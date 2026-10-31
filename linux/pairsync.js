// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Every two-way section is one setting shared by both
// computers, remembered per pair. "Show this PC's notifications on the Mac" is this PC's
// notifs.send AND the Mac's notifs.receive: flip it on either computer and the other follows.
// Directions are told from the sender's side ('out' = the sender's things on the receiver), so the
// receiver flips them. On connect each side restores its values for that peer; then the host sends
// all of them (`pair.sync {all}`) and the guest adopts them. Reference: mac/pairsync.js.
//
// A feature may have one direction only (Remote: the phone's Remote page moving this computer; the
// phone has no switch of its own, its page sends `pair.sync` to turn it on here). `on` names the
// section's own switch that a direction turns on with it (ReZume's).
//
// Call check() with every state push (main.js): it sends what changed here.
'use strict';

const P = require('../shared/protocol.js');
const { offlineChanges } = require('../shared/pairsync-offline.js');

const T = P.T;

// feature → settings [section, key] for this PC's out (mine → theirs) / in (theirs → mine).
const FEATURES = {
  clipboard: { out: ['clipboard', 'send'], in: ['clipboard', 'receive'] },
  notifs: { out: ['notifs', 'send'], in: ['notifs', 'receive'] },
  apps: { out: ['pcApps', 'allow'], in: ['macApps', 'on'] },
  audio: { out: ['audio', 'send'], in: ['audio', 'receive'] },
  cursor: { out: ['kvm', 'driveOther'], in: ['kvm', 'beDriven'] },
  rezume: { out: ['rezume', 'send'], in: ['rezume', 'receive'], on: 'on' },
  remote: { in: ['remote', 'allow'] },
  terminal: { out: ['terminal', 'allowMac'], in: ['terminal', 'enabled'] },
  files: { out: ['files', 'dropToMac'], in: ['files', 'acceptFromMac'] },
};
// Shared values, the same on both computers (no direction): key → settings path + values.
const VALUES = {
  pace: { path: ['monitor', 'pacing'], allowed: ['fast', 'smooth'] },
  gestures: { path: ['kvm', 'gestures'], allowed: [true, false] },
  ble: { path: ['kvm', 'ble'], allowed: [true, false] }, // cursor sharing over Bluetooth (kvm.js)
  // Share Keyboard: one switch for both sides (a computer, or a phone's Keyboard page). Set on
  // either side for the speed and scrolling of this computer's mouse on a phone (its Cursor page).
  keyboard: { path: ['kvm', 'keyboard'], allowed: [true, false] },
  speed: { path: ['kvm', 'speed'], allowed: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3], phone: true },
  reverseScroll: { path: ['kvm', 'reverseScroll'], allowed: [true, false], phone: true },
};

class PairSync {
  // opts: link, settings (shared; .pairSync is kept here), save(), set(section, partial) (ipc.js:
  // applies a setting with its side effects), only (the features this app has, else all of them)
  constructor(opts) {
    Object.assign(this, opts);
    this.features = Object.fromEntries(Object.entries(FEATURES).filter(([f]) => !opts.only || opts.only.includes(f)));
    this.last = null; // the values both computers agree on now
    this.peerId = '';
    this.offlinePeerId = '';
    this.offlineValues = null;
    if (!this.settings.pairSync || typeof this.settings.pairSync !== 'object') this.settings.pairSync = {};

    this.link.on('welcome', () => {
      this._rememberOffline();
      this.offlinePeerId = '';
      this.offlineValues = null;
      const s = this.link.snapshot().session;
      this.peerId = s && s.id ? String(s.id) : '';
      const saved = this.settings.pairSync[this.peerId];
      this.last = this.values();
      if (saved) this._adopt(saved);
      if (this.link.hosting) this.link.send({ t: T.PAIR_SYNC, all: this.last }); // we are the host: ours win
    });
    this.link.on('closed', () => {
      if (this.peerId) {
        this.offlinePeerId = this.peerId;
        this.offlineValues = this.values();
      }
      this.last = null;
      this.peerId = '';
    });
    this.link.on(T.PAIR_SYNC, (m) => {
      if (!this.last) return;
      const vals = this._values();
      if (vals[m.key] && vals[m.key].allowed.includes(m.value)) return this._adopt({ values: { [m.key]: m.value } });
      if (m.all && typeof m.all === 'object') {
        const mine = { values: {} };
        for (const [k, d] of Object.entries(vals)) if (m.all.values && d.allowed.includes(m.all.values[k])) mine.values[k] = m.all.values[k];
        for (const f of Object.keys(this.features)) {
          const v = m.all[f];
          if (v && typeof v === 'object') mine[f] = { out: v.in, in: v.out }; // their in = our out
        }
        this._adopt(mine);
      } else if (this.features[m.feature] && (m.dir === 'out' || m.dir === 'in') && typeof m.on === 'boolean') {
        this._adopt({ [m.feature]: { [m.dir === 'out' ? 'in' : 'out']: m.on } });
      }
    });
  }

  // The shared values with this peer: the phone-only ones only with a phone.
  _values() {
    const phone = this.link.peerOs === P.OS.ANDROID;
    return Object.fromEntries(Object.entries(VALUES).filter(([, d]) => phone || !d.phone));
  }

  // A direction's value: undefined where this side has no such switch.
  _get(d, dir) {
    const p = d[dir];
    const sec = p && this.settings[p[0]];
    if (!sec || typeof sec !== 'object') return undefined;
    return !!sec[p[1]] && (!d.on || !!sec[d.on]);
  }

  values() {
    const out = {};
    for (const [f, d] of Object.entries(this.features)) out[f] = { out: this._get(d, 'out'), in: this._get(d, 'in') };
    out.values = {};
    for (const [k, d] of Object.entries(this._values())) out.values[k] = this.settings[d.path[0]][d.path[1]];
    return out;
  }

  // Take values from the peer (or our saved ones) without sending them back.
  _adopt(vals) {
    const now = this.values();
    const known = this._values();
    for (const [k, v] of Object.entries(vals.values || {})) {
      const d = known[k];
      if (!d || !d.allowed.includes(v) || now.values[k] === v) continue;
      now.values[k] = v;
      this.last = now;
      this.set(d.path[0], { [d.path[1]]: v });
    }
    for (const [f, v] of Object.entries(vals)) {
      const d = this.features[f];
      if (f === 'values' || !d || !v) continue;
      for (const dir of ['out', 'in']) {
        if (typeof v[dir] !== 'boolean' || typeof now[f][dir] !== 'boolean' || now[f][dir] === v[dir]) continue;
        const [section, key] = d[dir];
        now[f][dir] = v[dir];
        this.last = now; // before set(): its state push must not echo this change
        this.set(section, { [key]: v[dir], ...(v[dir] && d.on ? { [d.on]: true } : {}) });
      }
    }
    this.last = now;
    this._remember(now);
  }

  _remember(vals) {
    if (!this.peerId) return;
    this.settings.pairSync[this.peerId] = vals;
    this.save();
  }

  _rememberOffline() {
    if (!this.offlinePeerId || !this.offlineValues) return;
    const now = this.values();
    const next = offlineChanges(this.settings.pairSync[this.offlinePeerId] || this.offlineValues, this.offlineValues, now);
    this.offlineValues = now;
    if (next) {
      this.settings.pairSync[this.offlinePeerId] = next;
      this.save();
    }
  }

  check() {
    if (!this.last || this.link.status.state !== 'connected') return this._rememberOffline();
    const now = this.values();
    let changed = false;
    for (const f of Object.keys(this.features)) {
      for (const dir of ['out', 'in']) {
        if (typeof now[f][dir] !== 'boolean' || now[f][dir] === (this.last[f] || {})[dir]) continue;
        changed = true;
        this.link.send({ t: T.PAIR_SYNC, feature: f, dir, on: now[f][dir] });
      }
    }
    for (const k of Object.keys(now.values)) {
      if (now.values[k] === (this.last.values || {})[k]) continue;
      changed = true;
      this.link.send({ t: T.PAIR_SYNC, key: k, value: now.values[k] });
    }
    this.last = now;
    if (changed) this._remember(now);
  }
}

module.exports = { PairSync, FEATURES, VALUES };
