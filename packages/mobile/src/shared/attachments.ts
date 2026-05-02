// Mobile variant of attachments.ts. Uses @noble/ciphers + @noble/hashes
// because RN's Hermes doesn't ship crypto.subtle. Wire format and Edge
// Function contract are identical to packages/shared/src/attachments.ts —
// a file uploaded from desktop downloads cleanly on mobile and vice versa.

import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  bytesToBase64, base64ToBytes, utf8Encode, utf8Decode, uuidv4,
} from './encoding';
import type {
  AttachmentMetadata, AttachmentSummary,
} from './types';

// Constants — keep in sync with packages/shared/src/attachments.ts and the migration.
export const CHUNK_SIZE = 1024 * 1024;
export const GCM_TAG_BYTES = 16;
export const NONCE_BASE_BYTES = 8;
export const CHUNK_INDEX_BYTES = 4;
export const GCM_NONCE_BYTES = NONCE_BASE_BYTES + CHUNK_INDEX_BYTES;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const ATTACHMENT_URL_PREFIX = 'attachment:';

const UPLOAD_FN = 'attachments-upload-url';
const DOWNLOAD_FN = 'attachments-download-url';

// ----------------------------------------------------------------------------
// Per-attachment HKDF key derivation
// ----------------------------------------------------------------------------

function deriveAttachmentKey(masterRaw: Uint8Array, attachmentId: string): Uint8Array {
  return hkdf(sha256, masterRaw, new Uint8Array(0), utf8Encode(`attachment:${attachmentId}`), 32);
}

// ----------------------------------------------------------------------------
// Streaming AES-GCM encrypt / decrypt — chunked
// ----------------------------------------------------------------------------

function chunkNonce(nonceBase: Uint8Array, chunkIndex: number): Uint8Array {
  const nonce = new Uint8Array(GCM_NONCE_BYTES);
  nonce.set(nonceBase, 0);
  // big-endian 32-bit chunk index, last 4 bytes
  nonce[NONCE_BASE_BYTES + 0] = (chunkIndex >>> 24) & 0xff;
  nonce[NONCE_BASE_BYTES + 1] = (chunkIndex >>> 16) & 0xff;
  nonce[NONCE_BASE_BYTES + 2] = (chunkIndex >>> 8) & 0xff;
  nonce[NONCE_BASE_BYTES + 3] = chunkIndex & 0xff;
  return nonce;
}

function encryptStream(plaintext: Uint8Array, key: Uint8Array, nonceBase: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let i = 0;
  for (let off = 0; off < plaintext.length; off += CHUNK_SIZE) {
    const chunk = plaintext.subarray(off, Math.min(off + CHUNK_SIZE, plaintext.length));
    const ct = gcm(key, chunkNonce(nonceBase, i)).encrypt(chunk);
    chunks.push(ct);
    total += ct.length;
    i++;
  }
  // Concatenate
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function decryptStream(ciphertext: Uint8Array, key: Uint8Array, nonceBase: Uint8Array): Uint8Array {
  // Each plaintext chunk is CHUNK_SIZE bytes; ciphertext chunk is plaintext + 16-byte tag.
  const chunkCt = CHUNK_SIZE + GCM_TAG_BYTES;
  const out: Uint8Array[] = [];
  let total = 0;
  let i = 0;
  for (let off = 0; off < ciphertext.length; off += chunkCt) {
    const c = ciphertext.subarray(off, Math.min(off + chunkCt, ciphertext.length));
    const pt = gcm(key, chunkNonce(nonceBase, i)).decrypt(c);
    out.push(pt);
    total += pt.length;
    i++;
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const p of out) { buf.set(p, offset); offset += p.length; }
  return buf;
}

// ----------------------------------------------------------------------------
// Metadata blob
// ----------------------------------------------------------------------------

function encryptMetadata(meta: AttachmentMetadata, key: Uint8Array): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = new Uint8Array(GCM_NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const plaintext = utf8Encode(JSON.stringify(meta));
  const ciphertext = gcm(key, nonce).encrypt(plaintext);
  return { ciphertext, nonce };
}

function decryptMetadata(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): AttachmentMetadata {
  const pt = gcm(key, nonce).decrypt(ciphertext);
  return JSON.parse(utf8Decode(pt)) as AttachmentMetadata;
}

function sha256Hex(bytes: Uint8Array): string {
  const h = sha256(bytes);
  let hex = '';
  for (let i = 0; i < h.length; i++) hex += h[i].toString(16).padStart(2, '0');
  return hex;
}

// ----------------------------------------------------------------------------
// Public API — mirrors packages/shared/src/attachments.ts
// ----------------------------------------------------------------------------

export interface UploadInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  dimensions?: { width: number; height: number };
}

export interface UploadResult {
  id: string;
  encrypted_size: number;
  storage_key: string;
}

export interface AttachmentsClientConfig {
  supabase: SupabaseClient;
  masterRaw: Uint8Array;
  functionsBaseUrl?: string;
}

export class AttachmentsClient {
  private sb: SupabaseClient;
  private masterRaw: Uint8Array;
  private functionsBaseUrl?: string;

  constructor(cfg: AttachmentsClientConfig) {
    this.sb = cfg.supabase;
    this.masterRaw = cfg.masterRaw;
    this.functionsBaseUrl = cfg.functionsBaseUrl;
  }

  async upload(noteId: string, input: UploadInput): Promise<UploadResult> {
    if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${input.bytes.length} > ${MAX_ATTACHMENT_BYTES}`);
    }
    const id = uuidv4();
    const storageKey = uuidv4();
    const key = deriveAttachmentKey(this.masterRaw, id);

    const nonceBase = new Uint8Array(NONCE_BASE_BYTES);
    crypto.getRandomValues(nonceBase);

    const checksum = sha256Hex(input.bytes);
    const metadata: AttachmentMetadata = {
      filename: input.filename,
      mime_type: input.mimeType,
      original_size: input.bytes.length,
      sha256_checksum: checksum,
      ...(input.dimensions ? { dimensions: input.dimensions } : {}),
    };
    const ciphertext = encryptStream(input.bytes, key, nonceBase);
    const meta = encryptMetadata(metadata, key);

    const upload = await this.invokeFunction(UPLOAD_FN, {
      note_id: noteId,
      storage_key: storageKey,
      content_type: 'application/octet-stream',
    });
    const url: string = upload.url;
    const backend: string = upload.backend ?? 'supabase';

    const putResp = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: ciphertext,
    });
    if (!putResp.ok) {
      throw new Error(`upload PUT failed: ${putResp.status}`);
    }

    const { error } = await this.sb.rpc('attachments_create', {
      p_id: id,
      p_note_id: noteId,
      p_storage_key: storageKey,
      p_storage_backend: backend,
      p_encrypted_size: ciphertext.length,
      p_nonce: byteaArg(nonceBase),
      p_encrypted_metadata: byteaArg(meta.ciphertext),
      p_metadata_nonce: byteaArg(meta.nonce),
    });
    if (error) {
      throw new Error(`attachments_create failed: ${error.message}`);
    }
    return { id, encrypted_size: ciphertext.length, storage_key: storageKey };
  }

  async download(attachmentId: string): Promise<{ bytes: Uint8Array; metadata: AttachmentMetadata }> {
    const resp = await this.invokeFunction(DOWNLOAD_FN, { attachment_id: attachmentId });
    const url: string = resp.url;
    const nonceBase = base64ToBytes(resp.nonce);
    const encryptedMeta = base64ToBytes(resp.encrypted_metadata);
    const metaNonce = base64ToBytes(resp.metadata_nonce);

    const key = deriveAttachmentKey(this.masterRaw, attachmentId);

    const getResp = await fetch(url);
    if (!getResp.ok) throw new Error(`download GET failed: ${getResp.status}`);
    const ciphertext = new Uint8Array(await getResp.arrayBuffer());

    const bytes = decryptStream(ciphertext, key, nonceBase);
    const metadata = decryptMetadata(encryptedMeta, metaNonce, key);
    return { bytes, metadata };
  }

  async listForNote(noteId: string): Promise<AttachmentSummary[]> {
    const { data, error } = await this.sb.rpc('attachments_for_note', { p_note_id: noteId });
    if (error) throw new Error(`attachments_for_note failed: ${error.message}`);
    const rows = (data ?? []) as Array<{
      id: string; note_id: string; encrypted_size: number;
      encrypted_metadata: string; metadata_nonce: string; created_at: string;
    }>;
    const out: AttachmentSummary[] = [];
    for (const row of rows) {
      const key = deriveAttachmentKey(this.masterRaw, row.id);
      try {
        const metadata = decryptMetadata(
          hexOrBase64ToBytes(row.encrypted_metadata as unknown as string),
          hexOrBase64ToBytes(row.metadata_nonce as unknown as string),
          key,
        );
        out.push({
          id: row.id,
          note_id: row.note_id,
          encrypted_size: Number(row.encrypted_size),
          metadata,
          created_at: row.created_at,
        });
      } catch {
        // ignore undecryptable rows
      }
    }
    return out;
  }

  async delete(attachmentId: string): Promise<void> {
    const { error } = await this.sb.from('attachments').delete().eq('id', attachmentId);
    if (error) throw new Error(`attachments delete failed: ${error.message}`);
  }

  /** Returns { used, quota } in bytes. */
  async quota(): Promise<{ usedBytes: number; quotaBytes: number }> {
    const { data, error } = await this.sb.rpc('attachments_quota_used');
    if (error) throw new Error(`attachments_quota_used failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    return {
      usedBytes: Number(row?.used_bytes ?? 0),
      quotaBytes: Number(row?.quota_bytes ?? 10 * 1024 * 1024 * 1024),
    };
  }

  private async invokeFunction(name: string, body: unknown): Promise<any> {
    if (this.functionsBaseUrl) {
      const auth = (this.sb as any).rest?.headers?.authorization
        ?? (this.sb as any).rest?.headers?.Authorization;
      const resp = await fetch(`${this.functionsBaseUrl.replace(/\/$/, '')}/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(auth ? { authorization: auth } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`fn ${name} failed: ${resp.status}`);
      return resp.json();
    }
    const { data, error } = await this.sb.functions.invoke(name, { body: body as any });
    if (error) throw error;
    return data;
  }
}

// ----------------------------------------------------------------------------
// Factory: build an AttachmentsClient from a session.
// ----------------------------------------------------------------------------

export function createAttachmentsClient(
  url: string, anonKey: string, jwt: string, masterRaw: Uint8Array,
): AttachmentsClient {
  const sb = createClient(url, anonKey, {
    global: { headers: { authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'meo' as any },
  });
  (sb as any).rest.headers['authorization'] = `Bearer ${jwt}`;
  (sb as any).functions.setAuth?.(jwt);
  return new AttachmentsClient({ supabase: sb, masterRaw });
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function byteaArg(bytes: Uint8Array): string {
  let hex = '\\x';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function hexOrBase64ToBytes(value: string): Uint8Array {
  if (!value) return new Uint8Array(0);
  if (value.startsWith('\\x')) {
    const hex = value.slice(2);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return base64ToBytes(value);
}
