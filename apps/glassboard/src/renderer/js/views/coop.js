'use strict';

// Co-op: shared projects (tasks + board + chat) with partners who join by link.

(function (GB) {
  const { h } = GB;

  // ---------------------------------------------------------------- runtime state

  GB.coop = {
    status: { rooms: [], localRelay: null, lan: [] },
    unread: {},
    drafts: {},
    activeChat: null, // room id whose chat is visible right now
    listeners: new Set(),
    rooms() {
      return (GB.store.get('coop') || { rooms: [] }).rooms;
    },
    room(id) {
      return this.rooms().find((r) => r.id === id);
    },
    live(id) {
      return this.status.rooms.find((r) => r.id === id) || { status: 'offline', peers: [] };
    },
    roomForBoard(boardId) {
      return this.rooms().find((r) => r.boardId === boardId);
    },
    on(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
    emit() {
      for (const fn of this.listeners) fn();
    },
    async refresh() {
      try {
        this.status = await window.glass.coop.status();
        this.emit();
      } catch {
        /* locked */
      }
    },
  };

  window.glass.coop.onStatus((st) => {
    GB.coop.status = st;
    GB.coop.emit();
  });

  window.glass.coop.onChat(({ room, msg }) => {
    if (!GB.store.data) return;
    if (msg && GB.coop.activeChat !== room) {
      const self = GB.store.profile && msg.name === GB.store.profile.name && msg.color === GB.store.profile.color;
      if (!self) {
        GB.coop.unread[room] = (GB.coop.unread[room] || 0) + 1;
        const r = GB.coop.room(room);
        GB.toast(`💬 ${msg.name}${r ? ' · ' + r.name : ''}: ${msg.text.slice(0, 80)}`, 3500);
      }
    }
    GB.coop.emit();
  });

  const statusLabel = (live) =>
    ({ online: 'в сети', connecting: 'подключение…', offline: 'нет связи' })[live.status] || live.status;

  const avatar = (p, size = 26) =>
    h(
      'div.avatar',
      { title: p.name, style: { background: p.color || '#8e8e93', width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.42) + 'px' } },
      (p.name || '?').charAt(0).toUpperCase()
    );

  GB.coop.avatar = avatar;

  // ---------------------------------------------------------------- chat panel (used here and on boards)

  GB.coop.chatPanel = function chatPanel(roomId) {
    const list = h('div.chat-list');
    const input = h('textarea.chat-input', { placeholder: 'Сообщение… (Enter — отправить)', rows: 1, value: GB.coop.drafts[roomId] || '' });
    const el = h('div.chat', list, h('div.chat-compose', input, h('button.btn.primary.small', { onclick: send }, 'Отправить')));
    let lastCount = -1;

    function render() {
      const room = GB.coop.room(roomId);
      const msgs = room ? room.chat : [];
      if (msgs.length === lastCount) return;
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      lastCount = msgs.length;
      list.innerHTML = '';
      if (!msgs.length) list.append(h('div.chat-empty', 'Здесь пока тихо. Напишите партнёру 👋'));
      const me = GB.store.profile || {};
      let prev = null;
      for (const m of msgs) {
        const mine = m.name === me.name && m.color === me.color;
        const grouped = prev && prev.name === m.name && m.ts - prev.ts < 5 * 60 * 1000;
        list.append(
          h(
            'div.chat-msg',
            { class: (mine ? 'mine' : '') + (grouped ? ' grouped' : '') },
            grouped ? h('div.chat-gap') : avatar(m, 28),
            h(
              'div.chat-bubble-wrap',
              grouped ? null : h('div.chat-meta', h('b', m.name), ' ', new Date(m.ts).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })),
              h('div.chat-bubble', { style: mine ? null : { borderLeftColor: m.color } }, m.text)
            )
          )
        );
        prev = m;
      }
      if (atBottom || lastCount <= 1) list.scrollTop = list.scrollHeight;
    }

    async function send() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      GB.coop.drafts[roomId] = '';
      autosize();
      try {
        await window.glass.coop.chat(roomId, text);
        list.scrollTop = list.scrollHeight;
      } catch (err) {
        GB.toast(err.message);
      }
    }

    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
    }

    input.addEventListener('input', () => {
      GB.coop.drafts[roomId] = input.value;
      autosize();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    GB.coop.activeChat = roomId;
    GB.coop.unread[roomId] = 0;
    const offs = [GB.store.on('coop', render), GB.coop.on(render)];
    render();
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
    return {
      el,
      focus: () => input.focus(),
      destroy() {
        offs.forEach((off) => off());
        if (GB.coop.activeChat === roomId) GB.coop.activeChat = null;
      },
    };
  };

  // ---------------------------------------------------------------- dialogs

  function modal(title, body, actions) {
    return new Promise((resolve) => {
      const close = (v) => {
        back.remove();
        resolve(v);
      };
      const form = h(
        'form.modal.glass',
        {
          style: { width: '440px' },
          onsubmit: (e) => {
            e.preventDefault();
            close(actions.submit());
          },
        },
        h('h2', title),
        body,
        h('div.row', h('div.spacer'), h('button.btn', { type: 'button', onclick: () => close(null) }, 'Отмена'), h('button.btn.primary', { type: 'submit' }, actions.ok))
      );
      const back = h('div.modal-back', { onpointerdown: (e) => e.target === back && close(null) }, form);
      back.addEventListener('keydown', (e) => e.key === 'Escape' && close(null));
      document.body.append(back);
      const first = form.querySelector('input, textarea');
      if (first) first.focus();
    });
  }

  async function createDialog() {
    const name = h('input.input', { placeholder: 'Название проекта', value: '' });
    let mode = 'local';
    const relay = h('input.input', { placeholder: 'wss://relay.example.com', value: localStorage.getItem('glassboard:relay') || '' });
    const relayRow = h('div.field.hidden', h('label', 'Адрес сервера связи'), relay);
    const hint = h('div.muted', { style: { fontSize: '12px' } });
    const setMode = (m) => {
      mode = m;
      relayRow.classList.toggle('hidden', m !== 'custom');
      hint.textContent =
        m === 'local'
          ? 'Сервер связи запустится на этом компьютере. Партнёр в той же сети (Wi-Fi) подключится сразу; для интернета откройте порт или используйте туннель — см. README.'
          : 'Свой сервер связи (relay) — доступен из интернета. Его можно развернуть из файла relay.Dockerfile.';
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    };
    const seg = h(
      'div.segmented',
      h('button', { type: 'button', dataset: { m: 'local' }, onclick: () => setMode('local') }, 'Этот компьютер'),
      h('button', { type: 'button', dataset: { m: 'custom' }, onclick: () => setMode('custom') }, 'Свой сервер')
    );
    setMode('local');
    const res = await modal(
      'Новый совместный проект',
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div.muted', 'Будут общими: задачи проекта, доска и чат. Курсоры участников видны на доске.'),
        h('div.field', h('label', 'Название'), name),
        h('div.field', h('label', 'Сервер связи'), seg),
        relayRow,
        hint
      ),
      { ok: 'Создать', submit: () => ({ name: name.value.trim(), relay: mode === 'custom' ? relay.value.trim() : '' }) }
    );
    if (!res) return null;
    if (res.relay) localStorage.setItem('glassboard:relay', res.relay);
    try {
      const out = await window.glass.coop.create(res);
      await window.glass.copy(out.invite);
      GB.toast('Проект создан. Ссылка-приглашение скопирована — отправьте её партнёру');
      return out.id;
    } catch (err) {
      GB.toast(err.message, 4000);
      return null;
    }
  }

  async function joinDialog(prefill = '') {
    const link = h('textarea.input', { placeholder: 'glassboard://join/…', value: prefill, style: { minHeight: '84px', fontFamily: 'ui-monospace, monospace', fontSize: '12px' } });
    const res = await modal(
      'Присоединиться к проекту',
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div.muted', 'Вставьте ссылку-приглашение от партнёра. Общие задачи, доска и вся история чата появятся у вас и сохранятся в вашем зашифрованном профиле.'),
        link
      ),
      { ok: 'Присоединиться', submit: () => link.value.trim() }
    );
    if (!res) return null;
    try {
      const out = await window.glass.coop.join(res);
      GB.toast(out.already ? 'Вы уже в этом проекте' : 'Подключаемся… данные появятся, когда партнёр будет в сети');
      return out.id;
    } catch (err) {
      GB.toast(err.message, 4000);
      return null;
    }
  }

  GB.coop.joinDialog = joinDialog;

  // ---------------------------------------------------------------- view

  GB.views = GB.views || {};
  GB.views.coop = {
    title: 'Вместе',
    mount(root, shell, opts) {
      let selected = opts.roomId || (GB.store.get('ui').coopRoom && GB.coop.room(GB.store.get('ui').coopRoom) ? GB.store.get('ui').coopRoom : null);
      let chat = null;
      const body = h('div.coop-layout');
      root.append(body);

      function select(id) {
        selected = id;
        GB.store.set('ui', { ...GB.store.get('ui'), coopRoom: id });
        render();
      }

      function render() {
        const rooms = GB.coop.rooms();
        if (selected && !GB.coop.room(selected)) selected = null;
        if (!selected && rooms.length) selected = rooms[0].id;
        if (chat) chat.destroy();
        chat = null;
        body.innerHTML = '';
        shell.setSub(rooms.length ? `${rooms.length} ${GB.plural(rooms.length, 'проект', 'проекта', 'проектов')}` : 'совместная работа в реальном времени');

        if (!rooms.length) {
          body.append(
            h(
              'div.coop-empty',
              h(
                'div.coop-card.glass',
                { onclick: async () => select(await createDialog()) },
                h('div.big', '✨'),
                h('h2', 'Создать совместный проект'),
                h('div.muted', 'Общие задачи, доска с курсорами участников и чат. Партнёр заходит по ссылке.')
              ),
              h(
                'div.coop-card.glass',
                { onclick: async () => select(await joinDialog()) },
                h('div.big', '🔗'),
                h('h2', 'Присоединиться по ссылке'),
                h('div.muted', 'Получили приглашение glassboard://join/…? Вставьте его сюда.')
              )
            )
          );
          return;
        }

        const room = GB.coop.room(selected);
        const live = GB.coop.live(selected);
        const me = GB.store.profile || {};

        // left: rooms
        const list = h(
          'div.coop-rooms.glass',
          rooms.map((r) => {
            const lv = GB.coop.live(r.id);
            const unread = GB.coop.unread[r.id];
            return h(
              'button.coop-room',
              { class: r.id === selected ? 'on' : '', onclick: () => select(r.id) },
              h('span.status-dot', { class: lv.status }),
              h('div', { style: { minWidth: 0, flex: 1 } }, h('h3', r.name), h('div.faint', { style: { fontSize: '11.5px' } }, lv.peers.length ? `${lv.peers.length + 1} в сети` : statusLabel(lv))),
              unread ? h('span.badge-dot', unread) : null
            );
          }),
          h('div.spacer'),
          h('button.btn.small', { onclick: async () => select((await createDialog()) || selected) }, '+ Новый'),
          h('button.btn.small.ghost', { onclick: async () => select((await joinDialog()) || selected) }, 'По ссылке')
        );

        // right: room
        chat = GB.coop.chatPanel(room.id);
        const people = [{ name: me.name + ' (вы)', color: me.color }, ...live.peers];
        const detail = h(
          'div.coop-room-detail',
          h(
            'div.coop-head.glass',
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('h2', room.name),
              h(
                'div.row',
                { style: { marginTop: '6px' } },
                h('span.chip', h('span.status-dot', { class: live.status }), statusLabel(live)),
                h('span.chip', room.role === 'host' ? 'вы создатель' : 'вы участник'),
                live.error && live.status !== 'online' ? h('span.chip.overdue', live.error) : null,
                !live.ready && room.role === 'guest' ? h('span.chip.today', 'ждём партнёра в сети, чтобы получить данные') : null
              )
            ),
            h('div.coop-people', people.map((p) => avatar(p, 32)))
          ),
          h(
            'div.row',
            { style: { gap: '8px', flexWrap: 'wrap' } },
            h(
              'button.btn.primary',
              {
                disabled: !room.boardId,
                onclick: () => {
                  GB.store.set('ui', { ...GB.store.get('ui'), boardId: room.boardId });
                  GB.shell.go('board');
                },
              },
              '▦ Открыть доску'
            ),
            h(
              'button.btn',
              {
                disabled: !room.projectId,
                onclick: () => {
                  GB.store.set('ui', { ...GB.store.get('ui'), projectId: room.projectId });
                  GB.shell.go('tasks');
                },
              },
              '✓ Задачи проекта'
            ),
            h(
              'button.btn',
              {
                onclick: async () => {
                  const link = await window.glass.coop.invite(room.id);
                  await window.glass.copy(link);
                  GB.toast('Ссылка-приглашение скопирована');
                },
              },
              '🔗 Пригласить'
            ),
            h('div.spacer'),
            h(
              'button.btn.ghost.danger',
              {
                onclick: async () => {
                  const res = await GB.prompt({
                    title: 'Покинуть проект?',
                    text: 'Вы перестанете получать изменения. Напишите «удалить», чтобы стереть задачи и доску этого проекта у себя, или оставьте пустым, чтобы сохранить копию.',
                    fields: [{ name: 'del', placeholder: 'оставить копию' }],
                    ok: 'Покинуть',
                    danger: true,
                  });
                  if (!res) return;
                  await window.glass.coop.leave(room.id, { keepData: res.del.trim().toLowerCase() !== 'удалить' });
                  selected = null;
                },
              },
              'Покинуть'
            )
          ),
          room.localRelay && GB.coop.status.localRelay
            ? h(
                'div.muted',
                { style: { fontSize: '12px' } },
                `Сервер связи работает на этом компьютере (${GB.coop.status.localRelay.urls.join(', ') || 'порт ' + GB.coop.status.localRelay.port}). Пока приложение открыто, партнёры в вашей сети могут подключаться.`
              )
            : null,
          h('div.coop-chat.glass', chat.el)
        );
        body.append(list, detail);
      }

      const offs = [
        GB.store.on('coop', (_v) => {
          // re-render the shell only when the set of rooms changes; chat re-renders itself
          const ids = GB.coop.rooms().map((r) => r.id + r.name + !!r.projectId).join();
          if (ids !== lastIds) {
            lastIds = ids;
            render();
          }
        }),
        GB.coop.on(() => {
          const sig = JSON.stringify(GB.coop.status.rooms.map((r) => [r.id, r.status, r.ready, r.peers.map((p) => p.id)])) + JSON.stringify(GB.coop.unread);
          if (sig !== lastSig) {
            lastSig = sig;
            render();
          }
        }),
      ];
      let lastIds = GB.coop.rooms().map((r) => r.id + r.name + !!r.projectId).join();
      let lastSig = '';
      GB.coop.refresh();
      render();
      if (opts.invite) setTimeout(async () => select((await joinDialog(opts.invite)) || selected), 50);

      return {
        actions(el) {
          el.append(
            h('button.btn', { onclick: async () => select((await joinDialog()) || selected) }, '🔗 По ссылке'),
            h('button.btn.primary', { onclick: async () => select((await createDialog()) || selected) }, '+ Совместный проект')
          );
        },
        destroy() {
          offs.forEach((off) => off());
          if (chat) chat.destroy();
        },
      };
    },
  };
})(window.GB);
