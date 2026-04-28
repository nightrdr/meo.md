# Shared package — crypto, types, API client

TypeScript package shared by backend (for type defs only) and the desktop +
mobile clients (for crypto + API). The desktop and mobile clients import it
as `@meo/shared`.

## Crypto module

All operations use Web Crypto API (`crypto.subtle`), which is available in
browsers, Node ≥ 16, and React Native ≥ 0.71 (via `react-native-quick-crypto`
or the global `crypto` polyfill). MVP avoids bundling argon2-wasm.

### Key hierarchy
```
passphrase (user) + secret_key (128-bit, generated at signup) + salt (per user)
  └─[ PBKDF2-SHA256, 600k iters ]─▶ unlock_key (256-bit)

unlock_key
  └─[ AES-256-GCM decrypt(encrypted_master_key, master_key_nonce) ]─▶ master_key

master_key + note_id
  └─[ HKDF-SHA256, info="note:" || note_id ]─▶ per_note_key (256-bit)

per_note_key + note_plaintext (CBOR/JSON)
  └─[ AES-256-GCM ]─▶ encrypted_content + nonce
```

### Public functions
- `generateSecretKey(): Uint8Array` — 16 random bytes (128-bit).
- `formatSecretKey(bytes): string` — group into 5-char chunks for display.
- `parseSecretKey(string): Uint8Array` — strict parse, throws on bad input.
- `deriveUnlockKey(passphrase, secretKey, salt): CryptoKey`
- `wrapMasterKey(masterKey, unlockKey): { ciphertext, nonce }`
- `unwrapMasterKey(ciphertext, nonce, unlockKey): CryptoKey`
- `derivePerNoteKey(masterKey, noteId): CryptoKey`
- `encryptNote(note, masterKey): { ciphertext, nonce }`
- `decryptNote(ciphertext, nonce, noteId, masterKey): Note`
- `generateMasterKey(): CryptoKey` — for new accounts at signup.

### Note plaintext format
JSON (CBOR is a v2 optimization):
```json
{
  "id": "uuid",
  "title": "string",
  "body": "markdown",
  "folder": ["Work","Q1"],
  "tags": ["draft"],
  "links": [],
  "created_at": "iso8601",
  "updated_at": "iso8601",
  "hlc": "01J...AAAA",
  "version": 0
}
```

### HLC (hybrid logical clock)
ULID-shaped string: `<48-bit ms timestamp>-<16-bit logical>`. Comparison is
lexicographic. On each write: `now_ms = max(local_ms, last_hlc_ms); if equal,
logical++; else logical=0`.

## API client

Thin fetch wrapper. Stores JWT in memory (caller persists it).
- `signup(email, password): { user_id }`
- `login(email, password): { jwt, account: AccountWrapper | null }`
- `getAccount(jwt): AccountWrapper`
- `putAccount(jwt, AccountWrapper)` — first-time encryption setup
- `listNotes(jwt, since: number): EncryptedNoteRow[]`
- `upsertNote(jwt, EncryptedNoteRow)`
- `deleteNote(jwt, id)`

`AccountWrapper`:
```ts
{ salt: base64, encrypted_master_key: base64, master_key_nonce: base64,
  kdf_params: { algo:'PBKDF2', iters: 600000, hash:'SHA-256' } }
```

## Types
Single source of truth for `Note`, `EncryptedNoteRow`, `AccountWrapper`,
`AuthResponse`, etc.
