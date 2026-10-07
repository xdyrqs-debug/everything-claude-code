'use strict';

// Small DOM + data helpers shared by every view. Everything lives on window.GB.
window.GB = window.GB || {};

(function (GB) {
  GB.uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  GB.clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  GB.debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  GB.clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

  // h('div.card.glass', { onclick, style: {...}, dataset: {...} }, child, 'text', [children])
  GB.h = function h(tag, props, ...children) {
    const [name, ...classes] = tag.split('.');
    const node = document.createElement(name || 'div');
    if (classes.length) node.className = classes.join(' ');
    if (props != null && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
      children.unshift(props);
      props = null;
    }
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'class') node.className += (node.className ? ' ' : '') + value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key in node && key !== 'list') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    const append = (c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) c.forEach(append);
      else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    children.forEach(append);
    return node;
  };

  GB.svg = function svg(tag, attrs = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
    return node;
  };

  GB.hexToRgb = (hex) => {
    let h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return [128, 128, 128];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  GB.isLightColor = (hex) => {
    const [r, g, b] = GB.hexToRgb(hex);
    return 0.299 * r + 0.587 * g + 0.114 * b > 150;
  };

  GB.rgba = (hex, a) => `rgba(${GB.hexToRgb(hex).join(',')},${a})`;

  // Dates are stored as 'YYYY-MM-DD' strings in local time.
  GB.todayStr = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  GB.formatDue = (due) => {
    if (!due) return null;
    const today = GB.todayStr();
    if (due === today) return { text: 'Сегодня', cls: 'today' };
    if (due === GB.todayStr(1)) return { text: 'Завтра', cls: '' };
    if (due < today) {
      const d = new Date(due + 'T00:00');
      return { text: d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }), cls: 'overdue' };
    }
    const d = new Date(due + 'T00:00');
    return { text: d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }), cls: '' };
  };

  GB.plural = (n, one, few, many) => {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  };

  // Strip anything that is not simple rich text before putting note HTML in the DOM.
  const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'BR', 'P', 'DIV', 'SPAN', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'PRE', 'HR', 'LABEL', 'INPUT']);
  GB.sanitize = (html) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    const walk = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (!ALLOWED.has(child.tagName)) {
            if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(child.tagName)) child.remove();
            else {
              walk(child);
              child.replaceWith(...child.childNodes);
            }
            continue;
          }
          for (const attr of [...child.attributes]) {
            const keep =
              (child.tagName === 'INPUT' && ['type', 'checked'].includes(attr.name)) ||
              (attr.name === 'class' && /^(todo|todo-done)$/.test(attr.value));
            if (!keep) child.removeAttribute(attr.name);
          }
          if (child.tagName === 'INPUT' && child.getAttribute('type') !== 'checkbox') child.remove();
          else walk(child);
        } else if (child.nodeType !== Node.TEXT_NODE) {
          child.remove();
        }
      }
    };
    walk(tpl.content);
    return tpl.innerHTML;
  };

  GB.textOf = (html) => {
    const d = document.createElement('div');
    d.innerHTML = GB.sanitize(html);
    return d.textContent || '';
  };

  // ---------- transient UI ----------

  GB.toast = (text, ms = 2200) => {
    const t = GB.h('div.toast.glass', text);
    document.body.append(t);
    setTimeout(() => t.remove(), ms);
  };

  GB.closeMenus = () => document.querySelectorAll('.menu').forEach((m) => m.remove());

  // items: [{ label, icon, onClick, danger } | 'sep' | Node]
  GB.menu = (x, y, items) => {
    GB.closeMenus();
    const menu = GB.h('div.menu.glass');
    for (const it of items) {
      if (!it) continue;
      if (it === 'sep') menu.append(GB.h('hr'));
      else if (it instanceof Node) menu.append(it);
      else
        menu.append(
          GB.h(
            'button',
            {
              class: it.danger ? 'danger' : '',
              onclick: (e) => {
                e.stopPropagation();
                GB.closeMenus();
                it.onClick();
              },
            },
            GB.h('span', { style: { width: '18px', textAlign: 'center' } }, it.icon || ''),
            it.label
          )
        );
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
    setTimeout(() => {
      const off = (e) => {
        if (!menu.contains(e.target)) {
          menu.remove();
          window.removeEventListener('pointerdown', off, true);
        }
      };
      window.addEventListener('pointerdown', off, true);
    });
    return menu;
  };

  // Promise-based modal; fields: [{ name, label, type, value, placeholder }]
  GB.prompt = ({ title, text, fields = [], ok = 'OK', danger = false }) =>
    new Promise((resolve) => {
      const inputs = {};
      const close = (val) => {
        back.remove();
        resolve(val);
      };
      const form = GB.h(
        'form.modal.glass',
        {
          onsubmit: (e) => {
            e.preventDefault();
            const out = {};
            for (const [k, el] of Object.entries(inputs)) out[k] = el.value;
            close(out);
          },
        },
        GB.h('h2', title),
        text ? GB.h('div.muted', text) : null,
        fields.map((f) => {
          inputs[f.name] = GB.h('input.input', {
            type: f.type || 'text',
            value: f.value || '',
            placeholder: f.placeholder || '',
            autocomplete: 'off',
          });
          return GB.h('div.field', f.label ? GB.h('label', f.label) : null, inputs[f.name]);
        }),
        GB.h(
          'div.row',
          GB.h('div.spacer'),
          GB.h('button.btn', { type: 'button', onclick: () => close(null) }, 'Отмена'),
          GB.h('button.btn.primary', { type: 'submit', style: danger ? { background: '#ff453a' } : null }, ok)
        )
      );
      const back = GB.h('div.modal-back', { onpointerdown: (e) => e.target === back && close(null) }, form);
      back.addEventListener('keydown', (e) => e.key === 'Escape' && close(null));
      document.body.append(back);
      const first = Object.values(inputs)[0];
      (first || form.querySelector('.primary')).focus();
      if (first) first.select();
    });

  GB.confirm = (title, text, ok = 'Удалить') =>
    GB.prompt({ title, text, ok, danger: true }).then((r) => r !== null);

  GB.isTyping = (e) => {
    const t = e.target;
    return t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
  };

  GB.PALETTE = ['#ffd60a', '#ff9f0a', '#ff6b6b', '#ff7ab6', '#bf5af2', '#7aa2ff', '#64d2ff', '#30d158', '#a2e36b', '#ffffff', '#8e8e93', '#1c1c1e'];
})(window.GB);
