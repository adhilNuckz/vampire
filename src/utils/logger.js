/**
 * src/utils/logger.js
 * ─────────────────────────────────────────────────────────────
 * Centralised Winston logger used by every module.
 * Emits an in-process 'log' event so the dashboard can
 * forward entries to connected browsers via Socket.IO.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const path    = require('path');
const fs      = require('fs-extra');
const winston = require('winston');
const { EventEmitter } = require('events');
require('dotenv').config();

// ── ensure log directory exists ──────────────────────────────────────────────
const LOG_DIR = process.env.LOG_DIR || './logs';
fs.ensureDirSync(LOG_DIR);

// ── in-process event bus (dashboard subscribes to this) ──────────────────────
const logBus = new EventEmitter();
logBus.setMaxListeners(30);

// ── custom Winston transport that fires on the event bus ─────────────────────
class BusTransport extends winston.transports.Stream {
  constructor(opts) {
    const stream = require('stream').Writable({
      write(chunk, _enc, done) {
        try {
          const entry = JSON.parse(chunk.toString());
          logBus.emit('log', entry);
        } catch (_) { /* ignore parse errors */ }
        done();
      }
    });
    super({ stream, ...opts });
  }
}

// ── format helpers ────────────────────────────────────────────────────────────
const { combine, timestamp, printf, colorize, errors } = winston.format;

const fileFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ level, message, timestamp, stack }) =>
    `[${timestamp}] ${level}: ${stack || message}`)
);

// ── build logger ──────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),

    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      format:   fileFormat,
      maxsize:  10 * 1024 * 1024,
      maxFiles: 7,
      tailable: true
    }),

    new winston.transports.File({
      level:    'error',
      filename: path.join(LOG_DIR, 'error.log'),
      format:   fileFormat,
      maxsize:  5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true
    }),

    new BusTransport({ format: fileFormat })
  ]
});

// ── convenience wrappers ──────────────────────────────────────────────────────
logger.logMessage = (meta) => logger.info('WHATSAPP_IN',  { ...meta, _tag: 'message'   });
logger.logReply   = (meta) => logger.info('WHATSAPP_OUT', { ...meta, _tag: 'reply'     });
logger.logCommand = (meta) => logger.info('COMMAND',      { ...meta, _tag: 'command'   });
logger.logEmail   = (meta) => logger.info('EMAIL',        { ...meta, _tag: 'email'     });
logger.logApiCheck= (meta) => logger.info('API_CHECK',    { ...meta, _tag: 'api_check' });

module.exports = { logger, logBus };
