// AWS SigV4 query-string presigner for S3-compatible storage (iDrive, MinIO, etc).
//
// Why hand-rolled? Edge functions run on Deno; pulling @aws-sdk/client-s3 adds
// ~3 MB of cold-start weight, and we only need *presign* (not the full client).
// This implementation does the canonical-request + string-to-sign + HMAC dance
// against Web Crypto's SubtleCrypto.HMAC, which is available in Deno.

const enc = new TextEncoder();

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return new Uint8Array(sig);
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === 'string' ? enc.encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function uriEscape(s: string, encodeSlash = true): string {
  // SigV4 uri encoding: same as RFC 3986 unreserved.
  let out = '';
  for (const ch of s) {
    if (
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '-' || ch === '_' || ch === '.' || ch === '~'
    ) {
      out += ch;
    } else if (ch === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      const bytes = enc.encode(ch);
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

export interface SignParams {
  endpoint: string;     // e.g. https://s3.us-west-1.idrivecloud.com or http://127.0.0.1:54321/storage/v1/s3
  region: string;       // e.g. us-west-1, local
  bucket: string;
  key: string;
  accessKey: string;
  secretKey: string;
  method: 'GET' | 'PUT';
  expiresIn: number;    // seconds, max 604800 per AWS spec
  contentType?: string; // optional; if set, included as a signed header (PUT)
}

export interface SignedUrl {
  url: string;
  expiresAt: number; // ms epoch
}

export async function presignS3Url(p: SignParams): Promise<SignedUrl> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260428T123456Z
  const dateStamp = amzDate.slice(0, 8);                          // 20260428
  const credentialScope = `${dateStamp}/${p.region}/s3/aws4_request`;

  const url = new URL(p.endpoint);
  // Path-style addressing: /<bucket>/<key>. (Virtual-hosted style would put
  // the bucket in the hostname; iDrive supports both, MinIO defaults to path.)
  const pathname = `${url.pathname.replace(/\/$/, '')}/${p.bucket}/${p.key}`
    .split('/')
    .map(seg => uriEscape(seg, false))
    .join('/');

  // Signed headers: just `host` (and optionally content-type for PUT).
  const headerEntries: [string, string][] = [['host', url.host]];
  if (p.method === 'PUT' && p.contentType) {
    headerEntries.push(['content-type', p.contentType]);
  }
  headerEntries.sort((a, b) => a[0].localeCompare(b[0]));
  const signedHeaders = headerEntries.map(([k]) => k).join(';');
  const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v.trim()}\n`).join('');

  const queryParams = new URLSearchParams();
  queryParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  queryParams.set('X-Amz-Credential', `${p.accessKey}/${credentialScope}`);
  queryParams.set('X-Amz-Date', amzDate);
  queryParams.set('X-Amz-Expires', String(p.expiresIn));
  queryParams.set('X-Amz-SignedHeaders', signedHeaders);
  // Sort params alphabetically and re-encode; URLSearchParams already sorts when we call sort().
  const sorted = Array.from(queryParams.entries()).sort(([a], [b]) => a.localeCompare(b));
  const canonicalQuery = sorted
    .map(([k, v]) => `${uriEscape(k)}=${uriEscape(v)}`)
    .join('&');

  const canonicalRequest = [
    p.method,
    pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  // Derive signing key: kDate -> kRegion -> kService -> kSigning
  const kDate    = await hmacSha256(enc.encode('AWS4' + p.secretKey), dateStamp);
  const kRegion  = await hmacSha256(kDate, p.region);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const sigBytes = await hmacSha256(kSigning, stringToSign);
  const signature = toHex(sigBytes);

  const finalUrl = `${url.protocol}//${url.host}${pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return {
    url: finalUrl,
    expiresAt: now.getTime() + p.expiresIn * 1000,
  };
}
