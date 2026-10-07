'use strict';

// Settings: theme, glass transparency/blur/colours, per-heading fonts,
// sticky-note defaults, security (password, auto-lock), data import/export.

(function (GB) {
  const { h } = GB;
  const TINTS = ['#9db4ff', '#c7d2fe', '#ffffff', '#a5f3fc', '#bbf7d0', '#fde68a', '#fecaca', '#f5d0fe', '#1f2937', '#000000'];
  const ACCENTS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#30d158', '#64d2ff', '#8e8e93'];
  const WEIGHTS = [
    [300, 'Light'],
    [400, 'Regular'],
    [500, 'Medium'],
    [600, 'Semibold'],
    [650, 'Semi+'],
    [700, 'Bold'],
    [800, 'Heavy'],
    [900, 'Black'],
  ];

  GB.views = GB.views || {};
  GB.views.settings = {
    title: 'Настройки',
    mount(root, shell) {
      shell.setSub('внешний вид, шрифты, безопасность');
      const wrap = h('div.settings');
      root.append(wrap);
      let localFonts = [];
      const s = () => GB.store.get('settings');
      const set = (patch) => GB.store.set('settings', { ...s(), ...patch });

      const row = (label, hint, control) => h('div.set-row', h('label', label, hint ? h('small', hint) : null), control);

      const slider = (key, min, max, step, fmt = (v) => Math.round(v * 100) + '%') => {
        const val = h('span.val', fmt(s()[key]));
        const input = h('input', {
          type: 'range',
          min,
          max,
          step,
          value: s()[key],
          oninput: () => {
            val.textContent = fmt(Number(input.value));
            set({ [key]: Number(input.value) });
          },
        });
        return h('div.row', input, val);
      };

      const seg = (options, value, onPick) =>
        h(
          'div.segmented',
          options.map(([v, label]) =>
            h('button', {
              class: v === value ? 'on' : '',
              onclick: (e) => {
                onPick(v);
                e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
                e.currentTarget.classList.add('on');
              },
            }, label)
          )
        );

      const toggle = (checked, onChange, disabled) =>
        h('label.switch', h('input', { type: 'checkbox', checked, disabled, onchange: (e) => onChange(e.target.checked) }), h('span'));

      const colorPicker = (key, presets) => {
        const holder = h('div.row', { style: { flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: '260px' } });
        const draw = () => {
          holder.innerHTML = '';
          holder.append(
            ...presets.map((c) =>
              h('button.swatch', {
                title: c,
                style: { background: c, outline: s()[key] === c ? '2px solid var(--accent)' : 'none', outlineOffset: '2px' },
                onclick: () => {
                  set({ [key]: c });
                  draw();
                },
              })
            ),
            h('input', {
              type: 'color',
              value: s()[key],
              title: 'Свой цвет',
              style: { width: '26px', height: '26px' },
              oninput: (e) => set({ [key]: e.target.value }),
              onchange: draw,
            })
          );
        };
        draw();
        return holder;
      };

      // ---------- appearance ----------
      const nativeSupported = ['darwin', 'win32'].includes(window.glass.platform);
      const appearance = h(
        'section.glass',
        h('h2', 'Внешний вид'),
        row(
          'Тема',
          null,
          seg(
            [
              ['light', '☀︎ Светлая'],
              ['dark', '☾ Тёмная'],
              ['system', 'Авто'],
            ],
            s().theme,
            (v) => set({ theme: v })
          )
        ),
        row('Цвет окна', 'Оттенок стекла', colorPicker('tint', TINTS)),
        row('Акцент', 'Кнопки, выделение, ссылки', colorPicker('accent', ACCENTS)),
        row('Прозрачность окна', 'Чем меньше — тем больше видно рабочий стол', slider('windowOpacity', 0.05, 1, 0.01)),
        row('Плотность панелей', 'Непрозрачность стеклянных карточек', slider('panelOpacity', 0.05, 0.95, 0.01)),
        row('Размытие', 'Сила blur под панелями', slider('blur', 0, 60, 1, (v) => Math.round(v) + 'px')),
        row(
          'Фон',
          'Аврора рисует мягкие цветные пятна под стеклом',
          seg(
            [
              ['aurora', 'Аврора'],
              ['clear', 'Прозрачный'],
            ],
            s().backdrop,
            (v) => set({ backdrop: v })
          )
        ),
        row(
          'Системное размытие',
          nativeSupported
            ? window.glass.platform === 'darwin'
              ? 'macOS vibrancy — размывает рабочий стол за окном'
              : 'Windows 11 Acrylic — размывает рабочий стол за окном'
            : 'Недоступно в этой ОС — используйте «Аврору»',
          toggle(s().nativeBlur && nativeSupported, (v) => set({ nativeBlur: v }), !nativeSupported)
        )
      );

      // ---------- fonts ----------
      const preview = h(
        'div.font-preview',
        h('h1', 'Заголовок 1 — Проект'),
        h('h2', 'Заголовок 2 — Раздел'),
        h('h3', 'Заголовок 3 — Карточка задачи'),
        h('div', 'Основной текст: быстрая коричневая лиса перепрыгивает через ленивую собаку. 0123456789')
      );
      const fontsList = h('datalist', { id: 'font-names' });
      const fontRow = (level, label) => {
        const f = () => s().fonts[level];
        const setFont = (patch) => set({ fonts: { ...s().fonts, [level]: { ...f(), ...patch } } });
        const known = GB.FONTS.find((x) => x.stack === f().family);
        const custom = h('input.input', {
          placeholder: 'Название шрифта',
          value: known ? '' : f().family.replace(/^"|"(,.*)?$/g, ''),
          class: known ? 'hidden' : '',
          style: { gridColumn: '2 / 5' },
          onchange: () => custom.value.trim() && setFont({ family: `"${custom.value.trim().replace(/"/g, '')}", ${GB.FONTS[0].stack}` }),
        });
        custom.setAttribute('list', 'font-names');
        const select = h(
          'select.input',
          {
            onchange: () => {
              if (select.value === '__custom') {
                custom.classList.remove('hidden');
                custom.focus();
              } else {
                custom.classList.add('hidden');
                setFont({ family: select.value });
              }
            },
          },
          GB.FONTS.map((x) => h('option', { value: x.stack, selected: x.stack === f().family, style: { fontFamily: x.stack } }, x.name)),
          h('option', { value: '__custom', selected: !known }, 'Свой шрифт…')
        );
        const size = h('input.input', {
          type: 'number',
          min: 9,
          max: 72,
          value: f().size,
          title: 'Размер, px',
          onchange: () => setFont({ size: GB.clamp(Number(size.value) || f().size, 9, 72) }),
        });
        const weight = h(
          'select.input',
          { title: 'Насыщенность', onchange: () => setFont({ weight: Number(weight.value) }) },
          WEIGHTS.map(([w, name]) => h('option', { value: w, selected: w === f().weight }, name))
        );
        return h('div', h('div.font-row', h('span', { class: level === 'body' ? '' : 'h3' }, label), select, size, weight), h('div.font-row', h('span'), custom));
      };
      const fonts = h(
        'section.glass',
        h('h2', 'Шрифты'),
        h('div.muted', { style: { fontSize: '12.5px', marginBottom: '6px' } }, 'Отдельный шрифт, размер и насыщенность для каждого уровня заголовков.'),
        fontRow('h1', 'H1'),
        fontRow('h2', 'H2'),
        fontRow('h3', 'H3'),
        fontRow('body', 'Текст'),
        fontsList,
        preview,
        h(
          'div.row',
          { style: { marginTop: '10px' } },
          h('div.spacer'),
          h(
            'button.btn.small',
            {
              onclick: () => {
                set({ fonts: GB.clone(DEFAULT_FONTS) });
                renderAll();
              },
            },
            'Сбросить шрифты'
          )
        )
      );

      // ---------- notes ----------
      const notes = h(
        'section.glass',
        h('h2', 'Записки'),
        row('Цвет по умолчанию', null, colorPicker('noteColor', GB.PALETTE.slice(0, 10))),
        row('Непрозрачность по умолчанию', 'У каждой записки можно поменять отдельно', slider('noteOpacity', 0.15, 1, 0.01))
      );

      // ---------- security ----------
      const profile = GB.store.profile || {};
      const autoLock = h(
        'select.input',
        { style: { width: '160px' }, onchange: () => set({ autoLockMinutes: Number(autoLock.value) }) },
        [
          [0, 'Никогда'],
          [1, '1 минута'],
          [5, '5 минут'],
          [15, '15 минут'],
          [30, '30 минут'],
          [60, '1 час'],
        ].map(([v, l]) => h('option', { value: v, selected: v === s().autoLockMinutes }, l))
      );
      const security = h(
        'section.glass',
        h('h2', 'Безопасность'),
        h('div.muted', { style: { fontSize: '12.5px' } }, 'Данные профиля зашифрованы AES-256-GCM ключом из вашего пароля (scrypt). Без пароля их не прочитать.'),
        row(
          'Профиль',
          null,
          h(
            'div.row',
            h('div.avatar', { style: { background: profile.color, width: '28px', height: '28px' } }, (profile.name || '?').charAt(0).toUpperCase()),
            h(
              'button.btn.small',
              {
                onclick: async () => {
                  const res = await GB.prompt({ title: 'Имя профиля', fields: [{ name: 'name', value: profile.name }], ok: 'Сохранить' });
                  if (!res || !res.name.trim()) return;
                  GB.store.profile = await window.glass.auth.updateProfile({ name: res.name });
                  GB.toast('Имя обновлено');
                },
              },
              profile.name || 'Переименовать'
            )
          )
        ),
        row('Автоблокировка', 'При бездействии компьютера', autoLock),
        row('Блокировать при сне', 'И при блокировке экрана системы', toggle(s().lockOnSleep, (v) => set({ lockOnSleep: v }))),
        row(
          'Пароль',
          null,
          h(
            'button.btn.small',
            {
              onclick: async () => {
                const res = await GB.prompt({
                  title: 'Сменить пароль',
                  fields: [
                    { name: 'old', label: 'Текущий пароль', type: 'password' },
                    { name: 'next', label: 'Новый пароль', type: 'password' },
                    { name: 'again', label: 'Повторите новый пароль', type: 'password' },
                  ],
                  ok: 'Сменить',
                });
                if (!res) return;
                if (res.next !== res.again) return GB.toast('Новые пароли не совпадают');
                try {
                  await window.glass.auth.changePassword({ oldPassword: res.old, newPassword: res.next });
                  GB.toast('Пароль изменён');
                } catch (err) {
                  GB.toast(err.message);
                }
              },
            },
            'Сменить пароль'
          )
        ),
        row('Заблокировать сейчас', 'Ctrl/⌘ + L', h('button.btn.small', { onclick: () => window.glass.auth.lock() }, '🔒 Заблокировать'))
      );

      // ---------- data ----------
      const data = h(
        'section.glass',
        h('h2', 'Данные'),
        row(
          'Экспорт',
          'JSON-файл без шифрования — храните его в надёжном месте',
          h(
            'button.btn.small',
            {
              onclick: async () => {
                const path = await window.glass.data.export();
                if (path) GB.toast('Сохранено: ' + path);
              },
            },
            'Экспортировать'
          )
        ),
        row(
          'Импорт',
          'Заменит все данные текущего профиля',
          h(
            'button.btn.small',
            {
              onclick: async () => {
                if (!(await GB.confirm('Импортировать данные?', 'Текущие задачи, доски и записки будут заменены.', 'Импортировать'))) return;
                try {
                  const imported = await window.glass.data.import();
                  if (imported) {
                    GB.store.data = imported;
                    GB.theme.apply(imported.settings);
                    GB.toast('Данные импортированы');
                    GB.shell.go('tasks');
                  }
                } catch (err) {
                  GB.toast(err.message);
                }
              },
            },
            'Импортировать'
          )
        ),
        row(
          'Удалить профиль',
          'Безвозвратно удалит все данные этого пользователя',
          h(
            'button.btn.small.danger',
            {
              onclick: async () => {
                const res = await GB.prompt({
                  title: 'Удалить профиль?',
                  text: 'Это действие нельзя отменить. Введите пароль для подтверждения.',
                  fields: [{ name: 'password', type: 'password', label: 'Пароль' }],
                  ok: 'Удалить навсегда',
                  danger: true,
                });
                if (!res) return;
                try {
                  await window.glass.auth.deleteProfile({ password: res.password });
                } catch (err) {
                  GB.toast(err.message);
                }
              },
            },
            'Удалить'
          )
        )
      );

      // ---------- Claude (MCP) ----------
      const claude = h('section.glass', h('h2', 'Подключение Claude (MCP)'));
      const renderClaude = (st) => {
        claude.innerHTML = '';
        const desktopJson = JSON.stringify(st.desktopConfig, null, 2);
        const copyBtn = (label, text) =>
          h(
            'button.btn.small',
            {
              onclick: async () => {
                await window.glass.copy(text);
                GB.toast('Скопировано');
              },
            },
            label
          );
        const code = (text) => h('pre.code-block', text);
        claude.append(
          h('h2', 'Подключение Claude (MCP)'),
          h(
            'div.muted',
            { style: { fontSize: '12.5px' } },
            'Claude сможет смотреть и менять задачи, записки, mind map и доски, пока приложение разблокировано. Сервер слушает только этот компьютер и защищён токеном.'
          ),
          row(
            'Разрешить подключение',
            st.enabled ? (st.running ? `Работает: ${st.url}` : `Не запущен${st.error ? ': ' + st.error : ''}`) : 'Выключено',
            toggle(st.enabled, async (v) => renderClaude(await window.glass.mcp.update({ enabled: v })))
          ),
          row(
            'Разрешить изменения',
            'Выключите, чтобы Claude мог только читать',
            toggle(st.allowWrite, async (v) => renderClaude(await window.glass.mcp.update({ allowWrite: v })))
          ),
          st.enabled
            ? h(
                'div',
                h('h3', { style: { margin: '14px 0 6px' } }, 'Claude Desktop'),
                h(
                  'div.muted',
                  { style: { fontSize: '12.5px' } },
                  'Настройки Claude → Developer → Edit Config. Вставьте блок в claude_desktop_config.json (внутрь "mcpServers", если он уже есть) и перезапустите Claude.'
                ),
                code(desktopJson),
                h('div.row', { style: { marginTop: '6px' } }, h('div.spacer'), copyBtn('Скопировать конфиг', desktopJson)),
                h('h3', { style: { margin: '14px 0 6px' } }, 'Claude Code'),
                h('div.muted', { style: { fontSize: '12.5px' } }, 'Выполните в терминале:'),
                code(st.codeCommand),
                h(
                  'div.row',
                  { style: { marginTop: '6px' } },
                  h(
                    'button.btn.small.ghost',
                    {
                      onclick: async () => {
                        if (!(await GB.confirm('Сменить токен?', 'Подключённые клиенты Claude перестанут работать, пока вы не обновите их конфигурацию.', 'Сменить'))) return;
                        renderClaude(await window.glass.mcp.regenerateToken());
                      },
                    },
                    'Сменить токен'
                  ),
                  h('div.spacer'),
                  copyBtn('Скопировать команду', st.codeCommand)
                ),
                h(
                  'div.muted',
                  { style: { fontSize: '12px', marginTop: '10px' } },
                  'Попробуйте спросить Claude: «Что у меня на сегодня в Glassboard?» или «Разбей проект „Ремонт“ на задачи и закрепи план записку на экране».'
                )
              )
            : null
        );
      };
      window.glass.mcp.status().then(renderClaude);

      const shortcuts = h(
        'section.glass',
        h('h2', 'Горячие клавиши'),
        [
          ['Ctrl/⌘ 1–6', 'Переключение разделов'],
          ['Ctrl/⌘ N', 'Новая задача / записка'],
          ['Ctrl/⌘ L', 'Заблокировать'],
          ['Доска: V H N T R O F C P K', 'Инструменты'],
          ['Пробел + мышь', 'Перемещение холста'],
          ['Ctrl/⌘ + колесо', 'Масштаб'],
          ['Ctrl/⌘ Z / Shift Z', 'Отменить / повторить'],
          ['Mind map: Tab / Enter', 'Дочерний / соседний узел'],
          ['Записка: Ctrl+Alt+1/2/3', 'Заголовки H1/H2/H3'],
          ['Записка: Ctrl+Enter', 'Пункт чек-листа'],
        ].map(([k, v]) => row(v, null, h('span.chip', k)))
      );

      const DEFAULT_FONTS = {
        h1: { family: GB.FONTS[1].stack, size: 28, weight: 700 },
        h2: { family: GB.FONTS[1].stack, size: 20, weight: 650 },
        h3: { family: GB.FONTS[2].stack, size: 15, weight: 600 },
        body: { family: GB.FONTS[0].stack, size: 14, weight: 400 },
      };

      const renderAll = () => GB.shell.go('settings');

      wrap.append(appearance, fonts, claude, notes, security, data, shortcuts);

      // Offer installed font names when the platform allows it.
      if (typeof window.queryLocalFonts === 'function') {
        window
          .queryLocalFonts()
          .then((list) => {
            localFonts = [...new Set(list.map((f) => f.family))].sort();
            fontsList.append(...localFonts.map((name) => h('option', { value: name })));
          })
          .catch(() => {});
      }

      return {};
    },
  };
})(window.GB);
