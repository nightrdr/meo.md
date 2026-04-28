// Session-scoped AI runtime. Manages:
//  - The embedder (lazy-loaded via @huggingface/transformers)
//  - The in-memory vector store engine
//  - IndexedDB persistence of vectors
//  - The BM25 index over the current decrypted notes
//  - The Ollama generator
//
// Constructed once when AI is first used, kept alive for the session.
// Notes are upserted into both the BM25 index and the vector store
// whenever they're saved (see App.tsx wiring).

import {
  ai as A,
  type Note,
} from '@meo/shared';
import {
  loadAllVectors, putVector, deleteVector,
} from './storage';

export interface AIRuntime {
  embedder: A.Embedder;
  vectorStore: A.InMemoryVectorEngine;
  bm25: A.Bm25Index;
  generator: A.OllamaBackend;
  /** Index a single note. Re-embeds only if the content hash changed. */
  indexNote(note: Note): Promise<void>;
  /** Drop a note's index entry (called on tombstone). */
  removeNote(noteId: string): Promise<void>;
  /** Bulk-rebuild from a snapshot of the user's notes. */
  rebuild(notes: Map<string, Note>, onProgress?: (done: number, total: number) => void): Promise<void>;
  /** Plain-text status for the AI panel header. */
  isAvailable(): Promise<{ ollama: boolean; embedder: boolean }>;
}

let cached: AIRuntime | null = null;

/**
 * Get (and lazily build) the AI runtime. Note: the embedder loads
 * lazily inside this function — first call triggers the model
 * download, which can be slow.
 */
export async function getAIRuntime(): Promise<AIRuntime> {
  if (cached) return cached;
  cached = await build();
  return cached;
}

/**
 * Return the cached runtime if it's been built, else null. Used by
 * the save lifecycle to keep the index in sync without triggering a
 * cold-start of the embedder.
 */
export function peekAIRuntime(): AIRuntime | null {
  return cached;
}

export function clearAIRuntime(): void {
  // Don't try to dispose the embedder; transformers.js manages its own
  // lifecycle. Just drop our reference; GC handles the rest after a
  // tab refresh.
  cached = null;
}

async function build(): Promise<AIRuntime> {
  const embedder = await A.getEmbedder();
  const vectorStore = new A.InMemoryVectorEngine();
  const bm25 = new A.Bm25Index();
  const generator = new A.OllamaBackend();

  // Hydrate the vector store from disk (synchronously empty until
  // we've embedded any notes, but we may have persisted vectors from
  // a previous session).
  const persisted = await loadAllVectors();
  if (persisted.length) {
    const entries = persisted.map(p => ({
      noteId: p.noteId,
      vec: new Float32Array(p.vec),
      meta: { vec_hash: p.vec_hash, embedder_id: p.embedder_id },
    }));
    vectorStore.bulkLoad(entries);
  }

  async function indexNote(note: Note) {
    const expectedHash = await A.noteVecHash(note);
    const currentHash = vectorStore.hashFor(note.id);
    if (currentHash === expectedHash) {
      // Up-to-date in vector store; still keep BM25 in sync (cheap).
      bm25.upsert(note);
      return;
    }
    const text = A.formatNoteForEmbedding(note);
    const vec = await embedder.embed(text);
    await vectorStore.upsert(note.id, vec, {
      vec_hash: expectedHash,
      embedder_id: embedder.id,
    });
    await putVector({
      noteId: note.id,
      vec: vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength) as ArrayBuffer,
      vec_hash: expectedHash,
      embedder_id: embedder.id,
    });
    bm25.upsert(note);
  }

  async function removeNote(noteId: string) {
    await vectorStore.remove(noteId);
    await deleteVector(noteId);
    bm25.remove(noteId);
  }

  async function rebuild(
    notes: Map<string, Note>,
    onProgress?: (done: number, total: number) => void,
  ) {
    const arr = Array.from(notes.values());
    bm25.rebuild(arr);
    let done = 0;
    for (const n of arr) {
      await indexNote(n);
      done++;
      if (onProgress) onProgress(done, arr.length);
      // Yield to keep UI responsive every 25 notes
      if (done % 25 === 0) await new Promise(r => setTimeout(r, 0));
    }
  }

  return {
    embedder, vectorStore, bm25, generator,
    indexNote, removeNote, rebuild,
    async isAvailable() {
      return {
        ollama: await generator.isAvailable(),
        embedder: true,
      };
    },
  };
}
