/* ============================================================
   通用工具
   ============================================================ */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export const esc = (s = '') => String(s).replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

export function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

/**
 * 收集容器内带 name 的表单控件值。
 * 弹窗里的表单容器是 div（不是 <form>），直接用 new FormData(div) 会抛
 * TypeError 且被 async 回调吞掉，表现为"点按钮没反应"，因此统一走这里。
 */
export function collectForm(root) {
  const out = {};
  if (!root) return out;
  root.querySelectorAll('input[name], textarea[name], select[name]').forEach((n) => {
    if (!n.name) return;
    if (n.type === 'checkbox' || n.type === 'radio') { if (n.checked) out[n.name] = n.value; return; }
    out[n.name] = n.value;
  });
  return out;
}

export function debounce(fn, ms = 240) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function throttle(fn, ms = 200) {
  let last = 0, timer;
  return (...a) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...a); }
    else { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last)); }
  };
}

const pad = (n) => String(n).padStart(2, '0');
export function fmtClock(ts) {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDay(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const sameY = d.getFullYear() === now.getFullYear();
  if (d.toDateString() === now.toDateString()) return '今天';
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${sameY ? '' : d.getFullYear() + '年'}${d.getMonth() + 1}月${d.getDate()}日`;
}
export function fmtRelative(ts) {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return fmtDay(ts);
}
export function fmtListTime(ts) {
  const d = new Date(ts * 1000), n = new Date();
  if (d.toDateString() === n.toDateString()) return fmtClock(ts);
  if (Date.now() / 1000 - ts < 86400 * 7) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
export function fmtDuration(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${pad(s)}`;
}

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

/* ---------- 远程图片（头像 / 群头像） ----------
   /api/files/{id} 需要 Bearer 令牌，直接写进 <img src> 会 401。
   这里统一走带鉴权的下载，转成 Blob URL 并按 fileId 缓存复用。 */
import { api } from './api.js';
const _fileUrls = new Map();

function sniffMime(u8) {
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'image/png';
  if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'image/jpeg';
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image/gif';
  if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) return 'image/webp';
  return 'image/*';
}

/** 取可直接在 <img> 中使用的 URL（异步，带缓存） */
export async function fileUrl(fid) {
  if (!fid) return '';
  const hit = _fileUrls.get(fid);
  if (hit) return hit;                       // 可能是 Promise（并发复用）
  const p = (async () => {
    try {
      const buf = await api.download(fid);
      const u8 = new Uint8Array(buf);
      return URL.createObjectURL(new Blob([u8], { type: sniffMime(u8) }));
    } catch { return ''; }
  })();
  _fileUrls.set(fid, p);
  const url = await p;
  _fileUrls.set(fid, url);                   // 落定后换成字符串
  return url;
}

/** 头像/群头像引用（"file:xxx"）→ 图片 fileId */
export function fileIdOf(av) {
  return av && String(av).startsWith('file:') ? String(av).slice(5) : '';
}

/* ---------- 昵称 + 性别徽标 ---------- */
const GENDER_SVG = {
  male: '<circle cx="10.5" cy="13.5" r="6"/><path d="M15 9l5-5"/><path d="M20 4h-5v5"/>',
  female: '<circle cx="12" cy="9" r="6"/><path d="M12 15v6"/><path d="M9.5 18.5h5"/>',
  other: '<circle cx="12" cy="8.5" r="5.5"/><path d="M12 14v7"/><path d="M12 17.5h-3.2a1.8 1.8 0 1 0 0 3.6H12"/>',
};
const GENDER_META = {
  male: { cls: 'is-male', title: '男' },
  female: { cls: 'is-female', title: '女' },
  other: { cls: 'is-other', title: '其他' },
};

/**
 * 性别徽标节点。
 * 性别为保密（unknown）或缺失时不渲染任何节点——遵循"无则不添加"。
 */
export function genderIcon(u, opts = {}) {
  const g = String((u && u.gender) || '').toLowerCase();
  const meta = GENDER_META[g];
  if (!meta) return null;
  const size = opts.size ? ` gender-icon--${opts.size}` : '';
  return el('span', {
    class: `gender-icon ${meta.cls}${size}`,
    title: opts.bare ? null : meta.title,
    'aria-hidden': 'true',
    html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"
      stroke-linecap="round" stroke-linejoin="round">${GENDER_SVG[g]}</svg>`,
  });
}

/**
 * 昵称 + 性别徽标的统一节点（全局昵称渲染入口）。
 * @param {object} u    用户对象，取 remark/nickname/username 与 gender
 * @param {object} opts { text: 覆盖显示文本, class: 追加类名, single: 单行省略 }
 */
export function nameNode(u = {}, opts = {}) {
  const text = opts.text != null
    ? opts.text
    : (u.remark || u.nickname || u.username || opts.fallback || '未知用户');
  const cls = ['uname', opts.single === false ? '' : 'uname--ell', opts.class || '']
    .filter(Boolean).join(' ');
  const node = el('span', { class: cls, title: opts.title || null });
  node.appendChild(el('span', { class: 'uname__text', text: String(text) }));
  const icon = genderIcon(u);
  if (icon) node.appendChild(icon);
  return node;
}

/** 聊天 toast / 弹窗文案里用的"昵称+性别"纯文本标记（不需要 DOM 时用） */
export function genderMark(u) {
  const g = String((u && u.gender) || '').toLowerCase();
  return { male: '♂', female: '♀', other: '⚧' }[g] || '';
}

/* ---------- 头像 ---------- */
/** 官方图标：系统身份 / 官方账号 / 公共聊天室统一用它，避免和普通用户的首字头像混淆 */
export const OFFICIAL_ICON = '/static/img/icon-128.png';
export function isOfficial(u = {}) {
  const id = String(u.id || u.username || '');
  return id === 'system' || u.official === true || u.is_official === true
    || String(u.role || '') === 'admin';
}
const AVATAR_HUES = [262, 196, 158, 24, 340, 218, 92, 300, 40, 176];
export function avatarSeed(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}
export function avatarBg(name = '') {
  const h = AVATAR_HUES[avatarSeed(name) % AVATAR_HUES.length];
  return `linear-gradient(135deg, hsl(${h} 78% 62%), hsl(${(h + 42) % 360} 74% 52%))`;
}
export function initialOf(u = {}) {
  const n = (u.remark || u.nickname || u.username || '?').trim();
  return n.slice(0, 1).toUpperCase();
}

/** 生成头像 DOM（支持 file:xxx 远程图 / 表情 / 文字首字） */
export function avatar(user = {}, size = '', opts = {}) {
  const cls = ['avatar', size ? `avatar--${size}` : '', opts.class || ''].filter(Boolean).join(' ');
  const node = el('div', { class: cls, style: { background: avatarBg(user.nickname || user.username || 'u') } });
  const av = (user.avatar && !isOfficial(user)) ? user.avatar : '';
  // 官方身份：直接显示官方图标，不参与首字 / 表情头像
  if (isOfficial(user) && !fileIdOf(user.avatar || '')) {
    node.classList.add('avatar--official');
    node.style.background = 'var(--panel-2)';
    node.appendChild(el('img', { src: OFFICIAL_ICON, alt: user.nickname || '官方' }));
    if (opts.status !== false) {
      node.appendChild(el('i', { class: 'avatar__status' + (user.online ? ' is-online' : '') }));
    }
    if (opts.onClick) { node.style.cursor = 'pointer'; node.addEventListener('click', opts.onClick); }
    return node;
  }
  const fid = fileIdOf(av);
  if (fid) {
    const img = el('img', { alt: '' });
    img.style.opacity = '0';
    node.appendChild(img);
    fileUrl(fid).then((url) => {
      if (!url) { img.remove(); node.textContent = initialOf(user); return; }
      img.src = url;
      img.style.opacity = '1';
      img.style.transition = 'opacity .2s';
      node.style.background = 'var(--panel-2)';
    });
  } else if (av) {
    node.textContent = av;
  } else {
    node.textContent = initialOf(user);
  }
  if (opts.status !== false) {
    node.appendChild(el('i', { class: 'avatar__status' + (user.online ? ' is-online' : '') }));
  }
  if (opts.onClick) { node.style.cursor = 'pointer'; node.addEventListener('click', opts.onClick); }
  return node;
}

/** 同步版本保留为 fileId 形式，异步取图请用 fileUrl() */
export function avatarUrl(av) {
  return fileIdOf(av);
}

/* ---------- 其它 ---------- */
export function fileIcon(name = '', mime = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'mic';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'share';
  return 'file';
}
export function isImage(name = '') {
  return /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(name);
}
export function isVideo(name = '') {
  return /\.(mp4|webm|mov|mkv|avi)$/i.test(name);
}

/** 浏览器是否支持 <a download>：iOS Safari / 部分内置浏览器不认这个属性，
 *  点了会毫无反应（用户侧表现为「下载没反应」），必须提前判定走兜底。 */
export function canDownloadAttr() {
  try { return 'download' in document.createElement('a'); } catch { return false; }
}

/**
 * 把 Blob 存到本地。
 *
 * 两个坑都在这里堵住：
 *  1) 回收太快 —— 早先 2 秒就 revoke 掉 blob URL，大文件/慢设备还没开始写盘就
 *     被掐断，落盘结果是 0 字节或半截文件。这里延后到 60 秒再回收。
 *  2) 不支持 download 属性的环境 —— 退化为在新标签打开 blob，由用户长按/另存。
 */
export function download(data, filename) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const name = filename || '附件';
  const url = URL.createObjectURL(blob);
  if (!canDownloadAttr()) {
    // 微信 / 内置浏览器：download 属性无效，优先交给系统分享面板（可直接存到「文件」），
    // 再不行才退化成新窗口打开，提示长按保存。
    try {
      const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: name }).catch(() => window.open(url, '_blank'));
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return url;
      }
    } catch { /* 不支持 File/分享，走下面的新窗口 */ }
    const w = window.open(url, '_blank');
    if (!w) { toastSafe('当前浏览器不支持直接下载，已在新窗口打开，请长按或右键保存'); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return url;
  }
  const a = el('a', { href: url, download: filename || '附件' });
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
  return url;
}

function toastSafe(msg) {
  try { window.dispatchEvent(new CustomEvent('ui:toast', { detail: { msg } })); } catch { /* ignore */ }
  console.warn(msg);
}

export function pickFiles(accept = '*/*', multiple = false) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    document.body.appendChild(input);
    input.addEventListener('change', () => { resolve(Array.from(input.files || [])); input.remove(); });
    input.click();
  });
}

export function copyText(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const ta = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  return Promise.resolve();
}
