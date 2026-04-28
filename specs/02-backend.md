# Backend — meo.md API (MVP)

Node + Hono + better-sqlite3. Single process, single SQLite file. Replaces
the self-hosted Supabase stack for MVP; same endpoint shape so a swap to
Supabase is mechanical.

Default port: 8787. Configurable via `PORT` env.

## Schema (SQLite)

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,        -- uuid
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,          -- scrypt(password)
  created_at   INTEGER NOT NULL
);

CREATE TABLE accounts (
  user_id              TEXT PRIMARY KEY REFERENCES users(id),
  salt                 BLOB NOT NULL,
  encrypted_master_key BLOB NOT NULL,
  master_key_nonce     BLOB NOT NULL,
  kdf_params           TEXT NOT NULL,   -- json
  created_at           INTEGER NOT NULL
);

CREATE TABLE notes (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  encrypted_content BLOB NOT NULL,
  nonce             BLOB NOT NULL,
  version           INTEGER NOT NULL,
  hlc_timestamp     TEXT NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  size_bytes        INTEGER
);
CREATE INDEX idx_notes_user_version ON notes(user_id, version);

CREATE TABLE sync_cursor (
  user_id    TEXT PRIMARY KEY,
  next_version INTEGER NOT NULL DEFAULT 1
);
```

`version` is monotonic per user — we increment `sync_cursor.next_version`
under a transaction on each upsert. Clients pass `?since=<version>` to get
all updates strictly greater than their cursor.

## Endpoints

All bodies JSON unless noted. Auth via `Authorization: Bearer <jwt>`.

### `POST /auth/signup`
Body: `{ email, password }` → `{ user_id }`. 409 if email exists.

### `POST /auth/login`
Body: `{ email, password }` → `{ jwt, has_account: bool }`.

### `GET /account`
→ `AccountWrapper` (or 404 if not yet set up).

### `PUT /account`
Body: `AccountWrapper`. Idempotent on first write; 409 if already set
(passphrase rotation needs a different endpoint, out of MVP scope).

### `GET /sync/notes?since=<version>`
→ `{ notes: EncryptedNoteRow[], cursor: number }`. Includes tombstoned
notes (those with `deleted_at` set).

### `POST /notes`
Body: `EncryptedNoteRow` (id, ciphertext, nonce, hlc, etc.). Server
assigns `version`. Last-write-wins by HLC: if existing row's HLC > incoming,
returns 409 with current row; client merges by creating a "Conflicted copy"
note (per spec §2.4).

### `DELETE /notes/:id`
Tombstones. Server sets `deleted_at`, increments version.

### `GET /healthz`
→ `{ ok: true }`.

## Auth
- Password hash: `scrypt` (built into Node's `crypto`).
- JWT: HS256, secret from `JWT_SECRET` env (random fallback for dev).
- Token lifetime: 30 days for MVP.

## RLS-equivalent
Every query filters by `user_id = jwt.sub`. There is no admin endpoint.

## Out of MVP
- Realtime / WebSocket (`/sync/realtime`) — polling only.
- AI proxy (separate service in spec §2.5).
- Paddle billing (`/billing/*`).
- Attachments (`/attachments/*`).
- Device enrollment (`/devices/*`, QR pairing).
- Email verification, password reset.
