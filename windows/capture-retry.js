// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Backoff for a screen capture that ended without the user turning sharing off.
'use strict';

class CaptureRetry {
  constructor(run, timers = {}) {
    this.run = run;
    this.setTimer = timers.setTimeout || setTimeout;
    this.clearTimer = timers.clearTimeout || clearTimeout;
    this.baseMs = 2000;
    this.maxMs = 30000;
    this.delay = this.baseMs;
    this.timer = null;
  }

  later() {
    if (this.timer !== null) return; // one retry, even if several failure callbacks fire
    const wait = this.delay;
    this.delay = Math.min(this.maxMs, this.delay * 2);
    this.timer = this.setTimer(() => { this.timer = null; this.run(); }, wait);
  }

  cancel() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  reset() {
    this.cancel();
    this.delay = this.baseMs;
  }
}

module.exports = CaptureRetry;
