'use strict';

// Lock screen: pick a profile and enter its password, or create a new profile
// (name + password chosen by the user). The password never leaves the main
// process except as the input to scrypt.

(function (GB) {
  const { h } = GB;
  const COLORS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#30d158', '#64d2ff', '#8e8e93'];
  const LAST_KEY = 'glassboard:lastProfile';

  const avatar = (p) => h('div.avatar', { style: { background: p.color } }, (p.name || '?').trim().charAt(0).toUpperCase());

  GB.lock = {
    root: null,
    onUnlocked: null,

    async show(onUnlocked) {
      this.onUnlocked = onUnlocked;
      this.root = document.getElementById('lock');
      this.root.classList.remove('hidden');
      const { profiles } = await window.glass.auth.profiles();
      if (profiles.length) this.renderLogin(profiles);
      else this.renderCreate(false);
    },

    hide() {
      this.root.classList.add('hidden');
      this.root.innerHTML = '';
    },

    card(...children) {
      this.root.innerHTML = '';
      const card = h('div.lock-card.glass.no-drag', h('div.logo', '◐'), ...children);
      this.root.append(h('div.drag', { style: { position: 'absolute', inset: '0 0 auto 0', height: '40px' } }), card);
      return card;
    },

    fail(card, errorEl, message) {
      errorEl.textContent = message;
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
    },

    renderLogin(profiles) {
      let selected = profiles.find((p) => p.id === localStorage.getItem(LAST_KEY)) || profiles[0];
      const error = h('div.error');
      const pass = h('input.input', { type: 'password', placeholder: 'Пароль', autocomplete: 'current-password' });
      const submit = h('button.btn.primary', { type: 'submit' }, 'Войти');
      const title = h('h2');

      const list = h('div.profiles');
      const renderPicks = () => {
        list.innerHTML = '';
        title.textContent = `Привет, ${selected.name}`;
        for (const p of profiles) {
          list.append(
            h(
              'button.profile-pick',
              {
                type: 'button',
                class: p.id === selected.id ? 'on' : '',
                onclick: () => {
                  selected = p;
                  error.textContent = '';
                  renderPicks();
                  pass.focus();
                },
              },
              avatar(p),
              h('span', p.name)
            )
          );
        }
      };
      renderPicks();

      const card = this.card(
        title,
        h('div.muted', { style: { marginTop: '4px' } }, 'Введите пароль, чтобы открыть пространство'),
        profiles.length > 1 ? list : null,
        h(
          'form',
          {
            onsubmit: async (e) => {
              e.preventDefault();
              if (!pass.value) return pass.focus();
              submit.disabled = true;
              submit.textContent = 'Проверка…';
              try {
                const res = await window.glass.auth.unlock({ id: selected.id, password: pass.value });
                localStorage.setItem(LAST_KEY, selected.id);
                pass.value = '';
                this.hide();
                this.onUnlocked(res);
              } catch (err) {
                pass.select();
                this.fail(card, error, err.message);
              } finally {
                submit.disabled = false;
                submit.textContent = 'Войти';
              }
            },
          },
          pass,
          submit,
          error
        ),
        h('button.btn.ghost.small', { type: 'button', onclick: () => this.renderCreate(true) }, '+ Добавить пользователя')
      );
      setTimeout(() => pass.focus(), 50);
    },

    renderCreate(canGoBack) {
      let color = COLORS[Math.floor(Math.random() * COLORS.length)];
      const error = h('div.error');
      const name = h('input.input', { placeholder: 'Ваше имя', maxLength: 40 });
      const pass = h('input.input', { type: 'password', placeholder: 'Придумайте пароль (от 4 символов)', autocomplete: 'new-password' });
      const pass2 = h('input.input', { type: 'password', placeholder: 'Повторите пароль', autocomplete: 'new-password' });
      const submit = h('button.btn.primary', { type: 'submit' }, 'Создать и войти');
      const colors = h('div.color-row');
      const renderColors = () => {
        colors.innerHTML = '';
        COLORS.forEach((c) =>
          colors.append(
            h('button.color-dot', {
              type: 'button',
              class: c === color ? 'on' : '',
              style: { background: c },
              onclick: () => {
                color = c;
                renderColors();
              },
            })
          )
        );
      };
      renderColors();

      const card = this.card(
        h('h2', canGoBack ? 'Новый пользователь' : 'Добро пожаловать'),
        h(
          'div.muted',
          { style: { marginTop: '4px' } },
          'Пароль шифрует все ваши данные. Восстановить его нельзя — запомните его.'
        ),
        h(
          'form',
          {
            onsubmit: async (e) => {
              e.preventDefault();
              if (!name.value.trim()) return this.fail(card, error, 'Введите имя');
              if (pass.value.length < 4) return this.fail(card, error, 'Пароль слишком короткий');
              if (pass.value !== pass2.value) return this.fail(card, error, 'Пароли не совпадают');
              submit.disabled = true;
              submit.textContent = 'Шифрование…';
              try {
                const res = await window.glass.auth.create({ name: name.value, password: pass.value, color });
                localStorage.setItem(LAST_KEY, res.profile.id);
                this.hide();
                this.onUnlocked(res);
              } catch (err) {
                this.fail(card, error, err.message);
              } finally {
                submit.disabled = false;
                submit.textContent = 'Создать и войти';
              }
            },
          },
          name,
          pass,
          pass2,
          colors,
          submit,
          error
        ),
        canGoBack ? h('button.btn.ghost.small', { type: 'button', onclick: () => this.show(this.onUnlocked) }, '← Назад') : null
      );
      setTimeout(() => name.focus(), 50);
    },
  };
})(window.GB);
