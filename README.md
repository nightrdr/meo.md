# meo.md - working MVP

A privacy-first, end-to-end encrypted markdown notes app with multi-device sync.
This repo is a scoped MVP of the [full v1 spec](./meo-md-spec.docx) - see
[`specs/00-mvp-scope.md`](./specs/00-mvp-scope.md) for what is and isn't built.

## What works end-to-end

- **Signup** with email + account password
- **Encryption setup**: client-generated Secret Key (128-bit) + user-chosen
  passphrase derive a master key. Master key wrapped with AES-GCM and stored
  on the server (passphrase + Secret Key never leave the device).
- **Per-note encryption**: each note's blob is encrypted with a per-note key
  derived from the master key via HKDF.
- **Multi-device sync**: encrypted blobs sync via REST polling; new devices
  recover the master key from passphrase + Secret Key.
- **Folder hierarchy** (path-based, encrypted, zero schema)
- **Markdown editor** (TipTap on desktop, native TextInput on mobile)
- **Cross-platform interop**: notes encrypted on mobile decrypt on desktop
  and vice versa (verified by automated tests).
- **Server holds only ciphertext**: the SQLite blob is opaque to anyone with
  DB access - verified by inspecting the running database.

## Layout

```
packages/
├── shared/         # TypeScript crypto + API client (used by desktop)
├── backend/        # Node + Hono + better-sqlite3 + JWT
├── desktop/        # Vite + React + TipTap (web app; Tauri-ready)
└── mobile/         # Expo + React Native + Expo Router

specs/
├── 00-mvp-scope.md       # what's in / out of MVP
├── 01-shared-crypto.md   # shared package spec
├── 02-backend.md         # backend spec
├── 03-desktop.md         # desktop spec
└── 04-mobile.md          # mobile spec
```

## Quickstart

You need Node ≥ 20, npm, and Docker (for self-hosted Supabase). For mobile
you'll additionally need Xcode (iOS) or Android Studio + a device or
simulator. The desktop app runs in a normal browser or as a Tauri native window.

### 1. Install everything from the repo root

```bash
npm install                                 # installs shared + backend + desktop
(cd packages/shared && npm run build)       # build the shared TS package
cd packages/mobile && npm install --legacy-peer-deps && cd -
```

### 2. Bring up the data layer

The recommended path (matches the spec) is **self-hosted Supabase via the
Supabase CLI** - full Postgres + GoTrue + PostgREST + Realtime + Storage
locally in Docker.

```bash
# Install the Supabase CLI once (download the static binary):
curl -fsSL "https://github.com/supabase/cli/releases/latest/download/supabase_darwin_arm64.tar.gz" \
  | tar -xz -C "$HOME/.local/bin/"
# Or on macOS with brew/sudo: brew install supabase/tap/supabase

# Bring up the local Supabase stack (first run pulls ~2GB of images, ~5 min):
supabase start
# When done, supabase status prints the API URL + anon key. The schema is
# auto-applied from supabase/migrations/.

# Wire the desktop app to it - write a .env.local:
cd packages/desktop
KEY=$(supabase status | grep Publishable | awk '{print $4}')
cat > .env.local <<EOF
VITE_DATA_BACKEND=supabase
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=$KEY
EOF
cd -
```

**Fallback: legacy Hono + SQLite backend.** Used during the very first MVP;
endpoint shape is identical so the desktop client treats them as drop-in.
Useful if Docker is unavailable.

```bash
npm --workspace @meo/backend run dev        # → http://localhost:8787
# In packages/desktop/.env.local set: VITE_DATA_BACKEND=hono
```

### 3. Run the desktop app

There are two ways to run it. Both use the same React UI; the difference is
the shell.

**Option A: in a browser (fast iteration)**

```bash
npm --workspace @meo/desktop run dev        # → http://localhost:5173
```

Open http://localhost:5173.

**Option B: as a native window (Tauri 2.x)**

This is the production shell - a real macOS / Windows / Linux app window with
no browser chrome. Requires Rust via rustup (one-time setup):

```bash
# Install rustup once if you don't have it (Homebrew's cargo is not enough -
# Tauri's CLI specifically needs rustup to detect the target triple):
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
. "$HOME/.cargo/env"

# Start Vite (serves the UI on :5173) in one terminal:
npm --workspace @meo/desktop run dev

# Start Tauri in a second terminal - opens the native window:
npm --workspace @meo/desktop run tauri:dev

# To produce a distributable .app / .dmg / .msi / .deb / .AppImage:
npm --workspace @meo/desktop run tauri:build
# Output goes to packages/desktop/src-tauri/target/release/bundle/
```

The first `tauri dev` compile downloads + builds wry, tao, and the rest of
the Tauri runtime - expect 5–10 minutes. Subsequent runs are seconds.

In either mode: click "Create an account", set up encryption, and **save the
Secret Key** that's displayed - you'll need it to unlock from another device.
Refreshing / restarting logs you out (master key is in-memory only, by design).

### 4. Run the mobile app

The mobile app expects the backend at `http://localhost:8787`. If running on
a real device or simulator on a different machine, edit
`packages/mobile/app.json` → `expo.extra.apiUrl` to your LAN IP.

```bash
cd packages/mobile
npx expo start
# Press 'i' for iOS Simulator, 'a' for Android Emulator,
# or scan the QR code with Expo Go on a physical device.
```

## Tests

All tests are runnable from the repo root once `npm install` has been done.

```bash
# 1. Crypto unit tests (round-trip, wrong-passphrase rejection, HLC)
node packages/shared/test-crypto.mjs

# 2. Backend (Hono fallback) end-to-end - start backend on :8787 first
node packages/backend/test-e2e.mjs

# 3. Supabase end-to-end - supabase must be running
SUPABASE_ANON_KEY=$(supabase status | grep Publishable | awk '{print $4}') \
  node packages/shared/test-supabase-e2e.mjs

# 4. Cross-platform crypto interop (mobile ↔ desktop)
cd packages/mobile && node test-interop.mjs
```

Expected output: all four suites end with **"All ... tests passed."**

The Supabase suite covers the full stack: GoTrue signup/login, encryption
wrapper round-trip via PostgREST + RLS, encrypted note CRUD via the
`meo.upsert_note` RPC, stale-HLC rejection (409), tombstones, and
**cross-tenant isolation enforced by Postgres RLS** (not application-layer
checks).

## Crypto invariants the MVP enforces

1. The **encryption passphrase** never reaches the server. It is combined
   with the device-held Secret Key and a per-user salt to derive the unlock
   key via PBKDF2-SHA256 (600k iterations). The spec calls for Argon2id;
   PBKDF2 is the MVP substitute (see `specs/00-mvp-scope.md`).
2. The **master key** is wrapped at rest with AES-256-GCM under the unlock
   key, then sent to the server. Server stores only the wrapper.
3. **Per-note keys** are HKDF-derived from `(master_key, "note:" || note_id)`
   - compromise of one note's key cannot decrypt others.
4. Note plaintext (title, body, folder, tags, links) is JSON-serialized,
   AES-GCM-encrypted with the per-note key, and stored as an opaque blob.
5. **HLC timestamps** order writes; concurrent writes are last-write-wins by
   HLC (with a "Conflicted copy" fallback path planned per spec - not implemented in MVP UI).

## Verifying the privacy claim

After creating a note in the running app, peek at the SQLite file:

```bash
sqlite3 packages/backend/meo.sqlite \
  "SELECT id, length(encrypted_content) AS bytes, hex(substr(encrypted_content, 1, 32)) AS first32 FROM notes;"
```

You'll see the row id, ciphertext length, and the first 32 hex bytes -
which look uniformly random. The note's title and body are nowhere in
plaintext on the server.

## Design

The desktop UI follows the **Meo** design - a warm paper-minimal aesthetic
(see `design-mocks/`). Palette and typography:

- Surfaces: warm paper `#F6F2EA`, sidebar `#EFE9DD`, raised overlays `#FFFBF3`.
- Ink: primary `#1F1C17`, secondary `#4A443B`, muted `#8A8375`.
- Accent: mossy green `#4F6B3A` (single accent across selection, focus, brand dot).
- AI tint: rust `#B4632A` with `#F4E2CB` soft fill - used for the "Ask Meo"
  pill and AI affordances.
- Body: Source Serif 4 16/1.65. UI: Inter. Code/keys: JetBrains Mono.
- Logo: `MeoMark` - a filleted-square ink badge with a serif "M" notch and
  green accent dot.

Three-pane layout (sidebar 232px / list 300px / editor flex). Source of
truth: `design-mocks/components/{theme,desktop,icons}.jsx`. Dark mode swaps
the surface tokens automatically via `prefers-color-scheme`.

## What's wired up

| Feature | Desktop | Mobile |
|---|---|---|
| Auth (signup, login, encryption setup) | ✓ | ✓ |
| Supabase backend (Postgres + GoTrue + PostgREST + RLS) | ✓ | ✓ |
| Per-note AES-GCM E2EE | ✓ | ✓ |
| Folder tree + sub-folders + creation | ✓ | ✓ - `+` next to FOLDERS opens a bottom-sheet prompt; long-press a folder for New sub-folder / Rename / Delete |
| Tags (per-note + sidebar list) | ✓ | ✓ - per-note add/remove, sidebar tag chips, long-press for filter / remove-from-all |
| Contextual right-click / long-press menus | ✓ | ✓ - ActionSheet covers note / folder / tag, mirroring the desktop ContextMenu items |
| ⌘K / search overlay | ✓ | ✓ - full-screen modal, same notes/folders/tags ranking |
| Markdown editor toolbar (Edit/Split/Preview, headings, lists, etc.) | ✓ TipTap | basic - bottom toolbar with bold/italic/list/h1/checklist + Ask Meo (placeholder) |
| Three-pane (desktop) / drilldown navigation (mobile) | ✓ | ✓ - Meo design system, MeoMark, warm paper, serif body |
| Ask Meo panel (right drawer / bottom sheet) | ✓ wired to Ollama with full RAG (BM25 + vector + RRF + MMR + citations) | ✓ wired to Ollama with same RAG plumbing; default embedder is no-op so BM25 carries retrieval until phase 3.5 swaps in `transformers-rn` |
| Slash menu in editor | ✓ | not yet - keyboard-toolbar `/` button planned, lower priority than 3.5 |
| Local LLM via Ollama / llama.rn | ✓ Ollama | ✓ `llama.rn` shipped (Metal/Vulkan/OpenCL). GGUF model registry + downloads via HF Hub. Needs an iOS simulator or device for `expo run:ios` to actually launch. |
| BM25 + vector + RRF + MMR retrieval | ✓ | ✓ (BM25 + RRF; vector contributes nothing until phase 3.5 real embedder) |
| Local embeddings (bge-small-en-v1.5) | ✓ | runtime installed (`onnxruntime-react-native`); WordPiece tokenizer + ONNX file is the remaining wiring. `NoopEmbedder` default; BM25 carries retrieval. |
| Settings → AI screen (model install, embeddings status) | ✓ | ✓ - Local GGUF download (Wi-Fi + resumable + progress) + Apple Intelligence row on iOS 18+ + Embeddings progress |
| **Attachments** (E2EE images / files via iDrive S3 + MinIO local fallback) | ✓ - file picker, drag-and-drop, encrypted at rest, custom TipTap renderer | shared crypto pipeline ready; mobile file-picker UI is a small follow-up |

The architecture for the not-yet-mobile features is locked in
[`specs/05-llm-architecture.md`](specs/05-llm-architecture.md). Mobile
will not need any backend changes; the shared `packages/shared/src/ai/*`
modules are platform-agnostic except for the embedder runtime
(transformers.js → may move to native if perf is bad on RN).

## Production gaps

This is an MVP, not a release. Notable gaps versus the master spec:

- **Argon2id → PBKDF2** (computational, not memory-hard)
- **Native menubar, Spotlight, biometrics** - desktop runs in Tauri but
  shell-only; native integrations are deferred
- **TenTap** - mobile uses a plain monospace TextInput
- **No realtime / WebSocket** - polling every 10s instead
- **No attachments / streaming media**
- **No QR-pairing / Emergency Kit PDF** - manual passphrase + Secret Key
  re-entry is the only enrollment path
- **No SQLCipher** on the client (encrypted notes still encrypted in cache,
  but the surrounding metadata is plaintext-on-disk under OS encryption)
- **No local LLM, AI proxy, embeddings, or vector search**
- **No Paddle billing**
- **No password reset / email verification**
- **No tests for sync conflict resolution beyond stale-HLC rejection**

Each of these is purely additive - nothing here paints us into a corner.
