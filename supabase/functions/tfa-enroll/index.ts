// tfa-enroll — Agent 8.
//
// Generates a fresh 20-byte TOTP secret for the caller, stores it server-side
// encrypted with TFA_KEK (32-byte hex env var), and returns the otpauth URL
// the caller's authenticator app can scan.
//
// Why server-side encryption (and not, say, masterRaw): TOTP requires the
// verifier to hold the shared secret in plaintext at the moment of
// validation. We can't use the user's E2EE master key because the server
// never sees it. TFA_KEK is the operator's responsibility; rotating it
// requires migrating the secret_enc column.
//
// Local development:
//   export TFA_KEK=$(openssl rand -hex 32)
//   supabase functions serve tfa-enroll --no-verify-jwt
//   curl -X POST http://localhost:54321/functions/v1/tfa-enroll \
//     -H "Authorization: Bearer <user-jwt>"

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders, handleOptions } from '../_shared/cors.ts';

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
  if (!kekHex || kekHex.length !== 64) {
    return jsonError(500, 'tfa_kek_not_configured');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Resolve the caller from their JWT.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who, error: whoErr } = await userClient.auth.getUser(jwt);
  if (whoErr || !who.user) return jsonError(401, 'invalid_token');
  const userId = who.user.id;
  const email = who.user.email ?? '';

  // Generate a fresh 20-byte secret (RFC 6238 recommends 160 bits).
  const secret = crypto.getRandomValues(new Uint8Array(20));
  const secretB32 = base32encode(secret);

  // Encrypt at rest.
  const kek = hexToBytes(kekHex);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', kek, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, secret));

  // Service-role write (bypasses RLS — there's no client policy on this table).
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'meo' as any },
  });
  // Upsert: re-enrollment overwrites the previous secret.
  const { error: upErr } = await sb.from('tfa_secrets').upsert({
    user_id: userId,
    secret_enc: bytesToHex(ct),
    secret_nonce: bytesToHex(nonce),
    enabled: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (upErr) return jsonError(500, `db_error: ${upErr.message}`);

  // otpauth URL — `meo.md` is both label namespace and issuer.
  const label = encodeURIComponent(`meo.md:${email}`);
  const params = new URLSearchParams();
  params.set('secret', secretB32);
  params.set('issuer', 'meo.md');
  params.set('algorithm', 'SHA1');
  params.set('digits', '6');
  params.set('period', '30');
  const otpauth = `otpauth://totp/${label}?${params.toString()}`;

  return jsonOk({ otpauth_url: otpauth, secret_b32: secretB32 });
});

// ─── helpers ───────────────────────────────────────────────────────────

function base32encode(bytes: Uint8Array): string {
  // RFC 4648 base32 alphabet, no padding (TOTP convention).
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alpha[(buf >> bits) & 31];
    }
  }
  if (bits > 0) out += alpha[(buf << (5 - bits)) & 31];
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// PostgREST expects bytea writes as `\x<hex>`. Without the prefix the
// payload is interpreted as text and silently turned into `<hex>::bytea`,
// which double-encodes (every char becomes its ASCII byte).
function bytesToHex(bytes: Uint8Array): string {
  let s = '\\x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
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
