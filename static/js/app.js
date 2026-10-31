/* ============================================================
   武侯Chat · 应用入口：形态调度 / 实时事件编排
   Copyright © 2026 左熙宇
   ------------------------------------------------------------
   界面系统有两套，且彼此独立（不是同一份 DOM 的响应式补丁）：
     · 电脑端 shell-desktop.js：三栏（rail / side / main），图标栏换栏
     · 移动端 shell-mobile.js ：App 形态（顶栏 + 页面栈 + 底部标签栏）
   本文件只做「编排」：决定当前用哪一套、把业务模块的 render 交给它，
   以及承载与形态无关的部分（主题 / 认证 / 实时事件 / 快捷键）。
   ============================================================ */
import { $, el, debounce } from './util.js';
import { api, tokenStore, setUnauthorizedHandler } from './api.js';
import { toast, sheet, modal, bindTilt } from './ui.js';
import { initAuth, showAuth, hideAuth } from './auth.js?v=20261031';
import { connect } from './realtime.js';
import {
  state, on, emit, loadMe, loadConvs, loadFriends, loadGroups, loadFriendRequests,
  loadTags, startKeySync, roomName,
} from './state.js';
import * as C from './crypto.js';
import * as chat from './chat.js?v=20261031';
import * as contacts from './contacts.js';
import * as moments from './moments.js';
import * as search from './search.js';
import * as settings from './settings.js?v=20261025';
import * as notice from './notice.js';
import { openUserCard, openGroupCard, openReport, openAddFriend, openJoinGroup } from './cards.js';
import { handleCallEvent } from './call.js';
import { icon } from './icons.js';
import { initMotion } from './motion.js?v=20261031';
import { ensureWords, startAutoSync } from './badwords.js';
import {
  formFactor, isMobile, watchFormFactor, onFormFactorChange, setFormFactor,
} from './formfactor.js';
import * as desktop from './shell-desktop.js';
import * as mobile from './shell-mobile.js?v=20261030';

/* ---------------- 启动 ----------------
   boot() 在文件末尾调用：它同步执行到第一个 await 之前，
   若放在这里会先于下方 const（如主题表）求值而触发 TDZ。 */

async function boot() {
  applyTheme();
  renderCopyright();
  // 形态必须在首帧就生效：认证页本身也分两套（窄屏是贴边的单卡，宽屏是双卡舞台），
  // 若等到 enterApp() 才同步，登录前 html.is-mobile 一直缺席，整页样式都是错的。
  watchFormFactor();
  onFormFactorChange((ff) => { if (shell && ff !== shell) swapShell(ff); });
  setUnauthorizedHandler(() => { tokenStore.clear(); location.reload(); });
  bindTilt();
  wireGlobalKeys();
  // 认证卡片的 3D 倾斜：交给卡片自己（拖动时倾斜会干扰手感，只在卡片上做很轻的一档）
  document.querySelectorAll('.auth-card').forEach((c) => {
    c.classList.add('tilt');
    c.dataset.tilt = '2';
  });
  try { initMotion(); } catch (e) { console.warn('动效引擎初始化失败', e); }
  try { await ensureWords(); startAutoSync(); } catch (e) { console.warn('违规词库加载失败', e); }

  // 调试 / 自动化测试句柄（不影响功能；挂到 DOM 上以便外部脚本访问）
  window.__wuhou = { C, api, state, on, emit, tokenStore, formFactor };
  document.documentElement.__wuhou = window.__wuhou;

  const okBoot = await Promise.race([
    (async () => { try { await api.get('/api/meta'); return true; } catch { return false; } })(),
    new Promise((r) => setTimeout(() => r(false), 4000)),
  ]);
  setTimeout(() => {
    const b = $('#boot'); b.classList.add('is-out');
    setTimeout(() => b.remove(), 520);
  }, 500);
  if (!okBoot) toast('无法连接服务端，请确认后端已启动', 'err', 5000);

  initAuth(async () => { await enterApp(); });
  if (tokenStore.get()) {
    try {
      await loadMe();
      C.setMe(state.me.id);
      // 刷新场景：优先用本机设备密钥恢复私钥，失败则要求重新登录解锁
      if (!C.ready()) await C.tryDeviceUnlock();
      if (!C.ready()) throw new Error('密钥未解锁');
      // 只恢复全局密钥还不够：RSA 身份（IDENT）也要从本机缓存恢复，
      // 否则刷新后 hasIdentity() 为 false —— 设置页会重新出现「升级」提示，
      // 私聊也会从会话级密钥退化回全局密钥（要重新登录才恢复）
      await C.restoreIdentity();
      await enterApp(false);
    } catch {
      tokenStore.clear();
      showAuth();
    }
  } else {
    showAuth();
  }
}

/* ---------------- 主题 ----------------
   dark → light → aurora 循环；非法值一律回落为默认主题。
   安卓端（WebView 性能有限，极光的动态渐变背景会持续闪烁）强制禁用极光。 */
const IS_ANDROID = /WuhouChatAndroid/i.test(navigator.userAgent);
const THEMES = IS_ANDROID ? ['dark', 'light'] : ['dark', 'light', 'aurora'];
const THEME_LABEL = { dark: '深色', light: '浅色', aurora: '极光' };
const THEME_META_COLOR = { dark: '#0a0916', light: '#eef0f8', aurora: '#05070f' };
const DEFAULT_THEME = IS_ANDROID ? 'dark' : 'aurora';

export function currentTheme() {
  const t = localStorage.getItem('wuhou.theme');
  // 安卓端不认极光：之前在其它端选过极光时，回落深色，避免闪烁
  if (IS_ANDROID && t === 'aurora') return DEFAULT_THEME;
  if (!t) return DEFAULT_THEME;
  return THEMES.includes(t) ? t : DEFAULT_THEME;
}

export function setTheme(t) {
  // 安卓端把任何极光请求都强制回落为深色
  const safe = (IS_ANDROID && t === 'aurora') ? DEFAULT_THEME : t;
  const name = THEMES.includes(safe) ? safe : DEFAULT_THEME;
  document.documentElement.dataset.theme = name;
  localStorage.setItem('wuhou.theme', name);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_META_COLOR[name] || THEME_META_COLOR.dark;
  document.dispatchEvent(new CustomEvent('wuhou:theme', { detail: name }));
}

function applyTheme() {
  setTheme(currentTheme());
  const btn = $('#themeBtn');
  const sync = () => {
    const cur = currentTheme();
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    if (btn) {
      btn.title = `当前：${THEME_LABEL[cur]} · 点击切换为${THEME_LABEL[next]}`;
      const tip = btn.querySelector('.rail__tip');
      if (tip) tip.textContent = THEME_LABEL[cur];
    }
  };
  const cycle = () => {
    const cur = currentTheme();
    setTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
    sync();
  };
  if (btn) btn.addEventListener('click', cycle);
  document.addEventListener('wuhou:theme', sync);
  // 移动端没有 rail 上的主题按钮，从「更多」抽屉里切
  document.addEventListener('wuhou:theme-toggle', cycle);
  sync();
}

function renderCopyright() {
  api.get('/api/meta').then((m) => {
    $('#copyright').textContent = `${m.copyright} · 加密传输与存储 · 请勿用于违法用途`;
  }).catch(() => {
    $('#copyright').textContent = 'Copyright © 2026 左熙宇 · 武侯Chat · 保留所有权利';
  });
}

/* ---------------- 形态与外壳 ---------------- */
let shell = null;      // 'desktop' | 'mobile'

function mountShell(ff) {
  if (ff === shell) return;
  if (shell === 'desktop') desktop.detach();
  if (shell === 'mobile') mobile.unmount();
  shell = ff;
  if (ff === 'desktop') {
    desktop.attach();
    desktop.buildRail();
    wireDesktopChrome();
  } else {
    // 移动端整套界面由 shell-mobile 自建，与 #app 那套三栏 DOM 毫无关系
    const app = $('#app'); if (app) app.hidden = true;
    mobile.mount(document.body);
  }
}

/** 切换形态时保留当前所在的栏目，尽量不让用户"丢了位置" */
function swapShell(ff) {
  const here = shell === 'desktop' ? desktop.navKey() : mobile.currentKey();
  mountShell(ff);
  navigate(here || 'chat');
}

/* ---------------- 电脑端专属顶栏 / 搜索框 ---------------- */
let chromeWired = false;
function wireDesktopChrome() {
  const input = $('#globalSearch');
  if (input && !chromeWired) {
    chromeWired = true;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { navigate('search'); setTimeout(() => search.renderStage(input.value), 30); }
    });
    input.addEventListener('input', debounce(() => {
      if (input.value.trim().length >= 1 && desktop.navKey() !== 'search') navigate('search');
      if (desktop.navKey() === 'search') search.renderStage(input.value);
    }, 420));
  }
  const btnNew = $('#btnNew');
  if (btnNew && !btnNew.dataset.wired) {
    btnNew.dataset.wired = '1';
    btnNew.addEventListener('click', () => openNewSheet());
  }
}

/* ---------------- 全局键盘快捷键（桌面端） ----------------
   Ctrl/Cmd+K 或 / → 聚焦全局搜索；Esc → 关闭右键菜单/弹层/抽屉 */
function wireGlobalKeys() {
  document.addEventListener('keydown', (e) => {
    // 输入框 / 文本域内不劫持快捷键（除了 Esc 关闭由各自组件处理）
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;

    // Ctrl/Cmd+K 或 独立按 / → 聚焦全局搜索（桌面端）
    if (!typing && (e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const input = $('#globalSearch');
      if (input && !isMobile()) { input.focus(); input.select(); }
      return;
    }
    if (!typing && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const input = $('#globalSearch');
      if (input && !isMobile()) { e.preventDefault(); input.focus(); input.select(); }
      return;
    }

    // Esc：关闭右键菜单（ui.js 的 modal 已各自处理 Escape）
    if (e.key === 'Escape' && !typing) {
      document.querySelectorAll('.ctx').forEach((n) => n.remove());
      if (isMobile()) mobile.closeDrawer();
    }
  });
}

/** 「＋ / ⋯」发起面板：两套形态共用同一张底部（或居中）动作单 */
async function openNewSheet() {
  const v = await sheet([
    { icon: 'userPlus', label: '添加好友', value: 'friend' },
    { icon: 'users', label: '创建群聊', value: 'group' },
    { icon: 'globe', label: '加入群聊', value: 'join' },
    { icon: 'chat', label: '进入公共聊天室', value: 'room' },
  ], '发起');
  if (v === 'friend') openAddFriend();
  else if (v === 'group') contacts.openCreateGroup();
  else if (v === 'join') openJoinGroup();
  else if (v === 'room') openConv('room:main');
}

/** 移动端「更多」抽屉：低频入口集中在这里，不占底部标签栏 */
function openMobileMore() {
  mobile.openDrawer([
    { icon: 'globe', label: '动态广场', onClick: () => navigate('msquare') },
    { icon: 'bell', label: '站点公告', onClick: () => navigate('notice') },
    { icon: 'heart', label: '捐赠本站', onClick: () => navigate('donate') },
    { icon: 'contrast', label: '切换主题', onClick: () => document.dispatchEvent(new CustomEvent('wuhou:theme-toggle')) },
    { icon: 'monitor', label: '切换到电脑版界面', onClick: () => { setFormFactor('desktop'); toast('已切换到电脑版界面', 'ok'); } },
  ]);
}

/* ---------------- 导航：两套形态，两套语言 ---------------- */
function navigate(key) {
  if (key === 'admin') { location.href = '/app/admin'; return; }
  if (isMobile()) mobileNavigate(key);
  else desktop.navigate(key);
}

function mobileNavigate(key) {
  if (key === 'chat') {
    mobile.setRoot({ key: 'chat', title: '消息', side: (h) => chat.renderConvList(h), actions: [
      { icon: 'search', label: '搜索', onClick: () => navigate('search') },
      { icon: 'plus', label: '发起', onClick: () => openNewSheet() },
      { icon: 'more', label: '更多', onClick: openMobileMore },
    ] });
  } else if (key === 'contacts') {
    mobile.setRoot({ key: 'contacts', title: '通讯录', side: (h) => contacts.renderSide(h), stage: () => contacts.renderStage(), actions: [
      { icon: 'plus', label: '发起', onClick: () => openNewSheet() },
      { icon: 'more', label: '更多', onClick: openMobileMore },
    ] });
  } else if (key === 'moments') {
    mobile.setRoot({ key: 'moments', title: '动态', side: (h) => moments.renderSide(h), stage: () => moments.renderStage(), actions: [
      { icon: 'plus', label: '发布动态', onClick: () => moments.openPublish() },
      { icon: 'more', label: '更多', onClick: openMobileMore },
    ] });
  } else if (key === 'msquare') {
    mobile.setRoot({ key: 'msquare', title: '动态广场', side: (h) => moments.renderSide(h, 'square'), stage: () => moments.renderSquare(), actions: [
      { icon: 'plus', label: '发布动态', onClick: () => moments.openPublish('square') },
      { icon: 'more', label: '更多', onClick: openMobileMore },
    ] });
  } else if (key === 'settings') {
    mobile.setRoot({ key: 'settings', title: '我的', side: (h) => settings.renderSide(h), stage: () => settings.renderStage('profile'), actions: [
      { icon: 'more', label: '更多', onClick: openMobileMore },
    ] });
  } else if (key === 'search') {
    mobile.push({ key: 'search', title: '全局搜索', stage: () => search.renderStage('') });
  } else if (key === 'notice') {
    mobile.push({ key: 'notice', title: '站点公告', stage: () => notice.renderStage('notice') });
  } else if (key === 'donate') {
    mobile.push({ key: 'donate', title: '捐赠本站', stage: () => notice.renderStage('donate') });
  } else {
    mobile.setRoot({ key: 'chat', title: '消息', side: (h) => chat.renderConvList(h), actions: [] });
  }
  mobile.refreshBadgesFromState();
}

/** 打开会话：电脑端换右栏，移动端推一页（列表仍是栈底那页） */
function openConv(conv) {
  state.activeConv = conv;
  if (!isMobile()) { desktop.openConv(conv); return; }
  const name = convName(conv);
  mobile.push({ key: 'conv', title: name, stage: () => chat.openConv(conv) });
}

function convName(conv) {
  if (conv === 'room:main') return roomName();
  if (conv.startsWith('g:')) {
    const g = (state.groups || []).find((x) => x.id === conv.slice(2));
    return (g && (g.remark || g.name)) || '群聊';
  }
  const uid = conv.replace('p:', '').split(':').find((u) => u !== state.me?.id);
  const f = (state.friends || []).find((x) => x.id === uid);
  return (f && (f.remark || f.nickname)) || '聊天';
}

/* ---------------- 进入主应用 ---------------- */
async function enterApp(fresh = true) {
  hideAuth();

  // 个人资料是必需的；其余列表允许单项失败，避免某个接口异常把整个启动打挂
  const soft = (p, label) => p.catch((e) => { console.warn(`[武侯Chat] ${label} 加载失败`, e); return null; });
  try {
    await loadMe();
  } catch (e) {
    toast('登录状态已失效，请重新登录', 'err');
    tokenStore.clear();
    showAuth();
    return;
  }
  mountShell(formFactor());

  await Promise.all([
    soft(loadConvs(), '会话列表'),
    soft(loadFriends(), '好友列表'),
    soft(loadGroups(), '群聊列表'),
    soft(loadFriendRequests(), '好友申请'),
    soft(loadTags(), '好友分组'),
  ]);
  state.convs = state.convs || [];
  state.friends = state.friends || [];
  state.groups = state.groups || [];
  state.tags = state.tags || [];
  state.requests.friend = state.requests.friend || [];

  try { await connect(); } catch (e) { console.warn('[武侯Chat] 实时通道连接失败', e); }
  startKeySync();
  wireRealtime();

  if (!state.convs.some((c) => c.conv === 'room:main')) {
    await api.post('/api/chat/read', { conv: 'room:main' }).catch(() => {});
    await soft(loadConvs(), '会话列表');
    state.convs = state.convs || [];
  }
  C.prunePlain();

  if (fresh) {
    const r = await api.get('/api/meta');
    toast(`欢迎回来，${state.me.nickname}`, 'ok');
    setTimeout(() => toast(`存储：${r.storage === 'redis' ? 'Redis' : '进程内'} · 已建立统一密钥加密通道`, 'info', 3200), 1200);
  }
  navigate('chat');
}

/* ---------------- 实时事件 ---------------- */
function wireRealtime() {
  on('ws:message', (d) => {
    chat.handleIncoming(d);
    if (d && d.type === 'system') notice.invalidateNotice();
    refreshLists();
  });
  on('ws:recall', (d) => { chat.handleRecall(d); refreshLists(); });
  on('ws:message_react', (d) => chat.handleReact(d));
  on('ws:presence', (d) => {
    state.online[d.uid] = d.online;
    chat.invalidateUser(d.uid);
    refreshLists();
  });
  on('ws:friend_request', () => {
    toast('收到新的好友申请', 'info');
    loadFriendRequests().then(() => { refreshLists(); refreshCurrent(); });
  });
  on('ws:friend_result', (d) => {
    toast(d.accept ? '对方接受了你的好友申请' : '对方拒绝了你的好友申请', d.accept ? 'ok' : 'warn');
    refreshAll();
  });
  on('ws:friend_removed', () => refreshAll());
  on('ws:group_added', () => { toast('你被邀请加入了新群聊', 'info'); refreshAll(); });
  on('ws:group_member_added', () => refreshAll());
  on('ws:group_member_removed', () => refreshAll());
  on('ws:group_kicked', (d) => { toast(`你已被移出群聊「${d.name}」`, 'warn'); refreshAll(); });
  on('ws:group_dissolved', (d) => { toast(`群聊「${d.name}」已解散`, 'warn'); refreshAll(); });
  on('ws:group_updated', () => refreshAll());
  on('ws:group_role', (d) => {
    refreshAll();
    if (d && d.role === 'admin') toast('你已成为该群管理员', 'ok');
    else if (d && d.role === 'owner') toast('群主已转让给你', 'ok');
    else toast('你的管理员身份已被撤销', 'info');
  });
  on('ws:group_announce', (d) => { chat.handleGroupAnnounce(d); refreshLists(); });
  on('ws:group_join_request', () => { toast('有新的入群申请待处理', 'info'); refreshAll(); });
  on('ws:group_muted', (d) => { if (d.muted) toast('你已被群主禁言', 'warn'); });
  // 群 / 房间密钥由持钥成员用我的 RSA 公钥包裹后经服务端中转，这里解开并落本机
  on('ws:group_key', async (d) => {
    try {
      await C.saveGroupKey(`g:${d.gid}`, await C.unwrapGroupKey(d.wrapped), d.ver || 1);
      if (state.activeConv === `g:${d.gid}`) chat.openConv(state.activeConv);
    } catch { /* 未升级身份 / 解不开 → 忽略，继续用旧密钥 */ }
  });
  on('ws:room_key', async (d) => {
    try { await C.saveGroupKey('room:main', await C.unwrapGroupKey(d.wrapped), 1); } catch { /* ignore */ }
  });
  on('ws:moment_new', () => toast('好友发布了新动态', 'info'));
  // 点赞 / 评论都会实时落到动态列表上；作者侧额外提示「谁赞了」，并指引去查看名单
  on('ws:moment_like', (d) => {
    const who = (d && d.user && (d.user.nickname || d.user.username)) || '有人';
    if (!d || d.liked !== false) {
      toast(`${who} 赞了你的动态`, 'ok');
      try { window.dispatchEvent(new CustomEvent('wuhou:reward', { detail: { title: '收到一个赞', sub: who } })); } catch {}
    }
    refreshCurrent('moments');
  });
  on('ws:moment_comment', () => refreshCurrent('moments'));
  on('ws:moment_forward', () => refreshCurrent('moments'));
  // 关注 / 给用户点赞：都是广场关系，收到时给个明确回执
  on('ws:moment_follow', (d) => {
    const who = (d && d.user && (d.user.nickname || d.user.username)) || '有人';
    toast(`${who} 关注了你`, 'ok');
  });
  on('ws:call', (d) => handleCallEvent(d));
  on('ws:typing', (d) => {
    if (d.conv !== state.activeConv) return;
    toast('对方正在输入…', 'info', 900);
  });

  on('ui:nav', (k) => navigate(k));
  on('ui:refresh', () => refreshAll());
  on('ui:refreshConvList', () => refreshLists());
  on('ui:openConv', (conv) => openConv(conv));
  on('ui:report', async ([type, id]) => openReport(type, id));
  on('ui:groupCard', (gid) => openGroupCard(gid));
  on('ui:userCard', (uid) => openUserCard(uid));
  // 用户资料卡 → 「查看动态」：一次性视图，移动端推一页，电脑端单独渲染
  on('ui:userMoments', async (d) => {
    const uid = typeof d === 'string' ? d : (d && d.uid);
    const name = (d && d.name) || '';
    if (!uid) return;
    if (isMobile()) mobile.push({ key: 'userMoments', title: name || 'TA 的动态', stage: () => moments.renderUserMoments(uid, name) });
    else desktop.openUserMoments(uid, name);
  });
  on('ui:poke', (uid) => {
    const conv = `p:${[state.me.id, uid].sort().join(':')}`;
    openConv(conv);
    setTimeout(() => chat.sendPoke(), 260);
  });
  on('ui:convChanged', () => { if (desktop.navKey() === 'chat') chat.renderConvList($('#sideBody')); });
}

/* ---------------- 刷新 ---------------- */
async function refreshLists() {
  await loadConvs();
  if (isMobile()) {
    mobile.refreshBadgesFromState();
    if (mobile.currentKey() === 'chat') chat.renderConvList($('#sideBody'));
  } else {
    desktop.refreshLists();
  }
}

async function refreshAll() {
  await Promise.all([loadMe(), loadConvs(), loadFriends(), loadGroups(), loadFriendRequests(), loadTags()]);
  if (isMobile()) {
    mobile.refreshBadgesFromState();
    const k = mobile.currentKey();
    if (k === 'chat') chat.renderConvList($('#sideBody'));
    else mobile.refresh();
  } else {
    desktop.refreshAll();
  }
}

/** 只在停在某个栏目时重跑它的渲染（收到点赞 / 评论等轻量事件时用） */
function refreshCurrent(key) {
  const cur = isMobile() ? mobile.currentKey() : desktop.navKey();
  if (key && cur !== key) return;
  if (isMobile()) { if (!key || cur === key) mobile.refresh(); }
  else desktop.refreshAll();
}

/* ---------------- 小工具 ---------------- */
window.__lightbox = (src) => import('./ui.js').then((m) => m.lightbox(src));
window.addEventListener('beforeunload', () => { try { C.prunePlain(); } catch { /* ignore */ } });
window.addEventListener('online', () => toast('网络已恢复', 'ok'));
window.addEventListener('offline', () => toast('网络已断开', 'warn'));
// 移动端：浏览器/系统返回键优先退出弹层，其次退出页面栈
addEventListener('popstate', () => { if (isMobile()) { mobile.closeDrawer(); mobile.pop(); } });

boot();
