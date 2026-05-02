// Note-mutation tools for Ask Meo.
//
// We don't use Ollama's native function-calling because (a) it's
// model-dependent (only newer Llama / Qwen / Mistral tunes support
// it via the `tools` parameter), (b) we want the same code path to
// work against future cloud models with their own function-calling
// shapes, and (c) any tool call MUST go through user confirmation
// anyway - we're not running silent CRUD against the user's notes.
//
// So we use a model-agnostic convention: instruct the assistant to
// emit a fenced JSON block at the END of its message when it wants
// to create/update/delete notes. The UI strips the block from the
// rendered message and surfaces each action as a confirmation chip.
// The user clicks Apply on each one to actually mutate the note.

import type { Note } from '../types.js';

/** A proposed note mutation parsed from an assistant message. */
export type NoteToolCall =
  | {
      type: 'create';
      title: string;
      body: string;
      folder?: string[];
      tags?: string[];
    }
  | {
      type: 'update';
      id: string;
      title?: string;
      body?: string;
      folder?: string[];
      tags?: string[];
    }
  | {
      type: 'delete';
      id: string;
    };

/**
 * Cap on the number of mutations the model can request in one turn.
 * Anything beyond is ignored - prevents a runaway "delete all notes"
 * if the model misunderstands ambient context.
 */
export const MAX_TOOL_CALLS_PER_TURN = 5;

/**
 * The system-prompt fragment we append in chat mode. It documents the
 * JSON convention to the model and emphasizes (twice, by design) that
 * silent mutations aren't possible: every action goes through user
 * confirmation. That's not ceremony - knowing the user has to click
 * Apply makes the model less reluctant to PROPOSE actions, which is
 * the whole point.
 */
export const NOTE_TOOLS_SYSTEM_PROMPT = `
You can propose changes to the user's notes. The user reviews each
proposal before it's applied; you cannot silently mutate anything.

When the user's request implies creating, updating, or deleting a
note, append a fenced JSON block AT THE VERY END of your reply with
the actions you'd like to take. The block format:

\`\`\`meo-actions
{
  "actions": [
    { "type": "create", "title": "...", "body": "...", "folder": ["work","Q1"], "tags": ["draft"] },
    { "type": "update", "id": "<note-id-from-context>", "body": "new body..." },
    { "type": "delete", "id": "<note-id-from-context>" }
  ]
}
\`\`\`

Rules:
- Only emit the block when you actually want to mutate notes. For
  pure questions, omit it entirely.
- "create": title and body required; folder and tags optional. Use
  body as full Markdown.
- "update": id is mandatory and MUST be a real note id from the
  current CONTEXT block. Any of body / title / folder / tags can
  appear; whatever you omit stays unchanged.
- "delete": id is mandatory and MUST be a real note id from CONTEXT.
- At most ${MAX_TOOL_CALLS_PER_TURN} actions per turn.
- The natural-language part of your reply should still answer the
  user's question or describe what you're proposing.
- NEVER refuse a mutation by describing yourself or your role. Just
  emit the action; the user will confirm before it lands.

Example. User: "create a note titled 'Grocery list' with milk, eggs, bread".
Reply:

I'll create that note for you.

\`\`\`meo-actions
{ "actions": [ { "type": "create", "title": "Grocery list", "body": "- milk\\n- eggs\\n- bread" } ] }
\`\`\`
`.trim();

/** Regex anchors for the meo-actions fence. Tolerant to surrounding
 *  whitespace and to the trailing newline being absent. */
const FENCE_RE = /```meo-actions\s*\n([\s\S]*?)\n?```/i;

/**
 * Parse an assistant message into:
 *   - `clean`: the message text with the meo-actions block stripped
 *   - `actions`: the parsed list of proposed mutations
 *
 * Tolerates malformed JSON: returns no actions if the block can't
 * be parsed (and leaves the original text alone). Capping at
 * MAX_TOOL_CALLS_PER_TURN.
 */
export function parseNoteToolCalls(
  message: string,
  knownNoteIds: Set<string> = new Set(),
): { clean: string; actions: NoteToolCall[] } {
  const m = FENCE_RE.exec(message);
  if (!m) return { clean: message, actions: [] };
  let parsed: any;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return { clean: message, actions: [] };
  }
  const raw: any[] = Array.isArray(parsed?.actions) ? parsed.actions : [];
  const actions: NoteToolCall[] = [];
  for (const a of raw.slice(0, MAX_TOOL_CALLS_PER_TURN)) {
    if (!a || typeof a.type !== 'string') continue;
    if (a.type === 'create') {
      if (typeof a.title !== 'string' || typeof a.body !== 'string') continue;
      const folder = Array.isArray(a.folder) ? a.folder.filter((x: any) => typeof x === 'string') : undefined;
      const tags = Array.isArray(a.tags) ? a.tags.filter((x: any) => typeof x === 'string') : undefined;
      actions.push({ type: 'create', title: a.title, body: a.body, folder, tags });
    } else if (a.type === 'update') {
      if (typeof a.id !== 'string') continue;
      // Don't allow updating a note id that wasn't in the LLM's
      // context block - prevents the model hallucinating a uuid.
      if (knownNoteIds.size > 0 && !knownNoteIds.has(a.id)) continue;
      const out: NoteToolCall = { type: 'update', id: a.id };
      if (typeof a.title === 'string') out.title = a.title;
      if (typeof a.body === 'string') out.body = a.body;
      if (Array.isArray(a.folder)) out.folder = a.folder.filter((x: any) => typeof x === 'string');
      if (Array.isArray(a.tags)) out.tags = a.tags.filter((x: any) => typeof x === 'string');
      actions.push(out);
    } else if (a.type === 'delete') {
      if (typeof a.id !== 'string') continue;
      if (knownNoteIds.size > 0 && !knownNoteIds.has(a.id)) continue;
      actions.push({ type: 'delete', id: a.id });
    }
  }
  // Strip the fence from the visible text. Leave a single blank
  // line where it was so paragraphs above don't run into anything
  // we render below.
  const clean = message.replace(FENCE_RE, '').trimEnd();
  return { clean, actions };
}

/**
 * Apply a confirmed action against the in-memory session. The caller
 * supplies plain CRUD callbacks (typically thin wrappers around
 * `saveNote` / `deleteNote` from session.ts) so this module stays
 * independent of any particular session shape.
 */
export interface NoteToolApplyContext {
  notes: Map<string, Note>;
  newDraft: () => Note;
  saveNote: (n: Note) => Promise<Note>;
  deleteNote: (id: string) => Promise<void>;
}

export async function applyNoteToolCall(
  call: NoteToolCall,
  ctx: NoteToolApplyContext,
): Promise<{ ok: true; resultId: string | null } | { ok: false; error: string }> {
  try {
    switch (call.type) {
      case 'create': {
        const draft = ctx.newDraft();
        const next: Note = {
          ...draft,
          title: call.title,
          body: call.body,
          folder: call.folder ?? [],
          tags: call.tags ?? [],
        };
        const saved = await ctx.saveNote(next);
        return { ok: true, resultId: saved.id };
      }
      case 'update': {
        const existing = ctx.notes.get(call.id);
        if (!existing) return { ok: false, error: `note ${call.id} not found` };
        const next: Note = {
          ...existing,
          title: call.title ?? existing.title,
          body: call.body ?? existing.body,
          folder: call.folder ?? existing.folder,
          tags: call.tags ?? existing.tags,
        };
        const saved = await ctx.saveNote(next);
        return { ok: true, resultId: saved.id };
      }
      case 'delete': {
        if (!ctx.notes.has(call.id)) return { ok: false, error: `note ${call.id} not found` };
        await ctx.deleteNote(call.id);
        return { ok: true, resultId: call.id };
      }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Short human-readable summary for confirmation chips. */
export function describeNoteToolCall(
  call: NoteToolCall,
  notes: Map<string, Note>,
): string {
  switch (call.type) {
    case 'create':
      return `Create note "${call.title}"${call.folder?.length ? ` in ${call.folder.join('/')}` : ''}`;
    case 'update': {
      const existing = notes.get(call.id);
      const what: string[] = [];
      if (call.title !== undefined) what.push('title');
      if (call.body !== undefined) what.push('body');
      if (call.folder !== undefined) what.push('folder');
      if (call.tags !== undefined) what.push('tags');
      return `Update "${existing?.title || call.id.slice(0, 8)}" — ${what.join(', ') || 'no fields?'}`;
    }
    case 'delete': {
      const existing = notes.get(call.id);
      return `Delete "${existing?.title || call.id.slice(0, 8)}"`;
    }
  }
}
