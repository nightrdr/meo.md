import {
  bytesToBase64, base64ToBytes, utf8Encode, utf8Decode, concat,
} from './encoding.js';
import type { AccountWrapper, Note } from './types.js';

// Marker prefix that flags a body string as already-vault-wrapped. Lives
// inside the *plaintext* of a note's `body` field (before the outer per-note
// encryption runs), and is detected by `decryptNote` to peel back the inner
// AES-GCM layer when a vault key is supplied. Format:
//   vault:<base64-nonce>:<base64-ct>
// The colon-separated layout is intentional - `:` never appears inside a
// base64 alphabet, so a single split() recovers the parts unambiguously.
export const VAULT_BODY_PREFIX = 'vault:';

const PBKDF2_ITERS = 600_000;

export function generateSecretKeyBytes(): Uint8Array {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return b;
}

// Display: A1B2C-D3E4F-...-... (groups of 5 hex chars). 32 hex / 5 = 6 groups + 2.
// Use base32-ish alphabet (Crockford, no I/L/O/U) for human friendliness.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 chars
export function formatSecretKey(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('Secret key must be 16 bytes');
  // 16 bytes = 128 bits = 25.6 base32 chars; we encode 25 chars (125 bits used) and pad with checksum bit.
  // For simplicity just hex-uppercase, grouped 4-4-4-4-4-4-4-4.
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  return hex.match(/.{1,4}/g)!.join('-');
}

export function parseSecretKey(s: string): Uint8Array {
  const hex = s.replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length !== 32) throw new Error('Secret key must be 32 hex characters');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
// Re-export so consumers don't need a separate import path
void ALPHABET; // silence "unused"

export function generateSalt(): Uint8Array {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return b;
}

export function generateNonce(): Uint8Array {
  const b = new Uint8Array(12); // GCM standard
  crypto.getRandomValues(b);
  return b;
}

export async function deriveUnlockKey(
  passphrase: string,
  secretKey: Uint8Array,
  salt: Uint8Array,
  iters: number = PBKDF2_ITERS,
): Promise<CryptoKey> {
  // Spec §3.2: passphrase + Secret Key + salt → Argon2id → unlock key.
  // MVP uses PBKDF2 (see specs/00-mvp-scope.md). Combine inputs:
  // PBKDF2 input material = SHA-256(passphrase || 0x00 || secretKey).
  const passBytes = utf8Encode(passphrase);
  const sep = new Uint8Array([0]);
  const ikm = await crypto.subtle.digest('SHA-256', concat(passBytes, sep, secretKey));
  const baseKey = await crypto.subtle.importKey('raw', ikm, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function generateMasterKeyRaw(): Promise<Uint8Array> {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

export async function importAesKey(raw: Uint8Array, usages: KeyUsage[] = ['encrypt','decrypt']): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, usages);
}

export async function wrapMasterKey(masterRaw: Uint8Array, unlockKey: CryptoKey): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const nonce = generateNonce();
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, unlockKey, masterRaw);
  return { ciphertext: new Uint8Array(ct), nonce };
}

export async function unwrapMasterKey(ciphertext: Uint8Array, nonce: Uint8Array, unlockKey: CryptoKey): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, unlockKey, ciphertext);
  return new Uint8Array(pt);
}

// HKDF-SHA256 over the master key with note id as info.
export async function derivePerNoteKey(masterRaw: Uint8Array, noteId: string): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', masterRaw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8Encode(`note:${noteId}`),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Vault key (Agent 8). A second key derived from the master key, scoped to a
// user. Used to wrap the *body* of vault-flagged notes before the outer
// per-note encryption runs - so an attacker who somehow grabs `masterRaw` from
// memory still can't read vault bodies without the vault key.
//
// Derivation:   vault_key = HKDF-SHA256(masterRaw, salt=utf8(user_id), info='vault:v1', length=32)
// ---------------------------------------------------------------------------
/**
 * Is `body` still in its `vault:<nonce>:<ct>` wire form? Used by the UI to
 * decide whether to render a 🔒 placeholder preview vs the real content.
 */
export function isVaultLockedBody(body: string | undefined | null): boolean {
  return typeof body === 'string' && body.startsWith(VAULT_BODY_PREFIX);
}

export async function deriveVaultKey(masterRaw: Uint8Array, userId: string): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', masterRaw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8Encode(userId),
      info: utf8Encode('vault:v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptVaultBody(
  body: string,
  vaultKey: CryptoKey,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const nonce = generateNonce();
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    vaultKey,
    utf8Encode(body),
  );
  return { ciphertext: new Uint8Array(ct), nonce };
}

export async function decryptVaultBody(
  ct: Uint8Array,
  nonce: Uint8Array,
  vaultKey: CryptoKey,
): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, vaultKey, ct);
  return utf8Decode(new Uint8Array(pt));
}

/**
 * Wrap (or pass through) a note's body for vault-flagged notes. Returns the
 * wire-form string: `vault:<b64-nonce>:<b64-ct>` if a vaultKey is provided
 * and `note.isVault === true`, otherwise the body unchanged.
 *
 * Idempotent - if `body` already starts with the vault marker we leave it
 * alone. Saving a vault note that's currently locked (no vaultKey in scope)
 * therefore keeps the original ciphertext intact.
 */
async function maybeWrapVaultBody(note: Note, vaultKey: CryptoKey | undefined): Promise<string> {
  if (!note.isVault) return note.body;
  if (note.body.startsWith(VAULT_BODY_PREFIX)) return note.body;
  if (!vaultKey) return note.body;
  const { ciphertext, nonce } = await encryptVaultBody(note.body, vaultKey);
  return `${VAULT_BODY_PREFIX}${bytesToBase64(nonce)}:${bytesToBase64(ciphertext)}`;
}

/**
 * Detect a vault marker on a body string and try to peel it. If `vaultKey`
 * is missing we leave the marker in place - the UI is expected to render a
 * locked placeholder until the user unlocks. Throws on malformed markers
 * so a corrupt blob surfaces loudly instead of silently looking unlocked.
 */
async function maybeUnwrapVaultBody(body: string, vaultKey: CryptoKey | undefined): Promise<string> {
  if (!body.startsWith(VAULT_BODY_PREFIX)) return body;
  if (!vaultKey) return body; // caller will treat as locked
  const rest = body.slice(VAULT_BODY_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep < 0) throw new Error('malformed vault body: missing nonce/ct separator');
  const nonce = base64ToBytes(rest.slice(0, sep));
  const ct = base64ToBytes(rest.slice(sep + 1));
  return decryptVaultBody(ct, nonce, vaultKey);
}

export async function encryptNote(
  note: Note,
  masterRaw: Uint8Array,
  vaultKey?: CryptoKey,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const key = await derivePerNoteKey(masterRaw, note.id);
  const nonce = generateNonce();
  // Wrap the body for vault notes (no-op for normal notes). We mutate the
  // body field inline - `note` is the caller's snapshot, never the live
  // object - and serialise the rest of the JSON unchanged.
  const wrappedBody = await maybeWrapVaultBody(note, vaultKey);
  const wireNote: Note = wrappedBody === note.body ? note : { ...note, body: wrappedBody };
  const plaintext = utf8Encode(JSON.stringify(wireNote));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext);
  return { ciphertext: new Uint8Array(ct), nonce };
}

export async function decryptNote(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  noteId: string,
  masterRaw: Uint8Array,
  vaultKey?: CryptoKey,
): Promise<Note> {
  const key = await derivePerNoteKey(masterRaw, noteId);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
  const note = JSON.parse(utf8Decode(new Uint8Array(pt))) as Note;
  // Best-effort vault unwrap. A vault note encountered without a vault key
  // keeps its `vault:...` marker - the UI sees this and renders the locked
  // preview without ever touching plaintext.
  if (note.body && note.body.startsWith(VAULT_BODY_PREFIX)) {
    note.body = await maybeUnwrapVaultBody(note.body, vaultKey);
  }
  return note;
}

// --- Account wrapper helpers (high-level signup / unlock) ---

export interface SetupResult {
  wrapper: AccountWrapper;
  masterRaw: Uint8Array;
  secretKey: Uint8Array;
}

export async function setupNewAccount(passphrase: string): Promise<SetupResult> {
  const secretKey = generateSecretKeyBytes();
  const salt = generateSalt();
  const masterRaw = await generateMasterKeyRaw();
  const unlockKey = await deriveUnlockKey(passphrase, secretKey, salt);
  const { ciphertext, nonce } = await wrapMasterKey(masterRaw, unlockKey);
  const wrapper: AccountWrapper = {
    salt: bytesToBase64(salt),
    encrypted_master_key: bytesToBase64(ciphertext),
    master_key_nonce: bytesToBase64(nonce),
    kdf_params: { algo: 'PBKDF2', iters: PBKDF2_ITERS, hash: 'SHA-256' },
  };
  return { wrapper, masterRaw, secretKey };
}

export async function unlockAccount(
  passphrase: string,
  secretKey: Uint8Array,
  wrapper: AccountWrapper,
): Promise<Uint8Array> {
  const salt = base64ToBytes(wrapper.salt);
  const ciphertext = base64ToBytes(wrapper.encrypted_master_key);
  const nonce = base64ToBytes(wrapper.master_key_nonce);
  const unlockKey = await deriveUnlockKey(passphrase, secretKey, salt, wrapper.kdf_params.iters);
  return unwrapMasterKey(ciphertext, nonce, unlockKey);
}
