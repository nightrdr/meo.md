// Tiny HKDF-SHA-256 fallback used by pairing.ts when SubtleCrypto's
// HKDF deriveBits is unavailable (older Node, restrictive runtimes).
// All other environments use crypto.subtle.deriveBits, which is faster
// and FIPS-friendly.
//
// Implementation per RFC 5869:
//   PRK = HMAC-SHA256(salt, IKM)
//   T(1) = HMAC-SHA256(PRK, info || 0x01)
//   T(N) = HMAC-SHA256(PRK, T(N-1) || info || N)
//   OKM = T(1) || T(2) || ... truncated to L bytes.
//
// We rely on crypto.subtle.{importKey,sign} for HMAC because writing
// SHA-256 from scratch would be careless. SubtleCrypto's HMAC is
// available everywhere SubtleCrypto exists.

export async function hkdfRaw(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const subtle = (typeof crypto !== 'undefined' ? crypto.subtle : undefined);
  if (!subtle) {
    throw new Error('No SubtleCrypto available; HKDF fallback cannot run.');
  }

  // Extract step
  const saltKey = await subtle.importKey('raw', salt.length ? salt : new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prkBuf = await subtle.sign('HMAC', saltKey, ikm);
  const prkKey = await subtle.importKey('raw', new Uint8Array(prkBuf), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

  // Expand step
  const out = new Uint8Array(length);
  let prev = new Uint8Array(0);
  let pos = 0;
  let counter = 1;
  while (pos < length) {
    const buf = new Uint8Array(prev.length + info.length + 1);
    buf.set(prev, 0);
    buf.set(info, prev.length);
    buf[prev.length + info.length] = counter;
    const tBuf = await subtle.sign('HMAC', prkKey, buf);
    const t = new Uint8Array(tBuf);
    const take = Math.min(t.length, length - pos);
    out.set(t.subarray(0, take), pos);
    pos += take;
    prev = t;
    counter += 1;
  }
  return out;
}
