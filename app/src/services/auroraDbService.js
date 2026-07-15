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

      // ── One-shot cleanup: drop the old "Detected content" feature ───────
      // The COCO-SSD object-label store used to live here. AI captions
      // (asset_captions, captions_fts) do the same job with much better recall,
      // so the whole feature was removed 2026-07-15. Left in as a migration so
      // existing DBs shed the tables + column on the next startup — fresh
      // installs skip the DROPs (IF EXISTS) and never see them at all.
      d.run(`DROP INDEX IF EXISTS idx_asset_labels_label`);
      d.run(`DROP INDEX IF EXISTS idx_asset_labels_asset`);
      d.run(`DROP INDEX IF EXISTS idx_assets_labeled`);
      d.run(`DROP TABLE IF EXISTS asset_labels`);
      d.run(`DROP TABLE IF EXISTS labels`);
      // ALTER DROP COLUMN needs SQLite 3.35+ (we ship 3.44). Wrap in the
      // shared addColumn's error-swallowing pattern in case the column was
      // already gone.
      d.run(`ALTER TABLE assets DROP COLUMN labeled_at`, (err) => {
        if (err && !/no such column/i.test(err.message)) reject(err);
      });

      // ── Natural-language captions (for "girl holding a coffee" style search) ──
      // A vision-LLM (Ollama, typically on a networked machine) generates one short
      // factual caption per photo and pushes it via POST /api/aurora/captions/ingest.
      // Stored SEPARATELY from user `tags` so place/tag search stay untouched. The
      // raw caption text is preserved verbatim so a later pass can embed it for
      // semantic vector search without re-captioning.
      d.run(`CREATE TABLE IF NOT EXISTS asset_captions (
        asset_id INTEGER PRIMARY KEY,
        caption TEXT,
        model TEXT,
        captioned_at INTEGER
      )`);
      // Standalone FTS5 index over captions (rowid = asset_id), kept in sync on every
      // ingest (DELETE+INSERT — FTS5 has no UPSERT). NOT the active search path yet:
      // free-text search matches captions via LIKE in tokenClause so it compounds with
      // chips / strict / fuzzy for free. This index is maintained anyway so a later
      // bm25 relevance upgrade needs no backfill — and it confirms FTS5 is compiled in.
      d.run(`CREATE VIRTUAL TABLE IF NOT EXISTS captions_fts USING fts5(caption)`);
      // Deduplicated term dictionary over captions_fts (read-only, always live — it
      // reads the FTS index directly). Used by the search vocabulary / fuzzy spell-
      // correction so it scales with the number of distinct words, not the number of
      // captions — no need to load & re-tokenise 100k captions on the fallback path.
      d.run(`CREATE VIRTUAL TABLE IF NOT EXISTS captions_vocab USING fts5vocab('captions_fts', 'row')`);
      // captioned_at on assets is the resumable "pending" cursor (NULL = no caption yet),
      // mirroring labeled_at. Lets /captions/pending use an index without a join.
      addColumn(`ALTER TABLE assets ADD COLUMN captioned_at INTEGER`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_assets_captioned ON assets(captioned_at)`);

      d.run(`CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(text, content='')`);

      // ── RBAC: users, roles, sessions, audit log ─────────────────────────
      // Auth is bolted on top of an existing single-tenant DB, so all four
      // tables are created idempotently and never touch the photo schema. A
      // fresh install has zero rows in `users` — the app treats that as the
      // "claim admin" state and shows the setup screen to the first visitor.
      d.run(`CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL COLLATE NOCASE,
        is_builtin INTEGER DEFAULT 0,
        permissions TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER
      )`);
      d.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        pin_hash TEXT NOT NULL,
        pin_salt TEXT NOT NULL,
        role_id INTEGER NOT NULL REFERENCES roles(id),
        disabled INTEGER DEFAULT 0,
        created_at INTEGER,
        last_seen_at INTEGER,
        failed_attempts INTEGER DEFAULT 0,
        locked_until INTEGER DEFAULT 0
      )`);
      d.run(`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        user_agent TEXT
      )`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at)`);
      d.run(`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        target TEXT,
        details TEXT
      )`, (err) => {
        if (err && !err.message.includes('already exists')) reject(err);
        else resolve();
      });
      d.run(`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)`);
      d.run(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)`);
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
