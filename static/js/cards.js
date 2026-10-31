/* ============================================================
   卡片层：用户信息卡 / 群聊信息卡 / 添加好友卡 / 加入群聊卡 / 举报
   ============================================================ */
import { el, avatar, fileUrl, fileIdOf, collectForm, nameNode, pickFiles } from './util.js';
import { api } from './api.js';
import { toast, modal, confirm, prompt, sheet } from './ui.js';
import * as C from './crypto.js';
import {
  state, loadFriends, loadGroups, loadConvs, loadFriendRequests, loadTags, emit, ensureGroupKey,
} from './state.js';
import { icon, icoHtml } from './icons.js';
import { friendChips, openTagPicker, tagNames } from './tags.js';

const GENDER = { male: '男', female: '女', other: '其他', unknown: '保密' };
const PICK = ['🦊', '🐼', '🐯', '🐨', '🐸', '🐵', '🦁', '🐧', '🦄', '🐙', '🦉', '🐳', '🌙', '🔥', '🍀', '🎧'];

/** 生日倒计时提示：把「2006-05-01」翻译成「还有 12 天 · 满 20 岁」，纯展示用 */
function birthdayCountdown(bd) {
  if (!bd) return '';
  const parts = String(bd).split('-');
  const mi = Number(parts[parts.length - 2]);
  const di = Number(parts[parts.length - 1]);
  if (!(mi >= 1 && mi <= 12) || !(di >= 1 && di <= 31)) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let year = now.getFullYear();
  let next = new Date(year, mi - 1, di);
  if (next < today) next = new Date(year + 1, mi - 1, di);
  year = next.getFullYear();
  const days = Math.round((next - today) / 86400000);
  let turning = '';
  if (parts.length >= 3 && Number(parts[0])) turning = ` · 满 ${year - Number(parts[0])} 岁`;
  if (days === 0) return '今天生日 🎂' + turning;
  if (days === 1) return '明天生日' + turning;
  return `还有 ${days} 天` + turning;
}

/**
 * 「刷新资料卡」走的是重新打开一张卡。自绘弹窗没有替换机制，
 * 不先关掉旧卡就会一层一层往上叠（改一次备注多一层），因此统一在这里收干净。
 */
function reopenUserCard(uid) {
  document.querySelectorAll('.modal-scrim').forEach((n) => n.click());
  setTimeout(() => openUserCard(uid), 190);
}

/* ---------------- 用户信息卡 ---------------- */
export async function openUserCard(uid, { onChanged } = {}) {
  let r;
  try { r = await api.get(`/api/users/${uid}`); }
  catch (e) { return toast(e.message, 'err'); }
  const u = r.user;
  const isSelf = u.is_self;
  const body = el('div');

  const hero = el('div', { class: 'card-hero' }, [
    avatar(u, 'xl', { status: true, onClick: async () => { const fid = fileIdOf(u.avatar || ''); if (fid) { const url = await fileUrl(fid); if (url) window.__lightbox(url); } } }),
    el('div', { class: 'card-hero__info grow' }, [
      el('div', { class: 'card-hero__name' }, [
        nameNode(u, { class: 'grow' }),
        u.online ? el('span', { class: 'tag tag--ok', text: '在线' }) : el('span', { class: 'tag', text: '离线' }),
      ]),
      el('div', { class: 'card-hero__sub', text: `@${u.username}` }),
      u.signature ? el('div', { class: 'card-hero__sub', text: u.signature }) : null,
    ]),
  ]);
  body.appendChild(hero);
  // 好友：把「我给 TA 的分组」直接摆在大头像下面，比塞在 kv 里更好找
  const heroChips = u.friend ? friendChips({ tags: u.tags || [] }, { max: 5 }) : null;
  if (heroChips) { heroChips.classList.add('tagchips--hero'); body.appendChild(heroChips); }

  /* ---- 广场身份条：粉丝 / 获赞 ----
     点赞只针对动态，这里没有「给人点赞」的入口 —— 「获赞」就是 TA 发的动态收到的赞。 */
  let st = {};
  // api.get 已经剥掉 {ok,data} 外壳，返回的就是内层对象，不要再取 .stats
  try { st = (await api.get(`/api/moments/stats/${uid}`)) || {}; } catch { st = {}; }

  const statB = (n, label, key) => el('button', {
    class: 'ucard-stat', type: 'button', dataset: { ucardStat: key },
    title: label,
  }, [el('b', { text: String(n) }), el('span', { text: label })]);
  const followersBox = statB(Number(st.followers || 0), '粉丝', 'followers');
  body.appendChild(el('div', { class: 'ucard-stats' }, [
    followersBox,
    el('span', { class: 'ucard-stats__sep' }),
    statB(Number(st.likes || 0), '获赞', 'likes'),
  ]));

  const setFollowers = (n) => { followersBox.querySelector('b').textContent = String(n); };

  const kv = el('div', { class: 'kv' });
  const add = (k, v) => { if (v === null || v === undefined || v === '') return; kv.append(el('div', { class: 'kv__k', text: k }), el('div', { class: 'kv__v', text: String(v) })); };
  if (u.remark) add('备注', u.remark);
  if (u.friend) {
    const names = tagNames(u.tags || []);
    add('分组', names.length ? names.join('、') : '未分组');
  }
  add('昵称', u.nickname);
  add('年龄', u.age ?? '未填写');
  add('性别', GENDER[u.gender] || '保密');
  if (u.birthday) {
    const cd = birthdayCountdown(u.birthday);
    add('生日', cd ? `${u.birthday}（${cd}）` : u.birthday);
  } else {
    add('生日', u.birthday || '未填写');
  }
  add('签名', u.signature || '这个人很神秘，什么都没写');
  add('拍一拍', u.poke || '拍了拍');
  add('状态', u.online ? '在线' : (u.last_seen ? `最后活跃 ${new Date(u.last_seen * 1000).toLocaleString('zh-CN')}` : '离线'));
  body.appendChild(kv);

  const actions = el('div', { class: 'card-actions' });

  if (!isSelf) {
    /* 关注是开关：点了就变，再点一次取消，上面的粉丝数同步跟着变 */
    const followBtn = el('button', {
      class: 'btn' + (st.me_following ? ' btn--ok is-on' : ''),
      dataset: { ucardFollow: uid },
      title: '关注后 TA 投放到动态广场的新动态会出现在广场「关注」页',
      text: st.me_following ? '✓ 已关注' : '＋ 关注',
    });
    followBtn.addEventListener('click', async () => {
      followBtn.disabled = true;
      try {
        const r = await api.post(`/api/moments/follow/${uid}`);
        const on = !!r.following;
        followBtn.classList.toggle('btn--ok', on);
        followBtn.classList.toggle('is-on', on);
        followBtn.textContent = on ? '✓ 已关注' : '＋ 关注';
        setFollowers(r.followers ?? 0);
        toast(on ? `已关注，TA 的广场动态会出现在「关注」页` : '已取消关注', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      finally { followBtn.disabled = false; }
    });

    followBtn.classList.add('btn--full');   // 关注独占一行，比挤在半格更好按
    actions.appendChild(followBtn);
  }

  if (isSelf) {
    // 设置中心里已有完整的资料编辑表单，这里不再重复放“编辑资料”按钮
    actions.appendChild(el('button', { class: 'btn btn--primary btn--full', text: '打开个人设置', onClick: () => { emit('ui:nav', 'settings'); } }));
  } else if (u.friend) {
    actions.appendChild(el('button', { class: 'btn btn--primary btn--full', text: '发消息', onClick: () => emit('ui:openConv', `p:${[state.me.id, u.id].sort().join(':')}`) }));
    actions.appendChild(el('button', { class: 'btn', text: '设置备注', onClick: async () => {
      const v = await prompt('设置备注名', { label: '仅自己可见', value: u.remark || '' });
      if (v === null) return;
      await api.post('/api/users/remark', { target: u.id, remark: v, kind: 'user' });
      toast('备注已更新', 'ok'); loadFriends(); loadConvs(); reopenUserCard(uid);
    } }));
    actions.appendChild(el('button', { class: 'btn', text: '设置分组', onClick: async () => {
      await openTagPicker({ id: u.id, nickname: u.nickname, remark: u.remark, tags: u.tags || [] });
      reopenUserCard(uid);
    } }));
    actions.appendChild(el('button', { class: 'btn btn--ghost', text: '拍一拍', onClick: () => emit('ui:poke', u.id) }));
    actions.appendChild(el('button', { class: 'btn', text: '🎴 推荐给好友', title: '把 TA 的名片发给其他好友或群聊',
      onClick: () => recommendFriend(u) }));
    actions.appendChild(el('button', { class: 'btn btn--danger', text: u.blocked ? '取消拉黑' : '拉黑', onClick: async () => {
      if (!u.blocked && !await confirm(`拉黑后 ${u.nickname} 将无法与你联系，同时解除好友关系。`, { danger: true, okText: '拉黑' })) return;
      await api.post('/api/users/block', { uid: u.id, block: !u.blocked });
      toast(u.blocked ? '已取消拉黑' : '已拉黑', 'ok'); loadFriends(); loadConvs(); emit('ui:refresh');
    } }));
    actions.appendChild(el('button', { class: 'btn btn--ghost', text: '删除好友', onClick: async () => {
      if (!await confirm(`确定删除好友 ${u.nickname} 吗？`, { danger: true, okText: '删除' })) return;
      await api.del(`/api/friends/${u.id}`); toast('已删除', 'ok'); loadFriends(); loadConvs(); emit('ui:refresh');
    } }));
  } else {
    // 拉黑只针对好友：陌生人不会产生联系，无需也不允许拉黑
    actions.appendChild(el('button', { class: 'btn btn--primary btn--full', text: u.blocked ? '已拉黑' : '添加好友',
      onClick: () => (u.blocked ? toast('你已拉黑该用户，请先解除拉黑', 'warn') : openAddFriend(u.id)) }));
    if (u.blocked) {
      actions.appendChild(el('button', { class: 'btn btn--ghost', text: '解除拉黑', onClick: async () => {
        await api.post('/api/users/block', { uid: u.id, block: false });
        toast('已解除拉黑', 'ok'); emit('ui:refresh');
      } }));
    }
  }
  // 「查看动态」：本人与好友始终可看，陌生人取决于对方的隐私开关（can_view_moments）
  const canMoments = isSelf || u.friend || u.can_view_moments;
  if (!isSelf) {
    actions.appendChild(el('button', {
      class: 'btn btn--ghost', text: '🖼 查看广场动态',
      title: canMoments ? `查看 ${u.nickname} 投放到动态广场的动态` : '对方未向陌生人开放动态',
      disabled: !canMoments,
      onClick: async () => {
        document.querySelectorAll('.modal-scrim').forEach((n) => n.click());
        emit('ui:userMoments', { uid: u.id, name: u.remark || u.nickname || u.username });
      },
    }));
    actions.appendChild(el('button', { class: 'btn btn--ghost', text: '举报', onClick: () => openReport('user', u.id) }));
  } else {
    actions.appendChild(el('button', {
      class: 'btn btn--ghost', text: '🖼 我的广场动态',
      onClick: async () => {
        document.querySelectorAll('.modal-scrim').forEach((n) => n.click());
        emit('ui:userMoments', { uid: u.id, name: '我的动态' });
      },
    }));
  }
  body.appendChild(actions);
  modal({ title: isSelf ? '我的资料' : '用户资料', body, footer: null });
}

/* ---------------- 名片推荐好友 ----------------
   把一个人的资料打包成「名片」，端到端加密后作为一条富消息发给别的会话。
   走的是和转发动态同一条链路：结构化 payload + 加密 + /api/chat/send，
   因此接收端无论是好友还是群成员，都按同一张卡片渲染。 */

/** 按会话性质加密：群走群密钥（含版本与托管信封），其余走会话 / 全局密钥 */
async function encryptForConv(conv, payload) {
  if (conv.startsWith('g:')) {
    await ensureGroupKey(conv.slice(2));
    return C.encryptFor([], payload, conv);
  }
  const ids = conv.startsWith('p:') ? conv.split(':').slice(1).filter((x) => x !== state.me.id) : [];
  return C.encryptFor(ids, payload, conv);
}

export function recommendFriend(u) {
  const targets = new Set();
  let mode = 'friend';

  const tabs = el('div', { class: 'seg' }, [
    el('button', { class: 'seg__item is-active', type: 'button', text: '好友' }),
    el('button', { class: 'seg__item', type: 'button', text: '群聊' }),
  ]);
  const listEl = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '260px', overflow: 'auto' } });
  const counter = el('div', { class: 'muted', style: { fontSize: '11.5px' } });
  const reason = el('input', { class: 'input', placeholder: '推荐理由（可选，会随名片一起发出）', maxLength: 60 });

  const items = () => (mode === 'friend'
    ? (state.friends || []).filter((f) => f.id !== u.id)
    : (state.groups || []));

  const syncCounter = () => {
    counter.textContent = targets.size
      ? `已选择 ${targets.size} 个${mode === 'friend' ? '好友' : '群聊'}`
      : '选择要把名片发给谁（可多选）';
  };

  const render = () => {
    listEl.innerHTML = '';
    const its = items();
    if (!its.length) {
      listEl.appendChild(el('div', { class: 'muted', style: { padding: '10px 4px' },
        text: mode === 'friend' ? '没有其他好友可以推荐了' : '你还没有群聊' }));
      return;
    }
    its.forEach((it) => {
      const tick = el('span', { class: 'pick-row__check', html: icon('check', 14) });
      tick.hidden = !targets.has(it.id);
      const row = el('div', { class: 'result-card pick-row' + (targets.has(it.id) ? ' is-active' : '') }, [
        avatar(mode === 'friend' ? it : { avatar: it.avatar, nickname: it.name }, 'sm', { status: mode === 'friend' }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'list-item__title' }, [
            nameNode(mode === 'friend' ? it : {}, { text: it.remark || it.nickname || it.name, single: false }),
          ]),
          el('div', { class: 'result-card__snippet ellipsis',
            text: mode === 'friend' ? `@${it.username}` : '群聊 · 名片对所有成员可见' }),
        ]),
        tick,
      ]);
      row.addEventListener('click', () => {
        if (targets.has(it.id)) targets.delete(it.id); else targets.add(it.id);
        const on = targets.has(it.id);
        row.classList.toggle('is-active', on);
        tick.hidden = !on;
        syncCounter();
      });
      listEl.appendChild(row);
    });
  };

  const switchTo = (m) => {
    mode = m; targets.clear();
    tabs.children[0].classList.toggle('is-active', m === 'friend');
    tabs.children[1].classList.toggle('is-active', m === 'group');
    render(); syncCounter();
  };
  tabs.children[0].addEventListener('click', () => switchTo('friend'));
  tabs.children[1].addEventListener('click', () => switchTo('group'));

  const send = async () => {
    if (!targets.size) { toast('先选择要把名片发给谁', 'err'); return false; }
    const snap = {
      kind: 'contact',
      uid: u.id,
      nickname: u.nickname || u.username || '未知用户',
      username: u.username || '',
      avatar: typeof u.avatar === 'string' ? u.avatar.slice(0, 4) : '',
      signature: String(u.signature || '').slice(0, 60),
      recommend: u.id,
      reason: String(reason.value || '').trim().slice(0, 60),
      from: state.me?.id || '',
      from_name: state.me?.nickname || '',
    };
    let sent = 0;
    for (const id of targets) {
      const conv = mode === 'friend' ? `p:${[state.me.id, id].sort().join(':')}` : `g:${id}`;
      try {
        const { cipher, keys } = await encryptForConv(conv, snap);
        await api.post('/api/chat/send', { conv, type: 'contact', cipher, keys, hint: 'contact' });
        sent += 1;
      } catch (e) { toast(`${it0(mode, id)}：${e.message}`, 'err'); }
    }
    await loadConvs();
    toast(sent ? `名片已发出 · ${sent} 个${mode === 'friend' ? '好友' : '群聊'}` : '发送失败', sent ? 'ok' : 'err');
    return true;
  };

  // 报错信息里要带上目标名字，否则多个目标连续失败时分不清是哪个
  const it0 = (m, id) => {
    const one = items().find((x) => x.id === id);
    return one ? (one.remark || one.nickname || one.name || id) : id;
  };

  const body = el('div', { class: 'form' }, [
    tabs, listEl, counter, reason,
  ]);
  modal({
    title: `推荐 ${u.remark || u.nickname || '好友'} 给他人`,
    body,
    footer: [{ text: '取消' }, { text: '发送名片', kind: 'primary', onClick: send }],
  });
  render(); syncCounter();
}

/* ---------------- 编辑资料 ---------------- */
export async function openEditProfile(u, onSaved) {
  const body = el('div', { class: 'form' });
  let avatarValue = u.avatar || PICK[0];
  let localPreview = '';      // 刚上传的本地预览（网络取图前的占位）
  const picker = el('div', { class: 'avatar-picker' });
  const render = () => {
    picker.innerHTML = '';
    PICK.forEach((a) => picker.appendChild(el('button', {
      class: 'avatar-picker__opt' + (avatarValue === a ? ' is-active' : ''), type: 'button', text: a,
      onClick: () => { avatarValue = a; render(); },
    })));
    // 已上传的图片头像：显示缩略图并标记为选中
    const fid = fileIdOf(avatarValue);
    if (fid) {
      const thumb = el('button', { class: 'avatar-picker__opt is-active', type: 'button', title: '当前头像' });
      thumb.appendChild(el('img', { src: localPreview || '', alt: '' }));
      fileUrl(fid).then((url) => { if (url) thumb.querySelector('img').src = url; });
      picker.appendChild(thumb);
    }
    picker.appendChild(el('button', {
      class: 'avatar-picker__opt avatar-picker__upload', type: 'button', text: '上传',
      onClick: async () => {
        const files = await new Promise((res) => {
          const i = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
          document.body.appendChild(i); i.onchange = () => { res(Array.from(i.files || [])); i.remove(); }; i.click();
        });
        if (!files.length) return;
        try {
          const up = await api.uploadRaw(await files[0].arrayBuffer(), files[0].name);
          avatarValue = `file:${up.id}`;
          localPreview = URL.createObjectURL(files[0]);
          toast('头像已上传', 'ok');
          render();
        } catch (err) { toast(err.message, 'err'); }
      },
    }));
  };
  render();

  const f = (label, name, value, type = 'text') => el('label', { class: 'field' }, [
    el('span', { class: 'field__label', text: label }),
    el('input', { class: 'input', name, value: value ?? '', type }),
  ]);

  body.append(
    el('div', { class: 'field' }, [el('span', { class: 'field__label', text: '头像' }), picker]),
    el('div', { class: 'grid-2' }, [f('昵称', 'nickname', u.nickname), f('个性签名', 'signature', u.signature)]),
    el('div', { class: 'grid-3' }, [
      f('年龄', 'age', u.age ?? '', 'number'),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: '性别' }),
        el('select', { class: 'input', name: 'gender' }, ['unknown', 'male', 'female', 'other'].map((g) =>
          el('option', { value: g, text: GENDER[g], selected: (u.gender || 'unknown') === g }))),
      ]),
      f('生日', 'birthday', u.birthday, 'date'),
    ]),
    f('拍一拍后缀', 'poke', u.poke || '拍了拍'),
  );

  modal({
    title: '编辑资料', body, wide: false,
    footer: [{
      text: '保存', kind: 'primary', onClick: async () => {
        const fd = collectForm(body);
        await api.put('/api/users/me', {
          nickname: String(fd.nickname || '').trim(),
          signature: String(fd.signature || '').trim(),
          age: fd.age ? Number(fd.age) : null,
          gender: String(fd.gender || 'unknown'),
          birthday: String(fd.birthday || ''),
          avatar: avatarValue,
          poke: String(fd.poke || '拍了拍'),
        });
        toast('资料已保存', 'ok');
        const r = await api.get('/api/users/me'); state.me = r.user;
        emit('ui:refresh'); onSaved && onSaved();
      }
    }, { text: '取消' }],
  });
}

/* ---------------- 资料写入统一出口 ---------------- */
async function saveProfile(patch, onSaved) {
  await api.put('/api/users/me', patch);
  try { const r = await api.get('/api/users/me'); state.me = r.user; } catch { /* 拉取失败不影响本地刷新 */ }
  emit('ui:refresh');
  onSaved && onSaved();
}

/* ---------------- 头像编辑卡（独立） ---------------- */
export async function openAvatarEditor(u, onSaved) {
  let value = u.avatar || PICK[0];
  let localPreview = '';
  const body = el('div', { class: 'form' });

  /* 顶部大预览 + 当前来源说明 */
  const preview = el('div', { class: 'avatar-edit' });
  const box = el('div', { class: 'avatar-edit__box' });
  const kind = el('div', { class: 'avatar-edit__kind' });
  const renderPreview = () => {
    box.innerHTML = '';
    box.appendChild(avatar({ ...u, avatar: value }, 'xl', { status: false }));
    const fid = fileIdOf(value);
    if (fid && localPreview) {
      let im = box.querySelector('img');
      if (!im) { box.textContent = ''; im = el('img', { alt: '' }); box.appendChild(im); }
      im.src = localPreview;
    }
    kind.textContent = fid ? '当前：上传的图片头像' : (value ? '当前：表情头像' : '当前：默认文字头像');
  };
  preview.append(box, kind);
  body.appendChild(preview);

  /* 表情头像 */
  const picker = el('div', { class: 'avatar-picker avatar-picker--wrap' });
  const renderPicker = () => {
    picker.innerHTML = '';
    PICK.forEach((a) => picker.appendChild(el('button', {
      class: 'avatar-picker__opt' + (value === a ? ' is-active' : ''), type: 'button', text: a,
      onClick: () => { value = a; renderPicker(); renderPreview(); },
    })));
  };
  renderPicker();
  renderPreview();

  const upload = async () => {
    const files = await pickFiles('image/*');
    if (!files.length) return;
    const f = files[0];
    if (f.size > 3 * 1024 * 1024) return toast('图片不能超过 3MB', 'err');
    try {
      const up = await api.uploadRaw(await f.arrayBuffer(), f.name);
      value = `file:${up.id}`;
      localPreview = URL.createObjectURL(f);
      toast('头像已上传，记得点保存', 'ok');
      renderPicker(); renderPreview();
    } catch (err) { toast(err.message || '上传失败', 'err'); }
  };

  body.append(
    el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: '表情头像' }), picker,
    ]),
    el('div', { class: 'avatar-edit__acts' }, [
      el('button', { class: 'btn btn--sm', text: '上传图片头像', onClick: upload }),
      el('button', {
        class: 'btn btn--sm btn--ghost', text: '恢复默认',
        onClick: () => { value = PICK[0]; localPreview = ''; renderPicker(); renderPreview(); },
      }),
    ]),
    el('div', { class: 'field__hint', text: '图片头像会做内容安全检测并原图存储；表情头像即时生效、无需等待上传。' }),
  );

  modal({
    title: '编辑头像', body, wide: false,
    footer: [
      { text: '保存头像', kind: 'primary', onClick: async () => { await saveProfile({ avatar: value }, onSaved); toast('头像已更新', 'ok'); } },
      { text: '取消' },
    ],
  });
}

/* ---------------- 年龄 / 性别 / 生日 卡（独立） ---------------- */
function ageFromBirthday(bd) {
  if (!bd) return null;
  const d = new Date(bd);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}
function zodiacOf(bd) {
  if (!bd) return '';
  const d = new Date(bd);
  if (Number.isNaN(d.getTime())) return '';
  const md = (d.getMonth() + 1) * 100 + d.getDate();
  const table = [[119, '摩羯座'], [218, '水瓶座'], [320, '双鱼座'], [419, '白羊座'], [520, '金牛座'],
    [621, '双子座'], [722, '巨蟹座'], [822, '狮子座'], [922, '处女座'], [1023, '天秤座'],
    [1122, '天蝎座'], [1221, '射手座'], [1231, '摩羯座']];
  for (const [limit, name] of table) if (md <= limit) return name;
  return '摩羯座';
}

export async function openBirthEditor(u, onSaved) {
  const body = el('div', { class: 'form' });
  let gender = u.gender || 'unknown';

  const seg = el('div', { class: 'seg seg--fill' });
  const renderSeg = () => {
    seg.innerHTML = '';
    [['unknown', '保密'], ['male', '男'], ['female', '女'], ['other', '其他']].forEach(([v, t]) => {
      seg.appendChild(el('button', {
        class: 'seg__item' + (gender === v ? ' is-active' : ''), type: 'button', text: t,
        onClick: () => { gender = v; renderSeg(); },
      }));
    });
  };
  renderSeg();

  const birthInput = el('input', { class: 'input', name: 'birthday', type: 'date', value: u.birthday || '', max: new Date().toISOString().slice(0, 10) });
  const ageInput = el('input', { class: 'input', name: 'age', type: 'number', value: u.age ?? '', min: '1', max: '120', placeholder: '未填写' });
  const hint = el('div', { class: 'field__hint' });
  const renderHint = () => {
    const bd = birthInput.value;
    const a = ageFromBirthday(bd);
    const z = zodiacOf(bd);
    hint.textContent = bd ? `生日推算：${a === null ? '—' : `${a} 岁`}${z ? ` · ${z}` : ''}` : '填写生日后可一键把年龄同步为周岁';
  };
  birthInput.addEventListener('input', renderHint);
  renderHint();

  body.append(
    el('div', { class: 'field' }, [el('span', { class: 'field__label', text: '性别' }), seg]),
    el('div', { class: 'grid-2' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '生日' }), birthInput]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '年龄' }), ageInput]),
    ]),
    el('div', { class: 'avatar-edit__acts' }, [
      el('button', {
        class: 'btn btn--sm', text: '按生日填充年龄',
        onClick: () => {
          const a = ageFromBirthday(birthInput.value);
          if (a === null) return toast('请先填写生日', 'warn');
          ageInput.value = String(a);
          toast(`已按生日填充为 ${a} 岁`, 'ok');
        },
      }),
      el('button', {
        class: 'btn btn--sm btn--ghost', text: '清空生日与年龄',
        onClick: () => { birthInput.value = ''; ageInput.value = ''; renderHint(); },
      }),
    ]),
    hint,
  );

  modal({
    title: '年龄 / 性别 / 生日', body, wide: false,
    footer: [{
      text: '保存', kind: 'primary', onClick: async () => {
        const bd = String(birthInput.value || '');
        const age = ageInput.value ? Number(ageInput.value) : null;
        if (bd && ageFromBirthday(bd) === null) return toast('生日不合法', 'err');
        if (age !== null && (age < 1 || age > 120)) return toast('年龄需在 1–120 之间', 'err');
        await saveProfile({ birthday: bd, age, gender }, onSaved);
        toast('资料已保存', 'ok');
      },
    }, { text: '取消' }],
  });
}

/* ---------------- 群聊信息卡 ---------------- */
export async function openGroupCard(gid, { onChanged } = {}) {
  let r;
  try { r = await api.get(`/api/groups/${gid}`); }
  catch (e) { return toast(e.message, 'err'); }
  const g = r.group;
  const body = el('div');
  const hero = el('div', { class: 'card-hero' }, [
    avatar({ avatar: g.avatar, nickname: g.name || '群' }, 'xl', { status: false }),
    el('div', { class: 'card-hero__info grow' }, [
      el('div', { class: 'card-hero__name' }, [el('span', { text: (g.remark || g.name) }),
        el('span', { class: 'tag', text: `${g.member_count} 人` })]),
      el('div', { class: 'card-hero__sub', text: g.intro || '这个群还没有介绍' }),
      el('div', { style: { marginTop: '6px', display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
        el('span', { class: 'tag tag--accent', text: { free: '自由加入', approval: '需审核', invite: '仅邀请' }[g.join_mode] }),
        g.discoverable ? el('span', { class: 'tag tag--ok', text: '可被发现' }) : el('span', { class: 'tag', text: '不可被发现' }),
        g.mute_all ? el('span', { class: 'tag tag--danger', text: '全员禁言' }) : null,
      ]),
    ]),
  ]);
  body.appendChild(hero);

  /* 群公告：有内容就展示在成员区上方；能改的人随时可以编辑 */
  const adminSet = new Set(g.admins || []);
  const announceText = String(g.announce || '').trim();
  if (announceText || g.is_owner || g.is_admin) {
    body.appendChild(el('div', { class: 'card-note' }, [
      el('div', { class: 'card-note__head' }, [
        el('span', { class: 'card-note__ico', html: icon('bell', 12, 2) }),
        el('span', { text: '群公告' }),
      ]),
      el('div', { class: 'card-note__text', text: announceText || '暂无群公告' }),
      (g.is_owner || g.is_admin)
        ? el('button', { class: 'btn btn--sm btn--ghost', text: announceText ? '编辑' : '发布', onClick: () => openGroupAnnounce(gid, g) })
        : null,
    ]));
  }

  /* 成员网格 */
  const grid = el('div', { class: 'member-grid' });
  (g.members || []).slice(0, 24).forEach((m) => {
    grid.appendChild(el('div', { class: 'member-cell', onClick: () => openUserCard(m.id) }, [
      avatar(m, '', { status: true }),
      el('div', { class: 'member-cell__name' }, [
        m.id === g.owner ? el('span', { text: '👑 ' }) : null,
        adminSet.has(m.id) ? el('span', { class: 'tag tag--accent', text: '管理' }) : null,
        nameNode(m),
      ]),
    ]));
  });
  if (g.is_owner) {
    grid.appendChild(el('div', { class: 'member-cell member-cell--add', onClick: () => openInviteMembers(gid) }, [
      el('div', { class: 'avatar', html: icon('plus', 22) }), el('div', { class: 'member-cell__name', text: '添加' })]));
  }
  body.append(el('div', { class: 'field' }, [el('span', { class: 'field__label', text: `群成员 · ${g.member_count}` }), grid]));

  /* 操作：主按钮一行 + 管理宫格等宽三列 + 危险区两列。
     之前 6 个按钮挤在一条 flex 里自动换行，宽度参差是"列表尺寸不协调"的重灾区。 */
  const refreshGroup = async () => { await loadGroups(); await loadConvs(); emit('ui:refresh'); };
  const holder = { close: null };   // modal() 返回后回填，便于「解散 / 退出」后关闭卡片
  const acts = el('div', { class: 'acts-stack' });
  const tile = (ico, label, onClick, kind = '') => el('button', { class: `btn ${kind}`, onClick }, [
    el('span', { class: 'acts-ico', html: icoHtml(ico, 16) }), el('span', { text: label }),
  ]);

  if (g.is_owner) {
    acts.append(
      el('button', { class: 'btn btn--primary btn--full', text: '进入群聊', onClick: () => emit('ui:openConv', `g:${gid}`) }),
      el('div', { class: 'acts-grid' }, [
        tile('users', '成员管理', () => openGroupMembers(g)),
        tile('edit', '编辑群资料', () => openEditGroup(g, () => { openGroupCard(gid); onChanged && onChanged(); })),
        tile('userPlus', '邀请好友入群', () => openInviteMembers(gid)),
      ]),
      el('div', { class: 'acts-grid' }, [
        tile('bell', '群公告', () => openGroupAnnounce(gid, g)),
        tile('shield', '转让群聊', () => openTransferOwner(g, () => { openGroupCard(gid); onChanged && onChanged(); })),
      ]),
      el('div', { class: 'acts-danger' }, [
        tile('flag', '举报', () => openReport('group', gid), 'btn--ghost'),
        tile('trash', '解散群聊', async () => {
          if (!await confirm('解散后群聊与聊天记录将不可恢复，确定吗？', { danger: true, okText: '解散' })) return;
          await api.del(`/api/groups/${gid}`);
          toast('群聊已解散', 'ok');
          holder.close && holder.close();       // 群已不存在，卡片必须关闭
          await refreshGroup();
          emit('ui:nav', 'chat');
        }, 'btn--danger'),
      ]),
    );
  } else if (g.is_admin) {
    // 副管理员：能管人、能发公告、能审批入群，但不能改群资料 / 解散 / 转让
    acts.append(
      el('button', { class: 'btn btn--primary btn--full', text: '进入群聊', onClick: () => emit('ui:openConv', `g:${gid}`) }),
      el('div', { class: 'acts-grid' }, [
        tile('users', '成员管理', () => openGroupMembers(g)),
        tile('bell', '群公告', () => openGroupAnnounce(gid, g)),
        tile('userPlus', '邀请好友入群', () => openInviteMembers(gid)),
      ]),
      el('div', { class: 'acts-danger' }, [
        tile('flag', '举报', () => openReport('group', gid), 'btn--ghost'),
        el('button', { class: 'btn btn--danger', text: '退出群聊', onClick: () => leaveGroup(gid, holder, refreshGroup) }),
      ]),
    );
  } else if (g.joined) {
    acts.append(
      el('button', { class: 'btn btn--primary btn--full', text: '进入群聊', onClick: () => emit('ui:openConv', `g:${gid}`) }),
      el('div', { class: 'acts-grid' }, [
        tile('userPlus', '邀请好友入群', () => openInviteMembers(gid)),
        tile('edit', '设置群备注', async () => {
          const v = await prompt('设置群备注', { value: g.remark || '' });
          if (v === null) return;
          await api.post('/api/groups/remark', { target: gid, remark: v, kind: 'group' });
          toast('已更新', 'ok'); loadConvs();
        }),
        tile('flag', '举报', () => openReport('group', gid), 'btn--ghost'),
      ]),
      el('div', { class: 'acts-danger' }, [
        el('button', { class: 'btn btn--danger', style: { gridColumn: '1 / -1' }, text: '退出群聊', onClick: async () => {
          if (!await confirm('确定退出该群聊吗？', { danger: true, okText: '退出' })) return;
          await api.post('/api/groups/leave', { gid });
          toast('已退出群聊', 'ok');
          holder.close && holder.close();
          await refreshGroup();
          emit('ui:nav', 'chat');
        } }),
      ]),
    );
  } else {
    acts.append(
      el('button', { class: 'btn btn--primary btn--full', text: '申请加入群聊', onClick: () => openJoinGroup(gid) }),
      el('div', { class: 'acts-danger' }, [
        el('button', { class: 'btn btn--ghost', style: { gridColumn: '1 / -1' }, text: '举报', onClick: () => openReport('group', gid) }),
      ]),
    );
  }
  body.appendChild(acts);
  const box = modal({ title: '群聊信息', body, wide: true });
  holder.close = box.close;
}

/* ---------------- 编辑群资料 ---------------- */
export function openEditGroup(g, onSaved) {
  const body = el('div', { class: 'form' });
  let avatarValue = g.avatar || '🐼';
  const picker = el('div', { class: 'avatar-picker' });
  const render = () => {
    picker.innerHTML = '';
    PICK.forEach((a) => picker.appendChild(el('button', {
      class: 'avatar-picker__opt' + (avatarValue === a ? ' is-active' : ''), type: 'button', text: a,
      onClick: () => { avatarValue = a; render(); },
    })));
  };
  render();
  body.append(
    el('div', { class: 'field' }, [el('span', { class: 'field__label', text: '群头像' }), picker]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '群名称' }), el('input', { class: 'input', name: 'name', value: g.name })]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '群介绍' }), el('textarea', { class: 'input', name: 'intro', rows: 3, style: { height: 'auto', padding: '10px 12px', resize: 'vertical' }, text: g.intro || '' })]),
    el('div', { class: 'grid-2' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '入群方式' }), el('select', { class: 'input', name: 'join_mode' },
        [['free', '自由加入'], ['approval', '需要审核'], ['invite', '仅群主邀请']].map(([v, t]) => el('option', { value: v, text: t, selected: g.join_mode === v })))]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '可发现性' }), el('select', { class: 'input', name: 'discoverable' },
        [['1', '允许被搜索到'], ['0', '不公开']].map(([v, t]) => el('option', { value: v, text: t, selected: (g.discoverable ? '1' : '0') === v })))]),
    ]),
    el('div', { class: 'setting-row' }, [
      el('div', { class: 'grow' }, [el('div', { class: 'setting-row__label', text: '全员禁言' }), el('div', { class: 'setting-row__desc', text: '开启后仅群主可发言' })]),
      el('div', { class: 'setting-row__ctrl' }, [el('div', { class: 'switch' + (g.mute_all ? ' is-on' : ''), onclick: (e) => e.target.classList.toggle('is-on') })]),
    ]),
  );
  modal({
    title: '编辑群资料', body,
    footer: [{
      text: '保存', kind: 'primary', onClick: async () => {
        const fd = collectForm(body);
        await api.put('/api/groups', {
          gid: g.id,
          name: String(fd.name || '').trim(),
          intro: String(fd.intro || '').trim(),
          avatar: avatarValue,
          join_mode: String(fd.join_mode),
          discoverable: String(fd.discoverable) === '1',
          mute_all: !!body.querySelector('.switch').classList.contains('is-on'),
        });
        toast('群资料已更新', 'ok'); loadGroups(); loadConvs(); onSaved && onSaved(); emit('ui:refresh');
      }
    }, { text: '取消' }],
  });
}

/* ---------------- 转让群聊 ---------------- */
export function openTransferOwner(g, onDone) {
  const sel = el('select', { class: 'input', name: 'uid' });
  const load = async () => {
    const r = await api.get(`/api/groups/${g.id}`);
    sel.innerHTML = '';
    (r.group.members || []).filter((m) => m.id !== r.group.owner).forEach((m) => {
      sel.appendChild(el('option', { value: m.id, text: `${m.remark || m.nickname}（@${m.username}）` }));
    });
  };
  load();
  const body = el('div', { class: 'form' }, [
    el('div', { class: 'field' }, [el('span', { class: 'field__label', text: '转让给' }), sel]),
    el('div', { class: 'muted', style: { fontSize: '11.5px' },
      text: '转让后你将成为普通成员，对方成为新群主。成员名单不变，聊天记录与群密钥不受影响。' }),
  ]);
  modal({
    title: '转让群聊', body,
    footer: [
      { text: '确认转让', kind: 'danger', onClick: async () => {
        const uid = String(sel.value || '');
        if (!uid) { toast('请先选择受让成员', 'info'); return false; }
        if (!await confirm('转让后你将失去群主权限，确定吗？', { danger: true, okText: '转让' })) return false;
        await api.post('/api/groups/transfer', { gid: g.id, uid });
        toast('群主已转让', 'ok');
        await loadGroups(); await loadConvs();
        onDone && onDone(); emit('ui:refresh');
      } },
      { text: '取消' },
    ],
  });
}

/* ---------------- 群公告 ---------------- */
export function openGroupAnnounce(gid, g = {}) {
  const body = el('div', { class: 'form' }, [
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: '群公告' }),
      el('textarea', { class: 'input', name: 'announce', rows: 4, maxLength: 500,
        placeholder: '留空即清空公告', style: { height: 'auto', padding: '10px 12px', resize: 'vertical' },
        text: g.announce || '' }),
    ]),
    el('div', { class: 'muted', style: { fontSize: '11.5px' },
      text: '公告常驻在群聊顶部，全体成员可见；只有群主和管理员可以发布。' }),
  ]);
  const save = async (text) => {
    await api.post('/api/groups/announce', { gid, text });
    toast(text ? '群公告已更新' : '群公告已清空', 'ok');
    await loadGroups();
    emit('ui:refresh');
    // 群聊页顶部公告条要立刻跟着变。走 refreshGroupHead 而不是 refreshChatHead：
    // 后者直接用 openConv 时缓存的 current.group 重画，会把刚存的新公告覆盖回旧值。
    const { refreshGroupHead } = await import('./chat.js');
    await refreshGroupHead(gid);
  };
  modal({
    title: '群公告', body,
    footer: [
      { text: '保存', kind: 'primary', onClick: async () => {
        const fd = collectForm(body);
        await save(String(fd.announce || '').trim());
      } },
      g.announce ? { text: '清空', kind: 'danger', onClick: () => save('') } : null,
      { text: '取消' },
    ].filter(Boolean),
  });
}

/* ---------------- 成员管理 ---------------- */
async function leaveGroup(gid, holder, after) {
  if (!await confirm('确定退出该群聊吗？', { danger: true, okText: '退出' })) return;
  await api.post('/api/groups/leave', { gid });
  toast('已退出群聊', 'ok');
  holder.close && holder.close();       // 已不是成员，卡片必须关掉
  await after();
  emit('ui:nav', 'chat');
}

export async function openGroupMembers(g) {
  const r = await api.get(`/api/groups/${g.id}`);
  const gg = r.group;
  const admins = new Set(gg.admins || []);
  // 我的角色直接取服务端算好的 role：权限判断不能靠前端猜，但也别重复请求
  const myRole = gg.role || (gg.is_owner ? 'owner' : 'member');
  const roleOf = (m) => (m.id === gg.owner ? 'owner' : admins.has(m.id) ? 'admin' : 'member');
  const members = (gg.members || []);
  const body = el('div');
  if (!members.length) body.appendChild(el('div', { class: 'muted center', text: '暂无成员', style: { padding: '18px' } }));

  // 群主排最前，管理员次之，其余按昵称 —— 管理层要一眼看到
  const order = { owner: 0, admin: 1, member: 2 };
  members.sort((a, b) => (order[roleOf(a)] - order[roleOf(b)])
    || String(a.remark || a.nickname || '').localeCompare(String(b.remark || b.nickname || '')));

  members.forEach((m) => {
    const role = roleOf(m);
    const row = el('div', { class: 'device-card' }, [
      avatar(m, 'sm', { status: true }),
      el('div', { class: 'grow' }, [
        el('div', { class: 'setting-row__label' }, [
          nameNode(m),
          role === 'owner' ? el('span', { class: 'tag tag--accent', text: '群主' }) : null,
          role === 'admin' ? el('span', { class: 'tag tag--ok', text: '管理员' }) : null,
        ]),
        el('div', { class: 'setting-row__desc', text: `@${m.username}` }),
      ]),
    ]);
    // 任命 / 撤销管理员：只有群主能改管理层
    if (myRole === 'owner' && role !== 'owner') {
      row.appendChild(el('button', {
        class: 'btn btn--sm btn--ghost', text: role === 'admin' ? '撤销管理' : '设为管理',
        onClick: async () => {
          await api.post('/api/groups/admin', { gid: gg.id, uid: m.id, admin: role !== 'admin' });
          toast(role === 'admin' ? '已撤销管理员' : '已设为管理员', 'ok');
          await loadGroups();
          openGroupMembers(g);       // 就地刷新列表
        },
      }));
    }
    // 禁言 / 移出：群主可对所有非群主成员下手；管理员只能对普通成员
    if (role === 'member' || (myRole === 'owner' && role === 'admin')) {
      row.appendChild(el('button', { class: 'btn btn--sm btn--ghost', text: '禁言', onClick: async () => {
        const d = await prompt('禁言时长（秒，0 表示永久）', { value: '600' });
        if (d === null) return;
        try {
          await api.post('/api/groups/mute', { gid: gg.id, uid: m.id, mute: true, duration: Number(d) || 0 });
          toast('已禁言', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      } }));
      row.appendChild(el('button', { class: 'btn btn--sm btn--danger', text: '移出', onClick: async () => {
        if (!await confirm(`将 ${m.remark || m.nickname} 移出群聊？`, { danger: true, okText: '移出' })) return;
        try {
          await api.del('/api/groups/members', { gid: gg.id, uid: m.id });
          toast('已移出', 'ok'); openGroupMembers(g); loadGroups();
        } catch (e) { toast(e.message, 'err'); }
      } }));
    }
    body.appendChild(row);
  });
  modal({ title: `成员管理 · ${members.length} 人`, body, footer: null });
}

export async function openInviteMembers(gid) {
  const friends = state.friends.length ? state.friends : (await loadFriends());
  const r = await api.get(`/api/groups/${gid}`);
  const joined = new Set((r.group.members || []).map((m) => m.id));
  const body = el('div');
  const list = friends.filter((f) => !joined.has(f.id));
  if (!list.length) body.appendChild(el('div', { class: 'muted center', text: '好友都已入群', style: { padding: '18px' } }));
  list.forEach((f) => {
    body.appendChild(el('div', { class: 'device-card' }, [
      avatar(f, 'sm', { status: true }),
      el('div', { class: 'grow' }, [el('div', { class: 'setting-row__label' }, [nameNode(f)])]),
      el('button', { class: 'btn btn--sm btn--primary', text: '邀请', onClick: async () => {
        const r = await api.post('/api/groups/members', { gid, uid: f.id });
        // 密钥必须按对方 RSA 公钥真实包裹后交给服务端中转。
        // 早期这里写的是 ensureGroupKey() + wrapKeyRaw()，而后者返回的是「全局密钥 token」，
        // 服务端只看有没有值就把该成员移出待领队列 —— 对方于是被判定为「已领到密钥」，
        // 却怎么也解不开，读不到任何群历史，定时补发也不会再来救场。
        // relayGroupKey 内部走 wrapGroupKey 做真实包裹；对方若尚未入群，服务端会跳过，
        // 待领标记保留，由 state.js 的定时补发（distributeKeys）兜底。
        const { ensureGroupKey, relayGroupKey } = await import('./state.js');
        await ensureGroupKey(gid);
        await relayGroupKey(gid, [f.id]);
        if (r && r.joined) toast(`${f.remark || f.nickname} 已加入群聊`, 'ok');
        else if (r && r.need_user) toast('已发出邀请，等待对方同意', 'ok');
        else if (r && r.need_owner) toast('对方已同意，等待群主确认', 'ok');
        else toast('已邀请', 'ok');
        loadGroups();
      } }),
    ]));
  });
  modal({ title: '添加群成员', body, footer: null });
}

/* ---------------- 添加好友卡 ---------------- */
export async function openAddFriend(uid = '') {
  const body = el('div', { class: 'form' });
  const friends = state.friends.length ? state.friends : (await loadFriends()).length ? state.friends : [];
  let target = uid;
  if (!target) {
    const sel = el('select', { class: 'input', name: 'to' });
    // 允许输入任意用户名：提供搜索框
    const input = el('input', { class: 'input', name: 'q', placeholder: '输入用户名或昵称后搜索' });
    const results = el('div');
    const doSearch = async () => {
      const q = String(input.value || '').trim();
      if (!q) return;
      const r = await api.get(`/api/search?q=${encodeURIComponent(q)}&scope=user`);
      results.innerHTML = '';
      (r.users || []).slice(0, 12).forEach((u) => {
        results.appendChild(el('div', { class: 'contact-item', onClick: () => { target = u.id; results.innerHTML = ''; input.value = u.nickname; } }, [
          avatar(u, 'sm', { status: true }),
          el('div', { class: 'grow' }, [el('div', { class: 'contact-item__name' }, [nameNode(u)]), el('div', { class: 'contact-item__sub', text: '@' + u.username })]),
        ]));
      });
      if (!results.children.length) results.appendChild(el('div', { class: 'muted', text: '未找到匹配用户', style: { padding: '6px 4px' } }));
    };
    body.append(
      el('div', { class: 'field' }, [el('span', { class: 'field__label', text: '查找用户' }), input]),
      results,
    );
    let t = null;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(doSearch, 400); });
    body.dataset.getTarget = () => target;
  }
  body.appendChild(el('label', { class: 'field' }, [
    el('span', { class: 'field__label', text: '申请留言（可自定义）' }),
    el('textarea', { class: 'input', name: 'message', rows: 3, placeholder: '我是…想和你聊聊', style: { height: 'auto', padding: '10px 12px', resize: 'vertical' } }),
  ]));
  modal({
    title: '添加好友', body,
    footer: [{
      text: '发送申请', kind: 'primary', onClick: async () => {
        const fd = collectForm(body);
        const to = target || String(fd.to || '');
        if (!to) { toast('请先选择要添加的用户', 'err'); return false; }
        // 隐私预检：对方可能禁止被添加，或设置了验证问题
        let answer = '';
        try {
          const chk = await api.get(`/api/friends/add-check?uid=${encodeURIComponent(to)}`);
          if (!chk.can) {
            const why = {
              none: '对方已关闭被添加功能',
              blocked: '你们之间存在拉黑关系，无法添加',
              friend: '你们已经是好友了',
              self: '不能添加自己',
              pending: '申请已发送，请等待对方处理',
            };
            toast(why[chk.mode] || '对方暂不接受好友申请', 'err');
            // 已经是好友 / 申请在途：没有可继续操作的空间，直接关掉弹窗，
            // 否则弹窗停在原地会让人以为"点了没反应"
            if (chk.mode === 'friend' || chk.mode === 'pending' || chk.mode === 'self') return;
            return false;
          }
          if (chk.mode === 'question') {
            const a = await prompt(chk.question || '请回答对方的验证问题', { label: '答对后对方才会收到你的申请' });
            if (a === null) return false;
            answer = String(a || '').trim();
          }
        } catch (e) { /* 预检失败不阻断，交由后端最终判定 */ }
        await api.post('/api/friends/request', { to, message: String(fd.message || '').slice(0, 120), answer });
        toast('申请已发送', 'ok'); emit('ui:refresh');
      }
    }, { text: '取消' }],
  });
}

/* ---------------- 加入群聊卡 ----------------
   改为「输入群名 → 匹配出候选 → 单选一个」：直接罗列全站群聊既暴露了
   不公开的群，也让用户在一长串列表里翻找。 */
export async function openJoinGroup(gid = '') {
  const body = el('div', { class: 'form' });
  let target = gid || '';
  let picked = null;

  const input = el('input', { class: 'input', placeholder: '输入群名称关键词…' });
  const list = el('div', { style: { maxHeight: '220px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' } });
  const tip = el('div', { class: 'muted', style: { padding: '6px 0 0', fontSize: '12px' }, text: '输入群名后点选一个群（每次仅可选择一个）' });

  const say = (text) => { list.innerHTML = ''; list.appendChild(el('div', { class: 'muted', style: { padding: '8px' }, text })); };
  say('输入群名称开始查找');

  let timer = null;
  const search = async () => {
    const kw = String(input.value || '').trim();
    if (!kw) { picked = null; target = ''; say('输入群名称开始查找'); return; }
    say('查找中…');
    let groups = [];
    try { groups = (await api.get(`/api/groups/discover?q=${encodeURIComponent(kw)}`)).groups || []; }
    catch { groups = []; }
    list.innerHTML = '';
    if (!groups.length) { say('没有匹配的群聊，换个关键词试试'); return; }
    groups.forEach((g) => {
      const row = el('div', {
        class: 'contact-item', dataset: { gid: g.id },
        onClick: () => {
          // 单选：一次只能选中一个群，再点已选中的项则取消
          picked = picked && picked.id === g.id ? null : g;
          target = picked ? picked.id : '';
          Array.from(list.children).forEach((n) => n.classList.toggle('is-active', !!picked && n.dataset.gid === picked.id));
          tip.textContent = picked ? `已选择：${picked.name || '群聊'}` : '输入群名后点选一个群（每次仅可选择一个）';
        },
      }, [
        el('div', { class: 'avatar avatar--sm', text: (g.name || '群').slice(0, 1) }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'contact-item__name', text: g.name }),
          el('div', { class: 'contact-item__sub', text: `${g.member_count} 人 · ${g.intro || '无介绍'}` }),
        ]),
        g.join_mode === 'free' ? el('span', { class: 'tag tag--ok', text: '自由加入' })
          : el('span', { class: 'tag', text: g.join_mode === 'invite' ? '仅邀请' : '需审核' }),
      ]);
      list.appendChild(row);
    });
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 320); });

  body.append(
    el('div', { class: 'field' }, [el('span', { class: 'field__label', text: '查找群聊' }), input]),
    el('div', { class: 'field' }, [el('span', { class: 'field__label', text: '匹配结果' }), list, tip]),
  );
  if (gid) {
    // 从群卡 / 搜索结果带过来的指定群：直接把该群渲染成已选中项，
    // 不再让结果区停在最开始的「输入群名称开始查找」提示上
    input.disabled = true; input.value = '已指定群聊';
    (async () => {
      try {
        const r = await api.get(`/api/groups/${gid}`);
        const g = r.group || {};
        target = gid; picked = { id: gid, name: g.remark || g.name };
        list.innerHTML = '';
        list.appendChild(el('div', { class: 'contact-item is-active' }, [
          el('div', { class: 'avatar avatar--sm', text: (g.name || '群').slice(0, 1) }),
          el('div', { class: 'grow' }, [
            el('div', { class: 'contact-item__name', text: g.remark || g.name || '群聊' }),
            el('div', { class: 'contact-item__sub', text: `${g.member_count || '?'} 人 · ${g.intro || '无介绍'}` }),
          ]),
          el('span', { class: 'tag tag--ok', text: '已选择' }),
        ]));
        tip.textContent = `已选择：${g.remark || g.name || '群聊'}`;
      } catch (e) { say(e.message || '群聊不存在或已解散'); }
    })();
  }
  body.appendChild(el('label', { class: 'field' }, [
    el('span', { class: 'field__label', text: '入群申请（可自定义）' }),
    el('textarea', { class: 'input', name: 'message', rows: 3, placeholder: '我想加入这个群…', style: { height: 'auto', padding: '10px 12px', resize: 'vertical' } }),
  ]));
  modal({
    title: '加入群聊', body,
    footer: [{
      text: '提交申请', kind: 'primary', onClick: async () => {
        const fd = collectForm(body);
        if (!target) { toast('请选择群聊', 'err'); return false; }
        const r = await api.post('/api/groups/join', { gid: target, message: String(fd.message || '').slice(0, 120) });
        toast(r.joined ? '已加入群聊' : '申请已提交', 'ok');
        loadGroups(); loadConvs(); emit('ui:refresh');
      }
    }, { text: '取消' }],
  });
}

/* ---------------- 好友申请列表卡（侧栏入口） ----------------
   好友申请不再占用通讯录主区的一整块，收进这张卡里统一处理。 */
export async function openFriendRequests() {
  const body = el('div', { class: 'form' });
  const list = el('div', { class: 'req-list' });
  const count = el('span', { class: 'tag tag--accent' });
  body.append(
    el('div', { class: 'req-list__bar' }, [el('span', { class: 'req-list__title', text: '待处理' }), count, el('div', { class: 'grow' })]),
    list,
  );

  let rows = [];
  const draw = () => {
    count.textContent = String(rows.length);
    list.innerHTML = '';
    if (!rows.length) {
      list.appendChild(el('div', { class: 'empty-mini' }, [
        el('div', { class: 'muted', text: '暂无待处理的好友申请' }),
      ]));
      return;
    }
    rows.forEach((r) => {
      const u = r.from_user || {};
      const row = el('div', { class: 'device-card' }, [
        avatar(u, 'sm', { status: true, onClick: () => openUserCard(u.id) }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'setting-row__label' }, [nameNode(u, { text: u.nickname || '用户' })]),
          el('div', { class: 'setting-row__desc ellipsis', text: r.message || '（无留言）' }),
        ]),
      ]);
      const acts = el('div', { class: 'req-list__acts' }, [
        el('button', { class: 'btn btn--sm btn--primary', text: '同意', onClick: async () => {
          await api.post('/api/friends/handle', { rid: r.id, accept: true });
          rows = rows.filter((x) => x.id !== r.id);
          toast(`已添加 ${u.remark || u.nickname || '好友'}`, 'ok');
          await loadFriends(); await loadConvs(); await loadFriendRequests();
          rows = state.requests.friend || [];
          draw(); emit('ui:refresh');
        } }),
        el('button', { class: 'btn btn--sm btn--ghost', text: '拒绝', onClick: async () => {
          await api.post('/api/friends/handle', { rid: r.id, accept: false });
          rows = rows.filter((x) => x.id !== r.id);
          toast('已拒绝', 'info');
          await loadFriendRequests();
          rows = state.requests.friend || [];
          draw(); emit('ui:refresh');
        } }),
      ]);
      row.appendChild(acts);
      list.appendChild(row);
    });
  };

  const spin = el('div', { class: 'center', style: { padding: '26px' } }, [el('span', { class: 'spinner' })]);
  list.appendChild(spin);
  modal({ title: '好友申请', body, wide: false, footer: [{ text: '关闭' }] });
  try { rows = await loadFriendRequests() || []; } catch { rows = []; }
  draw();
}

/* ---------------- 入群申请卡（我管理的群聊） ----------------
   与「好友申请卡」同一套交互：列表 + 同意 / 拒绝，处理完就地移除该行。 */
export async function openGroupRequests(gid = '') {
  const body = el('div', { class: 'form' });
  const list = el('div', { class: 'req-list' });
  const count = el('span', { class: 'tag tag--accent' });
  const where = el('span', { class: 'muted', style: { fontSize: '12px' } });
  body.append(
    el('div', { class: 'req-list__bar' }, [el('span', { class: 'req-list__title', text: '入群申请' }), count, el('div', { class: 'grow' }), where]),
    list,
  );

  let rows = [];
  const draw = () => {
    count.textContent = String(rows.length);
    list.innerHTML = '';
    if (!rows.length) {
      list.appendChild(el('div', { class: 'empty-mini' }, [
        el('div', { class: 'muted', text: '暂无待处理的入群申请' }),
      ]));
      return;
    }
    rows.forEach((r) => {
      const u = r.user || {};
      const row = el('div', { class: 'device-card' }, [
        avatar(u, 'sm', { status: true, onClick: () => openUserCard(u.id) }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'setting-row__label' }, [nameNode(u, { text: u.nickname || '用户' })]),
          el('div', { class: 'setting-row__desc ellipsis', text: r.message || '（无留言）' }),
        ]),
      ]);
      row.appendChild(el('div', { class: 'req-list__acts' }, [
        el('button', { class: 'btn btn--sm btn--primary', text: '同意', onClick: async () => {
          await api.post('/api/groups/requests/handle', { gid: r.gid, rid: r.id, accept: true });
          toast('已同意入群', 'ok');
          await loadGroups(); await loadConvs(); emit('ui:refresh');
          await reload();
        } }),
        el('button', { class: 'btn btn--sm btn--ghost', text: '拒绝', onClick: async () => {
          await api.post('/api/groups/requests/handle', { gid: r.gid, rid: r.id, accept: false });
          toast('已拒绝', 'info');
          await reload();
        } }),
      ]));
      list.appendChild(row);
    });
  };

  const reload = async () => {
    rows = [];
    const mine = (state.groups || []).filter((g) => g.is_owner);
    const gids = gid ? [gid] : mine.map((g) => g.id);
    for (const id of gids) {
      const g = mine.find((x) => x.id === id) || { id, name: '群聊' };
      try {
        const rs = (await api.get(`/api/groups/${id}/requests`)).requests || [];
        rs.forEach((r) => rows.push({ ...r, gid: id, group_name: g.name }));
      } catch { /* 非群主 / 接口异常 → 跳过 */ }
    }
    rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    where.textContent = gid ? (mine.find((g) => g.id === gid)?.name || '') : `共 ${gids.length} 个群`;
    draw();
  };

  list.appendChild(el('div', { class: 'center', style: { padding: '26px' } }, [el('span', { class: 'spinner' })]));
  modal({ title: '入群申请', body, wide: false, footer: [{ text: '关闭' }] });
  await loadGroups();
  await reload();
}

/* ---------------- 公共聊天室成员卡 ---------------- */
export async function openRoomMembers() {
  const body = el('div');
  const list = el('div', { class: 'req-list' });
  const head = el('div', { class: 'room-members__head muted' });
  body.append(head, list);

  const draw = (members, total) => {
    head.textContent = total
      ? `公共聊天室共 ${total} 位成员，当前在线 ${members.length} 人`
      : '正在获取成员…';
    list.innerHTML = '';
    if (!members.length) {
      list.appendChild(el('div', { class: 'empty-mini' }, [el('div', { class: 'muted', text: '当前没有其他成员在线' })]));
      return;
    }
    members.forEach((m) => {
      list.appendChild(el('div', {
        class: 'device-card', title: '查看资料',
        onClick: () => { if (!m.is_self) openUserCard(m.id); },
      }, [
        avatar(m, 'sm', { status: true }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'setting-row__label' }, [
            nameNode(m, { text: m.remark || m.nickname || '成员' }),
            m.is_self ? el('span', { class: 'tag tag--accent', text: '我' }) : null,
            m.friend ? el('span', { class: 'tag tag--ok', text: '好友' }) : null,
          ]),
          el('div', { class: 'setting-row__desc', text: m.is_self ? '你正在这里' : `@${m.username}` }),
        ]),
        el('span', { class: 'tag tag--ok', text: '在线' }),
      ]));
    });
  };

  list.appendChild(el('div', { class: 'center', style: { padding: '26px' } }, [el('span', { class: 'spinner' })]));
  modal({ title: '聊天室成员', body, wide: false, footer: [{ text: '关闭' }] });
  try {
    const r = await api.get('/api/chat/room/members');
    draw(r.members || [], r.total || 0);
  } catch (e) {
    list.innerHTML = '';
    list.appendChild(el('div', { class: 'muted center', style: { padding: '22px' }, text: e?.message || '获取成员失败' }));
  }
}

/* ---------------- 举报 ---------------- */
export async function openReport(type, id) {
  const reasons = (await api.get('/api/reports/reasons')).reasons || [];
  const body = el('div', { class: 'form' });
  let chosen = reasons[0];
  const chips = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } });
  reasons.forEach((r) => {
    const b = el('button', { class: 'btn btn--sm' + (r === chosen ? ' btn--primary' : ' btn--ghost'), text: r, type: 'button',
      onClick: () => { chosen = r; chips.querySelectorAll('.btn').forEach((n) => { n.classList.remove('btn--primary'); n.classList.add('btn--ghost'); }); b.classList.add('btn--primary'); b.classList.remove('btn--ghost'); } });
    chips.appendChild(b);
  });
  body.append(
    el('div', { class: 'field' }, [el('span', { class: 'field__label', text: '举报原因' }), chips]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: '补充说明（选填）' }),
      el('textarea', { class: 'input', name: 'detail', rows: 3, style: { height: 'auto', padding: '10px 12px', resize: 'vertical' } }),
    ]),
    el('div', { class: 'muted', style: { fontSize: '11.5px' }, text: '提交后管理员会核查被举报内容（含聊天正文），请确保举报属实；恶意举报将按社区规范处理。' }),
  );
  modal({
    title: '举报', body,
    footer: [{
      text: '提交举报', kind: 'danger', onClick: async () => {
        const fd = collectForm(body);
        await api.post('/api/reports', {
          target_type: type, target_id: id, reason: chosen,
          detail: String(fd.detail || '').slice(0, 500),
        });
        toast('举报已提交，感谢你的反馈', 'ok');
      }
    }, { text: '取消' }],
  });
}
