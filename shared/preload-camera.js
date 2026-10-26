// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The camera windows' bridge to main (camshare.js): messages in, messages out, and the virtual
// camera's frames (shared/vcam.js).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cam', {
  on: (fn) => ipcRenderer.on('cam:in', (_e, m) => fn(m)),
  send: (m) => ipcRenderer.send('cam:out', m),
  vcam: (buf) => ipcRenderer.send('vcam:frame', buf),
});
