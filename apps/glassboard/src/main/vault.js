'use strict';

// Encrypted per-profile storage.
// Each profile is a JSON file whose payload is AES-256-GCM encrypted with a key
// derived from the user's password via scrypt. Nothing about the password is
// stored: a wrong password simply fails GCM authentication.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_KDF = { N: 1 << 15, r: 8, p: 1, keylen: 32 };
const MIN_PASSWORD_LENGTH = 4;

class BadPasswordError extends Error {
  constructor() {
    super('Неверный пароль');
    this.code = 'BAD_PASSWORD';
  }
}

function deriveKey(password, salt, kdf = DEFAULT_KDF) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password).normalize('NFKC'),
      salt,
      kdf.keylen,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

function encrypt(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(key, blob) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new BadPasswordError();
  }
}

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`);
  }
}

class Vault {
  constructor(dir, kdf = DEFAULT_KDF) {
    this.dir = dir;
    this.kdf = kdf;
    fs.mkdirSync(dir, { recursive: true });
    this.indexFile = path.join(dir, 'profiles.json');
  }

  listProfiles() {
    try {
      const list = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      return Array.isArray(list) ? list.filter((p) => fs.existsSync(this.fileFor(p.id))) : [];
    } catch {
      return [];
    }
  }

  fileFor(id) {
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Некорректный профиль');
    return path.join(this.dir, `${id}.vault`);
  }

  saveIndex(list) {
    writeAtomic(this.indexFile, JSON.stringify(list, null, 2));
  }

  async createProfile(name, password, data, color = '#7aa2ff') {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Введите имя');
    validatePassword(password);
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16);
    const key = await deriveKey(password, salt, this.kdf);
    const session = { id, key, salt, kdf: this.kdf };
    this.save(session, data);
    const profile = { id, name: trimmed.slice(0, 40), color, createdAt: Date.now() };
    this.saveIndex([...this.listProfiles(), profile]);
    return { profile, session };
  }

  readFile(id) {
    return JSON.parse(fs.readFileSync(this.fileFor(id), 'utf8'));
  }

  async unlock(id, password) {
    const file = this.readFile(id);
    const salt = Buffer.from(file.salt, 'base64');
    const kdf = file.kdf || this.kdf;
    const key = await deriveKey(password, salt, kdf);
    const data = decrypt(key, file);
    return { session: { id, key, salt, kdf }, data };
  }

  save(session, data) {
    const payload = {
      v: 1,
      salt: session.salt.toString('base64'),
      kdf: session.kdf,
      ...encrypt(session.key, data),
    };
    writeAtomic(this.fileFor(session.id), JSON.stringify(payload));
  }

  async changePassword(session, data, oldPassword, newPassword) {
    validatePassword(newPassword);
    await this.unlock(session.id, oldPassword); // throws BadPasswordError
    const salt = crypto.randomBytes(16);
    const key = await deriveKey(newPassword, salt, this.kdf);
    const next = { id: session.id, key, salt, kdf: this.kdf };
    this.save(next, data);
    return next;
  }

  async deleteProfile(id, password) {
    await this.unlock(id, password);
    fs.rmSync(this.fileFor(id), { force: true });
    this.saveIndex(this.listProfiles().filter((p) => p.id !== id));
  }

  renameProfile(id, patch) {
    const list = this.listProfiles().map((p) =>
      p.id === id
        ? {
            ...p,
            name: patch.name ? String(patch.name).trim().slice(0, 40) || p.name : p.name,
            color: patch.color || p.color,
          }
        : p
    );
    this.saveIndex(list);
    return list.find((p) => p.id === id);
  }
}

module.exports = { Vault, BadPasswordError, deriveKey, encrypt, decrypt, MIN_PASSWORD_LENGTH };
