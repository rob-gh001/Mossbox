const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const storageDir = path.join(__dirname, '..', '..', 'storage');
const uploadsDir = path.join(storageDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const db = new Database(path.join(storageDir, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('note', 'todo')),
  content TEXT NOT NULL,
  is_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT,
  note TEXT,
  fetched_title TEXT,
  final_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monitor_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  http_server TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL DEFAULT '',
  interval_seconds REAL NOT NULL DEFAULT 5,
  reconnect_interval_seconds INTEGER NOT NULL DEFAULT 10,
  log_level INTEGER NOT NULL DEFAULT 0,
  disable_remote_control INTEGER NOT NULL DEFAULT 0,
  ignore_unsafe_cert INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'stopped',
  last_error TEXT NOT NULL DEFAULT '',
  last_started_at TEXT,
  last_stopped_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO monitor_settings (id) VALUES (1);
`);

module.exports = { db, storageDir, uploadsDir };
