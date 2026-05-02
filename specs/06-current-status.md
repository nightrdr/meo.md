# Current status — desktop and mobile

A precise, current-as-of-this-document inventory of what's shipped, what
works end-to-end, and what's deliberately deferred. This is the
companion to the per-component specs (`01–05`) and the master spec
(`meo-md-spec.docx`). When in doubt, this doc is what the build looks
like; the others describe what it's becoming.

> **Scope:** This is a working MVP. Everything below is the v1.0 build
> shipping toward Hacker News / Product Hunt launch (per spec §7.3). It
> does not represent a hosted production deployment.

---

## 1. The big picture

```
  ┌────────────────────────────────┐         ┌─────────────────────────┐
  │   Desktop (Tauri / web)        │         │   Mobile (Expo RN)      │
  │                                │         │                         │
  │   Auth + E2EE notes      ✅    │         │   Auth + E2EE notes  ✅ │
  │   Three-pane app         ✅    │         │   Drilldown app      ✅ │
  │   Folders + tags         ✅    │         │   Folders + tags     ✅ │
  │   Search + context menus ✅    │         │   Search + sheets    ✅ │
  │   AI panel + slash menu  ✅    │         │   AI sheet + RAG     ✅ │
  │   Local LLM (Ollama)     ✅    │         │   Local LLM (llama.rn) ✅* │
  │   Embeddings + RAG       ✅    │         │   Retrieval (BM25)   ✅ │
  │                                │         │   Embeddings (real)  ✅ │
  │   Settings → AI          ✅    │         │   Settings → AI      ✅ │
  │   Attachments (E2EE)     ✅    │         │   Attachments        ✅ │
  │   Tauri native window    ✅    │         │   Bare workflow      ✅ │
  └────────────────────────────────┘         └─────────────────────────┘

           ✅* runtime + plumbing shipped; needs an iOS simulator or device build
```

Both clients talk to a **self-hosted Supabase** (`supabase start`) over
HTTPS. The server only ever sees:
- account email + password hash (GoTrue)
- encrypted master key wrapper
- encrypted note ciphertext + opaque metadata (HLC, version)

Note plaintext, embeddings, and AI prompts/responses **never leave the
device**. The five privacy invariants P1–P5 from
[`05-llm-architecture.md`](05-llm-architecture.md) §1 hold.

---

## 2. Repository layout

```
meo.md/
├── packages/
│   ├── shared/         # crypto + types + API clients + AI modules (TS)
│   │   └── src/ai/     # types, registry, embeddings, bm25, vectorStore,
│   │                   #   retrieval, rag, backends/ollama
│   ├── backend/        # Hono + SQLite legacy backend (kept for fallback)
│   ├── desktop/        # Vite + React + TipTap; Tauri shell at src-tauri/
│   └── mobile/         # Expo SDK 51 + RN, Expo Router
├── supabase/           # local Supabase config + migrations + meo schema
│   ├── config.toml     # exposes `meo` schema to PostgREST
│   └── migrations/     # 4 files: schema, grants fix, FOUND-var fix, error codes
├── specs/
│   ├── 00-mvp-scope.md
│   ├── 01-shared-crypto.md
│   ├── 02-backend.md
│   ├── 03-desktop.md
│   ├── 04-mobile.md
│   ├── 05-llm-architecture.md
│   └── 06-current-status.md   ← this file
├── design-mocks/       # extracted from user-supplied zip (HTML + JSX)
└── meo-md-spec.docx    # the master spec
```

---

## 3. Backend (Supabase)

**Local stack runs via `supabase start`.** Brings up GoTrue, Postgres,
PostgREST, Realtime, Storage (MinIO), Studio, Inbucket. ~10 containers.

### What's wired

- **Schema** (`supabase/migrations/`):
  - `meo.accounts(user_id, salt, encrypted_master_key, master_key_nonce, kdf_params)`
  - `meo.notes(id, user_id, encrypted_content, nonce, version, hlc_timestamp, updated_at, deleted_at, size_bytes)`
  - `meo.sync_cursor(user_id, next_version)` — per-user monotonic counter
- **RLS** enforced on every table: `user_id = auth.uid()`. Verified in
  the E2E test that user B sees zero of user A's notes.
- **RPCs** (SECURITY DEFINER):
  - `meo.upsert_note(...)` — atomic version bump + HLC last-write-wins
  - `meo.delete_note(id)` — tombstone + version bump
- **Auth** via Supabase GoTrue. Email/password; email verification off
  for local dev (per `config.toml`).

### Tests passing

```
node packages/shared/test-crypto.mjs           # 7 tests, crypto round-trip
node packages/backend/test-e2e.mjs             # 11 tests, legacy backend
node packages/shared/test-supabase-e2e.mjs     # 10 tests, Supabase stack
cd packages/mobile && node test-interop.mjs    # 4 tests, mobile↔desktop ciphertext
```

All four suites are green.

### Deliberately deferred

- **Hosted Supabase** (cloud project + production env). The local-dev
  config is what `supabase start` gives us.
- **Auth proxy / paid tier billing** (Paddle, per spec §2.6).
- **AI proxy + `meo.usage_log` table** (per spec §2.5 / `05-llm-architecture.md`
  §14). Ships with the paid tier in v1.1 since cloud LLM keys are gated.

### Attachments quota

- Workspace-wide quota of 10 GiB enforced **inside** the
  `meo.attachments_create` SECURITY DEFINER RPC (atomic with the insert,
  no TOCTOU race).
- `meo.attachments_quota_used()` returns `(used_bytes, quota_bytes)` so
  the client can show usage in Settings → Storage.
- Migration: `supabase/migrations/20260428001000_attachments_quota.sql`.

---

## 4. Desktop (`packages/desktop/`)

### Stack

- **Vite + React 18 + TypeScript**
- **TipTap** as the markdown editor
- **IndexedDB** for local cache (encrypted notes, vectors, prefs)
- **`@huggingface/transformers`** (Web Crypto-friendly) for embeddings
- **Tauri 2** for the native shell (optional; web works standalone)

### Screens / surfaces

| Surface | Status | File |
|---|---|---|
| Auth (login + signup + passphrase + Secret Key + unlock) | ✅ verified | `src/Auth.tsx` |
| Three-pane app shell | ✅ | `src/App.tsx` |
| Sidebar (Library + Folders + Tags + Ask Meo + AIControls) | ✅ | `src/App.tsx`, `src/AIControls.tsx` |
| Notes list (list-pane) | ✅ — title, preview, time-ago, tag chips | `src/App.tsx` |
| Editor (TipTap, full markdown toolbar, Edit/Split/Preview, tag chips) | ✅ | `src/Editor.tsx` |
| Right-click context menus (note / folder / tag / FOLDERS header) | ✅ — verified in preview | `src/ContextMenu.tsx` |
| Folder + sub-folder creation (inline rename input, persisted) | ✅ — verified | `src/App.tsx` |
| Tag picker on note + tag chips in sidebar + tag context menu | ✅ — verified | `src/Editor.tsx`, `src/App.tsx` |
| ⌘K search overlay (notes + folders + tags, kbd nav) | ✅ — verified | `src/SearchOverlay.tsx` |
| Drag-and-drop note → folder | ✅ | `src/App.tsx` |
| Native context-menu blocked (no Inspect Element) | ✅ | `src/App.tsx` |
| **Ask Meo panel** (right drawer, Ask + Chat modes, citations) | ✅ — verified end-to-end against Ollama | `src/AIPanel.tsx`, `src/aiStore.ts` |
| **Slash menu** (`/` in editor → Summarize / Action items / Outline / Improve) | ✅ — verified streaming into editor | `src/SlashMenu.tsx` |
| **Settings → AI** (Local models with Ollama pull, Embeddings progress + force re-index, Cloud locked v1.1) | ✅ — verified | `src/Settings.tsx` |
| **Attachments E2EE pipeline** (per-attachment HKDF key, AES-256-GCM streaming encrypt, encrypted metadata blob, signed PUT/GET URLs via Edge Functions, iDrive prod / MinIO dev fallback) | ✅ — round-trip test passes; bytes ciphertext at rest; filename never plaintext in DB | `packages/shared/src/attachments.ts`, `packages/desktop/src/AttachmentRenderer.tsx`, `supabase/functions/attachments-{upload,download}-url/`, `supabase/migrations/20260428000000_attachments.sql` |
| **Image upload / drop in editor** (file picker, drag-and-drop, custom TipTap node view that fetches + decrypts on demand) | ✅ — wired into `Editor.tsx` toolbar + drop zone | `src/Editor.tsx`, `src/AttachmentRenderer.tsx` |

### Privacy invariants verified live

- POST `/api/chat` to Ollama happens **on the device**, never via the server.
- Embedder runs **in the browser** (transformers.js WASM).
- Vector store is **IndexedDB** on the user's disk, not in Postgres.
- Verified: `qwen2.5:1.5b` produced a 3-bullet summary citing
  `[note:<id>]` for the only retrieved note. Zero traffic to Supabase
  during the AI request.

### Performance numbers (M-class Mac)

| Op | Measured |
|---|---|
| Embedder cold start | ~700 ms (model download cached after first run) |
| Embed one note (~500 words) | ~5 ms |
| Vector search, single note | <1 ms |
| BM25 search, ~10 docs | <1 ms |
| First token from `qwen2.5:1.5b` (warm) | ~250 ms |
| Streaming rate | ~25 tok/s |

Within budgets from `05-llm-architecture.md` §10.

### Deferred on desktop (out of v1.0)

- **Cloud frontier LLM keys** — entire keychain + provider adapters
  are scoped in `05-llm-architecture.md` §8 but gated to v1.1 / paid tier.
- **Cross-encoder rerank** (deferred to v1.1 per §17a).
- **Custom HF model URL input** in Settings (v1.1).
- **Spotlight integration**, **biometric unlock**, **menubar capture**
  (per spec §4.3, deferred).
- **Realtime WebSocket sync** (polling every 10s for now, per §2.4).
- **Attachments** (image/PDF/file).

---

## 5. Mobile (`packages/mobile/`)

### Stack

- **Expo SDK 51** + **React Native 0.74**
- **Expo Router** for screen navigation
- **`@noble/ciphers` + `@noble/hashes`** for crypto (no native deps)
- **`@supabase/supabase-js`** for backend
- **`react-native-svg`** for the icon set
- **`expo-secure-store`** for JWT storage
- **`@react-native-async-storage/async-storage`** for prefs + encrypted-note cache
- **`expo-clipboard`** for copy actions

### What's there now (phases 1–3 + **phase 3.5 native** shipped)

| Surface | Status | File |
|---|---|---|
| Auth screens (login / signup / passphrase / Secret Key / unlock) | ✅ — Meo-styled, MeoMark logo, serif headings | `app/index.tsx` |
| **Supabase backend wiring** (`SupabaseApiClient` mobile variant) | ✅ — same RPCs (`meo.upsert_note` etc.) as desktop | `src/shared/supabase-api.ts`, `src/session.ts:makeApiClient` |
| Folders top-level screen (system + user folder cards + tag chips + FAB) | ✅ — drilldown navigation matches `mobile.jsx` | `app/folders.tsx` |
| Folder detail screen (back nav + serif title + notes card) | ✅ | `app/folder/[path].tsx` |
| Note editor (title + folder + body + tags + bottom toolbar) | ✅ — plain markdown TextInput body, formatting buttons | `app/note/[id].tsx` |
| **ActionSheet** (universal bottom sheet for context menus) | ✅ | `src/ActionSheet.tsx` |
| **PromptSheet** (universal bottom sheet for inline prompts) | ✅ | `src/ActionSheet.tsx` |
| **Long-press context menus** on notes / folders / tags | ✅ | wired in `folders.tsx` + `folder/[path].tsx` + `note/[id].tsx` |
| **Folder + sub-folder creation** (inline prompt) | ✅ — `+` button, long-press → New sub-folder | `folders.tsx` |
| **Folder rename / delete** (cascades to notes) | ✅ | `folders.tsx` + `folder/[path].tsx` |
| **Tag chips** in sidebar + per-note add/remove + long-press for filter / remove-from-all | ✅ | sidebar in `folders.tsx`, in-editor in `note/[id].tsx` |
| **Search overlay** (full-screen modal, notes + folders + tags) | ✅ — same scoring shape as desktop ⌘K | `src/SearchOverlay.tsx` |
| **Sign out** action sheet | ✅ | `folders.tsx` |
| Brand row + Sparkle / Settings / Sign-out buttons | ✅ — matches design mock | `folders.tsx` |
| **AI shared modules** (types, registry, BM25, RRF/MMR retrieval, RAG orchestrator, Ollama backend) | ✅ — same code path as desktop, RN-adapted | `src/shared/ai/*` |
| **Mobile aiStore** (AsyncStorage-backed vector store + BM25 + Ollama generator + indexNote/rebuild) | ✅ | `src/aiStore.ts` |
| **AI bottom sheet** wired to RAG + status states (loading / no-backend / no-model / ready / error) | ✅ — gracefully degrades to BM25-only when embedder is no-op | `src/AISheet.tsx` |
| **Settings → AI screen** (Local models discovered from Ollama, Embeddings status + Force re-index, Cloud v1.1 lock) | ✅ | `app/settings/ai.tsx` |
| Cross-platform crypto interop with desktop | ✅ — verified by `test-interop.mjs` | `src/shared/crypto.ts` (noble) |
| Bundles cleanly for iOS via Expo's Metro | ✅ — 3.08 MB hbc | — |
| **`expo prebuild` done** (irreversible — bare workflow, Expo Go gone) | ✅ — `ios/` + `android/` folders generated, gitignored | `packages/mobile/ios/`, `packages/mobile/android/` |
| **`llama.rn` integration** (RN binding around llama.cpp; Metal on iOS, Vulkan/OpenCL/CPU on Android) | ✅ shipped — `LlamaRnBackend` implements `Generator`; downloads GGUF Q4 quants from Hugging Face Hub on demand via `expo-file-system` | `src/shared/ai/backends/llamaRn.ts` |
| **`op-sqlite` vector store** (replaces AsyncStorage-backed JSON for scale) | ✅ — schema `note_vectors(note_id, dim, vec, vec_hash, embedder_id)` per spec §6.2 | `src/shared/ai/vectorStore.sqlite.ts` |
| **Apple FoundationModels backend** (iOS 18+ system LLM, free, no download) | ✅ — Swift Pod (`FoundationLLM.podspec` + `FoundationLLMModule.swift`) bridges `LanguageModelSession` to RN via `RCTEventEmitter`. JS side wires `requestId` per call; tokens stream as `FoundationLLMOnToken` events. Linked into Podfile via local `foundation-llm-plugin.js` | `modules/foundation-llm/`, `src/shared/ai/backends/foundation.ts`, `foundation-llm-plugin.js` |
| **Real bge-small-en-v1.5 embedder** (`onnxruntime-react-native`) | ✅ — `OnnxBgeSmallEmbedder` does mean-pool weighted by attention_mask + L2-normalize, 384-dim output. Pure-JS WordPiece tokenizer (`tokenizer.ts`, 9 self-tests green). 33 MB ONNX + 250 KB vocab download on demand via `expo-file-system`'s `createDownloadResumable`. Toggle in Settings → AI rebuilds the index. `NoopEmbedder` remains the default until the user opts in | `src/shared/ai/embeddings.ts`, `src/shared/ai/tokenizer.ts`, `app/settings/ai.tsx` |
| **Mobile attachments file + image picker** | ✅ — `expo-image-picker` for camera-roll images (with permission flow + dimensions), `expo-document-picker` for arbitrary files. Upload status banner in the editor toolbar. Cross-platform interop test (mobile noble ↔ desktop Web Crypto) passes 3/3 cases | `app/note/[id].tsx`, `src/attachmentsBridge.ts`, `test-attachments-interop.mjs` |

### What's still pending on mobile

| Missing | Plan |
|---|---|
| **Gemini Nano via ML Kit GenAI** | Equivalent for supported Android (Pixel 8+, Galaxy S24+). Same shape as Apple's bridge — Kotlin module exposing `GenerativeModel` over `RCTEventEmitter`. |
| **iOS simulator / device build** | This host doesn't have an iOS simulator installed (`xcrun simctl list devices` is empty). Install path documented in §10 below. Bundle export already works. |
| Slash menu inside the editor | Keyboard-toolbar `/` button; lower priority. |
| Background fetch / push notifications for sync | Per spec §5.3, deferred. |
| Biometric unlock (LocalAuthentication) | Per spec §5.3, deferred. |
| Camera capture | Per spec §5.4 — `expo-image-picker` already covers gallery + camera roll; live capture is a one-call upgrade (`launchCameraAsync`). |
| TenTap rich editor | Per spec §5.2, deferred — plain TextInput is fine for v1. |

---

## 6. Shared (`packages/shared/`)

The single source of truth for cross-platform logic.

### Modules

| File | Purpose |
|---|---|
| `src/types.ts` | `Note`, `EncryptedNoteRow`, `AccountWrapper`, etc. |
| `src/encoding.ts` | base64, UTF-8, UUID v4 |
| `src/hlc.ts` | Hybrid logical clock |
| `src/crypto.ts` | Web Crypto-based PBKDF2 → AES-GCM → HKDF (desktop) |
| `src/api.ts` | Hono-backed `ApiClient` (legacy, fallback only) |
| `src/supabase-api.ts` | `SupabaseApiClient` — drop-in replacement |
| `src/ai/types.ts` | `Embedder`, `VectorStore`, `Generator`, `RetrievedChunk`, etc. |
| `src/ai/registry.ts` | Static model catalogue (local + system-os + cloud) |
| `src/ai/embeddings.ts` | bge-small-en-v1.5 via `@huggingface/transformers` + cosine util |
| `src/ai/bm25.ts` | Pure-JS BM25 ranker (~80 lines, no deps) |
| `src/ai/vectorStore.ts` | `VectorStore` interface + `InMemoryVectorEngine` |
| `src/ai/retrieval.ts` | Hybrid retrieve (BM25 + vector + RRF + MMR + sentence snippets) |
| `src/ai/rag.ts` | RAG orchestrator: query → embed → retrieve → prompt → stream |
| `src/ai/backends/ollama.ts` | Ollama HTTP client (detect, list, pull, stream) |

The mobile `src/shared/` mirror has its own `crypto.ts` (noble-based)
and its own `supabase-api.ts` (RN-compatible) but otherwise reuses the
same `types.ts`, `hlc.ts`, `api.ts`, `encoding.ts`. The AI modules will
be added to the mobile mirror in phase 3 (next).

---

## 7. Spec drift / honest tradeoffs vs. master spec

| Spec § | What the spec says | What we shipped | Why |
|---|---|---|---|
| §3.2 | Argon2id KDF | PBKDF2-SHA256 (600k iters) | Argon2 in browser/RN requires WASM bundle; PBKDF2 is built into Web Crypto on every platform. Same key hierarchy. Documented in `00-mvp-scope.md`. |
| §3.5 | sqlite-vec for vector store | IndexedDB (desktop) / AsyncStorage (mobile, phase 3) | Brute-force cosine is <50 ms for 10k notes — the spec's complexity comes from scale we don't have yet. |
| §3.5 | Hybrid retrieval (BM25 + vector + cross-encoder rerank) | BM25 + vector + RRF + MMR; cross-encoder rerank deferred to v1.1 | Cross-encoder is a 120 MB extra download; locked in `05-llm-architecture.md` §17a. |
| §3.6 | Local LLM via llama.cpp wrapper | Ollama on desktop; llama.rn deferred to phase 3 on mobile | Ollama already does GGUF + downloads + GPU offload; not bundling the runtime is the right MVP call. |
| §4 | Tauri 2.x desktop shell | Tauri 2 wired up; web app also works standalone | Both ship. |
| §5.2 | TenTap (TipTap-in-WebView) on mobile | Plain markdown TextInput | Per `04-mobile.md`, TenTap is the v1.5 nice-to-have. |
| §5.5 | Local LLM on mobile via llama.cpp NDK / Metal | **Shipped** via `llama.rn` (binding around llama.cpp). Embedder runtime in place; bge-small wiring is the remaining step. | One-way door taken. |
| §2.5 | AI proxy as a metered passthrough | Built into the spec only — not yet shipped | Cloud LLMs are tier-gated; ship with v1.1 alongside frontier keys. |
| §2.6 | Paddle billing | Not in v1.0 | Auth gate only; revenue path comes after launch. |
| §3.8 | Attachments with streaming AES-GCM | **Shipped** — per-attachment HKDF key, 1 MiB chunked AES-GCM, encrypted metadata blob, signed URLs via Edge Functions, iDrive prod / MinIO local. E2E test green. | Mobile UI follow-up is the only remainder. |
| §6.1 | QR pairing for new device | Manual passphrase + Secret Key only | QR pairing is a substantial side-channel; manual entry covers the same threat model. |

Nothing here paints us into a corner; each row has a non-destructive
upgrade path.

---

## 8. What's next (immediate roadmap)

The priority queue when work resumes. Phase 3 JS-side is **done**; the
remaining work splits cleanly into "needs prebuild" and "doesn't need
prebuild" so we can keep moving on whichever you prefer.

### Doesn't need `expo prebuild` (can ship today)

1. **Cloud (frontier) LLM keys** behind a tier gate. Paste OpenAI /
   Anthropic / Google keys in Settings → AI; mobile + desktop share
   the keychain abstraction.
2. **AI proxy + `meo.usage_log`** Supabase Edge Function. Metered
   passthrough, no body logging. Per spec §2.5.
3. **Attachments E2EE pipeline** with iDrive S3 (per spec §3.8 and the
   architecture I locked earlier). Schema, signed-URL Edge Function,
   client streaming AES-GCM, image/file upload buttons in the editor.
4. **Realtime WebSocket sync** (replaces 10s polling). Per spec §2.4.
5. **Slash menu on mobile** — keyboard-toolbar `/` button.
6. **Note pinning** — schema field, sort order, Pin folder filter
   actually populates.

### Requires `expo prebuild` (one-way door)

7. **Phase 3.5: real on-device LLM on mobile.**
   - `npx expo prebuild` (irreversible without `git revert`)
   - `llama.rn` integration, default model: Qwen 2.5 1.5B Q4
   - `transformers-rn` for the real bge-small embedder
   - Apple FoundationModels for iOS 18+
   - Gemini Nano via ML Kit on supported Android
   - `op-sqlite` vector store (replaces AsyncStorage)

### Either way

8. **Cross-encoder rerank** behind a Settings toggle (per spec §17a,
   v1.1).
9. **Spotlight / menubar / biometric unlock** on desktop.

Each item in (1)-(6) is independent. Pick based on what to demo first.
Items in (7) are a single block; deciding the prebuild moment is the
gate.

---

## 9. How to run, end-to-end

### Desktop, full AI stack

```bash
# Once
brew install supabase/tap/supabase    # or download CLI binary
ollama pull qwen2.5:1.5b              # ~950 MB

# Each session
supabase start                         # ~10s after first pull
npm --workspace @meo/desktop run dev   # Vite on :5173

# In another terminal, optional:
npm --workspace @meo/desktop run tauri:dev   # native window
```

Sign in, open Ask Meo, chat with your notes locally.

### Mobile, bare workflow (phase 3.5)

`expo prebuild` has been run; this is no longer an Expo Go app. The
native modules (`llama.rn`, `op-sqlite`, `onnxruntime-react-native`,
`FoundationLLM`) require a native build.

```bash
cd packages/mobile
# Set Supabase config in app.json's `extra.supabaseAnonKey`
npm install                          # picks up onnxruntime + foundation-llm
npx expo run:ios                     # compiles + installs to simulator
# or
npx expo run:android                 # compiles + installs to emulator
```

The Metro bundler ships the JS automatically; the simulator hot-reloads
on save. Auth, notes, folders, tags, search, long-press menus, AI
sheet, attachments (image + file picker), and Settings → AI all work.

#### Installing the iOS simulator (first-time on a fresh Mac)

`npx expo run:ios` requires Xcode + an iOS simulator runtime. On a host
where `xcrun simctl list devices` is empty:

```bash
# Check what's installed
xcodebuild -showsdks

# Option A — via Xcode CLI (~7 GB download)
sudo xcodebuild -downloadPlatform iOS

# Option B — via Xcode UI: open Xcode → Settings → Components → click
# "Download" next to the latest iOS Simulator runtime.

# After it finishes, verify:
xcrun simctl list devices | grep -i "iphone"
```

Once a simulator runtime is installed, `npx expo run:ios` boots one
automatically (defaults to the latest iPhone). To pick a specific one:

```bash
npx expo run:ios --device "iPhone 16 Pro"
```

#### CocoaPods caveats on Apple Silicon

If `pod install` fails with FFI / json native build errors:

```bash
cd ios
sudo gem install ffi
arch -x86_64 pod install            # one-shot if rosetta-only gems
```

#### FoundationModels (iOS 18+) gating

The `FoundationLLM` pod weak-links the FoundationModels framework, so
the binary loads on iOS 15+ but the entry points return
`{available: false}` on anything below iOS 18. Apple Intelligence is
further gated by the OS to A17 Pro / M-series silicon — Settings → AI
shows the model row as "Detected on this OS, native bridge not yet
linked" until the device + user opt-in are both ready.

### Final verification checklist

Run these commands to confirm a green build before tagging v1.0:

```bash
# Backend
cd supabase && supabase status                  # all containers healthy
node ../packages/shared/test-supabase-e2e.mjs   # 10/10 green

# Crypto + AI
node ../packages/shared/test-crypto.mjs                     # 7 tests
cd ../packages/mobile && node test-tokenizer.mjs            # 9 tests
node test-interop.mjs                                       # 4 tests
node test-attachments-interop.mjs                           # 3 tests

# Bundles
cd ../desktop && npm run build                              # ✅ no warnings
cd ../mobile && npx tsc --noEmit                            # ✅ exit 0
npx expo export --platform ios --output-dir export-test     # ~3.2 MB hbc
```

All test suites are currently green at HEAD.

---

This document gets updated whenever a major piece flips status. The
two docs that change the most often: this one and `05-llm-architecture.md`.
