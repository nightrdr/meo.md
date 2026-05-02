// RevenueCat webhook handler (mobile tier - App Store / Play Store).
//
// RevenueCat doesn't HMAC-sign its webhooks; instead it lets you set a fixed
// `Authorization: Bearer <token>` header on the platform side, which we
// require here via the `RC_WEBHOOK_AUTH` env var. Set the same token in the
// RevenueCat dashboard's webhook configuration.
//
// Events we care about:
//   - INITIAL_PURCHASE  - first purchase (or first restore on a fresh install)
//   - RENEWAL           - auto-renewal succeeded
//   - CANCELLATION      - user canceled (still active until expires_date)
//   - EXPIRATION        - actually expired, drop to free
//   - BILLING_ISSUE     - auto-renew failed; we keep the tier and flag cancel_at_period_end
//
// `app_user_id` MUST equal our meo `user_id` - the mobile client sets this via
// `Purchases.logIn(userId)` immediately after auth. RC also exposes
// `original_app_user_id`; we prefer the stable `app_user_id`.
//
// Tier comes from the entitlement identifier, NOT the product id, because
// product ids differ between iOS and Android. Define entitlements named
// `hobbyist` and `business` in the RevenueCat dashboard.
//
// Local development:
//   supabase functions serve revenuecat-webhook --no-verify-jwt
//   curl -X POST http://localhost:54321/functions/v1/revenuecat-webhook \
//     -H "Authorization: Bearer dev-rc-secret" -d '{"event":{...}}'

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders, handleOptions } from '../_shared/cors.ts';

const ENTITLEMENT_TO_TIER: Record<string, 'hobbyist' | 'business'> = {
  hobbyist: 'hobbyist',
  business: 'business',
};

interface RcWebhook {
  api_version?: string;
  event?: RcEvent;
}

interface RcEvent {
  type?: string;
  id?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  product_id?: string;
  entitlement_id?: string | null;
  entitlement_ids?: string[] | null;
  expiration_at_ms?: number | null;
  event_timestamp_ms?: number;
  cancel_reason?: string | null;
  store?: string;
}

Deno.serve(async (req: Request) => {
  const cors = handleOptions(req);
  if (cors) return cors;
  if (req.method !== 'POST') return jsonError(405, 'method_not_allowed');

  const expected = Deno.env.get('RC_WEBHOOK_AUTH');
  if (!expected) return jsonError(500, 'rc_webhook_auth_not_configured');

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return jsonError(401, 'missing_bearer');
  }
  const presented = auth.slice(7).trim();
  if (!timingSafeEqual(presented, expected)) {
    return jsonError(401, 'invalid_bearer');
  }

  let payload: RcWebhook;
  try {
    payload = await req.json();
  } catch {
    return jsonError(400, 'invalid_json');
  }

  const ev = payload.event;
  if (!ev || !ev.type) return jsonError(400, 'missing_event');

  const handled = new Set([
    'INITIAL_PURCHASE',
    'RENEWAL',
    'CANCELLATION',
    'EXPIRATION',
    'BILLING_ISSUE',
  ]);
  if (!handled.has(ev.type)) {
    return jsonOk({ ok: true, ignored: ev.type });
  }

  const meoUserId = ev.app_user_id ?? ev.original_app_user_id;
  if (!meoUserId || !/^[0-9a-f-]{36}$/i.test(meoUserId)) {
    return jsonError(400, 'missing_meo_user_id');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'meo' as any },
  });

  // Cross-store conflict guard - only on a fresh purchase.
  if (ev.type === 'INITIAL_PURCHASE') {
    const { data: existing } = await sb.rpc('subscription_source', { p_user_id: meoUserId });
    const row = Array.isArray(existing) ? existing[0] : existing;
    if (row && row.source && row.source !== 'revenuecat' && row.tier !== 'free') {
      return jsonError(409, 'cross_store_conflict');
    }
  }

  // Tier resolution.
  const entitlements: string[] = ev.entitlement_ids
    ?? (ev.entitlement_id ? [ev.entitlement_id] : []);
  let tier: 'free' | 'hobbyist' | 'business' | 'enterprise' = 'free';
  if (ev.type !== 'EXPIRATION') {
    for (const e of entitlements) {
      const t = ENTITLEMENT_TO_TIER[e];
      if (t) { tier = t; break; }
    }
  }

  const periodEnd = typeof ev.expiration_at_ms === 'number'
    ? new Date(ev.expiration_at_ms).toISOString()
    : null;
  const cancelAtPeriodEnd = ev.type === 'CANCELLATION' || ev.type === 'BILLING_ISSUE';

  const { error: rpcErr } = await sb.rpc('upsert_subscription', {
    p_user_id:     meoUserId,
    p_tier:        tier,
    p_source:      'revenuecat',
    p_external_id: ev.entitlement_id ?? entitlements[0] ?? null,
    p_period_end:  periodEnd,
    p_cancel:      cancelAtPeriodEnd,
    p_raw:         payload as any,
  });
  if (rpcErr) return jsonError(500, `rpc_error: ${rpcErr.message}`);

  return jsonOk({ ok: true, tier, event: ev.type });
});

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
