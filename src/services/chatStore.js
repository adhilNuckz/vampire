/**
 * src/services/chatStore.js
 * ─────────────────────────────────────────────────────────────
 * In-memory ring-buffer of received WhatsApp messages.
 * Holds last MAX_MESSAGES entries; exported to both bot and dashboard.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const MAX_MESSAGES = 1000;
const chatMessages = [];
let   nextId = 1;

/**
 * @param {{ sender, senderId, body, type, mediaUrl, ts }} entry
 * @returns {{ id, sender, senderId, body, type, mediaUrl, ts }}
 */
function addMessage(entry) {
  const msg = { id: nextId++, ...entry };
  chatMessages.push(msg);
  if (chatMessages.length > MAX_MESSAGES) chatMessages.shift();
  return msg;
}

/**
 * @param {number} limit — max entries to return (newest last)
 */
function getMessages(limit = 200) {
  return chatMessages.slice(-Math.min(limit, MAX_MESSAGES));
}

module.exports = { addMessage, getMessages };
