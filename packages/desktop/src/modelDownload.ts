// Client for the Agent 7 model-download backend service.
//
// Public API:
//   - fetchManifest(): GET /models/manifest, returns the parsed list.
//   - downloadModel(id, onProgress): streams /models/:id/file with
//     a ReadableStream so we can report progress, then persists the
//     full blob in the IndexedDB 'model_files' store.
//
// Note: desktop currently uses Ollama for LLM inference; this helper
// exists so embedder GGUFs (bge-small) and any future
// bring-your-own-GGUF flow share one path with the backend service.

import { apiBaseUrl } from './session';
import { getModelFile, putModelFile, type CachedModelFile } from './storage';

/** Mirrors backend/internal/models/ManifestEntry. */
export type ModelKind = 'local-llm' | 'cloud-llm' | 'embedder';

export interface ManifestEntry {
  id: string;
  name: string;
  /** local-llm = downloadable GGUF; cloud-llm = BYO API key; embedder = downloadable ONNX */
  kind: ModelKind;
  family: string;
  /** cloud-llm only: OpenAI / Anthropic / Google / xAI */
  vendor?: string;
  params: string;
  /** null for cloud-llm */
  quant: string | null;
  size_bytes: number;
  sha256: string | null;
  /** absolute URL filled in by the server. null for cloud-llm. */
  download_url: string | null;
  default_for: ('mobile' | 'desktop')[];
  /** short UI label e.g. "Fast, on-device" */
  tag?: string;
}

export interface DownloadProgress {
  /** Bytes received so far. */
  loaded: number;
  /** Total bytes per Content-Length, or `null` if the server didn't send one. */
  total: number | null;
  /** Convenience: 0..1 or null if total unknown. */
  fraction: number | null;
}

/**
 * Fetch the manifest from the backend. Returns an empty array on any
 * non-2xx so callers can render a soft "no models available" state
 * instead of crashing.
 */
export async function fetchManifest(): Promise<ManifestEntry[]> {
  const res = await fetch(joinUrl(apiBaseUrl, '/models/manifest'));
  if (!res.ok) return [];
  const body = await res.json();
  return Array.isArray(body?.models) ? body.models as ManifestEntry[] : [];
}

/**
 * Download a model file with progress reporting. Resolves to the
 * cached row. If the file is already in IndexedDB, we short-circuit
 * and return the existing row (with `loaded === total === blob.size`
 * fired on `onProgress` once for UI parity).
 */
export async function downloadModel(
  entry: ManifestEntry,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<CachedModelFile> {
  const existing = await getModelFile(entry.id);
  if (existing) {
    onProgress?.({
      loaded: existing.size_bytes,
      total: existing.size_bytes,
      fraction: 1,
    });
    return existing;
  }

  const url = entry.download_url ?? joinUrl(apiBaseUrl, `/models/${entry.id}/file`);
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch { /* non-JSON body */ }
    throw new Error(`download ${entry.id}: ${res.status}${detail ? ` - ${detail}` : ''}`);
  }
  if (!res.body) throw new Error(`download ${entry.id}: response has no body`);

  const totalHeader = res.headers.get('Content-Length');
  const total = totalHeader ? parseInt(totalHeader, 10) : null;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.({
        loaded,
        total,
        fraction: total ? loaded / total : null,
      });
    }
  }

  const blob = new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
  const row: CachedModelFile = {
    id: entry.id,
    blob,
    size_bytes: blob.size,
    sha256: entry.sha256 ?? undefined,
    cached_at: new Date().toISOString(),
  };
  await putModelFile(row);
  return row;
}

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1);
  if (!base.endsWith('/') && !path.startsWith('/')) return `${base}/${path}`;
  return base + path;
}
