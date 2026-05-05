// System-requirements estimator for local GGUF models.
//
// We use a back-of-envelope rule of thumb that's "right enough" for the
// UI to give an honest hint about whether a given model will run on the
// user's machine before they spend 4 GB of bandwidth pulling it.
//
// Rule of thumb (Q4 GGUF, 4096-token context):
//   - model in memory      ≈ sizeBytes * 1.0
//   - KV cache             ≈ paramsB   * 0.5 GB
//   - overhead (CUDA libs, scratch, page-aligned slack)
//                          ≈ 0.5 GB
//   - recommendedVram      = ceil(model_gb + kv_gb + 0.5)
//   - minRamGb             = recommendedVram + 2     (CPU fallback path)
//   - runsOnCpu            = recommendedVram <= 8    (CPUs with 8+ GB
//                            of unified/system RAM can chew Q4 7B-class
//                            models at usable tps without a GPU)
//
// These numbers come from llama.cpp/Ollama community benchmarks for
// Q4_K_M; finer-grained quants (Q5, Q8, F16) will under-estimate but
// the catalogue we ship is Q4 across the board.

export interface SystemRequirements {
  /** Recommended system RAM if running on CPU. Whole GBs. */
  minRamGb: number;
  /** Recommended VRAM for GPU offload. Whole GBs. */
  recommendedVramGb: number;
  /** True when the model is small enough to be reasonable on CPU only. */
  runsOnCpu: boolean;
}

const BYTES_PER_GB = 1024 * 1024 * 1024;
const KV_GB_PER_B_PARAM = 0.5;        // 4096 ctx, Q4 KV
const OVERHEAD_GB = 0.5;
const CPU_FRIENDLY_VRAM_GB = 8;

/**
 * Estimate the resources needed to run a Q4 GGUF model.
 *
 * @param sizeBytes  on-disk size of the GGUF file (also ≈ in-memory weights)
 * @param paramsB    parameter count in billions (e.g. 7 for a 7B model)
 */
export function estimateRequirements(
  sizeBytes: number,
  paramsB: number,
): SystemRequirements {
  const modelGb = sizeBytes / BYTES_PER_GB;
  const kvGb = paramsB * KV_GB_PER_B_PARAM;
  const recommendedVramGb = Math.max(1, Math.ceil(modelGb + kvGb + OVERHEAD_GB));
  const minRamGb = recommendedVramGb + 2;
  const runsOnCpu = recommendedVramGb <= CPU_FRIENDLY_VRAM_GB;
  return { minRamGb, recommendedVramGb, runsOnCpu };
}

/**
 * Parse a parameter-size label into a number of *billions*.
 *
 *   "1.5B"  -> 1.5
 *   "7B"    -> 7
 *   "33M"   -> 0.033
 *   "270M"  -> 0.27
 *   "1.5b"  -> 1.5  (case-insensitive)
 *   "  7 B" -> 7    (whitespace tolerated)
 *
 * Returns 0 on anything we can't parse so callers can fall back to a
 * size-based heuristic without exception handling.
 */
export function parseParamsB(label: string): number {
  if (!label) return 0;
  const m = /([\d.]+)\s*([bm])/i.exec(label.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2].toLowerCase();
  return unit === 'b' ? n : n / 1000;        // M → /1000 to land in B
}

/**
 * Map our internal underscored model id (`qwen2.5-1.5b-q4`) to the
 * registry name Ollama expects on `pull` / `chat` (`qwen2.5:1.5b`).
 *
 * The registry id encodes:  family-params-quant
 * Ollama's tag is:          family:params         (Q4 is implicit;
 *                                                  it's the default tag)
 *
 * Curated for the LOCAL_GGUF_CATALOGUE in registry.ts. Unknown ids
 * fall through to a best-effort transform so power users typing a
 * raw Ollama tag still work.
 */
export const OLLAMA_TAG_BY_ID: Readonly<Record<string, string>> = Object.freeze({
  'qwen2.5-1.5b-q4': 'qwen2.5:1.5b',
  'qwen2.5-7b-q4':   'qwen2.5:7b',
  'llama3.1-8b-q4':  'llama3.1:8b',
  'mistral-7b-q4':   'mistral:7b',
  'phi3.5-mini-q4':  'phi3.5:3.8b',
  'gemma2-9b-q4':    'gemma2:9b',
});

export function ollamaTagForId(id: string): string {
  const direct = OLLAMA_TAG_BY_ID[id];
  if (direct) return direct;
  // Best effort: strip the `-q*` suffix and replace the last hyphen
  // before the params with a colon. e.g. "foo-7b" → "foo:7b".
  const noQuant = id.replace(/-q\d+(_\w+)?$/i, '');
  const m = /^(.*)-([\d.]+[bmBM])$/.exec(noQuant);
  if (m) return `${m[1]}:${m[2].toLowerCase()}`;
  return noQuant;
}

/**
 * Convenience: pull params-in-billions out of a registry id when no
 * separate label is available. e.g. "qwen2.5-1.5b-q4" → 1.5.
 */
export function paramsBFromId(id: string): number {
  const m = /-([\d.]+[bmBM])(?:-|$)/.exec(id);
  return m ? parseParamsB(m[1]) : 0;
}
