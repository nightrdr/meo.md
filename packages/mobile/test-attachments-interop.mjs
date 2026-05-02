// Cross-platform interop for the attachments E2EE pipeline.
//
// Asserts: a payload encrypted with the **mobile** noble-based attachments
// module decrypts cleanly on **desktop** (Web Crypto), and vice versa.
//
// Relies on Supabase + the attachments-* Edge Functions running locally
// (same prerequisites as test-attachments-e2e.mjs in the shared package).

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ── Compile mobile shared with the attachments module ────────────────────
// (Same trick as test-interop.mjs: tsc → post-process .js extensions.)
const sources = execSync(
  `find src/shared -name '*.ts' -not -name '*.d.ts' -not -path '*/ai/*'`,
  { cwd: __dirname },
).toString().trim().split('\n').filter(Boolean);
execSync(
  `npx tsc --module ES2022 --target ES2022 --moduleResolution node --esModuleInterop --skipLibCheck --outDir test-dist ${sources.map(s => `'${s}'`).join(' ')}`,
  { cwd: __dirname, stdio: 'inherit' },
);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
for (const p of walk(path.join(__dirname, 'test-dist'))) {
  let s = fs.readFileSync(p, 'utf8');
  s = s.replace(/from ['"](\.\.?\/[^'"]+)['"]/g, (_m, spec) =>
    spec.endsWith('.js') ? `from '${spec}'` : `from '${spec}.js'`,
  );
  s = s.replace(/^export \* as ai from .*ai\/index.*;\s*$/gm, '');
  fs.writeFileSync(p, s);
}

const mobile = await import('./test-dist/index.js');
const desktop = await import('../shared/dist/index.js');

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_ANON_KEY) {
  console.error('Set SUPABASE_ANON_KEY (run `supabase status | grep Publishable | awk \"{print $4}\"`).');
  process.exit(2);
}

// ── Sign up + set up encryption (using the desktop crypto path; the noble
// path is verified separately by test-interop.mjs already) ───────────────
const stamp = Date.now();
const email = `attach-interop-${stamp}@meo.md`;
const password = 'pwpwpwpw';

const desktopApi = new desktop.SupabaseApiClient({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
await desktopApi.signup(email, password);
const login = await desktopApi.login(email, password);
const setup = await desktop.setupNewAccount('attach-interop-passphrase');
await desktopApi.putAccount(setup.wrapper);
const masterRaw = setup.masterRaw;

// Create a parent note to hang attachments off of
const note = {
  id: desktop.uuidv4(),
  title: 'attach-interop',
  body: '',
  folder: [], tags: [], links: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  hlc: '0000000000001-00000',
  version: 0,
};
const enc = await desktop.encryptNote(note, masterRaw);
await desktopApi.upsertNote({
  id: note.id,
  encrypted_content: desktop.bytesToBase64(enc.ciphertext),
  nonce: desktop.bytesToBase64(enc.nonce),
  hlc_timestamp: note.hlc,
  updated_at: 0, deleted_at: null, version: 0, size_bytes: enc.ciphertext.length,
});

// ── Build clients on both sides ──────────────────────────────────────────
const mobileClient = mobile.createAttachmentsClient(SUPABASE_URL, SUPABASE_ANON_KEY, login.jwt, masterRaw);
const desktopClient = desktop.createAttachmentsClient(SUPABASE_URL, SUPABASE_ANON_KEY, login.jwt, masterRaw, `${SUPABASE_URL}/functions/v1`);

// Mobile uploads via .functions.invoke. The Edge Functions runtime listens
// on the same port but a different endpoint shape - point the client at it.
mobileClient['functionsBaseUrl'] = `${SUPABASE_URL}/functions/v1`;

// ── Test 1: mobile-encrypted bytes decrypt on desktop ────────────────────
const payload1 = new TextEncoder().encode('hello from mobile (noble) → desktop (web crypto)');
console.log('1. mobile encrypts → desktop decrypts');
const up1 = await mobileClient.upload(note.id, {
  bytes: payload1, filename: 'mobile-source.txt', mimeType: 'text/plain',
});
const dl1 = await desktopClient.download(up1.id);
assert.deepEqual(Array.from(dl1.bytes), Array.from(payload1));
assert.equal(dl1.metadata.filename, 'mobile-source.txt');
console.log(`   ✓ ${up1.encrypted_size} bytes round-tripped, filename match`);

// ── Test 2: desktop-encrypted bytes decrypt on mobile ────────────────────
const payload2 = new TextEncoder().encode('hello from desktop (web crypto) → mobile (noble)');
console.log('2. desktop encrypts → mobile decrypts');
const up2 = await desktopClient.upload(note.id, {
  bytes: payload2, filename: 'desktop-source.txt', mimeType: 'text/plain',
});
const dl2 = await mobileClient.download(up2.id);
assert.deepEqual(Array.from(dl2.bytes), Array.from(payload2));
assert.equal(dl2.metadata.filename, 'desktop-source.txt');
console.log(`   ✓ ${up2.encrypted_size} bytes round-tripped, filename match`);

// ── Test 3: quota function returns sensible values ──────────────────────
console.log('3. quota check');
const q = await mobileClient.quota();
assert.ok(q.usedBytes >= up1.encrypted_size + up2.encrypted_size,
  `expected used >= ${up1.encrypted_size + up2.encrypted_size}, got ${q.usedBytes}`);
assert.equal(q.quotaBytes, 10 * 1024 * 1024 * 1024);
console.log(`   ✓ used=${q.usedBytes} quota=${q.quotaBytes}`);

console.log('\nAll attachment cross-platform interop tests passed.');
