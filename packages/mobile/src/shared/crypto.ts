// Pure-JS crypto for React Native using @noble/* libraries.
// Equivalent key hierarchy to desktop's Web Crypto implementation:
//   passphrase + secretKey + salt --[PBKDF2-SHA256, 600k]--> unlockKey (32 bytes)
//   unlockKey --[AES-256-GCM decrypt]--> masterKey (32 bytes)
//   masterKey + noteId --[HKDF-SHA256]--> perNoteKey (32 bytes)

import { gcm } from '@noble/ciphers/aes';
import { pbkdf2 as pbkdf2Sync } from '@noble/hashes/pbkdf2';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToBase64, base64ToBytes, utf8Encode, utf8Decode, concat } from './encoding';
import type { AccountWrapper, Note } from './types';

const PBKDF2_ITERS = 600_000;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function generateSecretKeyBytes(): Uint8Array { return randomBytes(16); }
export function generateSalt(): Uint8Array { return randomBytes(16); }
export function generateNonce(): Uint8Array { return randomBytes(12); }

export function formatSecretKey(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('Secret key must be 16 bytes');
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

export function deriveUnlockKeyRaw(
  passphrase: string, secretKey: Uint8Array, salt: Uint8Array, iters: number = PBKDF2_ITERS,
): Uint8Array {
  // Same input combination as desktop: SHA-256(passphrase || 0x00 || secretKey).
  const ikm = sha256(concat(utf8Encode(passphrase), new Uint8Array([0]), secretKey));
  return pbkdf2Sync(sha256, ikm, salt, { c: iters, dkLen: 32 });
}

export async function generateMasterKeyRaw(): Promise<Uint8Array> { return randomBytes(32); }

export function aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return gcm(key, nonce).encrypt(plaintext);
}
export function aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return gcm(key, nonce).decrypt(ciphertext);
}

export function wrapMasterKey(masterRaw: Uint8Array, unlockKey: Uint8Array): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = generateNonce();
  return { ciphertext: aesGcmEncrypt(unlockKey, nonce, masterRaw), nonce };
}

export function unwrapMasterKey(ciphertext: Uint8Array, nonce: Uint8Array, unlockKey: Uint8Array): Uint8Array {
  return aesGcmDecrypt(unlockKey, nonce, ciphertext);
}

export function derivePerNoteKey(masterRaw: Uint8Array, noteId: string): Uint8Array {
  return hkdf(sha256, masterRaw, new Uint8Array(0), utf8Encode(`note:${noteId}`), 32);
}

export function encryptNote(note: Note, masterRaw: Uint8Array): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const key = derivePerNoteKey(masterRaw, note.id);
  const nonce = generateNonce();
  const plaintext = utf8Encode(JSON.stringify(note));
  return { ciphertext: aesGcmEncrypt(key, nonce, plaintext), nonce };
}

export function decryptNote(ciphertext: Uint8Array, nonce: Uint8Array, noteId: string, masterRaw: Uint8Array): Note {
  const key = derivePerNoteKey(masterRaw, noteId);
  const pt = aesGcmDecrypt(key, nonce, ciphertext);
  return JSON.parse(utf8Decode(pt)) as Note;
}

export interface SetupResult {
  wrapper: AccountWrapper;
  masterRaw: Uint8Array;
  secretKey: Uint8Array;
}

export async function setupNewAccount(passphrase: string): Promise<SetupResult> {
  const secretKey = generateSecretKeyBytes();
  const salt = generateSalt();
  const masterRaw = await generateMasterKeyRaw();
  const unlockKey = deriveUnlockKeyRaw(passphrase, secretKey, salt);
  const { ciphertext, nonce } = wrapMasterKey(masterRaw, unlockKey);
  const wrapper: AccountWrapper = {
    salt: bytesToBase64(salt),
    encrypted_master_key: bytesToBase64(ciphertext),
    master_key_nonce: bytesToBase64(nonce),
    kdf_params: { algo: 'PBKDF2', iters: PBKDF2_ITERS, hash: 'SHA-256' },
  };
  return { wrapper, masterRaw, secretKey };
}

export async function unlockAccount(
  passphrase: string, secretKey: Uint8Array, wrapper: AccountWrapper,
): Promise<Uint8Array> {
  const salt = base64ToBytes(wrapper.salt);
  const ciphertext = base64ToBytes(wrapper.encrypted_master_key);
  const nonce = base64ToBytes(wrapper.master_key_nonce);
  const unlockKey = deriveUnlockKeyRaw(passphrase, secretKey, salt, wrapper.kdf_params.iters);
  return unwrapMasterKey(ciphertext, nonce, unlockKey);
}
