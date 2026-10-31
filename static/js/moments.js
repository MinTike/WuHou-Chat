/* ============================================================
   动态（朋友圈）：发布 / 浏览 / 点赞 / 评论 / 转发 / 删除
   正文与媒体均为加密存储，密钥按可见好友用 RSA 逐个包裹。
   ============================================================ */
import { el, avatar, fmtRelative, isImage, isVideo, pickFiles, fmtSize, nameNode } from './util.js';
import { api } from './api.js';
import { toast, modal, confirm, lightbox } from './ui.js';
import * as C from './crypto.js';
import { state, ensureGroupKey, emit, loadTags } from './state.js';
import { openUserCard, openAddFriend } from './cards.js';
import { icon, icoHtml } from './icons.js';
import { guardText } from './badwords.js';
import { tagChip } from './tags.js';

const mediaUrl = new Map();

const SCOPE_HINTS = {
  all: '所有好友都能看到',
  allow: '只有被选中的好友能看到（未选中者一律不可见）',
  deny: '被选中的好友看不到，其余好友都能看到',
  self: '只有你自己能看到',
  tag: '只有被分到所选分组的好友能看到',
  friends: '只有你的好友能看到（不进公开广场，非好友看不到）',
};

/**
 * 可见范围名单选择器：allow / deny 选好友，tag 选分组，其余范围不显示。
 * scope 与 picks 都由调用方持有，这里只负责按当前 scope 渲染。
 */
function buildAudiencePicker(getScope, picks) {
  const box = el('div', { class: 'privacy-picker' });
  const refresh = () => {
    box.innerHTML = '';
    const scope = getScope();
    if (scope === 'tag') {
      const list = state.tags || [];
      if (!list.length) {
        box.appendChild(el('div', { class: 'muted', style: { padding: '4px 0' }, text: '还没有好友分组，去通讯录先给好友打个标签' }));
        return;
      }
      list.forEach((t) => box.appendChild(tagChip(t, {
        active: picks.has(t.id), count: t.count, small: true,
        onClick: () => { picks.has(t.id) ? picks.delete(t.id) : picks.add(t.id); refresh(); },
      })));
      return;
    }
    if (!state.friends.length) {
      box.appendChild(el('div', { class: 'muted', style: { padding: '4px 0' }, text: '还没有好友可选' }));
      return;
    }
    state.friends.forEach((f) => box.appendChild(el('button', {
      class: 'chip' + (picks.has(f.id) ? ' is-active' : ''), type: 'button',
      onClick: () => { picks.has(f.id) ? picks.delete(f.id) : picks.add(f.id); refresh(); },
    }, [nameNode(f, { single: false })])));
  };
  return { box, refresh };
}

/** 「tag」范围需要分组列表，标签通常已在登录时加载，这里兜一次保证是最新的 */
function warmTags(after) {
  loadTags().then(() => { if (typeof after === 'function') after(); }).catch(() => {});
}

/** 动态侧栏（好友动态 / 动态广场 共用一份）：两个投放目的地在一处切换，
 *  不在两个视图里各维护一套重复部件，避免改一处忘一处。
 *  current: 'friends' | 'square' —— 决定默认高亮与「发布动态」的投放目标。 */
export async function renderSide(host, current = 'friends') {
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'side__group-title' }, [el('span', { text: '动态' })]));

  const isSquare = current === 'square';
  const SIDE = isSquare
    ? { key: 'square', title: '动态广场', sub: '精选 · 关注 · 我的', ico: 'globe',
        grad: 'linear-gradient(135deg,#35d6ff,#7c6cff)' }
    : { key: 'friends', title: '好友动态', sub: '仅好友可见 · 加密存储', ico: 'users',
        grad: 'linear-gradient(135deg,#25d9c6,#7c5cff)' };

  // 只列当前所在的这一处：导航交给左侧 rail（和页头按钮），侧栏里再摆一份就是重复部件
  host.appendChild(el('div', {
    class: 'contact-item is-active', dataset: { sq: SIDE.key },
    onClick: () => (isSquare ? renderSquare() : renderStage()),
  }, [
    el('div', { class: 'avatar', style: { background: SIDE.grad }, html: icon(SIDE.ico, 20) }),
    el('div', { class: 'grow' }, [
      el('div', { class: 'contact-item__name', text: SIDE.title }),
      el('div', { class: 'contact-item__sub', text: SIDE.sub }),
    ]),
  ]));

  host.appendChild(el('button', {
    class: 'btn btn--primary btn--block', style: { margin: '10px 8px' },
    dataset: { sidepub: SIDE.key },
    text: '发布动态',
    onClick: () => openPublish(SIDE.key),
  }));
}

/** 统一密钥模式下，动态与聊天共用全局密钥句柄，刷新后仍可解密 */
async function momentRawKey() {
  try { return await C.ensureGlobal(); } catch { return null; }
}

/* ================= 好友动态（仅好友可见，原有的朋友圈视图） ================= */
export async function renderStage() {
  const stage = document.querySelector('#stage');
  stage.innerHTML = '';
  const body = el('div', { class: 'view__body' });
  const feed = el('div', { class: 'moments', dataset: { feedlist: 'friends' } });

  const compose = el('div', { class: 'moments__compose' }, [
    avatar(state.me || {}, '', { status: false }),
    el('button', {
      class: 'input grow', style: { textAlign: 'left', color: 'var(--muted)', height: '42px' },
      text: '分享此刻…（文字 / 图片 / 视频，加密存储）',
      onClick: () => openPublish('friends'),
    }),
  ]);
  feed.appendChild(compose);

  const loading = el('div', { class: 'center', style: { padding: '40px' } }, [el('span', { class: 'spinner' })]);
  feed.appendChild(loading);

  const view = el('div', { class: 'view' }, [
    el('div', { class: 'view__head' }, [
      el('div', { class: 'view__title', text: '好友动态' }),
      el('span', { class: 'view__sub', text: '仅好友可见 · 加密存储' }),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn btn--sm', text: '去广场 ›', onClick: () => emit('ui:nav', 'msquare') }),
    ]),
    body,
  ]);
  body.appendChild(feed);
  stage.appendChild(view);

  let list = [];
  try { list = (await api.get('/api/moments/feed?limit=40')).moments || []; }
  catch { list = []; }
  loading.remove();

  if (!list.length) {
    feed.appendChild(el('div', { class: 'empty', style: { padding: '50px 20px' } }, [
      el('div', { class: 'empty__icon', html: icon('sparkles', 44, 1.5) }),
      el('div', { class: 'empty__title', text: '还没有动态' }),
      el('div', { class: 'empty__sub', text: '发布第一条动态，或添加好友后查看他们的分享' }),
    ]));
    return;
  }
  for (const m of list) feed.appendChild(await momentNode(m));
}

/* ================= 动态广场（精选 / 关注 / 我的 × 最新 / 热度，全站公开） ================= */
const SQUARE_TABS = [['featured', '精选'], ['following', '关注'], ['mine', '我的']];
const squareState = { tab: 'featured', sort: 'latest' };

export async function renderSquare(tab = squareState.tab, sort = squareState.sort) {
  squareState.tab = SQUARE_TABS.some(([k]) => k === tab) ? tab : 'featured';
  squareState.sort = sort === 'hot' ? 'hot' : 'latest';

  const stage = document.querySelector('#stage');
  stage.innerHTML = '';
  const body = el('div', { class: 'view__body' });
  const wrap = el('div', { class: 'msquare', dataset: { feedlist: 'square' } });

  /* 页头：标题 + 副标题 + 发布 */
  wrap.appendChild(el('div', { class: 'msquare__head' }, [
    el('div', {}, [
      el('div', { class: 'view__title', text: '动态' }),
      el('div', { class: 'msquare__sub', text: '匿名之中，也值得留下温度' }),
    ]),
    el('div', { class: 'grow' }),
    el('button', { class: 'btn btn--primary msquare__pub', onClick: () => openPublish('square') }, [
      el('span', { class: 'btn__ico', html: icon('sparkles', 15) }),
      el('span', { text: '发布动态' }),
    ]),
  ]));

  /* 一级分段：精选 / 关注 / 我的 */
  const seg = el('div', { class: 'seg msquare__seg' });
  SQUARE_TABS.forEach(([k, t]) => {
    seg.appendChild(el('button', {
      class: 'seg__item' + (k === squareState.tab ? ' is-active' : ''), type: 'button', text: t,
      onClick: () => renderSquare(k, squareState.sort),
    }));
  });
  wrap.appendChild(seg);

  /* 二级筛选：最新 / 热度 */
  const sorts = el('div', { class: 'msquare__sorts' });
  [['latest', '最新'], ['hot', '热度']].forEach(([k, t]) => {
    sorts.appendChild(el('button', {
      class: 'msquare__sort' + (k === squareState.sort ? ' is-active' : ''), type: 'button', text: t,
      onClick: () => renderSquare(squareState.tab, k),
    }));
  });
  wrap.appendChild(sorts);

  const grid = el('div', { class: 'mgrid' });
  const loading = el('div', { class: 'center', style: { padding: '40px' } }, [el('span', { class: 'spinner' })]);
  grid.appendChild(loading);
  wrap.appendChild(grid);

  const view = el('div', { class: 'view' }, [
    el('div', { class: 'view__head' }, [
      el('div', { class: 'view__title', text: '动态广场' }),
      el('span', { class: 'view__sub', text: '全站公开内容 · 加密存储 · 按社区规范核查' }),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn btn--sm', text: '‹ 好友动态', onClick: () => emit('ui:nav', 'moments') }),
    ]),
    body,
  ]);
  body.appendChild(wrap);
  stage.appendChild(view);

  let list = [];
  try {
    list = (await api.get(`/api/moments/square/feed?tab=${squareState.tab}&sort=${squareState.sort}&limit=40`)).moments || [];
  } catch { list = []; }
  loading.remove();

  if (!list.length) {
    const sub = squareState.tab === 'following'
      ? '关注感兴趣的人，他们的新动态会出现在这里'
      : squareState.tab === 'mine'
        ? '发布时选择「投放到动态广场」，内容会出现在这里'
        : '还没有公开内容，发布时选择「动态广场」即可出现在这里';
    grid.appendChild(el('div', { class: 'empty', style: { padding: '50px 20px', gridColumn: '1 / -1' } }, [
      el('div', { class: 'empty__icon', html: icon('sparkles', 44, 1.5) }),
      el('div', { class: 'empty__title', text: '这里还很安静' }),
      el('div', { class: 'empty__sub', text: sub }),
    ]));
    return;
  }
  for (const m of list) grid.appendChild(await momentNode(m));
}

/** 某位用户的动态主页：资料 hero（统计 + 关注/私信/拉黑）+ 动态列表 */
export async function renderUserMoments(uid, name = '') {
  const stage = document.querySelector('#stage');
  stage.innerHTML = '';

  let data = null;
  let st = null;
  // 「查看动态」看的是对方投放到「动态广场」的内容（与用户卡片入口一致）
  try { data = await api.get(`/api/moments/user/${uid}?limit=50&feed=square`); }
  catch (e) {
    stage.appendChild(el('div', { class: 'view' }, [
      el('div', { class: 'view__head' }, [el('div', { class: 'view__title', text: '动态' })]),
      el('div', { class: 'view__body' }, [el('div', { class: 'empty', style: { padding: '50px 20px' } }, [
        el('div', { class: 'empty__title', text: '无法查看动态' }),
        el('div', { class: 'empty__sub', text: e.message || '请稍后重试' }),
      ])]),
    ]));
    return;
  }
  // api.get 已剥掉 {ok,data} 外壳，返回的就是内层对象，不要再取 .stats
  try { st = (await api.get(`/api/moments/stats/${uid}`)) || {}; } catch { st = {}; }

  const author = data.author || {};
  const list = data.moments || [];
  const isSelf = !!data.is_self;

  const feed = el('div', { class: 'moments' });

  /* ---- hero ---- */
  const statBox = (n, label) => el('div', { class: 'm-hero__stat' }, [
    el('b', { text: String(n ?? 0) }),
    el('span', { text: label }),
  ]);

  const followBtn = el('button', {
    class: 'btn btn--ok m-hero__follow' + (st.me_following ? ' is-on' : ''),
    text: st.me_following ? '已关注' : '关注',
  });
  followBtn.addEventListener('click', async () => {
    try {
      const r = await api.post(`/api/moments/follow/${uid}`);
      st.me_following = !!r.following;
      st.followers = r.followers;
      followBtn.classList.toggle('is-on', st.me_following);
      followBtn.textContent = st.me_following ? '已关注' : '关注';
      statFollowers.querySelector('b').textContent = String(r.followers ?? 0);
      toast(st.me_following ? '已关注，TA 的新动态会出现在广场「关注」页' : '已取消关注', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

  const statFollowers = statBox(st.followers, '粉丝');

  const hero = el('div', { class: 'm-hero' });
  hero.appendChild(el('div', { class: 'm-hero__main' }, [
    avatar(author, 'xl', { status: false }),
    el('div', { class: 'grow' }, [
      el('div', { class: 'm-hero__name' }, [
        nameNode(author, { single: false }),
        author.gender === 'male' ? el('span', { class: 'gmark gmark--m', title: '男', text: '♂' }) : null,
        author.gender === 'female' ? el('span', { class: 'gmark gmark--f', title: '女', text: '♀' }) : null,
        author.age ? el('span', { class: 'm-hero__age', text: `${author.age} 岁` }) : null,
      ]),
      author.signature ? el('div', { class: 'm-hero__sig', text: author.signature }) : null,
      el('div', { class: 'm-hero__handle', text: `@${author.username || ''}` }),
    ]),
    el('div', { class: 'm-hero__stats' }, [
      statBox(st.likes, '获赞'),
      statBox(st.following, '关注'),
      statFollowers,
    ]),
    el('div', { class: 'm-hero__acts' }, [
      isSelf ? el('span', { class: 'm-hero__selftip', text: '这是你的动态主页' }) : followBtn,
      isSelf ? null : el('button', {
        class: 'btn btn--primary', text: '发送私信',
        onClick: () => emit('ui:openConv', `p:${[state.me?.id, uid].sort().join(':')}`),
      }),
      isSelf ? null : el('button', {
        class: 'btn m-hero__block', text: '拉黑',
        onClick: async () => {
          if (!await confirm(`拉黑后你将看不到 ${author.nickname || 'TA'} 的动态与消息，确定？`, { danger: true, okText: '拉黑' })) return;
          try {
            await api.post('/api/users/block', { uid, block: true });
            toast('已拉黑', 'ok');
            emit('ui:nav', 'moments');
          } catch (e) { toast(e.message, 'err'); }
        },
      }),
    ]),
  ]));

  const view = el('div', { class: 'view' }, [
    el('div', { class: 'view__head' }, [
      el('button', {
        class: 'btn btn--sm btn--ghost', text: '← 返回',
        onClick: () => emit('ui:nav', 'moments'),
      }),
      el('div', { class: 'view__title' }, [
        nameNode(author, { text: `${name || author.remark || author.nickname || 'TA'} 的广场动态`, single: false }),
      ]),
      el('span', { class: 'view__sub', text: data.is_self ? '动态广场 · 加密存储' : `${list.length} 条可见` }),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn btn--sm', text: '回广场', onClick: () => emit('ui:nav', 'moments') }),
    ]),
    el('div', { class: 'view__body' }, [
      el('div', { class: 'mprofile' }, [hero, feed]),
    ]),
  ]);
  stage.appendChild(view);

  if (!data.visible_to_me) {
    feed.appendChild(el('div', { class: 'empty', style: { padding: '56px 20px' } }, [
      el('div', { class: 'empty__icon', html: icon('eyeClosed', 44, 1.5) }),
      el('div', { class: 'empty__title', text: '动态未对你开放' }),
      el('div', { class: 'empty__sub', text: data.hint || '对方未向陌生人开放动态，添加好友后即可查看' }),
      el('button', {
        class: 'btn btn--primary', style: { marginTop: '14px' }, text: '添加好友',
        onClick: () => openAddFriend(uid),
      }),
    ]));
    return;
  }

  if (!list.length) {
    feed.appendChild(el('div', { class: 'empty', style: { padding: '56px 20px' } }, [
      el('div', { class: 'empty__icon', html: icon('sparkles', 44, 1.5) }),
      el('div', { class: 'empty__title', text: data.is_self ? '你还没有往广场投稿' : '这里还没有动态' }),
      el('div', { class: 'empty__sub', text: data.is_self ? '在动态广场点「发布」写下第一条' : (data.hint || 'TA 还没有往动态广场发布过内容') }),
      data.is_self ? el('button', { class: 'btn btn--primary', style: { marginTop: '14px' }, text: '发布动态', onClick: () => openPublish() }) : null,
    ]));
    return;
  }

  if (data.hint) {
    feed.appendChild(el('div', {
      class: 'muted', style: { padding: '2px 0 10px', fontSize: '12.5px' }, text: '🔒 ' + data.hint,
    }));
  }
  for (const m of list) feed.appendChild(await momentNode(m));
}

async function decryptMoment(m) {
  const raw = await momentRawKey();
  if (!raw) return null;
  try { return await C.decryptGroup(raw, m.cipher); } catch { return null; }
}

/** 性别符号：♂ / ♀（保密不显示） */
function genderMark(g) {
  if (g === 'male') return el('span', { class: 'gmark gmark--m', title: '男', text: '♂' });
  if (g === 'female') return el('span', { class: 'gmark gmark--f', title: '女', text: '♀' });
  return null;
}

/** 点赞名单：谁赞了这条动态 —— 作者之外的人也能看，点头像继续看资料卡 */
async function presentLikers(mid) {
  let raw = { likes: [], count: 0 };
  try { raw = await api.get(`/api/moments/${mid}/likes`); }
  catch (e) { toast(e.message || '点赞名单拉取失败', 'err'); return; }
  const users = await Promise.all((raw.likes || []).slice(0, 60).map(async (x) => {
    if (x.id === state.me?.id) return state.me;
    try { const r = await api.get(`/api/users/${x.id}`); return r.user || x; } catch { return x; }
  }));
  const list = el('div', { class: 'mlike-list' });
  if (!users.length) {
    list.appendChild(el('div', { class: 'muted', style: { padding: '10px 2px' }, text: '还没有人点赞' }));
  } else {
    for (const u of users) {
      list.appendChild(el('div', {
        class: 'mlike-chip', dataset: { liker: u.id },
        onClick: () => openUserCard(u.id),
      }, [
        avatar(u, '', { status: false }),
        el('span', { class: 'mlike-chip__n', text: u.remark || u.nickname || '某人' }),
      ]));
    }
  }
  modal({ title: `${raw.count || users.length} 人赞过`, body: list });
}

/** 广场 / 主页通用动态卡：作者行 + 长文折叠 + 图标计数操作行 */
async function momentNode(m) {
  const payload = await decryptMoment(m);
  const author = m.author || {};
  const isMine = author.id && author.id === state.me?.id;
  const node = el('div', { class: 'moment moment--card' });

  /* 头部：头像 + 昵称 / 性别 / 精选置顶 + 日期 +（广场）关注按钮 */
  let followBtn = null;
  if (!isMine && author.id && m.me_following !== undefined) {
    followBtn = el('button', {
      class: 'mfollow' + (m.me_following ? ' is-on' : ''),
      text: m.me_following ? '已关注' : '关注',
      onClick: async () => {
        try {
          const r = await api.post(`/api/moments/follow/${author.id}`);
          m.me_following = !!r.following;
          followBtn.classList.toggle('is-on', m.me_following);
          followBtn.textContent = m.me_following ? '已关注' : '关注';
        } catch (e) { toast(e.message, 'err'); }
      },
    });
  }
  node.appendChild(el('div', { class: 'moment__head' }, [
    avatar(author, '', { status: true, onClick: () => openUserCard(author.id) }),
    el('div', { class: 'moment__headinfo' }, [
      el('div', { class: 'moment__authorline' }, [
        el('span', { class: 'moment__author', onClick: () => openUserCard(author.id) }, [
          nameNode(author, { text: author.remark || author.nickname || '匿名', single: false }),
        ]),
        genderMark(author.gender),
        m.pinned ? el('span', { class: 'tag tag--ok moment__ftag', text: '置顶' }) : null,
        m.featured ? el('span', { class: 'tag tag--warn moment__ftag', text: '精选' }) : null,
      ]),
      el('div', { class: 'moment__time', text: fmtRelative(m.ts) }),
    ]),
    followBtn,
  ]));

  const body = el('div', { class: 'moment__body' });
  node.appendChild(body);

  if (!payload) {
    body.appendChild(el('div', { class: 'moment__text muted', text: '🔒 无法解析这条动态（可能由旧版密钥加密）' }));
  } else {
    if (payload.text) {
      const t = String(payload.text);
      const textNode = el('div', { class: 'moment__text', text: t });
      if (t.length > 160) {
        textNode.classList.add('is-folded');
        const more = el('button', { class: 'moment__more', type: 'button', text: '展开全文 ⌄' });
        more.addEventListener('click', () => {
          const folded = textNode.classList.toggle('is-folded');
          more.textContent = folded ? '展开全文 ⌄' : '收起 ⌃';
        });
        body.append(textNode, more);
      } else {
        body.appendChild(textNode);
      }
    }
    const media = payload.media || [];
    if (media.length) {
      const cls = media.length === 1 ? 'moment__media--1' : media.length === 2 ? 'moment__media--2' : media.length === 4 ? 'moment__media--4' : '';
      const grid = el('div', { class: `moment__media ${cls}` });
      for (const item of media) grid.appendChild(await mediaNode(item));
      body.appendChild(grid);
    }
  }

  /* 点赞 / 评论 / 转发 */
  const likesHost = el('div', { class: 'moment__likes-host' });
  const renderLikes = async () => {
    const r = await api.get(`/api/moments/${m.id}`);
    const mm = r.moment || {};
    likesHost.innerHTML = '';
    if (Number(mm.like_count) > 0) {
      const lk = el('button', {
        class: 'moment__likes', type: 'button', dataset: { likers: m.id },
        title: '看看是谁赞的',
      }, [
        el('span', { class: 'moment__like-ico', html: icon('heart', 13) }),
        el('span', { text: `${mm.like_count} 人赞过` }),
        el('span', { class: 'moment__likes-more', text: '›' }),
      ]);
      lk.addEventListener('click', () => presentLikers(m.id));
      likesHost.appendChild(lk);
    }
    likeBtn.dataset.liked = mm.liked ? '1' : '';
    likeBtn.classList.toggle('is-on', !!mm.liked);
    likeBtn.lastChild.textContent = mm.liked
      ? (mm.like_count ? `已赞 ${mm.like_count}` : '已赞')
      : (mm.like_count ? `赞 ${mm.like_count}` : '赞');
    syncCount(mm.comment_count || 0);
  };
  /** 「评论 N」的计数：删完最后一条时尾巴要干净，不能留个孤零零的「评论」 */
  function syncCount(n) {
    commentBtn.lastChild.textContent = n ? `评论 ${n}` : '评论';
  }
  const likeBtn = el('button', { class: 'moment__act', dataset: { likeBtn: m.id } }, [
    el('span', { class: 'moment__act-ico', html: icon('heart', 16) }), el('span', { text: '赞' }),
  ]);
  likeBtn.addEventListener('click', async () => {
    try {
      await api.post(`/api/moments/${m.id}/like`);
      await renderLikes();
    } catch (e) { toast(e.message, 'err'); }
  });
  const commentBtn = el('button', { class: 'moment__act' }, [el('span', { class: 'moment__act-ico', html: icon('comment', 16) }), el('span', { text: '评论' })]);
  const commentsBox = el('div', { class: 'moment__comments' });
  commentsBox.hidden = true;
  commentBtn.addEventListener('click', async () => {
    commentsBox.hidden = !commentsBox.hidden;
    if (!commentsBox.hidden) await renderComments();
  });
  const forwardBtn = el('button', { class: 'moment__act' }, [el('span', { text: '↗️' }), el('span', { text: '转发' })]);
  forwardBtn.addEventListener('click', () => openForward(m, payload));

  const foot = el('div', { class: 'moment__foot' }, [likeBtn, commentBtn, forwardBtn]);
  if (m.can_delete) {
    foot.appendChild(el('button', { class: 'moment__act', title: '调整这条动态的可见范围', onClick: () => openVisibility(m) },
      [el('span', { class: 'moment__act-ico', html: icon('eye', 16) }), el('span', { text: '可见范围' })]));
    foot.appendChild(el('button', { class: 'moment__act', onClick: async () => {
      if (!await confirm('删除这条动态？', { danger: true, okText: '删除' })) return;
      await api.del(`/api/moments/${m.id}`); toast('已删除', 'ok'); renderStage();
    } }, [el('span', { class: 'moment__act-ico', html: icon('trash', 16) }), el('span', { text: '删除' })]));
  }
  body.append(likesHost, foot, commentsBox);
  renderLikes();

  /** 评论折叠：超过 6 条二级回复时折叠，避免长串对话把 Feed 撑爆 */
  const contractLimit = 6;

  async function renderComments() {
    commentsBox.innerHTML = '';
    const r = await api.get(`/api/moments/${m.id}`);
    const raw = await momentRawKey();
    syncCount(r.moment?.comment_count || 0);

    const list = (r.moment.comments || []).filter((c) => c && c.id);
    const roots = list.filter((c) => !c.reply_to);
    const kidsOf = (pid) => list.filter((c) => (c.root || c.reply_to) === pid);

    /* 回复目标：'' = 顶级评论；其余为某条评论的 id（二级封顶由服务端判定） */
    let replyTo = '';
    let replyName = '';

    const dec = async (cip) => {
      if (!raw) return '🔒 无法解密';
      try { return (await C.decryptGroup(raw, cip)).text; } catch { return '🔒 无法解密'; }
    };

    const buildLine = async (c, isChild) => {
      const who = c.author || {};
      const whoName = who.remark || who.nickname || '匿名';
      const line = el('div', { class: 'moment__comment' + (isChild ? ' is-reply' : '') });

      line.appendChild(el('b', { class: 'mc-who', title: '查看资料', onClick: () => openUserCard(who.id) }, [
        nameNode(who, { text: whoName, single: false }),
      ]));
      if (isChild && c.reply_name) {
        line.appendChild(el('span', { class: 'mc-reply', text: '回复' }));
        line.appendChild(el('b', { class: 'mc-who', title: '查看资料',
          onClick: () => (c.reply_id ? openUserCard(c.reply_id) : null), text: c.reply_name }));
      }
      line.appendChild(el('span', { text: '：' }));
      line.appendChild(el('span', { class: 'mc-text', text: await dec(c.cipher) }));

      // 操作：回复始终有，删除按服务端的 can_delete（自己的评论 / 自己动态下的评论）
      line.appendChild(el('button', {
        class: 'mc-act', type: 'button', text: '回复',
        onClick: () => { replyTo = c.id; replyName = whoName; focusComposer(); },
      }));
      if (c.can_delete) {
        line.appendChild(el('button', {
          class: 'mc-act is-danger', type: 'button', text: '删除',
          onClick: async () => {
            if (!await confirm(kidsOf(c.id).length
              ? `删除这条评论？它下面的 ${kidsOf(c.id).length} 条回复会一并删除`
              : '删除这条评论？', { danger: true, okText: '删除' })) return;
            await api.del(`/api/moments/${m.id}/comment/${c.id}`);
            toast('已删除', 'ok'); await renderComments(); renderLikes();
          },
        }));
      }
      if ((c.media || []).length) {
        const mb = el('div', { class: 'moment__comment-media' });
        for (const item of c.media) mb.appendChild(await mediaNode(item));
        line.appendChild(mb);
      }
      return line;
    };

    for (const root of roots) {
      commentsBox.appendChild(await buildLine(root, false));
      const kids = kidsOf(root.id);
      if (!kids.length) continue;
      const holder = el('div', { class: 'moment__replies' });
      const shown = [];
      const paintKids = async (upto) => {
        holder.innerHTML = '';
        shown.length = 0;
        for (const k of kids.slice(0, upto)) {
          const n = await buildLine(k, true);
          shown.push(n); holder.appendChild(n);
        }
        if (kids.length > upto) {
          holder.appendChild(el('button', {
            class: 'mc-more', type: 'button', text: `展开其余 ${kids.length - upto} 条回复`,
            onClick: () => paintKids(kids.length),
          }));
        } else if (kids.length > contractLimit) {
          holder.appendChild(el('button', {
            class: 'mc-more', type: 'button', text: '收起',
            onClick: () => paintKids(contractLimit),
          }));
        }
      };
      await paintKids(Math.min(kids.length, contractLimit));
      commentsBox.appendChild(holder);
    }

    /* ---- 评论输入：文字 + 图片 / 视频，可切换回复目标 ---- */
    const pend = [];
    const pendBox = el('div', { class: 'moment__media' });
    const targetBar = el('div', { class: 'mc-target' });
    targetBar.hidden = true;

    const renderTarget = () => {
      targetBar.innerHTML = '';
      if (!replyTo) { targetBar.hidden = true; input.placeholder = '写评论…（加密存储，回车发送）'; return; }
      targetBar.hidden = false;
      targetBar.appendChild(el('span', { class: 'mc-target__text', text: `回复 ${replyName}：` }));
      targetBar.appendChild(el('button', { class: 'mc-target__x', type: 'button', text: '✕', title: '取消回复',
        onClick: () => { replyTo = ''; replyName = ''; renderTarget(); input.focus(); } }));
      input.placeholder = `回复 ${replyName}…`;
    };
    const focusComposer = () => { renderTarget(); input.focus(); input.scrollIntoView({ block: 'nearest' }); };

    const send = async () => {
      const t = String(input.value || '').trim();
      if ((!t && !pend.length) || !raw) return;
      input.value = '';
      await api.post(`/api/moments/${m.id}/comment`, {
        mid: m.id, cipher: await C.encryptGroup(raw, { text: t }),
        reply_to: replyTo, media: pend.splice(0, pend.length),
      });
      pendBox.innerHTML = '';
      replyTo = ''; replyName = '';
      await renderComments(); renderLikes();
    };
    const input = el('input', { class: 'input', placeholder: '写评论…（加密存储，回车发送）', style: { height: '34px' } });
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape' && replyTo) { replyTo = ''; replyName = ''; renderTarget(); return; }
      if (e.key === 'Enter') await send();
    });
    const mediaBtn = el('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: '＋ 图片 / 视频', onClick: async () => {
      const files = await pickFiles('image/*,video/*', true);
      for (const f of files) {
        if (pend.length >= 4) break;
        const enc = await C.encryptFile(f);
        const up = await api.upload(enc.bytes, f.name);
        pend.push({ fileId: up.id, name: f.name, size: f.size, mime: f.type || '', key: enc.key, iv: enc.iv });
        pendBox.appendChild(el('span', { class: 'tag tag--accent', text: (isVideo(f.name) ? '🎬 ' : '🖼 ') + f.name.slice(0, 12) }));
      }
    } });
    commentsBox.append(targetBar, pendBox, el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, [
      input, mediaBtn,
      el('button', { class: 'btn btn--sm btn--primary', type: 'button', text: '发送', onClick: send }),
    ]));
    renderTarget();
  }

  renderLikes();
  return node;
}

async function mediaNode(item) {
  const holder = el('div', { class: 'moment__media-item' }, [el('div', { class: 'skeleton', style: { width: '100%', height: '100%' } })]);
  (async () => {
    try {
      const url = await mediaObjectUrl(item);
      holder.innerHTML = '';
      if (isVideo(item.name)) holder.appendChild(el('video', { src: url, muted: true, playsinline: true }));
      else holder.appendChild(el('img', { src: url, alt: item.name || '' }));
      holder.addEventListener('click', () => lightbox(url, isVideo(item.name), { name: item.name, blob: mediaBlob.get(item.fileId) }));
    } catch { holder.innerHTML = '<div class="muted" style="font-size:11px">🔒 解密失败</div>'; }
  })();
  return holder;
}

/** 下载并解密媒体 → objectURL（带缓存；聊天里的动态分享卡片缩略图也复用它） */
const mediaBlob = new Map();   // fileId -> Blob（保存/预览直接用，避免 fetch(blob:) 被 CSP 拦）
export async function mediaObjectUrl(item) {
  let url = mediaUrl.get(item.fileId);
  if (!url) {
    const buf = await api.download(item.fileId);
    const pt = await C.decryptFile(buf, item.key, item.iv);
    const blob = new Blob([pt], { type: item.mime || 'application/octet-stream' });
    mediaBlob.set(item.fileId, blob);
    url = URL.createObjectURL(blob);
    mediaUrl.set(item.fileId, url);
  }
  return url;
}

/* ---------------- 已发布动态的可见范围调整 ---------------- */
const SCOPE_TEXT = {
  all: '全部好友可见', allow: '选中好友可见', deny: '选中好友不可见', self: '仅自己可见',
  tag: '选中分组可见',
};

export function openVisibility(m) {
  const body = el('div', { class: 'form' });
  let scope = m.scope || 'all';
  const picks = new Set(m.scope_list || []);
  const SCOPES = [['all', '全部好友'], ['allow', '谁可以看见'], ['deny', '谁不可以看见'], ['tag', '按分组'], ['self', '仅自己可见']];
  const picker = buildAudiencePicker(() => scope, picks);

  const seg = el('div', { class: 'seg' });
  const hint = el('div', { class: 'muted', style: { fontSize: '11.5px' } });
  const field = el('div', { class: 'field' });

  const render = () => {
    seg.innerHTML = '';
    SCOPES.forEach(([v, t]) => seg.appendChild(el('button', {
      class: 'seg__item' + (scope === v ? ' is-active' : ''), type: 'button', text: t,
      onClick: () => { scope = v; render(); },
    })));
    hint.textContent = SCOPE_HINTS[scope] || '';
    field.innerHTML = '';
    field.append(el('span', { class: 'field__label', text: '可见范围' }), seg, hint);
    if (scope === 'allow' || scope === 'deny' || scope === 'tag') {
      picker.refresh();
      field.appendChild(picker.box);
    }
  };
  render();
  warmTags(render);
  body.appendChild(el('div', { class: 'muted', style: { fontSize: '11.5px' }, text: `当前：${SCOPE_TEXT[m.scope] || '全部好友可见'} · ${m.visible_count || 0} 人可见` }));
  body.appendChild(field);

  modal({
    title: '调整可见范围', body, wide: false,
    footer: [{
      text: '保存', kind: 'primary', onClick: async () => {
        await api.patch(`/api/moments/${m.id}/visibility`, { scope, scope_list: Array.from(picks) });
        toast('可见范围已更新', 'ok');
        renderStage();
      }
    }, { text: '取消' }],
  });
}

/* ---------------- 发布 ---------------- */
export function openPublish(feedKind = 'friends') {
  const body = el('div', { class: 'form' });

  /* 投放目标由入口决定：从好友动态进来只投好友动态，从广场进来只投广场。
     不给互切开关 —— 文案、可见范围、加密方式都跟着目的地走，混选会让人发错地方。 */
  const feed = feedKind === 'square' ? 'square' : 'friends';
  const TARGET_INFO = {
    friends: { name: '好友动态', icon: 'users',
               hint: '只有你的好友能看到这条动态（加密存储）' },
    square: { name: '动态广场', icon: 'globe',
              hint: '全站登录用户可见，无需好友关系；加密存储并按社区规范核查，请勿包含隐私信息' },
  }[feed];

  const targetBar = el('div', { class: 'mpubtarget', dataset: { pubtarget: feed } }, [
    el('span', { class: 'mpubtarget__ico', html: icon(TARGET_INFO.icon, 15) }),
    el('div', { class: 'grow' }, [
      el('div', { class: 'mpubtarget__t' }, [
        el('span', { text: '发布到' }),
        el('b', { text: TARGET_INFO.name }),
      ]),
      el('div', { class: 'mpubtarget__hint', text: TARGET_INFO.hint }),
    ]),
  ]);
  body.appendChild(targetBar);

  const ta = el('textarea', {
    class: 'input', rows: 4,
    placeholder: feed === 'square'
      ? '这一刻的想法…（发布到动态广场，全站可见）'
      : '这一刻的想法…（加密存储，仅好友可见）',
    style: { height: 'auto', padding: '10px 12px', resize: 'vertical' },
  });
  const mediaBox = el('div', { class: 'moment__media' });
  const picked = [];
  const localUrls = [];   // 预览用的本地 URL，弹窗关闭时统一释放
  let uploadPending = 0;  // 仍有媒体在加密上传时不允许发布

  const addBtn = el('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: '＋ 图片 / 视频', onClick: async () => {
    const files = await pickFiles('image/*,video/*', true);
    for (const f of files) {
      if (picked.length >= 9) break;
      // 先落本地预览，让用户在加密上传过程中就能看到图片，而不是只看到图标
      const local = URL.createObjectURL(f);
      localUrls.push(local);
      const cell = el('div', { class: 'moment__media-item', style: { cursor: 'default' } });
      cell.appendChild(isVideo(f.name)
        ? el('video', { src: local, muted: true, playsinline: true, loop: true, autoplay: true })
        : el('img', { src: local, alt: f.name }));
      const badge = el('span', { class: 'media-badge', text: '加密上传中…' });
      cell.appendChild(badge);
      cell.appendChild(el('button', {
        class: 'sticker-cell__del', style: { opacity: '1' }, title: '移除', html: icon('x', 13),
        onClick: () => {
          const i = picked.findIndex((p) => p._cell === cell);
          if (i >= 0) picked.splice(i, 1);
          if (uploading) uploading._cancel = true;
          cell.remove();
        },
      }));
      mediaBox.appendChild(cell);

      const uploading = { _cancel: false };
      uploadPending++;
      try {
        const e = await C.encryptFile(f);
        const up = await api.upload(e.bytes, f.name);
        if (uploading._cancel) continue;
        const item = { fileId: up.id, name: f.name, size: f.size, mime: f.type || '', key: e.key, iv: e.iv };
        picked.push(item);
        item._cell = cell;
        badge.textContent = isVideo(f.name) ? '🎬 已加密' : '🖼 已加密';
        badge.classList.add('is-ok');
      } catch (err) {
        badge.textContent = '上传失败';
        badge.classList.add('is-err');
        toast(`「${f.name}」上传失败：${err.message || '请重试'}`, 'err');
      } finally {
        uploadPending--;
      }
    }
  } });

  /* 可见范围：
     好友动态 → 全部好友 / 谁可以看见 / 谁不可以看见 / 按分组 / 仅自己可见
     动态广场 → 所有人可见 / 好友可见 / 仅自己可见（广场是公开场合，三档足够清楚） */
  const SQUARE_SCOPES = [['all', '所有人可见'], ['friends', '好友可见'], ['self', '仅自己可见']];
  const FRIEND_SCOPES = [['all', '全部好友'], ['allow', '谁可以看见'], ['deny', '谁不可以看见'], ['tag', '按分组'], ['self', '仅自己可见']];
  const SCOPES = feed === 'square' ? SQUARE_SCOPES : FRIEND_SCOPES;
  let scope = feed === 'square'
    ? 'all'
    : (FRIEND_SCOPES.some(([v]) => v === state.me?.moments_scope) ? state.me.moments_scope : 'all');
  const picks = new Set(state.me?.moments_list || []);
  const picker = buildAudiencePicker(() => scope, picks);

  const scopeSeg = el('div', { class: 'seg', dataset: { pubscope: 'seg' } });
  const scopeHint = el('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '6px' } });
  const renderScope = () => {
    scopeSeg.innerHTML = '';
    SCOPES.forEach(([v, t]) => scopeSeg.appendChild(el('button', {
      class: 'seg__item' + (scope === v ? ' is-active' : ''), type: 'button', text: t,
      dataset: { pubscope: v },
      onClick: () => { scope = v; renderScope(); },
    })));
    scopeHint.textContent = SCOPE_HINTS[scope] || '';
    renderScopeField();
  };
  const scopeField = el('div', { class: 'field' }, [
    el('span', { class: 'field__label', text: '可见范围' }), scopeSeg, scopeHint,
  ]);
  const renderScopeField = () => {
    scopeField.innerHTML = '';
    scopeField.append(el('span', { class: 'field__label', text: '可见范围' }), scopeSeg, scopeHint);
    if (scope === 'allow' || scope === 'deny' || scope === 'tag') {
      picker.refresh();
      scopeField.appendChild(picker.box);
    }
  };
  renderScope();
  warmTags(renderScope);

  body.append(
    ta,
    el('div', { class: 'field' }, [el('span', { class: 'field__label', text: '媒体（已加密上传）' }), mediaBox, addBtn]),
    scopeField,
  );

  modal({
    title: '发布动态', body, wide: false,
    footer: [{
      text: '发布', kind: 'primary', onClick: async () => {
        const text = String(ta.value || '').trim();
        if (!text && !picked.length) { toast('写点什么或添加图片', 'err'); return false; }
        if (uploadPending > 0) { toast('媒体仍在加密上传中，请稍候…', 'info'); return false; }
        // 动态正文同样是加密存储，违规词只能在加密前于本地检测
        let body = text;
        try {
          const g = await guardText(text, 'moment');
          if (g.blocked) { toast(`内容包含违规词：${g.hits.join('、')}`, 'err'); return false; }
          if (g.masked) { body = g.text; toast(`已按社区规范打码：${g.hits.join('、')}`, 'warn'); }
        } catch { /* 词库不可用时放行 */ }
        const payload = { text: body, media: picked };
        // 会话密钥：随机 AES，按可见好友的公钥逐个包裹
        let audience = state.friends.map((f) => f.id);
        if (scope === 'self') audience = [];
        else if (scope === 'allow') audience = state.friends.filter((f) => picks.has(f.id)).map((f) => f.id);
        else if (scope === 'deny') audience = state.friends.filter((f) => !picks.has(f.id)).map((f) => f.id);
        // 按分组：服务端会用同一口径复核，这里展开是为了给这些成员逐个包裹动态密钥
        else if (scope === 'tag') audience = state.friends
          .filter((f) => (f.tags || []).some((t) => picks.has(t))).map((f) => f.id);
        const targets = [...new Set([...audience, state.me?.id].filter(Boolean))];
        let cipher, keys = {};
        if (feed === 'square') {
          // 广场是全站公开内容：直接用全局统一密钥加密，任何登录用户都能解开；
          // 可见性由服务端按「投放广场 = 公开」放行（双向拉黑仍被屏蔽）。
          const raw = await momentRawKey();
          if (!raw) { toast('加密密钥未就绪，请稍后重试', 'err'); return false; }
          cipher = await C.encryptGroup(raw, payload);
        } else {
          const r = await C.encryptFor(targets, payload);
          cipher = r.cipher; keys = r.keys;
        }
        await api.post('/api/moments', {
          cipher, keys, media: [],
          scope, scope_list: Array.from(picks), feed,
        });
        toast(feed === 'square'
          ? (scope === 'friends' ? '已发布（好友可见）' : scope === 'self' ? '已发布（仅自己可见）' : '已发布到动态广场')
          : (scope === 'self' ? '已发布（仅自己可见）' : '已发布'), 'ok');
        if (feed === 'square') { emit('ui:nav', 'msquare'); renderSquare('mine'); }
        else { emit('ui:nav', 'moments'); renderStage(); }
      }
    }, { text: '取消' }],
    onClose: () => { localUrls.forEach((u) => URL.revokeObjectURL(u)); },
  });
  setTimeout(() => ta.focus(), 80);
}

/* ---------------- 转发 ---------------- */
async function openForward(m, payload) {
  const body = el('div', { class: 'form' });
  const tabs = el('div', { class: 'seg' }, [
    el('button', { class: 'seg__item is-active', text: '好友' }),
    el('button', { class: 'seg__item', text: '群聊' }),
  ]);
  const listEl = el('div', { style: { maxHeight: '260px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' } });
  let mode = 'friend';
  const render = () => {
    listEl.innerHTML = '';
    const items = mode === 'friend' ? state.friends : state.groups;
    items.forEach((it) => {
      const row = el('div', { class: 'contact-item', onClick: async () => {
        await doForward(m, payload, mode === 'friend' ? `p:${[state.me.id, it.id].sort().join(':')}` : `g:${it.id}`, it.id, mode === 'group');
      } }, [
        avatar(mode === 'friend' ? it : { nickname: it.name }, 'sm', { status: mode === 'friend' }),
        el('div', { class: 'grow' }, [el('div', { class: 'contact-item__name' }, [
          nameNode(mode === 'friend' ? it : {}, { text: it.remark || it.nickname || it.name }),
        ])]),
      ]);
      listEl.appendChild(row);
    });
    if (!items.length) listEl.appendChild(el('div', { class: 'muted', style: { padding: '8px' }, text: '暂无可转发目标' }));
  };
  tabs.children[0].addEventListener('click', () => { mode = 'friend'; tabs.children[0].classList.add('is-active'); tabs.children[1].classList.remove('is-active'); render(); });
  tabs.children[1].addEventListener('click', () => { mode = 'group'; tabs.children[1].classList.add('is-active'); tabs.children[0].classList.remove('is-active'); render(); });
  body.append(tabs, listEl);
  modal({ title: '转发到…', body, footer: null });
  render();
}

async function doForward(m, payload, conv, targetUid, isGroup = false) {
  try {
    // ① 先在服务端登记分享副本：原动态的隐私设置对副本不再生效，接收人可凭 sid 查看
    const fr = await api.post(`/api/moments/${m.id}/forward`,
      isGroup ? { to: [], group: targetUid } : { to: [targetUid] });
    const sid = fr.shares?.[targetUid] || '';
    // ② 聊天消息里带上结构化快照（含 sid），接收端据此渲染分享卡片
    const snap = {
      kind: 'moment', mid: m.id, share: sid,
      text: payload?.text || '[动态]',
      media: (payload?.media || []).slice(0, 4),
      author: { id: m.author?.id || m.author || '', nickname: m.author?.nickname || '' },
      ts: m.ts,
    };
    let cipher, keys = {};
    if (isGroup) {
      const raw = await ensureGroupKey(targetUid);
      if (!raw) { toast('群密钥未就绪', 'err'); return; }
      cipher = await C.encryptGroup(raw, snap);
    } else {
      const r = await C.encryptFor([targetUid], snap);
      cipher = r.cipher; keys = r.keys;
    }
    await api.post('/api/chat/send', { conv, type: 'moment', cipher, keys, hint: 'moment' });
    toast('已转发', 'ok');
    document.querySelectorAll('.modal-scrim').forEach((n) => n.click());
    emit('ui:openConv', conv);
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- 分享卡片 → 动态详情 ---------------- */
/**
 * 查看一条被分享的动态（凭 sid 走 /share/{sid}，不受原动态隐私范围限制）。
 * @param {string} sid  分享记录 id
 * @param {string} back 返回目标（通常是来源会话 conv）
 */
export async function renderSharedMoment(sid, back = '') {
  const stage = document.querySelector('#stage');
  stage.innerHTML = '';
  const feed = el('div', { class: 'moments' });
  const loading = el('div', { class: 'center', style: { padding: '40px' } }, [el('span', { class: 'spinner' })]);
  feed.appendChild(loading);
  stage.appendChild(el('div', { class: 'view' }, [
    el('div', { class: 'view__head' }, [
      back ? el('button', { class: 'btn btn--sm btn--ghost', text: '← 返回', onClick: () => emit('ui:openConv', back) })
           : el('button', { class: 'btn btn--sm btn--ghost', text: '← 返回', onClick: () => emit('ui:nav', 'moments') }),
      el('div', { class: 'view__title', text: '动态详情' }),
      el('span', { class: 'view__sub', text: '来自好友的分享 · 加密存储' }),
    ]),
    el('div', { class: 'view__body' }, [feed]),
  ]));

  let m = null;
  try { m = (await api.get(`/api/moments/share/${encodeURIComponent(sid)}`)).moment; }
  catch (e) {
    loading.remove();
    feed.appendChild(el('div', { class: 'empty', style: { padding: '56px 20px' } }, [
      el('div', { class: 'empty__icon', html: icon('eyeClosed', 44, 1.5) }),
      el('div', { class: 'empty__title', text: '无法查看这条分享' }),
      el('div', { class: 'empty__sub', text: e.message || '分享可能已被撤销' }),
    ]));
    return;
  }
  loading.remove();

  const author = m.author || {};
  const note = el('div', { class: 'moment-share-note' }, [
    el('span', { class: 'moment-share-note__ico', html: icon('quote', 14) }),
    el('span', { text: `${m.shared_by?.remark || m.shared_by?.nickname || '好友'} 分享了 ${author.nickname || '好友'} 的动态 · 原动态的隐私设置对本分享不再生效` }),
  ]);
  feed.appendChild(note);
  feed.appendChild(await momentNode(m));
}
