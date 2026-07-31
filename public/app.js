/* ВТОРОЙ ИГРОК - клиент: WebRTC P2P + Firebase Realtime Database (сигналы).
   Финальная сборка: без блокирующих оверлеев, индикатор связи стартует всегда. */
'use strict';

const firebaseConfig = {
  apiKey: "AIzaSyCWOrWHIkyYj13vU9B2IEvdLsXs7jbChyA",
  authDomain: "two-players-945a2.firebaseapp.com",
  databaseURL: "https://two-players-945a2-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "two-players-945a2",
  storageBucket: "two-players-945a2.firebasestorage.app",
  messagingSenderId: "947219222314",
  appId: "1:947219222314:web:c67fff24831d3945d61853"
};

const hasFirebase = (typeof firebase !== 'undefined');
let db = null, SV = null;
if (hasFirebase) {
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    SV = firebase.database.ServerValue.TIMESTAMP;
  } catch (e) { console.warn('firebase init failed:', e); }
}

const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443',
             'turn:openrelay.metered.ca:443?transport=tcp'],
      username: 'openrelayproject', credential: 'openrelayproject' }
  ],
  iceCandidatePoolSize: 10
};
const QUALITY = {
  max:    { bitrate: 12000000, fps: 60, label: '1080p60 макс' },
  high:   { bitrate: 8000000,  fps: 60, label: '1080p60' },
  medium: { bitrate: 4000000,  fps: 45, label: '720p45' },
  eco:    { bitrate: 2000000,  fps: 30, label: '720p30' }
};

let roomCode = null, isHost = false, myId = null, peerId = null, pc = null;
let micStream = null, screenStream = null, screenTracks = [];
let makingOffer = false, statsTimer = null, prevVideo = null;
let remoteMix = new MediaStream();
let audioCtx = null, localAnalyser = null, remoteAnalyser = null, metersRAF = null, meterBuf = null;
let membersRef = null, signalsRef = null, myMemberRef = null;

const $ = (id) => document.getElementById(id);
const el = {
  netLed: $('netLed'), netStatus: $('netStatus'), pingValue: $('pingValue'),
  lobbyScreen: $('lobbyScreen'),
  btnCreate: $('btnCreate'), joinCode: $('joinCode'), btnJoin: $('btnJoin'), lobbyError: $('lobbyError'),
  waitScreen: $('waitScreen'), roomCodeDisplay: $('roomCodeDisplay'),
  btnCopyLink: $('btnCopyLink'), btnCopyCode: $('btnCopyCode'),
  waitText: $('waitText'), btnCancelWait: $('btnCancelWait'),
  callScreen: $('callScreen'),
  remoteVideo: $('remoteVideo'), stageEmpty: $('stageEmpty'),
  stageEmptyText: $('stageEmptyText'), stageBadge: $('stageBadge'),
  localVideo: $('localVideo'), eventBanner: $('eventBanner'),
  peerLed: $('peerLed'), peerName: $('peerName'),
  meterRemote: $('meterRemote'), meterLocal: $('meterLocal'),
  statRes: $('statRes'), statFps: $('statFps'), barFps: $('barFps'),
  statBitrate: $('statBitrate'), barBitrate: $('barBitrate'),
  statRtt: $('statRtt'), barRtt: $('barRtt'),
  statJitter: $('statJitter'), statLoss: $('statLoss'), barLoss: $('barLoss'),
  btnMic: $('btnMic'), icoMic: $('icoMic'), capMic: $('capMic'),
  btnShare: $('btnShare'), capShare: $('capShare'), qualitySelect: $('qualitySelect'),
  btnCopyCallLink: $('btnCopyCallLink'), btnLeave: $('btnLeave'),
  toast: $('toast'), remoteAudio: $('remoteAudio'), unsupported: $('unsupported')
};

function genId() {
  try { return crypto.randomUUID(); }
  catch { return 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
}
function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
function showScreen(name) {
  el.lobbyScreen.hidden = name !== 'lobby';
  el.waitScreen.hidden = name !== 'wait';
  el.callScreen.hidden = name !== 'call';
}
let toastTimer = null;
function toast(msg) {
  if (!el.toast) return;
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2800);
}
let bannerTimer = null;
function banner(msg, kind) {
  if (!el.eventBanner) return;
  el.eventBanner.textContent = msg;
  el.eventBanner.className = 'event-banner event-banner--' + (kind || 'good');
  el.eventBanner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.eventBanner.hidden = true; }, 3500);
}
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(okMsg);
}
function roomLink() { return location.origin + location.pathname + '?room=' + roomCode; }
function lobbyError(msg) {
  if (!el.lobbyError) return;
  el.lobbyError.textContent = msg; el.lobbyError.hidden = false;
  el.lobbyError.style.animation = 'none';
  void el.lobbyError.offsetWidth;
  el.lobbyError.style.animation = '';
}

function watchConnection() {
  if (!db) {
    if (el.netLed) el.netLed.className = 'led led--amber';
    if (el.netStatus) el.netStatus.textContent = 'без базы';
    return;
  }
  db.ref('.info/connected').on('value', (s) => {
    if (s.val() === true) {
      el.netLed.className = 'led led--green';
      el.netStatus.textContent = 'на связи';
    } else {
      el.netLed.className = 'led led--red';
      el.netStatus.textContent = 'нет связи';
      el.pingValue.textContent = '—';
    }
  });
}

function pushSignal(to, type, extra) {
  if (!db || !roomCode || !myId) return;
  db.ref('rooms/' + roomCode + '/signals').push(
    Object.assign({ from: myId, to: to, type: type, ts: SV }, extra || {})
  );
}
function subscribeSignals() {
  if (!db) return;
  signalsRef = db.ref('rooms/' + roomCode + '/signals');
  signalsRef.on('child_added', (snap) => {
    const sig = snap.val();
    if (!sig) { snap.ref.remove(); return; }
    if (sig.from === myId) { snap.ref.remove(); return; }
    if (sig.to !== myId && sig.to !== '*') return;
    if (sig.type === 'offer' || sig.type === 'answer' || sig.type === 'candidate') {
      handleSignal(sig.from, sig);
    }
    snap.ref.remove();
  });
}
function subscribeMembers() {
  if (!db) return;
  membersRef = db.ref('rooms/' + roomCode + '/members');
  membersRef.on('child_added', (snap) => {
    if (snap.key === myId) return;
    if (!peerId) peerId = snap.key;
    if (isHost) onPeerArrived();
  });
  membersRef.on('child_changed', (snap) => {
    if (snap.key === peerId) applyPeerState(snap.val());
  });
  membersRef.on('child_removed', (snap) => {
    if (snap.key === peerId) onPeerLeft();
  });
}
async function writeMember() {
  if (!db) return;
  myMemberRef = db.ref('rooms/' + roomCode + '/members/' + myId);
  await myMemberRef.set({ mic: true, sharing: false, ts: SV });
  myMemberRef.onDisconnect().remove();
}

async function createRoom() {
  if (!db) throw 'Сигнальный канал недоступен. Обнови страницу (Ctrl+Shift+R).';
  myId = genId(); isHost = true;
  let code = genCode();
  for (let i = 0; i < 12; i++) {
    const s = await db.ref('rooms/' + code).get();
    if (!s.exists()) break;
    code = genCode();
  }
  roomCode = code;
  renderRoomCode(code);
  showScreen('wait');
  await writeMember();
  subscribeMembers();
  subscribeSignals();
}
async function joinRoom(code) {
  if (!db) throw 'Сигнальный канал недоступен. Обнови страницу (Ctrl+Shift+R).';
  const roomSnap = await db.ref('rooms/' + code).get();
  if (!roomSnap.exists()) throw 'Комната не найдена. Проверь код.';
  const mSnap = await db.ref('rooms/' + code + '/members').get();
  if (mSnap.exists() && Object.keys(mSnap.val() || {}).length >= 2) {
    throw 'В комнате уже два человека.';
  }
  myId = genId(); isHost = false; roomCode = code;
  await writeMember();
  subscribeMembers();
  subscribeSignals();
  enterCall();
  banner('Ты в комнате. Соединяемся...', 'good');
  sendState();
}
function renderRoomCode(code) {
  el.roomCodeDisplay.innerHTML = '';
  for (const ch of code) {
    const s = document.createElement('span'); s.textContent = ch;
    el.roomCodeDisplay.appendChild(s);
  }
}

async function ensureMic() {
  if (micStream) return micStream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const e = new Error('NO_MEDIA'); throw e;
  }
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false
  });
  startLocalMeter(micStream);
  return micStream;
}

el.btnCreate.addEventListener('click', async () => {
  try {
    el.btnCreate.disabled = true;
    el.lobbyError.hidden = true;
    await ensureMic();
    await createRoom();
  } catch (err) {
    el.btnCreate.disabled = false;
    if (err && err.name === 'NotAllowedError') {
      lobbyError('Ты запретил микрофон. Разреши его в браузере и нажми «Создать» снова.');
    } else if (err && err.message === 'NO_MEDIA') {
      lobbyError('Этот браузер не даёт доступ к микрофону. Открой сайт в Chrome, Edge или Safari.');
    } else if (typeof err === 'string') {
      lobbyError(err);
    } else {
      lobbyError('Не удалось создать комнату. Обнови страницу (Ctrl+Shift+R) и попробуй снова.');
    }
  }
});
el.btnJoin.addEventListener('click', joinByCode);
el.joinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinByCode(); });
el.joinCode.addEventListener('input', () => {
  el.joinCode.value = el.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});
async function joinByCode() {
  const code = el.joinCode.value.trim();
  if (code.length !== 4) return lobbyError('Код комнаты - 4 символа.');
  try {
    el.btnJoin.disabled = true;
    el.lobbyError.hidden = true;
    await ensureMic();
    await joinRoom(code);
    el.btnJoin.disabled = false;
  } catch (err) {
    el.btnJoin.disabled = false;
    if (err && err.name === 'NotAllowedError') {
      lobbyError('Ты запретил микрофон. Разреши его и нажми «Войти» снова.');
    } else if (err && err.message === 'NO_MEDIA') {
      lobbyError('Этот браузер не даёт доступ к микрофону. Открой сайт в Chrome, Edge или Safari.');
    } else {
      lobbyError(typeof err === 'string' ? err : 'Нет доступа к микрофону. Разреши его в браузере.');
    }
  }
}
el.btnCopyLink.addEventListener('click', () => copyText(roomLink(), 'Ссылка скопирована - отправь другу'));
el.btnCopyCode.addEventListener('click', () => copyText(roomCode, 'Код комнаты скопирован'));
el.btnCancelWait.addEventListener('click', leaveAll);

function enterCall() {
  showScreen('call');
  el.stageEmpty.hidden = false;
  el.stageEmptyText.textContent = isHost
    ? 'Напарник на связи. Нажми «Демонстрация», чтобы показать свой экран.'
    : 'Ты подключился. Как только друг включит демонстрацию - его экран появится здесь.';
  el.peerLed.className = 'led led--green';
  startStats();
}

function ensurePC() {
  if (pc) return pc;
  pc = new RTCPeerConnection(RTC_CONFIG);

  if (micStream) micStream.getAudioTracks().forEach((t) => pc.addTrack(t, micStream));
  if (screenStream) {
    const v = screenStream.getVideoTracks()[0]; if (v) pc.addTrack(v, screenStream);
    const a = screenStream.getAudioTracks()[0]; if (a) pc.addTrack(a, screenStream);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate && peerId) pushSignal(peerId, 'candidate', { candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    remoteMix.addTrack(e.track);
    if (e.track.kind === 'video') {
      el.remoteVideo.srcObject = remoteMix;
      el.remoteVideo.muted = true;
      el.remoteVideo.play().catch(() => {});
      el.stageEmpty.hidden = true;
    } else {
      el.remoteAudio.srcObject = remoteMix;
      el.remoteAudio.play().catch(() => {});
      startRemoteMeter(remoteMix);
    }
    e.track.onended = () => {
      remoteMix.removeTrack(e.track);
      if (e.track.kind === 'video') {
        el.stageEmpty.hidden = false;
        el.stageEmptyText.textContent = 'Напарник остановил демонстрацию.';
      }
    };
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      el.peerLed.className = 'led led--green';
      banner('Прямое соединение установлено', 'good');
      applyQuality();
    } else if (s === 'disconnected') {
      el.peerLed.className = 'led led--amber';
    } else if (s === 'failed') {
      el.peerLed.className = 'led led--red';
      banner('Связь прервалась - переподключаемся...', 'warn');
      pc.restartIce();
    }
  };
  pc.onnegotiationneeded = async () => {
    if (!peerId) return;
    try {
      makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
      pushSignal(peerId, 'offer', { sdp: pc.localDescription });
    } catch (err) { console.warn('offer error', err); }
    finally { makingOffer = false; }
  };
  return pc;
}
async function handleSignal(fromId, msg) {
  if (!peerId) peerId = fromId;
  if (!pc) ensurePC();
  try {
    if (msg.type === 'offer') {
      const collision = makingOffer || pc.signalingState !== 'stable';
      if (collision && isHost) return;
      await pc.setRemoteDescription(msg.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      pushSignal(fromId, 'answer', { sdp: pc.localDescription });
    } else if (msg.type === 'answer') {
      await pc.setRemoteDescription(msg.sdp);
    } else if (msg.type === 'candidate') {
      try { await pc.addIceCandidate(msg.candidate); } catch {}
    }
  } catch (err) { console.warn('signal error', err); }
}
function onPeerArrived() {
  enterCall();
  ensurePC();
  banner('Напарник подключился', 'good');
  sendState();
}
function onPeerLeft() {
  peerId = null;
  if (pc) { pc.close(); pc = null; }
  remoteMix.getTracks().forEach((t) => remoteMix.removeTrack(t));
  el.remoteVideo.srcObject = null;
  el.remoteAudio.srcObject = null;
  el.peerLed.className = 'led led--red';
  el.meterRemote.style.width = '0%';
  if (isHost) {
    el.stageEmpty.hidden = false;
    el.stageEmptyText.textContent = 'Напарник вышел. Комната жива - ждём его возвращения...';
    banner('Напарник отключился. Он может зайти по тому же коду.', 'warn');
  } else {
    banner('Хост закрыл комнату', 'warn');
    setTimeout(() => {
      leaveAll();
      lobbyError('Хост закрыл комнату. Пусть создаст новую и пришлёт код.');
    }, 2200);
  }
}

el.btnShare.addEventListener('click', async () => {
  if (screenStream) return stopScreenShare(false);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    return toast('Демонстрация экрана недоступна в этом браузере. Открой сайт в Chrome или Edge.');
  }
  try {
    el.btnShare.disabled = true;
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor', frameRate: { ideal: 60, max: 60 },
               width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000 },
      systemAudio: 'include', selfBrowserSurface: 'exclude', preferCurrentTab: false
    });
    el.btnShare.disabled = false;

    const vTrack = screenStream.getVideoTracks()[0];
    vTrack.contentHint = 'detail';
    vTrack.addEventListener('ended', () => stopScreenShare(true));
    screenTracks = screenStream.getTracks();

    el.localVideo.srcObject = screenStream;
    el.localVideo.hidden = false;

    if (pc) {
      pc.addTrack(vTrack, screenStream);
      const aTrack = screenStream.getAudioTracks()[0];
      if (aTrack) pc.addTrack(aTrack, screenStream);
    }

    el.btnShare.classList.add('is-live');
    el.capShare.textContent = 'в эфире';
    el.stageBadge.hidden = false;
    applyQuality();
    sendState();
    toast(screenStream.getAudioTracks().length
      ? 'Экран в эфире - вместе со звуком игры'
      : 'Экран в эфире (без системного звука - отметь галочку в окне захвата)');
  } catch (err) {
    el.btnShare.disabled = false;
    screenStream = null;
    if (err && err.name !== 'NotAllowedError') toast('Не удалось начать демонстрацию');
  }
});
function stopScreenShare(silent) {
  if (screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null; }
  if (pc && screenTracks.length) {
    pc.getSenders().forEach((s) => { if (s.track && screenTracks.includes(s.track)) pc.removeTrack(s); });
  }
  screenTracks = [];
  el.localVideo.srcObject = null;
  el.localVideo.hidden = true;
  el.btnShare.classList.remove('is-live');
  el.capShare.textContent = 'демонстрация';
  el.stageBadge.hidden = true;
  sendState();
  if (!silent) toast('Демонстрация остановлена');
}

async function applyQuality() {
  if (!pc) return;
  const preset = QUALITY[el.qualitySelect.value] || QUALITY.high;
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = preset.bitrate;
    params.encodings[0].maxFramerate = preset.fps;
    try { await sender.setParameters(params); } catch (err) { console.warn(err); }
  }
}
el.qualitySelect.addEventListener('change', () => {
  applyQuality();
  const p = QUALITY[el.qualitySelect.value];
  if (p) toast('Качество: ' + p.label);
});

el.btnMic.addEventListener('click', () => {
  if (!micStream) return;
  const track = micStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  el.btnMic.classList.toggle('is-muted', !track.enabled);
  el.icoMic.textContent = track.enabled ? '🎙' : '🔇';
  el.capMic.textContent = track.enabled ? 'микрофон' : 'выкл';
  sendState();
});
function sendState() {
  if (!myMemberRef) return;
  const t = micStream ? micStream.getAudioTracks()[0] : null;
  myMemberRef.update({ mic: t ? t.enabled : true, sharing: !!screenStream });
}
function applyPeerState(state) {
  el.peerName.textContent = (state && state.mic === false) ? 'Напарник (микрофон выкл)' : 'Напарник';
}

el.btnCopyCallLink.addEventListener('click', () => copyText(roomLink(), 'Ссылка на комнату скопирована'));
el.btnLeave.addEventListener('click', leaveAll);
window.addEventListener('beforeunload', () => {
  try { if (myMemberRef) myMemberRef.remove(); } catch {}
  if (pc) pc.close();
});

function leaveAll() {
  stopScreenShare(true);
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (pc) { pc.close(); pc = null; }
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  stopMeters();
  try { if (membersRef) membersRef.off(); } catch {}
  try { if (signalsRef) signalsRef.off(); } catch {}
  try { if (myMemberRef) { myMemberRef.remove(); myMemberRef = null; } } catch {}
  try { if (isHost && roomCode && db) db.ref('rooms/' + roomCode).remove(); } catch {}
  membersRef = null; signalsRef = null;
  remoteMix = new MediaStream();
  el.remoteVideo.srcObject = null;
  el.remoteAudio.srcObject = null;
  el.localVideo.srcObject = null;
  el.localVideo.hidden = true;
  el.btnShare.classList.remove('is-live');
  el.capShare.textContent = 'демонстрация';
  el.btnMic.classList.remove('is-muted');
  el.icoMic.textContent = '🎙';
  el.capMic.textContent = 'микрофон';
  el.stageBadge.hidden = true;
  el.eventBanner.hidden = true;
  resetStatsUI();
  roomCode = null; peerId = null; isHost = false; myId = null; prevVideo = null;
  showScreen('lobby');
}

function startStats() {
  if (statsTimer) clearInterval(statsTimer);
  prevVideo = null; resetStatsUI();
  statsTimer = setInterval(collectStats, 1000);
}
async function collectStats() {
  if (!pc) return;
  let video = null, remote = null;
  try {
    const report = await pc.getStats();
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video' && !r.isRemote) {
        if (!video || r.bytesSent > video.bytesSent) video = r;
      }
      if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remote = r;
    });
  } catch { return; }

  if (video) {
    const now = performance.now();
    if (prevVideo && now > prevVideo.t) {
      const dt = (now - prevVideo.t) / 1000;
      const bps = ((video.bytesSent - prevVideo.bytes) * 8) / dt;
      el.statBitrate.textContent = fmtBitrate(bps);
      setBar(el.barBitrate, (bps / 12000000) * 100);
    }
    prevVideo = { t: now, bytes: video.bytesSent };
    if (video.frameWidth && video.frameHeight) el.statRes.textContent = video.frameWidth + 'x' + video.frameHeight;
    const fps = video.framesPerSecond || 0;
    el.statFps.textContent = fps ? String(Math.round(fps)) : '—';
    setBar(el.barFps, (fps / 60) * 100, fps > 0 && fps < 24, fps > 0 && fps < 12);
  }
  if (remote) {
    if (remote.roundTripTime != null) {
      const ms = Math.round(remote.roundTripTime * 1000);
      el.statRtt.textContent = ms + ' мс';
      el.pingValue.textContent = ms + ' мс';
      setBar(el.barRtt, (ms / 300) * 100, ms > 80, ms > 150);
    }
    if (remote.jitter != null) el.statJitter.textContent = (remote.jitter * 1000).toFixed(1) + ' мс';
    if (remote.packetsLost != null && video && video.packetsSent > 0) {
      const pct = (remote.packetsLost / video.packetsSent) * 100;
      el.statLoss.textContent = pct === 0 ? '0 %' : pct.toFixed(2) + ' %';
      setBar(el.barLoss, Math.min(100, pct * 20), pct > 0.3, pct > 1);
    }
  }
}
function setBar(bar, pct, warn, bad) {
  bar.style.width = Math.max(2, Math.min(100, pct)) + '%';
  bar.className = bad ? 'bad' : (warn ? 'warn' : '');
}
function fmtBitrate(bps) {
  if (bps >= 1000000) return (bps / 1000000).toFixed(1) + ' Мбит/с';
  return Math.round(bps / 1000) + ' Кбит/с';
}
function resetStatsUI() {
  el.statRes.textContent = '—'; el.statFps.textContent = '—';
  el.statBitrate.textContent = '—'; el.statRtt.textContent = '—';
  el.statJitter.textContent = '—'; el.statLoss.textContent = '—';
  el.pingValue.textContent = '—';
  [el.barFps, el.barBitrate, el.barRtt, el.barLoss].forEach((b) => { b.style.width = '0%'; b.className = ''; });
}

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function makeAnalyser(stream) {
  const ctx = ensureAudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
  return an;
}
function startLocalMeter(stream) { try { localAnalyser = makeAnalyser(stream); } catch { localAnalyser = null; } runMeters(); }
function startRemoteMeter(stream) { try { remoteAnalyser = makeAnalyser(stream); } catch { remoteAnalyser = null; } runMeters(); }
function meterLevel(an) {
  if (!an) return 0;
  if (!meterBuf || meterBuf.length !== an.frequencyBinCount) meterBuf = new Uint8Array(an.frequencyBinCount);
  an.getByteTimeDomainData(meterBuf);
  let sum = 0;
  for (let i = 0; i < meterBuf.length; i++) { const v = (meterBuf[i] - 128) / 128; sum += v * v; }
  return Math.min(100, Math.sqrt(sum / meterBuf.length) * 300);
}
function runMeters() {
  if (metersRAF) return;
  const loop = () => {
    el.meterLocal.style.width = meterLevel(localAnalyser) + '%';
    el.meterRemote.style.width = meterLevel(remoteAnalyser) + '%';
    metersRAF = requestAnimationFrame(loop);
  };
  loop();
}
function stopMeters() {
  if (metersRAF) cancelAnimationFrame(metersRAF);
  metersRAF = null; localAnalyser = null; remoteAnalyser = null;
  el.meterLocal.style.width = '0%'; el.meterRemote.style.width = '0%';
}

(function init() {
  if (el.unsupported) el.unsupported.hidden = true;
  watchConnection();
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) {
    el.joinCode.value = urlRoom.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (el.joinCode.value.length === 4) toast('Код подставлен из ссылки - нажми «Войти»');
  }
})();
