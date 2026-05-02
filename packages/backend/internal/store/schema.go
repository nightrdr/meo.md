package store

import "database/sql"

// schema mirrors packages/backend/src/db.ts exactly so the same
// meo.sqlite file is forward- and backward-compatible between the TS
// and Go servers. Adding a column? Add a migration here, don't edit
// these statements.
const schema = `
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
`

func migrate(db *sql.DB) error {
	_, err := db.Exec(schema)
	return err
}
