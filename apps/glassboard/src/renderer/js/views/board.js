'use strict';

// Miro-style infinite whiteboard: stickies, text, shapes, frames, connectors,
// freehand pen, task cards, multi-select, resize, undo/redo, copy/paste.

(function (GB) {
  const { h, svg } = GB;

  const TOOLS = [
    { id: 'select', key: 'v', label: 'Выбор (V)' },
    { id: 'hand', key: 'h', label: 'Рука (H / пробел)' },
    'sep',
    { id: 'sticky', key: 'n', label: 'Стикер (N)' },
    { id: 'text', key: 't', label: 'Текст (T)' },
    { id: 'rect', key: 'r', label: 'Прямоугольник (R)' },
    { id: 'ellipse', key: 'o', label: 'Эллипс (O)' },
    { id: 'frame', key: 'f', label: 'Фрейм (F)' },
    { id: 'connector', key: 'c', label: 'Стрелка (C)' },
    { id: 'pen', key: 'p', label: 'Перо (P)' },
    { id: 'task', key: 'k', label: 'Карточка задачи (K)' },
  ];
  const DEFAULT_SIZE = {
    sticky: [200, 200],
    text: [240, 50],
    rect: [220, 130],
    ellipse: [180, 140],
    frame: [640, 420],
    task: [240, 110],
  };
  const DEFAULT_COLOR = { sticky: '#ffd60a', text: null, rect: '#7aa2ff', ellipse: '#30d158', frame: null, pen: '#0a84ff', connector: '#8e8e93', task: null };
  const EDITABLE = new Set(['sticky', 'text', 'rect', 'ellipse', 'frame', 'task']);

  GB.views = GB.views || {};
  GB.views.board = {
    title: 'Доска',
    mount(root, shell) {
      // ---------- data access ----------
      const ui = () => GB.store.get('ui');
      const boards = () => GB.store.get('boards');
      let boardId = ui().boardId && boards().some((b) => b.id === ui().boardId) ? ui().boardId : null;
      if (!boardId) {
        if (!boards().length) {
          GB.store.set('boards', [{ id: GB.uid(), name: 'Моя доска', items: [], connectors: [], viewport: { x: 0, y: 0, zoom: 1 } }]);
        }
        boardId = boards()[0].id;
      }
      const board = () => boards().find((b) => b.id === boardId);
      let doc = GB.clone({ items: board().items, connectors: board().connectors });
      const history = new GB.History();

      let tool = 'select';
      let color = null; // null = default per tool
      let selection = new Set();
      let selectedConnector = null;
      let connectFrom = null;
      let editingId = null;
      let clipboard = null;

      const commit = (pushHistory = true, before) => {
        if (pushHistory) history.push(before || snapshotBefore || doc);
        snapshotBefore = null;
        GB.store.update('boards', (list) => list.map((b) => (b.id === boardId ? { ...b, items: GB.clone(doc.items), connectors: GB.clone(doc.connectors) } : b)), 'board');
        render();
      };
      let snapshotBefore = null;
      const remember = () => {
        snapshotBefore = GB.clone(doc);
      };

      const itemById = (id) => doc.items.find((i) => i.id === id);
      const maxZ = () => Math.max(0, ...doc.items.map((i) => i.z || 0));
      const minZ = () => Math.min(0, ...doc.items.map((i) => i.z || 0));

      // ---------- DOM ----------
      const world = h('div.world');
      const links = svg('svg', { class: 'links' });
      const defs = svg('defs');
      links.append(defs);
      const itemLayer = h('div');
      const cursorLayer = h('div.cursor-layer');
      world.append(itemLayer, links, cursorLayer);
      const canvas = h('div.canvas', world);
      const marquee = h('div.marquee.hidden');
      canvas.append(marquee);

      const toolbar = h('div.floating-bar.left.glass');
      const topbar = h('div.floating-bar.top.glass');
      const zoomLabel = h('span.zoom-label', { title: 'Сбросить масштаб', onclick: () => vp.zoomAt(...centerClient(), 1) });
      const zoombar = h(
        'div.floating-bar.bottom-right.glass',
        h('button.tool', { title: 'Отменить (Ctrl+Z)', onclick: undo }, GB.icon('undo')),
        h('button.tool', { title: 'Повторить (Ctrl+Shift+Z)', onclick: redo }, GB.icon('redo')),
        h('span.sep'),
        h('button.tool', { title: 'Уменьшить', onclick: () => vp.zoomBy(1 / 1.2) }, '−'),
        zoomLabel,
        h('button.tool', { title: 'Увеличить', onclick: () => vp.zoomBy(1.2) }, '+'),
        h('button.tool', { title: 'Показать всё (Shift+1)', onclick: fitAll }, GB.icon('fit'))
      );
      const hint = h('div.hint.glass.hidden');
      const presence = h('div.floating-bar.top-right.glass.hidden');
      const chatDock = h('div.board-chat.glass.hidden');
      const wrap = h('div.canvas-wrap.glass', canvas, toolbar, topbar, zoombar, hint, presence, chatDock);
      root.append(wrap);

      const centerClient = () => {
        const r = canvas.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      };

      const saveViewport = GB.debounce((v) => {
        GB.store.update('boards', (list) => list.map((b) => (b.id === boardId ? { ...b, viewport: v } : b)), 'board');
      }, 400);
      const vp = new GB.Viewport(canvas, world, {
        state: board().viewport || {},
        onChange: (v) => {
          zoomLabel.textContent = Math.round(v.zoom * 100) + '%';
          cursorLayer.style.setProperty('--inv-zoom', 1 / v.zoom);
          saveViewport(v);
        },
        canPan: () => tool === 'hand',
      });
      zoomLabel.textContent = Math.round(vp.zoom * 100) + '%';
      cursorLayer.style.setProperty('--inv-zoom', 1 / vp.zoom);

      // ---------- co-op: presence, live cursors, chat ----------
      const sharedRoom = () => GB.coop && GB.coop.roomForBoard(boardId);
      const cursors = new Map(); // peer -> { el, timer }
      let chatPanel = null;
      let lastCursorSent = 0;

      function clearCursors() {
        for (const c of cursors.values()) {
          clearTimeout(c.timer);
          c.el.remove();
        }
        cursors.clear();
      }

      function renderPresence() {
        const room = sharedRoom();
        presence.classList.toggle('hidden', !room);
        if (!room) {
          chatDock.classList.add('hidden');
          if (chatPanel) chatPanel.destroy();
          chatPanel = null;
          return;
        }
        const live = GB.coop.live(room.id);
        const me = GB.store.profile || {};
        const unread = GB.coop.unread[room.id] || 0;
        presence.innerHTML = '';
        presence.append(
          h('span.status-dot', { class: live.status, title: live.status }),
          GB.coop.avatar({ name: me.name, color: me.color }, 26),
          ...live.peers.map((p) => GB.coop.avatar(p, 26)),
          h('span.sep'),
          h(
            'button.tool',
            {
              title: 'Чат проекта',
              class: chatPanel ? 'on' : '',
              onclick: () => {
                if (chatPanel) {
                  chatPanel.destroy();
                  chatPanel = null;
                  chatDock.classList.add('hidden');
                } else {
                  chatPanel = GB.coop.chatPanel(room.id);
                  chatDock.innerHTML = '';
                  chatDock.append(h('div.board-chat-head', h('h3', '💬 ' + room.name)), chatPanel.el);
                  chatDock.classList.remove('hidden');
                  chatPanel.focus();
                }
                renderPresence();
              },
            },
            '💬',
            unread && !chatPanel ? h('span.badge-dot.mini', unread) : null
          )
        );
      }

      canvas.addEventListener('pointermove', (e) => {
        const room = sharedRoom();
        if (!room) return;
        const now = performance.now();
        if (now - lastCursorSent < 40) return;
        lastCursorSent = now;
        const p = vp.toWorld(e.clientX, e.clientY);
        window.glass.coop.cursor(room.id, boardId, p.x, p.y);
      });

      const offCursor = window.glass.coop.onCursor((c) => {
        const room = sharedRoom();
        if (!room || c.room !== room.id) return;
        if (c.all) return clearCursors();
        let cur = cursors.get(c.peer);
        if (c.gone || c.boardId !== boardId) {
          if (cur) {
            cur.el.remove();
            cursors.delete(c.peer);
          }
          return;
        }
        if (!cur) {
          const el = h('div.remote-cursor', { style: { '--c': c.color } });
          el.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l16 9-7 2-3 7z" fill="currentColor" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>';
          el.append(h('span.remote-name', c.name));
          cursorLayer.append(el);
          cur = { el, timer: null };
          cursors.set(c.peer, cur);
        }
        cur.el.style.color = c.color;
        cur.el.querySelector('.remote-name').style.background = c.color;
        cur.el.style.transform = `translate(${c.x}px, ${c.y}px) scale(var(--inv-zoom, 1))`;
        cur.el.classList.remove('idle');
        clearTimeout(cur.timer);
        cur.timer = setTimeout(() => cur.el.classList.add('idle'), 8000);
      });

      // ---------- toolbars ----------
      function renderToolbar() {
        toolbar.innerHTML = '';
        for (const t of TOOLS) {
          if (t === 'sep') {
            toolbar.append(h('span.sep'));
            continue;
          }
          toolbar.append(h('button.tool', { class: tool === t.id ? 'on' : '', title: t.label, onclick: () => setTool(t.id) }, GB.icon(t.id === 'select' ? 'select' : t.id)));
        }
      }

      function renderTopbar() {
        topbar.innerHTML = '';
        const target = selection.size ? [...selection].map(itemById).filter(Boolean) : null;
        const active = target && target.length ? target[0].color : color;
        topbar.append(
          ...GB.PALETTE.map((c) =>
            h('button.swatch', {
              title: c,
              style: { background: c, outline: active === c ? '2px solid var(--accent)' : 'none', outlineOffset: '2px' },
              onclick: () => applyColor(c),
            })
          ),
          h('input', { type: 'color', value: active || '#0a84ff', title: 'Свой цвет', style: { width: '24px', height: '24px' }, onchange: (e) => applyColor(e.target.value) })
        );
        if (selection.size) {
          topbar.append(
            h('span.sep'),
            h('button.tool', { title: 'На передний план', onclick: () => reorder(true) }, '⇡'),
            h('button.tool', { title: 'На задний план', onclick: () => reorder(false) }, '⇣'),
            h('button.tool', { title: 'Дублировать (Ctrl+D)', onclick: duplicate }, '⧉'),
            h('button.tool', { title: 'Удалить (Del)', onclick: removeSelection }, '🗑')
          );
        }
      }

      function setTool(id) {
        tool = id;
        connectFrom = null;
        canvas.classList.toggle('hand', id === 'hand');
        canvas.classList.toggle('crosshair', !['select', 'hand'].includes(id));
        const hints = {
          connector: 'Нажмите на первый объект, затем на второй',
          pen: 'Рисуйте с зажатой кнопкой мыши',
          select: null,
          hand: null,
        };
        const text = id in hints ? hints[id] : 'Нажмите на холст, чтобы добавить';
        hint.classList.toggle('hidden', !text);
        hint.textContent = text || '';
        renderToolbar();
        render();
      }

      function applyColor(c) {
        if (selection.size) {
          remember();
          for (const id of selection) {
            const it = itemById(id);
            if (it) it.color = c;
          }
          commit();
        } else if (selectedConnector) {
          remember();
          const cn = doc.connectors.find((x) => x.id === selectedConnector);
          if (cn) cn.color = c;
          commit();
        } else {
          color = c;
          renderTopbar();
        }
      }

      // ---------- rendering ----------
      function textColorFor(it) {
        if (it.type === 'sticky') return GB.isLightColor(it.color || '#ffd60a') ? 'rgba(0,0,0,.82)' : '#fff';
        if (it.type === 'text') return it.color || 'var(--fg)';
        return 'var(--fg)';
      }

      function renderItem(it) {
        const el = h('div.item', {
          class: [it.type, selection.has(it.id) ? 'selected' : '', connectFrom === it.id ? 'connect-source' : ''].join(' '),
          dataset: { id: it.id },
          style: {
            left: it.x + 'px',
            top: it.y + 'px',
            width: it.w + 'px',
            height: it.h + 'px',
            zIndex: (it.type === 'frame' ? 0 : 1000) + (it.z || 0),
          },
        });
        const c = it.color;
        if (it.type === 'sticky') {
          el.style.background = `linear-gradient(165deg, ${GB.rgba(c || '#ffd60a', 1)}, ${GB.rgba(c || '#ffd60a', 0.86)})`;
        } else if (it.type === 'rect' || it.type === 'ellipse') {
          el.style.color = c;
          el.style.background = GB.rgba(c, 0.16);
        } else if (it.type === 'frame' && c) {
          el.style.background = GB.rgba(c, 0.12);
          el.style.borderColor = GB.rgba(c, 0.5);
        }

        if (it.type === 'path') {
          const s = svg('svg', { viewBox: `0 0 ${it.w} ${it.h}`, width: '100%', height: '100%', style: 'overflow:visible' });
          s.append(
            svg('path', {
              d: it.points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' '),
              fill: 'none',
              stroke: c || '#0a84ff',
              'stroke-width': it.stroke || 3,
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
            })
          );
          el.append(s);
        } else if (it.type === 'frame') {
          el.append(h('div.frame-title', it.text || 'Фрейм'));
        } else if (it.type === 'task') {
          const t = GB.store.get('tasks').find((x) => x.id === it.taskId);
          if (t) {
            const done = t.subtasks.filter((s) => s.done).length;
            const status = { todo: '○ К выполнению', doing: '◐ В работе', done: '● Готово' }[t.status];
            el.style.borderLeft = `4px solid ${c || 'var(--accent)'}`;
            el.append(
              h('div.row', h('span.chip', status), t.due ? h('span.chip', { class: GB.formatDue(t.due).cls }, GB.formatDue(t.due).text) : null),
              h('h3', { style: { textDecoration: t.status === 'done' ? 'line-through' : '' } }, t.title)
            );
            if (t.subtasks.length) {
              el.append(h('div.progress', { style: { width: '100%' } }, h('i', { style: { width: (done / t.subtasks.length) * 100 + '%' } })));
            }
          } else {
            el.append(h('div.muted', 'Задача удалена'));
          }
        } else {
          el.append(h('div.content', { style: { color: textColorFor(it), width: '100%' } }, it.text || ''));
        }
        if (selection.size === 1 && selection.has(it.id)) el.append(h('div.handle'));
        return el;
      }

      function anchor(a, b) {
        // point on the border of box a, on the line from a's centre to b's centre
        const ax = a.x + a.w / 2;
        const ay = a.y + a.h / 2;
        const dx = b.x + b.w / 2 - ax;
        const dy = b.y + b.h / 2 - ay;
        if (!dx && !dy) return [ax, ay];
        const sx = dx ? a.w / 2 / Math.abs(dx) : Infinity;
        const sy = dy ? a.h / 2 / Math.abs(dy) : Infinity;
        let s = Math.min(sx, sy);
        if (a.type === 'ellipse') s = 1 / Math.sqrt((dx / (a.w / 2)) ** 2 + (dy / (a.h / 2)) ** 2);
        return [ax + dx * s, ay + dy * s];
      }

      function renderLinks() {
        for (const n of [...links.childNodes]) if (n !== defs) n.remove();
        defs.innerHTML = '';
        for (const cn of doc.connectors) {
          const a = itemById(cn.from);
          const b = itemById(cn.to);
          if (!a || !b) continue;
          const [x1, y1] = anchor(a, b);
          const [x2, y2] = anchor(b, a);
          const col = cn.color || '#8e8e93';
          const markerId = 'arrow-' + cn.id;
          const marker = svg('marker', { id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
          marker.append(svg('path', { d: 'M0 0 L10 5 L0 10 z', fill: col }));
          defs.append(marker);
          const d = `M${x1} ${y1} L${x2} ${y2}`;
          const selected = selectedConnector === cn.id;
          links.append(
            svg('path', { d, stroke: selected ? 'var(--accent)' : col, 'stroke-width': selected ? 3.5 : 2.5, fill: 'none', 'marker-end': `url(#${markerId})`, 'stroke-linecap': 'round' }),
            Object.assign(svg('path', { d, stroke: 'transparent', 'stroke-width': 14, fill: 'none', class: 'hit', 'data-connector': cn.id }))
          );
          if (cn.label) {
            const t = svg('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': 13 });
            t.textContent = cn.label;
            links.append(t);
          }
        }
      }

      function render() {
        if (editingId) return; // don't clobber an active editor
        itemLayer.innerHTML = '';
        for (const it of doc.items) itemLayer.append(renderItem(it));
        renderLinks();
        renderTopbar();
        shell.setSub(`${board().name} · ${doc.items.length} ${GB.plural(doc.items.length, 'объект', 'объекта', 'объектов')}`);
      }

      // ---------- item creation ----------
      function createAt(type, x, y) {
        const [w, hgt] = DEFAULT_SIZE[type];
        remember();
        const it = { id: GB.uid(), type, x: Math.round(x - w / 2), y: Math.round(y - hgt / 2), w, h: hgt, text: '', color: color || DEFAULT_COLOR[type], z: type === 'frame' ? minZ() - 1 : maxZ() + 1 };
        if (type === 'frame') it.text = 'Фрейм';
        if (type === 'task') {
          const task = GB.taskOps.create({ title: 'Новая задача' });
          it.taskId = task.id;
        }
        doc.items.push(it);
        selection = new Set([it.id]);
        commit();
        setTool('select');
        if (EDITABLE.has(type)) startEdit(it.id);
        return it;
      }

      // ---------- editing ----------
      function startEdit(id) {
        const it = itemById(id);
        if (!it || !EDITABLE.has(it.type)) return;
        const el = itemLayer.querySelector(`[data-id="${id}"]`);
        if (!el) return;
        let target;
        if (it.type === 'frame') target = el.querySelector('.frame-title');
        else if (it.type === 'task') {
          target = el.querySelector('h3');
          if (!target) return;
        } else target = el.querySelector('.content');
        editingId = id;
        target.contentEditable = 'plaintext-only';
        target.classList.add('editor');
        target.focus();
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const finish = () => {
          target.removeEventListener('blur', finish);
          editingId = null;
          const text = target.innerText.replace(/\n$/, '');
          if (it.type === 'task') {
            if (text.trim()) GB.taskOps.patch(it.taskId, { title: text.trim() });
            render();
            return;
          }
          if (text !== it.text) {
            remember();
            it.text = text;
            // grow text boxes to fit their content
            if (it.type === 'text' || it.type === 'sticky') {
              const need = target.scrollHeight + (it.type === 'sticky' ? 32 : 12);
              if (need > it.h) it.h = Math.ceil(need);
            }
            commit();
          } else render();
        };
        target.addEventListener('blur', finish);
        target.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey || it.type === 'frame' || it.type === 'task'))) {
            e.preventDefault();
            target.blur();
          }
        });
      }

      // ---------- selection ops ----------
      function removeSelection() {
        if (!selection.size && !selectedConnector) return;
        remember();
        if (selectedConnector) doc.connectors = doc.connectors.filter((c) => c.id !== selectedConnector);
        doc.items = doc.items.filter((i) => !selection.has(i.id));
        doc.connectors = doc.connectors.filter((c) => itemById(c.from) && itemById(c.to));
        selection.clear();
        selectedConnector = null;
        commit();
      }

      function cloneItems(items, offset) {
        const idMap = new Map();
        const out = items.map((it) => {
          const copy = { ...GB.clone(it), id: GB.uid(), x: it.x + offset, y: it.y + offset, z: maxZ() + 1 };
          idMap.set(it.id, copy.id);
          return copy;
        });
        return { out, idMap };
      }

      function duplicate() {
        if (!selection.size) return;
        remember();
        const sel = doc.items.filter((i) => selection.has(i.id));
        const { out, idMap } = cloneItems(sel, 24);
        doc.items.push(...out);
        for (const c of doc.connectors.filter((c) => idMap.has(c.from) && idMap.has(c.to))) {
          doc.connectors.push({ ...c, id: GB.uid(), from: idMap.get(c.from), to: idMap.get(c.to) });
        }
        selection = new Set(out.map((i) => i.id));
        commit();
      }

      function copy() {
        const items = doc.items.filter((i) => selection.has(i.id));
        if (!items.length) return;
        const ids = new Set(items.map((i) => i.id));
        clipboard = { items: GB.clone(items), connectors: GB.clone(doc.connectors.filter((c) => ids.has(c.from) && ids.has(c.to))) };
      }

      function paste() {
        if (!clipboard) return;
        remember();
        const center = vp.center();
        const minX = Math.min(...clipboard.items.map((i) => i.x));
        const minY = Math.min(...clipboard.items.map((i) => i.y));
        const { out, idMap } = cloneItems(clipboard.items, 0);
        for (const it of out) {
          it.x = Math.round(center.x + (it.x - minX) - 60);
          it.y = Math.round(center.y + (it.y - minY) - 60);
        }
        doc.items.push(...out);
        for (const c of clipboard.connectors) doc.connectors.push({ ...c, id: GB.uid(), from: idMap.get(c.from), to: idMap.get(c.to) });
        selection = new Set(out.map((i) => i.id));
        commit();
      }

      function reorder(front) {
        remember();
        for (const id of selection) {
          const it = itemById(id);
          if (it) it.z = front ? maxZ() + 1 : minZ() - 1;
        }
        commit();
      }

      function undo() {
        const prev = history.undo(doc);
        if (!prev) return;
        doc = prev;
        selection = new Set([...selection].filter(itemById));
        commit(false);
      }

      function redo() {
        const next = history.redo(doc);
        if (!next) return;
        doc = next;
        selection = new Set([...selection].filter(itemById));
        commit(false);
      }

      function bounds(items) {
        if (!items.length) return null;
        const x = Math.min(...items.map((i) => i.x));
        const y = Math.min(...items.map((i) => i.y));
        return { x, y, w: Math.max(...items.map((i) => i.x + i.w)) - x, h: Math.max(...items.map((i) => i.y + i.h)) - y };
      }

      function fitAll() {
        const b = bounds(doc.items);
        if (b) vp.fit(b);
        else {
          vp.x = canvas.clientWidth / 2;
          vp.y = canvas.clientHeight / 2;
          vp.zoom = 1;
          vp.apply(true);
        }
      }

      // ---------- pointer interactions ----------
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        GB.closeMenus();
        if (editingId) return;
        // keep focus where we put it (new items start in edit mode)
        e.preventDefault();
        const p = vp.toWorld(e.clientX, e.clientY);
        const itemEl = e.target.closest('.item');
        const connEl = e.target.closest('[data-connector]');
        const item = itemEl && itemById(itemEl.dataset.id);

        if (['sticky', 'text', 'rect', 'ellipse', 'frame', 'task'].includes(tool)) {
          createAt(tool, p.x, p.y);
          return;
        }

        if (tool === 'connector') {
          if (!item) return;
          if (!connectFrom) {
            connectFrom = item.id;
            hint.textContent = 'Теперь выберите второй объект';
            render();
          } else if (connectFrom !== item.id) {
            remember();
            doc.connectors.push({ id: GB.uid(), from: connectFrom, to: item.id, color: color || DEFAULT_COLOR.connector });
            connectFrom = null;
            commit();
            setTool('select');
          }
          return;
        }

        if (tool === 'pen') {
          startPen(e, p);
          return;
        }

        if (tool !== 'select') return;

        if (connEl && !item) {
          selection.clear();
          selectedConnector = connEl.dataset.connector;
          render();
          return;
        }
        selectedConnector = null;

        if (e.target.classList.contains('handle') && item) {
          startResize(e, item);
          return;
        }

        if (item) {
          if (e.shiftKey) {
            if (selection.has(item.id)) selection.delete(item.id);
            else selection.add(item.id);
            render();
            return;
          }
          if (!selection.has(item.id)) selection = new Set([item.id]);
          render();
          startMove(e, p);
          return;
        }

        if (!e.shiftKey) selection.clear();
        render();
        startMarquee(e, p);
      });

      canvas.addEventListener('dblclick', (e) => {
        const itemEl = e.target.closest('.item');
        if (itemEl) {
          const it = itemById(itemEl.dataset.id);
          if (it && it.type === 'task' && e.altKey) {
            GB.shell.go('tasks');
            return;
          }
          startEdit(itemEl.dataset.id);
          return;
        }
        const connEl = e.target.closest('[data-connector]');
        if (connEl) {
          editConnectorLabel(connEl.dataset.connector);
          return;
        }
        if (tool === 'select') {
          const p = vp.toWorld(e.clientX, e.clientY);
          createAt('sticky', p.x, p.y);
        }
      });

      async function editConnectorLabel(id) {
        const cn = doc.connectors.find((c) => c.id === id);
        if (!cn) return;
        const res = await GB.prompt({ title: 'Подпись стрелки', fields: [{ name: 'label', value: cn.label || '' }], ok: 'Сохранить' });
        if (res === null) return;
        remember();
        cn.label = res.label.trim();
        commit();
      }

      function drag(e, onMove, onUp) {
        canvas.setPointerCapture(e.pointerId);
        const move = (ev) => onMove(ev);
        const up = (ev) => {
          canvas.removeEventListener('pointermove', move);
          canvas.removeEventListener('pointerup', up);
          canvas.removeEventListener('pointercancel', up);
          onUp(ev);
        };
        canvas.addEventListener('pointermove', move);
        canvas.addEventListener('pointerup', up);
        canvas.addEventListener('pointercancel', up);
      }

      function startMove(e, start) {
        const before = GB.clone(doc);
        const moving = new Set(selection);
        // frames carry the objects inside them, like in Miro
        for (const id of selection) {
          const f = itemById(id);
          if (f && f.type === 'frame') {
            for (const it of doc.items) {
              const cx = it.x + it.w / 2;
              const cy = it.y + it.h / 2;
              if (it.id !== f.id && cx > f.x && cx < f.x + f.w && cy > f.y && cy < f.y + f.h) moving.add(it.id);
            }
          }
        }
        const origin = new Map([...moving].map((id) => [id, { x: itemById(id).x, y: itemById(id).y }]));
        let moved = false;
        drag(
          e,
          (ev) => {
            const p = vp.toWorld(ev.clientX, ev.clientY);
            const dx = p.x - start.x;
            const dy = p.y - start.y;
            if (!moved && Math.hypot(dx, dy) < 3 / vp.zoom) return;
            moved = true;
            for (const [id, o] of origin) {
              const it = itemById(id);
              it.x = Math.round(o.x + dx);
              it.y = Math.round(o.y + dy);
              const el = itemLayer.querySelector(`[data-id="${id}"]`);
              if (el) {
                el.style.left = it.x + 'px';
                el.style.top = it.y + 'px';
              }
            }
            renderLinks();
          },
          () => {
            if (moved) commit(true, before);
          }
        );
      }

      function startResize(e, it) {
        const before = GB.clone(doc);
        const start = vp.toWorld(e.clientX, e.clientY);
        const ow = it.w;
        const oh = it.h;
        const el = itemLayer.querySelector(`[data-id="${it.id}"]`);
        drag(
          e,
          (ev) => {
            const p = vp.toWorld(ev.clientX, ev.clientY);
            it.w = Math.max(40, Math.round(ow + p.x - start.x));
            it.h = Math.max(30, Math.round(oh + p.y - start.y));
            if (ev.shiftKey) it.h = Math.round((it.w * oh) / ow);
            el.style.width = it.w + 'px';
            el.style.height = it.h + 'px';
            if (it.type === 'path') el.querySelector('svg').setAttribute('preserveAspectRatio', 'none');
            renderLinks();
          },
          () => {
            if (it.type === 'path') {
              // rescale the stroke points to the new box
              const sx = it.w / ow;
              const sy = it.h / oh;
              it.points = it.points.map(([x, y]) => [x * sx, y * sy]);
            }
            commit(true, before);
          }
        );
      }

      function startMarquee(e, start) {
        const base = new Set(selection);
        const rect = canvas.getBoundingClientRect();
        drag(
          e,
          (ev) => {
            const p = vp.toWorld(ev.clientX, ev.clientY);
            const x = Math.min(p.x, start.x);
            const y = Math.min(p.y, start.y);
            const w = Math.abs(p.x - start.x);
            const hh = Math.abs(p.y - start.y);
            marquee.classList.remove('hidden');
            Object.assign(marquee.style, {
              left: Math.min(ev.clientX, e.clientX) - rect.left + 'px',
              top: Math.min(ev.clientY, e.clientY) - rect.top + 'px',
              width: Math.abs(ev.clientX - e.clientX) + 'px',
              height: Math.abs(ev.clientY - e.clientY) + 'px',
            });
            selection = new Set(base);
            for (const it of doc.items) {
              if (it.x >= x && it.y >= y && it.x + it.w <= x + w && it.y + it.h <= y + hh) selection.add(it.id);
            }
            for (const el of itemLayer.children) el.classList.toggle('selected', selection.has(el.dataset.id));
          },
          () => {
            marquee.classList.add('hidden');
            render();
          }
        );
      }

      function startPen(e, start) {
        const pts = [[start.x, start.y]];
        const live = svg('path', { fill: 'none', stroke: color || DEFAULT_COLOR.pen, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
        links.append(live);
        drag(
          e,
          (ev) => {
            const p = vp.toWorld(ev.clientX, ev.clientY);
            const last = pts[pts.length - 1];
            if (Math.hypot(p.x - last[0], p.y - last[1]) < 1.5 / vp.zoom) return;
            pts.push([p.x, p.y]);
            live.setAttribute('d', pts.map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join(' '));
          },
          () => {
            live.remove();
            if (pts.length < 2) return;
            const b = bounds(pts.map(([x, y]) => ({ x, y, w: 0, h: 0 })));
            const pad = 4;
            remember();
            doc.items.push({
              id: GB.uid(),
              type: 'path',
              x: Math.round(b.x - pad),
              y: Math.round(b.y - pad),
              w: Math.max(8, Math.round(b.w + pad * 2)),
              h: Math.max(8, Math.round(b.h + pad * 2)),
              points: pts.map(([x, y]) => [x - b.x + pad, y - b.y + pad]),
              color: color || DEFAULT_COLOR.pen,
              stroke: 3,
              z: maxZ() + 1,
            });
            commit();
          }
        );
      }

      // ---------- context menu ----------
      canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const itemEl = e.target.closest('.item');
        const p = vp.toWorld(e.clientX, e.clientY);
        if (!itemEl) {
          GB.menu(e.clientX, e.clientY, [
            { icon: '🟨', label: 'Стикер', onClick: () => createAt('sticky', p.x, p.y) },
            { icon: 'T', label: 'Текст', onClick: () => createAt('text', p.x, p.y) },
            { icon: '▢', label: 'Фрейм', onClick: () => createAt('frame', p.x, p.y) },
            { icon: '☑', label: 'Карточка задачи', onClick: () => createAt('task', p.x, p.y) },
            clipboard ? { icon: '📋', label: 'Вставить', onClick: paste } : null,
            'sep',
            { icon: '⤢', label: 'Показать всё', onClick: fitAll },
          ]);
          return;
        }
        const it = itemById(itemEl.dataset.id);
        if (!selection.has(it.id)) {
          selection = new Set([it.id]);
          render();
        }
        GB.menu(e.clientX, e.clientY, [
          EDITABLE.has(it.type) ? { icon: '✎', label: 'Редактировать', onClick: () => startEdit(it.id) } : null,
          it.type === 'sticky' || it.type === 'rect' || it.type === 'ellipse' || it.type === 'text'
            ? {
                icon: '☑',
                label: 'Превратить в задачу',
                onClick: () => {
                  const title = (it.text || '').split('\n')[0].trim() || 'Задача с доски';
                  const description = (it.text || '').split('\n').slice(1).join('\n').trim();
                  const task = GB.taskOps.create({ title, description });
                  remember();
                  Object.assign(it, { type: 'task', taskId: task.id, w: 240, h: 110, text: '' });
                  commit();
                  GB.toast('Задача создана во «Входящих»');
                },
              }
            : null,
          it.type === 'sticky'
            ? {
                icon: '📌',
                label: 'Вынести на экран как записку',
                onClick: () => GB.noteOps.create({ title: '', body: (it.text || '').split('\n').map((l) => `<div>${l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]) || '<br>'}</div>`).join(''), color: it.color, pinned: true }),
              }
            : null,
          it.type === 'task' ? { icon: '↗', label: 'Открыть в задачах', onClick: () => GB.shell.go('tasks') } : null,
          'sep',
          { icon: '⇡', label: 'На передний план', onClick: () => reorder(true) },
          { icon: '⇣', label: 'На задний план', onClick: () => reorder(false) },
          { icon: '⧉', label: 'Дублировать', onClick: duplicate },
          { icon: '⎘', label: 'Копировать', onClick: copy },
          'sep',
          { icon: '🗑', label: 'Удалить', danger: true, onClick: removeSelection },
        ]);
      });

      // ---------- sidebar: list of boards ----------
      function sidebar(el) {
        el.append(
          h('div.sidebar-section', 'Доски', h('button', { title: 'Новая доска', onclick: addBoard }, '+')),
          ...boards().map((b) =>
            h(
              'button.nav-item',
              {
                class: b.id === boardId ? 'on' : '',
                onclick: () => switchBoard(b.id),
                oncontextmenu: (e) => {
                  e.preventDefault();
                  GB.menu(e.clientX, e.clientY, [
                    {
                      icon: '✎',
                      label: 'Переименовать',
                      onClick: async () => {
                        const res = await GB.prompt({ title: 'Переименовать доску', fields: [{ name: 'name', value: b.name }], ok: 'Сохранить' });
                        if (res && res.name.trim()) {
                          GB.store.update('boards', (list) => list.map((x) => (x.id === b.id ? { ...x, name: res.name.trim() } : x)), 'board');
                          shell.refreshSidebar();
                          render();
                        }
                      },
                    },
                    boards().length > 1
                      ? {
                          icon: '🗑',
                          label: 'Удалить доску',
                          danger: true,
                          onClick: async () => {
                            if (!(await GB.confirm('Удалить доску?', b.name))) return;
                            GB.store.update('boards', (list) => list.filter((x) => x.id !== b.id), 'board');
                            if (b.id === boardId) switchBoard(boards()[0].id);
                            else shell.refreshSidebar();
                          },
                        }
                      : null,
                  ]);
                },
              },
              h('span.ico', b.shared ? '👥' : '▦'),
              b.name,
              h('span.count', b.items.length || '')
            )
          )
        );
      }

      async function addBoard() {
        const res = await GB.prompt({ title: 'Новая доска', fields: [{ name: 'name', placeholder: 'Название' }], ok: 'Создать' });
        if (!res || !res.name.trim()) return;
        const b = { id: GB.uid(), name: res.name.trim(), items: [], connectors: [], viewport: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, zoom: 1 } };
        GB.store.update('boards', (list) => [...list, b], 'board');
        switchBoard(b.id);
      }

      function switchBoard(id) {
        boardId = id;
        GB.store.set('ui', { ...ui(), boardId: id });
        doc = GB.clone({ items: board().items, connectors: board().connectors });
        history.clear();
        selection.clear();
        const v = board().viewport || { x: 0, y: 0, zoom: 1 };
        vp.x = v.x;
        vp.y = v.y;
        vp.zoom = v.zoom;
        vp.apply();
        zoomLabel.textContent = Math.round(vp.zoom * 100) + '%';
        cursorLayer.style.setProperty('--inv-zoom', 1 / vp.zoom);
        clearCursors();
        if (chatPanel) chatPanel.destroy();
        chatPanel = null;
        chatDock.classList.add('hidden');
        renderPresence();
        render();
        shell.refreshSidebar();
      }

      // ---------- keyboard ----------
      function onKey(e) {
        if (GB.isTyping(e) || editingId) return;
        const mod = e.metaKey || e.ctrlKey;
        const k = e.key.toLowerCase();
        if (mod && k === 'z') {
          e.preventDefault();
          e.shiftKey ? redo() : undo();
        } else if (mod && k === 'y') {
          e.preventDefault();
          redo();
        } else if (mod && k === 'd') {
          e.preventDefault();
          duplicate();
        } else if (mod && k === 'c') copy();
        else if (mod && k === 'v') paste();
        else if (mod && k === 'a') {
          e.preventDefault();
          selection = new Set(doc.items.map((i) => i.id));
          render();
        } else if (e.key === 'Delete' || e.key === 'Backspace') removeSelection();
        else if (e.key === 'Escape') {
          selection.clear();
          selectedConnector = null;
          setTool('select');
        } else if (e.key === 'Enter' && selection.size === 1) {
          e.preventDefault();
          startEdit([...selection][0]);
        } else if (e.key.startsWith('Arrow') && selection.size) {
          e.preventDefault();
          const step = e.shiftKey ? 20 : 2;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          remember();
          for (const id of selection) {
            const it = itemById(id);
            it.x += dx;
            it.y += dy;
          }
          commit();
        } else if (e.shiftKey && e.code === 'Digit1') fitAll();
        else if (!mod && (k === '=' || k === '+')) vp.zoomBy(1.2);
        else if (!mod && k === '-') vp.zoomBy(1 / 1.2);
        else if (!mod && !e.altKey) {
          const t = TOOLS.find((x) => x !== 'sep' && x.key === k);
          if (t) setTool(t.id);
        }
      }

      // live-update task cards when tasks change elsewhere
      const offs = [
        GB.store.on('tasks', () => doc.items.some((i) => i.type === 'task') && render()),
        GB.store.on('boards', (_v, source) => {
          if (source === 'board') return;
          const b = board();
          if (!b) return switchBoard(boards()[0].id);
          const editing = editingId && itemById(editingId);
          doc = GB.clone({ items: b.items, connectors: b.connectors });
          if (editing) {
            // keep the object the open editor writes into; take everything else from the partner
            const idx = doc.items.findIndex((i) => i.id === editing.id);
            if (idx >= 0) doc.items[idx] = editing;
            return;
          }
          render();
          shell.refreshSidebar();
        }),
        GB.coop.on(renderPresence),
        GB.store.on('coop', renderPresence),
        offCursor,
      ];
      renderPresence();

      renderToolbar();
      setTool('select');
      // first visit: frame the content (the view is already in the DOM, so sizes are known)
      const v0 = board().viewport;
      if (!v0 || (v0.x === 0 && v0.y === 0 && v0.zoom === 1)) {
        if (doc.items.length) fitAll();
        else {
          vp.x = canvas.clientWidth / 2;
          vp.y = canvas.clientHeight / 2;
          vp.apply();
        }
      }

      return {
        sidebar,
        onKey,
        actions(el) {
          el.append(h('button.btn', { onclick: () => createAt('sticky', vp.center().x, vp.center().y) }, '+ Стикер'));
        },
        destroy() {
          offs.forEach((off) => off());
          if (chatPanel) chatPanel.destroy();
          clearCursors();
          vp.destroy();
        },
      };
    },
  };
})(window.GB);
