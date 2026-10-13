/**
 * tests/revoke.test.js
 * ─────────────────────────────────────────────────────────────
 * Covers the anti-delete ("deleted message") pipeline without WhatsApp:
 * the id-resolution helpers, and the capture → de-duplicate → revoke flow
 * through chatStore against a throwaway SQLite file.
 *
 * Run:  npm test
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const os     = require('node:os');
const fs     = require('node:fs');

// ── isolate the DB before loading anything that touches it ────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vampire-test-'));
process.chdir(sandbox);
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });

const {
  resolveRevokeIds, idCandidates, parseSerializedId, serializedFromKey, messageIdOf,
  describeMessage,
} = require('../src/services/revokeResolver');
const chatStore = require('../src/services/chatStore');

const SENDER = '94783811114@c.us';
const OTHER  = '94770000000@c.us';
const RAW_ID = '3EB0CAFEBABE1234';

/** A whatsapp-web.js-shaped message id. */
const mkId = (fromMe, remote, id) => ({
  fromMe, remote, id, _serialized: `${fromMe}_${remote}_${id}`,
});

/** A whatsapp-web.js-shaped Message. */
const mkMessage = (overrides = {}) => ({
  id:         mkId(false, SENDER, RAW_ID),
  from:       SENDER,
  to:         mkId(false, SENDER, RAW_ID) && 'me@c.us',
  fromMe:     false,
  body:       'the original message',
  type:       'chat',
  timestamp:  1_700_000_000,
  hasMedia:   false,
  protocolMessageKey: undefined,
  ...overrides,
});

// ═════════════════════════════════════════════════════════════════════════════
// revokeResolver
// ═════════════════════════════════════════════════════════════════════════════

test('parseSerializedId splits on the outer underscores only', () => {
  assert.deepStrictEqual(
    parseSerializedId(`false_${SENDER}_${RAW_ID}`),
    { fromMe: false, remote: SENDER, id: RAW_ID }
  );
  assert.strictEqual(parseSerializedId('garbage'), null);
  assert.strictEqual(parseSerializedId(''), null);
});

test('serializedFromKey accepts both string and Wid-object remote', () => {
  assert.strictEqual(
    serializedFromKey({ fromMe: false, remote: SENDER, id: RAW_ID }),
    `false_${SENDER}_${RAW_ID}`
  );
  assert.strictEqual(
    serializedFromKey({ fromMe: true, remote: { _serialized: SENDER }, id: RAW_ID }),
    `true_${SENDER}_${RAW_ID}`
  );
  assert.strictEqual(serializedFromKey(null), null);
});

test('idCandidates prefers protocolMessageKey over msg.id', () => {
  const originalId = `false_${SENDER}_ORIGINAL`;
  const msg = mkMessage({
    id: mkId(false, SENDER, 'PROTOCOL_MSG_ID'),
    protocolMessageKey: mkId(false, SENDER, 'ORIGINAL'),
  });
  assert.deepStrictEqual(idCandidates(msg), [originalId, `false_${SENDER}_PROTOCOL_MSG_ID`]);
});

test('resolveRevokeIds returns the pre-revoke snapshot id first', () => {
  const after  = mkMessage({ id: mkId(false, SENDER, 'PROTOCOL') });
  const before = mkMessage({ id: mkId(false, SENDER, 'ORIGINAL') });
  assert.deepStrictEqual(resolveRevokeIds(after, before), [
    `false_${SENDER}_ORIGINAL`,
    `false_${SENDER}_PROTOCOL`,
  ]);
});

test('resolveRevokeIds copes with the undefined revoked_msg the library warns about', () => {
  const after = mkMessage();
  assert.deepStrictEqual(resolveRevokeIds(after, undefined), [`false_${SENDER}_${RAW_ID}`]);
  assert.deepStrictEqual(resolveRevokeIds(undefined, undefined), []);
});

// ── messageIdOf ──────────────────────────────────────────────────────────────
// On the current WhatsApp Web build the library's getMessageModel rebuilds the
// id with Object.assign, which drops the `_serialized` getter. Capturing via
// message.id._serialized then stored an EMPTY id for every message, which broke
// de-duplication and made deletions unmatchable. Rebuilding from the parts is
// what makes capture and revoke agree.

test('messageIdOf uses _serialized when the build provides it', () => {
  assert.strictEqual(messageIdOf(mkMessage()), `false_${SENDER}_${RAW_ID}`);
});

test('messageIdOf rebuilds the id when _serialized is missing', () => {
  // exactly the shape Object.assign({}, msg.id, {remote}) produces
  const msg = mkMessage({ id: { fromMe: false, remote: SENDER, id: RAW_ID } });
  assert.strictEqual(messageIdOf(msg), `false_${SENDER}_${RAW_ID}`);
});

test('messageIdOf rebuilds the id when remote is an un-serialized Wid', () => {
  const msg = mkMessage({ id: { fromMe: true, remote: { _serialized: OTHER }, id: RAW_ID } });
  assert.strictEqual(messageIdOf(msg), `true_${OTHER}_${RAW_ID}`);
});

test('messageIdOf accepts a bare string id', () => {
  assert.strictEqual(messageIdOf({ id: 'plain-id' }), 'plain-id');
});

test('messageIdOf returns "" rather than throwing on junk', () => {
  assert.strictEqual(messageIdOf(null), '');
  assert.strictEqual(messageIdOf({}), '');
  assert.strictEqual(messageIdOf({ id: {} }), '');
  assert.strictEqual(messageIdOf({ id: { fromMe: false, id: RAW_ID } }), ''); // no remote
});

test('a captured id round-trips: what capture stores, a revoke can match', () => {
  // This is the property that actually matters end to end.
  const storedId = messageIdOf(mkMessage({ id: { fromMe: false, remote: SENDER, id: RAW_ID } }));
  const revokedId = resolveRevokeIds(
    mkMessage({ id: { fromMe: false, remote: SENDER, id: 'PROTOCOL' } }),
    mkMessage({ id: { fromMe: false, remote: SENDER, id: RAW_ID } })
  );
  assert.ok(revokedId.includes(storedId), `revoke candidates ${revokedId} must include stored ${storedId}`);
});

test('describeMessage keeps the original body and marks the sender', () => {
  const info = describeMessage(mkMessage());
  assert.strictEqual(info.body, 'the original message');
  assert.strictEqual(info.senderId, '94783811114');
  assert.strictEqual(info.sender, '94783811114');
  assert.strictEqual(info.ts, 1_700_000_000_000);
});

test('describeMessage labels our own messages "Me"', () => {
  const info = describeMessage(mkMessage({ fromMe: true, from: 'me@c.us', to: OTHER }));
  assert.strictEqual(info.sender, 'Me');
  assert.strictEqual(info.senderId, '94770000000');
});

// ═════════════════════════════════════════════════════════════════════════════
// chatStore: capture → duplicate → revoke
// ═════════════════════════════════════════════════════════════════════════════

test('capturing the same msgId twice creates exactly one row', async () => {
  const msgId = `false_${SENDER}_DUP001`;
  const first  = await chatStore.addMessage({ msgId, sender: 'Alice', senderId: '94783811114', body: 'hi', type: 'chat' });
  const second = await chatStore.addMessage({ msgId, sender: 'Alice', senderId: '94783811114', body: 'hi', type: 'chat' });

  assert.strictEqual(first.created, true, 'first capture should insert');
  assert.strictEqual(second.created, false, 're-delivery must not insert');
  assert.strictEqual(first.message.id, second.message.id, 'same row id');

  const stored = (await chatStore.getMessages(500)).filter(m => m.msgId === msgId);
  assert.strictEqual(stored.length, 1, 'exactly one row for this msgId');
});

test('a ciphertext re-delivery enriches the row without duplicating it', async () => {
  const msgId = `false_${SENDER}_CIPHER01`;
  await chatStore.addMessage({ msgId, sender: 'Bob', senderId: '94783811114', body: '', type: 'ciphertext' });
  const { created, message } = await chatStore.addMessage({
    msgId, sender: 'Bob', senderId: '94783811114', body: 'secret photo', type: 'image', mediaUrl: '/media/x.jpg',
  });

  assert.strictEqual(created, false);
  assert.strictEqual(message.type, 'image');
  assert.strictEqual(message.body, 'secret photo');
  assert.strictEqual(message.mediaUrl, '/media/x.jpg');

  const stored = (await chatStore.getMessages(500)).filter(m => m.msgId === msgId);
  assert.strictEqual(stored.length, 1);
});

test('revoking keeps the original body and marks it deleted', async () => {
  const msgId = `false_${SENDER}_REV001`;
  await chatStore.addMessage({ msgId, sender: 'Carol', senderId: '94783811114', body: 'you cannot unsay this', type: 'chat' });

  const updated = await chatStore.revokeMessage(msgId);
  assert.ok(updated, 'revoke should find the message');
  assert.strictEqual(updated.isDeleted, true);
  assert.strictEqual(updated.body, 'you cannot unsay this', 'body must survive the revoke');
  assert.ok(updated.deletedAt > 0);

  // and the change is persisted, not just in the returned object
  const stored = (await chatStore.getMessages(500)).find(m => m.msgId === msgId);
  assert.strictEqual(stored.isDeleted, true);
  assert.strictEqual(stored.body, 'you cannot unsay this');
});

test('revoking an unknown msgId reports "not found" instead of throwing', async () => {
  assert.strictEqual(await chatStore.revokeMessage(`false_${SENDER}_NOPE`), null);
  assert.strictEqual(await chatStore.revokeMessage(''), null);
  assert.strictEqual(await chatStore.revokeMessage(null), null);
});

test('a deletion for a never-captured message is still recorded', async () => {
  const msgId = `false_${SENDER}_MISSED1`;
  const entry = await chatStore.markDeleted({
    msgId, sender: 'Dave', senderId: '94783811114', body: 'deleted before we saw it', type: 'chat', ts: 1_600_000_000_000,
  });

  assert.strictEqual(entry.isDeleted, true);
  assert.strictEqual(entry.body, 'deleted before we saw it');

  const stored = (await chatStore.getMessages(500)).find(m => m.msgId === msgId);
  assert.strictEqual(stored.isDeleted, true);
  assert.strictEqual(stored.body, 'deleted before we saw it');
});

test('markDeleted on an already-captured message preserves its media', async () => {
  const msgId = `false_${SENDER}_MISSED2`;
  await chatStore.addMessage({
    msgId, sender: 'Erin', senderId: '94783811114', body: '', type: 'image', mediaUrl: '/media/kept.jpg',
  });

  const entry = await chatStore.markDeleted({ msgId, sender: 'Erin', senderId: '94783811114', body: '', type: 'image' });
  assert.strictEqual(entry.isDeleted, true);
  assert.strictEqual(entry.mediaUrl, '/media/kept.jpg', 'media must not be dropped by the revoke path');
  assert.strictEqual((await chatStore.getMessages(500)).filter(m => m.msgId === msgId).length, 1);
});

test('a revoked message is never resurrected by a late re-delivery', async () => {
  const msgId = `false_${SENDER}_LATE01`;
  await chatStore.addMessage({ msgId, sender: 'Frank', senderId: '94783811114', body: 'original', type: 'chat' });
  await chatStore.revokeMessage(msgId);

  // WhatsApp Web volunteers the decrypted version after the revoke
  const { message } = await chatStore.addMessage({
    msgId, sender: 'Frank', senderId: '94783811114', body: 'original', type: 'image', mediaUrl: '/media/late.jpg',
  });

  assert.strictEqual(message.isDeleted, true, 'must stay deleted');
  assert.strictEqual(message.body, 'original', 'must keep the original text');
  assert.strictEqual(message.mediaUrl, '/media/late.jpg', 'late media is still worth keeping');
});

test('getMessages returns the newest N in chronological order', async () => {
  // Base the timestamps on "now" so the rows from earlier tests stay older.
  const base = Date.now();
  const mk = i => chatStore.addMessage({
    msgId: `false_${SENDER}_ORDER${String(i).padStart(3, '0')}`,
    sender: 'G', senderId: '94783811114', body: `m${i}`, type: 'chat', ts: base + i,
  });
  for (let i = 0; i < 12; i++) await mk(i);

  const recent = await chatStore.getMessages(5);
  assert.strictEqual(recent.length, 5);
  assert.deepStrictEqual(recent.map(m => m.body), ['m7', 'm8', 'm9', 'm10', 'm11']);
});

// ── clean up ─────────────────────────────────────────────────────────────────
test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
