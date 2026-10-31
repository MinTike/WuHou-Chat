/* ============================================================
   形态层：决定当前运行「电脑端界面系统」还是「移动端界面系统」
   Copyright © 2026 左熙宇
   ------------------------------------------------------------
   两套界面是彼此独立的两份实现，不是同一份 DOM 的响应式补丁：
     · desktop → shell-desktop.js（三栏：rail / side / main）
     · mobile  → shell-mobile.js （App：顶栏 + 页面栈 + 底部标签栏）
   形态只由这里产生，业务模块与另一套系统完全不接触。

   判定顺序：URL 参数 ?ff= > 本地偏好 localStorage > 视口规则。
   视口规则（可预测，便于自动化）：
     ≤ 760px 手机形态；≥ 1024px 电脑形态；中间地带看指针类型（触摸 → 手机）。
   ============================================================ */
const MQ_PHONE = 760;
const MQ_DESKTOP = 1024;
const KEY = 'wuhou.ff';

const listeners = new Set();

function coarse() {
  try { return matchMedia('(pointer: coarse)').matches; } catch { return false; }
}

/** 不覆盖任何偏好时的自然形态：以宽度为准，触摸设备向上放宽一档 */
export function naturalFormFactor() {
  const w = innerWidth;
  if (w <= MQ_DESKTOP) return 'mobile';
  if (coarse() && w <= 1280) return 'mobile';
  return 'desktop';
}

function stored() {
  try {
    const v = new URLSearchParams(location.search).get('ff');
    if (v === 'mobile' || v === 'desktop') return v;
  } catch { /* ignore */ }
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'mobile' || v === 'desktop') return v;
  } catch { /* ignore */ }
  return '';
}

/** 当前形态：'mobile' | 'desktop' */
export function formFactor() {
  return stored() || naturalFormFactor();
}

/** 兼容旧名：ui.js 用它决定弹层是否走「底部抽屉」形态 */
export const isNarrow = () => formFactor() === 'mobile';
export const isMobile = isNarrow;
export const isDesktop = () => formFactor() === 'desktop';

/** 手动切换（移动端「更多」里的「切换到电脑版」走这里）；'' 表示回到自动 */
export function setFormFactor(ff) {
  try {
    if (ff === 'mobile' || ff === 'desktop') localStorage.setItem(KEY, ff);
    else localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  sync();
}

/** 形态生效：挂文档类 → 通知订阅者（由 app.js 负责换壳） */
export function sync() {
  const ff = formFactor();
  document.documentElement.classList.toggle('is-mobile', ff === 'mobile');
  document.documentElement.classList.toggle('is-desktop', ff === 'desktop');
  document.documentElement.dataset.ff = ff;
  listeners.forEach((cb) => { try { cb(ff); } catch (e) { console.warn('[formfactor] 回调失败', e); } });
  document.dispatchEvent(new CustomEvent('wuhou:formfactor', { detail: ff }));
}

export function onFormFactorChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let t = 0;
export function watchFormFactor() {
  addEventListener('resize', () => {
    clearTimeout(t);
    // 只在形态真的跨越边界时才换壳，否则每次 resize 都会重挂载一次整套界面
    t = setTimeout(() => { if (formFactor() !== document.documentElement.dataset.ff) sync(); }, 180);
  });
  addEventListener('orientationchange', () => setTimeout(sync, 260));
  sync();
}
