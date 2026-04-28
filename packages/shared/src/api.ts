import type {
  AccountWrapper, EncryptedNoteRow, AuthSignupResponse, AuthLoginResponse, SyncResponse,
} from './types.js';

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API ${status}`);
  }
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
