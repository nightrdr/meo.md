// QR-pairing handover protocol (Agent 9).
//
// Two devices need to agree on a 32-byte symmetric "pair_key" without
// any prior shared secret beyond a short-lived handover_id printed in
// the QR. The construction is:
//
//   Device A (already signed in):
//     ek_a_priv, ek_a_pub  ← X25519 keypair
//     QR: { v:1, ek_a_pub, handover_id, issued_at, expires_at }
//
//   Device B (fresh install):
//     ek_b_priv, ek_b_pub  ← X25519 keypair
//     deposits ek_b_pub into meo.handovers/<id>
//
//   Both:
//     shared   = X25519(my_priv, their_pub)
//     pair_key = HKDF-SHA-256(shared, salt = handover_id_bytes,
//                             info = "meo:pair:v1", 32 bytes)
//
//   Device A then encrypts the session bundle under pair_key with
//   AES-GCM (random 12-byte nonce) and uploads ciphertext + nonce.
//   Device B fetches both, decrypts, and is signed in.
//
// Security notes:
//   - The handover_id is the bearer token for *the row*, but it is also
//     the HKDF salt - so an attacker who only has the QR (id + ek_a_pub)
//     can't derive pair_key without one of the private keys.
//   - 60-second TTL on the row + 32 random bytes of UUID entropy makes
//     a real-time MITM the only viable attack, and it requires either
//     the camera feed or the database row.
//   - We do NOT fall back to a less-secure scheme on failure. If the
//     scan / paste fails, the user sees "Pairing failed" and is
//     redirected to the passphrase + Secret Key flow.

// We don't import any node-only libs here - everything runs in the
// renderer (desktop + mobile webview). tweetnacl is the only dep and
// it's universal.

import { hkdfRaw } from './pairing-hkdf.js';
import { uuidv4 } from './encoding.js';

export interface HandoverQrPayload {
  v: 1;
  ek_a_pub: string;     // base64
  handover_id: string;  // uuid v4
  issued_at: number;    // ms epoch
  expires_at: number;   // ms epoch
}

export interface SessionBundle {
  master_key_raw: string;  // base64
  jwt: string;
  user_id: string;
  email: string;
  secret_key: string;      // formatted "AAAA-BBBB-..."
}

// ── Encoding helpers (no node Buffer in browser) ──

function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if (typeof btoa !== 'undefined') return btoa(bin);
  return Buffer.from(bytes).toString('base64');
}

function decodeBase64(s: string): Uint8Array {
  if (typeof atob !== 'undefined') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// uuid -> 16 bytes
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error('not a uuid: ' + uuid);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── X25519 via tweetnacl (the only library small enough to ship in the
//    bundle without a wasm payload). We import lazily so the crypto
//    surface stays tree-shakeable on consumers that don't pair.

async function loadNacl(): Promise<{
  keyPair: () => { publicKey: Uint8Array; secretKey: Uint8Array };
  scalarMult: (sk: Uint8Array, pk: Uint8Array) => Uint8Array;
}> {
  // tweetnacl.box.keyPair returns curve25519 keys (X25519). The shared
  // secret is X25519(sk, pk) which tweetnacl exposes as
  // nacl.scalarMult(sk, pk).
  const nacl = await import('tweetnacl');
  return {
    keyPair: () => {
      const kp = nacl.default.box.keyPair();
      return { publicKey: kp.publicKey, secretKey: kp.secretKey };
    },
    scalarMult: (sk, pk) => nacl.default.scalarMult(sk, pk),
  };
}

// ── HKDF-SHA-256 → 32 bytes (pair_key). ──
//
// We use WebCrypto's HKDF where available (browser + Node 16+); the
// mobile package has @noble/hashes/hkdf already, but desktop ships
// without it and the SubtleCrypto path keeps the dep surface small.
async function hkdfPairKey(
  shared: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  if (typeof crypto !== 'undefined' && crypto.subtle && (crypto.subtle as any).importKey) {
    try {
      const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info },
        ikm,
        32 * 8,
      );
      return new Uint8Array(bits);
    } catch {
      // fall through to the noble fallback
    }
  }
  return hkdfRaw(shared, salt, info, 32);
}

// ── Generate Device A's ephemeral keypair + payload ──
export async function makeHandoverPayload(): Promise<{
  payload: HandoverQrPayload;
  ek_priv: Uint8Array;
}> {
  const nacl = await loadNacl();
  const kp = nacl.keyPair();
  const handover_id = uuidv4();
  const now = Date.now();
  return {
    payload: {
      v: 1,
      ek_a_pub: encodeBase64(kp.publicKey),
      handover_id,
      issued_at: now,
      expires_at: now + 60_000,
    },
    ek_priv: kp.secretKey,
  };
}

// ── Generate Device B's ephemeral keypair ──
export async function makeBKeypair(): Promise<{
  ek_pub: Uint8Array;
  ek_priv: Uint8Array;
}> {
  const nacl = await loadNacl();
  const kp = nacl.keyPair();
  return { ek_pub: kp.publicKey, ek_priv: kp.secretKey };
}

// ── Compute pair_key on either side ──
export async function derivePairKey(
  myPriv: Uint8Array,
  theirPub: Uint8Array,
  handoverId: string,
): Promise<Uint8Array> {
  const nacl = await loadNacl();
  const shared = nacl.scalarMult(myPriv, theirPub);
  const salt = uuidToBytes(handoverId);
  const info = utf8('meo:pair:v1');
  return hkdfPairKey(shared, salt, info);
}

// ── Seal / open the SessionBundle under pair_key ──
export async function sealBundle(
  bundle: SessionBundle,
  pairKey: Uint8Array,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const key = await crypto.subtle.importKey('raw', pairKey, 'AES-GCM', false, ['encrypt']);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const pt = utf8(JSON.stringify(bundle));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, pt);
  return { ciphertext: new Uint8Array(ct), nonce };
}

export async function openBundle(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  pairKey: Uint8Array,
): Promise<SessionBundle> {
  const key = await crypto.subtle.importKey('raw', pairKey, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(pt))) as SessionBundle;
}

// ── QR encoding: payload → string and back ──
//
// We base64-encode the JSON so any QR encoder can consume it as ASCII.
// The string fits comfortably in a v6 QR at low ECC.

export function encodeQr(payload: HandoverQrPayload): string {
  return encodeBase64(utf8(JSON.stringify(payload)));
}

export function decodeQr(s: string): HandoverQrPayload {
  const trimmed = s.trim();
  // Forgive a "meo://pair?p=…" wrapper - future-proofs us if we ever
  // generate a tap-to-open scheme.
  const m = trimmed.match(/[?&]p=([^&]+)/);
  const raw = m ? m[1] : trimmed;
  const json = new TextDecoder().decode(decodeBase64(raw));
  const obj = JSON.parse(json);
  if (obj?.v !== 1 || typeof obj.ek_a_pub !== 'string' || typeof obj.handover_id !== 'string') {
    throw new Error('Invalid QR payload - wrong version or missing fields.');
  }
  if (typeof obj.expires_at === 'number' && obj.expires_at < Date.now()) {
    throw new Error('That QR code has expired. Generate a new one.');
  }
  return obj as HandoverQrPayload;
}

// ── Plumbing helpers for the API layer ──

export function bytesToB64(b: Uint8Array): string { return encodeBase64(b); }
export function b64ToBytes(s: string): Uint8Array { return decodeBase64(s); }

