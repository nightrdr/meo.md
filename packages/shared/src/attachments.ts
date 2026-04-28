// End-to-end encrypted attachments — per spec §3.8.
//
// Architecture:
//   1. Client derives `attachment_key = HKDF-SHA256(master_key, "attachment:<id>")`.
//   2. Client encrypts the bytes in 1 MiB chunks with AES-256-GCM.
//      Each chunk's nonce is `nonce_base (8B) || chunk_index (4B, big-endian)`.
//      `nonce_base` is randomly generated per-attachment; the same base is
//      reused for every chunk because the chunk_index is unique within an
//      attachment. (The spec calls out 12-byte GCM IV with 8-byte base + 4-byte
//      index.)
//   3. Client encrypts the metadata blob ({filename, mime, …}) separately with
//      a fresh 12-byte GCM nonce, using the same `attachment_key`.
//   4. Client asks the `attachments-upload-url` Edge Function for a 15-minute
//      signed PUT URL.
//   5. Client PUTs the concatenated ciphertext (chunk_0 || chunk_1 || …) to
//      that URL.
//   6. Client INSERTs the metadata row via `meo.attachments_create` RPC.
//
// Server *never* sees plaintext bytes, the filename, the mime type, the
// dimensions, or the per-attachment AES key.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  bytesToBase64, base64ToBytes, utf8Encode, utf8Decode, concat, uuidv4,
} from './encoding.js';
import type {
  AttachmentMetadata, AttachmentRow, AttachmentSummary,
} from './types.js';

// ----------------------------------------------------------------------------
// Constants — keep in sync with the database migration & Edge Function.
// ----------------------------------------------------------------------------

export const CHUNK_SIZE = 1024 * 1024;     // 1 MiB plaintext per chunk
export const GCM_TAG_BYTES = 16;
export const NONCE_BASE_BYTES = 8;
export const CHUNK_INDEX_BYTES = 4;
export const GCM_NONCE_BYTES = NONCE_BASE_BYTES + CHUNK_INDEX_BYTES; // 12

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;       // 100 MiB plaintext
export const MAX_ENCRYPTED_BYTES  = 110 * 1024 * 1024;       // server-side cap
export const MAX_QUOTA_BYTES_PER_ACCOUNT = 10 * 1024 * 1024 * 1024; // 10 GiB

const UPLOAD_FN = 'attachments-upload-url';
const DOWNLOAD_FN = 'attachments-download-url';

// ----------------------------------------------------------------------------
// Per-attachment HKDF key derivation
// ----------------------------------------------------------------------------

export async function deriveAttachmentKey(
  masterRaw: Uint8Array,
  attachmentId: string,
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', masterRaw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8Encode(`attachment:${attachmentId}`),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ----------------------------------------------------------------------------
// Streaming AES-GCM in 1 MiB chunks
// ----------------------------------------------------------------------------

function makeChunkNonce(base: Uint8Array, index: number): Uint8Array {
  const nonce = new Uint8Array(GCM_NONCE_BYTES);
  nonce.set(base, 0);
  // big-endian 32-bit chunk index in the trailing 4 bytes
  nonce[NONCE_BASE_BYTES + 0] = (index >>> 24) & 0xff;
  nonce[NONCE_BASE_BYTES + 1] = (index >>> 16) & 0xff;
  nonce[NONCE_BASE_BYTES + 2] = (index >>> 8)  & 0xff;
  nonce[NONCE_BASE_BYTES + 3] =  index         & 0xff;
  return nonce;
}

export async function encryptStream(
  plaintext: Uint8Array,
  key: CryptoKey,
  nonceBase: Uint8Array,
): Promise<Uint8Array> {
  if (plaintext.length === 0) {
    // Single zero-byte chunk so we always produce at least one ciphertext chunk
    // (with auth tag) for empty attachments. Easier symmetry on decrypt.
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: makeChunkNonce(nonceBase, 0) },
      key, new Uint8Array(0),
    );
    return new Uint8Array(ct);
  }
  const out: Uint8Array[] = [];
  let chunkIndex = 0;
  for (let offset = 0; offset < plaintext.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, plaintext.length);
    const chunk = plaintext.subarray(offset, end);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: makeChunkNonce(nonceBase, chunkIndex) },
      key, chunk,
    );
    out.push(new Uint8Array(ct));
    chunkIndex++;
  }
  return concat(...out);
}

export async function decryptStream(
  ciphertext: Uint8Array,
  key: CryptoKey,
  nonceBase: Uint8Array,
): Promise<Uint8Array> {
  // The encrypted layout is chunk_0 || chunk_1 || …, where each chunk is
  // exactly CHUNK_SIZE + GCM_TAG_BYTES bytes (except possibly the last).
  const chunkOnWire = CHUNK_SIZE + GCM_TAG_BYTES;
  const out: Uint8Array[] = [];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < ciphertext.length) {
    const end = Math.min(offset + chunkOnWire, ciphertext.length);
    const chunk = ciphertext.subarray(offset, end);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: makeChunkNonce(nonceBase, chunkIndex) },
      key, chunk,
    );
    out.push(new Uint8Array(pt));
    offset = end;
    chunkIndex++;
  }
  return concat(...out);
}

// Decrypt only the first chunk (for image previews where the spec says
// first-chunk preview is acceptable). For files > 1 MiB this returns a
// truncated buffer; callers should only use it where partial-render is
// expected (e.g. progressive image decoding).
export async function decryptFirstChunk(
  ciphertext: Uint8Array,
  key: CryptoKey,
  nonceBase: Uint8Array,
): Promise<Uint8Array> {
  const chunkOnWire = CHUNK_SIZE + GCM_TAG_BYTES;
  const end = Math.min(chunkOnWire, ciphertext.length);
  const chunk = ciphertext.subarray(0, end);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: makeChunkNonce(nonceBase, 0) },
    key, chunk,
  );
  return new Uint8Array(pt);
}

// ----------------------------------------------------------------------------
// Metadata blob — separate single-shot AES-GCM with its own 12-byte nonce.
// ----------------------------------------------------------------------------

export async function encryptMetadata(
  metadata: AttachmentMetadata,
  key: CryptoKey,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const nonce = new Uint8Array(GCM_NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const plaintext = utf8Encode(JSON.stringify(metadata));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext);
  return { ciphertext: new Uint8Array(ct), nonce };
}

export async function decryptMetadata(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: CryptoKey,
): Promise<AttachmentMetadata> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
  return JSON.parse(utf8Decode(new Uint8Array(pt))) as AttachmentMetadata;
}

// ----------------------------------------------------------------------------
// SHA-256 helper
// ----------------------------------------------------------------------------

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// ----------------------------------------------------------------------------
// AttachmentsClient — high-level surface for the editor + renderer
// ----------------------------------------------------------------------------

export interface UploadResult {
  id: string;
  encrypted_size: number;
  storage_key: string;
}

export interface UploadInput {
  /** Original bytes — we don't trust ArrayBuffer.byteLength alone in the wire path. */
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  dimensions?: { width: number; height: number };
}

export interface AttachmentsClientConfig {
  supabase: SupabaseClient;
  /** Master key bytes; the client never persists them. */
  masterRaw: Uint8Array;
  /** Optional override for the supabase functions base URL (used by tests). */
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
    const key = await deriveAttachmentKey(this.masterRaw, id);

    // 1. Encrypt bytes (streaming) and metadata (single-shot)
    const nonceBase = new Uint8Array(NONCE_BASE_BYTES);
    crypto.getRandomValues(nonceBase);

    const checksum = await sha256Hex(input.bytes);
    const metadata: AttachmentMetadata = {
      filename: input.filename,
      mime_type: input.mimeType,
      original_size: input.bytes.length,
      sha256_checksum: checksum,
      ...(input.dimensions ? { dimensions: input.dimensions } : {}),
    };
    const ciphertext = await encryptStream(input.bytes, key, nonceBase);
    const meta = await encryptMetadata(metadata, key);

    // 2. Ask the edge function for a signed PUT URL.
    const upload = await this.invokeFunction(UPLOAD_FN, {
      note_id: noteId,
      storage_key: storageKey,
      content_type: 'application/octet-stream',
    });
    const url: string = upload.url;
    const backend: string = upload.backend ?? 'supabase';

    // 3. PUT the ciphertext.
    const putResp = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: ciphertext,
    });
    if (!putResp.ok) {
      throw new Error(`upload PUT failed: ${putResp.status} ${await safeText(putResp)}`);
    }

    // 4. Insert the database row via the SECURITY DEFINER RPC.
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

    const key = await deriveAttachmentKey(this.masterRaw, attachmentId);

    const getResp = await fetch(url);
    if (!getResp.ok) {
      throw new Error(`download GET failed: ${getResp.status} ${await safeText(getResp)}`);
    }
    const ciphertext = new Uint8Array(await getResp.arrayBuffer());

    const [bytes, metadata] = await Promise.all([
      decryptStream(ciphertext, key, nonceBase),
      decryptMetadata(encryptedMeta, metaNonce, key),
    ]);
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
      const key = await deriveAttachmentKey(this.masterRaw, row.id);
      try {
        const metadata = await decryptMetadata(
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
      } catch (e) {
        // skip rows we can't decrypt rather than blowing up the whole listing
        // eslint-disable-next-line no-console
        console.warn('decrypt metadata failed for attachment', row.id, e);
      }
    }
    return out;
  }

  async delete(attachmentId: string): Promise<void> {
    const { error } = await this.sb.from('attachments').delete().eq('id', attachmentId);
    if (error) throw new Error(`attachments delete failed: ${error.message}`);
    // Note: this leaves the orphaned ciphertext in the bucket. The full GC
    // story is in spec §3.8; for the v1 lifecycle a periodic Edge Function
    // can sweep storage_keys without a matching row.
  }

  // --- internals ----------------------------------------------------------

  private async invokeFunction(name: string, body: unknown): Promise<any> {
    // sb.functions.invoke handles auth headers automatically when the client
    // has a session installed. We also accept a raw URL override for tests.
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
      if (!resp.ok) {
        throw new Error(`fn ${name} failed: ${resp.status} ${await safeText(resp)}`);
      }
      return resp.json();
    }
    const { data, error } = await this.sb.functions.invoke(name, { body: body as any });
    if (error) throw error;
    return data;
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// Translate a Uint8Array into the `\x...` hex form Postgres expects for bytea
// when called via PostgREST RPC. Same convention as supabase-api.ts.
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

async function safeText(resp: Response): Promise<string> {
  try { return await resp.text(); } catch { return '<no body>'; }
}

// Convenience helpers for tests / callers.
export function createAttachmentsClient(
  url: string, anonKey: string, jwt: string, masterRaw: Uint8Array,
  functionsBaseUrl?: string,
): AttachmentsClient {
  const sb = createClient(url, anonKey, {
    global: { headers: { authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'meo' as any },
  });
  // Mirror the trick supabase-api.ts uses: stamp JWT into rest.headers so
  // PostgREST + RPC calls see it.
  (sb as any).rest.headers['authorization'] = `Bearer ${jwt}`;
  // Also set it on the underlying functions client so .functions.invoke works.
  (sb as any).functions.setAuth?.(jwt);
  return new AttachmentsClient({ supabase: sb, masterRaw, functionsBaseUrl });
}

// Guard: detect attachment URLs in markdown, e.g. `![alt](attachment:<id>)`.
export function parseAttachmentUrl(url: string): string | null {
  if (!url || !url.startsWith('attachment:')) return null;
  const id = url.slice('attachment:'.length).trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return id;
}

// Tiny re-export so consumers don't need a separate import.
export { bytesToBase64 };
