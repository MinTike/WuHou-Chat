/* ============================================================
   移动端界面系统：App 形态（顶栏 + 页面栈 + 底部标签栏）
   Copyright © 2026 左熙宇
   ------------------------------------------------------------
   这是与电脑端并列的一整套界面，不是同一份 DOM 的响应式补丁：
     · 信息结构不同：电脑端同屏三栏（列表常驻在中间栏），
       移动端是「4 个根标签 + 页面栈」——列表本身就是一页，点进去才推新页。
     · 导航语言不同：电脑端点图标栏换栏，移动端底部标签 + 右滑返回。
     · 顶栏不同：移动端有返回键（栈深 > 0），业务页自带头部时沿用自带头部。
     · 弹层不同：一律底部抽屉 + 下拉关闭；操作靠长按菜单。
   业务模块无感知：仍只认 #sideBody / #stage，由本系统决定它们在哪一页。
   ============================================================ */
import { el } from './util.js';
import { icon } from './icons.js';
import { emit, state } from './state.js';

const TABS = [
  { key: 'chat', icon: 'chat', label: '消息' },
  { key: 'contacts', icon: 'users', label: '通讯录' },
  { key: 'moments', icon: 'sparkles', label: '动态' },
  { key: 'settings', icon: 'user', label: '我' },
];

let root = null;          // .mapp
let bar = null;           // .mbar
let barBack = null, barTitle = null, barActs = null;
let stackEl = null;       // .mstack
let tabEl = null;         // .mtab
let veil = null;          // 抽屉遮罩
let drawer = null;        // 右侧抽屉（更多）
let pages = [];           // 页面栈：[{node, cfg, sideEl, stageEl}]
let tab = 'chat';
let busy = false;

/* ---------------- 触感 ---------------- */
function haptic(ms = 8) {
  if (!('ontouchstart' in window)) return;
  try { navigator.vibrate && navigator.vibrate(ms); } catch { /* ignore */ }
}

/* ---------------- 挂载 ---------------- */
export function mount(host) {
  if (root) return root;
  root = el('div', { class: 'mapp', id: 'mapp' });

  // 桌面端三栏 DOM（#app）虽然已被隐藏，但里面的 #sideBody / #stage 仍占着全局唯一 id。
  // 业务模块普遍用 document.querySelector('#stage') / $('#stage') 取容器，
  // 若不把这些 id 让出来，渲染会写进桌面端隐藏容器 → 移动端页面空白。
  // 这里统一剥离，保证 querySelector 命中移动端当前页容器；切回桌面端时
  // shell-desktop.attach() 会重新赋回这两个 id。
  const _app = host.querySelector && host.querySelector('#app');
  const _deskSide = _app && _app.querySelector('#sideBody');
  const _deskStage = _app && _app.querySelector('#stage');
  if (_deskSide) _deskSide.removeAttribute('id');
  if (_deskStage) _deskStage.removeAttribute('id');

  bar = el('header', { class: 'mbar' }, [
    barBack = el('button', { class: 'mbar__back', type: 'button', 'aria-label': '返回',
      html: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
      onClick: () => pop() }),
    barTitle = el('div', { class: 'mbar__title ellipsis', text: '消息' }),
    barActs = el('div', { class: 'mbar__acts' }),
  ]);
  stackEl = el('div', { class: 'mstack' });
  tabEl = el('nav', { class: 'mtab' });
  TABS.forEach((t) => {
    tabEl.appendChild(el('button', {
      class: 'mtab__item' + (t.key === tab ? ' is-active' : ''), type: 'button',
      dataset: { tab: t.key }, title: t.label,
      html: `<span class="mtab__ico">${icon(t.icon, 21)}</span><span class="mtab__label">${t.label}</span>`,
      onClick: () => { haptic(6); emit('ui:nav', t.key); },
    }));
  });

  drawer = el('aside', { class: 'mdrawer' }, [el('div', { class: 'mdrawer__title', text: '更多' })]);
  veil = el('div', { class: 'mveil', onClick: closeDrawer });

  root.append(bar, stackEl, tabEl, veil, drawer);
  host.appendChild(root);
  bindGestures();
  return root;
}

export function unmount() {
  if (!root) return;
  root.remove();
  root = null; stackEl = null; tabEl = null; bar = null; pages = [];
}

/* ---------------- 页面栈 ---------------- */
function makePage(cfg) {
  const sideEl = el('div', { class: 'mpage__side' });
  const stageEl = el('div', { class: 'mpage__body' });
  const node = el('section', { class: 'mpage', dataset: { key: cfg.key || '' } }, [
    el('div', { class: 'mpage__scroll' }, [sideEl, stageEl]),
  ]);
  return { node, cfg, sideEl, stageEl };
}

/** 只有栈顶页面持有 #sideBody / #stage：业务模块照旧用 querySelector 取容器 */
function activate(page) {
  pages.forEach((p) => {
    if (p === page) return;
    p.sideEl.removeAttribute('id');
    p.stageEl.removeAttribute('id');
  });
  page.sideEl.id = 'sideBody';
  page.stageEl.id = 'stage';
}

/** 渲染一页。业务模块的 render 大多是 async（要拉接口），必须等它落定再装饰：
    否则 decorate() 去找 .chat__head 时聊天页还没画出来，返回键就注入不进去。 */
async function paintPage(page) {
  activate(page);
  const { cfg } = page;
  const side = page.sideEl, stage = page.stageEl;
  side.innerHTML = ''; stage.innerHTML = '';
  side.hidden = !cfg.side;
  stage.hidden = !cfg.stage;
  try { if (cfg.side) await cfg.side(side); } catch (e) { console.warn('[m] side 渲染失败', e); }
  try { if (cfg.stage) await cfg.stage(stage); } catch (e) { console.warn('[m] stage 渲染失败', e); }
  // 渲染期间可能已经被 pop 掉了（连点返回），这时节点已脱离文档，别再装饰
  if (!page.node.isConnected) return;
  decorate(page);
}

/** 顶栏：根页一律用标准顶栏（标题 + 动作）；二级页沿用业务页自带头部并注入返回键 */
function decorate(page) {
  const depth = pages.length - 1;
  const isRoot = depth === 0;
  // 标签栏只在根页出现：进入二级页后底部让位给内容，栈模型的层级才清楚
  tabEl.classList.toggle('is-hidden', !isRoot);
  page.node.classList.toggle('is-root', isRoot);

  // 根页已经有了标准顶栏，业务页自带的 .view__head 会再写一遍同样的标题
  // （通讯录 / 动态 / 设置都会），交给 CSS 收掉，避免顶部出现两条重复标题栏。
  const own = isRoot ? null : page.node.querySelector('.chat__head, .view__head');

  if (own) {
    // 聊天页要保留通话 / 更多按钮，所以沿用它自己的头部
    bar.hidden = true;
    if (!own.querySelector('.mback')) {
      own.insertBefore(el('button', { class: 'mback', type: 'button', 'aria-label': '返回',
        html: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
        onClick: () => pop() }), own.firstChild);
    }
    return;
  }
  bar.hidden = false;
  barTitle.textContent = page.cfg.title || '';
  barBack.hidden = isRoot;
  barActs.innerHTML = '';
  (page.cfg.actions || []).forEach((a) => {
    barActs.appendChild(el('button', {
      class: 'mbar__act', type: 'button', title: a.label, 'aria-label': a.label,
      html: icon(a.icon || 'more', 20), onClick: a.onClick,
    }));
  });
}

/** 切换根标签：清空整栈 */
export function setRoot(cfg) {
  if (!root || busy) return;
  busy = true;
  stackEl.innerHTML = '';
  pages = [];
  const page = makePage(cfg);
  pages.push(page);
  stackEl.appendChild(page.node);
  paintPage(page);
  setTab(cfg.key);
  requestAnimationFrame(() => { page.node.classList.add('is-in'); busy = false; });
}

/** 推入二级页：从右侧滑入，顶栏出现返回键 */
export function push(cfg) {
  if (!root || busy) return;
  busy = true;
  const prev = pages[pages.length - 1];
  const page = makePage(cfg);
  page.node.classList.add('is-enter');
  pages.push(page);
  stackEl.appendChild(page.node);
  paintPage(page);
  if (prev) prev.node.classList.add('is-behind');
  requestAnimationFrame(() => {
    page.node.classList.remove('is-enter');
    setTimeout(() => { busy = false; }, 260);
  });
}

export function pop() {
  if (!root || pages.length <= 1 || busy) return false;
  busy = true;
  const page = pages.pop();
  page.node.classList.add('is-leave');
  const cur = pages[pages.length - 1];
  cur.node.classList.remove('is-behind');
  haptic(6);
  setTimeout(() => {
    page.node.remove();
    activate(cur);
    decorate(cur);
    busy = false;
  }, 240);
  return true;
}

/** 回到根标签（供外部「返回键」兜底） */
export function popToRoot() {
  while (pages.length > 1) {
    const p = pages.pop();
    p.node.remove();
  }
  if (pages[0]) { activate(pages[0]); decorate(pages[0]); }
}

export function depth() { return pages.length - 1; }
export function currentKey() { return pages.length ? pages[pages.length - 1].cfg.key : tab; }

export function setTab(key) {
  tab = key;
  if (!tabEl) return;
  tabEl.querySelectorAll('.mtab__item').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === key));
}

export function updateBadges({ chat: c = 0, contacts: n = 0 } = {}) {
  if (!tabEl) return;
  tabEl.querySelectorAll('.mtab__item').forEach((b) => {
    const old = b.querySelector('.mtab__dot'); if (old) old.remove();
    const v = b.dataset.tab === 'chat' ? c : (b.dataset.tab === 'contacts' ? n : 0);
    if (v > 0) b.querySelector('.mtab__ico').appendChild(el('i', { class: 'mtab__dot', text: v > 99 ? '99+' : String(v) }));
  });
}

/** 重跑当前页（数据刷新后） */
export function refresh() {
  const page = pages[pages.length - 1];
  if (page) paintPage(page);
}

/* ---------------- 抽屉「更多」 ---------------- */
export function openDrawer(items) {
  if (!drawer) return;
  drawer.querySelectorAll('.mdrawer__item').forEach((n) => n.remove());
  items.forEach((it) => drawer.appendChild(el('button', {
    class: 'mdrawer__item', type: 'button', html: `<span class="mdrawer__ico">${icon(it.icon || 'dot', 18)}</span><span>${it.label}</span>`,
    onClick: () => { closeDrawer(); haptic(6); it.onClick && it.onClick(); },
  })));
  drawer.classList.add('is-open');
  veil.classList.add('is-on');
}
export function closeDrawer() {
  drawer?.classList.remove('is-open');
  veil?.classList.remove('is-on');
}
export const isDrawerOpen = () => !!drawer?.classList.contains('is-open');

/* ---------------- 手势：右滑返回 / 下拉关弹层 / 长按 = 右键 ---------------- */
function bindGestures() {
  /* 1. 左缘右滑 → 返回 */
  const EDGE = 28;
  let sx = 0, sy = 0, live = false, dx = 0;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || pages.length <= 1) return;
    const t = e.touches[0];
    if (t.clientX > EDGE) return;
    sx = t.clientX; sy = t.clientY; dx = 0; live = false;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!pages.length) return;
    const t = e.touches[0];
    if (!sx) return;
    dx = t.clientX - sx;
    const dy = Math.abs(t.clientY - sy);
    if (!live) {
      if (dx < 8 || dy > Math.abs(dx) * 0.8) { sx = 0; return; }
      live = true;
      pages[pages.length - 1].node.classList.add('is-pulling');
    }
    pages[pages.length - 1].node.style.setProperty('--mx', Math.max(0, dx) + 'px');
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (!live) { sx = 0; return; }
    const page = pages[pages.length - 1];
    page.classList.remove('is-pulling');
    page.style.removeProperty('--mx');
    live = false; sx = 0;
    if (dx > innerWidth * 0.3) pop();
  });

  /* 2. 弹层下拉关闭 */
  let host = null, scrim = null, sy2 = 0, dy2 = 0, live2 = false;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest('button, input, textarea, select, a')) return;
    const grab = t.closest('.modal__head, .sheet, .ctx');
    if (!grab) return;
    host = grab.classList.contains('modal__head') ? grab.closest('.modal') : grab;
    scrim = host?.parentElement?.querySelector('.modal-scrim');
    sy2 = e.touches[0].clientY; dy2 = 0; live2 = false;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!host) return;
    dy2 = e.touches[0].clientY - sy2;
    if (dy2 <= 0) { if (live2) host.style.removeProperty('--dy'); return; }
    if (!live2) { live2 = true; host.classList.add('is-pulling'); }
    host.style.setProperty('--dy', dy2 + 'px');
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchend', () => {
    if (!host) return;
    const h = host; host = null;
    h.classList.remove('is-pulling');
    h.style.removeProperty('--dy');
    if (live2 && dy2 > 96) { haptic(6); if (scrim?.isConnected) scrim.click(); else h.remove(); }
    scrim = null; dy2 = 0; live2 = false;
  });

  /* 3. 长按 = 右键：手机没有右键，但动作出口仍然只有菜单这一个 */
  let timer = 0, tx = 0, ty = 0, target = null, ctxBornAt = 0;
  const cancel = () => { clearTimeout(timer); timer = 0; target = null; };
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.target instanceof Element ? e.target : null;
    target = t && t.closest('.msg') ? t.closest('.msg') : null;
    if (!target) return;
    tx = e.touches[0].clientX; ty = e.touches[0].clientY;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const n = target; cancel();
      if (!n || !n.isConnected) return;
      try { getSelection()?.removeAllRanges(); } catch { /* ignore */ }
      n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: tx, clientY: ty }));
      ctxBornAt = Date.now();
      haptic(12);
    }, 420);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!timer) return;
    const d = Math.abs(e.touches[0].clientX - tx) + Math.abs(e.touches[0].clientY - ty);
    if (d > 10) cancel();
  }, { passive: true });
  document.addEventListener('touchend', cancel);
  document.addEventListener('touchcancel', cancel);

  // 触摸端不能用 mousedown 判「点外面」：长按松手后浏览器会补发一个目标为
  // 该消息的合成 mousedown，菜单会在弹出的同一帧把自己删掉。
  document.addEventListener('pointerdown', (e) => {
    const box = document.querySelector('.ctx');
    if (!box || box.contains(e.target)) return;
    // 长按弹出菜单后，浏览器紧接着会补发一次 pointerdown（同一次触摸的尾巴）。
    // 不挡住它，菜单会在弹出的同一瞬间被自己删掉 —— 表现为"长按没反应"。
    if (ctxBornAt && Date.now() - ctxBornAt < 500) return;
    box.remove();
  }, true);

  /* 4. 软键盘：把输入区顶到键盘上沿，底部标签栏让位 */
  const vv = window.visualViewport;
  if (vv) {
    const upd = () => {
      const kb = Math.max(0, innerHeight - vv.height);
      document.documentElement.style.setProperty('--kb', kb + 'px');
      document.body.classList.toggle('is-kb', kb > 80);
      if (kb > 80) {
        const sc = document.querySelector('.chat__scroll');
        if (sc) requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; });
      }
    };
    vv.addEventListener('resize', upd);
    vv.addEventListener('scroll', upd);
  } else {
    document.addEventListener('focusin', (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        document.documentElement.style.setProperty('--kb', '300px');
        document.body.classList.add('is-kb');
      }
    });
    document.addEventListener('focusout', () => {
      document.documentElement.style.setProperty('--kb', '0px');
      document.body.classList.remove('is-kb');
    });
  }
}

export function refreshBadgesFromState() {
  updateBadges({
    chat: (state.convs || []).reduce((s, c) => s + (c.unread || 0), 0),
    contacts: (state.requests.friend || []).length,
  });
}
