import type {
  AccountWrapper, EncryptedNoteRow, AuthSignupResponse, AuthLoginResponse, SyncResponse,
} from './types.js';

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    // Prefer the server-supplied `error` text — falls back to `message`,
    // then to a generic "API <status>" string. Callers that previously
    // matched on `e.message === 'API 422'` should switch to `.status`.
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

  // GoTrue / Supabase Auth common cases
  if (code === 'over_email_send_rate_limit' || lower.includes('rate limit'))
    return 'Too many requests — wait a minute before trying again.';
  if (code === 'otp_expired' || lower.includes('expired'))
    return 'That code has expired. Request a new one.';
  if (code === 'invalid_otp' || lower.includes('invalid otp') || lower.includes('token has expired or is invalid'))
    return 'That code is incorrect. Double-check the digits and try again.';
  if (code === 'email_address_invalid' || lower.includes('invalid email') || lower.includes('email address') && lower.includes('invalid'))
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

  // Network / unreachable
  if (raw === 'Failed to fetch' || lower.includes('networkerror') || lower.includes('network request failed'))
    return 'Couldn\'t reach the server. Check your connection.';

  // Anything we didn't explicitly recognize gets a generic message —
  // the raw server text isn't useful to end users and often leaks
  // backend implementation detail. The original error is still
  // available on the thrown object's `body` / `status` for debugging.
  return 'An unexpected error was encountered!';
}

export class ApiClient {
  constructor(public baseUrl: string, public jwt?: string) {}

  setJwt(jwt: string | undefined) { this.jwt = jwt; }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as any) };
    if (this.jwt) headers['authorization'] = `Bearer ${this.jwt}`;
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }

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

  getAccount() {
    return this.req<AccountWrapper>('/account');
  }

  putAccount(wrapper: AccountWrapper) {
    return this.req<{ ok: true }>('/account', {
      method: 'PUT', body: JSON.stringify(wrapper),
    });
  }

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
}
