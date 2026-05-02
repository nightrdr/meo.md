// Slash menu inside the editor. Triggers on `/` at the start of an empty
// paragraph (or right after whitespace + `/`). Opens a floating popover
// with AI actions; selected action runs RAG against the current note's
// content and inserts the result.
//
// The action runs through the same shared AI runtime as the AI panel.

import React, { useEffect, useState, useRef, useCallback } from 'react';
import type { Editor as TipTapEditor } from '@tiptap/react';
import { Icon } from './Icon';
import { ai as A, type Note } from '@meo/shared';
import { getAIRuntime } from './aiStore';

interface Props {
  editor: TipTapEditor | null;
  note: Note;
  modelId: string;
  notes: Map<string, Note>;
  onUpdate: (next: Note) => void;
}

interface MenuPosition {
  top: number;
  left: number;
  /** The slash position in the doc, used to remove the literal `/` on commit. */
  slashPos: number;
}

interface SlashItem {
  id: string;
  label: string;
  hint: string;
  icon: keyof typeof Icon;
  prompt: (note: Note) => string;
  /** Replace the editor body with the result, or insert at cursor. */
  mode: 'insert' | 'replace';
}

const ITEMS: SlashItem[] = [
  {
    id: 'summarize',
    label: 'Summarize this note',
    hint: 'A 3-sentence abstract',
    icon: 'Sparkle',
    prompt: (n) => `Summarize the following note in 3 sentences.\n\n# ${n.title}\n\n${n.body}`,
    mode: 'insert',
  },
  {
    id: 'action-items',
    label: 'Extract action items',
    hint: 'As a checklist',
    icon: 'Checklist',
    prompt: (n) => `List the action items from the following note as a markdown task list (using "- [ ]"). Only include real action items.\n\n# ${n.title}\n\n${n.body}`,
    mode: 'insert',
  },
  {
    id: 'outline',
    label: 'Turn into outline',
    hint: 'Headings + bullets',
    icon: 'List',
    prompt: (n) => `Rewrite the following note as a clean outline with markdown headings (##) and bullets. Keep it faithful to the original.\n\n# ${n.title}\n\n${n.body}`,
    mode: 'replace',
  },
  {
    id: 'improve',
    label: 'Improve writing',
    hint: 'Clarity + flow',
    icon: 'Edit',
    prompt: (n) => `Improve the writing in the following note for clarity and flow. Preserve every fact, every name, every number. Don't add new claims. Output only the rewritten note (no commentary).\n\n# ${n.title}\n\n${n.body}`,
    mode: 'replace',
  },
];

export function SlashMenu({ editor, note, modelId, notes, onUpdate }: Props) {
  const [pos, setPos] = useState<MenuPosition | null>(null);
  const [selected, setSelected] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Detect `/` at the start of an empty block. Listens to selection
  // changes from TipTap and the slash keypress.
  useEffect(() => {
    if (!editor) return;

    const handler = (event: KeyboardEvent) => {
      if (event.key !== '/') return;
      // Only trigger when the cursor is in an empty paragraph or after
      // whitespace. Defer to the next tick so TipTap has applied the input.
      setTimeout(() => {
        const { from } = editor.state.selection;
        const $pos = editor.state.doc.resolve(from);
        const blockText = $pos.parent.textContent;
        // Trigger only if the slash is alone in its block (so ".. /" or
        // mid-word slashes don't open it).
        if (blockText === '/' || blockText.endsWith(' /')) {
          const coords = editor.view.coordsAtPos(from);
          // Position relative to the editor pane's bounding rect
          const editorRect = (editor.view.dom as HTMLElement).getBoundingClientRect();
          setPos({
            top: coords.bottom - editorRect.top + 4,
            left: coords.left - editorRect.left,
            slashPos: from - 1,
          });
          setSelected(0);
        }
      }, 0);
    };

    const dom = editor.view.dom;
    dom.addEventListener('keyup', handler);
    return () => dom.removeEventListener('keyup', handler);
  }, [editor]);

  // Keyboard navigation
  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPos(null);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected(s => Math.min(s + 1, ITEMS.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected(s => Math.max(s - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runItem(ITEMS[selected]);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, selected]);

  // Click-outside dismiss
  useEffect(() => {
    if (!pos) return;
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setPos(null);
      }
    };
    const t = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onClick);
    };
  }, [pos]);

  const runItem = useCallback(async (item: SlashItem) => {
    if (!editor) return;
    setRunning(item.id);
    try {
      // Strip the literal `/`
      if (pos) {
        editor.chain().setTextSelection({ from: pos.slashPos, to: pos.slashPos + 1 }).deleteSelection().run();
      }
      setPos(null);

      const rt = await getAIRuntime();
      const av = await rt.isAvailable();
      if (!av.ollama) {
        editor.chain().focus().insertContent('\n\n*(AI is not available, install Ollama and pull a model first.)*\n\n').run();
        return;
      }

      // Stream the response into the doc
      const stream = rt.generator.stream({
        model: modelId,
        messages: [
          { role: 'system', content: 'You write concise, accurate prose. Output only what is asked, no preamble.' },
          { role: 'user', content: item.prompt(note) },
        ],
        maxTokens: 512,
        temperature: 0.4,
      });

      if (item.mode === 'replace') {
        // Buffer first, then replace the body in one shot to avoid weird
        // intermediate states.
        let buf = '';
        for await (const c of stream) {
          if (c.delta) buf += c.delta;
        }
        onUpdate({ ...note, body: buf.trim() });
      } else {
        // Insert mode - stream into the editor
        editor.chain().focus().insertContent('\n\n').run();
        for await (const c of stream) {
          if (c.delta) {
            editor.chain().focus().insertContent(c.delta).run();
          }
        }
      }
    } catch (e) {
      // Graceful: just leave a marker
      editor.chain().focus().insertContent(`\n\n*(AI error: ${(e as Error).message})*\n\n`).run();
    } finally {
      setRunning(null);
    }
  }, [editor, note, modelId, notes, onUpdate, pos]);

  if (!pos) return null;

  return (
    <div
      ref={wrapperRef}
      className="slash-menu"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.preventDefault()}      // don't steal focus from editor
    >
      <div className="slash-header">
        <Icon.Sparkle size={11} stroke="var(--ai)" />
        <span style={{ color: 'var(--ai)', fontWeight: 600 }}>AI actions</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>/</span>
      </div>
      {ITEMS.map((it, i) => {
        const I = Icon[it.icon];
        const isRunning = running === it.id;
        return (
          <div
            key={it.id}
            className={`slash-item ${i === selected ? 'active' : ''}`}
            onMouseEnter={() => setSelected(i)}
            onClick={() => runItem(it)}
          >
            <div className="slash-item-icon">
              <I size={12} />
            </div>
            <div className="slash-item-body">
              <div className="slash-item-label">{it.label}</div>
              <div className="slash-item-hint">{it.hint}</div>
            </div>
            {isRunning ? <span className="slash-running">…</span>
              : i === selected ? <Icon.Return size={11} stroke="var(--ink3)" /> : null}
          </div>
        );
      })}
    </div>
  );
}
