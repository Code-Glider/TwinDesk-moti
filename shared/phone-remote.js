// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone as this computer's remote (Windows, Mac and Linux): its Remote page (a touchpad, a
// keyboard, a gamepad whose buttons are keys) moves this computer's pointer, clicks, scrolls and
// types. Relative input (remote.*) goes straight to the helper as k.* events, while the Remote tab's
// switch is on (settings.remote.allow, on until turned off) and this computer's own mouse is at home
// (not driving the phone or another computer). When it isn't taken, the phone is told why
// (remote.state {allowed, why}), and the Remote tab says it too.
//
// server: the phone's session (on('t:<type>'), on('closed'), current, sendToClient);
// helper: helper.js; getSettings(); atHome(): this computer's mouse is its own; onChange().
'use strict';

const P = require('./protocol.js');

const T = P.T;
const isPhone = (ctx) => !!ctx && ctx.os === P.OS.ANDROID;
const num = (v, max) => Math.max(-max, Math.min(max, Number(v) || 0));
const BUTTONS = new Set(Object.values(P.BUTTON));
const CODE = /^[A-Za-z0-9]{1,32}$/; // KeyboardEvent.code names (KeyA, ArrowLeft, MediaPlayPause…)
const USING_MS = 3000; // input this recent: "in use now"

class PhoneRemote {
  constructor({ server, helper, getSettings, atHome, onChange = () => {} }) {
    Object.assign(this, { server, helper, getSettings, atHome, onChange });
    this.held = false; // keys or buttons the phone may still hold down here
    this.refusedAt = 0;
    this.lastInput = 0;
    this.opened = false; // the phone's Remote page is open (it said hello)
    const on = (t, fn) => server.on(`t:${t}`, (m) => isPhone(server.current) && fn(m || {}));
    on(T.REMOTE_HELLO, () => {
      this.opened = true;
      this._state();
      this.onChange();
    });
    // smooth: the helper eases the move out over about a frame instead of jumping (Smoother.cs).
    on(T.REMOTE_MOVE, (m) => this._ev({ t: T.K_MOVE, dx: num(m.dx, 4000), dy: num(m.dy, 4000), smooth: m.smooth === true }));
    on(T.REMOTE_DOWN, (m) => BUTTONS.has(m.b) && this._ev({ t: T.K_DOWN, b: m.b }));
    on(T.REMOTE_UP, (m) => BUTTONS.has(m.b) && this._ev({ t: T.K_UP, b: m.b }));
    on(T.REMOTE_WHEEL, (m) => this._ev({ t: T.K_WHEEL, dx: num(m.dx, 4000), dy: num(m.dy, 4000), mode: 'pixel' }));
    on(T.REMOTE_KEY_DOWN, (m) => typeof m.code === 'string' && CODE.test(m.code) && this._ev({ t: T.K_KEY_DOWN, code: m.code }));
    on(T.REMOTE_KEY_UP, (m) => typeof m.code === 'string' && CODE.test(m.code) && this._ev({ t: T.K_KEY_UP, code: m.code }));
    on(T.REMOTE_RELEASE, () => {
      this.release();
      this.opened = false; // the page closed
      this.onChange();
    });
    // The phone went away holding a key (Wi-Fi dropped mid-press): let it go here.
    server.on('closed', () => {
      this.release();
      this.opened = false;
      this.onChange();
    });
  }

  get allow() {
    const r = this.getSettings().remote;
    return !(r && r.allow === false);
  }

  // Why it isn't taken now, '' when it is.
  get why() {
    if (!this.allow) return 'Remote is off on this computer: turn it on in TwinDesk’s Remote page there';
    if (!this.atHome()) return 'This computer’s mouse is on another device now (Cursor): bring it back first';
    return '';
  }

  // The Remote tab's switch (and its answer to the phone).
  setAllow(on) {
    const s = this.getSettings();
    s.remote = { ...(s.remote || {}), allow: !!on };
    if (!on) this.release();
    this._state();
    this.onChange();
  }

  // This computer's mouse went to another device or came back: the phone hears whether it's taken.
  refresh() {
    this._state();
    this.onChange();
  }

  _state() {
    if (!isPhone(this.server.current)) return;
    const why = this.why;
    this.server.sendToClient({ t: T.REMOTE_STATE, allowed: !why, why });
  }

  _ev(ev) {
    if (this.why) {
      // Tell the phone (it says why on its Remote page), at most once a second.
      const now = Date.now();
      if (now - this.refusedAt > 1000) {
        this.refusedAt = now;
        this._state();
        this.onChange();
      }
      return;
    }
    const was = this.lastInput;
    this.lastInput = Date.now();
    if (this.lastInput - was > USING_MS) this.onChange(); // "in use now"
    clearTimeout(this.usingTimer);
    this.usingTimer = setTimeout(() => this.onChange(), USING_MS + 100);
    if (ev.t === T.K_DOWN || ev.t === T.K_KEY_DOWN) this.held = true;
    this.helper.send('inject', { ev });
  }

  release() {
    if (!this.held) return;
    this.held = false;
    if (this.atHome()) this.helper.send('releaseAll');
  }

  // For the Remote tab (state.remote).
  get view() {
    return {
      allow: this.allow,
      why: this.why,
      opened: this.opened && isPhone(this.server.current),
      using: Date.now() - this.lastInput < USING_MS,
    };
  }
}

module.exports = { PhoneRemote };
