// Mobile AI runtime. Mirrors packages/desktop/src/aiStore.ts but uses
// op-sqlite for vector persistence and a chained generator that prefers
// the in-process llama.rn runtime over a (rare on mobile) Ollama daemon.
//
// Phase 3.5 ships:
//   - NoopEmbedder still in place (BM25 carries retrieval, vector
//     contributes nothing — see specs/05-llm-architecture.md §6.1
//     for the gap on the embedder side and embeddings.ts for the
//     reasoning).
//   - op-sqlite vector store (`note_vectors` table, see
//     specs/05-llm-architecture.md §6.2). Falls back to in-memory if
//     op-sqlite isn't linked yet (so the Expo Go shell still loads).
//   - In-memory BM25 over decrypted notes.
//   - LlamaRnBackend (Metal on iOS, Vulkan/OpenCL/CPU on Android)
//     preferred, with OllamaBackend as a developer fallback.
//   - FoundationBackend for iOS 18+ — visible-but-unavailable until
//     the Swift native module lands.
//
// `getAIRuntime()` lazily picks the highest-priority backend that
// reports `isAvailable() === true` for the active model. The choice is
// re-resolved each time the runtime is rebuilt (sign-out clears the
// cache).

import {
  ai as A,
  type Note,
} from './shared';
import type { Generator } from './shared/ai/types';
import { getUseRealEmbedder } from './aiSettings';

export interface MobileAIRuntime {
  embedder: A.Embedder;
  vectorStore: A.VectorStore;
  bm25: A.Bm25Index;
  /** The currently selected backend. May be `LlamaRnBackend`, `OllamaBackend`, or `FoundationBackend`. */
  generator: Generator;
  /** All wired backends, in preference order. UI uses this for "available" banners. */
  backends: { llama: A.LlamaRnBackend; ollama: A.OllamaBackend; foundation: A.FoundationBackend };
  indexNote(note: Note): Promise<void>;
  removeNote(noteId: string): Promise<void>;
  rebuild(notes: Map<string, Note>, onProgress?: (done: number, total: number) => void): Promise<void>;
  isAvailable(): Promise<{
    /** Any generator backend reports available */
    any: boolean;
    /** Per-backend availability */
    llama: boolean;
    foundation: boolean;
    ollama: boolean;
    /** Real (non-noop) embedder */
    embedder: boolean;
  }>;
}

let cached: MobileAIRuntime | null = null;

export async function getAIRuntime(): Promise<MobileAIRuntime> {
  if (cached) return cached;
  cached = await build();
  return cached;
}

export function peekAIRuntime(): MobileAIRuntime | null { return cached; }
export function clearAIRuntime(): void {
  // Drop the ONNX session if we held one. Releasing the native handle
  // is best-effort — the next build() will create a fresh one anyway.
  A.clearEmbedderCache();
  cached = null;
}

async function build(): Promise<MobileAIRuntime> {
  // The user opts into the real embedder via Settings → AI. Downloading
  // the bge-small files is a separate explicit step (33 MB). If the
  // flag is on but files are missing, fall back to NoopEmbedder so the
  // runtime still boots — BM25 still works and Settings shows what to
  // do.
  let useReal = await getUseRealEmbedder();
  if (useReal) {
    const status = await A.getEmbedderFileStatus();
    if (!status.ready) useReal = false;
  }
  let embedder: A.Embedder;
  try {
    embedder = await A.getEmbedder(useReal);
  } catch (err) {
    console.warn('[meo] real embedder failed to load; falling back to noop', err);
    embedder = await A.getEmbedder(false);
  }
  const bm25 = new A.Bm25Index();

  // Vector store: prefer op-sqlite. If the native module isn't linked
  // (e.g. the dev is poking at the JS bundle in Expo Go), fall back to
  // an in-memory engine. Both implement the same interface.
  let vectorStore: A.VectorStore;
  if (await A.SqliteVectorStore.isAvailable()) {
    const store = new A.SqliteVectorStore();
    try {
      await store.open();
      vectorStore = store;
    } catch (err) {
      console.warn('[meo] op-sqlite vector store failed to open; falling back to in-memory', err);
      vectorStore = new A.InMemoryVectorEngine();
    }
  } else {
    vectorStore = new A.InMemoryVectorEngine();
  }

  // Generator chain. Order matters — the first one that reports
  // available wins. See specs/05-llm-architecture.md §3.
  const llama = new A.LlamaRnBackend();
  const ollama = new A.OllamaBackend();
  const foundation = new A.FoundationBackend();
  const generator: Generator =
    (await foundation.isAvailable()) ? foundation
    : (await llama.isAvailable())     ? llama
    : ollama;                         // final fallback (returns isAvailable=false on most phones)

  async function indexNote(note: Note) {
    const expectedHash = await A.noteVecHash(note);
    const currentHash = (vectorStore as A.SqliteVectorStore | A.InMemoryVectorEngine).hashFor?.(note.id);
    if (currentHash === expectedHash) {
      bm25.upsert(note);
      return;
    }
    const text = A.formatNoteForEmbedding(note);
    const vec = await embedder.embed(text);
    await vectorStore.upsert(note.id, vec, {
      vec_hash: expectedHash,
      embedder_id: embedder.id,
    });
    bm25.upsert(note);
  }

  async function removeNote(noteId: string) {
    await vectorStore.remove(noteId);
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
      if (done % 25 === 0) await new Promise(r => setTimeout(r, 0));
    }
  }

  return {
    embedder,
    vectorStore,
    bm25,
    generator,
    backends: { llama, ollama, foundation },
    indexNote,
    removeNote,
    rebuild,
    async isAvailable() {
      const [llamaUp, foundationUp, ollamaUp] = await Promise.all([
        llama.isAvailable(),
        foundation.isAvailable(),
        ollama.isAvailable(),
      ]);
      return {
        any: llamaUp || foundationUp || ollamaUp,
        llama: llamaUp,
        foundation: foundationUp,
        ollama: ollamaUp,
        embedder: embedder.id !== 'noop',
      };
    },
  };
}
