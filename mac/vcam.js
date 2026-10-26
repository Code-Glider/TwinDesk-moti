// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The virtual camera on the Mac (shared/vcam.js's driver): "TwinDesk Camera", a Camera Extension
// (mac-helper/Sources/twindesk-camera) inside TwinDesk.app/Contents/Library/SystemExtensions.
// Installing it is twindesk-vcam activate (Contents/MacOS: the extension must be in its main
// bundle), and the first time macOS asks the person to allow it in System Settings; twindesk-vcam
// feed then writes the frames into the camera. macOS loads a camera extension only from an app in
// /Applications signed with Developer ID and a provisioning profile that allows system extensions
// (build-app.sh with MAC_TEAM_ID, MAC_APP_PROFILE and MAC_CAMERA_PROFILE): other builds don't
// carry it, and the Camera tab says so.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Contents/Resources/app/mac → Contents
const CONTENTS = path.join(__dirname, '..', '..', '..');
const TOOL = path.join(CONTENTS, 'MacOS', 'twindesk-vcam');
const EXTENSION = path.join(CONTENTS, 'Library', 'SystemExtensions', 'org.macshare.mac.camera.systemextension');

function tool(cmd, onLine, timeout = 20000) {
  return new Promise((resolve) => {
    const p = execFile(TOOL, [cmd], { timeout }, (err, stdout) => {
      let last = {};
      for (const line of String(stdout || '').trim().split('\n')) {
        try { last = JSON.parse(line); } catch {}
      }
      if (err && !last.error && last.ok !== true) last.error = err.killed ? 'it took too long' : err.message;
      resolve(last);
    });
    if (onLine) {
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try { onLine(JSON.parse(line)); } catch {}
        }
      });
    }
  });
}

const driver = {
  name: 'TwinDesk Camera',

  async check() {
    if (!fs.existsSync(TOOL) || !fs.existsSync(EXTENSION)) {
      return { supported: false, message: 'Not in this build: macOS takes camera extensions only from TwinDesk signed by its developer (a release build)' };
    }
    if (!/^\/Applications\//.test(CONTENTS)) return { supported: false, message: 'Move TwinDesk to the Applications folder first: macOS installs camera extensions only from there' };
    const st = await tool('status');
    return { supported: true, installed: st.camera === true };
  },

  async install(say) {
    const r = await tool('activate', (m) => {
      if (m.approval) say('Allow it in System Settings › General › Login Items & Extensions › Camera Extensions (macOS asks once)');
    }, 310000);
    if (!r.ok) throw new Error('macOS didn’t install the camera: ' + (r.error || 'unknown'));
    if (r.reboot) throw new Error('It’s installed after the Mac restarts');
    // The new camera shows up in a moment.
    for (let i = 0; i < 30; i++) {
      if ((await tool('status')).camera === true) return;
      await new Promise((res) => setTimeout(res, 200));
    }
  },

  async remove() {
    const r = await tool('deactivate', null, 310000);
    if (!r.ok) throw new Error(r.error || 'unknown');
  },

  feed(onExit) {
    const p = spawn(TOOL, ['feed'], { stdio: ['pipe', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => console.log('[vcam] ' + String(d).trim()));
    p.on('exit', onExit);
    p.on('error', onExit);
    p.stdin.on('error', () => {});
    return p;
  },
};

module.exports = driver;
