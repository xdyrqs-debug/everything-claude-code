'use strict';

// Real-time co-op for shared projects.
//
// A shared room = one project (its tasks) + one board + a chat. Peers talk
// through a relay (src/coop/relay.js) over WebSocket; every payload is
// AES-256-GCM encrypted with the room key that only travels inside the
// invite link, so the relay sees nothing but ciphertext.
//
// Sync model: the room is split into entities (project meta, board meta,
// each task, each board item, each connector). Each entity carries a
// last-writer-wins revision [timestamp, peerId]. Local edits are detected by
// diffing the app state against what was last synced; remote edits are
// applied when their revision is newer. A short "recently applied remote"
// memory stops a renderer that still holds a stale copy from reverting a
// partner's change.

const crypto = require('crypto');
const os = require('os');
const { createRelay } = require('../coop/relay');
const { MqttSocket } = require('../coop/mqtt');

const LOCAL_RELAY_PORT = 47900;
const STALE_WINDOW_MS = 3000;
const CHAT_LIMIT = 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const stable = (v) => JSON.stringify(v, Object.keys(v || {}).sort());
const deepStable = (v) => {
  if (Array.isArray(v)) return '[' + v.map(deepStable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter((k) => k !== '_rev' && v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + deepStable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
};

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function open(key, data) {
  const raw = Buffer.from(data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}

function encodeInvite(room) {
  return 'glassboard://join/' + b64url(JSON.stringify({ v: 1, r: room.relay, i: room.id, k: room.key, n: room.name }));
}

function decodeInvite(text) {
  const m = /glassboard:\/\/join\/([A-Za-z0-9_-]+)/.exec(String(text || '').trim());
  if (!m) throw new Error('Это не ссылка-приглашение Glassboard');
  let inv;
  try {
    inv = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Ссылка повреждена');
  }
  if (!inv.r || !inv.i || !inv.k || !(inv.r === 'public' || /^wss?:\/\//.test(inv.r))) throw new Error('Ссылка повреждена');
  return { relay: inv.r, id: inv.i, key: inv.k, name: inv.n || 'Совместный проект' };
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

const newer = (a, b) => !b || a[0] > b[0] || (a[0] === b[0] && String(a[1]) > String(b[1]));

// ---------------------------------------------------------------- entity mapping

function collect(data, room) {
  const map = new Map();
  const project = data.projects.find((p) => p.id === room.projectId);
  const board = data.boards.find((b) => b.id === room.boardId);
  if (project) map.set('p', { name: project.name, color: project.color, icon: project.icon });
  if (board) {
    map.set('b', { name: board.name });
    for (const it of board.items) map.set('i:' + it.id, it);
    for (const c of board.connectors) map.set('c:' + c.id, c);
  }
  for (const t of data.tasks) if (t.projectId === room.projectId) map.set('t:' + t.id, t);
  return map;
}

// Write entity values back into the app data; returns the touched state keys.
function writeBack(data, room, values) {
  const touched = new Set();
  let project = data.projects.find((p) => p.id === room.projectId);
  let board = data.boards.find((b) => b.id === room.boardId);
  if (!project && room.projectId) {
    project = { id: room.projectId, name: room.name, color: '#5e5ce6', icon: '👥', shared: room.id };
    data.projects = [...data.projects, project];
    touched.add('projects');
  }
  if (!board && room.boardId) {
    board = { id: room.boardId, name: room.name, items: [], connectors: [], viewport: { x: 0, y: 0, zoom: 1 }, shared: room.id };
    data.boards = [...data.boards, board];
    touched.add('boards');
  }

  let tasks = null;
  let items = null;
  let connectors = null;
  for (const [k, val] of values) {
    if (k === 'p' && val && project) {
      data.projects = data.projects.map((p) => (p.id === room.projectId ? { ...p, ...val, shared: room.id } : p));
      touched.add('projects');
    } else if (k === 'b' && val && board) {
      data.boards = data.boards.map((b) => (b.id === room.boardId ? { ...b, name: val.name } : b));
      touched.add('boards');
    } else if (k.startsWith('t:')) {
      tasks = tasks || new Map(data.tasks.map((t) => [t.id, t]));
      const id = k.slice(2);
      if (val) tasks.set(id, { ...val, id, projectId: room.projectId });
      else tasks.delete(id);
    } else if (k.startsWith('i:')) {
      const b = data.boards.find((x) => x.id === room.boardId);
      items = items || new Map(b.items.map((i) => [i.id, i]));
      const id = k.slice(2);
      if (val) items.set(id, { ...val, id });
      else items.delete(id);
    } else if (k.startsWith('c:')) {
      const b = data.boards.find((x) => x.id === room.boardId);
      connectors = connectors || new Map(b.connectors.map((c) => [c.id, c]));
      const id = k.slice(2);
      if (val) connectors.set(id, { ...val, id });
      else connectors.delete(id);
    }
  }
  if (tasks) {
    data.tasks = [...tasks.values()];
    touched.add('tasks');
  }
  if (items || connectors) {
    data.boards = data.boards.map((b) =>
      b.id === room.boardId
        ? {
            ...b,
            items: items ? [...items.values()] : b.items,
            // drop connectors whose ends are gone
            connectors: (connectors ? [...connectors.values()] : b.connectors).filter((c) => {
              const ids = new Set((items ? [...items.values()] : b.items).map((i) => i.id));
              return ids.has(c.from) && ids.has(c.to);
            }),
          }
        : b
    );
    touched.add('boards');
  }
  return touched;
}

// ---------------------------------------------------------------- room

class Room {
  constructor(mgr, cfg) {
    this.mgr = mgr;
    this.cfg = cfg; // persisted object inside data.coop.rooms
    this.key = Buffer.from(cfg.key, 'base64url');
    this.peerId = b64url(crypto.randomBytes(8));
    this.ws = null;
    this.status = 'offline';
    this.error = null;
    this.peers = new Map();
    this.synced = new Map(); // key -> canonical json of last synced value
    this.recentRemote = new Map(); // key -> { at, json } of values replaced by remote ops
    this.retry = 0;
    this.stopped = false;
    this.baseline();
  }

  get data() {
    return this.mgr.data();
  }

  baseline() {
    this.synced.clear();
    if (!this.cfg.projectId) return;
    for (const [k, v] of collect(this.data, this.cfg)) this.synced.set(k, deepStable(v));
  }

  // ---- transport ----
  connect() {
    if (this.stopped) return;
    this.status = 'connecting';
    this.mgr.emitStatus();
    let ws;
    try {
      ws = this.mgr.openSocket(this.cfg.relay, this);
    } catch (err) {
      this.error = err.message;
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.error = null;
      ws.send(JSON.stringify({ t: 'join', room: this.cfg.id, peer: this.peerId }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      this.onRelay(msg);
    };
    ws.onerror = () => {
      this.error = this.cfg.relay === 'public' ? 'Нет связи с интернет-сервером, пробуем другой…' : 'Нет связи с сервером ' + this.cfg.relay;
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.peers.clear();
      this.mgr.emitCursorsCleared(this.cfg.id);
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.status = 'offline';
    this.mgr.emitStatus();
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
    this.status = 'offline';
  }

  send(obj, to) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ t: 'msg', data: seal(this.key, obj), ...(to ? { to } : {}) }));
    return true;
  }

  me() {
    const p = this.mgr.profile();
    return { name: p.name, color: p.color };
  }

  onRelay(msg) {
    if (msg.t === 'joined') {
      this.status = 'online';
      this.mgr.emitStatus();
      this.send({ type: 'hello', ...this.me(), want: true });
      // alone in the room: our state is the truth; nothing to wait for
    } else if (msg.t === 'peer-leave') {
      this.peers.delete(msg.peer);
      this.mgr.emitCursor({ room: this.cfg.id, peer: msg.peer, gone: true });
      this.mgr.emitStatus();
    } else if (msg.t === 'msg') {
      let body;
      try {
        body = open(this.key, msg.data);
      } catch {
        return; // wrong key or tampered
      }
      this.onPeer(msg.from, body);
    } else if (msg.t === 'error') {
      this.error = msg.message;
      this.mgr.emitStatus();
    }
  }

  onPeer(from, m) {
    switch (m.type) {
      case 'hello': {
        const known = this.peers.has(from);
        this.peers.set(from, { name: String(m.name || 'Гость').slice(0, 40), color: m.color || '#8e8e93' });
        this.mgr.emitStatus();
        if (m.want) {
          this.send({ type: 'hello', ...this.me(), want: false }, from);
          this.send({ type: 'chat-sync', messages: this.cfg.chat }, from);
          // the longest-standing peer (smallest id among the rest) answers with state
          const ids = [this.peerId, ...[...this.peers.keys()].filter((id) => id !== from)].sort();
          if (ids[0] === this.peerId && this.cfg.projectId) this.send(this.snapshot(), from);
          if (!known) this.mgr.notify(`${this.peers.get(from).name} подключился к «${this.cfg.name}»`);
        }
        break;
      }
      case 'snapshot':
        this.applySnapshot(m);
        break;
      case 'ops':
        this.applyOps(m.ops || []);
        break;
      case 'chat':
        if (this.addChat([m.msg])) this.mgr.emitChat(this.cfg.id, m.msg);
        break;
      case 'chat-sync':
        if (this.addChat(m.messages || [])) this.mgr.emitChat(this.cfg.id, null);
        break;
      case 'cursor': {
        const p = this.peers.get(from);
        if (p) this.mgr.emitCursor({ room: this.cfg.id, peer: from, name: p.name, color: p.color, boardId: m.boardId, x: m.x, y: m.y });
        break;
      }
      default:
    }
  }

  // ---- chat ----
  addChat(messages) {
    const ids = new Set(this.cfg.chat.map((x) => x.id));
    let added = false;
    for (const msg of messages) {
      if (!msg || !msg.id || ids.has(msg.id) || typeof msg.text !== 'string') continue;
      this.cfg.chat.push({ id: String(msg.id), name: String(msg.name || '').slice(0, 40), color: msg.color, text: msg.text.slice(0, 4000), ts: Number(msg.ts) || Date.now() });
      ids.add(msg.id);
      added = true;
    }
    if (added) {
      this.cfg.chat.sort((a, b) => a.ts - b.ts);
      if (this.cfg.chat.length > CHAT_LIMIT) this.cfg.chat = this.cfg.chat.slice(-CHAT_LIMIT);
      this.mgr.persist(true);
    }
    return added;
  }

  sendChat(text) {
    const msg = { id: b64url(crypto.randomBytes(9)), ...this.me(), text: String(text).slice(0, 4000), ts: Date.now() };
    this.addChat([msg]);
    this.send({ type: 'chat', msg });
    return msg;
  }

  // ---- state sync ----
  rev() {
    return [Date.now(), this.peerId];
  }

  snapshot() {
    const entities = [];
    const current = collect(this.data, this.cfg);
    for (const [k, v] of current) entities.push({ k, rev: this.cfg.revs[k] || [0, ''], val: v });
    for (const [k, rev] of Object.entries(this.cfg.revs)) if (!current.has(k)) entities.push({ k, rev, val: null });
    return { type: 'snapshot', projectId: this.cfg.projectId, boardId: this.cfg.boardId, name: this.cfg.name, entities };
  }

  applySnapshot(m) {
    if (!this.cfg.projectId) {
      this.cfg.projectId = m.projectId;
      this.cfg.boardId = m.boardId;
      if (m.name) this.cfg.name = m.name;
      this.mgr.persist(true);
    }
    if (m.projectId !== this.cfg.projectId || m.boardId !== this.cfg.boardId) return;
    const remote = new Map((m.entities || []).map((e) => [e.k, e]));
    this.applyOps(m.entities || [], { fromSnapshot: true });
    // push back what we have that is newer or unknown to the sender
    const mine = [];
    for (const [k, v] of collect(this.data, this.cfg)) {
      const r = remote.get(k);
      if (!r || newer(this.cfg.revs[k] || [0, ''], r.rev)) {
        if (!this.cfg.revs[k]) this.cfg.revs[k] = this.rev();
        mine.push({ k, rev: this.cfg.revs[k], val: v });
      }
    }
    if (mine.length) this.send({ type: 'ops', ops: mine });
    this.mgr.emitStatus();
  }

  applyOps(ops, { fromSnapshot } = {}) {
    const values = new Map();
    const now = Date.now();
    for (const op of ops) {
      if (!op || typeof op.k !== 'string' || !Array.isArray(op.rev)) continue;
      if (!/^(p|b|[tic]:[A-Za-z0-9_-]{1,64})$/.test(op.k)) continue;
      const local = this.cfg.revs[op.k];
      if (local && !newer(op.rev, local)) continue;
      if (!local && op.val === null && !this.synced.has(op.k)) {
        this.cfg.revs[op.k] = op.rev; // remember tombstone
        continue;
      }
      const prev = this.synced.get(op.k);
      this.recentRemote.set(op.k, { at: now, json: prev });
      this.cfg.revs[op.k] = op.rev;
      if (op.val === null) this.synced.delete(op.k);
      else this.synced.set(op.k, deepStable(op.val));
      values.set(op.k, op.val);
    }
    if (!values.size) return;
    const touched = writeBack(this.data, this.cfg, values);
    this.mgr.persist(false);
    for (const key of touched) this.mgr.pushState(key);
    if (!fromSnapshot) this.mgr.emitStatus();
  }

  // Called after the local user changed tasks/boards/projects.
  onLocalChange() {
    if (!this.cfg.projectId) return;
    const now = Date.now();
    const current = collect(this.data, this.cfg);
    const ops = [];
    const restore = new Map();
    const isStale = (k, json) => {
      const r = this.recentRemote.get(k);
      return r && now - r.at < STALE_WINDOW_MS && r.json === json;
    };
    for (const [k, v] of current) {
      const json = deepStable(v);
      if (this.synced.get(k) === json) continue;
      if (isStale(k, json)) {
        // a stale copy is trying to undo a partner's change: put theirs back
        restore.set(k, this.synced.has(k) ? JSON.parse(this.synced.get(k)) : null);
        continue;
      }
      const rev = this.rev();
      this.cfg.revs[k] = rev;
      this.synced.set(k, json);
      ops.push({ k, rev, val: v });
    }
    for (const k of [...this.synced.keys()]) {
      if (current.has(k)) continue;
      if (isStale(k, undefined)) {
        restore.set(k, JSON.parse(this.synced.get(k)));
        continue;
      }
      const rev = this.rev();
      this.cfg.revs[k] = rev;
      this.synced.delete(k);
      ops.push({ k, rev, val: null });
    }
    if (restore.size) {
      const touched = writeBack(this.data, this.cfg, restore);
      for (const key of touched) this.mgr.pushState(key);
    }
    if (ops.length) {
      this.mgr.persist(false);
      this.send({ type: 'ops', ops });
    }
  }

  publicStatus() {
    return {
      id: this.cfg.id,
      status: this.status,
      error: this.error,
      ready: !!this.cfg.projectId,
      me: this.peerId,
      peers: [...this.peers].map(([id, p]) => ({ id, ...p })),
    };
  }
}

// ---------------------------------------------------------------- manager

class CoopManager {
  constructor(ctx) {
    // ctx: getSession, pushState(key), persist(broadcast), emit(channel, payload), notify(text), WebSocket?
    this.ctx = ctx;
    this.WebSocket = ctx.WebSocket || globalThis.WebSocket;
    this.rooms = new Map();
    this.relay = null;
    this.relayPort = null;
  }

  data() {
    return this.ctx.getSession().data;
  }

  openSocket(relay, room) {
    if (relay === 'public') {
      const brokers = this.ctx.publicBrokers || (process.env.GLASSBOARD_PUBLIC_BROKERS || '').split(',').filter(Boolean);
      return new MqttSocket({ WebSocket: this.WebSocket, brokers, room, roomId: room.cfg.id });
    }
    return new this.WebSocket(relay);
  }

  profile() {
    return this.ctx.getSession().profile || { name: 'Гость', color: '#8e8e93' };
  }

  store() {
    const data = this.data();
    if (!data.coop || !Array.isArray(data.coop.rooms)) data.coop = { rooms: [] };
    return data.coop;
  }

  persist(broadcast) {
    this.ctx.persist(broadcast);
  }

  pushState(key) {
    this.ctx.pushState(key);
  }

  emitStatus() {
    this.ctx.emit('coop:status', this.status());
  }

  emitChat(roomId, msg) {
    this.ctx.emit('coop:chat', { room: roomId, msg });
  }

  emitCursor(c) {
    this.ctx.emit('coop:cursor', c);
  }

  emitCursorsCleared(roomId) {
    this.ctx.emit('coop:cursor', { room: roomId, all: true, gone: true });
  }

  notify(text) {
    this.ctx.notify(text);
  }

  status() {
    return {
      rooms: [...this.rooms.values()].map((r) => r.publicStatus()),
      localRelay: this.relayPort ? { port: this.relayPort, urls: lanAddresses().map((a) => `ws://${a}:${this.relayPort}`) } : null,
      lan: lanAddresses(),
    };
  }

  // ---- lifecycle with the session ----
  async start() {
    const { rooms } = this.store();
    if (rooms.some((r) => r.localRelay && r.role === 'host')) await this.ensureLocalRelay().catch(() => {});
    for (const cfg of rooms) this.startRoom(cfg);
    this.emitStatus();
  }

  stop() {
    for (const r of this.rooms.values()) r.stop();
    this.rooms.clear();
  }

  async shutdown() {
    this.stop();
    if (this.relay) await this.relay.close();
    this.relay = null;
    this.relayPort = null;
  }

  startRoom(cfg) {
    const room = new Room(this, cfg);
    this.rooms.set(cfg.id, room);
    room.connect();
    return room;
  }

  async ensureLocalRelay() {
    if (this.relay) return this.relayPort;
    const relay = createRelay();
    let port = LOCAL_RELAY_PORT;
    for (; port < LOCAL_RELAY_PORT + 10; port++) {
      try {
        await relay.listen(port);
        this.relay = relay;
        this.relayPort = port;
        return port;
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
      }
    }
    throw new Error('Не удалось запустить сервер связи: порты заняты');
  }

  // ---- user actions ----
  async create({ name, relay }) {
    const data = this.data();
    const title = String(name || '').trim() || 'Совместный проект';
    let relayUrl = String(relay || '').trim();
    let localRelay = false;
    if (relayUrl === 'local') relayUrl = '';
    if (relayUrl === 'public') {
      // free public MQTT brokers: works across the internet with no setup
    } else if (!relayUrl) {
      const port = await this.ensureLocalRelay();
      const ip = lanAddresses()[0] || '127.0.0.1';
      relayUrl = `ws://${ip}:${port}`;
      localRelay = true;
    }
    if (relayUrl !== 'public' && !/^wss?:\/\/[^\s]+$/.test(relayUrl)) throw new Error('Адрес сервера должен начинаться с ws:// или wss://');

    const id = b64url(crypto.randomBytes(16));
    const projectId = 'sp' + b64url(crypto.randomBytes(6));
    const boardId = 'sb' + b64url(crypto.randomBytes(6));
    data.projects = [...data.projects, { id: projectId, name: title, color: '#5e5ce6', icon: '👥', shared: id }];
    data.boards = [...data.boards, { id: boardId, name: title, items: [], connectors: [], viewport: { x: 0, y: 0, zoom: 1 }, shared: id }];
    const cfg = { id, key: b64url(crypto.randomBytes(32)), relay: relayUrl, localRelay, name: title, role: 'host', projectId, boardId, chat: [], revs: {}, createdAt: Date.now() };
    const now = this.rev0();
    for (const k of collect(data, cfg).keys()) cfg.revs[k] = now;
    this.store().rooms.push(cfg);
    this.persist(true);
    this.pushState('projects');
    this.pushState('boards');
    this.startRoom(cfg);
    return { id, invite: encodeInvite(cfg), projectId, boardId };
  }

  rev0() {
    return [Date.now(), 'host'];
  }

  join(invite) {
    const inv = decodeInvite(invite);
    const existing = this.store().rooms.find((r) => r.id === inv.id);
    if (existing) {
      if (!this.rooms.has(existing.id)) this.startRoom(existing);
      return { id: existing.id, already: true };
    }
    const cfg = { id: inv.id, key: inv.key, relay: inv.relay, localRelay: false, name: inv.name, role: 'guest', projectId: null, boardId: null, chat: [], revs: {}, createdAt: Date.now() };
    this.store().rooms.push(cfg);
    this.persist(true);
    this.startRoom(cfg);
    return { id: cfg.id };
  }

  invite(roomId) {
    const cfg = this.store().rooms.find((r) => r.id === roomId);
    if (!cfg) throw new Error('Комната не найдена');
    return encodeInvite(cfg);
  }

  leave(roomId, { keepData = true } = {}) {
    const room = this.rooms.get(roomId);
    if (room) room.stop();
    this.rooms.delete(roomId);
    const coop = this.store();
    const cfg = coop.rooms.find((r) => r.id === roomId);
    coop.rooms = coop.rooms.filter((r) => r.id !== roomId);
    const data = this.data();
    if (cfg && cfg.projectId) {
      if (keepData) {
        data.projects = data.projects.map((p) => (p.id === cfg.projectId ? { ...p, shared: undefined, icon: '●' } : p));
        data.boards = data.boards.map((b) => (b.id === cfg.boardId ? { ...b, shared: undefined } : b));
      } else {
        data.tasks = data.tasks.filter((t) => t.projectId !== cfg.projectId);
        data.projects = data.projects.filter((p) => p.id !== cfg.projectId);
        data.boards = data.boards.filter((b) => b.id !== cfg.boardId);
        this.pushState('tasks');
      }
      this.pushState('projects');
      this.pushState('boards');
    }
    this.persist(true);
    this.emitStatus();
  }

  chat(roomId, text) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('Комната не подключена');
    if (!String(text || '').trim()) return null;
    const msg = room.sendChat(String(text).trim());
    this.emitChat(roomId, msg);
    return msg;
  }

  cursor(roomId, boardId, x, y) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    // public brokers are shared infrastructure: keep cursor traffic modest
    const now = Date.now();
    if (room.cfg.relay === 'public' && now - (room.lastCursor || 0) < 90) return;
    room.lastCursor = now;
    room.send({ type: 'cursor', boardId, x: Math.round(x), y: Math.round(y) });
  }

  onLocalChange(key) {
    if (!['tasks', 'boards', 'projects'].includes(key)) return;
    for (const r of this.rooms.values()) r.onLocalChange();
  }
}

module.exports = { CoopManager, encodeInvite, decodeInvite, seal, open, collect, writeBack, deepStable, LOCAL_RELAY_PORT };
