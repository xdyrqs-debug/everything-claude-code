#!/usr/bin/env node
'use strict';

// stdio <-> HTTP bridge for Claude Desktop (and any stdio-only MCP client).
// Usage: node mcp-bridge.js <path to Glassboard's mcp.json>
// Run by the Glassboard binary itself with ELECTRON_RUN_AS_NODE=1, so no
// separate Node.js install is needed. Each JSON-RPC line from stdin is
// forwarded to the running app; when the app is closed, the bridge still
// answers the handshake and lists tools so the client keeps them.

const fs = require('fs');
const http = require('http');
const readline = require('readline');

const configPath = process.argv[2];
const PROTOCOL = '2025-06-18';

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function post(cfg, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(cfg.url);
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${cfg.token}`,
          'Content-Length': payload.length,
        },
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 202 || !text) return resolve(null);
          if (res.statusCode === 401) return reject(new Error('Токен Glassboard изменился — обновите конфигурацию Claude из настроек Glassboard.'));
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`Некорректный ответ Glassboard (${res.statusCode})`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Glassboard не отвечает')));
    req.on('error', reject);
    req.end(payload);
  });
}

function offline(msg, reason) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.id === undefined || msg.id === null) return null;
  const cfg = readConfig() || {};
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'glassboard', title: 'Glassboard', version: 'bridge' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: (cfg.tools || [])
          .filter((t) => cfg.allowWrite !== false || t.readOnly)
          .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call':
      return reply({
        content: [
          {
            type: 'text',
            text: `Glassboard недоступен: ${reason}. Попросите пользователя открыть Glassboard, разблокировать его и включить «Подключение Claude (MCP)» в настройках.`,
          },
        ],
        isError: true,
      });
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

function write(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const cfg = readConfig();
  if (!cfg || !cfg.enabled || !cfg.url || !cfg.token) {
    return write(Array.isArray(msg) ? msg.map((m) => offline(m, 'MCP выключен')).filter(Boolean) : offline(msg, 'MCP выключен'));
  }
  try {
    write(await post(cfg, msg));
  } catch (err) {
    const reason = err.code === 'ECONNREFUSED' ? 'приложение не запущено' : err.message;
    write(Array.isArray(msg) ? msg.map((m) => offline(m, reason)).filter(Boolean) : offline(msg, reason));
  }
}

if (!configPath) {
  process.stderr.write('Usage: mcp-bridge.js <path/to/mcp.json>\n');
  process.exit(2);
}

// Keep request order: process lines one after another.
let queue = Promise.resolve();
readline
  .createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', (line) => {
    if (line.trim()) queue = queue.then(() => handle(line));
  })
  .on('close', () => queue.then(() => process.exit(0)));
