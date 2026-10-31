/* ============================================================
   全局状态 / 事件总线 / 密钥管理
   ============================================================ */
import { api } from './api.js';
import * as C from './crypto.js';

export const state = {
  me: null,
  convs: [],
  friends: [],
  groups: [],
  tags: [],             // 好友分组标签：[{id,name,color,count}]（只属于自己）
  requests: { friend: [], group: {} },
  activeConv: null,
  gkeys: {},          // gid -> 群密钥(raw b64)
  roomKey: null,      // 公共聊天室密钥(raw b64)
  roomName: '',       // 公共聊天室名称（服务端下发）
  online: {},         // uid -> bool
  pendingSync: false,
};

/* ---------------- 极简事件总线 ---------------- */
const handlers = new Map();
export function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(fn);
  return () => handlers.get(name).delete(fn);
}
export function emit(name, detail) {
  const set = handlers.get(name);
  if (set) for (const fn of Array.from(set)) { try { fn(detail); } catch (e) { console.error(e); } }
}

/* ---------------- 基础数据 ---------------- */
export async function loadMe() {
  const r = await api.get('/api/users/me');
  state.me = r.user;
  C.setMe(r.user.id);
  return state.me;
}

export async function loadConvs() {
  const r = await api.get('/api/chat/conversations');
  state.convs = r.conversations || [];
  // 公共聊天室的名字由服务端下发（settings.room_name），前端不再各自硬编码 ——
  // 否则改一次名字要动好几个文件，还总有漏的。
  if (r.room && r.room.name) state.roomName = r.room.name;
  return state.convs;
}

/** 公共聊天室名称（后端下发，加载前的兜底值仅用于首屏那一瞬间） */
export function roomName() {
  return state.roomName || '武侯祠';
}

export async function loadFriends() {
  const r = await api.get('/api/friends');
  state.friends = r.friends || [];
  for (const f of state.friends) state.online[f.id] = !!f.online;
  C.preloadPubkeys(state.friends);
  return state.friends;
}

export async function loadTags() {
  try {
    const r = await api.get('/api/friends/tags');
    state.tags = r.tags || [];
  } catch { state.tags = []; }
  return state.tags;
}

/** 标签 id → 标签对象；渲染 layer chip 时到处都要用，集中一处避免各模块各写一遍 */
export function tagMap() {
  const m = {};
  (state.tags || []).forEach((t) => { m[t.id] = t; });
  return m;
}

export async function loadGroups() {
  const r = await api.get('/api/groups');
  state.groups = r.groups || [];
  return state.groups;
}

export async function loadFriendRequests() {
  try {
    const r = await api.get('/api/friends/requests');
    state.requests.friend = r.requests || [];
  } catch { state.requests.friend = []; }
  return state.requests.friend;
}

export function convByKey(key) { return state.convs.find((c) => c.conv === key); }

export function convMembers(conv) {
  if (conv.startsWith('p:')) {
    const [, a, b] = conv.split(':');
    return [a, b].filter((u) => u !== (state.me ? state.me.id : ''));
  }
  return [];
}

export function convTitle(conv) {
  const c = convByKey(conv);
  if (!c) return conv.startsWith('g:') ? '群聊' : '聊天';
  return c.title || '聊天';
}

/* ---------------- 群 / 房间密钥（V2.0 P0-2） ----------------
   每个群 / 公共聊天室一把随机 AES-256-GCM 密钥，用成员 RSA 公钥包裹后
   经服务端中转分发（服务端只见包裹，不见密钥）：
     · ensure*   —— 拉取属于我的包裹并解开；版本更高则覆盖本地
     · bootstrap —— 建群 / 还没有人有密钥时生成并分发给当前成员
     · relay     —— 给还没领到密钥的成员补发（新成员入群走这条）
     · rekey     —— 服务端标记「成员被移除」时轮换新版本，被移除者不再收到 */

async function pubkeyOf(uid) {
  try { return await C.pubKeyOf(uid); } catch { return ''; }
}

async function wrapForMembers(uids, raw) {
  const targets = {};
  for (const uid of uids || []) {
    if (!uid) continue;
    const p = await pubkeyOf(uid);
    if (!p) continue;                       // 未升级的老账号 → 暂不分发
    try { targets[uid] = await C.wrapGroupKey(raw, p); } catch { /* ignore */ }
  }
  return targets;
}

async function groupMembers(gid) {
  try {
    const g = await api.get(`/api/groups/${gid}`);
    return (g.group?.members || []).map((m) => m.id);
  } catch { return []; }
}

/** 生成新版本密钥并分发给全部当前成员 */
export async function bootstrapGroupKey(gid, uids = []) {
  const conv = 'g:' + gid;
  try { await C.ensureGlobal(); } catch { return false; }
  let info = null;
  try { info = await api.get(`/api/chat/keys/group/${gid}`); } catch { return false; }
  let list = (uids && uids.length) ? uids : await groupMembers(gid);
  const me = state.me ? state.me.id : '';
  const all = Array.from(new Set([...(list || []), me].filter(Boolean)));
  if (!all.length) return false;
  // 已有密钥且服务端没要求轮换（例如只是拉了新成员）→ 不该换密钥，
  // 否则新成员读不到历史消息；这里退化成「给缺密钥的人补发」。
  if (info.ver && !info.rekey) return await relayGroupKey(gid, all);
  const newVer = Number(info.ver || 0) + 1;
  const g = await C.rotateGroupKey(conv, newVer);
  const targets = await wrapForMembers(all, g.raw);
  if (!Object.keys(targets).length) return false;
  try {
    const r = await api.post('/api/chat/keys', { gid, targets, ver: newVer });
    if (r && r.stale) await adoptServerGroupKey(gid);   // 并发轮换落败 → 采纳别人的
  } catch { return false; }
  return true;
}

/** 并发轮换落败后：回拉服务端上的密钥版本并采纳 */
async function adoptServerGroupKey(gid) {
  try {
    const back = await api.get(`/api/chat/keys/group/${gid}`);
    if (back && back.wrapped) {
      await C.saveGroupKey('g:' + gid, await C.unwrapGroupKey(back.wrapped), back.ver || 1);
    }
  } catch { /* ignore */ }
}

/** 确保本机持有该群密钥；必要时引导生成 / 轮换 */
export async function ensureGroupKey(gid) {
  const conv = 'g:' + gid;
  try { await C.ensureGlobal(); } catch { return false; }
  let info = null;
  try { info = await api.get(`/api/chat/keys/group/${gid}`); } catch { info = null; }
  if (!info) return !!(await C.groupKeyOf(conv));
  if (info.wrapped) {
    try {
      await C.saveGroupKey(conv, await C.unwrapGroupKey(info.wrapped), info.ver || 1);
      return true;
    } catch { /* 自己没升级，解不开 → 继续尝试引导 */ }
  }
  // 还没有人有密钥，或服务端要求轮换（成员被移除）→ 由我来生成并分发
  if (!info.ver || info.rekey) return await bootstrapGroupKey(gid);
  return !!(await C.groupKeyOf(conv));
}

/* 公共聊天室：全员开放、随时进出，且没有「移除成员」语义，
   因此维持全局统一密钥 —— 保证任何人发出的消息任何人都能读。
   （群聊才有成员边界，所以群密钥 + 移除重钥只用于群聊。） */
async function globalHandle() {
  try { return await C.ensureGlobal(); } catch { return null; }
}

export async function ensureRoomKey() { return !!await globalHandle(); }

export async function bootstrapRoomKey() { return !!await globalHandle(); }

/** 给还没领到密钥的成员补发（新成员入群 / 成员换设备） */
export async function relayGroupKey(gid, uids) {
  const mine = await C.groupKeyOf('g:' + gid);
  if (!mine) return false;
  const targets = await wrapForMembers(uids, mine.raw);
  if (!Object.keys(targets).length) return false;
  try { await api.post('/api/chat/keys', { gid, targets }); } catch { return false; }
  return true;
}

/** 周期同步：轮换重钥、为待领成员补发、顺带同步公共聊天室 */
export async function distributeKeys() {
  try { await C.ensureGlobal(); } catch { return; }
  let r = null;
  try { r = await api.get('/api/chat/keys/pending'); } catch { return; }
  for (const g of r.groups || []) {
    try {
      if (g.rekey) { await bootstrapGroupKey(g.gid); continue; }
      const mine = await C.groupKeyOf('g:' + g.gid);
      if (!mine) continue;
      const targets = await wrapForMembers((g.uids || []).map((u) => u.uid), mine.raw);
      if (Object.keys(targets).length) await api.post('/api/chat/keys', { gid: g.gid, targets });
    } catch { /* 单个群失败不影响其他群 */ }
  }
}

export function startKeySync(ms = 20000) {
  setTimeout(distributeKeys, 3000);
  setInterval(distributeKeys, ms);
}
