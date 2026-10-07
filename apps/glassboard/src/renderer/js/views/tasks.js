'use strict';

// Task structuring: projects, kanban + list layouts, subtasks, priorities,
// due dates, tags, quick-add syntax, and "pin as sticky note".

(function (GB) {
  const { h } = GB;

  const STATUSES = [
    { id: 'todo', label: 'К выполнению', emoji: '○' },
    { id: 'doing', label: 'В работе', emoji: '◐' },
    { id: 'done', label: 'Готово', emoji: '●' },
  ];
  const PRIORITIES = ['Нет', 'Низкий', 'Средний', 'Высокий'];
  const PROJECT_COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#ff375f', '#bf5af2', '#64d2ff', '#ffd60a', '#8e8e93'];

  // "Позвонить Ане !3 #работа @завтра" -> { title, priority, tags, due }
  GB.parseQuickAdd = function parseQuickAdd(text) {
    let priority = 0;
    let due = null;
    const tags = [];
    const words = [];
    for (const w of text.trim().split(/\s+/)) {
      let m;
      if ((m = /^!([0-3])$/.exec(w))) priority = Number(m[1]);
      else if ((m = /^#([\p{L}\p{N}_-]+)$/u.exec(w))) tags.push(m[1].toLowerCase());
      else if (/^@(сегодня|today)$/i.test(w)) due = GB.todayStr(0);
      else if (/^@(завтра|tomorrow)$/i.test(w)) due = GB.todayStr(1);
      else if (/^@(неделя|week)$/i.test(w)) due = GB.todayStr(7);
      else if ((m = /^@(\d{4}-\d{2}-\d{2})$/.exec(w))) due = m[1];
      else if ((m = /^@(\d{1,2})\.(\d{1,2})$/.exec(w))) {
        const y = new Date().getFullYear();
        due = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      } else words.push(w);
    }
    return { title: words.join(' '), priority, tags, due };
  };

  GB.taskOps = {
    create(patch) {
      const tasks = GB.store.get('tasks');
      const task = {
        id: GB.uid(),
        title: 'Новая задача',
        description: '',
        status: 'todo',
        priority: 0,
        due: null,
        tags: [],
        subtasks: [],
        projectId: 'inbox',
        createdAt: Date.now(),
        order: Math.min(0, ...tasks.map((t) => t.order || 0)) - 1,
        ...patch,
      };
      task.id = patch.id || GB.uid();
      task.createdAt = patch.createdAt && patch.id ? patch.createdAt : Date.now();
      GB.store.set('tasks', [...tasks, task]);
      return task;
    },
    patch(id, patch) {
      GB.store.update('tasks', (list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    },
    remove(id) {
      GB.store.update('tasks', (list) => list.filter((t) => t.id !== id));
    },
    pinAsNote(task) {
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      const parts = [];
      if (task.description) parts.push(`<p>${esc(task.description).replace(/\n/g, '<br>')}</p>`);
      for (const s of task.subtasks) parts.push(`<div class="${s.done ? 'todo-done' : 'todo'}">${esc(s.title)}</div>`);
      if (task.due) parts.push(`<p>📅 ${esc(GB.formatDue(task.due).text)}</p>`);
      GB.noteOps.create({ title: task.title, body: parts.join(''), pinned: true, taskId: task.id });
      GB.toast('Задача закреплена на экране');
    },
  };

  const project = (id) => GB.store.get('projects').find((p) => p.id === id);

  GB.views = GB.views || {};
  GB.views.tasks = {
    title: 'Задачи',
    mount(root, shell) {
      let openTaskId = null;
      let dragId = null;
      const ui = () => GB.store.get('ui');
      const setUi = (p) => GB.store.set('ui', { ...ui(), ...p });

      // ---------- toolbar ----------
      const quick = h('input', {
        placeholder: 'Новая задача…   !1-3 приоритет · #тег · @завтра · @25.12',
        onkeydown: (e) => {
          if (e.key !== 'Enter' || !quick.value.trim()) return;
          const parsed = GB.parseQuickAdd(quick.value);
          if (!parsed.title) return;
          const pid = ui().projectId;
          GB.taskOps.create({
            ...parsed,
            projectId: project(pid) ? pid : 'inbox',
            due: parsed.due || (pid === 'today' ? GB.todayStr() : null),
          });
          quick.value = '';
        },
      });
      const search = h('input.input.search', { placeholder: 'Поиск', oninput: () => render() });
      const layoutSeg = h('div.segmented');
      const body = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
      const drawerHost = h('div');

      root.append(
        h('div.toolbar', h('div.quick-add.glass', h('span.faint', '+'), quick), search, layoutSeg),
        body,
        drawerHost
      );

      function renderLayoutSeg() {
        layoutSeg.innerHTML = '';
        for (const [id, label] of [
          ['kanban', 'Канбан'],
          ['list', 'Список'],
        ]) {
          layoutSeg.append(h('button', { class: ui().taskLayout === id ? 'on' : '', onclick: () => setUi({ taskLayout: id }) }, label));
        }
      }

      // ---------- filtering ----------
      function visibleTasks() {
        const pid = ui().projectId;
        const q = search.value.trim().toLowerCase();
        return GB.store
          .get('tasks')
          .filter((t) => {
            if (pid === 'today') {
              if (!t.due || t.due > GB.todayStr()) return false;
            } else if (pid === 'upcoming') {
              if (!t.due) return false;
            } else if (pid !== 'all' && t.projectId !== pid) return false;
            if (!q) return true;
            return (t.title + ' ' + t.description + ' ' + t.tags.join(' ')).toLowerCase().includes(q);
          })
          .sort((a, b) => (a.order || 0) - (b.order || 0));
      }

      function subtitle(tasks) {
        const open = tasks.filter((t) => t.status !== 'done').length;
        const pid = ui().projectId;
        const name =
          pid === 'all' ? 'Все задачи' : pid === 'today' ? 'Сегодня' : pid === 'upcoming' ? 'Со сроком' : project(pid)?.name || '';
        shell.setTitle(name || 'Задачи', `${open} ${GB.plural(open, 'активная', 'активные', 'активных')}`);
      }

      // ---------- card ----------
      function card(t) {
        const done = t.subtasks.filter((s) => s.done).length;
        const due = GB.formatDue(t.due);
        const p = project(t.projectId);
        const el = h(
          'div.card',
          {
            class: t.status === 'done' ? 'done' : '',
            draggable: true,
            dataset: { id: t.id },
            onclick: () => openDrawer(t.id),
            oncontextmenu: (e) => {
              e.preventDefault();
              cardMenu(t, e.clientX, e.clientY);
            },
            ondragstart: (e) => {
              dragId = t.id;
              e.dataTransfer.setData('text/plain', t.id);
              e.dataTransfer.effectAllowed = 'move';
              requestAnimationFrame(() => el.classList.add('dragging'));
            },
            ondragend: () => {
              dragId = null;
              el.classList.remove('dragging');
            },
          },
          h('div.card-title', h('span.prio', { class: `prio-${t.priority}`, title: PRIORITIES[t.priority] }), h('h3', t.title)),
          h(
            'div.meta',
            due ? h('span.chip', { class: due.cls }, '📅 ' + due.text) : null,
            ui().projectId === 'all' || ui().projectId === 'today' || ui().projectId === 'upcoming'
              ? p && h('span.chip', h('span', { style: { color: p.color } }, '●'), p.name)
              : null,
            t.tags.map((tag) => h('span.chip', '#' + tag)),
            t.subtasks.length ? h('span.chip', `☑ ${done}/${t.subtasks.length}`) : null
          ),
          t.subtasks.length ? h('div.progress', h('i', { style: { width: (done / t.subtasks.length) * 100 + '%' } })) : null
        );
        return el;
      }

      function cardMenu(t, x, y) {
        GB.menu(x, y, [
          ...STATUSES.filter((s) => s.id !== t.status).map((s) => ({
            icon: s.emoji,
            label: s.label,
            onClick: () => GB.taskOps.patch(t.id, { status: s.id }),
          })),
          'sep',
          { icon: '📌', label: 'Закрепить как записку', onClick: () => GB.taskOps.pinAsNote(t) },
          {
            icon: '⧉',
            label: 'Дублировать',
            onClick: () =>
              GB.taskOps.create({
                ...GB.clone(t),
                id: undefined,
                title: t.title + ' (копия)',
                subtasks: t.subtasks.map((s) => ({ ...s, id: GB.uid() })),
              }),
          },
          'sep',
          { icon: '🗑', label: 'Удалить', danger: true, onClick: () => GB.taskOps.remove(t.id) },
        ]);
      }

      // ---------- kanban ----------
      function renderKanban(tasks) {
        const wrap = h('div.kanban');
        for (const st of STATUSES) {
          const items = tasks.filter((t) => t.status === st.id);
          const cards = h('div.cards', items.map(card));
          const col = h(
            'div.column.glass',
            {
              ondragover: (e) => {
                if (!dragId) return;
                e.preventDefault();
                col.classList.add('drop');
              },
              ondragleave: (e) => {
                if (!col.contains(e.relatedTarget)) col.classList.remove('drop');
              },
              ondrop: (e) => {
                e.preventDefault();
                col.classList.remove('drop');
                if (!dragId) return;
                // insert before the card under the cursor
                const after = [...cards.querySelectorAll('.card:not(.dragging)')].find((c) => {
                  const r = c.getBoundingClientRect();
                  return e.clientY < r.top + r.height / 2;
                });
                const ordered = items.filter((t) => t.id !== dragId).map((t) => t.id);
                const idx = after ? ordered.indexOf(after.dataset.id) : ordered.length;
                ordered.splice(idx, 0, dragId);
                const orderMap = new Map(ordered.map((id, i) => [id, i]));
                GB.store.update('tasks', (list) =>
                  list.map((t) =>
                    orderMap.has(t.id) ? { ...t, order: orderMap.get(t.id), status: t.id === dragId ? st.id : t.status } : t
                  )
                );
              },
            },
            h(
              'header',
              h('h2', st.label),
              h('span.badge', items.length),
              h('div.spacer'),
              h(
                'button.btn.icon.small.ghost',
                {
                  title: 'Добавить',
                  onclick: () => {
                    const pid = ui().projectId;
                    const t = GB.taskOps.create({
                      status: st.id,
                      projectId: project(pid) ? pid : 'inbox',
                      due: pid === 'today' ? GB.todayStr() : null,
                    });
                    openDrawer(t.id, true);
                  },
                },
                '+'
              )
            ),
            cards
          );
          wrap.append(col);
        }
        return wrap;
      }

      // ---------- list ----------
      function renderList(tasks) {
        const today = GB.todayStr();
        const groups = [
          ['Просрочено', (t) => t.status !== 'done' && t.due && t.due < today],
          ['Сегодня', (t) => t.status !== 'done' && t.due === today],
          ['Предстоящие', (t) => t.status !== 'done' && t.due && t.due > today],
          ['Без срока', (t) => t.status !== 'done' && !t.due],
          ['Выполнено', (t) => t.status === 'done'],
        ];
        const wrap = h('div.list.glass');
        let any = false;
        for (const [name, test] of groups) {
          const items = tasks.filter(test);
          if (!items.length) continue;
          any = true;
          wrap.append(
            h(
              'div.list-group',
              h('h2', name, h('span.faint', { style: { fontSize: '13px', marginLeft: '8px' } }, items.length)),
              items.map((t) => {
                const due = GB.formatDue(t.due);
                return h(
                  'div.list-row',
                  {
                    class: t.status === 'done' ? 'done' : '',
                    onclick: () => openDrawer(t.id),
                    oncontextmenu: (e) => {
                      e.preventDefault();
                      cardMenu(t, e.clientX, e.clientY);
                    },
                  },
                  h(
                    'button.check',
                    {
                      class: t.status === 'done' ? 'on' : '',
                      onclick: (e) => {
                        e.stopPropagation();
                        GB.taskOps.patch(t.id, { status: t.status === 'done' ? 'todo' : 'done' });
                      },
                    },
                    t.status === 'done' ? '✓' : ''
                  ),
                  h('span.prio', { class: `prio-${t.priority}`, style: { marginTop: 0 } }),
                  h('span.t', t.title),
                  t.status === 'doing' ? h('span.chip', '◐ в работе') : null,
                  t.subtasks.length ? h('span.chip', `☑ ${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}`) : null,
                  t.tags.map((tag) => h('span.chip', '#' + tag)),
                  due ? h('span.chip', { class: due.cls }, due.text) : null
                );
              })
            )
          );
        }
        if (!any) wrap.append(h('div.empty', h('div.big', '✨'), h('h2', 'Задач нет'), h('div', 'Добавьте первую в строке сверху')));
        return wrap;
      }

      // ---------- drawer ----------
      function openDrawer(id, focusTitle) {
        openTaskId = id;
        renderDrawer(focusTitle);
      }

      function closeDrawer() {
        openTaskId = null;
        drawerHost.innerHTML = '';
      }

      function renderDrawer(focusTitle) {
        drawerHost.innerHTML = '';
        const t = GB.store.get('tasks').find((x) => x.id === openTaskId);
        if (!t) return closeDrawer();
        const set = (p) => GB.taskOps.patch(t.id, p);

        const title = h('input.title-input', { value: t.title, oninput: () => set({ title: title.value }) });
        const seg = (options, value, onPick) =>
          h(
            'div.segmented',
            options.map(([v, label]) => h('button', { class: v === value ? 'on' : '', onclick: () => onPick(v) }, label))
          );

        const subList = h('div');
        t.subtasks.forEach((s) => {
          const input = h('input', {
            type: 'text',
            value: s.title,
            oninput: () => set({ subtasks: currentSubs().map((x) => (x.id === s.id ? { ...x, title: input.value } : x)) }),
          });
          subList.append(
            h(
              'div.subtask',
              { class: s.done ? 'done' : '' },
              h(
                'button.check',
                {
                  class: s.done ? 'on' : '',
                  onclick: () => set({ subtasks: currentSubs().map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)) }),
                },
                s.done ? '✓' : ''
              ),
              input,
              h('button.x', { onclick: () => set({ subtasks: currentSubs().filter((x) => x.id !== s.id) }) }, '✕')
            )
          );
        });
        const currentSubs = () => GB.store.get('tasks').find((x) => x.id === t.id).subtasks;
        const newSub = h('input.input', {
          placeholder: '+ Подзадача (Enter)',
          onkeydown: (e) => {
            if (e.key === 'Enter' && newSub.value.trim()) {
              set({ subtasks: [...currentSubs(), { id: GB.uid(), title: newSub.value.trim(), done: false }] });
              setTimeout(() => drawerHost.querySelector('.subtask-new')?.focus());
            }
          },
        });
        newSub.classList.add('subtask-new');

        const desc = h('textarea.input', { value: t.description, placeholder: 'Описание, ссылки, детали…', oninput: () => set({ description: desc.value }) });
        const tags = h('input.input', {
          value: t.tags.join(', '),
          placeholder: 'через запятую',
          onchange: () => set({ tags: tags.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) }),
        });
        const due = h('input.input', { type: 'date', value: t.due || '', onchange: () => set({ due: due.value || null }) });
        const proj = h(
          'select.input',
          { onchange: () => set({ projectId: proj.value }) },
          GB.store.get('projects').map((p) => h('option', { value: p.id, selected: p.id === t.projectId }, `${p.icon || '●'} ${p.name}`))
        );

        const drawer = h(
          'div.drawer.glass',
          h(
            'div.row',
            h('span.faint', { style: { fontSize: '12px' } }, new Date(t.createdAt).toLocaleDateString('ru-RU')),
            h('div.spacer'),
            h('button.btn.small', { onclick: () => GB.taskOps.pinAsNote(t), title: 'Показать задачу как записку поверх окон' }, '📌 На экран'),
            h('button.btn.icon.small.ghost', { onclick: closeDrawer }, '✕')
          ),
          title,
          seg(
            STATUSES.map((s) => [s.id, s.label]),
            t.status,
            (v) => set({ status: v })
          ),
          h('div.field', h('label', 'Приоритет'), seg(PRIORITIES.map((p, i) => [i, p]), t.priority, (v) => set({ priority: v }))),
          h('div.field-grid', h('div.field', h('label', 'Срок'), due), h('div.field', h('label', 'Проект'), proj)),
          h('div.field', h('label', 'Теги'), tags),
          h('div.field', h('label', `Подзадачи ${t.subtasks.length ? `· ${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}` : ''}`), subList, newSub),
          h('div.field', h('label', 'Описание'), desc),
          h('div.spacer'),
          h(
            'button.btn.danger',
            {
              onclick: async () => {
                if (await GB.confirm('Удалить задачу?', t.title)) {
                  GB.taskOps.remove(t.id);
                  closeDrawer();
                }
              },
            },
            'Удалить задачу'
          )
        );
        drawerHost.append(drawer);
        if (focusTitle) {
          title.focus();
          title.select();
        }
      }

      // ---------- render ----------
      function render() {
        const tasks = visibleTasks();
        subtitle(tasks);
        renderLayoutSeg();
        body.innerHTML = '';
        body.append(ui().taskLayout === 'list' ? renderList(tasks) : renderKanban(tasks));
      }

      function refreshDrawer() {
        if (!openTaskId) return;
        // keep focus/caret when the change came from the drawer itself
        const active = document.activeElement;
        if (active && drawerHost.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.type !== 'date') return;
        renderDrawer();
      }

      // ---------- sidebar ----------
      function sidebar(el) {
        const pid = ui().projectId;
        const tasks = GB.store.get('tasks');
        const openCount = (fn) => tasks.filter((t) => t.status !== 'done' && fn(t)).length;
        const item = (id, ico, name, count, color) =>
          h(
            'button.nav-item',
            {
              class: pid === id ? 'on' : '',
              onclick: () => {
                setUi({ projectId: id });
                closeDrawer();
              },
              oncontextmenu: color ? (e) => projectMenu(id, e) : null,
              ondragover: color ? (e) => dragId && e.preventDefault() : null,
              ondrop: color
                ? (e) => {
                    e.preventDefault();
                    if (dragId) GB.taskOps.patch(dragId, { projectId: id });
                  }
                : null,
            },
            color ? h('span.dot', { style: { background: color } }) : h('span.ico', ico),
            name,
            count ? h('span.count', count) : null
          );
        el.append(
          h('div.sidebar-section', 'Обзор'),
          item('all', '◎', 'Все задачи', openCount(() => true)),
          item('today', '☀', 'Сегодня', openCount((t) => t.due && t.due <= GB.todayStr())),
          item('upcoming', '📅', 'Со сроком', openCount((t) => !!t.due)),
          h('div.sidebar-section', 'Проекты', h('button', { title: 'Новый проект', onclick: addProject }, '+')),
          ...GB.store.get('projects').map((p) => item(p.id, p.icon, p.name, openCount((t) => t.projectId === p.id), p.color))
        );
      }

      async function addProject() {
        const res = await GB.prompt({ title: 'Новый проект', fields: [{ name: 'name', placeholder: 'Название' }], ok: 'Создать' });
        if (!res || !res.name.trim()) return;
        const projects = GB.store.get('projects');
        const p = { id: GB.uid(), name: res.name.trim(), color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length], icon: '●' };
        GB.store.set('projects', [...projects, p]);
        setUi({ projectId: p.id });
      }

      function projectMenu(id, e) {
        e.preventDefault();
        const p = project(id);
        GB.menu(e.clientX, e.clientY, [
          {
            icon: '✎',
            label: 'Переименовать',
            onClick: async () => {
              const res = await GB.prompt({ title: 'Переименовать проект', fields: [{ name: 'name', value: p.name }], ok: 'Сохранить' });
              if (res && res.name.trim())
                GB.store.update('projects', (list) => list.map((x) => (x.id === id ? { ...x, name: res.name.trim() } : x)));
            },
          },
          h(
            'div.swatches',
            PROJECT_COLORS.map((c) =>
              h('button.swatch', {
                style: { background: c },
                onclick: () => {
                  GB.closeMenus();
                  GB.store.update('projects', (list) => list.map((x) => (x.id === id ? { ...x, color: c } : x)));
                },
              })
            )
          ),
          id === 'inbox'
            ? null
            : {
                icon: '🗑',
                label: 'Удалить проект',
                danger: true,
                onClick: async () => {
                  if (!(await GB.confirm('Удалить проект?', 'Задачи будут перенесены во «Входящие».'))) return;
                  GB.store.update('tasks', (list) => list.map((t) => (t.projectId === id ? { ...t, projectId: 'inbox' } : t)));
                  GB.store.update('projects', (list) => list.filter((x) => x.id !== id));
                  if (ui().projectId === id) setUi({ projectId: 'all' });
                },
              },
        ]);
      }

      const offs = [
        GB.store.on('tasks', () => {
          render();
          refreshDrawer();
          shell.refreshSidebar();
        }),
        GB.store.on('projects', () => {
          render();
          shell.refreshSidebar();
        }),
        GB.store.on('ui', () => {
          render();
          shell.refreshSidebar();
        }),
      ];
      render();

      return {
        sidebar,
        actions(el) {
          el.append(
            h(
              'button.btn.primary',
              {
                onclick: () => {
                  const pid = ui().projectId;
                  const t = GB.taskOps.create({ projectId: project(pid) ? pid : 'inbox', due: pid === 'today' ? GB.todayStr() : null });
                  openDrawer(t.id, true);
                },
              },
              '+ Задача'
            )
          );
        },
        onKey(e) {
          if (e.key === 'Escape' && openTaskId) closeDrawer();
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            quick.focus();
          }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            search.focus();
          }
        },
        destroy() {
          offs.forEach((off) => off());
        },
      };
    },
  };
})(window.GB);
