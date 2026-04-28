export interface KdfParams {
  algo: 'PBKDF2';
  iters: number;
  hash: 'SHA-256';
}

export interface AccountWrapper {
  salt: string;
  encrypted_master_key: string;
  master_key_nonce: string;
  kdf_params: KdfParams;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  folder: string[];
  tags: string[];
  links: string[];
  created_at: string;
  updated_at: string;
  hlc: string;
  version: number;
}

export interface EncryptedNoteRow {
  id: string;
  encrypted_content: string;
  nonce: string;
  hlc_timestamp: string;
  updated_at: number;
  deleted_at: number | null;
  version: number;
  size_bytes: number;
}

export interface AuthSignupResponse { user_id: string; }
export interface AuthLoginResponse { jwt: string; has_account: boolean; user_id: string; }
export interface SyncResponse { notes: EncryptedNoteRow[]; cursor: number; }
