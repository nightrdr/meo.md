# meo.md MVP scope (derived from spec v1.0)

The master spec is a 14-week build. This MVP captures the core architecture
in a form that can be wired up and demonstrated end-to-end. It is **not**
production-ready and skips features explicitly listed below.

## In MVP
- E2E encrypted notes (AES-256-GCM, key hierarchy from passphrase + Secret Key)
- Multi-device sync via REST polling
- Markdown editor on desktop (TipTap)
- Markdown editor on mobile (plain TextInput-based for MVP)
- Per-user JWT auth, RLS-equivalent enforcement at API layer
- SQLite persistence on backend (encrypted blobs, monotonic version, HLC)
- Folder paths embedded in the encrypted blob (per spec §3.4)
- Last-write-wins conflict resolution by HLC

## Cut from MVP (and why)
- **Rust core via uniffi-rs** → Replaced with TypeScript shared package. A
  Rust + uniffi build would consume the entire session; the crypto and sync
  logic is straightforward in TS using Web Crypto API. Migration path: extract
  to Rust once the API surface stabilizes.
- **Argon2id** → PBKDF2-SHA256 (600k iterations). Argon2 in browser/RN
  requires WASM bundling that adds friction; PBKDF2 is built into
  WebCrypto on every platform. Same key hierarchy, same output size,
  weaker memory-hardness. Swap-in is a one-file change in `shared/crypto.ts`.
- **Tauri shell** → Vite web app. Same React + TipTap UI; Tauri can wrap it
  later by pointing `tauri.conf.json` at the built `dist/`.
- **TenTap on mobile** → plain RN TextInput for markdown source. TenTap's
  WebView+TipTap bridge is heavy and the reading experience can come later.
- **Local LLM (llama.cpp)**, **AI proxy**, **embeddings**, **vector search** →
  Out of scope. Architecture is unaffected; these are additive features.
- **Paddle billing** → Out of scope. Endpoints exist as no-ops.
- **Realtime WebSocket** → Polling only. Spec allows polling as one of two
  mechanisms; WebSocket is additive.
- **SQLCipher** → Plain SQLite on backend (notes already E2EE). On client,
  ciphertext is held in memory + IndexedDB/AsyncStorage; OS disk encryption
  is the at-rest guarantee for the MVP.
- **Streaming media / attachments** → Out of scope.
- **QR pairing / Emergency Kit PDF** → Out of scope. Manual passphrase + Secret Key
  re-entry is the only enrollment path.

## Non-negotiable invariants preserved
1. **Server never sees plaintext.** All note content (title, body, folder, tags)
   is in the encrypted blob.
2. **Encryption passphrase + Secret Key never leave the device.**
3. **Master key is wrapped at rest**, decrypted only with passphrase + Secret Key.
4. **Per-note keys** derived via HKDF from master key + note id.
5. **Account password (server-known) is distinct** from encryption passphrase
   (client-only).
