import { scryptSync, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const actual = scryptSync(password, salt, expected.length, { N, r, p });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString('hex');

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf as any).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export interface JwtPayload { sub: string; email: string; iat: number; exp: number; }

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, ttlSeconds = 60 * 60 * 24 * 30): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const full: JwtPayload = { ...payload, iat: now, exp: now + ttlSeconds };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(full));
  const sig = createHmac('sha256', JWT_SECRET).update(`${headerB64}.${payloadB64}`).digest();
  return `${headerB64}.${payloadB64}.${b64url(sig)}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest();
  const provided = b64urlDecode(s);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let payload: JwtPayload;
  try { payload = JSON.parse(b64urlDecode(p).toString('utf8')); }
  catch { return null; }
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
