'use strict';

const SYSTEM_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif';
const DISPLAY_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif';
const ROUNDED_FONT = 'ui-rounded, "SF Pro Rounded", Nunito, "Varela Round", "Segoe UI", system-ui, sans-serif';

function defaultSettings() {
  return {
    theme: 'system', // 'light' | 'dark' | 'system'
    windowOpacity: 0.55, // alpha of the main window tint
    panelOpacity: 0.45, // alpha of glass panels/cards
    blur: 28, // px, backdrop blur of panels
    tint: '#9db4ff', // window colour
    accent: '#0a84ff',
    backdrop: 'aurora', // 'aurora' | 'clear' — aurora draws colour blobs behind the glass
    nativeBlur: true, // macOS vibrancy / Windows acrylic
    noteColor: '#ffd60a',
    noteOpacity: 0.7,
    fonts: {
      h1: { family: DISPLAY_FONT, size: 28, weight: 700 },
      h2: { family: DISPLAY_FONT, size: 20, weight: 650 },
      h3: { family: ROUNDED_FONT, size: 15, weight: 600 },
      body: { family: SYSTEM_FONT, size: 14, weight: 400 },
    },
    autoLockMinutes: 15, // 0 disables
    lockOnSleep: true,
  };
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function defaultData(name = '') {
  const now = Date.now();
  const inbox = { id: 'inbox', name: 'Входящие', color: '#0a84ff', icon: '📥' };
  const rootId = uid();
  return {
    version: 1,
    settings: defaultSettings(),
    projects: [inbox, { id: uid(), name: 'Личное', color: '#ff9f0a', icon: '🌿' }],
    tasks: [
      {
        id: uid(),
        title: 'Добро пожаловать в Glassboard',
        description:
          'Разбивайте задачи на подзадачи, перетаскивайте карточки между колонками и закрепляйте важное как записку на экране.',
        status: 'todo',
        priority: 2,
        due: null,
        tags: ['старт'],
        subtasks: [
          { id: uid(), title: 'Открыть настройки и выбрать тему', done: false },
          { id: uid(), title: 'Создать записку и закрепить её поверх окон', done: false },
          { id: uid(), title: 'Набросать mind map проекта', done: false },
        ],
        projectId: 'inbox',
        createdAt: now,
        order: 0,
      },
    ],
    notes: [],
    boards: [{ id: uid(), name: 'Моя доска', items: [], connectors: [], viewport: { x: 0, y: 0, zoom: 1 } }],
    mindmaps: [
      {
        id: uid(),
        name: 'Идеи',
        viewport: { x: 0, y: 0, zoom: 1 },
        root: {
          id: rootId,
          text: name ? `Цели: ${name}` : 'Главная цель',
          collapsed: false,
          children: [
            { id: uid(), text: 'Работа', collapsed: false, children: [] },
            { id: uid(), text: 'Здоровье', collapsed: false, children: [] },
            { id: uid(), text: 'Обучение', collapsed: false, children: [] },
          ],
        },
      },
    ],
    ui: { view: 'tasks', taskLayout: 'kanban', projectId: 'all', boardId: null, mindmapId: null },
    coop: { rooms: [] },
  };
}

// Fill in keys added in newer versions without touching user data.
function migrate(data) {
  const base = defaultData();
  const out = { ...base, ...data };
  out.settings = { ...base.settings, ...(data.settings || {}) };
  out.settings.fonts = { ...base.settings.fonts, ...((data.settings && data.settings.fonts) || {}) };
  out.ui = { ...base.ui, ...(data.ui || {}) };
  for (const key of ['projects', 'tasks', 'notes', 'boards', 'mindmaps']) {
    if (!Array.isArray(out[key])) out[key] = base[key];
  }
  if (!out.projects.some((p) => p.id === 'inbox')) out.projects.unshift(base.projects[0]);
  if (!out.coop || !Array.isArray(out.coop.rooms)) out.coop = { rooms: [] };
  return out;
}

module.exports = { defaultData, defaultSettings, migrate, uid };
