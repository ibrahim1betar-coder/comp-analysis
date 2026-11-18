import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);

// Performance pragmas: WAL lets readers (the dashboard) never block the collector's writes.
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -32000;
`);

db.exec(`
CREATE TABLE IF NOT EXISTS competitors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  color_slot  INTEGER NOT NULL DEFAULT 1,
  is_self     INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  competitor_id  INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  platform       TEXT NOT NULL,
  handle         TEXT NOT NULL,
  external_id    TEXT,
  display_name   TEXT,
  avatar_url     TEXT,
  profile_url    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  last_synced_at TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (platform, handle)
);
CREATE INDEX IF NOT EXISTS idx_accounts_competitor ON accounts(competitor_id);

CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  published_at  TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'post',
  url           TEXT,
  caption       TEXT,
  thumbnail_url TEXT,
  views         INTEGER,
  likes         INTEGER NOT NULL DEFAULT 0,
  comments      INTEGER NOT NULL DEFAULT 0,
  shares        INTEGER NOT NULL DEFAULT 0,
  saves         INTEGER NOT NULL DEFAULT 0,
  interactions  INTEGER GENERATED ALWAYS AS (likes + comments + shares + saves) STORED,
  fetched_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_account_published ON posts(account_id, published_at);
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at);
CREATE INDEX IF NOT EXISTS idx_posts_interactions ON posts(interactions);
CREATE INDEX IF NOT EXISTS idx_posts_views ON posts(views);

CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  captured_on  TEXT NOT NULL,
  followers    INTEGER,
  following    INTEGER,
  posts_count  INTEGER,
  total_views  INTEGER,
  total_likes  INTEGER,
  UNIQUE (account_id, captured_on)
);

-- Per-post counter history: one row per post per day (the last sync of the day wins).
-- "Activity in period" analysis = counters at the end of the period minus counters at its start.
CREATE TABLE IF NOT EXISTS post_snapshots (
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  captured_on TEXT NOT NULL,
  views       INTEGER,
  likes       INTEGER NOT NULL DEFAULT 0,
  comments    INTEGER NOT NULL DEFAULT 0,
  shares      INTEGER NOT NULL DEFAULT 0,
  saves       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, captured_on)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_post_snapshots_day ON post_snapshots(captured_on);

CREATE TABLE IF NOT EXISTS credentials (
  platform   TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  ok             INTEGER,
  message        TEXT,
  posts_upserted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// Backfill: posts collected before snapshots existed get one dated by their last fetch, so history starts there.
db.exec(`INSERT OR IGNORE INTO post_snapshots (post_id, captured_on, views, likes, comments, shares, saves)
         SELECT id, substr(fetched_at, 1, 10), views, likes, comments, shares, saves FROM posts
         WHERE NOT EXISTS (SELECT 1 FROM post_snapshots s WHERE s.post_id = posts.id)`);

const stmtCache = new Map();
/** Prepared statements are cached: preparing SQL is the slow part of SQLite calls. */
export function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

let depth = 0;
/** Run `fn` atomically. Nested calls become savepoints, so helpers can be composed inside a larger transaction. */
export function transaction(fn) {
  const nested = depth > 0;
  db.exec(nested ? `SAVEPOINT sp${depth}` : 'BEGIN');
  depth++;
  try {
    const result = fn();
    depth--;
    db.exec(nested ? `RELEASE sp${depth}` : 'COMMIT');
    return result;
  } catch (err) {
    depth--;
    db.exec(nested ? `ROLLBACK TO sp${depth}; RELEASE sp${depth}` : 'ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

export function getSetting(key, fallback = null) {
  const row = stmt('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(key, value) {
  stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
