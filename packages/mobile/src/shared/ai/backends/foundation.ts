// Apple FoundationModels backend.
//
// iOS 18+ ships an in-OS LLM via the FoundationModels framework.
// Hooking it up requires a small Swift native module (Pod) that
// bridges `LanguageModelSession` → React Native. That module isn't
// shipped yet — this file provides:
//
//   1. `isFoundationModelsAvailable()` — JS-side gating used by the
//      registry to decide whether to *list* the system-os model.
//   2. `FoundationBackend` — implements `Generator` so the chain in
//      `aiStore.ts` is uniform; `isAvailable()` always returns false
//      until a real native module is linked, so we never silently
//      try and fail.
//
// When the native module lands (`FoundationLLMModule`), this file
// will lazy-require it the same way `llamaRn.ts` does. Until then,
// the model remains visible-but-unavailable in the registry, which
// matches the desktop pattern of "Ollama installed but no models".

import { Platform } from 'react-native';
import type { Generator, Model, GenerateOptions, GenerateChunk } from '../types';

type FoundationLLMModule = {
  isAvailable(): Promise<boolean>;
  /** Stream a chat completion. Tokens come via the optional callback. */
  complete(opts: {
    messages: { role: string; content: string }[];
    maxTokens?: number;
    temperature?: number;
  }, onToken?: (delta: string) => void): Promise<{ promptTokens: number; completionTokens: number }>;
};

let modulePresent: boolean | null = null;
let foundationModule: FoundationLLMModule | null = null;
function tryLoadFoundationModule(): FoundationLLMModule | null {
  if (modulePresent !== null) return foundationModule;
  modulePresent = false;
  try {
    // The native module name when it ships will be `FoundationLLM`.
    // It's wrapped via `react-native`'s NativeModules — but we
    // require it dynamically so the JS bundle still loads on
    // platforms that don't have it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RN = require('react-native');
    const m = RN?.NativeModules?.FoundationLLM as FoundationLLMModule | undefined;
    if (m && typeof m.complete === 'function') {
      foundationModule = m;
      modulePresent = true;
    }
  } catch {
    /* swallow */
  }
  return foundationModule;
}

/** True iff this device *could* run Apple FoundationModels (iOS 18+). */
export function isFoundationModelsCapable(): boolean {
  if (Platform.OS !== 'ios') return false;
  // Platform.Version on iOS is a string like "18.1"; on Android it's a number.
  const v = parseInt(String(Platform.Version), 10);
  return Number.isFinite(v) && v >= 18;
}

/** Live availability — capability AND the native module is linked AND the OS reports the model is ready. */
export async function isFoundationModelsAvailable(): Promise<boolean> {
  if (!isFoundationModelsCapable()) return false;
  const m = tryLoadFoundationModule();
  if (!m) return false;
  try { return await m.isAvailable(); } catch { return false; }
}

export class FoundationBackend implements Generator {
  readonly id = 'apple-foundation';

  async isAvailable(): Promise<boolean> {
    return isFoundationModelsAvailable();
  }

  async listModels(): Promise<Model[]> {
    if (!isFoundationModelsCapable()) return [];
    return [{
      id: 'apple-foundation',
      name: 'Apple Intelligence',
      kind: 'system-os',
      tag: 'iOS 18+, free, no download',
      installed: true,
    }];
  }

  async *stream(opts: GenerateOptions): AsyncIterable<GenerateChunk> {
    const m = tryLoadFoundationModule();
    if (!m) throw new Error('Apple FoundationModels native module is not linked');

    type Item =
      | { kind: 'delta'; delta: string }
      | { kind: 'done'; usage?: { promptTokens: number; completionTokens: number } }
      | { kind: 'error'; error: Error };
    const queue: Item[] = [];
    let resolveNext: ((v: Item) => void) | null = null;
    const push = (item: Item) => {
      if (resolveNext) { resolveNext(item); resolveNext = null; }
      else queue.push(item);
    };
    const next = (): Promise<Item> => new Promise((resolve) => {
      if (queue.length) resolve(queue.shift()!);
      else resolveNext = resolve;
    });

    m.complete(
      {
        messages: opts.messages,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
      },
      (delta) => { if (delta) push({ kind: 'delta', delta }); },
    ).then(
      (usage) => push({ kind: 'done', usage }),
      (err: Error) => push({ kind: 'error', error: err }),
    );

    while (true) {
      const item = await next();
      if (item.kind === 'error') throw item.error;
      if (item.kind === 'delta') yield { delta: item.delta };
      if (item.kind === 'done') {
        yield { delta: '', done: true, usage: item.usage };
        return;
      }
    }
  }
}
