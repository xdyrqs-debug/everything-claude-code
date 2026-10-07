'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createRelay } = require('../src/coop/relay');
const { CoopManager, decodeInvite, seal, open } = require('../src/main/coop');
const { defaultData } = require('../src/main/defaults');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(20);
  }
  throw new Error('timeout waiting for condition');
}

// A fake app: session data + a CoopManager wired like main.js does.
function peer(name, color) {
  const session = { data: defaultData(name), profile: { name, color } };
  const events = { status: [], chat: [], cursor: [], notify: [] };
  const mgr = new CoopManager({
    getSession: () => session,
    pushState: () => {},
    persist: () => {},
    emit: (ch, p) => events[ch.split(':')[1]]?.push(p),
    notify: (t) => events.notify.push(t),
  });
  // emulate main.setState for local edits
  const set = (key, value) => {
    session.data[key] = value;
    mgr.onLocalChange(key);
  };
  return { session, mgr, events, set, data: () => session.data };
}

const board = (p, id) => p.data().boards.find((b) => b.id === id);

test('encryption round-trip and invite decoding', () => {
  const key = Buffer.alloc(32, 7);
  assert.deepEqual(open(key, seal(key, { a: 1 })), { a: 1 });
  assert.throws(() => open(Buffer.alloc(32, 8), seal(key, { a: 1 })));
  assert.throws(() => decodeInvite('https://example.com'), /приглашение/);
});

test('two peers share tasks, board, cursors and chat in real time', async (t) => {
  const relay = createRelay();
  const port = await relay.listen(0, '127.0.0.1');
  const host = peer('Аня', '#ff375f');
  const guest = peer('Боб', '#30d158');
  t.after(async () => {
    host.mgr.stop();
    guest.mgr.stop();
    await relay.close();
  });

  // host creates a room on an explicit relay URL and adds content before anyone joins
  const room = await host.mgr.create({ name: 'Ремонт', relay: `ws://127.0.0.1:${port}` });
  const hb = board(host, room.boardId);
  host.set('tasks', [...host.data().tasks, { id: 'task1', title: 'Купить плитку', description: '', status: 'todo', priority: 2, due: null, tags: [], subtasks: [], projectId: room.projectId, createdAt: 1, order: 0 }]);
  host.set('boards', host.data().boards.map((b) => (b.id === hb.id ? { ...b, items: [{ id: 'st1', type: 'sticky', x: 0, y: 0, w: 200, h: 200, text: 'Идея', color: '#ffd60a', z: 1 }] } : b)));
  await until(() => host.mgr.status().rooms[0].status === 'online');

  // guest joins with the link and receives the snapshot
  guest.mgr.join(room.invite);
  await until(() => guest.data().tasks.some((x) => x.id === 'task1'));
  const gb = board(guest, room.boardId);
  assert.ok(gb, 'shared board created on guest');
  assert.equal(gb.items[0].text, 'Идея');
  assert.equal(guest.data().projects.find((p) => p.id === room.projectId).name, 'Ремонт');
  await until(() => host.mgr.status().rooms[0].peers.length === 1 && guest.mgr.status().rooms[0].peers.length === 1);
  assert.equal(host.mgr.status().rooms[0].peers[0].name, 'Боб');

  // guest edits -> host sees it
  guest.set('boards', guest.data().boards.map((b) => (b.id === gb.id ? { ...b, items: b.items.map((i) => ({ ...i, x: 300, text: 'Идея!' })) } : b)));
  await until(() => board(host, room.boardId).items[0].x === 300);
  assert.equal(board(host, room.boardId).items[0].text, 'Идея!');

  // host completes the task -> guest sees it
  host.set('tasks', host.data().tasks.map((x) => (x.id === 'task1' ? { ...x, status: 'done' } : x)));
  await until(() => guest.data().tasks.find((x) => x.id === 'task1').status === 'done');

  // unrelated private tasks never leave the host
  assert.ok(!guest.data().tasks.some((x) => x.title === 'Добро пожаловать в Glassboard' && x.projectId === 'inbox' && host.data().tasks.includes(x)));
  const guestShared = guest.data().tasks.filter((x) => x.projectId === room.projectId);
  assert.equal(guestShared.length, 1);

  // a stale renderer copy on the host must not revert the guest's change
  const staleBoards = JSON.parse(JSON.stringify(host.data().boards));
  guest.set('boards', guest.data().boards.map((b) => (b.id === gb.id ? { ...b, items: b.items.map((i) => ({ ...i, y: 500 })) } : b)));
  await until(() => board(host, room.boardId).items[0].y === 500);
  host.set('boards', staleBoards.map((b) => (b.id === room.boardId ? { ...b, items: b.items.map((i) => ({ ...i, y: 0 })) } : b)));
  await wait(150);
  assert.equal(board(host, room.boardId).items[0].y, 500, 'host keeps partner change');
  assert.equal(board(guest, room.boardId).items[0].y, 500, 'guest not reverted');

  // deletion propagates
  guest.set('tasks', guest.data().tasks.filter((x) => x.id !== 'task1'));
  await until(() => !host.data().tasks.some((x) => x.id === 'task1'));

  // cursor
  host.mgr.cursor(room.id, room.boardId, 120.4, 80.6);
  await until(() => guest.events.cursor.some((c) => c.x === 120 && c.name === 'Аня'));

  // chat is delivered and stored on both sides
  host.mgr.chat(room.id, 'Привет!');
  await until(() => guest.data().coop.rooms[0].chat.some((m) => m.text === 'Привет!'));
  guest.mgr.chat(room.id, 'Привет, Аня');
  await until(() => host.data().coop.rooms[0].chat.length === 2);
});

test('late joiner gets chat history and offline edits merge', async (t) => {
  const relay = createRelay();
  const port = await relay.listen(0, '127.0.0.1');
  const a = peer('A', '#111111');
  const b = peer('B', '#222222');
  const c = peer('C', '#333333');
  t.after(async () => {
    for (const p of [a, b, c]) p.mgr.stop();
    await relay.close();
  });
  const room = await a.mgr.create({ name: 'Проект', relay: `ws://127.0.0.1:${port}` });
  b.mgr.join(room.invite);
  await until(() => a.mgr.status().rooms[0].peers.length === 1);
  a.mgr.chat(room.id, 'один');
  b.mgr.chat(room.id, 'два');
  await until(() => a.data().coop.rooms[0].chat.length === 2 && b.data().coop.rooms[0].chat.length === 2);

  // B goes offline and edits; meanwhile A edits something else
  b.mgr.stop();
  b.set('tasks', [...b.data().tasks, { id: 'offline1', title: 'Сделано офлайн', description: '', status: 'todo', priority: 0, due: null, tags: [], subtasks: [], projectId: room.projectId, createdAt: 2, order: 0 }]);
  a.set('tasks', [...a.data().tasks, { id: 'online1', title: 'Сделано онлайн', description: '', status: 'todo', priority: 0, due: null, tags: [], subtasks: [], projectId: room.projectId, createdAt: 3, order: 0 }]);

  // C joins late: receives the whole chat
  c.mgr.join(room.invite);
  await until(() => c.data().coop.rooms[0].chat.length === 2);
  assert.deepEqual(c.data().coop.rooms[0].chat.map((m) => m.text), ['один', 'два']);

  // B reconnects: both edits end up everywhere
  await b.mgr.start();
  const has = (p, id) => p.data().tasks.some((x) => x.id === id);
  await until(() => has(a, 'offline1') && has(b, 'online1') && has(c, 'offline1') && has(c, 'online1'));
});
