/* ============================================================
   UI 组件：Toast / Modal / 抽屉 / 右键菜单 / 滑块人机检测 / 图片预览
   ============================================================ */
import { $, el, esc, download } from './util.js';
import { api } from './api.js';
import { icon, icoHtml } from './icons.js';
import { isNarrow } from './formfactor.js';

/* ---------------- Toast ---------------- */
export function toast(msg, kind = 'info', ms = 2400) {
  const root = $('#toastRoot');
  const node = el('div', { class: `toast toast--${kind}`, role: 'status', 'aria-live': 'polite' }, [
    el('span', { class: 'toast__ico', html: icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : kind === 'warn' ? 'shield' : 'info', 16) }),
    el('span', { text: msg }),
  ]);
  root.appendChild(node);
  setTimeout(() => { node.classList.add('is-out'); setTimeout(() => node.remove(), 260); }, ms);
  return node;
}

/* ---------------- 3D 倾斜（事件委托，class="tilt" 即生效） ---------------- */
let _tiltBound = false;
export function bindTilt() {
  if (_tiltBound) return;
  _tiltBound = true;
  let cur = null;
  const reset = () => {
    if (!cur) return;
    cur.classList.remove('is-tilting');
    cur.style.setProperty('--rx', '0deg');
    cur.style.setProperty('--ry', '0deg');
    cur.style.setProperty('--ts', '1');
    cur = null;
  };
  document.addEventListener('pointermove', (e) => {
    const t = e.target instanceof Element ? e.target.closest('.tilt') : null;
    if (!t) { reset(); return; }
    if (cur && cur !== t) reset();
    cur = t;
    const r = t.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    const max = Number(t.dataset.tilt || 6);
    t.classList.add('is-tilting');
    t.style.setProperty('--ry', (px * max * 2).toFixed(2) + 'deg');
    t.style.setProperty('--rx', (-py * max * 2).toFixed(2) + 'deg');
    t.style.setProperty('--ts', '1.015');
  });
  document.addEventListener('pointerleave', reset);
  window.addEventListener('blur', reset);
}

/* ---------------- 可拖动卡片 ----------------
   按住 handle（弹窗标题栏）拖动整个卡片；位移用 CSS 变量 --dx/--dy 记录，
   这样弹窗原本的 translate(-50%,-50%) 居中变换不会被破坏。 */
export function makeDraggable(box, handle, { onDragStart = null, clamp = false } = {}) {
  if (!box || !handle) return;
  let dx = 0, dy = 0, sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, pid = null;

  handle.style.cursor = 'grab';
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a, input, select, textarea')) return;
    dragging = true; pid = e.pointerId;
    sx = e.clientX; sy = e.clientY; ox = dx; oy = dy;
    handle.style.cursor = 'grabbing';
    box.classList.add('is-dragging');
    try { handle.setPointerCapture(pid); } catch { /* ignore */ }
    onDragStart && onDragStart();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = ox + (e.clientX - sx);
    dy = oy + (e.clientY - sy);
    if (clamp) {
      // 拖不丢：整张卡永远保持在视口内（留 12px 安全边）。
      // r.left = 静态位置 + dx，所以由它反推出 dx / dy 的允许区间。
      const r = box.getBoundingClientRect();
      const left0 = r.left - dx, top0 = r.top - dy;
      const minX = 12 - left0, maxX = innerWidth - 12 - r.width - left0;
      const minY = 12 - top0, maxY = innerHeight - 12 - r.height - top0;
      dx = (minX <= maxX) ? Math.max(minX, Math.min(dx, maxX)) : dx;
      dy = (minY <= maxY) ? Math.max(minY, Math.min(dy, maxY)) : dy;
    }
    box.style.setProperty('--dx', dx + 'px');
    box.style.setProperty('--dy', dy + 'px');
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.style.cursor = 'grab';
    box.classList.remove('is-dragging');
    try { handle.releasePointerCapture(pid); } catch { /* ignore */ }
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('dblclick', () => {
    dx = 0; dy = 0;
    box.style.setProperty('--dx', '0px');
    box.style.setProperty('--dy', '0px');
  });
}

/* ---------------- Modal ---------------- */
export function modal({ title = '', body = '', footer = null, wide = false, onClose = null } = {}) {
  const root = $('#modalRoot');
  const scrim = el('div', { class: 'modal-scrim' });
  const box = el('div', { class: 'modal' + (wide ? ' modal--wide' : '') });
  const close = () => {
    if (box.dataset.closing === '1') return;
    box.dataset.closing = '1';
    // 用专门的退场关键帧（下沉 + 缩小 + 淡出），而不是把入场动画倒放
    box.style.animation = 'popOut .18s cubic-bezier(.4, 0, 1, 1) both';
    scrim.style.animation = 'fadeOut .16s ease both';
    setTimeout(() => { scrim.remove(); box.remove(); onClose && onClose(); }, 175);
  };
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', function esc2(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); }
  });

  const head = el('div', { class: 'modal__head' }, [
    el('div', { class: 'modal__title', text: title }),
    el('button', { class: 'icon-btn modal__close', html: icon('x', 18), onClick: close }),
  ]);
  box.appendChild(head);
  // 手机端 modal 是底部抽屉，拖动会和内容滚动打架，交给 mobile.js 的下拉手势
  if (!isNarrow()) makeDraggable(box, head);
  const bodyWrap = el('div', { class: 'modal__body' });
  if (typeof body === 'string') bodyWrap.innerHTML = body; else if (body) bodyWrap.appendChild(body);
  box.appendChild(bodyWrap);

  if (footer) {
    const foot = el('div', { class: 'modal__foot' });
    for (const b of footer) {
      const btn = el('button', { class: `btn ${b.kind ? 'btn--' + b.kind : 'btn--ghost'}`, text: b.text });
      btn.addEventListener('click', async () => {
        // 回调可能是 async（如管理员登录），必须等待完成再决定是否关闭，
        // 否则会先走 onClose → resolve(false)，把成功结果覆盖掉。
        // 另外：回调抛错时必须兜住并提示——此前未捕获会导致弹窗既不关闭、
        // 也没有任何反馈，看起来就像「点了没反应 / 卡死」。
        if (btn.dataset.busy === '1') return;      // 防重复点击
        btn.dataset.busy = '1';
        const label = btn.textContent;
        btn.disabled = true;
        try {
          const r = await (b.onClick && b.onClick(box));
          if (r !== false && b.close !== false) close();
        } catch (e) {
          toast(e?.message || '操作失败，请重试', 'err');
        } finally {
          btn.disabled = false;
          btn.dataset.busy = '';
          if (btn.isConnected && btn.textContent !== label) btn.textContent = label;
        }
      });
      foot.appendChild(btn);
    }
    box.appendChild(foot);
  }
  root.appendChild(scrim); root.appendChild(box);
  return { box, body: bodyWrap, close };
}

export function confirm(msg, { title = '确认操作', danger = false, okText = '确定' } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: el('div', { class: 'muted', text: msg, style: { padding: '4px 0 8px', lineHeight: '1.7' } }),
      footer: [
        { text: '取消', onClick: () => resolve(false) },
        { text: okText, kind: danger ? 'danger' : 'primary', onClick: () => resolve(true) },
      ],
      onClose: () => resolve(false),
    });
  });
}

export function prompt(title, { label = '', value = '', placeholder = '', multiline = false, password = false } = {}) {
  return new Promise((resolve) => {
    const input = multiline
      ? el('textarea', { class: 'input', rows: 4, style: { resize: 'vertical', height: 'auto', padding: '10px 12px' }, placeholder })
      : el('input', { class: 'input', type: password ? 'password' : 'text', value, placeholder });
    const wrap = el('div', { class: 'field' }, [
      label ? el('span', { class: 'field__label', text: label }) : null,
      input,
    ]);
    setTimeout(() => input.focus(), 60);
    modal({
      title,
      body: wrap,
      footer: [
        { text: '取消', onClick: () => resolve(null) },
        {
          text: '确定', kind: 'primary', onClick: () => {
            const v = String(input.value || '').trim();
            if (!v) { input.focus(); return false; }
            resolve(v);
          }
        },
      ],
      onClose: () => resolve(null),
    });
  });
}

/* ---------------- 底部抽屉 ---------------- */
export function sheet(items, title = '') {
  return new Promise((resolve) => {
    const root = $('#sheetRoot');
    const scrim = el('div', { class: 'modal-scrim' });
    const box = el('div', { class: 'sheet' });
    const done = (v) => {
      if (done._closed) return; done._closed = true;
      scrim.style.animation = 'fadeOut .18s ease both';
      box.style.animation = 'sheetOut .22s cubic-bezier(.4, 0, 1, 1) both';
      setTimeout(() => { scrim.remove(); box.remove(); }, 210);
      resolve(v);
    };
    scrim.addEventListener('click', () => done(null));
    if (title) box.appendChild(el('div', { class: 'sheet__item muted', text: title, style: { fontSize: '12px' } }));
    for (const it of items) {
      box.appendChild(el('button', {
        class: 'sheet__item' + (it.danger ? ' sheet__item--danger' : ''),
        onClick: () => done(it.value !== undefined ? it.value : it.label),
      }, [el('span', { class: 'sheet__ico', html: icoHtml(it.icon, 18) }), el('span', { text: it.label })]));
    }
    box.appendChild(el('button', { class: 'sheet__item muted', text: '取消', onClick: () => done(null) }));
    root.appendChild(scrim); root.appendChild(box);
  });
}

/* ---------------- 右键菜单 ---------------- */
export function ctxMenu(x, y, items) {
  document.querySelectorAll('.ctx').forEach((n) => n.remove());
  const box = el('div', { class: 'ctx', style: { left: `${Math.min(x, innerWidth - 180)}px`, top: `${Math.min(y, innerHeight - 260)}px` } });
  // 菜单刚弹出的这段时间内不接受点击：手机长按松手后浏览器会补发一个 click，
  // 落点正好压在某个菜单项上 —— 不挡住就是"长按一下直接执行了撤回 / 举报"。
  const born = Date.now();
  for (const it of items) {
    if (!it) continue;
    box.appendChild(el('button', {
      class: 'ctx__item' + (it.danger ? ' ctx__item--danger' : ''),
      onClick: () => {
        if (Date.now() - born < 350) return;
        box.remove(); it.onClick && it.onClick();
      },
    }, [el('span', { class: 'ctx__ico', html: icoHtml(it.icon || 'dot', 16) }), el('span', { text: it.label })]));
  }
  document.body.appendChild(box);
  const off = (e) => { if (!box.contains(e.target)) { box.remove(); document.removeEventListener('mousedown', off); } };
  // 触摸端不在这里注册 mousedown 关闭：长按弹出菜单后松开手指，Chrome 会补发一个
  // 合成 mousedown（目标正是被长按的那条消息），会被误判成"点外面"把刚弹出的菜单删掉。
  // 触摸端的"点外面关闭"由 mobile.js 的 pointerdown 捕获处理（只在新手势时触发）。
  if (!isNarrow()) setTimeout(() => document.addEventListener('mousedown', off), 10);
}

/* ---------------- 图片 / 视频预览 ----------------
   opts.name 传入原文件名时，顶部会显示名字并提供「保存」按钮 ——
   图片 / 视频消息没有别的下载入口，放大预览这一步必须能落盘。 */
export function lightbox(src, isVideo = false, opts = {}) {
  const scrim = el('div', {
    class: 'modal-scrim lightbox',
    style: { background: 'rgba(4,3,10,.9)', display: 'grid', placeItems: 'center', zIndex: 300 },
  });
  const media = isVideo
    ? el('video', { src, controls: true, autoplay: true, style: { maxWidth: '88vw', maxHeight: '84vh', borderRadius: '14px' } })
    : el('img', { src, style: { maxWidth: '88vw', maxHeight: '84vh', borderRadius: '14px', boxShadow: '0 30px 80px rgba(0,0,0,.6)' } });
  const stage = el('div', { class: 'lightbox__stage' }, [media]);
  if (opts.name) {
    stage.appendChild(el('div', { class: 'lightbox__bar' }, [
      el('span', { class: 'lightbox__name ellipsis', text: opts.name }),
      el('button', {
        class: 'lightbox__save', type: 'button',
        html: `${icoHtml('download', 15)}<span>保存</span>`,
        onClick: async (e) => {
          e.stopPropagation();
          try {
            // 优先使用调用方传入的 Blob（聊天/动态图片解密后直接持有），
            // 避免 fetch(blob:) 被 CSP connect-src 拦截导致「无法下载」。
            let blob = opts.blob;
            if (!blob) {
              const res = await fetch(src);
              blob = await res.blob();
            }
            download(blob, opts.name);
            toast('已开始下载', 'ok');
          } catch { toast('保存失败', 'err'); }
        },
      }),
    ]));
  }
  scrim.appendChild(stage);
  scrim.addEventListener('click', () => {
    scrim.style.animation = 'fadeIn .18s reverse both';
    media.style.animation = 'popIn .22s reverse both';
    setTimeout(() => scrim.remove(), 190);
  });
  document.body.appendChild(scrim);
}

/* ---------------- 滑块人机检测 ---------------- */
const CAP_W = 320, CAP_H = 180;

export function createSlider(host) {
  let data = null, x = 0, cost = 0, track = [], passed = false;
  let scale = 1, dragging = false, t0 = 0, raf = 0;

  const bg = el('img', { class: 'slider__bg', alt: '验证底图', draggable: 'false' });
  const piece = el('img', { class: 'slider__piece', alt: '', draggable: 'false' });
  const flash = el('div', { class: 'slider__flash' });
  const stage = el('div', { class: 'slider__stage' }, [bg, piece, flash]);

  const fill = el('div', { class: 'slider__fill' });
  const knob = el('div', {
    class: 'slider__knob', html: '<span class="slider__knob-ic">⇢</span>',
    tabindex: '0', role: 'slider', 'aria-label': '拖动滑块完成拼图',
  });
  const hint = el('div', { class: 'slider__hint', text: '按住滑块拖动，拼合图形' });
  const trackEl = el('div', { class: 'slider__track' }, [fill, hint, knob]);
  const refreshBtn = el('button', { class: 'slider__refresh', type: 'button', html: '⟳', title: '换一张', 'aria-label': '换一张' });
  const bar = el('div', { class: 'slider__bar' }, [trackEl, refreshBtn]);

  host.append(stage, bar);
  host.classList.add('is-loading');

  const knobIcon = knob.firstElementChild;
  refreshBtn.addEventListener('click', () => refresh());
  // 键盘操作（无障碍）：连续按键结束后再校验
  let kbTimer = 0;
  knob.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    if (passed || !data) return;
    if (!t0) t0 = Date.now();
    setX(x + (e.key === 'ArrowRight' ? 8 : -8), true);
    track.push({ x: Math.round(x), t: Date.now() - t0 });
    clearTimeout(kbTimer);
    kbTimer = setTimeout(() => {
      if (dragging) return;
      cost = Math.max(Date.now() - t0, 400);
      settle(false);
    }, 420);
  });

  function layout() {
    const w = stage.clientWidth;
    if (!w) return;                       // 容器不可见（如注册页签隐藏）时跳过
    scale = w / CAP_W;
    if (!data) return;
    // 舞台纵横比可以和底图不一致（如注册页压缩高度），纵向单独按实际高度等比缩放即可保持对位
    const sv = (stage.clientHeight || CAP_H) / CAP_H;
    piece.style.width = `${data.pw * scale}px`;
    piece.style.height = `${data.ph * sv}px`;
    piece.style.top = `${data.y * sv}px`;
    piece.style.left = '0px';
    applyX(false);
  }

  function applyX(animate = false) {
    if (animate) {
      piece.style.transition = 'transform .34s cubic-bezier(.22,.9,.28,1)';
      fill.style.transition = 'width .34s cubic-bezier(.22,.9,.28,1)';
      knob.style.transition = 'left .34s cubic-bezier(.22,.9,.28,1)';
    } else {
      piece.style.transition = fill.style.transition = knob.style.transition = '';
    }
    piece.style.transform = `translate3d(${x}px,0,0)`;
    knob.style.left = `${x}px`;
    fill.style.width = `${x + knob.offsetWidth / 2}px`;
  }

  function setX(px, animate = false) {
    const max = Math.max(0, trackEl.clientWidth - knob.offsetWidth);
    x = Math.max(0, Math.min(px, max));
    applyX(animate);
  }

  let gen = 0;        // 生成序号：防止连点“换一张”时旧请求覆盖新图
  let autoRetry = 0;  // 加载失败自动重试次数，成功后清零

  async function refresh() {
    const my = ++gen;
    cancelAnimationFrame(raf);
    passed = false; x = 0; track = []; cost = 0; t0 = 0;
    host.classList.remove('is-ok', 'is-fail');
    host.classList.add('is-loading');
    hint.textContent = '正在加载验证…';
    hint.style.opacity = '1';
    piece.style.visibility = 'hidden';
    bg.style.opacity = '0';
    applyX(false);
    fill.style.width = '0px';
    try { data = await api.post('/api/auth/captcha'); }
    catch (e) {
      // 服务冷启动 / 网络抖动可能偶发失败，先自动重试两次，别让用户卡在“点我重试”
      if (autoRetry < 2) {
        autoRetry += 1;
        hint.textContent = '验证加载失败，正在重试…';
        hint.style.opacity = '1';
        setTimeout(() => { if (my === gen) refresh(); }, 900 * autoRetry);
        return;
      }
      host.classList.remove('is-loading');
      hint.textContent = '验证加载失败，点击 ⟳ 重试';
      hint.style.opacity = '1';
      return;
    }
    autoRetry = 0;
    // 调试模式（服务端下发 target_x）才存在，供自动化测试确定性拖动
    if (data.target_x != null) host.dataset.targetX = String(data.target_x);
    else delete host.dataset.targetX;
    bg.src = data.bg;
    piece.src = data.piece;

    const loaded = (img) => (img.complete
      ? Promise.resolve()
      : new Promise((r) => { img.onload = r; img.onerror = r; }));
    // 图片解码完成后再显示，避免闪现；同时加超时兜底，绝不卡在加载态
    await Promise.race([
      Promise.all([loaded(bg), loaded(piece)]),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    await new Promise((r) => requestAnimationFrame(r));
    if (my !== gen) return;                  // 期间已被新的 refresh() 接管
    host.classList.remove('is-loading');
    layout();
    bg.style.opacity = '1';
    piece.style.visibility = 'visible';
    hint.textContent = '按住滑块拖动，拼合图形';
    hint.style.opacity = '1';
  }

  const onMove = (e) => {
    if (!dragging) return;
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const px = cx - startX + startPos;
    setX(px);
    track.push({ x: Math.round(px), t: Date.now() - t0 });
    if (x > 6) hint.style.opacity = '0';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    cost = Date.now() - t0;
    host.classList.remove('is-dragging');
    knob.style.cursor = '';
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    if (x > 2) applyX(true);
    settle();
  };

  /** 松手后即时向服务端校验，给出明确的通过/失败反馈 */
  async   function settle(byDrag = true) {
    if (passed || !data || x <= 0) return;
    if (byDrag && cost && cost < 260) {  // 客户端先拦截“操作过快”，避免白白消耗票据
      fail('拖得太快了，请稍慢一点');
      return;
    }
    hint.textContent = '正在校验…';
    hint.style.opacity = '1';
    try {
      const r = await api.post('/api/auth/captcha/check', {
        captcha_id: data.id,
        captcha_x: Math.round(x / (scale || 1)),
        captcha_track: track,
        captcha_cost: cost,
      });
      if (r && r.passed) done();
      else fail(r && r.error);
    } catch (e) {
      fail(e && e.message);
    }
  }
  let startX = 0, startPos = 0;
  const onDown = (e) => {
    if (passed || !data || host.classList.contains('is-loading')) return;
    dragging = true;
    startX = e.touches ? e.touches[0].clientX : e.clientX;
    startPos = x;
    t0 = Date.now();
    track = [{ x: Math.round(x), t: 0 }];
    host.classList.add('is-dragging');
    hint.style.opacity = x > 6 ? '0' : '1';
    try { knob.setPointerCapture(e.pointerId); } catch (_) {}
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    e.preventDefault();
  };
  knob.addEventListener('pointerdown', onDown);
  knob.addEventListener('touchstart', onDown, { passive: false });

  // 容器尺寸变化（窗口缩放 / 页签切换显示）时重新计算缩放
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => layout()).observe(stage);
  } else {
    window.addEventListener('resize', layout);
  }

  refresh();

  function fail(msg) {
    host.classList.remove('is-ok');
    host.classList.add('is-fail');
    hint.textContent = msg || '验证失败，请重试';
    hint.style.opacity = '1';
    knobIcon.textContent = 'x';
    setX(0, true);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      setTimeout(() => { host.classList.remove('is-fail'); knobIcon.textContent = '⇢'; refresh(); }, 900);
    });
  }

  function done() {
    passed = true;
    host.classList.remove('is-fail');
    host.classList.add('is-ok');
    knobIcon.textContent = '✓';
    hint.textContent = `验证通过 · ${(cost / 1000).toFixed(1)}s`;
    hint.style.opacity = '1';
    flash.classList.add('is-on');
    setTimeout(() => flash.classList.remove('is-on'), 620);
  }

  return {
    refresh,
    relayout: layout,        // 容器可见性 / 尺寸变化后手动重算拼图缩放
    async value() {
      if (!data) throw new Error('请先完成滑动验证');
      if (!passed) throw new Error('请先拖动滑块完成拼图');
      return {
        captcha_id: data.id,
        captcha_x: Math.round(x / (scale || 1)),
        captcha_track: track,
        captcha_cost: cost,
      };
    },
    fail,
    done,
    get done_() { return passed; },
  };
}
