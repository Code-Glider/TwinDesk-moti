// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Camera tab (Mac, PC and Linux): a camera of the other device in a window here. A phone's,
// back or front, through wireless debugging (phoneview.js openCamera, Android 12 or later); the
// other computer's, which it shares only with "Let … see this camera" on there (camshare.js), and
// this computer's the same way. In a window, or with Virtual camera on, in a camera every app here
// can pick ("TwinDesk Camera", shared/vcam.js), installed the first time it's turned on.
'use strict';

UI.tab({
  id: 'camera',
  group: 'More',
  order: 75,
  title: 'Camera',
  icon: 'camera',
  color: 'linear-gradient(#bf5af2, #8944ab)',
  desc: 'See the other device’s camera in a window here.',
  badge: (s) => (s.camera && s.camera.sending ? 'warn' : s.camera && s.camera.viewing ? 'on' : ''),
  build(body) {
    const { api } = UI;
    const cam = (m) => api.camera(m);

    // A phone: its camera in a window (scrcpy's camera source).
    let facing = 'back';
    const phoneFacing = UI.segmented([{ value: 'back', label: 'Back' }, { value: 'front', label: 'Front' }], (v) => {
      facing = v;
      phoneFacing.set(v);
    });
    phoneFacing.set(facing);
    const phoneShow = UI.button('Show', () => api.phoneCamera(true, { facing }), 'primary');
    const phoneClose = UI.button('Close', () => api.phoneCamera(false));
    const phoneRow = UI.row('Show {name}’s camera', '', [phoneFacing, phoneClose, phoneShow]);
    const phoneCard = UI.card('{name}’s camera', [phoneRow]);

    // The other computer's camera here.
    const theirShow = UI.button('Show', () => cam({ do: 'view' }), 'primary');
    const theirClose = UI.button('Close', () => cam({ do: 'close' }));
    const theirRow = UI.row('Show {name}’s camera', '', [theirClose, theirShow]);
    const theirCard = UI.card('{name}’s camera', [theirRow]);

    // This computer's camera there.
    const share = UI.switch((v) => cam({ do: 'share', on: v }), { label: 'Share this camera' });
    const shareRow = UI.row('Let {name} see this camera', '', [share]);
    const device = UI.select([{ value: '', label: 'The default camera' }], (v) => cam({ do: 'device', id: v }));
    const deviceRow = UI.row('Camera', 'Which of {me}’s cameras it shows', [device]);
    const stop = UI.button('Stop', () => cam({ do: 'stop' }), 'danger');
    const liveRow = UI.row('{name} is viewing it now', 'The camera is on while that window is open', [stop]);
    const ourCard = UI.card('{me}’s camera', [shareRow, deviceRow, liveRow]);

    // Virtual camera: what Show starts goes to a camera other apps can pick, not a window.
    const virtual = UI.switch((v) => cam({ do: 'virtual', on: v }), { label: 'Virtual camera' });
    const vRemove = UI.button('Remove', () => cam({ do: 'vcamRemove' }));
    const vRow = UI.row('Virtual camera', '', [vRemove, virtual]);
    const vCard = UI.card('Virtual camera', [vRow]);

    const bleNote = UI.note('warn', '');
    const note = UI.note('info', '');
    body.append(bleNote, vCard, phoneCard, theirCard, ourCard, note);

    let listed = false;
    return (s) => {
      const c = s.camera || {};
      const phone = UI.isPhone(s);
      const v = s.vcam || {};
      const vName = `“${v.name || 'TwinDesk Camera'}”`;
      virtual.set(!!v.on);
      virtual.disable(v.supported === false || !!v.busy);
      vRemove.hidden = !v.installed || !!v.on || !!v.busy;
      vRow.setHint(!v.checked ? 'Checking…'
        : v.supported === false ? v.message
          : v.busy === 'install' ? (v.message || 'Installing…')
            : v.busy === 'remove' ? 'Removing…'
              : v.ready ? (v.live ? `Live: apps here pick ${vName}` : `Show sends the camera to ${vName}, which apps here can pick`)
                : v.on ? (v.message || 'Not installed')
                  : v.message || `Off: Show opens a window. On: the camera goes to ${vName} for Zoom, Teams, the browser…`);
      const how = v.ready ? `What Show starts goes to ${vName}, a camera Zoom, Teams, the browser and every other app here can pick: no window opens.` : '';
      phoneCard.hidden = !phone;
      theirCard.hidden = ourCard.hidden = phone;
      bleNote.set(!phone && c.connected && c.ble ? 'Through Bluetooth a camera can’t go across: connect over Wi-Fi or a cable.' : '');

      if (phone) {
        const ph = s.phone || {};
        const br = ph.bridge || { state: 'off' };
        const ready = !!ph.connected && br.state === 'ready';
        const w = (br.windows || []).find((x) => x.kind === 'camera');
        const open = !!w;
        phoneRow.setHint(!ph.connected ? 'Not connected' : !ready ? 'Needs wireless debugging: set it up on the Phone page'
          : open && w.virtual ? `In ${vName} now`
            : open ? 'In a window here: its light and zoom are on the window'
              : v.ready ? `In ${vName} (Android 12 or later)` : 'In a window here (Android 12 or later)');
        phoneShow.disabled = !ready;
        phoneShow.textContent = open ? (w.virtual ? 'Start again' : 'Show again') : v.ready ? 'Start' : 'Show';
        phoneClose.textContent = open && w.virtual ? 'Stop' : 'Close';
        phoneClose.hidden = !open;
        note.set(how || 'A window here. Turn on Virtual camera for a webcam other apps can pick.');
        return;
      }

      theirShow.disabled = !c.connected || !!c.ble || (!c.peerShares && !c.viewing);
      theirShow.textContent = c.viewing ? (c.viewVirtual ? 'Start again' : 'Show again') : v.ready ? 'Start' : 'Show';
      theirClose.textContent = c.viewing && c.viewVirtual ? 'Stop' : 'Close';
      theirClose.hidden = !c.viewing;
      const where = (c.viewing ? c.viewVirtual : v.ready) ? `In ${vName}` : 'In a window here';
      theirRow.setHint(!c.connected ? 'Not connected'
        : c.viewing && c.viewStatus === 'live' ? where + (c.viewVirtual ? ' now' : '')
          : c.viewing && c.viewStatus === 'refused' ? 'Turn on “Let {me} see this camera” on {name} first'
            : c.viewing && c.viewStatus === 'failed' ? `It didn’t start: ${c.viewError || 'unknown'}`
              : c.viewing && c.viewStatus === 'ended' ? '{name} stopped its camera'
                : c.viewing ? 'Asking for it…'
                  : c.peerShares ? where : 'Turn on “Let {me} see this camera” on {name} first');

      share.set(!!c.share);
      shareRow.setHint(c.shareError || (c.share ? '{name} can open it in a window there. A popup says so here when it does' : 'Off: nobody sees it'));
      device.options([{ value: '', label: 'The default camera' }, ...(c.devices || []).map((d) => ({ value: d.id, label: d.label }))]);
      device.set(c.device || '');
      deviceRow.hidden = !c.share;
      liveRow.hidden = !c.sending;
      if (c.share && !listed) {
        listed = true;
        cam({ do: 'devices' });
      }
      note.set((how || 'A window here. Turn on Virtual camera for a webcam other apps can pick.') + ' The picture goes straight between the two computers.');
    };
  },
});
