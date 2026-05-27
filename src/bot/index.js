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
const { addMessage: addChatMessage } = require('../services/chatStore');
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

async function captureMessage(message) {
  const chatJid = message.fromMe ? message.to : message.from;
  if (
    message.from?.endsWith('@newsletter') ||
    message.type === 'newsletter' ||
    message.author === null && message.from?.endsWith('@broadcast') ||
    chatJid?.endsWith('@g.us')
  ) return;
  const conversationId = parseSenderId(chatJid);

  let contact;
  try { contact = await message.getContact(); } catch (_) { contact = {}; }
  const name = contact.pushname || contact.name || conversationId;
  const ts = message.timestamp ? message.timestamp * 1000 : Date.now();
  const type = message.type;
  let body = message.body || '';
  let mediaUrl = null;

  // Save any media if present (including view-once, ephemeral, etc.)
  if (message.hasMedia) {
    try {
      const media = await message.downloadMedia();
      if (media) {
        const ext   = (media.mimetype || 'application/octet-stream').split('/')[1].split(';')[0];
        const fname = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const fpath = path.join(MEDIA_DIR, fname);
        await fs.writeFile(fpath, Buffer.from(media.data, 'base64'));
        mediaUrl = `/media/${fname}`;
      }
    } catch (e) {
      logger.warn(`Chat media capture: ${e.message}`);
    }
  }

  const displayName = message.fromMe ? 'Me' : name;

  const entry = await addChatMessage({
    msgId: message.id._serialized,
    sender: displayName,
    senderId: conversationId,
    body,
    type,
    mediaUrl,
    ts
  });
  logBus.emit('chat_message', entry);
}

async function sendReply(message, text) {
  const MAX = 3800;
  for (let i = 0; i < text.length; i += MAX) {
    await message.reply(text.slice(i, i + MAX));
  }
  logger.logReply({ to: message.from, body: text.slice(0, 200) });
}

// ── WhatsApp client ───────────────────────────────────────────────────────────
const headless      = process.env.HEADLESS !== 'false';   // default true on server
const browserPath   = (process.env.BROWSER_PATH || '').trim();
const resolvedBrowserPath = browserPath && fs.pathExistsSync(browserPath) ? browserPath : null;

if (browserPath && !resolvedBrowserPath) {
  logger.warn(`BROWSER_PATH is set but not found: ${browserPath} — falling back to Puppeteer's default browser lookup.`);
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
    scheduleInitialize('init failed');
  } finally {
    initializing = false;
  }
}

// ── Capture all incoming messages for view-once/ephemeral media ─────────────
client.on('message', async message => {
  // Only process incoming (not from self)
  if (!message.fromMe) {
    captureMessage(message).catch(() => {});
  }
});

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

// ── Message revocation (anti-delete) handler ────────────────────────
client.on('message_revoke_everyone', async (after, before) => {
  try {
    const msgId = after.id._serialized;
    logger.info(`Message revoked: ${msgId}`);
    const { revokeMessage } = require('../services/chatStore');
    const updated = await revokeMessage(msgId);
    if (updated) {
      logBus.emit('chat_message_revoked', { msgId, deletedAt: updated.deletedAt });
    }
  } catch (err) {
    logger.error(`Error handling message revoke: ${err.message}`);
  }
});

// ── message handler ───────────────────────────────────────────────────────────
client.on('message_create', async message => {
  try {
    // Skip WhatsApp Channels / Newsletters — their chat object crashes on getChat()
    if (
      message.from?.endsWith('@newsletter') ||
      message.type === 'newsletter' ||
      message.author === null && message.from?.endsWith('@broadcast')
    ) return;

    // ── capture message (incoming & outgoing) ────────────────────────────
    captureMessage(message).catch(() => {});

    if (message.fromMe) return;

    const senderId  = parseSenderId(message.from);
    const chat      = await message.getChat();
    const body = message.body || '';
    if (message.type !== 'chat' || chat.isGroup || message.from?.endsWith('@g.us')) return;
    if (!body.trim()) return;

    const autopilot = getAutoPilotState();
    if (!autopilot.enabled) return;

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
