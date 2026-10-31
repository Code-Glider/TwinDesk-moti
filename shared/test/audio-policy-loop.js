// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Two simulated peers must converge without endlessly echoing audio.policy.
// Run: node shared/test/audio-policy-loop.js
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const P = require('../protocol.js');

function soundClass(platform) {
  const original = Module._load;
  const ipcMain = new EventEmitter();
  Module._load = function (name, parent, main) {
    if (name === 'electron') return {
      ipcMain,
      BrowserWindow: class {},
      session: { defaultSession: { setDisplayMediaRequestHandler() {} } },
      desktopCapturer: { getSources: async () => [] },
    };
    if (name === './loopback' && parent && path.basename(parent.filename) === 'sound.js' &&
        path.basename(path.dirname(parent.filename)) === 'linux') {
      return { acquire: async () => '', release() {} };
    }
    return original.apply(this, arguments);
  };
  try { return require(path.join(__dirname, '..', '..', platform, 'sound.js')); }
  finally { Module._load = original; }
}

function checkPlatform(platform) {
  const Sound = soundClass(platform);
  const a = new EventEmitter();
  const b = new EventEmitter();
  const queue = [];
  const sent = [];
  a.status = b.status = { state: 'connected' };
  a.send = (m) => { sent.push(['a', m]); queue.push([b, m]); };
  b.send = (m) => { sent.push(['b', m]); queue.push([a, m]); };

  // Deliver events in turns rather than recursively. The old code creates an infinite queue.
  function drain() {
    let delivered = 0;
    while (queue.length) {
      assert.ok(++delivered < 32, platform + ': audio.policy echo loop');
      const [target, m] = queue.shift();
      target.emit(m.t, m);
    }
  }
  function policies() { return sent.filter(([, m]) => m.t === P.T.AUDIO_POLICY).length; }

  const settingsA = { audio: { receive: false, send: false, volume: 1, muteLocal: false } };
  const settingsB = { audio: { receive: false, send: false, volume: 1, muteLocal: false } };
  const sa = new Sound({ link: a, settings: settingsA, onChange() {} });
  const sb = new Sound({ link: b, settings: settingsB, onChange() {} });

  a.emit('welcome');
  b.emit('welcome');
  drain();
  assert.equal(policies(), 2, platform + ': startup sent more than one policy per peer');

  // Duplicate remote policy should neither change state nor provoke a new send.
  a.emit(P.T.AUDIO_POLICY, { accept: false });
  b.emit(P.T.AUDIO_POLICY, { accept: false });
  drain();
  assert.equal(policies(), 2, platform + ': unchanged policy was echoed');

  // Real changes still propagate and settle in a bounded number of messages.
  settingsA.audio.receive = true;
  sa.apply();
  drain();
  assert.equal(sb.macAccepts, true);
  assert.equal(policies(), 4);

  settingsB.audio.receive = true;
  sb.apply();
  drain();
  assert.equal(sa.macAccepts, true);
  assert.equal(policies(), 6);

  settingsA.audio.receive = false;
  sa.apply();
  drain();
  assert.equal(sb.macAccepts, false);
  assert.equal(policies(), 8);

  // Repeating an already-received policy is an idempotent no-op.
  a.emit(P.T.AUDIO_POLICY, { accept: true });
  b.emit(P.T.AUDIO_POLICY, { accept: false });
  drain();
  assert.equal(policies(), 8);
}

for (const platform of ['linux', 'windows']) checkPlatform(platform);
console.log('audio-policy-loop: ok (Linux and Windows)');
