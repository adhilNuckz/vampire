/**
 * src/bot/index.js
 * ─────────────────────────────────────────────────────────────
 * WhatsApp Web bot — entry point.
 *
 * • QR code login (session persisted in /.wwebjs_auth)
 * • Listens for messages from authorised numbers
 * • Routes text → processor, voice → ffmpeg → Gemini STT → processor
 * • Replies in the same WhatsApp chat
 * • Forwards real-time events to the dashboard via logBus
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const path    = require('path');
const os      = require('os');
const fs      = require('fs-extra');
const qrcode  = require('qrcode-terminal');
const ffmpeg  = require('fluent-ffmpeg');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { logger, logBus }    = require('../utils/logger');
const { generateAutoReply } = require('../services/processor');
const { setClient }         = require('../services/whatsappClient');
const { addMessage: addChatMessage, revokeMessage, markDeleted } = require('../services/chatStore');
const { resolveRevokeIds, describeMessage, messageIdOf } = require('../services/revokeResolver');
const { isIgnoredChat } = require('../services/messageFilter');
const { sessionDir, killOrphanBrowsers, clearStaleProfileLock } = require('../utils/browserLock');
const { getAutoPilotState } = require('../services/autopilot');
require('dotenv').config();

// ── global error safety net ───────────────────────────────────────────────────
process.on('uncaughtException',  err => { console.error('[UNCAUGHT]', err); process.exit(1); });
process.on('unhandledRejection', err => { console.error('[UNHANDLED]', err); });

// ── configuration ─────────────────────────────────────────────────────────────
const ADMIN_NUMBERS   = (process.env.ADMIN_NUMBERS || '')
  .split(',').map(n => n.trim().replace(/\D/g, '')).filter(Boolean);
const AGENT_CHAT_NAME = process.env.AGENT_CHAT_NAME || 'Agent';
const CMD_PREFIX      = process.env.COMMAND_PREFIX  || '!';
const AUDIO_TMP_DIR   = path.join(os.tmpdir(), 'wa_agent_audio');

fs.ensureDirSync(AUDIO_TMP_DIR);

// ── rate limiter (10 req / min per sender) ────────────────────────────────────
const rateMap    = new Map();
const RATE_LIMIT  = 10;
const RATE_WINDOW = 60_000;

function isRateLimited(id) {
  const now = Date.now();
  const rec = rateMap.get(id) || { count: 0, resetAt: now + RATE_WINDOW };
  if (now > rec.resetAt) { rateMap.set(id, { count: 1, resetAt: now + RATE_WINDOW }); return false; }
  if (rec.count >= RATE_LIMIT) return true;
  rec.count++;
  rateMap.set(id, rec);
  return false;
}

// ── helpers ───────────────────────────────────────────────────────────────────
const parseSenderId  = from  => (from || '').replace(/@.+/, '');
const isAuthorised   = id    => !ADMIN_NUMBERS.length || ADMIN_NUMBERS.includes(id);

function convertToWav(inputPath) {
  const outputPath = inputPath.replace(/\.\w+$/, '.wav');
  return new Promise((resolve, reject) =>
    ffmpeg(inputPath)
      .audioChannels(1).audioFrequency(16000).format('wav')
      .on('error', reject).on('end', () => resolve(outputPath))
      .save(outputPath)
  );
}

async function downloadMedia(message) {
  const media    = await message.downloadMedia();
  const ext      = media.mimetype.split('/')[1].split(';')[0];
  const filePath = path.join(AUDIO_TMP_DIR, `voice_${Date.now()}.${ext}`);
  await fs.writeFile(filePath, Buffer.from(media.data, 'base64'));
  return { localPath: filePath, mimeType: media.mimetype };
}

// ── chat history capture ──────────────────────────────────────────────────────
const MEDIA_DIR = path.join(__dirname, '../../public/media');
fs.ensureDirSync(MEDIA_DIR);

/**
 * Restore `message.id._serialized` before handing the message to the library.
 *
 * whatsapp-web.js passes `this.id._serialized` into the page for downloadMedia(),
 * reply(), delete() and friends. On the current WhatsApp Web build the id is
 * rebuilt with Object.assign(), which drops that computed getter, so the library
 * looks up a message whose id is `undefined` and the call dies with a mangled
 * page error — which is exactly why images arrived as bare placeholders.
 *
 * `message.id` is a plain mutable object at that point, so the field can simply
 * be put back.
 *
 * @returns {string} the id, or '' if none could be determined
 */
function ensureMessageId(message) {
  const id = messageIdOf(message);
  if (id && message.id && typeof message.id === 'object' && !message.id._serialized) {
    try { message.id._serialized = id; }
    catch (_) { /* frozen object — nothing we can do from here */ }
  }
  return id;
}

/** Download a message's media into public/media; returns its public URL. */
async function saveMedia(message) {
  if (!message?.hasMedia) return null;
  try {
    const media = await message.downloadMedia();
    if (!media || !media.data) return null;
    const ext   = (media.mimetype || 'application/octet-stream').split('/')[1].split(';')[0];
    const fname = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    await fs.writeFile(path.join(MEDIA_DIR, fname), Buffer.from(media.data, 'base64'));
    return `/media/${fname}`;
  } catch (e) {
    // The page-side errors here arrive heavily mangled (often just "r"), so log
    // whatever identity the error does carry rather than a bare message.
    logger.warn(`Chat media capture failed [${e?.name || 'Error'}]: ${e?.message || e}`);
    return null;
  }
}

// Only warn once per session — a build that cannot supply ids would otherwise
// log on every single message.
let warnedMissingId = false;

async function captureMessage(message) {
  if (isIgnoredChat(message)) return null;

  // Must happen before saveMedia(): downloadMedia() needs a usable id.
  const msgId = ensureMessageId(message);

  const chatJid        = message.fromMe ? message.to : message.from;
  const conversationId = parseSenderId(chatJid);

  let contact = {};
  if (!message.fromMe) {
    try { contact = await message.getContact(); } catch (_) { contact = {}; }
  }
  const name = contact.pushname || contact.name || conversationId;

  // Save any media if present (including view-once, ephemeral, etc.)
  const mediaUrl = await saveMedia(message);

  if (!msgId && !warnedMissingId) {
    warnedMissingId = true;
    logger.warn('Could not determine a message id — de-duplication and deleted-message tracking will not work for these messages.');
  }

  const { message: entry } = await addChatMessage({
    msgId,
    sender: message.fromMe ? 'Me' : name,
    senderId: conversationId,
    body: message.body || '',
    type: message.type,
    mediaUrl,
    ts: message.timestamp ? message.timestamp * 1000 : Date.now()
  });

  // Always emit — the dashboard upserts by msgId. WhatsApp Web re-delivers the
  // same message (ciphertext first, then the decrypted version with its media),
  // and an upsert turns that into a refresh instead of a duplicate bubble.
  logBus.emit('chat_message', entry);
  return entry;
}

async function sendReply(message, text) {
  const MAX = 3800;
  for (let i = 0; i < text.length; i += MAX) {
    await message.reply(text.slice(i, i + MAX));
  }
  logger.logReply({ to: message.from, body: text.slice(0, 200) });
}

// ── WhatsApp client ───────────────────────────────────────────────────────────
const headless = process.env.HEADLESS !== 'false';   // default true on server

// Where a browser might live. BROWSER_PATH wins; the rest is auto-detection, so
// a fresh server install works even if .env was never filled in. This matters
// because the installer skips Puppeteer's own Chromium download — without a
// system browser the client would otherwise retry forever with
// "Could not find Chrome".
const BROWSER_CANDIDATES = [
  process.env.BROWSER_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].map(p => (p || '').trim()).filter(Boolean);

function resolveBrowserPath() {
  for (const candidate of BROWSER_CANDIDATES) {
    try { if (fs.pathExistsSync(candidate)) return candidate; } catch (_) { /* keep looking */ }
  }
  return null;
}

const resolvedBrowserPath = resolveBrowserPath();

if (resolvedBrowserPath) {
  logger.info(`Using browser: ${resolvedBrowserPath}`);
} else {
  const hint = process.env.BROWSER_PATH
    ? `BROWSER_PATH="${process.env.BROWSER_PATH}" does not exist.`
    : 'No system Chrome/Chromium found.';
  logger.warn(
    `${hint} Falling back to Puppeteer's bundled browser. ` +
    'If the bot keeps failing to start, install Chrome or Chromium and set ' +
    'BROWSER_PATH in .env to its full path.'
  );
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  restartOnAuthFail: true,
  puppeteer: {
    headless,
    ...(resolvedBrowserPath ? { executablePath: resolvedBrowserPath } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-popup-blocking',
      '--disable-translate',
      '--disable-background-networking',
      '--safebrowsing-disable-auto-update',
      '--disable-sync'
    ]
  }
});

// Recovery from a profile left locked by a previous, crashed run — see
// src/utils/browserLock.js.
const AUTH_SESSION_DIR = sessionDir();
const orphanBrowsers   = () => killOrphanBrowsers(AUTH_SESSION_DIR);
const clearStaleLock   = () => clearStaleProfileLock(AUTH_SESSION_DIR);

// ── init/reconnect with backoff ──────────────────────────────────────────────
let initializing = false;
let retryTimer = null;
let retryDelayMs = 5_000;
const MAX_RETRY_DELAY_MS = 120_000;

function scheduleInitialize(reason) {
  if (retryTimer) return;
  const delay = retryDelayMs;
  const reasonSuffix = reason ? ` (${reason})` : '';
  logger.warn(`Scheduling WhatsApp re-init in ${Math.round(delay / 1000)}s${reasonSuffix}.`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    initializeClient(reason);
  }, delay);
  retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
}

async function initializeClient(reason) {
  if (initializing) return;
  initializing = true;
  try {
    if (reason) logger.info(`Initializing WhatsApp client (${reason})...`);
    await client.initialize();
    retryDelayMs = 5_000;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  } catch (err) {
    const msg = err?.message || String(err);
    logger.error(`Client initialize failed: ${msg}`);
    try { await client.destroy(); } catch (_) {}

    // A locked profile is not worth backing off over — clear it and retry now,
    // otherwise the exponential backoff just stretches out a guaranteed failure.
    if (/already running|SingletonLock/i.test(msg)) {
      await orphanBrowsers();
      if (await clearStaleLock()) retryDelayMs = 5_000;
    }
    scheduleInitialize('init failed');
  } finally {
    initializing = false;
  }
}

// NOTE: there is deliberately no `client.on('message')` capture handler.
// whatsapp-web.js emits `message_create` for EVERY new message (including our
// own) and then emits `message` again for the incoming ones, so capturing in
// both places stored every received message twice. `message_create` below is
// the single capture point. (Client.js:477 then :486)

// ── lifecycle events ──────────────────────────────────────────────────────────
client.on('qr', qr => {
  logger.info('── Scan the QR code below with WhatsApp ──');
  qrcode.generate(qr, { small: true });
  logBus.emit('qr', qr);
});

client.on('authenticated', () => {
  logger.info('WhatsApp authenticated ✅');
  logBus.emit('status', { connected: true, message: 'Authenticated' });
});

client.on('ready', () => {
  logger.info(`WhatsApp agent READY 🚀  (chat: "${AGENT_CHAT_NAME}", prefix: "${CMD_PREFIX}")`);
  logBus.emit('status', { connected: true, message: 'Ready' });
  setClient(client); // share with dashboard scheduler
  const sessionId = client.info?.wid?._serialized || client.info?.wid?.user || 'unknown';
  logger.info(`WhatsApp session: ${sessionId}`);
  setTimeout(() => {
    const confirmId = client.info?.wid?._serialized || client.info?.wid?.user || 'unknown';
    logger.info(`WhatsApp health check: still ready after 30s (session ${confirmId}).`);
  }, 30_000);
});

client.on('auth_failure', msg => {
  logger.error(`Auth failure: ${msg}`);
  logBus.emit('status', { connected: false, message: `Auth failure: ${msg}` });
});

client.on('disconnected', reason => {
  logger.warn(`Disconnected: ${reason}`);
  logBus.emit('status', { connected: false, message: `Disconnected: ${reason}` });
  scheduleInitialize(`disconnected: ${reason}`);
});

// ── Message revocation (anti-delete) ─────────────────────────────────────────
/**
 * Mark a revoked message as deleted, keeping the original body and media.
 *
 * The event's two arguments are unreliable (see revokeResolver.js), so we
 * resolve every id the event could refer to and mark the first one we have on
 * record. If we have none — the bot was offline, or WhatsApp Web never handed
 * us the message — and `recover` is set, we reconstruct the message from the
 * pre-revocation snapshot so the deletion still shows up in the dashboard.
 *
 * @param {object}      after   post-revocation Message
 * @param {object|null} before  pre-revocation snapshot (holds the original text)
 * @param {'everyone'|'me'} source
 * @param {boolean}     recover  store a synthetic entry when nothing matched
 */
async function handleRevoke(after, before, source, recover) {
  const ids = resolveRevokeIds(after, before);
  if (!ids.length) {
    logger.warn(`Revoke event (${source}) had no usable message id — ignored.`);
    return;
  }

  for (const msgId of ids) {
    const updated = await revokeMessage(msgId);
    if (updated) {
      logBus.emit('chat_message_revoked', updated);
      logger.info(`Message revoked (${source}): ${msgId}`);
      return;
    }
  }

  if (!recover) {
    logger.info(`Message removed (${source}) but never captured: ${ids[0]}`);
    return;
  }

  // Never captured it — rebuild from the snapshot that still has the content.
  const original = before || after;
  ensureMessageId(original);   // same id repair, so its media can still be pulled
  const info     = describeMessage(original);
  if (!info || (!info.body && !info.hasMedia)) {
    logger.warn(`Revoke (${source}) for unknown message with no recoverable content: ${ids[0]}`);
    return;
  }

  const entry = await markDeleted({
    msgId:    ids[0],
    sender:   info.sender,
    senderId: info.senderId,
    body:     info.body,
    type:     info.type,
    mediaUrl: await saveMedia(original),
    ts:       info.ts,
  });

  logBus.emit('chat_message_revoked', entry);
  logger.info(`Message revoked (${source}), recovered from snapshot: ${ids[0]}`);
}

// Deleted for everyone — the classic anti-delete case.
client.on('message_revoke_everyone', (after, before) => {
  handleRevoke(after, before, 'everyone', true)
    .catch(err => logger.error(`Revoke handler failed: ${err.message}`));
});

// Deleted for me — the account owner deleting from their own phone. Only ever
// flags a message we already hold; WhatsApp Web also fires this when a chat is
// cleared, and inventing entries for those would flood the dashboard.
client.on('message_revoke_me', message => {
  handleRevoke(message, null, 'me', false)
    .catch(err => logger.error(`Revoke-me handler failed: ${err.message}`));
});

// ── message handler ───────────────────────────────────────────────────────────
client.on('message_create', async message => {
  try {
    // One filter for both paths: groups, Channels, Status and system
    // notifications are neither archived nor acted on.
    if (isIgnoredChat(message)) return;

    // ── capture message (incoming & outgoing) ────────────────────────────
    captureMessage(message).catch(() => {});

    if (message.fromMe) return;

    const senderId = parseSenderId(message.from);
    const body     = message.body || '';

    // Cheap, store-free filters first. message.getChat() is a round-trip into
    // the browser that throws on some builds (LID-addressed chats especially),
    // so it must not gate every incoming message — it used to run even with
    // Auto Pilot off, erroring on each one and logging a stack trace.
    if (message.type !== 'chat') return;
    if (message.from?.endsWith('@g.us')) return;
    if (!body.trim()) return;

    const autopilot = getAutoPilotState();
    if (!autopilot.enabled) return;

    const chat = await message.getChat().catch(() => null);
    if (!chat || chat.isGroup) return;

    const contact = await message.getContact().catch(() => ({}));
    const chatName = chat.name || contact.pushname || contact.name || senderId;
    const senderName = contact.pushname || contact.name || chatName || senderId;

    logger.logMessage({ from: senderId, body, type: 'text' });
    logBus.emit('message', { from: senderId, body, type: 'text', ts: Date.now() });

    const reply = await generateAutoReply({ chatName, senderName, messageText: body });
    return sendReply(message, reply);

  } catch (err) {
    logger.error(`Message handler: ${err.message}\n${err.stack}`);
  }
});

// ── startup ───────────────────────────────────────────────────────────────────
(async () => {
  logger.info('Starting WhatsApp agent…');
  const autoPilot = getAutoPilotState();
  logger.info(`Auto Pilot is ${autoPilot.enabled ? 'enabled' : 'disabled'}`);
  // Recover from a crash/reboot that left the browser and its profile lock behind.
  await orphanBrowsers();
  await clearStaleLock();
  initializeClient('startup');
})().catch(err => {
  logger.error(`Fatal bot startup: ${err.message}\n${err.stack}`);
  // don't process.exit here — dashboard may be running in same process
});

// ── graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`${signal} — shutting down…`);
  try { await client.destroy(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { client };
