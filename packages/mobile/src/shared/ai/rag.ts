// RAG orchestrator: query → embed → retrieve → build prompt → stream.
// One function, two modes: 'ask' (single-shot) and 'chat' (multi-turn).

import type {
  Embedder, VectorStore, Generator, GenerateChunk, ChatMessage, RetrievedChunk,
} from './types';
import type { Note } from '../types';
import type { Bm25Index } from './bm25';
import { hybridRetrieve } from './retrieval';

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
}

export interface RagAskResult {
  /** Streamed deltas of the answer text. */
  stream: AsyncIterable<GenerateChunk>;
  /** Notes the LLM saw as context, in retrieval order. */
  context: RetrievedChunk[];
}

const SYSTEM_PROMPT_ASK = `You are Meo, an assistant that answers questions strictly using the user's own notes.
- Only state things the notes support. If the notes don't contain the answer, say so.
- Cite sources inline as [note:<id>] using the ids in the context. Don't invent ids.
- Prefer concise answers (2–4 sentences) unless the user asks for detail.
- Match the user's tone. The user writes in plain prose, not bullet points, unless they're a list.`;

const SYSTEM_PROMPT_CHAT = `You are Meo, the user's personal assistant grounded in their own notes.
- Use the provided context whenever relevant. Don't make things up.
- Cite sources inline as [note:<id>] using the ids in the context.
- Keep replies conversational and brief unless asked for depth.`;

export async function ragAsk(args: RagAskArgs): Promise<RagAskResult> {
  const context = await hybridRetrieve({
    query: args.query,
    embedder: args.embedder,
    vectorStore: args.vectorStore,
    bm25: args.bm25,
    notes: args.notes,
    options: { k: 8 },
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: args.mode === 'ask' ? SYSTEM_PROMPT_ASK : SYSTEM_PROMPT_CHAT },
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
