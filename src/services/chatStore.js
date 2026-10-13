/**
 * src/services/chatStore.js
 * ─────────────────────────────────────────────────────────────
 * Ring-buffer + persistence façade for captured WhatsApp messages.
 *
 * addMessage() is idempotent per msgId: WhatsApp Web delivers the same
 * logical message several times (message_create + message, plus a second
 * event when a ciphertext message finally decrypts), and re-delivering it
 * must not create a second row or a second bubble in the dashboard.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const {
  upsertChatMessage,
  getRecentChatMessages,
  revokeChatMessage,
  findChatMessage,
} = require('./db');

const MAX_MESSAGES = 1000;
const memoryBuffer = [];

/**
 * Capture a message.
 *
 * @param {{ msgId, sender, senderId, body, type, mediaUrl, ts }} entry
 * @returns {Promise<{ message: Object, created: boolean }>}
 *   `created` is false when this msgId was already captured (the returned
 *   message then holds any newly-learned fields, e.g. media for a
 *   message that arrived as ciphertext first).
 */
async function addMessage(entry) {
  const ts = entry.ts || Date.now();
  const { entry: saved, created } = await upsertChatMessage({ ...entry, ts });
  const message = { ...saved };

  const idx = memoryBuffer.findIndex(m => m.msgId && m.msgId === message.msgId);
  if (idx !== -1) {
    memoryBuffer[idx] = message;
  } else {
    memoryBuffer.push(message);
    if (memoryBuffer.length > MAX_MESSAGES) memoryBuffer.shift();
  }

  return { message, created };
}

/**
 * @param {number} limit — max entries to return (oldest first)
 */
async function getMessages(limit = 200) {
  const lim = Math.min(limit, MAX_MESSAGES);
  try {
    return await getRecentChatMessages(lim);
  } catch (err) {
    // DB unavailable — fall back to whatever is still in memory.
    return memoryBuffer.slice(-lim);
  }
}

/**
 * Mark an already-captured message as deleted (deleted for everyone).
 *
 * The original body/media are deliberately preserved — that is the whole
 * point of the anti-delete feature.
 *
 * @param {string} msgId
 * @returns {Promise<Object|null>} the updated entry, or null if unknown
 */
async function revokeMessage(msgId) {
  if (!msgId) return null;

  const updated = await revokeChatMessage(msgId);
  if (!updated) return null;

  const idx = memoryBuffer.findIndex(m => m.msgId === msgId);
  if (idx !== -1) {
    memoryBuffer[idx] = { ...memoryBuffer[idx], isDeleted: true, deletedAt: updated.deletedAt };
  }
  return updated;
}

/**
 * Record a deletion for a message we never captured — the bot was offline,
 * the message predates the current session, or WhatsApp Web dropped it from
 * its store. Without this the deletion would be invisible in the dashboard.
 *
 * @param {{ msgId, sender, senderId, body, type, mediaUrl, ts }} entry
 * @returns {Promise<Object>} the stored (deleted) entry
 */
async function markDeleted(entry) {
  const already = await findChatMessage(entry.msgId);
  if (already) {
    const updated = await revokeMessage(entry.msgId);
    if (updated) return updated;
  }

  const deletedAt = Date.now();
  const { entry: saved } = await upsertChatMessage({
    ...entry,
    ts: entry.ts || deletedAt,
    isDeleted: true,
    deletedAt,
  });

  const message = { ...saved };
  const idx = memoryBuffer.findIndex(m => m.msgId && m.msgId === message.msgId);
  if (idx !== -1) memoryBuffer[idx] = message;
  else {
    memoryBuffer.push(message);
    if (memoryBuffer.length > MAX_MESSAGES) memoryBuffer.shift();
  }
  return message;
}

module.exports = { addMessage, getMessages, revokeMessage, markDeleted };
