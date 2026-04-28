// E2E test against the local Supabase stack. Mirrors backend/test-e2e.mjs.
// Requires `supabase start` to be running first.

import { strict as assert } from 'node:assert';
import {
  SupabaseApiClient, setupNewAccount, unlockAccount, encryptNote, decryptNote,
  bytesToBase64, base64ToBytes, hlcZero, hlcTick, hlcEncode, uuidv4,
} from './dist/index.js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_ANON_KEY) {
  console.error('Set SUPABASE_ANON_KEY (run: supabase status | grep Publishable | awk \'{print $3}\').');
  process.exit(2);
}

const api = new SupabaseApiClient({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
const stamp = Date.now();
const email = `test-${stamp}@meo.md`;
const accountPassword = 'login-pass-' + stamp;
const encPassphrase = 'super-secret-passphrase';

console.log('1. signup…');
const signup = await api.signup(email, accountPassword);
assert.ok(signup.user_id);

console.log('2. login…');
const login = await api.login(email, accountPassword);
assert.equal(login.has_account, false);

console.log('3. set up encryption (PUT /account)…');
const setup = await setupNewAccount(encPassphrase);
await api.putAccount(setup.wrapper);

console.log('4. login again, expect has_account=true; recover master key…');
const login2 = await api.login(email, accountPassword);
assert.equal(login2.has_account, true);
const wrapper = await api.getAccount();
const masterRaw = await unlockAccount(encPassphrase, setup.secretKey, wrapper);
assert.deepEqual(Array.from(masterRaw), Array.from(setup.masterRaw));

console.log('5. encrypt + upsert a note…');
let hlc = hlcZero();
hlc = hlcTick(hlc);
const note = {
  id: uuidv4(),
  title: 'First note', body: '# Hello\n\nThis is **e2e** encrypted via Supabase.',
  folder: ['Work', 'Q1'], tags: ['draft'], links: [],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  hlc: hlcEncode(hlc), version: 0,
};
const enc = await encryptNote(note, masterRaw);
const saved = await api.upsertNote({
  id: note.id,
  encrypted_content: bytesToBase64(enc.ciphertext),
  nonce: bytesToBase64(enc.nonce),
  hlc_timestamp: note.hlc,
  updated_at: 0, deleted_at: null, version: 0, size_bytes: enc.ciphertext.length,
});
assert.ok(saved.version > 0);

console.log('6. sync since=0 → expect our note, decrypt, compare…');
const sync = await api.syncNotes(0);
assert.equal(sync.notes.length, 1);
const decoded = await decryptNote(base64ToBytes(sync.notes[0].encrypted_content), base64ToBytes(sync.notes[0].nonce), sync.notes[0].id, masterRaw);
assert.equal(decoded.title, 'First note');
assert.deepEqual(decoded.folder, ['Work', 'Q1']);

console.log('7. update → new version, sync since old cursor returns it…');
const oldVersion = saved.version;
hlc = hlcTick(hlc);
const note2 = { ...note, title: 'Updated title', hlc: hlcEncode(hlc) };
const enc2 = await encryptNote(note2, masterRaw);
const saved2 = await api.upsertNote({
  id: note.id, encrypted_content: bytesToBase64(enc2.ciphertext), nonce: bytesToBase64(enc2.nonce),
  hlc_timestamp: note2.hlc, updated_at: 0, deleted_at: null, version: 0, size_bytes: enc2.ciphertext.length,
});
assert.ok(saved2.version > oldVersion);
const sync2 = await api.syncNotes(oldVersion);
assert.equal(sync2.notes.length, 1);

console.log('8. stale write rejected (older HLC)…');
let staleErr = null;
try {
  await api.upsertNote({
    id: note.id, encrypted_content: bytesToBase64(enc.ciphertext), nonce: bytesToBase64(enc.nonce),
    hlc_timestamp: note.hlc, // older
    updated_at: 0, deleted_at: null, version: 0, size_bytes: enc.ciphertext.length,
  });
} catch (e) { staleErr = e; }
assert.ok(staleErr, 'stale upsert should be rejected');
assert.equal(staleErr.status, 409);

console.log('9. delete (tombstone)…');
const tomb = await api.deleteNote(note.id);
assert.ok(tomb.deleted_at);
const sync3 = await api.syncNotes(saved2.version);
assert.equal(sync3.notes.length, 1);
assert.ok(sync3.notes[0].deleted_at);

console.log('10. cross-tenant isolation (RLS)…');
const email2 = `other-${stamp}@meo.md`;
const api2 = new SupabaseApiClient({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
await api2.signup(email2, 'pw-other-1234');
await api2.login(email2, 'pw-other-1234');
const sync4 = await api2.syncNotes(0);
assert.equal(sync4.notes.length, 0, 'second user must see zero notes via RLS');

console.log('\nAll Supabase e2e tests passed.');
