/* ============================================================
   API 客户端（统一鉴权 / 错误提示 / 二进制上传）
   ============================================================ */
const TOKEN_KEY = 'wuhou.token';
const ADMIN_KEY = 'wuhou.admin';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (t) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
  admin: {
    get: () => localStorage.getItem(ADMIN_KEY) || '',
    set: (t) => localStorage.setItem(ADMIN_KEY, t),
    clear: () => localStorage.removeItem(ADMIN_KEY),
  },
};

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

/** 这些接口自己承担失败原因的展示（登录/注册要显示具体错误），
 *  不应触发全局的「清 token + 刷新」，否则用户连错误原因都看不到。 */
const SELF_HANDLED_401 = ['/api/auth/login', '/api/auth/register', '/api/auth/second'];

/** 请求超时熔断：任何请求都不允许无限挂起（默认 20s，二进制 60s） */
function fetchWithTimeout(path, init, ms) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  if (ctrl) {
    init.signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), ms);
  }
  return fetch(path, init).finally(() => { if (timer) clearTimeout(timer); });
}

async function request(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const tk = opts.admin ? tokenStore.admin.get() : tokenStore.get();
  if (tk) headers.Authorization = `Bearer ${tk}`;
  const res = await fetchWithTimeout(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, 20000);
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) {
    try { data = await res.json(); } catch { data = null; }
  }
  const selfHandled = opts.noUnauth || SELF_HANDLED_401.includes(path);
  if (res.status === 401 && onUnauthorized && !opts.admin && !selfHandled) onUnauthorized();
  if (!res.ok || (data && data.ok === false)) {
    const msg = (data && data.error) || `请求失败 (${res.status})`;
    const err = new Error(msg);
    err.code = (data && data.code) || res.status;
    err.status = res.status;
    throw err;
  }
  return data ? data.data : null;
}

export const api = {
  // GET 没有请求体：第二/第三参数都可能是 opts（历史调用写成 (p, undefined, opts)），这里统一兼容
  get: (p, b, o) => request('GET', p, undefined, o || (b && typeof b === 'object' ? b : undefined)),
  post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
  put: (p, b, o) => request('PUT', p, b === undefined ? {} : b, o),
  patch: (p, b, o) => request('PATCH', p, b === undefined ? {} : b, o),
  del: (p, b, o) => request('DELETE', p, b === undefined ? {} : b, o),

  /** 上传已加密的字节流（聊天附件，服务端只做名称与体积检查） */
  async upload(bytes, name = '') {
    const tk = tokenStore.get();
    const q = name ? `?name=${encodeURIComponent(String(name).slice(0, 180))}` : '';
    const res = await fetchWithTimeout('/api/files/upload' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${tk}` },
      body: bytes,
    }, 60000);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || '上传失败');
    return data.data;
  },

  /** 原图上传（头像等公开内容）：服务端做魔数 + 内容威胁检测 */
  async uploadRaw(bytes, name = '') {
    const tk = tokenStore.get();
    const q = `?raw=1&name=${encodeURIComponent(String(name || '').slice(0, 180))}`;
    const res = await fetchWithTimeout('/api/files/upload' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${tk}` },
      body: bytes,
    }, 30000);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || '上传失败');
    }
    return data.data;
  },

  /** 注册页头像上传（免登录专用接口） */
  async uploadAnonymous(bytes) {
    const res = await fetchWithTimeout('/api/auth/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    }, 30000);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || '上传失败');
    return data.data;
  },

  /** 下载加密字节流（附件上限 200MB，60s 熔断会掐断大文件的正常下载） */
  async download(fid) {
    const tk = tokenStore.get();
    const res = await fetchWithTimeout(`/api/files/${fid}`, {
      headers: { Authorization: `Bearer ${tk}` },
    }, 300000);
    if (!res.ok) throw new Error('文件下载失败');
    return await res.arrayBuffer();
  },
};

/* 服务端下发的 WS 端口缓存（部署到服务器后，WS 端口可能与 HTTP 不同，
   必须以 /api/meta 返回的 ws_port 为准，不能在前端写死 8001）。 */
let _wsPort = 8001;
let _wsPortPromise = null;

export async function resolveWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  if (!_wsPortPromise) {
    _wsPortPromise = fetch('/api/meta')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.data && d.data.ws_port) _wsPort = d.data.ws_port; })
      .catch(() => { /* 保留默认 8001 */ });
  }
  await _wsPortPromise;
  return `${proto}://${location.hostname}:${_wsPort}/ws`;
}

/** 兼容旧引用的同步默认值（仅当调用方无法 await 时使用；新代码请用 resolveWsUrl） */
export const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname}:8001/ws`;
})();
