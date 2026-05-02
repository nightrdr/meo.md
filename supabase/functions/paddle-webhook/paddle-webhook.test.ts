// Unit tests for the Paddle webhook signature verifier.
//
// Run with:
//   deno test supabase/functions/paddle-webhook/paddle-webhook.test.ts
//
// We hold ourselves to three behaviours:
//   1. A correctly-signed body verifies.
//   2. A tampered body fails.
//   3. An old timestamp (replay) fails even with a correct hash.

import { assertEquals, assertStrictEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { verifyPaddleSignature } from './index.ts';

const SECRET = 'pdl_ntfset_test_secret';

async function sign(body: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${ts}:${body}`),
  );
  const hex = [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `ts=${ts};h1=${hex}`;
}

Deno.test('accepts a correctly-signed payload', async () => {
  const body = JSON.stringify({ event_type: 'subscription.created' });
  const ts = Math.floor(Date.now() / 1000);
  const header = await sign(body, ts);
  assertStrictEquals(await verifyPaddleSignature(header, body, SECRET), true);
});

Deno.test('rejects a tampered body', async () => {
  const body = JSON.stringify({ event_type: 'subscription.created' });
  const ts = Math.floor(Date.now() / 1000);
  const header = await sign(body, ts);
  const tampered = body + ' ';
  assertStrictEquals(await verifyPaddleSignature(header, tampered, SECRET), false);
});

Deno.test('rejects an old timestamp (replay protection)', async () => {
  const body = JSON.stringify({ event_type: 'subscription.created' });
  const ts = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
  const header = await sign(body, ts);
  assertStrictEquals(await verifyPaddleSignature(header, body, SECRET), false);
});

Deno.test('rejects a malformed header', async () => {
  const body = '{}';
  assertStrictEquals(await verifyPaddleSignature('h1=abc', body, SECRET), false);
  assertStrictEquals(await verifyPaddleSignature('', body, SECRET), false);
  assertEquals(await verifyPaddleSignature('ts=abc;h1=def', body, SECRET), false);
});

Deno.test('rejects a wrong secret', async () => {
  const body = JSON.stringify({ event_type: 'subscription.created' });
  const ts = Math.floor(Date.now() / 1000);
  const header = await sign(body, ts);
  assertStrictEquals(await verifyPaddleSignature(header, body, 'wrong-secret'), false);
});
