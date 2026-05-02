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
  // Agent 8 - Vault feature.
  // When `isVault === true`, the note's body is wrapped with a second
  // AES-GCM layer keyed by `vault_key = HKDF(masterRaw, salt=user_id, info='vault:v1')`
  // before the existing per-note encryption runs. The inner ciphertext
  // is stored as the body string with a `vault:<base64-nonce>:<base64-ct>`
  // marker so the outer crypto pipeline doesn't have to know about it.
  // The flag itself is *plaintext* (it lives inside the outer-encrypted
  // JSON, but it's not redacted) so the UI can decide whether to render
  // a 🔒 placeholder before any unlock prompt fires.
  isVault?: boolean;
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
  // Agent 8 - surfaced from meo.notes.is_vault. Lets the server-side
  // sync path tag rows so the client's redacted-preview rendering
  // doesn't have to peek inside ciphertext to decide.
  is_vault?: boolean;
}

export interface AuthSignupResponse { user_id: string; }
export interface AuthLoginResponse {
  jwt: string;
  has_account: boolean;
  user_id: string;
  /**
   * Long-lived refresh token (Supabase). Persisted alongside the access
   * JWT so cold starts can mint a fresh access token without forcing
   * the user back through OTP. Optional because legacy backends may
   * not surface it.
   */
  refresh_token?: string;
}
export interface SyncResponse { notes: EncryptedNoteRow[]; cursor: number; }

// ----------------------------------------------------------------------------
// Attachments - per spec §3.8.
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

// ----------------------------------------------------------------------------
// Subscriptions (Agent 10).
//
// `Tier` is the canonical name of a billing tier. The full feature matrix
// lives in `mvp-development.md`; the desktop app reads it via getCurrentTier()
// (in session.ts) which queries the meo.subscriptions table.
// ----------------------------------------------------------------------------
export type Tier = 'free' | 'hobbyist' | 'business' | 'enterprise';
export type BillingSource = 'paddle' | 'revenuecat' | 'manual';

export interface SubscriptionRow {
  user_id: string;
  tier: Tier;
  source: BillingSource | null;
  external_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
}
