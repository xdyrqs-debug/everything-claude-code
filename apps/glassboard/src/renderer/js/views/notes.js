'use strict';

// Notes gallery in the main window + helpers used by other views to spawn
// sticky-note windows (each note opens as its own frameless glass window).

(function (GB) {
  const { h } = GB;

  GB.noteOps = {
    create(patch = {}) {
      const s = GB.store.get('settings');
      const note = {
        id: GB.uid(),
        title: '',
        body: '',
        color: s.noteColor,
        opacity: s.noteOpacity,
        pinned: false,
        open: false,
        bounds: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...patch,
      };
      GB.store.update('notes', (list) => [note, ...list]);
      this.open(note.id);
      return note;
    },
    open(id) {
      GB.store.flushNow();
      window.glass.notes.open(id);
    },
    patch(id, patch) {
      GB.store.update('notes', (list) => list.map((n) => (n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n)));
    },
    async remove(id) {
      const note = GB.store.get('notes').find((n) => n.id === id);
      if (!note) return;
      if (!(await GB.confirm('Удалить записку?', note.title || 'Без названия'))) return;
      GB.store.update('notes', (list) => list.filter((n) => n.id !== id));
    },
    menuItems(note) {
      return [
        { icon: '↗', label: 'Открыть на экране', onClick: () => this.open(note.id) },
        {
          icon: '📌',
          label: note.pinned ? 'Открепить' : 'Закрепить поверх окон',
          onClick: () => {
            this.patch(note.id, { pinned: !note.pinned });
            if (!note.pinned) this.open(note.id);
          },
        },
        note.open ? { icon: '✕', label: 'Убрать с экрана', onClick: () => window.glass.notes.close(note.id) } : null,
        'sep',
        h(
          'div.swatches',
          GB.PALETTE.map((c) =>
            h('button.swatch', {
              style: { background: c },
              title: c,
              onclick: () => {
                GB.closeMenus();
                this.patch(note.id, { color: c });
              },
            })
          )
        ),
        'sep',
        { icon: '🗑', label: 'Удалить', danger: true, onClick: () => this.remove(note.id) },
      ];
    },
  };

  GB.views = GB.views || {};
  GB.views.notes = {
    title: 'Записки',
    mount(root, shell) {
      const grid = h('div.notes-grid');
      const search = h('input.input.search', { placeholder: 'Поиск…', oninput: () => render() });
      root.append(
        h(
          'div.toolbar',
          h('div.muted', 'Записки открываются отдельными окнами — их можно закрепить поверх всех программ.'),
          h('div.spacer'),
          search
        ),
        grid
      );

      function render() {
        const q = search.value.trim().toLowerCase();
        const notes = GB.store
          .get('notes')
          .filter((n) => !q || (n.title + ' ' + GB.textOf(n.body)).toLowerCase().includes(q));
        shell.setSub(`${notes.length} ${GB.plural(notes.length, 'записка', 'записки', 'записок')}`);
        grid.innerHTML = '';
        if (!notes.length) {
          grid.append(
            h(
              'div.empty',
              { style: { gridColumn: '1 / -1', gridRow: 'span 2' } },
              h('div.big', '🗒'),
              h('h2', 'Пока пусто'),
              h('div', 'Создайте записку — она появится на рабочем столе как виджет.'),
              h('button.btn.primary', { onclick: () => GB.noteOps.create() }, '+ Новая записка')
            )
          );
          return;
        }
        for (const n of notes) {
          const light = GB.isLightColor(n.color);
          const body = h('div.body');
          body.innerHTML = GB.sanitize(n.body) || '<span style="opacity:.5">Пусто</span>';
          grid.append(
            h(
              'div.note-card',
              {
                class: light ? 'dark-text' : 'light-text',
                style: {
                  background: `linear-gradient(160deg, ${GB.rgba(n.color, 0.95)}, ${GB.rgba(n.color, 0.72)})`,
                  boxShadow: `0 10px 26px ${GB.rgba(n.color, 0.35)}, inset 0 1px 0 rgba(255,255,255,.5)`,
                },
                onclick: () => GB.noteOps.open(n.id),
                oncontextmenu: (e) => {
                  e.preventDefault();
                  GB.menu(e.clientX, e.clientY, GB.noteOps.menuItems(n));
                },
              },
              h('h3', n.title || 'Без названия'),
              body,
              h(
                'div.foot',
                n.pinned ? h('span.chip', '📌 закреплена') : null,
                n.open ? h('span.chip', 'на экране') : null,
                h('div.spacer'),
                h(
                  'button.btn.icon.small.ghost',
                  {
                    title: 'Ещё',
                    onclick: (e) => {
                      e.stopPropagation();
                      GB.menu(e.clientX, e.clientY, GB.noteOps.menuItems(n));
                    },
                  },
                  '⋯'
                )
              )
            )
          );
        }
      }

      const off = GB.store.on('notes', render);
      render();
      return {
        actions(el) {
          el.append(h('button.btn.primary', { onclick: () => GB.noteOps.create() }, '+ Записка'));
        },
        onKey(e) {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            GB.noteOps.create();
          }
        },
        destroy: off,
      };
    },
  };
})(window.GB);
