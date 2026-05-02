# LLM architecture - desktop and mobile

This is the design contract for everything AI in meo.md. It covers where
inference runs, where embeddings come from, how RAG over notes works, how
keys are stored, and how privacy is preserved end to end. It is the
sibling of `01-shared-crypto.md`: same level of rigor, same insistence on
the server never seeing plaintext.

The companion mocks: `design-mocks/components/{ai-controls.jsx,desktop.jsx,
markdown-editor.jsx,mobile.jsx,models-screen.jsx}`.

## 0. Goals and non-goals

### Goals

1. **Ask questions across your notes** without the server (or any third
   party that the user hasn't explicitly opted into) seeing note contents.
2. **Run open-source LLMs locally** on desktop (macOS, Windows, Linux)
   and on mobile (iOS, Android), with a single shared client interface.
3. **Frontier cloud LLMs are opt-in per user**, with their own API key
   that **never reaches our server**, and with an explicit privacy warning
   in the UI.
4. **One consolidated Settings screen** for both kinds of model: local
   downloads on the left, cloud keys on the right.
5. **Cross-platform parity** for the user-facing AI surface: same
   conversation panel, same slash menu, same settings, same model
   registry where the underlying runtime supports it.

### Non-goals (v1)

- Multi-user or shared AI usage. Per-user only.
- Fine-tuning of local models from inside the app.
- Voice transcription. (Spec defers to v1.5.)
- Building our own llama.cpp wrapper, our own quantization pipeline,
  or our own model hub. We use Ollama on desktop and llama.rn on mobile
  with HF Hub as the model registry.
- Embedding-heavy retrieval beyond ~10,000 notes per workspace. This is
  the realistic ceiling for in-process brute-force cosine on mobile.
  We will revisit when a real user hits it.

## 1. Privacy invariants

These are non-negotiable. Every implementation choice below preserves
all five.

| # | Invariant | What it implies |
|---|---|---|
| **P1** | Note plaintext never leaves the device for **embedding generation**. | The embedding model runs locally, on every platform, always. |
| **P2** | Note plaintext never leaves the device for **local LLM inference**. | Local LLMs run on the device, full stop. The "AI proxy" never sees note contents. |
| **P3** | **Cloud LLM is opt-in per user.** Sending plaintext to a cloud provider only happens when the user has set up a frontier model **with their own API key** and explicitly selected it for the current question. | The UI warns about this every time a cloud model is being used. The default backend is always local. |
| **P4** | **Frontier API keys never reach our server.** They go from the user's keychain straight to the provider's endpoint. | The AI proxy is bypassed for keyed users. We never receive, log, or even see these keys. |
| **P5** | The AI proxy (used by trial users without their own key) is a **metered passthrough**. Request and response bodies are never persisted. Only `{user_id, model, prompt_tokens, completion_tokens, ts}` is written, for billing. | The proxy code includes no logging beyond this row. The proxy schema enforces it. |

These match spec §2.5, §3.6, §6.4. The architecture below is the
mechanism that delivers them.

## 2. Architecture overview

```
                 ┌────────────────────────────────────────────────────────┐
                 │                  CLIENT (trust boundary)               │
                 │                                                        │
                 │   ┌────────────┐     ┌──────────────┐                  │
   user query ──▶│   │  AI panel  │────▶│   RAG core   │                  │
                 │   │ slash menu │     │  (retrieve   │                  │
                 │   └────────────┘     │   then       │                  │
                 │                      │   generate)  │                  │
                 │                      └─────┬────────┘                  │
                 │                            │                           │
                 │            ┌───────────────┼───────────────┐           │
                 │            ▼               ▼               ▼           │
                 │      ┌──────────┐    ┌──────────┐    ┌──────────┐     │
                 │      │ embedder │    │  vector  │    │ generator│     │
                 │      │ (bge-    │    │   store  │    │  router  │     │
                 │      │  small)  │    │ (cosine) │    │          │     │
                 │      └──────────┘    └──────────┘    └─────┬────┘     │
                 │                                            │          │
                 │   ┌────────────────────────────────────────┴────────┐ │
                 │   │              Generator backends                 │ │
                 │   │                                                 │ │
                 │   │  Desktop:                                       │ │
                 │   │    • Ollama (HTTP at :11434)                    │ │
                 │   │    • Frontier direct (Anthropic, OpenAI, …)     │ │
                 │   │                                                 │ │
                 │   │  Mobile:                                        │ │
                 │   │    • llama.rn (in-process, GGUF)                │ │
                 │   │    • Apple FoundationModels (iOS 18+, in-OS)    │ │
                 │   │    • Gemini Nano via ML Kit (Pixel 8+, Samsung) │ │
                 │   │    • Frontier direct (same as desktop)          │ │
                 │   └─────────────────────────────────────────────────┘ │
                 └────────────────────────────────────────────────────────┘
                                            │
                              encrypted blobs only
                                            │
                                            ▼
                 ┌────────────────────────────────────────────────────────┐
                 │            SERVER (untrusted, sees ciphertext)         │
                 │                                                        │
                 │   ┌────────────────┐         ┌─────────────────────┐  │
                 │   │ AI proxy       │ ──────▶ │   Anthropic, OpenAI, │  │
                 │   │ (metered       │         │   Google, xAI       │  │
                 │   │  passthrough,  │         │   (only for trial   │  │
                 │   │  no logging)   │         │    users without    │  │
                 │   │                │         │    their own key)   │  │
                 │   └────────────────┘         └─────────────────────┘  │
                 │           │                                            │
                 │           ▼                                            │
                 │   meo.usage_log (token counts only, no content)        │
                 └────────────────────────────────────────────────────────┘
```

The line that splits the diagram in half is the **encryption boundary**.
Everything AI-related on the client side runs in plaintext (because it
must, to be useful). Everything that crosses the boundary is either
ciphertext or anonymous metering.

## 3. Layered backend selection

When a user sends an AI query, the runtime picks a generator backend in
this order. Each layer is a well-defined function that returns either a
streaming response or `null` (meaning "try the next layer"):

```
  v1.0:
    isAppleFoundationModelsAvailable() (iOS 18+)  →  Apple system model
              ↓ no
    isLocalGgufModelInstalled()  →  Ollama (desktop) or llama.rn (mobile)
              ↓ no
    show "Install a model" empty state with a CTA

  v1.1 (paid tier ships):
    userTierAllowsCloud() && hasFrontierKey(currentModel)  →  direct call
              ↓ no
    [v1.0 chain above]
              ↓ no
    userTierAllowsProxy()  →  AI proxy (metered)
              ↓ no
    show "Install a model or upgrade" empty state
```

This order is **deterministic and visible to the user**. The model
selector in the sidebar shows which backend will be used; we never
silently fall back to a different backend mid-conversation.

## 4. Per-platform runtime catalog

| Layer | Desktop (Tauri / web) | iOS | Android |
|---|---|---|---|
| Frontier cloud | Direct HTTPS to provider with user key | Same | Same |
| OS-shipped LLM | n/a | Apple FoundationModels (iOS 18+) | Gemini Nano via ML Kit GenAI (Pixel 8+, Samsung S24+) |
| On-device GGUF | Ollama daemon at `localhost:11434` | `llama.rn` (Metal) | `llama.rn` (Vulkan / OpenCL / CPU fallback) |
| Embedder | `@xenova/transformers` (WASM) in a Web Worker | `@xenova/transformers` in JS thread (or native via `transformers-rn` if perf is bad) | Same as iOS |
| Vector store | `idb` over IndexedDB | `op-sqlite` (already used in spec §5.3) | Same as iOS |
| Keychain | Tauri Stronghold plugin (`tauri-plugin-stronghold`) | `expo-secure-store` (already in use for JWT) | Same as iOS |

We **do not bundle** Ollama. The desktop app detects whether Ollama is
running and, if not, shows a card with a one-click installer link. Same
posture as Docker Desktop: depend on it, don't ship it.

We **do not bundle** any model with the binary. Models download on
first use over Wi-Fi with explicit consent (see §9). This keeps the
initial install size small and respects App Store / Play limits
(>200 MB iOS, >150 MB Android trigger warnings).

## 5. The model registry

There is one logical registry, surfaced identically on every platform.
It has three columns:

| Field | Type | Notes |
|---|---|---|
| `id` | string | e.g. `qwen2.5-1.5b-q4`, `claude-sonnet-4.5`, `apple-foundation` |
| `kind` | enum | `'local-gguf' \| 'system-os' \| 'cloud'` |
| `tag` | string | UI subtitle: "Fast, on-device" / "Frontier" / etc. |

Source of the registry per platform:

- **Desktop**: a static catalog from `packages/shared/src/ai/registry.ts`
  for cloud + system-os entries, plus dynamic discovery by polling
  `GET http://localhost:11434/api/tags` for installed Ollama models.
  Both are concatenated in the model dropdown.
- **Mobile (iOS/Android)**: same static catalog for cloud + system-os
  entries, plus a managed list of GGUF files the app has downloaded,
  stored in the encrypted preferences store.

The static portion of the registry is identical to the design mocks'
`MODELS` array in `design-mocks/components/ai-controls.jsx` and the
existing `packages/desktop/src/AIControls.tsx` `MODELS` constant. The
mocks are the source of truth for visuals; this doc is the source of
truth for behavior.

### 5.1 Default models

| Platform | Default | Why |
|---|---|---|
| Desktop with Ollama installed | First Ollama model with `<= 7B` params | Fast first interaction without forcing a download |
| Desktop without Ollama | `Meo Mini` placeholder; clicking sends user to install card | Honest empty state |
| iOS 18+ | Apple FoundationModels | Free, no download, OS-blessed |
| iOS < 18 | `Qwen 2.5 1.5B Q4` (≈950 MB) | Smallest competent model that fits in 4 GB-RAM phones |
| Android with Gemini Nano | Gemini Nano via ML Kit | Free, no download |
| Android without Gemini Nano | Same Qwen 2.5 1.5B as iOS | One registry across platforms |

### 5.2 Model rows shown to the user

Per the design (`AIControls.tsx`), each row shows:

- A colored dot: green for `local-gguf` and `system-os`, rust for `cloud`
- Name + DEFAULT badge if applicable
- Subtitle: `Local · 1.1 GB · Fast, on-device` / `Anthropic · shares data · Frontier`

The "shares data" suffix is mandatory on cloud rows. P3.

## 6. Embeddings and the vector store

### 6.1 Embedding model

**`Xenova/bge-small-en-v1.5`** (ONNX, 384-dim).

| Property | Value |
|---|---|
| Output dimension | 384 |
| Quantized size | ~33 MB |
| Inference time, M2 Pro / WASM | ~5 ms per note |
| Inference time, iPhone 14 / WASM | ~25 ms per note |
| MTEB retrieval benchmark | Better than `all-MiniLM-L6-v2` (the spec's default) at the same size |

Loaded once at startup, kept in memory. All embedding generation runs
on the **client**, in a Web Worker on desktop and on the JS thread on
mobile (with a yield every ~50 notes to keep the UI responsive).

We may add `text-embedding-3-small` as an opt-in cloud embedder later
**only if the user has set up an OpenAI key** and explicitly checked
"use cloud embeddings" in advanced settings. The default is, and will
remain, local. P1.

### 6.2 The vector store interface

`packages/shared/src/ai/vectorStore.ts`:

```ts
export interface VectorStore {
  /** Insert or update a note's embedding. */
  upsert(noteId: string, vector: Float32Array): Promise<void>;

  /** Remove an embedding (note deleted). */
  remove(noteId: string): Promise<void>;

  /** Cosine similarity search. Returns top-k by similarity, descending. */
  search(query: Float32Array, k: number): Promise<SearchHit[]>;

  /** Bulk re-index. Used after switching embedding model. */
  rebuild(notes: Note[], embedder: Embedder, onProgress: (n: number) => void): Promise<void>;
}

export interface SearchHit {
  noteId: string;
  score: number;       // [0, 1]
}
```

Two implementations:

- `IndexedDbVectorStore` (desktop) - vectors stored as `Uint8Array`
  views in the existing `meo-md` IndexedDB under a new `vectors`
  object store. Brute-force cosine in the worker thread on every search.
- `SqliteVectorStore` (mobile) - vectors stored as a `BLOB` column in a
  new SQLite table `note_vectors(note_id TEXT PRIMARY KEY, dim INT,
  vec BLOB)`. Brute-force cosine in JS over a query that pulls all
  rows. Below 10k notes this is <10 ms; above, we revisit.

Both implementations are tested with the same test vector against
the same interface in `packages/shared/test-vector-store.mjs`.

### 6.3 What we never store

- **The decrypted note plaintext.** Embeddings are derived from
  plaintext, but only the 384-dim float vector is persisted. The
  plaintext lives in memory only when the note is open or being
  embedded.
- **Cleartext copies of vectors on the server.** The server has no
  knowledge that vectors exist. Vector search is local-only.

If the user clears local cache (sign-out flow already supports this
via `clearAll()`), all embeddings are dropped. The next sign-in
re-embeds everything in the background.

### 6.4 Re-embedding strategy

| Trigger | Behavior |
|---|---|
| Note saved | Re-embed only if title or body changed since last embed. Tracked via a `vec_hash` field on the cached encrypted note row (hash of `title || body`). |
| New device first sync | Background worker embeds all decrypted notes, batched 50 at a time, yielding to keep UI responsive. Status surfaced in the sidebar AI controls ("Indexing 124 of 1000…"). |
| Embedding model changed | Force-rebuild via `vectorStore.rebuild(...)`. Confirmation dialog warns it can take minutes for large workspaces. |

## 7. RAG: retrieve-then-generate

### 7.1 Flow

```
  user query
     │
     ▼
  embed(query)  ────────────────────────  ~10 ms
     │
     ▼
  vectorStore.search(qvec, k=8)  ───────  ~5 ms per 1k notes
     │
     ▼
  MMR rerank (λ=0.5) for diversity  ────  <1 ms
     │
     ▼
  build prompt:
     system: "You are Meo, a helpful assistant grounded in the user's
              notes. Cite sources by note id."
     context: top-k snippets, each prefixed with [note:<id>] [title]
     user: <query>
     │
     ▼
  generator.stream(messages)  ──────────  100-2000 ms first token
     │
     ▼
  parse streamed deltas, surface citations as chips below the answer
```

### 7.2 Snippet building

Each retrieved note contributes a snippet, not its full text. Snippets
are built by:

1. Embedding the query against the note's _sentences_ (split on `.`/
   `!`/`?` with a 200-char cap per sentence).
2. Picking the top 3 sentences from the note for the snippet.
3. Joining them in document order with `…` separators if non-contiguous.

This keeps the generator's context window bounded even with very long
notes, and gives more relevant context than naive truncation.

### 7.3 Citations

Every chunk in the prompt is tagged `[note:<id>] [title]`. The system
prompt instructs the model to keep these tags when quoting. The
client parses tags out of the streamed output, replaces them with chip
components (mossy-green, click to open the source note), and shows
which notes were retrieved (whether or not they were cited) in a
collapsed footer below the answer.

### 7.4 Mode selection

The AI panel has two query modes (a tiny segmented control at the top
of the input):

- **Ask** - single retrieval pass; returns "Answer from your notes"
  callout with citations + a list of notes. No conversation history.
- **Chat** - multi-turn conversation. Each user turn does its own
  retrieval (so we don't pollute later turns with irrelevant context
  from earlier ones). History is in-memory only; not persisted.

### 7.5 Boundary between ⌘K nav and AI retrieval

These are two separate features and they should not be conflated:

| Feature | Purpose | Index | Latency budget | Surface |
|---|---|---|---|---|
| **⌘K quick search** (already shipped) | Jump to a note / folder / tag by exact substring | None - linear scan over decrypted titles + bodies + tags + folders | <16 ms for 1000 notes | Cmd-K overlay |
| **AI panel retrieval** (this doc) | Ground LLM answers in relevant notes via RAG | Hybrid: SQLite FTS5 (BM25) + local vector store | <50 ms for 10k notes | Right drawer (desktop) / bottom sheet (mobile) |

Hybrid retrieval is **only** invoked from the AI panel. ⌘K does not
embed, does not call BM25, does not touch the vector store. It stays a
pure substring/fuzzy navigator. This keeps ⌘K instant and the AI
retrieval path orthogonal to it; there is no shared code path or
shared cache between the two.

## 8. Frontier (cloud) keys - v1.1 only

> **Status:** Not shipped in v1.0. Gated behind the paid tier system
> (which doesn't exist yet). The architecture below is the contract
> for v1.1 so the cut-over is mechanical when the tier lands. Until
> then, the "Cloud models" section in Settings → AI is hidden.

### 8.1 Storage

| Platform | Mechanism | Key encryption at rest |
|---|---|---|
| Desktop (Tauri) | `tauri-plugin-stronghold` | Encrypted under a Stronghold password derived from the OS keychain |
| Mobile | `expo-secure-store` | iOS Keychain Services / Android EncryptedSharedPreferences |
| Web fallback (no native shell) | IndexedDB, AES-GCM under a key derived from the user's encryption passphrase | Best-effort; user warned that the OS keychain is preferred |

### 8.2 Providers supported in v1

| Provider | Endpoint | Key prefix | Test endpoint |
|---|---|---|---|
| Anthropic | `https://api.anthropic.com/v1/messages` | `sk-ant-` | `GET /v1/models` |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `sk-` | `GET /v1/models` |
| Google AI Studio | `https://generativelanguage.googleapis.com/v1beta/models/gemini-X:streamGenerateContent` | (paramless) | `GET /v1beta/models` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `sk-or-` | `GET /api/v1/models` |
| xAI | `https://api.x.ai/v1/chat/completions` | `xai-` | `GET /v1/models` |

### 8.3 Validation

When a user pastes a key, the Settings screen does a `GET /models` call
(no completion is generated, no token spent in most cases). On 200, the
key is stored. On 401/403, the field shows a red error. We never store
an unvalidated key.

### 8.4 Direct call shape

For Anthropic (others analogous):

```
client (with user key)
   │
   ▼  HTTPS to api.anthropic.com  (TLS only - no proxy)
provider
   │
   ▼  streaming response
client (renders tokens)
```

The user's note plaintext, the system prompt, and the response all
travel directly between the device and Anthropic over TLS. **No meo.md
server is in the path.** P3, P4.

## 9. Model download UX

Models are large. We don't surprise users.

### 9.1 Triggering a download

- User opens the model selector → sees a model with `installed: false`
  and a `1.1 GB` size badge.
- They click "Install".
- A modal appears: **"Download Qwen 2.5 1.5B Q4 (950 MB) over Wi-Fi?"**
  - Confirm
  - Cancel
- A progress row replaces the install button: bytes / total, MB/s,
  cancel button. Shown both in the dropdown and in Settings → AI.
- On completion the model becomes selectable. No restart needed.

### 9.2 Network safety

- Wi-Fi-only by default. Cellular blocked unless the user toggles
  "Allow over cellular" in Settings → AI. iOS uses `NWPathMonitor`,
  Android uses `ConnectivityManager`.
- Resumable. Range requests on the HF Hub CDN. If interrupted,
  resumes from the last completed byte.
- Verified via SHA-256 against the HF Hub-published checksum after
  download. Mismatch → delete file, surface error.

### 9.3 File locations and backups

| Platform | Path | Backup behavior |
|---|---|---|
| Desktop (Ollama) | Ollama-managed: `~/.ollama/models/` | OS-default; we don't touch |
| iOS | `FileSystem.documentDirectory/models/<model_id>.gguf` | `NSURLIsExcludedFromBackupKey = true` (no iCloud backup of multi-GB blobs) |
| Android | `getFilesDir()/models/<model_id>.gguf` | `android:allowBackup="false"` for the app, plus per-file `fullBackupContent` rules |

### 9.4 Eviction

When free disk drops below 2 GB, the AI panel shows a warning row in
the model selector. Settings → AI shows total disk used by models with
per-model uninstall buttons. Uninstall removes the file and updates
the registry; doesn't affect any encrypted note data.

## 10. Performance budgets

These are targets the implementation has to hit. They become the
acceptance criteria for the work.

| Operation | Desktop budget | Mobile budget |
|---|---|---|
| Embedder cold start | < 800 ms | < 1500 ms |
| Embed a 500-word note | < 30 ms | < 80 ms |
| Initial backfill: 100 notes | < 3 s | < 12 s |
| Vector search, 1000 notes | < 5 ms | < 10 ms |
| Vector search, 10000 notes | < 50 ms | < 100 ms |
| First token, local model | < 500 ms | < 800 ms |
| Streaming rate, local model | ≥ 15 tok/s | ≥ 8 tok/s |
| First token, frontier cloud | < 800 ms | < 800 ms |

If we miss the mobile budgets on Qwen 2.5 1.5B, we drop to Llama 3.2 1B
as the default and surface "your device may struggle with larger
models" guidance.

## 11. Settings → AI screen

Two sections in v1.0; the third (Cloud models) is hidden behind a tier
check that always returns false until the paid tier ships.

```
  ┌───────────────────────────────────────────────────────────────────┐
  │ Settings  /  AI                                                   │
  │                                                                   │
  │  ╭─ Local models ───────────────────────────────────────────────╮ │
  │  │ ● Meo Mini (Qwen 2.5 1.5B)         950 MB    [installed][✓]  │ │
  │  │ ○ Llama 3.1 8B                     4.7 GB    [install]       │ │
  │  │ ○ Qwen 2.5 7B                      4.4 GB    [install]       │ │
  │  │   …                                                          │ │
  │  │ + Add custom model from Hugging Face URL          (v1.1)     │ │
  │  ╰──────────────────────────────────────────────────────────────╯ │
  │                                                                   │
  │  ╭─ Embeddings ─────────────────────────────────────── advanced ─╮ │
  │  │ Model: bge-small-en-v1.5                                     │ │
  │  │ Embeds: title + body + tags + folder                         │ │
  │  │ 348/1240 notes indexed (▮▮▮▮▮▮░░░░ 28%)                      │ │
  │  │                                              [Force re-index]│ │
  │  ╰──────────────────────────────────────────────────────────────╯ │
  │                                                                   │
  │  ╭─ Cloud models ────────────────────────────────────  v1.1  ───╮ │
  │  │  (Hidden in v1.0. Visible to paid-tier users in v1.1.)       │ │
  │  ╰──────────────────────────────────────────────────────────────╯ │
  └───────────────────────────────────────────────────────────────────┘
```

In v1.1, cloud rows always show the rust "shares data" warning. Local
rows are tagged green. The visual language is consistent with the
sidebar AI controls.

## 12. Implementation surface

What changes in the repo, by package.

### 12.1 `packages/shared/src/ai/`

New folder. All cross-platform AI logic lives here.

```
ai/
├── index.ts              # public exports
├── types.ts              # Embedder, Generator, GenerateOptions, Model, etc.
├── registry.ts           # static cloud + system-os models; merged with runtime
├── embeddings.ts         # transformers.js wrapper + cache
├── vectorStore.ts        # interface only
├── vectorStore.indexeddb.ts  # desktop impl
├── vectorStore.sqlite.ts     # mobile impl (uses op-sqlite at runtime)
├── rag.ts                # retrieve + MMR + prompt build
├── chat.ts               # turn-based orchestrator over a Generator
├── keychain.ts           # platform-abstracted key get/put/remove
└── backends/
    ├── ollama.ts         # detect, list, stream
    ├── llamaRn.ts        # mobile native runtime adapter
    ├── foundation.ts     # iOS Apple FoundationModels
    ├── geminiNano.ts     # Android ML Kit GenAI
    └── frontier/
        ├── anthropic.ts
        ├── openai.ts
        ├── google.ts
        ├── openrouter.ts
        └── xai.ts
```

### 12.2 `packages/desktop/src/`

```
AIPanel.tsx           # right-side drawer (340 px), conversation, input
SlashMenu.tsx         # in-editor / menu
Settings.tsx          # the screen above; routed at /settings
ai-store.ts           # session-scoped AI state + cached embedder
```

The existing `AIControls.tsx` (sidebar footer) keeps its current
shape; it gains a `Settings…` link and live binding to the keychain.

### 12.3 `packages/mobile/`

```
app/ai.tsx                # bottom-sheet AI panel route
app/settings/ai.tsx       # mobile Settings screen
src/AIControls.tsx        # rail in the bottom of the notes drawer
src/native-llm.ts         # llama.rn wrapper
src/native-foundation.ts  # iOS-only, gated by Platform.OS
src/native-gemini-nano.ts # Android-only
```

Going to llama.rn requires `npx expo prebuild`. That is a one-way door
and is documented in `04-mobile.md` when it lands.

### 12.4 `supabase/`

```
migrations/
  20260427000400_usage_log.sql   # meo.usage_log table
functions/
  ai-proxy/index.ts              # metered passthrough; no body logging
```

The proxy logs only `{user_id, model, prompt_tokens, completion_tokens,
ts}`. The function code includes a CI-enforced lint rule that fails
the build if any `console.log` or external write touches the request
or response body.

## 13. Data on disk and in memory

### 13.1 Disk (encrypted at rest)

| What | Where | Encryption |
|---|---|---|
| Encrypted note rows | IndexedDB / `notes` (desktop), SQLite encrypted_content (mobile) | AES-GCM with per-note key, as today |
| Note vectors | IndexedDB / `vectors` (desktop), SQLite `note_vectors` (mobile) | **Plaintext at rest** under OS disk encryption |
| Frontier API keys | OS keychain | OS-managed |
| Downloaded GGUF model files | App-private filesystem | None (model weights are not secret) |
| Ollama model cache | `~/.ollama/models/` | None; managed by Ollama |

The vectors are deliberately not encrypted on the client. Encrypting
them would require decrypting on every search, which kills the
sub-50 ms latency budget. Threat model: a local attacker who has
filesystem access already loses to N1 in spec §6.4; we don't pretend
otherwise. We do exclude vectors from cloud backups.

### 13.2 Memory

| What | Lifetime |
|---|---|
| Master key | Until tab refresh / app cold start (existing rule) |
| Embedder model weights | Until tab refresh; lazy-loaded on first AI use |
| Local LLM context | Per conversation; freed when AI panel is closed |
| Frontier API keys | Pulled from keychain on each request, never held in memory beyond the call |
| Conversation history | In memory only; not persisted in v1 |

## 14. Telemetry

Two kinds and only two kinds:

1. **Token usage** for billing of the AI proxy: `{user_id, model,
   prompt_tokens, completion_tokens, ts}`. No request bodies, no
   responses. Schema:

```sql
create table meo.usage_log (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id),
  model       text not null,
  prompt_tok  integer not null,
  reply_tok   integer not null,
  created_at  timestamptz not null default now()
);
create index on meo.usage_log (user_id, created_at desc);
```

2. **Errors** that the user sees. Surfaced in the UI only. We do not
   ship any analytics or crash reporting that touches AI request
   bodies. If we add Sentry later, AI request bodies are scrubbed
   client-side before report.

Frontier cloud usage that bypasses our proxy (because the user has
their own key) is not tracked anywhere on our side, by design.

## 15. Threat model addendum (extends spec §6.4)

| Threat | Defense |
|---|---|
| Provider compromise (cloud LLM steals notes) | User explicitly opts in per-key; we display "shares data" on every cloud row; their TOS apply; this is disclosed up front. |
| Compromised AI proxy server | Proxy never sees note content. It can see token counts, model id, and the user. It cannot see the user's API keys (those bypass it). |
| Compromised local device | All local AI data is plaintext to anyone with the device, same as today. We don't claim otherwise. |
| Network observer | TLS to the provider (cloud) or no network at all (local). |
| Subpoena of meo.md servers | Server has only encrypted note blobs and `usage_log`. A subpoena can produce token counts, not content. |

## 16. Migration path

What we ship vs. what we defer.

### 16.1 v1.0 (this build)

- AI panel (right drawer on desktop, bottom sheet on mobile)
- Slash menu in the editor
- Embeddings via bge-small (local), input includes title + body +
  tags + folder
- Vector store on each platform (IndexedDB on desktop, op-sqlite on
  mobile)
- BM25 over the same content via SQLite FTS5 (mobile) and a tiny
  pure-JS BM25 ranker (desktop)
- Hybrid retrieval: BM25 + vector + reciprocal rank fusion
- RAG search + chat modes
- Ollama integration on desktop
- llama.rn integration on mobile (one default model)
- Apple FoundationModels backend on iOS 18+
- Consolidated Settings → AI screen (Local models tab only)
- **Frontier (cloud) keys are NOT shipped in v1.0** - gated behind a
  paid tier that doesn't exist yet. The "Cloud models" section is
  hidden in the UI; the keychain abstraction and provider adapters
  live in the codebase but are not surfaced.

### 16.2 v1.1

- Cross-encoder rerank for RAG, behind a "high-quality results
  (slower)" toggle in Settings
- Frontier (cloud) keys for Anthropic, OpenAI, Google, OpenRouter,
  xAI - gated to the paid tier, with the tier check enforced
  client-side and server-side
- AI proxy, metered, for users on the paid tier without their own key
- Gemini Nano via ML Kit on supported Android
- ExecuTorch as an alternative on-device path
- Custom HF model URL input

### 16.3 v1.5

- Voice transcription (Whisper local) + voice notes
- Cloud embeddings as opt-in
- Per-folder AI scope ("Ask Meo in Work/")
- AI-driven note linking / suggested backlinks

### 16.4 v2

- Continuous fine-tuning of a small local model on the user's writing
- Sharing of AI conversations alongside notes
- Multi-modal: image understanding via local VLM

## 17. Resolved decisions

These were open questions during the design review; locked here so
implementation has no ambiguity.

1. **Embedding context: everything.** Title, body, tags, and folder
   path all flow into the embedding input. Format:
   ```
   <title>
   tags: <#tag1, #tag2>
   folder: <work/q1>

   <body>
   ```
   Re-embed triggers fire on any change to those fields, tracked via
   `vec_hash = sha256(title + "\0" + body + "\0" + tags.join(",") +
   "\0" + folder.join("/"))`.

2. **Hybrid retrieval (BM25 + vector + RRF): pending.** See §17a below.
   Cross-encoder rerank is deferred to v1.1 regardless of (a)'s answer.

3. **No "disable local embeddings" toggle.** Embeddings always run when
   the AI panel is opened, even if the user only uses cloud models.
   Keeps the model selector and search experience uniform.

4. **Frontier (cloud) LLMs are gated to a paid tier and not shipped in
   v1.0.** The Settings → AI "Cloud models" section is hidden until
   the tiering system exists. The architecture for keys is documented
   here so the cut-over is mechanical when the tier lands. All v1.0
   AI runs on local models or the OS-shipped LLMs (Apple
   FoundationModels, Gemini Nano).

5. **Ollama models are not listed when the daemon is offline.** Empty
   state with an install/start CTA instead.

### 17a. Resolved: hybrid retrieval is AI-panel-scoped, ships in v1.0

- ⌘K stays as the lightweight navigator (substring/fuzzy match over
  decrypted notes). No embeddings, no BM25 index. Already shipped.
- The AI panel uses **BM25 + vector + RRF merge** in v1.0. SQLite FTS5
  on every platform (the desktop already has SQLite available; on web
  we ship sql.js as a 600 KB worker if FTS becomes desirable, but for
  v1.0 the desktop also runs a tiny pure-JS BM25 over the in-memory
  decrypted note list since note counts are small enough).
- **Cross-encoder rerank is deferred to v1.1**, behind a "high-quality
  results (slower)" toggle. The 120 MB extra download is the cost we
  don't want to pay by default.

## 18a. Mobile parity backlog (CRITICAL - not yet started)

**Mobile has NOT received the desktop redesign or any of the features
shipped in the past several iterations.** It is still on the original
first-MVP layout (login → flat FlatList → plain TextInput editor)
talking to the legacy Hono backend on `:8787`. Before any LLM work
lands on mobile, the following gaps must be closed.

### 18a.1 Confirmed missing on mobile

Audited from `packages/mobile/`:

| Gap | Desktop has | Mobile state |
|---|---|---|
| Supabase backend | Yes (`SupabaseApiClient` via `@meo/shared`) | **No** - still constructs `new ApiClient('http://localhost:8787')` against the legacy Hono server |
| Meo design system (warm paper, serif body, mossy accent, MeoMark logo) | Yes | **No** - generic `styles.ts` |
| Three-pane mental model adapted for mobile | n/a (drilldown nav was the spec's own design) | Partial - `notes.tsx` is a flat list, not folder-aware |
| Folder tree | Yes (recursive, expandable, indent-aware) | **No** - folders ignored entirely |
| Folder + sub-folder creation | Yes (inline rename input) | **No** |
| Tags (per-note add/remove + sidebar tag list) | Yes | **No** - `note.tags` written but never surfaced |
| Contextual menus (right-click → note / folder / tag) | Yes (`ContextMenu.tsx`) | **No** - RN has no `contextmenu` event; needs long-press → action sheet |
| Search overlay (⌘K, exact match nav) | Yes (`SearchOverlay.tsx`) | **No** |
| Markdown toolbar (Edit/Split/Preview, headings, lists, etc.) | Yes (`Editor.tsx`) | **No** - plain monospace TextInput |
| AI controls in sidebar footer (on/off, model selector) | Yes (`AIControls.tsx`) | **No** |
| Disabled native context menu | n/a | n/a (RN doesn't have one) |
| Em-dash strip / copy review | Done | Not reviewed |

### 18a.2 Mobile-specific design source

The zip the user shared includes mobile mocks I have not yet read in
detail:

- `design-mocks/components/mobile.jsx` (≈12 KB) - primary mobile layout
- `design-mocks/ios-frame.jsx` - iOS device frame for the canvas
- The shared modules (theme, icons, ai-controls, models-screen, data,
  note-renderer, markdown-editor) apply to both platforms

These are the source of truth for the mobile redesign and must be
read first before any visual implementation.

### 18a.3 Required pre-AI mobile work (catch-up phase)

Done in this exact order to keep each step shippable on its own:

1. **Read `mobile.jsx`** to understand the navigation pattern: drill-down
   stack (folders → notes → editor), bottom-sheet folder switcher, etc.
2. **Migrate mobile to Supabase**: copy/adapt `SupabaseApiClient` into
   `packages/mobile/src/shared/supabase-api.ts` (using the noble crypto
   variant), add a `makeApiClient` factory parallel to desktop's,
   read URL + key from `expo-constants`/`app.json`.
3. **Apply the Meo design system**: replace `styles.ts` with the warm
   paper palette, MeoMark in `Icon.tsx`, serif fonts via `expo-font`.
4. **Reimplement the screens** to match `mobile.jsx`:
   - Folder list / drill-down navigation
   - Note list with title + preview + tags + relative time
   - Editor with title, folder field, markdown toolbar (subset for
     touch), tag chips, inline edit
5. **Long-press menus** as native action sheets via `@expo/react-native-action-sheet`
   (or a custom bottom sheet with the same items as the desktop
   `ContextMenu`). Note context, folder context, tag context.
6. **Folder + sub-folder creation**: same model as desktop (empty
   folders persisted in `AsyncStorage`/`SecureStore` prefs).
7. **Tags**: editor chip row + tag picker bottom sheet + tag filter in
   the folder list.
8. **Search**: full-screen modal triggered from a search icon in the
   header bar; exact-match nav, same as desktop ⌘K.
9. **AI controls in mobile**: rail at the bottom of the folder list
   screen (or in a Settings sheet), same on/off + model selector as
   desktop.

Only after all 9 steps does mobile reach **the desktop's current state**.
Then the LLM work in this doc can begin on mobile.

### 18a.4 Required AI work on top of catch-up

Once mobile is at parity, layer the LLM work in §16.1:

1. **Embedder**: `transformers.js` runs in RN's JSC, but it's slow.
   Decision point: keep it pure-JS (slow first-token but no native deps)
   or wire `transformers-rn` (real native ONNX runtime). Recommend
   pure-JS in v1.0 to keep the dev loop simple; revisit if perf is
   unacceptable.
2. **Vector store**: `op-sqlite` (already in `04-mobile.md`) plus a
   `note_vectors(note_id TEXT PRIMARY KEY, dim INT, vec BLOB)` table.
   Brute-force cosine in JS over the rows.
3. **BM25**: SQLite FTS5 over the same decrypted note content (held
   in memory only when the AI panel is open; the table itself stores
   plaintext in app sandbox, OK by spec §13.1).
4. **Local LLM runtime**: `llama.rn` integration (this requires
   `npx expo prebuild` - the one-way door called out in §4 and in
   `04-mobile.md`). Default model: Qwen 2.5 1.5B Q4.
5. **Apple FoundationModels**: small native module gated by
   `Platform.OS === 'ios' && Platform.Version >= '18'`.
6. **AI panel as a bottom sheet**: same conversation UI as desktop,
   adapted for touch.
7. **Settings → AI screen**: full-screen modal with the same
   "Local models" + "Embeddings" sections as desktop.

### 18a.5 Time estimate (honest)

| Phase | Days |
|---|---|
| Catch-up phase 1-9 (Supabase + design + screens + menus + folders + tags + search + AI controls UI) | 6-8 |
| AI work 1-7 (embeddings + vector store + BM25 + llama.rn + FoundationModels + AI panel + Settings) | 6-8 |
| **Total to bring mobile to spec parity with desktop including AI** | **12-16 days** |

Compare desktop AI-only work (~5-7 days) - mobile is meaningfully more
because it starts from further behind and `expo prebuild` is a costly
detour.

## 18. Out of scope

Explicit non-features so reviewers know what to expect:

- We do not run inference server-side on plaintext, ever.
- We do not store conversation history server-side.
- We do not have an "AI memory" feature that persists user-asserted
  facts across sessions. (Spec §3.3 already implicitly excludes it.)
- We do not allow workspace-wide LLM access from a different user's
  device, even on the same account; AI is tied to the device that has
  the master key.
- We do not implement model evaluation, leaderboards, or prompt
  templates as user-facing features in v1. Defaults are good defaults.

---

This document is the contract. Implementation of any AI feature must
either fit under one of these sections or trigger a change to this
document first.
