'use strict';

// Main window shell: lock screen <-> app, sidebar navigation, topbar, view lifecycle.

(function (GB) {
  const { h } = GB;
  const $ = (id) => document.getElementById(id);

  const NAV = [
    { id: 'tasks', label: 'Задачи', ico: '✓' },
    { id: 'board', label: 'Доска', ico: '▦' },
    { id: 'mindmap', label: 'Mind map', ico: '✺' },
    { id: 'notes', label: 'Записки', ico: '🗒' },
    { id: 'coop', label: 'Вместе', ico: '👥' },
    { id: 'settings', label: 'Настройки', ico: '⚙' },
  ];

  let current = null; // { id, instance }

  const shell = {
    setTitle(title, sub = '') {
      $('view-title').textContent = title;
      $('view-sub').textContent = sub;
    },
    setSub(sub) {
      $('view-sub').textContent = sub || '';
    },
    refreshSidebar() {
      const extra = $('side-extra');
      extra.innerHTML = '';
      if (current && current.instance.sidebar) current.instance.sidebar(extra);
    },
    go(id, opts) {
      openView(id, opts);
    },
  };
  GB.shell = shell;

  function renderNav() {
    const nav = $('nav');
    nav.innerHTML = '';
    const counts = {
      tasks: GB.store.get('tasks').filter((t) => t.status !== 'done').length,
      notes: GB.store.get('notes').length,
      coop: Object.values(GB.coop.unread).reduce((a, b) => a + b, 0) || null,
    };
    for (const item of NAV) {
      nav.append(
        h(
          'button.nav-item',
          { class: current && current.id === item.id ? 'on' : '', onclick: () => openView(item.id) },
          h('span.ico', item.ico),
          item.label,
          counts[item.id] ? h('span.count', counts[item.id]) : null
        )
      );
    }
  }

  function renderProfile() {
    const p = GB.store.profile || { name: '?', color: '#888' };
    const el = $('profile');
    el.innerHTML = '';
    el.append(
      h('div.avatar', { style: { background: p.color } }, p.name.charAt(0).toUpperCase()),
      h('div', { style: { minWidth: 0 } }, h('h3', p.name), h('div.faint', { style: { fontSize: '11.5px' } }, 'Glassboard'))
    );
  }

  function renderThemeButton() {
    const resolved = GB.theme.resolve(GB.store.get('settings').theme);
    $('theme-btn').textContent = resolved === 'dark' ? '☾' : '☀︎';
  }

  function openView(id, opts) {
    const view = GB.views[id];
    if (!view) return;
    if (current && current.instance.destroy) current.instance.destroy();
    GB.closeMenus();
    const content = $('content');
    content.innerHTML = '';
    $('top-actions').innerHTML = '';
    current = { id, instance: null };
    shell.setTitle(view.title, '');
    const root = h('div.view');
    content.append(root);
    current.instance = view.mount(root, shell, opts || {}) || {};
    if (current.instance.actions) current.instance.actions($('top-actions'));
    renderNav();
    shell.refreshSidebar();
    const ui = GB.store.get('ui');
    if (ui.view !== id) GB.store.set('ui', { ...ui, view: id });
  }

  function onUnlocked() {
    GB.store.load().then(() => {
      GB.theme.apply(GB.store.get('settings'));
      $('app').classList.remove('hidden');
      renderProfile();
      renderThemeButton();
      openView(GB.store.get('ui').view || 'tasks');
      GB.coop.refresh();
    });
  }

  function onLocked() {
    if (current && current.instance.destroy) current.instance.destroy();
    current = null;
    GB.closeMenus();
    document.querySelectorAll('.modal-back').forEach((m) => m.remove());
    $('content').innerHTML = '';
    $('app').classList.add('hidden');
    GB.store.data = null;
    GB.lock.show(onUnlocked);
  }

  // ---------- wiring ----------

  $('lock-btn').addEventListener('click', () => {
    GB.store.flushNow();
    window.glass.auth.lock();
  });
  $('theme-btn').addEventListener('click', () => {
    const s = GB.store.get('settings');
    const next = GB.theme.resolve(s.theme) === 'dark' ? 'light' : 'dark';
    GB.store.set('settings', { ...s, theme: next });
  });
  $('win-min').addEventListener('click', () => window.glass.win.minimize());
  $('win-max').addEventListener('click', () => window.glass.win.maximize());
  $('win-close').addEventListener('click', () => window.glass.win.close());
  document.querySelector('.topbar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input')) return;
    window.glass.win.maximize();
  });

  window.glass.auth.onLocked(onLocked);
  window.glass.mcp.onActivity((text) => GB.store.data && GB.toast('✦ ' + text, 3200));
  GB.coop.on(() => GB.store.data && renderNav());
  window.glass.coop.onInviteLink((link) => {
    if (GB.store.data) openView('coop', { invite: link });
  });

  // keep shell in sync with data
  const onData = () => {
    if (!GB.store.data) return;
    renderNav();
  };
  GB.store.on('tasks', onData);
  GB.store.on('notes', onData);
  GB.store.on('settings', (s) => {
    GB.theme.apply(s);
    renderThemeButton();
  });

  window.addEventListener('keydown', (e) => {
    if (!GB.store.data) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'l' && !e.shiftKey) {
      e.preventDefault();
      $('lock-btn').click();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && /^[1-6]$/.test(e.key)) {
      e.preventDefault();
      openView(NAV[Number(e.key) - 1].id);
      return;
    }
    if (current && current.instance.onKey) current.instance.onKey(e);
  });

  window.addEventListener('contextmenu', (e) => {
    if (!GB.isTyping(e)) e.preventDefault();
  });

  // ---------- boot ----------

  (async function boot() {
    const info = await window.glass.info();
    GB.info = info;
    GB.theme.apply(info.prefs);
    const { unlocked } = await window.glass.auth.profiles();
    if (unlocked) onUnlocked();
    else GB.lock.show(onUnlocked);
  })();
})(window.GB);
