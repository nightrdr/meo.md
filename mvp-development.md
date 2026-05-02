# MVP development tracker

Living source of truth for the v1.0 MVP roadmap. Each agent updates the
"Status" + "Notes" rows for its row when work lands. The orchestrator
uses this to know what's safe to build on top of.

## Pricing tiers (canonical — referenced by Agents 6, 7, 10)

| Tier | Price | Devices | Storage (notes + files) | Max attachment | LLM | Encryption | Other |
|---|---|---|---|---|---|---|---|
| **Free** | $0 | 1 | 1 GB | 10 MB | none on-device default; user-bring-key blocked | E2EE | upgrade nag |
| **Hobbyist** | $5/mo · $36/yr | 3 | 10 GB | 1 GB | frontier LLMs via user's API keys only | E2EE | — |
| **Business** | $25/mo · $180/yr | unlimited | 1 TB | 1 GB | 200k frontier tokens/mo + bring-your-own | E2EE + 2FA | — |
| **Enterprise** | custom | unlimited | custom | custom | custom | E2EE | plugins |

Token overage on Business: $5 / 100k tokens (Agent 7).

---

## Agents

| # | Title | Wave | Status | Files / surface | Notes |
|---|---|---|---|---|---|
| 1 | Biometric / OS unlock for already-signed-in user | 2 | pending | `Auth.tsx`, `src-tauri/lib.rs`, new keychain plugin | Touch ID on macOS, Windows Hello, libsecret on Linux. Fall back to passphrase. |
| 2 | Editor feature parity with `../markdown-editor` + export | 3 | shipped | `Editor.tsx`, `editor/mathExtension.ts`, `editor/mermaidExtension.ts`, `export.ts`, `App.tsx`, `Icon.tsx`, `ContextMenu.tsx`, `styles.css` | GFM tables (`@tiptap/extension-table*`) + ⌘⌥T 3×3 shortcut + toolbar picker grid. KaTeX inline `$x$` + block `$$x$$` as TipTap atom NodeViews (lazy `import('katex')`). Mermaid as a custom block NodeView (lazy `import('mermaid')`, debounced re-render, error placeholder). Markdown round-trip extended for all three node types via NUL/SOH-token re-insertion. Export pipelines (`exportNoteAsMarkdown`/`HTML`/`TXT`/`DOCX`/`PDF`): md = raw `note.body`, txt = regex-stripped, html = standalone doc with KaTeX CDN + Mermaid script, docx = `marked` lex → `docx` Paragraph/TextRun/Table mapping (lazy), pdf = popup window + `window.print()` fallback. Wired into note context menu (new "Export as ▸" submenu via `MenuEntry.items`) AND native File ▸ Export submenu (`onExport` reads `selectedIdRef.current`). |
| 4 | Collapse / expand sections by heading rank | 2 | shipped | `Editor.tsx`, new `editor/collapseExtension.ts`, `menus.ts`, `App.tsx`, `storage.ts`, `styles.css` | TipTap `meoCollapse` plugin (key `meo-collapse`); chevron widget on heading hover (persistent when collapsed) + `Decoration.inline` with `display:none`; "N items hidden" pill. ⌥⌘← / ⌥⌘→ collapse/expand current; ⇧⌥⌘← / ⇧⌥⌘→ collapse/expand all. Persisted as `meta.collapsed_headings: { [noteId]: ["<level>:<text>"] }`. Menu hooks `onCollapseSection`/`onExpandSection`/`onCollapseAllSections`/`onExpandAllSections` ride App-level CustomEvents (`meo:collapse-section` etc.) — Agent 5 native menu items not yet shipped, so the click path is keyboard-only for now. Markdown round-trip preserved (collapse is a view-only decoration). |
| 5 | Native macOS menu bar (App / File / Edit / View / Window) | 1 | shipped | `src-tauri/lib.rs`, `src/menus.ts`, App.tsx | macOS-only rich custom menu; ids forwarded to JS as `menu://<id>` events via `useMenuEvents`. Wired: About, Settings, New Note, New Folder, Search Notes, Find, Ask Meo, Toggle Sidebar; predefined Edit/Window/quit items intact. Stubbed (console.warn until destination tracks ship): Export/Import/Print/Insert-Link/New-Tag/New-Device/mode-change. Win/Linux: no menu (intentional — JS keyboard handlers cover the same shortcuts). |
| 6 | Dictation (native OS) + media insert (URL / file) + tier limits | 3 | shipped | `Editor.tsx`, `dictation.ts`, `AttachmentRenderer.tsx`, `Icon.tsx`, `Settings/Subscription.tsx`, `packages/shared/src/attachments.ts`, `supabase-api.ts`, migration `*_tier_limits.sql`, `styles.css` | **Dictation**: WebSpeech wrapper (`dictation.ts`) probes `window.SpeechRecognition || webkitSpeechRecognition` at mount; mic toolbar button hidden when unavailable (Linux without speech-dispatcher integration). Live partial = TipTap mark `meoDictationPartial` (dotted underline + 65% opacity); on `isFinal` the partial is wiped and the chunk is committed as plain text. Esc / second click / 3s silence → clean stop. ⌃⌥D shortcut. Pulsing red status pill above toolbar when hot. Auto-restart inside the wrapper handles Chromium's ~60s session cap. **Media insert**: Video + Audio toolbar buttons open a small modal with two tabs — *From URL* writes raw `<video src="…" controls>` / `<audio …>` HTML into the markdown body (CommonMark passes through; round-trip preserved in `htmlFromMarkdown`/`walk()`); *From file* reuses the existing E2EE attachment pipeline (per-attachment HKDF key, AES-GCM, signed URL). New `AttachmentVideoExtension` + `AttachmentAudioExtension` TipTap nodes use the same `attachment:<id>` URL prefix as images and decrypt-to-blob-URL via the shared `useDecryptedAttachment` hook. Image picker `accept` attr broadened to png/jpg/jpeg/gif/webp/svg/avif. **Tier-aware limits**: `tierLimits(tier)` helper in `@meo/shared` returns `{maxAttachmentBytes, totalStorageBytes}` for free/hobbyist/business/enterprise. New SQL migration `*_tier_limits.sql` adds `meo.tier_limits(uuid)`, `meo.note_size_check(uuid, int)`, `meo.storage_usage()` RPC; rewrites `attachments_create` and `upsert_note` to consult tier limits, raising **P0007 = attachment_too_large** and **P0008 = storage_cap_exceeded**. `mapPgError` translates both to HTTP 413. Editor pre-validates file size before upload and surfaces a humanized "exceeds your tier's 10 MB limit. Upgrade to Hobbyist for up to 1 GB." banner with an "Upgrade" button → opens Settings → Subscription. Settings → Subscription gains a `<StorageUsageBar>` (proportional fill, `warn` at 85%, `over` at 100%) reading from `getStorageUsage()`. Notes ciphertext counts toward the same workspace cap as attachments. |
| 7 | Model download backend service + first-run setup + LLM tier gating | 1 | shipped | `packages/backend/internal/models/`, `Settings.tsx`, `Onboarding.tsx`, `modelDownload.ts`, `session.ts`, `storage.ts` | Hosted manifest + Range-resumable streaming, sha256-verified admin upload. First-run Onboarding downloads defaults; tiered cloud-LLM section. |
| 8 | Vault feature (always-locked notes) + 2FA (Business+) | 2 | shipped | `Vault.tsx`, `TFA.tsx`, `Settings/Security.tsx`, `crypto.ts`, `meo.notes.is_vault`, `meo.tfa_secrets`, `tfa-enroll`/`tfa-verify` Edge Fns, `App.tsx` | Vault key = HKDF-SHA256(masterRaw, salt=user_id, info='vault:v1'); body wrapped before outer AES-GCM. TOTP secret AES-GCM'd with `TFA_KEK`; cold-start TFA gate for Business+. |
| 9 | QR pairing for new device + device list / remove | 2 | shipped | `Auth.tsx`, `Pairing.tsx`, `Settings/Devices.tsx`, `pairing.ts`, migrations | X25519 + HKDF-SHA256 + AES-GCM. 60s handovers row, pg_cron purge every 5m. Settings → Devices + per-device sign-out; cap enforced in `meo.upsert_note`. |
| 10 | Paddle (web) + RevenueCat (mobile) + subscription mgmt + cross-store conflict UX | 1 | shipped | `meo.subscriptions/usage_log/devices` migration + paddle/RC webhooks + `Settings/Subscription.tsx` + upgrade banner | HMAC-verified Paddle + bearer-verified RC webhooks, 409 cross-store guard. |
| 11 | Date-grouped notes list + sidebar toggle | 1 | shipped | `App.tsx`, `styles.css`, `Icon.tsx`, `storage.ts` | Today / Yesterday / Previous 7 / 30 Days / month / year groups via `groupNotesByDate`. Sidebar toggle button + ⇧⌘S, persisted via `setMeta({sidebar_hidden})`, wired to Agent 5's `onToggleSidebar`. |
| 12 | React Native apps (iOS / Android / desktop via macOS app store) | 4 | shipped (MVP scaffold) | `packages/mobile-rn/` (bare RN 0.81 + react 19; workspace dep on `@meo/shared`) | Buildable RN 0.81 / React 19 scaffold targeting iOS, Android, and macOS via `react-native-macos`. Ships: email-OTP auth (`requestEmailOtp`/`verifyEmailOtp`) → setup-or-unlock → read-only notes list (decrypts via `decryptNote`) → markdown-source note view → Settings (tier label + store-aware Manage button + AI placeholder + mobile-only model curated alert) + RevenueCat `Purchases.configure` scaffold (no real key yet). iOS+Android JS bundles green via `react-native bundle`. macOS native project requires `npx react-native-macos-init` (one-off, documented in README). **Deferred to Phase 2** (see `packages/mobile-rn/README.md`): editor write-side, biometric unlock, vault, 2FA, QR pairing, AI panel + curated mobile models, attachments, search, date-grouped list, sidebar toggle, dictation, export, devices/security panes, real RevenueCat key+IAP, native menu bar. The existing Expo `packages/mobile/` is unchanged and still ships to TestFlight. |

---

## Architectural decisions (locked)

- **Encryption**: stays E2EE. All tier features ride on top of the existing master-key pipeline. No tier downgrades crypto.
- **Auth**: Email-OTP (already shipped). Biometric unlock = local convenience layer that decrypts a keychain-stored master key on Touch ID success. Master key still derived from passphrase on first install.
- **Storage**: iDrive remains the production durable backend for attachments. Self-hosted Supabase Storage (MinIO) is dev only.
- **AI runtime**: local-first wherever possible. Cloud LLMs are a tier feature; never required for core function.
- **Cross-platform UX**: keyboard shortcuts must show platform-appropriate modifiers (already done via `platform.ts`). New native code must `#[cfg]`-gate macOS-specific paths.

---

## Open product questions (need decisions before relevant agent runs)

- **Agent 7**: which models do we host? Suggested set: `qwen2.5-1.5b-q4`, `qwen2.5-7b-q4`, `llama3.1-8b-q4`. Mobile gets only the 1.5B by default (size).
- **Agent 8**: vault unlock — biometric required, or passphrase optional? Recommend biometric required + passphrase fallback.
- **Agent 9**: QR payload format. Recommend a one-time signed bundle: `{master_key_wrapper, signed_jwt_for_new_device, expires_at}` — signed by the existing device's symmetric key, valid for 60 seconds.
- **Agent 10**: free-tier upgrade nag — modal on cold start, persistent banner above Ask Meo, or both? User said "Show upgrade button for free users just above ask meo" → settle on the persistent banner.
- **Agent 12**: ship sequence — TestFlight first, then Play Store, then Mac App Store. RN-desktop only after iOS+Android stable.

---

## Wave plan (orchestrator's notes)

**Wave 1 — independent, parallel via worktrees** (in flight):
- Agent 5 (native menus)
- Agent 7 (model backend)
- Agent 10 (payments)
- Agent 11 (date list + sidebar toggle)

**Wave 2 — after Wave 1 merges** (parallel):
- Agent 1 (biometric unlock) — depends on Wave 1's keychain shape
- Agent 4 (collapse sections) — TipTap plugin, isolated
- Agent 8 (vault) — depends on Agent 1's biometric primitive
- Agent 9 (QR pairing) — adds File-menu item from Agent 5

**Wave 3 — sequential because they all touch Editor.tsx**:
- Agent 2 (markdown-editor parity + export)
- Agent 6 (dictation + media + storage limits)

**Wave 4 — large independent track** (long-running):
- Agent 12 (React Native apps) — scoped to MVP: auth + sync + basic editor + payments. Feature parity is a follow-on.
