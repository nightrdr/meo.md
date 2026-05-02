# @meo/mobile-rn — React Native shell (iOS / Android / macOS)

MVP scaffold for a single React Native codebase that targets iOS,
Android, and macOS (via [`react-native-macos`][rnm]). Created with
`@react-native-community/cli init` (RN 0.81.6, React 19.1.4) so it
maps cleanly to the standard Xcode + Gradle templates.

[rnm]: https://microsoft.github.io/react-native-macos/

## Why a separate package from `packages/mobile/`?

`packages/mobile/` is the existing **Expo** project that already runs
on iOS and Android. It has the AI runtime (llama.rn, op-sqlite,
foundation) wired up and is what ships to TestFlight today.

`packages/mobile-rn/` is the **bare RN port** scoped to:

- macOS via `react-native-macos` (Mac App Store distribution path —
  Tauri can't be used here because it has no RevenueCat support)
- a future consolidation onto a single codebase once the Expo
  prebuild's macOS story stabilises

We chose **bare RN** over Expo because Expo's macOS support is
experimental and the macOS App Store submission needs precise control
over Info.plist, entitlements, code-signing, and StoreKit / RevenueCat
native modules. The existing `packages/mobile/` keeps working as the
iOS/Android shipping path; this package is the new desktop/macOS track.

## Architecture

```
App.tsx
  ├── AuthScreen        — email-OTP → setup or unlock
  ├── NotesListScreen   — read-only list of decrypted notes
  ├── NoteScreen        — read-only markdown source view
  └── SettingsScreen    — current tier + Manage subscription + AI stub
src/
  lib/
    session.ts          — in-memory Session, makeApiClient, loadNotes
    revenuecat.ts       — Purchases.configure scaffold
    theme.ts            — colour / font tokens
  screens/
    AuthScreen.tsx, NotesListScreen.tsx, NoteScreen.tsx, SettingsScreen.tsx
```

All crypto + API calls go through `@meo/shared` (workspace dep). No
duplication of the shared layer.

## Build

### Prerequisites

- Node ≥ 20, npm ≥ 10
- macOS with Xcode 15+ (for iOS / macOS)
- Android Studio with an SDK 34 emulator (for Android)
- CocoaPods 1.16+ (`gem install cocoapods` or via Bundler)

### First-time setup

From the repo root:

```sh
npm install
npm --workspace @meo/shared run build   # produces dist/ that mobile-rn imports
```

Then add the macOS native project (one-off — writes a `macos/` folder
into this package):

```sh
cd packages/mobile-rn
npx react-native-macos-init
```

Install pods:

```sh
npm run pods:ios     # iOS
npm run pods:macos   # macOS
```

### Run

From `packages/mobile-rn/`:

```sh
npm start            # Metro bundler (separate terminal)
npm run macos        # → opens the macOS app window
npm run ios          # → iOS Simulator
npm run android      # → Android emulator
```

### Configure backend

Two env vars, supplied however your bundler prefers (default placeholders
are baked in for local Supabase CLI):

```
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
REVENUECAT_IOS_KEY=appl_...      # optional, scaffold only
REVENUECAT_ANDROID_KEY=goog_...  # optional, scaffold only
```

The Metro bundler reads `process.env.*` at JS bundle time. For RN we
recommend `react-native-config` or `react-native-dotenv` — neither is
wired in yet (kept the scaffold minimal); see Phase 2.

## What's shipped (v1)

- Email-OTP auth (`requestEmailOtp` → `verifyEmailOtp` from `@meo/shared`)
- Encryption setup (passphrase + Secret Key) and unlock
- Read-only notes list (decrypts via `decryptNote`)
- Read-only note view (markdown source as the rendering)
- Settings: tier label + Manage subscription button (Paddle / store-aware)
- AI panel placeholder + mobile-only model gating alert
- RevenueCat `Purchases.configure` scaffold (no real key)

## What's deferred (Phase 2)

These all exist on desktop and need a follow-on agent run:

- **Editor write-side**: create / edit / delete, autosave, slash menu,
  TipTap parity (the desktop's full editor)
- **Sync v2**: incremental cursor, optimistic updates, conflict UX
- **Biometric unlock**: iOS Keychain via `react-native-keychain`,
  Android BiometricPrompt — see Agent 1's desktop design as the
  template
- **Vault** (Agent 8) and **2FA** (Agent 8) UIs
- **QR pairing** (Agent 9) — needs camera permission flow
- **AI panel** — local LLM (llama.rn) + cloud LLM with the curated
  mobile model list from Agent 7's manifest (`default_for: ['mobile']`)
- **Attachments** — image / file picker, encrypt-and-upload
- **Find / Search overlay**
- **Date-grouped notes list** (Agent 11) and sidebar toggle
- **Native menu bar on macOS** (Agent 5) — RN-macOS exposes a menu
  bridge; needs wiring
- **Dictation** (Agent 6) — uses iOS / macOS Speech framework
- **Export** (md / pdf / docx / txt / html) — Agent 2's pipeline
- **Devices list / remove** — already in shared API
- **Real RevenueCat key** + IAP entitlements
- **Settings panes**: Devices, Security, Models, Sources

## Testing

```sh
npm test            # jest unit tests
npm run typecheck   # tsc --noEmit
```

The native build is the integration test in v1 — `npm run macos` must
launch a window and reach the AuthScreen.

## Known issues

- The internal AppRegistry name is still `MobileRn` (matching the
  Xcode target). The user-facing `displayName` is `Meo`. Renaming the
  Xcode target requires regenerating the iOS project — defer.
- `react-native-purchases` is in `package.json` so the bundler
  resolves the import; the `configure` call is gated on a real API
  key being present at runtime, so the scaffold won't crash.
- macOS bundle: `react-native-purchases` does NOT publish a macOS
  module. The `revenuecat.ts` `require()` happens inside a try/catch,
  so the macOS build is still green — it just logs a warning and
  skips IAP wiring on Mac (Mac App Store StoreKit will need a
  separate native module wrapper).
