/* ============================================================
   WebSocket 实时通道（含自动重连 / 心跳 / WebRTC 信令收发）
   ============================================================ */
import { api, resolveWsUrl } from './api.js';
import { emit } from './state.js';

let ws = null, closed = false, retry = 0, hb = null;

export function deviceId() {
  let d = localStorage.getItem('wuhou.device');
  if (!d) {
    d = JSON.stringify({ id: 'dev_' + Math.random().toString(36).slice(2, 12), name: navigator.platform || 'Web' });
    localStorage.setItem('wuhou.device', d);
  }
  return JSON.parse(d);
}

export async function connect() {
  closed = false;
  let ticket;
  try {
    const r = await api.post('/api/auth/ticket', { device_id: deviceId().id });
    ticket = r.ticket;
  } catch { return scheduleReconnect(); }

  let wsUrl;
  try { wsUrl = await resolveWsUrl(); } catch { return scheduleReconnect(); }
  try { ws = new WebSocket(wsUrl); } catch { return scheduleReconnect(); }

  ws.onopen = () => {
    retry = 0;
    send({ t: 'auth', ticket });
    emit('ws:status', { online: true });
    clearInterval(hb);
    hb = setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'heartbeat' })); }, 30000);
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'welcome') { emit('ws:ready', msg); return; }
    if (msg.t === 'pong') return;
    if (msg.t === 'error') { emit('ws:error', msg); return; }
    if (msg.t === 'event') { emit(`ws:${msg.type}`, msg.data); emit('ws:event', msg); }
  };
  ws.onclose = () => {
    clearInterval(hb);
    emit('ws:status', { online: false });
    if (!closed) scheduleReconnect();
  };
  ws.onerror = () => { try { ws && ws.close(); } catch { /* ignore */ } };
}

function scheduleReconnect() {
  if (closed) return;
  retry = Math.min(retry + 1, 6);
  const delay = Math.min(1000 * retry, 12000);
  setTimeout(connect, delay);
}

export function disconnect() { closed = true; clearInterval(hb); try { ws && ws.close(); } catch { /* ignore */ } }

export function send(obj) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}

/* ---------- 便捷封装 ---------- */
export const rt = {
  typing: (conv) => send({ t: 'typing', conv }),
  read: (conv) => send({ t: 'read', conv }),
  subscribe: (conv) => send({ t: 'subscribe', conv }),
  call: (payload) => send({ t: 'call', ...payload }),
};
