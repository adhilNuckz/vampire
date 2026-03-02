/**
 * src/services/email.js
 * ─────────────────────────────────────────────────────────────
 * Gmail REST API over HTTPS (port 443).
 * No SMTP — works even when ISP blocks ports 465 / 587.
 *
 * Requires in .env:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 * Run `node get-token.js` once to get those values.
 *
 * Exports:
 *   sendEmail({ to, subject, body, html? })  → { success, info | error }
 *   getInbox(n)                              → Array<{ from, subject, date, snippet }>
 *   validateEmail(address)                   → boolean
 *   parseEmailCommand(raw)                   → { to, subject, body }
 *   verifySMTP()                             → { ok, message }
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const { google } = require('googleapis');
const { logger } = require('../utils/logger');
require('dotenv').config();

// ── helpers ───────────────────────────────────────────────────────────────────

function requireOauthCreds() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error(
      'Gmail API not configured.\n' +
      'Run: node get-token.js  — takes ~5 min, then paste 3 lines into .env'
    );
  }
}

/** Basic RFC-5322 format check. */
function validateEmail(address) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(address).trim());
}

/**
 * Parse natural-language email string into { to, subject, body }.
 * e.g. "to: alice@x.com subject: Hello body: How are you?"
 */
function parseEmailCommand(raw) {
  const toMatch      = raw.match(/\bto[:\s]+([^\s,;]+)/i);
  const subjectMatch = raw.match(/\bsubject[:\s]+"?([^"]+?)"?\s*(body|$)/i) ||
                       raw.match(/\bsubject[:\s]+(.+?)(?:\s+body|$)/i);
  const bodyMatch    = raw.match(/\bbody[:\s]+"?(.+)"?$/is) ||
                       raw.match(/\bbody[:\s]+(.+)$/is);
  return {
    to:      toMatch      ? toMatch[1].trim()      : raw.trim(),
    subject: subjectMatch ? subjectMatch[1].trim() : '(no subject)',
    body:    bodyMatch    ? bodyMatch[1].trim()     : ''
  };
}

// ── OAuth2 client ────────────────────────────────────────────────────────────

function makeOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return client;
}

async function sendViaGmailAPI({ to, subject, body, html }) {
  const auth  = makeOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || 'me';
  const mimeLines = [
    'MIME-Version: 1.0',
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject || '(no subject)'}`,
    html
      ? 'Content-Type: text/html; charset="UTF-8"'
      : 'Content-Type: text/plain; charset="UTF-8"',
    '',
    html || body || ''
  ].join('\r\n');

  // Gmail API requires base64url encoding
  const raw = Buffer.from(mimeLines)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });
  return { messageId: res.data.id, threadId: res.data.threadId };
}

// ── main send ─────────────────────────────────────────────────────────────────

/**
 * Send an email.
 * @param {{ to: string, subject: string, body: string, html?: string }} params
 * @returns {Promise<{ success: boolean, info?: object, error?: string }>}
 */
async function sendEmail({ to, subject, body, html }) {
  const recipients = String(to).split(/[,;]/).map(r => r.trim()).filter(Boolean);
  const invalid    = recipients.filter(r => !validateEmail(r));

  if (invalid.length) {
    const msg = `Invalid email address(es): ${invalid.join(', ')}`;
    logger.warn(msg);
    return { success: false, error: msg };
  }

  const dest = recipients.join(', ');

  try {
    requireOauthCreds();
    const info = await sendViaGmailAPI({ to: dest, subject, body, html });
    logger.info(`Email sent → ${dest} | id: ${info.messageId}`);
    logger.logEmail({ to: dest, subject, success: true });
    return { success: true, info };
  } catch (err) {
    logger.logEmail({ to: dest, subject, success: false });
    logger.error(`Email failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Verify email connectivity (called at startup).
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function verifySMTP() {
  try {
    requireOauthCreds();
    await makeOAuth2Client().getAccessToken();
    return { ok: true, message: 'Gmail API ready ✅' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ── inbox reader ─────────────────────────────────────────────────────────────

/**
 * Fetch recent inbox messages via Gmail API.
 * @param {number} maxResults  how many messages to fetch (default 5)
 * @returns {Promise<Array<{ from, subject, date, snippet }>>}
 */
async function getInbox(maxResults = 5) {
  requireOauthCreds();

  const auth  = makeOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  // list message IDs in INBOX
  const list = await gmail.users.messages.list({
    userId:   'me',
    labelIds: ['INBOX'],
    maxResults,
    q: 'is:inbox'
  });

  const messages = list.data.messages || [];
  if (!messages.length) return [];

  // fetch each message header
  const results = await Promise.all(messages.map(async ({ id }) => {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date']
    });

    const headers = msg.data.payload?.headers || [];
    const h = (name) => headers.find(h => h.name === name)?.value || '';

    return {
      id,
      from:    h('From'),
      subject: h('Subject') || '(no subject)',
      date:    h('Date'),
      snippet: msg.data.snippet || ''
    };
  }));

  return results;
}

module.exports = { sendEmail, getInbox, validateEmail, parseEmailCommand, verifySMTP };
