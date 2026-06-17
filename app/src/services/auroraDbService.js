const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.AURORA_DB_PATH || path.join(__dirname, '../../database/aurora.db');

let db = null;

function getDb() {
  if (!db) {
    db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA synchronous=NORMAL');
    db.run('PRAGMA cache_size=10000');
  }
  return db;
}

function initSchema() {
  return new Promise((resolve, reject) => {
    const d = getDb();
    d.serialize(() => {
      d.run(`CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        content_hash TEXT,
        kind TEXT NOT NULL,
        bytes INTEGER,
        width INTEGER,
        height INTEGER,
        duration_s REAL,
        taken_at INTEGER,
        gps_lat REAL,
        gps_lon REAL,
        place_id INTEGER REFERENCES places(id),
        camera TEXT,
        lens TEXT,
        fav INTEGER DEFAULT 0,
        mtime INTEGER NOT NULL,
        indexed_at INTEGER
      )`);

      d.run(`CREATE TABLE IF NOT EXISTS places (
        id INTEGER PRIMARY KEY,
        name TEXT,
        country TEXT,
        lat REAL,
        lon REAL
      )`);

      d.run(`CREATE TABLE IF NOT EXISTS faces (
        id INTEGER PRIMARY KEY,
        asset_id INTEGER REFERENCES assets(id),
        bbox TEXT,
        embedding BLOB,
        person_id INTEGER REFERENCES people(id)
      )`);

      d.run(`CREATE TABLE IF NOT EXISTS people (
        id INTEGER PRIMARY KEY,
        name TEXT,
        cover_face INTEGER
      )`);

      // ── Tags (user labels, many-to-many with assets) ──
      d.run(`CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL COLLATE NOCASE,
        created_at INTEGER
      )`);
      d.run(`CREATE TABLE IF NOT EXISTS asset_tags (
        asset_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        created_at INTEGER,
        PRIMARY KEY (asset_id, tag_id)
      )`);

      d.run(`CREATE TABLE IF NOT EXISTS import_sessions (
        id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT DEFAULT 'running',
        scanned INTEGER DEFAULT 0,
        indexed INTEGER DEFAULT 0,
        skipped INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0
      )`);

      // ── Lightweight migrations (SQLite has no ADD COLUMN IF NOT EXISTS) ──
      // Live Photos: the still carries live_video_id → its motion clip; the clip
      // is flagged is_live_motion=1 so it's hidden from the main grid/timeline.
      const addColumn = (sql) => d.run(sql, (err) => {
        if (err && !/duplicate column name/i.test(err.message)) reject(err);
      });
      addColumn(`ALTER TABLE assets ADD COLUMN live_video_id INTEGER`);
      addColumn(`ALTER TABLE assets ADD COLUMN is_live_motion INTEGER DEFAULT 0`);

      d.run(`CREATE INDEX IF NOT EXISTS idx_assets_taken ON assets(taken_at)`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_assets_place ON assets(place_id)`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind)`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_assets_fav ON assets(fav)`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_assets_live_motion ON assets(is_live_motion)`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id)`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_asset_tags_asset ON asset_tags(asset_id)`);

      // ── App settings (passcode, preferences) ──
      d.run(`CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )`);
      d.run(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('private_passcode', '0000')`);

      // ── Privacy + duplicate detection columns ──
      addColumn(`ALTER TABLE assets ADD COLUMN hidden INTEGER DEFAULT 0`);
      addColumn(`ALTER TABLE assets ADD COLUMN file_hash TEXT`);
      addColumn(`ALTER TABLE assets ADD COLUMN duplicate_of INTEGER`);

      d.run(`CREATE INDEX IF NOT EXISTS idx_assets_hidden ON assets(hidden)`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_assets_dup ON assets(duplicate_of)`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(file_hash)`);

      d.run(`CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(text, content='')`, (err) => {
        if (err && !err.message.includes('already exists')) reject(err);
        else resolve();
      });
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

module.exports = { getDb, initSchema, run, get, all, DB_PATH };
