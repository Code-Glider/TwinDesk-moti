// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Regression tests for the Windows/Linux file receiver. No Electron or platform helper required.
// Run: node shared/test/filerecv-hardening.js
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const P = require('../protocol.js');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function until(check, reason) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('Timed out waiting for ' + reason);
}

function receiver(platform, root) {
  const original = Module._load;
  const ipc = new EventEmitter();
  const from = (parent, folder) => parent &&
    path.basename(parent.filename) === 'filerecv.js' &&
    path.basename(path.dirname(parent.filename)) === folder;
  Module._load = function (name, parent, main) {
    if (name === 'electron') return {
      app: { getPath: (kind) => kind === 'downloads' ? path.join(root, 'Downloads') : root },
      shell: { showItemInFolder: () => {} },
      ipcMain: ipc,
    };
    if (name === './fm' && from(parent, 'linux')) {
      return { at: async () => ({}), showItems: () => {} };
    }
    if (name === 'child_process' && from(parent, 'windows')) {
      return { spawn: () => ({ unref() {} }) };
    }
    return original.apply(this, arguments);
  };
  let FileRecv;
  try { FileRecv = require(path.join(__dirname, '..', '..', platform, 'filerecv.js')); }
  finally { Module._load = original; }

  const sent = [];
  const link = new EventEmitter();
  link.send = (m) => sent.push(m);
  const recv = new FileRecv({
    link,
    settings: { files: { acceptFromMac: true } },
    helper: { request: async () => ({ path: '' }) },
    onChange: () => {},
  });
  const done = (id) => sent.find((m) => m.t === P.T.FILE_DONE && m.id === id);
  return { link, recv, sent, done };
}

async function checkPlatform(platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-recv-test-'));
  const originalStream = fs.createWriteStream;
  const originalMkdir = fs.mkdirSync;
  fs.mkdirSync(path.join(root, 'Downloads'));
  const { link, recv, sent, done } = receiver(platform, root);
  try {
    // A peer controls the ID, but not the temporary path. A pre-existing file must survive.
    const outside = path.join(root, 'outside.part');
    fs.writeFileSync(outside, 'keep me');
    recv._offer({ id: '../outside', drop: 'release', name: 'safe.txt', size: 0 });
    const unsafe = recv.files.get('../outside');
    assert.ok(unsafe, platform + ': offer was accepted');
    await until(() => fs.existsSync(unsafe.tmp), 'temporary file to open');
    assert.equal(path.dirname(unsafe.tmp), recv.dir, platform + ': temp file escaped incoming');
    assert.match(path.basename(unsafe.tmp), /^[0-9a-f]{32}\.part$/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me', platform + ': sender overwrote a file');
    recv._drop('../outside');

    // Cancel while Node is still opening the stream: no orphan can appear afterward.
    recv._offer({ id: 'cancelled', drop: 'release', name: 'cancelled.txt', size: 20 });
    const cancelled = recv.files.get('cancelled');
    link.emit(P.T.FILE_CANCEL, { id: 'cancelled' });
    await until(() => cancelled.out.closed, 'cancelled stream to close');
    assert.equal(fs.existsSync(cancelled.tmp), false, platform + ': cancel left an unopened part');

    // Reject the extra chunk *before* writing it, both for a drag and a Send files batch.
    recv._offer({ id: 'overrun', drop: 'release', name: 'overrun.bin', size: 1 });
    const overrun = recv.files.get('overrun');
    recv._chunk({ id: 'overrun', seq: 0, data: Buffer.from('too many') });
    assert.equal(done('overrun')?.ok, false, platform + ': drag overrun was accepted');
    assert.equal(recv.files.has('overrun'), false);
    await until(() => overrun.out.closed, 'overrun stream to close');
    assert.equal(fs.existsSync(overrun.tmp), false, platform + ': overrun left a partial file');

    recv._offer({ id: 'batch-overrun', drop: 'send', batch: 'batch-bad', count: 1,
      rel: 'Photos/overrun.bin', size: 1 });
    const batchOverrun = recv.bfiles.get('batch-overrun');
    recv._chunk({ id: 'batch-overrun', seq: 0, data: Buffer.from('too many') });
    assert.equal(done('batch-overrun')?.ok, false, platform + ': batch overrun was accepted');
    assert.equal(recv.bfiles.has('batch-overrun'), false);
    assert.ok(sent.some((m) => m.t === P.T.FILES_DONE && m.batch === 'batch-bad' && !m.ok));
    await until(() => batchOverrun.out.closed, 'batch overrun stream to close');
    assert.equal(fs.existsSync(batchOverrun.tmp), false, platform + ': batch overrun left a partial file');

    recv._offer({ id: 'bad-hash', drop: 'release', name: 'bad-hash.bin', size: 1 });
    const badHash = recv.files.get('bad-hash');
    recv._chunk({ id: 'bad-hash', seq: 0, data: Buffer.from('x') });
    recv._end({ id: 'bad-hash', sha256: 'wrong' });
    await until(() => !!done('bad-hash'), 'checksum failure notification');
    assert.equal(done('bad-hash').ok, false);
    await until(() => badHash.out.closed, 'checksum-failed stream to close');
    assert.equal(fs.existsSync(badHash.tmp), false, platform + ': checksum failure left a partial file');

    // No available staging directory (ENOSPC/EACCES) must refuse the offer, not throw
    // through the link's EventEmitter and crash the app's main process.
    fs.mkdirSync = function (dir, ...args) {
      if (dir === recv.dir) throw Object.assign(new Error('simulated storage failure'), { code: 'ENOSPC' });
      return originalMkdir.call(this, dir, ...args);
    };
    try {
      assert.doesNotThrow(() => recv._offer({ id: 'cannot-stage', drop: 'release',
        name: 'cannot-stage.txt', size: 1 }));
    } finally { fs.mkdirSync = originalMkdir; }
    assert.ok(sent.some((m) => m.t === P.T.FILE_REFUSE && m.id === 'cannot-stage' && m.why === 'storage_error'));
    assert.equal(recv.files.has('cannot-stage'), false);

    // Disk full: a checksum of received bytes cannot certify that the bytes reached disk.
    const failing = () => new Writable({
      write(_bytes, _encoding, cb) {
        cb(Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' }));
      },
    });
    fs.createWriteStream = failing;
    const contents = Buffer.from('data that cannot be saved');
    recv._offer({ id: 'disk-full', drop: 'release', name: 'disk-full.bin', size: contents.length });
    fs.createWriteStream = originalStream;
    recv._chunk({ id: 'disk-full', seq: 0, data: contents });
    recv._end({ id: 'disk-full', sha256: sha(contents) });
    await until(() => !!done('disk-full'), 'disk-full failure notification');
    assert.equal(done('disk-full').ok, false, platform + ': failed write reported success');
    assert.match(done('disk-full').error, /disk full/);

    recv._offer({ id: 'batch-disk-full', drop: 'send', batch: 'batch-full', count: 1,
      rel: 'Photos/disk-full.bin', size: contents.length });
    fs.createWriteStream = failing;
    recv._chunk({ id: 'batch-disk-full', seq: 0, data: contents });
    fs.createWriteStream = originalStream;
    recv._end({ id: 'batch-disk-full', sha256: sha(contents) });
    await until(() => !!done('batch-disk-full'), 'batch disk-full failure notification');
    assert.equal(done('batch-disk-full').ok, false);
    assert.ok(sent.some((m) => m.t === P.T.FILES_DONE && m.batch === 'batch-full' && !m.ok));

    // Legitimate bytes still arrive, and an existing downloaded file is never overwritten.
    fs.writeFileSync(path.join(root, 'Downloads', 'report.txt'), 'existing');
    const good = Buffer.from('actual report');
    recv._offer({ id: 'good-drag', drop: 'release', name: 'report.txt', size: good.length });
    recv._chunk({ id: 'good-drag', seq: 0, data: good });
    recv._end({ id: 'good-drag', sha256: sha(good) });
    await until(() => recv.files.get('good-drag')?.complete, 'completed drag');
    await recv.onRelease();
    await until(() => !!done('good-drag'), 'successful drag notification');
    assert.equal(done('good-drag').ok, true);
    assert.equal(fs.readFileSync(done('good-drag').path, 'utf8'), 'actual report');
    assert.equal(fs.readFileSync(path.join(root, 'Downloads', 'report.txt'), 'utf8'), 'existing');

    const batch = Buffer.from('batch content');
    recv._offer({ id: 'good-batch', drop: 'send', batch: 'batch-ok', count: 1,
      rel: 'Folder/item.txt', size: batch.length });
    recv._chunk({ id: 'good-batch', seq: 0, data: batch });
    recv._end({ id: 'good-batch', sha256: sha(batch) });
    await until(() => !!done('good-batch'), 'successful batch notification');
    assert.equal(done('good-batch').ok, true);
    assert.equal(fs.readFileSync(done('good-batch').path, 'utf8'), 'batch content');
    assert.ok(sent.some((m) => m.t === P.T.FILES_DONE && m.batch === 'batch-ok' && m.ok));

    // A sender must not stage two batch IDs into the same destination and race the writes.
    recv._offer({ id: 'first-duplicate', drop: 'send', batch: 'batch-duplicate', count: 2,
      rel: 'Duplicates/same.txt', size: 5 });
    recv._offer({ id: 'second-duplicate', drop: 'send', batch: 'batch-duplicate', count: 2,
      rel: 'Duplicates/same.txt', size: 6 });
    assert.ok(sent.some((m) => m.t === P.T.FILE_REFUSE && m.id === 'second-duplicate'),
      platform + ': two files targeted the same batch path');
    recv._chunk({ id: 'first-duplicate', seq: 0, data: Buffer.from('first') });
    recv._end({ id: 'first-duplicate', sha256: sha(Buffer.from('first')) });
    await until(() => !!done('first-duplicate'), 'first duplicate file saved');
    assert.equal(done('first-duplicate').ok, true);
    assert.equal(fs.readFileSync(done('first-duplicate').path, 'utf8'), 'first');
    assert.ok(sent.some((m) => m.t === P.T.FILES_DONE && m.batch === 'batch-duplicate' && !m.ok));
  } finally {
    fs.createWriteStream = originalStream;
    fs.mkdirSync = originalMkdir;
    link.emit('closed');
    await new Promise((r) => setTimeout(r, 30));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  for (const platform of ['linux', 'windows']) await checkPlatform(platform);
  console.log('filerecv-hardening: ok (Linux and Windows)');
})().catch((e) => { console.error(e); process.exitCode = 1; });
