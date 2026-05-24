/**
 * src/dashboard/index.js
 * ─────────────────────────────────────────────────────────────
 * Express + Socket.IO web dashboard.
 *
 * Features: Contacts, Chats, Messages, Schedule + Ping
 * Removed:  AI commands, Email, Server Tasks, API Health, Logs
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const path       = require('path');
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const { logger, logBus }          = require('../utils/logger');
const { sendWhatsApp, getClient } = require('../services/whatsappClient');
const { getMessages: getChatMessages } = require('../services/chatStore');
require('dotenv').config();

// ── App setup ─────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST', 'DELETE'] } });
const PORT   = parseInt(process.env.DASHBOARD_PORT || '5555', 10);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../../public')));

// ── Socket.IO bridge ──────────────────────────────────────────
logBus.on('status',               status => io.emit('status',               status));
logBus.on('qr',                   qr     => io.emit('qr',                   qr));
logBus.on('chat_message',         msg    => io.emit('new_chat_message',      msg));
logBus.on('chat_message_revoked', data   => io.emit('chat_message_revoked',  data));

io.on('connection', socket => {
  logger.info(`Dashboard client connected: ${socket.id}`);
  socket.on('disconnect', () => logger.info(`Dashboard client left: ${socket.id}`));
});

// ── REST API ──────────────────────────────────────────────────

// Health
app.get('/api/status', (_, res) =>
  res.json({ status: 'ok', uptime: process.uptime(), ts: Date.now() })
);

// All chat messages (including deleted)
app.get('/api/chats', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '1000'), 2000);
    const msgs  = await getChatMessages(limit);
    res.json({ messages: msgs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Contacts search
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
      .slice(0, 100)
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

// Send a single WhatsApp message
app.post('/api/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to)      return res.status(400).json({ error: '"to" is required' });
  if (!message) return res.status(400).json({ error: '"message" is required' });
  try {
    await sendWhatsApp(to, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ping (send the same message N times)
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
    logger.info(`Ping ×${times} sent → ${to}`);
    io.emit('ping_sent', entry);
    res.json({ success: true, count: times });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Scheduled Messages ────────────────────────────────────────
const schedules = [];   // { id, to, message, sendAt (ms), status, createdAt }
let   scheduleId = 1;

app.post('/api/schedule', (req, res) => {
  const { to, message, sendAt } = req.body;
  if (!to)      return res.status(400).json({ error: '"to" is required' });
  if (!message) return res.status(400).json({ error: '"message" is required' });
  if (!sendAt)  return res.status(400).json({ error: '"sendAt" is required' });

  const sendAtMs = new Date(sendAt).getTime();
  if (isNaN(sendAtMs)) return res.status(400).json({ error: 'Invalid sendAt date' });
  if (sendAtMs <= Date.now()) return res.status(400).json({ error: 'sendAt must be in the future' });

  const entry = {
    id: scheduleId++,
    to: String(to).trim(),
    message,
    sendAt: sendAtMs,
    status: 'pending',
    createdAt: Date.now(),
  };
  schedules.push(entry);
  logger.info(`Schedule #${entry.id} → ${entry.to} at ${new Date(sendAtMs).toLocaleString()}`);
  io.emit('schedule_update', schedules);
  res.json({ success: true, schedule: entry });
});

app.get('/api/schedule', (_, res) => res.json({ schedules }));

app.delete('/api/schedule/:id', (req, res) => {
  const id  = parseInt(req.params.id);
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1)                          return res.status(404).json({ error: 'Not found' });
  if (schedules[idx].status === 'sent')    return res.status(400).json({ error: 'Already sent' });
  schedules[idx].status = 'cancelled';
  io.emit('schedule_update', schedules);
  res.json({ success: true });
});

// Scheduler tick — every 15 s
setInterval(async () => {
  const now = Date.now();
  for (const job of schedules) {
    if (job.status !== 'pending' || job.sendAt > now) continue;
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

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => logger.info(`Dashboard → http://0.0.0.0:${PORT}`));

module.exports = { app, server, io };
