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
 *
 * Anti-delete notes
 * -----------------
 * • msg_id is UNIQUE. WhatsApp Web emits the same logical message more
 *   than once (message_create + message, and again for ciphertext
 *   messages that later decrypt), so every insert goes through
 *   upsertChatMessage() which de-duplicates on msg_id and enriches the
 *   existing row (e.g. when a ciphertext message gains its real media).
 * • revokeChatMessage() marks a row deleted WITHOUT clearing the body, so
 *   the dashboard keeps showing what was originally sent.
 * • markMessageDeletedFallback() records a deletion even when we never
 *   captured the original message (bot was offline, store miss, …).
 * ─────────────────────────────────────────────────────────────
 */

const path  = require("path");
const fs    = require("fs-extra");
const { logger } = require("../utils/logger");

const DATA_DIR = path.join(process.cwd(), "data");
fs.ensureDirSync(DATA_DIR);
const DB_FILE = path.join(DATA_DIR, "vampire.db");

const useMySQL = process.env.DB_USE_MYSQL === "true";
let mysqlFailed = false;
let mysqlFallbackWarned = false;

function useSQLiteFallback(reason) {
  if (!mysqlFallbackWarned) {
    logger.warn(`MySQL unavailable, using SQLite fallback: ${reason}`);
    mysqlFallbackWarned = true;
  }
}

// ── sql.js SQLite ─────────────────────────────────────────────
let _sqliteDB   = null;   // sql.js Database instance
let _sqliteReady = null;  // Promise

const SELECT_COLS = "id, msg_id, sender, sender_id, body, type, media_url, ts, is_deleted, deleted_at";

function saveSQLiteDB(db) {
  // Persist sql.js in-memory DB to disk
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

/** Run a SELECT and return an array of plain row objects. */
function sqliteAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

/** Run a SELECT and return the first row (or null). */
function sqliteGet(db, sql, params = []) {
  return sqliteAll(db, sql, params)[0] || null;
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

    // Back-fill de-duplication for databases created before msg_id was UNIQUE.
    try {
      db.run(`
        DELETE FROM chat_messages
        WHERE msg_id <> ''
          AND id NOT IN (SELECT MAX(id) FROM chat_messages WHERE msg_id <> '' GROUP BY msg_id)
      `);
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_id_unique ON chat_messages(msg_id) WHERE msg_id <> ''");
    } catch (err) {
      logger.warn(`SQLite msg_id unique index skipped: ${err.message}`);
    }

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

/**
 * Insert a message, or update the existing row for the same msg_id.
 *
 * Returns { entry, created } — `created` is false when the msg_id was
 * already stored (in which case only empty fields are filled in, so a
 * decrypted ciphertext message finally gets its media/body).
 */
async function upsertChatMessageSQLite(entry) {
  const db = await getSQLite();
  const ts = entry.ts || Date.now();
  const msgId = entry.msgId || "";

  if (msgId) {
    const existing = sqliteGet(db, `SELECT ${SELECT_COLS} FROM chat_messages WHERE msg_id = ? LIMIT 1`, [msgId]);
    if (existing) {
      const patch = buildEnrichmentPatch(sqliteRowToEntry(existing), entry);
      if (Object.keys(patch).length) {
        const sets = Object.keys(patch).map(k => `${COLUMN_FOR[k]} = ?`).join(", ");
        db.run(
          `UPDATE chat_messages SET ${sets} WHERE id = ?`,
          [...Object.values(patch), existing.id]
        );
        saveSQLiteDB(db);
        // Re-read rather than merging `patch` into the row: the row is keyed by
        // column name (media_url) while `patch` is keyed by field name (mediaUrl).
        const fresh = sqliteGet(db, `SELECT ${SELECT_COLS} FROM chat_messages WHERE id = ?`, [existing.id]);
        return { entry: sqliteRowToEntry(fresh), created: false };
      }
      return { entry: sqliteRowToEntry(existing), created: false };
    }
  }

  db.run(
    "INSERT INTO chat_messages (msg_id, sender, sender_id, body, type, media_url, ts, is_deleted, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      msgId,
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
  const idRes = db.exec("SELECT last_insert_rowid() AS id");
  const id    = idRes[0]?.values[0]?.[0] ?? 0;
  saveSQLiteDB(db);

  return {
    entry: {
      id,
      msgId,
      sender:    entry.sender    || "",
      senderId:  entry.senderId  || "",
      body:      entry.body      || "",
      type:      entry.type      || "",
      mediaUrl:  entry.mediaUrl  || null,
      ts,
      isDeleted: Boolean(entry.isDeleted),
      deletedAt: entry.deletedAt || null,
    },
    created: true,
  };
}

async function getRecentChatMessagesSQLite(limit) {
  const db  = await getSQLite();
  const lim = Math.max(1, limit || 1000);
  // Take the NEWEST `lim` rows, then present them oldest → newest.
  return sqliteAll(
    db,
    `SELECT ${SELECT_COLS} FROM (
       SELECT ${SELECT_COLS} FROM chat_messages ORDER BY ts DESC, id DESC LIMIT ?
     ) ORDER BY ts ASC, id ASC`,
    [lim]
  ).map(sqliteRowToEntry);
}

async function findChatMessageSQLite(msgId) {
  const db = await getSQLite();
  const row = sqliteGet(db, `SELECT ${SELECT_COLS} FROM chat_messages WHERE msg_id = ? LIMIT 1`, [msgId]);
  return row ? sqliteRowToEntry(row) : null;
}

async function revokeChatMessageSQLite(msgId) {
  const db        = await getSQLite();
  const deletedAt = Date.now();
  const existing  = sqliteGet(db, `SELECT ${SELECT_COLS} FROM chat_messages WHERE msg_id = ? LIMIT 1`, [msgId]);
  if (!existing) return null;

  db.run("UPDATE chat_messages SET is_deleted = 1, deleted_at = ? WHERE msg_id = ?", [deletedAt, msgId]);
  saveSQLiteDB(db);

  return sqliteRowToEntry({ ...existing, is_deleted: 1, deleted_at: deletedAt });
}

// ── MySQL ─────────────────────────────────────────────────────
let pool        = null;
let schemaReady = null;

async function initMySQL() {
  if (pool || mysqlFailed) return;
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
        deleted_at BIGINT       DEFAULT NULL,
        UNIQUE KEY uniq_msg_id (msg_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).then(() => {
      const alters = [
        "ALTER TABLE chat_messages ADD COLUMN msg_id VARCHAR(255) DEFAULT ''",
        "ALTER TABLE chat_messages ADD COLUMN is_deleted TINYINT(1) DEFAULT 0",
        "ALTER TABLE chat_messages ADD COLUMN deleted_at BIGINT DEFAULT NULL",
        "ALTER TABLE chat_messages ADD UNIQUE KEY uniq_msg_id (msg_id)",
      ];
      return Promise.all(alters.map(sql => pool.execute(sql).catch(() => {})));
    }).catch(err => {
      mysqlFailed = true;
      logger.warn(`MySQL unavailable, using SQLite fallback: ${err.message}`);
      pool        = null;
      schemaReady = null;
    });
  }
  await schemaReady;
}

async function upsertChatMessageMySQL(entry) {
  await initMySQL();
  if (!pool) throw new Error("MySQL pool unavailable");
  const ts    = entry.ts || Date.now();
  const msgId = entry.msgId || "";

  if (msgId) {
    const [rows] = await pool.execute(
      `SELECT ${SELECT_COLS} FROM chat_messages WHERE msg_id = ? LIMIT 1`, [msgId]
    );
    if (rows.length) {
      const patch = buildEnrichmentPatch(mysqlRowToEntry(rows[0]), entry);
      if (Object.keys(patch).length) {
        const sets = Object.keys(patch).map(k => `${COLUMN_FOR[k]} = ?`).join(", ");
        await pool.execute(
          `UPDATE chat_messages SET ${sets} WHERE id = ?`,
          [...Object.values(patch), rows[0].id]
        );
        const [fresh] = await pool.execute(
          `SELECT ${SELECT_COLS} FROM chat_messages WHERE id = ? LIMIT 1`, [rows[0].id]
        );
        return { entry: mysqlRowToEntry(fresh[0]), created: false };
      }
      return { entry: mysqlRowToEntry(rows[0]), created: false };
    }
  }

  const [result] = await pool.execute(
    "INSERT INTO chat_messages (msg_id, sender, sender_id, body, type, media_url, ts, is_deleted, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [msgId, entry.sender || "", entry.senderId || "",
     entry.body || "", entry.type || "", entry.mediaUrl || null,
     ts, entry.isDeleted ? 1 : 0, entry.deletedAt || null]
  );
  return {
    entry: {
      id:        Number(result.insertId),
      msgId,
      sender:    entry.sender || "",
      senderId:  entry.senderId || "",
      body:      entry.body || "",
      type:      entry.type || "",
      mediaUrl:  entry.mediaUrl || null,
      ts,
      isDeleted: Boolean(entry.isDeleted),
      deletedAt: entry.deletedAt || null,
    },
    created: true,
  };
}

function mysqlRowToEntry(r) {
  return {
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
  };
}

async function getRecentChatMessagesMySQL(limit) {
  await initMySQL();
  if (!pool) throw new Error("MySQL pool unavailable");
  const lim = Math.max(1, limit || 1000);
  const [rows] = await pool.execute(
    `SELECT ${SELECT_COLS} FROM (
       SELECT ${SELECT_COLS} FROM chat_messages ORDER BY ts DESC, id DESC LIMIT ?
     ) t ORDER BY ts ASC, id ASC`,
    [lim]
  );
  return rows.map(mysqlRowToEntry);
}

async function findChatMessageMySQL(msgId) {
  await initMySQL();
  if (!pool) throw new Error("MySQL pool unavailable");
  const [rows] = await pool.execute(
    `SELECT ${SELECT_COLS} FROM chat_messages WHERE msg_id = ? LIMIT 1`, [msgId]
  );
  return rows.length ? mysqlRowToEntry(rows[0]) : null;
}

async function revokeChatMessageMySQL(msgId) {
  await initMySQL();
  if (!pool) throw new Error("MySQL pool unavailable");
  const [rows] = await pool.execute(
    `SELECT ${SELECT_COLS} FROM chat_messages WHERE msg_id = ? LIMIT 1`, [msgId]
  );
  if (!rows.length) return null;

  const deletedAt = Date.now();
  await pool.execute(
    "UPDATE chat_messages SET is_deleted = 1, deleted_at = ? WHERE msg_id = ?",
    [deletedAt, msgId]
  );
  return { ...mysqlRowToEntry(rows[0]), isDeleted: true, deletedAt };
}

// ── field mapping for partial updates ─────────────────────────
const COLUMN_FOR = {
  body:     "body",
  type:     "type",
  mediaUrl: "media_url",
  sender:   "sender",
  senderId: "sender_id",
  ts:       "ts",
};

/**
 * Work out which fields of a re-delivered message should enrich an
 * already-stored row. We only ever fill gaps — a later event must never
 * clobber content we already hold (that is what would break anti-delete).
 */
function buildEnrichmentPatch(existing, incoming) {
  const patch = {};
  if (!existing.mediaUrl && incoming.mediaUrl)       patch.mediaUrl = incoming.mediaUrl;
  if (!existing.body     && incoming.body)           patch.body     = incoming.body;
  if (!existing.sender   && incoming.sender)         patch.sender   = incoming.sender;
  if (!existing.senderId && incoming.senderId)       patch.senderId = incoming.senderId;
  // ciphertext → decrypted message: same id, type only known after decryption
  if (incoming.type && (!existing.type || existing.type === "ciphertext") && incoming.type !== existing.type) {
    patch.type = incoming.type;
  }
  if (existing.isDeleted) delete patch.body; // never un-hide a deleted message
  return patch;
}

// ── Unified API ───────────────────────────────────────────────

async function upsertChatMessage(entry) {
  if (useMySQL && !mysqlFailed) {
    try {
      return await upsertChatMessageMySQL(entry);
    } catch (err) {
      useSQLiteFallback(err.message);
    }
  }
  return upsertChatMessageSQLite(entry);
}

async function getRecentChatMessages(limit) {
  if (useMySQL && !mysqlFailed) {
    try {
      return await getRecentChatMessagesMySQL(limit);
    } catch (err) {
      useSQLiteFallback(err.message);
    }
  }
  return getRecentChatMessagesSQLite(limit);
}

async function findChatMessage(msgId) {
  if (!msgId) return null;
  if (useMySQL && !mysqlFailed) {
    try {
      return await findChatMessageMySQL(msgId);
    } catch (err) {
      useSQLiteFallback(err.message);
    }
  }
  return findChatMessageSQLite(msgId);
}

async function revokeChatMessage(msgId) {
  if (!msgId) return null;
  if (useMySQL && !mysqlFailed) {
    try {
      return await revokeChatMessageMySQL(msgId);
    } catch (err) {
      useSQLiteFallback(err.message);
    }
  }
  return revokeChatMessageSQLite(msgId);
}

// Kept for backwards compatibility with earlier imports.
const saveChatMessage = upsertChatMessage;

module.exports = {
  upsertChatMessage,
  saveChatMessage,
  getRecentChatMessages,
  findChatMessage,
  revokeChatMessage,
};
