import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor as TipTapEditor, Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { Mark } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { MathInline, MathBlock } from './editor/mathExtension';
import { Mermaid } from './editor/mermaidExtension';
import type { Note, Tier } from '@meo/shared';
import { ATTACHMENT_URL_PREFIX, tierLimits, explainAttachmentTooLarge } from '@meo/shared';
import { Icon } from './Icon';
import { SlashMenu } from './SlashMenu';
import {
  AttachmentImageExtension, AttachmentVideoExtension, AttachmentAudioExtension,
  makeAttachmentsClient,
} from './AttachmentRenderer';
import { getAIRuntime } from './aiStore';
import { shortcut } from './platform';
import { isDictationAvailable, startDictation, type DictationSession } from './dictation';
import {
  MeoCollapseExtension,
  meoCollapsePluginKey,
  collapseCurrentSection,
  expandCurrentSection,
  collapseAllSections,
  expandAllSections,
  anchorsFromState,
  positionsFromAnchors,
  restoreCollapsed,
} from './editor/collapseExtension';
import { getMeta, setMeta } from './storage';

interface Props {
  note: Note;
  breadcrumb: string[];
  status: 'idle' | 'syncing' | 'saving' | 'error';
  statusMsg: string;
  wordCount: number;
  modelId: string;
  notes: Map<string, Note>;
  /** Current billing tier — used for client-side attachment size pre-validation. */
  tier?: Tier;
  onChange: (next: Note) => void;
  onDelete: () => void;
  /** Called when the user clicks the "Upgrade" link in the attachment-too-large banner. */
  onOpenSubscription?: () => void;
}

type EditorMode = 'edit' | 'split' | 'preview';

// Find plugin — paints decorations on every case-insensitive match of
// the active query. The query lives on the plugin's own state and is
// updated by dispatching a transaction with a meta payload.
const findPluginKey = new PluginKey<{ query: string; currentIndex: number; total: number }>('meo-find');

function buildDecorationSet(doc: any, query: string, currentIndex: number): { decos: DecorationSet; total: number } {
  if (!query) return { decos: DecorationSet.empty, total: 0 };
  const decorations: Decoration[] = [];
  let i = 0;
  const q = query.toLowerCase();
  doc.descendants((node: any, pos: number) => {
    if (!node.isText) return;
    const text: string = node.text || '';
    const lower = text.toLowerCase();
    let from = 0;
    while (true) {
      const at = lower.indexOf(q, from);
      if (at < 0) break;
      decorations.push(
        Decoration.inline(pos + at, pos + at + q.length, {
          class: i === currentIndex ? 'meo-find-hit meo-find-hit-current' : 'meo-find-hit',
        }),
      );
      from = at + Math.max(1, q.length);
      i++;
    }
  });
  return { decos: DecorationSet.create(doc, decorations), total: i };
}

// Translucent / dotted-underline mark used for the live dictation
// partial-transcript preview. Stripped from markdown serialization (the
// final commit on each chunk replaces it with plain text) so it never
// leaks into the saved body.
const DictationPartialMark = Mark.create({
  name: 'meoDictationPartial',
  parseHTML() {
    return [{ tag: 'span[data-meo-dictation="partial"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, 'data-meo-dictation': 'partial', class: 'meo-dictation-partial' }, 0];
  },
});

const FindExtension = Extension.create({
  name: 'meoFind',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: findPluginKey,
        state: {
          init: () => ({ decos: DecorationSet.empty as any, query: '', currentIndex: -1, total: 0 }),
          apply(tr, prev: any) {
            const meta = tr.getMeta(findPluginKey) as any;
            const query = meta?.query !== undefined ? meta.query : prev.query;
            const currentIndex = meta?.currentIndex !== undefined ? meta.currentIndex : prev.currentIndex;
            // Recompute on doc change OR on meta update.
            if (!tr.docChanged && meta === undefined) return prev;
            const { decos, total } = buildDecorationSet(tr.doc, query, currentIndex);
            return { decos, query, currentIndex, total };
          },
        },
        props: {
          decorations(state) { return (findPluginKey.getState(state) as any)?.decos; },
        },
      }),
    ];
  },
});

export function Editor({
  note, breadcrumb, status, statusMsg, wordCount, modelId, notes,
  tier = 'free', onChange, onDelete, onOpenSubscription,
}: Props) {
  const lastNoteId = useRef(note.id);
  const [mode, setMode] = useState<EditorMode>('edit');
  const [tagInput, setTagInput] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ kind: 'idle' } | { kind: 'busy'; filename: string } | { kind: 'error'; message: string; upgradable?: boolean }>({ kind: 'idle' });
  const [dropActive, setDropActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  // Media-insert popover (toolbar Video / Audio button → URL or File modal).
  // `null` means closed; when open we track which media kind we're inserting.
  const [mediaModal, setMediaModal] = useState<null | { kind: 'video' | 'audio' }>(null);

  // Dictation state (Agent 6 §1). `dictationAvailable` is probed once at
  // mount; the mic toolbar button is hidden when false.
  const [dictationAvailable] = useState<boolean>(isDictationAvailable);
  const [dictating, setDictating] = useState(false);
  const dictationSessionRef = useRef<DictationSession | null>(null);
  // Position + length of the live partial transcript currently inserted in
  // the doc (so we can replace/clear it on each event).
  const partialRef = useRef<{ from: number; length: number } | null>(null);

  // ── Find-in-note state ──
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);

  // ── AI bubble state (proofread / summarize) ──
  type Bubble =
    | { kind: 'idle' }
    | { kind: 'running'; action: 'summarize' | 'proofread' }
    | { kind: 'result'; action: 'summarize' | 'proofread'; text: string; original: string; selectionFrom: number; selectionTo: number };
  const [bubble, setBubble] = useState<Bubble>({ kind: 'idle' });
  const bubbleAbortRef = useRef<AbortController | null>(null);

  // ── Split-view ping-pong guard ──
  // When the textarea drives an update (user types in source) we set this
  // flag so the TipTap onUpdate doesn't echo it back and produce a loop.
  const sourceDrivenRef = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({}),
      Placeholder.configure({ placeholder: 'Start writing in markdown' }),
      AttachmentImageExtension,
      AttachmentVideoExtension,
      AttachmentAudioExtension,
      // Task list: stored as `<ul data-type="taskList"><li data-type="taskItem"
      // data-checked="true|false">…</li></ul>` and serialized to markdown
      // as `- [x] / - [ ]` by markdownFromHtml below.
      TaskList,
      TaskItem.configure({ nested: true }),
      // GFM-style tables. StarterKit doesn't bundle these so no
      // collision worry; we still pass `resizable: false` to keep the
      // simpler editing experience.
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      // KaTeX math (lazy-loads `katex` on first render).
      MathInline,
      MathBlock,
      // Mermaid diagrams (lazy-loads `mermaid` on first render).
      Mermaid,
      FindExtension,
      MeoCollapseExtension,
      DictationPartialMark,
    ],
    content: htmlFromMarkdown(note.body),
    onUpdate: ({ editor }) => {
      if (sourceDrivenRef.current) return;
      onChange({ ...note, body: markdownFromHtml(editor.getHTML()) });
    },
  });

  const noteId = note.id;
  const handleAttachmentFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0 || !editor) return;
    const client = makeAttachmentsClient();
    if (!client) {
      setUploadStatus({ kind: 'error', message: 'Sign in to upload attachments' });
      return;
    }
    const limits = tierLimits(tier);
    for (const file of list) {
      // Tier-aware client-side pre-validation. The server enforces the same
      // cap (SQLSTATE P0007) as a defense-in-depth measure.
      if (file.size > limits.maxAttachmentBytes) {
        setUploadStatus({
          kind: 'error',
          message: explainAttachmentTooLarge(tier, file.size),
          upgradable: tier === 'free',
        });
        continue;
      }
      setUploadStatus({ kind: 'busy', filename: file.name });
      try {
        const arrayBuf = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        const dimensions = await readImageDimensions(file).catch(() => undefined);
        const result = await client.upload(noteId, {
          bytes,
          filename: file.name || 'attachment',
          mimeType: file.type || 'application/octet-stream',
          dimensions,
        });
        const attachmentUrl = `${ATTACHMENT_URL_PREFIX}${result.id}`;
        const mime = file.type || '';
        const isImage = mime.startsWith('image/');
        const isVideo = mime.startsWith('video/');
        const isAudio = mime.startsWith('audio/');
        if (isImage) {
          editor.chain().focus().insertContent({
            type: 'image',
            attrs: {
              src: attachmentUrl,
              alt: file.name,
              'data-attachment-id': result.id,
            },
          }).run();
        } else if (isVideo) {
          editor.chain().focus().insertContent({
            type: 'video',
            attrs: { src: attachmentUrl, controls: true, 'data-attachment-id': result.id },
          }).run();
        } else if (isAudio) {
          editor.chain().focus().insertContent({
            type: 'audio',
            attrs: { src: attachmentUrl, controls: true, 'data-attachment-id': result.id },
          }).run();
        } else {
          // Generic file — drop a markdown-style link so the editor body
          // still round-trips.
          editor.chain().focus().insertContent(`[${file.name}](${attachmentUrl})`).run();
        }
        setUploadStatus({ kind: 'idle' });
      } catch (e: any) {
        console.error('attachment upload failed', e);
        // Surface the server-side too-large / quota errors as an upgradable
        // banner so the user sees the same call-to-action as the client-side
        // path.
        const msg = String(e?.message ?? e);
        const tooLarge = /attachment_too_large|attachment too large|413/.test(msg);
        const overQuota = /storage_cap_exceeded|quota exceeded/.test(msg);
        const friendly = tooLarge
          ? explainAttachmentTooLarge(tier, file.size)
          : overQuota
            ? `You've used your tier's storage cap. ${tier === 'free' ? 'Upgrade for more space.' : 'Free up some attachments or contact support.'}`
            : msg;
        setUploadStatus({
          kind: 'error',
          message: friendly,
          upgradable: tier === 'free' && (tooLarge || overQuota),
        });
      }
    }
  }, [editor, noteId, tier]);

  // Insert a remote-URL video/audio without uploading. The URL is stored
  // verbatim in the markdown body via the round-trip (raw <video>/<audio>
  // HTML — see markdownFromHtml below).
  const insertMediaFromUrl = useCallback((kind: 'video' | 'audio', url: string) => {
    if (!editor) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    editor.chain().focus().insertContent({
      type: kind,
      attrs: { src: trimmed, controls: true },
    }).run();
  }, [editor]);

  // ── Dictation toggle (Agent 6 §1) ──
  // Starts/stops a WebSpeech session and inserts text at the cursor.
  // - `onPartial` shows a translucent live preview at the caret using a
  //   transient inserted text run that we replace each result event.
  // - `onFinal` commits a chunk: clears the partial, then inserts the
  //   final text (plain) at the caret.
  const stopDictation = useCallback(() => {
    const sess = dictationSessionRef.current;
    if (sess) sess.stop();
    dictationSessionRef.current = null;
    // Clear any leftover partial run (mark removed; commit happens on final).
    if (editor && partialRef.current) {
      const { from, length } = partialRef.current;
      try {
        editor.chain().focus()
          .setTextSelection({ from, to: from + length })
          .unsetMark('meoDictationPartial')
          .deleteSelection()
          .run();
      } catch { /* the doc may have changed; partial is best-effort */ }
      partialRef.current = null;
    }
    setDictating(false);
  }, [editor]);

  const toggleDictation = useCallback(() => {
    if (dictating) { stopDictation(); return; }
    if (!editor) return;
    if (!isDictationAvailable()) return;
    setDictating(true);
    const sess = startDictation({
      onPartial: (text) => {
        if (!editor) return;
        // Replace any previous partial with the new one, marked translucent.
        const view = editor.view;
        const tr = view.state.tr;
        if (partialRef.current) {
          tr.delete(partialRef.current.from, partialRef.current.from + partialRef.current.length);
          partialRef.current = null;
        }
        const insertAt = tr.selection.from;
        if (text) {
          const markType = view.state.schema.marks.meoDictationPartial;
          if (markType) {
            tr.insertText(text, insertAt);
            tr.addMark(insertAt, insertAt + text.length, markType.create());
            partialRef.current = { from: insertAt, length: text.length };
          } else {
            // Fallback: plain insert if the mark type isn't registered.
            tr.insertText(text, insertAt);
            partialRef.current = { from: insertAt, length: text.length };
          }
        }
        view.dispatch(tr);
      },
      onFinal: (text) => {
        if (!editor) return;
        const view = editor.view;
        const tr = view.state.tr;
        if (partialRef.current) {
          tr.delete(partialRef.current.from, partialRef.current.from + partialRef.current.length);
          partialRef.current = null;
        }
        const insertAt = tr.selection.from;
        const trimmed = text.replace(/\s+$/, '') + ' ';
        tr.insertText(trimmed, insertAt);
        view.dispatch(tr);
      },
      onEnd: () => {
        // Engine ended (silence / error / user stop). Reset state; the
        // partial cleanup already happened in stopDictation if user-driven.
        dictationSessionRef.current = null;
        if (partialRef.current && editor) {
          try {
            editor.chain().focus()
              .setTextSelection({ from: partialRef.current.from, to: partialRef.current.from + partialRef.current.length })
              .deleteSelection()
              .run();
          } catch { /* ignore */ }
          partialRef.current = null;
        }
        setDictating(false);
      },
    });
    dictationSessionRef.current = sess;
  }, [dictating, editor, stopDictation]);

  // Stop dictation when switching notes or unmounting.
  useEffect(() => {
    return () => { dictationSessionRef.current?.stop(); };
  }, []);
  useEffect(() => {
    if (dictating) stopDictation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    if (e.dataTransfer?.files?.length) {
      void handleAttachmentFiles(e.dataTransfer.files);
    }
  }, [handleAttachmentFiles]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes?.('Files')) {
      e.preventDefault();
      setDropActive(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDropActive(false);
  }, []);

  useEffect(() => {
    if (!editor) return;
    if (note.id !== lastNoteId.current) {
      lastNoteId.current = note.id;
      editor.commands.setContent(htmlFromMarkdown(note.body), false);
      // Reset find state when switching notes — a query from the
      // previous note doesn't apply.
      setFindOpen(false); setFindQuery(''); setFindIndex(0);
      setBubble({ kind: 'idle' });
    }
  }, [note.id, note.body, editor]);

  // ── Push the active find query into the ProseMirror plugin ──
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.view.state.tr.setMeta(findPluginKey, { query: findQuery, currentIndex: findIndex }),
    );
  }, [editor, findQuery, findIndex]);

  // ── Preview mode = read-only TipTap. Edit and Split keep editing on. ──
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(mode !== 'preview');
  }, [editor, mode]);

  // ── Collapse-section persistence (Agent 4) ──
  // Stored as `meta.collapsed_headings: { [noteId]: string[] }` where
  // each entry is a "level:lowercased-text" anchor (see collapseExtension).
  // We restore on note-open and snapshot whenever the plugin state
  // changes (debounced via rAF).
  const collapseRestoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!editor) return;
    if (collapseRestoredFor.current === note.id) return;
    let cancelled = false;
    (async () => {
      const meta = await getMeta();
      const anchors = meta.collapsed_headings?.[note.id] ?? [];
      if (cancelled || !editor) return;
      const positions = positionsFromAnchors(editor.view.state, anchors);
      restoreCollapsed(editor.view, positions);
      collapseRestoredFor.current = note.id;
    })();
    return () => { cancelled = true; };
  }, [editor, note.id]);

  // Persist collapsed-set changes (debounced).
  useEffect(() => {
    if (!editor) return;
    let raf = 0;
    let lastSerialized = '';
    const onUpdate = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(async () => {
        if (!editor) return;
        const anchors = anchorsFromState(editor.view.state);
        const ser = anchors.join('\n');
        if (ser === lastSerialized) return;
        lastSerialized = ser;
        const meta = await getMeta();
        const map = { ...(meta.collapsed_headings ?? {}) };
        if (anchors.length === 0) delete map[note.id];
        else map[note.id] = anchors;
        await setMeta({ collapsed_headings: map });
      });
    };
    editor.on('transaction', onUpdate);
    return () => {
      editor.off('transaction', onUpdate);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [editor, note.id]);
  const findTotal: number = useMemo(() => {
    if (!editor || !findQuery) return 0;
    return (findPluginKey.getState(editor.view.state) as any)?.total ?? 0;
  }, [editor, findQuery, note.body]);

  // ── Split-view source-pane edit handler ──
  // The textarea is the source of truth for `note.body`. We re-set the
  // TipTap content with the sourceDrivenRef flag so its onUpdate doesn't
  // echo back and create a loop.
  const handleSourceChange = useCallback((nextBody: string) => {
    if (!editor) {
      onChange({ ...note, body: nextBody });
      return;
    }
    sourceDrivenRef.current = true;
    onChange({ ...note, body: nextBody });
    editor.commands.setContent(htmlFromMarkdown(nextBody), false);
    // Release the flag after the React + TipTap microtasks settle.
    queueMicrotask(() => { sourceDrivenRef.current = false; });
  }, [editor, note, onChange]);

  // ── AI bubble logic — proofread / summarize ──
  const cancelBubble = useCallback(() => {
    bubbleAbortRef.current?.abort();
    bubbleAbortRef.current = null;
    setBubble({ kind: 'idle' });
  }, []);

  const runAIBubble = useCallback(async (action: 'summarize' | 'proofread') => {
    if (!editor) return;
    // Use the current selection if non-empty, otherwise the whole body.
    const { from, to } = editor.state.selection;
    const hasSelection = from !== to;
    const selectionText = hasSelection
      ? editor.state.doc.textBetween(from, to, '\n')
      : note.body;
    if (!selectionText.trim()) return;

    setBubble({ kind: 'running', action });
    const abort = new AbortController();
    bubbleAbortRef.current = abort;
    try {
      const rt = await getAIRuntime();
      const av = await rt.isAvailable();
      if (!av.ollama) {
        setBubble({
          kind: 'result', action,
          text: '(AI is not available — install Ollama and pull a model.)',
          original: selectionText, selectionFrom: from, selectionTo: to,
        });
        return;
      }
      const system = action === 'summarize'
        ? 'You write concise, accurate summaries. Output only the summary, no preamble.'
        : 'You proofread English prose. Fix spelling, grammar, and minor style issues. Preserve every fact, name, and number. Output only the corrected text, no commentary.';
      const userPrompt = action === 'summarize'
        ? `Summarize the following in 3 sentences:\n\n${selectionText}`
        : `Proofread the following text. Output the corrected version only.\n\n${selectionText}`;
      const stream = rt.generator.stream({
        model: modelId,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: 512,
        temperature: action === 'summarize' ? 0.4 : 0.2,
        signal: abort.signal,
      });
      let buf = '';
      // Show streaming text as it arrives.
      for await (const c of stream) {
        if (abort.signal.aborted) return;
        if (c.delta) {
          buf += c.delta;
          setBubble({
            kind: 'result', action, text: buf,
            original: selectionText, selectionFrom: from, selectionTo: to,
          });
        }
      }
    } catch (e: any) {
      setBubble({
        kind: 'result', action,
        text: `(AI error: ${e?.message ?? String(e)})`,
        original: selectionText, selectionFrom: from, selectionTo: to,
      });
    } finally {
      bubbleAbortRef.current = null;
    }
  }, [editor, note.body, modelId]);

  const applyProofread = useCallback(() => {
    if (!editor || bubble.kind !== 'result') return;
    const { selectionFrom, selectionTo, text } = bubble;
    if (selectionFrom !== selectionTo) {
      // Replace the selection.
      editor.chain()
        .focus()
        .setTextSelection({ from: selectionFrom, to: selectionTo })
        .insertContent(text.trim())
        .run();
    } else {
      // Replace the whole body.
      editor.commands.setContent(htmlFromMarkdown(text.trim()), true);
    }
    setBubble({ kind: 'idle' });
  }, [editor, bubble]);

  // ── Editor-local Esc + ⌘F + ⌘A handling ──
  // Captures Esc *before* App.tsx's global handler so editor overlays
  // close first; we stopPropagation when we consume.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘F (or Ctrl+F) opens the find bar
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
        return;
      }
      // ⌘A inside the editor view → route through ProseMirror's
      // selectAll so the view repaints with a visible AllSelection.
      // Without this, the macOS Edit menu's selectAll: action does
      // a native DOM selectAll that PM may not reconcile, leaving
      // the user with an invisible selection. We only intercept when
      // the event actually originated inside the editor — letting it
      // pass through to plain inputs/textareas (split source pane,
      // title/folder/find-bar inputs) so their native behaviour is
      // untouched.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && editor) {
        const tgt = e.target as HTMLElement | null;
        const inEditor = tgt instanceof Node && editor.view.dom.contains(tgt);
        if (inEditor) {
          e.preventDefault();
          editor.commands.selectAll();
          return;
        }
      }
      if (e.key === 'Escape') {
        if (dictating) { stopDictation(); e.stopPropagation(); e.preventDefault(); return; }
        if (bubble.kind !== 'idle') { cancelBubble(); e.stopPropagation(); e.preventDefault(); return; }
        if (findOpen) { setFindOpen(false); setFindQuery(''); e.stopPropagation(); e.preventDefault(); return; }
        if (mediaModal) { setMediaModal(null); e.stopPropagation(); e.preventDefault(); return; }
      }
      // ⌃⌥D toggles dictation (works on macOS as Control+Option+D and on
      // Win/Linux as Ctrl+Alt+D — we use the literal control flag so the
      // shortcut sits next to other macOS-style "control + option" combos
      // already in the app).
      if (e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D')) {
        if (dictationAvailable) {
          e.preventDefault();
          toggleDictation();
          return;
        }
      }
      // ── Collapse / expand sections (Agent 4) ──
      // ⌥⌘← collapse current section, ⌥⌘→ expand current section.
      // ⇧⌥⌘← collapse all, ⇧⌥⌘→ expand all.
      if (editor && e.altKey && (e.metaKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const all = e.shiftKey;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (all) collapseAllSections(editor.view);
          else collapseCurrentSection(editor.view);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (all) expandAllSections(editor.view);
          else expandCurrentSection(editor.view);
          return;
        }
      }
    };
    document.addEventListener('keydown', onKey, true); // capture phase
    return () => document.removeEventListener('keydown', onKey, true);
  }, [bubble, findOpen, cancelBubble, editor, dictating, dictationAvailable, mediaModal, stopDictation, toggleDictation]);

  // ── Collapse menu-event bridge ──
  // App.tsx (via useMenuEvents) dispatches `meo:collapse-section`
  // / `meo:expand-section` / `meo:collapse-all` / `meo:expand-all`
  // CustomEvents on `document`. We forward them to the active editor.
  useEffect(() => {
    if (!editor) return;
    const onCollapseOne = () => collapseCurrentSection(editor.view);
    const onExpandOne = () => expandCurrentSection(editor.view);
    const onCollapseAll = () => collapseAllSections(editor.view);
    const onExpandAll = () => expandAllSections(editor.view);
    document.addEventListener('meo:collapse-section', onCollapseOne);
    document.addEventListener('meo:expand-section', onExpandOne);
    document.addEventListener('meo:collapse-all', onCollapseAll);
    document.addEventListener('meo:expand-all', onExpandAll);
    return () => {
      document.removeEventListener('meo:collapse-section', onCollapseOne);
      document.removeEventListener('meo:expand-section', onExpandOne);
      document.removeEventListener('meo:collapse-all', onCollapseAll);
      document.removeEventListener('meo:expand-all', onExpandAll);
    };
  }, [editor]);

  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, '').toLowerCase();
    if (!t || note.tags.includes(t)) {
      setShowTagInput(false);
      setTagInput('');
      return;
    }
    onChange({ ...note, tags: [...note.tags, t] });
    setTagInput('');
    setShowTagInput(false);
  };
  const removeTag = (t: string) => {
    onChange({ ...note, tags: note.tags.filter(x => x !== t) });
  };

  return (
    <div className="editor-pane">
      <div className="editor-header">
        <div className="breadcrumb">
          <span className="crumb">Meo</span>
          {breadcrumb.length > 0 && <span className="sep">›</span>}
          {breadcrumb.map((c, i) => (
            <React.Fragment key={i}>
              <span className="crumb">{c}</span>
              {i < breadcrumb.length - 1 && <span className="sep">›</span>}
            </React.Fragment>
          ))}
          <span className="sep">›</span>
          <input
            className="title-input"
            value={note.title}
            placeholder="Untitled"
            onChange={(e) => onChange({ ...note, title: e.target.value })}
          />
        </div>
        <input
          className="folder-input"
          value={note.folder.join('/')}
          placeholder="folder/path"
          onChange={(e) => onChange({
            ...note,
            folder: e.target.value.split('/').map(s => s.trim()).filter(Boolean),
          })}
          title="Slash-separated folder path"
        />
      </div>

      <Toolbar
        editor={editor}
        mode={mode}
        setMode={setMode}
        onPickAttachment={() => fileInputRef.current?.click()}
        onOpenVideo={() => setMediaModal({ kind: 'video' })}
        onOpenAudio={() => setMediaModal({ kind: 'audio' })}
        onOpenFind={() => setFindOpen(true)}
        onSummarize={() => runAIBubble('summarize')}
        onProofread={() => runAIBubble('proofread')}
        bubbleRunning={bubble.kind === 'running' ? bubble.action : null}
        dictationAvailable={dictationAvailable}
        dictating={dictating}
        onToggleDictation={toggleDictation}
      />

      {/* In-note find bar — ⌘F or toolbar button. Highlights matches via
          a ProseMirror plugin in edit/preview mode and via an overlay in
          split mode. */}
      {findOpen && (
        <div className="find-bar">
          <Icon.Search size={13} />
          <input
            autoFocus
            value={findQuery}
            placeholder={`Find in note (${mode}) — ${shortcut('F')}`}
            onChange={(e) => { setFindQuery(e.target.value); setFindIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (findTotal === 0) return;
                setFindIndex(i => (i + (e.shiftKey ? -1 : 1) + findTotal) % findTotal);
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setFindOpen(false); setFindQuery('');
              }
            }}
          />
          <span className="find-counter">
            {findQuery ? (findTotal ? `${Math.min(findIndex + 1, findTotal)}/${findTotal}` : '0/0') : ''}
          </span>
          <button className="find-btn"
            disabled={!findQuery || findTotal === 0}
            title="Previous match (Shift+Enter)"
            onClick={() => setFindIndex(i => (i - 1 + findTotal) % findTotal)}
          ><Icon.Chevron size={12} style={{ transform: 'rotate(180deg)' }} /></button>
          <button className="find-btn"
            disabled={!findQuery || findTotal === 0}
            title="Next match (Enter)"
            onClick={() => setFindIndex(i => (i + 1) % findTotal)}
          ><Icon.Chevron size={12} /></button>
          <button className="find-btn" title="Close (Esc)"
            onClick={() => { setFindOpen(false); setFindQuery(''); }}
          ><Icon.X size={12} /></button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.gif,.webp,.svg,.avif,image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) void handleAttachmentFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept=".mp4,.webm,.mov,.ogv,video/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) void handleAttachmentFiles(e.target.files);
          e.target.value = '';
          setMediaModal(null);
        }}
      />
      <input
        ref={audioInputRef}
        type="file"
        accept=".mp3,.wav,.m4a,.ogg,.flac,audio/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) void handleAttachmentFiles(e.target.files);
          e.target.value = '';
          setMediaModal(null);
        }}
      />

      {dictating && (
        <div className="dictation-pill" role="status" aria-live="polite">
          <span className="dictation-dot" />
          Dictating… (Esc to stop)
        </div>
      )}

      {mediaModal && (
        <MediaInsertModal
          kind={mediaModal.kind}
          onClose={() => setMediaModal(null)}
          onPickFile={() => {
            (mediaModal.kind === 'video' ? videoInputRef : audioInputRef).current?.click();
          }}
          onSubmitUrl={(url) => {
            insertMediaFromUrl(mediaModal.kind, url);
            setMediaModal(null);
          }}
        />
      )}

      <div
        className={`editor-body ${mode === 'split' ? 'split' : ''}${dropActive ? ' drop-active' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        {mode === 'split' && (
          <div className="editor-source-wrap">
            <textarea
              className="editor-source"
              value={note.body}
              onChange={(e) => handleSourceChange(e.target.value)}
              placeholder="Start writing markdown…"
              spellCheck={false}
            />
            {findOpen && findQuery && (
              <div
                className="editor-source-overlay"
                aria-hidden
                dangerouslySetInnerHTML={{
                  __html: highlightOverlay(note.body, findQuery, findIndex),
                }}
              />
            )}
          </div>
        )}
        <div className="editor-canvas" style={{ position: 'relative' }}>
          <EditorContent editor={editor} />

          {/* Slash menu (`/` inside the body opens AI actions) */}
          <SlashMenu editor={editor} note={note} modelId={modelId} notes={notes} onUpdate={onChange} />

          {/* AI bubble (proofread / summarize). Anchored to the top of the
              canvas; absolute, so it floats above the prose. */}
          {bubble.kind !== 'idle' && (
            <div className="ai-bubble" style={{ top: 8, right: 8 }}>
              <div className="ai-bubble-header">
                {bubble.kind === 'running' && <span className="spinner" />}
                {bubble.kind === 'result' && <Icon.Sparkle size={12} stroke="var(--ai)" />}
                <span className="label">
                  {bubble.action === 'summarize' ? 'Summary' : 'Proofread'}
                </span>
                <div className="grow" />
                <button onClick={cancelBubble} title="Close (Esc)">
                  <Icon.X size={12} />
                </button>
              </div>
              <div className="ai-bubble-body">
                {bubble.kind === 'running'
                  ? 'Generating…'
                  : bubble.action === 'proofread'
                    ? <ProofreadDiff before={bubble.original} after={bubble.text} />
                    : bubble.text}
              </div>
              {bubble.kind === 'result' && (
                <div className="ai-bubble-actions">
                  <div className="grow" />
                  <button onClick={() => navigator.clipboard.writeText(bubble.text.trim())}>
                    <Icon.Copy size={11} style={{ marginRight: 4, verticalAlign: -1 }} />
                    Copy
                  </button>
                  {bubble.action === 'proofread' && (
                    <button className="primary" onClick={applyProofread}>
                      Apply
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Tag chips inline at the bottom of the note body */}
          <div className="tag-row">
            {note.tags.map(t => (
              <span key={t} className="tag-chip in-note">
                #{t}
                <button
                  type="button"
                  className="tag-remove"
                  onClick={() => removeTag(t)}
                  title="Remove tag"
                >
                  <Icon.X size={9} />
                </button>
              </span>
            ))}
            {showTagInput ? (
              <input
                className="tag-input"
                autoFocus
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addTag();
                  if (e.key === 'Escape') { setTagInput(''); setShowTagInput(false); }
                }}
                onBlur={addTag}
                placeholder="tag"
              />
            ) : (
              <button
                type="button"
                className="tag-add"
                onClick={() => setShowTagInput(true)}
                title="Add tag"
              >
                <Icon.Plus size={10} /> Add tag
              </button>
            )}
          </div>
        </div>
      </div>

      {uploadStatus.kind !== 'idle' && (
        <div className={`upload-banner ${uploadStatus.kind}`}>
          {uploadStatus.kind === 'busy'
            ? `Encrypting and uploading ${uploadStatus.filename}…`
            : uploadStatus.message}
          {uploadStatus.kind === 'error' && uploadStatus.upgradable && onOpenSubscription && (
            <button
              type="button"
              className="upload-banner-upgrade"
              onClick={() => { setUploadStatus({ kind: 'idle' }); onOpenSubscription(); }}
            >
              Upgrade
            </button>
          )}
          {uploadStatus.kind === 'error' && (
            <button
              type="button"
              className="upload-banner-dismiss"
              onClick={() => setUploadStatus({ kind: 'idle' })}
            >
              <Icon.X size={10} />
            </button>
          )}
        </div>
      )}

      <div className="statusbar">
        <span>
          <span className={`dot ${status === 'idle' ? 'ok' : status === 'error' ? 'err' : 'syncing'}`}>●</span>{' '}
          {statusMsg || 'Ready'}
        </span>
        <span>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
        <div className="grow" />
        <button className="delete-current" onClick={onDelete}>Delete note</button>
        <span style={{ fontFamily: 'var(--font-mono)' }}>Markdown</span>
      </div>
    </div>
  );
}

function Toolbar({
  editor, mode, setMode, onPickAttachment, onOpenVideo, onOpenAudio, onOpenFind,
  onSummarize, onProofread, bubbleRunning,
  dictationAvailable, dictating, onToggleDictation,
}: {
  editor: TipTapEditor | null;
  mode: EditorMode;
  setMode: (m: EditorMode) => void;
  onPickAttachment: () => void;
  onOpenVideo: () => void;
  onOpenAudio: () => void;
  onOpenFind: () => void;
  onSummarize: () => void;
  onProofread: () => void;
  bubbleRunning: 'summarize' | 'proofread' | null;
  dictationAvailable: boolean;
  dictating: boolean;
  onToggleDictation: () => void;
}) {
  if (!editor) return <div className="editor-toolbar" style={{ height: 41 }} />;

  // Preserve the editor's selection across toolbar button clicks. By
  // default, mousedown on a <button> moves focus *away* from the
  // contenteditable, which collapses the selection to a single cursor
  // — so single-click commands ran on a stale/empty selection (need a
  // second click to take), and multi-line selections only formatted
  // the first line. preventDefault on mousedown stops the focus shift
  // while still letting click run normally.
  const preserveFocus = (e: React.MouseEvent) => {
    // Mode-segment buttons are navigational — let them take focus
    // normally so keyboard nav still works inside the segment.
    if ((e.target as HTMLElement).closest('.mode-segment')) return;
    e.preventDefault();
  };

  // Preview mode: hide editing controls so users don't click greyed-out
  // buttons that silently no-op. Keep Find (still useful when reading)
  // and the mode segment (so the user can switch back).
  if (mode === 'preview') {
    return (
      <div className="editor-toolbar" onMouseDown={preserveFocus}>
        <button type="button" title={`Find in note (${shortcut('F')})`} onClick={onOpenFind}>
          <Icon.Search size={14} />
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--ink3)', marginRight: 8, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase' }}>
          Read-only
        </span>
        <div className="mode-segment">
          {(['edit', 'split', 'preview'] as EditorMode[]).map(m => (
            <button
              key={m}
              type="button"
              className={mode === m ? 'on' : ''}
              onClick={() => setMode(m)}
            >{m === 'edit' ? 'Edit' : m === 'split' ? 'Split' : 'Preview'}</button>
          ))}
        </div>
      </div>
    );
  }

  const Btn = ({ icon, label, onClick, active = false, disabled = false }: {
    icon: React.ReactNode; label: string; onClick: () => void;
    active?: boolean; disabled?: boolean;
  }) => (
    <button
      type="button"
      title={label}
      className={active ? 'active' : ''}
      disabled={disabled}
      onClick={onClick}
    >{icon}</button>
  );

  const Sep = () => <div className="divider" />;

  // Heading dropdown
  const [hOpen, setHOpen] = React.useState(false);
  const headingLevel = (() => {
    for (const lvl of [1, 2, 3, 4, 5, 6] as const) {
      if (editor.isActive('heading', { level: lvl })) return lvl;
    }
    return 0;
  })();

  return (
    <div className="editor-toolbar" onMouseDown={preserveFocus}>
      <Btn
        icon={<Icon.Undo size={14} />}
        label={`Undo, ${shortcut('Z')}`}
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
      />
      <Btn
        icon={<Icon.Redo size={14} />}
        label={`Redo, ${shortcut('Z', 'shift')}`}
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
      />

      <Sep />

      <div className="heading-select" onMouseDown={(e) => e.preventDefault()}>
        <button
          type="button"
          title="Heading"
          className={headingLevel ? 'active' : ''}
          onClick={() => setHOpen(o => !o)}
        >
          H<span style={{ fontSize: 9, opacity: 0.7, marginLeft: 1 }}>
            {headingLevel || '1·6'}
          </span>
          <Icon.ChevronD size={9} />
        </button>
        {hOpen && (
          <div className="heading-menu" onMouseDown={(e) => e.preventDefault()}>
            <button type="button" onClick={() => { editor.chain().focus().setParagraph().run(); setHOpen(false); }}>Paragraph</button>
            {[1, 2, 3, 4, 5, 6].map(level => (
              <button
                key={level}
                type="button"
                onClick={() => { editor.chain().focus().toggleHeading({ level: level as 1|2|3|4|5|6 }).run(); setHOpen(false); }}
              >Heading {level}</button>
            ))}
          </div>
        )}
      </div>

      <Btn icon={<Icon.Bold size={14} />} label={`Bold, ${shortcut('B')}`}
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()} />
      <Btn icon={<Icon.Italic size={14} />} label={`Italic, ${shortcut('I')}`}
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()} />
      <Btn icon={<Icon.Strike size={14} />} label="Strikethrough"
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()} />

      <Sep />

      <Btn icon={<Icon.Link size={14} />} label="Link (paste markdown)"
        onClick={() => {
          const url = prompt('Link URL');
          if (!url) return;
          editor.chain().focus().insertContent(`[${editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) || 'link'}](${url})`).run();
        }} />
      <Btn icon={<Icon.Image size={14} />} label="Insert image / file (encrypted upload)"
        onClick={onPickAttachment} />
      <Btn icon={<Icon.Video size={14} />} label="Insert video (URL or file)"
        onClick={onOpenVideo} />
      <Btn icon={<Icon.Audio size={14} />} label="Insert audio (URL or file)"
        onClick={onOpenAudio} />
      {dictationAvailable && (
        <button
          type="button"
          title={dictating ? 'Stop dictation' : 'Start dictation (Ctrl+Alt+D)'}
          className={dictating ? 'dictation-btn dictating' : 'dictation-btn'}
          onClick={onToggleDictation}
        >
          {dictating
            ? <span className="dictation-rec-dot" aria-hidden />
            : <Icon.Mic size={14} />}
        </button>
      )}
      <Btn icon={<Icon.Code size={14} />} label="Inline code"
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()} />
      <Btn icon={<Icon.CodeBlock size={14} />} label="Code block"
        active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()} />

      <Sep />

      <Btn icon={<Icon.List size={14} />} label="Bullet list"
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()} />
      <Btn icon={<Icon.ListNumbered size={14} />} label="Numbered list"
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()} />
      <Btn icon={<Icon.Checklist size={14} />} label="To-do list"
        active={editor.isActive('taskList')}
        onClick={() => (editor.chain().focus() as any).toggleTaskList().run()} />
      <Btn icon={<Icon.Outdent size={14} />} label="Outdent"
        onClick={() => editor.chain().focus().liftListItem('listItem').run()} />
      <Btn icon={<Icon.Indent size={14} />} label="Indent"
        onClick={() => editor.chain().focus().sinkListItem('listItem').run()} />

      <Sep />

      <Btn icon={<Icon.Quote size={14} />} label="Blockquote"
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()} />
      <Btn icon={<Icon.Hr size={14} />} label="Horizontal rule"
        onClick={() => editor.chain().focus().setHorizontalRule().run()} />

      <Sep />

      {/* Table picker — small dropdown grid */}
      <TablePicker editor={editor} />
      <Btn icon={<Icon.Math size={14} />} label="Insert math (LaTeX)"
        active={editor.isActive('mathInline') || editor.isActive('mathBlock')}
        onClick={() => {
          const latex = prompt('LaTeX (e.g. E = mc^2)');
          if (!latex) return;
          editor.chain().focus().insertContent({
            type: 'mathInline',
            attrs: { latex },
          }).run();
        }} />
      <Btn icon={<Icon.Diagram size={14} />} label="Insert Mermaid diagram"
        active={editor.isActive('mermaid')}
        onClick={() => {
          const sample = 'graph TD\n  A[Start] --> B{Choice}\n  B -->|Yes| C[Done]\n  B -->|No| D[Loop]';
          editor.chain().focus().insertContent({
            type: 'mermaid',
            attrs: { source: sample },
          }).run();
        }} />
      <Btn icon={<Icon.Search size={14} />} label={`Find in note (${shortcut('F')})`}
        onClick={onOpenFind} />

      <Sep />

      <button type="button" title="AI actions, /" className="ai-toolbar-btn">
        <Icon.Sparkle size={14} stroke="var(--ai)" />
      </button>
      <button
        type="button"
        title="Summarize selection or whole note"
        className="ai-toolbar-btn"
        disabled={!!bubbleRunning}
        onClick={onSummarize}
      >
        <Icon.Summary size={14} stroke="var(--ai)" />
      </button>
      <button
        type="button"
        title="Proofread selection or whole note"
        className="ai-toolbar-btn"
        disabled={!!bubbleRunning}
        onClick={onProofread}
      >
        <Icon.Spell size={14} stroke="var(--ai)" />
      </button>

      <div style={{ flex: 1 }} />

      <div className="mode-segment">
        {(['edit', 'split', 'preview'] as EditorMode[]).map(m => (
          <button
            key={m}
            type="button"
            className={mode === m ? 'on' : ''}
            onClick={() => setMode(m)}
          >{m === 'edit' ? 'Edit' : m === 'split' ? 'Split' : 'Preview'}</button>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Table picker — small popout grid; hover to size, click to insert.
// Keyboard shortcut ⌘⌥T inserts a 3×3 table directly.
// ──────────────────────────────────────────────────────────────────────

function TablePicker({ editor }: { editor: TipTapEditor }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState({ rows: 0, cols: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const ROWS = 6, COLS = 8;

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) {
      const t = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
      return () => {
        clearTimeout(t);
        document.removeEventListener('mousedown', onDocClick);
      };
    }
  }, [open]);

  // Keyboard shortcut: ⌘⌥T (Ctrl+Alt+T on Win/Linux) inserts a 3×3 table.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.altKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [editor]);

  const insert = (rows: number, cols: number) => {
    setOpen(false);
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        title={`Insert table (${shortcut('T', 'alt')})`}
        className={editor.isActive('table') ? 'active' : ''}
        onClick={() => setOpen(o => !o)}
      >
        <Icon.Table size={14} />
      </button>
      {open && (
        <div
          className="table-picker"
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4,
            background: 'var(--overlay)', border: '1px solid var(--paper-edge)',
            borderRadius: 8, padding: 6,
            boxShadow: '0 12px 36px rgba(0,0,0,0.18)',
            zIndex: 100,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, 14px)`, gap: 2 }}>
            {Array.from({ length: ROWS * COLS }).map((_, idx) => {
              const r = Math.floor(idx / COLS) + 1;
              const c = (idx % COLS) + 1;
              const on = r <= hover.rows && c <= hover.cols;
              return (
                <button
                  key={idx}
                  type="button"
                  style={{
                    width: 14, height: 14, padding: 0,
                    border: '1px solid var(--paper-edge)',
                    background: on ? 'var(--accent, #4f6b3a)' : 'transparent',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={() => setHover({ rows: r, cols: c })}
                  onClick={() => insert(r, c)}
                />
              );
            })}
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--ink3)', textAlign: 'center' }}>
            {hover.rows > 0 ? `${hover.rows} × ${hover.cols}` : 'Pick size'}
          </div>
        </div>
      )}
    </div>
  );
}

// --- markdown ↔ HTML translators ---

// Read the natural dimensions of an image file. Returns undefined for
// non-images / failures (e.g. PDF, generic binary). Used for attachment
// metadata so the renderer can pre-size before bytes finish decrypting.
async function readImageDimensions(file: File): Promise<{ width: number; height: number } | undefined> {
  if (!(file.type || '').startsWith('image/')) return undefined;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(undefined);
    };
    img.src = url;
  });
}

function htmlFromMarkdown(md: string): string {
  if (!md) return '';
  const lines = md.split('\n');
  const out: string[] = [];
  let inList: null | 'ul' | 'ol' | 'task' = null;
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];
  let inMathBlock = false;
  let mathBuf: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/\r$/, '');
    // ── Fenced code blocks (incl. ```mermaid). ──
    if (!inMathBlock && line.startsWith('```')) {
      if (inCode) {
        if (codeLang === 'mermaid') {
          out.push(`<pre data-meo-mermaid="true"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        } else {
          out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        }
        inCode = false; codeBuf = []; codeLang = '';
      } else {
        closeList();
        codeLang = line.slice(3).trim();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    // ── Block math ($$ on its own line opens/closes). ──
    if (line.trim() === '$$') {
      if (inMathBlock) {
        out.push(`<div data-meo-math="block" data-latex="${escapeAttr(mathBuf.join('\n'))}">$$${escapeHtml(mathBuf.join('\n'))}$$</div>`);
        inMathBlock = false; mathBuf = [];
      } else {
        closeList();
        inMathBlock = true;
      }
      continue;
    }
    if (inMathBlock) { mathBuf.push(line); continue; }

    // ── GFM table: header line, separator, body rows. ──
    // Detect by: current line is a "| ... |" row, next line is a
    // separator like "| --- | --- |".
    if (/^\s*\|.*\|\s*$/.test(line) && li + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[li + 1])) {
      closeList();
      const tbl = consumeTable(lines, li);
      out.push(tbl.html);
      li = tbl.nextIndex - 1;
      continue;
    }

    if (line.startsWith('# ')) { closeList(); out.push(`<h1>${inline(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('## ')) { closeList(); out.push(`<h2>${inline(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('### ')) { closeList(); out.push(`<h3>${inline(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('#### ')) { closeList(); out.push(`<h4>${inline(line.slice(5))}</h4>`); continue; }
    if (line.startsWith('##### ')) { closeList(); out.push(`<h5>${inline(line.slice(6))}</h5>`); continue; }
    if (line.startsWith('###### ')) { closeList(); out.push(`<h6>${inline(line.slice(7))}</h6>`); continue; }
    if (line.startsWith('> ')) { closeList(); out.push(`<blockquote><p>${inline(line.slice(2))}</p></blockquote>`); continue; }
    if (/^---+$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    // ── Raw HTML video / audio (Agent 6 §2). CommonMark allows
    // arbitrary inline HTML, so we just pass these through unchanged.
    // Captured here so they're treated as block elements rather than
    // wrapped inside a <p>. Any attribute order is preserved.
    {
      const mediaMatch = line.match(/^\s*<(video|audio)\s+([^>]*?)\s*(?:\/>|>\s*<\/\1>|>)\s*$/i);
      if (mediaMatch) {
        closeList();
        const tag = mediaMatch[1].toLowerCase();
        const attrs = mediaMatch[2] ?? '';
        out.push(`<${tag} ${attrs}></${tag}>`);
        continue;
      }
    }
    // Task-list items must be checked BEFORE the generic ulMatch.
    const taskMatch = line.match(/^[-*] \[([ xX])\] (.+)$/);
    if (taskMatch) {
      openList('task');
      const checked = /[xX]/.test(taskMatch[1]) ? 'true' : 'false';
      out.push(`<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${checked === 'true' ? ' checked' : ''}><span></span></label><div><p>${inline(taskMatch[2])}</p></div></li>`);
      continue;
    }
    const ulMatch = line.match(/^[-*] (.+)$/);
    const olMatch = line.match(/^\d+\. (.+)$/);
    if (ulMatch) { openList('ul'); out.push(`<li><p>${inline(ulMatch[1])}</p></li>`); continue; }
    if (olMatch) { openList('ol'); out.push(`<li><p>${inline(olMatch[1])}</p></li>`); continue; }
    if (line.trim() === '') { closeList(); out.push(''); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  if (inMathBlock) out.push(`<div data-meo-math="block" data-latex="${escapeAttr(mathBuf.join('\n'))}">$$${escapeHtml(mathBuf.join('\n'))}$$</div>`);
  return out.join('');

  function openList(kind: 'ul' | 'ol' | 'task') {
    if (inList === kind) return;
    if (inList) out.push(closeTag(inList));
    out.push(openTag(kind));
    inList = kind;
  }
  function closeList() {
    if (inList) { out.push(closeTag(inList)); inList = null; }
  }
  function openTag(kind: 'ul' | 'ol' | 'task'): string {
    if (kind === 'task') return '<ul data-type="taskList">';
    return `<${kind}>`;
  }
  function closeTag(kind: 'ul' | 'ol' | 'task'): string {
    return kind === 'task' ? '</ul>' : `</${kind}>`;
  }
}

/** Parse a GFM table starting at `lines[start]`. Returns the rendered HTML and the index AFTER the table. */
function consumeTable(lines: string[], start: number): { html: string; nextIndex: number } {
  const splitRow = (raw: string): string[] => {
    let s = raw.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  };
  const headerCells = splitRow(lines[start]);
  // Skip the separator line.
  let i = start + 2;
  const rows: string[][] = [];
  while (i < lines.length) {
    const row = lines[i];
    if (!/^\s*\|.*\|\s*$/.test(row)) break;
    rows.push(splitRow(row));
    i++;
  }
  const headHtml = headerCells.map((c) => `<th><p>${inline(c)}</p></th>`).join('');
  const bodyHtml = rows
    .map((r) => `<tr>${r.map((c) => `<td><p>${inline(c)}</p></td>`).join('')}</tr>`)
    .join('');
  return {
    html: `<table><tbody><tr>${headHtml}</tr>${bodyHtml}</tbody></table>`,
    nextIndex: i,
  };
}

function inline(s: string): string {
  // First extract image references so escapeHtml doesn't mangle them.
  // We use a placeholder strategy: replace ![alt](url) with a unique token,
  // run the rest of inline formatting, then re-insert as raw <img> tags.
  const imgs: { alt: string; src: string }[] = [];
  let idx = 0;
  const withImgPlaceholders = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt: string, src: string) => {
    imgs.push({ alt, src });
    return ` IMG${idx++}`;
  });
  const links: { text: string; href: string }[] = [];
  let lidx = 0;
  const withLinks = withImgPlaceholders.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, href: string) => {
    links.push({ text, href });
    return ` LNK${lidx++}`;
  });
  // Inline math: `$x$`. We require a non-whitespace, non-$ char after
  // the opening `$` so currency strings (e.g. "the price is $5") don't
  // get parsed as math.
  const maths: { latex: string }[] = [];
  let midx = 0;
  const withMaths = withLinks.replace(/\$([^\s$][^$\n]*?)\$/g, (_, latex: string) => {
    maths.push({ latex });
    return ` MTH${midx++}`;
  });
  let html = escapeHtml(withMaths)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
  // Re-insert images
  html = html.replace(/ IMG(\d+)/g, (_m, i: string) => {
    const it = imgs[Number(i)];
    const dataId = it.src.startsWith('attachment:')
      ? ` data-attachment-id="${it.src.slice('attachment:'.length)}"`
      : '';
    return `<img src="${escapeAttr(it.src)}" alt="${escapeAttr(it.alt)}"${dataId}>`;
  });
  // Re-insert links
  html = html.replace(/ LNK(\d+)/g, (_m, i: string) => {
    const it = links[Number(i)];
    return `<a href="${escapeAttr(it.href)}">${escapeHtml(it.text)}</a>`;
  });
  // Re-insert inline math
  html = html.replace(/ MTH(\d+)/g, (_m, i: string) => {
    const it = maths[Number(i)];
    return `<span data-meo-math="inline" data-latex="${escapeAttr(it.latex)}">$${escapeHtml(it.latex)}$</span>`;
  });
  return html;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownFromHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  return walk(doc.body.firstChild!).trim();
}

function walk(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const inner = Array.from(el.childNodes).map(walk).join('');
  switch (el.tagName.toLowerCase()) {
    case 'h1': return `\n# ${inner}\n`;
    case 'h2': return `\n## ${inner}\n`;
    case 'h3': return `\n### ${inner}\n`;
    case 'h4': return `\n#### ${inner}\n`;
    case 'h5': return `\n##### ${inner}\n`;
    case 'h6': return `\n###### ${inner}\n`;
    case 'p': return `\n${inner}\n`;
    case 'strong': case 'b': return `**${inner}**`;
    case 'em': case 'i': return `*${inner}*`;
    case 's': case 'strike': case 'del': return `~~${inner}~~`;
    case 'code':
      if (el.parentElement?.tagName.toLowerCase() === 'pre') return inner;
      return `\`${inner}\``;
    case 'pre': {
      // Mermaid fence — `<pre data-meo-mermaid="true">` round-trips
      // back to a ```mermaid block so the source is preserved.
      if (el.getAttribute('data-meo-mermaid') === 'true') {
        const code = el.querySelector('code');
        const src = (code ? code.textContent : el.textContent) ?? '';
        return `\n\`\`\`mermaid\n${src.replace(/\n+$/, '')}\n\`\`\`\n`;
      }
      return `\n\`\`\`\n${inner.trim()}\n\`\`\`\n`;
    }
    // Block math: `<div data-meo-math="block" data-latex="…">` →
    // `$$…$$` on its own line.
    case 'div': {
      if (el.getAttribute('data-meo-math') === 'block') {
        const latex = el.getAttribute('data-latex') ?? '';
        return `\n$$\n${latex}\n$$\n`;
      }
      return inner;
    }
    case 'span': {
      // Inline math: `<span data-meo-math="inline" data-latex="…">` → `$…$`
      if (el.getAttribute('data-meo-math') === 'inline') {
        const latex = el.getAttribute('data-latex') ?? '';
        return `$${latex}$`;
      }
      return inner;
    }
    // ── GFM tables ──
    case 'table': {
      // TipTap renders tables as `<table><tbody><tr>...</tr></tbody></table>`.
      // The first <tr> holds <th>s in our convention; the rest are body rows.
      const rows = Array.from(el.querySelectorAll('tr'));
      if (rows.length === 0) return '';
      const cellText = (cell: Element) => walk(cell).replace(/\n+/g, ' ').trim() || ' ';
      const headerRow = rows[0];
      const headerCells = Array.from(headerRow.children).map((c) => cellText(c));
      const widths = headerCells.map(() => 3);
      const lines: string[] = [];
      lines.push('| ' + headerCells.join(' | ') + ' |');
      lines.push('|' + widths.map(() => ' --- ').join('|') + '|');
      for (let r = 1; r < rows.length; r++) {
        const cells = Array.from(rows[r].children).map((c) => cellText(c));
        // Pad shorter rows so the table stays valid GFM.
        while (cells.length < headerCells.length) cells.push(' ');
        lines.push('| ' + cells.join(' | ') + ' |');
      }
      return '\n' + lines.join('\n') + '\n';
    }
    case 'tbody': case 'thead': case 'tr': case 'td': case 'th': return inner;
    case 'blockquote': return inner.split('\n').filter(Boolean).map(l => `> ${l.replace(/^\s+/, '')}`).join('\n') + '\n';
    case 'ul': {
      // Task list — TipTap marks <ul> with data-type="taskList".
      if (el.getAttribute('data-type') === 'taskList') {
        const items = Array.from(el.children).map(li => {
          const checked = li.getAttribute('data-checked') === 'true';
          // Each task item is `<li data-type="taskItem"><label><input>…</label><div><p>TEXT</p></div></li>`
          // We pull text from the `<div>` content only (skip the checkbox label).
          const body = Array.from(li.children)
            .filter(c => c.tagName.toLowerCase() !== 'label')
            .map(walk).join('').trim();
          return `- [${checked ? 'x' : ' '}] ${body}`;
        }).join('\n');
        return `\n${items}\n`;
      }
      const items = Array.from(el.children).map(li => `- ${walk(li).trim()}`).join('\n');
      return `\n${items}\n`;
    }
    case 'ol': {
      const items = Array.from(el.children).map((li, i) => `${i + 1}. ${walk(li).trim()}`).join('\n');
      return `\n${items}\n`;
    }
    case 'li': return inner.trim();
    // Skip rendering of the checkbox label inside taskItems (handled above).
    case 'label': case 'input': return '';
    case 'hr': return `\n---\n`;
    case 'br': return `\n`;
    case 'img': {
      // Prefer the data-attachment-id roundtrip when present so the
      // markdown form survives even if the renderer rewrote `src` to a
      // blob URL.
      const id = (el as HTMLImageElement).getAttribute('data-attachment-id');
      const alt = (el as HTMLImageElement).getAttribute('alt') ?? '';
      const src = id
        ? `attachment:${id}`
        : ((el as HTMLImageElement).getAttribute('src') ?? '');
      return `![${alt}](${src})`;
    }
    case 'video':
    case 'audio': {
      // Round-trip as raw HTML in markdown. CommonMark passes inline HTML
      // through unchanged, so writing `<video src="..." controls></video>`
      // on its own line is portable.
      const tag = el.tagName.toLowerCase();
      const id = (el as HTMLElement).getAttribute('data-attachment-id');
      const src = id
        ? `attachment:${id}`
        : ((el as HTMLElement).getAttribute('src') ?? '');
      // Always emit `controls` so the saved markdown stays interactive
      // when re-opened on another client; the renderer NodeView also
      // forces it.
      const dataAttr = id ? ` data-attachment-id="${id}"` : '';
      return `\n<${tag} src="${escapeAttr(src)}" controls${dataAttr}></${tag}>\n`;
    }
    case 'a': {
      const href = (el as HTMLAnchorElement).getAttribute('href') ?? '';
      return `[${inner}](${href})`;
    }
    default: return inner;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Find / highlight helpers
// ──────────────────────────────────────────────────────────────────────

// Build an HTML string that overlays match highlights on top of the
// source-pane textarea. The textarea text is invisible (color:transparent
// via CSS) but the overlay div uses identical font and padding so the
// `<mark>` boxes line up with the underlying characters.
function highlightOverlay(text: string, query: string, currentIndex: number): string {
  if (!query) return escapeHtmlOverlay(text);
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const out: string[] = [];
  let i = 0;
  let hitIndex = 0;
  while (i < text.length) {
    const at = lower.indexOf(q, i);
    if (at < 0) { out.push(escapeHtmlOverlay(text.slice(i))); break; }
    out.push(escapeHtmlOverlay(text.slice(i, at)));
    const cls = hitIndex === currentIndex ? ' class="current"' : '';
    out.push(`<mark${cls}>${escapeHtmlOverlay(text.slice(at, at + q.length))}</mark>`);
    i = at + Math.max(1, q.length);
    hitIndex++;
  }
  return out.join('');
}

// Standard HTML escape, plus we leave whitespace (incl. newlines) intact
// so the overlay layout matches the textarea's wrapping exactly.
function escapeHtmlOverlay(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ──────────────────────────────────────────────────────────────────────
// Proofread diff — a tiny word-level LCS so the bubble can show what
// the model actually changed. Insertions get a green tint, deletions
// get a red strikethrough. Sufficient for at-a-glance review without
// pulling in a full diff lib.
// ──────────────────────────────────────────────────────────────────────

function ProofreadDiff({ before, after }: { before: string; after: string }) {
  const tokens = useMemo(() => diffWords(before.trim(), after.trim()), [before, after]);
  return (
    <>
      {tokens.map((t, i) => {
        if (t.kind === 'eq') return <React.Fragment key={i}>{t.text}</React.Fragment>;
        if (t.kind === 'add') return <span key={i} className="diff-add">{t.text}</span>;
        return <span key={i} className="diff-del">{t.text}</span>;
      })}
    </>
  );
}

type DiffTok = { kind: 'eq' | 'add' | 'del'; text: string };

function diffWords(a: string, b: string): DiffTok[] {
  // Tokenize on word boundaries, keeping whitespace as its own tokens
  // so the diff doesn't claim every space changed.
  const tok = (s: string): string[] => s.match(/\s+|\S+/g) ?? [];
  const A = tok(a), B = tok(b);
  // Classic LCS — O(n*m). Notes are small enough that this is fine.
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (A[i] === B[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffTok[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ kind: 'eq', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: A[i] }); i++; }
    else { out.push({ kind: 'add', text: B[j] }); j++; }
  }
  while (i < n) { out.push({ kind: 'del', text: A[i++] }); }
  while (j < m) { out.push({ kind: 'add', text: B[j++] }); }
  // Coalesce consecutive same-kind runs for cleaner DOM.
  const coalesced: DiffTok[] = [];
  for (const t of out) {
    const last = coalesced[coalesced.length - 1];
    if (last && last.kind === t.kind) last.text += t.text;
    else coalesced.push({ ...t });
  }
  return coalesced;
}

// ──────────────────────────────────────────────────────────────────────
// Media insert modal — small URL-or-file picker for the Video / Audio
// toolbar buttons. URL inserts render as a raw <video>/<audio> tag in
// the markdown body (CommonMark passes raw HTML through). File picks
// reuse the existing E2EE attachment pipeline.
// ──────────────────────────────────────────────────────────────────────

function MediaInsertModal({
  kind, onClose, onPickFile, onSubmitUrl,
}: {
  kind: 'video' | 'audio';
  onClose: () => void;
  onPickFile: () => void;
  onSubmitUrl: (url: string) => void;
}) {
  const [tab, setTab] = useState<'url' | 'file'>('url');
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, [tab]);

  const submit = () => {
    if (!url.trim()) return;
    onSubmitUrl(url.trim());
  };

  const labelKind = kind === 'video' ? 'Video' : 'Audio';

  return (
    <div className="media-modal-overlay" onMouseDown={onClose} role="dialog" aria-modal>
      <div className="media-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="media-modal-header">
          <h3>Insert {labelKind}</h3>
          <button type="button" className="media-modal-close" onClick={onClose}>
            <Icon.X size={12} />
          </button>
        </div>
        <div className="media-modal-tabs">
          <button
            type="button"
            className={tab === 'url' ? 'on' : ''}
            onClick={() => setTab('url')}
          >From URL</button>
          <button
            type="button"
            className={tab === 'file' ? 'on' : ''}
            onClick={() => setTab('file')}
          >From file</button>
        </div>
        {tab === 'url' && (
          <div className="media-modal-body">
            <label>
              <span>{labelKind} URL</span>
              <input
                ref={inputRef}
                type="url"
                placeholder={kind === 'video' ? 'https://example.com/clip.mp4' : 'https://example.com/track.mp3'}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); submit(); }
                  if (e.key === 'Escape') { e.preventDefault(); onClose(); }
                }}
              />
            </label>
            <p className="media-modal-hint">
              The URL is stored as plain text in your note — no upload, no encryption.
              Paste links from the open web or your own server.
            </p>
            <div className="media-modal-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary" onClick={submit} disabled={!url.trim()}>
                Insert
              </button>
            </div>
          </div>
        )}
        {tab === 'file' && (
          <div className="media-modal-body">
            <p className="media-modal-hint">
              Upload a {kind} file. It's encrypted on your device before upload — the server never sees the bytes or filename.
              Accepted: {kind === 'video' ? 'mp4, webm, mov, ogv' : 'mp3, wav, m4a, ogg, flac'}.
            </p>
            <div className="media-modal-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary" onClick={onPickFile}>
                Choose file…
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
