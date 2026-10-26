// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The viewer (camera-view.html): the other computer's camera, answered recvonly to its offer.
'use strict';

const api = window.cam;
const video = document.getElementById('video');
const status = document.getElementById('status');
const again = document.getElementById('again');
const mirror = document.getElementById('mirror');
const name = new URLSearchParams(location.search).get('name') || 'the other computer';
let pc = null;
let pending = [];

function say(text, retry = false) {
  status.textContent = text;
  status.hidden = !text;
  again.hidden = !retry;
}

function reset() {
  if (pc) pc.close();
  pc = null;
  pending = [];
  video.srcObject = null;
}

// Candidates that came before the offer (the sender gathers as it sends it) are kept for it.
async function offer(sdp) {
  if (pc) pc.close();
  if (!pending) pending = [];
  const me = (pc = new RTCPeerConnection({ iceServers: [] }));
  me.ontrack = (e) => {
    video.srcObject = e.streams[0] || new MediaStream([e.track]);
    video.play().catch(() => {});
  };
  me.onicecandidate = (e) => e.candidate && pc === me && api.send({ t: 'ice', candidate: e.candidate.toJSON() });
  me.onconnectionstatechange = () => {
    if (pc !== me) return;
    if (me.connectionState === 'connected') { say(''); api.send({ t: 'live' }); }
    else if (me.connectionState === 'failed') say(`The picture can’t get through from ${name}: are both on the same network?`, true);
  };
  try {
    await me.setRemoteDescription({ type: 'offer', sdp });
    await me.setLocalDescription(await me.createAnswer());
    api.send({ t: 'answer', sdp: me.localDescription.sdp });
    for (const c of pending.splice(0)) await me.addIceCandidate(c).catch(() => {});
    pending = null;
  } catch (e) {
    say('The camera didn’t start: ' + e.message, true);
  }
}

api.on((m) => {
  if (!m) return;
  if (m.t === 'offer') offer(m.sdp);
  else if (m.t === 'ice') {
    if (!pc || pending) (pending || (pending = [])).push(m.candidate);
    else pc.addIceCandidate(m.candidate).catch(() => {});
  } else if (m.t === 'reset') {
    reset();
  } else if (m.t === 'status') {
    const n = m.name || name;
    if (m.status === 'starting') say(`Asking ${n} for its camera…`);
    else if (m.status === 'refused') { reset(); say(`${n} doesn’t share its camera: turn on Camera › “Let this computer see the camera” there.`, true); }
    else if (m.status === 'failed') { reset(); say(`${n}’s camera didn’t start: ${m.error || 'unknown'}`, true); }
    else if (m.status === 'ended') { reset(); say(`${n} stopped its camera.`, true); }
  }
});
again.onclick = () => api.send({ t: 'again' });
mirror.onclick = () => mirror.classList.toggle('on', document.body.classList.toggle('mirror'));
api.send({ t: 'ready' });
