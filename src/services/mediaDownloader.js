/**
 * src/services/mediaDownloader.js
 * ─────────────────────────────────────────────────────────────
 * Download and decrypt a message's attachment.
 *
 * Why this exists instead of message.downloadMedia()
 * ---------------------------------------------------
 * The library's version omits `mimetype` from the options it hands to
 * WhatsApp Web's download manager. On the current WhatsApp Web build that is
 * rejected outright:
 *
 *   InvalidMediaFileType: Unexpected mimetype application/octet-stream
 *                          for media type image
 *
 * so every attachment (images, audio, documents — 100% of them, in both direct
 * chats and groups) failed to save and arrived as a placeholder. Passing the
 * message's own mimetype through makes the identical call succeed.
 *
 * This mirrors the library's page-side routine, with that one field added. It
 * also restores `message.id._serialized` first, because the library's lookup
 * key is dropped when the id is rebuilt (see revokeResolver.messageIdOf).
 *
 * If a future whatsapp-web.js fixes this upstream, this module can go away —
 * `saveMedia()` in the bot is the only caller.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const { logger } = require('../utils/logger');
const { messageIdOf } = require('./revokeResolver');

/** File extension for a mimetype, without the leading dot. */
function extensionFor(mimetype) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
    'audio/ogg': 'ogg', 'audio/oga': 'ogg', 'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav',
    'audio/webm': 'weba',
    'application/pdf': 'pdf', 'application/zip': 'zip',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt', 'text/csv': 'csv',
  };
  if (map[mimetype]) return map[mimetype];

  // Fall back to the subtype (image/tiff -> tiff), Sanitised so it can never
  // introduce a path separator into a filename.
  const sub = String(mimetype || '').split('/')[1] || '';
  const clean = sub.split(';')[0].replace(/[^a-z0-9]/gi, '');
  return clean || 'bin';
}

/**
 * Runs inside the WhatsApp Web page. Kept as a function so it can be passed
 * straight to page.evaluate().
 */
async function downloadInPage(msgId) {
  const Msg = window.require('WAWebCollections').Msg;

  const msg =
    Msg.get(msgId) ||
    (await Msg.getMessagesById([msgId]))?.messages?.[0];

  // mediaStage 'REUPLOADING' means the media expired and cannot be fetched.
  if (!msg || !msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') {
    return null;
  }

  if (msg.mediaData.mediaStage !== 'RESOLVED') {
    await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
  }

  const stage = String(msg.mediaData.mediaStage || '');
  if (stage.includes('ERROR') || stage === 'FETCHING') return undefined;

  const mockQpl = {
    addAnnotations() { return this; },
    addPoint() { return this; },
  };

  const decrypted = await window
    .require('WAWebDownloadManager')
    .downloadManager
    .downloadAndMaybeDecrypt({
      directPath: msg.directPath,
      encFilehash: msg.encFilehash,
      filehash: msg.filehash,
      mediaKey: msg.mediaKey,
      mediaKeyTimestamp: msg.mediaKeyTimestamp,
      type: msg.type,
      mimetype: msg.mimetype,        // <-- without this the call is rejected
      signal: new AbortController().signal,
      downloadQpl: mockQpl,
    });

  return {
    data: await window.WWebJS.arrayBufferToBase64Async(decrypted),
    mimetype: msg.mimetype,
    filename: msg.filename,
    filesize: msg.size,
  };
}

/**
 * @param {object} client  the live whatsapp-web.js Client
 * @param {object} message a Message
 * @returns {Promise<{data: string, mimetype: string, filename?: string, filesize?: number, ext: string}|null>}
 *   null when the message has no media or the media is no longer retrievable
 */
async function downloadMedia(client, message) {
  if (!client?.pupPage || !message) return null;

  const msgId = messageIdOf(message);
  if (!msgId) {
    logger.warn('Cannot download media: no usable message id.');
    return null;
  }

  // Only skip when the library positively says there is no media. An absent
  // flag must not block the attempt — the page call is the source of truth.
  if (message.hasMedia === false) return null;

  const result = await client.pupPage.evaluate(downloadInPage, msgId);
  if (!result || !result.data) return null;

  return { ...result, ext: extensionFor(result.mimetype) };
}

module.exports = { downloadMedia, extensionFor };
