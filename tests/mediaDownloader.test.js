/**
 * tests/mediaDownloader.test.js
 * ─────────────────────────────────────────────────────────────
 * The page-side call itself needs a real browser, so it is covered by the live
 * suite. These tests pin the parts that decide what lands on disk: the
 * filename extension, and the guards that keep a missing client or message
 * from throwing inside a message handler.
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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vampire-media-'));
process.chdir(sandbox);

const { downloadMedia, extensionFor } = require('../src/services/mediaDownloader');

test('extensionFor maps the common WhatsApp media types', () => {
  assert.strictEqual(extensionFor('image/jpeg'), 'jpg');
  assert.strictEqual(extensionFor('image/png'), 'png');
  assert.strictEqual(extensionFor('image/webp'), 'webp');
  assert.strictEqual(extensionFor('video/mp4'), 'mp4');
  assert.strictEqual(extensionFor('audio/ogg'), 'ogg');
  assert.strictEqual(extensionFor('audio/mpeg'), 'mp3');
  assert.strictEqual(extensionFor('application/pdf'), 'pdf');
});

test('extensionFor falls back to the subtype', () => {
  assert.strictEqual(extensionFor('image/tiff'), 'tiff');
  assert.strictEqual(extensionFor('audio/x-m4a'), 'xm4a');
});

test('extensionFor never returns something usable as a path', () => {
  // A mimetype is attacker-influenced: it arrives with the message and ends up
  // in a filename, so no result may contain a separator.
  const dangerous = ['image/../../etc/passwd', 'image/..', 'image/a/b', 'image/%2e%2e/x'];
  for (const mime of dangerous) {
    const ext = extensionFor(mime);
    assert.doesNotMatch(ext, /[/\\]/, `${mime} -> ${ext} must not contain a separator`);
    assert.doesNotMatch(ext, /\.\./,  `${mime} -> ${ext} must not traverse`);
  }
  assert.strictEqual(extensionFor('image/../../etc/passwd'), 'bin');  // '..' sanitises away
  assert.strictEqual(extensionFor('image/png; charset=utf-8'), 'png');
  assert.strictEqual(extensionFor(undefined), 'bin');
  assert.strictEqual(extensionFor(''), 'bin');
  assert.strictEqual(extensionFor('nonsense'), 'bin');
});

test('downloadMedia returns null without a client, message or id', async () => {
  assert.strictEqual(await downloadMedia(null, { id: { fromMe: false, remote: 'a@c.us', id: 'X' } }), null);
  assert.strictEqual(await downloadMedia({ pupPage: {} }, null), null);
  assert.strictEqual(await downloadMedia({ pupPage: {} }, {}), null);          // no id
  assert.strictEqual(await downloadMedia({ pupPage: {} }, { id: {} }), null);  // unbuildable id
});

test('downloadMedia does not call the page when the message has no media', async () => {
  let called = false;
  const client = { pupPage: { evaluate: async () => { called = true; } } };
  const message = { hasMedia: false, id: { fromMe: false, remote: 'a@c.us', id: 'X' } };

  assert.strictEqual(await downloadMedia(client, message), null);
  assert.strictEqual(called, false, 'must not round-trip to the browser for a text message');
});

test('downloadMedia gives the page the rebuilt id, not undefined', async () => {
  // The whole bug was the library passing undefined here.
  let received;
  const client = { pupPage: { evaluate: async (_fn, msgId) => { received = msgId; return null; } } };
  // note: no _serialized — exactly the shape that used to break lookups
  const message = { hasMedia: true, id: { fromMe: false, remote: '447@lid', id: 'ABC' } };

  await downloadMedia(client, message);
  assert.strictEqual(received, 'false_447@lid_ABC');
});

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
