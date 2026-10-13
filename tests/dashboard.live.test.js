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

// Run the whole live suite with the password gate ON — that is how it is
// deployed, so the tests should exercise the real configuration.
const AUTH_USER = 'live-admin';
const AUTH_PASS = 'live-test-password';
process.env.DASHBOARD_USER     = AUTH_USER;
process.env.DASHBOARD_PASSWORD = AUTH_PASS;

const BASIC       = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
const authHeaders = { Authorization: BASIC };

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

/** Resolve if `event` does NOT arrive within `ms`; reject if it does. */
function noEvent(socket, event, ms = 700) {
  return new Promise((resolve, reject) => {
    const onEvent = () => { clearTimeout(timer); reject(new Error(`unexpected '${event}'`)); };
    const timer = setTimeout(() => { socket.off(event, onEvent); resolve(); }, ms);
    socket.once(event, onEvent);
  });
}

/**
 * Open a second socket, as a second browser tab would.
 *
 * `register` runs BEFORE the connection completes: the server pushes cached
 * state (the QR) immediately on connect, so a listener attached afterwards
 * would miss it entirely and the test would pass or fail on timing.
 */
function connectClient(register) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE, { transports: ['websocket'], reconnection: false, extraHeaders: authHeaders });
    const pending = register?.(socket);
    socket.once('connect', () => resolve({ socket, pending }));
    socket.once('connect_error', reject);
  });
}

let socket;

test.before(async () => {
  if (!server.listening) await new Promise(r => server.once('listening', r));
  socket = ioClient(BASE, { transports: ['websocket'], reconnection: false, extraHeaders: authHeaders });
  await once(socket, 'connect');
});

test.after(async () => {
  socket?.close();
  await new Promise(r => server.close(r));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('GET /api/status reports healthy', async () => {
  const res  = await fetch(`${BASE}/api/status`, { headers: authHeaders });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.status, 'ok');
});

// ── the password gate ────────────────────────────────────────────────────────
// These are the tests that matter: everything above proves the dashboard works,
// these prove it is not open to the internet.

test('anonymous requests are refused before reaching any route', async () => {
  for (const path of ['/', '/api/status', '/api/chats', '/api/autopilot']) {
    const res = await fetch(`${BASE}${path}`);
    assert.strictEqual(res.status, 401, `${path} must require a password`);
  }
});

test('the refusal advertises the realm so browsers prompt', async () => {
  const res = await fetch(`${BASE}/`);
  assert.match(res.headers.get('www-authenticate') || '', /^Basic realm="/);
});

test('the chat archive and its media are behind the gate', async () => {
  // /media holds the photos of every chat — it is static, so it is easy to
  // leave unprotected by registering auth after express.static().
  const res = await fetch(`${BASE}/api/chats`);
  assert.strictEqual(res.status, 401);

  const media = await fetch(`${BASE}/media/.gitkeep`);
  assert.strictEqual(media.status, 401, 'static media must not be public');
});

test('wrong credentials are refused', async () => {
  const bad = 'Basic ' + Buffer.from(`${AUTH_USER}:wrong-password`).toString('base64');
  const res = await fetch(`${BASE}/api/status`, { headers: { Authorization: bad } });
  assert.strictEqual(res.status, 401);
});

test('an anonymous socket connection is refused', async () => {
  // The WebSocket upgrade skips Express, so the io.use() gate is the only
  // thing protecting live chat traffic.
  const anon = ioClient(BASE, { transports: ['websocket'], reconnection: false, timeout: 4000 });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('anonymous socket was NOT refused')), 4000);
      anon.once('connect', () => { clearTimeout(timer); reject(new Error('anonymous socket connected')); });
      anon.once('connect_error', () => { clearTimeout(timer); resolve(); });
    });
  } finally {
    anon.close();
  }
});

test('GET / serves the dashboard UI', async () => {
  const res  = await fetch(`${BASE}/`, { headers: authHeaders });
  const html = await res.text();
  assert.strictEqual(res.status, 200);
  assert.match(html, /WhatsApp Dashboard/);
  assert.match(html, /chat_message_revoked/, 'UI must handle the revoked event');
});

test('the UI renders media rather than a text placeholder', async () => {
  const html = await (await fetch(`${BASE}/`, { headers: authHeaders })).text();
  assert.match(html, /function mediaHtml/, 'attachments need a renderer');
  assert.match(html, /<img class="bubble-media"/, 'chat bubbles must show images');
  assert.match(html, /msg-media/, 'the messages list must show images too');
  assert.match(html, /not saved/, 'unsaved media should say so, not show nothing');
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
  const res  = await fetch(`${BASE}/api/chats?limit=100`, { headers: authHeaders });
  const body = await res.json();
  const found = body.messages.find(m => m.msgId === originalId);
  assert.ok(found, 'recovered deletion must appear in /api/chats');
  assert.strictEqual(found.isDeleted, true);
});

// ── QR hand-off ──────────────────────────────────────────────────────────────
// The QR payload WhatsApp sends is a ~240-char opaque string. Showing that as
// text is unscannable, so the server must deliver a rendered image instead.

const QR_PAYLOAD = `2@${'aB3xZ9'.repeat(38)},1`;

test('a QR is delivered to the browser as a rendered PNG, not raw text', async () => {
  const waiting = once(socket, 'qr');
  logBus.emit('qr', QR_PAYLOAD);

  const payload = await waiting;
  assert.strictEqual(payload.data, QR_PAYLOAD, 'raw payload kept for reference');
  assert.match(payload.image, /^data:image\/png;base64,/, 'must be a renderable image');
  assert.ok(payload.image.length > 1000, 'a real QR image, not a 1px placeholder');
});

test('a browser that connects after the QR was issued still receives it', async () => {
  // Socket.IO does not replay past events, so the server has to cache the last
  // QR — otherwise opening the dashboard a moment too late shows an empty box.
  const { socket: late, pending } = await connectClient(s => once(s, 'qr'));
  try {
    const payload = await pending;
    assert.strictEqual(payload.data, QR_PAYLOAD);
    assert.match(payload.image, /^data:image\/png;base64,/);
  } finally {
    late.close();
  }
});

test('the cached QR is dropped once the session is authenticated', async () => {
  logBus.emit('status', { connected: true, message: 'Authenticated' });

  const { socket: late, pending } = await connectClient(s => noEvent(s, 'qr'));
  try {
    await pending;   // resolves only because nothing was replayed
  } finally {
    late.close();
  }
});

test('a re-delivered message does not produce a duplicate in /api/chats', async () => {
  const msgId = `false_${SENDER}_LIVE004`;
  for (let i = 0; i < 3; i++) {
    await chatStore.addMessage({ msgId, sender: 'Zoe', senderId: '94783811114', body: 'once only', type: 'chat' });
  }
  const res  = await fetch(`${BASE}/api/chats?limit=500`, { headers: authHeaders });
  const body = await res.json();
  assert.strictEqual(body.messages.filter(m => m.msgId === msgId).length, 1);
});
