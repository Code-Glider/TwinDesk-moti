// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One-to-one Mac IPC: the selected guest is dialled immediately, even while hosting.
// Run: node mac/mesh/test/connect-address-one-ipc.test.js
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

const original = Module._load;
Module._load = function (name, parent, main) {
  const ipc = parent && path.basename(parent.filename) === 'ipc.js' &&
    path.basename(path.dirname(parent.filename)) === 'mac';
  if (name === 'electron' && ipc) return {
    ipcMain: { on() {}, handle() {} }, shell: {}, app: {}, screen: {}, dialog: {},
    clipboard: {}, Menu: {}, systemPreferences: {},
  };
  if (name === './store' && ipc) return { saveSettings() {} };
  return original.apply(this, arguments);
};
let setupIpc;
try { ({ setupIpc } = require('../../ipc.js')); }
finally { Module._load = original; }

function context(ask = null) {
  const server = new EventEmitter();
  let releases = 0;
  let disconnects = 0;
  server.server = { current: { deviceId: 'alpha' }, release() { releases++; } };
  server.current = { deviceId: 'alpha' };
  server.disconnect = () => { disconnects++; };
  const calls = [];
  const link = {
    hosts: [{ id: 'bravo', name: 'Bravo', address: '192.0.2.20', port: 47800 }],
    ctx: null,
    connect: (takeover, prefer) => calls.push({ takeover, prefer }),
  };
  const dev = { id: 'bravo', name: 'Bravo', os: 'mac', address: '192.0.2.20', port: 47800 };
  const state = { connect: { busy: false, message: '', error: false, pending: null }, addresses: [] };
  const ctx = {
    state, settings: {}, pushState() {}, server, link,
    pairing: { list: () => [] }, discovery: { ask: ask || (async () => dev) },
  };
  const actions = setupIpc(ctx);
  return { actions, state, server, link, calls, releases: () => releases, disconnects: () => disconnects };
}

(async () => {
  // An inbound Alpha session is released, while the preferred Bravo target is recorded
  // without an 800 ms window in which the background reconnector could dial Alpha.
  {
    const c = context();
    await c.actions.connectAddress('192.0.2.20');
    assert.equal(c.releases(), 1);
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].prefer.id, 'bravo');
    assert.equal(c.state.connect.pending.id, 'bravo');
    c.server.emit('client', { deviceId: 'bravo' });
    assert.equal(c.state.connect.pending, null);
  }

  // Already connected as Bravo's guest: neither release nor dial again.
  {
    const c = context();
    c.server.server.current = null;
    c.link.ctx = { deviceId: 'bravo' };
    await c.actions.connectAddress('192.0.2.20');
    assert.equal(c.releases(), 0);
    assert.equal(c.calls.length, 0);
  }

  // Disconnect while discovery is pending: the late reply must not redial a computer.
  {
    let resolveLookup;
    const c = context(() => new Promise((r) => { resolveLookup = r; }));
    const lookup = c.actions.connectAddress('192.0.2.20');
    c.actions.disconnect();
    resolveLookup({ id: 'bravo', name: 'Bravo', os: 'mac', address: '192.0.2.20' });
    await lookup;
    assert.equal(c.disconnects(), 1);
    assert.equal(c.calls.length, 0);
  }

  console.log('connect-address-one-ipc: ok');
})().catch((e) => { console.error(e); process.exitCode = 1; });
