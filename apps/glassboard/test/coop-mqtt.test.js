'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CoopManager, decodeInvite } = require('../src/main/coop');
const { defaultData } = require('../src/main/defaults');
const { startBroker } = require('./helpers/mqtt-broker');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(25);
  }
  throw new Error('timeout');
}

function peer(name, brokers) {
  const session = { data: defaultData(name), profile: { name, color: '#0a84ff' } };
  const events = { cursor: [] };
  const mgr = new CoopManager({
    getSession: () => session,
    pushState() {},
    persist() {},
    emit: (ch, p) => ch === 'coop:cursor' && events.cursor.push(p),
    notify() {},
    publicBrokers: brokers,
  });
  const set = (key, value) => {
    session.data[key] = value;
    mgr.onLocalChange(key);
  };
  return { mgr, set, events, data: () => session.data };
}

test('internet mode: peers sync through an MQTT broker, with failover', async (t) => {
  const broker = await startBroker();
  // first broker in the list is dead -> both peers must fall over to the live one
  const brokers = ['ws://127.0.0.1:1/mqtt', broker.url];
  const a = peer('Аня', brokers);
  const b = peer('Бен', brokers);
  t.after(async () => {
    a.mgr.stop();
    b.mgr.stop();
    await broker.close();
  });

  const room = await a.mgr.create({ name: 'Через океан', relay: 'public' });
  assert.equal(decodeInvite(room.invite).relay, 'public');
  await until(() => a.mgr.status().rooms[0].status === 'online', 15000);
  a.set('tasks', [...a.data().tasks, { id: 'x1', title: 'Билеты', description: '', status: 'todo', priority: 0, due: null, tags: [], subtasks: [], projectId: room.projectId, createdAt: 1, order: 0 }]);
  a.mgr.chat(room.id, 'hello from A');

  b.mgr.join(room.invite);
  await until(() => b.data().tasks.some((x) => x.id === 'x1'), 15000);
  await until(() => b.data().coop.rooms[0].chat.length === 1);
  await until(() => a.mgr.status().rooms[0].peers.length === 1);

  // large board snapshot is chunked transparently
  const big = Array.from({ length: 400 }, (_, i) => ({ id: 'it' + i, type: 'sticky', x: i, y: 0, w: 200, h: 200, text: 'x'.repeat(300), color: '#ffd60a', z: i }));
  a.set('boards', a.data().boards.map((bd) => (bd.id === room.boardId ? { ...bd, items: big } : bd)));
  await until(() => b.data().boards.find((bd) => bd.id === room.boardId).items.length === 400);

  b.set('tasks', b.data().tasks.map((x) => (x.id === 'x1' ? { ...x, status: 'done' } : x)));
  await until(() => a.data().tasks.find((x) => x.id === 'x1').status === 'done');

  b.mgr.cursor(room.id, room.boardId, 10, 20);
  await until(() => a.events.cursor.some((c) => c.x === 10 && c.name === 'Бен'));

  // B leaves cleanly -> A notices
  b.mgr.stop();
  await until(() => a.mgr.status().rooms[0].peers.length === 0);
});
