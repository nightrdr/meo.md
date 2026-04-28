// Mobile embedder. v1.0 phase 3 ships only `NoopEmbedder`:
// returns zero-vectors. With this, hybrid retrieval gracefully
// degrades to BM25-only — vector contributes nothing, RRF picks the
// BM25 hits, and snippets fall back to the first matching sentences.
//
// The real bge-small-en-v1.5 embedder lands in phase 3.5, after
// `expo prebuild` and a native ONNX runtime (e.g. `transformers-rn`)
// is installed. Same `Embedder` interface, ~50× faster than running
// transformers.js on Hermes/JSC.

import type { Embedder } from './types';

const DIM = 384;

export class NoopEmbedder implements Embedder {
  readonly id = 'noop';
  readonly dim = DIM;
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(DIM);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(DIM));
  }
}

/**
 * Default factory. Returns the noop embedder until phase 3.5.
 */
export async function getEmbedder(): Promise<Embedder> {
  return new NoopEmbedder();
}

export function clearEmbedderCache(): void {
  // No-op for the noop embedder.
}
