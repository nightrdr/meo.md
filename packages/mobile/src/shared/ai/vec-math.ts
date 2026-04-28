/**
 * Cosine similarity between two L2-normalized vectors.
 * Inputs are assumed normalized (the embedder sets normalize=true).
 */
export function cosineNormalized(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('vector dim mismatch');
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  if (dot > 1) return 1;
  if (dot < -1) return -1;
  return dot;
}
