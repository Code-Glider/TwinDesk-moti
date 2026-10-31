// TwinDesk — Copyright (C) 2026. GPL-3.0, see LICENSE.
// Simulated Mac host / Windows guest with real PairSync implementations.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('../protocol.js');
const { PairSync: MacSync } = require('../../mac/pairsync.js');
const { PairSync: WinSync } = require('../../windows/pairsync.js');
const { PairSync: LinuxSync } = require('../../linux/pairsync.js');
const { offlineChanges } = require('../pairsync-offline.js');

function testPair(PeerSync, label) {
  const mac = {
    kvm: { driveOther: true, beDriven: true, gestures: true, ble: false, keyboard: true },
    sharing: { pace: 'fast' }, pairSync: { unrelated: { cursor: { out: false, in: false } } },
  };
  const peer = {
    kvm: { driveOther: true, beDriven: true, gestures: true, ble: false, keyboard: true },
    monitor: { pacing: 'fast' }, pairSync: {},
  };
  const server = new EventEmitter();
  const link = new EventEmitter();
  const ctx = { deviceId: label, role: 'guest', os: P.OS.WIN };
  let macSaves = 0;
  let peerSaves = 0;
  let mSync, pSync;
  server.current = null;
  server.send = (_, m) => link.emit(P.T.PAIR_SYNC, m);
  server.sendToClient = (m) => link.emit(P.T.PAIR_SYNC, m);
  link.status = { state: 'connected' };
  link.hosting = false;
  link.peerOs = P.OS.MAC;
  link.snapshot = () => ({ session: { id: 'mac' } });
  link.send = (m) => server.emit(`t:${P.T.PAIR_SYNC}`, m);

  mSync = new MacSync({ server, getSettings: () => mac, saveSettings: () => { macSaves++; },
    apply: () => {}, only: ['cursor'] });
  pSync = new PeerSync({ link, settings: peer, save: () => { peerSaves++; },
    set: (section, partial) => { Object.assign(peer[section], partial); pSync.check(); },
    only: ['cursor'] });

  function connect() {
    link.status.state = 'connected';
    server.current = ctx;
    link.emit('welcome');
    server.emit('client', ctx);
  }

  function disconnect() {
    link.status.state = 'disconnected';
    link.emit('closed');
    server.current = null;
    server.emit('closed');
  }

  connect();
  mac.kvm.driveOther = false;
  mSync.check();
  assert.strictEqual(peer.kvm.beDriven, false, `${label}: turning off propagates`);
  mac.kvm.driveOther = true;
  mSync.check();
  assert.strictEqual(peer.kvm.beDriven, true, `${label}: re-enable propagates while connected`);

  mac.kvm.driveOther = false;
  mSync.check();
  disconnect();
  mac.kvm.driveOther = true;
  mSync.check(); // UI changes the permission checkbox while the peer is offline
  assert.strictEqual(mac.pairSync[label].cursor.out, true, `${label}: offline edit is saved for the right peer`);
  assert.deepStrictEqual(mac.pairSync.unrelated.cursor, { out: false, in: false },
    `${label}: another peer's permission is untouched`);
  const saves = macSaves;
  mSync.check();
  assert.strictEqual(macSaves, saves, `${label}: repeated idle checks do not rewrite settings`);
  connect();
  assert.strictEqual(mac.kvm.driveOther, true, `${label}: offline re-enable survives reconnection`);
  assert.strictEqual(peer.kvm.beDriven, true, `${label}: remote permission is restored`);
  assert.ok(peerSaves > 0, `${label}: receiver persists the synchronized permission`);

  // An authenticated but malformed packet must not coerce a truthy string into a KVM grant.
  mac.kvm.beDriven = false;
  mSync.check();
  server.emit(`t:${P.T.PAIR_SYNC}`, { feature: 'cursor', dir: 'out', on: 'false' });
  assert.strictEqual(mac.kvm.beDriven, false, `${label}: malformed Boolean cannot grant inbound KVM`);

  disconnect();
  peer.kvm.beDriven = false;
  pSync.check();
  assert.strictEqual(peer.pairSync.mac.cursor.in, false,
    `${label}: offline receiver changes also persist for its prior peer`);
}

testPair(WinSync, 'windows');
testPair(LinuxSync, 'linux');

const saved = { cursor: { out: false, in: false }, values: { pace: 'smooth' } };
const before = { cursor: { out: false, in: true }, values: { pace: 'smooth' } };
const after = { cursor: { out: true, in: true }, values: { pace: 'fast' } };
assert.deepStrictEqual(offlineChanges(saved, before, after),
  { cursor: { out: true, in: false }, values: { pace: 'fast' } }, 'only locally edited fields override stored peer choices');
assert.strictEqual(offlineChanges(saved, before, before), null, 'unchanged local settings do not rewrite per-peer preferences');

console.log('pairsync-reconnect: passed');
