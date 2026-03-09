// ── Capture all incoming messages for view-once/ephemeral media ─────────────
client.on('message', async message => {
  // Only process incoming (not from self)
  if (!message.fromMe) {
    captureMessage(message).catch(() => {});
  }
});
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
const { processMessage, transcribeAudio } = require('../services/processor');
const { verifySMTP }        = require('../services/email');
const { setClient }         = require('../services/whatsappClient');
const { addMessage: addChatMessage } = require('../services/chatStore');
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
  const senderId = parseSenderId(message.from);
  let contact;
  try { contact = await message.getContact(); } catch (_) { contact = {}; }
  const name   = contact.pushname || contact.name || senderId;
  const ts     = message.timestamp ? message.timestamp * 1000 : Date.now();
  const type   = message.type;
  let body     = message.body || '';
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

  const entry = addChatMessage({ sender: name, senderId, body, type, mediaUrl, ts });
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
const browserPath   = process.env.BROWSER_PATH || null;   // set in .env

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless,
    ...(browserPath ? { executablePath: browserPath } : {}),
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
});

client.on('auth_failure', msg => {
  logger.error(`Auth failure: ${msg}`);
  logBus.emit('status', { connected: false, message: `Auth failure: ${msg}` });
});

client.on('disconnected', reason => {
  logger.warn(`Disconnected: ${reason}`);
  logBus.emit('status', { connected: false, message: `Disconnected: ${reason}` });
  setTimeout(() => client.initialize(), 10_000);
});

// ── message handler ───────────────────────────────────────────────────────────
client.on('message_create', async message => {
    // skip outgoing messages that aren't commands (prevents processing bot's own replies)
    if (message.fromMe && !message.body?.startsWith(CMD_PREFIX)) return;
  try {
    // Skip WhatsApp Channels / Newsletters — their chat object crashes on getChat()
    if (
      message.from?.endsWith('@newsletter') ||
      message.type === 'newsletter' ||
      message.author === null && message.from?.endsWith('@broadcast')
    ) return;

    // ── capture all incoming messages for Chats dashboard ────────────────────
    if (!message.fromMe) captureMessage(message).catch(() => {});

    const senderId  = parseSenderId(message.from);
    const chat      = await message.getChat();
    const fromAgent = chat.name?.toLowerCase() === AGENT_CHAT_NAME.toLowerCase();
    const fromAdmin = isAuthorised(senderId);

    if (!fromAgent && !fromAdmin) return;

    // ── text ─────────────────────────────────────────────────────────────────
    if (message.type === 'chat') {
      const body        = message.body || '';
      const needsPrefix = CMD_PREFIX?.length > 0;
      if (needsPrefix && !body.startsWith(CMD_PREFIX) && !fromAgent) return;

      const text = needsPrefix && body.startsWith(CMD_PREFIX)
        ? body.slice(CMD_PREFIX.length).trim() : body.trim();
      if (!text) return;

      logger.logMessage({ from: senderId, body: text, type: 'text' });
      logBus.emit('message', { from: senderId, body: text, type: 'text', ts: Date.now() });

      if (isRateLimited(senderId)) {
        return sendReply(message, '⏳ Rate limit reached. Wait a moment before sending more commands.');
      }

      return sendReply(message, await processMessage(text, senderId));
    }

    // ── voice note ───────────────────────────────────────────────────────────
    if (message.type === 'ptt' || message.type === 'audio') {
      logger.info(`Voice note from ${senderId}`);
      logBus.emit('message', { from: senderId, body: '[voice note]', type: 'voice', ts: Date.now() });

      await sendReply(message, '🎙 Processing your voice note…');

      let oggPath, wavPath;
      try {
        ({ localPath: oggPath } = await downloadMedia(message));
        wavPath    = await convertToWav(oggPath);
        const buf  = await fs.readFile(wavPath);
        const text = await transcribeAudio(buf, 'audio/wav');

        if (!text) return sendReply(message, '❌ Could not transcribe. Please try text instead.');

        logBus.emit('message', { from: senderId, body: `[voice→text]: ${text}`, type: 'voice_transcript', ts: Date.now() });
        await sendReply(message, `📝 _Heard:_ "${text}"\n\nProcessing…`);
        return sendReply(message, await processMessage(text, senderId));

      } catch (err) {
        logger.error(`Voice error: ${err.message}`);
        return sendReply(message, `❌ Voice processing failed: ${err.message}`);
      } finally {
        if (oggPath) fs.remove(oggPath).catch(() => {});
        if (wavPath) fs.remove(wavPath).catch(() => {});
      }
    }

  } catch (err) {
    logger.error(`Message handler: ${err.message}\n${err.stack}`);
  }
});

// ── startup ───────────────────────────────────────────────────────────────────
(async () => {
  logger.info('Starting WhatsApp agent…');
  const smtp = await verifySMTP();
  logger[smtp.ok ? 'info' : 'warn'](`SMTP: ${smtp.message}`);
  client.initialize();
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
