// Mobile AI runtime. Mirrors packages/desktop/src/aiStore.ts but uses
// AsyncStorage for vector persistence and a swappable generator backend.
//
// v1.0 phase 3 ships:
//   - NoopEmbedder (BM25 carries retrieval, vector contributes nothing)
//   - AsyncStorage vector store (sufficient for ≲ 5k notes)
//   - In-memory BM25 over decrypted notes
//   - Ollama generator backend (works if user runs Ollama on the device's
//     LAN and forwards the port; in practice nobody does this; treats it
//     as Available=false on real iPhones, surfaces "AI coming soon")
//   - Frontier API key generator (also gated to v1.1 paid tier)
//
// Phase 3.5 swaps NoopEmbedder → real bge-small-en-v1.5 via
// transformers-rn, and adds llama.rn as the primary generator.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ai as A,
  type Note,
} from './shared';

const VECTORS_KEY = 'meo.vectors.v1';

interface PersistedVectorRecord {
  noteId: string;
  vec: number[];          // serialized — AsyncStorage is JSON-only
  vec_hash: string;
  embedder_id: string;
}

export interface MobileAIRuntime {
  embedder: A.Embedder;
  vectorStore: A.InMemoryVectorEngine;
  bm25: A.Bm25Index;
  generator: A.OllamaBackend;
  indexNote(note: Note): Promise<void>;
  removeNote(noteId: string): Promise<void>;
  rebuild(notes: Map<string, Note>, onProgress?: (done: number, total: number) => void): Promise<void>;
  isAvailable(): Promise<{ ollama: boolean; embedder: boolean }>;
}

let cached: MobileAIRuntime | null = null;

export async function getAIRuntime(): Promise<MobileAIRuntime> {
  if (cached) return cached;
  cached = await build();
  return cached;
}

export function peekAIRuntime(): MobileAIRuntime | null { return cached; }
export function clearAIRuntime(): void { cached = null; }

async function build(): Promise<MobileAIRuntime> {
  const embedder = await A.getEmbedder();
  const vectorStore = new A.InMemoryVectorEngine();
  const bm25 = new A.Bm25Index();
  const generator = new A.OllamaBackend();

  // Hydrate from AsyncStorage. JSON arrays are slow at scale; that's
  // OK for v1.0 phase 3 — switch to op-sqlite in phase 3.5.
  const raw = await AsyncStorage.getItem(VECTORS_KEY);
  if (raw) {
    try {
      const records = JSON.parse(raw) as PersistedVectorRecord[];
      vectorStore.bulkLoad(records.map(r => ({
        noteId: r.noteId,
        vec: new Float32Array(r.vec),
        meta: { vec_hash: r.vec_hash, embedder_id: r.embedder_id },
      })));
    } catch { /* silent: corrupt cache → start fresh */ }
  }

  async function persist() {
    const out: PersistedVectorRecord[] = [];
    for (const e of vectorStore.all()) {
      out.push({
        noteId: e.noteId,
        vec: Array.from(e.vec),
        vec_hash: e.meta.vec_hash,
        embedder_id: e.meta.embedder_id,
      });
    }
    await AsyncStorage.setItem(VECTORS_KEY, JSON.stringify(out));
  }

  async function indexNote(note: Note) {
    const expectedHash = await A.noteVecHash(note);
    const currentHash = vectorStore.hashFor(note.id);
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
    await persist();
  }

  async function removeNote(noteId: string) {
    await vectorStore.remove(noteId);
    bm25.remove(noteId);
    await persist();
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
      // Yield every 25 notes
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
