'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, powerMonitor, screen, shell, clipboard } = require('electron');
const { Vault, BadPasswordError } = require('./vault');
const { defaultData, migrate } = require('./defaults');
const { McpServer } = require('./mcp');
const { CoopManager } = require('./coop');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const RENDERER = path.join(__dirname, '..', 'renderer');
const STATE_KEYS = new Set(['settings', 'projects', 'tasks', 'notes', 'boards', 'mindmaps', 'ui']);

// Linux compositors need this for real window transparency.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');

let vault;
let mcp;
let coop;
let pendingInvite = null;
let mainWindow = null;
const noteWindows = new Map(); // noteId -> BrowserWindow
let session = null; // { id, key, salt, kdf, data, profile }
let saveTimer = null;
const failedAttempts = new Map(); // profileId -> { count, until }

// ---------- appearance shared with the lock screen (not secret) ----------

function uiPrefsFile() {
  return path.join(app.getPath('userData'), 'appearance.json');
}

function readUiPrefs() {
  try {
    return JSON.parse(fs.readFileSync(uiPrefsFile(), 'utf8'));
  } catch {
    return { theme: 'system', nativeBlur: true, tint: '#9db4ff', windowOpacity: 0.55, backdrop: 'aurora' };
  }
}

function writeUiPrefs(settings) {
  const { theme, nativeBlur, tint, windowOpacity, backdrop, accent, blur, panelOpacity } = settings;
  const prefs = { theme, nativeBlur, tint, windowOpacity, backdrop, accent, blur, panelOpacity };
  try {
    fs.writeFileSync(uiPrefsFile(), JSON.stringify(prefs));
  } catch {
    /* non-critical */
  }
}

// ---------- windows ----------

function glassOptions(nativeBlur) {
  const opts = { transparent: true, backgroundColor: '#00000000', frame: false, hasShadow: true };
  if (isMac) {
    Object.assign(opts, {
      frame: true,
      titleBarStyle: 'hidden',
      vibrancy: nativeBlur ? 'under-window' : undefined,
      visualEffectState: 'active',
    });
  } else if (isWin && nativeBlur) {
    opts.backgroundMaterial = 'acrylic';
  }
  return opts;
}

function applyNativeBlur(win, enabled) {
  if (!win || win.isDestroyed()) return;
  if (isMac) win.setVibrancy(enabled ? 'under-window' : null);
  else if (isWin && typeof win.setBackgroundMaterial === 'function') {
    win.setBackgroundMaterial(enabled ? 'acrylic' : 'none');
  }
}

function webPrefs() {
  return {
    preload: path.join(__dirname, '..', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: true,
  };
}

function lockdown(win) {
  // Never navigate away from the bundled UI; open external links in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createMainWindow() {
  const prefs = readUiPrefs();
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 920,
    minHeight: 600,
    title: 'Glassboard',
    show: false,
    ...glassOptions(prefs.nativeBlur !== false),
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: webPrefs(),
  });
  lockdown(mainWindow);
  mainWindow.loadFile(path.join(RENDERER, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function noteById(id) {
  return session && session.data.notes.find((n) => n.id === id);
}

function openNoteWindow(id) {
  const existing = noteWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const note = noteById(id);
  if (!note) return;

  const area = screen.getPrimaryDisplay().workArea;
  const b = note.bounds || {};
  const width = b.width || 300;
  const height = b.height || 320;
  const x = Number.isFinite(b.x) ? b.x : area.x + area.width - width - 40 - (noteWindows.size % 6) * 24;
  const y = Number.isFinite(b.y) ? b.y : area.y + 60 + (noteWindows.size % 6) * 24;

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 200,
    minHeight: 140,
    show: false,
    skipTaskbar: !!note.pinned,
    alwaysOnTop: !!note.pinned,
    title: note.title || 'Записка',
    ...glassOptions(session.data.settings.nativeBlur),
    ...(isMac ? { titleBarStyle: 'customButtonsOnHover', frame: false } : {}),
    webPreferences: webPrefs(),
  });
  if (note.pinned) setPinned(win, true);
  lockdown(win);
  win.loadFile(path.join(RENDERER, 'note.html'), { query: { id } });
  win.once('ready-to-show', () => win.showInactive());
  noteWindows.set(id, win);

  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      patchNote(id, { bounds: win.getBounds() }, null);
    }, 300);
  };
  win.on('move', rememberBounds);
  win.on('resize', rememberBounds);
  win.on('closed', () => {
    noteWindows.delete(id);
    // Closing because of lock/quit keeps the "open" flag so the note comes back.
    if (session && !session.closingAll) patchNote(id, { open: false }, null);
  });

  if (!note.open) patchNote(id, { open: true }, null);
}

function setPinned(win, pinned) {
  win.setAlwaysOnTop(pinned, pinned ? 'floating' : 'normal');
  win.setSkipTaskbar(pinned);
  if (isMac) win.setVisibleOnAllWorkspaces(pinned, { visibleOnFullScreen: true });
}

function closeAllNotes() {
  if (session) session.closingAll = true;
  for (const win of noteWindows.values()) if (!win.isDestroyed()) win.close();
  noteWindows.clear();
  if (session) session.closingAll = false;
}

function allWindows() {
  return [mainWindow, ...noteWindows.values()].filter((w) => w && !w.isDestroyed());
}

function broadcast(channel, payload, exceptWebContents) {
  for (const win of allWindows()) {
    if (win.webContents !== exceptWebContents) win.webContents.send(channel, payload);
  }
}

// ---------- session state ----------

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!session) return;
  try {
    vault.save(session, session.data);
  } catch (err) {
    console.error('Не удалось сохранить данные:', err);
  }
}

function setState(key, value, sender) {
  if (!session || !STATE_KEYS.has(key)) return false;
  session.data[key] = value;
  scheduleSave();
  broadcast('state:changed', { key, value }, sender);
  if (coop) coop.onLocalChange(key);
  if (key === 'settings') {
    writeUiPrefs(value);
    for (const win of allWindows()) applyNativeBlur(win, value.nativeBlur);
  }
  if (key === 'notes') syncNoteWindows();
  return true;
}

function patchNote(id, patch, sender) {
  if (!session) return;
  const notes = session.data.notes.map((n) => (n.id === id ? { ...n, ...patch } : n));
  setState('notes', notes, sender);
}

// Keep native window flags in sync with note data (pin, deletion, title).
function syncNoteWindows() {
  for (const [id, win] of noteWindows) {
    if (win.isDestroyed()) continue;
    const note = noteById(id);
    if (!note) {
      win.destroy();
      noteWindows.delete(id);
      continue;
    }
    if (win.isAlwaysOnTop() !== !!note.pinned) setPinned(win, !!note.pinned);
    win.setTitle(note.title || 'Записка');
  }
}

function startSession(s, data, profile) {
  session = { ...s, data: migrate(data), profile };
  failedAttempts.delete(s.id);
  writeUiPrefs(session.data.settings);
  for (const win of allWindows()) applyNativeBlur(win, session.data.settings.nativeBlur);
  for (const note of session.data.notes) if (note.open) openNoteWindow(note.id);
  coop.start();
  if (pendingInvite) deliverInvite();
  return { profile, data: session.data };
}

function lock() {
  if (!session) return;
  coop.stop();
  flush();
  closeAllNotes();
  session = null;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auth:locked');
}

// ---------- co-op invite links (glassboard://join/...) ----------

function inviteFromArgv(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.startsWith('glassboard://join/')) || null;
}

function deliverInvite() {
  if (!pendingInvite || !session || !mainWindow || mainWindow.isDestroyed()) return;
  const link = pendingInvite;
  pendingInvite = null;
  const send = () => mainWindow.webContents.send('coop:invite-link', link);
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
  else setTimeout(send, 300);
}

function receiveInvite(link) {
  if (!link) return;
  pendingInvite = link;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  deliverInvite();
}

function windowFrom(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

// ---------- IPC ----------

function registerIpc() {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, value: await fn(event, ...args) };
      } catch (err) {
        return { ok: false, error: err.message || String(err), code: err.code, wait: err.wait };
      }
    });

  const requireSession = () => {
    if (!session) throw Object.assign(new Error('Приложение заблокировано'), { code: 'LOCKED' });
    return session;
  };

  handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    prefs: readUiPrefs(),
    shouldUseDark: nativeTheme.shouldUseDarkColors,
  }));

  handle('auth:profiles', () => ({
    profiles: vault.listProfiles(),
    unlocked: session ? session.id : null,
  }));

  handle('auth:create', async (_e, { name, password, color }) => {
    const data = defaultData(name);
    const { profile, session: s } = await vault.createProfile(name, password, data, color);
    return startSession(s, data, profile);
  });

  handle('auth:unlock', async (_e, { id, password }) => {
    const profile = vault.listProfiles().find((p) => p.id === id);
    if (!profile) throw new Error('Профиль не найден');
    const attempts = failedAttempts.get(id) || { count: 0, until: 0 };
    if (Date.now() < attempts.until) {
      const wait = Math.ceil((attempts.until - Date.now()) / 1000);
      throw Object.assign(new Error(`Слишком много попыток. Подождите ${wait} с`), { code: 'WAIT', wait });
    }
    try {
      const { session: s, data } = await vault.unlock(id, password);
      return startSession(s, data, profile);
    } catch (err) {
      if (err instanceof BadPasswordError) {
        const count = attempts.count + 1;
        const delay = count >= 3 ? Math.min(60, 2 ** (count - 3)) * 1000 : 0;
        failedAttempts.set(id, { count, until: Date.now() + delay });
      }
      throw err;
    }
  });

  handle('auth:lock', () => lock());

  handle('auth:change-password', async (_e, { oldPassword, newPassword }) => {
    const s = requireSession();
    const next = await vault.changePassword(s, s.data, oldPassword, newPassword);
    Object.assign(session, next);
    return true;
  });

  handle('auth:update-profile', (_e, patch) => {
    const s = requireSession();
    s.profile = vault.renameProfile(s.id, patch);
    return s.profile;
  });

  handle('auth:delete-profile', async (_e, { password }) => {
    const s = requireSession();
    await vault.deleteProfile(s.id, password);
    coop.stop();
    clearTimeout(saveTimer);
    closeAllNotes();
    session = null;
    if (mainWindow) mainWindow.webContents.send('auth:locked');
    return true;
  });

  handle('state:get', () => {
    const s = requireSession();
    return { data: s.data, profile: s.profile };
  });

  handle('state:set', (event, key, value) => {
    requireSession();
    return setState(key, value, event.sender);
  });

  handle('note:open', (_e, id) => {
    requireSession();
    openNoteWindow(id);
  });

  handle('note:close', (_e, id) => {
    const win = noteWindows.get(id);
    if (win && !win.isDestroyed()) win.close();
  });

  handle('win:minimize', (e) => windowFrom(e)?.minimize());
  handle('win:maximize', (e) => {
    const win = windowFrom(e);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  handle('win:close', (e) => windowFrom(e)?.close());
  handle('win:focus-main', () => {
    if (!mainWindow) createMainWindow();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ---- co-op ----
  handle('coop:status', () => {
    requireSession();
    return coop.status();
  });
  handle('coop:create', async (_e, opts) => {
    requireSession();
    const res = await coop.create(opts || {});
    coop.emitStatus();
    return res;
  });
  handle('coop:join', (_e, invite) => {
    requireSession();
    const res = coop.join(invite);
    coop.emitStatus();
    return res;
  });
  handle('coop:invite', (_e, roomId) => {
    requireSession();
    return coop.invite(roomId);
  });
  handle('coop:leave', (_e, roomId, opts) => {
    requireSession();
    return coop.leave(roomId, opts || {});
  });
  handle('coop:chat', (_e, roomId, text) => {
    requireSession();
    return coop.chat(roomId, text);
  });
  ipcMain.on('coop:cursor', (_e, roomId, boardId, x, y) => {
    if (session && coop) coop.cursor(roomId, boardId, x, y);
  });

  // ---- Claude / MCP ----
  handle('mcp:status', () => mcp.status());
  handle('mcp:update', (_e, patch) =>
    mcp.update({
      ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
      ...(typeof patch.allowWrite === 'boolean' ? { allowWrite: patch.allowWrite } : {}),
    })
  );
  handle('mcp:regenerate-token', () => mcp.regenerateToken());
  handle('app:copy', (_e, text) => clipboard.writeText(String(text)));

  handle('data:export', async (e) => {
    const s = requireSession();
    const { canceled, filePath } = await dialog.showSaveDialog(windowFrom(e), {
      title: 'Экспорт данных',
      defaultPath: `glassboard-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, JSON.stringify(s.data, null, 2), { mode: 0o600 });
    return filePath;
  });

  handle('data:import', async (e) => {
    const s = requireSession();
    const { canceled, filePaths } = await dialog.showOpenDialog(windowFrom(e), {
      title: 'Импорт данных',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths[0]) return false;
    const parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
      throw new Error('Файл не похож на экспорт Glassboard');
    }
    closeAllNotes();
    coop.stop();
    s.data = migrate(parsed);
    flush();
    coop.start();
    for (const note of s.data.notes) if (note.open) openNoteWindow(note.id);
    return s.data;
  });
}

// ---------- auto-lock ----------

function startAutoLock() {
  setInterval(() => {
    if (!session) return;
    const minutes = Number(session.data.settings.autoLockMinutes) || 0;
    if (minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) lock();
  }, 15 * 1000);
  const onSleep = () => {
    if (session && session.data.settings.lockOnSleep) lock();
  };
  powerMonitor.on('suspend', onSleep);
  powerMonitor.on('lock-screen', onSleep);
}

// ---------- lifecycle ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    receiveInvite(url);
  });
  pendingInvite = inviteFromArgv(process.argv);

  app.on('second-instance', (_e, argv) => {
    receiveInvite(inviteFromArgv(argv));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    vault = new Vault(path.join(app.getPath('userData'), 'profiles'));
    mcp = new McpServer({
      userData: app.getPath('userData'),
      version: app.getVersion(),
      getSession: () => session,
      setState: (key, value) => setState(key, value, null),
      openNote: (id) => openNoteWindow(id),
      closeNote: (id) => {
        const win = noteWindows.get(id);
        if (win && !win.isDestroyed()) win.close();
      },
      allowWrite: () => mcp.config.allowWrite,
      notify: (text) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mcp:activity', text);
      },
    });
    if (mcp.config.enabled) mcp.start();
    coop = new CoopManager({
      getSession: () => session,
      pushState: (key) => {
        if (!session) return;
        scheduleSave();
        broadcast('state:changed', { key, value: session.data[key] }, null);
        if (key === 'notes') syncNoteWindows();
      },
      persist: (broadcastRooms) => {
        if (!session) return;
        scheduleSave();
        if (broadcastRooms) broadcast('state:changed', { key: 'coop', value: session.data.coop }, null);
      },
      emit: (channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
      },
      notify: (text) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mcp:activity', text);
      },
    });
    if (process.defaultApp) {
      if (process.argv.length >= 2) app.setAsDefaultProtocolClient('glassboard', process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient('glassboard');
    }
    registerIpc();
    createMainWindow();
    startAutoLock();
    nativeTheme.on('updated', () =>
      broadcast('theme:system-changed', nativeTheme.shouldUseDarkColors, null)
    );
    app.on('activate', () => {
      if (!mainWindow) createMainWindow();
    });
  });

  app.on('before-quit', () => {
    flush();
    if (session) session.closingAll = true;
  });

  app.on('window-all-closed', () => {
    flush();
    if (!isMac) app.quit();
  });
}
