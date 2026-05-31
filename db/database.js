// db/database.js
// Initializes and manages the SQLite database for ClipFlow

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'clipflow.db');

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL'); // Better concurrent performance
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  const database = db;

  // ── Profiles ─────────────────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      tiktok_account   TEXT,
      youtube_account  TEXT,
      instagram_account TEXT,
      tiktok_token     TEXT,   -- encrypted OAuth token
      youtube_token    TEXT,   -- encrypted OAuth token
      instagram_token  TEXT,   -- encrypted OAuth token
      tiktok_session   TEXT,   -- puppeteer session/cookies JSON
      youtube_session  TEXT,
      instagram_session TEXT,
      is_active   INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Sentences ─────────────────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS sentences (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Descriptions ──────────────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS descriptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Thumbnails ────────────────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS thumbnails (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      filename   TEXT NOT NULL,
      filepath   TEXT NOT NULL,
      label      TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Upload Jobs ───────────────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      original_file   TEXT NOT NULL,
      generated_file  TEXT,
      profile_id      TEXT,
      sentence_id     INTEGER,
      description_id  INTEGER,
      thumbnail_id    INTEGER,
      sentence_text   TEXT,
      description_text TEXT,
      thumbnail_path  TEXT,
      status          TEXT DEFAULT 'pending',  -- pending|processing|processed|posting|done|failed
      error_message   TEXT,
      tiktok_status   TEXT DEFAULT 'pending',  -- pending|success|failed
      youtube_status  TEXT DEFAULT 'pending',
      instagram_status TEXT DEFAULT 'pending',
      tiktok_post_id  TEXT,
      youtube_post_id TEXT,
      instagram_post_id TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(profile_id) REFERENCES profiles(id)
    );
  `);

  // ── Logs ──────────────────────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id     TEXT,
      level      TEXT NOT NULL,   -- info|warn|error|success
      platform   TEXT,            -- tiktok|youtube|instagram|system
      message    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed default sentences if empty
  const sentenceCount = database.prepare('SELECT COUNT(*) as c FROM sentences').get();
  if (sentenceCount.c === 0) {
    const seedSentences = [
      'The best investment you can make is in yourself.',
      'Small steps every day lead to massive results.',
      'Your future is created by what you do today.',
      'Stop waiting. Start creating.',
      'Success is built on consistent action.',
      'Be so good they can\'t ignore you.',
      'The grind never stops.',
      'Discipline is the bridge between goals and accomplishment.',
      'Every expert was once a beginner.',
      'Work in silence. Let success make the noise.',
    ];
    const insert = database.prepare('INSERT INTO sentences (text) VALUES (?)');
    seedSentences.forEach(s => insert.run(s));
  }

  // Seed default descriptions if empty
  const descCount = database.prepare('SELECT COUNT(*) as c FROM descriptions').get();
  if (descCount.c === 0) {
    const seedDescs = [
      '🔥 Drop a comment if this hit different! #viral #trending #motivation',
      '💡 Save this for when you need it most. #mindset #growth #success',
      '🚀 This is your sign to level up. #hustle #entrepreneur #winning',
      '⚡ Tag someone who needs to see this! #inspire #goals #grind',
      '🎯 Follow for more daily motivation. #dailymotivation #positivevibes',
    ];
    const insertD = database.prepare('INSERT INTO descriptions (text) VALUES (?)');
    seedDescs.forEach(d => insertD.run(d));
  }

  console.log('✅ Database schema initialized');
}

// ── Helper query functions ─────────────────────────────────────────────────

function getRandom(table) {
  const database = getDb();
  return database.prepare(`SELECT * FROM ${table} ORDER BY RANDOM() LIMIT 1`).get();
}

function addLog(jobId, level, message, platform = 'system') {
  const database = getDb();
  database.prepare(`
    INSERT INTO logs (job_id, level, platform, message) VALUES (?, ?, ?, ?)
  `).run(jobId, level, platform, message);
}

function updateJob(id, fields) {
  const database = getDb();
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(fields), new Date().toISOString(), id];
  database.prepare(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`).run(...values);
}

module.exports = { getDb, getRandom, addLog, updateJob };
