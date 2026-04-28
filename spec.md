**meo.md**

Technical Specification --- v1.0

*Backend, Desktop, and Mobile Architecture*

**1. Overview**

meo.md is a privacy-first, end-to-end encrypted markdown notes
application with multi-device sync and local AI capabilities. **The
product targets privacy-conscious knowledge workers willing to pay
\$9+/month** for a notes app that combines premium UX (Notes-app feel),
full markdown power (KaTeX, Mermaid, code), local AI features, and
zero-knowledge encryption.

This spec covers the v1 scope across three components: the backend
(self-hosted Supabase), the desktop app (Tauri), and the mobile app
(React Native). Voice transcription, real-time collaboration, and web
app are explicitly deferred to v1.5+.

**1.1 Core principles**

- Local-first: every device holds a complete encrypted copy of all
  notes. Offline operation is the default state.

- Zero-knowledge server: encryption keys never leave user devices.
  Server stores only encrypted blobs and metadata required for sync.

- Shared Rust core: cryptography, sync, and AI orchestration logic live
  in a single Rust crate consumed by both Tauri (desktop) and React
  Native (mobile via uniffi-rs).

- Single product, two shells: the UI is platform-native (DOM on desktop,
  native on mobile) but features and data model are identical.

**1.2 High-level architecture**

┌─────────────────────────────────────────────────────────────┐

│ CLIENT DEVICES (trust boundary) │

├──────────────────────────┬──────────────────────────────────┤

│ Tauri desktop │ React Native mobile │

│ React + TipTap UI │ RN + TenTap UI │

│ Rust core (direct) │ Rust core (via uniffi-rs) │

│ whisper.cpp, llama.cpp │ whisper.cpp, llama.cpp (NDK) │

└──────────┬───────────────┴────────────┬─────────────────────┘

│ Encrypted blobs only │

▼ ▼

┌─────────────────────────────────────────────────────────────┐

│ SELF-HOSTED SUPABASE (untrusted) │

│ GoTrue auth │ Postgres │ Storage (S3) │ Realtime │ RLS │

│ meo schema (notes, devices, accounts, attachments) │

└─────────────────────────────────────────────────────────────┘

**2. Backend (self-hosted Supabase)**

Backend runs on existing self-hosted Supabase infrastructure. meo.md
uses its own Postgres schema (meo) that shares the auth.users table with
markdowneditoronline.com but isolates content tables completely.

**2.1 Authentication**

Supabase GoTrue handles email/password authentication. Two distinct
credentials per user:

- Account password: hashed by GoTrue (bcrypt). Used to log in and
  receive a JWT. This password CAN be reset via email.

- Encryption passphrase: never sent to server. Used client-side with the
  Secret Key to derive the unlock key. CANNOT be reset by the server.

**Critical separation:** the account password lets you sign in. The
encryption passphrase lets you decrypt notes. Losing the account
password is recoverable. Losing the encryption passphrase + Secret Key
is not.

**2.2 Database schema**

The meo schema contains the following tables (all with row-level
security enforcing user_id = auth.uid()):

**meo.accounts**

user_id uuid PRIMARY KEY REFERENCES auth.users(id)

argon2_salt bytea NOT NULL

encrypted_master_key bytea NOT NULL \-- AES-GCM ciphertext

master_key_nonce bytea NOT NULL

argon2_params jsonb NOT NULL \-- {m,t,p} for forward compat

created_at timestamptz DEFAULT now()

**meo.devices**

id uuid PRIMARY KEY

user_id uuid REFERENCES auth.users(id)

device_name text NOT NULL

device_pubkey bytea NOT NULL \-- X25519 public key

platform text \-- \'mac\', \'win\', \'linux\', \'ios\', \'android\'

last_sync_at timestamptz

revoked_at timestamptz

created_at timestamptz DEFAULT now()

**meo.notes**

id uuid PRIMARY KEY

user_id uuid REFERENCES auth.users(id)

encrypted_content bytea NOT NULL \-- AES-GCM blob

nonce bytea NOT NULL

version bigint NOT NULL \-- monotonic for sync

hlc_timestamp text NOT NULL \-- hybrid logical clock

updated_at timestamptz NOT NULL

deleted_at timestamptz \-- tombstone

size_bytes int

The encrypted_content blob contains the entire note: title, markdown
body, folder path, tags, links, embeddings. Server cannot read any of
it.

**meo.attachments**

id uuid PRIMARY KEY

note_id uuid REFERENCES meo.notes(id)

user_id uuid REFERENCES auth.users(id)

storage_key text NOT NULL \-- random UUID, no semantic info

storage_backend text NOT NULL \-- \'supabase\', \'r2\', \'idrive\'

encrypted_size bigint NOT NULL \-- size of ciphertext on disk

nonce bytea NOT NULL \-- AES-GCM nonce for content

encrypted_metadata bytea NOT NULL \-- AES-GCM blob: {filename,

\-- mime_type, dimensions,

\-- duration, checksum}

metadata_nonce bytea NOT NULL

created_at timestamptz DEFAULT now()

**meo.subscriptions**

user_id uuid PRIMARY KEY REFERENCES auth.users(id)

paddle_customer_id text \-- ctm_xxx from Paddle

paddle_sub_id text \-- sub_xxx from Paddle

paddle_price_id text \-- pri_xxx (monthly vs annual)

plan text \-- \'trial\', \'pro\', \'expired\'

status text \-- \'active\', \'past_due\', \'canceled\', \'paused\'

trial_ends_at timestamptz

current_period_end timestamptz

update_url text \-- Paddle-hosted portal URL

cancel_url text \-- Paddle-hosted cancel URL

**2.3 Storage layer (S3-compatible, client-encrypted)**

**Backend:** Supabase Storage (S3-compatible) for v1, since it ships
with self-hosted Supabase and integrates with RLS. Migration path to
Cloudflare R2 (no egress fees) or iDrive e2 (cost-optimized,
EU-resident) is straightforward at scale --- the storage abstraction in
the Rust core treats all backends as opaque S3 endpoints.

**Bucket configuration:**

- Single private bucket: meo-attachments

- Public access: disabled. All access via short-lived signed URLs
  (15-minute TTL) issued by the API after JWT + RLS check

- Object keys: random UUIDs only --- no filename, mime type, or note ID
  encoded in the key (prevents semantic metadata leakage via S3 logs)

- Server-side encryption-at-rest (SSE) enabled as defense-in-depth, but
  is NOT the privacy guarantee --- every byte uploaded is already
  client-side ciphertext

**Upload contract (client → server):**

- Client encrypts file bytes with per-attachment key (see §3.8) →
  produces ciphertext blob + nonce + auth tag

- Client requests a signed PUT URL: POST /attachments/upload-url with
  {note_id, encrypted_size, mime_hint}

- Server validates JWT, checks user owns the note, returns signed URL +
  storage_key

- Client uploads ciphertext directly to S3 endpoint via the signed URL

- Client confirms upload: POST /attachments/confirm with {storage_key,
  nonce, encrypted_size, encrypted_metadata_blob} → server inserts row
  into meo.attachments

**Download contract (server → client):**

- Client requests signed GET URL: GET /attachments/{id}/download-url

- Server validates ownership, issues signed URL

- Client fetches ciphertext directly from S3

- Client decrypts locally using per-attachment key derived from master
  key

**Critical privacy property:** the server only ever sees ciphertext
blobs and ownership metadata. Mime type, original filename, and any
other identifying file metadata are encrypted as part of the
per-attachment metadata blob (see §3.8). The S3 backend itself never
holds plaintext bytes of any media file at any point.

**2.4 Sync API**

Sync uses two mechanisms in combination:

- Polling endpoint (REST): GET /sync/notes?since=\<version\> returns all
  notes updated after the given version. Idempotent and resumable.

- Realtime subscriptions (WebSocket): clients subscribe to Postgres
  changes on meo.notes filtered by user_id. When another device writes,
  all subscribed devices receive a push.

Conflict resolution for v1: **last-write-wins by HLC timestamp**. When
two devices edit the same note offline and reconnect, the later HLC
wins; the loser\'s content is preserved as a \'Conflicted copy
\[date\]\' note. CRDT-based merge is deferred to v2.

**2.5 AI proxy (separate service)**

AI proxy runs as a small Hono/Bun service alongside Supabase, NOT as
Edge Functions (better streaming, easier scaling). Responsibilities:

- Validate Supabase JWT on every request

- Check subscription status before forwarding

- Forward to Anthropic / OpenAI APIs

- Stream responses back to client

- Log token usage per request (NEVER prompt or response content)

**Privacy contract:** the proxy is a metered passthrough. Request and
response bodies are not persisted. Only {user_id, model, tokens_in,
tokens_out, timestamp} are written to a usage table for billing.

**2.6 Billing (Paddle)**

**Paddle (Merchant of Record):** chosen over Stripe because Paddle
handles global sales tax, VAT, and GST collection/remittance. For an
India-based founder selling to global customers in USD, this avoids
Stripe India\'s RBI compliance restrictions on international SaaS
subscriptions and eliminates multi-jurisdiction tax registration burden.

- Paddle Billing API (not Paddle Classic --- which is being deprecated)

- 14-day free trial, no payment method required at signup

- \$9/month or \$90/year (save 17%)

- Paddle.js overlay checkout embedded in app for upgrade flow

- Paddle-hosted customer portal for subscription management (linked from
  app settings)

- Webhook handler subscribes to: subscription.created,
  subscription.updated, subscription.canceled, transaction.completed,
  transaction.payment_failed

- Trial expiry blocks sync but preserves all local data on each device

- Disputes and chargebacks handled by Paddle as MoR --- founder is
  insulated

**Pricing economics:** Paddle fees are \~5% + \$0.50 per transaction. At
\$9/mo, \~\$0.95 in fees, \$8.05 net. At \$90/yr, \~\$5 in fees, \$85
net. Higher than Stripe (2.9% + \$0.30) but eliminates accounting
overhead and India-specific compliance work.

**3. Shared Rust core**

The Rust core is the heart of meo.md. It contains all cryptographic
operations, sync logic, AI orchestration, and storage abstraction. Built
once, consumed by both Tauri (native Rust binding via tauri::command)
and React Native (via uniffi-rs generated Swift/Kotlin bindings).

**3.1 Module layout**

core/

├── crypto/

│ ├── kdf.rs \# Argon2id key derivation

│ ├── aead.rs \# AES-256-GCM encrypt/decrypt

│ ├── hkdf.rs \# Per-note key derivation

│ └── secret_key.rs \# 128-bit Secret Key generation

├── enrollment/

│ ├── qr.rs \# QR code generation/parsing

│ ├── ephemeral.rs \# X25519 keypair for pairing

│ └── bundle.rs \# Encrypted handoff payload

├── notes/

│ ├── note.rs \# Note model (title, body, folder, tags)

│ ├── encrypt.rs \# Note → encrypted blob

│ └── decrypt.rs \# Encrypted blob → note

├── sync/

│ ├── client.rs \# Sync API HTTP client

│ ├── conflict.rs \# HLC-based conflict resolution

│ └── realtime.rs \# WebSocket subscription

├── search/

│ ├── fts.rs \# FTS5 full-text indexing

│ ├── embeddings.rs \# Vector generation via Transformers

│ └── vector.rs \# sqlite-vec similarity search

├── ai/

│ ├── local.rs \# llama.cpp wrapper for local LLMs

│ ├── cloud.rs \# Cloud LLM via proxy

│ └── rag.rs \# RAG over notes (retrieval + generation)

├── storage/

│ ├── sqlite.rs \# SQLCipher database

│ ├── attachments.rs \# Encrypted file storage

│ └── keychain.rs \# OS-secure-storage abstraction

├── export/

│ ├── markdown.rs \# MD passthrough

│ ├── pdf.rs \# MD → HTML → PDF (printpdf or weasyprint)

│ ├── docx.rs \# MD → DOCX (docx-rs)

│ └── plaintext.rs \# MD → stripped text

└── lib.rs \# Public API

**3.2 Cryptography**

**Primitives:** Argon2id for KDF, AES-256-GCM for encryption,
HKDF-SHA256 for key derivation, X25519 + ChaCha20-Poly1305 for device
pairing.

**Key hierarchy:**

- Passphrase + Secret Key + per-user salt → Argon2id (m=64MB, t=3, p=4)
  → 256-bit Unlock Key

- Unlock Key → AES-GCM-decrypt(encrypted_master_key) → 256-bit Master
  Key

- Master Key + note_id → HKDF-SHA256 → per-note key (each note encrypted
  independently)

- Per-note key → AES-256-GCM → encrypted note blob

**Secret Key:** 128-bit random value generated at signup. Shown to user
once in an Emergency Kit PDF. Stored on each device\'s OS keychain
(Touch ID / Face ID / Windows Hello / Android Keystore wrapped). Never
sent to server.

**3.3 Note model**

struct Note {

id: Uuid,

title: String,

body: String, // Markdown source

folder_path: Vec\<String\>, // \[\'Work\', \'Projects\', \'Q1\'\]

tags: Vec\<String\>,

links: Vec\<NoteLink\>, // \[\[wiki-style\]\] references

attachments: Vec\<AttachmentRef\>,

embedding: Option\<Vec\<f32\>\>, // 384-dim, generated locally

created_at: DateTime\<Utc\>,

updated_at: DateTime\<Utc\>,

hlc: HybridLogicalClock,

version: u64,

}

This entire struct gets serialized (CBOR), encrypted with the per-note
key, and stored as the encrypted_content blob. Every field is invisible
to the server.

**3.4 Folder hierarchy**

Folders are NOT a separate database concept. Each note carries its own
folder_path as an array of strings (e.g., \[\'Work\', \'Projects\', \'Q1
Planning\'\]). The UI builds the folder tree by walking all notes\'
paths.

**Why this design:** no separate folders table means no folder schema to
keep in sync, no folder-renaming edge cases, no orphaned folders.
Renaming a folder = rewriting folder_path on all affected notes.
Sub-folders are unlimited depth, free.

**3.5 Search architecture**

**Full-text search:** SQLite FTS5 index over decrypted note content.
Index lives in the local SQLCipher database --- encrypted at rest,
plaintext only when the database is unlocked. Server never holds the FTS
index.

**Vector search:** embeddings generated locally using all-MiniLM-L6-v2
(384-dim, \~80MB model) via Transformers.js or candle. Stored in
sqlite-vec virtual tables. Cosine similarity runs locally over the
user\'s own corpus.

**Hybrid retrieval:** RAG-over-notes uses BM25 (FTS5) + vector
similarity, reranked by a small local cross-encoder. Top-k results pass
to the LLM (local or cloud) for synthesis.

**3.6 Local LLM integration**

- Bundled: llama.cpp wrapper (llama-cpp-rs)

- Default model: Qwen2.5-3B-Instruct-Q4 (\~2.2GB) --- downloaded on
  first use, cached

- Power users can add: Llama-3.2-3B, Phi-3.5-mini, Gemma-2-2B

- Use cases: summarize, autocomplete, ask-this-note, semantic search
  synthesis

- Cloud fallback for heavy queries: opt-in, routed via AI proxy with
  explicit user consent

**3.7 Export**

All exports run locally. Source markdown is the canonical format; other
formats are derived.

- Markdown: direct file write, with frontmatter for metadata (tags,
  dates)

- Plaintext: markdown stripped of formatting via pulldown-cmark

- PDF: markdown → HTML (with KaTeX/Mermaid pre-rendered) → PDF via
  weasyprint binding or chromium-headless on desktop

- DOCX: markdown → AST → docx-rs construction

- Bulk export: \'Export folder\' produces a zip with the chosen format,
  attachments included

**3.8 Media encryption pipeline**

Media (images, PDFs, audio, arbitrary file attachments) follows a
separate encryption pipeline from notes because attachments can be large
(up to 100MB per file) and must support streaming encrypt/decrypt to
avoid loading entire files into memory.

**Per-attachment key derivation:**

- attachment_id = random Uuid (v4)

- attachment_key = HKDF-SHA256(master_key, info = \"attachment:\" \|\|
  attachment_id) → 256-bit key

- Each attachment gets its own key. Compromise of one attachment key
  cannot decrypt others.

**Content encryption (the file bytes):**

- Cipher: AES-256-GCM in streaming mode (chunked, 1MB chunks)

- Each chunk uses a derived per-chunk nonce: nonce_base \|\| chunk_index
  (96-bit)

- nonce_base = 64-bit random, generated once per attachment, stored in
  meo.attachments.nonce

- Chunk auth tags concatenated; final auth tag covers the entire file

- Streaming design allows progressive upload and partial decrypt for
  previews (e.g., first chunk of an image)

**Metadata encryption (filename, mime, dimensions):**

- Sensitive metadata is itself encrypted, NOT stored in plaintext
  columns

- Metadata struct: { filename, mime_type, dimensions?, duration?,
  sha256_checksum, original_size }

- Serialized as CBOR, encrypted with AES-256-GCM using attachment_key
  with a separate nonce

- Stored in meo.attachments.encrypted_metadata + metadata_nonce

- **Why this matters:** without metadata encryption, a server-side
  attacker could see that a user has \"medical-scan-2026.pdf\" attached
  even if they can\'t read it. With metadata encryption, the server sees
  only an opaque blob of unknown type.

**Streaming encrypt flow (upload):**

1\. Client picks file → reads bytes via async stream

2\. Client generates attachment_id, derives attachment_key

3\. Client generates 64-bit nonce_base

4\. For each 1MB chunk:

\- nonce = nonce_base \|\| chunk_index

\- ciphertext_chunk = AES-GCM-encrypt(chunk, attachment_key, nonce)

\- Stream ciphertext_chunk to S3 PUT URL

5\. Encrypt metadata blob with attachment_key (separate nonce)

6\. POST /attachments/confirm with all encrypted metadata

7\. Add AttachmentRef to note: {attachment_id, encrypted thumbnail?}

8\. Re-encrypt and sync the note with new AttachmentRef

**Streaming decrypt flow (download):**

1\. Client fetches signed GET URL for ciphertext

2\. Client streams ciphertext, decrypts chunk-by-chunk

3\. Decrypted bytes → temp file in app sandbox (not iCloud-backed)

4\. Decrypt encrypted_metadata to recover filename, mime, etc.

5\. Render in editor / open with system viewer

6\. Temp file zeroed and deleted on close

**Thumbnails (for performance):**

- Generated client-side at upload time

- Encrypted with same attachment_key (different nonce)

- Stored as separate small object in S3 OR inlined in the note\'s
  encrypted blob if \<50KB

- Allows showing image previews in note list without downloading full
  attachment

**Size limits and quotas:**

- Per-attachment max: 100MB (configurable per plan)

- Per-account quota: 10GB on Pro tier (signaled to client; enforced
  server-side via SUM(encrypted_size))

- Free trial: same as Pro for trial duration

- Quota check on /attachments/upload-url request --- returns 413 if
  exceeded

**Garbage collection:**

- When a note is deleted (tombstoned), referenced attachments are NOT
  immediately deleted from S3

- Background job runs daily: finds attachment rows with no live note
  references, deletes from S3, then deletes the row

- This avoids race conditions where another device hasn\'t yet seen the
  deletion

- Hard deletion happens after 30-day grace period

**4. Desktop application (Tauri)**

Single Tauri 2.x application targeting macOS, Windows, and Linux. UI is
React + Vite + TypeScript. Styling via Tailwind + shadcn/ui.

**4.1 UI design language**

**Reference: macOS Notes app.** Three-pane layout: folder sidebar
(left), note list (middle), editor (right). Resizable panes. Native-feel
context menus, keyboard shortcuts (Cmd+N new, Cmd+F find, Cmd+/ AI,
Cmd+K quick switcher), and drag-and-drop for folder reorganization.

**Visual style:** neutral light/dark themes following system. Subtle
borders, generous whitespace, native-feeling typography (SF Pro on Mac,
Segoe UI on Windows, Inter on Linux). No Notion-style block UI ---
meo.md is a writing tool, not a database.

**4.2 Editor**

- TipTap-based markdown editor (ProseMirror under the hood)

- Markdown engine reused from markdowneditoronline.com (*code to be
  provided separately*) --- KaTeX for math, Mermaid for diagrams,
  Prism/Shiki for syntax highlighting, GFM tables, task lists, footnotes

- Slash commands (/), markdown shortcuts (# for heading, \*\* for bold),
  wiki-style \[\[note links\]\]

- Live preview: edits render inline (CodeMirror-style) rather than
  split-pane

**4.3 Local capabilities**

- SQLCipher database in app data directory, biometric-unlocked at
  startup

- File watcher for export-to-folder feature (one-way export to disk)

- Native menubar integration: Cmd+Shift+N to capture from anywhere

- Spotlight integration on macOS (CSImporter) --- encrypted index,
  opt-in

**4.4 Sync**

- Background sync runs every 30 seconds while idle, every 5 seconds
  while editing

- Realtime WebSocket subscription pushes remote updates within \~1
  second

- Offline-first: all features work without internet; sync resumes when
  reconnected

**5. Mobile application (React Native)**

Single Expo-managed React Native app targeting iOS 15+ and Android 8+.
EAS Build handles signing and distribution.

**5.1 UI design language**

Native feel is non-negotiable at \$9+/mo pricing. Use platform
navigation patterns:

- iOS: native navigation stack via Expo Router, swipe-to-go-back,
  pull-to-refresh, sheet presentations

- Android: Material 3 patterns, bottom sheets, native back gesture

- Reanimated 3 + Gesture Handler for all animations (smooth
  swipe-to-delete on note list, pinch-to-zoom on attachments)

- Same three-pane mental model as desktop, adapted: folder list → note
  list → editor as drilldown navigation

**5.2 Editor**

- TenTap (@10play/tentap-editor) --- TipTap embedded in WebView with
  React Native bridge

- Same TipTap extensions as desktop (KaTeX, Mermaid, code) so authoring
  experience is consistent

- Native keyboard accessory bar with markdown shortcuts (heading, bold,
  list, code)

- Mobile-optimized slash menu and quick-tag picker

**5.3 Local storage and sync**

- op-sqlite with SQLCipher for encrypted local database

- Expo SecureStore + LocalAuthentication for biometric Secret Key
  wrapping

- Background fetch for sync (iOS BGAppRefreshTask, Android WorkManager)

- Push notifications for cross-device updates (silent push, content
  delivered via sync)

**5.4 Media handling**

All media goes through the streaming encryption pipeline defined in
§3.8. The mobile app provides platform-specific capture sources but
never bypasses the encryption layer.

- Image picker (Expo ImagePicker) → bytes streamed to Rust core →
  encrypted chunks → S3 upload

- Document picker (Expo DocumentPicker) for PDF/file attachments ---
  same pipeline

- Camera integration (Expo Camera) for direct photo-to-note --- captured
  bytes encrypted before any disk write

- Image preview: thumbnails decrypted on demand, full image decrypted to
  temp sandbox file when opened

- PDF preview: decrypted to temp sandbox file, rendered via
  react-native-pdf, file zeroed on close

- On Android: temp files written to app-private directory (not external
  storage), excluded from MediaStore indexing

- On iOS: temp files in app sandbox, excluded from iCloud backup via
  NSURLIsExcludedFromBackupKey

**5.5 Local AI on mobile**

- llama.cpp via custom RN turbo module --- NDK build for Android,
  Metal-optimized for iOS

- Default model: Qwen2.5-1.5B-Q4 (\~1GB) for mobile --- smaller than
  desktop default due to memory constraints

- Embedding model: all-MiniLM-L6-v2 (\~80MB) for vector search

- Cloud fallback for heavy queries, opt-in per request

**6. Cross-cutting concerns**

**6.1 New device enrollment**

Two paths from a fresh install:

- **QR pairing (preferred):** new device shows QR with ephemeral X25519
  public key. Existing logged-in device scans, encrypts {Secret Key,
  master key} with that pubkey, uploads to server. New device polls,
  decrypts locally. \~60 seconds end-to-end.

- **Manual entry (fallback):** user types email + passphrase + Secret
  Key from Emergency Kit PDF. Slower but works without access to another
  device.

**6.2 Recovery model**

Three recovery scenarios, with explicit messaging in onboarding:

- Forgot account password: standard email reset via Supabase. Restores
  login but does NOT decrypt notes.

- Forgot encryption passphrase + still have a logged-in device: enroll
  new device via QR, then change passphrase from Settings.

- Lost all devices + lost passphrase + lost Emergency Kit: notes are
  unrecoverable. This is the privacy guarantee.

**6.3 Subscription enforcement**

- Trial: full features for 14 days, banner counts down

- Active: full sync + cloud AI

- Expired: local features continue, sync paused, banner prompts
  subscription

- All local data preserved indefinitely regardless of subscription state

**6.4 Threat model and disclosures**

What meo.md protects against: server compromise, subpoena of meo.md
servers, employee misuse, network observers (TLS), passive metadata
harvesting at rest.

What meo.md does NOT protect against: compromised user device, weak
passphrase combined with leaked Secret Key, OS-level keylogging, screen
capture by other apps with permission, malicious modifications to the
meo.md client itself (mitigated by open-source crypto core +
reproducible builds).

**6.5 Metadata leakage (honest disclosure)**

Server can see (and we disclose this on the security page):

- User account email and authentication state

- Number of notes per user, total encrypted bytes, sync activity
  timestamps

- Number of devices enrolled, device names, last-sync times

- Subscription tier and billing status

Server cannot see: note titles, content, folder structure, tags, links,
attachment contents, search queries, AI prompts.

**7. v1 scope summary**

**7.1 In scope**

- Core editing: TipTap markdown editor with KaTeX, Mermaid, code
  highlighting, GFM

- Folder hierarchy with unlimited sub-folders (path-based, no separate
  table)

- Tags and wiki-style \[\[note links\]\]

- Full-text search (SQLite FTS5) and semantic search (sqlite-vec + local
  embeddings)

- Local LLM Q&A over notes (Qwen2.5 default, configurable)

- Cloud LLM fallback (opt-in, via AI proxy)

- E2EE storage: Argon2id + AES-256-GCM with passphrase + Secret Key

- Multi-device sync via self-hosted Supabase, QR-based enrollment

- Encrypted media attachments (images, PDFs, files)

- Export: markdown, PDF, DOCX, plaintext (single note + bulk folder)

- Tauri desktop (Mac, Windows, Linux), React Native mobile (iOS,
  Android)

- Biometric unlock on every platform

- Paddle billing (MoR): 14-day trial, \$9/mo or \$90/yr

**7.2 Explicitly NOT in v1**

- Voice transcription (v1.5)

- Web app (v2)

- Real-time collaborative editing (v2)

- Public note sharing via links (v2)

- CRDT-based merge (v2 --- last-write-wins is sufficient for v1)

- Browser extension / web clipper (v1.5)

- Plugin marketplace (v3 or never)

- Team / family plans (v2)

- Note version history beyond local undo (v1.5)

**7.3 Implementation sequence**

- Weeks 1--3: Rust core --- crypto module with property-based tests,
  then KDF, then storage abstraction

- Weeks 4--5: Backend --- Supabase schema, RLS, sync API, AI proxy

- Weeks 6--9: Tauri desktop --- UI shell, editor integration, sync,
  search, export

- Weeks 10--12: React Native mobile --- same feature set against the
  shared Rust core

- Week 13: Private beta with \~20 users; bug fixes

- Week 14: Public launch (Product Hunt, Hacker News, privacy subreddits)

*End of specification --- v1.0*
