'use strict';

// Local MCP server: lets Claude (Claude Code over HTTP, Claude Desktop through
// the stdio bridge) read and edit the unlocked profile's tasks, notes, mind
// maps and boards. Listens on 127.0.0.1 only and requires a bearer token.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { uid } = require('./defaults');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PORT = 47821;
const MAX_BODY = 2 * 1024 * 1024;

// ---------------------------------------------------------------- text <-> note HTML

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Light markdown: "# ", "## ", "### ", "- [ ] ", "- [x] ", "- " lines.
function textToNoteHtml(text) {
  const out = [];
  let list = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^\s*[-*] \[( |x|X)\] (.*)$/.exec(line))) {
      flush();
      out.push(`<div class="${m[1] === ' ' ? 'todo' : 'todo-done'}">${esc(m[2])}</div>`);
    } else if ((m = /^\s*[-*] (.*)$/.exec(line))) list.push(esc(m[1]));
    else if ((m = /^(#{1,3}) (.*)$/.exec(line))) {
      flush();
      out.push(`<h${m[1].length}>${esc(m[2])}</h${m[1].length}>`);
    } else {
      flush();
      out.push(line ? `<div>${esc(line)}</div>` : '<div><br></div>');
    }
  }
  flush();
  return out.join('');
}

function noteHtmlToText(html) {
  return String(html || '')
    .replace(/<div class="todo-done">/g, '\n- [x] ')
    .replace(/<div class="todo">/g, '\n- [ ] ')
    .replace(/<h([1-3])>/g, (_m, n) => '\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<li>/g, '\n- ')
    .replace(/<(div|p|blockquote|pre)>(<br\s*\/?>)?/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- tool definitions

const STATUS = ['todo', 'doing', 'done'];
const s = (type, description, extra = {}) => ({ type, description, ...extra });
const DATE = s('string', 'Срок в формате YYYY-MM-DD, "today"/"tomorrow", или пустая строка чтобы убрать срок');

const TOOLS = [
  {
    name: 'glassboard_overview',
    description:
      'Сводка по рабочему пространству Glassboard: проекты, число задач по статусам, просроченные и сегодняшние задачи, записки, mind map и доски. Начните с этого инструмента.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'list_tasks',
    description: 'Список задач с фильтрами. По умолчанию без выполненных.',
    inputSchema: {
      type: 'object',
      properties: {
        project: s('string', 'ID или название проекта'),
        status: s('string', 'Статус', { enum: STATUS }),
        due: s('string', 'Фильтр по сроку', { enum: ['overdue', 'today', 'upcoming', 'none'] }),
        tag: s('string', 'Тег без #'),
        query: s('string', 'Поиск по названию, описанию и тегам'),
        include_done: s('boolean', 'Включить выполненные задачи'),
      },
    },
    readOnly: true,
  },
  {
    name: 'get_task',
    description: 'Полная информация о задаче, включая подзадачи с их ID.',
    inputSchema: { type: 'object', properties: { id: s('string', 'ID задачи') }, required: ['id'] },
    readOnly: true,
  },
  {
    name: 'create_task',
    description: 'Создать задачу. Подзадачи передаются списком строк.',
    inputSchema: {
      type: 'object',
      properties: {
        title: s('string', 'Название'),
        description: s('string', 'Описание'),
        project: s('string', 'ID или название проекта (по умолчанию «Входящие»). Несуществующий проект будет создан.'),
        status: s('string', 'Статус', { enum: STATUS }),
        priority: s('integer', '0 — нет, 1 — низкий, 2 — средний, 3 — высокий', { minimum: 0, maximum: 3 }),
        due: DATE,
        tags: s('array', 'Теги', { items: { type: 'string' } }),
        subtasks: s('array', 'Подзадачи', { items: { type: 'string' } }),
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'Изменить задачу: поля, статус, добавить подзадачи или отметить их выполненными.',
    inputSchema: {
      type: 'object',
      properties: {
        id: s('string', 'ID задачи'),
        title: s('string', 'Новое название'),
        description: s('string', 'Новое описание'),
        project: s('string', 'ID или название проекта'),
        status: s('string', 'Статус', { enum: STATUS }),
        priority: s('integer', '0–3', { minimum: 0, maximum: 3 }),
        due: DATE,
        tags: s('array', 'Новый список тегов (заменяет старый)', { items: { type: 'string' } }),
        add_subtasks: s('array', 'Добавить подзадачи', { items: { type: 'string' } }),
        complete_subtasks: s('array', 'ID или названия подзадач, которые отметить выполненными', { items: { type: 'string' } }),
        reopen_subtasks: s('array', 'ID или названия подзадач, с которых снять отметку', { items: { type: 'string' } }),
        remove_subtasks: s('array', 'ID или названия подзадач для удаления', { items: { type: 'string' } }),
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Удалить задачу.',
    inputSchema: { type: 'object', properties: { id: s('string', 'ID задачи') }, required: ['id'] },
  },
  {
    name: 'create_project',
    description: 'Создать проект для задач.',
    inputSchema: {
      type: 'object',
      properties: { name: s('string', 'Название'), color: s('string', 'Цвет #RRGGBB') },
      required: ['name'],
    },
  },
  {
    name: 'list_notes',
    description: 'Список записок с текстом.',
    inputSchema: { type: 'object', properties: { query: s('string', 'Поиск') } },
    readOnly: true,
  },
  {
    name: 'create_note',
    description:
      'Создать записку. Текст поддерживает "# ", "## ", "### " заголовки, "- " списки и "- [ ] " / "- [x] " чек-листы. pinned=true показывает её поверх всех окон.',
    inputSchema: {
      type: 'object',
      properties: {
        title: s('string', 'Заголовок'),
        text: s('string', 'Текст записки'),
        color: s('string', 'Цвет #RRGGBB'),
        pinned: s('boolean', 'Закрепить поверх всех окон'),
        show: s('boolean', 'Открыть окно записки на экране (по умолчанию true)'),
      },
      required: ['title'],
    },
  },
  {
    name: 'update_note',
    description: 'Изменить записку: заголовок, текст (заменяет), дописать текст, цвет, закрепление, показать/скрыть.',
    inputSchema: {
      type: 'object',
      properties: {
        id: s('string', 'ID записки'),
        title: s('string', 'Заголовок'),
        text: s('string', 'Новый текст (заменяет старый)'),
        append_text: s('string', 'Дописать в конец'),
        color: s('string', 'Цвет #RRGGBB'),
        pinned: s('boolean', 'Закрепить поверх всех окон'),
        show: s('boolean', 'true — открыть окно, false — убрать с экрана'),
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_note',
    description: 'Удалить записку.',
    inputSchema: { type: 'object', properties: { id: s('string', 'ID записки') }, required: ['id'] },
  },
  {
    name: 'list_mindmaps',
    description: 'Список mind map.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'get_mindmap',
    description: 'Mind map в виде дерева узлов с ID.',
    inputSchema: { type: 'object', properties: { id: s('string', 'ID или название карты') }, required: ['id'] },
    readOnly: true,
  },
  {
    name: 'create_mindmap',
    description: 'Создать mind map из дерева: [{ "text": "...", "children": [...] }].',
    inputSchema: {
      type: 'object',
      properties: {
        name: s('string', 'Центральная тема'),
        branches: s('array', 'Ветки первого уровня', { items: { $ref: '#/$defs/node' } }),
      },
      required: ['name'],
      $defs: {
        node: {
          type: 'object',
          properties: { text: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/node' } } },
          required: ['text'],
        },
      },
    },
  },
  {
    name: 'add_mindmap_nodes',
    description: 'Добавить узлы (с вложенными) в существующую mind map под указанный узел (по умолчанию — к центру).',
    inputSchema: {
      type: 'object',
      properties: {
        map: s('string', 'ID или название карты'),
        parent_id: s('string', 'ID родительского узла'),
        nodes: s('array', 'Узлы', { items: { $ref: '#/$defs/node' } }),
      },
      required: ['map', 'nodes'],
      $defs: {
        node: {
          type: 'object',
          properties: { text: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/node' } } },
          required: ['text'],
        },
      },
    },
  },
  {
    name: 'list_boards',
    description: 'Список досок с содержимым (стикеры, фигуры, тексты, связи).',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'add_board_items',
    description:
      'Добавить объекты на доску. Без координат объекты раскладываются сеткой правее существующих. connections — пары индексов в массиве items, между которыми рисуется стрелка.',
    inputSchema: {
      type: 'object',
      properties: {
        board: s('string', 'ID или название доски (по умолчанию первая; несуществующая будет создана)'),
        items: s('array', 'Объекты', {
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['sticky', 'text', 'rect', 'ellipse', 'frame'] },
              text: { type: 'string' },
              color: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
            },
            required: ['text'],
          },
        }),
        connections: s('array', 'Стрелки [откуда, куда] по индексам items', {
          items: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        }),
      },
      required: ['items'],
    },
  },
];

// ---------------------------------------------------------------- tool implementations

class ToolError extends Error {}

function createTools(ctx) {
  const data = () => {
    const session = ctx.getSession();
    if (!session) throw new ToolError('Glassboard заблокирован. Попросите пользователя разблокировать приложение паролем.');
    return session.data;
  };
  const commit = (key, value) => ctx.setState(key, value);

  const localDate = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const today = () => localDate(0);
  const normDate = (v) => {
    if (v == null || v === '') return null;
    if (v === 'today') return localDate(0);
    if (v === 'tomorrow') return localDate(1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ToolError(`Неверная дата «${v}», нужен формат YYYY-MM-DD`);
    return v;
  };

  function findProject(ref, create) {
    if (!ref) return data().projects.find((p) => p.id === 'inbox');
    const lower = String(ref).toLowerCase();
    const found = data().projects.find((p) => p.id === ref || p.name.toLowerCase() === lower);
    if (found || !create) {
      if (!found) throw new ToolError(`Проект «${ref}» не найден`);
      return found;
    }
    return addProject(ref);
  }

  function addProject(name, color) {
    const colors = ['#0a84ff', '#ff9f0a', '#30d158', '#ff375f', '#bf5af2', '#64d2ff', '#ffd60a'];
    const p = { id: uid(), name: String(name).trim(), color: color || colors[data().projects.length % colors.length], icon: '●' };
    commit('projects', [...data().projects, p]);
    return p;
  }

  const task = (id) => {
    const t = data().tasks.find((x) => x.id === id);
    if (!t) throw new ToolError(`Задача ${id} не найдена`);
    return t;
  };
  const projectName = (id) => (data().projects.find((p) => p.id === id) || {}).name || id;

  const taskSummary = (t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    due: t.due,
    project: projectName(t.projectId),
    tags: t.tags,
    subtasks: t.subtasks.length ? `${t.subtasks.filter((x) => x.done).length}/${t.subtasks.length}` : undefined,
  });

  const matchSub = (sub, refs) => refs.some((r) => r === sub.id || String(r).toLowerCase() === sub.title.toLowerCase());

  function buildNodes(list) {
    return (list || []).map((n) => ({
      id: uid(),
      text: String(n.text || '').slice(0, 300),
      collapsed: false,
      children: buildNodes(n.children),
    }));
  }

  function findMap(ref) {
    const lower = String(ref).toLowerCase();
    const m = data().mindmaps.find((x) => x.id === ref || x.name.toLowerCase() === lower || x.root.text.toLowerCase() === lower);
    if (!m) throw new ToolError(`Mind map «${ref}» не найдена`);
    return m;
  }

  const outline = (n) => ({ id: n.id, text: n.text, done: n.done || undefined, children: n.children.length ? n.children.map(outline) : undefined });

  function patchTask(id, patch) {
    commit('tasks', data().tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    return task(id);
  }

  return {
    glassboard_overview() {
      const d = data();
      const open = d.tasks.filter((t) => t.status !== 'done');
      const t0 = today();
      return {
        projects: d.projects.map((p) => ({ id: p.id, name: p.name, open_tasks: open.filter((t) => t.projectId === p.id).length })),
        tasks: { todo: d.tasks.filter((t) => t.status === 'todo').length, doing: d.tasks.filter((t) => t.status === 'doing').length, done: d.tasks.filter((t) => t.status === 'done').length },
        overdue: open.filter((t) => t.due && t.due < t0).map(taskSummary),
        today: open.filter((t) => t.due === t0).map(taskSummary),
        in_progress: open.filter((t) => t.status === 'doing').map(taskSummary),
        notes: d.notes.map((n) => ({ id: n.id, title: n.title || '(без названия)', pinned: !!n.pinned })),
        mindmaps: d.mindmaps.map((m) => ({ id: m.id, name: m.root.text || m.name })),
        boards: d.boards.map((b) => ({ id: b.id, name: b.name, items: b.items.length })),
        date: t0,
      };
    },

    list_tasks(a) {
      const t0 = today();
      const project = a.project ? findProject(a.project) : null;
      const q = (a.query || '').toLowerCase();
      return data()
        .tasks.filter((t) => {
          if (project && t.projectId !== project.id) return false;
          if (a.status ? t.status !== a.status : !a.include_done && t.status === 'done') return false;
          if (a.tag && !t.tags.includes(a.tag.toLowerCase())) return false;
          if (a.due === 'overdue' && !(t.due && t.due < t0)) return false;
          if (a.due === 'today' && t.due !== t0) return false;
          if (a.due === 'upcoming' && !(t.due && t.due > t0)) return false;
          if (a.due === 'none' && t.due) return false;
          if (q && !(t.title + ' ' + t.description + ' ' + t.tags.join(' ')).toLowerCase().includes(q)) return false;
          return true;
        })
        .sort((x, y) => (x.order || 0) - (y.order || 0))
        .map(taskSummary);
    },

    get_task({ id }) {
      const t = task(id);
      return { ...taskSummary(t), description: t.description, subtasks: t.subtasks, created: new Date(t.createdAt).toISOString() };
    },

    create_task(a) {
      const title = String(a.title || '').trim();
      if (!title) throw new ToolError('Нужно название задачи');
      const p = findProject(a.project, true);
      const t = {
        id: uid(),
        title,
        description: a.description || '',
        status: STATUS.includes(a.status) ? a.status : 'todo',
        priority: Math.max(0, Math.min(3, Number(a.priority) || 0)),
        due: normDate(a.due),
        tags: (a.tags || []).map((x) => String(x).replace(/^#/, '').toLowerCase()).filter(Boolean),
        subtasks: (a.subtasks || []).filter(Boolean).map((x) => ({ id: uid(), title: String(x), done: false })),
        projectId: p.id,
        createdAt: Date.now(),
        order: Math.min(0, ...data().tasks.map((x) => x.order || 0)) - 1,
      };
      commit('tasks', [...data().tasks, t]);
      ctx.notify(`Claude создал задачу «${t.title}»`);
      return { created: taskSummary(t), subtasks: t.subtasks };
    },

    update_task(a) {
      const t = task(a.id);
      const patch = {};
      for (const k of ['title', 'description']) if (typeof a[k] === 'string') patch[k] = a[k];
      if (a.status) {
        if (!STATUS.includes(a.status)) throw new ToolError('Статус: todo, doing или done');
        patch.status = a.status;
      }
      if (a.priority != null) patch.priority = Math.max(0, Math.min(3, Number(a.priority) || 0));
      if (a.due !== undefined) patch.due = normDate(a.due);
      if (a.tags) patch.tags = a.tags.map((x) => String(x).replace(/^#/, '').toLowerCase()).filter(Boolean);
      if (a.project) patch.projectId = findProject(a.project, true).id;
      let subs = t.subtasks;
      if (a.remove_subtasks) subs = subs.filter((x) => !matchSub(x, a.remove_subtasks));
      if (a.complete_subtasks) subs = subs.map((x) => (matchSub(x, a.complete_subtasks) ? { ...x, done: true } : x));
      if (a.reopen_subtasks) subs = subs.map((x) => (matchSub(x, a.reopen_subtasks) ? { ...x, done: false } : x));
      if (a.add_subtasks) subs = [...subs, ...a.add_subtasks.filter(Boolean).map((x) => ({ id: uid(), title: String(x), done: false }))];
      if (subs !== t.subtasks) patch.subtasks = subs;
      const updated = patchTask(t.id, patch);
      ctx.notify(`Claude обновил задачу «${updated.title}»`);
      return { updated: taskSummary(updated), subtasks: updated.subtasks };
    },

    delete_task({ id }) {
      const t = task(id);
      commit('tasks', data().tasks.filter((x) => x.id !== id));
      ctx.notify(`Claude удалил задачу «${t.title}»`);
      return { deleted: id };
    },

    create_project({ name, color }) {
      if (!String(name || '').trim()) throw new ToolError('Нужно название проекта');
      const p = addProject(name, color);
      ctx.notify(`Claude создал проект «${p.name}»`);
      return p;
    },

    list_notes({ query } = {}) {
      const q = (query || '').toLowerCase();
      return data()
        .notes.map((n) => ({ id: n.id, title: n.title, text: noteHtmlToText(n.body), pinned: !!n.pinned, on_screen: !!n.open, color: n.color }))
        .filter((n) => !q || (n.title + ' ' + n.text).toLowerCase().includes(q));
    },

    create_note(a) {
      const settings = data().settings;
      const note = {
        id: uid(),
        title: String(a.title || ''),
        body: textToNoteHtml(a.text || ''),
        color: a.color || settings.noteColor,
        opacity: settings.noteOpacity,
        pinned: !!a.pinned,
        open: false,
        bounds: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      commit('notes', [note, ...data().notes]);
      if (a.show !== false) ctx.openNote(note.id);
      ctx.notify(`Claude создал записку «${note.title}»`);
      return { id: note.id, title: note.title, pinned: note.pinned };
    },

    update_note(a) {
      const n = data().notes.find((x) => x.id === a.id);
      if (!n) throw new ToolError(`Записка ${a.id} не найдена`);
      const patch = { updatedAt: Date.now() };
      if (typeof a.title === 'string') patch.title = a.title;
      if (typeof a.text === 'string') patch.body = textToNoteHtml(a.text);
      if (typeof a.append_text === 'string') patch.body = (patch.body ?? n.body) + textToNoteHtml(a.append_text);
      if (a.color) patch.color = a.color;
      if (typeof a.pinned === 'boolean') patch.pinned = a.pinned;
      commit('notes', data().notes.map((x) => (x.id === n.id ? { ...x, ...patch } : x)));
      if (a.show === true) ctx.openNote(n.id);
      if (a.show === false) ctx.closeNote(n.id);
      ctx.notify(`Claude обновил записку «${patch.title ?? n.title}»`);
      return { id: n.id, updated: Object.keys(patch).filter((k) => k !== 'updatedAt') };
    },

    delete_note({ id }) {
      const n = data().notes.find((x) => x.id === id);
      if (!n) throw new ToolError(`Записка ${id} не найдена`);
      commit('notes', data().notes.filter((x) => x.id !== id));
      ctx.notify(`Claude удалил записку «${n.title}»`);
      return { deleted: id };
    },

    list_mindmaps() {
      const count = (n) => 1 + n.children.reduce((a, c) => a + count(c), 0);
      return data().mindmaps.map((m) => ({ id: m.id, name: m.root.text || m.name, nodes: count(m.root) }));
    },

    get_mindmap({ id }) {
      const m = findMap(id);
      return { id: m.id, name: m.root.text, root: outline(m.root) };
    },

    create_mindmap({ name, branches }) {
      if (!String(name || '').trim()) throw new ToolError('Нужна центральная тема');
      const m = {
        id: uid(),
        name: String(name).trim(),
        viewport: { x: 0, y: 0, zoom: 1 },
        root: { id: uid(), text: String(name).trim(), collapsed: false, children: buildNodes(branches) },
      };
      commit('mindmaps', [...data().mindmaps, m]);
      ctx.notify(`Claude создал mind map «${m.name}»`);
      return { id: m.id, root: outline(m.root) };
    },

    add_mindmap_nodes({ map, parent_id: parentId, nodes }) {
      const m = findMap(map);
      const root = JSON.parse(JSON.stringify(m.root));
      let parent = root;
      if (parentId) {
        const find = (n) => (n.id === parentId ? n : n.children.map(find).find(Boolean));
        parent = find(root);
        if (!parent) throw new ToolError(`Узел ${parentId} не найден`);
      }
      const added = buildNodes(nodes);
      parent.collapsed = false;
      parent.children.push(...added);
      commit('mindmaps', data().mindmaps.map((x) => (x.id === m.id ? { ...x, root } : x)));
      ctx.notify(`Claude дополнил mind map «${root.text}»`);
      return { added: added.map(outline) };
    },

    list_boards() {
      return data().boards.map((b) => ({
        id: b.id,
        name: b.name,
        items: b.items.map((i) => ({ id: i.id, type: i.type, text: i.text || undefined, task_id: i.taskId, x: i.x, y: i.y, w: i.w, h: i.h, color: i.color })),
        connections: b.connectors.map((c) => ({ from: c.from, to: c.to, label: c.label })),
      }));
    },

    add_board_items({ board, items, connections }) {
      if (!Array.isArray(items) || !items.length) throw new ToolError('Передайте хотя бы один объект');
      let b;
      if (board) {
        const lower = String(board).toLowerCase();
        b = data().boards.find((x) => x.id === board || x.name.toLowerCase() === lower);
        if (!b) {
          b = { id: uid(), name: String(board), items: [], connectors: [], viewport: { x: 0, y: 0, zoom: 1 } };
          commit('boards', [...data().boards, b]);
        }
      } else b = data().boards[0];
      if (!b) throw new ToolError('Доска не найдена');

      const SIZE = { sticky: [200, 200], text: [260, 60], rect: [220, 130], ellipse: [180, 140], frame: [640, 420] };
      const COLOR = { sticky: '#ffd60a', text: null, rect: '#7aa2ff', ellipse: '#30d158', frame: null };
      const startX = b.items.length ? Math.max(...b.items.map((i) => i.x + i.w)) + 80 : 0;
      let z = Math.max(0, ...b.items.map((i) => i.z || 0));
      const made = items.map((it, idx) => {
        const type = SIZE[it.type] ? it.type : 'sticky';
        const [w, h] = SIZE[type];
        return {
          id: uid(),
          type,
          text: String(it.text || ''),
          x: Number.isFinite(it.x) ? it.x : startX + (idx % 4) * 240,
          y: Number.isFinite(it.y) ? it.y : Math.floor(idx / 4) * 240,
          w: it.w || w,
          h: it.h || h,
          color: it.color || COLOR[type],
          z: type === 'frame' ? -1 - idx : ++z,
        };
      });
      const connectors = (connections || [])
        .filter(([from, to]) => made[from] && made[to] && from !== to)
        .map(([from, to]) => ({ id: uid(), from: made[from].id, to: made[to].id, color: '#8e8e93' }));
      commit(
        'boards',
        data().boards.map((x) => (x.id === b.id ? { ...x, items: [...x.items, ...made], connectors: [...x.connectors, ...connectors] } : x))
      );
      ctx.notify(`Claude добавил ${made.length} объект(ов) на доску «${b.name}»`);
      return { board: b.id, items: made.map((i) => ({ id: i.id, type: i.type, text: i.text })) };
    },
  };
}

// ---------------------------------------------------------------- JSON-RPC

function createRpc(ctx) {
  const impl = createTools(ctx);

  return async function handle(msg) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
    const isNotification = msg.id === undefined || msg.id === null;

    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params && msg.params.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'glassboard', title: 'Glassboard', version: ctx.version },
          instructions:
            'Glassboard — личное пространство пользователя: задачи (проекты, статусы todo/doing/done, подзадачи), записки на экране, mind map и доски. ' +
            'Начните с glassboard_overview. Изменения сразу видны пользователю в приложении. Не удаляйте данные без явной просьбы.',
        });
      }
      case 'ping':
        return isNotification ? null : reply({});
      case 'tools/list':
        return reply({
          tools: TOOLS.filter((t) => ctx.allowWrite() || t.readOnly).map(({ name, description, inputSchema, readOnly }) => ({
            name,
            description,
            inputSchema,
            annotations: { readOnlyHint: !!readOnly, destructiveHint: /^delete_/.test(name), openWorldHint: false },
          })),
        });
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params || {};
        const def = TOOLS.find((t) => t.name === name);
        if (!def) return fail(-32602, `Unknown tool: ${name}`);
        const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
        try {
          if (!def.readOnly && !ctx.allowWrite()) throw new ToolError('Изменения запрещены в настройках Glassboard (режим «только чтение»).');
          const result = await impl[name](args || {});
          return reply(text(result));
        } catch (err) {
          return reply({ ...text(err instanceof ToolError ? err.message : `Ошибка: ${err.message}`), isError: true });
        }
      }
      default:
        if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  };
}

// ---------------------------------------------------------------- HTTP transport

class McpServer {
  constructor(ctx) {
    this.ctx = ctx;
    this.rpc = createRpc(ctx);
    this.server = null;
    this.port = null;
    this.configFile = path.join(ctx.userData, 'mcp.json');
    this.config = this.readConfig();
  }

  readConfig() {
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
    } catch {
      /* first run */
    }
    return {
      enabled: !!cfg.enabled,
      allowWrite: cfg.allowWrite !== false,
      port: Number(cfg.port) || DEFAULT_PORT,
      token: typeof cfg.token === 'string' && cfg.token.length >= 32 ? cfg.token : crypto.randomBytes(24).toString('hex'),
    };
  }

  saveConfig() {
    // `tools` lets the bridge advertise tools even while the app is closed.
    const tools = TOOLS.map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, readOnly: !!readOnly }));
    const out = { ...this.config, port: this.port || this.config.port, url: this.url(), tools };
    fs.writeFileSync(this.configFile, JSON.stringify(out, null, 2), { mode: 0o600 });
    // Stable copies for the stdio bridge (the app binary may live in a read-only bundle).
    fs.writeFileSync(path.join(this.ctx.userData, 'mcp-bridge.js'), fs.readFileSync(path.join(__dirname, '..', 'mcp', 'bridge.js')));
  }

  url() {
    return `http://127.0.0.1:${this.port || this.config.port}/mcp`;
  }

  status() {
    const bridge = path.join(this.ctx.userData, 'mcp-bridge.js');
    const command = process.env.APPIMAGE || process.execPath;
    return {
      enabled: this.config.enabled,
      allowWrite: this.config.allowWrite,
      running: !!this.server,
      url: this.url(),
      token: this.config.token,
      desktopConfig: {
        mcpServers: {
          glassboard: { command, args: [bridge, this.configFile], env: { ELECTRON_RUN_AS_NODE: '1' } },
        },
      },
      codeCommand: `claude mcp add --transport http glassboard ${this.url()} --header "Authorization: Bearer ${this.config.token}"`,
      error: this.error || null,
    };
  }

  async update(patch) {
    Object.assign(this.config, patch);
    if (this.config.enabled && !this.server) await this.start();
    if (!this.config.enabled && this.server) await this.stop();
    this.saveConfig();
    return this.status();
  }

  async regenerateToken() {
    this.config.token = crypto.randomBytes(24).toString('hex');
    this.saveConfig();
    return this.status();
  }

  async start() {
    this.error = null;
    for (let port = this.config.port; port < this.config.port + 20; port++) {
      try {
        await this.listen(port);
        this.port = port;
        this.saveConfig();
        return;
      } catch (err) {
        if (err.code !== 'EADDRINUSE') {
          this.error = err.message;
          return;
        }
      }
    }
    this.error = 'Нет свободного порта';
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.onRequest(req, res));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      this.server = null;
    });
  }

  authorized(req) {
    const header = req.headers.authorization || '';
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(this.config.token);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  onRequest(req, res) {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    // Block browsers (CSRF / DNS rebinding): only local hosts, no web origins.
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host)) return send(403, { error: 'Forbidden host' });
    if (req.headers.origin && req.headers.origin !== 'null') return send(403, { error: 'Forbidden origin' });
    if (new URL(req.url, 'http://x').pathname !== '/mcp') return send(404, { error: 'Not found' });
    if (!this.authorized(req)) return send(401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    if (req.method === 'DELETE') return send(200, {});
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed' }, { Allow: 'POST' });

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(413, { error: 'Payload too large' });
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const batch = Array.isArray(msg);
      const results = (await Promise.all((batch ? msg : [msg]).map((m) => this.rpc(m)))).filter(Boolean);
      if (!results.length) return send(202);
      send(200, batch ? results : results[0]);
    });
  }
}

module.exports = { McpServer, TOOLS, createRpc, textToNoteHtml, noteHtmlToText, PROTOCOL_VERSIONS };
