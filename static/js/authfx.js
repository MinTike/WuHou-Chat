/* ============================================================
   武侯Chat · 认证页画布粒子网络（玻璃拟态氛围层）
   Copyright © 2026 左熙宇
   ------------------------------------------------------------
   作用：在品牌页背景之上、卡片之下铺一层「漂浮粒子 + 近邻连线 +
        指针轻微排斥」的动效，配合卡片的半透明玻璃把粒子虚化成柔光
        散景（bokeh），强化玻璃拟态的纵深感。

   降级策略（与 motion.js 的 perf 看门狗保持一致）：
     · 移动端（html.is-mobile）：不启动，触摸端没有 hover 且省电
     · 系统要求降低动效（prefers-reduced-motion）：不启动
     · 帧率过低被标记降级（html.perf-lite）：不启动
     · 窄屏（≤900px）：认证页是单卡堆叠，氛围层意义不大，亦跳过
   生命周期：showAuth() → startAuthFX()；hideAuth() → stopAuthFX()。
   ============================================================ */
const REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

let canvas = null;
let ctx = null;
let raf = 0;
let particles = [];
let w = 0;
let h = 0;
let dpr = 1;
let running = false;
let formObserver = null;
const mouse = { x: -9999, y: -9999, active: false };

function enabled() {
  const root = document.documentElement;
  if (root.classList.contains('is-mobile')) return false;
  if (root.classList.contains('perf-lite')) return false;
  if (REDUCE) return false;
  if (window.innerWidth <= 900) return false;
  return true;
}

function resize() {
  const auth = document.getElementById('auth');
  if (!auth || !canvas) return;
  const rect = auth.getBoundingClientRect();
  w = Math.max(1, Math.floor(rect.width || window.innerWidth));
  h = Math.max(1, Math.floor(rect.height || window.innerHeight));
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function buildParticles() {
  // 密度随面积，但设上下限，避免大屏过密或小屏过空
  const count = Math.max(26, Math.min(72, Math.round((w * h) / 24000)));
  particles = [];
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      r: 1.1 + Math.random() * 1.9,
    });
  }
}

function step() {
  if (!running) return;
  ctx.clearRect(0, 0, w, h);

  // 运动 + 鼠标轻微排斥（不吸附、不跟随，仅局部让开）
  const REPEL = 120;
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < 0 || p.x > w) p.vx *= -1;
    if (p.y < 0 || p.y > h) p.vy *= -1;
    if (mouse.active) {
      const dx = p.x - mouse.x;
      const dy = p.y - mouse.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < REPEL * REPEL) {
        const d = Math.sqrt(d2) || 1;
        const f = ((REPEL - d) / REPEL) * 0.5;
        p.vx += (dx / d) * f * 0.12;
        p.vy += (dy / d) * f * 0.12;
      }
    }
    // 限速，避免被鼠标推飞后回不来
    const sp = Math.hypot(p.vx, p.vy);
    const MAX = 1.15;
    if (sp > MAX) { p.vx = (p.vx / sp) * MAX; p.vy = (p.vy / sp) * MAX; }
  }

  // 近邻连线
  const LINK = 130;
  ctx.lineWidth = 1;
  for (let i = 0; i < particles.length; i++) {
    const a = particles[i];
    for (let j = i + 1; j < particles.length; j++) {
      const b = particles[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d < LINK) {
        const al = (1 - d / LINK) * 0.45;
        ctx.strokeStyle = `rgba(150, 178, 255, ${al.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  // 粒子本体（径向渐变，柔光点）
  for (const p of particles) {
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3.2);
    g.addColorStop(0, 'rgba(190, 214, 255, .92)');
    g.addColorStop(1, 'rgba(140, 170, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  raf = requestAnimationFrame(step);
}

function onMove(e) {
  const auth = document.getElementById('auth');
  if (!auth) return;
  const rect = auth.getBoundingClientRect();
  mouse.x = e.clientX - rect.left;
  mouse.y = e.clientY - rect.top;
  mouse.active = true;
}
function onLeave() { mouse.active = false; mouse.x = -9999; mouse.y = -9999; }

/** 认证页显示时调用：创建画布并启动动画（若处于降级环境则安静跳过） */
export function startAuthFX() {
  if (running) return;
  if (!enabled()) {
    window.__authFX = { running: false, skipped: true, reason: 'degraded' };
    return;
  }
  const auth = document.getElementById('auth');
  if (!auth) return;

  canvas = document.createElement('canvas');
  canvas.className = 'auth-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  auth.appendChild(canvas);
  ctx = canvas.getContext('2d');

  resize();
  buildParticles();

  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerleave', onLeave, { passive: true });
  window.addEventListener('resize', resize);

  // 形态切到移动端时立刻收掉画布（认证页常驻期间也可能跨形态，不能只靠 hideAuth）
  formObserver = new MutationObserver(() => {
    if (document.documentElement.classList.contains('is-mobile')) stopAuthFX();
  });
  formObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  running = true;
  window.__authFX = { running: true, skipped: false, count: particles.length };
  raf = requestAnimationFrame(step);
}

/** 认证页隐藏时调用：停动画、移除画布、解绑监听，彻底释放资源 */
export function stopAuthFX() {
  running = false;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerleave', onLeave);
  window.removeEventListener('resize', resize);
  if (formObserver) { formObserver.disconnect(); formObserver = null; }
  if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  canvas = null;
  ctx = null;
  particles = [];
  window.__authFX = { running: false, stopped: true };
}
