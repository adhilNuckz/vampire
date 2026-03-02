/**
 * start.js  — unified entry point
 * ─────────────────────────────────────────────────────────────
 * Starts both the WhatsApp bot and the dashboard in the SAME
 * Node.js process so they share the same logBus EventEmitter
 * and all bot events appear live in the dashboard.
 *
 * Usage:  node start.js
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

// ── global safety net ─────────────────────────────────────────────────────────
process.on('uncaughtException',  err => console.error('[UNCAUGHT]', err));
process.on('unhandledRejection', err => console.error('[UNHANDLED]', err));

// ── start dashboard first (sets up Express + Socket.IO) ──────────────────────
require('./src/dashboard/index.js');

// ── start bot (will emit events on the shared logBus) ────────────────────────
require('./src/bot/index.js');
