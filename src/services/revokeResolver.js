/**
 * src/services/revokeResolver.js
 * ─────────────────────────────────────────────────────────────
 * Turning a WhatsApp "message deleted" event into a message id we can
 * actually match against what we stored.
 *
 * Why this needs its own module
 * -----------------------------
 * whatsapp-web.js emits `message_revoke_everyone(message, revoked_msg)`
 * where the two arguments are genuinely awkward:
 *
 *   • `revoked_msg` (2nd arg) is frequently `undefined` — the library warns
 *     about this in its own JSDoc, and it is the ONLY argument that carries
 *     the original text/media.
 *   • The 1st argument is the revocation protocol message. Its `id` is not
 *     reliably the id of the message the user deleted — the library itself
 *     rewrites `revoked_msg.id` from `protocolMessageKey`
 *     (whatsapp-web.js/src/Client.js:499-500) precisely because those differ.
 *
 * So instead of guessing, we collect every id the event could be talking
 * about, in order of confidence, and let the caller match the first one it
 * has on record. Pure functions only — no client, no DB — so this is
 * directly unit-testable.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/** JIDs never contain '_', so a serialized id splits on the outer two. */
function parseSerializedId(serialized) {
  if (typeof serialized !== 'string' || !serialized) return null;
  const first = serialized.indexOf('_');
  const last  = serialized.lastIndexOf('_');
  if (first === -1 || last === -1 || first === last) return null;
  return {
    fromMe: serialized.slice(0, first) === 'true',
    remote: serialized.slice(first + 1, last),
    id:     serialized.slice(last + 1),
  };
}

/** `remote` may be a raw string or an un-serialized Wid object. */
function jidOf(remote) {
  if (!remote) return null;
  if (typeof remote === 'string') return remote;
  return remote._serialized || null;
}

/** Build a serialized message id from a MessageKey-shaped object. */
function serializedFromKey(key) {
  if (!key) return null;
  if (typeof key._serialized === 'string' && key._serialized) return key._serialized;
  const remote = jidOf(key.remote);
  if (!remote || !key.id) return null;
  return `${key.fromMe ? 'true' : 'false'}_${remote}_${key.id}`;
}

/**
 * The canonical serialized id of a message, for storage and later matching.
 *
 * Must NOT simply read `msg.id._serialized`. On the current WhatsApp Web build
 * the library rebuilds `msg.id` with `Object.assign({}, msg.id, { remote })`
 * (Injected/Utils.js `getMessageModel`), and `_serialized` is a computed getter
 * rather than an own property — so it is dropped by the copy and comes back
 * `undefined`. Every captured message then stored an empty id, which silently
 * disabled de-duplication and made it impossible to match a later deletion.
 *
 * Rebuilding from `{fromMe, remote, id}` yields exactly the string WhatsApp
 * uses, and it is the same function the revoke side resolves against, so both
 * ends are guaranteed to agree.
 *
 * @param {object} msg a whatsapp-web.js Message
 * @returns {string} '' when no id can be determined
 */
function messageIdOf(msg) {
  const id = msg?.id;
  if (!id) return '';
  if (typeof id === 'string') return id;
  return serializedFromKey(id) || '';
}

/**
 * Every id this message could be known by, most-trusted first.
 * @returns {string[]} unique, non-empty
 */
function idCandidates(msg) {
  if (!msg) return [];
  const out = [];
  const push = v => { if (v && !out.includes(v)) out.push(v); };

  // protocolMessageKey is the key the library itself trusts (Client.js:499)
  push(serializedFromKey(msg.protocolMessageKey));
  push(typeof msg.id?._serialized === 'string' ? msg.id._serialized : null);
  push(serializedFromKey(msg.id));
  return out;
}

/**
 * Candidate ids for a revoke event, ordered by confidence:
 * the pre-revoke snapshot's id is the most literal answer, then the
 * post-revoke message, then anything protocolMessageKey points at.
 *
 * @param {object} after  first event arg — the message, post-revocation
 * @param {object} [before] second event arg — the pre-revocation snapshot
 * @returns {string[]}
 */
function resolveRevokeIds(after, before) {
  const out = [];
  for (const id of [...idCandidates(before), ...idCandidates(after)]) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Describe a message for storage — used when a deletion arrives for a
 * message we never captured. `before` (the pre-revoke snapshot) is the
 * only argument that still holds the original text, so prefer it.
 *
 * @param {object} msg  a whatsapp-web.js Message
 * @param {string} [contactName]
 */
function describeMessage(msg, contactName) {
  if (!msg) return null;

  const chatJid  = msg.fromMe ? msg.to : msg.from;
  if (!chatJid) return null;
  const senderId = String(chatJid).replace(/@.+/, '');

  return {
    chatJid,
    senderId,
    sender:   msg.fromMe ? 'Me' : (contactName || senderId),
    body:     msg.body || '',
    type:     msg.type || 'chat',
    ts:       msg.timestamp ? msg.timestamp * 1000 : Date.now(),
    hasMedia: Boolean(msg.hasMedia),
  };
}

module.exports = {
  parseSerializedId,
  jidOf,
  serializedFromKey,
  messageIdOf,
  idCandidates,
  resolveRevokeIds,
  describeMessage,
};
