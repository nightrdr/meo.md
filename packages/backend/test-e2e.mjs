// End-to-end smoke test: signup → setup encryption → create note → sync → verify decrypt.
// Requires backend running on $API (default http://localhost:8787) and built shared package.

import { strict as assert } from 'node:assert';
import {
  ApiClient, setupNewAccount, unlockAccount, encryptNote, decryptNote,
  bytesToBase64, base64ToBytes, hlcZero, hlcTick, hlcEncode, uuidv4,
} from '../shared/dist/index.js';

const api = new ApiClient(process.env.API ?? 'http://localhost:8787');
const email = `test-${Date.now()}@meo.md`;
const accountPassword = 'login-pass-' + Date.now();
const encPassphrase = 'super-secret-passphrase';

console.log('1. health…');
const health = await fetch(api.baseUrl + '/healthz').then(r => r.json());
assert.equal(health.ok, true);

console.log('2. signup…');
const signup = await api.signup(email, accountPassword);
assert.ok(signup.user_id);

console.log('3. login…');
const login = await api.login(email, accountPassword);
assert.equal(login.has_account, false);

console.log('4. set up encryption (PUT /account)…');
const setup = await setupNewAccount(encPassphrase);
await api.putAccount(setup.wrapper);

console.log('5. login again, expect has_account=true; recover master key…');
const login2 = await api.login(email, accountPassword);
assert.equal(login2.has_account, true);
const wrapper = await api.getAccount();
const masterRaw = await unlockAccount(encPassphrase, setup.secretKey, wrapper);
assert.deepEqual(Array.from(masterRaw), Array.from(setup.masterRaw), 'master key recovered from server-stored wrapper');

console.log('6. encrypt + upsert a note…');
let hlc = hlcZero();
hlc = hlcTick(hlc);
const note = {
  id: uuidv4(),
  title: 'First note',
  body: '# Hello\n\nThis is **e2e** encrypted.\n\nFolder = Work/Q1.',
  folder: ['Work', 'Q1'],
  tags: ['draft'],
  links: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  hlc: hlcEncode(hlc),
  version: 0,
};
const enc = await encryptNote(note, masterRaw);
const saved = await api.upsertNote({
  id: note.id,
  encrypted_content: bytesToBase64(enc.ciphertext),
  nonce: bytesToBase64(enc.nonce),
  hlc_timestamp: note.hlc,
  updated_at: 0, deleted_at: null, version: 0, size_bytes: enc.ciphertext.length,
});
assert.ok(saved.version > 0, 'server assigned version');

console.log('7. sync /sync/notes?since=0 → expect our note, decrypt, compare…');
const sync = await api.syncNotes(0);
assert.equal(sync.notes.length, 1);
const row = sync.notes[0];
const decoded = await decryptNote(base64ToBytes(row.encrypted_content), base64ToBytes(row.nonce), row.id, masterRaw);
assert.equal(decoded.title, 'First note');
assert.deepEqual(decoded.folder, ['Work', 'Q1']);

console.log('8. update note → new version, sync since old cursor returns it…');
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
assert.equal(sync2.notes[0].id, note.id);

console.log('9. stale write rejected (older HLC)…');
let staleErr = null;
try {
  await api.upsertNote({
    id: note.id, encrypted_content: bytesToBase64(enc.ciphertext), nonce: bytesToBase64(enc.nonce),
    hlc_timestamp: note.hlc, // older HLC
    updated_at: 0, deleted_at: null, version: 0, size_bytes: enc.ciphertext.length,
  });
} catch (e) { staleErr = e; }
assert.ok(staleErr, 'stale upsert should 409');
assert.equal(staleErr.status, 409);

console.log('10. delete (tombstone)…');
const tomb = await api.deleteNote(note.id);
assert.ok(tomb.deleted_at);
const sync3 = await api.syncNotes(saved2.version);
assert.equal(sync3.notes.length, 1);
assert.ok(sync3.notes[0].deleted_at);

console.log('11. cross-tenant isolation: another user cannot read first user\'s notes…');
const email2 = `other-${Date.now()}@meo.md`;
await api.signup(email2, 'pw-other-1234');
const login3 = await api.login(email2, 'pw-other-1234'); // this swaps the JWT in the client
const sync4 = await api.syncNotes(0);
assert.equal(sync4.notes.length, 0, 'second user must see zero notes');

console.log('\nAll e2e tests passed.');
