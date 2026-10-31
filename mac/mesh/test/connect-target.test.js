// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A selected address must not silently reconnect to a different paired computer.
// Run: node mac/mesh/test/connect-target.test.js
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

const hosts = [
  { id: 'alpha', name: 'Alpha', address: '192.0.2.10', port: 47800, fp: 'alpha-fp', token: 'a' },
  { id: 'bravo', name: 'Bravo', address: '192.0.2.20', port: 47800, fp: 'bravo-fp', token: 'b' },
];
const sockets = [];

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.terminated = false;
    sockets.push(this);
  }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close'); }
  close() { this.terminate(); }
  send() {}
}

const original = Module._load;
Module._load = function (name, parent, main) {
  const inLink = parent && path.basename(parent.filename) === 'link.js' &&
    path.basename(path.dirname(parent.filename)) === 'mac';
  if (name === 'ws' && inLink) return FakeWebSocket;
  if (name === './store' && inLink) return {
    read: () => hosts.map((h) => ({ ...h })),
    write() {},
  };
  return original.apply(this, arguments);
};
let Link;
try { ({ Link } = require('../../link.js')); }
finally { Module._load = original; }

async function until(check, label) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('Timed out: ' + label);
}

const make = (canConnect = () => true) => new Link({ macId: 'local', macName: 'Local' }, {
  canConnect,
  resolve: (id) => id === 'alpha' ? { address: '192.0.2.10', port: 47800 } : null,
});

async function check() {
  // First attempt to Bravo fails: retries must remain on Bravo, though Alpha is discoverable.
  {
    sockets.length = 0;
    const link = make();
    try {
      link.connect(true, { id: 'bravo', address: '192.0.2.20', port: 47800 });
      await until(() => sockets.length === 1, 'first connection');
      assert.match(sockets[0].url, /192\.0\.2\.20/);
      sockets[0].terminate();
      link._scheduleReconnect(0); // skip only the elapsed backoff, not the routing decision
      await until(() => sockets.length === 2, 'retry connection');
      assert.match(sockets[1].url, /192\.0\.2\.20/, 'retry switched to another paired host');
    } finally { link.stop(); }
  }

  // Selecting Bravo while already on Alpha must actually close Alpha and dial Bravo.
  {
    sockets.length = 0;
    const link = make();
    try {
      link.connect();
      await until(() => sockets.length === 1, 'Alpha connection');
      assert.match(sockets[0].url, /192\.0\.2\.10/);
      link.connect(true, { id: 'bravo', address: '192.0.2.20' });
      await until(() => sockets.length === 2, 'switch to Bravo');
      assert.equal(sockets[0].terminated, true, 'old socket was not released');
      assert.match(sockets[1].url, /192\.0\.2\.20/);
    } finally { link.stop(); }
  }

  // Even after a successful welcome, an unplanned disconnect must not switch hosts.
  {
    sockets.length = 0;
    const link = make();
    try {
      link.connect(true, { id: 'bravo' });
      await until(() => sockets.length === 1, 'Bravo session');
      link._onWelcome({ macName: 'Bravo' });
      assert.equal(link.preferId, 'bravo');
      sockets[0].terminate();
      link._scheduleReconnect(0);
      await until(() => sockets.length === 2, 'session reconnect');
      assert.match(sockets[1].url, /192\.0\.2\.20/);
    } finally { link.stop(); }
  }

  // Selecting a new address never relaxes the existing certificate fingerprint check.
  {
    sockets.length = 0;
    const link = make();
    try {
      link.connect(true, { id: 'bravo', address: '192.0.2.25' });
      await until(() => sockets.length === 1, 'updated-address session');
      assert.match(sockets[0].url, /192\.0\.2\.25/);
      link._onOpen('untrusted-fingerprint', '192.0.2.25');
      assert.equal(link.status.state, 'identity_changed');
      assert.equal(sockets[0].terminated, true);
    } finally { link.stop(); }
  }

  // Standby while hosting another session does not consume the selected target.
  {
    sockets.length = 0;
    let allowed = false;
    const link = make(() => allowed);
    try {
      link.connect(true, { id: 'bravo' });
      await until(() => link.status.state === 'standby', 'standby');
      assert.equal(sockets.length, 0);
      allowed = true;
      link._scheduleReconnect(0);
      await until(() => sockets.length === 1, 'post-standby connection');
      assert.match(sockets[0].url, /192\.0\.2\.20/);
    } finally { link.stop(); }
  }

  // A stale or forgotten selection is an error, never permission to control another host.
  {
    sockets.length = 0;
    const link = make();
    try {
      link.connect(true, { id: 'missing' });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sockets.length, 0, 'unknown selected host fell back to another');
      link.connect(true, { id: 'bravo' });
      await until(() => sockets.length === 1, 'Bravo connection before forget');
      link.forget('bravo');
      link._scheduleReconnect(0);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sockets.length, 1, 'forgotten host fell back to Alpha');
    } finally { link.stop(); }
  }

  console.log('connect-target: ok');
}

check().catch((e) => { console.error(e); process.exitCode = 1; });
