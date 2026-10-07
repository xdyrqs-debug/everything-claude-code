'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createRpc, McpServer, textToNoteHtml, noteHtmlToText } = require('../src/main/mcp');
const { defaultData } = require('../src/main/defaults');

function harness({ locked = false, allowWrite = true } = {}) {
  const session = locked ? null : { data: defaultData('Тест') };
  const opened = [];
  const notes = [];
  const ctx = {
    version: 'test',
    getSession: () => session,
    setState: (key, value) => {
      session.data[key] = value;
    },
    openNote: (id) => opened.push(id),
    closeNote: () => {},
    allowWrite: () => allowWrite,
    notify: (t) => notes.push(t),
  };
  const rpc = createRpc(ctx);
  let id = 0;
  const call = async (name, args = {}) => {
    const res = await rpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    const text = res.result.content[0].text;
    return { isError: !!res.result.isError, text, json: res.result.isError ? null : JSON.parse(text) };
  };
  return { rpc, call, session, opened, notes };
}

test('initialize negotiates protocol and lists tools', async () => {
  const { rpc } = harness();
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'glassboard');
  const unknown = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
  assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.ok(list.result.tools.some((t) => t.name === 'create_task'));
  const missing = await rpc({ jsonrpc: '2.0', id: 4, method: 'nope' });
  assert.equal(missing.error.code, -32601);
});

test('task lifecycle through tools', async () => {
  const { call, session, notes } = harness();
  const created = await call('create_task', {
    title: 'Ремонт кухни',
    project: 'Ремонт',
    priority: 3,
    due: '2030-01-15',
    tags: ['#дом'],
    subtasks: ['Купить плитку', 'Нанять мастера'],
  });
  assert.equal(created.isError, false);
  const id = created.json.created.id;
  assert.ok(session.data.projects.some((p) => p.name === 'Ремонт'), 'project auto-created');
  assert.deepEqual(session.data.tasks.find((t) => t.id === id).tags, ['дом']);

  const upd = await call('update_task', { id, status: 'doing', complete_subtasks: ['купить плитку'], add_subtasks: ['Выбрать цвет'] });
  assert.equal(upd.json.updated.status, 'doing');
  assert.equal(upd.json.subtasks.filter((s) => s.done).length, 1);
  assert.equal(upd.json.subtasks.length, 3);

  const listed = await call('list_tasks', { project: 'ремонт' });
  assert.equal(listed.json.length, 1);
  assert.equal(listed.json[0].subtasks, '1/3');

  const bad = await call('update_task', { id, due: '15.01.2030' });
  assert.ok(bad.isError);

  await call('delete_task', { id });
  assert.ok(!session.data.tasks.some((t) => t.id === id));
  assert.ok(notes.length >= 3, 'user is notified about changes');
});

test('overview, notes, mindmaps and boards', async () => {
  const { call, session, opened } = harness();
  const ov = await call('glassboard_overview');
  assert.ok(ov.json.projects.length >= 1);

  const note = await call('create_note', { title: 'План', text: '# Неделя\n- [ ] Спорт\n- [x] Отчёт\nобычный <текст>', pinned: true });
  assert.deepEqual(opened, [note.json.id]);
  const stored = session.data.notes[0];
  assert.ok(stored.pinned);
  assert.ok(stored.body.includes('<div class="todo">Спорт</div>'));
  assert.ok(stored.body.includes('&lt;текст&gt;'), 'note text is escaped');
  const notesList = await call('list_notes');
  assert.ok(notesList.json[0].text.includes('- [x] Отчёт'));

  const map = await call('create_mindmap', { name: 'Отпуск', branches: [{ text: 'Билеты', children: [{ text: 'Самолёт' }] }, { text: 'Отель' }] });
  const got = await call('get_mindmap', { id: 'отпуск' });
  assert.equal(got.json.root.children.length, 2);
  await call('add_mindmap_nodes', { map: map.json.id, parent_id: got.json.root.children[1].id, nodes: [{ text: 'Бронь' }] });
  const again = await call('get_mindmap', { id: map.json.id });
  assert.equal(again.json.root.children[1].children[0].text, 'Бронь');

  const board = await call('add_board_items', { items: [{ text: 'A' }, { type: 'rect', text: 'B' }], connections: [[0, 1], [0, 5]] });
  assert.equal(board.json.items.length, 2);
  assert.equal(session.data.boards[0].connectors.length, 1);
});

test('read-only mode and locked app', async () => {
  const ro = harness({ allowWrite: false });
  const list = await ro.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(list.result.tools.every((t) => t.annotations.readOnlyHint));
  assert.ok((await ro.call('create_task', { title: 'x' })).isError);

  const locked = harness({ locked: true });
  const res = await locked.call('glassboard_overview');
  assert.ok(res.isError);
  assert.match(res.text, /заблокирован/);
});

test('note text round-trips through html', () => {
  const text = '## Заголовок\n- [ ] пункт\n- элемент';
  assert.equal(noteHtmlToText(textToNoteHtml(text)), text);
});

function request(port, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('HTTP transport enforces token and origin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-mcp-'));
  const session = { data: defaultData() };
  const server = new McpServer({
    userData: dir,
    version: 'test',
    getSession: () => session,
    setState: (k, v) => (session.data[k] = v),
    openNote() {},
    closeNote() {},
    allowWrite: () => true,
    notify() {},
  });
  server.config.port = 47000 + Math.floor(Math.random() * 900);
  await server.update({ enabled: true });
  const st = server.status();
  assert.ok(st.running);
  const port = server.port;
  const auth = { Authorization: `Bearer ${st.token}` };
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  try {
    assert.equal((await request(port, { body: ping })).status, 401);
    assert.equal((await request(port, { body: ping, headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await request(port, { body: ping, headers: { ...auth, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(port, { method: 'GET', headers: auth })).status, 405);
    const ok = await request(port, { body: ping, headers: auth });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.result, {});
    assert.equal((await request(port, { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: auth })).status, 202);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
    assert.equal(cfg.token, st.token);
    assert.ok(cfg.tools.length > 5);
    assert.ok(fs.existsSync(path.join(dir, 'mcp-bridge.js')));
    assert.equal(fs.statSync(path.join(dir, 'mcp.json')).mode & 0o077, 0, 'config is private');
  } finally {
    await server.update({ enabled: false });
  }
});
