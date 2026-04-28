// Static portion of the model registry. Cloud + system-os entries plus
// known local-gguf models. The runtime merges this with dynamic
// discovery (Ollama on desktop, downloaded files on mobile).

import type { Model } from './types';

/**
 * Local GGUF models we surface in the catalogue. The list is curated;
 * users can always run any model Ollama serves on desktop, but these
 * are the ones the UI proactively offers to install.
 */
export const LOCAL_GGUF_CATALOGUE: Model[] = [
  {
    id: 'qwen2.5-1.5b-q4',
    name: 'Qwen 2.5 1.5B',
    kind: 'local-gguf',
    tag: 'Fast, on-device',
    size: '1.1 GB',
    default: true,
  },
  {
    id: 'llama3.1-8b-q4',
    name: 'Llama 3.1 8B',
    kind: 'local-gguf',
    tag: 'Balanced',
    size: '4.7 GB',
  },
  {
    id: 'qwen2.5-7b-q4',
    name: 'Qwen 2.5 7B',
    kind: 'local-gguf',
    tag: 'Long context',
    size: '4.4 GB',
  },
  {
    id: 'mistral-7b-q4',
    name: 'Mistral 7B',
    kind: 'local-gguf',
    tag: 'Reasoning',
    size: '4.1 GB',
  },
  {
    id: 'phi3.5-mini-q4',
    name: 'Phi-3.5 Mini',
    kind: 'local-gguf',
    tag: 'Lightweight',
    size: '2.3 GB',
  },
  {
    id: 'gemma2-9b-q4',
    name: 'Gemma 2 9B',
    kind: 'local-gguf',
    tag: 'High quality',
    size: '5.4 GB',
  },
];

/**
 * Apple FoundationModels and Gemini Nano. Marked system-os so the UI
 * shows them with a "0 MB" badge. Runtime gates by Platform.OS +
 * version + a feature-detection probe.
 */
export const SYSTEM_OS_CATALOGUE: Model[] = [
  {
    id: 'apple-foundation',
    name: 'Apple Intelligence',
    kind: 'system-os',
    tag: 'iOS 18+, free, no download',
  },
  {
    id: 'gemini-nano',
    name: 'Gemini Nano',
    kind: 'system-os',
    tag: 'Pixel 8+, Galaxy S24+, no download',
  },
];

/**
 * Cloud frontier models. v1.0 hides these behind a tier flag; the
 * catalogue lives here so the cut-over for v1.1 is mechanical.
 */
export const CLOUD_CATALOGUE: Model[] = [
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', vendor: 'Anthropic',  kind: 'cloud', tag: 'Frontier' },
  { id: 'gpt-4o',            name: 'GPT-4o',             vendor: 'OpenAI',    kind: 'cloud', tag: 'Frontier' },
  { id: 'gemini-2.5-pro',    name: 'Gemini 2.5 Pro',     vendor: 'Google',    kind: 'cloud', tag: 'Frontier' },
  { id: 'grok-4',            name: 'Grok 4',             vendor: 'xAI',       kind: 'cloud', tag: 'Frontier' },
];

/** All models that should be shown in v1.0 (local + system-os only). */
export function v1Catalogue(): Model[] {
  return [...LOCAL_GGUF_CATALOGUE, ...SYSTEM_OS_CATALOGUE];
}

/** Full catalogue including cloud (v1.1). */
export function fullCatalogue(): Model[] {
  return [...LOCAL_GGUF_CATALOGUE, ...SYSTEM_OS_CATALOGUE, ...CLOUD_CATALOGUE];
}

/** Per-platform default model id. */
export function defaultModelId(platform: 'desktop' | 'ios' | 'ios18+' | 'android' | 'android-nano'): string {
  switch (platform) {
    case 'desktop':       return 'qwen2.5-1.5b-q4';   // first Ollama model preferred at runtime
    case 'ios18+':        return 'apple-foundation';
    case 'android-nano':  return 'gemini-nano';
    case 'ios':
    case 'android':       return 'qwen2.5-1.5b-q4';
  }
}
