// TwinDesk — Copyright (C) 2026. GPL-3.0, see LICENSE.
// Authenticated one-to-one hosts on each desktop OS must survive brief scheduler pauses.
'use strict';

const assert = require('assert');
const P = require('../protocol.js');

const hosts = [
  ['Mac', require('../../mac/server.js').Server],
  ['Windows', require('../../windows/server.js').Server],
  ['Linux', require('../../linux/server.js').Server],
];

function liveness(Server, silenceMs, transport = 'ip') {
  let pings = 0;
  let terminated = 0;
  const ws = {
    lastRx: Date.now() - silenceMs,
    transport,
    address: '127.0.0.1',
    blePort: 0,
    OPEN: 1,
    readyState: 1,
    send: () => { pings++; },
    terminate: () => { terminated++; },
  };
  const fake = {
    sockets: new Set([{ authed: true, name: 'test', ws, alt: null }]),
    blePorts: new Map(),
  };
  Server.prototype._liveness.call(fake);
  return { pings, terminated };
}

for (const [name, Server] of hosts) {
  assert.deepStrictEqual(liveness(Server, P.TIMEOUT_MS + 500), { pings: 1, terminated: 0 },
    `${name}: a 4.5-second background pause should not disconnect the session`);
  assert.strictEqual(liveness(Server, P.SESSION_TIMEOUT_MS + 500).terminated, 1,
    `${name}: a session silent longer than 15 seconds should disconnect`);
  assert.strictEqual(liveness(Server, P.SESSION_TIMEOUT_MS + 500, 'ble').terminated, 0,
    `${name}: Bluetooth keeps its separate 20-second deadline`);
  assert.strictEqual(liveness(Server, P.BLE_TIMEOUT_MS + 500, 'ble').terminated, 1,
    `${name}: dead Bluetooth sessions still disconnect`);
}

console.log('session-heartbeat: passed');
