import {
  SupabaseApiClient, setupNewAccount, encryptNote, bytesToBase64,
  hlcZero, hlcTick, hlcEncode, uuidv4,
} from './dist/index.js';
import { createClient } from '@supabase/supabase-js';

const ANON = process.env.SUPABASE_ANON_KEY;
const URL = 'http://127.0.0.1:54321';
const stamp = Date.now();
const email = `errshape-${stamp}@meo.md`;

const api = new SupabaseApiClient({ url: URL, anonKey: ANON });
await api.signup(email, 'pwpwpwpw');
await api.login(email, 'pwpwpwpw');
const setup = await setupNewAccount('p');
await api.putAccount(setup.wrapper);

const id = uuidv4();
let hlc = hlcZero(); hlc = hlcTick(hlc);
const note = { id, title:'a',body:'a',folder:[],tags:[],links:[],created_at:'',updated_at:'',hlc:hlcEncode(hlc),version:0 };
const e1 = await encryptNote(note, setup.masterRaw);
await api.upsertNote({
  id,
  encrypted_content: bytesToBase64(e1.ciphertext),
  nonce: bytesToBase64(e1.nonce),
  hlc_timestamp: note.hlc,
  updated_at: 0, deleted_at: null, version: 0, size_bytes: e1.ciphertext.length,
});

// Use a raw supabase-js call to get the unmapped error shape
const sb = createClient(URL, ANON, { auth:{persistSession:false}, db:{schema:'meo'} });
const login = await sb.auth.signInWithPassword({ email, password: 'pwpwpwpw' });
console.log('login user:', login.data.user?.id);

const hexCt = '\\x' + Array.from(e1.ciphertext).map(b => b.toString(16).padStart(2,'0')).join('');
const hexNonce = '\\x' + Array.from(e1.nonce).map(b => b.toString(16).padStart(2,'0')).join('');
const { data, error } = await sb.rpc('upsert_note', {
  p_id: id, p_encrypted_content: hexCt, p_nonce: hexNonce,
  p_hlc_timestamp: note.hlc, p_size_bytes: e1.ciphertext.length,
});

console.log('data:', data);
console.log('error keys:', error && Object.keys(error));
console.log('error:', JSON.stringify(error, null, 2));
