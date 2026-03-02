/**
 * src/services/processor.js
 * ─────────────────────────────────────────────────────────────
 * Natural-language command processor backed by Gemini.
 *
 * Flow:
 *   processMessage(text, senderId)
 *     1. Ask Gemini to classify intent + extract params
 *     2. Route to the appropriate handler
 *     3. Return a human-friendly reply string
 *
 * Supported intents:
 *   send_email, shell_command, api_check, nmap_scan,
 *   crypto_price, weather, system_metrics, disk_usage,
 *   uptime, tail_log, restart_service, top_processes,
 *   help, unknown
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { logger }   = require('../utils/logger');
const { sendEmail, getInbox } = require('./email');
const tasks         = require('./serverTasks');
require('dotenv').config();

// ── Gemini client ─────────────────────────────────────────────────────────────
let _model = null;

function getModel() {
  if (_model) return _model;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set in .env');
  _model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
  return _model;
}

// ── Gemini call with auto-retry on 429 ───────────────────────────────────────
async function callGemini(contents, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getModel().generateContent(contents);
    } catch (err) {
      const is429 = err.message?.includes('429') || err.status === 429;

      // parse suggested retry delay from error message e.g. "retryDelay":"27s"
      const delayMatch = err.message?.match(/"retryDelay"\s*:\s*"(\d+)s"/);
      const delaySec   = delayMatch ? parseInt(delayMatch[1]) + 2 : 30;

      if (is429 && attempt < maxRetries) {
        logger.warn(`Gemini 429 – waiting ${delaySec}s then retrying (attempt ${attempt + 1}/${maxRetries})…`);
        await new Promise(r => setTimeout(r, delaySec * 1000));
        continue;
      }

      // Daily quota exhausted (limit: 0) — give user a clear message
      if (is429 && err.message?.includes('limit: 0')) {
        throw new Error('Daily Gemini quota exhausted. Resets at midnight PT. Try again later or get a new API key at https://aistudio.google.com/');
      }

      throw err;
    }
  }
}

// ── Classification prompt ─────────────────────────────────────────────────────
const CLASSIFICATION_PROMPT = `
You are a command intent classifier for a WhatsApp server automation agent.
Given a user message, respond ONLY with a valid JSON object (no markdown, no code fences).

JSON schema:
{
  "intent": "<one of the intents below>",
  "params": { <relevant key-value pairs> },
  "display": "<human-friendly short description of what the command will do>"
}

Supported intents and their params:
- shell_command  : { command }
- api_check      : { urls: ["..."] }
- nmap_scan      : { target, flags? }
- crypto_price   : { coins: ["bitcoin","..."] }
- weather        : { city }
- system_metrics : {}
- disk_usage     : {}
- uptime         : {}
- tail_log       : { path, lines? }
- restart_service: { service }
- top_processes  : {}
- help           : {}
- unknown        : { reason }

Rules:
- For shell_command, only emit the raw shell command string.
- If the message looks like an email request, use "unknown" — emails are handled separately via !email command.
- If ambiguous or not actionable, use "unknown".
- Respond ONLY with the JSON — no extra text.

User message: `;

// ── Classify via Gemini ───────────────────────────────────────────────────────
async function classifyIntent(text) {
  try {
    const result  = await callGemini(CLASSIFICATION_PROMPT + JSON.stringify(text));
    const raw     = result.response.text().trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    logger.warn(`Gemini classification failed: ${err.message}`);
    return { intent: 'unknown', params: { reason: err.message }, display: '' };
  }
}

// ── Transcribe voice audio via Gemini STT ────────────────────────────────────
async function transcribeAudio(audioBuffer, mimeType = 'audio/wav') {
  try {
    const result = await callGemini([
      { inlineData: { mimeType, data: audioBuffer.toString('base64') } },
      'Transcribe the audio exactly. Return only the transcribed text, nothing else.'
    ]);
    return result.response.text().trim();
  } catch (err) {
    logger.error(`Audio transcription failed: ${err.message}`);
    return '';
  }
}

// ── Help text ─────────────────────────────────────────────────────────────────
const HELP_TEXT = `
*WhatsApp Agent — Commands* 🤖

📧 *Email*
  • !email alice@x.com subject Hello body Hi there
  • !inbox        — show last 5 emails
  • !inbox 10     — show last 10 emails

🖥 *Server*
  • Run df -h
  • Restart service nginx  /  Restart pm2:my-app
  • Tail /var/log/syslog 50 lines
  • Top processes  |  Uptime

📊 *Metrics*
  • System metrics  |  Disk usage

🌐 *Network*
  • Check API https://api.example.com/health
  • Nmap scan 192.168.1.1

💰 *Crypto*
  • Bitcoin price
  • Prices for bitcoin, ethereum, solana

🌤 *Weather*
  • Weather in Tokyo

🤖 *AI Chat*
  • !ask What is the meaning of life?
  • !chat Explain quantum computing simply

❓ Type *help* to see this message again.
`.trim();

// ── Intent handlers ───────────────────────────────────────────────────────────
const handlers = {
  async send_email({ to, subject, body }) {
    if (!to) return '❌ Missing recipient address.';
    const res = await sendEmail({ to, subject, body });
    return res.success
      ? `✅ Email sent to *${to}* — Subject: "${subject}"`
      : `❌ Email failed: ${res.error}`;
  },

  async read_inbox({ count = 5 }) {
    try {
      const emails = await getInbox(Math.min(count, 20));
      if (!emails.length) return '📭 Inbox is empty (or no Gmail API access).';
      const lines = emails.map((e, i) => {
        const from    = e.from.replace(/<[^>]+>/, '').trim() || e.from;
        const date    = e.date ? new Date(e.date).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '';
        const snippet = e.snippet.length > 80 ? e.snippet.slice(0, 77) + '…' : e.snippet;
        return `*${i + 1}.* ${e.subject}\n   From: ${from}  |  ${date}\n   ${snippet}`;
      });
      return `📬 *Last ${emails.length} inbox emails:*\n\n` + lines.join('\n\n');
    } catch (err) {
      return `❌ Inbox error: ${err.message}`;
    }
  },

  async shell_command({ command }) {
    if (!command) return '❌ No command provided.';
    const res = await tasks.runCommand(command);
    if (!res.success) return `❌ ${res.error}`;
    return '```\n' + res.output.slice(0, 3000) + '\n```';
  },

  async api_check({ urls }) {
    if (!urls?.length) return '❌ No URLs provided.';
    return tasks.checkApiHealth(urls);
  },

  async nmap_scan({ target, flags }) {
    if (!target) return '❌ No target specified.';
    return tasks.nmapScan(target, flags);
  },

  async crypto_price({ coins }) { return tasks.getCryptoPrices(coins); },
  async weather({ city })       { return tasks.getWeather(city); },
  async system_metrics()        { return tasks.getSystemMetrics(); },
  async disk_usage()            { return tasks.getDiskUsage(); },
  async uptime()                { return tasks.getUptime(); },

  async tail_log({ path: filePath, lines }) {
    if (!filePath) return '❌ No log file path specified.';
    return tasks.tailLog(filePath, lines || 20);
  },

  async restart_service({ service }) {
    if (!service) return '❌ No service name specified.';
    return tasks.restartService(service);
  },

  async top_processes() { return tasks.getTopProcesses(); },
  async help()          { return HELP_TEXT; },

  async chat({ question }) {
    if (!question) return '❌ Usage: !ask <your question>';
    try {
      const result = await callGemini(question);
      return result.response.text().trim();
    } catch (err) {
      return `❌ ${err.message}`;
    }
  },

  async unknown({ reason }) {
    return `🤔 Not sure how to handle that.${reason ? `\nReason: ${reason}` : ''}\nType *help* for available commands.`;
  }
};

// ── Keyword fast-path (no Gemini needed) ────────────────────────────────────
// Maps regex patterns directly to { intent, params } — bypasses LLM entirely.
const KEYWORD_ROUTES = [
  // help
  { re: /^!?help$/i,                                     intent: 'help',           params: {} },

  // system / metrics
  { re: /^!?(sysinfo|system[-_ ]?metrics?|metrics?)$/i,  intent: 'system_metrics', params: {} },
  { re: /^!?(disk[-_ ]?usage?|df)$/i,                    intent: 'disk_usage',     params: {} },
  { re: /^!?(uptime)$/i,                                 intent: 'uptime',         params: {} },
  { re: /^!?(top[-_ ]?proc(esses?)?)$/i,                 intent: 'top_processes',  params: {} },
  { re: /^!?(cpu|ram|memory)$/i,                         intent: 'system_metrics', params: {} },

  // crypto — !btc, !eth, !crypto, !price bitcoin, etc.
  { re: /^!?(btc|bitcoin[-_ ]?price?)$/i,                intent: 'crypto_price',   params: { coins: ['bitcoin'] } },
  { re: /^!?(eth|ethereum[-_ ]?price?)$/i,               intent: 'crypto_price',   params: { coins: ['ethereum'] } },
  { re: /^!?(sol|solana[-_ ]?price?)$/i,                 intent: 'crypto_price',   params: { coins: ['solana'] } },
  { re: /^!?crypto$/i,                                   intent: 'crypto_price',   params: {} },

  // weather — !weather London
  { re: /^!?weather(?:\s+(.+))?$/i,                      intent: 'weather',
    extract: m => ({ city: (m[1] || '').trim() }) },

  // email — !email to@x.com [subject: ...] [body: ...] OR !email to@x.com plain text
  // Everything after the address is the message body unless subject:/body: tags are used.
  { re: /^!?email\s+(\S+@\S+)(.*)$/is,
    intent: 'send_email',
    extract: m => {
      const addr = m[1].trim();
      const rest = (m[2] || '').trim();
      const subjMatch = rest.match(/\bsubject[:\s]+([^\n]+?)(?:\s+body[:\s]|$)/i);
      const bodyMatch = rest.match(/\bbody[:\s]+([\s\S]+)$/i);
      return {
        to:      addr,
        subject: subjMatch ? subjMatch[1].trim() : '(no subject)',
        body:    bodyMatch ? bodyMatch[1].trim() : rest || ''
      };
    }
  },

  // inbox — !inbox  or  !inbox 10
  { re: /^!?inbox(?:\s+(\d+))?$/i,                        intent: 'read_inbox',
    extract: m => ({ count: m[1] ? parseInt(m[1]) : 5 }) },

  // shell — !run <cmd> or !shell <cmd> or !cmd <cmd>
  { re: /^!?(?:run|shell|cmd)\s+(.+)$/i,                 intent: 'shell_command',
    extract: m => ({ command: m[1] }) },

  // log — !log /path/to/file 50
  { re: /^!?(?:tail|log)\s+(\S+)(?:\s+(\d+))?$/i,       intent: 'tail_log',
    extract: m => ({ path: m[1], lines: m[2] ? parseInt(m[2]) : 20 }) },

  // service restart — !restart nginx or !restart pm2:app
  { re: /^!?restart\s+(.+)$/i,                           intent: 'restart_service',
    extract: m => ({ service: m[1].trim() }) },

  // api / health check — !check https://...
  { re: /^!?(?:check|api)\s+(https?:\/\/\S+)$/i,        intent: 'api_check',
    extract: m => ({ urls: [m[1]] }) },

  // nmap — !nmap 192.168.1.1
  { re: /^!?nmap\s+(\S+)(?:\s+(.+))?$/i,                 intent: 'nmap_scan',
    extract: m => ({ target: m[1], flags: m[2] }) },

  // ask / chat — !ask <anything> or !chat <anything>
  { re: /^!?(?:ask|chat)\s+(.+)$/is,                     intent: 'chat',
    extract: m => ({ question: m[1].trim() }) },
];

function matchKeyword(text) {
  const trimmed = text.trim();
  for (const route of KEYWORD_ROUTES) {
    const m = trimmed.match(route.re);
    if (m) {
      const params = route.extract ? route.extract(m) : route.params;
      return { intent: route.intent, params, display: route.intent };
    }
  }
  return null;
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Process a text message from a WhatsApp user.
 * @param {string} text      Raw message text
 * @param {string} senderId  WhatsApp number of sender
 * @returns {Promise<string>}
 */
async function processMessage(text, senderId) {
  logger.info(`Processing from ${senderId}: "${text.slice(0, 100)}"`);

  // 1. Try keyword fast-path first (zero Gemini quota used)
  const kw = matchKeyword(text.trim());
  if (kw) {
    logger.info(`Keyword match: ${kw.intent}`);
    const handler = handlers[kw.intent] || handlers.unknown;
    try   { return await handler(kw.params || {}); }
    catch (err) {
      logger.error(`Handler error [${kw.intent}]: ${err.message}`);
      return `❌ Error: ${err.message}`;
    }
  }

  // 2. Fall back to Gemini for natural-language queries
  const { intent, params, display } = await classifyIntent(text);
  logger.info(`Gemini intent: ${intent} | ${display}`);

  const handler = handlers[intent] || handlers.unknown;
  try {
    return await handler(params || {});
  } catch (err) {
    logger.error(`Handler error [${intent}]: ${err.message}`);
    return `❌ Error processing request: ${err.message}`;
  }
}

module.exports = { processMessage, classifyIntent, transcribeAudio };
