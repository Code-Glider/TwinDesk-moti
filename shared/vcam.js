// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Camera › Virtual camera (Windows, Mac and Linux): what Show starts — the other computer's
// camera, or a phone's — goes to a camera every app on this computer can pick ("TwinDesk Camera"),
// not to a window. Off until turned on; turning it on installs the camera the first time (each
// platform's driver: windows/vcam.js, linux/vcam.js, mac/vcam.js), and while it's on the camera's
// window stays hidden and sends its frames here (shared/vcam-feed.js: NV12, 1280×720, on
// 'vcam:frame'), which go to the driver's feed process. Without frames the camera shows black.
//
// driver: {name, always?, check() → {supported, installed, message}, install(say), remove(), feed(onExit) → ChildProcess}
//   say(text): what installing waits for now (the Mac: the person allowing it in System Settings).
//   always: the feed runs all the while it's on (Linux: an apps sees the camera only while
//   something writes to it), not only while frames come.
// cfg() → settings.camera; save(); onChange(); onReady(ready): the camera's windows reopen the other way.
'use strict';

const FRAME = 1280 * 720 * 3 / 2;
const IDLE_MS = 5000; // no frames this long: the feed process goes (it starts again with the next one)
const LIVE_MS = 2000;

class VirtualCam {
  constructor({ driver, cfg, save, onChange, onReady }) {
    Object.assign(this, { driver, cfg, save, onChange, onReady });
    this.state = { checked: false, supported: !!driver, installed: false, busy: '', message: '' };
    this.proc = null;
    this.blocked = false; // the feed's pipe is full: frames drop until it drains
    this.lastFrame = 0;
    this.idle = null;
    this.wasReady = false;
    const { ipcMain } = require('electron');
    ipcMain.on('vcam:frame', (_e, buf) => this.frame(buf));
  }

  get on() {
    return this.cfg().virtual === true;
  }

  // On and installed: Show feeds the camera.
  get ready() {
    return this.on && this.state.installed;
  }

  async check() {
    if (!this.driver) return this._set({ checked: true, supported: false, message: 'Not on this computer' });
    try {
      const r = await this.driver.check();
      this._set({ checked: true, supported: r.supported !== false, installed: !!r.installed, message: r.message || '' });
    } catch (e) {
      this._set({ checked: true, message: 'Couldn’t check the virtual camera: ' + e.message });
    }
    if (this.on && this.state.supported && !this.state.installed && !this.state.busy) await this.install();
  }

  async setOn(on) {
    this.cfg().virtual = !!on;
    this.save();
    if (on && !this.state.checked) return this.check();
    if (on && this.state.supported && !this.state.installed) return this.install();
    this._set({ message: on ? this.state.message : '' });
  }

  async install() {
    if (this.state.busy || !this.driver) return;
    this._set({ busy: 'install', message: '' });
    try {
      await this.driver.install((text) => this._set({ message: String(text || '') }));
      const r = await this.driver.check();
      this.state.installed = !!r.installed;
      this.state.message = r.installed ? '' : (r.message || 'It didn’t install');
    } catch (e) {
      this.state.message = e.message;
    }
    this._set({ busy: '' });
  }

  // Camera › Remove: the camera goes from this computer (the switch goes off).
  async remove() {
    if (this.state.busy || !this.driver) return;
    this.cfg().virtual = false;
    this.save();
    this._set({ busy: 'remove', message: '' });
    this._stopFeed();
    try {
      await this.driver.remove();
      this.state.installed = false;
    } catch (e) {
      this.state.message = 'Couldn’t remove it: ' + e.message;
    }
    try {
      const r = await this.driver.check();
      this.state.installed = !!r.installed;
    } catch {}
    this._set({ busy: '' });
  }

  frame(buf) {
    if (!this.ready || !buf || buf.byteLength !== FRAME) return;
    const was = this.lastFrame;
    this.lastFrame = Date.now();
    // The tab's "live" comes and goes with the frames.
    if (this.lastFrame - was > LIVE_MS) this.onChange();
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => this.onChange(), LIVE_MS + 100);
    this._startFeed();
    clearTimeout(this.idle);
    if (!this.driver.always) this.idle = setTimeout(() => this._stopFeed(), IDLE_MS);
    if (!this.proc || this.blocked) return;
    if (!this.proc.stdin.write(Buffer.from(buf))) {
      this.blocked = true;
      this.proc.stdin.once('drain', () => { this.blocked = false; });
    }
  }

  _startFeed() {
    if (this.proc || !this.ready) return;
    const p = this.proc = this.driver.feed(() => {
      if (this.proc !== p) return;
      this.proc = null;
      this.blocked = false;
      // Linux: it runs all the while it's on (again a moment after it stops).
      if (this.driver.always) setTimeout(() => this._sync(), 2000);
    });
  }

  _stopFeed() {
    clearTimeout(this.idle);
    const p = this.proc;
    this.proc = null;
    this.blocked = false;
    if (p) {
      try { p.stdin.end(); } catch {}
      setTimeout(() => { try { p.kill(); } catch {} }, 1000);
    }
  }

  // The camera's windows follow ready (the other way when it changes), and Linux's feed.
  _sync() {
    const ready = this.ready;
    if (this.driver && this.driver.always) {
      if (ready) this._startFeed();
      else this._stopFeed();
    } else if (!ready) this._stopFeed();
    if (ready !== this.wasReady) {
      this.wasReady = ready;
      if (this.onReady) this.onReady(ready);
    }
  }

  _set(p) {
    Object.assign(this.state, p);
    this._sync();
    this.onChange();
  }

  // For the Camera tab (state.vcam).
  view() {
    return {
      ...this.state,
      on: this.on,
      ready: this.ready,
      name: this.driver ? this.driver.name : '',
      live: this.ready && Date.now() - this.lastFrame < LIVE_MS,
    };
  }

  stop() {
    this._stopFeed();
  }
}

module.exports = { VirtualCam, FRAME };
