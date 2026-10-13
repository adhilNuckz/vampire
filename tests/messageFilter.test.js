/**
 * tests/messageFilter.test.js
 * ─────────────────────────────────────────────────────────────
 * Decides what belongs in the chat archive. A regression here is not loud —
 * it silently fills the dashboard with Status posts and groups — so the
 * cases are pinned explicitly.
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

// logger writes to LOG_DIR relative to cwd, so isolate before requiring.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vampire-filter-'));
process.chdir(sandbox);

const { isIgnoredChat, chatJidOf } = require('../src/services/messageFilter');

const CONTACT = '94783811114@c.us';
const LID     = '66431047700657@lid';

const msg = (o = {}) => ({ from: CONTACT, to: 'me@c.us', fromMe: false, type: 'chat', ...o });

test('a normal incoming 1:1 chat is archived', () => {
  assert.strictEqual(isIgnoredChat(msg()), false);
});

test('a normal outgoing 1:1 chat is archived', () => {
  assert.strictEqual(isIgnoredChat(msg({ fromMe: true, from: 'me@c.us', to: CONTACT })), false);
});

test('LID-addressed chats are archived', () => {
  assert.strictEqual(isIgnoredChat(msg({ from: LID })), false);
});

test('groups are ignored', () => {
  assert.strictEqual(isIgnoredChat(msg({ from: '1234567890-123456@g.us' })), true);
});

test('Channels/Newsletters are ignored', () => {
  assert.strictEqual(isIgnoredChat(msg({ from: '123@newsletter' })), true);
});

// The regression that prompted this module: Status posts arrive with `author`
// set, so the old author-based @broadcast test let every one of them through.
test('WhatsApp Status posts are ignored even with an author set', () => {
  assert.strictEqual(isIgnoredChat(msg({ from: 'status@broadcast', author: CONTACT })), true);
});

test('WhatsApp Status posts are ignored with no author', () => {
  assert.strictEqual(isIgnoredChat(msg({ from: 'status@broadcast', author: null })), true);
});

test('outgoing broadcast-list messages are ignored', () => {
  assert.strictEqual(isIgnoredChat(msg({ fromMe: true, from: 'me@c.us', to: '123@broadcast' })), true);
});

test('system notification messages are ignored', () => {
  assert.strictEqual(isIgnoredChat(msg({ type: 'notification_template' })), true);
  assert.strictEqual(isIgnoredChat(msg({ type: 'e2e_notification' })), true);
  assert.strictEqual(isIgnoredChat(msg({ type: 'newsletter' })), true);
});

test('non-chat media types are still archived', () => {
  for (const type of ['image', 'video', 'audio', 'ptt', 'document', 'sticker']) {
    assert.strictEqual(isIgnoredChat(msg({ type })), false, `${type} should be archived`);
  }
});

test('a message with no usable jid is ignored rather than crashing', () => {
  assert.strictEqual(isIgnoredChat(msg({ from: undefined, to: undefined })), true);
  assert.strictEqual(isIgnoredChat(null), true);
  assert.strictEqual(isIgnoredChat(undefined), true);
  assert.strictEqual(isIgnoredChat({}), true);
});

test('chatJidOf prefers the counterparty for both directions', () => {
  assert.strictEqual(chatJidOf(msg()), CONTACT);
  assert.strictEqual(chatJidOf(msg({ fromMe: true, to: CONTACT })), CONTACT);
  assert.strictEqual(chatJidOf(msg({ from: { _serialized: CONTACT } })), CONTACT);
  assert.strictEqual(chatJidOf(null), null);
});

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
