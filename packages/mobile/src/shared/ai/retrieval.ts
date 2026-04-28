// Hybrid retrieval: BM25 + vector + reciprocal rank fusion + MMR.
// Used by the AI panel only (per spec §7.5).
//
// Flow:
//   1. Embed query (in caller).
//   2. Run BM25 over decrypted notes (top perRetrieverK).
//   3. Run vector search over indexed embeddings (top perRetrieverK).
//   4. Reciprocal rank fusion to merge.
//   5. MMR rerank for diversity (avoids near-duplicates dominating).
//   6. Build snippets per note (best 3 sentences vs query).

import type { Note } from '../types';
import type {
  Embedder, VectorStore, RetrievedChunk, RetrievalOptions,
} from './types';
import { formatNoteForEmbedding } from './types';
import { Bm25Index } from './bm25';
import { cosineNormalized } from './vec-math';

interface RetrieveArgs {
  query: string;
  embedder: Embedder;
  vectorStore: VectorStore;
  bm25: Bm25Index;
  notes: Map<string, Note>;       // for snippet building
  options?: RetrievalOptions;
}

const RRF_K = 60;        // standard constant from the RRF paper
const DEFAULT_K = 8;
const DEFAULT_PER_K = 16;
const DEFAULT_LAMBDA = 0.5;

export async function hybridRetrieve(args: RetrieveArgs): Promise<RetrievedChunk[]> {
  const k = args.options?.k ?? DEFAULT_K;
  const perK = args.options?.perRetrieverK ?? DEFAULT_PER_K;
  const lambda = args.options?.mmrLambda ?? DEFAULT_LAMBDA;

  // 1. Embed the query
  const qvec = await args.embedder.embed(args.query);

  // 2. BM25
  const bmHits = args.bm25.search(args.query, perK);

  // 3. Vector
  const vecHits = await args.vectorStore.search(qvec, perK);

  // 4. RRF merge
  const fused = reciprocalRankFusion(
    [bmHits.map(h => h.noteId), vecHits.map(h => h.noteId)],
    RRF_K,
  );

  // 5. MMR rerank (uses the query vector and the candidates' vectors)
  const candidateVecs: { noteId: string; vec: Float32Array }[] = [];
  for (const noteId of fused) {
    // Pull vector from the store's iteration interface; re-embed only if missing.
    let vec: Float32Array | null = null;
    if ((args.vectorStore as any).hashFor) {
      // Use the in-memory engine's iterator if available
      const eng: any = args.vectorStore as any;
      if (eng.all) {
        for (const e of eng.all()) {
          if (e.noteId === noteId) { vec = e.vec; break; }
        }
      }
    }
    if (!vec) {
      // Fallback: re-embed the note's content. Rare path.
      const n = args.notes.get(noteId);
      if (!n) continue;
      vec = await args.embedder.embed(formatNoteForEmbedding(n));
    }
    candidateVecs.push({ noteId, vec });
  }
  const mmrPicked = mmrSelect(qvec, candidateVecs, k, lambda);

  // 6. Snippets
  const out: RetrievedChunk[] = [];
  for (const { noteId, score } of mmrPicked) {
    const note = args.notes.get(noteId);
    if (!note) continue;
    const snippet = await topSentences(note, args.query, args.embedder, 3);
    out.push({
      noteId,
      title: note.title || 'Untitled',
      snippet,
      score,
    });
  }
  return out;
}

// ─── Reciprocal Rank Fusion ──────────────────────────────────────────

/**
 * Merge multiple ranked lists. Score = Σ 1 / (k + rank).
 * Returns the doc ids in fused order.
 */
export function reciprocalRankFusion(rankings: string[][], k = RRF_K): string[] {
  const scores = new Map<string, number>();
  for (const list of rankings) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

// ─── Maximal Marginal Relevance ──────────────────────────────────────

interface MmrPicked { noteId: string; score: number; }

function mmrSelect(
  query: Float32Array,
  candidates: { noteId: string; vec: Float32Array }[],
  k: number,
  lambda: number,
): MmrPicked[] {
  const remaining = candidates.slice();
  const picked: MmrPicked[] = [];

  while (picked.length < k && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const relevance = cosineNormalized(query, c.vec);
      // Penalty: max similarity to anything already picked
      let maxSim = 0;
      for (const p of picked) {
        const pVec = candidates.find(cv => cv.noteId === p.noteId)!.vec;
        const sim = cosineNormalized(c.vec, pVec);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const winner = remaining.splice(bestIdx, 1)[0];
    picked.push({ noteId: winner.noteId, score: bestScore });
  }
  return picked;
}

// ─── Snippet builder ─────────────────────────────────────────────────

async function topSentences(
  note: Note,
  query: string,
  embedder: Embedder,
  count: number,
): Promise<string> {
  const sentences = splitSentences(note.body);
  if (sentences.length === 0) return note.title || '';
  if (sentences.length <= count) return sentences.join(' ');

  const qvec = await embedder.embed(query);
  const scored: { idx: number; sent: string; score: number }[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const v = await embedder.embed(sentences[i]);
    scored.push({ idx: i, sent: sentences[i], score: cosineNormalized(qvec, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, count).sort((a, b) => a.idx - b.idx); // restore order
  // Insert "…" between non-contiguous sentences
  const out: string[] = [];
  for (let i = 0; i < top.length; i++) {
    out.push(top[i].sent);
    if (i < top.length - 1 && top[i + 1].idx > top[i].idx + 1) out.push('…');
  }
  return out.join(' ');
}

function splitSentences(text: string): string[] {
  if (!text) return [];
  // Cap each sentence at 200 chars to keep prompts bounded.
  const split = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z])/);
  return split
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.length > 200 ? s.slice(0, 197) + '…' : s);
}
