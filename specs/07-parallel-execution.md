# Parallel execution: Door A + Door B

Two agents working simultaneously in isolated git worktrees. When both
finish, their branches merge back into `main`. This file tracks scope,
status, and merge plan.

## Door A — Mobile native AI runtime

**One-way door** (involves `npx expo prebuild`). User explicitly opted in.

### Scope

Everything in `packages/mobile/` only. No changes to other packages.

### Tasks

- [ ] **A1.** `npx expo prebuild --clean` to generate `ios/` and `android/` folders (irreversible — bare workflow from here, Expo Go gone)
- [ ] **A2.** Install `llama.rn` (RN binding around llama.cpp; Metal on iOS, Vulkan/OpenCL/CPU on Android)
- [ ] **A3.** Install `op-sqlite` to replace AsyncStorage for the vector store
- [ ] **A4.** Install `react-native-transformers` or the active native ONNX runtime alternative (verify package; fallback: keep `NoopEmbedder` if no good option ships)
- [ ] **A5.** Add `LlamaRnBackend` implementing the shared `Generator` interface, in `packages/mobile/src/shared/ai/backends/llamaRn.ts`
- [ ] **A6.** Replace `NoopEmbedder` in `packages/mobile/src/shared/ai/embeddings.ts` with the real bge-small-en-v1.5 wrapper (or document why it had to stay no-op)
- [ ] **A7.** Replace AsyncStorage vector store in `aiStore.ts` with op-sqlite
- [ ] **A8.** Update generator chain order in `aiStore.ts`: prefer llama.rn over Ollama on mobile
- [ ] **A9.** Update Settings → AI screen to show llama.rn model state + "Install Qwen 2.5 1.5B (~950 MB)" download button with progress
- [ ] **A10.** Native module shim for **Apple FoundationModels** (iOS 18+) gated by `Platform.Version >= '18'` — list as a `system-os` model in registry
- [ ] **A11.** `npx expo run:ios` to verify the app builds and launches in the iOS simulator
- [ ] **A12.** Update `specs/06-current-status.md` flipping mobile rows from ⚠ 3.5 to ✅

### Acceptance

- iOS app builds and launches via `npx expo run:ios`.
- Android app builds and launches via `npx expo run:android` (or build is documented if a tool is missing on the dev machine).
- Ask Meo on mobile produces a real response from a local model on a connected device or simulator.
- `npx tsc --noEmit` clean. `npx expo export --platform ios` clean.

### Out of scope for Door A

- Anything that touches `packages/desktop/`, `packages/shared/` outside the mobile mirror, or `supabase/`
- Attachments / iDrive (that's Door B)

---

## Door B — Attachments pipeline (E2EE, iDrive S3)

### Scope

- `supabase/` — new migration + Edge Function
- `packages/shared/src/` — new attachments module (crypto + storage abstraction + API client surface)
- `packages/desktop/src/` — image/file upload buttons in the toolbar, attachment renderer in TipTap
- `packages/mobile/app/note/[id].tsx` — image/file upload buttons in the bottom toolbar

### Tasks

- [ ] **B1.** Migration: `meo.attachments` table per spec §2.2 (id, note_id, user_id, storage_key, storage_backend, encrypted_size, nonce, encrypted_metadata, metadata_nonce, created_at) + RLS
- [ ] **B2.** `meo.attachments_create` and `meo.attachments_confirm` RPCs (SECURITY DEFINER, atomic)
- [ ] **B3.** Storage backend abstraction in `packages/shared/src/attachments.ts`:
  - `interface StorageBackend` with `signedPutUrl(key)` and `signedGetUrl(key)`
  - `IDriveStorage` implementation (S3 v4 sigv4)
  - `SupabaseStorageBackend` fallback for local dev (uses Supabase's MinIO)
- [ ] **B4.** Edge Function `supabase/functions/attachments-upload-url/index.ts` that validates JWT, checks note ownership, signs a PUT URL via the chosen backend (env-driven). Reads iDrive secrets from env.
- [ ] **B5.** Edge Function `supabase/functions/attachments-download-url/index.ts` (mirror, for GET).
- [ ] **B6.** Client crypto in shared: per-attachment HKDF key from master key + attachment id; AES-256-GCM streaming encrypt/decrypt in 1 MB chunks per spec §3.8.
- [ ] **B7.** Encrypted metadata blob (filename + mime + dimensions + sha256_checksum + original_size), stored in `meo.attachments.encrypted_metadata`.
- [ ] **B8.** `AttachmentsClient` in shared that exposes `upload(file)`, `download(id)`, `delete(id)`. Used by both desktop and mobile.
- [ ] **B9.** Desktop editor: replace the placeholder "Image (paste URL)" toolbar button with an actual file picker; upload, get the attachment id back, insert as a TipTap image referencing the attachment id.
- [ ] **B10.** Custom TipTap image renderer that fetches + decrypts on demand (lazy decrypt, blob URL for the lifetime of the editor).
- [ ] **B11.** Mobile editor: file picker on the bottom toolbar (image first, generic file later); same upload pipeline. Insert as `![](attachment:<id>)` markdown that the renderer recognizes.
- [ ] **B12.** README + `06-current-status.md` updated. iDrive env vars documented.
- [ ] **B13.** Test: round-trip an image — upload, query the database, verify the bytes are encrypted, download, decrypt, byte-compare.

### Acceptance

- Image upload + download works end-to-end on desktop, against Supabase's local MinIO (no real iDrive credentials required for the test).
- The bytes in the bucket are AES-256-GCM ciphertext (verify with the round-trip test).
- Filename / mime never leave the device unencrypted (verify by reading the row in psql).
- `npx tsc --noEmit` clean across all packages.
- All existing tests still pass.

### Out of scope for Door B

- Real iDrive credentials integration (the env-driven contract is in place; the user fills `IDRIVE_*` env vars when ready)
- llama.rn / mobile prebuild / on-device LLM (Door A)
- Real-time sync, frontier API keys, AI proxy

---

## Merge plan

When both agents finish:

1. Identify the worktree paths and branch names from each agent's result.
2. Cherry-pick or merge each branch into `main` from this primary tree.
3. Resolve the small overlap zone:
   - `packages/mobile/app/note/[id].tsx` — both may have edited (Agent A for AI, Agent B for upload). Manual merge.
   - `specs/06-current-status.md` — both may have updated. Re-write the file from the merged truth.
4. Run the full verification suite from this tree:
   ```bash
   node packages/shared/test-crypto.mjs
   node packages/shared/test-supabase-e2e.mjs
   cd packages/mobile && node test-interop.mjs
   cd packages/desktop && npx tsc --noEmit
   cd packages/mobile && npx tsc --noEmit
   ```
5. Update `06-current-status.md` to reflect both doors landed, and update README.

## Status — both doors landed

| Door | Branch | Final commit | Status | Notes |
|---|---|---|---|---|
| A — Mobile native AI | `door-a-mobile-llm` | `ed49c3c` | ✅ merged into `master` (merge commit `e7e2a8e`) | Prebuild done; `llama.rn` + `op-sqlite` + `onnxruntime-react-native` installed; `LlamaRnBackend` + `FoundationBackend` + `SqliteVectorStore` shipped. Embedder stayed on `NoopEmbedder` (deliberate — see honest gaps below). iOS simulator wasn't available on this host, so `expo run:ios` not executed; `expo export --platform ios` is clean. |
| B — Attachments / iDrive | `door-b-attachments` | `50d8e63` | ✅ merged into `master` (merge commit `12739c3`) | Migration `20260428000000_attachments.sql` + 2 RPCs + 2 Edge Functions + shared `AttachmentsClient` + desktop TipTap `AttachmentImageExtension`. E2E test passes; bytes verified ciphertext at rest, filename never plaintext in DB. iDrive paths via env, MinIO fallback for local dev. |

### Post-merge work (done by main session)

- Wired `setAttachmentsContext` shim into `App.tsx#onAuth` and cleared on `handleLogout` (Door B's call-out).
- Fixed `packages/mobile/test-interop.mjs` to recurse into subdirs and exclude the new `ai/` subtree (RN-only deps don't resolve under plain Node).
- Ran the full suite: **crypto + supabase-e2e + attachments-e2e + interop — all four green.**

### Honest gaps to close in follow-ups

From Door A's report:
1. **Real embedder** — `onnxruntime-react-native` is installed; need to wire bge-small-en-v1.5 ONNX file + WordPiece tokenizer + pooling. ~half day.
2. **FoundationModels Swift Pod** — JS side is wired, native bridge isn't. ~half day per platform.
3. **iOS simulator** — install via Xcode → Components or `xcodebuild -downloadPlatform iOS`, then `npx expo run:ios` works.

From Door B's report:
4. **Quota enforcement (10 GiB per account)** — per-attachment 100 MiB cap is enforced both client and server-side, but the workspace-wide quota isn't. Add a trigger on `meo.attachments_create`.
5. **First-chunk preview** — `decryptFirstChunk` exists in `attachments.ts` but the renderer always does a full decrypt today.
6. **Mobile attachments UI** — shared `attachments.ts` is mobile-compatible; the file-picker wiring in the mobile note editor is a separate ticket (Door A's strict scope kept it out).
7. **CSS for `.upload-banner` / `.att-image` / `.drop-active`** — Door B couldn't touch `styles.css`. Functional, just unstyled.
