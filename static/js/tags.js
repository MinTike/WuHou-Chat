/* ============================================================
   好友分组标签：chip 渲染 / 给好友打标 / 标签管理
   单独成模块的原因是 contacts / cards / moments 三处都要用，
   而它们之间存在循环引用（contacts → cards），再互相 import 会炸。
   ============================================================ */
import { el } from './util.js';
import { api } from './api.js';
import { toast, modal, confirm, prompt } from './ui.js';
import { state, loadTags, loadFriends, loadConvs, emit } from './state.js';
import { icon } from './icons.js';

export const TAG_COLORS = ['accent', 'accent-2', 'ok', 'warn', 'danger'];

const COLOR_TEXT = {
  accent: '紫', 'accent-2': '青', ok: '绿', warn: '橙', danger: '红',
};

/** 单个分组标签 chip。small = 联系人列表里的迷你版 */
export function tagChip(tag, { count = null, small = false, active = false, onClick = null } = {}) {
  if (!tag) return null;
  const cls = ['tagchip', `tagchip--${tag.color || 'accent'}`];
  if (small) cls.push('tagchip--sm');
  if (active) cls.push('is-active');
  // 可点的 chip 用 button（键盘可达），纯展示用 span —— 两种场景共用同一套样式
  const props = { class: cls.join(' '), title: tag.name, text: count === null ? tag.name : `${tag.name} ${count}` };
  if (onClick) { props.type = 'button'; props.onClick = onClick; }
  return el(onClick ? 'button' : 'span', props);
}

/** 好友身上的一串标签（渲染时复用 tagMap，避免逐个 find） */
export function friendChips(friend, { map = null, max = 3 } = {}) {
  const m = map || tagMap();
  const ids = friend && friend.tags ? friend.tags : [];
  if (!ids.length) return null;
  const wrap = el('div', { class: 'tagchips' });
  ids.slice(0, max).forEach((id) => {
    const c = tagChip(m[id], { small: true });
    if (c) wrap.appendChild(c);
  });
  if (ids.length > max) {
    wrap.appendChild(el('span', { class: 'tagchip tagchip--more', text: `+${ids.length - max}` }));
  }
  return wrap;
}

export function tagMap() {
  const m = {};
  (state.tags || []).forEach((t) => { m[t.id] = t; });
  return m;
}

/** 分组名列表（给资料卡、动态可见范围的摘要用） */
export function tagNames(ids, map = null) {
  const m = map || tagMap();
  return (ids || []).map((id) => (m[id] && m[id].name) || '').filter(Boolean);
}

/* ---------------- 给某个好友打标 ---------------- */
/**
 * 给好友打标。返回一个 Promise：**弹窗关闭后才 resolve**（saved = 是否点了保存）。
 * 写成 awaitable 是必需的——调用方要在关闭后重开资料卡刷新显示，
 * 若不等待就会出现「分组弹窗还在，资料卡又叠了一层把它盖住」。
 */
export function openTagPicker(friend, onDone) {
  return new Promise((resolve) => {
    const map = tagMap();
    const picked = new Set(friend.tags || []);
    const box = el('div', { class: 'privacy-picker' });
    let newName = '';
    let saved = false;

    const render = () => {
      box.innerHTML = '';
      if (!(state.tags || []).length) {
        box.appendChild(el('div', { class: 'muted', style: { padding: '4px 0' }, text: '还没有分组，先在下面新建一个' }));
        return;
      }
      state.tags.forEach((t) => {
        const on = picked.has(t.id);
        const chip = tagChip(t, {
          small: true, active: on, count: t.count,
          onClick: () => { if (on) picked.delete(t.id); else picked.add(t.id); render(); },
        });
        if (chip) box.appendChild(chip);
      });
    };
    render();

    const nameInput = el('input', {
      class: 'input', placeholder: '新建分组，例如「大学同学」', maxLength: '12',
      onInput: (e) => { newName = e.target.value; },
    });
    const addRow = el('div', { class: 'tagmgr__new' }, [
      el('div', { class: 'grow' }, [nameInput]),
      el('button', {
        class: 'btn btn--sm btn--ghost', type: 'button', text: '新建并选中',
        onClick: async () => {
          const n = String(newName || '').trim();
          if (!n) { toast('请填写分组名称', 'err'); return; }
          try {
            const r = await api.post('/api/friends/tags', { name: n });
            const t = r.tag;
            await loadTags();
            picked.add(t.id);
            nameInput.value = ''; newName = '';
            render();
            toast(`已创建分组「${t.name}」`, 'ok');
          } catch (e) { toast(e.message, 'err'); }
        },
      }),
    ]);

    const body = el('div', { class: 'form' }, [
      el('div', { class: 'field' }, [
        el('span', { class: 'field__label', text: `给 ${friend.remark || friend.nickname} 分组` }),
        box,
      ]),
      el('div', { class: 'field' }, [el('span', { class: 'field__label', text: '补一个新分组' }), addRow]),
    ]);

    modal({
      title: '设置分组', body, wide: false,
      // 关闭后才让调用方继续：否则重开的资料卡会压在还没关掉的分组弹窗上面
      onClose: () => resolve(saved),
      footer: [{
        text: '保存', kind: 'primary', onClick: async () => {
          await api.put(`/api/friends/${friend.id}/tags`, { tags: Array.from(picked) });
          toast('分组已更新', 'ok');
          saved = true;
          await loadTags(); await loadFriends(); await loadConvs();
          emit('ui:refresh');
          if (onDone) onDone(Array.from(picked));
        },
      }, { text: '取消' }],
    });
  });
}

/* ---------------- 标签管理：重命名 / 换色 / 删除 ---------------- */
export function openTagManager(onChanged) {
  const body = el('div', { class: 'form tagmgr' });
  let max = 20;

  const swatchRow = (tag) => {
    const row = el('div', { class: 'tagmgr__swatches' });
    TAG_COLORS.forEach((c) => {
      const dot = el('button', {
        class: `tagmgr__dot tagchip--${c}` + (tag.color === c ? ' is-active' : ''),
        type: 'button', title: COLOR_TEXT[c] || c,
        onClick: async () => {
          if (tag.color === c) return;
          try {
            await api.patch(`/api/friends/tags/${tag.id}`, { color: c });
            tag.color = c;
            await loadTags();
            if (onChanged) onChanged();
            rebuild();
          } catch (e) { toast(e.message, 'err'); }
        },
      });
      row.appendChild(dot);
    });
    return row;
  };

  const rebuild = () => {
    body.innerHTML = '';
    const list = el('div', { class: 'tagmgr__list' });
    if (!(state.tags || []).length) {
      list.appendChild(el('div', { class: 'muted center', style: { padding: '14px' }, text: '还没有分组，通讯录里可以给好友打标签' }));
    }
    state.tags.forEach((tag) => {
      list.appendChild(el('div', { class: 'device-card tagmgr__row' }, [
        el('span', { class: 'tagmgr__dot tagchip--' + (tag.color || 'accent') }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'setting-row__label', text: tag.name }),
          el('div', { class: 'setting-row__desc', text: `${tag.count} 位好友` }),
        ]),
        el('button', {
          class: 'btn btn--sm', text: '重命名',
          onClick: async () => {
            const v = await prompt('重命名分组', { value: tag.name });
            if (v === null || v === tag.name) return;
            try {
              await api.patch(`/api/friends/tags/${tag.id}`, { name: v });
              toast('已重命名', 'ok');
              await loadTags(); if (onChanged) onChanged(); rebuild();
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
        el('button', {
          class: 'btn btn--sm btn--danger', text: '删除',
          onClick: async () => {
            if (!await confirm(`删除分组「${tag.name}」？好友不会被删除，只是回到未分组。`, { danger: true, okText: '删除' })) return;
            try {
              await api.del(`/api/friends/tags/${tag.id}`);
              toast('分组已删除', 'ok');
              await loadTags(); await loadFriends();
              if (onChanged) onChanged(); rebuild();
              emit('ui:refresh');
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
        swatchRow(tag),
      ]));
    });
    body.appendChild(list);

    const nameInput = el('input', { class: 'input', placeholder: '新分组名称', maxLength: '12' });
    const row = el('div', { class: 'tagmgr__new' }, [
      el('div', { class: 'grow' }, [nameInput]),
      el('button', {
        class: 'btn btn--primary btn--sm', type: 'button', text: '＋ 新建分组',
        onClick: async () => {
          const n = String(nameInput.value || '').trim();
          if (!n) { toast('请填写分组名称', 'err'); return; }
          try {
            const r = await api.post('/api/friends/tags', { name: n });
            toast(`已创建「${r.tag.name}」`, 'ok');
            nameInput.value = '';
            await loadTags(); if (onChanged) onChanged(); rebuild();
          } catch (e) { toast(e.message, 'err'); }
        },
      }),
    ]);
    body.appendChild(el('div', { class: 'side__group-title', style: { padding: '6px 0 8px' } }, [
      el('span', { text: `分组 ${(state.tags || []).length} / ${max}` }),
    ]));
    body.appendChild(row);
  };

  api.get('/api/friends/tags').then((r) => {
    state.tags = r.tags || [];
    max = r.max || 20;
    rebuild();
  }).catch(() => rebuild());

  rebuild();
  modal({
    title: '管理好友分组', body, wide: false,
    footer: [{ text: '完成', kind: 'primary' }],
  });
}

/** 通讯录里的筛选条：全部 / 各分组 / 未分组 + 管理入口。返回 { node, active } */
export function buildFilterBar(currentId, onChange) {
  const bar = el('div', { class: 'filterbar' });
  const map = tagMap();
  const counts = {};
  const untagged = (state.friends || []).filter((f) => !(f.tags || []).length).length;
  (state.tags || []).forEach((t) => {
    counts[t.id] = (state.friends || []).filter((f) => (f.tags || []).includes(t.id)).length;
  });

  const chip = (text, id, extraClass = '') => el('button', {
    class: `filterbar__chip${currentId === id ? ' is-active' : ''}${extraClass ? ' ' + extraClass : ''}`,
    type: 'button', text,
    onClick: () => onChange(id),
  });

  bar.appendChild(chip(`全部 ${(state.friends || []).length}`, ''));
  (state.tags || []).forEach((t) => {
    const c = el('button', {
      class: 'filterbar__chip' + (currentId === t.id ? ' is-active' : ''),
      type: 'button', title: t.count ? `${t.count} 位好友` : '还没有成员',
      onClick: () => onChange(t.id),
    }, [
      el('i', { class: `tagmgr__dot tagchip--${t.color || 'accent'}` }),
      el('span', { text: `${t.name} ${counts[t.id] || 0}` }),
    ]);
    bar.appendChild(c);
  });
  if (untagged || currentId === '__none__') {
    bar.appendChild(chip(`未分组 ${untagged}`, '__none__'));
  }
  bar.appendChild(el('button', {
    class: 'filterbar__manage', type: 'button', title: '管理好友分组',
    html: icon('settings', 15), onClick: () => openTagManager(() => onChange(currentId)),
  }));
  return bar;
}
