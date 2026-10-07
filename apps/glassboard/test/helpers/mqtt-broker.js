'use strict';

// Local MQTT-over-WebSocket broker (Aedes) standing in for the public brokers.
const http = require('http');
const { WebSocketServer, createWebSocketStream } = require('ws');
const aedes = require('aedes');

async function startBroker() {
  const broker = typeof aedes.createBroker === 'function' ? await aedes.createBroker() : aedes();
  const server = http.createServer();
  const wss = new WebSocketServer({ server, handleProtocols: (protocols) => (protocols.has('mqtt') ? 'mqtt' : false) });
  wss.on('connection', (ws) => broker.handle(createWebSocketStream(ws)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/mqtt`;
  return {
    url,
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => server.close(r));
      await new Promise((r) => broker.close(r));
    },
  };
}

module.exports = { startBroker };
