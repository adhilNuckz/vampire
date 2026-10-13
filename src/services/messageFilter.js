/**
 * src/services/messageFilter.js
 * ─────────────────────────────────────────────────────────────
 * Which WhatsApp messages belong in the dashboard archive.
 *
 * Only real 1:1 chats do. Everything else — groups, Channels/Newsletters,
 * WhatsApp Status, and the system notification messages WhatsApp emits for
 * things like a contact changing their number — is noise that would otherwise
 * pile up in the chat list forever.
 *
 * Kept as a pure function, separate from the bot, because the previous inline
 * version silently let Status posts through: it only rejected `@broadcast`
 * when `message.author` was null, which Status posts do not satisfy.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/** JID suffixes that are never a 1:1 conversation. */
const IGNORED_JID_SUFFIXES = ['@g.us', '@broadcast', '@newsletter'];

/**
 * Message types that are system events rather than things a person sent:
 *   notification_template — contact changed their phone number, etc.
 *   e2e_notification      — encryption/security notices
 *   newsletter            — Channels
 */
const IGNORED_TYPES = new Set(['newsletter', 'notification_template', 'e2e_notification']);

/**
 * The JID of the conversation a message belongs to.
 * @returns {string|null}
 */
function chatJidOf(message) {
  if (!message) return null;
  const jid = message.fromMe ? message.to : message.from;
  if (!jid) return null;
  return typeof jid === 'string' ? jid : (jid._serialized || null);
}

/**
 * @param {object} message a whatsapp-web.js Message
 * @returns {boolean} true when the message should NOT be archived
 */
function isIgnoredChat(message) {
  if (!message) return true;

  const chatJid = chatJidOf(message);
  if (!chatJid) return true;                                   // nothing to key it on
  if (IGNORED_JID_SUFFIXES.some(s => chatJid.endsWith(s))) return true;

  if (IGNORED_TYPES.has(message.type)) return true;

  // Status updates arrive as `status@broadcast` with an author set, so the JID
  // check above is what catches them — not an author-based test.
  if (typeof message.from === 'string' && message.from.endsWith('@broadcast')) return true;

  return false;
}

module.exports = { isIgnoredChat, chatJidOf, IGNORED_JID_SUFFIXES, IGNORED_TYPES };
