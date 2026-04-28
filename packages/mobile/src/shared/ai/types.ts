// Public types for the AI subsystem. See specs/05-llm-architecture.md.

import type { Note } from '../types';

// ─── Models ────────────────────────────────────────────────────────────

export type ModelKind = 'local-gguf' | 'system-os' | 'cloud';

export interface Model {
  id: string;
  name: string;
  kind: ModelKind;
  tag: string;                  // UI subtitle, e.g. "Fast, on-device"
  size?: string;                // human-readable, e.g. "1.1 GB" — local-gguf only
  vendor?: string;              // cloud-only, e.g. "OpenAI"
  installed?: boolean;          // local-gguf only — runtime-resolved
  default?: boolean;            // marks the recommended default per platform
}

// ─── Embedder ──────────────────────────────────────────────────────────

export interface Embedder {
  /** Lower-cased model id, e.g. "bge-small-en-v1.5". */
  readonly id: string;

  /** Output dimensionality (e.g. 384). */
  readonly dim: number;

  /** Embed a single string. Returns a normalized 1-D vector. */
  embed(text: string): Promise<Float32Array>;

  /**
   * Embed a batch. Default implementation calls embed() in a loop;
   * native runtimes may override for SIMD speedups.
   */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

// ─── Vector store ──────────────────────────────────────────────────────

export interface VectorStore {
  /** Insert or update a note's embedding. */
  upsert(noteId: string, vector: Float32Array, meta?: VectorMeta): Promise<void>;

  /** Remove an embedding (note deleted). */
  remove(noteId: string): Promise<void>;

  /** Cosine similarity search. Returns top-k by similarity, descending. */
  search(query: Float32Array, k: number): Promise<SearchHit[]>;

  /** Total number of indexed vectors. */
  count(): Promise<number>;

  /** Drop all vectors. */
  clear(): Promise<void>;
}

export interface VectorMeta {
  /**
   * Hash of the embedded text. Used to skip re-embedding unchanged notes.
   * sha256(title + "\0" + body + "\0" + tags + "\0" + folder)
   */
  vec_hash: string;

  /** Embedder id at the time of embedding (for migration detection). */
  embedder_id: string;
}

export interface SearchHit {
  noteId: string;
  score: number;          // [0, 1] cosine similarity
}

// ─── Retrieval ─────────────────────────────────────────────────────────

export interface RetrievedChunk {
  noteId: string;
  title: string;
  snippet: string;
  score: number;          // post-fusion relevance score
}

export interface RetrievalOptions {
  /** Total candidates to surface after fusion + diversity. Default 8. */
  k?: number;
  /** MMR λ (0 = max diversity, 1 = max relevance). Default 0.5. */
  mmrLambda?: number;
  /** Per-retriever k before fusion. Default 16. */
  perRetrieverK?: number;
}

// ─── Generator ─────────────────────────────────────────────────────────

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenerateOptions {
  model: string;
  messages: ChatMessage[];
  /** Max tokens to generate. Default 512. */
  maxTokens?: number;
  /** 0..2. Default 0.7. */
  temperature?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface GenerateChunk {
  /** A streamed delta of generated text. */
  delta: string;
  /** Final-frame data, if any. */
  done?: boolean;
  /** Token counts when the stream finishes. */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface Generator {
  readonly id: string;

  /** Probe the backend. Returns true if available right now. */
  isAvailable(): Promise<boolean>;

  /** List models reachable through this backend, runtime-resolved. */
  listModels(): Promise<Model[]>;

  /** Stream a chat completion. */
  stream(opts: GenerateOptions): AsyncIterable<GenerateChunk>;
}

// ─── Embedding-input formatter ─────────────────────────────────────────

/**
 * Per spec §17.1: embeddings include title, body, tags, folder. This is
 * the canonical input format. Any change here must bump
 * EMBEDDING_INPUT_VERSION below to force re-embed on rollout.
 */
export const EMBEDDING_INPUT_VERSION = 1;

export function formatNoteForEmbedding(note: Note): string {
  const parts: string[] = [];
  if (note.title.trim()) parts.push(note.title.trim());
  if (note.tags.length) parts.push('tags: ' + note.tags.map(t => `#${t}`).join(', '));
  if (note.folder.length) parts.push('folder: ' + note.folder.join('/'));
  if (note.body.trim()) {
    parts.push('');         // blank line between meta and body
    parts.push(note.body.trim());
  }
  return parts.join('\n');
}

/**
 * Stable hash for change-detection. Re-embed when this changes.
 * Uses @noble/hashes for SHA-256 — portable across browser, Node, and
 * RN (which doesn't ship crypto.subtle on Hermes).
 */
import { sha256 } from '@noble/hashes/sha256';

export async function noteVecHash(note: Note): Promise<string> {
  const input = `${note.title}\0${note.body}\0${note.tags.join(',')}\0${note.folder.join('/')}\0v${EMBEDDING_INPUT_VERSION}`;
  const bytes = new TextEncoder().encode(input);
  const out = sha256(bytes);
  return Array.from(out).map(b => b.toString(16).padStart(2, '0')).join('');
}
