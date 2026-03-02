/**
 * src/dashboard/index.js
 * ─────────────────────────────────────────────────────────────
 * Express + Socket.IO web dashboard.
 *
 * • http://<host>:5555
 * • Subscribes to logBus and pushes every event to browsers
 * • REST API for manual task triggering
 * • Serves static UI from /public/
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const path       = require('path');
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const si         = require('systeminformation');
const { logger, logBus } = require('../utils/logger');
const { processMessage }  = require('../services/processor');
const { sendEmail }       = require('../services/email');
const { sendWhatsApp, getClient } = require('../services/whatsappClient');
const { getMessages: getChatMessages } = require('../services/chatStore');
const tasks               = require('../services/serverTasks');
require('dotenv').config();

// ── app setup ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT   = parseInt(process.env.DASHBOARD_PORT || '5555', 10);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve the public/ directory which lives two levels above this file
app.use(express.static(path.join(__dirname, '../../public')));

// ── in-memory log ring-buffer (last 500 entries) ──────────────────────────────
const MAX_HISTORY = 500;
const logHistory  = [];
const push = entry => {
  logHistory.push(entry);
  if (logHistory.length > MAX_HISTORY) logHistory.shift();
};

// ── bridge logBus → Socket.IO ─────────────────────────────────────────────────
logBus.on('log',     entry  => { push(entry);                         io.emit('log',     entry);  });
logBus.on('message', msg    => { push({ _tag: 'message', ...msg });   io.emit('message', msg);    });
logBus.on('status',  status => {                                       io.emit('status',  status); });
logBus.on('qr',      qr     => {                                       io.emit('qr',      qr);     });
logBus.on('chat_message', msg => {                                     io.emit('new_chat_message', msg); });

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  logger.info(`Dashboard client connected: ${socket.id}`);
  socket.emit('history', logHistory.slice(-200));
  socket.on('disconnect', () => logger.info(`Dashboard client left: ${socket.id}`));
});

// ─────────────────────────────────────────────────────────────────────────────
//  REST API
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/status', (_, res) =>
  res.json({ status: 'ok', uptime: process.uptime(), ts: Date.now() })
);

app.get('/api/metrics', async (_, res) => {
  try {
    const [cpu, mem, disk, load] = await Promise.all([si.cpu(), si.mem(), si.fsSize(), si.currentLoad()]);
    res.json({ cpu, mem, disk, load });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/system', async (_, res) => {
  res.json({ metrics: await tasks.getSystemMetrics() });
});

app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), MAX_HISTORY);
  res.json({ logs: logHistory.slice(-limit) });
});

app.get('/api/crypto', async (req, res) => {
  const coins = (req.query.coins || process.env.CRYPTO_DEFAULT || 'bitcoin,ethereum').split(',');
  res.json({ result: await tasks.getCryptoPrices(coins) });
});

app.get('/api/weather', async (req, res) => {
  res.json({ result: await tasks.getWeather(req.query.city || '') });
});

app.post('/api/command', async (req, res) => {
  const { text, sender = 'dashboard' } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const reply = await processMessage(text, sender);
    io.emit('command_result', { text, reply, sender, ts: Date.now() });
    res.json({ success: true, reply });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/email', async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to) return res.status(400).json({ error: 'to is required' });
  try { res.json(await sendEmail({ to, subject, body })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shell', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command is required' });
  res.json(await tasks.runCommand(command));
});

app.post('/api/health-check', async (req, res) => {
  const { urls } = req.body;
  if (!urls?.length) return res.status(400).json({ error: 'urls is required' });
  res.json({ result: await tasks.checkApiHealth(urls) });
});

// ── Contacts search & ping ────────────────────────────────────────────────────

app.get('/api/contacts', async (req, res) => {
  const client = getClient();
  if (!client) return res.status(503).json({ error: 'WhatsApp not ready yet' });
  try {
    const q        = (req.query.q || '').toLowerCase().trim();
    const contacts = await client.getContacts();
    const results  = contacts
      .filter(c => !c.isGroup && (c.number || c.id?.user))
      .filter(c => {
        if (!q) return true;
        const name   = (c.name || c.pushname || '').toLowerCase();
        const number = (c.number || c.id?.user || '').toLowerCase();
        return name.includes(q) || number.includes(q);
      })
      .slice(0, 50)
      .map(c => ({
        id:     c.id?._serialized || `${c.number}@c.us`,
        name:   c.name || c.pushname || '',
        number: c.number || c.id?.user || '',
      }));
    res.json({ contacts: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ping', async (req, res) => {
  const { to, message, count = 5 } = req.body;
  if (!to)      return res.status(400).json({ error: '"to" is required' });
  if (!message) return res.status(400).json({ error: '"message" is required' });
  const times = Math.min(Math.max(parseInt(count) || 5, 1), 20);
  try {
    for (let i = 0; i < times; i++) {
      await sendWhatsApp(to, message);
      if (i < times - 1) await new Promise(r => setTimeout(r, 600));
    }
    const entry = { to, message, count: times, ts: Date.now() };
    logger.info(`Ping ×${times} sent → ${to}: ${message.slice(0, 60)}`);
    io.emit('ping_sent', entry);
    res.json({ success: true, count: times });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Chat history ─────────────────────────────────────────────────────────────
app.get('/api/chats', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
  res.json({ messages: getChatMessages(limit) });
});

// ── Scheduled WhatsApp Messages ──────────────────────────────────────────────
const schedules = [];  // { id, to, message, sendAt (ms), status, createdAt }
let   scheduleId = 1;

// Create a scheduled message
app.post('/api/schedule', (req, res) => {
  const { to, message, sendAt } = req.body;
  if (!to)      return res.status(400).json({ error: '"to" (phone number) is required' });
  if (!message) return res.status(400).json({ error: '"message" is required' });
  if (!sendAt)  return res.status(400).json({ error: '"sendAt" (ISO datetime) is required' });

  const sendAtMs = new Date(sendAt).getTime();
  if (isNaN(sendAtMs)) return res.status(400).json({ error: 'Invalid sendAt date' });
  if (sendAtMs <= Date.now()) return res.status(400).json({ error: 'sendAt must be in the future' });

  const entry = { id: scheduleId++, to: String(to).trim(), message, sendAt: sendAtMs, status: 'pending', createdAt: Date.now() };
  schedules.push(entry);
  logger.info(`Schedule #${entry.id} created → ${entry.to} at ${new Date(sendAtMs).toLocaleString()}`);
  io.emit('schedule_update', schedules);
  res.json({ success: true, schedule: entry });
});

// List all schedules
app.get('/api/schedule', (req, res) => {
  res.json({ schedules });
});

// Cancel a scheduled message
app.delete('/api/schedule/:id', (req, res) => {
  const id  = parseInt(req.params.id);
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (schedules[idx].status === 'sent') return res.status(400).json({ error: 'Already sent' });
  schedules[idx].status = 'cancelled';
  io.emit('schedule_update', schedules);
  res.json({ success: true });
});

// Scheduler tick — checks every 15 s
setInterval(async () => {
  const now = Date.now();
  for (const job of schedules) {
    if (job.status !== 'pending') continue;
    if (job.sendAt > now) continue;
    job.status = 'sending';
    try {
      await sendWhatsApp(job.to, job.message);
      job.status = 'sent';
      logger.info(`Schedule #${job.id} sent → ${job.to}`);
    } catch (err) {
      job.status = 'failed';
      job.error  = err.message;
      logger.error(`Schedule #${job.id} failed: ${err.message}`);
    }
    io.emit('schedule_update', schedules);
  }
}, 15_000);

// ── start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => logger.info(`Dashboard → http://0.0.0.0:${PORT}`));

// Broadcast live metrics every 15 s if anyone is watching
setInterval(async () => {
  if (!io.sockets.sockets.size) return;
  try {
    const [load, mem] = await Promise.all([si.currentLoad(), si.mem()]);
    io.emit('metrics', {
      cpu: parseFloat(load.currentLoadUser.toFixed(1)),
      ram: parseFloat(((mem.active / mem.total) * 100).toFixed(1)),
      ts:  Date.now()
    });
  } catch (_) {}
}, 15_000);

module.exports = { app, server, io };
