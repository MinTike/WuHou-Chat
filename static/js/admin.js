/* ============================================================
   管理员控制台（独立鉴权）
   ============================================================ */
import { el, avatar, fmtRelative, nameNode } from './util.js';
import { api, tokenStore } from './api.js';
import { toast, modal, confirm, prompt } from './ui.js';
import { icon, icoHtml } from './icons.js';

const A = tokenStore.admin;

async function ensureLogin() {
  if (A.get()) return true;
  return new Promise((resolve) => {
    const body = el('div', { class: 'form' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '管理员账号' }), el('input', { class: 'input', id: 'admUser' })]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '管理员密码' }), el('input', { class: 'input', id: 'admPass', type: 'password' })]),
    ]);
    modal({
      title: '管理员登录', body,
      footer: [{
        text: '登录', kind: 'primary', onClick: async () => {
          const username = document.querySelector('#admUser').value.trim();
          const password = document.querySelector('#admPass').value;
          try {
            const r = await api.post('/api/admin/login', { username, password }, { admin: true });
            A.set(r.token);
            if (r.admin && r.admin.username) localStorage.setItem('wuhou.admin.name', r.admin.username);
            toast('管理员已登录', 'ok');
            resolve(true);
          } catch (e) {
            toast(e.message, 'err');
            return false;   // 保持弹窗，允许重试；取消/关闭时由 onClose resolve(false)
          }
        }
      }, { text: '取消', onClick: () => resolve(false) }],
      onClose: () => resolve(false),
    });
  });
}

export async function renderSide(host) {
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'side__group-title' }, [el('span', { text: '管理' })]));
  host.appendChild(el('div', { class: 'contact-item', onClick: () => renderStage() }, [
    el('div', { class: 'avatar', style: { background: 'linear-gradient(135deg,#ff5d7d,#ffb43a)' }, html: icon('shield', 24) }),
    el('div', { class: 'grow' }, [
      el('div', { class: 'contact-item__name', text: '管理控制台' }),
      el('div', { class: 'contact-item__sub', text: A.get() ? '已登录' : '需要管理员令牌' }),
    ]),
  ]));
  if (A.get()) {
    host.appendChild(el('button', {
      class: 'btn btn--ghost btn--block', style: { margin: '10px 8px' }, text: '退出管理登录',
      onClick: async () => {
        try { await api.post('/api/admin/logout', {}, { admin: true }); } catch { /* 网络失败也照常本地退出 */ }
        A.clear();
        localStorage.removeItem('wuhou.admin.name');
        toast('已退出登录', 'info');
        renderSide(host);
      },
    }));
  }
}

/* ---------------- 修改密码 ---------------- */
async function dialogChangePassword() {
  return new Promise((resolve) => {
    const oldPwd = el('input', { class: 'input', id: 'cpOld', type: 'password', placeholder: '当前密码' });
    const newPwd = el('input', { class: 'input', id: 'cpNew', type: 'password', placeholder: '新密码（12-128 位）' });
    const newPwd2 = el('input', { class: 'input', id: 'cpNew2', type: 'password', placeholder: '再输一次新密码' });
    modal({
      title: '修改管理员密码', body: el('div', { class: 'form' }, [
        el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '当前密码' }), oldPwd]),
        el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '新密码' }), newPwd]),
        el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '确认新密码' }), newPwd2]),
        el('div', { class: 'muted', style: { fontSize: '11.5px' }, text: '修改成功后所有已登录设备需重新登录。' }),
      ]),
      footer: [
        { text: '取消', onClick: () => resolve(false) },
        {
          text: '确认修改', kind: 'primary', onClick: async () => {
            const a = oldPwd.value, b = newPwd.value, c = newPwd2.value;
            if (!a) { toast('请输入当前密码', 'warn'); return false; }
            if (b.length < 12) { toast('新密码至少 12 位', 'warn'); return false; }
            if (b !== c) { toast('两次输入的新密码不一致', 'warn'); return false; }
            try {
              await api.post('/api/admin/password', { old_password: a, new_password: b }, { admin: true });
              A.clear();
              toast('密码已修改，请重新登录', 'ok');
              resolve(true);
              return true;
            } catch (e) { toast(e.message, 'err'); return false; }
          },
        },
      ],
      onClose: () => resolve(false),
    });
  });
}

/** 独立页面入口：/app/admin 直接把控制台挂到指定容器（不依赖主应用骨架） */
export async function mountAdmin(host, tab = 'overview') {
  return renderConsole(host, tab);
}

export async function renderStage(tab = 'overview') {
  return renderConsole(document.querySelector('#stage'), tab);
}

/** 当前标签页的重载钩子：供各标签页内部（如「立即清理」）在完成后刷新自己 */
let reloadTab = null;

async function renderConsole(stage, tab = 'overview') {
  if (!await ensureLogin()) return false;
  stage.innerHTML = '';
  const box = el('div', { class: 'admin' });

  const tabs = el('div', { class: 'admin__tabs' });
  // WAF 有独立控制台（/app/waf），这里不再保留任何 WAF 页签 ——
  // 两套界面重复维护同一批功能，改一处忘一处只会造成不一致。
  const TABS = [['overview', '概况'], ['users', '用户'], ['groups', '群聊'], ['reports', '举报'], ['words', '违规词'], ['notice', '发布公告']];
  let cur = tab;
  const refresh = el('button', {
    class: 'btn btn--sm btn--ghost', html: icoHtml('refresh', 15), title: '刷新当前页',
    onClick: (e) => { const b = e.currentTarget; b.style.opacity = '.5'; setTimeout(() => { b.style.opacity = ''; }, 500); load(cur); },
  });
  const changePwd = el('button', {
    class: 'btn btn--sm btn--ghost', text: '修改密码',
    onClick: async () => { if (await dialogChangePassword()) { A.clear(); location.reload(); } },
  });
  const bar = el('div', { class: 'admin__toolbar', style: { justifyContent: 'space-between' } }, [tabs, el('div', { style: { display: 'flex', gap: '8px' } }, [changePwd, refresh])]);
  const load = async (k) => {
    cur = k;
    reloadTab = () => load(k);
    tabs.querySelectorAll('.seg__item').forEach((n) => n.classList.toggle('is-active', n.dataset.k === k));
    box.innerHTML = '';
    box.appendChild(bar);
    box.appendChild(el('div', { class: 'center', style: { padding: '40px' } }, [el('span', { class: 'spinner' })]));
    try {
      const node = await ({
        overview: tabOverview, users: tabUsers, groups: tabGroups,
        reports: tabReports, words: tabWords, notice: tabNotice,
      })[k]();
      box.innerHTML = '';
      box.appendChild(bar);
      box.appendChild(node);
    } catch (e) {
      box.innerHTML = ''; box.appendChild(bar);
      box.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'empty__title', text: e.message || '加载失败' })]));
      if (String(e.message).includes('管理员')) { A.clear(); }
    }
  };
  TABS.forEach(([k, label]) => tabs.appendChild(el('button', {
    class: 'seg__item' + (k === tab ? ' is-active' : ''), dataset: { k }, text: label, onClick: () => load(k),
  })));

  const view = el('div', { class: 'view' }, [
    el('div', { class: 'view__head' }, [
      el('div', { class: 'view__title', text: '管理控制台' }),
      el('span', { class: 'view__sub', text: '武侯Chat · 社区治理' }),
    ]),
    el('div', { class: 'view__body' }, [box]),
  ]);
  stage.appendChild(view);
  await load(tab);
  return true;
}

/* ---------------- 概况 ---------------- */
async function tabOverview() {
  const r = await api.get('/api/admin/overview', undefined, { admin: true });
  let ret = null;
  try { ret = await api.get('/api/admin/files/retention', undefined, { admin: true }); } catch { /* 旧服务端无此接口 */ }
  const box = el('div');
  box.appendChild(el('div', { class: 'admin__sec', text: '运行概览' }));
  const stats = el('div', { class: 'admin__stats' });
  const add = (n, l, ico, cls = '') => stats.appendChild(el('div', { class: `stat tilt ${cls}`, dataset: { tilt: '5' } }, [
    el('span', { class: 'stat__ico', html: icoHtml(ico, 17) }),
    el('div', { class: 'stat__num' + (typeof n !== 'number' ? ' stat__num--text' : ''), text: String(n) }),
    el('div', { class: 'stat__label', text: l }),
  ]));
  add(r.users, '注册用户', 'users');
  add(r.online, '当前在线', 'zap', r.online > 0 ? 'stat--ok' : '');
  add(r.groups, '群聊', 'hash');
  add(r.reports_pending, '待处理举报', 'flag', r.reports_pending ? 'stat--warn' : '');
  add(r.connections, 'WS 连接', 'chat');
  add(r.badwords, '违规词', 'shield');
  add(r.waf_hits, 'WAF 命中', 'alert');
  box.appendChild(stats);

  /* 安全态势：一眼回答「现在安全吗」。完整界面在独立控制台 /app/waf，这里只放结论 */
  box.appendChild(el('div', { class: 'admin__sec', text: '安全态势' }));
  const shTitle = el('div', { class: 'admin-shield__t', text: '探测中…' });
  const shSub = el('div', { class: 'admin-shield__d', text: 'JredonpT-WAF（定制版） · 全站流量实时检测' });
  const shNum = (l) => {
    const n = el('div', { class: 'admin-shield__n', text: '—' });
    const cell = el('div', { class: 'admin-shield__cell' }, [n, el('div', { class: 'admin-shield__l', text: l })]);
    return { cell, n };
  };
  const shBlocked = shNum('累计拦截');
  const shBanned = shNum('当前封禁');
  const shLevel = shNum('防护强度');
  const shieldBox = el('div', { class: 'admin-shield is-probe' }, [
    el('div', { class: 'admin-shield__main' }, [
      el('div', { class: 'admin-shield__ico', html: icoHtml('shield', 22) }),
      el('div', { class: 'grow' }, [shTitle, shSub]),
    ]),
    el('div', { class: 'admin-shield__nums' }, [shBlocked.cell, shBanned.cell, shLevel.cell]),
    el('a', { class: 'btn btn--sm btn--ghost admin-shield__go', href: '/app/waf', target: '_blank', rel: 'noopener',
      text: '打开控制台' }),
  ]);
  box.appendChild(shieldBox);
  (async () => {
    const [st, s] = await Promise.all([
      api.get('/api/admin/waf/status', undefined, { admin: true }).catch(() => ({})),
      api.get('/api/admin/waf/panel/stats', undefined, { admin: true }).catch(() => ({})),
    ]);
    const det = st.detect || {};
    let cls = 'is-bad', t = '防护未开启';
    if (det.enabled && !det.broken) {
      cls = st.online ? 'is-ok' : 'is-warn';
      t = st.online ? '防护正常' : '检测服务未响应';
    } else if (det.enabled && det.broken) {
      cls = 'is-warn'; t = '暂未拦截攻击';
    }
    shieldBox.classList.remove('is-probe');
    shieldBox.classList.add(cls);
    shTitle.textContent = t;
    shSub.textContent = det.enabled
      ? `${det.service || 'JredonpT-WAF（定制版）'} · 攻击自动识别并拦截`
      : 'WAF 未参与拦截判定';
    shBlocked.n.textContent = String(s.total_blocked ?? '—');
    shBanned.n.textContent = String(s.current_blocked_ips ?? '—');
    shLevel.n.textContent = st.defense_level != null ? `L${st.defense_level}` : '—';
  })();

  /* 系统信息：一眼看清运行状态，含文件保留期 */
  const retH = ret && ret.retention != null ? _humanSec(ret.retention) : '24 小时';
  const retTxt = ret && ret.enabled === false ? '已关闭' : `传输文件保留 ${retH}，超时自动清除`;
  box.appendChild(el('div', { class: 'admin__sec', text: '系统信息' }));
  const sys = el('div', { class: 'admin-sys' });
  const row = (ico, k, v) => sys.appendChild(el('div', { class: 'admin-sys__row tilt', dataset: { tilt: '4' } }, [
    el('span', { class: 'admin-sys__ico', html: icoHtml(ico, 17) }),
    el('div', { class: 'grow' }, [el('div', { class: 'admin-sys__k', text: k }), el('div', { class: 'admin-sys__v', text: v })]),
  ]));
  row('layers', '存储后端', r.storage === 'redis' ? 'Redis' : '服务端持久化存储（Redis 未连接）');
  row('zap', '消息总线', r.broker === 'rabbit' ? 'RabbitMQ' : '进程内事件总线（RabbitMQ 未连接）');
  /* 文件保留期：附「立即清理」，支持演练 */
  const purgeBtn = el('button', {
    class: 'btn btn--sm btn--ghost', text: '立即清理', title: '手动触发一轮过期文件清扫',
    onClick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true; b.textContent = '清理中…';
      try {
        const s = await api.post('/api/admin/files/purge', {}, { admin: true });
        toast(`清理完成：过期 ${s.purged || 0} 个（${((s.bytes || 0) / 1048576).toFixed(1)}MB）· 孤儿 ${s.orphans || 0} 个`, 'ok');
        // 注意：这里不能用 load()——它只在 renderConsole 内定义，各标签页函数里引用会抛
        // "load is not defined"。统一走模块级的 reloadTab 钩子。
        reloadTab && reloadTab();
      } catch (err) { toast(err.message, 'err'); }
      finally { b.disabled = false; b.textContent = '立即清理'; }
    },
  });
  sys.appendChild(el('div', { class: 'admin-sys__row tilt', dataset: { tilt: '4' } }, [
    el('span', { class: 'admin-sys__ico', html: icoHtml('trash', 17) }),
    el('div', { class: 'grow' }, [el('div', { class: 'admin-sys__k', text: '文件保留期' }), el('div', { class: 'admin-sys__v', text: retTxt })]),
    purgeBtn,
  ]));
  row('shield', '违规词库', `${r.badwords} 条 · 实时下发客户端`);
  /* WAF 只有一行状态 + 入口：完整界面在独立控制台 /app/waf，
     这里不重复做一套（重复维护两套同样的功能，改一处忘一处就会不一致）。 */
  const wafRow = el('div', { class: 'admin-sys__row tilt', dataset: { tilt: '4' } }, [
    el('span', { class: 'admin-sys__ico', html: icoHtml('shield', 17) }),
    el('div', { class: 'grow' }, [el('div', { class: 'admin-sys__k', text: 'WAF 防护' }),
      el('div', { class: 'admin-sys__v', text: '探测中…' })]),
    el('a', { class: 'btn btn--sm btn--ghost', href: '/app/waf', target: '_blank', rel: 'noopener',
      text: '打开控制台' }),
  ]);
  sys.appendChild(wafRow);
  api.get('/api/admin/waf/status', undefined, { admin: true }).then((w) => {
    const det = w.detect || {};
    wafRow.querySelector('.admin-sys__v').textContent = !det.enabled
      ? '未参与拦截判定'
      : det.broken ? '暂未拦截（引擎异常）'
        : `防护中 · ${det.service || 'JredonpT-WAF（定制版）'}`;
  }).catch(() => { wafRow.querySelector('.admin-sys__v').textContent = '探测失败'; });
  box.appendChild(sys);
  return box;
}

function _humanSec(s) {
  const n = Number(s) || 0;
  if (n % 86400 === 0) return `${n / 86400} 天`;
  if (n % 3600 === 0) return `${n / 3600} 小时`;
  return `${n} 秒`;
}

/* ---------------- 用户 ---------------- */
const USER_PAGE = 40;
async function tabUsers() {
  const box = el('div');
  const search = el('input', { class: 'input', placeholder: '按用户名 / 昵称筛选…' });
  const refresh = el('button', { class: 'btn btn--sm btn--ghost', html: icoHtml('refresh', 15), title: '刷新列表', onClick: () => load() });
  const count = el('span', { class: 'admin__count', text: '' });
  const wrap = el('div', { class: 'table-wrap' });
  const pager = el('div', { class: 'admin__pager' });
  box.append(el('div', { class: 'admin__toolbar' }, [search, refresh, count]), wrap, pager);

  let all = [];
  let total = 0;
  let page = 1;

  const draw = () => {
    const kw = search.value.trim().toLowerCase();
    const list = kw
      ? all.filter((u) => (u.username + ' ' + (u.nickname || '')).toLowerCase().includes(kw))
      : all;
    count.textContent = kw ? `匹配 ${list.length} / ${total} 位用户` : `共 ${total} 位用户`;

    const pages = Math.max(1, Math.ceil(list.length / USER_PAGE));
    page = Math.min(page, pages);
    const slice = list.slice((page - 1) * USER_PAGE, page * USER_PAGE);

    const table = el('table', { class: 'table' });
    table.innerHTML = '<thead><tr><th>用户</th><th>用户名</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead>';
    const tb = el('tbody');
    if (!slice.length) {
      tb.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'muted center', text: kw ? '没有匹配的用户' : '还没有注册用户', style: { padding: '26px' } })]));
    }
    slice.forEach((u) => {
      const tr = el('tr');
      tr.append(
        el('td', { style: { display: 'flex', alignItems: 'center', gap: '9px', minWidth: '150px' } }, [
          avatar(u, 'sm', { status: false }),
          nameNode(u, { text: u.nickname || '-' }),
        ]),
        el('td', { text: '@' + u.username }),
        el('td', {}, [el('span', { class: 'tag ' + (u.banned ? 'tag--danger' : u.online ? 'tag--ok' : ''), text: u.banned ? '已封禁' : u.online ? '在线' : '离线' })]),
        el('td', { text: u.created ? fmtRelative(u.created) : '-' }),
      );
      const ops = el('td', { style: { display: 'flex', gap: '6px', whiteSpace: 'nowrap' } });
      ops.append(
        el('button', { class: 'btn btn--sm', text: u.banned ? '解封' : '封禁', onClick: async () => {
          await api.post('/api/admin/users/action', { uid: u.id, action: u.banned ? 'unban' : 'ban' }, { admin: true });
          toast(u.banned ? '已解封' : '已封禁', 'ok'); load();
        } }),
        el('button', { class: 'btn btn--sm btn--ghost', text: '重置密码', onClick: async () => {
          const p = await prompt('输入新密码（8-128 位，不能留空）');
          if (!p || p.length < 8) { toast('新密码至少 8 位', 'warn'); return; }
          await api.post('/api/admin/users/action', { uid: u.id, action: 'reset_password', note: p }, { admin: true });
          toast('已重置', 'ok');
        } }),
        el('button', { class: 'btn btn--sm btn--danger', text: '删除', onClick: async () => {
          if (!await confirm(`删除用户 ${u.nickname || '@' + u.username}？`, { danger: true, okText: '删除' })) return;
          await api.post('/api/admin/users/action', { uid: u.id, action: 'delete' }, { admin: true });
          toast('已删除', 'ok'); load();
        } }),
      );
      tr.appendChild(ops);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    wrap.innerHTML = ''; wrap.appendChild(table);

    pager.innerHTML = '';
    if (pages > 1) {
      const info = el('span', { class: 'admin__pager__info', text: `第 ${page} / ${pages} 页` });
      const prev = el('button', { class: 'btn btn--sm btn--ghost', text: '上一页', disabled: page <= 1, onClick: () => { page--; draw(); wrap.scrollTop = 0; } });
      const next = el('button', { class: 'btn btn--sm btn--ghost', text: '下一页', disabled: page >= pages, onClick: () => { page++; draw(); wrap.scrollTop = 0; } });
      pager.append(prev, info, next);
    }
  };

  const load = async () => {
    const r = await api.get(`/api/admin/users?q=`, undefined, { admin: true });
    all = r.users || [];
    total = r.total ?? all.length;
    page = 1;
    draw();
  };
  search.addEventListener('input', () => { clearTimeout(search._t); search._t = setTimeout(() => { page = 1; draw(); }, 250); });
  await load();
  return box;
}

/* ---------------- 群聊 ---------------- */
async function tabGroups() {
  const box = el('div');
  const wrap = el('div', { class: 'table-wrap' });
  const count = el('span', { class: 'admin__count', text: '' });
  const refresh = el('button', { class: 'btn btn--sm btn--ghost', html: icoHtml('refresh', 15), title: '刷新列表', onClick: () => render() });
  box.append(el('div', { class: 'admin__toolbar' }, [count, refresh]), wrap);

  let list = [];
  const render = async () => {
    const r = await api.get('/api/admin/groups', undefined, { admin: true });
    list = r.groups || [];
    count.textContent = `共 ${list.length} 个群聊`;
    const table = el('table', { class: 'table' });
    table.innerHTML = '<thead><tr><th>群名</th><th>群主</th><th>成员</th><th>可见性</th><th>操作</th></tr></thead>';
    const tb = el('tbody');
    if (!list.length) {
      tb.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'muted center', text: '还没有群聊', style: { padding: '26px' } })]));
    }
    list.forEach((g) => {
      const tr = el('tr');
      tr.append(
        el('td', { text: g.name }),
        el('td', { text: g.owner_name || g.owner }),
        el('td', { text: String(g.member_count) }),
        el('td', {}, [el('span', { class: 'tag ' + (g.discoverable ? 'tag--ok' : ''), text: g.discoverable ? '公开' : '隐藏' })]),
      );
      const ops = el('td', { style: { display: 'flex', gap: '6px', whiteSpace: 'nowrap' } }, [
        el('button', { class: 'btn btn--sm btn--ghost', text: g.discoverable ? '隐藏' : '已隐藏', disabled: !g.discoverable, onClick: async () => {
          await api.post('/api/admin/groups/action', { gid: g.id, action: 'hide' }, { admin: true });
          toast('已隐藏', 'ok');
          render();                                   // 之前不重绘，列表会一直显示旧状态
        } }),
        el('button', { class: 'btn btn--sm btn--danger', text: '解散', onClick: async () => {
          if (!await confirm(`解散群聊「${g.name}」？群聊与记录将不可恢复。`, { danger: true, okText: '解散' })) return;
          try {
            await api.post('/api/admin/groups/action', { gid: g.id, action: 'dissolve' }, { admin: true });
          } catch (e) { toast(e.message, 'err'); return; }
          toast('已解散', 'ok');
          // 解散成功：直接从列表移除这一行，不等整表重绘，反馈更即时
          tr.remove();
          list = list.filter((x) => x.id !== g.id);
          count.textContent = `共 ${list.length} 个群聊`;
          if (!list.length) render();
        } }),
      ]);
      tr.appendChild(ops);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    wrap.innerHTML = ''; wrap.appendChild(table);
  };
  await render();
  return box;
}

/* ---------------- 举报 ---------------- */
async function tabReports() {
  const box = el('div');
  const count = el('span', { class: 'admin__count', text: '' });
  const refresh = el('button', { class: 'btn btn--sm btn--ghost', html: icoHtml('refresh', 15), title: '刷新列表', onClick: () => render() });
  const listBox = el('div');
  box.append(el('div', { class: 'admin__toolbar' }, [count, refresh]), listBox);

  const STATUS = { pending: ['tag--warn', '待处理'], resolved: ['tag--ok', '已处理'], banned: ['tag--danger', '已封禁'] };
  let left = 0;

  const render = async () => {
    const r = await api.get('/api/admin/reports', undefined, { admin: true });
    const items = r.reports || [];
    left = items.length;
    count.textContent = `待处理 ${items.filter((x) => x.status === 'pending').length} · 共 ${items.length} 条`;
    listBox.innerHTML = '';
    if (!items.length) {
      listBox.appendChild(el('div', { class: 'muted center', style: { padding: '30px' }, text: '暂无举报' }));
      return;
    }
    items.forEach((rep) => {
      const [stCls, stTxt] = STATUS[rep.status] || ['', rep.status || '未知'];
      const ico = rep.target_type === 'group' ? 'users' : rep.target_type === 'message' ? 'chat' : 'user';
      const card = el('div', { class: 'device-card' });
      /** 处理后就地移除本条：卡片直接消失，不必等整表重绘 */
      const settle = async (action, doneMsg) => {
        try { await api.post('/api/admin/reports/handle', { rid: rep.id, action }, { admin: true }); }
        catch (e) { toast(e.message, 'err'); return; }
        toast(doneMsg, 'ok');
        card.remove();
        left -= 1;
        if (left <= 0) {
          listBox.innerHTML = '';
          listBox.appendChild(el('div', { class: 'muted center', style: { padding: '30px' }, text: '暂无举报' }));
          count.textContent = '共 0 条';
        } else {
          count.textContent = `共 ${left} 条`;
        }
      };
      card.append(
        el('div', { class: 'device-card__icon', html: icon(ico, 19) }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'setting-row__label' }, [
            el('span', { text: `${rep.target_type === 'group' ? '群聊' : rep.target_type === 'message' ? '消息' : '用户'} · ${rep.reason}` }),
            el('span', { class: 'tag ' + stCls, style: { marginLeft: '8px' }, text: stTxt }),
          ]),
          el('div', { class: 'setting-row__desc', text: `举报人：${(rep.reporter_user || {}).nickname || rep.reporter} · ${fmtRelative(rep.ts)} · ${rep.detail || '无补充'}` }),
          el('div', { class: 'setting-row__desc', text: `对象：${(rep.target_user || {}).nickname || (rep.target_group || {}).name || rep.target_id}` }),
          rep.target_message ? el('div', { class: 'admin__quote' }, [
            el('span', { class: 'tag', text: '被举报内容' }),
            el('span', { text: rep.target_message.text || '（该消息已撤回或无法解密）' }),
          ]) : null,
        ]),
        el('button', { class: 'btn btn--sm btn--ok', text: '已处理', disabled: rep.status === 'resolved', onClick: () => settle('resolved', '已标记为已处理') }),
        el('button', { class: 'btn btn--sm btn--danger', text: '封禁对象', onClick: () => settle('banned', '已封禁该对象') }),
      );
      listBox.appendChild(card);
    });
  };
  await render();

  /* ---- 动态精选：内容治理的一部分（精选进入广场精选位，置顶优先展示） ---- */
  box.appendChild(el('div', { class: 'settings__section-title', style: { marginTop: '20px' } }, [
    el('span', { text: '动态精选' })]));
  const moBox = el('div', { class: 'muted', style: { padding: '8px 0' }, text: '加载中…' });
  box.appendChild(moBox);
  (async () => {
    let items = [];
    try { items = (await api.get('/api/admin/moments?limit=30', undefined, { admin: true })).moments || []; }
    catch { moBox.textContent = '动态列表加载失败'; return; }
    moBox.className = '';
    moBox.innerHTML = '';
    if (!items.length) {
      moBox.appendChild(el('div', { class: 'muted', style: { padding: '8px 0' }, text: '还没有动态' }));
      return;
    }
    items.forEach((mo) => {
      const feat = el('button', {
        class: 'btn btn--sm ' + (mo.featured ? 'btn--ok' : ''), text: mo.featured ? '已精选' : '设精选',
        onClick: async () => {
          try {
            await api.post('/api/admin/moments/feature', { mid: mo.id, featured: !mo.featured, pinned: mo.pinned }, { admin: true });
            mo.featured = !mo.featured;
            feat.textContent = mo.featured ? '已精选' : '设精选';
            feat.classList.toggle('btn--ok', mo.featured);
            toast(mo.featured ? '已加入广场精选' : '已移出精选', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        },
      });
      const pin = el('button', {
        class: 'btn btn--sm ' + (mo.pinned ? 'btn--ok' : ''), text: mo.pinned ? '已置顶' : '置顶',
        onClick: async () => {
          try {
            await api.post('/api/admin/moments/feature', { mid: mo.id, featured: mo.featured, pinned: !mo.pinned }, { admin: true });
            mo.pinned = !mo.pinned;
            pin.textContent = mo.pinned ? '已置顶' : '置顶';
            pin.classList.toggle('btn--ok', mo.pinned);
            toast(mo.pinned ? '已在精选位置顶' : '已取消置顶', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        },
      });
      moBox.appendChild(el('div', { class: 'device-card' }, [
        el('div', { class: 'device-card__icon', html: icon('sparkles', 19) }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'setting-row__label' }, [
            el('span', { text: mo.author || '?' }),
            mo.featured ? el('span', { class: 'tag tag--ok', style: { marginLeft: '8px' }, text: '精选' }) : null,
            mo.pinned ? el('span', { class: 'tag tag--warn', style: { marginLeft: '6px' }, text: '置顶' }) : null,
          ]),
          el('div', { class: 'setting-row__desc', text: `${fmtRelative(mo.ts)} · 赞 ${mo.likes} · ${(mo.media ? `含 ${mo.media} 个媒体` : '纯文字')}（正文为密文，不做内容展示）` }),
        ]),
        pin, feat,
      ]));
    });
  })();

  return box;
}

/* ---------------- 违规词 ---------------- */
const WORD_PAGE = 120;
async function tabWords() {
  const box = el('div');
  const addInput = el('input', { class: 'input', placeholder: '输入新词，多个用逗号 / 空格分隔' });
  const search = el('input', { class: 'input', placeholder: '搜索已有词条…' });
  const refresh = el('button', { class: 'btn btn--sm btn--ghost', html: icoHtml('refresh', 15), title: '刷新词库', onClick: () => load() });
  const count = el('span', { class: 'admin__count', text: '' });
  const chips = el('div', { class: 'admin__words' });
  const pager = el('div', { class: 'admin__pager' });

  box.append(
    el('div', { style: { display: 'flex', gap: '8px' } }, [
      addInput,
      el('button', { class: 'btn btn--primary', text: '添加', onClick: async () => {
        const ws = String(addInput.value || '').split(/[,，\s]+/).filter(Boolean);
        if (!ws.length) return;
        await api.post('/api/admin/badwords', { words: ws }, { admin: true });
        toast(`已添加 ${ws.length} 个词`, 'ok'); addInput.value = ''; await load();
      } }),
    ]),
    el('div', { class: 'admin__toolbar' }, [search, refresh, count]),
    chips,
    pager,
  );

  let all = [];
  let page = 1;
  const draw = () => {
    const kw = search.value.trim().toLowerCase();
    const list = kw ? all.filter((w) => w.toLowerCase().includes(kw)) : all;
    count.textContent = kw ? `匹配 ${list.length} / ${all.length} 条` : `共 ${all.length} 条 · 词库会下发到客户端做本地检测`;

    const pages = Math.max(1, Math.ceil(list.length / WORD_PAGE));
    page = Math.min(Math.max(1, page), pages);
    const slice = list.slice((page - 1) * WORD_PAGE, page * WORD_PAGE);

    chips.innerHTML = '';
    if (!slice.length) {
      chips.appendChild(el('div', { class: 'muted center', style: { padding: '26px' }, text: kw ? '没有匹配的词条' : '词库为空' }));
    }
    slice.forEach((w) => chips.appendChild(el('span', {
      class: 'tag', title: '点击删除', text: w + ' ✕',
      onClick: async () => {
        if (!await confirm(`从词库中移除「${w}」？`, { danger: true, okText: '移除' })) return;
        await api.del(`/api/admin/badwords/${encodeURIComponent(w)}`, undefined, { admin: true });
        toast('已移除', 'ok'); await load();
      },
    })));

    pager.innerHTML = '';
    if (pages > 1) {
      const info = el('span', { class: 'admin__pager__info', text: `第 ${page} / ${pages} 页` });
      const prev = el('button', { class: 'btn btn--sm btn--ghost', text: '上一页', disabled: page <= 1, onClick: () => { page--; draw(); } });
      const next = el('button', { class: 'btn btn--sm btn--ghost', text: '下一页', disabled: page >= pages, onClick: () => { page++; draw(); } });
      pager.append(prev, info, next);
    }
  };

  const load = async () => {
    const r = await api.get('/api/admin/badwords', undefined, { admin: true });
    all = r.words || [];
    draw();
  };
  search.addEventListener('input', () => { page = 1; draw(); });
  await load();
  return box;
}

/* ---------------- 公告 / 站点捐赠 ---------------- */
const LEVELS = [['info', '公告'], ['success', '喜讯'], ['warn', '提醒'], ['danger', '重要']];

async function tabNotice() {
  const box = el('div', { class: 'form' });
  const ta = el('textarea', { class: 'input', rows: 4, placeholder: '公告内容（会同步推送到公共聊天室，并长期保留在侧边公告栏）…', style: { height: 'auto', padding: '10px 12px' } });
  let level = 'info';
  const seg = el('div', { class: 'seg' });
  const syncSeg = () => Array.from(seg.children).forEach((b) => b.classList.toggle('is-active', b.dataset.v === level));
  LEVELS.forEach(([v, label]) => seg.appendChild(el('button', {
    class: 'seg__item', type: 'button', dataset: { v }, text: label,
    onClick: () => { level = v; syncSeg(); },
  })));
  syncSeg();

  box.append(ta, seg, el('button', {
    class: 'btn btn--primary', text: '发布公告', onClick: async () => {
      const t = String(ta.value || '').trim();
      if (!t) { toast('请输入公告内容', 'err'); return; }
      await api.post('/api/admin/announce', { text: t, level }, { admin: true });
      toast('公告已发布', 'ok'); ta.value = '';
      await renderList();
    }
  }));

  box.appendChild(el('div', { class: 'settings__section-title', style: { marginTop: '18px' } }, [
    el('span', { text: '公告列表' })]));
  const list = el('div');
  box.appendChild(list);

  const renderList = async () => {
    list.innerHTML = '';
    const r = await api.get('/api/admin/announcements', undefined, { admin: true });
    const items = r.announcements || [];
    if (!items.length) {
      list.appendChild(el('div', { class: 'muted', text: '还没有公告' }));
      return;
    }
    items.forEach((a) => list.appendChild(el('div', { class: 'device-card' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'setting-row__label ellipsis', text: a.text.slice(0, 60) }),
        el('div', { class: 'setting-row__desc', text: `${fmtRelative(a.ts)} · ${(LEVELS.find(([v]) => v === a.level) || ['', '公告'])[1]}${a.pinned ? ' · 已置顶' : ''}${a.hidden ? ' · 已隐藏' : ''}` }),
      ]),
      el('button', {
        class: 'btn btn--sm', text: a.pinned ? '取消置顶' : '置顶',
        onClick: async () => {
          await api.post(`/api/admin/announcements/${a.id}/toggle`, { pinned: !a.pinned }, { admin: true });
          await renderList();
        }
      }),
      el('button', {
        class: 'btn btn--sm btn--ghost', text: a.hidden ? '显示' : '隐藏',
        onClick: async () => {
          await api.post(`/api/admin/announcements/${a.id}/toggle`, { hidden: !a.hidden }, { admin: true });
          await renderList();
        }
      }),
      el('button', {
        class: 'btn btn--sm btn--danger', text: '删除',
        onClick: async () => {
          if (!await confirm(`删除这条公告？`, { danger: true, okText: '删除' })) return;
          await api.del(`/api/admin/announcements/${a.id}`, undefined, { admin: true });
          toast('已删除', 'ok'); await renderList();
        }
      }),
    ])));
  };
  await renderList();

  /* ---- 站点捐赠配置 ---- */
  box.appendChild(el('div', { class: 'settings__section-title', style: { marginTop: '20px' } }, [
    el('span', { text: '站点捐赠栏' })]));
  const d = (await api.get('/api/admin/donate', undefined, { admin: true })).donate || {};
  const fTitle = el('input', { class: 'input', value: d.title || '' });
  // textarea 的初值要用 .value 赋值（setAttribute('value') 对它无效）
  const fIntro = el('textarea', { class: 'input', rows: 2, style: { height: 'auto', padding: '10px 12px' } });
  fIntro.value = d.intro || '';
  const fNote = el('textarea', { class: 'input', rows: 2, style: { height: 'auto', padding: '10px 12px' } });
  fNote.value = d.note || '';
  const fEnabled = el('input', { type: 'checkbox', style: { width: '18px', height: '18px' } });
  fEnabled.checked = d.enabled !== false;
  const fPayNote = el('input', { class: 'input', placeholder: '留空 = 自动用「用户名#ID后6位」', value: d.pay_note || '' });

  /* 捐赠名单：一行一位，格式「名字|留言|金额」 */
  const donors = Array.isArray(d.list) ? d.list.map((x) => [x.name || '', x.msg || '', x.amount || '']) : [];
  const fDonors = el('textarea', {
    class: 'input', rows: 4, style: { height: 'auto', padding: '10px 12px' },
    placeholder: '每行一位：名字|留言|金额\n例如：匆匆那年|站长长提神|¥8.80',
  });
  fDonors.value = donors.map((x) => x.join('|')).join('\n');
  const parseDonors = () => String(fDonors.value || '').split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .slice(0, 60)
    .map((l) => {
      const [name, msg, amount] = l.split('|').map((s) => s.trim());
      return { name: name || '', msg: msg || '', amount: amount || '' };
    })
    .filter((x) => x.name);

  /* 收款方式：两行（名称 / 链接或收款码图片地址） */
  const methods = Array.isArray(d.methods) ? d.methods.slice(0, 6) : [];
  const mBox = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const drawMethods = () => {
    mBox.innerHTML = '';
    methods.forEach((m, i) => {
      const link = el('input', { class: 'input', placeholder: '收款链接（可选）', value: m.link || '',
        onInput: (e) => { m.link = e.target.value; } });
      const qr = el('input', { class: 'input', placeholder: '收款码图片地址（可选）', value: m.qr || '',
        onInput: (e) => { m.qr = e.target.value; } });
      const upBtn = el('button', {
        class: 'btn btn--sm btn--ghost', type: 'button', text: '上传收款码', title: '直接从本机选择收款码图片',
        onClick: async () => {
          const files = await new Promise((res) => {
            const i2 = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
            document.body.appendChild(i2);
            i2.onchange = () => { res(Array.from(i2.files || [])); i2.remove(); };
            i2.click();
          });
          const f = files[0];
          if (!f) return;
          if (f.size > 3 * 1024 * 1024) { toast('收款码图片不能超过 3MB', 'err'); return; }
          try {
            upBtn.disabled = true; upBtn.textContent = '上传中…';
            const res = await fetch(`/api/admin/donate/qr?name=${encodeURIComponent(f.name)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${tokenStore.admin.get()}` },
              body: await f.arrayBuffer(),
            });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j || !j.ok) throw new Error((j && j.error) || '上传失败');
            m.qr = j.data.url;
            m.kind = 'qr';
            qr.value = m.qr;
            drawMethods();
            toast('收款码已上传', 'ok');
          } catch (e) { toast(`上传失败：${e.message}`, 'err'); }
          finally { upBtn.disabled = false; upBtn.textContent = '上传收款码'; }
        },
      });
      mBox.appendChild(el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
        el('input', { class: 'input', style: { maxWidth: '150px' }, placeholder: '名称，如 支付宝', value: m.name || '',
          onInput: (e) => { m.name = e.target.value; } }),
        link, qr, upBtn,
        el('button', { class: 'btn btn--sm btn--ghost', text: '移除', onClick: () => { methods.splice(i, 1); drawMethods(); } }),
      ]));
    });
    mBox.appendChild(el('button', {
      class: 'btn btn--sm', text: '＋ 添加收款方式',
      onClick: () => { methods.push({ name: '', kind: 'link', link: '', qr: '' }); drawMethods(); },
    }));
  };
  drawMethods();

  box.append(
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '标题' }), fTitle]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '说明文案' }), fIntro]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '备注（可选）' }), fNote]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '付款备注（用户侧蓝色信息条展示并可一键复制）' }), fPayNote]),
    el('div', { class: 'setting-row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'setting-row__label', text: '开启捐赠栏' }),
        el('div', { class: 'setting-row__desc', text: '关闭后用户侧只显示"站长当前未开启捐赠通道"' }),
      ]),
      el('div', { class: 'setting-row__ctrl' }, [fEnabled]),
    ]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '收款方式' }), mBox]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '捐赠名单（每行一位：名字|留言|金额，最多 60 行）' }), fDonors]),
    el('button', {
      class: 'btn btn--primary', text: '保存捐赠配置', onClick: async () => {
        await api.put('/api/admin/donate', {
          enabled: fEnabled.checked,
          title: fTitle.value, intro: fIntro.value, note: fNote.value,
          pay_note: fPayNote.value,
          methods: methods.filter((m) => (m.name || '').trim() && (m.link || m.qr)),
          list: parseDonors(),
        }, { admin: true });
        toast('捐赠配置已保存', 'ok');
      }
    }),
  );

  return box;
}
