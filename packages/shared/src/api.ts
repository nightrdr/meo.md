import type {
  AccountWrapper, EncryptedNoteRow, AuthSignupResponse, AuthLoginResponse, SyncResponse,
  SubscriptionRow, Tier,
} from './types.js';
import type { DeviceRow, HandoverRow, TokenRefresher } from './supabase-api.js';

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    const text =
      (typeof body === 'object' && body !== null && 'error' in body)
        ? String((body as any).error)
        : (typeof body === 'object' && body !== null && 'message' in body)
          ? String((body as any).message)
          : `API ${status}`;
    super(text);
  }
}

/**
 * Map a Supabase / GoTrue / generic auth error into a user-readable
 * sentence. Returns the original message when no friendly mapping is
 * known so we don't paper over genuinely useful detail.
 */
export function humanizeAuthError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const code = (e as any)?.body?.code ?? (e as any)?.code ?? '';
  const status = (e as any)?.status ?? 0;
  const lower = raw.toLowerCase();

  if (code === 'over_email_send_rate_limit' || lower.includes('rate limit'))
    return 'Too many requests - wait a minute before trying again.';
  if (code === 'otp_expired' || lower.includes('expired'))
    return 'That code has expired. Request a new one.';
  if (code === 'invalid_otp' || lower.includes('invalid otp') || lower.includes('token has expired or is invalid'))
    return 'That code is incorrect. Double-check the digits and try again.';
  if (code === 'email_address_invalid' || lower.includes('invalid email') || (lower.includes('email address') && lower.includes('invalid')))
    return 'That email address looks invalid.';
  if (code === 'otp_disabled' || lower.includes('signups not allowed') || lower.includes('email logins are disabled'))
    return 'Email sign-in is disabled on this server. Contact the administrator.';
  if (code === 'email_provider_disabled')
    return 'Email sign-in is disabled on this server.';
  if (code === 'user_already_exists')
    return 'An account with that email already exists. Just sign in.';
  if (code === 'invalid_credentials' || lower.includes('invalid login credentials'))
    return 'Wrong email or password.';
  if (status === 422 && lower.includes('already registered'))
    return 'That email is already registered.';
  if (raw === 'Failed to fetch' || lower.includes('networkerror') || lower.includes('network request failed'))
    return 'Couldn\'t reach the server. Check your connection.';

  return 'An unexpected error was encountered!';
}

/**
 * ApiClient is the desktop's gateway to the Go backend. It carries
 * the same surface as SupabaseApiClient so session.ts's makeApiClient
 * can swap between the two without the rest of the app caring.
 *
 * Auth model: every protected call sends `Authorization: Bearer <jwt>`.
 * On 401/403, withAuthRetry invokes the registered TokenRefresher (set
 * by App.tsx after each successful auth event), installs the new JWT,
 * and retries exactly once. Mid-session expiry stays invisible.
 */
export class ApiClient {
  private tokenRefresher?: TokenRefresher;

  constructor(public baseUrl: string, public jwt?: string) {}

  setJwt(jwt: string | undefined) { this.jwt = jwt; }

  setTokenRefresher(refresher: TokenRefresher | undefined) {
    this.tokenRefresher = refresher;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.withAuthRetry(() => this.rawReq<T>(path, init));
  }

  private async rawReq<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as any) };
    if (this.jwt) headers['authorization'] = `Bearer ${this.jwt}`;
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }

  /**
   * Run `call`. If it throws an ApiError that looks like a stale-JWT
   * problem AND we have a tokenRefresher registered, refresh once and
   * retry. Anything else propagates unchanged.
   */
  private async withAuthRetry<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof ApiError) || !this.tokenRefresher) throw e;
      if (!this.shouldRetry(e)) throw e;
      const fresh = await this.tryRefresh();
      if (!fresh) throw e;
      return await call();
    }
  }

  private shouldRetry(e: ApiError): boolean {
    if (e.status === 401) return true;
    // Postgres 42501 / "permission denied for …" surfaces as 403 when
    // the request reaches the server with a missing or stale JWT —
    // RLS/role mismatch, not a real authorization failure for an
    // authenticated user. Treat the same as 401 so refresh-and-retry
    // recovers transparently.
    if (e.status === 403 && /permission denied for/i.test(e.message)) return true;
    if ((e.body as any)?.code === '42501') return true;
    if (/jwt expired|invalid jwt|jwt verification/i.test(e.message)) return true;
    return false;
  }

  private async tryRefresh(): Promise<string | null | undefined> {
    if (!this.tokenRefresher) return null;
    try { return await this.tokenRefresher(); } catch { return null; }
  }

  // ─── Auth (legacy password) ───────────────────────────────────────

  signup(email: string, password: string) {
    return this.req<AuthSignupResponse>('/auth/signup', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
  }

  async login(email: string, password: string) {
    const r = await this.req<AuthLoginResponse>('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    this.jwt = r.jwt;
    return r;
  }

  // ─── Auth (OTP) ───────────────────────────────────────────────────

  async requestEmailOtp(email: string): Promise<{ sent: true }> {
    await this.req<{ sent: boolean }>('/auth/otp/request', {
      method: 'POST', body: JSON.stringify({ email }),
    });
    return { sent: true };
  }

  async verifyEmailOtp(email: string, token: string): Promise<AuthLoginResponse> {
    const r = await this.req<AuthLoginResponse>('/auth/otp/verify', {
      method: 'POST', body: JSON.stringify({ email, token }),
    });
    this.jwt = r.jwt;
    return r;
  }

  async refreshAccessToken(refreshToken: string): Promise<AuthLoginResponse> {
    const r = await this.req<AuthLoginResponse>('/auth/refresh', {
      method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }),
    });
    this.jwt = r.jwt;
    return r;
  }

  async logout(): Promise<void> {
    try {
      await this.req<{ ok: true }>('/auth/logout', { method: 'POST' });
    } catch {
      // Best-effort. The client clears local state regardless.
    }
  }

  // ─── Account ──────────────────────────────────────────────────────

  getAccount() { return this.req<AccountWrapper>('/account'); }

  putAccount(wrapper: AccountWrapper) {
    return this.req<{ ok: true }>('/account', {
      method: 'PUT', body: JSON.stringify(wrapper),
    });
  }

  // ─── Notes ────────────────────────────────────────────────────────

  syncNotes(since: number) {
    return this.req<SyncResponse>(`/sync/notes?since=${since}`);
  }

  upsertNote(row: EncryptedNoteRow) {
    return this.req<EncryptedNoteRow>('/notes', {
      method: 'POST', body: JSON.stringify(row),
    });
  }

  deleteNote(id: string) {
    return this.req<EncryptedNoteRow>(`/notes/${id}`, { method: 'DELETE' });
  }

  // ─── Devices ──────────────────────────────────────────────────────

  async listDevices(): Promise<DeviceRow[]> {
    const r = await this.req<{ devices: DeviceRow[] }>('/devices');
    return r.devices ?? [];
  }

  async registerDevice(deviceId: string, platform: string, name: string, ua: string | null = null): Promise<void> {
    await this.req<{ ok: true }>('/devices', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceId, platform, name, ua }),
    });
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.req<{ ok: true }>(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
  }

  // ─── Subscription / storage usage ─────────────────────────────────

  async getSubscription(): Promise<SubscriptionRow | null> {
    try {
      const r = await this.req<SubscriptionRow>('/subscription');
      return r ?? null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async getStorageUsage(): Promise<{
    attachment_bytes: number;
    note_bytes: number;
    total_bytes: number;
    cap_bytes: number;
    max_attachment_bytes: number;
  }> {
    return this.req('/storage/usage');
  }

  // ─── Handovers ────────────────────────────────────────────────────

  async handoverCreate(id: string, ekAPub: Uint8Array): Promise<void> {
    await this.req<{ ok: true }>('/handovers', {
      method: 'POST',
      body: JSON.stringify({ id, ek_a_pub: bytesToHex(ekAPub) }),
    });
  }

  async handoverPutB(id: string, ekBPub: Uint8Array): Promise<void> {
    await this.req<{ ok: true }>(`/handovers/${encodeURIComponent(id)}/b`, {
      method: 'PUT',
      body: JSON.stringify({ ek_b_pub: bytesToHex(ekBPub) }),
    });
  }

  async handoverPutPayload(id: string, payload: Uint8Array, nonce: Uint8Array): Promise<void> {
    await this.req<{ ok: true }>(`/handovers/${encodeURIComponent(id)}/payload`, {
      method: 'PUT',
      body: JSON.stringify({ payload: bytesToHex(payload), payload_nonce: bytesToHex(nonce) }),
    });
  }

  async handoverGet(id: string): Promise<HandoverRow | null> {
    try {
      const r = await this.req<{
        ek_a_pub: string | null;
        ek_b_pub: string | null;
        payload_for_b: string | null;
        payload_nonce: string | null;
        expires_at: string;
      }>(`/handovers/${encodeURIComponent(id)}`);
      return {
        ek_a_pub: r.ek_a_pub ? hexToBytes(r.ek_a_pub) : null,
        ek_b_pub: r.ek_b_pub ? hexToBytes(r.ek_b_pub) : null,
        payload_for_b: r.payload_for_b ? hexToBytes(r.payload_for_b) : null,
        payload_nonce: r.payload_nonce ? hexToBytes(r.payload_nonce) : null,
        expires_at: r.expires_at,
      };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async handoverClear(id: string): Promise<void> {
    await this.req<{ ok: true }>(`/handovers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // ─── 2FA ──────────────────────────────────────────────────────────

  async tfaStatus(): Promise<boolean> {
    try {
      const r = await this.req<{ enabled: boolean }>('/tfa/status');
      return Boolean(r.enabled);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return false;
      throw e;
    }
  }

  async tfaEnroll(secretEncB64: string, secretNonceB64: string): Promise<{ ok: true }> {
    return this.req<{ ok: true }>('/tfa/enroll', {
      method: 'POST',
      body: JSON.stringify({ secret_enc: secretEncB64, secret_nonce: secretNonceB64 }),
    });
  }

  async tfaGetSecret(): Promise<{ secret_enc: string; secret_nonce: string; enabled: boolean } | null> {
    try {
      return await this.req('/tfa/secret');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async tfaDisable(): Promise<void> {
    await this.req<{ ok: true }>('/tfa/disable', { method: 'POST' });
  }

  async tfaDelete(): Promise<void> {
    await this.req<{ ok: true }>('/tfa', { method: 'DELETE' });
  }

  // tfaVerify is a legacy two-step Edge Function flow on Supabase; the
  // Go backend doesn't need it (the desktop validates TOTP locally and
  // gates the unlock UI). Surface a helpful error if a caller still
  // hits this path.
  async tfaVerify(_code: string): Promise<{ token: string; expires_at: number }> {
    throw new ApiError(501, { error: 'tfaVerify not used on Go backend - validate locally' });
  }
}

// ─── tiny hex helpers ───────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
function hexToBytes(h: string): Uint8Array {
  if (h.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
