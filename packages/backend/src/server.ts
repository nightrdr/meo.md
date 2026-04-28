import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';

import { db, nextVersionFor } from './db.js';
import { hashPassword, verifyPassword, signJwt, verifyJwt, type JwtPayload } from './auth.js';

const app = new Hono();
app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'], allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'] }));

app.get('/healthz', (c) => c.json({ ok: true, service: 'meo.md backend', ts: Date.now() }));

// --- auth ---

app.post('/auth/signup', async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: string; password?: string } | null;
  if (!body?.email || !body.password) return c.json({ error: 'email and password required' }, 400);
  if (body.password.length < 8) return c.json({ error: 'password too short' }, 400);

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(body.email);
  if (existing) return c.json({ error: 'email already registered' }, 409);

  const id = randomUUID();
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, body.email, hashPassword(body.password), Date.now());
  return c.json({ user_id: id });
});

app.post('/auth/login', async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: string; password?: string } | null;
  if (!body?.email || !body.password) return c.json({ error: 'email and password required' }, 400);
  const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(body.email) as { id: string; email: string; password_hash: string } | undefined;
  if (!user || !verifyPassword(body.password, user.password_hash)) return c.json({ error: 'invalid credentials' }, 401);
  const hasAccount = !!db.prepare('SELECT 1 FROM accounts WHERE user_id = ?').get(user.id);
  const jwt = signJwt({ sub: user.id, email: user.email });
  return c.json({ jwt, has_account: hasAccount, user_id: user.id });
});

// --- middleware: require auth ---

function requireAuth(c: any): JwtPayload | Response {
  const header = c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const payload = verifyJwt(header.slice(7));
  if (!payload) return c.json({ error: 'invalid token' }, 401);
  return payload;
}

// --- account (encryption wrapper) ---

app.get('/account', (c) => {
  const auth = requireAuth(c); if (auth instanceof Response) return auth;
  const row = db.prepare('SELECT salt, encrypted_master_key, master_key_nonce, kdf_params FROM accounts WHERE user_id = ?').get(auth.sub) as any;
  if (!row) return c.json({ error: 'no account' }, 404);
  return c.json({
    salt: Buffer.from(row.salt).toString('base64'),
    encrypted_master_key: Buffer.from(row.encrypted_master_key).toString('base64'),
    master_key_nonce: Buffer.from(row.master_key_nonce).toString('base64'),
    kdf_params: JSON.parse(row.kdf_params),
  });
});

app.put('/account', async (c) => {
  const auth = requireAuth(c); if (auth instanceof Response) return auth;
  const body = await c.req.json() as any;
  if (!body?.salt || !body.encrypted_master_key || !body.master_key_nonce || !body.kdf_params) {
    return c.json({ error: 'missing fields' }, 400);
  }
  const exists = db.prepare('SELECT 1 FROM accounts WHERE user_id = ?').get(auth.sub);
  if (exists) return c.json({ error: 'account already initialized' }, 409);
  db.prepare(`INSERT INTO accounts (user_id, salt, encrypted_master_key, master_key_nonce, kdf_params, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`).run(
    auth.sub,
    Buffer.from(body.salt, 'base64'),
    Buffer.from(body.encrypted_master_key, 'base64'),
    Buffer.from(body.master_key_nonce, 'base64'),
    JSON.stringify(body.kdf_params),
    Date.now(),
  );
  return c.json({ ok: true });
});

// --- notes / sync ---

function rowToWire(row: any) {
  return {
    id: row.id,
    encrypted_content: Buffer.from(row.encrypted_content).toString('base64'),
    nonce: Buffer.from(row.nonce).toString('base64'),
    version: row.version,
    hlc_timestamp: row.hlc_timestamp,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    size_bytes: row.size_bytes,
  };
}

app.get('/sync/notes', (c) => {
  const auth = requireAuth(c); if (auth instanceof Response) return auth;
  const since = Number(c.req.query('since') ?? 0);
  const rows = db.prepare(`SELECT * FROM notes WHERE user_id = ? AND version > ? ORDER BY version ASC`).all(auth.sub, since) as any[];
  const cursor = rows.length ? rows[rows.length - 1].version : since;
  return c.json({ notes: rows.map(rowToWire), cursor });
});

app.post('/notes', async (c) => {
  const auth = requireAuth(c); if (auth instanceof Response) return auth;
  const body = await c.req.json() as any;
  if (!body?.id || !body.encrypted_content || !body.nonce || !body.hlc_timestamp) {
    return c.json({ error: 'missing fields' }, 400);
  }
  const existing = db.prepare('SELECT user_id, hlc_timestamp FROM notes WHERE id = ?').get(body.id) as any;
  if (existing && existing.user_id !== auth.sub) return c.json({ error: 'forbidden' }, 403);

  // last-write-wins by HLC: reject if incoming HLC <= existing
  if (existing && body.hlc_timestamp <= existing.hlc_timestamp) {
    const current = db.prepare('SELECT * FROM notes WHERE id = ?').get(body.id) as any;
    return c.json({ error: 'stale write', current: rowToWire(current) }, 409);
  }

  const ct = Buffer.from(body.encrypted_content, 'base64');
  const nonce = Buffer.from(body.nonce, 'base64');
  const version = nextVersionFor(auth.sub);
  const updatedAt = Date.now();

  if (existing) {
    db.prepare(`UPDATE notes SET encrypted_content=?, nonce=?, version=?, hlc_timestamp=?, updated_at=?, deleted_at=NULL, size_bytes=? WHERE id=?`)
      .run(ct, nonce, version, body.hlc_timestamp, updatedAt, ct.length, body.id);
  } else {
    db.prepare(`INSERT INTO notes (id, user_id, encrypted_content, nonce, version, hlc_timestamp, updated_at, deleted_at, size_bytes)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(body.id, auth.sub, ct, nonce, version, body.hlc_timestamp, updatedAt, ct.length);
  }
  const saved = db.prepare('SELECT * FROM notes WHERE id = ?').get(body.id);
  return c.json(rowToWire(saved));
});

app.delete('/notes/:id', (c) => {
  const auth = requireAuth(c); if (auth instanceof Response) return auth;
  const id = c.req.param('id');
  const existing = db.prepare('SELECT user_id FROM notes WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (existing.user_id !== auth.sub) return c.json({ error: 'forbidden' }, 403);
  const version = nextVersionFor(auth.sub);
  const now = Date.now();
  db.prepare('UPDATE notes SET deleted_at=?, version=?, updated_at=? WHERE id=?').run(now, version, now, id);
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  return c.json(rowToWire(row));
});

// --- start ---

const port = Number(process.env.PORT ?? 8787);
console.log(`meo.md backend listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
