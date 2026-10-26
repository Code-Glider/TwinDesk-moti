// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Camera tab (Mac, PC and Linux): a camera of the other device in a window here. A phone's,
// back or front, through wireless debugging (phoneview.js openCamera, Android 12 or later); the
// other computer's, which it shares only with "Let … see this camera" on there (camshare.js), and
// this computer's the same way. A window, not a webcam other apps can pick.
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

    const bleNote = UI.note('warn', '');
    const note = UI.note('info', '');
    body.append(bleNote, phoneCard, theirCard, ourCard, note);

    let listed = false;
    return (s) => {
      const c = s.camera || {};
      const phone = UI.isPhone(s);
      phoneCard.hidden = !phone;
      theirCard.hidden = ourCard.hidden = phone;
      bleNote.set(!phone && c.connected && c.ble ? 'Through Bluetooth a camera can’t go across: connect over Wi-Fi or a cable.' : '');

      if (phone) {
        const ph = s.phone || {};
        const br = ph.bridge || { state: 'off' };
        const ready = !!ph.connected && br.state === 'ready';
        const open = (br.windows || []).some((w) => w.kind === 'camera');
        phoneRow.setHint(!ph.connected ? 'Not connected' : !ready ? 'Needs wireless debugging: set it up on the Phone page' : open ? 'In a window here: its light and zoom are on the window' : 'In a window here (Android 12 or later)');
        phoneShow.disabled = !ready;
        phoneShow.textContent = open ? 'Show again' : 'Show';
        phoneClose.hidden = !open;
        note.set('A window here, not a webcam other apps can pick.');
        return;
      }

      theirShow.disabled = !c.connected || !!c.ble || (!c.peerShares && !c.viewing);
      theirShow.textContent = c.viewing ? 'Show again' : 'Show';
      theirClose.hidden = !c.viewing;
      theirRow.setHint(!c.connected ? 'Not connected'
        : c.viewing && c.viewStatus === 'live' ? 'In a window here'
          : c.viewing ? 'Asking for it…'
            : c.peerShares ? 'In a window here' : 'Turn on “Let {me} see this camera” on {name} first');

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
      note.set('A window there, not a webcam other apps can pick. The picture goes straight between the two computers.');
    };
  },
});
