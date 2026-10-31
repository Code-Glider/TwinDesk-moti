// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests PC screen capture recovery without Electron or a display driver.
// Run: node shared/test/windows-screen-resume.js
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

function clock() {
  let id = 0;
  const tasks = new Map();
  return {
    tasks,
    setTimeout(fn, ms) { tasks.set(++id, { fn, ms }); return id; },
    clearTimeout(key) { tasks.delete(key); },
    next() {
      const [key, t] = tasks.entries().next().value || [];
      assert.ok(t, 'a retry is scheduled');
      tasks.delete(key);
      t.fn();
      return t.ms;
    },
  };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

async function check(variant) {
  const original = Module._load;
  const powerMonitor = new EventEmitter();
  const displays = new EventEmitter();
  const display = { id: 1, label: 'Primary', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, displayFrequency: 60 };
  Object.assign(displays, {
    getAllDisplays: () => [display],
    getPrimaryDisplay: () => display,
    dipToScreenRect: (_win, bounds) => bounds,
  });
  let available = true;
  const desktopCapturer = { getSources: async () => available ? [{ id: 'screen:1', display_id: '1', name: 'Primary' }] : [] };
  Module._load = function (name, parent, main) {
    if (name === 'electron') return { desktopCapturer, screen: displays, powerMonitor };
    return original.apply(this, arguments);
  };
  let PcScreen;
  try { PcScreen = require(path.join(__dirname, '..', '..', 'windows', variant, 'pcscreen.js')); }
  finally { Module._load = original; }

  const link = new EventEmitter();
  link.status = { state: 'connected' };
  link.current = { transport: 'ip' };
  link.peerOs = 'win';
  link.send = () => {};
  const sender = new EventEmitter();
  let starts = 0;
  const stopped = [];
  sender.start = () => ++starts;
  sender.stop = (s) => stopped.push(s);
  const timers = clock();
  const pc = new PcScreen({
    link, sender, retryTimers: timers,
    vdd: { state: { installed: false, on: false }, find: async () => null },
    helper: { send() {} }, inputAllowed: () => true,
    settings: { pcScreen: { mbps: 8, sound: false, maxHeight: 0, extendSize: 'mac', monitor: '', input: false }, keys: { swapCtrlCmd: false } },
    onChange() {},
  });
  try {
    pc.mode = 'mirror';
    pc.mac.accept = true;
    await pc.apply();
    assert.equal(pc.sending?.session, 1, variant + ': initial capture');

    sender.emit('state', 1, { status: 'ended', error: 'locked desktop' });
    assert.equal(pc.sending, null, variant + ': ended capture stopped');
    assert.equal(timers.tasks.size, 1);
    assert.equal(timers.next(), 2000, variant + ': retries after 2 s');
    await settled();
    assert.equal(pc.sending?.session, 2, variant + ': resumed without a viewer policy event');
    assert.deepEqual(stopped, [1]);

    sender.emit('state', 2, { status: 'live' }); // a healthy session resets the backoff
    assert.equal(pc.retry.delay, 2000);
    available = false;
    sender.emit('state', 2, { status: 'failed', error: 'capture lost' });
    assert.equal(timers.next(), 2000);
    await settled();
    assert.equal(pc.sending, null, variant + ': no source while locked');
    assert.equal(timers.tasks.size, 1);
    assert.equal([...timers.tasks.values()][0].ms, 4000, variant + ': failure backs off');

    available = true;
    powerMonitor.emit('unlock-screen');
    await settled();
    assert.equal(timers.tasks.size, 0, variant + ': unlock cancels stale delayed retry');
    assert.equal(pc.sending?.session, 3, variant + ': unlock starts immediately');

    sender.emit('state', 3, { status: 'ended' });
    assert.equal(timers.tasks.size, 1);
    await pc.setMode('off');
    assert.equal(timers.tasks.size, 0, variant + ': user stopping sharing cancels retry');
    powerMonitor.emit('resume');
    await settled();
    assert.equal(pc.sending, null, variant + ': resume cannot re-enable disabled sharing');
  } finally {
    pc.shutdown();
    assert.equal(powerMonitor.listenerCount('unlock-screen'), 0);
    assert.equal(powerMonitor.listenerCount('resume'), 0);
  }
}

(async () => {
  for (const variant of ['', 'mesh']) await check(variant);
  console.log('windows-screen-resume: ok (one-to-one and mesh)');
})().catch((e) => { console.error(e); process.exitCode = 1; });
