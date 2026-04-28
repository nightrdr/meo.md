import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.MEO_DB_PATH ?? path.join(__dirname, '..', 'meo.sqlite');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  salt BLOB NOT NULL,
  encrypted_master_key BLOB NOT NULL,
  master_key_nonce BLOB NOT NULL,
  kdf_params TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  encrypted_content BLOB NOT NULL,
  nonce BLOB NOT NULL,
  version INTEGER NOT NULL,
  hlc_timestamp TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  size_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notes_user_version ON notes(user_id, version);

CREATE TABLE IF NOT EXISTS sync_cursor (
  user_id TEXT PRIMARY KEY,
  next_version INTEGER NOT NULL DEFAULT 1
);
`);

export function nextVersionFor(userId: string): number {
  const row = db.prepare('SELECT next_version FROM sync_cursor WHERE user_id = ?').get(userId) as { next_version: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO sync_cursor (user_id, next_version) VALUES (?, 2)').run(userId);
    return 1;
  }
  const v = row.next_version;
  db.prepare('UPDATE sync_cursor SET next_version = ? WHERE user_id = ?').run(v + 1, userId);
  return v;
}
