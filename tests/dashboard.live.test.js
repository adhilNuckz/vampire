/**
 * tests/dashboard.live.test.js
 * ─────────────────────────────────────────────────────────────
 * End-to-end check of the "deleted message" flow over the real stack:
 * Express + Socket.IO server, the actual in-process logBus bridge that the
 * bot uses, and a real Socket.IO client — exactly what a browser sees.
 *
 * Run:  npm run test:live
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const os     = require('node:os');
const fs     = require('node:fs');

// ── isolate: own DB + log dir, and a port unlikely to collide ────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vampire-live-'));
process.chdir(sandbox);
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });

const PORT = 5187;
process.env.DASHBOARD_PORT = String(PORT);
process.env.LOG_DIR        = path.join(sandbox, 'logs');

const { logger, logBus } = require('../src/utils/logger');
const { server }         = require('../src/dashboard/index.js');
const chatStore          = require('../src/services/chatStore');
const { resolveRevokeIds, describeMessage } = require('../src/services/revokeResolver');
const { io: ioClient }   = require('socket.io-client');

const SENDER = '94783811114@c.us';
const BASE   = `http://127.0.0.1:${PORT}`;

/** Wait for `event` on a socket, or reject after `timeout` ms. */
function once(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeout);
    socket.once(event, payload => { clearTimeout(timer); resolve(payload); });
  });
}

let socket;

test.before(async () => {
  if (!server.listening) await new Promise(r => server.once('listening', r));
  socket = ioClient(BASE, { transports: ['websocket'], reconnection: false });
  await once(socket, 'connect');
});

test.after(async () => {
  socket?.close();
  await new Promise(r => server.close(r));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('GET /api/status reports healthy', async () => {
  const res  = await fetch(`${BASE}/api/status`);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.status, 'ok');
});

test('GET / serves the dashboard UI', async () => {
  const res  = await fetch(`${BASE}/`);
  const html = await res.text();
  assert.strictEqual(res.status, 200);
  assert.match(html, /WhatsApp Dashboard/);
  assert.match(html, /chat_message_revoked/, 'UI must handle the revoked event');
});

test('capturing a message pushes new_chat_message to browsers', async () => {
  const msgId = `false_${SENDER}_LIVE001`;
  const waiting = once(socket, 'new_chat_message');

  await chatStore.addMessage({ msgId, sender: 'Zoe', senderId: '94783811114', body: 'live hello', type: 'chat' });
  const { message } = await chatStore.addMessage({ msgId, sender: 'Zoe', senderId: '94783811114', body: 'live hello', type: 'chat' });
  logBus.emit('chat_message', message);

  const received = await waiting;
  assert.strictEqual(received.msgId, msgId);
  assert.strictEqual(received.body, 'live hello');
});

test('a deleted message reaches the browser with its original body intact', async () => {
  const msgId = `false_${SENDER}_LIVE002`;
  await chatStore.addMessage({
    msgId, sender: 'Zoe', senderId: '94783811114', body: 'I regret sending this', type: 'chat',
  });

  const waiting = once(socket, 'chat_message_revoked');

  // Exactly what the bot's message_revoke_everyone handler does.
  const updated = await chatStore.revokeMessage(msgId);
  logBus.emit('chat_message_revoked', updated);

  const received = await waiting;
  assert.strictEqual(received.msgId, msgId);
  assert.strictEqual(received.isDeleted, true);
  assert.strictEqual(received.body, 'I regret sending this', 'the whole point: text survives deletion');
  assert.ok(received.deletedAt > 0);
});

test('the full revoke handler recovers a message that was never captured', async () => {
  // Mirrors bot/index.js handleRevoke() when no known id matches.
  const originalId = `false_${SENDER}_LIVE003`;
  const after  = { id: { fromMe: false, remote: SENDER, id: 'PROTOCOL_X', _serialized: `false_${SENDER}_PROTOCOL_X` } };
  const before = {
    id: { fromMe: false, remote: SENDER, id: 'LIVE003', _serialized: originalId },
    from: SENDER, fromMe: false, body: 'deleted before we ever saw it',
    type: 'chat', timestamp: 1_700_000_000, hasMedia: false,
  };

  const waiting = once(socket, 'chat_message_revoked');

  let entry = null;
  for (const id of resolveRevokeIds(after, before)) {
    entry = await chatStore.revokeMessage(id);
    if (entry) break;
  }
  assert.strictEqual(entry, null, 'nothing was captured, so nothing should match');

  const info  = describeMessage(before);
  const saved = await chatStore.markDeleted({
    msgId: originalId, sender: info.sender, senderId: info.senderId,
    body: info.body, type: info.type, ts: info.ts,
  });
  logBus.emit('chat_message_revoked', saved);

  const received = await waiting;
  assert.strictEqual(received.msgId, originalId);
  assert.strictEqual(received.isDeleted, true);
  assert.strictEqual(received.body, 'deleted before we ever saw it');

  // …and it is readable back out through the dashboard's own API.
  const res  = await fetch(`${BASE}/api/chats?limit=100`);
  const body = await res.json();
  const found = body.messages.find(m => m.msgId === originalId);
  assert.ok(found, 'recovered deletion must appear in /api/chats');
  assert.strictEqual(found.isDeleted, true);
});

test('a re-delivered message does not produce a duplicate in /api/chats', async () => {
  const msgId = `false_${SENDER}_LIVE004`;
  for (let i = 0; i < 3; i++) {
    await chatStore.addMessage({ msgId, sender: 'Zoe', senderId: '94783811114', body: 'once only', type: 'chat' });
  }
  const res  = await fetch(`${BASE}/api/chats?limit=500`);
  const body = await res.json();
  assert.strictEqual(body.messages.filter(m => m.msgId === msgId).length, 1);
});
