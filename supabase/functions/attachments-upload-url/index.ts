// attachments-upload-url
// ----------------------------------------------------------------------------
// Validates the caller's JWT, confirms they own the note that the upload is
// claimed against, and returns a 15-minute signed PUT URL for the chosen
// S3-compatible storage backend.
//
// Request body: { note_id: string, storage_key: string, content_type?: string }
// Response:     { url: string, expires_at: number, backend: 'supabase' | 'idrive', bucket: string }
//
// Storage backend resolution order:
//   1. STORAGE_BACKEND env var ('supabase' | 'idrive'); default 'supabase'.
//   2. iDrive needs IDRIVE_ENDPOINT, IDRIVE_REGION, IDRIVE_BUCKET,
//      IDRIVE_ACCESS_KEY, IDRIVE_SECRET_KEY.
//   3. supabase (dev fallback) uses Supabase Storage's S3 protocol endpoint
//      (http://kong:8000/storage/v1/s3 inside the network) with the local
//      keys auto-injected by the supabase CLI.
//
// The function never touches the actual bytes — only the metadata row, and
// only the URL.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders, handleOptions } from '../_shared/cors.ts';
import { presignS3Url } from '../_shared/sigv4.ts';

const ATTACHMENTS_BUCKET = 'meo-attachments';

interface ReqBody {
  note_id: string;
  storage_key: string;
  content_type?: string;
}

Deno.serve(async (req: Request) => {
  const cors = handleOptions(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return jsonError(405, 'method_not_allowed');
  }

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
  if (!body.note_id || !body.storage_key) {
    return jsonError(400, 'note_id_and_storage_key_required');
  }
  if (!/^[0-9a-f-]{36}$/i.test(body.storage_key) && !/^[A-Za-z0-9._-]{1,128}$/.test(body.storage_key)) {
    return jsonError(400, 'storage_key_must_be_uuid_or_safe_token');
  }

  // Validate JWT + note ownership using the user's own JWT (RLS enforced).
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const sb = createClient(supabaseUrl, anonKey, {
    global: { headers: { authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'meo' as any },
  });

  const { data: note, error: noteErr } = await sb
    .from('notes')
    .select('id')
    .eq('id', body.note_id)
    .maybeSingle();
  if (noteErr) return jsonError(500, `db_error: ${noteErr.message}`);
  if (!note) return jsonError(404, 'note_not_found_or_forbidden');

  // Choose backend.
  const backend = (Deno.env.get('STORAGE_BACKEND') ?? 'supabase').toLowerCase();
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
      key: body.storage_key,
      method: 'PUT',
      expiresIn: 900,
      contentType: body.content_type ?? 'application/octet-stream',
    });
  } else {
    // Supabase Storage S3 protocol (dev fallback).
    // The CLI injects access keys for service role into the function env.
    // Use the external/public URL for signing so the resulting presigned URL
    // is usable from outside the docker network (where the client runs).
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

    // Ensure bucket exists (idempotent). Uses service role via storage admin API.
    await ensureBucket(supabaseUrl, bucket);

    signed = await presignS3Url({
      endpoint, region, bucket, accessKey, secretKey,
      key: body.storage_key,
      method: 'PUT',
      expiresIn: 900,
      contentType: body.content_type ?? 'application/octet-stream',
    });
  }

  return jsonOk({
    url: signed.url,
    expires_at: signed.expiresAt,
    backend,
    bucket,
  });
});

async function ensureBucket(supabaseUrl: string, bucket: string): Promise<void> {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) return; // best-effort; the upload itself will fail loudly
  const adminUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/bucket`;
  const headers = {
    'apikey': serviceKey,
    'authorization': `Bearer ${serviceKey}`,
    'content-type': 'application/json',
  };
  const probe = await fetch(`${adminUrl}/${bucket}`, { headers });
  if (probe.ok) return;
  await fetch(adminUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
  });
}

function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
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
