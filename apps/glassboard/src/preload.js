'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) {
    const err = new Error(res.error);
    err.code = res.code;
    err.wait = res.wait;
    throw err;
  }
  return res.value;
}

const listen = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('glass', {
  platform: process.platform,
  info: () => call('app:info'),
  auth: {
    profiles: () => call('auth:profiles'),
    create: (payload) => call('auth:create', payload),
    unlock: (payload) => call('auth:unlock', payload),
    lock: () => call('auth:lock'),
    changePassword: (payload) => call('auth:change-password', payload),
    updateProfile: (patch) => call('auth:update-profile', patch),
    deleteProfile: (payload) => call('auth:delete-profile', payload),
    onLocked: listen('auth:locked'),
  },
  state: {
    get: () => call('state:get'),
    set: (key, value) => call('state:set', key, value),
    onChanged: listen('state:changed'),
  },
  notes: {
    open: (id) => call('note:open', id),
    close: (id) => call('note:close', id),
  },
  win: {
    minimize: () => call('win:minimize'),
    maximize: () => call('win:maximize'),
    close: () => call('win:close'),
    focusMain: () => call('win:focus-main'),
  },
  data: {
    export: () => call('data:export'),
    import: () => call('data:import'),
  },
  onSystemTheme: listen('theme:system-changed'),
});
