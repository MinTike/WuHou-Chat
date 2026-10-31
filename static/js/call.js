/* ============================================================
   语音 / 视频通话（WebRTC，信令经 WebSocket 转发）
   私聊为点对点，群聊为「发起者 ⇄ 各成员」星型连接。
   ============================================================ */
import { el, avatar } from './util.js';
import { toast } from './ui.js';
import { state } from './state.js';
import { rt } from './realtime.js';
import { icon, icoHtml } from './icons.js';

const ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

let active = null;   // { conv, mode, targets:[], peers:Map, local:MediaStream, ui:{}, startedAt }
let pendingInvite = null;

function ensureActive(conv, mode, targets) {
  if (!active) active = { conv, mode, targets: targets || [], peers: new Map(), local: null, ui: null, startedAt: Date.now() };
  return active;
}

/* ---------------- 发起 ---------------- */
export async function startCall(conv, mode = 'audio', targets = []) {
  if (active) { toast('正在通话中', 'warn'); return; }
  const list = (targets || []).filter((u) => u && u !== state.me.id);
  if (!list.length) { toast('没有可呼叫的对象', 'warn'); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' });
  } catch (e) {
    toast('无法获取麦克风/摄像头权限', 'err');
    return;
  }
  ensureActive(conv, mode, list);
  active.local = stream;
  renderCallUI('呼叫中…');
  for (const uid of list) {
    rt.call({ conv, to: uid, kind: 'invite', mode, members: list });
  }
  setTimeout(() => { if (active && active.peers.size === 0) { toast('对方未应答', 'warn'); endCall(true); } }, 45000);
}

/* ---------------- 收到信令 ---------------- */
export async function handleCallEvent(d) {
  const kind = d.kind, from = d.from;
  if (kind === 'invite') {
    if (active) { rt.call({ conv: d.conv, to: from, kind: 'busy' }); return; }
    pendingInvite = d;
    showIncoming(d);
    return;
  }
  if (kind === 'busy') {
    toast('对方正在通话中', 'warn');
    writeRecord(d.conv, d.mode || 'audio', 0, 'busy');
    return;
  }
  if (kind === 'reject') {
    toast('对方拒绝了通话', 'info');
    writeRecord(d.conv, d.mode || 'audio', 0, 'rejected');
    cleanupPeer(from);
    return;
  }
  if (kind === 'hangup') { toast('通话已结束', 'info'); cleanupPeer(from); return; }
  if (!active) return;

  if (kind === 'accept') { await createOffer(from); return; }
  if (kind === 'offer') { await handleOffer(from, d.payload); return; }
  if (kind === 'answer') { await handleAnswer(from, d.payload); return; }
  if (kind === 'candidate') { await handleCandidate(from, d.payload); return; }
}

/* ---------------- 被叫 UI ---------------- */
function showIncoming(d) {
  const root = document.querySelector('#callRoot');
  root.hidden = false;
  root.innerHTML = '';
  const who = { nickname: '对方', id: d.from };
  const box = el('div', { class: 'call' }, [
    el('div', { class: 'call__avatar' }, [avatar(who, 'xl', { status: false })]),
    el('div', { class: 'call__name', text: '来电' }),
    el('div', { class: 'call__state', text: d.mode === 'video' ? '视频通话邀请' : '语音通话邀请' }),
    el('div', { class: 'call__ctrl' }, [
      el('button', { class: 'call__btn call__btn--end', title: '拒绝', html: icon('x', 24), onClick: () => rejectCall(d) }),
      el('button', { class: 'call__btn', title: '接听', html: icon('check', 24), onClick: () => acceptCall(d) }),
    ]),
  ]);
  root.appendChild(box);
}

export async function incomingCall(d) { return showIncoming(d); }

async function acceptCall(d) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: d.mode === 'video' }); }
  catch (e) { toast('无法获取麦克风/摄像头权限', 'err'); return rejectCall(d); }
  ensureActive(d.conv, d.mode, [d.from]);
  active.local = stream;
  renderCallUI('连接中…');
  rt.call({ conv: d.conv, to: d.from, kind: 'accept', mode: d.mode });
}

function rejectCall(d) {
  rt.call({ conv: d.conv, to: d.from, kind: 'reject' });
  // 拒接也留一条记录，双方在会话里都能看到「未接 / 已拒绝」
  writeRecord(d.conv, d.mode || 'audio', 0, 'rejected');
  document.querySelector('#callRoot').hidden = true;
  document.querySelector('#callRoot').innerHTML = '';
  pendingInvite = null;
}

/** 通话结束后写一条通话记录消息（加密后与会话里其它消息一起落库） */
async function writeRecord(conv, mode, duration, status) {
  if (!conv) return;
  try {
    const { sendCallRecord } = await import('./chat.js');
    await sendCallRecord(conv, { mode, duration, status });
  } catch { /* 记录写不进去不影响通话本身 */ }
}

/* ---------------- 连接建立 ---------------- */
async function peerOf(uid) {
  if (active.peers.has(uid)) return active.peers.get(uid);
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const rec = { pc, stream: new MediaStream(), uid };
  active.peers.set(uid, rec);
  if (active.local) for (const t of active.local.getTracks()) pc.addTrack(t, active.local);
  pc.ontrack = (e) => { rec.stream.addTrack(e.track); active.connected = true; renderCallUI('通话中'); };
  pc.onicecandidate = (e) => { if (e.candidate) rt.call({ conv: active.conv, to: uid, kind: 'candidate', payload: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) cleanupPeer(uid);
  };
  return rec;
}

async function createOffer(uid) {
  const rec = await peerOf(uid);
  const offer = await rec.pc.createOffer();
  await rec.pc.setLocalDescription(offer);
  rt.call({ conv: active.conv, to: uid, kind: 'offer', payload: offer });
}

async function handleOffer(uid, sdp) {
  const rec = await peerOf(uid);
  await rec.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await rec.pc.createAnswer();
  await rec.pc.setLocalDescription(answer);
  rt.call({ conv: active.conv, to: uid, kind: 'answer', payload: answer });
  active.connected = true;
  renderCallUI('通话中');
}

async function handleAnswer(uid, sdp) {
  const rec = active.peers.get(uid);
  if (!rec) return;
  await rec.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  active.connected = true;
  renderCallUI('通话中');
}

async function handleCandidate(uid, cand) {
  const rec = active.peers.get(uid);
  if (!rec) return;
  try { await rec.pc.addIceCandidate(new RTCIceCandidate(cand)); } catch { /* ignore */ }
}

/* ---------------- UI ---------------- */
function renderCallUI(statusText) {
  const root = document.querySelector('#callRoot');
  root.hidden = false;
  root.innerHTML = '';
  if (!active) return;

  const videos = el('div', { class: 'call__videos' });
  if (active.mode === 'video') {
    const local = el('div', { class: 'call__video is-min' }, [
      el('video', { autoplay: true, muted: true, playsinline: true }),
      el('div', { class: 'call__label', text: '我' }),
    ]);
    local.querySelector('video').srcObject = active.local;
    videos.appendChild(local);
  }
  for (const [uid, rec] of active.peers) {
    const box = el('div', { class: 'call__video' }, [
      el('video', { autoplay: true, playsinline: true }),
      el('div', { class: 'call__label', text: uid === state.me.id ? '我' : '对方' }),
    ]);
    box.querySelector('video').srcObject = rec.stream;
    videos.appendChild(box);
  }

  // 开关状态挂在 active 上：通话中界面会反复重建（对端加入、状态刷新），
  // 局部闭包变量会被重置成「开」，导致按钮看着没反应
  if (active.mic === undefined) active.mic = true;
  if (active.cam === undefined) active.cam = active.mode === 'video';
  applyTrackState();

  const btnMic = el('button', {
    class: 'call__btn' + (active.mic ? '' : ' is-off'),
    title: active.mic ? '关闭麦克风' : '开启麦克风',
    html: icon(active.mic ? 'mic' : 'micOff', 24),
    onClick: () => { active.mic = !active.mic; renderCallUI('通话中'); toast(active.mic ? '麦克风已开启' : '麦克风已关闭', 'info', 900); },
  });
  const btnCam = el('button', {
    class: 'call__btn' + (active.cam ? '' : ' is-off'),
    title: active.cam ? '关闭摄像头' : '开启摄像头',
    html: icon(active.cam ? 'video' : 'videoOff', 24),
    onClick: () => { active.cam = !active.cam; renderCallUI('通话中'); toast(active.cam ? '摄像头已开启' : '摄像头已关闭', 'info', 900); },
  });

  const box = el('div', { class: 'call' }, [
    videos.children.length ? videos : el('div', { class: 'call__avatar' }, [avatar({ nickname: '通话' }, 'xl', { status: false })]),
    el('div', { class: 'call__name', text: active.mode === 'video' ? '视频通话' : '语音通话' }),
    el('div', { class: 'call__state', text: `${statusText} · ${fmtElapsed()}` }),
    el('div', { class: 'call__ctrl' }, [
      btnMic,
      active.mode === 'video' ? btnCam : null,
      el('button', { class: 'call__btn call__btn--end', title: '结束通话', html: icon('x', 24), onClick: () => endCall() }),
    ]),
  ]);
  root.appendChild(box);
  clearInterval(active.ui?.timer);
  active.ui = { timer: setInterval(() => {
    const s = box.querySelector('.call__state');
    if (s) s.textContent = `通话中 · ${fmtElapsed()}`;
  }, 1000) };
}

/** 把 mic / cam 的开关真正落到音轨上（界面重建后也要重新套用一次） */
function applyTrackState() {
  if (!active || !active.local) return;
  active.local.getAudioTracks().forEach((t) => { t.enabled = active.mic !== false; });
  active.local.getVideoTracks().forEach((t) => { t.enabled = active.cam !== false; });
}

function fmtElapsed() {
  const s = Math.floor((Date.now() - (active?.startedAt || Date.now())) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------------- 挂断 ---------------- */
function cleanupPeer(uid) {
  if (!active) return;
  const rec = active.peers.get(uid);
  if (rec) { try { rec.pc.close(); } catch { /* ignore */ } active.peers.delete(uid); }
  if (active.peers.size === 0 && active.targets.length <= 1) { endCall(true); return; }
  renderCallUI('通话中');
}

export function endCall(silent = false) {
  if (!active) return;
  const { conv, mode, startedAt } = active;
  // 只有真正连上过才算「通话结束」，一直没人接的算「未接听」
  const status = active.connected ? 'ended' : 'missed';
  const duration = active.connected ? (Date.now() - (startedAt || Date.now())) / 1000 : 0;
  for (const uid of active.targets) rt.call({ conv: active.conv, to: uid, kind: 'hangup' });
  for (const [, rec] of active.peers) { try { rec.pc.close(); } catch { /* ignore */ } }
  if (active.local) active.local.getTracks().forEach((t) => t.stop());
  clearInterval(active.ui?.timer);
  active = null; pendingInvite = null;
  const root = document.querySelector('#callRoot');
  root.hidden = true; root.innerHTML = '';
  if (!silent) toast('通话已结束', 'info');
  writeRecord(conv, mode, duration, status);
}
