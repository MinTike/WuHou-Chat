/* ============================================================
   电脑端界面系统：三栏布局（rail / side / main）
   Copyright © 2026 左熙宇
   ------------------------------------------------------------
   与移动端是两套彼此独立的实现：这里只服务宽屏，
   导航是「左侧图标栏 + 中间列表 + 右侧内容」的同屏三栏，
   不做任何移动端适配（抽屉 / 底部标签栏一概不出现）。
   业务模块只通过 #sideBody / #stage 两个容器与本系统对接。
   ============================================================ */
import { $, el } from './util.js';
import { icon } from './icons.js';
import { emit, state } from './state.js';
import * as chat from './chat.js?v=20261031';
import * as contacts from './contacts.js';
import * as moments from './moments.js';
import * as search from './search.js';
import * as settings from './settings.js';
import * as notice from './notice.js';

let currentNav = 'chat';
/** 换到移动端时这两个容器的 id 要让出去（避免两套系统同时存在 #stage） */
const IDS = { side: 'sideBody', stage: 'stage' };

export const key = () => currentNav;
export const navKey = () => currentNav;

export function attach() {
  const app = $('#app');
  if (app) app.hidden = false;
  const side = app && app.querySelector('#sideBody, .side__body');
  const stage = app && app.querySelector('#stage, .main__stage');
  if (side) side.id = IDS.side;
  if (stage) stage.id = IDS.stage;
}

export function detach() {
  const app = $('#app');
  if (app) app.hidden = true;
  const side = app && app.querySelector('#sideBody');
  const stage = app && app.querySelector('#stage');
  if (side) side.removeAttribute('id');
  if (stage) stage.removeAttribute('id');
}

/* ---------------- 左侧图标栏 ---------------- */
export function buildRail() {
  const rail = $('#railNav');
  if (!rail) return;
  rail.innerHTML = '';
  [
    { key: 'chat', icon: 'chat', label: '消息' },
    { key: 'contacts', icon: 'users', label: '通讯录' },
    { key: 'moments', icon: 'sparkles', label: '动态' },
    { key: 'msquare', icon: 'globe', label: '动态广场' },
    { key: 'search', icon: 'search', label: '搜索' },
    { key: 'settings', icon: 'settings', label: '设置' },
    { key: 'notice', icon: 'bell', label: '公告栏' },
    { key: 'donate', icon: 'heart', label: '捐赠本站' },
  ].forEach((n) => {
    const btn = el('button', {
      class: 'rail__btn' + (currentNav === n.key ? ' is-active' : ''),
      dataset: { nav: n.key }, title: n.label, html: icon(n.icon, 21),
      onClick: () => navigate(n.key),
    });
    btn.appendChild(el('span', { class: 'rail__tip', text: n.label }));
    rail.appendChild(btn);
  });
  updateBadges();
}

export function updateBadges() {
  const req = (state.requests.friend || []).length;
  const unread = (state.convs || []).reduce((s, c) => s + (c.unread || 0), 0);
  document.querySelectorAll('.rail__btn').forEach((b) => {
    const old = b.querySelector('.dot'); if (old) old.remove();
    const k = b.dataset.nav;
    if ((k === 'contacts' && req) || (k === 'chat' && unread)) {
      b.appendChild(el('i', { class: 'dot' }));
    }
  });
}

export function syncActive() {
  document.querySelectorAll('.rail__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === currentNav));
}

/* ---------------- 导航：同屏三栏，列表与内容一起换 ---------------- */
export function navigate(key) {
  if (key === 'admin') { location.href = '/app/admin'; return; }
  currentNav = key;
  syncActive();
  const body = $('#sideBody'), stage = $('#stage');
  if (body) body.innerHTML = '';
  if (stage) stage.innerHTML = '';

  if (key === 'chat') { chat.renderConvList(body); renderChatStage(); }
  else if (key === 'contacts') { contacts.renderSide(body); contacts.renderStage(); }
  else if (key === 'moments') { moments.renderSide(body); moments.renderStage(); }
  else if (key === 'msquare') { moments.renderSide(body, 'square'); moments.renderSquare(); }
  else if (key === 'search') { search.renderSide(body); search.renderStage($('#globalSearch')?.value || ''); }
  else if (key === 'settings') { settings.renderSide(body); settings.renderStage('profile'); }
  else if (key === 'notice') { notice.renderStage('notice'); }
  else if (key === 'donate') { notice.renderStage('donate'); }

  updateBadges();
}

export function renderChatStage() {
  const stage = $('#stage');
  if (!stage) return;
  if (!state.activeConv) {
    stage.appendChild(el('div', { class: 'view' }, [
      el('div', { class: 'view__head' }, [
        el('div', { class: 'view__title', text: '消息' }),
        el('div', { class: 'view__sub', text: '端到端加密' }),
      ]),
      el('div', { class: 'empty' }, [
        el('div', { class: 'empty__icon', html: icon('lock', 46, 1.5) }),
        el('div', { class: 'empty__title', text: '武侯Chat' }),
        el('div', { class: 'empty__sub', text: '打开左侧列表选择会话，或点击右上角 ＋ 添加好友 / 创建群聊 / 进入公共聊天室。所有内容均在本地加密后才离开设备。' }),
        el('button', { class: 'btn btn--primary', style: { marginTop: '12px' }, text: '进入公共聊天室', onClick: () => emit('ui:openConv', 'room:main') }),
      ]),
    ]));
    return;
  }
  chat.openConv(state.activeConv);
}

/** 打开会话：电脑端列表常驻在中间栏，只需要换右侧内容 */
export function openConv(conv) {
  state.activeConv = conv;
  if (currentNav === 'chat') chat.openConv(conv); else navigate('chat');
}

export function refreshLists() {
  if (currentNav === 'chat') chat.renderConvList($('#sideBody'));
  updateBadges();
}

export function refreshAll() {
  if (currentNav === 'chat') chat.renderConvList($('#sideBody'));
  if (currentNav === 'contacts') { contacts.renderSide($('#sideBody')); contacts.renderStage(); }
  if (currentNav === 'moments') { moments.renderSide($('#sideBody'), 'friends'); moments.renderStage(); }
  if (currentNav === 'msquare') { moments.renderSide($('#sideBody'), 'square'); moments.renderSquare(); }
  updateBadges();
}

/** 「查看 TA 的动态」：一次性视图，不属于任何导航项 */
export async function openUserMoments(uid, name) {
  currentNav = 'userMoments';
  syncActive();
  const body = $('#sideBody'), stage = $('#stage');
  if (body) body.innerHTML = '';
  if (stage) stage.innerHTML = '';
  moments.renderSide(body);
  await moments.renderUserMoments(uid, name);
}

export function setNav(key) { currentNav = key; syncActive(); }
