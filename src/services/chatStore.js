/**
 * src/services/chatStore.js
 * ─────────────────────────────────────────────────────────────
 * In-memory ring-buffer of received WhatsApp messages.
 * Holds last MAX_MESSAGES entries; exported to both bot and dashboard.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const { saveChatMessage, getRecentChatMessages, revokeChatMessage } = require('./db');

const MAX_MESSAGES = 1000;
const memoryBuffer = [];

/**
 * @param {{ msgId, sender, senderId, body, type, mediaUrl, ts }} entry
 * @returns {Promise<{ id, msgId, sender, senderId, body, type, mediaUrl, ts }>}
 */
async function addMessage(entry) {
  const ts        = entry.ts || Date.now();
  const { id }    = await saveChatMessage({ ...entry, ts });
  const msg       = { id, ...entry, ts };

  memoryBuffer.push(msg);
  if (memoryBuffer.length > MAX_MESSAGES) memoryBuffer.shift();

  return msg;
}

/**
 * @param {number} limit — max entries to return (newest last)
 */
async function getMessages(limit = 200) {
  const lim = Math.min(limit, MAX_MESSAGES);
  return getRecentChatMessages(lim);
}

/**
 * @param {string} msgId
 * @returns {Promise<Object|null>}
 */
async function revokeMessage(msgId) {
  const updated = await revokeChatMessage(msgId);
  
  // Update memory buffer if present
  const idx = memoryBuffer.findIndex(m => m.msgId === msgId);
  if (idx !== -1) {
    memoryBuffer[idx].isDeleted = true;
    memoryBuffer[idx].deletedAt = Date.now();
  }
  return updated;
}

module.exports = { addMessage, getMessages, revokeMessage };
