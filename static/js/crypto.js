/* ============================================================
   加密与密钥托管
   ------------------------------------------------------------
   · 身份密钥：RSA-OAEP 2048，注册时本地生成；私钥用「口令派生的
     AES-GCM 密钥」加密后以 keyblob 形式上送服务端，换设备可恢复。
   · 私聊：每个会话一把随机 AES-256-GCM 密钥，按收件人公钥逐个包裹。
   · 群聊 / 公共聊天室：仍用全局统一密钥（P0-2 再升级为群密钥）。
   · 密钥托管：每把会话密钥额外用「服务端 RSA 公钥」包一份（keys.__escrow）。
     内容在传输与落库环节仍是密文，但平台可解密用于违规检测与举报核查 ——
     这是 V2.0 明确的产品取舍：可用性 + 可治理优先于「平台不可解密」。
   · 文件：本地 AES-GCM 加密后再上传，服务端保存不透明字节流。
   ============================================================ */
import { api } from './api.js';

const DB_NAME = 'wuhouchat';
const DB_VER = 1;

/* ---------------- 编码 ---------------- */
export function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/* ---------------- IndexedDB ----------------
   注意：IndexedDB 在「被其他标签页占用（onblocked）」或隐私模式下可能既不
   resolve 也不 reject，历史上会导致注册流程永久卡在生成密钥阶段。
   因此这里统一加超时熔断 + 失败即降级为「无本地缓存」模式。 */
let _db = null;
let _idbDead = false;
const IDB_TIMEOUT = 5000;

function db() {
  if (_db) return Promise.resolve(_db);
  if (_idbDead) return Promise.reject(new Error('IndexedDB 不可用'));
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VER);
    } catch (e) { _idbDead = true; reject(e); return; }
    const done = (fn) => { clearTimeout(timer); fn(); };
    const timer = setTimeout(() => {
      _idbDead = true;
      try { req.result && req.result.close(); } catch { /* ignore */ }
      reject(new Error('IndexedDB 打开超时'));
    }, IDB_TIMEOUT);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
      if (!d.objectStoreNames.contains('plain')) {
        const s = d.createObjectStore('plain', { keyPath: 'id' });
        s.createIndex('conv', 'conv');
        s.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => done(() => { _db = req.result; resolve(_db); });
    req.onerror = () => done(() => { _idbDead = true; reject(req.error); });
    req.onblocked = () => done(() => {
      _idbDead = true;
      reject(new Error('IndexedDB 被其他页面占用'));
    });
  });
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    let t;
    try { t = d.transaction(store, mode); } catch (e) { reject(e); return; }
    const out = fn(t.objectStore(store));
    const timer = setTimeout(() => { try { t.abort(); } catch { /* ignore */ } reject(new Error('IndexedDB 事务超时')); }, IDB_TIMEOUT);
    t.oncomplete = () => { clearTimeout(timer); resolve(out && out.result !== undefined ? out.result : out); };
    t.onsuccess = () => { clearTimeout(timer); resolve(out && out.result !== undefined ? out.result : out); };
    t.onerror = () => { clearTimeout(timer); reject(t.error); };
    t.onabort = () => { clearTimeout(timer); reject(t.error || new Error('IndexedDB 事务已中止')); };
  });
}

// 键值读写一律降级为「失败即忽略」，绝不阻断注册/登录主流程
export const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k)).then((r) => (r ? r.v : null)).catch(() => null);
export const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put({ k, v })).catch(() => null);
export const kvDel = (k) => tx('kv', 'readwrite', (s) => s.delete(k)).catch(() => null);

/* ---------------- 全局统一密钥 ----------------
   全站（私聊 / 群聊 / 公共聊天室 / 动态 / 文件）共用一把 AES-256-GCM 密钥：
   登录后由服务端下发，本地缓存。这样彻底消除「密钥未同步 / 不在可见范围」
   导致的不可读；代价是所有已登录用户在密码学上处于同一信任域。 */
const GLOBAL_TOKEN = 'gk1';   // 密钥句柄（不代表密钥本身）
let GK = null;                // CryptoKey（全局密钥）
let GK_B64 = '';
let MY_UID = '';
let ESCROW_PUB = '';          // 服务端托管公钥：会话密钥要再包一份给平台
let ESCROW_REQ = true;        // 服务端要求「必须可解密」，否则消息会被拒收

async function importGlobal(raw) {
  GK = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  GK_B64 = b64(raw);
}

/** 取全局密钥句柄；未加载则向服务端索取（先读本地缓存，再走网络） */
export async function ensureGlobal() {
  if (GK) return GLOBAL_TOKEN;
  try {
    const cached = await kvGet('gk');
    if (cached) await importGlobal(unb64(cached));
  } catch { /* 缓存无效 */ }
  try {
    const r = await api.get('/api/crypto/key');
    if (r && r.key) {
      await importGlobal(unb64(r.key));
      await kvSet('gk', r.key);
      await cacheGlobalDevice();
      if (r.conv_keys !== undefined) setConvKeysFlag(r.conv_keys);
      if (r.escrow_pub) ESCROW_PUB = r.escrow_pub;
      if (r.escrow_required !== undefined) ESCROW_REQ = !!r.escrow_required;
    }
  } catch (e) {
    if (!GK) throw new Error('无法获取全局加密密钥，请重新登录');
  }
  return GK ? GLOBAL_TOKEN : null;
}

/** 托管公钥：ensureGlobal 走缓存提前返回时可能没拿到，这里补一次 */
async function escrowKey() {
  if (ESCROW_PUB) return ESCROW_PUB;
  try {
    const r = await api.get('/api/crypto/key');
    if (r && r.escrow_pub) ESCROW_PUB = r.escrow_pub;
  } catch { /* 拿不到就不托管，由服务端决定放行或拒收 */ }
  return ESCROW_PUB;
}
export function escrowPub() { return ESCROW_PUB; }

async function gk() {
  if (!GK) await ensureGlobal();
  if (!GK) throw new Error('加密密钥未就绪，请重新登录');
  return GK;
}

/* ---------------- 本机缓存（刷新免重新登录即可继续解密） ---------------- */
async function deviceKey() {
  let sec = await kvGet('devsec');
  if (!sec) {
    sec = b64(crypto.getRandomValues(new Uint8Array(32)));
    await kvSet('devsec', sec);
  }
  return crypto.subtle.importKey('raw', unb64(sec), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 全局密钥缓存在本机，用随机设备密钥二次包裹，避免明文落盘 */
async function cacheGlobalDevice() {
  try {
    if (!GK_B64) return;
    const k = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, unb64(GK_B64));
    await kvSet('gkdev', JSON.stringify({ i: b64(iv), c: b64(ct) }));
  } catch { /* ignore */ }
}

/** 刷新页面后恢复全局密钥（无需重新输入口令） */
export async function tryDeviceUnlock() {
  if (GK) return true;
  try {
    const blob = await kvGet('gkdev');
    if (!blob) return false;
    const { i, c } = JSON.parse(blob);
    const k = await deviceKey();
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(i) }, k, unb64(c));
    await importGlobal(raw);
    return true;
  } catch { return false; }
}

export function setMe(uid) { MY_UID = uid; }
export function ready() { return !!GK; }
export function myPubB64() {
  if (!GK) return '';
  return hasIdentity()
    ? 'RSA-OAEP-2048 · 会话级密钥（平台托管）'
    : '全局统一密钥 · AES-256-GCM';
}
/** 服务端是否持有可解密的托管密钥（供设置页如实说明） */
export function escrowOn() { return !!ESCROW_PUB; }
export function globalToken() { return GK ? GLOBAL_TOKEN : null; }

/* ---------------- 身份密钥（RSA-OAEP-2048） ----------------
   V2.0 恢复「服务端只持公钥」的身份层：
     · 私钥永不出端，只以两种形态存在 —— 口令派生的 keyblob（跨设备恢复）、
       本机设备密钥包裹的 IndexedDB 缓存（刷新免输口令）；
     · 老账号的公钥是占位值（gk-v1 / PUB_xxx），视为「未升级」，
       继续走全局统一密钥，不会因此读不懂历史消息。 */
const IDENT_VER = 1;
const isPlaceholderPub = (p) => !p || p === 'gk-v1' || String(p).startsWith('PUB_');
let IDENT = null;   // { pub: string, priv: CryptoKey }

async function derivePwKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const importRsaPub = (spki) => crypto.subtle.importKey('spki', unb64(spki),
  { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
const importRsaPriv = (pk8) => crypto.subtle.importKey('pkcs8', pk8,
  { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']);

async function wrapPrivWithPassword(pk8, password) {
  if (!password) return '';
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await derivePwKey(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, pk8);
  return JSON.stringify({ v: IDENT_VER, s: b64(salt), i: b64(iv), c: b64(ct) });
}

async function unwrapPrivWithPassword(blob, password) {
  const o = JSON.parse(blob);
  const k = await derivePwKey(password, unb64(o.s));
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.i) }, k, unb64(o.c));
  return importRsaPriv(raw);
}

/** 私钥落本机：设备密钥二次包裹，避免明文落盘 */
async function cacheIdentity(pk8) {
  const k = await deviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, pk8);
  await kvSet('ident', JSON.stringify({ v: IDENT_VER, i: b64(iv), c: b64(ct), pub: (IDENT && IDENT.pub) || '' }));
}

async function loadCachedIdentity() {
  const raw = await kvGet('ident');
  if (!raw) return null;
  const o = JSON.parse(raw);
  const k = await deviceKey();
  const pk8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.i) }, k, unb64(o.c));
  return { pub: o.pub || '', priv: await importRsaPriv(pk8) };
}

/** 注册：生成 RSA 身份密钥，返回可上送的公钥与口令包裹私钥 */
export async function createIdentity(password = '') {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt']);
  const pub = b64(await crypto.subtle.exportKey('spki', kp.publicKey));
  const pk8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  IDENT = { pub, priv: kp.privateKey };
  try { await cacheIdentity(pk8); } catch { /* 缓存失败不影响注册 */ }
  return { pubkey: pub, keyblob: await wrapPrivWithPassword(pk8, password) };
}

/** 登录后恢复身份：本机缓存优先，否则用登录口令解开 keyblob */
export async function restoreIdentity(password = '') {
  await ensureGlobal();
  if (!IDENT) {
    try { IDENT = await loadCachedIdentity(); } catch { IDENT = null; }
  }
  if (!IDENT && password) {
    try {
      const me = (await api.get('/api/users/me')).user || {};
      if (me.keyblob && String(me.keyblob).startsWith('{') && !isPlaceholderPub(me.pubkey)) {
        IDENT = { pub: me.pubkey, priv: await unwrapPrivWithPassword(me.keyblob, password) };
        try { await cacheIdentity(await crypto.subtle.exportKey('pkcs8', IDENT.priv)); } catch { /* ignore */ }
      }
    } catch { IDENT = null; }
  }
  return IDENT ? IDENT.pub : '';
}

/** 老账号升级：用当前登录口令生成真实身份密钥并上送 */
export async function upgradeIdentity(password = '') {
  if (!password) throw new Error('缺少登录口令，无法升级密钥');
  const id = await createIdentity(password);
  await api.put('/api/users/me', { pubkey: id.pubkey, keyblob: id.keyblob });
  return id.pubkey;
}

export function hasIdentity() { return !!IDENT; }
export function identityPub() { return IDENT ? IDENT.pub : ''; }

/** 修改登录口令：用新口令重新包裹私钥（换设备仍能恢复） */
export async function rekeyIdentity(oldPw = '', newPw = '') {
  await ensureGlobal();
  if (!IDENT && oldPw) {
    // 本地无缓存（换设备）→ 先用旧口令从 keyblob 取回私钥
    try {
      const me = (await api.get('/api/users/me')).user || {};
      if (me.keyblob && String(me.keyblob).startsWith('{')) {
        IDENT = { pub: me.pubkey || '', priv: await unwrapPrivWithPassword(me.keyblob, oldPw) };
      }
    } catch { /* 取不回就跳过重包 */ }
  }
  if (!IDENT || !newPw) return null;
  const pk8 = await crypto.subtle.exportKey('pkcs8', IDENT.priv);
  const keyblob = await wrapPrivWithPassword(pk8, newPw);
  try { await cacheIdentity(pk8); } catch { /* ignore */ }
  return { pubkey: IDENT.pub, keyblob };
}

export function lockIdentity() { GK = null; GK_B64 = ''; IDENT = null; }

/** 对端公钥（占位值视为未升级）。crypto.js 不引入 state.js，避免循环依赖。 */
const _pubs = new Map();
export function setPubKey(uid, pk) {
  if (uid && pk && !isPlaceholderPub(pk)) _pubs.set(uid, pk);
}
export async function pubKeyOf(uid) {
  if (!uid) return null;
  if (_pubs.has(uid)) return _pubs.get(uid) || null;
  let pk = '';
  try { pk = ((await api.get(`/api/users/${uid}`)).user || {}).pubkey || ''; } catch { pk = ''; }
  pk = isPlaceholderPub(pk) ? '' : pk;
  _pubs.set(uid, pk);
  return pk || null;
}

/* ---------------- 统一密钥加解密（seal / open） ---------------- */
/** 用全局密钥封装任意 JSON 负载 */
export async function seal(payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await gk(), enc(JSON.stringify(payload)));
  return { iv: b64(iv), ct: b64(ct) };
}
/** 用全局密钥解封 */
export async function open(cipher) {
  if (!cipher || !cipher.ct) throw new Error('空密文');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(cipher.iv) }, await gk(), unb64(cipher.ct));
  return JSON.parse(dec(pt));
}

/* ---------------- 会话级密钥（V2.0 P0-1：私聊先行） ----------------
   每个私聊会话一把随机 AES-256-GCM；发送时用对端 RSA 公钥包裹后随消息下发
   （keys[uid]），接收端解包后缓存。启用条件：开关开 + 私聊 + 双方都有真实身份密钥。
   任一条件不满足就回退全局统一密钥 —— 保证老消息、老账号、群聊/房间永远可读。 */
const ckMem = new Map();        // conv -> Uint8Array(32)，进程内缓存
let CONV_FLAG = null;           // 服务端开关（null = 未下发，按默认开启处理）

export function setConvKeysFlag(v) { CONV_FLAG = !!v; }
export function convKeysEnabled() {
  let ls = null;
  try { ls = localStorage.getItem('wuhou.convKeys'); } catch { /* ignore */ }
  if (ls === '0') return false;      // 本地强制关闭（灰度 / 故障回滚）
  if (ls === '1') return true;
  return CONV_FLAG === null ? true : CONV_FLAG;
}
const isPrivateConv = (conv) => typeof conv === 'string' && conv.startsWith('p:');
const isGroupConv = (conv) => typeof conv === 'string' && conv.startsWith('g:');
/** 群聊走群密钥作用域（而非逐条消息给每个成员各包一份）。
    公共聊天室不在此列：它全员开放、成员随时进出且没有「移除」语义，
    用群密钥会出现「有人还没领到密钥 → 读不到消息」的空窗，故维持全局密钥。 */
export const isScopeConv = (conv) => isGroupConv(conv);

async function cipherWith(raw, payload, kv = 0) {
  const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc(JSON.stringify(payload)));
  const out = { iv: b64(iv), ct: b64(ct), k: 'ck' };
  if (kv) out.kv = kv;          // 密钥版本：重钥后仍能按版本找到旧密钥
  return out;
}
async function plainWith(raw, cipher) {
  const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(cipher.iv) }, k, unb64(cipher.ct));
  return JSON.parse(dec(pt));
}

export async function convKeyRaw(conv) {
  if (!conv) return null;
  if (ckMem.has(conv)) return ckMem.get(conv);
  const raw = await kvGet('cvk:' + conv);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    const k = await deviceKey();
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.i) }, k, unb64(o.c));
    const v = new Uint8Array(pt);
    ckMem.set(conv, v);
    return v;
  } catch { return null; }
}

/** 生成（或轮换）会话密钥：P0-2 的成员变更重钥会复用这里 */
export async function rotateConvKey(conv) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  ckMem.set(conv, raw);
  try {
    const k = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, raw);
    await kvSet('cvk:' + conv, JSON.stringify({ v: 1, i: b64(iv), c: b64(ct) }));
  } catch { /* 缓存失败不影响本次发送 */ }
  return raw;
}

/* ---------------- 群 / 房间密钥（V2.0 P0-2） ----------------
   每个群 / 公共聊天室一把随机 AES-256-GCM 密钥：
     · 由任一成员生成，再用每个成员的 RSA 公钥包裹后经服务端中转分发；
     · 成员被移除 → 版本号 +1 并轮换新密钥，被移除者拿不到新包裹，
       因此读不到此后新消息；历史消息仍可用旧版本密钥解密（保留最近几个版本）；
     · 消息密文与私聊同构（cipher.k='ck'），同样附 keys.__escrow 供平台治理。 */
const GK_MEM = new Map();      // conv -> { raw, ver }

async function cacheGroupKey(conv, raw, ver) {
  GK_MEM.set(conv, { raw, ver });
  try {
    const k = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, raw);
    await kvSet('gk:' + conv, JSON.stringify({ v: 1, ver, i: b64(iv), c: b64(ct) }));
  } catch { /* 缓存失败不影响本次会话 */ }
}

/** 当前群密钥 { raw, ver }；没有则 null */
export async function groupKeyOf(conv) {
  if (!conv) return null;
  if (GK_MEM.has(conv)) return GK_MEM.get(conv);
  const s = await kvGet('gk:' + conv);
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    const k = await deviceKey();
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.i) }, k, unb64(o.c)));
    const v = { raw, ver: Number(o.ver) || 1 };
    GK_MEM.set(conv, v);
    return v;
  } catch { return null; }
}

/** 按版本取密钥（重钥后读旧消息） */
export async function groupKeyByVer(conv, ver) {
  const cur = await groupKeyOf(conv);
  if (cur && Number(ver) === cur.ver) return cur.raw;
  const s = await kvGet(`gkh:${conv}:${ver}`);
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    const k = await deviceKey();
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.i) }, k, unb64(o.c)));
  } catch { return null; }
}

/** 把旧版本另存一份，避免重钥后历史消息读不出来 */
async function keepGroupVersion(conv, old) {
  if (!old || !old.ver) return;
  try {
    const k = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, old.raw);
    await kvSet(`gkh:${conv}:${old.ver}`, JSON.stringify({ v: 1, ver: old.ver, i: b64(iv), c: b64(ct) }));
  } catch { /* ignore */ }
}

/** 轮换到新版本：返回 { raw, ver } */
export async function rotateGroupKey(conv, ver = 0) {
  const prev = await groupKeyOf(conv);
  if (prev) await keepGroupVersion(conv, prev);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const next = Number(ver) || ((prev ? prev.ver : 0) + 1);
  await cacheGroupKey(conv, raw, next);
  return GK_MEM.get(conv);
}

/** 保存别人分发给我的群密钥；服务端版本更旧时不覆盖 */
export async function saveGroupKey(conv, raw, ver) {
  const prev = await groupKeyOf(conv);
  ver = Number(ver) || 1;
  if (prev && prev.ver > ver) return false;
  if (prev && prev.ver < ver) await keepGroupVersion(conv, prev);
  await cacheGroupKey(conv, raw, ver);
  return true;
}

export function groupKeyVer(conv) { const g = GK_MEM.get(conv); return g ? g.ver : 0; }

/** 用某人公钥包裹群密钥（分发用） */
export async function wrapGroupKey(raw, spki) {
  return b64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, await importRsaPub(spki), raw));
}

/** 解开别人分发给我的群密钥（需要本机身份私钥） */
export async function unwrapGroupKey(wrapped) {
  if (!IDENT) throw new Error('缺少身份密钥，无法领取群密钥');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, IDENT.priv, unb64(wrapped)));
}

export function preloadPubkeys() { /* 会话密钥按需取公钥，无需预取 */ }

export async function encryptFor(uids = [], payload, conv = '') {
  const targets = (uids || []).filter(Boolean);

  // 群聊 / 公共聊天室：用该作用域的群密钥，成员通过 /api/chat/keys 领取，
  // 不必逐条消息给每个成员包一份（省流量，也便于成员变更后整体轮换）。
  if (isScopeConv(conv)) {
    const g = await groupKeyOf(conv);
    if (g && convKeysEnabled()) {
      try {
        const keys = {};
        const ep = await escrowKey();
        if (ep) {
          keys.__escrow = b64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, await importRsaPub(ep), g.raw));
        }
        return { cipher: await cipherWith(g.raw, payload, g.ver), keys };
      } catch { /* 任一步失败 → 回退全局密钥，绝不阻断发送 */ }
    }
    return { cipher: await seal(payload), keys: {} };
  }

  if (convKeysEnabled() && isPrivateConv(conv) && IDENT && targets.length) {
    try {
      const pubs = {};
      for (const u of targets) {
        const p = await pubKeyOf(u);
        if (!p) throw new Error('no_pub');       // 对方未升级 → 走全局密钥
        pubs[u] = p;
      }
      let raw = await convKeyRaw(conv);
      if (!raw) raw = await rotateConvKey(conv);
      const keys = {};
      for (const [u, p] of Object.entries(pubs)) {
        keys[u] = b64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, await importRsaPub(p), raw));
      }
      // 自己的其他设备也要能读：用自己的公钥再包一份
      if (MY_UID && !keys[MY_UID] && IDENT) {
        keys[MY_UID] = b64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, await importRsaPub(IDENT.pub), raw));
      }
      // 密钥托管：再用服务端 RSA 公钥包一份，供内容安全检测与举报核查。
      // 服务端开启 escrow_required 时，缺少这份信封的消息会被拒收。
      const ep = await escrowKey();
      if (ep) {
        try {
          keys.__escrow = b64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, await importRsaPub(ep), raw));
        } catch { /* 托管失败不阻断发送，由服务端决定放行或拒收 */ }
      }
      return { cipher: await cipherWith(raw, payload), keys };
    } catch { /* 任一步失败 → 回退全局密钥，绝不阻断发送 */ }
  }
  return { cipher: await seal(payload), keys: {} };
}

export async function decryptMessage(cipher, keys, conv = '') {
  // 群聊 / 公共聊天室：按密文里记录的版本号取对应的群密钥
  if (cipher && cipher.k === 'ck' && isScopeConv(conv)) {
    const kv = Number(cipher.kv || 0);
    let raw = kv ? await groupKeyByVer(conv, kv) : null;
    if (!raw) {
      const g = await groupKeyOf(conv);
      if (g) raw = g.raw;
    }
    if (raw) {
      try { return await plainWith(raw, cipher); } catch { /* 密钥换过了 → 再试全局 */ }
    }
    return open(cipher);
  }
  const forMe = keys && MY_UID ? keys[MY_UID] : '';
  if (forMe && IDENT) {
    try {
      const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, IDENT.priv, unb64(forMe)));
      if (conv) ckMem.set(conv, raw);
      return await plainWith(raw, cipher);
    } catch { /* 解不开 → 继续尝试已缓存的会话密钥 / 全局密钥 */ }
  }
  // 本条没带包裹（自己发的、或服务端未回推 keys），但本机已有会话密钥
  if (conv) {
    const raw = await convKeyRaw(conv);
    if (raw) { try { return await plainWith(raw, cipher); } catch { /* 回退全局 */ } }
  }
  return open(cipher);
}
/* ---------------- 动态专用加解密 ----------------
   这里刻意保留了「忽略入参、一律用全局密钥」的旧行为：动态正文历史上就是用
   全局密钥加解密的，直接改成使用 raw 会让库里已有的动态全部读不出来，
   要改必须配数据迁移。群聊不要用这一组。 */
export async function encryptGroup(rawB64, payload) { return seal(payload); }
export async function decryptGroup(rawB64, cipher) { return open(cipher); }
// 下面三个旧 shim 曾造成一次真实事故：wrapKeyRaw 返回的是全局密钥 token 而不是
// RSA 包裹结果，cards.js 邀请成员时把它提交给服务端，服务端只看「有没有值」
// 就把该成员移出待领队列 —— 结果新成员被判定为已领到密钥，却根本解不开，
// 读不到任何群历史，且定时补发不会再救场。已改为直接调用下面这一组带语义的函数：
//   分发给成员 → state.js 的 wrapForMembers / relayGroupKey（内部走 wrapGroupKey）
//   群消息加密 → encryptFor() 的 isScopeConv 分支


/* ---------------- 文件加密（IV 随密文一起存储） ---------------- */
export async function encryptFile(file) {
  const buf = await file.arrayBuffer();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await gk(), buf);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return { bytes: out, key: GLOBAL_TOKEN, iv: '', size: buf.byteLength };
}
export async function decryptFile(buf) {
  const b = new Uint8Array(buf);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b.slice(0, 12) }, await gk(), b.slice(12));
  return new Uint8Array(pt);
}

/* ---------------- 本地明文索引（供全局搜索） ---------------- */
export async function cachePlain(conv, msg, text) {
  if (!text) return;
  await tx('plain', 'readwrite', (s) => s.put({
    id: `${conv}:${msg.id}`, conv, mid: msg.id, ts: msg.ts || Date.now() / 1000,
    from: msg.from, type: msg.type || 'text', text: String(text).slice(0, 3000),
  }));
}
export async function searchPlain(q, limit = 40) {
  const kw = String(q || '').toLowerCase();
  if (!kw) return [];
  const all = await tx('plain', 'readonly', (s) => s.getAll());
  const out = [];
  for (const row of all || []) {
    if ((row.text || '').toLowerCase().includes(kw)) out.push(row);
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, limit);
}
export async function prunePlain(keep = 4000) {
  try {
    const all = await tx('plain', 'readonly', (s) => s.getAll());
    if (!all || all.length <= keep) return;
    all.sort((a, b) => a.ts - b.ts);
    const del = all.slice(0, all.length - keep);
    await tx('plain', 'readwrite', (s) => { for (const d of del) s.delete(d.id); });
  } catch { /* ignore */ }
}

/* ---------------- 自定义表情包（本地） ---------------- */
export async function customStickers() {
  return (await kvGet('stickers')) || [];
}
export async function addSticker(emoji, name) {
  const list = await customStickers();
  list.push({ id: 'cs_' + Math.random().toString(36).slice(2, 9), emoji, name: name || emoji, ts: Date.now() });
  await kvSet('stickers', list);
  return list;
}
export async function removeSticker(id) {
  const list = (await customStickers()).filter((s) => s.id !== id);
  await kvSet('stickers', list);
  return list;
}

/* ---------------- 清空（注销 / 退出） ---------------- */
export async function wipeLocal() {
  GK = null; GK_B64 = '';
  try { localStorage.removeItem('wuhou.device'); } catch { /* ignore */ }
  try {
    await tx('kv', 'readwrite', (s) => s.clear());
    await tx('plain', 'readwrite', (s) => s.clear());
  } catch { /* ignore */ }
}
