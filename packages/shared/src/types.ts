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

// ----------------------------------------------------------------------------
// Attachments — per spec §3.8.
//
// AttachmentMetadata is the *plaintext* form, never sent to the server. Its
// AES-GCM ciphertext lives in `meo.attachments.encrypted_metadata`.
// ----------------------------------------------------------------------------
export interface AttachmentMetadata {
  filename: string;
  mime_type: string;
  original_size: number;
  sha256_checksum: string;       // hex
  dimensions?: { width: number; height: number };
}

export interface AttachmentRow {
  id: string;
  note_id: string;
  user_id: string;
  storage_key: string;
  storage_backend: string;       // 'supabase' | 'idrive'
  encrypted_size: number;
  nonce: string;                 // base64; 8-byte nonce_base
  encrypted_metadata: string;    // base64
  metadata_nonce: string;        // base64; 12-byte GCM nonce
  created_at: string;
}

export interface AttachmentSummary {
  id: string;
  note_id: string;
  encrypted_size: number;
  metadata: AttachmentMetadata;
  created_at: string;
}

// Marker URL pattern that the editor inserts and the renderer recognizes.
// Stored in markdown as `![alt](attachment:<uuid>)`.
export const ATTACHMENT_URL_PREFIX = 'attachment:';
