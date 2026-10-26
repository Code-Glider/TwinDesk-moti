// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The camera windows' bridge to main (camshare.js): messages in, messages out.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cam', {
  on: (fn) => ipcRenderer.on('cam:in', (_e, m) => fn(m)),
  send: (m) => ipcRenderer.send('cam:out', m),
});
