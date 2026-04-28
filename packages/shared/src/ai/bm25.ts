// Pure-JS BM25 ranker. Builds an in-memory index over decrypted note
// content and ranks documents per query. ~80 lines, no dependencies.
//
// Used by the AI panel's hybrid retrieval. NOT used by ⌘K nav (which
// stays a substring matcher per spec §7.5).

import { formatNoteForEmbedding } from './types.js';
import type { Note } from '../types.js';

interface Doc {
  id: string;
  /** Token frequencies. */
  tf: Map<string, number>;
  /** Document length in tokens. */
  len: number;
}

export class Bm25Index {
  private docs: Doc[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;
  // Tunable BM25 parameters; defaults match the original Robertson paper.
  constructor(private k1 = 1.5, private b = 0.75) {}

  add(note: Note): void {
    // Same input as the embedder: title + tags + folder + body.
    const text = formatNoteForEmbedding(note);
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.push({ id: note.id, tf, len: tokens.length });
    for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
    this.recomputeAvgLen();
  }

  remove(noteId: string): void {
    const idx = this.docs.findIndex(d => d.id === noteId);
    if (idx < 0) return;
    const [doc] = this.docs.splice(idx, 1);
    for (const term of doc.tf.keys()) {
      const c = this.df.get(term) ?? 0;
      if (c <= 1) this.df.delete(term);
      else this.df.set(term, c - 1);
    }
    this.recomputeAvgLen();
  }

  upsert(note: Note): void {
    this.remove(note.id);
    this.add(note);
  }

  rebuild(notes: Note[]): void {
    this.docs = [];
    this.df.clear();
    for (const n of notes) this.add(n);
  }

  /** BM25 score (descending). Returns up to k matches. */
  search(query: string, k: number): { noteId: string; score: number }[] {
    const tokens = tokenize(query);
    const N = this.docs.length;
    if (N === 0 || tokens.length === 0) return [];

    const scores = new Map<string, number>();
    for (const term of tokens) {
      const df = this.df.get(term);
      if (!df) continue;
      // BM25 IDF (smoothed). Always positive thanks to the +1.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const doc of this.docs) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        const norm = tf * (this.k1 + 1) /
          (tf + this.k1 * (1 - this.b + this.b * doc.len / (this.avgLen || 1)));
        scores.set(doc.id, (scores.get(doc.id) ?? 0) + idf * norm);
      }
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([noteId, score]) => ({ noteId, score }));
  }

  size(): number { return this.docs.length; }

  private recomputeAvgLen(): void {
    if (this.docs.length === 0) { this.avgLen = 0; return; }
    let total = 0;
    for (const d of this.docs) total += d.len;
    this.avgLen = total / this.docs.length;
  }
}

/**
 * Cheap tokenizer: lowercase, keep alphanumerics + simple punctuation
 * stripped to words. No stemming; English-only assumption is fine for
 * v1, and BM25 doesn't need a stemmer to be useful. We do a tiny
 * stop-word list to cut the most over-represented junk.
 */
const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'has', 'have', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my',
  'of', 'on', 'or', 'so', 'than', 'that', 'the', 'their', 'them', 'they',
  'this', 'to', 'was', 'were', 'will', 'with', 'you', 'your',
]);

function tokenize(text: string): string[] {
  const out: string[] = [];
  // Split on non-word boundaries; keep `#` so tags survive ("#research"
  // tokenizes to "research" but a leading "#" is dropped — tags appear
  // in the input twice anyway via the `tags:` line).
  for (const tok of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (!tok) continue;
    if (tok.length === 1) continue;
    if (STOP.has(tok)) continue;
    out.push(tok);
  }
  return out;
}
