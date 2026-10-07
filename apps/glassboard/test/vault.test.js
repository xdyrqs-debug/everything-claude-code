'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('../src/main/vault');
const { defaultData, migrate } = require('../src/main/defaults');

// Cheap scrypt params keep the suite fast; production uses N = 2^15.
const FAST = { N: 1 << 10, r: 8, p: 1, keylen: 32 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glassboard-'));

test('profile round-trips data with the right password', async () => {
  const vault = new Vault(tmp(), FAST);
  const data = defaultData('Аня');
  const { profile } = await vault.createProfile('Аня', 'secret1', data);
  assert.equal(vault.listProfiles().length, 1);
  const { data: loaded } = await vault.unlock(profile.id, 'secret1');
  assert.deepEqual(loaded, data);
});

test('wrong password is rejected and file is not plaintext', async () => {
  const dir = tmp();
  const vault = new Vault(dir, FAST);
  const { profile } = await vault.createProfile('Bob', 'correct', { tasks: [{ title: 'top secret plan' }] });
  await assert.rejects(vault.unlock(profile.id, 'wrong'), { code: 'BAD_PASSWORD' });
  const raw = fs.readFileSync(path.join(dir, `${profile.id}.vault`), 'utf8');
  assert.ok(!raw.includes('top secret plan'));
});

test('short passwords are refused', async () => {
  const vault = new Vault(tmp(), FAST);
  await assert.rejects(vault.createProfile('X', '123', {}), /не короче/);
});

test('change password re-keys the vault', async () => {
  const vault = new Vault(tmp(), FAST);
  const { profile, session } = await vault.createProfile('C', 'old-pass', { a: 1 });
  await assert.rejects(vault.changePassword(session, { a: 2 }, 'nope', 'new-pass'), { code: 'BAD_PASSWORD' });
  await vault.changePassword(session, { a: 2 }, 'old-pass', 'new-pass');
  await assert.rejects(vault.unlock(profile.id, 'old-pass'), { code: 'BAD_PASSWORD' });
  const { data } = await vault.unlock(profile.id, 'new-pass');
  assert.deepEqual(data, { a: 2 });
});

test('multiple profiles are isolated and deletable', async () => {
  const vault = new Vault(tmp(), FAST);
  const a = await vault.createProfile('A', 'pass-a', { who: 'a' });
  const b = await vault.createProfile('B', 'pass-b', { who: 'b' });
  await assert.rejects(vault.unlock(a.profile.id, 'pass-b'));
  assert.equal((await vault.unlock(b.profile.id, 'pass-b')).data.who, 'b');
  await assert.rejects(vault.deleteProfile(a.profile.id, 'bad'));
  await vault.deleteProfile(a.profile.id, 'pass-a');
  assert.deepEqual(vault.listProfiles().map((p) => p.name), ['B']);
});

test('profile ids cannot escape the vault directory', () => {
  const vault = new Vault(tmp(), FAST);
  assert.throws(() => vault.fileFor('../evil'));
});

test('migrate fills new settings without losing data', () => {
  const out = migrate({ tasks: [{ id: 1 }], settings: { theme: 'dark', fonts: { h1: { family: 'X', size: 30, weight: 800 } } } });
  assert.equal(out.tasks.length, 1);
  assert.equal(out.settings.theme, 'dark');
  assert.equal(out.settings.fonts.h1.family, 'X');
  assert.ok(out.settings.fonts.body);
  assert.ok(out.projects.some((p) => p.id === 'inbox'));
});
