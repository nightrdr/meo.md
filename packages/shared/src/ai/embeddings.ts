// Local embedding model. Defaults to bge-small-en-v1.5 (384-dim, ~33 MB
// quantized). Runs in a Web Worker on desktop, on the JS thread on mobile.
//
// The dependency is loaded dynamically so that bundlers don't pull it
// into the initial chunk for users who never open the AI panel.

import type { Embedder } from './types.js';

let cached: Embedder | null = null;

/**
 * Get (and lazily load) the default embedder. The first call downloads
 * model weights from the HF CDN and primes the runtime; subsequent calls
 * are instant.
 */
export async function getEmbedder(): Promise<Embedder> {
  if (cached) return cached;
  cached = await loadBgeSmall();
  return cached;
}

/**
 * Force a re-load (e.g. after an embedder model swap). Releases the
 * old runtime by dropping the reference.
 */
export function clearEmbedderCache(): void {
  cached = null;
}

async function loadBgeSmall(): Promise<Embedder> {
  // Dynamic import keeps the ~10 MB transformers.js shim out of the
  // initial bundle. (Successor to @xenova/transformers under HF's
  // own namespace.)
  const tx: any = await import('@huggingface/transformers');

  // Pipeline construction. We use 'feature-extraction' which gives us
  // the raw [seq, dim] tensor; pooling is mean-of-tokens (the BGE
  // recommended default) with L2 normalization.
  const pipe = await tx.pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
    quantized: true,         // ~33 MB instead of ~130 MB
    progress_callback: (p: any) => {
      if (p?.status === 'progress' && p.file?.endsWith('.onnx')) {
        // Hook for the UI to show a download bar.
        if (typeof globalThis !== 'undefined' && (globalThis as any).__meoEmbedderProgress) {
          (globalThis as any).__meoEmbedderProgress(p);
        }
      }
    },
  });

  const dim = 384;
  const id = 'bge-small-en-v1.5';

  async function embed(text: string): Promise<Float32Array> {
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    // tx.Tensor → Float32Array
    return new Float32Array(output.data);
  }

  return {
    id,
    dim,
    embed,
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      // The runtime supports batch but we keep it simple: serial calls.
      // BGE encoder is ~5 ms/call on M2; batching doesn't change much
      // and serial keeps memory bounded.
      const out: Float32Array[] = [];
      for (const t of texts) out.push(await embed(t));
      return out;
    },
  };
}

// ─── Cosine similarity utility (used by vector store implementations) ──

/**
 * Cosine similarity between two L2-normalized vectors.
 * Inputs are assumed normalized (the embedder above sets normalize=true).
 * Skips the vector-norm divisions for speed.
 */
export function cosineNormalized(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('vector dim mismatch');
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Clamp small numerical drift; cosine of unit vectors is in [-1, 1].
  if (dot > 1) return 1;
  if (dot < -1) return -1;
  return dot;
}
