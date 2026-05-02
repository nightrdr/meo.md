# Desktop - meo.md web app (MVP)

Vite + React + TypeScript + TipTap. Runs in the browser; intended to be
wrapped in Tauri 2.x post-MVP (no code changes needed - point Tauri at the
built `dist/`).

## Screens

### `/login`
- Email + account password → `POST /auth/login`.
- On success, prompt for **encryption passphrase + Secret Key** to unlock.
- If `has_account=false`, route to `/setup`.

### `/signup`
- Email + account password → `POST /auth/signup`.
- Generate Secret Key (16 random bytes, formatted), generate master key,
  prompt for encryption passphrase, derive unlock key, wrap master key,
  `PUT /account`.
- Display Secret Key prominently with "Save this now" warning. (No PDF
  generation in MVP - just on-screen display + clipboard copy.)

### `/app` (post-unlock, three-pane)
- **Left:** folder tree built by walking `note.folder` paths.
- **Middle:** note list filtered by selected folder; preview = first line
  of body. Sorted by `updated_at desc`.
- **Right:** TipTap editor. Markdown source is the canonical state.

## Editor
- TipTap with StarterKit (paragraph, heading, bold, italic, code, lists,
  blockquote, hr).
- Title is a separate input bound to `note.title`.
- Folder is a text input (slash-separated path, e.g. `Work/Q1`). Parsed
  into `string[]`.
- KaTeX / Mermaid / Prism deferred (additive extensions).

## Sync engine
- On unlock: `GET /sync/notes?since=<localCursor>` → decrypt each row →
  upsert into local IndexedDB cache → update cursor.
- On edit: debounce 500ms → `encryptNote()` → `POST /notes` → on success,
  update local cursor.
- Periodic poll: every 10s while focused.

## Local persistence
IndexedDB via `idb` library. Two stores:
- `meta` - `{ jwt, user_id, sync_cursor, account_wrapper }`
- `notes` - encrypted rows (so a re-mount doesn't need to re-fetch from
  server). Decrypted into in-memory state only.

## Crypto on desktop
- `master_key` lives in memory (`CryptoKey`, non-extractable).
- Lost on tab refresh - user re-enters passphrase + Secret Key.
- For MVP we do NOT persist the master key; "remember me" is a v1.5 feature
  that requires keychain integration.

## Out of MVP
- Tauri shell + native menubar
- Spotlight integration
- Biometric unlock
- Drag-and-drop folder reorganization
- Slash commands beyond TipTap defaults
- Wiki links `[[...]]`
- Export (MD/PDF/DOCX)
- Search (FTS5)
- Local LLM
