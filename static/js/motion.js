/* ============================================================
   武侯Chat · 3D 动效引擎
   职责：背景视差光球 / 指针跟随光晕 / 界面整体倾斜 / 弹窗 3D 倾斜与镜面高光 /
        按钮涟漪 / 列表逐条编排。全部只写 CSS 变量 + 增删装饰节点，不碰业务 DOM。
   ============================================================ */

const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const root = document.documentElement;

/* ---------------- 背景视差 / 光标光晕 ---------------- */
function buildFx() {
  if (document.getElementById('fx')) return document.getElementById('fx');
  const fx = document.createElement('div');
  fx.className = 'fx';
  fx.id = 'fx';
  fx.setAttribute('aria-hidden', 'true');
  fx.innerHTML =
    '<div class="fx__layer fx__layer--c"><i class="fx__orb fx__orb--3"></i></div>' +
    '<div class="fx__layer fx__layer--b"><i class="fx__orb fx__orb--2"></i></div>' +
    '<div class="fx__layer fx__layer--a"><i class="fx__orb fx__orb--1"></i></div>' +
    '<i class="fx__cursor"></i>';
  document.body.insertBefore(fx, document.body.firstChild);
  return fx;
}

/* ---------------- 极光背景层 ----------------
   只负责把 DOM 挂上去，显示与动画完全由 CSS 依据 data-theme 控制；
   即使系统开启了「减少动效」也要挂，否则极光主题会变成纯色底。 */
function buildAurora() {
  if (document.getElementById('aurora')) return;
  const box = document.createElement('div');
  box.className = 'aurora';
  box.id = 'aurora';
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML =
    '<div class="aurora__stage">' +
      '<i class="aurora__sky"></i>' +
      '<i class="aurora__band aurora__band--1"></i>' +
      '<i class="aurora__band aurora__band--2"></i>' +
      '<i class="aurora__band aurora__band--3"></i>' +
      '<i class="aurora__band aurora__band--4"></i>' +
      '<i class="aurora__beam"></i>' +
      '<i class="aurora__stars"></i>' +
    '</div>' +
    '<i class="aurora__grain"></i>';
  document.body.insertBefore(box, document.body.firstChild);
}

let fxEl = null;
let wantX = 0, wantY = 0;      /* 归一化 -1 ~ 1 */
let curX = 0, curY = 0;
let appEl = null;

function tick() {
  /* 缓动逼近，避免生硬跟随 */
  curX += (wantX - curX) * 0.12;
  curY += (wantY - curY) * 0.12;
  root.style.setProperty('--px', curX.toFixed(3));
  root.style.setProperty('--py', curY.toFixed(3));

  if (appEl && appEl.classList.contains('is-3d')) {
    root.style.setProperty('--app-ry', (curX * 1.1).toFixed(3) + 'deg');
    root.style.setProperty('--app-rx', (-curY * 0.75).toFixed(3) + 'deg');
  }
  if (Math.abs(wantX - curX) > 0.002 || Math.abs(wantY - curY) > 0.002) {
    requestAnimationFrame(tick);
  } else {
    rafId = 0;
  }
}
let rafId = 0;
function kick() { if (!rafId && !REDUCE) rafId = requestAnimationFrame(tick); }

function onPointerMove(e) {
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  wantX = Math.max(-1, Math.min(1, (e.clientX / w) * 2 - 1));
  wantY = Math.max(-1, Math.min(1, (e.clientY / h) * 2 - 1));
  root.style.setProperty('--cx', e.clientX + 'px');
  root.style.setProperty('--cy', e.clientY + 'px');
  if (fxEl) fxEl.classList.add('is-live');

  /* 宽屏才开启整体倾斜，窄屏/触屏关闭以免内容被推出视口 */
  if (appEl) {
    const fine = !window.matchMedia('(pointer: coarse)').matches;
    if (w >= 980 && fine) appEl.classList.add('is-3d');
    else appEl.classList.remove('is-3d');
  }
  kick();
}

/* ---------------- 性能看门狗 ----------------
   极光 + 背景光球是常驻动效，低端显卡长时间跑会拖帧。
   这里实时盯帧率：连续两个采样窗低于阈值就自动降级为静态桌面（perf-lite），
   明显恢复后再自动升回来；用户也可以由设置页手动锁定降级。 */
const LITE_KEY = 'wuhou.perfLite';
const liteMode = () => root.classList.contains('perf-lite');

function setLite(on, note) {
  if (on === liteMode()) return;
  root.classList.toggle('perf-lite', on);
  document.dispatchEvent(new CustomEvent('wuhou:perf', { detail: { lite: on, note } }));
  if (note !== 'manual-keep') { /* 自动降级不写 localStorage，避免一次性卡顿被永久记住 */ }
}

function initPerfGovernor() {
  // 系统要求降低动效 / 用户手动锁定 → 直接静态化
  if (REDUCE || localStorage.getItem(LITE_KEY) === '1') { root.classList.add('perf-lite'); return; }

  let frames = 0, t0 = 0, bad = 0, good = 0;
  const WINDOW = 3000, BAD_FPS = 42, GOOD_FPS = 55;
  const step = (ts) => {
    if (!t0) t0 = ts;
    frames++;
    const dt = ts - t0;
    if (dt >= WINDOW) {
      const fps = (frames * 1000) / dt;
      frames = 0; t0 = ts;
      if (!liteMode()) {
        if (fps < BAD_FPS) { bad++; good = 0; } else { bad = 0; }
        if (bad >= 2) setLite(true, 'auto');
      } else {
        // 降级后若能稳定跑高帧率，再缓慢升回来（ hysteresis，避免来回抖）
        if (fps >= GOOD_FPS) { good++; bad = 0; } else { good = 0; bad++; }
        if (good >= 3) setLite(false, 'auto');
      }
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);

  /* 切走标签页 / 最小化：把常驻动画冻住，不再占 GPU */
  document.addEventListener('visibilitychange', () => {
    root.classList.toggle('is-idle', document.hidden === true);
  });
}

/** 供设置页调用：手动锁定 / 解除降级 */
export function setPerfLite(on) {
  try { localStorage.setItem(LITE_KEY, on ? '1' : '0'); } catch (_) {}
  root.classList.toggle('perf-lite', !!on);
  document.dispatchEvent(new CustomEvent('wuhou:perf', { detail: { lite: !!on, note: 'manual' } }));
}
export function perfLite() { return liteMode(); }

/* ---------------- 元素 3D 倾斜 + 镜面高光 ----------------
   历史坑：高光层是挂在目标元素的父节点上的兄弟节点，目标被移除时
   MutationObserver 的清理分支不一定命中（弹层通常连同外面一层壳一起摘掉），
   于是留下一批 position:fixed 的孤儿层：你看不见它，但它会持续占用合成资源，
   用久了帧率一路往下掉。这里改为「注册表 + 定期修剪」，谁能被追踪到就一定能被清掉。 */
const sheens = new WeakMap();
const sheenRegistry = new Set();   // { target, node }
let pruneTimer = 0;

function pruneSheens() {
  for (const rec of Array.from(sheenRegistry)) {
    const { target, node } = rec;
    const dead = !target.isConnected || (node.parentNode && !node.isConnected);
    if (!dead) continue;
    try { node.remove(); } catch (_) {}
    sheenRegistry.delete(rec);
    if (sheens.get(target) === node) sheens.delete(target);
  }
  if (!sheenRegistry.size && pruneTimer) { clearInterval(pruneTimer); pruneTimer = 0; }
}

function makeSheen(el) {
  const s = document.createElement('i');
  s.className = 'tilt-sheen';
  s.setAttribute('aria-hidden', 'true');
  if (el.parentNode) el.parentNode.appendChild(s);
  else document.body.appendChild(s);
  sheens.set(el, s);
  sheenRegistry.add({ target: el, node: s });
  if (!pruneTimer) pruneTimer = setInterval(pruneSheens, 1500);
  return s;
}

function syncSheen(el) {
  const s = sheens.get(el);
  if (!s) return false;
  if (!el.isConnected) { s.remove(); sheens.delete(el); return false; }
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  s.style.left = r.left + 'px';
  s.style.top = r.top + 'px';
  s.style.width = r.width + 'px';
  s.style.height = r.height + 'px';
  s.style.borderRadius = cs.borderRadius || '24px';
  return true;
}

function attachTilt(el, max = 4.5) {
  if (!el || el.dataset.tiltBound === '1') return;
  // 不可见的元素（隐藏的认证卡、离屏弹层）不建高光层，避免留下看不见却仍在占资源的节点
  if (!el.isConnected || (el.offsetParent === null && !el.matches('.modal, .sheet'))) return;
  el.dataset.tiltBound = '1';
  el.setAttribute('data-tilt', '');
  const sheen = makeSheen(el);

  let localRaf = 0;
  let everyOther = 0;
  const loop = () => {
    localRaf = 0;
    if (!syncSheen(el)) return;
    // 位置每两帧同步一次即可：之前每帧读 getBoundingClientRect 会强制同步布局
    if (++everyOther % 2 === 0) syncSheen(el);
    if (el.matches(':hover')) localRaf = requestAnimationFrame(loop);
  };

  el.addEventListener('pointerenter', () => {
    if (REDUCE || liteMode()) return;
    syncSheen(el);
    sheen.classList.add('is-on');
    if (!localRaf) localRaf = requestAnimationFrame(loop);
  });

  el.addEventListener('pointermove', (e) => {
    if (REDUCE) return;
    const r = el.getBoundingClientRect();
    const nx = (e.clientX - r.left) / Math.max(1, r.width);   /* 0 ~ 1 */
    const ny = (e.clientY - r.top) / Math.max(1, r.height);
    el.style.setProperty('--mx', ((nx * 100).toFixed(1)) + '%');
    el.style.setProperty('--my', ((ny * 100).toFixed(1)) + '%');
    el.style.setProperty('--tilt-ry', (((nx - 0.5) * 2 * max)).toFixed(2) + 'deg');
    el.style.setProperty('--tilt-rx', ((-(ny - 0.5) * 2 * max)).toFixed(2) + 'deg');
  });

  el.addEventListener('pointerleave', () => {
    el.style.setProperty('--tilt-rx', '0deg');
    el.style.setProperty('--tilt-ry', '0deg');
    sheen.classList.remove('is-on');
    if (localRaf) { cancelAnimationFrame(localRaf); localRaf = 0; }
  });
}

/* 弹窗 / 抽屉 / 认证面板：出现即绑定倾斜。
   移动端形态跳过：触摸端没有 hover，tilt sheen 永远不会触发，
   却要为每个弹窗维护 WeakMap 注册表 + MutationObserver，纯属白耗。 */
function watchTiltTargets() {
  if (document.documentElement.classList.contains('is-mobile')) return;
  const bind = (node) => {
    if (!(node instanceof Element)) return;
    if (node.matches('.modal, .sheet, .auth-card')) attachTilt(node);
    node.querySelectorAll?.('.modal, .sheet, .auth-card').forEach(attachTilt);
  };
  ['modalRoot', 'sheetRoot', 'auth'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach(bind);
        m.removedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          const s = sheens.get(n);
          if (s) { s.remove(); sheens.delete(n); }
          n.querySelectorAll?.('.modal, .sheet').forEach((sub) => {
            const ss = sheens.get(sub);
            if (ss) { ss.remove(); sheens.delete(sub); }
          });
        });
      }
    }).observe(el, { childList: true, subtree: true });
    bind(el);
  });
}

/* ---------------- 按钮涟漪 ---------------- */
function bindRipple() {
  if (REDUCE) return;
  // 移动端已有 :active 按压缩放反馈，且触摸端涟漪会与底部弹层动画叠加产生闪烁
  if (document.documentElement.classList.contains('is-mobile')) return;
  document.addEventListener('pointerdown', (e) => {
    if (liteMode()) return;
    const btn = e.target instanceof Element ? e.target.closest('.btn') : null;
    if (!btn || btn.dataset.noRipple === '1') return;
    const r = btn.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 2.4;
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.width = d + 'px';
    s.style.height = d + 'px';
    s.style.left = (e.clientX - r.left) + 'px';
    s.style.top = (e.clientY - r.top) + 'px';
    btn.appendChild(s);
    setTimeout(() => s.remove(), 640);
  }, { passive: true });
}

/* ---------------- 列表逐条编排 ---------------- */
const STAGGER_SEL = '.side__body, #stage, .conv-list, .moments, .search-group__list, .contacts-body, .settings__pane';
let stagRaf = 0;
const stagQue = new Set();

function markStagger(container) {
  const kids = container.children;
  if (!kids || kids.length === 0 || kids.length > 160) return;
  for (let i = 0; i < kids.length; i++) {
    kids[i].style.setProperty('--i', String(Math.min(i, 10)));
  }
}

function queueStagger(node) {
  if (!(node instanceof Element)) return;
  stagQue.add(node);
  if (stagRaf) return;
  stagRaf = requestAnimationFrame(() => {
    stagRaf = 0;
    stagQue.forEach((n) => {
      if (!n.isConnected) return;
      markStagger(n);
      n.querySelectorAll?.(STAGGER_SEL).forEach(markStagger);
    });
    stagQue.clear();
  });
}

function watchStagger() {
  new MutationObserver((muts) => {
    // 后台标签页 / 降级模式下完全不参与编排，省掉一整条 Mutation 处理链
    if (liteMode() || document.hidden) return;
    for (const m of muts) {
      if (m.type !== 'childList') continue;
      if (m.target instanceof Element) queueStagger(m.target);
      m.addedNodes.forEach((n) => {
        if (n instanceof Element && n.children.length) queueStagger(n);
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
}

/* ---------------- 背景光球：形态跟随 ----------------
   桌面形态创建 #fx 并挂指针监听；切到移动端时立即销毁并解绑，
   避免移动端 App 界面（.mapp 全屏覆盖）下光球层白耗 GPU / 电池。
   由 formfactor 的 sync() 通知驱动，天然覆盖首屏与运行中切换两种时序。 */
function teardownFx() {
  const old = document.getElementById('fx');
  if (old) old.remove();
  fxEl = null;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerleave', onPointerLeave);
  window.removeEventListener('blur', onWindowBlur);
  wantX = 0; wantY = 0; curX = 0; curY = 0;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  root.style.removeProperty('--px');
  root.style.removeProperty('--py');
  root.style.removeProperty('--app-ry');
  root.style.removeProperty('--app-rx');
}

function onPointerLeave() {
  wantX = 0; wantY = 0;
  if (fxEl) fxEl.classList.remove('is-live');
  if (appEl) {
    appEl.classList.remove('is-3d');
    root.style.setProperty('--app-rx', '0deg');
    root.style.setProperty('--app-ry', '0deg');
  }
  kick();
}

function onWindowBlur() {
  if (appEl) appEl.classList.remove('is-3d');
}

function setupFx() {
  if (fxEl) return;
  fxEl = buildFx();
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerleave', onPointerLeave, { passive: true });
  window.addEventListener('blur', onWindowBlur);
}

/* ---------------- 入口 ---------------- */
export function initMotion() {
  appEl = document.getElementById('app');
  // 安卓端（WebView）不构建极光层：动态渐变背景会持续闪烁，且极光主题在安卓端已被禁用
  if (!/WuhouChatAndroid/i.test(navigator.userAgent)) buildAurora();
  initPerfGovernor();
  // 首屏：桌面形态才创建光球层；移动端跳过（html.is-mobile 由 formfactor 同步挂好）
  if (!REDUCE && !document.documentElement.classList.contains('is-mobile')) setupFx();
  // 运行中切换形态：跟随 formfactor 清理 / 重建，避免残留光球层白耗 GPU
  import('./formfactor.js').then((ff) => {
    ff.onFormFactorChange((mode) => {
      if (REDUCE) return;
      if (mode === 'mobile') teardownFx();
      else if (!fxEl) setupFx();
    });
  }).catch(() => { /* 动态导入失败则退化为首屏判断 */ });
  watchTiltTargets();
  bindRipple();
  if (!REDUCE) watchStagger();
}

/* 供其他模块手痒时用：局部重排后主动补一次编排 */
export function restage(node) { queueStagger(node || document.body); }
