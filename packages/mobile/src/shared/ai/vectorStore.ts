// In-memory vector store baseline. Brute-force cosine over an array of
// (noteId, vector) tuples. <50ms for 10k vectors at 384-dim on a modern
// laptop. Persistence is platform-specific: desktop uses IndexedDB,
// mobile uses SQLite via op-sqlite. Both wrap this in-memory engine.
//
// Vectors are assumed L2-normalized (the embedder guarantees this via
// pooling.normalize=true), so cosine reduces to a dot product.

import type { VectorStore, SearchHit, VectorMeta } from './types';
import { cosineNormalized } from './vec-math';

interface Entry {
  noteId: string;
  vec: Float32Array;
  meta: VectorMeta;
}

/**
 * In-memory engine. The persistence layer (IndexedDB, SQLite) wraps
 * this and replays its operations on disk.
 */
export class InMemoryVectorEngine implements VectorStore {
  private entries = new Map<string, Entry>();

  async upsert(noteId: string, vector: Float32Array, meta?: VectorMeta): Promise<void> {
    if (!meta) throw new Error('VectorMeta is required');
    this.entries.set(noteId, { noteId, vec: vector, meta });
  }

  async remove(noteId: string): Promise<void> {
    this.entries.delete(noteId);
  }

  async search(query: Float32Array, k: number): Promise<SearchHit[]> {
    if (this.entries.size === 0) return [];
    const out: SearchHit[] = [];
    for (const e of this.entries.values()) {
      const score = cosineNormalized(query, e.vec);
      out.push({ noteId: e.noteId, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }

  async count(): Promise<number> {
    return this.entries.size;
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  // ─── Iteration helpers used by the persistence layers ───

  *all(): IterableIterator<Entry> {
    yield* this.entries.values();
  }

  bulkLoad(entries: Entry[]): void {
    this.entries.clear();
    for (const e of entries) this.entries.set(e.noteId, e);
  }

  hashFor(noteId: string): string | undefined {
    return this.entries.get(noteId)?.meta.vec_hash;
  }
}
