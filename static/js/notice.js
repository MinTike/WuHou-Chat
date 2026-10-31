/* ============================================================
   侧边「公告栏」与「捐赠本站栏」
   · 公告：结构化列表（独立于聊天记录），支持置顶 / 分级配色
   · 捐赠：内容由服务端下发（管理员在后台维护），前端不硬编码收款信息
   ============================================================ */
import { el, fmtRelative } from './util.js';
import { api } from './api.js';
import { toast, lightbox } from './ui.js';
import { icon, icoHtml } from './icons.js';
import { state } from './state.js';

let activePane = 'notice';
let cache = { list: null, ts: 0, donate: null, donateTs: 0 };

const LEVEL_STYLE = {
  info: { label: '公告', color: 'var(--accent)' },
  success: { label: '喜讯', color: 'var(--ok)' },
  warn: { label: '提醒', color: 'var(--warn)' },
  danger: { label: '重要', color: 'var(--danger)' },
};

/* ---------------- 主区 ---------------- */
export async function renderStage(pane = activePane, keepHead = false) {
  activePane = pane;
  const stage = document.getElementById('stage');
  if (!stage) return;
  stage.innerHTML = '';
  const body = el('div', { class: 'notice' });

  if (pane === 'donate') await renderDonate(body);
  else await renderAnnouncements(body);

  stage.appendChild(body);
}

/* ---------------- 公告栏 ---------------- */
async function loadAnnouncements(force = false) {
  const now = Date.now();
  if (!force && cache.list && now - cache.ts < 30000) return cache.list;
  const r = await api.get('/api/announcements');
  cache.list = r.announcements || [];
  cache.ts = now;
  return cache.list;
}

async function renderAnnouncements(box) {
  const head = el('div', { class: 'notice__hero' }, [
    el('div', { class: 'notice__hero-ico', html: icon('bell', 22) }),
    el('div', { class: 'grow' }, [
      el('div', { class: 'notice__hero-title', text: '公告' }),
      el('div', { class: 'notice__hero-sub', text: '由站长发布 · 不占用聊天记录，长期可查' }),
    ]),
    el('button', {
      class: 'btn btn--sm', text: '刷新',
      onClick: async () => {
        await loadAnnouncements(true);
        toast('公告已刷新', 'ok');
        await renderStage('notice', true);
      },
    }),
  ]);
  box.appendChild(head);

  const list = el('div', { class: 'notice__list' });
  box.appendChild(list);

  let items = null;
  try { items = await loadAnnouncements(true); }
  catch (e) { items = null; }

  if (!items) {
    list.appendChild(el('div', { class: 'empty', style: { padding: '30px 20px' } }, [
      el('div', { class: 'empty__icon', html: icon('bell', 40, 1.5) }),
      el('div', { class: 'empty__title', text: '公告加载失败' }),
      el('div', { class: 'empty__sub', text: '请稍后点击右上角「刷新」重试' }),
    ]));
    return;
  }
  if (!items.length) {
    list.appendChild(el('div', { class: 'empty', style: { padding: '30px 20px' } }, [
      el('div', { class: 'empty__icon', html: icon('bell', 40, 1.5) }),
      el('div', { class: 'empty__title', text: '暂无公告' }),
      el('div', { class: 'empty__sub', text: '站长发布公告后会显示在这里，重要变更也会同步推送到公共聊天室。' }),
    ]));
    return;
  }

  items.forEach((a) => {
    const meta = LEVEL_STYLE[a.level] || LEVEL_STYLE.info;
    list.appendChild(el('article', {
      class: 'notice-card' + (a.pinned ? ' is-pinned' : ''),
      style: { '--notice-color': meta.color },
    }, [
      el('div', { class: 'notice-card__bar' }),
      el('div', { class: 'notice-card__head' }, [
        el('span', { class: 'notice-card__tag', text: meta.label }),
        a.pinned ? el('span', { class: 'tag tag--ok', text: '置顶' }) : null,
        el('div', { class: 'grow' }),
        el('span', { class: 'notice-card__time', text: fmtRelative(a.ts) }),
      ]),
      el('div', { class: 'notice-card__text', text: a.text }),
      a.by ? el('div', { class: 'notice-card__by', text: `—— ${a.by}` }) : null,
    ]));
  });
}

/* ---------------- 捐赠栏 ---------------- */
async function loadDonate(force = false) {
  const now = Date.now();
  if (!force && cache.donate && now - cache.donateTs < 60000) return cache.donate;
  const r = await api.get('/api/donate');
  cache.donate = r.donate || null;
  cache.donateTs = now;
  return cache.donate;
}

const copy = async (text, tip = '已复制到剪贴板') => {
  try {
    await navigator.clipboard.writeText(text);
    toast(tip, 'ok');
  } catch { toast('复制失败，请手动选中复制', 'err'); }
};

/** 支付渠道的主色：微信绿 / 支付宝蓝，其余走中性强调色 */
const PAY_COLORS = [
  { match: /微信|weixin|wxpay/i, color: '#07c160', icon: 'chat' },
  { match: /支付宝|alipay/i, color: '#1677ff', icon: 'wallet' },
  { match: /qq/i, color: '#12b7f5', icon: 'chat' },
];

async function renderDonate(box) {
  const d = await loadDonate(true).catch(() => null);
  const enabled = !d || d.enabled !== false;

  box.appendChild(el('div', { class: 'notice__hero' }, [
    el('div', { class: 'notice__hero-ico', html: icon('heart', 22) }),
    el('div', { class: 'grow' }, [
      el('div', { class: 'notice__hero-eyebrow', text: 'SUPPORT' }),
      el('div', { class: 'notice__hero-title', text: (d && d.title) || '捐赠本站' }),
      el('div', { class: 'notice__hero-sub', text: '捐赠完全出于自愿，不会获得任何特权、会员或额外功能，也不会影响匹配、聊天及正常使用体验' }),
    ]),
  ]));

  const intro = el('div', { class: 'donate' });
  box.appendChild(intro);

  if (!d) {
    intro.appendChild(el('div', { class: 'empty', style: { padding: '30px 20px' } }, [
      el('div', { class: 'empty__icon', html: icon('heart', 40, 1.5) }),
      el('div', { class: 'empty__title', text: '捐赠信息加载失败' }),
      el('div', { class: 'empty__sub', text: '请稍后重试' }),
    ]));
    return;
  }

  intro.appendChild(el('p', { class: 'donate__intro', text: d.intro || '' }));

  if (!enabled) {
    intro.appendChild(el('div', { class: 'donate__off', text: '站长当前未开启捐赠通道。' }));
    return;
  }

  /* 备注条：想在捐赠名单里留名，就按这个备注付款（一键复制） */
  const noteVal = (d.pay_note || `${state.me?.username || ''}#${String(state.me?.id || '').slice(-6)}`).trim();
  if (noteVal) {
    intro.appendChild(el('div', { class: 'donate-notebar' }, [
      el('div', { class: 'donate-notebar__ico', html: icon('bell', 16) }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'donate-notebar__tip', text: '如果希望在捐赠记录中留下你的名字，付款时请备注站内用户名 + ID。' }),
        el('div', { class: 'donate-notebar__row' }, [
          el('code', { class: 'donate-notebar__val', text: noteVal }),
          el('button', {
            class: 'btn btn--sm btn--primary donate-notebar__copy', type: 'button', text: '一键复制',
            onClick: () => copy(noteVal, '备注已复制，去付款时粘贴即可'),
          }),
        ]),
      ]),
    ]));
  }

  /* 收款方式：大按钮（微信绿 / 支付宝蓝），点开放大收款码 */
  const methods = Array.isArray(d.methods) ? d.methods.filter((m) => m.link || m.qr) : [];
  if (!methods.length) {
    intro.appendChild(el('div', { class: 'donate__placeholder' }, [
      el('div', { class: 'donate__ph-ico', html: icon('heart', 26) }),
      el('div', { class: 'donate__ph-title', text: '收款方式尚未配置' }),
      el('div', { class: 'donate__ph-sub', text: '管理员可在管理后台「站点捐赠」中填写收款码与收款链接，填写后这里会自动展示。' }),
    ]));
  } else {
    const grid = el('div', { class: 'donate-pay' });
    methods.forEach((m) => {
      const theme = PAY_COLORS.find((p) => p.match.test(m.name || '')) || null;
      const color = theme ? theme.color : 'var(--accent)';
      const ico = theme ? theme.icon : 'heart';
      const btn = el('button', {
        class: 'donate-pay__btn', type: 'button',
        style: { '--pay-color': color },
        onClick: () => {
          if (m.qr) lightbox(m.qr, false, { name: `${m.name} 收款码` });
          else if (m.link) copy(m.link, `${m.name} 地址已复制`);
        },
      }, [
        el('span', { class: 'donate-pay__ico', html: icon(ico, 20) }),
        el('span', { class: 'donate-pay__name', text: m.name }),
      ]);
      grid.appendChild(btn);
    });
    intro.appendChild(grid);
  }

  /* 捐赠名单 */
  const donors = Array.isArray(d.list) ? d.list.filter((x) => x && x.name) : [];
  intro.appendChild(el('div', { class: 'donate-donors' }, [
    el('div', { class: 'donate-donors__head' }, [
      el('div', { class: 'donate-donors__title', text: '捐赠名单' }),
      el('div', { class: 'donate-donors__sub', text: donors.length ? `已记录 ${donors.length} 位热心支持，排名不分前后` : '你的支持会被记在这里（可在付款备注中留名）' }),
    ]),
    donors.length
      ? el('div', { class: 'donate-donors__list' }, donors.map((x) => el('div', { class: 'donate-donors__item' }, [
        el('span', { class: 'donate-donors__ava', text: (x.name || '?').slice(0, 1).toUpperCase() }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'donate-donors__name', text: x.name }),
          x.msg ? el('div', { class: 'donate-donors__msg', text: x.msg }) : null,
        ]),
        x.amount ? el('span', { class: 'donate-donors__amt', text: x.amount }) : null,
      ])))
      : null,
  ]));

  intro.appendChild(el('div', { class: 'donate__stats' }, [
    el('span', { class: 'e2ee-chip', html: icoHtml('lock', 11, 2.2) }, [el('span', { text: '捐赠记录不上传' })]),
    el('span', { text: '捐赠为自愿行为，不解锁任何功能，也不会影响你的数据与隐私。' }),
  ]));

  if (d.note) intro.appendChild(el('p', { class: 'donate__note', text: d.note }));

  intro.appendChild(el('div', { class: 'donate__foot' }, [
    el('span', {
      class: 'muted',
      text: '本站所有聊天、动态与文件均加密后传输与存储；会话密钥同时托管在服务端，平台据此核查违规内容。',
    }),
  ]));
}

/* 管理员发布新公告后调用，让侧栏下次进入时重新拉取 */
export function invalidateNotice() { cache = { list: null, ts: 0, donate: null, donateTs: 0 }; }
