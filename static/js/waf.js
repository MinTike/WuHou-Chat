/* ============================================================
   WAF 独立控制台（/app/waf）
   ------------------------------------------------------------
   这是 WAF 自己的界面系统：独立的侧栏导航、独立的信息密度、独立的视觉层
   （static/css/waf.css），与聊天主界面、管理员后台是三套不同的东西。

   身份：复用武侯Chat 的管理员令牌 —— 不为 WAF 另建一套账号，
   也就没有第二个登录入口要记、要维护、要轮换。

   数据：全部走 /api/admin/waf/panel/*，读的是本进程内 JredonpT-WAF（定制版）自己的状态，
   不依赖任何外部服务。

   Copyright © 2026 左熙宇
   ============================================================ */
import { el } from './util.js';
import { api, tokenStore } from './api.js';
import { toast } from './ui.js';
import { icon } from './icons.js';

const A = tokenStore.admin;

/* ---------------- 数据访问 ---------------- */
// 后端已把进程内 WAF 的 {code,msg,data} 剥成 data，api.get 又剥一层 ——
// 拿到的就是数据本体，不要再取 .data。
const panelGet = async (p, params) => {
  const qs = params && Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
  return (await api.get(`/api/admin/waf/panel/${p}${qs}`, undefined, { admin: true })) || {};
};
const panelPost = async (p, body) => (await api.post(`/api/admin/waf/panel/${p}`, body || {}, { admin: true })) || {};
// api.del 签名是 (path, body, opts)：第二位是请求体，选项在第三位
const panelDel = async (p) => (await api.del(`/api/admin/waf/panel/${p}`, undefined, { admin: true })) || {};

/* ---------------- 小工具 ---------------- */
const SEV_COLOR = { critical: '#ff4d6d', high: '#ff8a3d', medium: 'var(--warn)', low: 'var(--muted)' };
const SEV_TEXT = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '提示' };

const fmtTime = (t) => {
  if (!t) return '—';
  if (typeof t === 'number') return new Date(t * 1000).toLocaleString('zh-CN', { hour12: false });
  return String(t).replace('T', ' ').slice(0, 19);
};
const fmtNum = (n) => {
  const v = Number(n || 0);
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + '万';
  return String(v);
};
const ico = (name, size = 16) => icon(name, size, 1.9);

function card(children, extra = {}) {
  return el('div', { class: 'waf-card', ...extra }, children);
}
function section(title, extra = null) {
  return el('div', { class: 'waf-sec' }, [el('span', { text: title }), extra]);
}
function metric(n, k, x) {
  return card([
    el('div', { class: 'waf-metric__n', text: n }),
    el('div', { class: 'waf-metric__k', text: k }),
    x ? el('div', { class: 'waf-metric__x', text: x }) : null,
  ], { class: 'waf-card waf-metric' });
}
function badge(text, kind) {
  return el('span', { class: 'waf-badge' + (kind ? ' waf-badge--' + kind : ''), text });
}
function emptyBox(text) {
  return el('div', { class: 'waf-empty' }, [el('div', { text })]);
}
function loading() {
  return el('div', { class: 'waf-center' }, [el('div', { class: 'waf-spinner' })]);
}

/* ---------------- 登录（复用管理员身份） ---------------- */
function ensureLogin() {
  if (A.get()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const user = el('input', { class: 'input', id: 'wafUser', placeholder: '管理员账号' });
    const pass = el('input', { class: 'input', id: 'wafPass', type: 'password', placeholder: '管理员密码' });
    const body = el('div', { class: 'form' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '管理员账号' }), user]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '管理员密码' }), pass]),
      el('div', { class: 'muted', style: { fontSize: '11.5px', lineHeight: '1.7' },
        text: 'WAF 不另设账号 —— 用武侯Chat 的管理员身份进入，权限与后台一致。' }),
    ]);
    // 直接复用后台同一套 modal 样式类（components.css：modal-scrim / modal / modal__*），
    // 不另建一套 —— 视觉要统一，也不必为了一个登录框多写几十行 CSS。
    const scrim = el('div', { class: 'modal-scrim' });
    const box = el('div', { class: 'modal' }, [
      el('div', { class: 'modal__head' }, [el('div', { class: 'modal__title', text: '管理员登录' })]),
      el('div', { class: 'modal__body' }, [body]),
      el('div', { class: 'modal__foot' }, [
        el('button', { class: 'btn btn--ghost', text: '取消', onClick: () => { scrim.remove(); resolve(false); } }),
        el('button', { class: 'btn btn--primary', text: '登录', onClick: async () => {
          try {
            const r = await api.post('/api/admin/login',
              { username: user.value.trim(), password: pass.value }, { admin: true });
            A.set(r.token);
            if (r.admin && r.admin.username) localStorage.setItem('wuhou.admin.name', r.admin.username);
            toast('已登录', 'ok');
            scrim.remove();
            resolve(true);
          } catch (e) { toast(e.message || '登录失败', 'err'); }
        } }),
      ]),
    ]);
    scrim.appendChild(box);
    (document.getElementById('modalRoot') || document.body).appendChild(scrim);
    setTimeout(() => user.focus(), 60);
  });
}

/* ---------------- 页面：概况 ---------------- */
async function pageOverview(ctx) {
  const box = el('div', { class: 'waf__page' });
  const [st, s, tr] = await Promise.all([
    api.get('/api/admin/waf/status?force=1', undefined, { admin: true }).catch(() => ({})),
    panelGet('stats').catch(() => ({})),
    api.get('/api/admin/waf/trend?minutes=60', undefined, { admin: true }).catch(() => ({})),
  ]);
  const det = st.detect || {};
  const online = !!st.online;
  const guarding = !!det.enabled && !det.broken;

  /* 状态 Hero */
  const head = ['防护正常', 'is-ok'];
  const sub = 'JredonpT-WAF（定制版） · 攻击会被自动识别并拦截，无需干预。';
  box.appendChild(el('div', { class: 'waf-hero ' + head[1], dataset: { verdict: head[0] } }, [
    el('div', { class: 'waf-hero__ico', html: ico(guarding && online ? 'shield' : 'alert', 22) }),
    el('div', { style: { minWidth: '0' } }, [
      el('div', { class: 'waf-hero__t', text: head[0] }),
      el('div', { class: 'waf-hero__s', text: sub }),
    ]),
  ]));

  /* 指标 */
  const total = Number(s.total_requests || 0);
  const blocked = Number(s.total_blocked || 0);
  const rate = total ? ((blocked / total) * 100).toFixed(1) + '%' : '0%';
  box.appendChild(section('运行指标'));
  box.appendChild(el('div', { class: 'waf-grid waf-grid--6' }, [
    metric(fmtNum(total), '访问请求', '累计'),
    metric(fmtNum(blocked), '已拦截', `占比 ${rate}`),
    metric(String(s.unique_ips ?? '—'), '近期访客', '近一小时活跃'),
    metric(String(s.current_blocked_ips ?? '—'), '封禁中', '人工封禁'),
    metric(String(s.requests_per_sec ?? '—'), '请求/秒', '近 5 秒窗口'),
    metric(String(s.active_connections ?? '—'), '在线连接', '近一分钟'),
  ]));

  /* 趋势 + 攻击类型分布 */
  const buckets = tr.buckets || [];
  const types = tr.by_type || [];
  box.appendChild(section('近一小时拦截趋势'));
  if (buckets.length && buckets.some((n) => n > 0)) {
    const max = Math.max(1, ...buckets);
    const bars = el('div', { class: 'waf-bars' }, buckets.map((n) => el('div', {
      class: 'waf-bars__b',
      style: { height: Math.max(3, Math.round((n / max) * 84)) + 'px' },
      title: `${n} 次`,
    })));
    box.appendChild(card([
      bars,
      el('div', { class: 'waf-bars__axis' }, [
        el('span', { text: '60 分钟前' }),
        el('span', { text: `共 ${tr.total || 0} 次` }),
        el('span', { text: '现在' }),
      ]),
    ]));
  } else {
    box.appendChild(emptyBox('近一小时没有拦截记录'));
  }

  if (types.length) {
    const maxT = Math.max(1, ...types.map((t) => t.count));
    box.appendChild(section('攻击类型分布'));
    box.appendChild(card([el('div', { class: 'waf-dist' }, types.map((t) => el('div', { class: 'waf-dist__row' }, [
      el('span', { class: 'waf-dist__name', text: t.name, title: t.name }),
      el('span', { class: 'waf-dist__track' }, [
        el('span', { class: 'waf-dist__fill', style: { width: Math.round((t.count / maxT) * 100) + '%' } }),
      ]),
      el('span', { class: 'waf-dist__n', text: String(t.count) }),
    ])))]));
  }

  /* 主要攻击来源 */
  const tops = (s.top_attackers || []).slice(0, 6);
  if (tops.length) {
    box.appendChild(section('主要攻击来源'));
    box.appendChild(el('div', { class: 'waf-list' }, tops.map((a) => el('div', { class: 'waf-row' }, [
      el('div', { class: 'waf-row__main' }, [
        el('div', { class: 'waf-row__t' }, [
          el('span', { class: 'waf-mono', text: a.ip }),
          badge(`拦截 ${a.blocked}`, 'high'),
        ]),
        el('div', { class: 'waf-row__s',
          text: `请求 ${a.requests} 次 · 最近 ${fmtTime(a.last_seen)} · ${Object.keys(a.attack_types || {}).join('、') || '—'}` }),
      ]),
      el('div', { class: 'waf-row__side' }, [
        el('button', {
          class: 'waf-btn waf-btn--sm', text: '封禁',
          onClick: async () => {
            try { await panelPost('block', { ip: a.ip, reason: '控制台手动封禁' }); toast('已封禁', 'ok'); ctx.reload(); }
            catch (e) { toast(e.message || '封禁失败', 'err'); }
          },
        }),
      ]),
    ]))));
  }

  /* 最近事件 */
  const r = await panelGet('events', { limit: 6 }).catch(() => ({}));
  const recent = (r.events || []).slice(0, 6);
  box.appendChild(section('最近拦截'));
  if (!recent.length) box.appendChild(emptyBox('近期没有拦截记录'));
  else {
    box.appendChild(el('div', { class: 'waf-list' }, recent.map((e) => el('div', { class: 'waf-row' }, [
      el('div', { class: 'waf-row__main' }, [
        el('div', { class: 'waf-row__t' }, [
          el('span', { style: { width: '7px', height: '7px', borderRadius: '50%',
            background: SEV_COLOR[e.severity] || 'var(--muted)' } }),
          el('span', { text: e.attack_type || '攻击' }),
          el('span', { class: 'waf-mono muted', style: { fontWeight: '400' }, text: e.src_ip || '' }),
        ]),
        el('div', { class: 'waf-row__s', text: `${fmtTime(e.timestamp)} · ${e.url || ''}` }),
      ]),
      badge(SEV_TEXT[e.severity] || e.severity || '—', e.severity),
    ]))));
  }
  return box;
}

/* ---------------- 页面：攻击事件 ---------------- */
async function pageEvents(ctx) {
  const box = el('div', { class: 'waf__page' });
  const r = await panelGet('events', { limit: 200 });
  const all = r.events || [];

  const kw = el('input', { class: 'waf-input', placeholder: '按 IP / 类型 / 地址 搜索', style: { flex: '1 1 220px' } });
  const sev = el('select', { class: 'waf-select', style: { flex: '0 0 130px' } }, [
    el('option', { value: '', text: '全部级别' }),
    el('option', { value: 'critical', text: '严重' }),
    el('option', { value: 'high', text: '高危' }),
    el('option', { value: 'medium', text: '中危' }),
    el('option', { value: 'low', text: '低危' }),
  ]);
  const listBox = el('div', { class: 'waf-list' });

  const draw = () => {
    const q = (kw.value || '').trim().toLowerCase();
    const sv = sev.value;
    const list = all.filter((e) => {
      if (sv && e.severity !== sv) return false;
      if (!q) return true;
      return [e.src_ip, e.attack_type, e.url, e.detail].join(' ').toLowerCase().includes(q);
    });
    listBox.innerHTML = '';
    if (!list.length) { listBox.appendChild(emptyBox('没有符合条件的记录')); return; }
    for (const e of list.slice(0, 120)) {
      listBox.appendChild(el('div', { class: 'waf-row' }, [
        el('div', { class: 'waf-row__main' }, [
          el('div', { class: 'waf-row__t' }, [
            el('span', { style: { width: '7px', height: '7px', borderRadius: '50%',
              background: SEV_COLOR[e.severity] || 'var(--muted)' } }),
            el('span', { text: e.attack_type || '攻击' }),
            el('span', { class: 'waf-mono muted', style: { fontWeight: '400' }, text: e.src_ip || '' }),
            el('span', { class: 'waf-badge', text: (e.method || '') + ' ' + (e.action === 'block' ? '已拦截' : (e.action || '')) }),
          ]),
          el('div', { class: 'waf-row__s', text: e.detail || '' }),
          el('div', { class: 'waf-row__s muted', text: `${fmtTime(e.timestamp)} · ${e.url || ''}` }),
        ]),
        el('div', { class: 'waf-row__side' }, [
          badge(SEV_TEXT[e.severity] || e.severity || '—', e.severity),
          el('button', {
            class: 'waf-btn waf-btn--sm', text: '封禁',
            onClick: async () => {
              const okd = await ctx.confirmBox(`封禁 ${e.src_ip}？该来源的请求会被直接拒绝。`);
              if (!okd) return;
              try { await panelPost('block', { ip: e.src_ip, reason: `事件封禁：${e.attack_type}` }); toast('已封禁', 'ok'); ctx.reload(); }
              catch (err) { toast(err.message || '封禁失败', 'err'); }
            },
          }),
        ]),
      ]));
    }
  };
  kw.addEventListener('input', draw);
  sev.addEventListener('change', draw);

  box.appendChild(section(`攻击事件（${all.length}）`));
  box.appendChild(el('div', { class: 'waf-form-row', style: { marginBottom: '12px' } }, [kw, sev]));
  box.appendChild(listBox);
  draw();
  return box;
}

/* ---------------- 页面：封禁管理 ---------------- */
async function pageBlocked(ctx) {
  const box = el('div', { class: 'waf__page' });
  const r = await panelGet('blocked');
  const list = r.list || [];

  const ipIn = el('input', { class: 'waf-input', placeholder: '要封禁的 IP，如 203.0.113.9', style: { flex: '1 1 200px' } });
  const ttlIn = el('input', { class: 'waf-input', placeholder: '时长（秒，留空=长期）', style: { flex: '0 1 150px' } });
  const whyIn = el('input', { class: 'waf-input', placeholder: '原因（可留空）', style: { flex: '1 1 180px' } });

  box.appendChild(section(`封禁名单（${list.length}）`));
  if (!list.length) box.appendChild(emptyBox('当前没有封禁中的 IP'));
  else {
    box.appendChild(el('div', { class: 'waf-list' }, list.map((b) => el('div', { class: 'waf-row' }, [
      el('div', { class: 'waf-row__main' }, [
        el('div', { class: 'waf-row__t' }, [
          el('span', { class: 'waf-mono', text: b.ip }),
          b.permanent ? badge('长期', 'high') : badge('限时', 'medium'),
        ]),
        el('div', { class: 'waf-row__s',
          text: `${b.reason || '手动封禁'} · ${b.expires_at ? fmtTime(b.expires_at) + ' 到期' : '长期有效'}` }),
      ]),
      el('div', { class: 'waf-row__side' }, [
        el('button', {
          class: 'waf-btn waf-btn--sm', text: '解封',
          onClick: async () => {
            try { await panelPost('unblock', { ip: b.ip }); toast('已解封', 'ok'); ctx.reload(); }
            catch (e) { toast(e.message || '解封失败', 'err'); }
          },
        }),
      ]),
    ]))));
  }

  box.appendChild(section('手动封禁'));
  box.appendChild(card([
    el('div', { class: 'waf-form-row' }, [
      el('div', { class: 'waf-field', style: { flex: '1 1 200px' } }, [
        el('span', { class: 'waf-field__l', text: 'IP 地址' }), ipIn,
      ]),
      el('div', { class: 'waf-field', style: { flex: '0 1 150px' } }, [
        el('span', { class: 'waf-field__l', text: '时长（秒）' }), ttlIn,
      ]),
      el('div', { class: 'waf-field', style: { flex: '1 1 180px' } }, [
        el('span', { class: 'waf-field__l', text: '原因' }), whyIn,
      ]),
      el('button', {
        class: 'waf-btn waf-btn--primary', text: '封禁',
        onClick: async () => {
          const ip = (ipIn.value || '').trim();
          if (!ip) { toast('请填写 IP', 'err'); return; }
          const ttl = (ttlIn.value || '').trim();
          try {
            await panelPost('block', { ip, reason: whyIn.value.trim() || '控制台手动封禁',
              ttl_sec: ttl ? Number(ttl) : null });
            toast('已封禁', 'ok'); ipIn.value = ''; ttlIn.value = ''; whyIn.value = ''; ctx.reload();
          } catch (e) { toast(e.message || '封禁失败', 'err'); }
        },
      }),
      el('button', {
        class: 'waf-btn waf-btn--danger', text: '全部解封',
        onClick: async () => {
          if (!list.length) { toast('名单为空', 'err'); return; }
          const okd = await ctx.confirmBox(`解封全部 ${list.length} 个 IP？`, '会立即恢复它们的访问。');
          if (!okd) return;
          try { const r2 = await panelDel('block_all'); toast(`已解封 ${r2.cleared || 0} 个`, 'ok'); ctx.reload(); }
          catch (e) { toast(e.message || '操作失败', 'err'); }
        },
      }),
    ]),
    el('div', { class: 'waf-note', style: { marginTop: '10px' },
      text: '系统不会自动封禁任何来源 —— 公司、校园、蜂窝出口下一个 IP 背后是很多人，'
        + '自动拉黑误伤面太大。封禁只在这里由人决定；本机与白名单地址一律拒绝封禁。' }),
  ]));
  return box;
}

/* ---------------- 页面：白名单 ---------------- */
async function pageWhitelist(ctx) {
  const box = el('div', { class: 'waf__page' });
  const r = await panelGet('whitelist');
  const list = r.list || [];
  const ipIn = el('input', { class: 'waf-input', placeholder: '加入白名单的 IP', style: { flex: '1 1 240px' } });

  box.appendChild(section(`白名单（${list.length}）`));
  if (!list.length) box.appendChild(emptyBox('白名单为空'));
  else {
    box.appendChild(el('div', { class: 'waf-list' }, list.map((ip) => el('div', { class: 'waf-row' }, [
      el('div', { class: 'waf-row__main' }, [el('span', { class: 'waf-mono', text: ip })]),
      el('div', { class: 'waf-row__side' }, [
        el('button', {
          class: 'waf-btn waf-btn--sm', text: '移除',
          onClick: async () => {
            try { await panelDel(`whitelist/${ip}`); toast('已移除', 'ok'); ctx.reload(); }
            catch (e) { toast(e.message || '移除失败', 'err'); }
          },
        }),
      ]),
    ]))));
  }

  box.appendChild(section('加入白名单'));
  box.appendChild(card([
    el('div', { class: 'waf-form-row' }, [
      el('div', { class: 'waf-field', style: { flex: '1 1 240px' } }, [
        el('span', { class: 'waf-field__l', text: 'IP 地址' }), ipIn,
      ]),
      el('button', {
        class: 'waf-btn waf-btn--primary', text: '加入',
        onClick: async () => {
          const ip = (ipIn.value || '').trim();
          if (!ip) { toast('请填写 IP', 'err'); return; }
          try { await panelPost('whitelist', { ip }); toast('已加入', 'ok'); ipIn.value = ''; ctx.reload(); }
          catch (e) { toast(e.message || '加入失败', 'err'); }
        },
      }),
    ]),
    el('div', { class: 'waf-note', style: { marginTop: '10px' },
      text: '白名单里的来源不做拦截判定。只放完全信任的地址 —— 加进去等于给它一张通行证。' }),
  ]));
  return box;
}

/* ---------------- 页面：规则库 ---------------- */
async function pageRules() {
  const box = el('div', { class: 'waf__page' });
  const r = await panelGet('rules');
  const rules = r.rules || [];
  const kw = el('input', { class: 'waf-input', placeholder: '搜索规则名或说明', style: { flex: '1 1 240px' } });
  const body = el('div');

  const draw = () => {
    const q = (kw.value || '').trim().toLowerCase();
    const list = q
      ? rules.filter((x) => (x.name + ' ' + (x.desc || '') + ' ' + (x.category || '')).toLowerCase().includes(q))
      : rules;
    body.innerHTML = '';
    if (!list.length) { body.appendChild(emptyBox('没有匹配的规则')); return; }
    const grouped = new Map();
    for (const it of list) {
      const c = it.category || '其他';
      if (!grouped.has(c)) grouped.set(c, []);
      grouped.get(c).push(it);
    }
    for (const [cat, items] of grouped) {
      body.appendChild(section(`${cat}（${items.length}）`));
      body.appendChild(el('div', { class: 'waf-list' }, items.map((it) => el('div', { class: 'waf-row' }, [
        el('div', { class: 'waf-row__main' }, [
          el('div', { class: 'waf-row__t', text: it.name }),
          el('div', { class: 'waf-row__s', text: it.desc || '' }),
        ]),
        el('div', { class: 'waf-row__side' }, [
          badge(SEV_TEXT[it.severity] || it.severity || '—', it.severity),
        ]),
      ]))));
    }
  };
  kw.addEventListener('input', draw);

  box.appendChild(section(`规则库（${rules.length}）`));
  box.appendChild(el('div', { class: 'waf-form-row', style: { marginBottom: '12px' } }, [kw]));
  box.appendChild(body);
  draw();
  return box;
}

/* ---------------- 页面：实时检测 ---------------- */
function pageTry() {
  const box = el('div', { class: 'waf__page' });
  const method = el('select', { class: 'waf-select', style: { flex: '0 0 110px' } }, [
    el('option', { value: 'GET', text: 'GET' }),
    el('option', { value: 'POST', text: 'POST' }),
    el('option', { value: 'PUT', text: 'PUT' }),
  ]);
  const path = el('input', { class: 'waf-input', value: '/api/messages', style: { flex: '1 1 220px' } });
  const query = el('input', { class: 'waf-input', placeholder: '查询串，如 id=1', style: { flex: '1 1 200px' } });
  const ip = el('input', { class: 'waf-input', placeholder: '来源 IP（可留空）', style: { flex: '0 1 160px' } });
  const body = el('textarea', { class: 'waf-textarea', placeholder: '请求体（可留空）' });
  const out = el('div');

  const PRESETS = [
    ['SQL 注入', 'GET', '/api/messages', 'id=1 UNION SELECT password FROM users', ''],
    ['XSS 跨站', 'GET', '/api/messages', 'q=<script>alert(1)</script>', ''],
    ['路径穿越', 'GET', '/api/files', 'p=../../../../etc/passwd', ''],
    ['命令注入', 'GET', '/api/run', 'cmd=;cat /etc/passwd', ''],
    ['正常请求', 'GET', '/api/messages', 'id=12345', ''],
    ['中文搜索', 'GET', '/api/search', 'q=武侯', ''],
    ['嵌套 JSON', 'POST', '/api/chat/keys', '', '{"gid":"g1","targets":{"u_a":"WK_A"}}'],
  ];

  const run = async () => {
    out.innerHTML = '';
    out.appendChild(loading());
    let r;
    try {
      r = await api.post('/api/admin/waf/try', {
        method: method.value, path: path.value.trim(), query: query.value.trim(),
        body: body.value, client_ip: ip.value.trim(),
        headers: { 'user-agent': 'Mozilla/5.0 (WuhouChat-Console)', accept: 'application/json' },
      }, { admin: true }) || {};
    } catch (e) {
      out.innerHTML = '';
      out.appendChild(el('div', { class: 'waf-note', text: e.message || '请求失败' }));
      return;
    }
    out.innerHTML = '';
    const blocked = !!r.blocked;
    const tone = !r.asked ? 'var(--muted)' : (blocked ? 'var(--danger)' : 'var(--ok)');
    out.appendChild(el('div', {
      class: 'waf-hero ' + (!r.asked ? 'is-warn' : blocked ? 'is-bad' : 'is-ok'),
      dataset: { verdict: !r.asked ? '未参与' : blocked ? '拦截' : '放行' },
      style: { marginBottom: '12px' },
    }, [
      el('div', { class: 'waf-hero__ico', html: ico(blocked ? 'ban' : 'check', 22) }),
      el('div', {}, [
        el('div', { class: 'waf-hero__t', style: { color: tone },
          text: !r.asked ? '未参与判定' : blocked ? '判定：拦截' : '判定：放行' }),
        el('div', { class: 'waf-hero__s',
          text: r.reason || (blocked ? `${r.rule_name || ''} · ${r.description || ''}` : '未命中任何规则') }),
      ]),
    ]));
    const rows = [
      ['规则', r.rule_name || '—'],
      ['级别', SEV_TEXT[r.severity] || r.severity || '—'],
      ['动作', r.action || '—'],
      ['耗时', `${r.latency_ms ?? '—'} ms`],
      ['命中原文', r.matched_value || '—'],
    ];
    out.appendChild(card([el('div', { class: 'waf-dist' }, rows.map(([k, v]) => el('div', { class: 'waf-dist__row' }, [
      el('span', { class: 'waf-dist__name', text: k }),
      el('span', { class: 'waf-row__s', style: { flex: '1 1 auto', marginTop: '0' }, text: String(v) }),
    ])))]));
  };

  box.appendChild(section('实时检测'));
  box.appendChild(el('div', { class: 'waf-note', style: { marginBottom: '12px' },
    text: '把一段请求交给进程内 WAF 引擎判一次，看它拦不拦、为什么拦。'
      + '排查「某个接口为什么被拦」或「该不该拦」时用这个。' }));
  box.appendChild(card([
    el('div', { class: 'waf-form-row' }, [
      el('div', { class: 'waf-field', style: { flex: '0 0 110px' } }, [el('span', { class: 'waf-field__l', text: '方法' }), method]),
      el('div', { class: 'waf-field', style: { flex: '1 1 220px' } }, [el('span', { class: 'waf-field__l', text: '路径' }), path]),
      el('div', { class: 'waf-field', style: { flex: '1 1 200px' } }, [el('span', { class: 'waf-field__l', text: '查询串' }), query]),
      el('div', { class: 'waf-field', style: { flex: '0 1 160px' } }, [el('span', { class: 'waf-field__l', text: '来源 IP' }), ip]),
    ]),
    el('div', { class: 'waf-field', style: { marginTop: '10px' } }, [
      el('span', { class: 'waf-field__l', text: '请求体' }), body,
    ]),
    el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' } }, [
      el('button', { class: 'waf-btn waf-btn--primary', text: '检测一次', onClick: run }),
    ]),
  ]));

  box.appendChild(section('快速用例'));
  box.appendChild(el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
    PRESETS.map(([name, m, p, q, b]) => el('button', {
      class: 'waf-btn waf-btn--sm', text: name,
      onClick: () => { method.value = m; path.value = p; query.value = q; body.value = b; run(); },
    }))));

  box.appendChild(section('判定结果'));
  box.appendChild(out);
  return box;
}

/* ---------------- 页面：设置 ---------------- */
async function pageSettings(ctx) {
  const box = el('div', { class: 'waf__page' });
  const st = await api.get('/api/admin/waf/status?force=1', undefined, { admin: true }).catch(() => ({}));
  const d = st.detect || {};

  box.appendChild(section('服务'));
  const rows = [
    ['检测服务', d.service || '—'],
    ['服务地址', d.url || st.url || '—'],
    ['版本', st.version || '—'],
    ['版本类型', st.edition || '—'],
    ['防护强度', st.defense_level != null ? `L${st.defense_level}` : '—'],
    ['判定超时', d.timeout_ms != null ? `${d.timeout_ms} ms` : '—'],
    ['密钥来源', d.key_source || '—'],
    ['自动封禁', d.enabled ? '关闭（全局不封禁 IP）' : '—'],
  ];
  box.appendChild(card([el('div', { class: 'waf-dist' }, rows.map(([k, v]) => el('div', { class: 'waf-dist__row' }, [
    el('span', { class: 'waf-dist__name', text: k }),
    el('span', { class: 'waf-row__s', style: { flex: '1 1 auto', marginTop: '0' }, text: String(v) }),
  ])))]));

  /* 接口密钥 —— JredonpT-WAF（定制版）无外部密钥，区块改为说明 */
  box.appendChild(section('接口密钥'));
  box.appendChild(card([
    el('div', { class: 'waf-note', text: 'JredonpT-WAF（定制版）完全内建于武侯Chat 进程，'
      + '没有外部检测服务，也不需要任何 API 密钥。此区块仅为兼容旧版控制台保留。' }),
  ]));

  /* 自检 */
  box.appendChild(section('链路自检'));
  const result = el('div');
  const runTest = async () => {
    result.innerHTML = '';
    result.appendChild(loading());
    let r;
    try { r = await api.post('/api/admin/waf/selftest', {}, { admin: true }) || {}; }
    catch (e) { result.innerHTML = ''; result.appendChild(el('div', { class: 'waf-note', text: e.message || '自检失败' })); return; }
    result.innerHTML = '';
    const good = r.verdict === '防护生效';
    result.appendChild(el('div', {
      class: 'waf-hero ' + (good ? 'is-ok' : 'is-warn'),
      dataset: { verdict: r.verdict || '' },
      style: { marginBottom: '12px' },
    }, [
      el('div', { class: 'waf-hero__ico', html: ico(good ? 'shield' : 'alert', 22) }),
      el('div', {}, [
        el('div', { class: 'waf-hero__t', text: r.verdict || '—' }),
        el('div', { class: 'waf-hero__s', text: r.detail || '' }),
      ]),
    ]));
    result.appendChild(el('div', { class: 'waf-list' }, (r.cases || []).map((c) => {
      const isBenign = c.name === '正常请求';
      const bad = isBenign ? c.blocked : (!c.blocked && c.asked);
      return el('div', { class: 'waf-row' }, [
        el('div', { class: 'waf-row__main' }, [
          el('div', { class: 'waf-row__t', text: c.name }),
          el('div', { class: 'waf-row__s waf-mono', text: `${c.path}?${c.query}` }),
        ]),
        el('div', { class: 'waf-row__side' }, [
          el('span', {
            text: !c.asked ? '未参与' : (c.blocked ? '拦截' : '放行'),
            style: { fontWeight: '800', fontSize: '12.5px',
              color: !c.asked ? 'var(--muted)' : (bad ? 'var(--danger)' : 'var(--ok)') },
          }),
          c.rule_name ? el('span', { class: 'waf-badge', text: `${c.rule_name} · ${c.latency_ms}ms` }) : null,
        ]),
      ]);
    })));
  };
  box.appendChild(el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
    el('button', { class: 'waf-btn waf-btn--primary', text: '实测拦截', onClick: runTest }),
  ]));
  box.appendChild(result);
  return box;
}

/* ---------------- 外壳 ---------------- */
const PAGES = [
  { k: 'overview', name: '概况', icon: 'compass', fn: pageOverview },
  { k: 'events', name: '攻击事件', icon: 'alert', fn: pageEvents },
  { k: 'blocked', name: '封禁管理', icon: 'ban', fn: pageBlocked },
  { k: 'whitelist', name: '白名单', icon: 'check', fn: pageWhitelist },
  { k: 'rules', name: '规则库', icon: 'layers', fn: pageRules },
  { k: 'try', name: '实时检测', icon: 'zap', fn: pageTry },
  { k: 'settings', name: '服务设置', icon: 'settings', fn: pageSettings },
];

export async function mountWaf(host) {
  if (!host) return false;
  const ok = await ensureLogin();
  if (!ok) {
    host.appendChild(el('div', { class: 'waf-center', style: { padding: '80px 20px' } }, [
      el('div', { class: 'waf-empty' }, [
        el('div', { style: { fontSize: '14px', fontWeight: '700' }, text: '需要管理员身份' }),
        el('div', { text: '刷新页面后重新登录，或从管理控制台进入。' }),
        el('a', { class: 'waf-btn', href: '/app/admin', text: '去管理控制台' }),
      ]),
    ]));
    return false;
  }

  let cur = 'overview';
  let timer = null;

  const nav = el('nav', { class: 'waf__nav' });
  const body = el('div', { class: 'waf__body' });
  const title = el('div', { class: 'waf__top-t', text: '概况' });
  const sub = el('div', { class: 'waf__top-s', text: '' });
  const foot = el('div', { class: 'waf__foot' });

  const ctx = {
    reload: () => load(cur),
    confirmBox: (msg, title = '确认操作') => new Promise((resolve) => {
      // 用 window.confirm 太糙，但引入 ui.js 的 modal 会把后台的弹窗样式带进来；
      // 这里用一个自建的最小确认框，只在控制台内生效。
      const scrim = el('div', { class: 'modal-scrim' });
      const box = el('div', { class: 'modal' }, [
        el('div', { class: 'modal__head' }, [el('div', { class: 'modal__title', text: title })]),
        el('div', { class: 'modal__body' }, [
          el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap', lineHeight: '1.8' }, text: msg }),
        ]),
        el('div', { class: 'modal__foot' }, [
          el('button', { class: 'btn btn--ghost', text: '取消', onClick: () => { scrim.remove(); resolve(false); } }),
          el('button', { class: 'btn btn--danger', text: '确定', onClick: () => { scrim.remove(); resolve(true); } }),
        ]),
      ]);
      scrim.appendChild(box);
      (document.getElementById('modalRoot') || document.body).appendChild(scrim);
    }),
  };

  const load = async (k) => {
    cur = k;
    const def = PAGES.find((p) => p.k === k) || PAGES[0];
    title.textContent = def.name;
    sub.textContent = 'JredonpT-WAF（定制版） · 进程内检测';
    nav.querySelectorAll('.waf__nav-item').forEach((n) => n.classList.toggle('is-active', n.dataset.k === k));
    body.innerHTML = '';
    body.appendChild(loading());
    try {
      const node = await def.fn(ctx);
      body.innerHTML = '';
      body.appendChild(node);
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'waf-note', style: { lineHeight: '1.9' },
        text: `读取失败：${e.message || '服务未响应'}。` }));
    }
    paintFoot();
  };

  const paintFoot = async () => {
    let online = false, svc = '';
    try {
      const st = await api.get('/api/admin/waf/status', undefined, { admin: true });
      online = !!st.online && !!(st.detect || {}).enabled;
      svc = (st.detect || {}).service || '';
    } catch (e) { online = false; }
    foot.innerHTML = '';
    // color 与 background 同步：CSS 里的辉光用 currentColor，两者一致点才会"发光"
    const dotC = online ? 'var(--ok)' : 'var(--warn)';
    foot.appendChild(el('div', {}, [
      el('span', { class: 'waf__dot', style: { background: dotC, color: dotC } }),
      el('span', { text: online ? 'WAF 引擎在线' : 'WAF 引擎未就绪' }),
    ]));
    foot.appendChild(el('div', { style: { marginTop: '2px' }, text: svc || 'JredonpT-WAF（定制版）' }));
  };

  for (const p of PAGES) {
    nav.appendChild(el('button', {
      class: 'waf__nav-item', dataset: { k: p.k },
      onClick: () => load(p.k),
    }, [
      el('span', { class: 'waf__nav-ico', html: ico(p.icon, 17) }),
      el('span', { text: p.name }),
    ]));
  }

  const shell = el('div', { class: 'waf' }, [
    el('aside', { class: 'waf__side' }, [
      el('div', { class: 'waf__brand' }, [
        el('div', { class: 'waf__logo', text: '盾' }),
        el('div', {}, [
          el('div', { class: 'waf__brand-t', text: 'WAF 控制台' }),
          el('div', { class: 'waf__brand-s', text: '进程内自研' }),
        ]),
      ]),
      nav,
      foot,
    ]),
    el('div', { class: 'waf__main' }, [
      el('header', { class: 'waf__top' }, [
        el('div', { style: { minWidth: '0' } }, [title, sub]),
        el('div', { style: { flex: '1 1 auto' } }),
        el('span', { class: 'waf-top__admin', text: '管理员：' + (localStorage.getItem('wuhou.admin.name') || A.get() ? (localStorage.getItem('wuhou.admin.name') || 'admin') : 'admin') }),
        el('button', { class: 'waf-btn waf-btn--sm', html: ico('refresh', 15), title: '刷新', onClick: () => load(cur) }),
        el('a', { class: 'waf-btn waf-btn--sm', href: '/app/admin', text: '管理后台' }),
        el('button', {
          class: 'waf-btn waf-btn--sm', text: '退出登录',
          onClick: async () => {
            const yes = await new Promise((res) => {
              const scrim = el('div', { class: 'modal-scrim' });
              const box = el('div', { class: 'modal' }, [
                el('div', { class: 'modal__head' }, [el('div', { class: 'modal__title', text: '退出登录' })]),
                el('div', { class: 'modal__body' }, [el('div', { text: '确认退出 WAF 控制台？退出后需重新登录。' })]),
                el('div', { class: 'modal__foot' }, [
                  el('button', { class: 'btn btn--ghost', text: '取消', onClick: () => { scrim.remove(); res(false); } }),
                  el('button', { class: 'btn btn--danger', text: '退出', onClick: () => { scrim.remove(); res(true); } }),
                ]),
              ]);
              scrim.appendChild(box);
              (document.getElementById('modalRoot') || document.body).appendChild(scrim);
            });
            if (!yes) return;
            try { await api.post('/api/admin/logout', {}, { admin: true }); } catch { /* 网络失败也本地退出 */ }
            A.clear();
            localStorage.removeItem('wuhou.admin.name');
            toast('已退出登录', 'ok');
            setTimeout(() => location.reload(), 600);
          },
        }),
        el('a', { class: 'waf-btn waf-btn--sm', href: '/', text: '返回主站' }),
      ]),
      body,
    ]),
  ]);
  host.innerHTML = '';
  host.appendChild(shell);

  // 概况页每 15 秒自刷新：控制台是给值守的人看的，手动点刷新太累
  clearInterval(timer);
  timer = setInterval(() => { if (cur === 'overview') load('overview'); }, 15000);

  await load('overview');
  return true;
}
