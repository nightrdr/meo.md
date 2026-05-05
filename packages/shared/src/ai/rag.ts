// RAG orchestrator: query → embed → retrieve → build prompt → stream.
// One function, two modes: 'ask' (single-shot) and 'chat' (multi-turn).

import type {
  Embedder, VectorStore, Generator, GenerateChunk, ChatMessage, RetrievedChunk,
} from './types.js';
import type { Note } from '../types.js';
import type { Bm25Index } from './bm25.js';
import { hybridRetrieve } from './retrieval.js';
import { NOTE_TOOLS_SYSTEM_PROMPT } from './note-tools.js';

export type RagMode = 'ask' | 'chat';

export interface RagAskArgs {
  query: string;
  mode: RagMode;
  history?: ChatMessage[];                   // chat mode only
  embedder: Embedder;
  vectorStore: VectorStore;
  bm25: Bm25Index;
  notes: Map<string, Note>;
  generator: Generator;
  modelId: string;
  signal?: AbortSignal;
  /**
   * If true (chat mode only), append the note-mutation tool prompt
   * so the model can propose CRUD via the meo-actions JSON fence.
   * Defaults to true when mode === 'chat'. Pass false to opt-out
   * (e.g. for kiosks that should be strictly read-only).
   */
  enableNoteTools?: boolean;
  /**
   * Note IDs the user has already touched in this conversation —
   * created, updated, or cited in prior assistant turns. Forced into
   * CONTEXT regardless of the current query's retrieval score so
   * "update that note" type follow-ups have a target id to refer to.
   * The IDs are also returned to the caller via the result so they
   * can be unioned into parseNoteToolCalls' `knownNoteIds`.
   */
  pinnedNoteIds?: Iterable<string>;
}

export interface RagAskResult {
  /** Streamed deltas of the answer text. */
  stream: AsyncIterable<GenerateChunk>;
  /** Notes the LLM saw as context, in retrieval order. */
  context: RetrievedChunk[];
}

const SYSTEM_PROMPT_ASK = `You are Meo, the user's personal assistant for their own notes.
- Answer questions using the provided context whenever relevant. If the notes don't contain the answer, say so.
- When the user asks you to create, update, or delete a note, do it via the meo-actions JSON block (described below). Do NOT describe yourself or your capabilities; act on the request.
- Cite sources inline as [note:<id>] using the ids in the context. Don't invent ids.
- Prefer concise answers (2-4 sentences) unless the user asks for detail.
- Match the user's tone. The user writes in plain prose, not bullet points, unless they're a list.`;

const SYSTEM_PROMPT_CHAT = `You are Meo, the user's personal assistant grounded in their own notes.
- Use the provided context whenever relevant. Don't make things up.
- When the user asks you to create, update, or delete a note, do it via the meo-actions JSON block (described below). Don't describe yourself; act on the request.
- Cite sources inline as [note:<id>] using the ids in the context.
- Keep replies conversational and brief unless asked for depth.`;

export async function ragAsk(args: RagAskArgs): Promise<RagAskResult> {
  const retrieved = await hybridRetrieve({
    query: args.query,
    embedder: args.embedder,
    vectorStore: args.vectorStore,
    bm25: args.bm25,
    notes: args.notes,
    options: { k: 8 },
  });

  // Union pinned IDs (recent tool-call targets, prior citations) into
  // the context. A pinned ID that's already in `retrieved` is left
  // alone — duplicates would just confuse the model. A pinned ID that
  // ISN'T in retrieved gets a synthesized chunk built from the
  // in-memory note (title + first ~600 chars of body) so the model
  // sees enough to refer back to it via [note:<id>]. Without this, a
  // follow-up like "update the note you just created" can't resolve
  // because the new note wasn't retrieved by semantic search yet.
  const context: RetrievedChunk[] = [...retrieved];
  if (args.pinnedNoteIds) {
    const seen = new Set(context.map(c => c.noteId));
    for (const id of args.pinnedNoteIds) {
      if (seen.has(id)) continue;
      const n = args.notes.get(id);
      if (!n) continue;
      const snippet = (n.body ?? '').slice(0, 600);
      context.push({
        noteId: id,
        title: n.title ?? 'Untitled',
        snippet,
        score: 0,           // synthesized; ranking is not used past this point
      });
      seen.add(id);
    }
  }

  // Both Ask and Chat opt into note-mutation tools by default. The
  // user always sees a confirmation chip before any mutation lands,
  // so it's safe to expose the convention to the model in both modes.
  // (Kiosks that need strictly-read-only can pass enableNoteTools=false.)
  const enableTools = args.enableNoteTools ?? true;

  const sysPrompt = args.mode === 'ask' ? SYSTEM_PROMPT_ASK : SYSTEM_PROMPT_CHAT;
  const finalSys = enableTools ? `${sysPrompt}\n\n${NOTE_TOOLS_SYSTEM_PROMPT}` : sysPrompt;

  const messages: ChatMessage[] = [
    { role: 'system', content: finalSys },
  ];
  if (args.mode === 'chat' && args.history) {
    messages.push(...args.history);
  }
  messages.push({
    role: 'system',
    content: buildContextBlock(context),
  });
  messages.push({ role: 'user', content: args.query });

  return {
    stream: args.generator.stream({
      model: args.modelId,
      messages,
      maxTokens: 512,
      temperature: args.mode === 'ask' ? 0.3 : 0.6,
      signal: args.signal,
    }),
    context,
  };
}

function buildContextBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return 'CONTEXT: (none - no relevant notes were retrieved.)';
  }
  const blocks = chunks.map(c => `[note:${c.noteId}] ${c.title}\n${c.snippet}`);
  return `CONTEXT:\n\n${blocks.join('\n\n---\n\n')}`;
}

/**
 * Parse [note:<id>] tags out of streamed assistant text. Used by the UI
 * to replace tags with citation chips that link back to the source.
 */
export function extractCitations(text: string): { clean: string; ids: string[] } {
  const ids: string[] = [];
  const seen = new Set<string>();
  const clean = text.replace(/\[note:([a-f0-9-]+)\]/gi, (_m, id) => {
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
    return `[${ids.indexOf(id) + 1}]`;
  });
  return { clean, ids };
}
