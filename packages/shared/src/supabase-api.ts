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
// All blob columns (bytea) round-trip via base64 - same as the Hono backend.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AccountWrapper, EncryptedNoteRow, AuthSignupResponse, AuthLoginResponse, SyncResponse,
  SubscriptionRow, Tier,
} from './types.js';
import { ApiError } from './api.js';

// ── Devices (Agent 9) ──
export interface DeviceRow {
  device_id: string;
  name: string;
  platform: string;
  ua: string | null;
  ip: string | null;
  first_seen_at: string;
  last_seen: string;
}

// ── Handovers (Agent 9) - see packages/shared/src/pairing.ts ──
export interface HandoverRow {
  ek_a_pub: Uint8Array | null;
  ek_b_pub: Uint8Array | null;
  payload_for_b: Uint8Array | null;
  payload_nonce: Uint8Array | null;
  expires_at: string;
}

export interface SupabaseConfig {
  url: string;       // e.g. http://127.0.0.1:54321
  anonKey: string;   // public anon key
}

/**
 * Refresh callback. Invoked when an authenticated RPC fails with a 401
 * (or PostgREST's PGRST301 "JWT expired"). Implementation is expected
 * to obtain a fresh access token (typically by calling
 * refreshAccessToken with the persisted refresh_token) and ALSO to
 * persist the new token + rotated refresh_token wherever the app
 * keeps long-lived state. Returns the new access token, or null/undef
 * if no refresh is possible (e.g. no refresh_token stored), in which
 * case the original 401 is re-raised to the caller.
 */
export type TokenRefresher = () => Promise<string | undefined | null>;

export class SupabaseApiClient {
  public baseUrl: string;
  public jwt?: string;
  private sb: SupabaseClient;
  private userId?: string;
  // Set via setTokenRefresher; the desktop wires this up after each
  // login / cold-start refresh so mid-session JWT expiry is handled
  // transparently. Without it, every API call after the 1-hour TTL
  // dies with 401 and the user has to re-authenticate.
  private tokenRefresher?: TokenRefresher;

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
   * Register the refresh callback. Pass `undefined` to clear it
   * (e.g. on sign-out). Idempotent.
   */
  setTokenRefresher(refresher: TokenRefresher | undefined) {
    this.tokenRefresher = refresher;
  }

  /**
   * Wrap any authenticated RPC/PostgREST call so that a 401 / "JWT
   * expired" failure triggers exactly one refresh-and-retry attempt.
   * The retry uses the refreshed JWT (installed via setJwt by the
   * tokenRefresher itself). On retry-still-fails or no refresher
   * registered, the original error propagates.
   *
   * Typed loose-ly because supabase-js's builder return types vary
   * (Postgrest builder, RPC builder, auth, etc.). The shape we care
   * about is `{ error?: unknown; data?: unknown }`.
   */
  private async withAuthRetry<T>(
    call: () => PromiseLike<T>,
  ): Promise<T> {
    let result = await call();
    if (this.shouldRetryAfterRefresh((result as any)?.error)) {
      const newJwt = await this.tryRefresh();
      if (newJwt) {
        result = await call();
      }
    }
    return result;
  }

  private shouldRetryAfterRefresh(error: unknown): boolean {
    if (!error || !this.tokenRefresher) return false;
    const e = error as { code?: string; status?: number; message?: string };
    // PostgREST: PGRST301 = JWT expired; HTTP 401 = generally auth
    // GoTrue:    status 401
    if (e.code === 'PGRST301') return true;
    if (e.status === 401) return true;
    if (typeof e.message === 'string' && /jwt expired|invalid jwt|jwt verification/i.test(e.message)) {
      return true;
    }
    return false;
  }

  private async tryRefresh(): Promise<string | null | undefined> {
    if (!this.tokenRefresher) return null;
    try {
      return await this.tokenRefresher();
    } catch {
      return null;
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

  /** Password login - same caveat as signup() above. */
  async login(email: string, password: string): Promise<AuthLoginResponse> {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw new ApiError(error.status ?? 401, { error: error.message, code: (error as any).code });
    if (!data.session || !data.user) throw new ApiError(500, { error: 'login returned no session' });
    return this.adoptSession(data.session.access_token, data.user.id, data.session.refresh_token);
  }

  /**
   * Step 1 of the email-OTP flow. Sends a 6-digit code to `email` via
   * GoTrue's signInWithOtp. `shouldCreateUser: true` (the GoTrue
   * default) means new emails are signed up implicitly on the first
   * verifyEmailOtp - there is no separate signup step.
   *
   * Returns silently on success; throws an ApiError with a useful
   * message on rate-limiting, invalid email, or disabled email auth.
   */
  async requestEmailOtp(email: string): Promise<{ sent: true }> {
    const { error } = await this.sb.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        // Force OTP-style code rather than magic link - the desktop UI
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
    return this.adoptSession(data.session.access_token, data.user.id, data.session.refresh_token);
  }

  /**
   * Cold-start refresh path. Given a long-lived refresh token from a
   * previous session, mint a new access JWT (and a rotated refresh
   * token) without going through OTP again. Throws on a revoked /
   * expired refresh token so the caller can fall back to OTP.
   */
  async refreshAccessToken(refreshToken: string): Promise<AuthLoginResponse> {
    const { data, error } = await this.sb.auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw new ApiError(error.status ?? 401, { error: error.message, code: (error as any).code });
    if (!data.session || !data.user) throw new ApiError(401, { error: 'refresh returned no session' });
    return this.adoptSession(data.session.access_token, data.user.id, data.session.refresh_token);
  }

  /**
   * Common postlude for any auth path that yielded a session: install
   * the JWT on the rest client, look up has_account, and return the
   * shape the UI expects.
   */
  private async adoptSession(jwt: string, userId: string, refreshToken?: string): Promise<AuthLoginResponse> {
    this.jwt = jwt;
    this.userId = userId;
    (this.sb as any).rest.headers['authorization'] = `Bearer ${jwt}`;
    const { count, error } = await this.sb
      .from('accounts')
      .select('user_id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error) throw new ApiError(500, { error: error.message });
    return { jwt, has_account: (count ?? 0) > 0, user_id: userId, refresh_token: refreshToken };
  }

  async getAccount(): Promise<AccountWrapper> {
    if (!this.userId) {
      // try to recover from JWT - sb.auth.getUser handles it
      const { data, error } = await this.sb.auth.getUser(this.jwt);
      if (error || !data.user) throw new ApiError(401, { error: 'not authenticated' });
      this.userId = data.user.id;
    }
    const userId = this.userId;
    const { data, error } = await this.withAuthRetry(() => this.sb
      .from('accounts')
      .select('salt, encrypted_master_key, master_key_nonce, kdf_params')
      .eq('user_id', userId)
      .single());
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
    const { data, error } = await this.withAuthRetry(() => this.sb
      .from('notes')
      .select('id, encrypted_content, nonce, version, hlc_timestamp, updated_at, deleted_at, size_bytes, is_vault')
      .gt('version', since)
      .order('version', { ascending: true }));
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
      is_vault: Boolean((r as any).is_vault ?? false),
    }));
    const cursor = rows.length ? rows[rows.length - 1].version : since;
    return { notes: rows, cursor };
  }

  async upsertNote(row: EncryptedNoteRow): Promise<EncryptedNoteRow> {
    const { data, error } = await this.withAuthRetry(() => this.sb.rpc('upsert_note', {
      p_id: row.id,
      p_encrypted_content: base64ToHex(row.encrypted_content),
      p_nonce: base64ToHex(row.nonce),
      p_hlc_timestamp: row.hlc_timestamp,
      p_size_bytes: row.size_bytes,
      p_is_vault: Boolean(row.is_vault ?? false),
    }));
    if (error) {
      throw mapPgError(error);
    }
    return parseNoteRow(data, row.id);
  }

  async deleteNote(id: string): Promise<EncryptedNoteRow> {
    const { data, error } = await this.withAuthRetry(() => this.sb.rpc('delete_note', { p_id: id }));
    if (error) {
      throw mapPgError(error);
    }
    return parseNoteRow(data, id);
  }

  // ── Devices (Agent 9) ──

  async listDevices(): Promise<DeviceRow[]> {
    const { data, error } = await this.sb.rpc('devices_list');
    if (error) throw mapPgError(error as any);
    return ((data as any[]) ?? []).map((r: any) => ({
      device_id: String(r.device_id),
      name: String(r.name ?? 'Unnamed device'),
      platform: String(r.platform ?? 'unknown'),
      ua: r.ua ?? null,
      ip: r.ip ?? null,
      first_seen_at: String(r.first_seen_at),
      last_seen: String(r.last_seen),
    }));
  }

  async registerDevice(deviceId: string, platform: string, name: string, ua: string | null = null): Promise<void> {
    const { error } = await this.sb.rpc('device_register', {
      p_device_id: deviceId,
      p_platform: platform,
      p_name: name,
      p_ua: ua,
    });
    if (error) throw mapPgError(error as any);
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const { error } = await this.sb.rpc('device_revoke', { p_device_id: deviceId });
    if (error) throw mapPgError(error as any);
  }

  // ── Handovers (Agent 9) ──
  //
  // Anon-callable bearer-token semantics: the handover_id IS the secret.

  async handoverCreate(id: string, ekAPub: Uint8Array): Promise<void> {
    const { error } = await this.sb.rpc('handover_create', {
      p_id: id,
      p_ek_a_pub: bytesToHex(ekAPub),
    });
    if (error) throw mapPgError(error as any);
  }

  async handoverPutB(id: string, ekBPub: Uint8Array): Promise<void> {
    const { error } = await this.sb.rpc('handover_put_b', {
      p_id: id,
      p_ek_b_pub: bytesToHex(ekBPub),
    });
    if (error) throw mapPgError(error as any);
  }

  async handoverPutPayload(id: string, payload: Uint8Array, nonce: Uint8Array): Promise<void> {
    const { error } = await this.sb.rpc('handover_put_payload', {
      p_id: id,
      p_payload: bytesToHex(payload),
      p_payload_nonce: bytesToHex(nonce),
    });
    if (error) throw mapPgError(error as any);
  }

  async handoverGet(id: string): Promise<HandoverRow | null> {
    const { data, error } = await this.sb.rpc('handover_get', { p_id: id });
    if (error) throw mapPgError(error as any);
    const arr = (data as any[]) ?? [];
    if (arr.length === 0) return null;
    const r = arr[0];
    return {
      ek_a_pub: r.ek_a_pub ? hexToBytes(r.ek_a_pub) : null,
      ek_b_pub: r.ek_b_pub ? hexToBytes(r.ek_b_pub) : null,
      payload_for_b: r.payload_for_b ? hexToBytes(r.payload_for_b) : null,
      payload_nonce: r.payload_nonce ? hexToBytes(r.payload_nonce) : null,
      expires_at: String(r.expires_at),
    };
  }

  async handoverClear(id: string): Promise<void> {
    const { error } = await this.sb.rpc('handover_clear', { p_id: id });
    if (error) throw mapPgError(error as any);
  }

  // ─── 2FA (Agent 8) ───────────────────────────────────────────────

  async tfaStatus(): Promise<boolean> {
    const { data, error } = await this.sb.rpc('tfa_status');
    if (error) throw mapPgError(error as any);
    return Boolean(data);
  }

  async tfaEnroll(): Promise<{ otpauth_url: string; secret_b32: string }> {
    if (!this.jwt) throw new ApiError(401, { error: 'not authenticated' });
    const url = `${this.baseUrl.replace(/\/$/, '')}/functions/v1/tfa-enroll`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${this.jwt}`, 'content-type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body);
    return body;
  }

  async tfaVerify(code: string): Promise<{ token: string; expires_at: number }> {
    if (!this.jwt) throw new ApiError(401, { error: 'not authenticated' });
    const url = `${this.baseUrl.replace(/\/$/, '')}/functions/v1/tfa-verify`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${this.jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body);
    return body;
  }

  // Read the caller's storage usage (Agent 6). Returns the per-account totals
  // calculated server-side via meo.storage_usage(). RLS-safe.
  async getStorageUsage(): Promise<{
    attachment_bytes: number;
    note_bytes: number;
    total_bytes: number;
    cap_bytes: number;
    max_attachment_bytes: number;
  }> {
    const { data, error } = await this.sb.rpc('storage_usage');
    if (error) throw mapPgError(error as any);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return { attachment_bytes: 0, note_bytes: 0, total_bytes: 0, cap_bytes: 0, max_attachment_bytes: 0 };
    }
    return {
      attachment_bytes: Number(row.attachment_bytes ?? 0),
      note_bytes: Number(row.note_bytes ?? 0),
      total_bytes: Number(row.total_bytes ?? 0),
      cap_bytes: Number(row.cap_bytes ?? 0),
      max_attachment_bytes: Number(row.max_attachment_bytes ?? 0),
    };
  }

  // Read the caller's subscription row. Returns null if no row exists yet
  // (treat as `tier: 'free'`). RLS guarantees we only ever see auth.uid()'s
  // own row; a different user's row would simply not appear.
  async getSubscription(): Promise<SubscriptionRow | null> {
    const { data, error } = await this.sb
      .from('subscriptions')
      .select('user_id, tier, source, external_id, current_period_end, cancel_at_period_end, updated_at')
      .maybeSingle();
    if (error) {
      // PostgREST returns code PGRST116 when 0 rows match maybeSingle; that's
      // a not-found, not a fatal error.
      if ((error as any).code === 'PGRST116') return null;
      throw mapPgError(error as any);
    }
    if (!data) return null;
    return {
      user_id: data.user_id as string,
      tier: data.tier as Tier,
      source: (data.source ?? null) as SubscriptionRow['source'],
      external_id: (data.external_id ?? null) as string | null,
      current_period_end: (data.current_period_end ?? null) as string | null,
      cancel_at_period_end: Boolean(data.cancel_at_period_end),
      updated_at: data.updated_at as string,
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
  //   P0007 = attachment_too_large (Agent 6 - file > tier max)
  //   P0008 = storage_cap_exceeded (Agent 6 - workspace > tier total)
  //   P0009 = device_cap_exceeded (Agent 9 - too many devices)
  if (code === '40001' || msg.includes('stale write')) return new ApiError(409, { error: msg });
  if (code === 'P0007' || msg.includes('attachment_too_large')) {
    return new ApiError(413, { error: 'attachment_too_large', code: 'attachment_too_large' });
  }
  if (code === 'P0008' || msg.includes('storage_cap_exceeded') || msg.includes('quota exceeded')) {
    return new ApiError(413, { error: 'storage_cap_exceeded', code: 'storage_cap_exceeded' });
  }
  if (code === 'P0009' || msg.includes('device_cap_exceeded')) return new ApiError(429, { error: 'device_cap_exceeded', code: 'device_cap_exceeded' });
  if (code === '42501' || msg.includes('forbidden')) return new ApiError(403, { error: msg });
  if (code === '28000' || msg.includes('unauthorized')) return new ApiError(401, { error: msg });
  if (code === 'P0002' || msg.includes('not found')) return new ApiError(404, { error: msg });
  if (code === '23505') return new ApiError(409, { error: msg });
  return new ApiError(500, { error: msg });
}

/**
 * Parse a single note row out of an RPC response. PostgREST is happy
 * to return either a single object (for `returns meo.notes`) OR a
 * one-element array, depending on version and content negotiation -
 * supabase-js doesn't normalize this for us. So we accept both, plus
 * raise a clear error if the row is missing or doesn't carry an id
 * (which would otherwise crash IDB with a useless "not a valid key"
 * message). The fallback id keeps the on-disk cache consistent in
 * the rare case the server omits it.
 */
function parseNoteRow(raw: unknown, fallbackId: string): EncryptedNoteRow {
  let r: any = raw;
  if (Array.isArray(r)) r = r[0];
  if (!r || typeof r !== 'object') {
    throw new ApiError(500, { error: 'note RPC returned no row' });
  }
  const id: unknown = r.id ?? fallbackId;
  if (typeof id !== 'string' || id.length === 0) {
    throw new ApiError(500, { error: 'note RPC returned invalid id' });
  }
  return {
    id,
    encrypted_content: hexToBase64(r.encrypted_content),
    nonce: hexToBase64(r.nonce),
    version: Number(r.version),
    hlc_timestamp: r.hlc_timestamp,
    updated_at: typeof r.updated_at === 'string' ? Date.parse(r.updated_at) : Number(r.updated_at),
    deleted_at: r.deleted_at == null
      ? null
      : (typeof r.deleted_at === 'string' ? Date.parse(r.deleted_at) : Number(r.deleted_at)),
    size_bytes: Number(r.size_bytes ?? 0),
    is_vault: Boolean(r.is_vault ?? false),
  };
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

// Pairing/handovers RPCs prefer raw bytes; convert via the same hex
// representation PostgREST uses for bytea columns.
function bytesToHex(bytes: Uint8Array): string {
  let hex = '\\x';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}
function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith('\\x') ? hex.slice(2) : hex;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  return out;
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
