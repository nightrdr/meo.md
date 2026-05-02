// Apple FoundationModels backend.
//
// iOS 18+ ships an in-OS LLM via the FoundationModels framework.
// Hooking it up requires a small Swift native module (Pod) that
// bridges `LanguageModelSession` → React Native. That module isn't
// shipped yet - this file provides:
//
//   1. `isFoundationModelsAvailable()` - JS-side gating used by the
//      registry to decide whether to *list* the system-os model.
//   2. `FoundationBackend` - implements `Generator` so the chain in
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

// Native bridge contract. The Swift side (modules/foundation-llm/ios/
// FoundationLLMModule.swift) emits tokens through an `RCTEventEmitter`
// keyed by `requestId`; we subscribe per-call and tear the listener
// down when the promise resolves.
type FoundationLLMNative = {
  isAvailable(): Promise<boolean>;
  complete(opts: {
    requestId: string;
    messages: { role: string; content: string }[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ promptTokens: number; completionTokens: number }>;
};

type FoundationLLMHandle = {
  module: FoundationLLMNative;
  emitter: { addListener: (event: string, fn: (e: any) => void) => { remove(): void } };
};

let modulePresent: boolean | null = null;
let foundationHandle: FoundationLLMHandle | null = null;
function tryLoadFoundationModule(): FoundationLLMHandle | null {
  if (modulePresent !== null) return foundationHandle;
  modulePresent = false;
  try {
    // Lazy-require react-native so this file still parses in Node-side
    // tests (test-tokenizer.mjs and friends).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RN = require('react-native');
    const m = RN?.NativeModules?.FoundationLLM as FoundationLLMNative | undefined;
    if (m && typeof m.complete === 'function') {
      const emitter = new RN.NativeEventEmitter(m as any);
      foundationHandle = { module: m, emitter };
      modulePresent = true;
    }
  } catch {
    /* swallow */
  }
  return foundationHandle;
}

/** True iff this device *could* run Apple FoundationModels (iOS 18+). */
export function isFoundationModelsCapable(): boolean {
  if (Platform.OS !== 'ios') return false;
  // Platform.Version on iOS is a string like "18.1"; on Android it's a number.
  const v = parseInt(String(Platform.Version), 10);
  return Number.isFinite(v) && v >= 18;
}

/** Live availability - capability AND the native module is linked AND the OS reports the model is ready. */
export async function isFoundationModelsAvailable(): Promise<boolean> {
  if (!isFoundationModelsCapable()) return false;
  const h = tryLoadFoundationModule();
  if (!h) return false;
  try { return await h.module.isAvailable(); } catch { return false; }
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
    const h = tryLoadFoundationModule();
    if (!h) throw new Error('Apple FoundationModels native module is not linked');

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

    // Generate a unique requestId so concurrent streams don't crosstalk.
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sub = h.emitter.addListener('FoundationLLMOnToken', (e: { requestId: string; delta: string }) => {
      if (e.requestId === requestId && e.delta) push({ kind: 'delta', delta: e.delta });
    });

    h.module.complete({
      requestId,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
    }).then(
      (usage) => push({ kind: 'done', usage }),
      (err: Error) => push({ kind: 'error', error: err }),
    );

    try {
      while (true) {
        const item = await next();
        if (item.kind === 'error') throw item.error;
        if (item.kind === 'delta') yield { delta: item.delta };
        if (item.kind === 'done') {
          yield { delta: '', done: true, usage: item.usage };
          return;
        }
      }
    } finally {
      sub.remove();
    }
  }
}
