'use strict';

// Mind map: balanced tree layout around a central topic, keyboard-first
// editing (Tab / Enter / Del / Space / arrows), drag to re-parent, branch
// colours, collapse, and conversion of branches into tasks.

(function (GB) {
  const { h, svg } = GB;
  const BRANCH_COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#ff375f', '#bf5af2', '#64d2ff', '#ffd60a', '#ff6b6b'];
  const HGAP = 64;
  const VGAP = 14;

  GB.views = GB.views || {};
  GB.views.mindmap = {
    title: 'Mind map',
    mount(root, shell) {
      const ui = () => GB.store.get('ui');
      const maps = () => GB.store.get('mindmaps');
      const newMap = (name) => ({
        id: GB.uid(),
        name,
        viewport: { x: 0, y: 0, zoom: 1 },
        root: { id: GB.uid(), text: name, collapsed: false, children: [] },
      });
      if (!maps().length) GB.store.set('mindmaps', [newMap('Главная цель')]);
      let mapId = maps().some((m) => m.id === ui().mindmapId) ? ui().mindmapId : maps()[0].id;
      const map = () => maps().find((m) => m.id === mapId);

      let tree = GB.clone(map().root);
      let selected = tree.id;
      let editingId = null;
      const history = new GB.History();

      // ---------- tree helpers ----------
      function walk(node, fn, parent = null, depth = 0) {
        if (fn(node, parent, depth) === false) return false;
        for (const c of node.children) if (walk(c, fn, node, depth + 1) === false) return false;
      }
      function find(id) {
        let out = null;
        walk(tree, (n, parent, depth) => {
          if (n.id === id) {
            out = { node: n, parent, depth };
            return false;
          }
        });
        return out;
      }
      function isDescendant(ancestor, id) {
        let found = false;
        walk(ancestor, (n) => {
          if (n.id === id) found = true;
        });
        return found;
      }

      function commit(pushHistory = true, before) {
        if (pushHistory) history.push(before || tree);
        GB.store.update('mindmaps', (list) => list.map((m) => (m.id === mapId ? { ...m, root: GB.clone(tree), name: tree.text || m.name } : m)), 'mindmap');
        render();
        shell.refreshSidebar();
      }
      const change = (fn) => {
        const before = GB.clone(tree);
        fn();
        commit(true, before);
      };

      // ---------- DOM ----------
      const world = h('div.world');
      const links = svg('svg', { class: 'links' });
      const nodeLayer = h('div');
      world.append(links, nodeLayer);
      const canvas = h('div.canvas', world);
      const topbar = h(
        'div.floating-bar.top.glass',
        h('button.btn.small.ghost', { onclick: () => addChild(), title: 'Tab' }, '+ Дочерний'),
        h('button.btn.small.ghost', { onclick: () => addSibling(), title: 'Enter' }, '+ Соседний'),
        h('span.sep'),
        h('button.btn.small.ghost', { onclick: () => toTasks(selected), title: 'Создать задачу из выбранной ветки' }, '☑ В задачи'),
        h('span.sep'),
        h('button.tool', { title: 'Отменить (Ctrl+Z)', onclick: undo }, GB.icon('undo')),
        h('button.tool', { title: 'Повторить', onclick: redo }, GB.icon('redo')),
        h('button.tool', { title: 'Показать всё', onclick: fit }, GB.icon('fit'))
      );
      const hint = h(
        'div.hint.glass',
        h('kbd', 'Tab'), ' дочерний  ',
        h('kbd', 'Enter'), ' соседний  ',
        h('kbd', 'F2'), ' правка  ',
        h('kbd', 'Space'), ' свернуть  ',
        h('kbd', 'Del'), ' удалить  · перетащите узел на другой, чтобы перенести'
      );
      root.append(h('div.canvas-wrap.glass', canvas, topbar, hint));

      const saveViewport = GB.debounce((v) => {
        GB.store.update('mindmaps', (list) => list.map((m) => (m.id === mapId ? { ...m, viewport: v } : m)), 'mindmap');
      }, 400);
      const vp = new GB.Viewport(canvas, world, {
        state: map().viewport || {},
        onChange: saveViewport,
        canPan: (e) => !e.target.closest('.mm-node'),
      });

      // ---------- layout ----------
      function render() {
        if (editingId) return;
        nodeLayer.innerHTML = '';
        links.innerHTML = '';
        const els = new Map();

        // 1. create elements so we can measure them
        walk(tree, (n, parent, depth) => {
          if (parent && hiddenByCollapse(n)) return;
          const el = h(
            'div.mm-node',
            {
              class: [depth === 0 ? 'root' : `level-${Math.min(depth, 2)}`, n.id === selected ? 'selected' : ''].join(' '),
              dataset: { id: n.id },
            },
            h('span.text', n.text || ' '),
            n.done ? h('span.done-mark', '✓') : null,
            n.taskId ? h('span.done-mark', { title: 'Связано с задачей' }, '☑') : null
          );
          nodeLayer.append(el);
          els.set(n.id, el);
        });
        const size = new Map([...els].map(([id, el]) => [id, { w: el.offsetWidth, h: el.offsetHeight }]));

        // 2. compute subtree heights
        const heights = new Map();
        const subtreeH = (n) => {
          const own = size.get(n.id).h;
          const kids = visibleChildren(n);
          const sum = kids.reduce((acc, c) => acc + subtreeH(c), 0) + Math.max(0, kids.length - 1) * VGAP;
          const hh = Math.max(own, sum);
          heights.set(n.id, hh);
          return hh;
        };

        const pos = new Map();
        const place = (n, x, cy, dir, branchColor) => {
          const s = size.get(n.id);
          const left = dir > 0 ? x : x - s.w;
          pos.set(n.id, { x: left, y: cy - s.h / 2, w: s.w, h: s.h, dir, color: branchColor });
          const kids = visibleChildren(n);
          const total = kids.reduce((acc, c) => acc + heights.get(c.id), 0) + Math.max(0, kids.length - 1) * VGAP;
          let y = cy - total / 2;
          const nx = dir > 0 ? left + s.w + HGAP : left - HGAP;
          for (const c of kids) {
            const ch = heights.get(c.id);
            place(c, nx, y + ch / 2, dir, c.color || branchColor);
            y += ch + VGAP;
          }
        };

        const rs = size.get(tree.id);
        pos.set(tree.id, { x: -rs.w / 2, y: -rs.h / 2, w: rs.w, h: rs.h, dir: 0 });
        const kids = tree.collapsed ? [] : tree.children;
        const rightCount = Math.ceil(kids.length / 2);
        const sides = [kids.slice(0, rightCount), kids.slice(rightCount)];
        sides.forEach((group, sideIdx) => {
          const dir = sideIdx === 0 ? 1 : -1;
          group.forEach(subtreeH);
          const total = group.reduce((acc, c) => acc + heights.get(c.id), 0) + Math.max(0, group.length - 1) * VGAP * 2;
          let y = -total / 2;
          for (const c of group) {
            const idx = tree.children.indexOf(c);
            const color = c.color || BRANCH_COLORS[idx % BRANCH_COLORS.length];
            const ch = heights.get(c.id);
            place(c, dir > 0 ? rs.w / 2 + HGAP * 1.3 : -rs.w / 2 - HGAP * 1.3, y + ch / 2, dir, color);
            y += ch + VGAP * 2;
          }
        });

        // 3. position + draw links
        walk(tree, (n, parent) => {
          const p = pos.get(n.id);
          const el = els.get(n.id);
          if (!p || !el) return;
          el.style.left = p.x + 'px';
          el.style.top = p.y + 'px';
          if (p.color) el.style.setProperty('--branch', p.color);
          if (n.collapsed && n.children.length && parent) {
            el.append(h('span.fold', { class: p.dir > 0 ? 'right' : 'left' }, n.children.length));
          } else if (n.collapsed && n.children.length) {
            el.append(h('span.fold.right', n.children.length));
          }
          if (parent && pos.get(parent.id)) {
            const pp = pos.get(parent.id);
            const dir = p.dir;
            const x1 = dir > 0 ? pp.x + pp.w : pp.x;
            const y1 = pp.y + pp.h / 2;
            const x2 = dir > 0 ? p.x : p.x + p.w;
            const y2 = p.y + p.h / 2;
            const mx = (x1 + x2) / 2;
            links.append(
              svg('path', {
                d: `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
                fill: 'none',
                stroke: p.color,
                'stroke-width': parent === tree ? 3.5 : 2.2,
                'stroke-linecap': 'round',
                opacity: 0.85,
              })
            );
          }
        });
        lastPos = pos;
        let count = 0;
        walk(tree, () => {
          count++;
        });
        shell.setSub(`${tree.text} · ${count} ${GB.plural(count, 'узел', 'узла', 'узлов')}`);
      }
      let lastPos = new Map();

      function visibleChildren(n) {
        return n.collapsed ? [] : n.children;
      }
      function hiddenByCollapse(n) {
        let hidden = false;
        walk(tree, (x) => {
          if (x.collapsed && x.id !== n.id && isDescendant(x, n.id)) {
            hidden = true;
            return false;
          }
        });
        return hidden;
      }

      function fit() {
        if (!lastPos.size) return;
        const all = [...lastPos.values()];
        const x = Math.min(...all.map((p) => p.x));
        const y = Math.min(...all.map((p) => p.y));
        vp.fit({ x, y, w: Math.max(...all.map((p) => p.x + p.w)) - x, h: Math.max(...all.map((p) => p.y + p.h)) - y });
      }

      // ---------- editing ops ----------
      function select(id) {
        selected = id;
        for (const el of nodeLayer.children) el.classList.toggle('selected', el.dataset.id === id);
      }

      function addChild(id = selected, text = '') {
        const f = find(id);
        if (!f) return;
        const node = { id: GB.uid(), text, collapsed: false, children: [] };
        change(() => {
          f.node.collapsed = false;
          f.node.children.push(node);
          selected = node.id;
        });
        startEdit(node.id);
      }

      function addSibling(id = selected) {
        const f = find(id);
        if (!f) return;
        if (!f.parent) return addChild(id);
        const node = { id: GB.uid(), text: '', collapsed: false, children: [] };
        change(() => {
          f.parent.children.splice(f.parent.children.indexOf(f.node) + 1, 0, node);
          selected = node.id;
        });
        startEdit(node.id);
      }

      function remove(id = selected) {
        const f = find(id);
        if (!f || !f.parent) return;
        const idx = f.parent.children.indexOf(f.node);
        change(() => {
          f.parent.children.splice(idx, 1);
          selected = (f.parent.children[idx] || f.parent.children[idx - 1] || f.parent).id;
        });
      }

      function toggle(id = selected) {
        const f = find(id);
        if (!f || !f.node.children.length) return;
        change(() => {
          f.node.collapsed = !f.node.collapsed;
        });
      }

      function startEdit(id) {
        const el = nodeLayer.querySelector(`[data-id="${id}"] .text`);
        const f = find(id);
        if (!el || !f) return;
        select(id);
        editingId = id;
        el.contentEditable = 'plaintext-only';
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        let cancelled = false;
        const original = f.node.text;
        const finish = () => {
          el.removeEventListener('blur', finish);
          editingId = null;
          const text = cancelled ? original : el.innerText.replace(/\n/g, ' ').trim();
          if (!text && !original && f.parent) {
            // empty new node -> drop it
            const idx = f.parent.children.indexOf(f.node);
            f.parent.children.splice(idx, 1);
            selected = f.parent.id;
            commit(false);
          } else if (text !== original) {
            const before = GB.clone(tree);
            f.node.text = text || original;
            commit(true, before);
          } else render();
        };
        el.addEventListener('blur', finish);
        el.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            cancelled = true;
            el.blur();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            el.blur();
            if (!e.shiftKey && el.innerText.trim()) addSibling(id);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            el.blur();
            if (el.innerText.trim()) addChild(id);
          }
        });
      }

      function navigate(key) {
        const f = find(selected);
        if (!f) return;
        const p = lastPos.get(selected) || { dir: 0 };
        const kids = visibleChildren(f.node);
        if (key === 'ArrowUp' || key === 'ArrowDown') {
          if (!f.parent) return;
          const sibs = f.parent.children;
          const i = sibs.indexOf(f.node) + (key === 'ArrowUp' ? -1 : 1);
          if (sibs[i]) select(sibs[i].id);
          return;
        }
        const towardChildren = (key === 'ArrowRight' && p.dir >= 0) || (key === 'ArrowLeft' && p.dir < 0);
        if (!f.parent) {
          // root: pick first child on that side
          const half = Math.ceil(kids.length / 2);
          const side = key === 'ArrowRight' ? kids.slice(0, half) : kids.slice(half);
          if (side[0]) select(side[0].id);
        } else if (towardChildren) {
          if (kids[0]) select(kids[0].id);
        } else select(f.parent.id);
      }

      function setColor(id, color) {
        const f = find(id);
        if (!f) return;
        change(() => {
          f.node.color = color;
        });
      }

      function toTasks(id) {
        const f = find(id);
        if (!f) return;
        const n = f.node;
        const lines = (node, depth) => node.children.flatMap((c) => [{ title: '  '.repeat(depth) + c.text, done: !!c.done }, ...lines(c, depth + 1)]);
        const task = GB.taskOps.create({
          title: n.text || 'Задача',
          description: f.parent ? `Из mind map «${tree.text}» → ${f.parent.text}` : `Из mind map «${tree.text}»`,
          subtasks: lines(n, 0).map((s) => ({ id: GB.uid(), title: s.title, done: s.done })),
          tags: ['mindmap'],
        });
        change(() => {
          n.taskId = task.id;
        });
        GB.toast(`Задача «${task.title}» создана${task.subtasks.length ? ` с ${task.subtasks.length} подзадачами` : ''}`);
      }

      function undo() {
        const prev = history.undo(tree);
        if (!prev) return;
        tree = prev;
        commit(false);
      }
      function redo() {
        const next = history.redo(tree);
        if (!next) return;
        tree = next;
        commit(false);
      }

      // ---------- pointer ----------
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || editingId) return;
        GB.closeMenus();
        e.preventDefault();
        const el = e.target.closest('.mm-node');
        if (!el) return;
        const id = el.dataset.id;
        select(id);
        if (id === tree.id) return;
        // drag to re-parent
        const start = { x: e.clientX, y: e.clientY };
        let dragging = false;
        let target = null;
        canvas.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const dx = (ev.clientX - start.x) / vp.zoom;
          const dy = (ev.clientY - start.y) / vp.zoom;
          if (!dragging && Math.hypot(dx, dy) < 5) return;
          dragging = true;
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          el.style.pointerEvents = 'none';
          el.style.opacity = '0.75';
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          const overEl = under && under.closest('.mm-node');
          const f = find(id);
          const next = overEl && overEl !== el && !isDescendant(f.node, overEl.dataset.id) ? overEl : null;
          if (target !== next) {
            target && target.classList.remove('drop-target');
            target = next;
            target && target.classList.add('drop-target');
          }
        };
        const up = () => {
          canvas.removeEventListener('pointermove', move);
          canvas.removeEventListener('pointerup', up);
          if (!dragging) return;
          if (target) {
            const newParentId = target.dataset.id;
            change(() => {
              const f = find(id);
              f.parent.children.splice(f.parent.children.indexOf(f.node), 1);
              const np = find(newParentId);
              np.node.collapsed = false;
              np.node.children.push(f.node);
            });
          } else render();
        };
        canvas.addEventListener('pointermove', move);
        canvas.addEventListener('pointerup', up);
      });

      canvas.addEventListener('dblclick', (e) => {
        const el = e.target.closest('.mm-node');
        if (el) {
          if (e.target.closest('.fold')) toggle(el.dataset.id);
          else startEdit(el.dataset.id);
        } else addChild(tree.id);
      });

      canvas.addEventListener('click', (e) => {
        const fold = e.target.closest('.fold');
        if (fold) toggle(fold.parentElement.dataset.id);
      });

      canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const el = e.target.closest('.mm-node');
        if (!el) return;
        const id = el.dataset.id;
        select(id);
        const f = find(id);
        GB.menu(e.clientX, e.clientY, [
          { icon: '✎', label: 'Переименовать', onClick: () => startEdit(id) },
          { icon: '↳', label: 'Добавить дочерний', onClick: () => addChild(id) },
          f.parent ? { icon: '↓', label: 'Добавить соседний', onClick: () => addSibling(id) } : null,
          f.node.children.length ? { icon: f.node.collapsed ? '▸' : '▾', label: f.node.collapsed ? 'Развернуть' : 'Свернуть', onClick: () => toggle(id) } : null,
          f.parent
            ? {
                icon: '✓',
                label: f.node.done ? 'Снять отметку' : 'Отметить выполненным',
                onClick: () => change(() => (f.node.done = !f.node.done)),
              }
            : null,
          'sep',
          h(
            'div.swatches',
            BRANCH_COLORS.map((c) =>
              h('button.swatch', {
                style: { background: c },
                onclick: () => {
                  GB.closeMenus();
                  setColor(id, c);
                },
              })
            ),
            h('button.swatch', {
              title: 'Цвет по умолчанию',
              style: { background: 'transparent' },
              onclick: () => {
                GB.closeMenus();
                setColor(id, undefined);
              },
            })
          ),
          'sep',
          { icon: '☑', label: 'Создать задачу из ветки', onClick: () => toTasks(id) },
          {
            icon: '📌',
            label: 'Ветка как записка на экран',
            onClick: () => {
              const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
              const body = [];
              walk(f.node, (n, _p, d) => {
                if (n === f.node) return;
                body.push(`<div class="${n.done ? 'todo-done' : 'todo'}">${'— '.repeat(Math.max(0, d - 1))}${esc(n.text)}</div>`);
              });
              GB.noteOps.create({ title: f.node.text, body: body.join(''), pinned: true });
            },
          },
          f.parent ? 'sep' : null,
          f.parent ? { icon: '🗑', label: 'Удалить ветку', danger: true, onClick: () => remove(id) } : null,
        ]);
      });

      // ---------- sidebar ----------
      function sidebar(el) {
        el.append(
          h('div.sidebar-section', 'Карты', h('button', { title: 'Новая карта', onclick: addMap }, '+')),
          ...maps().map((m) =>
            h(
              'button.nav-item',
              {
                class: m.id === mapId ? 'on' : '',
                onclick: () => switchMap(m.id),
                oncontextmenu: (e) => {
                  e.preventDefault();
                  if (maps().length < 2) return;
                  GB.menu(e.clientX, e.clientY, [
                    {
                      icon: '🗑',
                      label: 'Удалить карту',
                      danger: true,
                      onClick: async () => {
                        if (!(await GB.confirm('Удалить карту?', m.name))) return;
                        GB.store.update('mindmaps', (list) => list.filter((x) => x.id !== m.id), 'mindmap');
                        if (m.id === mapId) switchMap(maps()[0].id);
                        else shell.refreshSidebar();
                      },
                    },
                  ]);
                },
              },
              h('span.ico', '✺'),
              m.name
            )
          )
        );
      }

      async function addMap() {
        const res = await GB.prompt({ title: 'Новая карта', fields: [{ name: 'name', placeholder: 'Центральная тема' }], ok: 'Создать' });
        if (!res || !res.name.trim()) return;
        const m = newMap(res.name.trim());
        GB.store.update('mindmaps', (list) => [...list, m], 'mindmap');
        switchMap(m.id);
      }

      function switchMap(id) {
        mapId = id;
        GB.store.set('ui', { ...ui(), mindmapId: id });
        tree = GB.clone(map().root);
        selected = tree.id;
        history.clear();
        render();
        const v = map().viewport;
        if (!v || (!v.x && !v.y)) centerRoot();
        else {
          Object.assign(vp, { x: v.x, y: v.y, zoom: v.zoom });
          vp.apply();
        }
        shell.refreshSidebar();
      }

      function centerRoot() {
        vp.x = canvas.clientWidth / 2;
        vp.y = canvas.clientHeight / 2;
        vp.zoom = 1;
        vp.apply(true);
      }

      // ---------- keyboard ----------
      function onKey(e) {
        if (GB.isTyping(e) || editingId) return;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          e.shiftKey ? redo() : undo();
        } else if (mod && e.key.toLowerCase() === 'y') {
          e.preventDefault();
          redo();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          addChild();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          addSibling();
        } else if (e.key === 'F2') {
          e.preventDefault();
          startEdit(selected);
        } else if (e.key === 'Delete' || e.key === 'Backspace') remove();
        else if (e.code === 'Space') {
          e.preventDefault();
          toggle();
        } else if (e.key.startsWith('Arrow')) {
          e.preventDefault();
          navigate(e.key);
        } else if (e.shiftKey && e.code === 'Digit1') fit();
        else if (e.key.length === 1 && !mod && !e.altKey && /\S/.test(e.key)) {
          // start typing to replace the label, like XMind/Miro
          startEdit(selected);
          const el = nodeLayer.querySelector(`[data-id="${selected}"] .text`);
          if (el) {
            el.textContent = '';
          }
        }
      }

      const offs = [
        GB.store.on('mindmaps', (_v, source) => {
          if (source === 'mindmap') return;
          if (!map()) return switchMap(maps()[0].id);
          tree = GB.clone(map().root);
          render();
          shell.refreshSidebar();
        }),
      ];

      render();
      const v0 = map().viewport;
      if (!v0 || (!v0.x && !v0.y)) centerRoot();

      return {
        sidebar,
        onKey,
        destroy() {
          offs.forEach((off) => off());
          vp.destroy();
        },
      };
    },
  };
})(window.GB);
