// attachments-download-url
// ----------------------------------------------------------------------------
// Mirror of attachments-upload-url for the GET path.
//
// Request body: { attachment_id: string }
// Response:     { url, expires_at, backend, bucket, encrypted_size, nonce, encrypted_metadata, metadata_nonce, storage_key }
//
// Returns the row alongside the URL so the client can decrypt without a
// separate round trip. RLS on meo.attachments ensures the caller can only
// fetch their own rows.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders, handleOptions } from '../_shared/cors.ts';
import { presignS3Url } from '../_shared/sigv4.ts';

const ATTACHMENTS_BUCKET = 'meo-attachments';

interface ReqBody {
  attachment_id: string;
}

Deno.serve(async (req: Request) => {
  const cors = handleOptions(req);
  if (cors) return cors;

  if (req.method !== 'POST') return jsonError(405, 'method_not_allowed');

  const auth = req.headers.get('authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    return jsonError(401, 'missing_bearer_token');
  }
  const jwt = auth.slice(7);

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json');
  }
  if (!body.attachment_id) return jsonError(400, 'attachment_id_required');

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const sb = createClient(supabaseUrl, anonKey, {
    global: { headers: { authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'meo' as any },
  });

  const { data: row, error } = await sb
    .from('attachments')
    .select('id, storage_key, storage_backend, encrypted_size, nonce, encrypted_metadata, metadata_nonce')
    .eq('id', body.attachment_id)
    .maybeSingle();
  if (error) return jsonError(500, `db_error: ${error.message}`);
  if (!row) return jsonError(404, 'attachment_not_found_or_forbidden');

  const backend = (row.storage_backend ?? Deno.env.get('STORAGE_BACKEND') ?? 'supabase').toLowerCase();
  let signed: { url: string; expiresAt: number };
  let bucket: string;

  if (backend === 'idrive') {
    const endpoint = mustEnv('IDRIVE_ENDPOINT');
    const region = mustEnv('IDRIVE_REGION');
    bucket = mustEnv('IDRIVE_BUCKET');
    const accessKey = mustEnv('IDRIVE_ACCESS_KEY');
    const secretKey = mustEnv('IDRIVE_SECRET_KEY');
    signed = await presignS3Url({
      endpoint, region, bucket, accessKey, secretKey,
      key: row.storage_key,
      method: 'GET',
      expiresIn: 900,
    });
  } else {
    const publicUrl = Deno.env.get('SUPABASE_PUBLIC_URL')
      ?? Deno.env.get('SUPABASE_EXTERNAL_URL')
      ?? 'http://127.0.0.1:54321';
    const endpoint = Deno.env.get('SUPABASE_S3_ENDPOINT')
      ?? `${publicUrl.replace(/\/$/, '')}/storage/v1/s3`;
    const region = Deno.env.get('SUPABASE_S3_REGION') ?? 'local';
    const accessKey = Deno.env.get('SUPABASE_S3_ACCESS_KEY')
      ?? Deno.env.get('S3_ACCESS_KEY')
      ?? '625729a08b95bf1b7ff351a663f3a23c';
    const secretKey = Deno.env.get('SUPABASE_S3_SECRET_KEY')
      ?? Deno.env.get('S3_SECRET_KEY')
      ?? '850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907';
    bucket = ATTACHMENTS_BUCKET;

    signed = await presignS3Url({
      endpoint, region, bucket, accessKey, secretKey,
      key: row.storage_key,
      method: 'GET',
      expiresIn: 900,
    });
  }

  return jsonOk({
    url: signed.url,
    expires_at: signed.expiresAt,
    backend,
    bucket,
    storage_key: row.storage_key,
    encrypted_size: Number(row.encrypted_size),
    nonce: byteaToBase64(row.nonce),
    encrypted_metadata: byteaToBase64(row.encrypted_metadata),
    metadata_nonce: byteaToBase64(row.metadata_nonce),
  });
});

function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

// PostgREST returns bytea as `\x...` hex by default. Translate to base64.
function byteaToBase64(value: unknown): string {
  if (!value) return '';
  if (typeof value !== 'string') return String(value);
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}
function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}
