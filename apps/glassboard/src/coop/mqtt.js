'use strict';

// "Internet (automatic)" transport for co-op rooms: talks MQTT 3.1.1 over
// WebSocket to free public brokers, so a room works across countries with no
// server, port forwarding or tunnel. Payloads are the same end-to-end
// encrypted blobs as with the relay; the broker only sees a hashed topic.
//
// MqttSocket mimics the small WebSocket surface Room uses with the relay
// (onopen/onmessage/onclose, send(json), readyState) and translates the relay
// protocol ({t:'join'}, {t:'msg'}) into MQTT publishes/subscriptions.

const crypto = require('crypto');

const PUBLIC_BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];
const KEEPALIVE = 30; // seconds
const HEARTBEAT_MS = 15000;
const PEER_TIMEOUT_MS = 45000;
const CHUNK = 60000; // characters of ciphertext per MQTT message
const CONNECT_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------- packet codec

function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};

const packet = (first, body) => Buffer.concat([Buffer.from([first]), varint(body.length), body]);

function connectPacket(clientId, will) {
  // clean session, will (QoS 0, not retained)
  const flags = 0x02 | (will ? 0x04 : 0);
  const keep = Buffer.alloc(2);
  keep.writeUInt16BE(KEEPALIVE);
  const parts = [str('MQTT'), Buffer.from([4, flags]), keep, str(clientId)];
  if (will) parts.push(str(will.topic), str(will.payload));
  return packet(0x10, Buffer.concat(parts));
}

function subscribePacket(id, topics) {
  const pid = Buffer.alloc(2);
  pid.writeUInt16BE(id);
  return packet(0x82, Buffer.concat([pid, ...topics.map((t) => Buffer.concat([str(t), Buffer.from([0])]))]));
}

const publishPacket = (topic, payload) => packet(0x30, Buffer.concat([str(topic), Buffer.from(payload, 'utf8')]));
const PINGREQ = Buffer.from([0xc0, 0x00]);
const DISCONNECT = Buffer.from([0xe0, 0x00]);

// Splits a byte stream into MQTT packets.
function parser(onPacket) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      let len = 0;
      let mul = 1;
      let i = 1;
      let b;
      do {
        if (i >= buf.length) return;
        b = buf[i++];
        len += (b & 0x7f) * mul;
        mul *= 128;
      } while (b & 0x80 && i < 5);
      if (buf.length < i + len) return;
      onPacket(buf[0], buf.subarray(i, i + len));
      buf = buf.subarray(i + len);
    }
  };
}

// ---------------------------------------------------------------- socket

class MqttSocket {
  // opts: { WebSocket, brokers, room: { brokerIndex }, roomId }
  constructor(opts) {
    this.opts = opts;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.peerId = null;
    this.lastSeen = new Map();
    this.chunks = new Map();
    this.timers = [];
    this.closed = false;
    this.connacked = false;

    const brokers = opts.brokers && opts.brokers.length ? opts.brokers : PUBLIC_BROKERS;
    const state = opts.room;
    this.url = brokers[(state.brokerIndex || 0) % brokers.length];
    this.base = 'glassboard/v1/' + crypto.createHash('sha256').update(String(opts.roomId)).digest('hex').slice(0, 32);

    let ws;
    try {
      ws = new opts.WebSocket(this.url, ['mqtt']);
    } catch (err) {
      setTimeout(() => this.fail(err.message), 0);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    const feed = parser((first, body) => this.onPacket(first, body));
    ws.onopen = () => {
      this.readyState = 1; // the Room sends {t:'join'} right away; CONNECT happens there
      this.onopen && this.onopen();
    };
    ws.onmessage = (ev) => feed(Buffer.from(ev.data));
    ws.onerror = () => this.onerror && this.onerror({ message: 'MQTT ' + this.url });
    ws.onclose = () => this.fail();
    this.timers.push(
      setTimeout(() => {
        if (!this.connacked) this.fail('timeout');
      }, CONNECT_TIMEOUT_MS)
    );
  }

  fail() {
    if (this.closed) return;
    // next attempt goes to the next broker in the list unless this one ever worked
    if (!this.connacked) this.opts.room.brokerIndex = (this.opts.room.brokerIndex || 0) + 1;
    this.shutdown();
    this.onclose && this.onclose();
  }

  shutdown() {
    this.closed = true;
    this.readyState = 3;
    for (const t of this.timers) clearTimeout(t), clearInterval(t);
    this.timers = [];
    try {
      this.ws && this.ws.close();
    } catch {
      /* ignore */
    }
  }

  raw(buf) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(buf);
  }

  emit(obj) {
    this.onmessage && this.onmessage({ data: JSON.stringify(obj) });
  }

  publish(topic, obj) {
    this.raw(publishPacket(topic, JSON.stringify(obj)));
  }

  // Relay-protocol messages from Room
  send(text) {
    const msg = JSON.parse(text);
    if (msg.t === 'join') {
      this.peerId = msg.peer;
      const will = { topic: this.base + '/all', payload: JSON.stringify({ from: msg.peer, leave: 1 }) };
      this.raw(connectPacket('gb_' + msg.peer, will));
    } else if (msg.t === 'msg' && this.connacked) {
      const topic = msg.to ? `${this.base}/p/${msg.to}` : `${this.base}/all`;
      if (msg.data.length <= CHUNK) this.publish(topic, { from: this.peerId, data: msg.data });
      else {
        const cid = crypto.randomBytes(6).toString('base64url');
        const n = Math.ceil(msg.data.length / CHUNK);
        for (let i = 0; i < n; i++) this.publish(topic, { from: this.peerId, cid, i, n, part: msg.data.slice(i * CHUNK, (i + 1) * CHUNK) });
      }
    }
  }

  close() {
    if (this.closed) return;
    if (this.connacked) {
      this.publish(this.base + '/all', { from: this.peerId, leave: 1 });
      this.raw(DISCONNECT);
    }
    this.shutdown();
    this.onclose && this.onclose();
  }

  onPacket(first, body) {
    const type = first >> 4;
    if (type === 2) {
      // CONNACK
      if (body[1] !== 0) return this.fail('refused ' + body[1]);
      this.connacked = true;
      this.raw(subscribePacket(1, [this.base + '/all', `${this.base}/p/${this.peerId}`]));
    } else if (type === 9) {
      // SUBACK: we are in the room
      this.emit({ t: 'joined', peers: [] });
      this.timers.push(setInterval(() => this.raw(PINGREQ), (KEEPALIVE * 1000) / 2));
      this.timers.push(setInterval(() => this.publish(this.base + '/all', { from: this.peerId, hb: 1 }), HEARTBEAT_MS));
      this.timers.push(setInterval(() => this.sweep(), 5000));
    } else if (type === 3) {
      const qos = (first >> 1) & 3;
      const tlen = body.readUInt16BE(0);
      const payload = body.subarray(2 + tlen + (qos ? 2 : 0)).toString('utf8');
      let m;
      try {
        m = JSON.parse(payload);
      } catch {
        return;
      }
      this.onPublish(m);
    }
  }

  onPublish(m) {
    if (!m || typeof m.from !== 'string' || m.from === this.peerId) return;
    if (m.leave) {
      if (this.lastSeen.delete(m.from)) this.emit({ t: 'peer-leave', peer: m.from });
      return;
    }
    this.lastSeen.set(m.from, Date.now());
    if (m.hb) return;
    if (typeof m.data === 'string') return this.emit({ t: 'msg', from: m.from, data: m.data });
    if (m.cid && Number.isInteger(m.i) && Number.isInteger(m.n) && m.n < 2000) {
      const key = m.from + ':' + m.cid;
      const entry = this.chunks.get(key) || { parts: new Array(m.n), got: 0, at: Date.now() };
      if (!entry.parts[m.i]) {
        entry.parts[m.i] = String(m.part || '');
        entry.got++;
      }
      this.chunks.set(key, entry);
      if (entry.got === m.n) {
        this.chunks.delete(key);
        this.emit({ t: 'msg', from: m.from, data: entry.parts.join('') });
      }
    }
  }

  sweep() {
    const now = Date.now();
    for (const [peer, at] of this.lastSeen) {
      if (now - at > PEER_TIMEOUT_MS) {
        this.lastSeen.delete(peer);
        this.emit({ t: 'peer-leave', peer });
      }
    }
    for (const [k, e] of this.chunks) if (now - e.at > 60000) this.chunks.delete(k);
  }
}

module.exports = { MqttSocket, PUBLIC_BROKERS };
