'use strict';

(function (GB) {
  // ---------------------------------------------------------------- store
  // Mirrors the decrypted profile data held by the main process. Writes are
  // applied locally at once and sent to main (debounced per key), which saves
  // them and forwards the change to every other window (e.g. note windows).

  const listeners = new Map();
  const pending = new Map();

  GB.store = {
    data: null,
    profile: null,

    async load() {
      const { data, profile } = await window.glass.state.get();
      this.data = data;
      this.profile = profile;
      return data;
    },

    get(key) {
      return this.data ? this.data[key] : undefined;
    },

    set(key, value, source = 'local') {
      this.data[key] = value;
      emit(key, value, source);
      clearTimeout(pending.get(key));
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          window.glass.state.set(key, this.data[key]).catch((err) => console.warn(err));
        }, 120)
      );
    },

    // Mutate a collection in place and publish it.
    update(key, fn, source) {
      const value = this.data[key];
      const result = fn(value);
      this.set(key, result === undefined ? value : result, source);
    },

    on(key, fn) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => listeners.get(key).delete(fn);
    },

    flushNow() {
      for (const [key, timer] of pending) {
        clearTimeout(timer);
        window.glass.state.set(key, this.data[key]).catch(() => {});
      }
      pending.clear();
    },
  };

  function emit(key, value, source) {
    for (const fn of listeners.get(key) || []) {
      try {
        fn(value, source);
      } catch (err) {
        console.error(err);
      }
    }
  }

  window.glass.state.onChanged(({ key, value }) => {
    if (!GB.store.data || pending.has(key)) return;
    GB.store.data[key] = value;
    emit(key, value, 'remote');
  });

  window.addEventListener('beforeunload', () => GB.store.data && GB.store.flushNow());

  // ---------------------------------------------------------------- theme

  const SYS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif';
  GB.FONTS = [
    { name: 'Системный (SF Pro / Segoe)', stack: SYS },
    {
      name: 'Системный Display',
      stack: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif',
    },
    { name: 'Скруглённый (SF Rounded)', stack: 'ui-rounded, "SF Pro Rounded", Nunito, "Varela Round", "Segoe UI", system-ui, sans-serif' },
    { name: 'Helvetica Neue', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
    { name: 'Avenir Next', stack: '"Avenir Next", Avenir, "Century Gothic", "Segoe UI", sans-serif' },
    { name: 'Futura', stack: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif' },
    { name: 'Gill Sans', stack: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif' },
    { name: 'Verdana', stack: 'Verdana, Geneva, Tahoma, sans-serif' },
    { name: 'Засечки (New York / Georgia)', stack: '"New York", ui-serif, Georgia, "Times New Roman", serif' },
    { name: 'Palatino', stack: 'Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif' },
    { name: 'Garamond', stack: 'Garamond, "EB Garamond", Baskerville, "Times New Roman", serif' },
    { name: 'Моноширинный', stack: 'ui-monospace, "SF Mono", Menlo, Consolas, "JetBrains Mono", "DejaVu Sans Mono", monospace' },
    { name: 'Рукописный', stack: '"Marker Felt", "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive' },
  ];

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  GB.theme = {
    current: null,
    resolve(theme) {
      return theme === 'system' || !theme ? (darkQuery.matches ? 'dark' : 'light') : theme;
    },
    apply(s) {
      if (!s) return;
      this.current = s;
      const root = document.documentElement;
      root.dataset.theme = this.resolve(s.theme);
      root.dataset.backdrop = s.backdrop || 'aurora';
      const set = (k, v) => v != null && root.style.setProperty(k, v);
      if (s.tint) set('--tint-rgb', GB.hexToRgb(s.tint).join(', '));
      if (s.accent) {
        set('--accent', s.accent);
        set('--accent-rgb', GB.hexToRgb(s.accent).join(', '));
      }
      if (s.windowOpacity != null) set('--win-alpha', s.windowOpacity);
      if (s.panelOpacity != null) set('--panel-alpha', s.panelOpacity);
      if (s.blur != null) set('--blur', s.blur + 'px');
      for (const level of ['h1', 'h2', 'h3', 'body']) {
        const f = s.fonts && s.fonts[level];
        if (!f) continue;
        set(`--font-${level}`, f.family);
        set(`--size-${level}`, f.size + 'px');
        set(`--weight-${level}`, f.weight);
      }
    },
  };
  darkQuery.addEventListener('change', () => GB.theme.current && GB.theme.apply(GB.theme.current));
  document.documentElement.classList.add('platform-' + window.glass.platform);

  // ---------------------------------------------------------------- undo history

  GB.History = class History {
    constructor(limit = 80) {
      this.limit = limit;
      this.past = [];
      this.future = [];
    }
    push(snapshot) {
      this.past.push(JSON.stringify(snapshot));
      if (this.past.length > this.limit) this.past.shift();
      this.future = [];
    }
    undo(current) {
      if (!this.past.length) return null;
      this.future.push(JSON.stringify(current));
      return JSON.parse(this.past.pop());
    }
    redo(current) {
      if (!this.future.length) return null;
      this.past.push(JSON.stringify(current));
      return JSON.parse(this.future.pop());
    }
    clear() {
      this.past = [];
      this.future = [];
    }
  };

  // ---------------------------------------------------------------- pan & zoom

  GB.Viewport = class Viewport {
    constructor(canvas, world, { state, onChange, canPan }) {
      this.canvas = canvas;
      this.world = world;
      this.x = state.x || 0;
      this.y = state.y || 0;
      this.zoom = state.zoom || 1;
      this.onChange = onChange || (() => {});
      this.canPan = canPan || (() => false);
      this.spaceDown = false;
      this.apply();

      canvas.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            const factor = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025) * 2);
            this.zoomAt(e.clientX, e.clientY, this.zoom * factor);
          } else {
            this.x -= e.deltaX;
            this.y -= e.deltaY;
            this.apply(true);
          }
        },
        { passive: false }
      );

      canvas.addEventListener('pointerdown', (e) => {
        const pan = e.button === 1 || (e.button === 0 && (this.spaceDown || this.canPan(e)));
        if (!pan) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const sx = e.clientX - this.x;
        const sy = e.clientY - this.y;
        canvas.classList.add('panning');
        canvas.setPointerCapture(e.pointerId);
        const move = (ev) => {
          this.x = ev.clientX - sx;
          this.y = ev.clientY - sy;
          this.apply(true);
        };
        const up = () => {
          canvas.classList.remove('panning');
          canvas.removeEventListener('pointermove', move);
          canvas.removeEventListener('pointerup', up);
        };
        canvas.addEventListener('pointermove', move);
        canvas.addEventListener('pointerup', up);
      }, true);

      this.onKey = (e) => {
        if (e.code === 'Space' && !GB.isTyping(e)) {
          if (e.type === 'keydown' && !this.spaceDown) {
            this.spaceDown = true;
            canvas.classList.add('hand');
          } else if (e.type === 'keyup') {
            this.spaceDown = false;
            canvas.classList.remove('hand');
          }
          if (canvas.isConnected) e.preventDefault();
        }
      };
      window.addEventListener('keydown', this.onKey);
      window.addEventListener('keyup', this.onKey);
    }

    destroy() {
      window.removeEventListener('keydown', this.onKey);
      window.removeEventListener('keyup', this.onKey);
    }

    apply(notify) {
      this.world.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.zoom})`;
      const g = 24 * this.zoom;
      this.canvas.style.backgroundSize = `${g}px ${g}px`;
      this.canvas.style.backgroundPosition = `${this.x}px ${this.y}px`;
      if (notify) this.onChange(this.state());
    }

    state() {
      return { x: Math.round(this.x), y: Math.round(this.y), zoom: +this.zoom.toFixed(3) };
    }

    zoomAt(clientX, clientY, zoom) {
      const rect = this.canvas.getBoundingClientRect();
      const z = GB.clamp(zoom, 0.1, 4);
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      this.x = px - ((px - this.x) * z) / this.zoom;
      this.y = py - ((py - this.y) * z) / this.zoom;
      this.zoom = z;
      this.apply(true);
    }

    zoomBy(factor) {
      const r = this.canvas.getBoundingClientRect();
      this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, this.zoom * factor);
    }

    toWorld(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: (clientX - rect.left - this.x) / this.zoom, y: (clientY - rect.top - this.y) / this.zoom };
    }

    center() {
      const r = this.canvas.getBoundingClientRect();
      return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
    }

    fit(box, padding = 80) {
      const r = this.canvas.getBoundingClientRect();
      if (!box || !r.width) return;
      const w = Math.max(box.w, 1);
      const hgt = Math.max(box.h, 1);
      this.zoom = GB.clamp(Math.min((r.width - padding * 2) / w, (r.height - padding * 2) / hgt), 0.15, 1.5);
      this.x = r.width / 2 - (box.x + w / 2) * this.zoom;
      this.y = r.height / 2 - (box.y + hgt / 2) * this.zoom;
      this.apply(true);
    }
  };

  // ---------------------------------------------------------------- icons

  const ICONS = {
    select: '<path d="M5 3l14 8-6 2-2 6z" fill="currentColor"/>',
    hand: '<path d="M8 13V5.5a1.5 1.5 0 013 0V11m0-1V4.5a1.5 1.5 0 013 0V11m0-.5V6a1.5 1.5 0 013 0v8a6 6 0 01-6 6h-1a6 6 0 01-5-2.7L3.3 13.6a1.5 1.5 0 012.4-1.8L8 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    sticky: '<path d="M4 4h16v10l-6 6H4z M14 20v-6h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    text: '<path d="M5 6V4h14v2M12 4v16M9 20h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    rect: '<rect x="4" y="5" width="16" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="7" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    frame: '<path d="M7 3v18M17 3v18M3 7h18M3 17h18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    connector: '<path d="M5 19L19 5M19 5h-7M19 5v7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    pen: '<path d="M4 20l4-1 11-11-3-3L5 16zM14 6l3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    task: '<rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 12l2.5 2.5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    undo: '<path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -3)"/>',
    redo: '<path d="M15 7l5 5-5 5M20 12H9a5 5 0 000 10h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -3)"/>',
    fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    pin: '<path d="M9 4h6l-1 5 3 3H7l3-3zM12 12v8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>',
  };
  GB.icon = (name) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.innerHTML = ICONS[name] || '';
    return s;
  };
})(window.GB);
