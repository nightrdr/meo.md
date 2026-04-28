// Standalone crypto smoke test against the built dist.
// Run: node test-crypto.mjs

import { strict as assert } from 'node:assert';
import {
  setupNewAccount, unlockAccount, encryptNote, decryptNote,
  formatSecretKey, parseSecretKey, generateSecretKeyBytes,
  hlcZero, hlcTick, hlcEncode, hlcDecode, hlcCompare,
} from './dist/index.js';

// 1. Round-trip: signup -> wrap master key -> unlock -> recover same master key
{
  const { wrapper, masterRaw, secretKey } = await setupNewAccount('correct-horse-battery');
  const recovered = await unlockAccount('correct-horse-battery', secretKey, wrapper);
  assert.deepEqual(Array.from(recovered), Array.from(masterRaw), 'master key round-trips');
  console.log('OK: master key round-trip');
}

// 2. Wrong passphrase fails to unlock
{
  const { wrapper, secretKey } = await setupNewAccount('right-pass');
  let threw = false;
  try { await unlockAccount('wrong-pass', secretKey, wrapper); } catch { threw = true; }
  assert.ok(threw, 'wrong passphrase must fail');
  console.log('OK: wrong passphrase rejected');
}

// 3. Wrong secret key fails to unlock
{
  const { wrapper } = await setupNewAccount('p');
  const fakeSk = generateSecretKeyBytes();
  let threw = false;
  try { await unlockAccount('p', fakeSk, wrapper); } catch { threw = true; }
  assert.ok(threw, 'wrong secret key must fail');
  console.log('OK: wrong secret key rejected');
}

// 4. Note encrypt/decrypt round-trip
{
  const { masterRaw } = await setupNewAccount('p');
  const note = {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Hello',
    body: '# heading\n\nbody **bold**',
    folder: ['Work', 'Q1'],
    tags: ['draft'],
    links: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    hlc: '0000000000000-00000',
    version: 0,
  };
  const { ciphertext, nonce } = await encryptNote(note, masterRaw);
  const decoded = await decryptNote(ciphertext, nonce, note.id, masterRaw);
  assert.deepEqual(decoded, note);
  console.log('OK: note round-trip');
}

// 5. Per-note key isolation: encrypting same plaintext with different note ids gives different ciphertext
{
  const { masterRaw } = await setupNewAccount('p');
  const a = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title:'x',body:'x',folder:[],tags:[],links:[],created_at:'',updated_at:'',hlc:'',version:0 };
  const b = { ...a, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
  const ea = await encryptNote(a, masterRaw);
  const eb = await encryptNote(b, masterRaw);
  // Different per-note keys + nonces; ciphertexts must differ.
  assert.notDeepEqual(Array.from(ea.ciphertext), Array.from(eb.ciphertext));
  console.log('OK: per-note key isolation');
}

// 6. Secret key formatting round-trip
{
  const sk = generateSecretKeyBytes();
  const formatted = formatSecretKey(sk);
  const parsed = parseSecretKey(formatted);
  assert.deepEqual(Array.from(sk), Array.from(parsed));
  console.log('OK: secret key format round-trip:', formatted);
}

// 7. HLC monotonicity
{
  let s = hlcZero();
  s = hlcTick(s, 1000);
  const a = hlcEncode(s);
  s = hlcTick(s, 1000); // same ms → counter++
  const b = hlcEncode(s);
  s = hlcTick(s, 2000); // newer ms → counter resets
  const c = hlcEncode(s);
  assert.ok(hlcCompare(a, b) < 0, 'a < b');
  assert.ok(hlcCompare(b, c) < 0, 'b < c');
  // round-trip
  assert.equal(hlcEncode(hlcDecode(c)), c);
  console.log('OK: HLC monotonic + round-trip');
}

console.log('\nAll crypto tests passed.');
