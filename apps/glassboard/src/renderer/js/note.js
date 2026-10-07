'use strict';

// A single sticky-note window. Data lives in the main process; this window
// edits one note by id and listens for changes made elsewhere.

(function (GB) {
  const { h } = GB;
  const id = new URLSearchParams(location.search).get('id');
  const $ = (x) => document.getElementById(x);
  const titleEl = $('title');
  const bodyEl = $('body');
  let note = null;
  let editing = false;

  function current() {
    return GB.store.get('notes').find((n) => n.id === id);
  }

  function patch(p) {
    GB.store.update('notes', (list) => list.map((n) => (n.id === id ? { ...n, ...p, updatedAt: Date.now() } : n)), 'self');
    note = current();
  }

  function paint() {
    const s = GB.store.get('settings');
    GB.theme.apply(s);
    const dark = GB.theme.resolve(s.theme) === 'dark';
    const a = note.opacity ?? 0.7;
    const base = dark ? '28,28,32' : '255,255,255';
    const solidText = GB.isLightColor(note.color) ? 'rgba(0,0,0,.84)' : 'rgba(255,255,255,.95)';
    const fg = a >= 0.5 ? solidText : dark ? 'rgba(255,255,255,.94)' : 'rgba(0,0,0,.84)';
    const root = document.documentElement.style;
    root.setProperty('--note-bg', `linear-gradient(${GB.rgba(note.color, a)}, ${GB.rgba(note.color, a * 0.85)}), rgba(${base}, ${0.18 + (1 - a) * 0.2})`);
    root.setProperty('--note-fg', fg);
    root.setProperty('--note-check', GB.rgba(note.color, 1));
    $('pin').classList.toggle('on', !!note.pinned);
    document.title = note.title || 'Записка';
  }

  function render() {
    note = current();
    if (!note) return window.close();
    if (document.activeElement !== titleEl) titleEl.value = note.title || '';
    if (!editing) bodyEl.innerHTML = GB.sanitize(note.body);
    paint();
  }

  const saveBody = GB.debounce(() => {
    editing = false;
    patch({ body: GB.sanitize(bodyEl.innerHTML) });
  }, 350);

  bodyEl.addEventListener('input', () => {
    editing = true;
    saveBody();
  });
  titleEl.addEventListener('input', () => patch({ title: titleEl.value }));
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      bodyEl.focus();
    }
  });

  // paste as plain text — keeps notes clean and safe
  bodyEl.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  // toggle checklist items by clicking their box
  bodyEl.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.todo, .todo-done');
    if (!item) return;
    const r = item.getBoundingClientRect();
    if (e.clientX - r.left > 22) return;
    e.preventDefault();
    item.className = item.className === 'todo' ? 'todo-done' : 'todo';
    editing = true;
    saveBody();
  });

  function currentBlock() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    let n = sel.anchorNode;
    while (n && n !== bodyEl && !(n.nodeType === 1 && /^(DIV|P|H1|H2|H3|LI)$/.test(n.tagName))) n = n.parentNode;
    return n && n !== bodyEl ? n : null;
  }

  function command(cmd) {
    bodyEl.focus();
    if (['h1', 'h2', 'h3', 'p'].includes(cmd)) {
      document.execCommand('formatBlock', false, cmd.toUpperCase());
    } else if (cmd === 'todo') {
      let block = currentBlock();
      if (!block) {
        document.execCommand('formatBlock', false, 'DIV');
        block = currentBlock();
      }
      if (block) block.className = block.className === 'todo' || block.className === 'todo-done' ? '' : 'todo';
    } else {
      document.execCommand(cmd, false, null);
    }
    editing = true;
    saveBody();
  }

  $('tools').addEventListener('mousedown', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    command(btn.dataset.cmd);
  });

  // Enter at the end of a checklist item continues the checklist
  bodyEl.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.altKey && /^Digit[123]$/.test(e.code)) {
      e.preventDefault();
      command('h' + e.code.slice(-1));
    } else if (mod && e.altKey && e.code === 'Digit0') {
      e.preventDefault();
      command('p');
    } else if (mod && e.key === 'Enter') {
      e.preventDefault();
      command('todo');
    }
  });

  $('pin').append(GB.icon('pin'));
  $('pin').addEventListener('click', () => patch({ pinned: !note.pinned }));
  $('close').addEventListener('click', () => {
    GB.store.flushNow();
    window.close();
  });
  $('main').addEventListener('click', () => window.glass.win.focusMain());

  $('style').addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.querySelector('.note-pop');
    if (existing) return existing.remove();
    const range = h('input', {
      type: 'range',
      min: 0.15,
      max: 1,
      step: 0.01,
      value: note.opacity ?? 0.7,
      oninput: () => patch({ opacity: Number(range.value) }) || paint(),
    });
    const pop = h(
      'div.note-pop.glass',
      h('label', 'Цвет'),
      h(
        'div.swatches',
        GB.PALETTE.map((c) =>
          h('button.swatch', {
            style: { background: c },
            onclick: () => {
              patch({ color: c });
              paint();
            },
          })
        )
      ),
      h('label', 'Прозрачность'),
      range
    );
    document.body.append(pop);
    const off = (ev) => {
      if (!pop.contains(ev.target)) {
        pop.remove();
        window.removeEventListener('pointerdown', off, true);
      }
    };
    setTimeout(() => window.addEventListener('pointerdown', off, true));
  });

  GB.store.on('notes', (_v, source) => {
    if (source !== 'self') render();
  });
  GB.store.on('settings', paint);

  window.addEventListener('contextmenu', (e) => {
    if (!GB.isTyping(e)) e.preventDefault();
  });

  GB.store
    .load()
    .then(() => {
      render();
      if (!note.title && !GB.textOf(note.body).trim()) titleEl.focus();
    })
    .catch(() => {
      $('locked').classList.remove('hidden');
    });
})(window.GB);
