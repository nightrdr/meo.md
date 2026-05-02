// Biometric / OS-keychain wrap-key bridge (Agent 1).
//
// Wraps the four Rust commands defined in `src-tauri/src/biometric.rs`:
//   biometric_save / biometric_load / biometric_clear / biometric_available
//
// Plus a pair of Web-Crypto helpers for the AES-256-GCM master-key
// wrapping. We use the browser's SubtleCrypto here (not @noble) because
// every desktop runtime - Tauri WKWebView, WebView2, WebKitGTK - exposes
// SubtleCrypto natively, and the wrap step happens once per device-key
// rotation (not per note). Keeping a runtime-bundled WebCrypto path
// also makes the dev-server (`npm run dev`) Just Work without depending
// on the Tauri side.
//
// Threat model summary (full version in mvp-development.md):
//   - master_wrap_blob lives in IndexedDB unencrypted at the IDB layer
//   - AES-GCM ciphertext is meaningless without `wrap_key`
//   - `wrap_key` lives only in the OS keychain, gated behind a
//     userPresence ACL (Touch ID / Watch / login pwd / Windows Hello)
//   - first-time setup happens after a successful passphrase+SecretKey
//     unlock; the user opts in via the "Enable Touch ID" toggle
//
// The Rust side is the source of truth for "is biometric available?";
// the JS check is just a pre-flight so we can hide UI gracefully when
// running in a plain browser tab without the Tauri runtime injected.

import { invoke } from '@tauri-apps/api/core';

/// All wrap-key entries in the keychain go under this key id. We
/// version it so a future schema change (e.g. switching to an
/// X25519-wrapped master) can coexist with the v1 entry without
/// either silently overwriting the other on cold start.
const KEY_ID = 'master_wrap_key_v1';

/// Lightweight Tauri-runtime probe. The `__TAURI_INTERNALS__` global
/// is injected by the host before the JS bundle runs. Plain browser
/// tabs (Vite dev server, Storybook) don't have it; we treat those as
/// "no biometric available" so the auth flow falls through to
/// passphrase mode without an `invoke()` rejection.
function tauriAvailable(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (globalThis as any).__TAURI_INTERNALS__ !== 'undefined';
}

/**
 * Returns true if the OS keychain + biometric prompt are usable on
 * this device. macOS Tauri returns true (we always attempt; the OS
 * picks Touch ID / Watch / login-pwd as fallback). Windows checks
 * Windows Hello availability synchronously. Linux returns false -
 * we honestly tell the UI no biometric is available so the prompt
 * copy isn't misleading. Plain browser tabs (no Tauri) return false.
 */
export async function biometricAvailable(): Promise<boolean> {
  if (!tauriAvailable()) return false;
  try {
    return await invoke<boolean>('biometric_available');
  } catch {
    return false;
  }
}

/**
 * Stash a base64-encoded 32-byte wrap key in the OS keychain, gated
 * behind the userPresence ACL. Called once after the first
 * successful passphrase+SecretKey unlock when the user has opted
 * into biometric.
 */
export async function saveWrapKey(keyB64: string): Promise<void> {
  await invoke('biometric_save', { keyId: KEY_ID, keyB64 });
}

/**
 * Pull the wrap key out of the keychain. The OS will prompt the user
 * for biometric (or fallback) before resolving. Rejects on cancel,
 * not-found, or platform error - callers should fall back to the
 * passphrase unlock screen.
 */
export async function loadWrapKey(): Promise<string> {
  return invoke<string>('biometric_load', { keyId: KEY_ID });
}

/**
 * Remove the wrap key from the keychain. Best-effort: failure during
 * sign-out shouldn't block the rest of the cleanup. The caller is
 * always expected to ALSO clear `master_wrap_blob` from IndexedDB.
 */
export async function clearWrapKey(): Promise<void> {
  if (!tauriAvailable()) return;
  try {
    await invoke('biometric_clear', { keyId: KEY_ID });
  } catch {
    // swallow - sign-out continues regardless
  }
}

// ─── AES-256-GCM wrap helpers ────────────────────────────────────────
//
// We wrap the 32-byte masterRaw with a fresh 32-byte wrap_key + a
// 12-byte random nonce. The blob is the GCM ciphertext+tag; the
// nonce is stored alongside in IndexedDB. AES-GCM authenticates the
// ciphertext, so a tampered blob fails decryption rather than
// silently producing garbage.

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Generate a fresh 32-byte AES key, encrypt `masterRaw` under it, and
 * return the wrap key + ciphertext blob + nonce - all base64-encoded
 * so they round-trip cleanly through IndexedDB and the Rust bridge.
 *
 * The caller is responsible for:
 *   1) writing `blob` and `nonce` to IndexedDB, and
 *   2) handing `keyB64` to `saveWrapKey` so the OS keychain locks it
 *      behind the userPresence ACL.
 */
export async function wrapMasterRaw(masterRaw: Uint8Array): Promise<{
  keyB64: string;
  blob: string;
  nonce: string;
}> {
  const wrapKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    wrapKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      cryptoKey,
      masterRaw,
    ),
  );
  return {
    keyB64: bytesToBase64(wrapKey),
    blob: bytesToBase64(ct),
    nonce: bytesToBase64(nonce),
  };
}

/**
 * Reverse of `wrapMasterRaw`. Throws if the blob has been tampered
 * with (AES-GCM tag mismatch) or the wrap key is wrong (very unlikely
 * unless someone manually replaced it in the keychain).
 */
export async function unwrapMasterRaw(
  keyB64: string,
  blob: string,
  nonce: string,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(keyB64),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const pt = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(nonce) },
      cryptoKey,
      base64ToBytes(blob),
    ),
  );
  return pt;
}

// ─── JWT helper ──────────────────────────────────────────────────────
//
// Pull the `exp` claim out of a JWT without verifying the signature.
// This is fine for "is the token still useful?" - the server still
// checks the signature on every request. Returns ms since epoch or
// null if the token is malformed.
export function jwtExpMs(jwt: string): number | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    // base64url → base64
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '='));
    const payload = JSON.parse(json) as { exp?: number };
    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}
