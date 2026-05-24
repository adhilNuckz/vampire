'use strict';

const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { logger } = require('../utils/logger');

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'autopilot.json');
const DEFAULT_STATE = { enabled: false };

fs.ensureDirSync(DATA_DIR);

let state = loadState();

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { enabled: Boolean(parsed.enabled) };
  } catch (err) {
    logger.warn(`Auto Pilot state load failed: ${err.message}`);
    return { ...DEFAULT_STATE };
  }
}

function persistState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getAutoPilotState() {
  return { enabled: Boolean(state.enabled) };
}

function setAutoPilotEnabled(enabled) {
  state = { enabled: Boolean(enabled) };
  persistState();
  logger.info(`Auto Pilot ${state.enabled ? 'enabled' : 'disabled'}`);
  return getAutoPilotState();
}

function toggleAutoPilot() {
  return setAutoPilotEnabled(!state.enabled);
}

function getBossLabel() {
  return (process.env.BOSS_NAME || 'my boss').trim() || 'my boss';
}

function buildFallbackReply({ senderName, messageText }) {
  const name = senderName || 'there';
  const boss = getBossLabel();
  const body = String(messageText || '').trim().toLowerCase();

  if (!body) {
    return `Hi ${name}, ${boss} has Auto Pilot enabled and is unavailable right now. Please leave a message and they will reply soon.`;
  }

  if (/^(hi|hello|hey|hii|yo)\b/.test(body)) {
    return `Hello ${name}, ${boss} has Auto Pilot enabled and is unavailable right now. They will be available soon.`;
  }

  if (/where are you|where u|when are you|available|free/.test(body)) {
    return `Hi ${name}, ${boss} has Auto Pilot enabled and is unavailable right now. They will be available soon.`;
  }

  return `Hi ${name}, ${boss} has Auto Pilot enabled and is unavailable right now. I saw your message and will respond soon.`;
}

async function callGeminiReply({ senderName, chatName, messageText }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return buildFallbackReply({ senderName, messageText });
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const prompt = [
    'You write short WhatsApp replies for a personal chat on behalf of the account owner.',
    'The Auto Pilot mode is enabled, so the owner is not replying manually.',
    'Reply to the sender in a warm, natural, concise style.',
    'Always mention that the boss has Auto Pilot enabled and is unavailable right now.',
    'If the sender greets you, respond with a greeting and the unavailability note.',
    'If the sender asks where the boss is or when they are available, say they will be available soon.',
    'Do not use markdown, bullet points, or code fences.',
    'Do not mention policies or technical details.',
    `Chat name: ${chatName || 'personal chat'}`,
    `Sender name: ${senderName || 'friend'}`,
    `Incoming message: ${messageText || ''}`,
    'Return only the reply text.'
  ].join('\n');

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 120,
        }
      },
      { timeout: 15000 }
    );

    const reply = data?.candidates?.[0]?.content?.parts
      ?.map(part => part?.text || '')
      .join('')
      .trim();

    return reply || buildFallbackReply({ senderName, messageText });
  } catch (err) {
    logger.warn(`Gemini Auto Pilot fallback: ${err.message}`);
    return buildFallbackReply({ senderName, messageText });
  }
}

async function generateAutoReply(context) {
  return callGeminiReply(context || {});
}

module.exports = {
  getAutoPilotState,
  setAutoPilotEnabled,
  toggleAutoPilot,
  generateAutoReply,
};
