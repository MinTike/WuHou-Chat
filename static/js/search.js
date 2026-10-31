/* ============================================================
   全局搜索：用户 / 群聊 / 聊天记录 / 动态
   聊天正文为密文，服务端只索引元数据，
   正文命中由本机解密索引（IndexedDB）补齐，两路结果合并展示。
   ============================================================ */
import { el, avatar, fmtRelative, debounce, nameNode } from './util.js';
import { api } from './api.js';
import { toast } from './ui.js';
import * as C from './crypto.js';
import { state, loadConvs, emit } from './state.js';
import { openUserCard, openGroupCard } from './cards.js';
import { icon, icoHtml } from './icons.js';

export function renderSide(host) {
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'side__group-title' }, [el('span', { text: '搜索' })]));
  host.appendChild(el('div', { class: 'muted', style: { padding: '4px 12px 12px', fontSize: '12px', lineHeight: '1.7' },
    text: '支持搜索用户昵称 / 用户名、群聊名称、聊天记录与动态内容。加密正文在本机解密后检索。' }));
}

/** 最近一次搜索词。点开结果里的用户 / 群聊卡片会触发全局刷新，把本页整个重画一遍；
 *  不留住这个词，用户关掉卡片回来就是一张空白页，只能重新输入再搜一遍。 */
let lastQuery = '';

export async function renderStage(initialQuery) {
  // 传了非空关键词 → 用它（并记住）；空 / 未传 → 恢复上一次的搜索状态
  const q = String(initialQuery || '').trim() || lastQuery;
  const stage = document.querySelector('#stage');
  stage.innerHTML = '';
  const results = el('div', { class: 'search-body' });

  const input = el('input', { class: 'input', placeholder: '输入关键词…', value: q });
  const bar = el('div', { style: { display: 'flex', gap: '8px' } }, [
    input,
    el('button', { class: 'btn btn--primary', text: '搜索', onClick: () => run(input.value) }),
  ]);

  const view = el('div', { class: 'view' }, [
    el('div', { class: 'view__head' }, [el('div', { class: 'view__title', text: '全局搜索' })]),
    el('div', { class: 'view__body' }, [el('div', { class: 'search-view' }, [bar, results])]),
  ]);
  stage.appendChild(view);
  setTimeout(() => input.focus(), 60);

  const runDebounced = debounce(run, 380);
  input.addEventListener('input', () => runDebounced(input.value));

  if (q) run(q);

  async function run(q) {
    const kw = String(q || '').trim();
    lastQuery = kw;
    results.innerHTML = '';
    if (!kw) {
      results.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty__icon', html: icon('search', 44, 1.5) }),
        el('div', { class: 'empty__title', text: '输入关键词开始搜索' }),
        el('div', { class: 'empty__sub', text: '聊天记录索引只建在浏览器本地，服务端不提供正文检索。' }),
      ]));
      return;
    }
    results.appendChild(el('div', { class: 'center', style: { padding: '30px' } }, [el('span', { class: 'spinner' })]));

    let data = { users: [], groups: [], messages: [], moments: [] };
    try { data = await api.get(`/api/search?q=${encodeURIComponent(kw)}`); } catch (e) { toast(e.message, 'err'); }
    // 本机明文索引只认「仍然有效」的会话：群已解散、对方已注销 / 封禁 / 被拉黑
    // 之后，会话会从服务端的会话列表里消失，这里同步过滤，避免旧记录被翻出来
    if (!state.convs.length) { try { await loadConvs(); } catch { /* ignore */ } }
    const alive = new Set((state.convs || []).map((c) => c.conv));
    let local = [];
    try { local = (await C.searchPlain(kw, 60)).filter((r) => alive.has(r.conv)); } catch { local = []; }

    results.innerHTML = '';
    const sec = (title, extra) => el('div', { class: 'search-group' }, [
      el('div', { class: 'search-sec__title' }, [el('span', { text: title }), extra || null]),
    ]);

    /* 用户 */
    const u = sec('用户', el('span', { text: `${(data.users || []).length} 个结果` }));
    const uBox = el('div', { class: 'search-group__list' });
    (data.users || []).forEach((p) => uBox.appendChild(el('div', { class: 'result-card tilt', dataset: { tilt: '4' }, onClick: () => openUserCard(p.id) }, [
      avatar(p, '', { status: true }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'list-item__title' }, [nameNode(p, { single: false })]),
        el('div', { class: 'result-card__snippet', text: `@${p.username} · ${p.signature || '无签名'}` }),
      ]),
      p.is_friend ? el('span', { class: 'tag tag--ok', text: '好友' }) : el('span', { class: 'tag', text: '非好友' }),
    ])));
    u.appendChild(uBox);
    results.appendChild(u);

    /* 群聊 */
    const g = sec('群聊', el('span', { text: `${(data.groups || []).length} 个结果` }));
    const gBox = el('div', { class: 'search-group__list' });
    (data.groups || []).forEach((p) => gBox.appendChild(el('div', { class: 'result-card tilt', dataset: { tilt: '4' }, onClick: () => openGroupCard(p.id) }, [
      el('div', { class: 'avatar', text: (p.name || '群').slice(0, 1) }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'list-item__title', text: p.name }),
        el('div', { class: 'result-card__snippet', text: `${p.member_count} 人 · ${p.intro || '无介绍'}` }),
      ]),
      p.joined ? el('span', { class: 'tag tag--ok', text: '已加入' }) : el('span', { class: 'tag', text: '未加入' }),
    ])));
    g.appendChild(gBox);
    results.appendChild(g);

    /* 聊天记录（服务端元数据 + 本机明文） */
    const m = sec('聊天记录', el('span', { text: `${(data.messages || []).length + local.length} 条` }));
    const mBox = el('div', { class: 'search-group__list' });
    for (const it of data.messages || []) {
      mBox.appendChild(el('div', { class: 'result-card tilt', dataset: { tilt: '4' }, onClick: () => emit('ui:openConv', it.conv) }, [
        avatar(it.from_user || {}, 'sm', { status: false }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'list-item__title', text: it.conv_title || '会话' }),
          el('div', { class: 'result-card__snippet', text: `${(it.from_user || {}).nickname || '系统'} · ${fmtRelative(it.ts)} · [${it.hint}]` }),
        ]),
        el('span', { class: 'tag', text: '元数据' }),
      ]));
    }
    for (const row of local) {
      const conv = state.convs.find((c) => c.conv === row.conv);
      mBox.appendChild(el('div', { class: 'result-card tilt', dataset: { tilt: '4' }, onClick: () => emit('ui:openConv', row.conv) }, [
        el('div', { class: 'avatar avatar--sm', html: icon('comment', 15) }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'list-item__title', text: conv ? conv.title : row.conv }),
          el('div', { class: 'result-card__snippet', text: row.text }),
        ]),
        el('span', { class: 'tag tag--accent', text: '本机解密' }),
      ]));
    }
    m.appendChild(mBox);
    results.appendChild(m);

    /* 动态 */
    const mo = sec('动态', el('span', { text: `${(data.moments || []).length} 条` }));
    const moBox = el('div', { class: 'search-group__list' });
    for (const it of data.moments || []) {
      let text = '🔒 密文（本机无密钥）';
      try {
        const raw = await C.kvGet('mk:' + it.id);
        if (raw) text = (await C.decryptGroup(raw, it.cipher)).text || '';
      } catch { /* ignore */ }
      moBox.appendChild(el('div', { class: 'result-card tilt', dataset: { tilt: '4' }, onClick: () => emit('ui:nav', 'moments') }, [
        avatar(it.author || {}, 'sm', { status: false }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'list-item__title' }, [
            nameNode(it.author || {}, { text: (it.author || {}).nickname || '匿名', single: false }),
          ]),
          el('div', { class: 'result-card__snippet', text: String(text).slice(0, 120) }),
        ]),
        el('span', { class: 'tag', text: fmtRelative(it.ts) }),
      ]));
    }
    mo.appendChild(moBox);
    results.appendChild(mo);

    if (!uBox.children.length && !gBox.children.length && !mBox.children.length && !moBox.children.length) {
      results.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty__icon', html: icon('search', 44, 1.5) }),
        el('div', { class: 'empty__title', text: '没有找到相关内容' }),
      ]));
    }
  }
}
