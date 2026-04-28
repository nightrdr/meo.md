// Cross-implementation interop test:
//   - Encrypt a note with the mobile (noble) crypto module.
//   - Decrypt it with the desktop (Web Crypto) module.
//   - And vice versa.
// If both ciphertexts round-trip across implementations, the key hierarchy
// + AES-GCM nonce/tag layout matches.

// Note: react-native-get-random-values is RN-only and doesn't run under Node;
// Node 22 already provides crypto.getRandomValues via globalThis.crypto, which is
// what the mobile crypto module reads. So we test the *logic* under Node and
// trust the polyfill on RN to provide the same crypto.getRandomValues contract.
import { strict as assert } from 'node:assert';

// Node 22 has Web Crypto in globalThis.crypto, so importing the desktop module works.
import * as desktop from '../shared/dist/index.js';

// Import mobile's noble-based module via tsx-style transpile.
// We can't import .ts directly in plain Node, so we'll use jiti or the precompiled output.
// Simpler: tsc-compile mobile/src/shared into a tmp dir.

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Compile mobile shared sources to ESM, then post-process imports to add .js extensions
// so plain Node ESM can resolve them.
execSync(
  `npx tsc --module ES2022 --target ES2022 --moduleResolution node --esModuleInterop --skipLibCheck --outDir test-dist src/shared/*.ts`,
  { cwd: __dirname, stdio: 'inherit' },
);
for (const f of fs.readdirSync(path.join(__dirname, 'test-dist'))) {
  if (!f.endsWith('.js')) continue;
  const p = path.join(__dirname, 'test-dist', f);
  let s = fs.readFileSync(p, 'utf8');
  s = s.replace(/from ['"](\.\/[^'"]+)['"]/g, (_m, spec) => spec.endsWith('.js') ? `from '${spec}'` : `from '${spec}.js'`);
  fs.writeFileSync(p, s);
}
const mobile = await import('./test-dist/index.js');

// Test 1: setup on mobile, unlock on desktop
{
  const passphrase = 'cross-impl-pass';
  const m = await mobile.setupNewAccount(passphrase);
  // Use the shared wrapper format
  const recoveredOnDesktop = await desktop.unlockAccount(passphrase, m.secretKey, m.wrapper);
  assert.deepEqual(Array.from(recoveredOnDesktop), Array.from(m.masterRaw));
  console.log('OK: mobile-setup → desktop-unlock');
}

// Test 2: setup on desktop, unlock on mobile
{
  const passphrase = 'cross-impl-pass-2';
  const d = await desktop.setupNewAccount(passphrase);
  const recoveredOnMobile = await mobile.unlockAccount(passphrase, d.secretKey, d.wrapper);
  assert.deepEqual(Array.from(recoveredOnMobile), Array.from(d.masterRaw));
  console.log('OK: desktop-setup → mobile-unlock');
}

// Test 3: encrypt on mobile, decrypt on desktop
{
  const masterRaw = new Uint8Array(32); crypto.getRandomValues(masterRaw);
  const note = {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    title: 'cross-impl', body: 'hello', folder: ['x'], tags: [], links: [],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    hlc: '0000000000000-00000', version: 0,
  };
  const enc = mobile.encryptNote(note, masterRaw);
  const dec = await desktop.decryptNote(enc.ciphertext, enc.nonce, note.id, masterRaw);
  assert.deepEqual(dec, note);
  console.log('OK: mobile encrypt → desktop decrypt');
}

// Test 4: encrypt on desktop, decrypt on mobile
{
  const masterRaw = new Uint8Array(32); crypto.getRandomValues(masterRaw);
  const note = {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    title: 'flipped', body: 'pwned by interop', folder: ['y'], tags: [], links: [],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    hlc: '0000000000000-00000', version: 0,
  };
  const enc = await desktop.encryptNote(note, masterRaw);
  const dec = mobile.decryptNote(enc.ciphertext, enc.nonce, note.id, masterRaw);
  assert.deepEqual(dec, note);
  console.log('OK: desktop encrypt → mobile decrypt');
}

console.log('\nAll cross-platform interop tests passed.');
