# Mobile — meo.md Expo RN app (MVP)

Expo SDK (latest) + React Native + TypeScript. iOS + Android.
Same crypto + API client (`@meo/shared`) as desktop, copied in (Expo + npm
workspaces have well-known friction — MVP duplicates the shared sources
into `mobile/src/shared/` rather than fight the bundler).

## Screens (Expo Router)

### `/` — login or setup
- Same flow as desktop: email + password → unlock with passphrase + Secret
  Key.
- New users: signup → generate Secret Key → display + Copy button →
  passphrase prompt → wrap master key → upload.

### `/notes` — list
- FlatList of notes, sorted by `updated_at desc`.
- Search bar filters by title (substring, post-decrypt, in memory).
- FAB "+" creates a new note → push to `/note/[id]`.
- Tap to open.

### `/note/[id]` — editor
- Title input + folder path input.
- Body: plain `TextInput` with `multiline=true` and monospace font
  (markdown source). MVP: no rich rendering. Post-MVP: TenTap.
- Save on blur / debounced; explicit "Save" button on the header.

## Storage
- `expo-secure-store` for the JWT.
- `AsyncStorage` (`@react-native-async-storage/async-storage`) for the
  encrypted notes cache and sync cursor.
- Master key in memory only (re-prompt on app cold start).

## Crypto on RN
- Web Crypto via `react-native-quick-crypto` (Expo prebuild). The MVP uses
  a thin polyfill that exposes `crypto.subtle` and `crypto.getRandomValues`
  — same API as desktop.
- If native crypto can't be installed in the available time, fall back to
  `@noble/hashes` + `@noble/ciphers` (pure JS, slower but correct).

## Out of MVP
- TenTap rich editor
- Push notifications
- Background fetch
- Biometric unlock (LocalAuthentication)
- Camera / image picker / attachments
- Local LLM (llama.cpp via NDK)
