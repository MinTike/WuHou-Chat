/* ============================================================
   通讯录：好友 / 群聊 / 黑名单
   好友申请收进侧栏触发的「好友申请列表卡」，主区只放好友与群聊。
   ============================================================ */
import { el, avatar, collectForm, nameNode } from './util.js';
import { api } from './api.js';
import { toast, confirm, modal } from './ui.js';
import { state, loadFriends, loadGroups, loadConvs, loadTags, emit } from './state.js';
import { openUserCard, openGroupCard, openAddFriend, openJoinGroup, openInviteMembers, openFriendRequests, openGroupRequests } from './cards.js';
import { icon, icoHtml } from './icons.js';
import { buildFilterBar, friendChips, openTagManager, openTagPicker, tagMap } from './tags.js';

/** 通讯录的分组筛选：''=全部 / tagId=某个分组 / '__none__'=未分组。
 *  这是主区好友列表的筛选条件，不是第二列联系人，重渲染时会保留。*/
let _tagFilter = '';

/**
 * 侧栏只做「导航 + 快捷操作」，好友/群聊列表统一放在主区（renderStage），避免双列重复。
 */
let _sideGen = 0;   // 侧栏并发渲染保护：异步补齐的申请数只写进最新一次渲染

export function renderSide(host) {
  const gen = ++_sideGen;
  host.innerHTML = '';
  const reqs = state.requests.friend.length;

  host.appendChild(el('div', { class: 'side__group-title' }, [el('span', { text: '新的朋友' })]));
  // 好友申请不再在主区占一整块，点击直接弹出「好友申请列表卡」
  host.appendChild(el('div', { class: 'contact-item', onClick: () => openFriendRequests() }, [
    el('div', { class: 'avatar', style: { background: 'linear-gradient(135deg,#ff8a5c,#ff5d7d)' }, html: icon('userPlus', 22) }),
    el('div', { class: 'grow' }, [el('div', { class: 'contact-item__name', text: '好友申请' }),
      el('div', { class: 'contact-item__sub', text: reqs ? `${reqs} 条待处理` : '暂无新申请' })]),
    reqs ? el('span', { class: 'badge', text: String(reqs) }) : null,
  ]));

  // 侧栏不放「添加好友 / 建群」按钮：入口统一在顶栏「＋」与列表空状态里

  const jump = (iconName, title, sub, onClick) => el('div', { class: 'contact-item', onClick }, [
    el('div', { class: 'avatar avatar--sm', style: { background: 'var(--glass-2)', display: 'grid', placeItems: 'center', color: 'var(--muted)' }, html: icon(iconName, 18) }),
    el('div', { class: 'grow' }, [
      el('div', { class: 'contact-item__name', text: title }),
      el('div', { class: 'contact-item__sub ellipsis', text: sub }),
    ]),
  ]);
  // 快捷入口用于「快速定位列表项」：列表较短时无需定位，直接省掉这一块
  if (state.friends.length + state.groups.length >= 10) {
    host.appendChild(el('div', { class: 'side__group-title' }, [el('span', { text: '快捷定位' })]));
    host.appendChild(jump('users', `好友 · ${state.friends.length}`, '滚动到好友列表', () => { renderStage(); scrollToSection('sec-friends'); }));
    host.appendChild(jump('layers', `我的群聊 · ${state.groups.length}`, '滚动到群聊列表', () => { renderStage(); scrollToSection('sec-groups'); }));
  }
  /* 我管理的群聊：每个群一条，点进去处理入群申请（同意 / 拒绝） */
  const mine = (state.groups || []).filter((g) => g.is_owner);
  host.appendChild(el('div', { class: 'side__group-title' }, [el('span', { text: '我管理的群聊' })]));
  if (!mine.length) {
    host.appendChild(el('div', { class: 'muted', style: { padding: '4px 12px 8px', fontSize: '12px' },
      text: '你还没有管理的群聊' }));
  } else {
    const badges = [];
    mine.forEach((g) => {
      const badge = el('span', { class: 'badge' });
      badge.hidden = true;
      badges.push({ gid: g.id, badge });
      host.appendChild(el('div', { class: 'contact-item', title: '处理入群申请', onClick: () => openGroupRequests(g.id) }, [
        el('div', { class: 'avatar avatar--sm', text: (g.remark || g.name || '群').slice(0, 1) }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'contact-item__name ellipsis', text: g.remark || g.name }),
          el('div', { class: 'contact-item__sub', text: '入群申请' }),
        ]),
        badge,
      ]));
    });
    // 申请数要现拉：侧栏先渲染出来，拿到数字后再补角标
    (async () => {
      for (const b of badges) {
        try {
          const rs = (await api.get(`/api/groups/${b.gid}/requests`)).requests || [];
          if (gen !== _sideGen) return;
          if (rs.length) { b.badge.textContent = String(rs.length); b.badge.hidden = false; }
        } catch { /* 忽略单个群失败 */ }
      }
    })();
  }

  host.appendChild(el('div', { class: 'side__group-title' }, [el('span', { text: '其他' })]));
  host.appendChild(jump('gift', '生日提醒', '谁快过生日了', () => { renderStage(); scrollToSection('sec-birthday'); }));
  host.appendChild(jump('shield', '黑名单管理', '管理已拉黑的用户', () => openBlacklist()));
}

/** 主区滚动到指定分块（renderStage 为异步，这里做几帧重试） */
function scrollToSection(id) {
  let tries = 0;
  const run = () => {
    const node = document.getElementById(id);
    const box = document.querySelector('.contacts-body');
    const top = node && box ? node.offsetTop - 8 : null;
    if (top !== null && top !== undefined) { box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }); return; }
    if (++tries < 12) requestAnimationFrame(() => setTimeout(run, 60));
  };
  requestAnimationFrame(run);
}

let _stageGen = 0;   // 并发渲染保护：ui:refresh 与 ui:nav 同时触发时只保留最后一次

/* ---------------- 生日提醒 ----------------
   生日散落在每个人的资料里，单看没意义；这里把它聚成一条按临近程度排的时间线。
   「今天」单独一行高亮，7 天内紧接着，更远的收在展开按钮后面。 */

function birthdayGap(r) {
  if (r.today) return '今天生日';
  if (r.days === 1) return '明天生日';
  if (r.days === 2) return '后天生日';
  return `${r.days} 天后`;
}

function buildBirthdayCard(data) {
  const today = data.today || [];
  const week = data.week || [];
  const later = data.later || [];
  const rows = [...today, ...week, ...later];
  const shown0 = today.length + week.length;

  const sec = el('div', { class: 'contact-section', id: 'sec-birthday' });
  const sub = today.length ? `今天有 ${today.length} 位好友过生日`
    : (week.length ? `${week.length} 位好友将在 7 天内过生日`
      : (later.length ? `${later.length} 位好友将在 60 天内过生日` : '近期没有临近的生日'));
  sec.appendChild(el('div', { class: 'side__group-title', style: { padding: '0 0 10px' } }, [
    el('span', { class: 'bd-title', html: icoHtml('cake', 15) }),
    el('span', { text: '生日提醒' }),
    el('span', { class: 'side__group-sub ellipsis', text: sub }),
  ]));

  const grid = el('div', { class: 'contact-grid' });
  const row = (r) => el('div', {
    class: 'result-card bd-row' + (r.today ? ' is-today' : ''),
    title: '点击查看资料', onClick: () => openUserCard(r.id),
  }, [
    avatar(r, '', { status: true }),
    el('div', { class: 'grow' }, [
      el('div', { class: 'list-item__title' }, [
        nameNode(r, { single: false }),
        r.today ? el('span', { class: 'tag tag--accent', text: '🎂 今天' }) : null,
      ]),
      el('div', { class: 'result-card__snippet ellipsis',
        text: `${birthdayGap(r)} · ${r.md}${r.turning ? ` · 满 ${r.turning} 岁` : ''}` }),
    ]),
    el('button', {
      class: 'btn btn--sm btn--ghost', type: 'button', text: '🎁 送祝福',
      onClick: (e) => { e.stopPropagation(); emit('ui:openConv', privateConv(r.id)); },
    }),
    el('span', { class: 'result-card__go', html: icon('chevronRight', 16) }),
  ]);

  const paint = (upto) => {
    grid.innerHTML = '';
    rows.slice(0, upto).forEach((r) => grid.appendChild(row(r)));
    const rest = rows.length - upto;
    if (rest > 0) {
      grid.appendChild(el('button', { class: 'bd-more', type: 'button',
        text: `展开更远的 ${rest} 位`, onClick: () => paint(rows.length) }));
    } else if (rows.length > shown0) {
      grid.appendChild(el('button', { class: 'bd-more', type: 'button',
        text: '收起', onClick: () => paint(shown0) }));
    }
  };
  paint(shown0 || Math.min(rows.length, 3));

  if (!rows.length) {
    const hint = el('div', { class: 'empty-mini' }, [
      el('div', { class: 'muted', text: data.unknown
        ? `${data.unknown} 位好友还没有填写生日，所以这里空着`
        : '近期没有好友过生日' }),
      data.me ? null : el('button', { class: 'btn btn--sm btn--ghost', text: '填写我的生日',
        onClick: () => emit('ui:nav', 'settings') }),
    ]);
    sec.appendChild(hint);
  }
  sec.appendChild(grid);
  if (data.me && data.me.days === 0) {
    sec.appendChild(el('div', { class: 'bd-note', text: '🎂 今天也是你的生日，祝你生日快乐！' }));
  }
  return sec;
}

/** 通讯录点击好友/群聊 → 直接进入聊天（而不是弹出资料卡） */
function openChat(conv) { emit('ui:openConv', conv); }
const privateConv = (uid) => `p:${[state.me.id, uid].sort().join(':')}`;

export async function renderStage() {
  const gen = ++_stageGen;
  const stage = document.querySelector('#stage');
  stage.innerHTML = '';

  const body = el('div', { class: 'view__body contacts-body' });

  /* 入群申请移到侧栏「我管理的群聊」里，主区不再重复一整块 */

  /* 我收到的入群邀请（需要我同意的） */
  try {
    const inv = (await api.get('/api/groups/invites')).invites || [];
    if (gen !== _stageGen) return;
    if (inv.length) {
      const card = el('div', { class: 'contact-section', id: 'sec-invites' });
      card.appendChild(el('div', { class: 'side__group-title', style: { padding: '0 0 10px' } }, [
        el('span', { text: `入群邀请 · ${inv.length}` })]));
      inv.forEach((it) => {
        card.appendChild(el('div', { class: 'device-card' }, [
          avatar({ avatar: (it.group || {}).avatar, nickname: (it.group || {}).name || '群' }, 'sm', { status: false }),
          el('div', { class: 'grow' }, [
            el('div', { class: 'setting-row__label ellipsis', text: (it.group || {}).remark || (it.group || {}).name || '群聊' }),
            el('div', { class: 'setting-row__desc ellipsis', text: `${(it.by || {}).nickname || '好友'} 邀请你加入` }),
          ]),
          el('button', { class: 'btn btn--sm btn--primary', text: '同意', onClick: async () => {
            await api.post('/api/groups/invites/handle', { iid: it.iid, accept: true });
            toast('已同意，等待群主确认' , 'ok');
            await loadGroups(); await loadConvs(); renderStage(); emit('ui:refresh');
          } }),
          el('button', { class: 'btn btn--sm btn--ghost', text: '拒绝', onClick: async () => {
            await api.post('/api/groups/invites/handle', { iid: it.iid, accept: false });
            toast('已拒绝邀请', 'info'); renderStage();
          } }),
        ]));
      });
      body.appendChild(card);
    }
  } catch { /* 邀请接口不可用时忽略 */ }

  /* 生日提醒：把散落在各人资料里的生日聚成一条时间线（失败时整块不显示，不影响主列表） */
  try {
    const bd = await api.get('/api/users/birthdays?days=60');
    if (gen !== _stageGen) return;
    body.appendChild(buildBirthdayCard(bd));
  } catch { /* 生日接口不可用时忽略 */ }

  /* 好友列表（备注优先显示） */
  const friendsAll = state.friends || [];
  const matches = (f) => {
    if (!_tagFilter) return true;
    const ids = f.tags || [];
    return _tagFilter === '__none__' ? !ids.length : ids.includes(_tagFilter);
  };
  const friends = friendsAll.filter(matches);
  const grid = el('div', { class: 'contact-grid' });
  const map = tagMap();
  friends.forEach((f) => {
    grid.appendChild(el('div', { class: 'result-card', title: '点击进入聊天', onClick: () => openChat(privateConv(f.id)) }, [
      avatar(f, '', { status: true }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'list-item__title' }, [
          nameNode(f, { single: false }),
          f.remark ? el('span', { class: 'tag', text: f.nickname, title: '原昵称' }) : null,
          f.online ? el('i', { class: 'dot-online is-online' }) : null,
        ]),
        el('div', { class: 'result-card__snippet ellipsis', text: f.signature || `@${f.username}` }),
        friendChips(f, { map }),
      ]),
      el('span', { class: 'result-card__go', html: icon('chevronRight', 16) }),
    ]));
  });
  if (!friends.length) {
    grid.appendChild(el('div', { class: 'empty-mini' }, [
      el('div', { class: 'muted', text: friendsAll.length
        ? (_tagFilter === '__none__' ? '没有未分组的好友' : '这个分组里还没有好友')
        : '还没有好友，从添加第一位好友开始' }),
      friendsAll.length
        ? el('button', { class: 'btn btn--sm btn--ghost', text: '查看全部好友', onClick: () => { _tagFilter = ''; renderStage(); } })
        : el('button', { class: 'btn btn--sm btn--primary', text: '＋ 添加好友', onClick: () => openAddFriend() }),
    ]));
  }
  const filterBar = el('div', { class: 'contact-section' }, [
    buildFilterBar(_tagFilter, async (id) => { _tagFilter = id; await loadTags(); await loadFriends(); renderStage(); }),
  ]);
  body.appendChild(el('div', { class: 'contact-section', id: 'sec-friends' }, [
    el('div', { class: 'side__group-title', style: { padding: '0 0 10px' } }, [
      el('span', { text: `好友 · ${friendsAll.length}` }),
    ]),
    filterBar, grid,
  ]));

  /* 群聊（备注优先显示） */
  const ggrid = el('div', { class: 'contact-grid' });
  state.groups.forEach((g) => {
    ggrid.appendChild(el('div', { class: 'result-card', title: '点击进入群聊', onClick: () => openChat('g:' + g.id) }, [
      avatar({ avatar: g.avatar, nickname: g.name || '群' }, '', { status: false }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'list-item__title' }, [
          el('span', { class: 'ellipsis', text: g.remark || g.name }),
          g.is_owner ? el('span', { class: 'tag tag--accent', text: '群主' }) : null,
        ]),
        el('div', { class: 'result-card__snippet ellipsis', text: `${g.member_count} 人 · ${g.intro || '无介绍'}` }),
      ]),
      el('span', { class: 'result-card__go', html: icon('chevronRight', 16) }),
    ]));
  });
  if (!state.groups.length) {
    ggrid.appendChild(el('div', { class: 'empty-mini' }, [
      el('div', { class: 'muted', text: '还没有群聊，创建一个或申请加入' }),
      el('div', { class: 'empty-mini__row' }, [
        el('button', { class: 'btn btn--sm btn--primary', text: '创建群聊', onClick: () => openCreateGroup() }),
        el('button', { class: 'btn btn--sm btn--ghost', text: '申请加群', onClick: () => openJoinGroup() }),
      ]),
    ]));
  }
  body.appendChild(el('div', { class: 'contact-section', id: 'sec-groups' }, [
    el('div', { class: 'side__group-title', style: { padding: '0 0 10px' } }, [
      el('span', { text: `我的群聊 · ${state.groups.length}` }),
    ]), ggrid]));

  const view = el('div', { class: 'view' }, [
    el('div', { class: 'view__head' }, [
      el('div', { class: 'view__title', text: '通讯录' }),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn btn--sm btn--ghost', text: '黑名单管理', onClick: () => openBlacklist() }),
    ]),
    body,
  ]);
  stage.appendChild(view);
}

/* ---------------- 建群 ---------------- */
export function openCreateGroup() {
  const body = el('div', { class: 'form' });
  const selected = new Set();
  const listEl = el('div', { style: { maxHeight: '220px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' } });
  state.friends.forEach((f) => {
    const row = el('div', { class: 'contact-item', onClick: () => {
      if (selected.has(f.id)) selected.delete(f.id); else selected.add(f.id);
      row.style.background = selected.has(f.id) ? 'var(--accent-soft)' : '';
    } }, [
      avatar(f, 'sm', { status: true }),
      el('div', { class: 'grow' }, [el('div', { class: 'contact-item__name' }, [nameNode(f)])]),
      el('span', { class: 'tag', text: '选择' }),
    ]);
    listEl.appendChild(row);
  });
  if (!state.friends.length) listEl.appendChild(el('div', { class: 'muted', style: { padding: '8px' }, text: '先添加好友后再建群' }));

  body.append(
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '群名称' }), el('input', { class: 'input', name: 'name', placeholder: '例如：武侯夜话' })]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '群介绍（选填）' }), el('input', { class: 'input', name: 'intro' })]),
    el('div', { class: 'grid-2' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '入群方式' }), el('select', { class: 'input', name: 'join_mode' },
        [['approval', '需要审核'], ['free', '自由加入'], ['invite', '仅群主邀请']].map(([v, t]) => el('option', { value: v, text: t })))]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '可发现性' }), el('select', { class: 'input', name: 'discoverable' },
        [['1', '允许被搜索'], ['0', '不公开']].map(([v, t]) => el('option', { value: v, text: t })))]),
    ]),
    el('div', { class: 'field' }, [el('span', { class: 'field__label', text: '选择初始成员' }), listEl]),
  );

  modal({
    title: '创建群聊', body,
    footer: [{
      text: '创建', kind: 'primary', onClick: async () => {
        const fd = collectForm(body);
        const name = String(fd.name || '').trim();
        if (!name) { toast('请填写群名称', 'err'); return false; }
        const r = await api.post('/api/groups', {
          name, intro: String(fd.intro || ''),
          join_mode: String(fd.join_mode), discoverable: String(fd.discoverable) === '1',
          members: Array.from(selected),
        });
        const { bootstrapGroupKey } = await import('./state.js');
        await bootstrapGroupKey(r.group.id, r.added || []);
        const added = (r.added || []).length, pend = (r.pending || []).length, ref = (r.refused || []).length;
        toast(
          pend || ref
            ? `群聊已创建：${added} 人已加入，${pend} 人待同意${ref ? `，${ref} 人拒绝被邀请` : ''}`
            : '群聊已创建，密钥已分发', pend || ref ? 'warn' : 'ok');
        await loadGroups(); await loadConvs(); emit('ui:refresh'); emit('ui:nav', 'contacts');
      }
    }, { text: '取消' }],
  });
}

async function openBlacklist() {
  const r = await api.get('/api/users/block/list');
  const list = r.blocked || [];
  const body = el('div');
  if (!list.length) body.appendChild(el('div', { class: 'muted center', style: { padding: '20px' }, text: '黑名单为空' }));
  list.forEach((u) => body.appendChild(el('div', { class: 'device-card' }, [
    avatar(u, 'sm', { status: false }),
    el('div', { class: 'grow' }, [el('div', { class: 'setting-row__label' }, [nameNode(u)]), el('div', { class: 'setting-row__desc', text: '@' + u.username })]),
    el('button', { class: 'btn btn--sm', text: '解除拉黑', onClick: async () => {
      await api.post('/api/users/block', { uid: u.id, block: false });
      toast('已解除', 'ok'); openBlacklist(); await loadFriends(); emit('ui:refresh');
    } }),
  ])));
  modal({ title: '黑名单管理', body, footer: null });
}
