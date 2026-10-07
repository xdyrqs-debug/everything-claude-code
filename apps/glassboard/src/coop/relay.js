#!/usr/bin/env node
'use strict';

// Glassboard co-op relay: a tiny dependency-free WebSocket server that
// forwards end-to-end encrypted messages between peers of the same room.
// It never sees keys or plaintext — only room ids and ciphertext.
//
// Runs inside the Glassboard app ("this computer" relay) or standalone:
//   PORT=47900 node relay.js
//
// Wire protocol (JSON text frames):
//   client -> relay  {t:'join', room, peer}          join a room
//                    {t:'msg', data, to?}             broadcast (or send to one peer)
//   relay -> client  {t:'joined', peers:[...]}        peers already in the room
//                    {t:'peer-join', peer} / {t:'peer-leave', peer}
//                    {t:'msg', from, data}
//                    {t:'error', message}

const http = require('http');
const crypto = require('crypto');

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_PEERS = 16;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------------------------------------------------------------- minimal RFC 6455 server side

class Socket {
  constructor(sock, onMessage, onClose) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    this.alive = true;
    this.onMessage = onMessage;
    this.onClose = onClose;
    sock.setNoDelay(true);
    sock.on('data', (d) => this.onData(d));
    sock.on('close', () => this.finish());
    sock.on('error', () => this.finish());
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return this.close(1009);
        len = Number(big);
        off = 10;
      }
      if (len > MAX_FRAME) return this.close(1009);
      if (!masked) return this.close(1002); // clients must mask
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      if (opcode === 0x8) return this.close(1000);
      if (opcode === 0x9) this.frame(0xa, payload);
      else if (opcode === 0xa) this.alive = true;
      else if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        const total = this.fragments.reduce((a, f) => a + f.length, 0);
        if (total > MAX_FRAME) return this.close(1009);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.onMessage(text);
        }
      } else if (opcode === 0x2) return this.close(1003);
    }
  }

  frame(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.sock.write(Buffer.concat([header, payload]));
  }

  send(obj) {
    this.frame(0x1, Buffer.from(JSON.stringify(obj)));
  }

  ping() {
    this.frame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this.frame(0x8, p);
    this.sock.end();
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.sock.destroy();
    this.onClose();
  }
}

// ---------------------------------------------------------------- relay

function createRelay({ log = () => {} } = {}) {
  const rooms = new Map(); // room -> Map(peer -> Socket)

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Glassboard relay is running\n');
  });

  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    let room = null;
    let peer = null;
    const ws = new Socket(
      sock,
      (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return ws.send({ t: 'error', message: 'bad json' });
        }
        if (msg.t === 'join' && !room) {
          if (!/^[A-Za-z0-9_-]{16,64}$/.test(msg.room || '') || !/^[A-Za-z0-9_-]{4,64}$/.test(msg.peer || '')) {
            return ws.send({ t: 'error', message: 'bad room or peer id' });
          }
          const members = rooms.get(msg.room) || new Map();
          if (members.size >= MAX_PEERS) return ws.send({ t: 'error', message: 'room is full' });
          if (members.has(msg.peer)) members.get(msg.peer).close(4000); // reconnect replaces stale socket
          room = msg.room;
          peer = msg.peer;
          ws.send({ t: 'joined', peers: [...members.keys()] });
          for (const other of members.values()) other.send({ t: 'peer-join', peer });
          members.set(peer, ws);
          rooms.set(room, members);
          log(`join ${room.slice(0, 6)}… ${peer} (${members.size})`);
        } else if (msg.t === 'msg' && room && typeof msg.data === 'string') {
          const members = rooms.get(room);
          if (!members) return;
          const out = { t: 'msg', from: peer, data: msg.data };
          if (msg.to) members.get(msg.to)?.send(out);
          else for (const [id, other] of members) if (id !== peer) other.send(out);
        }
      },
      () => {
        if (!room) return;
        const members = rooms.get(room);
        if (members && members.get(peer) === ws) {
          members.delete(peer);
          for (const other of members.values()) other.send({ t: 'peer-leave', peer });
          if (!members.size) rooms.delete(room);
          log(`leave ${room.slice(0, 6)}… ${peer} (${members.size})`);
        }
      }
    );
    sockets.add(ws);
    sock.on('close', () => sockets.delete(ws));
  });

  const sockets = new Set();
  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (!ws.alive) ws.close(1001);
      else {
        ws.alive = false;
        ws.ping();
      }
    }
  }, 25000);
  heartbeat.unref();

  return {
    server,
    rooms,
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of sockets) ws.close(1001);
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createRelay };

if (require.main === module) {
  const port = Number(process.env.PORT) || 47900;
  createRelay({ log: (m) => console.log(new Date().toISOString(), m) })
    .listen(port)
    .then((p) => console.log(`Glassboard relay listening on :${p}`));
}
