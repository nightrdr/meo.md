// Ollama generator backend. Talks to a local Ollama daemon over HTTP.
// We do NOT bundle Ollama; we detect it and surface an "Install Ollama"
// CTA when it's not running.
//
// Daemon defaults:
//   Endpoint: http://localhost:11434
//   API:      /api/tags    (list models)
//             /api/chat    (streaming chat completion)

import type { Generator, Model, GenerateOptions, GenerateChunk } from '../types.js';

const DEFAULT_ENDPOINT = 'http://localhost:11434';

export class OllamaBackend implements Generator {
  readonly id = 'ollama';
  constructor(private endpoint: string = DEFAULT_ENDPOINT) {}

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(800),  // fail fast
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<Model[]> {
    try {
      const res = await fetch(`${this.endpoint}/api/tags`);
      if (!res.ok) return [];
      const data = await res.json() as { models?: { name: string; size?: number; details?: { parameter_size?: string; family?: string } }[] };
      return (data.models ?? []).map(m => ({
        id: m.name,
        name: m.name,
        kind: 'local-gguf' as const,
        installed: true,
        tag: m.details?.parameter_size
          ? `${m.details.parameter_size}${m.details.family ? ', ' + m.details.family : ''}`
          : 'Local',
        size: m.size ? humanBytes(m.size) : undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Pull a model from Ollama's registry. Streams progress events.
   * Caller subscribes for status updates.
   */
  async *pull(modelId: string): AsyncIterable<{ status: string; completed?: number; total?: number }> {
    const res = await fetch(`${this.endpoint}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: modelId, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`pull failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { yield JSON.parse(line); } catch { /* skip malformed */ }
      }
    }
  }

  async *stream(opts: GenerateOptions): AsyncIterable<GenerateChunk> {
    const res = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        options: {
          temperature: opts.temperature ?? 0.7,
          num_predict: opts.maxTokens ?? 512,
        },
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama chat failed: ${res.status} ${body}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let frame: any;
        try { frame = JSON.parse(line); } catch { continue; }
        const delta = frame?.message?.content ?? '';
        const last = !!frame?.done;
        if (last) {
          promptTokens = frame?.prompt_eval_count ?? promptTokens;
          completionTokens = frame?.eval_count ?? completionTokens;
        }
        if (delta || last) {
          yield {
            delta,
            done: last,
            usage: last ? { promptTokens, completionTokens } : undefined,
          };
        }
        if (last) return;
      }
    }
  }
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
