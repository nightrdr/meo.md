// op-sqlite-backed vector store for mobile.
//
// Schema:
//   CREATE TABLE note_vectors (
//     note_id     TEXT PRIMARY KEY,
//     dim         INTEGER NOT NULL,
//     vec         BLOB NOT NULL,
//     vec_hash    TEXT NOT NULL,
//     embedder_id TEXT NOT NULL
//   );
//
// We hold the InMemoryVectorEngine as the hot path (brute-force cosine
// over Float32Arrays) and persist every change to SQLite. On startup we
// hydrate the engine by reading every row. <10k rows × 384 floats =
// ~15 MB, fine.
//
// Vectors are stored little-endian Float32 ArrayBuffers. We pass them to
// op-sqlite as `ArrayBuffer` and read them back as one too. op-sqlite
// returns BLOB columns as ArrayBuffer in `executeRaw` results.
//
// Lazy import: op-sqlite is a native module, so this file's top-level
// imports must stay JS-only. We `require('@op-engineering/op-sqlite')`
// inside `open()` so the JS bundle still parses on platforms where the
// pod isn't linked yet.

import type { VectorStore, SearchHit, VectorMeta } from './types';
import { InMemoryVectorEngine } from './vectorStore';

type OpSqlite = typeof import('@op-engineering/op-sqlite');
type DB = ReturnType<OpSqlite['open']>;

let opSqlite: OpSqlite | null = null;
function getOpSqlite(): OpSqlite | null {
  if (opSqlite) return opSqlite;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    opSqlite = require('@op-engineering/op-sqlite') as OpSqlite;
  } catch {
    opSqlite = null;
  }
  return opSqlite;
}

const DB_NAME = 'meo.db';
const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS note_vectors (
    note_id     TEXT PRIMARY KEY,
    dim         INTEGER NOT NULL,
    vec         BLOB NOT NULL,
    vec_hash    TEXT NOT NULL,
    embedder_id TEXT NOT NULL
  );
`;

function f32ToArrayBuffer(v: Float32Array): ArrayBuffer {
  // Make a tight copy so the buffer isn't a window into a larger pool.
  const out = new ArrayBuffer(v.byteLength);
  new Float32Array(out).set(v);
  return out;
}

function bytesToFloat32(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value;
  if (value instanceof ArrayBuffer) return new Float32Array(value);
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView;
    return new Float32Array(v.buffer, v.byteOffset, Math.floor(v.byteLength / 4));
  }
  if (Array.isArray(value)) return Float32Array.from(value as number[]);
  throw new Error('Unexpected BLOB type for vec column');
}

export class SqliteVectorStore implements VectorStore {
  private engine = new InMemoryVectorEngine();
  private db: DB | null = null;

  /** True if op-sqlite is linked and the table is ready. */
  static async isAvailable(): Promise<boolean> {
    return getOpSqlite() !== null;
  }

  async open(): Promise<void> {
    if (this.db) return;
    const lib = getOpSqlite();
    if (!lib) throw new Error('@op-engineering/op-sqlite is not linked');
    this.db = lib.open({ name: DB_NAME });
    await this.db.execute(TABLE_DDL);
    // Hydrate.
    const result = await this.db.execute('SELECT note_id, dim, vec, vec_hash, embedder_id FROM note_vectors');
    const entries: { noteId: string; vec: Float32Array; meta: VectorMeta }[] = [];
    for (const row of result.rows) {
      try {
        const vec = bytesToFloat32(row.vec);
        entries.push({
          noteId: String(row.note_id),
          vec,
          meta: {
            vec_hash: String(row.vec_hash),
            embedder_id: String(row.embedder_id),
          },
        });
      } catch { /* skip corrupt row */ }
    }
    this.engine.bulkLoad(entries);
  }

  async upsert(noteId: string, vector: Float32Array, meta?: VectorMeta): Promise<void> {
    if (!meta) throw new Error('VectorMeta is required');
    if (!this.db) await this.open();
    await this.engine.upsert(noteId, vector, meta);
    await this.db!.execute(
      'INSERT OR REPLACE INTO note_vectors (note_id, dim, vec, vec_hash, embedder_id) VALUES (?, ?, ?, ?, ?)',
      [noteId, vector.length, f32ToArrayBuffer(vector), meta.vec_hash, meta.embedder_id],
    );
  }

  async remove(noteId: string): Promise<void> {
    if (!this.db) await this.open();
    await this.engine.remove(noteId);
    await this.db!.execute('DELETE FROM note_vectors WHERE note_id = ?', [noteId]);
  }

  async search(query: Float32Array, k: number): Promise<SearchHit[]> {
    return this.engine.search(query, k);
  }

  async count(): Promise<number> {
    return this.engine.count();
  }

  async clear(): Promise<void> {
    if (!this.db) await this.open();
    await this.engine.clear();
    await this.db!.execute('DELETE FROM note_vectors');
  }

  /** Iteration helpers used by callers that want to introspect the cache. */
  hashFor(noteId: string): string | undefined {
    return this.engine.hashFor(noteId);
  }
}
