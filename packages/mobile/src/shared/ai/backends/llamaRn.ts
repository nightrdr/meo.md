// llama.rn generator backend. Mobile-only on-device LLM runtime.
//
// Backed by https://github.com/mybigday/llama.rn — a React Native
// binding around llama.cpp with Metal acceleration on iOS and
// Vulkan/OpenCL/CPU on Android. Models are GGUF files stored in the
// app sandbox and downloaded from Hugging Face Hub on demand.
//
// Lifecycle:
//   1. `LlamaRnBackend.isAvailable()` — checks that `llama.rn` is
//      linked (it is, after `expo prebuild`) and that at least one
//      GGUF model file exists in the models directory.
//   2. `listModels()` — scans `<documents>/models/*.gguf` and matches
//      filenames against the static catalogue from registry.ts.
//   3. `stream({model, messages})` — lazily loads the matching GGUF,
//      caches the LlamaContext, and pumps token deltas through the
//      shared `Generator` interface.
//
// Model registry filenames:
//   qwen2.5-1.5b-q4   → qwen2.5-1.5b-instruct-q4_k_m.gguf
//   llama3.1-8b-q4    → llama-3.1-8b-instruct-q4_k_m.gguf
//   qwen2.5-7b-q4     → qwen2.5-7b-instruct-q4_k_m.gguf
//   ...
//
// We never log token contents. P2.

import * as FileSystem from 'expo-file-system';
import type {
  Generator, Model, GenerateOptions, GenerateChunk,
} from '../types';
import { LOCAL_GGUF_CATALOGUE } from '../registry';

// llama.rn is a native module. It only loads after `npx expo prebuild`
// + a custom-dev-client build. We import lazily so the JS bundle still
// runs in Expo Go (where it'll just report `isAvailable() === false`).

type LlamaModule = typeof import('llama.rn');
type LlamaContext = Awaited<ReturnType<LlamaModule['initLlama']>>;

let llamaModule: LlamaModule | null = null;
let moduleLoadAttempted = false;

function getLlama(): LlamaModule | null {
  if (moduleLoadAttempted) return llamaModule;
  moduleLoadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    llamaModule = require('llama.rn') as LlamaModule;
  } catch {
    llamaModule = null;
  }
  return llamaModule;
}

export const MODELS_DIR = `${FileSystem.documentDirectory ?? ''}models/`;

/** Map registry id → filename in models dir + HF Hub URL. */
export const MODEL_FILES: Record<string, { filename: string; url: string; sha256?: string }> = {
  'qwen2.5-1.5b-q4': {
    filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    // Bartowski's quants of Qwen 2.5 are the de-facto reference.
    url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
  },
  'llama3.1-8b-q4': {
    filename: 'llama-3.1-8b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
  },
  'qwen2.5-7b-q4': {
    filename: 'qwen2.5-7b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
  },
  'mistral-7b-q4': {
    filename: 'mistral-7b-instruct-v0.3-q4_k_m.gguf',
    url: 'https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
  },
  'phi3.5-mini-q4': {
    filename: 'phi-3.5-mini-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf',
  },
  'gemma2-9b-q4': {
    filename: 'gemma-2-9b-it-q4_k_m.gguf',
    url: 'https://huggingface.co/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q4_K_M.gguf',
  },
};

/** Path to a downloaded model's GGUF file (may not exist yet). */
export function modelPath(id: string): string | null {
  const entry = MODEL_FILES[id];
  if (!entry) return null;
  return `${MODELS_DIR}${entry.filename}`;
}

export async function ensureModelsDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MODELS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
  }
}

export async function isModelInstalled(id: string): Promise<boolean> {
  const p = modelPath(id);
  if (!p) return false;
  try {
    const info = await FileSystem.getInfoAsync(p);
    return info.exists && !info.isDirectory && (info.size ?? 0) > 1024 * 1024;
  } catch {
    return false;
  }
}

/**
 * Stream a model download from HF Hub. Resumable, Wi-Fi-only by default.
 * Caller drives the loop; each yielded value is `{ totalBytesWritten,
 * totalBytesExpectedToWrite, done }`.
 */
export async function downloadModel(
  id: string,
  onProgress?: (p: { written: number; total: number }) => void,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const entry = MODEL_FILES[id];
  if (!entry) return { ok: false, error: `Unknown model id: ${id}` };
  await ensureModelsDir();
  const dest = `${MODELS_DIR}${entry.filename}`;

  // expo-file-system gives us resumable downloads via createDownloadResumable.
  const resumable = FileSystem.createDownloadResumable(
    entry.url,
    dest,
    {},
    (p) => onProgress?.({
      written: p.totalBytesWritten,
      total: p.totalBytesExpectedToWrite,
    }),
  );
  try {
    if (signal) {
      const onAbort = () => { resumable.pauseAsync().catch(() => {}); };
      signal.addEventListener('abort', onAbort);
    }
    const result = await resumable.downloadAsync();
    if (!result?.uri) return { ok: false, error: 'Download cancelled' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function deleteModel(id: string): Promise<void> {
  const p = modelPath(id);
  if (!p) return;
  try { await FileSystem.deleteAsync(p, { idempotent: true }); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────

export class LlamaRnBackend implements Generator {
  readonly id = 'llama.rn';

  /** Cached context per model id. Loading a 1 GB GGUF takes seconds; never re-load. */
  private contexts = new Map<string, LlamaContext>();
  private loading = new Map<string, Promise<LlamaContext>>();

  async isAvailable(): Promise<boolean> {
    const lib = getLlama();
    if (!lib) return false;
    // We're "available" once any one model is on disk. If none is installed,
    // the AI sheet shows the install CTA in Settings → AI instead.
    for (const id of Object.keys(MODEL_FILES)) {
      if (await isModelInstalled(id)) return true;
    }
    return false;
  }

  /** Models we actually have on disk, plus their human-readable size. */
  async listModels(): Promise<Model[]> {
    const out: Model[] = [];
    for (const cat of LOCAL_GGUF_CATALOGUE) {
      const installed = await isModelInstalled(cat.id);
      if (!installed) continue;
      out.push({ ...cat, installed: true });
    }
    return out;
  }

  /** Free all loaded contexts. Useful on sign-out. */
  async releaseAll(): Promise<void> {
    const lib = getLlama();
    this.contexts.clear();
    if (lib?.releaseAllLlama) await lib.releaseAllLlama().catch(() => {});
  }

  private async getContext(modelId: string): Promise<LlamaContext> {
    const cached = this.contexts.get(modelId);
    if (cached) return cached;
    const inflight = this.loading.get(modelId);
    if (inflight) return inflight;
    const lib = getLlama();
    if (!lib) throw new Error('llama.rn native module is not linked');
    const path = modelPath(modelId);
    if (!path) throw new Error(`Unknown model id: ${modelId}`);
    if (!(await isModelInstalled(modelId))) {
      throw new Error(`Model not installed: ${modelId}`);
    }
    const promise = lib.initLlama({
      model: path,
      n_ctx: 4096,
      n_gpu_layers: 99,            // offload everything to Metal/Vulkan if possible
      use_mlock: false,
    }).then((ctx) => {
      this.contexts.set(modelId, ctx);
      this.loading.delete(modelId);
      return ctx;
    }, (err) => {
      this.loading.delete(modelId);
      throw err;
    });
    this.loading.set(modelId, promise);
    return promise;
  }

  /**
   * Stream a chat completion. We use llama.rn's `completion` with a
   * token callback and bridge it to an async iterable.
   */
  async *stream(opts: GenerateOptions): AsyncIterable<GenerateChunk> {
    const ctx = await this.getContext(opts.model);

    // Bridge native token-callback → async iterable.
    type Item =
      | { kind: 'delta'; delta: string }
      | { kind: 'done'; usage?: { promptTokens: number; completionTokens: number } }
      | { kind: 'error'; error: Error };

    const queue: Item[] = [];
    let resolveNext: ((v: Item | null) => void) | null = null;
    const push = (item: Item) => {
      if (resolveNext) { resolveNext(item); resolveNext = null; }
      else queue.push(item);
    };
    const next = (): Promise<Item | null> =>
      new Promise<Item | null>((resolve) => {
        if (queue.length) resolve(queue.shift()!);
        else resolveNext = resolve;
      });

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        ctx.stopCompletion().catch(() => {});
      });
    }

    ctx.completion(
      {
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        n_predict: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.7,
        stop: ['<|im_end|>', '<|eot_id|>', '</s>'],
      },
      (data) => {
        const delta = (data.token ?? data.content ?? '') as string;
        if (delta) push({ kind: 'delta', delta });
      },
    ).then((result: any) => {
      const u = result?.timings || result?.tokens_evaluated != null
        ? {
            promptTokens: (result.tokens_evaluated ?? 0) as number,
            completionTokens: (result.tokens_predicted ?? 0) as number,
          }
        : undefined;
      push({ kind: 'done', usage: u });
    }, (err: Error) => {
      push({ kind: 'error', error: err });
    });

    while (true) {
      const item = await next();
      if (!item) return;
      if (item.kind === 'error') throw item.error;
      if (item.kind === 'delta') yield { delta: item.delta };
      if (item.kind === 'done') {
        yield { delta: '', done: true, usage: item.usage };
        return;
      }
    }
  }
}
