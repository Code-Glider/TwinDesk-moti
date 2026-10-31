// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Exercise the real mesh IPC registration with a selected peer and a second paired host.
// Run: node mac/mesh/test/connect-address-ipc.test.js
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

const original = Module._load;
Module._load = function (name, parent, main) {
  const ipc = parent && path.basename(parent.filename) === 'ipc.js' &&
    path.basename(path.dirname(parent.filename)) === 'mesh';
  if (name === 'electron' && ipc) return {
    ipcMain: { on() {}, handle() {} }, shell: {}, app: {}, screen: {}, dialog: {},
    clipboard: {}, Menu: {},
  };
  if (name === './store' && ipc) return { saveSettings() {} };
  return original.apply(this, arguments);
};
let setupIpc;
try { ({ setupIpc } = require('../ipc.js')); }
finally { Module._load = original; }

function context(ask = null) {
  const server = new EventEmitter();
  let releases = 0;
  server.server = { clients: new Map(), release() { releases++; } };
  server.current = { deviceId: 'alpha' };
  const hub = new EventEmitter();
  hub.selectedId = 'alpha';
  const connected = new Set(['alpha']);
  hub.select = (id) => {
    if (!connected.has(id)) return false;
    hub.selectedId = id;
    server.current = { deviceId: id };
    server.emit('client', server.current);
    return true;
  };
  let dialCount = 0;
  const host = {
    authed: false,
    pairing: { macId: 'bravo', address: '192.0.2.20', port: 47800 },
    store: { save() {} },
    connect() { dialCount++; },
  };
  const link = {
    hosts: [{ id: 'bravo', name: 'Bravo', address: '192.0.2.20', port: 47800 }],
    list: () => [host], get: (id) => id === 'bravo' ? host : null,
  };
  const dev = { id: 'bravo', name: 'Bravo', os: 'mac', address: '192.0.2.20', port: 47800 };
  let pushCount = 0;
  const state = { connect: { busy: false, message: '', error: false, pending: null }, addresses: [] };
  const ctx = {
    settings: {}, state, pushState: () => { pushCount++; }, server, hub, link,
    pairing: { list: () => [] }, discovery: { ask: ask || (async () => dev) },
  };
  const actions = setupIpc(ctx);
  return { actions, hub, server, host, connected, state, dialCount: () => dialCount,
    releaseCount: () => releases, pushCount: () => pushCount };
}

(async () => {
  // Alpha is currently in use. Connecting to Bravo must select Bravo on link-up, not leave
  // Alpha as the KVM target while the Overview says "Connecting to Bravo".
  {
    const c = context();
    await c.actions.connectAddress('192.0.2.20');
    assert.equal(c.dialCount(), 1);
    assert.equal(c.hub.selectedId, 'alpha');
    assert.equal(c.state.connect.pending.id, 'bravo');
    c.connected.add('bravo');
    c.host.authed = true;
    c.hub.emit('peerAdded', 'bravo');
    assert.equal(c.hub.selectedId, 'bravo');
    assert.equal(c.state.connect.pending, null);
    assert.equal(c.state.connect.message, '');
  }

  // Already-connected Bravo: Connect by address means *use Bravo*, not a no-op.
  {
    const c = context();
    c.connected.add('bravo');
    c.host.authed = true;
    await c.actions.connectAddress('192.0.2.20');
    assert.equal(c.dialCount(), 0);
    assert.equal(c.hub.selectedId, 'bravo');
    assert.equal(c.state.connect.pending, null);
  }

  // If Bravo already has an authenticated inbound socket, just select it: tearing
  // that session down to redial would interrupt working KVM and file transfers.
  {
    const c = context();
    c.server.server.clients.set('bravo', { deviceId: 'bravo' });
    c.connected.add('bravo');
    await c.actions.connectAddress('192.0.2.20');
    assert.equal(c.releaseCount(), 0);
    assert.equal(c.dialCount(), 0);
    assert.equal(c.hub.selectedId, 'bravo');
    assert.equal(c.state.connect.pending, null);
  }

  // A later explicit Use click wins over an earlier pending Connect action.
  {
    const c = context();
    await c.actions.connectAddress('192.0.2.20');
    assert.equal(c.state.connect.pending.id, 'bravo');
    c.actions.selectPeer('alpha');
    assert.equal(c.state.connect.pending, null);
    c.connected.add('bravo');
    c.hub.emit('peerAdded', 'bravo');
    assert.equal(c.hub.selectedId, 'alpha');
  }

  // An async lookup that finishes after the user chose a different device is ignored.
  {
    let resolveLookup;
    const c = context(() => new Promise((r) => { resolveLookup = r; }));
    const lookup = c.actions.connectAddress('192.0.2.20');
    c.actions.selectPeer('alpha');
    resolveLookup({ id: 'bravo', name: 'Bravo', os: 'mac', address: '192.0.2.20' });
    await lookup;
    assert.equal(c.dialCount(), 0);
    assert.equal(c.state.connect.pending, null);
    assert.equal(c.hub.selectedId, 'alpha');
  }

  // Two in-flight address lookups may resolve out of order; the newest choice wins.
  {
    const lookups = [];
    const c = context(() => new Promise((r) => lookups.push(r)));
    const earlier = c.actions.connectAddress('192.0.2.21');
    const later = c.actions.connectAddress('192.0.2.20');
    lookups[1]({ id: 'bravo', name: 'Bravo', os: 'mac', address: '192.0.2.20' });
    await later;
    lookups[0]({ id: 'bravo', name: 'Bravo', os: 'mac', address: '192.0.2.20' });
    await earlier;
    assert.equal(c.dialCount(), 1, 'stale lookup connected a second time');
    assert.equal(c.state.connect.pending.id, 'bravo');
  }

  // Discovery failures are reported rather than leaking an unhandled promise rejection.
  {
    const c = context(async () => { throw new Error('offline'); });
    await c.actions.connectAddress('192.0.2.20');
    assert.equal(c.state.connect.error, true);
    assert.equal(c.dialCount(), 0);
  }

  console.log('connect-address-ipc: ok');
})().catch((e) => { console.error(e); process.exitCode = 1; });
