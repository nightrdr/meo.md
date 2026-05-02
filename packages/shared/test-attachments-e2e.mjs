// E2E round-trip for the attachments pipeline.
// Requires `supabase start` to be running and `supabase functions serve` for
// the attachments-upload-url + attachments-download-url functions.
//
// Run with:
//   SUPABASE_ANON_KEY=$(supabase status -o env | grep ANON_KEY | cut -d= -f2 | tr -d '"') \
//     node packages/shared/test-attachments-e2e.mjs
//
// What it checks:
//   1. Signup, account setup, derive master key (existing pattern).
//   2. Create a note (so the attachment has a parent).
//   3. Upload a 1×1 PNG via the attachments client → encrypted ciphertext goes
//      to Supabase Storage's MinIO via S3 SigV4 PUT.
//   4. List attachments for the note via meo.attachments_for_note → metadata
//      decrypts and matches what we sent.
//   5. Download the same attachment by id → bytes byte-equal what we uploaded.
//   6. Direct DB inspection via psql confirms the filename never appears in
//      the row plaintext (only in encrypted_metadata).
//   7. Direct S3 fetch confirms the bytes in MinIO are NOT the original PNG
//      (i.e. they're ciphertext).

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import {
  SupabaseApiClient, setupNewAccount, unlockAccount, encryptNote,
  hlcZero, hlcTick, hlcEncode, uuidv4, bytesToBase64,
  createAttachmentsClient,
} from './dist/index.js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const FUNCTIONS_URL = process.env.SUPABASE_FUNCTIONS_URL ?? `${SUPABASE_URL}/functions/v1`;
if (!SUPABASE_ANON_KEY) {
  console.error("set SUPABASE_ANON_KEY (run: supabase status | awk '/Publishable/{print $3}')");
  process.exit(2);
}

const stamp = Date.now();
const email = `att-${stamp}@meo.md`;
const accountPassword = 'login-pass-' + stamp;
const encPassphrase = 'super-secret-attachments-passphrase';

console.log('1. signup + login + setup encryption');
const api = new SupabaseApiClient({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
await api.signup(email, accountPassword);
const login = await api.login(email, accountPassword);
const setup = await setupNewAccount(encPassphrase);
await api.putAccount(setup.wrapper);
const wrapper = await api.getAccount();
const masterRaw = await unlockAccount(encPassphrase, setup.secretKey, wrapper);
assert.deepEqual(Array.from(masterRaw), Array.from(setup.masterRaw));

console.log('2. create a note (parent for the attachment)');
let hlc = hlcTick(hlcZero());
const note = {
  id: uuidv4(),
  title: 'Attachments host',
  body: '# Hello\n\nWith an image attached.',
  folder: ['Inbox'],
  tags: ['e2e'],
  links: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  hlc: hlcEncode(hlc),
  version: 0,
};
const enc = await encryptNote(note, masterRaw);
await api.upsertNote({
  id: note.id,
  encrypted_content: bytesToBase64(enc.ciphertext),
  nonce: bytesToBase64(enc.nonce),
  hlc_timestamp: note.hlc,
  updated_at: 0, deleted_at: null, version: 0, size_bytes: enc.ciphertext.length,
});
console.log('   note id =', note.id);

console.log('3. upload a 1x1 PNG attachment');
// Hand-crafted 1x1 transparent PNG (smallest valid one).
const pngB64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQYV2NgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
const pngBytes = Uint8Array.from(Buffer.from(pngB64, 'base64'));

const attClient = createAttachmentsClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  login.jwt,
  masterRaw,
  FUNCTIONS_URL,
);

const uploadRes = await attClient.upload(note.id, {
  bytes: pngBytes,
  filename: 'tiny-secret.png',
  mimeType: 'image/png',
  dimensions: { width: 1, height: 1 },
});
console.log('   attachment id =', uploadRes.id);
console.log('   storage_key   =', uploadRes.storage_key);
console.log('   ciphertext    =', uploadRes.encrypted_size, 'bytes');
assert.equal(uploadRes.encrypted_size, pngBytes.length + 16, 'expect plaintext + 16-byte GCM tag');

console.log('4. list attachments via meo.attachments_for_note');
const listed = await attClient.listForNote(note.id);
assert.equal(listed.length, 1);
assert.equal(listed[0].id, uploadRes.id);
assert.equal(listed[0].metadata.filename, 'tiny-secret.png');
assert.equal(listed[0].metadata.mime_type, 'image/png');
assert.equal(listed[0].metadata.original_size, pngBytes.length);
assert.equal(listed[0].metadata.dimensions?.width, 1);

console.log('5. download + decrypt + byte-compare');
const dl = await attClient.download(uploadRes.id);
assert.equal(dl.metadata.filename, 'tiny-secret.png');
assert.equal(dl.bytes.length, pngBytes.length);
for (let i = 0; i < pngBytes.length; i++) {
  if (dl.bytes[i] !== pngBytes[i]) {
    throw new Error(`byte mismatch at index ${i}`);
  }
}

console.log('6. psql: confirm filename never appears in the row plaintext');
const psqlOut = execSync(
  `PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -t -A -c "select id, storage_key, encrypted_size, length(nonce), length(encrypted_metadata), length(metadata_nonce) from meo.attachments where id = '${uploadRes.id}';"`,
  { encoding: 'utf8' },
);
console.log('   row:', psqlOut.trim());
assert.ok(!psqlOut.includes('tiny-secret'), 'filename leaked into row plaintext!');
assert.ok(psqlOut.includes(uploadRes.id), 'row was not found at all');

console.log('7. inspect storage bytes - must NOT equal the PNG');
//  The download URL is a presigned GET we already used in step 5; ask for a
//  fresh one purely to dump raw bytes for inspection.
const rawResp = await fetch(`${FUNCTIONS_URL}/attachments-download-url`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${login.jwt}` },
  body: JSON.stringify({ attachment_id: uploadRes.id }),
});
assert.ok(rawResp.ok, `download-url fn returned ${rawResp.status}`);
const meta = await rawResp.json();
const rawGet = await fetch(meta.url);
assert.ok(rawGet.ok, `presigned GET returned ${rawGet.status}`);
const stored = new Uint8Array(await rawGet.arrayBuffer());
assert.equal(stored.length, uploadRes.encrypted_size);
// PNG signature is 89 50 4E 47 0D 0A 1A 0A - the ciphertext must NOT start with that.
const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
let differsAtSig = false;
for (let i = 0; i < pngSig.length; i++) {
  if (stored[i] !== pngSig[i]) { differsAtSig = true; break; }
}
assert.ok(differsAtSig, 'storage bytes start with the PNG signature - encryption did not happen!');

console.log('\nAll attachment e2e tests passed.');
