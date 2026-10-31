/* ============================================================
   用户设置：个人中心 / 安全中心 / 黑名单 / 注销 / 关于
   ============================================================ */
import { el, avatar, fmtRelative, nameNode } from './util.js';
import { api, tokenStore } from './api.js';
import { toast, modal, confirm, prompt } from './ui.js';
import { state, emit, loadTags } from './state.js';
import { openAvatarEditor, openBirthEditor, openEditProfile } from './cards.js';
import * as C from './crypto.js';
import { icon, icoHtml } from './icons.js';
import { tagChip } from './tags.js';

const PICK = ['🦊', '🐼', '🐯', '🐨', '🐸', '🐵', '🦁', '🐧', '🦄', '🐙', '🦉', '🐳', '🌙', '🔥', '🍀', '🎧'];

export function renderSide(host) {
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'side__group-title' }, [el('span', { text: '设置' })]));
  // 顶部不再放「我的头像卡」：它与下方「个人中心」入口重复，且个人中心页已有完整资料卡
  const items = [
    ['profile', '个人中心', 'user'],
    ['privacy', '隐私设置', 'eye'],
    ['security', '安全中心', 'shield'],
    ['block', '拉黑管理', 'ban'],
    ['about', '关于', 'info'],
  ];
  items.forEach(([k, label, ico]) => {
    host.appendChild(el('div', {
      class: 'contact-item' + (activePane === k ? ' is-active' : ''),
      dataset: { pane: k }, onClick: () => switchPane(k),
    }, [
      el('span', { class: 'contact-item__ico', html: icon(ico, 17) }),
      el('div', { class: 'contact-item__name', text: label }),
    ]));
  });
  host.appendChild(el('button', {
    class: 'btn btn--ghost btn--block', style: { margin: '14px 8px' },
    text: '退出登录', onClick: () => logout(),
  }));
}

/** 当前面板（供侧栏导航高亮） */
let activePane = 'profile';

const PANES = {
  profile: paneProfile,
  privacy: panePrivacy,
  security: paneSecurity,
  block: paneBlock,
  about: paneAbout,
};

/** 切换面板：侧栏导航为唯一入口，调用后同步高亮 */
export async function switchPane(k) {
  activePane = k;
  document.querySelectorAll('#sideBody [data-pane]')
    .forEach((n) => n.classList.toggle('is-active', n.dataset.pane === k));
  const stage = document.querySelector('#stage');
  const paneEl = stage.querySelector('.settings__pane');
  if (!paneEl) { await renderStage(k); return; }
  paneEl.innerHTML = '';
  paneEl.appendChild(el('div', { class: 'center', style: { padding: '40px' } }, [el('span', { class: 'spinner' })]));
  const node = await PANES[k]();
  paneEl.innerHTML = '';
  paneEl.appendChild(node);
}

export async function renderStage(pane = 'profile') {
  activePane = pane;
  const stage = document.querySelector('#stage');
  stage.innerHTML = '';
  const paneEl = el('div', { class: 'settings__pane' });

  const view = el('div', { class: 'view' }, [
    el('div', { class: 'view__head' }, [
      el('div', { class: 'view__title', text: '设置' }),
      el('span', { class: 'view__sub', text: '武侯Chat · 你的数据与密钥都由你掌控' }),
    ]),
    el('div', { class: 'view__body' }, [el('div', { class: 'settings settings--single' }, [paneEl])]),
  ]);
  stage.appendChild(view);
  document.querySelectorAll('#sideBody [data-pane]')
    .forEach((n) => n.classList.toggle('is-active', n.dataset.pane === pane));
  paneEl.appendChild(el('div', { class: 'center', style: { padding: '40px' } }, [el('span', { class: 'spinner' })]));
  const node = await PANES[pane]();
  paneEl.innerHTML = '';
  paneEl.appendChild(node);
}

/* ---------------- 个人中心 ---------------- */
async function paneProfile() {
  const u = (await api.get('/api/users/me')).user;
  state.me = u;
  const box = el('div');
  box.appendChild(el('div', { class: 'settings__section-title' }, [el('span', { text: '个人中心' })]));

  const hero = el('div', { class: 'card-hero' }, [
    el('button', {
      class: 'avatar-pick-btn', type: 'button', title: '编辑头像',
      onClick: () => openAvatarEditor(u, () => switchPane('profile')),
    }, [avatar(u, 'xl', { status: false }), el('span', { class: 'avatar-pick-btn__tip', text: '编辑头像' })]),
    el('div', { class: 'card-hero__info grow' }, [
      el('div', { class: 'card-hero__name' }, [nameNode(u)]),
      el('div', { class: 'card-hero__sub', text: `@${u.username}` }),
      el('div', { class: 'card-hero__sub', text: u.signature || '尚未填写个性签名' }),
    ]),
    // 下方就是完整的资料编辑列表，这里不再重复放「编辑资料」按钮
  ]);
  box.appendChild(hero);

  const row = (label, desc, ctrl) => el('div', { class: 'setting-row' }, [
    el('div', { class: 'grow' }, [el('div', { class: 'setting-row__label', text: label }), desc ? el('div', { class: 'setting-row__desc', text: desc }) : null]),
    el('div', { class: 'setting-row__ctrl' }, [ctrl]),
  ]);

  box.appendChild(row('昵称', u.nickname, el('button', { class: 'btn btn--sm', text: '修改', onClick: async () => {
    const v = await prompt('修改昵称', { value: u.nickname });
    if (!v) return;
    await api.put('/api/users/me', { nickname: v }); toast('已更新', 'ok'); switchPane('profile'); emit('ui:refresh');
  } })));
  box.appendChild(row('个性签名', u.signature || '未填写', el('button', { class: 'btn btn--sm', text: '修改', onClick: async () => {
    const v = await prompt('修改个性签名', { value: u.signature || '', multiline: true });
    if (v === null) return;
    await api.put('/api/users/me', { signature: v }); toast('已更新', 'ok'); switchPane('profile'); emit('ui:refresh');
  } })));
  box.appendChild(row('拍一拍后缀', u.poke || '拍了拍', el('button', { class: 'btn btn--sm', text: '修改', onClick: async () => {
    const v = await prompt('好友拍你时显示的后缀', { value: u.poke || '拍了拍' });
    if (!v) return;
    await api.put('/api/users/me', { poke: v }); toast('已更新', 'ok'); switchPane('profile');
  } })));
  box.appendChild(row('头像', '支持表情头像或上传图片（原图存储，服务端做内容安全检测）', el('button', { class: 'btn btn--sm', text: '更换', onClick: () => openAvatarEditor(u, () => switchPane('profile')) })));
  box.appendChild(row('年龄 / 性别 / 生日',
    `${u.age ?? '未填写'} · ${({ male: '男', female: '女', other: '其他', unknown: '保密' })[u.gender] || '保密'} · ${u.birthday || '未填写'}`,
    el('button', { class: 'btn btn--sm', text: '修改', onClick: () => openBirthEditor(u, () => switchPane('profile')) })));
  box.appendChild(row('用户名', `@${u.username}（登录用，不可修改）`, el('span', { class: 'tag', text: '只读' })));
  box.appendChild(row('登录密码', '修改密码后，加密私钥将用新口令重新加密', el('button', { class: 'btn btn--sm', text: '修改密码', onClick: () => changePassword() })));
  box.appendChild(row('加密方式', C.myPubB64() || '未加载',
    el('button', { class: 'btn btn--sm', text: '刷新', onClick: async () => { try { await C.ensureGlobal(); toast('全局密钥已就绪', 'ok'); } catch (e) { toast(e.message, 'err'); } } })));
  // 老账号（统一密钥时代注册）公钥是占位值，这里给一条升级通道
  if (!C.hasIdentity()) {
    box.appendChild(row('会话级密钥', '你的账号还是「全站同一把密钥」的旧模式，升级后私聊改用双方独有的会话密钥',
      el('button', { class: 'btn btn--sm btn--primary', text: '升级', onClick: async () => {
        const pw = await prompt('请输入当前登录密码（用于封装私钥）', { password: true });
        if (!pw) return;
        try { await C.upgradeIdentity(pw); toast('已升级为会话级密钥', 'ok'); switchPane('profile'); }
        catch (e) { toast(e.message || '升级失败', 'err'); }
      } })));
  }
  return box;
}

/* ---------------- 隐私设置 ---------------- */
const ADD_MODES = [['any', '所有人可添加'], ['question', '需回答验证问题'], ['none', '不允许陌生人添加']];
const INVITE_MODES = [['confirm', '需我同意后加入'], ['any', '自动加入'], ['none', '不允许被邀请']];
const MOMENT_SCOPES = [['all', '全部好友可见'], ['allow', '仅选中的好友可见'], ['deny', '选中的好友不可见'], ['tag', '按分组可见'], ['self', '仅自己可见']];

function segGroup(value, options, onPick) {
  const wrap = el('div', { class: 'seg' });
  options.forEach(([v, t]) => {
    wrap.appendChild(el('button', {
      class: 'seg__item' + (value === v ? ' is-active' : ''), type: 'button', text: t,
      onClick: () => onPick(v),
    }));
  });
  return wrap;
}

async function panePrivacy() {
  const u = (await api.get('/api/users/me')).user;
  state.me = u;
  const fam = state.friends.length ? state.friends : (await import('./state.js')).loadFriends().then(() => state.friends);
  const friends = await fam;
  const box = el('div');
  box.appendChild(el('div', { class: 'settings__section-title' }, [el('span', { text: '隐私设置' })]));

  const row = (label, desc, ctrl) => el('div', { class: 'setting-col' }, [
    el('div', {}, [el('div', { class: 'setting-row__label', text: label }), el('div', { class: 'setting-row__desc', text: desc })]),
    ctrl,
  ]);

  /* 1. 陌生人添加我的方式 */
  const addWrap = el('div', { class: 'privacy-card' });
  const addExtra = el('div', { class: 'privacy-card__extra' });
  const renderAddExtra = () => {
    addExtra.innerHTML = '';
    if (u.add_me_mode !== 'question') return;
    addExtra.append(
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '验证问题' }),
        el('input', { class: 'input', name: 'q', value: u.add_question || '', placeholder: '例如：我最喜欢的动物是什么？' })]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '正确答案' }),
        el('input', { class: 'input', name: 'a', value: u.add_answer || '', placeholder: '答案不区分大小写' })]),
      el('button', { class: 'btn btn--sm btn--primary', text: '保存问题与答案', onClick: async () => {
        const fd = {
          q: addExtra.querySelector('[name=q]').value,
          a: addExtra.querySelector('[name=a]').value,
        };
        await api.put('/api/users/me', { add_me_mode: 'question', add_question: fd.q, add_answer: fd.a });
        toast('已保存', 'ok'); switchPane('privacy');
      } }),
    );
  };
  addWrap.append(
    row('陌生人添加我的方式', '控制谁可以向你发送好友申请', segGroup(u.add_me_mode || 'any', ADD_MODES, async (v) => {
      await api.put('/api/users/me', { add_me_mode: v });
      u.add_me_mode = v; toast('已更新', 'ok'); switchPane('privacy');
    })),
    addExtra);
  box.appendChild(addWrap);
  renderAddExtra();

  /* 2. 好友邀请我加入群聊的方式 */
  box.appendChild(el('div', { class: 'privacy-card' }, [
    row('好友邀请我加入群聊的方式', '设为「需我同意」时，邀请需你确认后才生效',
      segGroup(u.group_invite_mode || 'confirm', INVITE_MODES, async (v) => {
        await api.put('/api/users/me', { group_invite_mode: v });
        u.group_invite_mode = v; toast('已更新', 'ok'); switchPane('privacy');
      })),
  ]));

  /* 3. 动态的默认可见范围 */
  const picked = new Set(u.moments_list || []);
  const listBox = el('div', { class: 'privacy-picker' });
  const listTip = el('div', { class: 'setting-row__desc', style: { paddingTop: '6px' }, text: '勾选即时保存，无需再点保存' });
  // 名单改为「勾选即保存」：不再提供保存按钮，避免勾完忘了点、白选一遍
  let saving = 0;
  const saveList = async () => {
    const seq = ++saving;
    try {
      await api.put('/api/users/me', { moments_scope: u.moments_scope, moments_list: Array.from(picked) });
      if (seq === saving) listTip.textContent = '已保存 · 勾选即时生效';
    } catch (e) { if (seq === saving) { listTip.textContent = '保存失败，请重试'; toast(e.message, 'err'); } }
  };
  const renderList = () => {
    listBox.innerHTML = '';
    // 「按分组可见」时这份名单换成标签：div 内容和 allow/deny 的好友名单共用一份 picked，
    // 但语义完全不同，所以先按范围分叉再渲染。
    if (u.moments_scope === 'tag') {
      const tags = state.tags || [];
      if (!tags.length) {
        listBox.appendChild(el('div', { class: 'muted', style: { padding: '6px 0' }, text: '还没有分组，去通讯录给好友打个标签' }));
        return;
      }
      tags.forEach((t) => listBox.appendChild(tagChip(t, {
        active: picked.has(t.id), count: t.count, small: true,
        onClick: () => { picked.has(t.id) ? picked.delete(t.id) : picked.add(t.id); renderList(); saveList(); },
      })));
      return;
    }
    if (!friends.length) {
      listBox.appendChild(el('div', { class: 'muted', style: { padding: '6px 0' }, text: '还没有好友可选' }));
      return;
    }
    friends.forEach((f) => {
      const on = picked.has(f.id);
      listBox.appendChild(el('button', {
        class: 'chip' + (on ? ' is-active' : ''), type: 'button',
        onClick: () => { on ? picked.delete(f.id) : picked.add(f.id); renderList(); saveList(); },
      }, [nameNode(f, { single: false })]));
    });
  };
  renderList();
  // 「按分组」需要标签列表：设置页不一定刚启动，这里兜一次刷新
  loadTags().then(() => renderList()).catch(() => {});
  const scopeCard = el('div', { class: 'privacy-card' });
  const renderScope = () => {
    scopeCard.innerHTML = '';
    scopeCard.append(
      row('动态的可见范围', '新发布动态的默认范围，发布后仍可单独调整',
        segGroup(u.moments_scope || 'all', MOMENT_SCOPES, async (v) => {
          await api.put('/api/users/me', { moments_scope: v, moments_list: Array.from(picked) });
          u.moments_scope = v; toast('已更新', 'ok'); switchPane('privacy');
        })),
    );
    const showList = u.moments_scope === 'allow' || u.moments_scope === 'deny' || u.moments_scope === 'tag';
    if (showList) {
      scopeCard.append(
        el('div', { class: 'field' }, [
          el('span', { class: 'field__label', text: {
            allow: '谁可以看见', deny: '谁不可以看见', tag: '哪些分组可以看见',
          }[u.moments_scope] || '名单' }),
          listBox, listTip]),
      );
    }
  };
  renderScope();
  box.appendChild(scopeCard);

  /* 4. 陌生人能否查看我的动态 */
  const stSw = el('div', { class: 'switch' + (u.moments_stranger ? ' is-on' : '') });
  stSw.addEventListener('click', async () => {
    const on = !stSw.classList.contains('is-on');
    try {
      await api.put('/api/users/me', { moments_stranger: on });
      u.moments_stranger = on;
      stSw.classList.toggle('is-on', on);
      toast(on ? '陌生人现在可以查看你的公开动态' : '陌生人将不再看到你的动态', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  box.appendChild(el('div', { class: 'privacy-card' }, [
    el('div', { class: 'setting-row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'setting-row__label', text: '允许陌生人查看我的动态' }),
        el('div', { class: 'setting-row__desc',
          text: '关闭时只有好友能在你的资料页看到动态；开启后陌生人也能看到，但「谁可以看见 / 谁不可以看见 / 仅自己可见」的限定依然生效。' }),
      ]),
      el('div', { class: 'setting-row__ctrl' }, [stSw]),
    ]),
  ]));
  return box;
}

/* ---------------- 安全中心 ---------------- */
const KIND_META = {
  success: { label: '登录成功', cls: 'tag--ok' },
  new_device: { label: '新增设备', cls: 'tag--accent' },
  abnormal_ip: { label: '异常IP登录', cls: 'tag--warn' },
};

/** 从 UA 解析浏览器 / 操作系统（设备卡的标题与副标题） */
function parseUA(ua) {
  ua = ua || '';
  const os = /Windows/i.test(ua) ? 'Windows'
    : /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
    : /Macintosh|Mac OS/i.test(ua) ? 'macOS'
    : /Linux/i.test(ua) ? 'Linux' : '';
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /OPR\//i.test(ua) ? 'Opera'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Safari\//i.test(ua) ? 'Safari' : '浏览器';
  return { browser, os };
}

/** 2026/9/30 17:58:28 —— 安全中心事件用绝对时间（审计口径），列表页才用相对时间 */
function fmtAbs(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 设备 ID 展示：9d99baf8…8c0ba459 */
function shortId(id) {
  id = String(id || '');
  return id.length > 15 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
}

/** 「中国 · 陕西」→「陕西」：归属地只展示省市级一段 */
function shortPlace(place) {
  const s = String(place || '').trim();
  if (!s) return '';
  const parts = s.split('·').map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

async function paneSecurity() {
  const u = (await api.get('/api/users/me')).user;
  const box = el('div');
  box.appendChild(el('div', { class: 'settings__section-title' }, [el('span', { text: '安全中心' })]));

  /* 顶部分段：设备管理（计数徽标） / 登录历史 */
  let tab = 'devices';
  const devSeg = el('button', { class: 'seg__item is-active', type: 'button', dataset: { sec: 'devices' } }, [
    el('span', { text: '设备管理' }),
    el('span', { class: 'sec-seg__badge', text: '…' }),
  ]);
  const histSeg = el('button', { class: 'seg__item', type: 'button', dataset: { sec: 'history' } }, [
    el('span', { text: '登录历史' }),
  ]);
  const seg = el('div', { class: 'seg sec-seg' }, [devSeg, histSeg]);
  box.appendChild(seg);

  const body = el('div', { class: 'sec-body' });
  box.appendChild(body);

  const spinner = () => el('div', { class: 'center', style: { padding: '30px' } }, [el('span', { class: 'spinner' })]);
  const empty = (title, sub) => el('div', { class: 'empty', style: { padding: '36px 20px' } }, [
    el('div', { class: 'empty__icon', html: icon('shield', 38, 1.5) }),
    el('div', { class: 'empty__title', text: title }),
    el('div', { class: 'empty__sub', text: sub || '' }),
  ]);

  /* ---- 设备管理 ---- */
  const showDevices = async () => {
    body.innerHTML = '';
    body.appendChild(spinner());
    let devs = [];
    try { devs = (await api.get('/api/auth/devices')).devices || []; } catch { /* 旧服务端 */ }
    const badge = devSeg.querySelector('.sec-seg__badge');
    if (badge) badge.textContent = String(devs.filter((d) => !d.revoked).length);
    body.innerHTML = '';
    if (!devs.length) {
      body.appendChild(empty('没有已登录的设备', '下次登录时会在这里登记'));
      return;
    }
    const infoRow = (k, v, mono) => el('div', { class: 'sec-dev__row' }, [
      el('span', { class: 'sec-dev__k', text: k }),
      el('span', { class: 'sec-dev__v' + (mono ? ' mono' : ''), text: v }),
    ]);
    for (const d of devs) {
      const { browser, os } = parseUA(d.ua);
      const looksOS = /win|mac|linux|iphone|ipad|android/i.test(d.name || '');
      const title = looksOS ? browser : (d.name || browser);
      const osText = os || (looksOS ? d.name : '') || '';
      body.appendChild(el('div', {
        class: 'sec-dev'
          + (d.current ? ' is-current' : '')
          + (d.revoked ? ' is-revoked' : ''),
      }, [
        el('div', { class: 'sec-dev__head' }, [
          el('div', { class: 'sec-dev__ico', html: icon('monitor', 18) }),
          el('div', { class: 'grow' }, [
            el('div', { class: 'sec-dev__name' }, [
              el('span', { text: title || '未知设备' }),
              d.current ? el('span', { class: 'sec-dev__cur', text: '本机' }) : null,
              d.revoked ? el('span', { class: 'sec-dev__cur is-off', text: '已注销' }) : null,
            ]),
            osText ? el('div', { class: 'sec-dev__os', text: osText }) : null,
          ]),
          d.online ? el('span', { class: 'sec-dev__dot', title: '当前在线' }) : null,
        ]),
        el('div', { class: 'sec-dev__info' }, [
          infoRow('IP', `${d.ip || '-'}${d.place ? ' · ' + shortPlace(d.place) : ''}`),
          infoRow('活跃', fmtAbs(d.ts)),
          infoRow('ID', shortId(d.id), true),
        ]),
        el('button', {
          class: 'btn btn--danger btn--block sec-dev__btn', text: '注销并退出',
          onClick: async () => {
            if (!await confirm('注销并退出该设备？该设备上的登录状态将被立即吊销。', { danger: true, okText: '注销并退出' })) return;
            try { await api.del(`/api/auth/devices/${d.id}`); } catch (e) { toast(e.message, 'err'); return; }
            toast('该设备已注销', 'ok');
            showDevices();
          },
        }),
      ]));
    }
  };

  /* ---- 登录历史 ---- */
  const showHistory = async (kind = '') => {
    body.innerHTML = '';
    body.appendChild(spinner());
    let lg = null;
    try { lg = await api.get(`/api/auth/login-log${kind ? '?kind=' + encodeURIComponent(kind) : ''}`); }
    catch { lg = null; }
    body.innerHTML = '';
    if (!lg) {
      body.appendChild(empty('登录足迹加载失败', '请稍后重试'));
      return;
    }

    const sel = el('select', { class: 'input sec-filter', title: '按事件类型筛选' });
    [['', '全部事件'], ['success', '登录成功'], ['abnormal_ip', '异常IP登录'], ['new_device', '新增设备']]
      .forEach(([v, t]) => {
        const o = el('option', { value: v, text: t });
        if (v === kind) o.selected = true;
        sel.appendChild(o);
      });
    sel.addEventListener('change', () => showHistory(sel.value));
    const clearBtn = el('button', {
      class: 'btn btn--sm btn--ghost', text: '清空记录', title: '清空全部登录足迹',
      onClick: async () => {
        if (!await confirm('清空全部登录足迹记录？', { danger: true, okText: '清空' })) return;
        await api.del('/api/auth/login-log');
        toast('已清空登录足迹', 'ok');
        showHistory('');
      },
    });
    body.appendChild(el('div', { class: 'sec-toolbar' }, [sel, el('div', { class: 'grow' }), clearBtn]));

    if (!lg.items.length) {
      body.appendChild(empty('暂无相关记录', kind ? '换个筛选条件，或等下一次登录' : '下一次登录会在这里留下时间与地点'));
      return;
    }
    lg.items.forEach((it) => {
      const meta = KIND_META[String(it.kind || 'success')] || KIND_META.success;
      const place = shortPlace(it.place || (it.source === 'local' ? '本机' : ''));
      body.appendChild(el('div', {
        class: 'sec-ev' + (String(it.kind || '') === 'abnormal_ip' ? ' is-warn' : ''),
      }, [
        el('div', { class: 'sec-ev__top' }, [
          el('span', { class: 'tag ' + meta.cls, text: meta.label }),
          el('span', { class: 'grow' }),
          el('span', { class: 'sec-ev__time', text: fmtAbs(it.ts) }),
        ]),
        el('div', { class: 'sec-ev__meta', text: `${it.ip || '-'}${place ? ' · ' + place : ''}` }),
      ]));
    });
    body.appendChild(el('div', { class: 'sec-ev__end', text: `已加载全部 · ${lg.items.length} 条` }));
  };

  devSeg.addEventListener('click', () => {
    if (tab === 'devices') return;
    tab = 'devices';
    devSeg.classList.add('is-active');
    histSeg.classList.remove('is-active');
    showDevices();
  });
  histSeg.addEventListener('click', () => {
    if (tab === 'history') return;
    tab = 'history';
    histSeg.classList.add('is-active');
    devSeg.classList.remove('is-active');
    showHistory('');
  });

  await showDevices();

  /* ---- 常驻安全项（两个 tab 之下） ---- */
  const sw = el('div', { class: 'switch' + (u.two_factor ? ' is-on' : '') });
  sw.addEventListener('click', async () => {
    const on = !sw.classList.contains('is-on');
    if (on) {
      const v = await prompt('设置第二层密码', { label: '每次登录都需要额外输入该密码', password: true });
      if (!v) return;
      await api.post('/api/auth/second-password', { enabled: true, password: v });
      sw.classList.add('is-on'); toast('已开启二次登录', 'ok');
    } else {
      const v = await prompt('输入当前第二层密码以关闭', { password: true });
      if (!v) return;
      await api.post('/api/auth/second-password', { enabled: false, password: v });
      sw.classList.remove('is-on'); toast('已关闭二次登录', 'info');
    }
  });
  box.appendChild(el('div', { class: 'setting-row' }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 'setting-row__label', text: '二次登录验证' }),
      el('div', { class: 'setting-row__desc', text: '开启后每次登录需额外输入第二层密码' }),
    ]),
    el('div', { class: 'setting-row__ctrl' }, [sw]),
  ]));

  box.appendChild(el('div', { class: 'setting-row' }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 'setting-row__label', text: '修改登录密码' }),
      el('div', { class: 'setting-row__desc', text: '建议定期更换，密码仅用于本地派生密钥' }),
    ]),
    el('div', { class: 'setting-row__ctrl' }, [el('button', { class: 'btn btn--sm', text: '修改', onClick: () => changePassword() })]),
  ]));

  /* 注销 */
  box.appendChild(el('div', { class: 'setting-row' }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 'setting-row__label', text: '注销账号' }),
      el('div', { class: 'setting-row__desc', text: '账号数据将被清除，且不可恢复' }),
    ]),
    el('div', { class: 'setting-row__ctrl' }, [el('button', { class: 'btn btn--sm btn--danger', text: '注销', onClick: async () => {
      if (!await confirm('注销后账号、好友、消息与本地密钥都会被清除，确定继续？', { danger: true, okText: '确认注销' })) return;
      const pwd = await prompt('请输入登录密码以确认', { password: true });
      if (!pwd) return;
      try {
        await api.del('/api/auth/account', { password: pwd });
        await C.wipeLocal(); tokenStore.clear(); toast('账号已注销', 'info'); location.reload();
      } catch (e) { toast(e.message, 'err'); }
    } })]),
  ]));
  return box;
}

/* ---------------- 拉黑管理 ---------------- */
async function paneBlock() {
  const box = el('div');
  box.appendChild(el('div', { class: 'settings__section-title' }, [el('span', { text: '拉黑用户管理' })]));
  const r = await api.get('/api/users/block/list');
  const list = r.blocked || [];
  if (!list.length) box.appendChild(el('div', { class: 'muted', style: { padding: '20px 0' }, text: '你还没有拉黑任何用户' }));
  list.forEach((u) => box.appendChild(el('div', { class: 'device-card' }, [
    avatar(u, 'sm', { status: false }),
    el('div', { class: 'grow' }, [
      el('div', { class: 'setting-row__label' }, [nameNode(u)]),
      el('div', { class: 'setting-row__desc', text: '@' + u.username }),
    ]),
    el('button', { class: 'btn btn--sm', text: '解除拉黑', onClick: async () => {
      await api.post('/api/users/block', { uid: u.id, block: false });
      toast('已解除拉黑', 'ok'); switchPane('block'); emit('ui:refresh');
    } }),
  ])));
  return box;
}

/* ---------------- 主题选择 ---------------- */
// 安卓端（WebView）禁用极光：动态渐变背景会导致界面持续闪烁
const IS_ANDROID = /WuhouChatAndroid/i.test(navigator.userAgent);
const ALL_THEME_OPTS = [
  { key: 'dark', name: '深色', desc: '沉静夜空', swatch: 'linear-gradient(135deg,#0a0916 0%,#171432 100%)' },
  { key: 'light', name: '浅色', desc: '明亮清爽', swatch: 'linear-gradient(135deg,#eef0f8 0%,#ffffff 100%)' },
  { key: 'aurora', name: '极光', desc: '动态渐变背景', swatch: 'linear-gradient(120deg,#2ff0b0 0%,#35d6ff 45%,#7c6cff 100%)' },
];
const THEME_OPTS = IS_ANDROID ? ALL_THEME_OPTS.filter((o) => o.key !== 'aurora') : ALL_THEME_OPTS;
const THEME_KEYS = THEME_OPTS.map((o) => o.key);

function currentThemeKey() {
  const raw = localStorage.getItem('wuhou.theme') || 'dark';
  // 安卓端不认极光：已存为 aurora 时回落深色
  const t = (IS_ANDROID && raw === 'aurora') ? 'dark' : raw;
  return THEME_KEYS.includes(t) ? t : 'dark';
}

/** 与 app.js 的 setTheme 保持同一套写入方式，并广播事件让侧栏按钮同步 */
function applyThemeKey(key) {
  // 安卓端把任何极光请求都强制回落为深色
  const safe = (IS_ANDROID && key === 'aurora') ? 'dark' : key;
  const k = THEME_KEYS.includes(safe) ? safe : 'dark';
  document.documentElement.dataset.theme = k;
  localStorage.setItem('wuhou.theme', k);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = { dark: '#0a0916', light: '#eef0f8', aurora: '#05070f' }[k];
  document.dispatchEvent(new CustomEvent('wuhou:theme', { detail: k }));
}

function themePicker() {
  const wrap = el('div', { class: 'theme-pick', style: { marginBottom: '14px' } });
  const cards = new Map();
  const sync = () => {
    const cur = currentThemeKey();
    cards.forEach((card, key) => card.classList.toggle('is-active', key === cur));
  };
  for (const o of THEME_OPTS) {
    const card = el('button', {
      class: 'theme-pick__card', type: 'button',
      onClick: () => { applyThemeKey(o.key); sync(); },
    }, [
      el('span', { class: 'theme-pick__swatch', style: { background: o.swatch } }),
      el('span', { class: 'grow' }, [
        el('span', { class: 'theme-pick__name', text: o.name }),
        el('span', { class: 'theme-pick__desc', text: o.desc }),
      ]),
      el('span', { class: 'theme-pick__dot' }),
    ]);
    cards.set(o.key, card);
    wrap.appendChild(card);
  }
  sync();
  return wrap;
}

/* ---------------- 关于 ---------------- */
async function paneAbout() {
  const meta = await api.get('/api/meta');
  const box = el('div');
  box.appendChild(el('div', { class: 'settings__section-title' }, [el('span', { text: '关于武侯Chat' })]));
  const kv = el('div', { class: 'kv' });
  const add = (k, v) => kv.append(el('div', { class: 'kv__k', text: k }), el('div', { class: 'kv__v', text: v }));
  add('产品名称', meta.app);
  add('版本', meta.version);
  add('版权', meta.copyright);
  add('存储后端', meta.storage === 'redis' ? 'Redis' : '服务端持久化存储（Redis 未连接）');
  add('消息总线', 'RabbitMQ（不可用时降级为进程内事件总线）');
  add('加密套件', '全局统一密钥 AES-256-GCM（WebCrypto）');
  add('文件传输', '本地 / FTP(ftplib) 双通道，客户端先加密再上传');
  box.appendChild(kv);

  box.appendChild(el('div', { class: 'setting-row', style: { marginTop: '14px' } }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 'setting-row__label', text: '外观主题' }),
      el('div', { class: 'setting-row__desc', text: '深色 / 浅色 / 极光（动态渐变背景）' }),
    ]),
  ]));
  box.appendChild(themePicker());

  // 管理后台是独立入口 /app/admin（独立账号 + 独立鉴权），不放进普通用户的设置里：
  // 「关于」页是所有用户都能看到的界面，这里出现后台入口既多余，也会让人误以为能点进去。

  box.appendChild(el('div', { class: 'muted', style: { marginTop: '16px', fontSize: '12px', lineHeight: '1.8' },
    text: '隐私说明：聊天正文、动态、图片与文件在离开设备前完成加密，传输与存储均为密文。会话密钥同时托管在服务端，平台据此对违规内容进行实时检测与举报核查；除此之外不用于任何其他用途。' }));
  return box;
}

/* ---------------- 修改密码 ---------------- */
async function changePassword() {
  const oldP = await prompt('当前密码', { password: true });
  if (!oldP) return;
  const newP = await prompt('新密码（至少 8 位）', { password: true });
  if (!newP || newP.length < 8) { toast('新密码至少 8 位', 'err'); return; }
  try {
    const me = (await api.get('/api/users/me')).user;
    await api.put('/api/users/password', { old_password: oldP, new_password: newP });
    // V2.0：私钥用口令包裹，改密必须重新封装一次，否则换设备后无法恢复身份
    try {
      const id = await C.rekeyIdentity(oldP, newP);
      if (id && id.keyblob) await api.put('/api/users/me', { pubkey: id.pubkey, keyblob: id.keyblob });
    } catch { /* 重包失败不阻断改密：全局密钥仍可读历史 */ }
    await C.ensureGlobal();
    toast('密码已更新', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

export async function logout() {
  if (!await confirm('确定退出登录吗？')) return;
  try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
  await C.wipeLocal();
  tokenStore.clear();
  location.reload();
}
