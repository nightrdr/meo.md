// Mobile variant of SupabaseApiClient. Mirrors packages/shared/src/supabase-api.ts
// but imports from the mobile noble-based shared modules so it works in
// React Native without WASM/native deps.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AccountWrapper, EncryptedNoteRow, AuthSignupResponse, AuthLoginResponse, SyncResponse,
} from './types';
import { ApiError } from './api';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
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
      (this.sb as any).rest.headers['authorization'] = `Bearer ${jwt}`;
    }
  }

  setJwt(jwt: string | undefined) {
    this.jwt = jwt;
    if (jwt) (this.sb as any).rest.headers['authorization'] = `Bearer ${jwt}`;
    else delete (this.sb as any).rest.headers['authorization'];
  }

  async signup(email: string, password: string): Promise<AuthSignupResponse> {
    const { data, error } = await this.sb.auth.signUp({ email, password });
    if (error) throw new ApiError(error.status ?? 400, { error: error.message });
    if (!data.user) throw new ApiError(500, { error: 'signup returned no user' });
    return { user_id: data.user.id };
  }

  async login(email: string, password: string): Promise<AuthLoginResponse> {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw new ApiError(error.status ?? 401, { error: error.message });
    if (!data.session || !data.user) throw new ApiError(500, { error: 'login returned no session' });
    this.jwt = data.session.access_token;
    this.userId = data.user.id;
    (this.sb as any).rest.headers['authorization'] = `Bearer ${this.jwt}`;
    const { count } = await this.sb.from('accounts').select('user_id', { count: 'exact', head: true }).eq('user_id', data.user.id);
    return { jwt: this.jwt, has_account: (count ?? 0) > 0, user_id: data.user.id };
  }

  async getAccount(): Promise<AccountWrapper> {
    if (!this.userId) {
      const { data, error } = await this.sb.auth.getUser(this.jwt);
      if (error || !data.user) throw new ApiError(401, { error: 'not authenticated' });
      this.userId = data.user.id;
    }
    const { data, error } = await this.sb
      .from('accounts')
      .select('salt, encrypted_master_key, master_key_nonce, kdf_params')
      .eq('user_id', this.userId).single();
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
    return { notes: rows, cursor: rows.length ? rows[rows.length - 1].version : since };
  }

  async upsertNote(row: EncryptedNoteRow): Promise<EncryptedNoteRow> {
    const { data, error } = await this.sb.rpc('upsert_note', {
      p_id: row.id,
      p_encrypted_content: base64ToHex(row.encrypted_content),
      p_nonce: base64ToHex(row.nonce),
      p_hlc_timestamp: row.hlc_timestamp,
      p_size_bytes: row.size_bytes,
    });
    if (error) throw mapPgError(error);
    const r = data as any;
    return rowToWire(r);
  }

  async deleteNote(id: string): Promise<EncryptedNoteRow> {
    const { data, error } = await this.sb.rpc('delete_note', { p_id: id });
    if (error) throw mapPgError(error);
    return rowToWire(data as any);
  }
}

function rowToWire(r: any): EncryptedNoteRow {
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

function mapPgError(error: { code?: string; message?: string }): ApiError {
  const code = error.code ?? '';
  const msg = error.message ?? '';
  if (code === '40001' || msg.includes('stale write')) return new ApiError(409, { error: msg });
  if (code === '42501' || msg.includes('forbidden')) return new ApiError(403, { error: msg });
  if (code === '28000' || msg.includes('unauthorized')) return new ApiError(401, { error: msg });
  if (code === 'P0002' || msg.includes('not found')) return new ApiError(404, { error: msg });
  if (code === '23505') return new ApiError(409, { error: msg });
  return new ApiError(500, { error: msg });
}

function hexToBase64(hex: string): string {
  if (!hex) return '';
  const s = hex.startsWith('\\x') ? hex.slice(2) : hex;
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}
function base64ToHex(b64: string): string {
  const bin = atob(b64);
  let hex = '\\x';
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return hex;
}
