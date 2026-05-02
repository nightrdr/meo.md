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
| 2 | Editor feature parity with `../markdown-editor` + export | 3 | pending | `Editor.tsx`, new export pipelines, context menu | Mermaid + KaTeX plugins, export md/pdf/docx/txt/html. |
| 4 | Collapse / expand sections by heading rank | 2 | pending | `Editor.tsx` (TipTap plugin) | Priority H1>…>H6>p; collapsing collapses sub-sections. |
| 5 | Native macOS menu bar (App / File / Edit / View / Window) | 1 | pending | `src-tauri/lib.rs`, App.tsx command hooks | Match macOS Notes layout. Implement what's actually wired (New Note, Find, Sidebar toggle, etc.). |
| 6 | Dictation (native OS) + media insert (URL / file) + tier limits | 3 | pending | `Editor.tsx`, attachments, storage gates | WebSpeech API for dictation. Quotas enforced server-side via `attachments_create` + a notes-size RPC. |
| 7 | Model download backend service + first-run setup + LLM tier gating | 1 | pending | `packages/backend/internal/models/`, new Edge Fn, `Settings.tsx`, `aiStore.ts` | Hosted model files. Free tier sees "API keys only" UI; Business gets 200k free tokens via AI proxy. |
| 8 | Vault feature (always-locked notes) + 2FA (Business+) | 2 | pending | new `Vault*.tsx`, `Auth.tsx`, RPCs, context menu | TOTP via standard authenticator protocol. Vault re-prompts biometric/passphrase on access. |
| 9 | QR pairing for new device + device list / remove | 2 | pending | `Auth.tsx`, File menu (Agent 5), Settings | Device row tracks type/make/IP. Free tier = 1 device hard cap. |
| 10 | Paddle (web) + RevenueCat (mobile) + subscription mgmt + cross-store conflict UX | 1 | pending | new Edge Fns, `meo.subscriptions` schema, `Settings/Subscription.tsx`, App.tsx upgrade button | Refuse purchase on the wrong store, show "manage on \<other store\>". |
| 11 | Date-grouped notes list + sidebar toggle | 1 | shipped | `App.tsx`, `styles.css`, `Icon.tsx`, `storage.ts` | Today / Yesterday / Previous 7 / 30 Days / month / year groups via `groupNotesByDate`. Sidebar toggle button + ⇧⌘S, persisted via `setMeta({sidebar_hidden})`, wired to Agent 5's `onToggleSidebar`. |
| 12 | React Native apps (iOS / Android / desktop via macOS app store) | 4 | pending | new `packages/mobile-rn/` | RN-Tauri parity. Mobile uses ONLY models curated for mobile (Agent 7 hands the list); show alert on others. |

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
