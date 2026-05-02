// Paddle Billing webhook handler (web / desktop tier).
//
// Paddle signs every webhook with HMAC-SHA256 over the raw request body using
// the secret you set as `PADDLE_WEBHOOK_SECRET`. The header looks like:
//   Paddle-Signature: ts=1700000000;h1=<hex>
// The signing input is `<ts>:<body>` and we compare against `h1`.
// Reference: https://developer.paddle.com/webhooks/signature-verification
//
// Events we care about:
//   - subscription.created    — new sub, set tier
//   - subscription.activated  — trial → active, set tier
//   - subscription.updated    — plan change / period rollover
//   - subscription.canceled   — sub canceled (still active until period end)
//
// Tier is derived from the Paddle `price_id` of the first non-trial item on
// the subscription. Update the map below to match the live Paddle catalogue.
//
// We resolve the meo user from `custom_data.meo_user_id`, which the desktop
// app passes when it opens the Paddle Checkout overlay.
//
// On a fresh purchase whose user already has an active subscription from a
// different `source` (e.g. a RevenueCat-managed mobile sub), we return 409 so
// the operator can refund the duplicate; the frontend never reaches this path
// because the desktop upgrade flow runs the same check before opening
// checkout.
//
// Local development:
//   supabase functions serve paddle-webhook --no-verify-jwt
//   curl -X POST http://localhost:54321/functions/v1/paddle-webhook \
//     -H "Paddle-Signature: ts=...;h1=..." -d '{"event_type":"subscription.created",...}'

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders, handleOptions } from '../_shared/cors.ts';

// Paddle price_id → meo tier. Update these once you've created the Paddle
// catalogue; the placeholders below let local development (and the unit
// tests) run without contacting Paddle.
const PRICE_TO_TIER: Record<string, 'hobbyist' | 'business' | 'enterprise'> = {
  pri_hobbyist_monthly: 'hobbyist',
  pri_hobbyist_yearly:  'hobbyist',
  pri_business_monthly: 'business',
  pri_business_yearly:  'business',
  pri_enterprise:       'enterprise',
};

interface PaddleWebhook {
  event_id?: string;
  event_type: string;
  occurred_at?: string;
  data?: PaddleSubscription;
}

interface PaddleSubscription {
  id?: string;
  status?: string;
  customer_id?: string;
  custom_data?: Record<string, unknown> | null;
  scheduled_change?: { action?: string; effective_at?: string } | null;
  current_billing_period?: { ends_at?: string; starts_at?: string } | null;
  items?: Array<{
    status?: string;
    price?: { id?: string };
    product?: { id?: string };
  }>;
}

Deno.serve(async (req: Request) => {
  const cors = handleOptions(req);
  if (cors) return cors;
  if (req.method !== 'POST') return jsonError(405, 'method_not_allowed');

  const secret = Deno.env.get('PADDLE_WEBHOOK_SECRET');
  if (!secret) return jsonError(500, 'paddle_webhook_secret_not_configured');

  const sigHeader = req.headers.get('paddle-signature');
  if (!sigHeader) return jsonError(401, 'missing_signature');

  // Read the body as text first — signature is over the *raw* body. Parsing
  // before verifying would let an attacker swap whitespace and pass the check.
  const rawBody = await req.text();
  const verified = await verifyPaddleSignature(sigHeader, rawBody, secret);
  if (!verified) return jsonError(401, 'invalid_signature');

  let payload: PaddleWebhook;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonError(400, 'invalid_json');
  }

  const handled = new Set([
    'subscription.created',
    'subscription.activated',
    'subscription.updated',
    'subscription.canceled',
  ]);
  if (!handled.has(payload.event_type)) {
    // Unknown event types are not errors — just no-op. Paddle will retry on
    // non-2xx, and we don't want endless retries for things we ignore.
    return jsonOk({ ok: true, ignored: payload.event_type });
  }

  const sub = payload.data;
  if (!sub) return jsonError(400, 'missing_data');

  const meoUserId = pickUserId(sub.custom_data);
  if (!meoUserId) return jsonError(400, 'missing_meo_user_id');

  // Service-role client — used to read existing source and call the
  // SECURITY DEFINER upsert RPC. Never exposed to the browser.
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'meo' as any },
  });

  // Cross-store conflict guard — only on fresh purchases. Updates / cancels
  // for an already-Paddle sub are still fine.
  if (payload.event_type === 'subscription.created') {
    const { data: existing } = await sb.rpc('subscription_source', { p_user_id: meoUserId });
    const row = Array.isArray(existing) ? existing[0] : existing;
    if (row && row.source && row.source !== 'paddle' && row.tier !== 'free') {
      return jsonError(409, 'cross_store_conflict');
    }
  }

  const tier = payload.event_type === 'subscription.canceled'
    ? 'free'
    : tierFromItems(sub.items);

  const periodEnd = sub.current_billing_period?.ends_at ?? null;
  const cancelAtPeriodEnd =
    payload.event_type === 'subscription.canceled' ||
    sub.scheduled_change?.action === 'cancel';

  const { error: rpcErr } = await sb.rpc('upsert_subscription', {
    p_user_id:     meoUserId,
    p_tier:        tier,
    p_source:      'paddle',
    p_external_id: sub.id ?? null,
    p_period_end:  periodEnd,
    p_cancel:      cancelAtPeriodEnd,
    p_raw:         payload as any,
  });
  if (rpcErr) return jsonError(500, `rpc_error: ${rpcErr.message}`);

  return jsonOk({ ok: true, tier, event: payload.event_type });
});

// ─── signature ─────────────────────────────────────────────────────────────

/**
 * Verify a Paddle webhook signature header. Exported (via the file's module
 * scope when imported in tests) so we can run the HMAC dance offline.
 */
export async function verifyPaddleSignature(
  header: string,
  body: string,
  secret: string,
): Promise<boolean> {
  // Header format: ts=...;h1=...
  const parts = header.split(';');
  let ts = '';
  let h1 = '';
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k === 'ts') ts = v ?? '';
    else if (k === 'h1') h1 = v ?? '';
  }
  if (!ts || !h1) return false;

  // Reject signatures more than 5 minutes old (replay protection).
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const ageSec = Math.abs(Date.now() / 1000 - tsNum);
  if (ageSec > 300) return false;

  const expected = await hmacHex(secret, `${ts}:${body}`);
  return timingSafeEqualHex(expected, h1);
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function pickUserId(custom: Record<string, unknown> | null | undefined): string | null {
  if (!custom) return null;
  const v = custom['meo_user_id'];
  if (typeof v !== 'string') return null;
  if (!/^[0-9a-f-]{36}$/i.test(v)) return null;
  return v;
}

function tierFromItems(items?: PaddleSubscription['items']): 'free' | 'hobbyist' | 'business' | 'enterprise' {
  if (!items || items.length === 0) return 'free';
  for (const it of items) {
    if (it.status && it.status !== 'active' && it.status !== 'trialing') continue;
    const id = it.price?.id;
    if (!id) continue;
    const tier = PRICE_TO_TIER[id];
    if (tier) return tier;
  }
  return 'free';
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
