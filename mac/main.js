// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main process: lifecycle, windows, tray, IPC, and the state pushed to the control window.
//
// State object sent to the control window ('state' channel) on every change:
// {
//   macName, macId, fp,                       // this Mac's identity (fp = cert SHA-256 hex)
//   addresses: ['192.168.1.5', ...],           // this Mac's IPv4 addresses (the server listens on P.PORT)
//   discovery: { on, error, localNetwork },      // discovery.js status
//   found: [{ id, name, os, address, port, invited }],   // other TwinDesk computers nearby
//   guest: { status: {state, message}, pairing: null|{phase, name, address, code, error}, hosts: [...] },  // link.js
//   connect: { busy, message, error },           // last "Connect by address" / Pair attempt
//   serverError: null | 'message',            // e.g. port already in use
//   client: null | { id, name, os, role, address, rttMs },   // the session (peer.js); role 'host' = we are its guest
//   input: { where: 'home'|'driving'|'driven', message: '', tapError: null|'msg' },   // kvm.js
//   pairing: null | { name, code: null|'123456', confirmed, allowed },
//   paired: [{ id, name, pairedAt, lastSeen }],
//   permissions: { screen: 'granted'|'denied'|'not-determined'|..., accessibility: bool,
//                  inputMonitoring: null|bool },   // null = not checked yet (asked from the helper)
//   helper: { running: bool },
//   sharing: { on, displayId: null|id, bitrateMbps, streamMaxHeight (0 = native),
//              displays: [{ id, label, width, height, pixelWidth, pixelHeight, virtual, primary }],
//              targetId: null|id,                  // the display being shared now
//              virtual: { enabled, width, height, hiDPI, hz, active: bool, error: null|'msg' } },
//   displayMode: 'extend'|'mirror'|'custom',    // what Monitor 2 shows (Display tab)
//   streamInput: bool,                          // accept mouse/keyboard from Monitor 2
//   stream: { status, display, width, height, fps, mbps, encoder, codec, qp, ... },   // stream.js
//   kvm: settings.kvm, keys: settings.keys,     // Cursor / Keyboard tabs
//   clipboard: { ...settings.clipboard, peerAccepts, lastSkip,
//                history: [{ dir: 'out'|'in', at, size, text (preview) }] },
//   receive: { on, fullScreen, input, session, kind, status, stats, open },   // (pcview.js)
//   papps: { on, apps: [{id, name, icon}], listing, launch: {id: ''|'ok'|why}, windows: [{wid, id, title, live}] },   //
//   ui: { tab }, app: { openAtLogin, keepAwake },
//   wake: { womp, peers: {id: {name, os, at}}, last },   // (wake.js)
// }
'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, systemPreferences, Notification, dialog, globalShortcut } = require('electron');

app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// The hidden capture window plays system audio into WebRTC without any user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Every sent video frame says "show me now" (RTP playout delay 0/0): the lowest latency, whatever
// the viewer app does. A viewer in "Smooth" playback adds its own small buffer on top
// (jitterBufferTarget). FlexFEC repairs lost packets without waiting a round trip for a resend; it
// costs bandwidth only while packets are being lost.
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/WebRTC-FlexFEC-03/Enabled/WebRTC-FlexFEC-03-Advertised/Enabled/');
// Renamed to TwinDesk: settings, pairing and the identity stay in the old folder.
app.setPath('userData', process.env.MACSHARE_PROFILE || path.join(app.getPath('appData'), 'MacShare')); // PROFILE: a second dev copy
// Multi-device switched on (multi.js, docs/multi-device.md): mesh/main.js runs instead of everything below.
if (require('./multi').on()) return void require('./mesh/main.js');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const P = require('../shared/protocol.js');
const { CamShare } = require('../shared/camshare.js');
const { NowPlaying } = require('../shared/nowplaying.js');
const CL = require('../shared/cursorlock.js');
const store = require('./store');
const identity = require('./identity');
const { Discovery, interfaces } = require('./discovery');
const { Link } = require('./link');
const { Peer } = require('./peer');
const { Server } = require('./server');
const { Pairing } = require('./pairing');
const { startServices } = require('./services');
const { setupIpc, TABS } = require('./ipc');
const login = require('./login');
const { Hud } = require('./hud');
const { PairSync } = require('./pairsync');
const { Phone } = require('./phone');
const { PhoneBridge } = require('./phone-bridge');
const { Wired } = require('./wired');
const { PhoneViews } = require('./phoneview');
const { PhoneDrive } = require('./phonedrive');
const { Updates } = require('../shared/updates.js');
const { BleHost, BleLook } = require('../shared/blepipe.js');
const { wifiQuiet } = require('../shared/blepolicy.js');
const { NetLink } = require('../shared/netlink.js');
const { aboutInfo } = require('../shared/about.js');

let win = null;
let tray = null;
let lockKey = null; // the cursor lock key at home (shared/cursorlock.js)
let hud = null;
let quitting = false;
let startHidden = process.argv.includes('--hidden');
let settings, id, server, pairing, discovery, link, peer, svc, actions, pairSync, updates;
let phoneHub = null; // Calls, Messages and Photos (loadHub); svc.hub is the Mac's sound capture (audiohub.js)

const state = {
  macName: '',
  macId: '',
  fp: '',
  addresses: [],
  serverError: null,
  client: null,
  input: { where: 'home', message: '' },
  pairing: null,
  paired: [],
  permissions: { screen: 'unknown', accessibility: false, inputMonitoring: null },
  helper: { running: false },
  sharing: null,
  streamInput: true,
  stream: null,
  discovery: { on: false, error: '', localNetwork: true },
  found: [],
  guest: null,
  connect: { busy: false, message: '', error: false },
};

// A phone app kept in the Dock (phoneview.js pin): open it once the phone's wireless debugging is
// ready, connecting a paired phone nearby first if none is connected; tries for 2 minutes.
let pendingPhoneApp = null; // {pkg, until}
function openPhoneApp(pkg) {
  if (!/^[\w.]{1,200}$/.test(pkg)) return;
  const phone = svc.phone;
  if (phone.connected && (phone.bridge.state === 'ready' || svc.net.onBle)) { // through Bluetooth: Wi-Fi first (onNoAdb)
    pendingPhoneApp = null;
    return svc.phoneViews.openApp(pkg, (phone.apps.find((a) => a.id === pkg) || {}).name);
  }
  if (!pendingPhoneApp) hud.show('home', 'Opening it when the phone is ready…');
  pendingPhoneApp = { pkg, until: (pendingPhoneApp && pendingPhoneApp.until) || Date.now() + 2 * 60 * 1000 };
  clearTimeout(openPhoneApp.timer);
  if (Date.now() > pendingPhoneApp.until) return (pendingPhoneApp = null);
  if (!phone.connected && !phone.connecting) {
    const near = phone.nearby()[0];
    if (near) phone.connect(near.id);
  }
  openPhoneApp.timer = setTimeout(() => pendingPhoneApp && openPhoneApp(pendingPhoneApp.pkg), 2000);
}

// macshare://pc-app/<id> from a PC app's Dock icon / Launchpad entry. It can arrive
// before the services exist, so it waits in `linkQueue`.
let linkQueue = [];
function handleLink(url) {
  if (!svc) return linkQueue.push(url);
  if (/^macshare:\/\/send\b/.test(String(url))) return handleSendLink(String(url));
  const m = /^macshare:\/\/pc-app\/(.+)$/.exec(String(url));
  if (!m) return;
  const id = decodeURIComponent(m[1]).slice(0, 1024);
  if (id.startsWith('phone:')) return openPhoneApp(id.slice(6));
  if (!settings.papps.on) actions.setPcApps({ on: true });
  svc.pcApps.openFromLink(id);
}
app.on('open-url', (e, url) => {
  e.preventDefault();
  handleLink(url);
});

let defaultIf = '';
function readDefaultIf() {
  require('child_process').execFile('/sbin/route', ['-n', 'get', 'default'], (err, out) => {
    const m = !err && /interface:\s*(\S+)/.exec(out);
    const name = m ? m[1] : '';
    if (name !== defaultIf) {
      defaultIf = name;
      pushState();
    }
  });
}

let pushQueued = false;
function pushState() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    // The address the other computer can reach, first (the UI shows only this one):
    // on the peer's network, then real adapters (en*), the default route, VPN tunnels and bridges last.
    const peerNet = String((peer && peer.current && peer.current.address) || '').replace(/^::ffff:/, '').split('.').slice(0, 3).join('.');
    const rank = (i) => (peerNet && i.address.startsWith(`${peerNet}.`) ? 0 : /^en\d/.test(i.name) ? 1
      : /^(utun|bridge|vmnet|vnic|llw|awdl)/.test(i.name) ? 4 : i.name === defaultIf ? 2 : 3);
    state.addresses = interfaces().sort((a, b) => rank(a) - rank(b)).map((i) => i.address);
    state.pairing = pairing ? pairing.pendingView() : null;
    state.paired = pairing ? pairing.list() : [];
    if (discovery) {
      state.discovery = { ...discovery.status };
      state.found = discovery.list();
    }
    if (link) state.guest = link.view();
    const c = peer && peer.current;
    state.client = c ? { id: c.deviceId, name: c.name, os: c.os, role: c.role, address: c.address, rttMs: c.rttMs, transport: c.transport || 'ip' } : null;
    if (svc && svc.net) {
      const hs = c && settings.net.hotspots[c.deviceId];
      state.net = { ...svc.net.view, ble: settings.net.ble !== false, blePc: settings.net.blePc === true, bleWifiOff: settings.net.bleWifiOff !== false, bleOff, radio: svc.ble.state, hotspotSsid: hs ? hs.ssid : '', hotspotSaved: !!(hs && hs.pass) };
    }
    const { helper, displays, stream, clipboard: clip, kvm } = svc || {};
    state.helper.running = !!(helper && helper.running);
    if (displays) {
      const target = displays.target();
      state.sharing = {
        on: !!settings.sharing.on,
        audio: !!settings.sharing.audio,
        displayId: settings.sharing.displayId,
        bitrateMbps: settings.bitrateMbps,
        streamMaxHeight: settings.streamMaxHeight,
        displays: displays.list(),
        targetId: target ? target.id : null,
        virtual: { ...settings.virtual, active: displays.virtualId !== null, error: displays.virtualError },
      };
    }
    if (stream) {
      state.stream = stream.view;
      state.audio = { ...settings.audio, ...svc.audio.view, screen: stream.audio };
    }
    state.streamInput = settings.streamInput !== false;
    state.displayMode = displayMode();
    state.kvm = settings.kvm;
    state.keys = settings.keys;
    state.clipboard = clip ? { ...settings.clipboard, ...clip.view } : null;
    state.camera = svc && svc.camShare ? svc.camShare.state : null;
    state.phoneMedia = svc && svc.nowPlaying ? svc.nowPlaying.view : null;
    state.btAudio = null; // macOS can't be a phone's Bluetooth speaker
    state.ui = settings.ui;
    state.app = settings.app;
    if (kvm) state.input = kvm.view;
    if (kvm && lockKey) {
      lockKey.sync(kvm.server.current ? settings.keys.lockKeys : '');
      state.input.lockError = lockKey.error;
    }
    if (svc) state.terminal = { ...settings.terminal, ...svc.terminal.view, toPc: svc.sshClient.view };
    if (svc) state.files = { ...settings.files, ...svc.drop.view, ...svc.fileSend.view, clip: svc.fileClip.view };
    if (svc) state.notifs = { ...settings.notifs, ...svc.notifs.view };
    if (svc) {
      const { secret, ...smb } = settings.smb; // never send the share password to the window
      state.smb = { ...smb, ...svc.smb.view };
      state.apps = { ...settings.apps, ...svc.apps.view };
      state.receive = { ...settings.receive, ...svc.pcView.view };
      state.papps = { ...settings.papps, ...svc.pcApps.view };
    }
    if (svc) state.wake = svc.wake.view;
    if (svc && svc.phone) state.phone = { ...svc.phone.view, settings: settings.phone };
    if (svc && svc.phoneDrive) state.mount = { ...svc.phoneDrive.view, on: !!settings.mount.on };
    // Calls, Messages and Photos: the settings alone until the hub is loaded (setupHub).
    state.hub = phoneHub ? phoneHub.view : { ...settings.hub, connected: false };
    if (updates) state.updates = updates.view;
    if (pairSync) pairSync.check();
    sendScreenState();
    if (win && !win.isDestroyed()) win.webContents.send('state', state);
    updateTray();
  });
}

// Tell the viewer what we share, so it can show Start / Extend / Mirror itself
// (screen.state); only when something changed or the peer is new.
let screenStateKey = '';
function sendScreenState() {
  const c = peer && peer.current;
  if (!c || !svc) return void (screenStateKey = '');
  const msg = { t: P.T.SCREEN_STATE, on: !!settings.sharing.on, mode: displayMode(), remote: settings.sharing.remote !== false, modes: ['extend', 'mirror'] };
  const key = JSON.stringify([c.deviceId, msg]);
  if (key === screenStateKey) return;
  screenStateKey = key;
  peer.sendToClient(msg);
}

// The viewer on the other computer starts/stops our sharing or switches Extend/Mirror.
function onScreenCtl(m) {
  // The phone viewer's Close stops sharing even when the viewer may not start and switch it.
  if (m.share === false && m.close === true) return void (settings.sharing.on && actions.setSharing(false, 'remote'));
  if (settings.sharing.remote === false) return void (screenStateKey = '', pushState()); // re-send: remote false
  // Started from the viewer without a mode: Mirror (the virtual display doesn't always start); Extend is its switch.
  const mode = m.mode === 'extend' || m.mode === 'mirror' ? m.mode : m.share === true && !settings.sharing.on ? 'mirror' : null;
  if (mode && displayMode() !== mode) actions.setDisplayMode(mode);
  if (typeof m.share === 'boolean' && m.share !== !!settings.sharing.on) actions.setSharing(m.share, 'remote');
}

// macshare://send?p=<path>&p=… from the Share menu extension: Send files to the peer.
function handleSendLink(url) {
  let u;
  try { u = new URL(url); } catch { return; }
  const paths = u.searchParams.getAll('p').filter((x) => x.startsWith('/')).slice(0, 1000);
  if (!paths.length) return;
  if (!peer.current) return hud && hud.show('away', 'Not connected', 'Open TwinDesk on the other computer first');
  actions.sendFiles(paths);
  hud && hud.show('away', `Sending ${paths.length} item${paths.length === 1 ? '' : 's'} to ${peer.current.name}`);
}

function displayMode() {
  const t = svc && svc.displays.target();
  if (!t) return 'custom';
  if (t.virtual) return 'extend';
  return t.primary && !settings.virtual.enabled ? 'mirror' : 'custom';
}

function refreshPermissions() {
  state.permissions.screen = systemPreferences.getMediaAccessStatus('screen');
  state.permissions.accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  if (svc && svc.helper.running) {
    svc.helper.request('permissions').then((r) => {
      state.permissions.inputMonitoring = !!r.inputMonitoring;
      if (r.screen === true) state.permissions.screen = 'granted'; // the helper sees a fresh grant first
      setupSeen();
      clearStalePermissions();
      pushState();
    }, () => {});
  }
  pushState();
}

// After an update signed differently (every ad-hoc build was), macOS still lists TwinDesk as
// allowed but the grant belongs to the old signature, so the switches are on and nothing works,
// and switching them on again does nothing. Once per new signature: whatever reads as missing is
// reset (tccutil drops the stale entry), so Allow asks afresh and the switch in System Settings
// really is ours. Builds signed with TwinDesk's certificate keep one signature (build-app.sh).
let staleChecked = false;
function clearStalePermissions() {
  if (staleChecked || !app.isPackaged) return;
  staleChecked = true;
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  require('child_process').execFile('/usr/bin/codesign', ['-dr', '-', bundle], (err, out, errOut) => {
    const m = /designated => (.+)/.exec(`${out}${errOut}`);
    if (!m || m[1] === settings.app.signature) return;
    const p = state.permissions;
    const services = [
      p.screen !== 'granted' && 'ScreenCapture',
      !p.accessibility && 'Accessibility',
      p.inputMonitoring === false && 'ListenEvent',
    ].filter(Boolean);
    const id = 'org.macshare.mac';
    let left = services.length;
    const done = () => {
      settings.app.signature = m[1];
      store.saveSettings(settings);
      refreshPermissions();
    };
    if (!left) return done();
    console.log(`[permissions] new signature: resetting ${services.join(', ')}`);
    for (const svcName of services) require('child_process').execFile('/usr/bin/tccutil', ['reset', svcName, id], () => --left || done());
  });
}

// Setup shows once: when everything is allowed it's done for good (like Skip for now).
function setupSeen() {
  const p = state.permissions;
  if (settings.ui.setupDone || p.screen !== 'granted' || !p.accessibility || p.inputMonitoring !== true) return;
  settings.ui.setupDone = true;
  store.saveSettings(settings);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: 'TwinDesk',
    show: false,
    titleBarStyle: 'hiddenInset', // the sidebar runs up under the traffic lights
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-control.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') console.log(`[window] ${e.level}: ${e.message}`);
  });
  win.loadFile(path.join(__dirname, 'control.html'));
  win.once('ready-to-show', () => {
    if (startHidden) startHidden = false; // started at login: stay in the menu bar
    else showWindow();
  });
  // In the Dock and ⌘-Tab only while the window is open; menu bar only otherwise.
  win.on('show', dockIcon);
  win.on('hide', dockIcon);
  win.on('closed', dockIcon);
  win.on('focus', refreshPermissions);
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function dockIcon() {
  if (!app.dock) return;
  const visible = !!(win && !win.isDestroyed() && win.isVisible());
  if (visible && !app.dock.isVisible()) {
    app.dock.show().then(() => win && !win.isDestroyed() && win.focus()); // showing the Dock icon can take focus away
  } else if (!visible && app.dock.isVisible()) {
    app.dock.hide();
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    win.show();
    win.focus();
  }
  app.focus({ steal: true });
}

// Menu bar: the app mark as a template icon; the switches people reach for most, one click away.
// Set again only when what it shows changes: a menu replaced while it's open closes (or its click
// goes nowhere), and the state is pushed every second (the ping time isn't in it for that reason).
let trayKey = '';
function updateTray() {
  if (!tray) return;
  const c = state.client;
  const phone = !!(c && c.os === P.OS.ANDROID);
  const name = c ? c.name : 'Other Computer';
  const k = settings.kvm;
  const where = state.input && state.input.where;
  const found = (state.found || []).filter((d) => !c || d.id !== c.id);
  const phoneView = !!(phone && svc && svc.phoneViews.list().some((v) => v.kind === 'screen'));
  const OS = { mac: 'Mac', linux: 'Linux', android: 'Phone' };
  const g = (svc && link && link.view()) || { status: {}, hosts: [] };
  const again = !c && g.hosts.length && (g.status.state === 'stopped' || !!g.status.busy);
  const key = JSON.stringify([c && c.name, c && c.transport, phone, again, where, k.linked, k.ble, svc && svc.kvm.locked, settings.keys.lockKeys, k.driveOther, k.beDriven, settings.sharing.on,
    !!(svc && svc.pcView.isOpen), phoneView, settings.clipboard.enabled, settings.audio.send, settings.app.hud,
    found.map((d) => [d.id, d.name, d.os]), updates && updates.status.available && updates.status.latest]);
  if (key === trayKey) return;
  trayKey = key;
  tray.setToolTip(c ? `TwinDesk: ${c.name}` : 'TwinDesk');
  const check = (label, checked, click, enabled = true) => ({ label, type: 'checkbox', checked: !!checked, enabled, click });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: c ? `Connected to ${c.name}${c.transport === 'ble' ? ' · Bluetooth' : ''}` : 'Not connected', enabled: false },
      ...(where === 'driving' || where === 'driven'
        ? [{ label: 'Bring Mouse and Keyboard Back', click: () => svc.kvm.home() }] : []),
      check('Cursor Sharing', k.linked !== false && !(svc && svc.kvm.paused), (i) => actions.setKvm({ shared: i.checked })),
      ...(c ? [check(`Lock Cursor on ${where === 'driving' ? name : id.macName} (${CL.keysLabel(settings.keys.lockKeys, 'mac')})`, svc && svc.kvm.locked, (i) => svc.kvm.setLocked(i.checked))] : []),
      { type: 'separator' },
      check('Share Screen', settings.sharing.on, (i) => actions.setSharing(i.checked)),
      phone
        ? check('Show Phone Screen', phoneView, (i) => actions.phoneScreen(i.checked))
        : check('Receive Screen', svc && svc.pcView.isOpen, (i) => (i.checked ? actions.showPcView() : actions.closePcView())),
      check(`Use Mouse and Keyboard on ${name}`, k.driveOther, (i) => actions.setKvm({ driveOther: i.checked })),
      ...(phone ? [] : [check(`Let ${name} Control ${id.macName}`, k.beDriven, (i) => actions.setKvm({ beDriven: i.checked }))]),
      check('Share Clipboard', settings.clipboard.enabled, (i) => actions.setClipboard({ enabled: i.checked })),
      check('Send Sound', settings.audio.send, (i) => actions.setAudio({ send: i.checked })),
      { type: 'separator' },
      {
        label: 'Connect To',
        submenu: [
          ...(found.length ? found.map((d) => ({ label: `${d.name} (${OS[d.os] || 'PC'})`, click: () => actions.pairWith(d.id) }))
            : [{ label: 'Nobody nearby', enabled: false }]),
          { type: 'separator' },
          { label: 'Connect by Address…', click: () => { actions.setTab('overview'); showWindow(); } },
          { label: 'Look Again', click: () => actions.refreshDiscovery() },
        ],
      },
      ...(c ? [{ label: phone ? 'Disconnect Phone' : `Disconnect ${name}`, click: () => actions.disconnect() }] : []),
      ...(again ? [{ label: `${g.status.busy ? 'Take Over' : 'Connect to'} ${g.hosts[0].name}`, click: () => actions.connectAgain() }] : []),
      check('Show a Popup When Switching', settings.app.hud !== false, (i) => actions.setApp({ hud: i.checked })),
      { type: 'separator' },
      ...(updates && updates.status.available ? [{ label: `Download TwinDesk ${updates.status.latest}…`, click: () => updates.open() }] : []),
      { label: 'Open TwinDesk…', click: showWindow },
      { label: 'Quit TwinDesk', click: () => app.quit() },
    ]),
  );
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  // Dev runs show Electron's icon otherwise; the built app has it in its bundle.
  if (app.dock && !app.isPackaged) app.dock.setIcon(path.join(__dirname, '..', 'shared', 'icon', 'teindesk-dark-mac.png'));
  store.init(app.getPath('userData'));
  settings = store.loadSettings();
  id = identity.load(settings);
  Object.assign(state, { macName: id.macName, macId: id.macId, fp: id.fp, version: app.getVersion(), about: aboutInfo(app) });
  console.log(`[main] ${id.macName} (${id.macId}) fp ${id.fp}`);

  server = new Server(id);
  server.on('listening', () => console.log(`[server] listening on 0.0.0.0:${server.port}`));
  server.on('listenError', (err) => {
    state.serverError = `Cannot listen on port ${P.PORT}: ${err.code || err.message}`;
    console.error(`[server] ${state.serverError}`);
    pushState();
  });
  server.on('client', (ctx) => {
    console.log(`[server] ${ctx.name} connected from ${ctx.address}`);
  });
  server.on('closed', (ctx) => {
    if (ctx.authed) console.log(`[server] ${ctx.name} disconnected`);
    pushState();
  });
  server.on('rtt', (ctx) => {
    if (process.env.MACSHARE_DEBUG_STATS) console.log(`[server] rtt ${ctx.rttMs} ms`);
    pushState();
  });

  discovery = new Discovery(id, server.port);
  discovery.on('change', pushState);
  discovery.start();
  link = new Link(id, {
    canConnect: () => !server.current && !(pairing && pairing.pending) && !server.phoneHolds(),
    resolve: (hostId) => { const d = discovery.get(hostId); return d && !d.ble ? d : null; }, // a Mac host: on the network only
  });
  link.on('change', pushState);
  link.on('request', showWindow);
  // Take over on a Mac we're a guest of: back to it, taking the session over (a device connected
  // to us goes first, as Take over here does).
  discovery.on('invite', (d) => {
    if (!d || !link.hosts.some((h) => h.id === d.id)) return;
    if (server.current) {
      server.release();
      setTimeout(() => link.connect(true), 800);
    } else link.connect(true);
  });
  pairing = new Pairing(server, id, { busy: () => !!link.ctx, yieldTo: () => link.stop() });
  server.on('phoneFree', () => { link.poke(); pushState(); });
  pairing.on('change', pushState);
  pairing.on('request', showWindow);
  peer = new Peer(server, link);
  peer.on('client', (ctx) => {
    console.log(`[peer] session with ${ctx.name} (${ctx.os}, ${ctx.role === 'host' ? 'we are its guest' : 'it is our guest'})`);
    peer.send(ctx, { t: P.T.STREAM_INPUT, on: settings.streamInput !== false });
    pushState();
  });
  peer.on('closed', pushState);
  peer.on('rtt', pushState);
  link.start();

  svc = startServices({ server: peer, getSettings: () => settings, pushState, onHelperReady: refreshPermissions });
  if (settings.app.openAtLogin !== login.isOn()) login.apply(settings.app.openAtLogin);

  svc.phone = new Phone({ server: peer, raw: server, discovery, pairing });
  svc.phone.on('change', pushState);
  // The phone's Keyboard page names this Mac's hotkey (double-tap = everything back here).
  peer.on('client', (ctx) => ctx.os === P.OS.ANDROID && peer.sendToClient({ t: 'phone.mac', hotkey: P.hotkeyName(settings.keys.hotkey || P.HOTKEY_MAC) }));
  // The phone's screen, input, clipboard and app windows, through wireless debugging.
  svc.phone.bridge = new PhoneBridge({ server: peer, phone: svc.phone, getSettings: () => settings, clipboard: svc.clipboard });
  svc.phone.bridge.on('change', pushState);
  svc.phone.bridge.on('save', () => store.saveSettings(settings));
  // A phone on a USB cable: pairing, the session, screen and sound through it (no Wi-Fi needed).
  svc.wired = new Wired({ adb: svc.phone.bridge.adb, raw: server, peer, getId: () => id.macId, getName: () => id.macName });
  pairing.isWired = (nonce) => svc.wired.knows(nonce);
  svc.wired.on('change', pushState);
  svc.phone.bridge.wired = svc.wired;
  svc.phone.wired = svc.wired;
  svc.phoneViews = new PhoneViews({ bridge: svc.phone.bridge, phone: svc.phone, getSettings: () => settings, server: peer, fileSend: svc.fileSend });
  // What plays on the phone, for the Overview's media controls (shared/nowplaying.js). Its sound as
  // this Mac's Bluetooth speaker isn't here: macOS can't be one.
  svc.nowPlaying = new NowPlaying({ server: peer, cfg: () => settings.audio });
  svc.nowPlaying.on('change', pushState);
  // Camera tab: the cameras of the two computers (shared/camshare.js; a phone's is phoneViews.openCamera).
  const computer = () => !!peer.current && peer.current.os !== P.OS.ANDROID;
  svc.camShare = new CamShare({
    link: {
      on: (t, fn) => (t === 'welcome' ? peer.on('client', (ctx) => ctx.os !== P.OS.ANDROID && fn()) : peer.on(`t:${t}`, (m) => fn(m))),
      send: (m) => peer.sendToClient(m),
      connected: computer,
      ble: () => !!(peer.current && peer.current.transport === 'ble'),
      closed: (fn) => peer.on('closed', fn),
    },
    cfg: () => settings.camera,
    save: () => store.saveSettings(settings),
    popup: (kind, text) => hud && hud.show(kind, text),
    peerName: () => (peer.current && peer.current.name) || 'the other computer',
    onChange: pushState,
  });
  svc.phoneViews.on('change', pushState);
  // A phone notification clicked here: its app in a window.
  svc.notifs.on('click', (m) => peer.current && peer.current.os === P.OS.ANDROID && svc.phoneViews.openNotified(m.app, m.appName));
  // The phone in Finder, through adb (the cable, else wireless debugging): only when Mount is clicked.
  svc.phoneDrive = new PhoneDrive({ adb: svc.phone.bridge.adb, bridge: svc.phone.bridge, phone: svc.phone });
  svc.phoneDrive.on('change', pushState);
  setupNet();
  setupHub();
  svc.kvm.local = svc.phone.bridge;
  const blockEdge = svc.kvm.blockEdge;
  svc.kvm.blockEdge = () => blockEdge() || svc.phoneViews.focused; // moving inside the phone window never crosses
  svc.apps.setSharing = (on, by) => actions.setSharing(on, by);
  peer.on(`t:${P.T.SCREEN_CTL}`, (m) => onScreenCtl(m));
  // Two-way switches shared with the other computer, per pair (pairsync.js).
  const SYNC_ACTIONS = {
    clipboard: (dir, on) => actions.setClipboard({ [dir === 'out' ? 'send' : 'receive']: on }),
    notifs: (dir, on) => actions.setNotifs({ [dir === 'out' ? 'send' : 'receive']: on }),
    apps: (dir, on) => (dir === 'out' ? actions.setApps({ offer: on }) : actions.setPcApps({ on })),
    audio: (dir, on) => actions.setAudio({ [dir === 'out' ? 'send' : 'receive']: on }),
    cursor: (dir, on) => actions.setKvm({ [dir === 'out' ? 'driveOther' : 'beDriven']: on }),
  };
  pairSync = new PairSync({ server: peer, getSettings: () => settings, saveSettings: () => store.saveSettings(settings),
    apply: (f, dir, on) => (f !== 'value' ? SYNC_ACTIONS[f](dir, on)
      : ['gestures', 'ble', 'keyboard', 'speed', 'reverseScroll'].includes(dir) ? actions.setKvm({ [dir]: on }) : actions.setSharingOpts({ [dir]: on })) });
  // New releases on GitHub: a notification once per version, the menu bar item and About › Updates.
  updates = new Updates({
    current: app.getVersion(), platform: 'mac', getSettings: () => settings,
    save: () => store.saveSettings(settings), onChange: pushState,
    notify: (title, body, onClick) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      n.on('click', onClick);
      n.show();
    },
  });
  updates.start();
  actions = setupIpc({ state, settings, pushState, server: peer, pairing, discovery, link, ...svc, hub: loadHub, login, refreshPermissions, updates });
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'))); // "Template": macOS tints it
  hud = new Hud(() => settings);
  svc.kvm.on('where', (mode) => {
    const name = peer.current ? peer.current.name : 'the other computer';
    if (mode === 'driving') hud.show('away', settings.kvm.mouse ? `Using ${name}` : `Typing on ${name}`);
    else if (mode === 'driven') hud.show('driven', `${name} is using ${id.macName}`);
    else hud.show('home', `Back on ${id.macName}`);
  });
  // Cursor lock: the popup goes where the pointer is (the other computer shows its own while we drive it).
  svc.kvm.on('lock', (on, mode) => {
    if (mode === 'driving' && !(svc.kvm.local && svc.kvm.local.drives())) return;
    const where = mode === 'driving' ? (peer.current ? peer.current.name : 'the other computer') : id.macName;
    hud.show('lock', on ? `Cursor locked on ${where}` : 'Cursor unlocked');
  });
  // The lock key at home: a global shortcut, held while connected (pushState syncs it).
  lockKey = new CL.GlobalLockKey(globalShortcut, () => svc.kvm.toggleLock());

  svc.fileClip.on('popup', (kind, text) => hud.show(kind, text));
  svc.clipboard.on('popup', (kind, text) => hud.show(kind, text)); // a picture from the other side
  svc.pcApps.on('popup', (kind, text) => hud.show(kind, text));
  svc.phone.bridge.on('popup', (kind, text) => hud.show(kind, text));
  if (app.isPackaged) app.setAsDefaultProtocolClient('macshare');
  for (const url of linkQueue.splice(0)) handleLink(url);
  // The hotkey's double-tap: the big card "Cursor sharing on/off" (also when the other side switched it).
  // ble: Over Bluetooth was switched (kvm.setShared through Bluetooth).
  svc.kvm.on('linked', (on, here, ble) => {
    const name = peer.current ? peer.current.name : '';
    const key = P.hotkeyName(settings.keys.hotkey);
    const sub = !here && name ? `Turned ${on ? 'on' : 'off'} on ${name}`
      : on ? `${name ? `With ${name}. ` : ''}Double-tap ${key} to turn it off` : `${ble ? 'It comes back on Wi-Fi. ' : ''}Double-tap ${key} to turn it on`;
    hud.show(on ? 'linkOn' : 'linkOff', `Cursor sharing ${on ? 'on' : 'off'}${!on && ble ? ' over Bluetooth' : ''}`, sub);
  });
  svc.drop.on('batch', (b) => {
    if (b.kind === 'send') hud.show('driven', `Received ${b.files} file${b.files === 1 ? '' : 's'} from ${peer.current ? peer.current.name : 'the other computer'}`);
  });
  // Files on their way, live: the percentage beside the menu bar icon, ↓ coming in, ↑ going out
  // (macOS notifications have no progress bar, and TwinDesk has no Dock icon to put one on).
  let trayPct = '';
  setInterval(() => {
    const sum = (list, k) => list.reduce((a, f) => [a[0] + (f[k] || 0), a[1] + (f.size || 0)], [0, 0]);
    const [got, gotOf] = sum(svc.drop.view.receiving, 'got');
    const [sent, sentOf] = sum(svc.fileSend.view.sending, 'sent');
    const pct = (n, of) => Math.min(99, Math.floor((100 * n) / of));
    const t = (gotOf ? ` ↓${pct(got, gotOf)}%` : '') + (sentOf ? ` ↑${pct(sent, sentOf)}%` : '');
    if (t === trayPct || !tray) return;
    trayPct = t;
    tray.setTitle(t, { fontType: 'monospacedDigit' });
  }, 500).unref();
  createWindow();
  refreshPermissions();
  if (process.env.MACSHARE_DEV_TEST) require('./dev/m2m')({ role: process.env.MACSHARE_DEV_TEST, svc, actions, link, pairing, peer });
  readDefaultIf();
  setInterval(() => {
    readDefaultIf();
    pushState();
  }, 5000); // addresses change when the network does
  // While Setup shows something missing, notice the grant without waiting for a window focus.
  setInterval(() => {
    const p = state.permissions;
    const missing = p.screen !== 'granted' || !p.accessibility || p.inputMonitoring === false;
    if (missing && win && !win.isDestroyed() && win.isVisible()) refreshPermissions();
  }, 3000);
});

// Not on one network: the session through Bluetooth (this Mac advertises; phones and PCs connect),
// and Wi-Fi for files and screens (netlink.js): this Mac joins the other side's Wi-Fi Direct group or
// access point for a while, or, for a phone's screen, its hotspot (the banner asks for it).
let bleOff = false; // General's Turn off Bluetooth on Wi-Fi connections, in effect (bleQuiet)
const bleQuiet = wifiQuiet();

function setupNet() {
  const { safeStorage } = require('electron');
  svc.ble = new BleHost({
    helper: svc.helper, server,
    info: () => ({ id: id.macId, name: id.macName.slice(0, 40), os: P.OS.MAC, port: server.port, fp: id.fp }),
    enabled: () => !bleOff && (settings.net.ble !== false || settings.net.blePc === true),
    accept: (g) => (g.os === P.OS.ANDROID ? settings.net.ble !== false : settings.net.blePc === true), // General's two Bluetooth switches
  });
  svc.ble.on('change', pushState);
  // PCs nearby that aren't on this network (not paired yet: they haven't connected to say hello).
  // Looked for only while there's no session; Invite asks one to connect.
  svc.bleLook = new BleLook({ helper: svc.helper, self: () => ({ id: id.macId, name: id.macName.slice(0, 40), os: P.OS.MAC }) });
  svc.bleLook.on('change', pushState);
  setInterval(() => {
    // The session on the same Wi-Fi a while (General's Turn off Bluetooth on Wi-Fi connections,
    // blepolicy.js wifiQuiet): no advertising, its pipes and the session's Bluetooth fallback closed;
    // back as it was when the session ends.
    const off = bleQuiet({ on: settings.net.bleWifiOff !== false, current: () => peer.current, onGroup: () => !!svc.net && svc.net.onGroup });
    if (off !== bleOff) {
      bleOff = off;
      console.log(`[ble] ${off ? 'off: the session is on the same Wi-Fi' : 'on again'}`);
      svc.ble.apply();
      pushState();
    }
    svc.bleLook.look(settings.net.blePc === true && !peer.current);
  }, 3000).unref();
  discovery.extra = {
    list: () => {
      const out = svc.ble.list();
      for (const d of svc.bleLook.list()) if (d.os !== P.OS.MAC && !out.some((x) => x.id === d.id)) out.push(d); // a Mac can't come through Bluetooth to a Mac
      return out;
    },
    invite: (devId) => svc.ble.invite(devId) || svc.bleLook.invite(devId),
  };
  const wifi = (cmd, args, ms) => svc.helper.request(cmd, args, ms);
  svc.net = new NetLink({
    os: P.OS.MAC,
    send: (m) => peer.sendNow(m),
    current: () => {
      const c = peer.current;
      return c && { deviceId: c.deviceId, os: c.os, role: c.role, transport: c.transport === 'ble' ? 'ble' : 'ip', address: c.address };
    },
    host: null, // a Mac can't host a network others join while it stays on its own
    join: {
      can: () => true,
      start: async (ssid, password) => {
        await wifi('wifiLocation').catch(() => {}); // macOS shows scans only to apps with Location
        await wifi('wifiJoin', { ssid, password }, 90000);
      },
      stop: () => wifi('wifiLeave', {}, 30000),
    },
    // A phone's screen goes through adb: on the phone's hotspot the Mac keeps the internet.
    // 'user': Connect with Wi-Fi Direct; 'hotspot': Connect with hotspot.
    hotspot: (why, peerOs) => peerOs === P.OS.ANDROID && why !== 'files' && why !== 'user',
    cable: () => {
      const c = peer.current;
      return !!c && c.os === P.OS.ANDROID && !!svc.wired && svc.wired.toCable(c.deviceId);
    },
  });
  svc.net.on('change', () => {
    if (svc.net.state === 'hotspot') showWindow();
    pushState();
  });
  svc.net.on('dropped', () => settings.sharing.on && actions.setSharing(false)); // Bluetooth can't carry the screen
  peer.hold = (m) => svc.net.holdOut(m, (x) => peer.sendNow(x));
  peer.tap = (m) => svc.net.onMessage(m);
  peer.on('client', () => svc.net.started());
  peer.on('closed', () => svc.net.ended());
  peer.on('transport', () => {
    pushState();
    if (!svc.smb.onBle) svc.smb.mountPc(); // on Wi-Fi now: the PC's folder too
  });
  svc.smb.wifi = (on) => (on ? svc.net.need('smb') : Promise.resolve(svc.net.release('smb')));
  // The phone's screen or an app window asked for while on Bluetooth: its hotspot, then the window.
  let pendingView = null;
  svc.phoneViews.onNoAdb = (v) => {
    const c = peer.current;
    if (!c || c.transport !== 'ble' || c.os !== P.OS.ANDROID) return false;
    pendingView = v;
    svc.net.need('phone').then((ok) => !ok && (pendingView = null));
    return true;
  };
  svc.phone.bridge.on('change', () => {
    if (!pendingView || !svc.phone.bridge.serial) return;
    const v = pendingView;
    pendingView = null;
    if (v.kind === 'app') svc.phoneViews.openApp(v.app, v.title);
    else svc.phoneViews.openScreen();
  });
  svc.phoneViews.on('change', () => {
    if (!svc.phoneViews.list().length && !pendingView) svc.net.release('phone');
  });
  svc.pcView.on('change', () => !svc.pcView.isOpen && svc.net.release('view'));
  const openPcApp = svc.pcApps.open.bind(svc.pcApps);
  svc.pcApps.open = (id) => svc.net.need('apps').then((ok) => ok && openPcApp(id));
  svc.pcApps.on('change', () => {
    const v = svc.pcApps.view;
    if (!(v.windows || []).length) svc.net.release('apps');
  });
  svc.netSecret = {
    seal: (s) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s).toString('base64') : `plain:${s}`),
    open: (s) => {
      if (!s) return '';
      if (s.startsWith('plain:')) return s.slice(6);
      try { return safeStorage.decryptString(Buffer.from(s, 'base64')); } catch { return ''; }
    },
  };
}

// Calls, Messages, Photos and Files from a phone (shared/phonehub.js): loaded when a phone connects with
// one of them on, or the first time a page uses it. Before that none of it exists: no module, no
// listener, nothing sent to the phone. The call window (shared/callwin.js) only with a call.
function setupHub() {
  const anyOn = () => settings.hub.calls || settings.hub.messages || settings.hub.media || settings.hub.files || settings.hub.shareServe;
  peer.on('client', (ctx) => ctx.os === P.OS.ANDROID && !phoneHub && anyOn() && loadHub());
  // The phone shares a folder: loaded for it (its listener comes with it, so this one passes it on).
  peer.on(`t:${P.T.SHARE_OFFER}`, (m, ctx) => ctx && ctx.os === P.OS.ANDROID && !phoneHub && loadHub().share && phoneHub.share.onOffer(m));
  peer.on(`t:${P.T.SHARE_SET}`, (m, ctx) => ctx && ctx.os === P.OS.ANDROID && !phoneHub && loadHub().share && phoneHub.share.act('serve', { on: !!m.serve }));
}

let callwin = null;
function loadHub() {
  if (phoneHub) return phoneHub;
  const { PhoneHub } = require('../shared/phonehub.js');
  const hub = new PhoneHub({
    server: peer, getSettings: () => settings, save: () => store.saveSettings(settings),
    audio: (opts) => require('./callaudio.js').create({ helper: svc.helper, ...opts }), // the calls' sound over Bluetooth
    send: (paths, batch) => !!(svc.fileSend && svc.fileSend.sendBatch(paths, 'send', batch)), // Files: into a folder on the phone
    choose: () => dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, { properties: ['openFile', 'openDirectory', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths)),
    share: { // shared folders with the phone (shared/foldershare.js)
      mounter: require('./phonedrive').mounter, adb: svc && svc.phone.bridge.adb, serialOf: (id) => svc && svc.wired && svc.wired.serialOf(id),
      chooseFolder: () => dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, { properties: ['openDirectory', 'createDirectory'] }).then((r) => (r.canceled ? '' : r.filePaths[0])),
      defaultFolder: path.join(require('os').homedir(), 'MacShare'),
      tls: () => server && server.tls, // served with the session's certificate, which the phone pinned
      wifi: (on) => (!svc.net ? Promise.resolve(false) : on ? svc.net.need('folder') : Promise.resolve(svc.net.release('folder'))), // through Bluetooth
    },
  });
  phoneHub = hub;
  hub.on('change', pushState);
  hub.on('data', (m) => win && !win.isDestroyed() && win.webContents.send('hub', m));
  const popup = () => {
    if (!callwin && !hub.call) return;
    callwin = callwin || require('../shared/callwin.js');
    callwin.update(hub, { corner: 'top', open: goTab });
  };
  hub.on('call', popup);
  hub.on('change', popup);
  if (peer.current && peer.current.os === P.OS.ANDROID) hub.started();
  return hub;
}

// The window on one page (the call window's name opens Calls).
function goTab(tab) {
  if (TABS.includes(tab)) settings.ui.tab = tab; // a window made now opens there
  showWindow();
  if (win && !win.isDestroyed()) win.webContents.send('go', tab);
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('window-all-closed', () => {}); // keep running in the menu bar
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
app.on('before-quit', () => {
  quitting = true;
  if (svc && svc.phoneViews) svc.phoneViews.shutdown();
  if (svc && svc.phoneDrive) svc.phoneDrive.shutdown();
  if (phoneHub && phoneHub.audio) phoneHub.audio.stop(); // the phone's calls go back to it
  if (phoneHub && phoneHub.share) phoneHub.share.stop();
  if (callwin) callwin.close();
  if (svc && svc.wired) svc.wired.stop();
  if (svc) svc.shutdown(); // KVM home first, so the helper releases input
  if (discovery) discovery.stop();
  if (link) link.stop();
  if (server) server.close();
});
