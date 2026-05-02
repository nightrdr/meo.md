// Supabase-backed implementation of the same surface as ApiClient (api.ts).
// Drop-in replacement: same methods, same return types, same wire format.
//
// The data path:
//   - Auth: Supabase GoTrue (signUp / signInWithPassword)
//   - Encryption wrapper: meo.accounts table via PostgREST (RLS-enforced)
//   - Notes sync (read): meo.notes table via PostgREST (RLS-enforced)
//   - Notes upsert: meo.upsert_note RPC (atomic version bump + HLC check)
//   - Notes delete: meo.delete_note RPC (tombstone + version bump)
//
// All blob columns (bytea) round-trip via base64 — same as the Hono backend.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AccountWrapper, EncryptedNoteRow, AuthSignupResponse, AuthLoginResponse, SyncResponse,
} from './types.js';
import { ApiError } from './api.js';

export interface SupabaseConfig {
  url: string;       // e.g. http://127.0.0.1:54321
  anonKey: string;   // public anon key
}

export class SupabaseApiClient {
  public baseUrl: string;
  public jwt?: string;
  private sb: SupabaseClient;
  private userId?: string;

  constructor(config: SupabaseConfig, jwt?: string) {
    this.baseUrl = config.url;
    this.jwt = jwt;
    this.sb = createClient(config.url, config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'meo' as any },
    });
    if (jwt) {
      // Manually install the JWT so PostgREST sees the user
      (this.sb as any).rest.headers['authorization'] = `Bearer ${jwt}`;
      (this.sb as any).realtime.setAuth(jwt);
    }
  }

  setJwt(jwt: string | undefined) {
    this.jwt = jwt;
    if (jwt) {
      (this.sb as any).rest.headers['authorization'] = `Bearer ${jwt}`;
    } else {
      delete (this.sb as any).rest.headers['authorization'];
    }
  }

  /**
   * Password signup. Kept for the e2e test scripts (which need a fast
   * non-interactive auth path) and for the legacy Hono backend's
   * compatibility tests. The desktop UI uses requestEmailOtp /
   * verifyEmailOtp instead.
   */
  async signup(email: string, password: string): Promise<AuthSignupResponse> {
    const { data, error } = await this.sb.auth.signUp({ email, password });
    if (error) throw new ApiError(error.status ?? 400, { error: error.message, code: (error as any).code });
    if (!data.user) throw new ApiError(500, { error: 'signup returned no user' });
    return { user_id: data.user.id };
  }

  /** Password login — same caveat as signup() above. */
  async login(email: string, password: string): Promise<AuthLoginResponse> {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw new ApiError(error.status ?? 401, { error: error.message, code: (error as any).code });
    if (!data.session || !data.user) throw new ApiError(500, { error: 'login returned no session' });
    return this.adoptSession(data.session.access_token, data.user.id);
  }

  /**
   * Step 1 of the email-OTP flow. Sends a 6-digit code to `email` via
   * GoTrue's signInWithOtp. `shouldCreateUser: true` (the GoTrue
   * default) means new emails are signed up implicitly on the first
   * verifyEmailOtp — there is no separate signup step.
   *
   * Returns silently on success; throws an ApiError with a useful
   * message on rate-limiting, invalid email, or disabled email auth.
   */
  async requestEmailOtp(email: string): Promise<{ sent: true }> {
    const { error } = await this.sb.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        // Force OTP-style code rather than magic link — the desktop UI
        // wants the user to type 6 digits, not click a URL that would
        // open in their default browser.
        emailRedirectTo: undefined,
      },
    });
    if (error) throw new ApiError(error.status ?? 400, { error: error.message, code: (error as any).code });
    return { sent: true };
  }

  /**
   * Step 2 of the email-OTP flow. Exchanges `token` for a session.
   * Same return shape as login() so the caller doesn't care which auth
   * path was used. has_account tells the UI whether to send the user
   * to the unlock screen (returning) or the setup screen (new user).
   */
  async verifyEmailOtp(email: string, token: string): Promise<AuthLoginResponse> {
    const { data, error } = await this.sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw new ApiError(error.status ?? 400, { error: error.message, code: (error as any).code });
    if (!data.session || !data.user) throw new ApiError(500, { error: 'verifyOtp returned no session' });
    return this.adoptSession(data.session.access_token, data.user.id);
  }

  /**
   * Common postlude for any auth path that yielded a session: install
   * the JWT on the rest client, look up has_account, and return the
   * shape the UI expects.
   */
  private async adoptSession(jwt: string, userId: string): Promise<AuthLoginResponse> {
    this.jwt = jwt;
    this.userId = userId;
    (this.sb as any).rest.headers['authorization'] = `Bearer ${jwt}`;
    const { count, error } = await this.sb
      .from('accounts')
      .select('user_id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) throw new ApiError(500, { error: error.message });
    return { jwt, has_account: (count ?? 0) > 0, user_id: userId };
  }

  async getAccount(): Promise<AccountWrapper> {
    if (!this.userId) {
      // try to recover from JWT — sb.auth.getUser handles it
      const { data, error } = await this.sb.auth.getUser(this.jwt);
      if (error || !data.user) throw new ApiError(401, { error: 'not authenticated' });
      this.userId = data.user.id;
    }
    const { data, error } = await this.sb
      .from('accounts')
      .select('salt, encrypted_master_key, master_key_nonce, kdf_params')
      .eq('user_id', this.userId)
      .single();
    if (error) {
      if (error.code === 'PGRST116') throw new ApiError(404, { error: 'no account' });
      throw new ApiError(500, { error: error.message });
    }
    return {
      salt: hexToBase64(data.salt as unknown as string),
      encrypted_master_key: hexToBase64(data.encrypted_master_key as unknown as string),
      master_key_nonce: hexToBase64(data.master_key_nonce as unknown as string),
      kdf_params: data.kdf_params,
    };
  }

  async putAccount(wrapper: AccountWrapper): Promise<{ ok: true }> {
    if (!this.userId) {
      const { data } = await this.sb.auth.getUser(this.jwt);
      if (!data.user) throw new ApiError(401, { error: 'not authenticated' });
      this.userId = data.user.id;
    }
    const { error } = await this.sb.from('accounts').insert({
      user_id: this.userId,
      salt: base64ToHex(wrapper.salt),
      encrypted_master_key: base64ToHex(wrapper.encrypted_master_key),
      master_key_nonce: base64ToHex(wrapper.master_key_nonce),
      kdf_params: wrapper.kdf_params,
    });
    if (error) {
      if (error.code === '23505') throw new ApiError(409, { error: 'account already initialized' });
      throw new ApiError(500, { error: error.message });
    }
    return { ok: true };
  }

  async syncNotes(since: number): Promise<SyncResponse> {
    const { data, error } = await this.sb
      .from('notes')
      .select('id, encrypted_content, nonce, version, hlc_timestamp, updated_at, deleted_at, size_bytes')
      .gt('version', since)
      .order('version', { ascending: true });
    if (error) throw new ApiError(500, { error: error.message });
    const rows: EncryptedNoteRow[] = (data ?? []).map(r => ({
      id: r.id,
      encrypted_content: hexToBase64(r.encrypted_content as unknown as string),
      nonce: hexToBase64(r.nonce as unknown as string),
      version: Number(r.version),
      hlc_timestamp: r.hlc_timestamp,
      updated_at: typeof r.updated_at === 'string' ? Date.parse(r.updated_at) : Number(r.updated_at),
      deleted_at: r.deleted_at == null ? null : (typeof r.deleted_at === 'string' ? Date.parse(r.deleted_at) : Number(r.deleted_at)),
      size_bytes: Number(r.size_bytes ?? 0),
    }));
    const cursor = rows.length ? rows[rows.length - 1].version : since;
    return { notes: rows, cursor };
  }

  async upsertNote(row: EncryptedNoteRow): Promise<EncryptedNoteRow> {
    const { data, error } = await this.sb.rpc('upsert_note', {
      p_id: row.id,
      p_encrypted_content: base64ToHex(row.encrypted_content),
      p_nonce: base64ToHex(row.nonce),
      p_hlc_timestamp: row.hlc_timestamp,
      p_size_bytes: row.size_bytes,
    });
    if (error) {
      throw mapPgError(error);
    }
    const r = data as any;
    return {
      id: r.id,
      encrypted_content: hexToBase64(r.encrypted_content),
      nonce: hexToBase64(r.nonce),
      version: Number(r.version),
      hlc_timestamp: r.hlc_timestamp,
      updated_at: typeof r.updated_at === 'string' ? Date.parse(r.updated_at) : Number(r.updated_at),
      deleted_at: r.deleted_at == null ? null : (typeof r.deleted_at === 'string' ? Date.parse(r.deleted_at) : Number(r.deleted_at)),
      size_bytes: Number(r.size_bytes ?? 0),
    };
  }

  async deleteNote(id: string): Promise<EncryptedNoteRow> {
    const { data, error } = await this.sb.rpc('delete_note', { p_id: id });
    if (error) {
      throw mapPgError(error);
    }
    const r = data as any;
    return {
      id: r.id,
      encrypted_content: hexToBase64(r.encrypted_content),
      nonce: hexToBase64(r.nonce),
      version: Number(r.version),
      hlc_timestamp: r.hlc_timestamp,
      updated_at: typeof r.updated_at === 'string' ? Date.parse(r.updated_at) : Number(r.updated_at),
      deleted_at: r.deleted_at == null ? null : (typeof r.deleted_at === 'string' ? Date.parse(r.deleted_at) : Number(r.deleted_at)),
      size_bytes: Number(r.size_bytes ?? 0),
    };
  }
}

// Map a PostgREST/Postgres error into our ApiError with the same HTTP status
// codes the Hono backend would have used.
function mapPgError(error: { code?: string; message?: string }): ApiError {
  const code = error.code ?? '';
  const msg = error.message ?? '';
  // PostgREST surfaces Postgres SQLSTATE codes via error.code:
  //   40001 = our "stale write" (raised in upsert_note)
  //   42501 = forbidden (raised in upsert_note / delete_note)
  //   28000 = unauthorized (raised when auth.uid() is null)
  //   P0002 = not found (raised in delete_note)
  //   23505 = unique_violation (account already exists)
  if (code === '40001' || msg.includes('stale write')) return new ApiError(409, { error: msg });
  if (code === '42501' || msg.includes('forbidden')) return new ApiError(403, { error: msg });
  if (code === '28000' || msg.includes('unauthorized')) return new ApiError(401, { error: msg });
  if (code === 'P0002' || msg.includes('not found')) return new ApiError(404, { error: msg });
  if (code === '23505') return new ApiError(409, { error: msg });
  return new ApiError(500, { error: msg });
}

// PostgREST encodes bytea as a hex string starting with `\x` by default.
// We translate to/from base64 so the wire format matches our Hono backend's API.
function hexToBase64(hex: string): string {
  if (!hex) return '';
  const stripped = hex.startsWith('\\x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa !== 'undefined' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

function base64ToHex(b64: string): string {
  let bytes: Uint8Array;
  if (typeof atob !== 'undefined') {
    const binary = atob(b64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  }
  let hex = '\\x';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}
