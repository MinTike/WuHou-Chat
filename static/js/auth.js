/* ============================================================
   登录 / 注册（含滑动人机检测、身份密钥初始化）
   登录与注册是两张各自独立、可拖动的卡片（见 initAuthDesk）。
   ============================================================ */
import { $, el, avatar } from './util.js';
import { api, tokenStore } from './api.js';
import { toast, createSlider, makeDraggable } from './ui.js';
import { icon } from './icons.js';
import { startAuthFX, stopAuthFX } from './authfx.js';
import * as C from './crypto.js';

const AVATARS = ['🦊', '🐼', '🐯', '🐨', '🐸', '🐵', '🦁', '🐧', '🦄', '🐙', '🦉', '🐳', '🌙', '🔥', '🍀', '🎧'];

let sliderLogin = null, sliderReg = null;
let onSuccess = () => {};
let secondTemp = '';      // 二次登录续接凭证（已通过滑块，免重复验证）
let pendingAvatarFile = null;   // 注册阶段选中的头像文件（登录后再加密上传）

export function initAuth(handler) {
  onSuccess = handler;

  /* 登录 / 注册：两张独立卡片（可拖拽）的调度 */
  initAuthDesk();

  /* 一旦用户开始改动输入，就收起上次的失败原因 */
  [['#loginForm', 'loginErr'], ['#regForm', 'regErr']].forEach(([sel, box]) => {
    const f = $(sel);
    if (!f) return;
    f.addEventListener('input', () => clearErr(box));
    f.addEventListener('change', () => clearErr(box));
  });
  requestAnimationFrame(placeCards);
  window.addEventListener('resize', () => { placeCards(true); });

  /* 默认聚焦用户名：进入登录页即可直接输入（不影响滑块验证） */
  setTimeout(() => {
    const u = $('#loginForm [name=username]');
    if (u && !u.value) u.focus();
  }, 260);

  /* 明文切换 */
  document.querySelectorAll('.input-eye').forEach((b) => {
    b.addEventListener('click', () => {
      const input = b.parentElement.querySelector('input');
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      b.textContent = input.type === 'password' ? '👁' : '🙈';
    });
  });

  /* 头像选择 */
  const picker = $('#avatarPicker');
  let avatarValue = AVATARS[0];
  AVATARS.forEach((a, i) => {
    const o = el('button', {
      class: 'avatar-picker__opt' + (i === 0 ? ' is-active' : ''), type: 'button', text: a,
      onClick: () => {
        avatarValue = a;
        picker.querySelectorAll('.avatar-picker__opt').forEach((n) => n.classList.remove('is-active'));
        o.classList.add('is-active');
      },
    });
    picker.appendChild(o);
  });
  const uploadBtn = el('button', {
    class: 'avatar-picker__opt avatar-picker__upload', type: 'button', text: '上传',
    onClick: async () => {
      const files = await new Promise((res) => {
        const i = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
        document.body.appendChild(i);
        i.onchange = () => { res(Array.from(i.files || [])); i.remove(); };
        i.click();
      });
      if (!files.length) return;
      const f = files[0];
      if (f.size > 3 * 1024 * 1024) { toast('头像图片不能超过 3MB', 'err'); return; }
      // 加密所需的全局密钥要登录后才下发，因此这里只暂存文件，注册成功后再上传
      pendingAvatarFile = f;
      avatarValue = '';
      picker.dataset.value = avatarValue;
      uploadBtn.textContent = '';
      uploadBtn.appendChild(el('img', { src: URL.createObjectURL(f), alt: '' }));
      uploadBtn.classList.add('is-active');
      picker.querySelectorAll('.avatar-picker__opt').forEach((n) => { if (n !== uploadBtn) n.classList.remove('is-active'); });
      toast('头像已选择，注册后自动上传', 'ok');
    },
  });
  picker.appendChild(uploadBtn);
  picker.dataset.value = avatarValue;
  picker.getValue = () => avatarValue;

  /* 滑块 */
  sliderLogin = createSlider($('#sliderLogin'));
  sliderReg = createSlider($('#sliderReg'));

  /* 注册：选填字段折叠区（表单值始终参与提交，折叠只是视觉收起） */
  const moreBtn = $('#regMoreBtn');
  const moreWrap = $('#regMore');
  if (moreBtn && moreWrap) {
    const syncMoreLabel = (open) => {
      const label = moreBtn.querySelector('span');
      if (label) label.textContent = open ? '收起选填信息' : '更多信息（年龄 / 性别 / 生日，选填）';
    };
    moreBtn.addEventListener('click', () => {
      const open = moreWrap.classList.toggle('is-open');
      moreBtn.classList.toggle('is-open', open);
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      syncMoreLabel(open);
      // 展开 / 收起后重新量一次滑块舞台，保证拼图块位置仍然准确
      setTimeout(() => sliderReg?.relayout?.(), 340);
    });
    syncMoreLabel(false);
  }

  /* 提交 */
  $('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
  $('#regForm').addEventListener('submit', (e) => { e.preventDefault(); doRegister(); });
}

/* ---------------- 认证卡片桌面 ----------------
   登录 / 注册各是一张独立卡片：
     · 标题栏可拖动（带边界约束，拖不出屏幕），双击标题栏回到默认位置
     · 点任意卡片即置顶；标题栏右侧按钮切换到另一张
     · ▦ 按钮切换「并排显示」，两张卡同时可见
     · 窄屏（≤900px）自动回到普通居中排版，拖拽仍然可用 */
let cardNodes = null;
let activeCard = 'login';

function cardsOf() {
  if (!cardNodes) cardNodes = { login: $('#loginCard'), register: $('#regCard') };
  return cardNodes;
}

function relayoutSliders() {
  setTimeout(() => { sliderLogin?.relayout?.(); sliderReg?.relayout?.(); }, 240);
}

export function showAuthCard(which) {
  const cards = cardsOf();
  const target = cards[which];
  if (!target) return;
  Object.entries(cards).forEach(([k, node]) => {
    if (!node) return;
    if (k === which) { node.hidden = false; node.classList.add('is-front'); }
    else { node.classList.remove('is-front'); }
  });
  activeCard = which;
  clearErr(which === 'login' ? 'loginErr' : 'regErr');
  relayoutSliders();
}

function hideOther(which) {
  const cards = cardsOf();
  Object.entries(cards).forEach(([k, node]) => {
    if (!node || k === which || node.hidden) return;
    node.classList.add('is-hiding');
    // 与 cardOut 的 .24s 对齐；提前收起会砍掉退场动画的尾巴
    setTimeout(() => {
      node.classList.remove('is-hiding');
      // 延迟期间用户可能已经切回这张卡（典型的：页面刚打开就点「注册 ›」，
      // 而 initAuthDesk 的初始 hideOther 定时器还没到点）——此时绝不能把当前卡藏掉
      if (activeCard === k) return;
      node.hidden = true;
    }, 240);
  });
}

/** 默认落位：舞台在左，卡片停在舞台右侧；用户拖过之后就不再自动挪动 */
function placeCards(onResize = false) {
  const cards = cardsOf();
  if (!cards.login) return;
  if (innerWidth <= 900) {                 // 窄屏交给 CSS 排布
    Object.values(cards).forEach((node) => {
      if (!node) return;
      node.style.removeProperty('--x');
      node.style.removeProperty('--y');
    });
    return;
  }
  const hero = document.querySelector('.auth__showcase--hero');
  const heroRight = hero && hero.offsetParent ? hero.getBoundingClientRect().right : 0;
  const half = Math.min(430, innerWidth - 32) / 2;
  const x = Math.min(Math.max(heroRight + half + 34, innerWidth * 0.62), innerWidth - half - 16);
  const y = Math.round(innerHeight * 0.5);
  Object.values(cards).forEach((node) => {
    if (!node) return;
    // 用户已经拖过的卡片不参与自动重排，尊重手动位置
    if (onResize && (node.style.getPropertyValue('--dx') || node.style.getPropertyValue('--dy'))) return;
    node.style.setProperty('--x', `${Math.round(x)}px`);
    node.style.setProperty('--y', `${y}px`);
  });
}

function initAuthDesk() {
  const cards = cardsOf();
  const desk = $('#authDesk');
  if (!cards.login || !desk) return;

  Object.entries(cards).forEach(([key, node]) => {
    if (!node) return;
    const bar = node.querySelector('.auth-card__bar');
    makeDraggable(node, bar, { clamp: true, onDragStart: () => showAuthCard(key) });
    bar?.addEventListener('dblclick', () => {                 // 双击标题栏：回到默认位置
      node.style.setProperty('--dx', '0px');
      node.style.setProperty('--dy', '0px');
    });
    node.addEventListener('pointerdown', () => showAuthCard(key));
    node.querySelectorAll('.auth-card__btn[data-to]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        showAuthCard(b.dataset.to);
        hideOther(b.dataset.to);
      });
    });
  });

  placeCards();
  showAuthCard('login');
  hideOther('login');
}

/** 阶段超时看门狗：任一环节挂起都会抛出可读错误，避免界面永久卡在加载态 */
function guard(promise, ms, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}超时，请检查网络后重试`)), ms); }),
  ]);
}

/* ---------------- 表单内错误提示 ---------------- */
/** 服务端错误码 → 用户能看懂的原因（后端文案本身足够具体时留空，直接用后端文案） */
const REASONS = {
  bad_credentials: '用户名或密码错误，请检查后重试',
  bad_username: '用户名需为 3-20 位字母、数字、下划线、点或短横线',
  bad_password: '密码长度需为 8-128 位',
  username_taken: '该用户名已被注册，换一个试试',
  no_pubkey: '浏览器密钥初始化失败，请刷新页面后重试',
  captcha_failed: '滑块验证未通过：请按住滑块，把它拖到缺口位置再松开',
  captcha_expired: '人机检测已过期，请重新拖动下面的滑块',
  captcha_retry: '这张验证码已失效，请重新拖动滑块',
  rate_limited: '操作过于频繁，请稍候一分钟再试',
  banned: '账号已被封禁，如有疑问请联系管理员',
  bad_second_password: '第二层密码错误，请重新输入',
  bad_temp_token: '二次登录凭证已过期，请重新登录',
  no_user: '账号不存在，请确认用户名是否正确',
};

/** 把任意异常转成一句可读的失败原因 */
function reasonOf(err) {
  const raw = String((err && err.message) || err || '').trim();
  const code = String((err && err.code) || '');
  const mapped = REASONS[code];
  if (!mapped) return raw || '操作失败，请稍后重试';
  // 后端文案含具体信息（如被保留的用户名、命中的敏感词）时，把它附在后面
  const tail = raw && !mapped.includes(raw) && raw.length <= 60 ? `（${raw}）` : '';
  return mapped + tail;
}

function showErr(boxId, msg) {
  const box = $(`#${boxId}`);
  const text = reasonOf(msg);
  if (!box) { toast(text, 'err'); return; }
  box.innerHTML = '';
  box.appendChild(el('span', { class: 'form-alert__ico', html: icon('alert', 15, 2) }));
  box.appendChild(el('span', { class: 'form-alert__text', text }));
  box.hidden = false;
  box.classList.remove('is-shake');
  void box.offsetWidth;                       // 重启动画
  box.classList.add('is-shake');
  try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
}

function clearErr(boxId) {
  const box = $(`#${boxId}`);
  if (!box) return;
  box.hidden = true;
  box.innerHTML = '';
  box.classList.remove('is-shake');
}

const USERNAME_RE = /^[A-Za-z0-9_.\-]{3,20}$/;

function spin(btn, text) {
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${text}`;
}

/** 提交前的本地校验：先给出明确原因，避免无谓的请求往返 */
function invalid(boxId, msg) {
  if (msg) showErr(boxId, msg);
  return !msg;
}

async function doLogin() {
  const form = $('#loginForm');
  const fd = new FormData(form);
  const btn = form.querySelector('button[type=submit]');
  clearErr('loginErr');

  const username = String(fd.get('username') || '').trim();
  const password = String(fd.get('password') || '');
  if (!username || !password) { showErr('loginErr', '请填写用户名和密码'); return; }

  spin(btn, '正在进入…');
  let finished = false;
  try {
    let payload;
    try { payload = await sliderLogin.value(); }
    catch (e) { sliderLogin.fail(e.message); throw e; }
    const dev = JSON.parse(localStorage.getItem('wuhou.device') || 'null') || { id: '' };
    const body = {
      username: String(fd.get('username') || '').trim(),
      password: String(fd.get('password') || ''),
      second_password: String(fd.get('second') || ''),
      device_id: dev.id, device_name: navigator.platform || 'Web',
      temp_token: secondTemp,
      ...payload,
    };
    let r = await guard(api.post('/api/auth/login', body), 20000, '登录请求');
    if (r.need_second) {
      sliderLogin.done();
      secondTemp = r.temp_token || '';
      $('#loginSecondWrap').hidden = false;
      btn.disabled = false; btn.textContent = '验证第二层密码';
      toast('该账号已开启二次登录', 'warn');
      form.querySelector('[name=second]').focus();
      return;
    }
    spin(btn, '正在解锁加密身份…');
    await guard(afterAuth(r.token, body.password, body.second_password), 30000, '解锁身份');
    finished = true;
    sliderLogin.done();
  } catch (err) {
    showErr('loginErr', err);
    sliderLogin.fail(err.message);
  } finally {
    if (!finished) { btn.disabled = false; btn.textContent = '进入武侯Chat'; }
  }
}

async function doRegister() {
  const form = $('#regForm');
  const fd = new FormData(form);
  const btn = form.querySelector('button[type=submit]');
  const password = String(fd.get('password') || '');
  const username = String(fd.get('username') || '').trim();
  const nickname = String(fd.get('nickname') || '').trim();
  clearErr('regErr');

  // 先本地说清楚问题在哪，别让用户白等一次请求
  if (!USERNAME_RE.test(username)) {
    showErr('regErr', '用户名需为 3-20 位字母、数字、下划线、点或短横线');
    form.querySelector('[name=username]').focus();
    return;
  }
  if (!nickname) {
    showErr('regErr', '请填写昵称，别人看到的是这个名字');
    form.querySelector('[name=nickname]').focus();
    return;
  }
  if (nickname.length > 24) {
    showErr('regErr', '昵称不能超过 24 个字');
    form.querySelector('[name=nickname]').focus();
    return;
  }
  if (password.length < 8 || password.length > 128) {
    showErr('regErr', '密码长度需为 8-128 位');
    form.querySelector('[name=password]').focus();
    return;
  }

  let finished = false;
  try {
    let payload;
    try { payload = await sliderReg.value(); }
    catch (e) { sliderReg.fail(e.message); throw e; }

    spin(btn, '正在初始化加密密钥…');
    const identity = await guard(C.createIdentity(password), 15000, '密钥初始化');

    spin(btn, '正在创建账号…');
    const dev = JSON.parse(localStorage.getItem('wuhou.device') || 'null') || { id: '' };
    const r = await guard(api.post('/api/auth/register', {
      username, password, nickname,
      age: fd.get('age') ? Number(fd.get('age')) : null,
      gender: String(fd.get('gender') || 'unknown'),
      birthday: String(fd.get('birthday') || ''),
      avatar: $('#avatarPicker').getValue() || AVATARS[0],
      pubkey: identity.pubkey,
      keyblob: identity.keyblob,
      device_id: dev.id, device_name: navigator.platform || 'Web',
      ...payload,
    }), 20000, '注册请求');
    localStorage.setItem('wuhou.device', JSON.stringify({
      id: (r.device || {}).id || '', name: (r.device || {}).name || '',
    }));
    sliderReg.done();

    spin(btn, '正在进入武侯Chat…');
    await guard(afterAuth(r.token, password, ''), 30000, '初始化会话');
    finished = true;
    toast('身份已创建，欢迎加入武侯Chat', 'ok');
  } catch (err) {
    showErr('regErr', err);
    sliderReg.fail(err.message);
  } finally {
    if (!finished) { btn.disabled = false; btn.textContent = '创建身份'; }
  }
}

async function afterAuth(token, password) {
  tokenStore.set(token);
  const me = await api.get('/api/users/me');
  // 登录后索取全局密钥（兼容历史与群聊），并用登录口令恢复 RSA 身份私钥
  await C.restoreIdentity(password);
  C.setMe(me.user.id);

  // 注册时选了图片头像：此时已登录，上传原图并写回资料
  // （头像属公开资料，若加密则 <img> 无从解析，故与聊天文件区别对待）
  if (pendingAvatarFile) {
    const f = pendingAvatarFile;
    pendingAvatarFile = null;
    try {
      const up = await api.uploadRaw(await f.arrayBuffer(), f.name);
      await api.put('/api/users/me', { avatar: `file:${up.id}` });
    } catch (err) { toast(`头像上传失败：${err.message}`, 'err'); }
  }
  onSuccess(me.user);
}

export function showAuth() {
  $('#auth').hidden = false;
  $('#app').hidden = true;
  startAuthFX();
}
export function hideAuth() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  stopAuthFX();
}

export function avatarPreview(user) { return avatar(user, 'lg'); }
