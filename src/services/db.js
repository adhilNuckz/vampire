"use strict";

/**
 * src/services/db.js
 * ─────────────────────────────────────────────────────────────
 * Persistence layer for WhatsApp chat messages.
 *
 * Primary store  : MySQL  (when DB_USE_MYSQL=true in .env)
 * Default store  : SQLite via sql.js (data/vampire.db — pure JS, no native build needed)
 *
 * Schema (both engines):
 *   chat_messages(id, msg_id, sender, sender_id, body, type,
 *                 media_url, ts, is_deleted, deleted_at)
 * ─────────────────────────────────────────────────────────────
 */

const path  = require("path");
const fs    = require("fs-extra");
const { logger } = require("../utils/logger");

const DATA_DIR = path.join(process.cwd(), "data");
fs.ensureDirSync(DATA_DIR);
const DB_FILE = path.join(DATA_DIR, "vampire.db");

const useMySQL = process.env.DB_USE_MYSQL === "true";

// ── sql.js SQLite ─────────────────────────────────────────────
let _sqliteDB   = null;   // sql.js Database instance
let _sqliteReady = null;  // Promise

function saveSQLiteDB(db) {
  // Persist sql.js in-memory DB to disk
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

async function getSQLite() {
  if (_sqliteDB) return _sqliteDB;
  if (_sqliteReady) return _sqliteReady;

  _sqliteReady = (async () => {
    const initSqlJs = require("sql.js");
    const SQL = await initSqlJs();

    let db;
    if (fs.existsSync(DB_FILE)) {
      const fileBuffer = fs.readFileSync(DB_FILE);
      db = new SQL.Database(fileBuffer);
      logger.info(`SQLite loaded from ${DB_FILE}`);
    } else {
      db = new SQL.Database();
      logger.info(`SQLite created at ${DB_FILE}`);
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        msg_id     TEXT    DEFAULT '',
        sender     TEXT    DEFAULT '',
        sender_id  TEXT    DEFAULT '',
        body       TEXT    DEFAULT '',
        type       TEXT    DEFAULT '',
        media_url  TEXT,
        ts         INTEGER DEFAULT 0,
        is_deleted INTEGER DEFAULT 0,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ts     ON chat_messages(ts);
      CREATE INDEX IF NOT EXISTS idx_msg_id ON chat_messages(msg_id);
    `);
    saveSQLiteDB(db);
    _sqliteDB = db;
    return db;
  })();

  return _sqliteReady;
}

function sqliteRowToEntry(r) {
  return {
    id:        r.id,
    msgId:     r.msg_id     || "",
    sender:    r.sender     || "",
    senderId:  r.sender_id  || "",
    body:      r.body       || "",
    type:      r.type       || "",
    mediaUrl:  r.media_url  || null,
    ts:        r.ts,
    isDeleted: Boolean(r.is_deleted),
    deletedAt: r.deleted_at || null,
  };
}

async function saveChatMessageSQLite(entry) {
  const db  = await getSQLite();
  const ts  = entry.ts || Date.now();
  db.run(
    "INSERT INTO chat_messages (msg_id, sender, sender_id, body, type, media_url, ts, is_deleted, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      entry.msgId     || "",
      entry.sender    || "",
      entry.senderId  || "",
      entry.body      || "",
      entry.type      || "",
      entry.mediaUrl  || null,
      ts,
      entry.isDeleted ? 1 : 0,
      entry.deletedAt || null,
    ]
  );
  // Get last insert id
  const idRes = db.exec("SELECT last_insert_rowid() AS id");
  const id    = idRes[0]?.values[0]?.[0] ?? 0;
  saveSQLiteDB(db);
  return { id, ts };
}

async function getRecentChatMessagesSQLite(limit) {
  const db  = await getSQLite();
  const lim = limit || 1000;
  const res = db.exec(
    `SELECT id, msg_id, sender, sender_id, body, type, media_url, ts, is_deleted, deleted_at
     FROM chat_messages ORDER BY ts ASC, id ASC LIMIT ${lim}`
  );
  if (!res.length || !res[0].values.length) return [];
  const cols = res[0].columns;
  return res[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return sqliteRowToEntry(obj);
  });
}

async function revokeChatMessageSQLite(msgId) {
  const db        = await getSQLite();
  const deletedAt = Date.now();
  db.run(
    "UPDATE chat_messages SET is_deleted = 1, deleted_at = ? WHERE msg_id = ?",
    [deletedAt, msgId]
  );
  saveSQLiteDB(db);
  const res = db.exec(
    `SELECT id, msg_id, sender, sender_id, body, type, media_url, ts, is_deleted, deleted_at
     FROM chat_messages WHERE msg_id = '${msgId.replace(/'/g, "''")}' LIMIT 1`
  );
  if (!res.length || !res[0].values.length) return null;
  const cols = res[0].columns;
  const obj  = {};
  res[0].columns.forEach((c, i) => { obj[c] = res[0].values[0][i]; });
  return sqliteRowToEntry(obj);
}

// ── MySQL ─────────────────────────────────────────────────────
let pool        = null;
let schemaReady = null;

async function initMySQL() {
  if (pool) return;
  const mysql = require("mysql2/promise");
  pool = mysql.createPool({
    host:               process.env.DB_HOST     || "localhost",
    port:               parseInt(process.env.DB_PORT || "3306", 10),
    user:               process.env.DB_USER     || "root",
    password:           process.env.DB_PASSWORD || "",
    database:           process.env.DB_NAME     || "vampire",
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
  });

  if (!schemaReady) {
    schemaReady = pool.execute(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        msg_id     VARCHAR(255) DEFAULT '',
        sender     VARCHAR(255) DEFAULT '',
        sender_id  VARCHAR(100) DEFAULT '',
        body       TEXT,
        type       VARCHAR(50)  DEFAULT '',
        media_url  TEXT,
        ts         BIGINT       DEFAULT 0,
        is_deleted TINYINT(1)   DEFAULT 0,
        deleted_at BIGINT       DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).then(() => {
      const alters = [
        "ALTER TABLE chat_messages ADD COLUMN msg_id VARCHAR(255) DEFAULT ''",
        "ALTER TABLE chat_messages ADD COLUMN is_deleted TINYINT(1) DEFAULT 0",
        "ALTER TABLE chat_messages ADD COLUMN deleted_at BIGINT DEFAULT NULL",
      ];
      return Promise.all(alters.map(sql => pool.execute(sql).catch(() => {})));
    }).catch(err => {
      logger.error(`MySQL schema init: ${err.message}`);
      pool        = null;
      schemaReady = null;
    });
  }
  await schemaReady;
}

async function saveChatMessageMySQL(entry) {
  await initMySQL();
  if (!pool) throw new Error("MySQL pool unavailable");
  const ts = entry.ts || Date.now();
  const [result] = await pool.execute(
    "INSERT INTO chat_messages (msg_id, sender, sender_id, body, type, media_url, ts, is_deleted, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [entry.msgId || "", entry.sender || "", entry.senderId || "",
     entry.body || "", entry.type || "", entry.mediaUrl || null,
     ts, entry.isDeleted ? 1 : 0, entry.deletedAt || null]
  );
  return { id: Number(result.insertId), ts };
}

async function getRecentChatMessagesMySQL(limit) {
  await initMySQL();
  if (!pool) throw new Error("MySQL pool unavailable");
  const lim = limit || 1000;
  const [rows] = await pool.execute(
    "SELECT * FROM chat_messages ORDER BY ts ASC, id ASC LIMIT ?", [lim]
  );
  return rows.map(r => ({
    id:        Number(r.id),
    msgId:     r.msg_id     || "",
    sender:    r.sender     || "",
    senderId:  r.sender_id  || "",
    body:      r.body       || "",
    type:      r.type       || "",
    mediaUrl:  r.media_url  || null,
    ts:        Number(r.ts),
    isDeleted: Boolean(r.is_deleted),
    deletedAt: r.deleted_at ? Number(r.deleted_at) : null,
  }));
}

async function revokeChatMessageMySQL(msgId) {
  await initMySQL();
  if (!pool) throw new Error("MySQL pool unavailable");
  const deletedAt = Date.now();
  await pool.execute(
    "UPDATE chat_messages SET is_deleted = 1, deleted_at = ? WHERE msg_id = ?",
    [deletedAt, msgId]
  );
  const [rows] = await pool.execute(
    "SELECT * FROM chat_messages WHERE msg_id = ? LIMIT 1", [msgId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id:        Number(r.id),
    msgId:     r.msg_id,
    sender:    r.sender,
    senderId:  r.sender_id,
    body:      r.body,
    type:      r.type,
    mediaUrl:  r.media_url,
    ts:        Number(r.ts),
    isDeleted: Boolean(r.is_deleted),
    deletedAt: Number(r.deleted_at),
  };
}

// ── Unified API ───────────────────────────────────────────────

async function saveChatMessage(entry) {
  if (useMySQL) return saveChatMessageMySQL(entry);
  return saveChatMessageSQLite(entry);
}

async function getRecentChatMessages(limit) {
  if (useMySQL) return getRecentChatMessagesMySQL(limit);
  return getRecentChatMessagesSQLite(limit);
}

async function revokeChatMessage(msgId) {
  if (useMySQL) return revokeChatMessageMySQL(msgId);
  return revokeChatMessageSQLite(msgId);
}

module.exports = { saveChatMessage, getRecentChatMessages, revokeChatMessage };
