// tfa-verify — Agent 8.
//
// Validates a 6-digit TOTP against the caller's stored secret. On success,
// mints a short-lived session-bound token (5 min) the client sends as the
// `X-MEO-TFA-Token` header on subsequent API calls until the next cold start.
//
// Token shape (intentionally simple for v1):
//   <user_id>.<expires_at_unix>.<hmac>
//   where hmac = HMAC-SHA256(TFA_KEK || ':sess:', `${user_id}:${expires_at_unix}`)
//
// Server-side middleware that gates Business+ traffic can rebuild the HMAC
// and check it. We're not minting a JWT (no RS256 keypair to manage) — the
// HMAC is fine for a 5-minute window scoped to a single env-var secret.
//
// Local dev:
//   supabase functions serve tfa-verify --no-verify-jwt
//   curl -X POST http://localhost:54321/functions/v1/tfa-verify \
//     -H "Authorization: Bearer <jwt>" \
//     -d '{"code":"123456"}'

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders, handleOptions } from '../_shared/cors.ts';

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_TOLERANCE = 1; // ±1 step
const TOKEN_TTL_SECONDS = 300; // 5 min

interface ReqBody { code?: string; }

Deno.serve(async (req: Request) => {
  const cors = handleOptions(req);
  if (cors) return cors;
  if (req.method !== 'POST') return jsonError(405, 'method_not_allowed');

  const auth = req.headers.get('authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    return jsonError(401, 'missing_bearer_token');
  }
  const jwt = auth.slice(7);

  const kekHex = Deno.env.get('TFA_KEK');
  if (!kekHex || kekHex.length !== 64) return jsonError(500, 'tfa_kek_not_configured');

  let body: ReqBody = {};
  try { body = await req.json(); } catch { return jsonError(400, 'invalid_json'); }
  const code = (body.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) return jsonError(400, 'code_must_be_6_digits');

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who, error: whoErr } = await userClient.auth.getUser(jwt);
  if (whoErr || !who.user) return jsonError(401, 'invalid_token');
  const userId = who.user.id;

  // Service-role read of the encrypted secret.
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'meo' as any },
  });
  const { data: row, error: rowErr } = await sb
    .from('tfa_secrets')
    .select('secret_enc, secret_nonce, enabled')
    .eq('user_id', userId)
    .maybeSingle();
  if (rowErr) return jsonError(500, `db_error: ${rowErr.message}`);
  if (!row || !row.enabled) return jsonError(404, 'tfa_not_enrolled');

  const kek = hexToBytes(kekHex);
  const ct = hexToBytes(stripPgHex(row.secret_enc as unknown as string));
  const nonce = hexToBytes(stripPgHex(row.secret_nonce as unknown as string));
  const key = await crypto.subtle.importKey('raw', kek, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let secret: Uint8Array;
  try {
    secret = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  } catch {
    return jsonError(500, 'secret_decrypt_failed');
  }

  // Verify against current ±tolerance steps.
  const nowStep = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  let ok = false;
  for (let i = -TOTP_TOLERANCE; i <= TOTP_TOLERANCE; i++) {
    const candidate = await totpAt(secret, nowStep + i);
    if (timingSafeEqual(candidate, code)) { ok = true; break; }
  }
  if (!ok) return jsonError(401, 'invalid_code');

  // Mint session token.
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const tokenInner = `${userId}:${expiresAt}`;
  const tokenSig = await hmacHex(kek, `meo:tfa:${tokenInner}`);
  const token = `${userId}.${expiresAt}.${tokenSig}`;
  return jsonOk({ token, expires_at: expiresAt });
});

// ─── TOTP impl (RFC 6238) ──────────────────────────────────────────────

async function totpAt(secret: Uint8Array, step: number): Promise<string> {
  // 8-byte big-endian counter
  const counter = new Uint8Array(8);
  let s = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = s & 0xff;
    s = Math.floor(s / 256);
  }
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24)
             | ((mac[offset + 1] & 0xff) << 16)
             | ((mac[offset + 2] & 0xff) << 8)
             | (mac[offset + 3] & 0xff);
  const mod = 10 ** TOTP_DIGITS;
  return (code % mod).toString().padStart(TOTP_DIGITS, '0');
}

// ─── helpers ───────────────────────────────────────────────────────────

async function hmacHex(secret: Uint8Array, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  let h = '';
  for (const b of new Uint8Array(sig)) h += b.toString(16).padStart(2, '0');
  return h;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// PostgREST returns bytea as `\xdeadbeef`. Strip the `\x` prefix if present.
function stripPgHex(hex: string): string {
  return hex.startsWith('\\x') ? hex.slice(2) : hex;
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}
function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}
