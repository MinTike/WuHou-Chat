/* ============================================================
   聊天视图：会话列表 / 消息收发 / 表情 / 文件 / 引用 / 撤回 / 拍一拍
   ============================================================ */
import {
  $, el, avatar, esc, fmtClock, fmtDay, fmtListTime, fmtSize,
  fileIcon, isImage, isVideo, pickFiles, download, nameNode,
} from './util.js';
import { api } from './api.js';
import { toast, modal, confirm, ctxMenu, lightbox } from './ui.js';
import * as C from './crypto.js';
import {
  state, ensureGroupKey, ensureRoomKey, bootstrapRoomKey, bootstrapGroupKey, emit, loadConvs,
  roomName,
} from './state.js';
import { rt } from './realtime.js';
import { openUserCard, openGroupCard, openRoomMembers, openAddFriend } from './cards.js';
import { startCall, incomingCall, endCall } from './call.js';
import { icon, icoHtml } from './icons.js';
import { mediaObjectUrl, renderSharedMoment } from './moments.js';
import { guardText } from './badwords.js';
import { recordVoice } from './voice.js';

const ROOM = 'room:main';
const mediaCache = new Map();      // fileId -> objectURL
const mediaBlobCache = new Map();  // fileId -> Blob（下载/另存直接用，避免 fetch(blob:) 被 CSP 拦）
const inflight = new Map();

let current = {
  conv: null, peer: null, group: null, quote: null, before: 0, hasMore: true, loading: false,
  mentions: [],               // 当前输入框里已选中的 @ 对象 [{id, name}]
};
let scrollEl = null;
// 鼠标是否正压在消息里的可点元素上 / 是否有一次被压住的自动滚动还没做
let hoveringScroll = false;
let pendingScroll = false;

/* ---------------- 会话列表 ---------------- */
export function renderConvList(host) {
  host.innerHTML = '';
  const convs = [...state.convs].sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));

  const section = (title, items, extra) => {
    if (!items.length) return;
    host.appendChild(el('div', { class: 'side__group-title' }, [
      el('span', { text: title }),
      el('span', { class: 'tag', text: String(items.length) }), extra || null,
    ]));
    const box = el('div', { class: 'conv-list' });
    items.forEach((c) => box.appendChild(convRow(c)));
    host.appendChild(box);
  };

  // 按会话性质分组：群聊 / 私聊 / 公共，便于在多会话时快速定位
  section('群聊', convs.filter((c) => c.kind === 'group'));
  section('私聊', convs.filter((c) => c.kind === 'private'));
  const room = convs.find((c) => c.kind === 'room');
  if (room) section('公共', [room], el('span', { class: 'tag tag--accent', text: '全员' }));

  if (!convs.length) {
    host.appendChild(el('div', { class: 'empty', style: { padding: '40px 20px' } }, [
      el('div', { class: 'empty__icon', html: icon('comment', 44, 1.5) }),
      el('div', { class: 'empty__title', text: '还没有会话' }),
      el('div', { class: 'empty__sub', text: '点击右上角 ＋ 添加好友、创建群聊或进入公共聊天室' }),
    ]));
  }
}

function convRow(c) {
  const name = c.title || (c.kind === 'room' ? roomName() : '聊天');
  const isRoom = c.kind === 'room';
  const av = isRoom
    ? avatar({ id: 'system', nickname: roomName(), official: true }, '', { status: false })
    : avatar(c.kind === 'private' ? (c.peer || {}) : { nickname: name, id: c.conv }, '',
      { status: c.kind === 'private', class: '' });
  const hintText = c.kind === 'room' ? '全用户公共聊天室 · 已加密' : (c.hint ? hintOf(c.hint) : '🔒 加密消息');
  return el('div', {
    class: 'conv' + (state.activeConv === c.conv ? ' is-active' : ''),
    // 走事件而不是直接调 openConv：电脑端是「换右栏」，移动端是「推一页」，
    // 只有入口层（app.js）知道当前跑的是哪一套界面系统。
    onClick: () => emit('ui:openConv', c.conv),
    onContextmenu: (e) => {
      e.preventDefault();
      ctxMenu(e.clientX, e.clientY, [
        { icon: 'check', label: '标记为已读', onClick: async () => { await api.post('/api/chat/read', { conv: c.conv }); loadConvs(); } },
        c.kind !== 'room' ? { icon: 'trash', label: '从列表移除', danger: true, onClick: () => toast('会话已隐藏（演示环境）', 'info') } : null,
      ]);
    },
  }, [
    av,
    el('div', { class: 'conv__body' }, [
        el('div', { class: 'conv__top' }, [
          // 私聊会话补性别徽标；群聊与公共房间无此概念
          el('div', { class: 'conv__name' }, [
            c.kind === 'private' ? nameNode(c.peer || {}, { single: false }) : el('span', { text: name }),
          ]),
          el('div', { class: 'conv__time', text: c.last_ts ? fmtListTime(c.last_ts) : '' }),
        ]),
      el('div', { class: 'conv__msg' }, [
        // 「有人@我」/「草稿」排在正文之前：会话列表上只有这两个位置能让人一眼看出
        // 这一条需要我处理，塞到最后会被长正文截断
        c.mentioned ? el('span', { class: 'conv__flag conv__flag--at', text: '[有人@我]' }) : null,
        c.draft ? el('span', { class: 'conv__flag conv__flag--draft', text: '[草稿]' }) : null,
        el('span', { class: 'lock', html: icon('lock', 12, 2.2) }),
        el('span', { class: 'ellipsis', text: hintText }),
      ]),
    ]),
    c.unread ? el('span', { class: 'badge', text: String(c.unread) }) : null,
  ]);
}

function hintOf(h) {
  return ({
    text: '[文本]', file: '[文件]', sticker: '[表情]', poke: '[拍一拍]',
    system: '[系统公告]', call: '[通话]', moment: '[动态]', voice: '[语音]',
  }[h] || '[消息]');
}

/* ---------------- 打开会话 ----------------
   并发保护：转发动态等场景会在极短时间内连开两个会话（导航自动打开上一个会话
   + 业务指定打开目标会话），两次 openConv 交错 await 会把消息塞进错误的滚动区，
   表现为「聊天内容不加载 / 加载成别的会话」。这里用序号让后发起的那个独占。 */
let openSeq = 0;

export async function openConv(conv) {
  if (!conv) return;
  // 切走之前先把上一个会话的草稿落库：这里的 current 还是旧的，
  // 再晚一步（比如等 renderChatView 之后）就会被新会话覆盖掉
  flushDraft();
  const seq = ++openSeq;
  const stale = () => seq !== openSeq;
  state.activeConv = conv;
  current = { conv, peer: null, group: null, quote: null, before: 0, hasMore: true, loading: false, mentions: [] };
  emit('ui:convChanged', conv);

  if (conv.startsWith('p:')) {
    const [, a, b] = conv.split(':');
    const peerId = a === state.me.id ? b : a;
    try {
      const r = await api.get(`/api/users/${peerId}`);
      if (stale()) return;
      current.peer = r.user;
      C.setPubKey(peerId, (r.user || {}).pubkey);   // 预热对端公钥，首次发送不必再取
    } catch { current.peer = null; }
  } else if (conv.startsWith('g:')) {
    try { const r = await api.get(`/api/groups/${conv.slice(2)}`); if (!stale()) current.group = r.group; } catch { current.group = null; }
    // ensureGroupKey 内部会按需：领取服务端包裹 / 首次生成 / 成员被移除后轮换
    await ensureGroupKey(conv.slice(2));
    if (stale()) return;
  } else if (conv === ROOM) {
    await ensureRoomKey();
    if (stale()) return;
  }
  rt.subscribe(conv);
  await api.post('/api/chat/read', { conv }).catch(() => {});
  if (stale()) return;
  loadConvs().then(() => { if (!stale()) emit('ui:refreshConvList'); });
  renderChatView();
  await loadMessages();
}

/* ---------------- 渲染聊天区 ---------------- */
function renderChatView() {
  const stage = $('#stage');
  stage.innerHTML = '';
  const c = current.conv;
  const isRoom = c === ROOM;
  const isGroup = c.startsWith('g:');
  const title = isRoom ? roomName()
    : isGroup ? (current.group ? (current.group.remark || current.group.name) : '群聊')
      : (current.peer ? (current.peer.remark || current.peer.nickname) : '聊天');
  const sub = isRoom ? `公共聊天室 · 全员可见 · 已加密`
    : isGroup ? (current.group ? `${current.group.member_count} 位成员` : '')
      : (current.peer ? (current.peer.online ? '在线' : '离线') : '');

  const av = isRoom
    ? avatar({ id: 'system', nickname: roomName(), official: true })
    : isGroup
      ? el('div', { class: 'avatar', onClick: () => openGroupCard(c.slice(2)) }, [el('span', { text: (title || '群').slice(0, 1) })])
      : avatar(current.peer || {}, '', { status: true, onClick: () => current.peer && openUserCard(current.peer.id) });
  // 双击头像 = 拍一拍
  if (!isRoom) {
    av.style.cursor = 'pointer';
    av.title = '双击头像拍一拍';
    av.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const uid = isGroup ? (current.peer?.id || '') : (current.peer?.id || '');
      sendPoke(uid);
    });
  }

  const head = el('div', { class: 'chat__head' }, [
    el('div', { class: 'chat__peer' }, [
      av,
      el('div', {}, [
        (() => {
          const n = el('div', { class: 'chat__peer-name' }, [
            // 群聊/公共房间没有性别概念，只有私聊对象才补性别徽标
            nameNode(!isRoom && !isGroup ? (current.peer || {}) : {}, { text: title, single: false }),
          ]);
          if (!isRoom && current.peer) {
            n.title = '双击昵称拍一拍';
            n.addEventListener('dblclick', (e) => { e.preventDefault(); sendPoke(current.peer.id); });
          }
          return n;
        })(),
        el('div', { class: 'chat__peer-sub' }, [
          isRoom || (current.peer && !current.peer.online) ? null : el('i', { class: 'dot-online is-online' }),
          el('span', { text: sub }),
          el('span', { class: 'e2ee-chip', html: icon('lock', 11, 2.2) }, [el('span', { text: '加密传输' })]),
        ]),
      ]),
    ]),
    el('div', { class: 'chat__tools' }, [
      iconTool('phone', '语音通话', () => startCall(c, 'audio', isGroup ? (current.group?.members || []).map((m) => m.id) : (current.peer ? [current.peer.id] : []))),
      // 公共聊天室是广播房间，不做点对点视频通话；这里换成「聊天室成员」
      isRoom ? null : iconTool('video', '视频通话', () => startCall(c, 'video', isGroup ? (current.group?.members || []).map((m) => m.id) : (current.peer ? [current.peer.id] : []))),
      isRoom ? iconTool('users', '聊天室成员', () => openRoomMembers()) : null,
      isGroup ? iconTool('users', '群信息', () => emit('ui:groupCard', c.slice(2))) : null,
      iconTool('more', '更多', (e) => ctxMenu(e.clientX, e.clientY, [
        { icon: 'search', label: '搜索聊天记录', onClick: () => emit('ui:nav', 'search') },
        { icon: 'flag', label: '举报该会话', onClick: () => emit('ui:report', isGroup ? ['group', c.slice(2)] : ['user', current.peer?.id]) },
      ])),
    ]),
  ]);

  // 群公告：常驻在消息区上方，不占用消息流，也不会被滚动带走
  const announce = isGroup ? groupAnnounceBar(c.slice(2), current.group) : null;
  scrollEl = el('div', { class: 'chat__scroll' });
  hoveringScroll = false; pendingScroll = false;   // 换了会话，旧的悬停状态不算数
  // 滚动容器挂到 current 上：切换会话时若旧的加载流程还在跑，
  // 它要能认出自己属于哪一次会话（否则会把结果渲染到新会话、或把游标写进新会话）
  if (current) current.scroll = scrollEl;
  scrollEl.addEventListener('scroll', () => {
    if (scrollEl.scrollTop < 60 && current && current.hasMore && !current.loading) loadMessages(true);
  });
  // 鼠标在消息区里就冻结自动滚动：来一条新消息把内容往上推，正在瞄准的按钮
  // 会从鼠标底下溜走 —— 看起来「一直在闪」，真点下去时按钮已经移位，
  // click 直接落空（表现就是「点了没反应、下不下来」）。鼠标移开再补滚。
  scrollEl.addEventListener('mouseover', () => { hoveringScroll = true; });
  scrollEl.addEventListener('mouseleave', () => { hoveringScroll = false; flushPendingScroll(); });

  const composer = buildComposer();
  const box = el('div', { class: 'chat' }, [head, announce, scrollEl, composer]);
  stage.appendChild(box);
}

/* ---------------- 群公告条 ----------------
   公告跟着群走，存在群文档里（announce / announce_by / announce_ts），
   只有群主和管理员能改 —— 权限判断在服务端，这里只决定要不要给「编辑」入口。 */
function groupAnnounceBar(gid, group) {
  const g = group || {};
  const text = String(g.announce || '').trim();
  const canEdit = !!(g.is_owner || g.is_admin);
  if (!text && !canEdit) return null;      // 没公告又改不了 → 不占位

  const bar = el('div', { class: 'chat__announce' + (text ? '' : ' is-empty') });
  bar.appendChild(el('span', { class: 'chat__announce-ico', html: icon('bell', 13, 2) }));
  const bodyEl = el('div', { class: 'chat__announce-text', text: text || '暂无群公告' });
  bar.appendChild(bodyEl);

  const edit = el('button', { class: 'chat__announce-btn', type: 'button', text: text ? '编辑' : '发布公告' });
  edit.addEventListener('click', () => openAnnounceEditor(gid, g));
  if (canEdit) bar.appendChild(edit);
  return bar;
}

async function openAnnounceEditor(gid, g) {
  const { openGroupAnnounce } = await import('./cards.js');
  openGroupAnnounce(gid, g);
}

/** 实时公告推送：正在看这个群就直接换掉文案，不用重开会话 */
export function handleGroupAnnounce(d) {
  if (!d || !current || current.conv !== `g:${d.gid}`) return;
  // current.group 是缓存对象：不在这里同步，后续任何一次重画都会把刚收到的
  // 新公告覆盖回旧值（表现为「改完公告，顶部还是旧的」）
  if (current.group) {
    current.group.announce = String(d.announce || '');
    current.group.announce_by = d.by || '';
  }
  const bar = document.querySelector('.chat__announce');
  if (!bar) { refreshGroupHead(d.gid); return; }
  const text = String(d.announce || '').trim();
  const bodyEl = bar.querySelector('.chat__announce-text');
  if (bodyEl) bodyEl.textContent = text || '暂无群公告';
  bar.classList.toggle('is-empty', !text);
  const btn = bar.querySelector('.chat__announce-btn');
  if (btn) btn.textContent = text ? '编辑' : '发布公告';
  if (d.by && d.by !== state.me.id && d.by_name) toast(`${d.by_name} 更新了群公告`, 'info');
}

/** 群资料（公告 / 名称 / 角色）变了之后重画顶部。
    必须先回服务端拉一次：current.group 是 openConv 时缓存下来的，不会自更新。 */
export async function refreshGroupHead(gid) {
  if (!current || current.conv !== `g:${gid}`) return;
  try { const r = await api.get(`/api/groups/${gid}`); current.group = r.group; } catch { /* 沿用旧值 */ }
  renderChatView();
  await loadMessages();
}

function iconTool(name, title, onClick) {
  return el('button', { class: 'icon-btn', title, html: icoHtml(name, 19), onClick: (e) => onClick(e) });
}

/* ---------------- 消息加载 ---------------- */
/* ---------------- 消息容器 · 节点上限 ----------------
   聊天滚动区以前只增不减：长时间聊天或反复上翻历史会把 DOM 堆到几千个节点，
   帧率肉眼可见地往下掉。这里保留最近 MAX_MSG_NODES 条，多余的从顶部裁掉，
   并保持滚动位置不被扯动（以「距底部距离」为锚点）。 */
const MAX_MSG_NODES = 240;

function trimMessages(sc = null) {
  const box = sc || scrollEl;
  if (!box) return;
  const overflow = box.children.length - MAX_MSG_NODES;
  if (overflow <= 0) return;
  const anchor = box.scrollHeight - box.scrollTop;   // 距底部距离
  let dropped = 0;
  while (dropped < overflow && box.firstChild) {
    const n = box.firstChild;
    // 还在发送中的消息不能裁，否则用户会看到自己的气泡凭空消失
    if (n.classList && n.classList.contains('msg') && n.dataset.pending === '1') break;
    box.removeChild(n);
    dropped++;
  }
  box.scrollTop = box.scrollHeight - anchor;
}

async function loadMessages(append = false) {
  if (!current.conv || current.loading) return;
  // 全程锁定本次加载所属的会话对象：await 期间若用户切了会话（或被重复打开），
  // current 会被换掉，此时必须丢弃结果 —— 否则旧流程会把 before 游标写成 1
  // 再请求一次「id < 1」的历史，拿到空列表并覆盖新会话，表现为「聊天内容空白」。
  const cur = current;
  cur.loading = true;
  const conv = cur.conv;
  try {
    const r = await api.get(`/api/chat/history?conv=${encodeURIComponent(conv)}&before=${cur.before}&limit=40`);
    const msgs = r.messages || [];
    if (cur !== current) return;          // 会话已切换：结果作废
    cur.hasMore = !!r.has_more;
    if (msgs.length) cur.before = msgs[0].id;
    const frag = document.createDocumentFragment();
    let lastDay = '';
    for (const m of msgs) {
      const day = fmtDay(m.ts);
      if (day !== lastDay) { frag.appendChild(el('div', { class: 'msg-day', text: day })); lastDay = day; }
      frag.appendChild(await renderMessage(m));
      if (cur !== current) return;        // 渲染途中被切走：同样作废
    }
    const sc = cur.scroll || scrollEl;
    if (!sc || cur !== current) return;
    if (append) {
      const old = sc.scrollHeight;
      sc.insertBefore(frag, sc.firstChild);
      sc.scrollTop = sc.scrollHeight - old;
    } else {
      sc.appendChild(frag);
      trimMessages(sc);
      scrollToBottom(true);
    }
  } catch (e) { if (cur === current) toast(e.message, 'err'); }
  finally { cur.loading = false; }
}

async function decryptMsg(msg) {
  if (msg.type === 'system') return { kind: 'system', text: (msg.system && msg.system.text) || '' };
  if (!msg.cipher) return null;
  try {
    // 会话级密钥优先（私聊且双方已升级），解不开自动回退全局密钥
    return await C.decryptMessage(msg.cipher, msg.keys, msg.conv || current.conv);
  } catch { /* 解密失败 */ }
  return null;
}

async function renderMessage(msg) {
  const mine = msg.from === state.me.id;
  const payload = await decryptMsg(msg);
  const who = mine ? state.me : (await peekUser(msg.from));

  const wrap = el('div', { class: 'msg' + (mine ? ' msg--me' : ''), dataset: { id: msg.id, from: msg.from } });
  // 系统消息用官方图标，其余走用户头像
  const msgAv = msg.from === 'system'
    ? avatar({ id: 'system', nickname: '系统', official: true }, 'sm', { status: false })
    : avatar(who || { nickname: '未知' }, 'sm', { status: false, onClick: () => openUserCard(msg.from) });
  wrap.appendChild(el('div', { class: 'msg__avatar' }, [msgAv]));

  const col = el('div', { class: 'msg__col' });
  const nameEl = nameNode(
    msg.from === 'system' ? {} : (who || {}),
    { text: (who && (who.remark || who.nickname)) || (msg.from === 'system' ? '系统' : '未知用户'),
      class: 'msg__name', single: false },
  );
  // 单击头像已用于打开资料卡，因此「拍一拍」改挂在昵称上（双击）
  if (!mine && msg.from !== 'system') {
    nameEl.title = '双击昵称拍一拍';
    nameEl.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); sendPoke(msg.from); });
  }
  col.appendChild(el('div', { class: 'msg__meta' }, [
    nameEl,
    el('span', { text: fmtClock(msg.ts) }),
    el('span', { class: 'msg__lock', html: icon('lock', 11, 2.2) }),
  ]));

  if (msg.recalled) {
    markNodeRecalled(wrap);               // 刷新后再进来，这条仍然不能再撤回
    col.appendChild(el('div', { class: 'msg__bubble is-poke', text: mine ? '你撤回了一条消息' : '对方撤回了一条消息' }));
  } else if (!payload) {
    col.appendChild(el('div', { class: 'msg__bubble', style: { opacity: '.75' } }, [
      el('span', { text: '🔒 无法解密（由旧版密钥加密，切换统一密钥后不可读）' }),
    ]));
  } else if (payload.kind === 'system') {
    col.appendChild(el('div', { class: 'msg__bubble is-system', text: payload.text }));
  } else if (payload.kind === 'poke') {
    const targetName = payload.target && payload.target !== state.me.id ? (await peekUser(payload.target))?.nickname : '我';
    const suffix = payload.suffix || '拍了拍';
    const tail = targetName && !suffix.endsWith(targetName) ? ` ${targetName}` : '';
    col.appendChild(el('div', { class: 'msg__bubble is-poke', text: `${who?.nickname || '有人'} ${suffix}${tail}` }));
  } else {
    const bubble = el('div', { class: 'msg__bubble' });
    if (payload.quote) {
      const q = el('div', { class: 'msg__quote', title: '点击跳转到原消息', onClick: () => jumpToMessage(payload.quote.id) }, [
        el('div', { class: 'msg__quote-name', text: payload.quote.from || '引用' }),
        el('div', { class: 'ellipsis', text: payload.quote.text || '' }),
      ]);
      bubble.appendChild(q);
    }
    if (payload.kind === 'text') {
      bubble.appendChild(renderTextNode(payload.text || '', payload.mentions || []));
    } else if (payload.kind === 'sticker') {
      bubble.appendChild(el('div', { class: 'msg__sticker', text: payload.emoji || '🙂' }));
    } else if (payload.kind === 'moment') {
      bubble.appendChild(momentCard(payload, msg));
    } else if (payload.kind === 'contact') {
      bubble.appendChild(contactCard(payload, mine));
    } else if (payload.kind === 'file') {
      bubble.appendChild(fileBubble(payload));
    } else if (payload.kind === 'call') {
      bubble.appendChild(callBubble(payload, mine));
    } else if (payload.kind === 'voice') {
      bubble.appendChild(voiceBubble(payload));
    }
    col.appendChild(bubble);
    // 乐观渲染阶段 id 还是临时的，等服务端确认后再写入明文索引
    if (payload.kind === 'text' && !msg._pending) C.cachePlain(msg.conv, msg, payload.text);
  }

  /* 操作统一收敛到右键菜单（引用 / 复制 / 回应 / 撤回 / 举报），不再展示悬浮按钮 */

  wrap._msg = msg;                  // 实时回应事件要在原节点上就地改，需要拿回 msg 对象
  wrap.appendChild(col);
  paintReactions(wrap, msg.reactions || {});
  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // 已撤回 / 仍在发送中的消息不允许再走一遍撤回（读取 DOM 上的实时状态，
    // 撤回事件到达后节点不会重建，只看引用的 msg 对象会读到旧值）
    const dead = msg.recalled || wrap.dataset.recalled === '1' || msg._pending;
    const canRecall = (mine || (current.conv.startsWith('g:') && current.group?.is_owner)) && !dead;
    const mx = e.clientX;
    const my = e.clientY;
    ctxMenu(mx, my, [
      payload && payload.kind !== 'system' ? { icon: 'quote', label: '引用', onClick: () => setQuote(msg, payload) } : null,
      { icon: 'copy', label: '复制', onClick: () => { navigator.clipboard?.writeText(payload?.text || ''); toast('已复制', 'ok'); } },
      // 附件类消息（文件/图片/视频/语音）提供「另存为」：图片与视频气泡本身没有下载按钮，
      // 右键菜单是它们唯一的保存入口（气泡动作统一走右键菜单）
      payload && payload.fileId ? { icon: 'download', label: '另存为', onClick: () => saveAttachment(payload) } : null,
      !dead ? { icon: 'smile', label: '表情回应', onClick: () => openReactPicker(mx, my, (emoji) => toggleReact(wrap, emoji)) } : null,
      canRecall ? { icon: 'undo', label: '撤回', danger: true, onClick: () => recall(msg, wrap) } : null,
      { icon: 'alert', label: '举报这条消息', danger: true, onClick: () => emit('ui:report', ['message', `${msg.conv}:${msg.id}`]) },
    ]);
  });
  return wrap;
}

const userPeek = new Map();

/* ---------------- 动态分享卡片 ---------------- */
/** 聊天里的转发动态：渲染成可点击的分享卡片（缩略图 + 标题 + 预览 + 来源行） */
function momentCard(p, msg) {
  const open = () => {
    if (p.share) renderSharedMoment(p.share, msg.conv || current.conv);
    else toast('该转发未携带分享副本，无法打开详情', 'info');
  };
  const card = el('button', { class: 'moment-card', type: 'button', onClick: open });
  const body = el('div', { class: 'moment-card__body' });
  body.appendChild(el('div', { class: 'moment-card__title', text: '分享了一条动态' }));
  if (p.text) body.appendChild(el('div', { class: 'moment-card__text', text: p.text }));
  body.appendChild(el('div', { class: 'moment-card__src' }, [
    el('span', { class: 'moment-card__src-ico', html: icon('sparkles', 11, 2) }),
    el('span', { text: '武侯动态 · 加密存储' }),
  ]));
  card.appendChild(body);

  const media = (p.media || [])[0];
  if (media) {
    const thumb = el('div', { class: 'moment-card__thumb' }, [el('div', { class: 'skeleton', style: { width: '100%', height: '100%' } })]);
    card.appendChild(thumb);
    (async () => {
      try {
        const url = await mediaObjectUrl(media);
        thumb.innerHTML = '';
        if (isVideo(media.name)) {
          thumb.appendChild(el('span', { class: 'moment-card__video', text: '🎬' }));
          thumb.style.background = `center / cover url(${url})`;
        } else {
          thumb.appendChild(el('img', { src: url, alt: '' }));
        }
      } catch { thumb.innerHTML = '<span class="moment-card__video">🔒</span>'; }
    })();
  }
  return card;
}

/* ---------------- 名片推荐 ----------------
   好友把自己通讯录里的某个人打包成名片发过来：一张可以看资料、直接加好友的卡片。
   推荐人自己发出的那份（mine）只是留个记录，不需要再点一遍加自己。 */
function contactCard(p, mine) {
  const uid = p.uid || p.recommend || '';
  const known = uid && uid !== state.me?.id && (state.friends || []).some((f) => f.id === uid);
  const card = el('div', { class: 'contact-card' });

  card.appendChild(el('div', { class: 'contact-card__top' }, [
    avatar({ avatar: p.avatar, nickname: p.nickname }, 'sm', { status: false }),
    el('div', { class: 'grow' }, [
      el('div', { class: 'contact-card__name ellipsis', text: p.nickname || '未知用户' }),
      p.username ? el('div', { class: 'contact-card__sub ellipsis', text: `@${p.username}` }) : null,
      p.signature ? el('div', { class: 'contact-card__sig ellipsis', text: p.signature }) : null,
    ]),
  ]));
  if (p.reason) card.appendChild(el('div', { class: 'contact-card__reason', text: `“${p.reason}”` }));

  const acts = el('div', { class: 'contact-card__acts' });
  if (uid) {
    acts.appendChild(el('button', { class: 'contact-card__btn', type: 'button', text: '查看资料',
      onClick: () => openUserCard(uid) }));
    if (uid === state.me?.id) {
      acts.appendChild(el('span', { class: 'contact-card__hint', text: '这是你的名片' }));
    } else if (known) {
      acts.appendChild(el('button', { class: 'contact-card__btn is-primary', type: 'button', text: '发消息',
        onClick: () => emit('ui:openConv', `p:${[state.me.id, uid].sort().join(':')}`) }));
    } else {
      acts.appendChild(el('button', { class: 'contact-card__btn is-primary', type: 'button', text: '添加好友',
        onClick: () => openAddFriend(uid) }));
    }
  }
  card.appendChild(acts);
  card.appendChild(el('div', { class: 'contact-card__src' }, [
    el('span', { class: 'contact-card__src-ico', html: icon('userPlus', 11) }),
    el('span', { text: mine ? '你推荐的名片 · 加密发送' : '好友推荐的名片 · 加密发送' }),
  ]));
  return card;
}

/* ---------------- 通话记录 ----------------
   通话结束（含未接听 / 被拒绝）后双方各写一条 type=call 的加密消息，
   这样会话里能留下可回溯的通话记录，而不只是转瞬即逝的浮层。 */
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '';
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function callBubble(p, mine) {
  const kind = p.mode === 'video' ? '视频通话' : '语音通话';
  const st = ({
    ended: '通话结束', missed: mine ? '对方未接听' : '未接听',
    rejected: mine ? '对方已拒绝' : '已拒绝', busy: '对方忙线中', failed: '通话中断',
  })[p.status] || '通话结束';
  const dur = fmtDuration(p.duration);
  return el('div', { class: 'msg__bubble is-call' }, [
    el('span', { class: 'msg__call-ico', html: icon(p.mode === 'video' ? 'video' : 'phone', 15) }),
    el('span', { text: `${kind} · ${st}${dur ? ' · ' + dur : ''}` }),
  ]);
}

/** 按会话性质加密：群走群密钥，其余走会话密钥 / 全局密钥 */
async function encryptForConv(conv, payload) {
  if (conv.startsWith('g:')) {
    await ensureGroupKey(conv.slice(2));
    // 交给 encryptFor 的群作用域分支：真群密钥 + 版本号 + 托管信封。
    // 旧实现是 encryptGroup(raw, payload)，而它会忽略入参、退回全局密钥。
    return C.encryptFor([], payload, conv);
  }
  const ids = conv.startsWith('p:') ? conv.split(':').slice(1).filter((u) => u !== state.me.id) : [];
  return C.encryptFor(ids, payload, conv);
}

export async function sendCallRecord(conv, { mode = 'audio', duration = 0, status = 'ended' } = {}) {
  if (!conv) return;
  try {
    const { cipher, keys } = await encryptForConv(conv, {
      kind: 'call', mode, duration: Math.round(duration || 0), status,
    });
    const r = await api.post('/api/chat/send', { conv, type: 'call', cipher, keys, hint: 'call' });
    if (conv === current.conv) {
      await appendIncoming({
        id: r.id, conv, from: state.me.id, ts: r.ts || Date.now() / 1000,
        type: 'call', cipher, keys, hint: 'call',
      });
    }
    loadConvs().then(() => emit('ui:refreshConvList'));
  } catch { /* 通话记录写不进去不应影响通话本身 */ }
}

async function peekUser(uid) {
  if (!uid || uid === 'system') return null;
  if (userPeek.has(uid)) return userPeek.get(uid);
  const p = api.get(`/api/users/${uid}`).then((r) => r.user).catch(() => null);
  userPeek.set(uid, p);
  const u = await p;
  if (!u) userPeek.delete(uid);
  return u;
}
export function invalidateUser(uid) { userPeek.delete(uid); }

/* ---------------- 文件气泡 ---------------- */
function fileBubble(p) {
  const box = el('div', { class: 'msg__file' });
  if (isImage(p.name)) {
    const holder = el('div', { class: 'msg__img' }, [
      el('div', { class: 'skeleton', style: { width: '180px', height: '120px' } }),
    ]);
    loadMedia(p).then((url) => {
      holder.innerHTML = '';
      holder.appendChild(el('img', { src: url, alt: p.name, onClick: () => lightbox(url, false, { name: p.name, blob: mediaBlobCache.get(p.fileId) }) }));
    }).catch(() => { holder.innerHTML = '<div class="muted">🔒 图片解密失败</div>'; });
    return holder;
  }
  if (isVideo(p.name)) {
    const holder = el('div', { class: 'msg__video' }, [el('div', { class: 'skeleton', style: { width: '220px', height: '130px' } })]);
    loadMedia(p).then((url) => {
      holder.innerHTML = '';
      holder.appendChild(el('video', { src: url, controls: true, preload: 'metadata' }));
    }).catch(() => { holder.innerHTML = '<div class="muted">🔒 视频解密失败</div>'; });
    return holder;
  }
  box.append(
    el('div', { class: 'msg__file-icon', html: icoHtml(fileIcon(p.name, p.mime), 20) }),
    el('div', { class: 'grow' }, [
      el('div', { class: 'msg__file-name ellipsis', text: p.name || '加密文件' }),
      el('div', { class: 'msg__file-size', text: fmtSize(p.size) + ' · 已加密' }),
    ]),
    el('button', {
      class: 'btn btn--sm btn--ghost', text: '下载', onClick: async () => {
        try {
          await loadMedia(p);   // 确保已下载并解密（填充 mediaBlobCache）
          const blob = mediaBlobCache.get(p.fileId);
          if (!blob) throw new Error('no blob');
          download(blob, p.name || '附件');
          toast('已开始下载', 'ok');
        } catch { toast('解密失败', 'err'); }
      }
    }),
  );
  return box;
}

async function loadMedia(p) {
  if (mediaCache.has(p.fileId)) return mediaCache.get(p.fileId);
  if (inflight.has(p.fileId)) return inflight.get(p.fileId);
  const job = (async () => {
    const buf = await api.download(p.fileId);
    const pt = await C.decryptFile(buf, p.key, p.iv);
    const blob = new Blob([pt], { type: p.mime || 'application/octet-stream' });
    mediaBlobCache.set(p.fileId, blob);
    const url = URL.createObjectURL(blob);
    mediaCache.set(p.fileId, url);
    return url;
  })();
  inflight.set(p.fileId, job);
  try { return await job; } finally { inflight.delete(p.fileId); }
}
export async function mediaUrl(p) { return loadMedia(p); }

/** 把加密附件解密后另存到本地（文件 / 图片 / 视频 / 语音通用）。
 *  图片与视频气泡没有下载按钮，这里（右键菜单「另存为」）是它们的保存入口。 */
async function saveAttachment(p) {
  try {
    await loadMedia(p);   // 确保已下载并解密（填充 mediaBlobCache）
    const blob = mediaBlobCache.get(p.fileId);
    if (!blob) throw new Error('no blob');
    download(blob, p.name || String(p.mime || '').split('/')[1] || '附件');
    toast('已开始下载', 'ok');
  } catch { toast('解密失败，无法保存', 'err'); }
}

/* ---------------- 语音消息气泡 ----------------
   只画 UI：音频字节要到点击时才去下载解密，避免一进会话就把所有语音都拉下来。
   同一时刻只允许一段在播 —— 否则多路语音叠在一起根本听不清。 */
const VOICE_N = 32;
const voicePlayers = new Map();   // fileId -> HTMLAudioElement

function stopOtherVoices(except) {
  for (const [fid, a] of voicePlayers) {
    if (fid !== except && !a.paused) { a.pause(); a.currentTime = 0; }
  }
}

function voiceWaveNodes(p) {
  const waveEl = el('div', { class: 'voice-wave voice-wave--msg' });
  const nodes = [];
  const src = (Array.isArray(p.wave) && p.wave.length) ? p.wave : null;
  for (let i = 0; i < VOICE_N; i++) {
    const v = src ? (src[Math.floor(i * src.length / VOICE_N)] ?? 0.2) : 0.35;
    const b = el('span', { class: 'voice-wave__bar', style: { height: `${Math.round(6 + Math.min(1, v) * 20)}px` } });
    nodes.push(b);
    waveEl.appendChild(b);
  }
  return { waveEl, nodes };
}

function voiceBubble(p) {
  const box = el('div', { class: 'msg__voice' });
  const { waveEl, nodes } = voiceWaveNodes(p);
  const playBtn = el('button', { class: 'voice-play', html: icoHtml('play', 15), title: '播放语音' });
  const timeEl = el('span', { class: 'msg__voice-time', text: fmtDuration(Number(p.duration || 0)) || '0:00' });
  box.append(playBtn, waveEl, timeEl, el('span', { class: 'msg__voice-lock', text: '🔒' }));

  const setIcon = (playing) => { playBtn.innerHTML = icoHtml(playing ? 'pause' : 'play', 15); };

  playBtn.addEventListener('click', async () => {
    const existing = voicePlayers.get(p.fileId);
    if (existing) {
      if (existing.paused) { stopOtherVoices(p.fileId); existing.play(); } else { existing.pause(); }
      return;
    }
    try {
      playBtn.classList.add('is-loading');
      const url = await loadMedia(p);
      const a = new Audio(url);
      voicePlayers.set(p.fileId, a);
      a.addEventListener('timeupdate', () => {
        const r = a.duration ? a.currentTime / a.duration : 0;
        nodes.forEach((b, i) => b.classList.toggle('is-played', i / VOICE_N <= r));
      });
      a.addEventListener('play', () => { playBtn.classList.add('is-playing'); setIcon(true); stopOtherVoices(p.fileId); });
      a.addEventListener('pause', () => { playBtn.classList.remove('is-playing'); setIcon(false); });
      a.addEventListener('ended', () => { setIcon(false); a.currentTime = 0; nodes.forEach((b) => b.classList.remove('is-played')); });
      await a.play();
    } catch { toast('语音解密失败', 'err'); }
    finally { playBtn.classList.remove('is-loading'); }
  });
  return box;
}

/* ---------------- 输入区 ---------------- */
/* 引用条 DOM 提到模块级：post() 发送后必须同步销毁引用条，
   否则会出现「消息已发出、引用条还挂在上面的幽灵引用」 */
let quoteBarEl = null;

function clearQuote() {
  current.quote = null;
  if (quoteBarEl) { quoteBarEl.hidden = true; quoteBarEl.innerHTML = ''; }
}

function buildComposer() {
  const quoteBar = el('div', { class: 'composer__quote' }, []);
  quoteBar.hidden = true;
  quoteBarEl = quoteBar;

  const conv = current.conv;
  const ta = el('textarea', { rows: 1, placeholder: '输入消息…（Enter 发送 / Shift+Enter 换行）' });
  ta.addEventListener('input', () => {
    autoGrow(ta);
    rt.typing(conv);
    queueDraft(conv, ta.value);
    updateMentionPanel();
  });
  ta.addEventListener('keydown', (e) => {
    // @ 浮层打开时先吃掉方向键与回车：否则回车会把半截 "@昵" 当成消息发出去
    if (mentionHotkey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAndClear(ta, conv); }
  });
  // 点击也要刷新候选：光标挪到别的 @ 上时应给出对应的候选
  ta.addEventListener('click', () => updateMentionPanel());
  ta.addEventListener('blur', () => setTimeout(() => closeMentionPanel(), 150));

  const emojiPanel = el('div', { class: 'emoji-panel' });
  emojiPanel.hidden = true;

  // 拉黑后服务端已切断该会话，这里同步把输入区锁掉，避免「点了发送没反应」
  const blocked = !!(current.conv || '').startsWith('p:') && !!current.peer?.blocked;

  // 右上角已有语音 / 视频通话入口，输入框左侧不再重复放通话按钮
  const micBtn = toolBtn('mic', '发送语音消息', () => sendVoice());
  const tools = el('div', { class: 'composer__tools' }, [
    toolBtn('smile', '表情 / 表情包', () => toggleEmoji(emojiPanel)),
    micBtn,
    toolBtn('image', '发送图片或文件', () => sendFiles()),
  ]);
  if (blocked) micBtn.disabled = true;

  // 草稿提示条：只在输入框里有内容时出现，空着不占位
  const draftBar = el('div', { class: 'composer__draft' }, [
    el('span', { class: 'composer__draft-ico', html: icon('edit', 12, 2) }),
    el('span', { text: '草稿已保存，换设备也能接着写' }),
    el('button', {
      class: 'composer__draft-clear', type: 'button', text: '清空',
      onClick: () => { ta.value = ''; autoGrow(ta); queueDraft(conv, ''); ta.focus(); },
    }),
  ]);
  draftBar.hidden = true;

  const sendBtn = el('button', {
    class: 'btn btn--primary composer__send', text: '发送',
    onClick: () => sendAndClear(ta, conv),
  });
  if (blocked) { ta.disabled = true; sendBtn.disabled = true; ta.placeholder = '已拉黑该用户，无法发送消息'; }

  const row = el('div', { class: 'composer__row', style: { position: 'relative' } }, [
    tools, ta, sendBtn, emojiPanel,
  ]);

  const composer = el('div', { class: 'composer' }, [
    quoteBar,
    draftBar,
    row,
    el('div', { class: 'composer__hint' }, [
      el('span', { class: 'e2ee-chip', text: '🔐 加密传输' }),
      el('span', {
        text: blocked ? '已拉黑该用户，双方会话已关闭'
          : (conv.startsWith('g:') ? '输入 @ 可以点名的一位成员' : '消息加密传输与存储，违规内容将被拦截'),
      }),
    ]),
  ]);

  current.setQuote = (msg, payload) => {
    current.quote = { id: msg.id, from: payload.from || '', text: payload.kind === 'text' ? payload.text : `[${hintOf(payload.kind)}]` };
    quoteBar.innerHTML = '';
    quoteBar.append(el('span', { text: `引用：${current.quote.text}` }),
      el('button', { class: 'icon-btn', html: icon('x', 16), onClick: () => clearQuote() }));
    quoteBar.hidden = false;
  };

  resetComposerState(conv, ta, draftBar);
  restoreDraft(conv, ta);      // 换设备 / 刷新页面回来还能接着写
  preloadMentions(conv);       // @ 候选名单提前拉一次，避免第一次 @ 时有卡顿感
  return composer;
}

/* ============================================================
   会话草稿
   写了一半被别的事打断是常态，草稿让切走的会话回来还能继续。
   载荷用会话密钥加密后交给服务端 —— 服务端（含管理后台）只见字节，
   和消息一样保持端到端加密。
   ============================================================ */
const DRAFT_DEBOUNCE = 600;
const COMPOSER = { ta: null, draftEl: null, timer: null, pending: null, savedConv: null, saved: null,
  panelEl: null, hits: [], idx: 0, at: 0, kw: '', cacheConv: null, cacheList: [] };

function resetComposerState(conv, ta, draftEl) {
  clearTimeout(COMPOSER.timer);
  COMPOSER.pending = null;
  COMPOSER.ta = ta;
  COMPOSER.draftEl = draftEl;
  COMPOSER.savedConv = null;
  COMPOSER.saved = null;
  COMPOSER.panelEl = null;
  COMPOSER.hits = [];
  COMPOSER.idx = 0;
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
}

/** 缓存下一次要写的草稿内容；连续输入只在停手后写一次，避免每次击键都跑一趟加密和 HTTP */
function queueDraft(conv, text) {
  const t = String(text || '');
  COMPOSER.pending = { conv, text: t };
  clearTimeout(COMPOSER.timer);
  COMPOSER.timer = setTimeout(() => {
    const p = COMPOSER.pending;
    COMPOSER.pending = null;
    if (p) writeDraft(p.conv, p.text);
  }, t.trim() ? DRAFT_DEBOUNCE : 0);      // 清空要立刻生效：慢一步会留下幽灵草稿
}

/** 立刻把待写草稿落库（切换会话 / 页面隐藏前调用） */
function flushDraft() {
  clearTimeout(COMPOSER.timer);
  const p = COMPOSER.pending;
  COMPOSER.pending = null;
  if (p) writeDraft(p.conv, p.text);
}

async function writeDraft(conv, text) {
  if (!conv) return;
  const t = String(text || '');
  if (COMPOSER.savedConv === conv && COMPOSER.saved === t) return;   // 内容没变就不必再写
  try {
    if (!t.trim()) {
      await api.post('/api/chat/draft', { conv, cipher: null, keys: {} });
    } else {
      const { cipher, keys } = await C.encryptFor(targetIds(), { kind: 'draft', text: t }, conv);
      await api.post('/api/chat/draft', { conv, cipher, keys });
    }
    COMPOSER.savedConv = conv;
    COMPOSER.saved = t;
    markDraft(conv, !!t.trim());
  } catch { /* 草稿只是便利功能，写失败也不该打断输入 */ }
}

/** 草稿标记同时更新会话列表：列表是本地重画的，不必为了一个小红字再拉一次接口 */
function markDraft(conv, on) {
  if (COMPOSER.draftEl) COMPOSER.draftEl.hidden = !on;
  const c = state.convs.find((x) => x.conv === conv);
  if (c) c.draft = !!on;
  const host = document.querySelector('#sideBody');
  if (host && host.querySelector('.conv')) renderConvList(host);
}

async function restoreDraft(conv, ta) {
  try {
    const r = await api.get('/api/chat/drafts');
    if (!current.conv || current.conv !== conv) return;      // 拉取期间已经切走了
    const hit = (r.drafts || []).find((d) => d.conv === conv);
    if (!hit || !hit.cipher) return;
    const p = await C.decryptMessage(hit.cipher, hit.keys, conv).catch(() => null);
    const text = p && p.kind === 'draft' ? String(p.text || '') : '';
    // 群密钥轮换过（自己又还没领到）时旧草稿会解不开 —— 那是过期数据，直接丢弃，
    // 不能因为一份读不了的草稿挡住进入会话
    if (!text) return;
    ta.value = text;
    COMPOSER.savedConv = conv;
    COMPOSER.saved = text;
    autoGrow(ta);
    markDraft(conv, true);
    syncMentionsFor(text);
  } catch { /* 取不到草稿就当作没有 */ }
}

/** 发送 / 清空输入框：发送成功的会话要马上清掉草稿，失败的要把内容还给用户 */
async function sendAndClear(ta, conv) {
  const text = ta.value;
  if (!String(text || '').trim()) return;
  closeMentionPanel();
  ta.value = '';
  autoGrow(ta);
  const sent = await sendText(text);
  if (current.conv !== conv) return;                    // 等待期间切走了：别改别人的输入框
  if (sent) {
    current.mentions = [];
    // 用户可能在等加密的这几毫秒里又打了新内容：那种情况不能清，否则等于删掉他新的草稿
    if (!COMPOSER.ta || !COMPOSER.ta.value.trim()) queueDraft(conv, '');
  } else {
    // 被违规词拦下 / 被禁言 / 网络失败：内容还回去，不能让人重打一遍
    ta.value = text;
    autoGrow(ta);
    queueDraft(conv, text);
  }
}

/* ============================================================
   @提及
   名单随正文一起加密发送（服务端靠托管密钥读出名单做定向提醒），
   因此服务端无从知道「谁和谁互相 @ 了」以外的信息；
   渲染侧按名单把 @昵称 高亮成可点击的名字。
   ============================================================ */
const MENTION_ALL = { id: 'all', name: '所有人' };

async function preloadMentions(conv) {
  const pick = (m) => ({ id: m.id, name: (m.remark || m.nickname || m.username || '').trim() });
  let list = [];
  try {
    if (conv.startsWith('g:')) {
      list = ((current.group && current.group.members) || []).map(pick).filter((m) => m.id && m.name && m.id !== state.me.id);
      // @所有人 只在群里给出入口（公共聊天室没有稳定成员边界）。
      // 服务端另有规模上限，超限会被忽略 —— 判断统一放在服务端，避免两端规则漂移。
      list = [MENTION_ALL, ...list];
    } else if (conv === ROOM) {
      const r = await api.get('/api/chat/room/members');
      list = (r.members || []).map(pick).filter((m) => m.id && m.name && m.id !== state.me.id);
    } else if (conv.startsWith('p:')) {
      list = current.peer ? [pick(current.peer)].filter((m) => m.id && m.name) : [];
    }
  } catch { list = []; }
  COMPOSER.cacheConv = conv;
  COMPOSER.cacheList = list;
  return list;
}

function mentionCache(conv) {
  return COMPOSER.cacheConv === conv ? (COMPOSER.cacheList || []) : [];
}

/** 光标前是不是一个正在输入的 "@xxx"；是则给出候选 */
function updateMentionPanel() {
  const ta = COMPOSER.ta;
  if (!ta) return;
  const conv = current.conv;
  const pos = ta.selectionStart === undefined ? ta.value.length : ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const m = /(?:^|[\s(（，,])@([^\s@]{0,20})$/.exec(before);
  if (!m || !mentionCache(conv).length) { closeMentionPanel(); return; }
  openMentionPanel(m[1] || '', m.index + m[0].indexOf('@'));
}

function openMentionPanel(kw, at) {
  const k = String(kw || '').toLowerCase();
  const hits = mentionCache(current.conv)
    .filter((m) => !k || m.name.toLowerCase().includes(k))
    .slice(0, 12);
  if (!hits.length) { closeMentionPanel(); return; }

  let panel = COMPOSER.panelEl;
  if (!panel || !panel.isConnected) {
    panel = el('div', { class: 'mention-panel' });
    // 挂在输入行上：浮层要跟着输入框而不是贴着视口，键盘弹起时位置仍然对
    const row = (COMPOSER.ta && COMPOSER.ta.closest('.composer__row')) || null;
    (row || document.body).appendChild(panel);
    COMPOSER.panelEl = panel;
  }
  panel.textContent = '';
  hits.forEach((m, i) => {
    panel.appendChild(el('button', {
      class: 'mention-panel__item' + (m.id === 'all' ? ' is-all' : ''),
      type: 'button', dataset: { idx: String(i) },
      onMouseenter: () => { COMPOSER.idx = i; syncMentionActive(); },
      onClick: () => applyMention(m, at, String(kw || '')),
    }, [
      m.id === 'all'
        ? el('span', { class: 'mention-panel__ico', html: icon('users', 14, 2) })
        : avatar({ id: m.id, nickname: m.name }, 'sm', { status: false }),
      el('span', { class: 'mention-panel__name ellipsis', text: m.name }),
      m.id === 'all' ? el('span', { class: 'mention-panel__tag', text: '全体' }) : null,
    ]));
  });
  COMPOSER.hits = hits;
  COMPOSER.at = at;
  COMPOSER.kw = String(kw || '');
  if (COMPOSER.idx >= hits.length) COMPOSER.idx = 0;
  panel.hidden = false;
  syncMentionActive();
}

function syncMentionActive() {
  const panel = COMPOSER.panelEl;
  if (!panel) return;
  panel.querySelectorAll('.mention-panel__item').forEach((n) => {
    n.classList.toggle('is-active', Number(n.dataset.idx) === COMPOSER.idx);
  });
}

function closeMentionPanel() {
  if (COMPOSER.panelEl) COMPOSER.panelEl.hidden = true;
  COMPOSER.hits = [];
}

/** 浮层接管方向键 / 回车 / Esc；返回 true 表示这次按键已被消费 */
function mentionHotkey(e) {
  const p = COMPOSER.panelEl;
  const n = (COMPOSER.hits || []).length;
  if (!p || p.hidden || !n) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    COMPOSER.idx = (COMPOSER.idx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    syncMentionActive();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    applyMention(COMPOSER.hits[COMPOSER.idx], COMPOSER.at, COMPOSER.kw);
    return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); closeMentionPanel(); return true; }
  return false;
}

function applyMention(m, at, kw) {
  const ta = COMPOSER.ta;
  if (!ta || !m) return;
  const head = ta.value.slice(0, at);
  const tail = ta.value.slice(at + 1 + String(kw || '').length);
  const insert = `@${m.name} `;
  ta.value = head + insert + tail;
  const caret = head.length + insert.length;
  current.mentions = current.mentions || [];
  if (!current.mentions.some((x) => x.id === m.id)) current.mentions.push({ id: m.id, name: m.name });
  closeMentionPanel();
  ta.focus();
  ta.setSelectionRange(caret, caret);
  autoGrow(ta);
  queueDraft(current.conv, ta.value);
}

/** 发送时按正文重新校正名单：用户手动删掉 "@昵称" 后不该再提醒那个人 */
function resolveMentions(text) {
  const list = [];
  if (/@所有人/.test(text)) list.push(MENTION_ALL);
  for (const m of current.mentions || []) {
    if (m.id === 'all' || list.some((x) => x.id === m.id)) continue;
    if (String(text).includes(`@${m.name}`)) list.push({ id: m.id, name: m.name });
  }
  return list;
}

/** 草稿还原后要同步 @ 名单：不然原稿里的 @昵称 发出去不会提醒到人 */
function syncMentionsFor(text) {
  const mentions = [];
  for (const m of mentionCache(current.conv)) {
    if (String(text).includes(`@${m.name}`)) mentions.push({ ...m });
  }
  current.mentions = mentions;
}

/* 模块级 URL 正则：renderTextNode 与 linkify 共用，避免 linkify 引用局部变量 */
const URL_RE = /(https?:\/\/[^\s<]+)/g;

/** 渲染正文：把名单里的 @昵称 高亮成可点击的名字；http(s):// 链接自动转成可点击外链 */
function renderTextNode(text, mentions = []) {
  const list = (mentions || []).filter((m) => m && m.name);
  if (!list.length) return linkify(text);
  const names = Array.from(new Set(list.map((m) => m.name)))
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`@(${names.join('|')})`, 'g');
  const frag = document.createDocumentFragment();
  let last = 0;
  let hit;
  while ((hit = re.exec(text)) !== null) {
    if (hit.index > last) frag.appendChild(linkify(text.slice(last, hit.index)));
    const m = list.find((x) => x.name === hit[1]) || null;
    const mine = m && m.id === state.me.id;
    const node = el('span', { class: 'msg__mention' + (mine ? ' is-me' : ''), text: hit[0] });
    if (m && m.id && m.id !== 'all') {
      node.title = '查看资料';
      node.dataset.uid = m.id;
      node.addEventListener('click', () => openUserCard(m.id));
    }
    frag.appendChild(node);
    last = hit.index + hit[0].length;
  }
  if (last < text.length) frag.appendChild(linkify(text.slice(last)));
  return frag;
}

/** 把纯文本里的 http(s):// 链接变成可点击外链（保留其余文本） */
function linkify(text) {
  if (!URL_RE.test(text)) return el('span', { text });
  const frag = document.createDocumentFragment();
  let last = 0, hit;
  URL_RE.lastIndex = 0;
  while ((hit = URL_RE.exec(text)) !== null) {
    if (hit.index > last) frag.appendChild(document.createTextNode(text.slice(last, hit.index)));
    const url = hit[0];
    const a = el('a', {
      class: 'msg__link', href: url, target: '_blank', rel: 'noopener noreferrer nofollow',
      text: url,
      title: url,
      onClick: (e) => {
        // 聊天内容本身是加密的，链接可能来自陌生人；点击前给一次轻量确认，避免误触钓鱼站
        e.preventDefault();
        e.stopPropagation();
        confirm(`即将在浏览器打开外部链接：\n${url}\n\n请确认这是你信任的地址。`, {
          title: '打开外部链接', okText: '打开',
        }).then((ok) => { if (ok) window.open(url, '_blank', 'noopener,noreferrer'); });
      },
    });
    frag.appendChild(a);
    last = hit.index + hit[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function toolBtn(name, title, onClick) {
  return el('button', { class: 'icon-btn', title, html: icoHtml(name, 19), onClick });
}
function targetIds() {
  const c = current.conv;
  if (c.startsWith('p:')) return current.peer ? [current.peer.id] : [];
  if (c.startsWith('g:')) return (current.group?.members || []).map((m) => m.id).filter((u) => u !== state.me.id);
  return [];
}

/* ---------------- 发送 ---------------- */
async function encryptPayload(payload) {
  // 私聊 + 双方都持有真实身份密钥 → 会话级密钥；其余仍用全局密钥
  const r = await C.encryptFor(targetIds(), payload, current.conv);
  return { cipher: r.cipher, keys: r.keys };
}

/* ---------------- 乐观渲染 ----------------
   服务端不会把消息回推给发送者（公共聊天室是广播例外），因此本地必须先上屏，
   等服务端确认后再把临时节点换成正式节点；失败则原地标记并提供重试。*/
let cidSeq = 0;
const nextCid = () => `c${Date.now().toString(36)}${(++cidSeq).toString(36)}`;
/** cid -> 临时消息节点，用于与服务端回推/确认对齐 */
const pendingNodes = new Map();

function markPending(node, stateName) {
  if (!node) return;
  node.classList.remove('is-pending', 'is-failed');
  if (stateName) node.classList.add(stateName);
}

/** 发送失败：气泡旁给出重试入口 */
function showRetry(node, retry) {
  if (!node) return;
  const col = node.querySelector('.msg__col');
  if (!col) return;
  col.querySelector('.msg__retry')?.remove();
  const bar = el('div', { class: 'msg__retry' }, [
    el('span', { class: 'msg__retry-tip', text: '发送失败' }),
    el('button', { class: 'msg__retry-btn', type: 'button', text: '重试', onClick: retry }),
    el('button', { class: 'msg__retry-btn is-danger', type: 'button', text: '删除', onClick: () => node.remove() }),
  ]);
  col.appendChild(bar);
}

async function post(type, payload, hint) {
  const { cipher, keys } = await encryptPayload(payload);
  const cid = nextCid();
  // 引用 id：优先取当前引用条；重试路径里引用条已被清掉，从 payload.quote 兜底还原
  const replyTo = current.quote ? current.quote.id : (payload.quote ? payload.quote.id : null);
  const body = {
    conv: current.conv, type, cipher, keys, hint, client_id: cid,
    reply_to: replyTo,
  };
  clearQuote();   // 引用随消息一起发出：数据与引用条同步销毁

  // 1) 先用本地密文把消息画出来（cipher 由本机加密，可立即解密渲染）
  let node = null;
  if (scrollEl) {
    const local = {
      id: `tmp:${cid}`, conv: current.conv, from: state.me.id, ts: Date.now() / 1000,
      type, cipher, keys, hint, reply_to: body.reply_to, _pending: true,
    };
    node = await renderMessage(local);
    node.classList.add('is-pending');
    node.dataset.cid = cid;
    node.dataset.pending = '1';          // 标记在发送管线里，裁剪历史时不许删
    pendingNodes.set(cid, node);
    scrollEl.appendChild(node);
    trimMessages();
    scrollToBottom(true, true);
  }

  try {
    const r = await api.post('/api/chat/send', body);
    // 2) 服务端确认：换成正式 id，去掉「发送中」状态
    if (node) {
      node.dataset.id = r.id;
      delete node.dataset.pending;
      markPending(node, '');
      node.querySelector('.msg__retry')?.remove();
      // 服务端确认后节点不会重建，所以必须把 msg 对象上的 _pending 一起清掉：
      // 否则右键菜单会一直把这条当成「还在发送中」，撤回 / 表情回应都不出现，
      // 只有重新打开会话（走 history 重渲染）才恢复正常。
      if (node._msg) { node._msg._pending = false; node._msg.id = r.id; }
    }
    pendingNodes.delete(cid);
    scrollToBottom(true, true);
    return r;
  } catch (e) {
    // 3) 失败：原地标记，保留重试入口（节点仍留在界面里，不会「凭空消失」）
    if (node) {
      markPending(node, 'is-failed');
      showRetry(node, () => {
        const again = post(type, payload, hint);
        node.remove();
        return again;
      });
    }
    pendingNodes.delete(cid);
    throw e;
  }
}

/** 跳转到被引用的原消息：先在当前 DOM 找，找不到则回溯历史再找 */
export async function jumpToMessage(id) {
  if (!scrollEl || id === undefined || id === null || id === '') return;
  const find = () => scrollEl.querySelector(`.msg[data-id="${String(id)}"]`);
  let node = find();
  if (!node) {
    for (let i = 0; i < 6 && current.hasMore && !node; i++) {
      await loadMessages(true);
      node = find();
    }
  }
  if (!node) { toast('原消息不在可加载范围内', 'warn'); return; }
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.remove('is-flash');
  void node.offsetWidth;            // 重置动画
  node.classList.add('is-flash');
  setTimeout(() => node.classList.remove('is-flash'), 1600);
}

/** 滚到消息区底部。force=true 时无条件滚动；smooth=true 时平滑滚动（收发消息），加载历史用瞬时 */
function scrollToBottom(force = false, smooth = false) {
  if (!scrollEl) return;
  const target = () => scrollEl.scrollHeight;
  const doIt = () => {
    if (!scrollEl) return;
    if (!force && scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight >= 160) return;
    // 鼠标在消息区里：先把这次滚动压住，等鼠标移开再补 —— 绝不把人正在瞄准的东西挪走。
    // 例外：人本来就在底部、又是自己刚发的消息，滚动几乎不会位移，照常滚，
    // 否则「发完看不见自己的消息」反而更怪。
    const far = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight >= 160;
    if (hoveringScroll && (far || !force)) { pendingScroll = true; return; }
    pendingScroll = false;
    scrollEl.scrollTo({ top: target(), behavior: smooth ? 'smooth' : 'auto' });
  };
  doIt();
  requestAnimationFrame(doIt);
  if (smooth) { setTimeout(doIt, 80); setTimeout(doIt, 240); }
  else setTimeout(doIt, 260);
}

/** 鼠标从消息区移开后，把之前被压住的滚动补上（只在人本来就贴着底部时补，
 *  免得把正在翻历史的人一把拽回最新） */
function flushPendingScroll() {
  if (!scrollEl || !pendingScroll) return;
  pendingScroll = false;
  if (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 160) scrollToBottom(true, true);
}

async function sendText(text) {
  let t = String(text || '').trim();
  if (!t) return false;
  // 客户端前置检测（即时提示）；服务端持有托管密钥，会再判一次
  try {
    const g = await guardText(t, 'message');
    if (g.blocked) { toast(`消息包含违规词：${g.hits.join('、')}`, 'err'); return false; }
    if (g.masked) { t = g.text; toast(`已按社区规范打码：${g.hits.join('、')}`, 'warn'); }
  } catch { /* 词库不可用时放行，不阻断发送 */ }
  try {
    // @ 名单与正文同密发送：服务端用托管密钥读出名单做定向提醒，
    // 明文侧不落任何「谁 @ 了谁」的信息
    const payload = { kind: 'text', text: t, mentions: resolveMentions(t) };
    if (current.quote) payload.quote = { id: current.quote.id, from: current.quote.from, text: current.quote.text };
    await post('text', payload, 'text');
    emit('ui:refreshConvList');
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}

async function sendSticker(emoji, name) {
  try { await post('sticker', { kind: 'sticker', emoji, name }, 'sticker'); emit('ui:refreshConvList'); }
  catch (e) { toast(e.message, 'err'); }
}

/** 拍一拍。uid 省略时取当前会话默认对象（私聊为对端）。 */
async function sendPoke(uid = '') {
  const target = uid || targetIds()[0] || '';
  // 后缀由发起方决定，渲染时会补上被拍者的昵称，因此默认不带「我」
  const suffix = (state.me?.poke) || '拍了拍';
  try { await post('poke', { kind: 'poke', target, suffix }, 'poke'); }
  catch (e) { toast(e.message, 'err'); }
}

async function sendFiles() {
  const files = await pickFiles('*/*', true);
  for (const f of files) {
    try {
      toast(`正在加密并上传 ${f.name}…`, 'info', 1500);
      const e = await C.encryptFile(f);
      const up = await api.upload(e.bytes, f.name);
      await post('file', {
        kind: 'file', fileId: up.id, name: f.name, size: f.size,
        mime: f.type || 'application/octet-stream', key: e.key, iv: e.iv,
      }, 'file');
      toast('已发送', 'ok');
      emit('ui:refreshConvList');
    } catch (err) { toast(err.message || '发送失败', 'err'); }
  }
}

/** 语音消息：录音结果走和文件完全相同的「浏览器内加密 → 上传」通道，服务端只见密文 */
async function sendVoice() {
  // 拉黑后服务端会拒收，这里直接挡掉，避免录了半天才发现发不出去
  if ((current.conv || '').startsWith('p:') && current.peer?.blocked) {
    toast('已拉黑该用户，无法发送消息', 'err'); return;
  }
  const rec = await recordVoice();
  if (!rec || !rec.blob) return;
  try {
    toast('正在加密并上传语音…', 'info', 1500);
    const m = rec.mime || 'audio/webm';
    const ext = m.includes('mp4') ? 'm4a' : m.includes('ogg') ? 'ogg' : 'webm';
    const file = new File([rec.blob], `语音消息-${new Date().toISOString().slice(11, 19)}.${ext}`, { type: m });
    const e = await C.encryptFile(file);
    const up = await api.upload(e.bytes, file.name);
    await post('voice', {
      kind: 'voice', fileId: up.id, name: file.name, size: file.size,
      mime: m, key: e.key, iv: e.iv,
      duration: rec.duration, wave: rec.wave,
    }, 'voice');
    toast('已发送', 'ok');
    emit('ui:refreshConvList');
  } catch (err) { toast(err.message || '语音发送失败', 'err'); }
}

function setQuote(msg, payload) {
  const text = payload.kind === 'text' ? payload.text : `[${hintOf(payload.kind)}]`;
  current.setQuote(msg, { ...payload, text });
}

/** 把某个消息节点就地标记为「已撤回」，并让后续右键菜单据此失效 */
function markNodeRecalled(node) {
  if (!node) return;
  node.dataset.recalled = '1';
  node.classList.add('is-recalled');
}

async function recall(msg, node) {
  // 防御三重：DOM 状态 / 消息对象 / 服务端多数读取到的是同一条记录
  if (node && node.dataset.recalled === '1') { toast('这条消息已经撤回过了', 'info'); return; }
  if (msg.recalled) { toast('这条消息已经撤回过了', 'info'); return; }
  if (msg._pending || String(msg.id || '').startsWith('tmp:')) {
    toast('消息还在发送中，请稍候再撤回', 'info'); return;
  }
  if (!await confirm('撤回这条消息？', { okText: '撤回' })) return;
  try {
    await api.post('/api/chat/recall', { conv: current.conv, mid: msg.id });
    msg.recalled = true;
    markNodeRecalled(node || document.querySelector(`.msg[data-id="${msg.id}"]`));
    toast('已撤回', 'ok');
  } catch (e) {
    // 服务端已判定撤回过（例如另一台设备刚撤）：本地同步成已撤回，别让用户反复点
    if (e.code === 'already_recalled') {
      msg.recalled = true;
      markNodeRecalled(node || document.querySelector(`.msg[data-id="${msg.id}"]`));
      toast('这条消息已经撤回过了', 'info');
      return;
    }
    toast(e.message, 'err');
  }
}

/* ---------------- 表情面板 ---------------- */
async function toggleEmoji(panel) {
  panel.hidden = !panel.hidden;
  if (!panel.hidden && !panel.dataset.built) {
    panel.dataset.built = '1';
    const groups = (await api.get('/api/meta/emoji')).groups || [];
    const tabs = el('div', { class: 'emoji-panel__tabs' });
    const grid = el('div', { class: 'emoji-panel__grid' });
    const custom = el('div', { class: 'emoji-panel__custom' });
    const foot = el('div', { class: 'emoji-panel__foot' });

    const switchTab = (name, items) => {
      grid.innerHTML = '';
      items.forEach((e) => grid.appendChild(el('button', { class: 'emoji-panel__cell', text: e, onClick: () => {
        const ta = $('#stage textarea'); if (ta) { ta.value += e; ta.dispatchEvent(new Event('input')); }
      } })));
      tabs.querySelectorAll('.emoji-panel__tab').forEach((t) => t.classList.toggle('is-active', t.textContent === name));
      grid.hidden = name === '自定义'; custom.hidden = name !== '自定义';
    };

    groups.forEach((g, i) => {
      tabs.appendChild(el('button', { class: 'emoji-panel__tab' + (i === 0 ? ' is-active' : ''), text: g.name, onClick: () => switchTab(g.name, g.items) }));
    });
    tabs.appendChild(el('button', { class: 'emoji-panel__tab', text: '自定义', onClick: () => { switchTab('自定义', []); renderCustom(); } }));

    async function renderCustom() {
      custom.innerHTML = '';
      const list = await C.customStickers();
      (list || []).forEach((s) => {
        custom.appendChild(el('div', { class: 'sticker-cell', title: s.name, onClick: () => sendSticker(s.emoji, s.name) }, [
          el('span', { text: s.emoji }),
          el('button', { class: 'sticker-cell__del', title: '删除', html: icon('x', 13), onClick: async (e) => { e.stopPropagation(); await C.removeSticker(s.id); renderCustom(); } }),
        ]));
      });
      custom.appendChild(el('div', { class: 'sticker-cell', html: icon('plus', 28), onClick: async () => {
        const v = await new Promise((res) => {
          modal({ title: '添加自定义表情', body: el('div', { class: 'form' }, [
            el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '表情（emoji 或文字）' }), el('input', { class: 'input', id: 'csEmoji', value: '😎' })]),
            el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '名称' }), el('input', { class: 'input', id: 'csName', value: '我的表情' })]),
          ]), footer: [{ text: '取消', onClick: () => res(null) }, { text: '添加', kind: 'primary', onClick: () => res({ e: document.querySelector('#csEmoji').value, n: document.querySelector('#csName').value }) }] });
        });
        if (v && v.e) { await C.addSticker(v.e, v.n || v.e); renderCustom(); }
      } }));
    }

    const pack = (await api.get('/api/meta/emoji')).stickers || [];
    pack.forEach((s) => foot.appendChild(el('button', { class: 'sticker-cell', style: { width: '38px', height: '38px', fontSize: '20px' }, text: s.emoji, title: s.name, onClick: () => sendSticker(s.emoji, s.name) })));
    foot.appendChild(el('span', { class: 'muted', style: { fontSize: '11px' }, text: '内置表情包 · 点击直发' }));

    panel.append(tabs, grid, custom, foot);
    switchTab(groups[0]?.name || '', groups[0]?.items || []);
    custom.hidden = true;
  }
}

/* ---------------- 表情回应（reactions） ---------------- */
/* 回应表情由服务端白名单校验，清单走 /api/meta/emoji 下发；这里留一份兜底，
   接口拿不到时（服务端未升级 / 网络异常）也不至于完全点不动。 */
const FALLBACK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '🙏', '👏', '💯'];
let reactEmojis = null;

async function getReactEmojis() {
  if (reactEmojis) return reactEmojis;
  try {
    const r = await api.get('/api/meta/emoji');
    reactEmojis = (r.reactions || []).length ? r.reactions : FALLBACK_REACTIONS;
  } catch { reactEmojis = FALLBACK_REACTIONS; }
  return reactEmojis;
}

/** 表情选择浮层：与右键菜单同一套「点外面就关」的逻辑，只是内容换成一排 emoji */
export async function openReactPicker(x, y, onPick) {
  const list = await getReactEmojis();
  document.querySelectorAll('.react-picker').forEach((n) => n.remove());
  const box = el('div', {
    class: 'react-picker',
    style: { left: `${Math.max(8, Math.min(x, innerWidth - 300))}px`, top: `${y}px` },
  });
  for (const e of list) {
    box.appendChild(el('button', {
      class: 'react-picker__item', type: 'button', text: e, title: `回应 ${e}`,
      onClick: () => { box.remove(); onPick(e); },
    }));
  }
  document.body.appendChild(box);
  // 贴着视口底部时改成向上弹，别把浮层甩到屏幕外
  const r = box.getBoundingClientRect();
  if (r.bottom > innerHeight - 8) box.style.top = `${Math.max(8, y - r.height - 24)}px`;
  const off = (ev) => { if (!box.contains(ev.target)) { box.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 10);
}

async function toggleReact(node, emoji) {
  const msg = node._msg;
  const mid = Number(node.dataset.id || 0);
  if (!msg || !mid) return;
  const prev = { ...(msg.reactions || {}) };
  const had = (prev[emoji] || []).includes(state.me.id);
  const next = (prev[emoji] || []).filter((u) => u !== state.me.id);
  if (!had) next.push(state.me.id);           // 同一表情再点一次 = 取消
  const rs = { ...prev };
  if (next.length) rs[emoji] = next; else delete rs[emoji];

  // 乐观更新：点了立刻变，服务端回包后再对齐一次（广播事件也会再来一遍）
  msg.reactions = rs;
  paintReactions(node, rs);
  try {
    const r = await api.post('/api/chat/react', { conv: msg.conv || current.conv, mid, emoji });
    msg.reactions = r.reactions || rs;
    paintReactions(node, msg.reactions);
  } catch (e) {
    msg.reactions = prev;                     // 失败就回滚到点击前，别留下假状态
    paintReactions(node, prev);
    toast(e.message || '回应失败', 'err');
  }
}

function paintReactions(node, reactions) {
  const col = node.querySelector('.msg__col');
  if (!col) return;
  let row = col.querySelector(':scope > .msg__reactions');
  const entries = Object.entries(reactions || {}).filter(([, uids]) => uids && uids.length);
  if (!entries.length) { if (row) row.remove(); return; }   // 没人回应就不占位
  if (!row) { row = el('div', { class: 'msg__reactions' }); col.appendChild(row); }
  row.textContent = '';
  for (const [emoji, uids] of entries) row.appendChild(reactChip(node, emoji, uids));
}

function reactChip(node, emoji, uids) {
  const chip = el('button', {
    class: 'msg__react' + (uids.includes(state.me.id) ? ' is-mine' : ''),
    type: 'button',
    title: `${uids.length} 人回应`,
    onClick: () => toggleReact(node, emoji),
  }, [
    el('span', { class: 'msg__react-emoji', text: emoji }),
    el('span', { class: 'msg__react-count', text: String(uids.length) }),
  ]);
  fillReactTitle(chip, uids);
  return chip;
}

async function fillReactTitle(chip, uids) {
  const names = [];
  for (const u of uids) {
    if (u === state.me.id) { names.push('我'); continue; }
    const p = await peekUser(u).catch(() => null);
    names.push((p && (p.remark || p.nickname)) || '某人');
  }
  const shown = names.slice(0, 8).join('、');
  chip.title = names.length > 8 ? `${shown} 等 ${names.length} 人回应` : `${shown}回应`;
}

/** 实时回应：服务端推的是整条消息的 reactions 全量，就地重画即可，不用重建节点 */
export function handleReact(data) {
  if (!scrollEl || !data || data.conv !== state.activeConv) return;
  const node = scrollEl.querySelector(`.msg[data-id="${data.id}"]`);
  if (!node) return;
  if (node._msg) node._msg.reactions = data.reactions || {};
  paintReactions(node, data.reactions || {});
}

/* ---------------- 实时消息接入 ---------------- */
export function handleIncoming(data) {
  if (!data || data.conv !== state.activeConv) {
    // 别的会话里被人点名了：只靠列表上一行小字容易漏看，这里补一个明确回执
    if (data && Array.isArray(data.mentions) && data.from !== state.me.id
        && (data.mentions.includes(state.me.id) || data.mentions.includes('all'))) {
      toast('有人提到了你', 'info');
    }
    emit('ui:refreshConvList');
    return;
  }
  appendIncoming(data);
}

export async function appendIncoming(msg) {
  if (!scrollEl) return;
  const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120;

  // 自己刚发出去的消息（乐观渲染已上屏）：更新为正式节点，不要重复插入
  const cid = msg.client_id || '';
  if (cid && pendingNodes.has(cid)) {
    const old = pendingNodes.get(cid);
    pendingNodes.delete(cid);
    const fresh = await renderMessage(msg);
    old.replaceWith(fresh);
    scrollToBottom(true, true);
    return;
  }
  // 兜底：同一条消息已在界面里（重连补推 / 重复广播）则忽略
  if (msg.id && scrollEl.querySelector(`.msg[data-id="${msg.id}"]`)) return;

  // 渲染是异步的，期间可能已经切走会话：渲染完重新取一次容器，
  // 并且会话不匹配就直接丢弃，避免把消息插进别的会话
  const node = await renderMessage(msg);
  if (msg.conv && current && current.conv && msg.conv !== current.conv) return;
  const sc = (current && current.scroll) || scrollEl;
  if (!sc) return;
  const mine = msg.from === state.me.id;
  sc.appendChild(node);
  trimMessages(sc);
  if (atBottom || mine) scrollToBottom(mine, true);
  api.post('/api/chat/read', { conv: msg.conv }).catch(() => {});
}

export function handleRecall(data) {
  if (!scrollEl || data.conv !== state.activeConv) return;
  const node = scrollEl.querySelector(`.msg[data-id="${data.id}"]`);
  if (!node) return;
  markNodeRecalled(node);                 // 标记后右键菜单不再出现「撤回」
  const bubble = node.querySelector('.msg__bubble');
  if (bubble) {
    bubble.className = 'msg__bubble is-poke';
    bubble.textContent = data.by === state.me.id ? '你撤回了一条消息' : '消息已被撤回';
  }
}

/* 切到别的标签页 / 关闭页面前补一次草稿落库。
   pagehide 与 visibilitychange 都要挂：前者覆盖关闭与前进后退缓存，
   后者覆盖切 App / 切标签页（这些场景不触发 pagehide）。请求可能被浏览器掐断，
   所以只在尽力而为的层面做 —— 真正的兜底是 600ms 的防抖写入。 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDraft();
});
window.addEventListener('pagehide', flushDraft);

export function currentConv() { return current.conv; }
export function refreshChatHead() { if (current.conv) renderChatView().valueOf(); }
export { sendSticker, sendText, sendPoke, sendFiles, loadMessages };
