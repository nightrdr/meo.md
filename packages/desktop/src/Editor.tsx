import React, { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor as TipTapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import type { Note } from '@meo/shared';
import { Icon } from './Icon';
import { SlashMenu } from './SlashMenu';

interface Props {
  note: Note;
  breadcrumb: string[];
  status: 'idle' | 'syncing' | 'saving' | 'error';
  statusMsg: string;
  wordCount: number;
  modelId: string;
  notes: Map<string, Note>;
  onChange: (next: Note) => void;
  onDelete: () => void;
}

type EditorMode = 'edit' | 'split' | 'preview';

export function Editor({ note, breadcrumb, status, statusMsg, wordCount, modelId, notes, onChange, onDelete }: Props) {
  const lastNoteId = useRef(note.id);
  const [mode, setMode] = useState<EditorMode>('edit');
  const [tagInput, setTagInput] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({}),
      Placeholder.configure({ placeholder: 'Start writing in markdown' }),
    ],
    content: htmlFromMarkdown(note.body),
    onUpdate: ({ editor }) => {
      onChange({ ...note, body: markdownFromHtml(editor.getHTML()) });
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (note.id !== lastNoteId.current) {
      lastNoteId.current = note.id;
      editor.commands.setContent(htmlFromMarkdown(note.body), false);
    }
  }, [note.id, note.body, editor]);

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

      <Toolbar editor={editor} mode={mode} setMode={setMode} />

      <div className={`editor-body ${mode === 'split' ? 'split' : ''}`}>
        {mode === 'split' && (
          <pre className="editor-source">{note.body || ' '}</pre>
        )}
        <div className="editor-canvas" style={{ position: 'relative' }}>
          <EditorContent editor={editor} />

          {/* Slash menu (`/` inside the body opens AI actions) */}
          <SlashMenu editor={editor} note={note} modelId={modelId} notes={notes} onUpdate={onChange} />

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
  editor, mode, setMode,
}: {
  editor: TipTapEditor | null; mode: EditorMode; setMode: (m: EditorMode) => void;
}) {
  if (!editor) return <div className="editor-toolbar" style={{ height: 41 }} />;

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
    <div className="editor-toolbar">
      <Btn
        icon={<Icon.Undo size={14} />}
        label="Undo, ⌘Z"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
      />
      <Btn
        icon={<Icon.Redo size={14} />}
        label="Redo, ⇧⌘Z"
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

      <Btn icon={<Icon.Bold size={14} />} label="Bold, ⌘B"
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()} />
      <Btn icon={<Icon.Italic size={14} />} label="Italic, ⌘I"
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()} />
      <Btn icon={<Icon.Strike size={14} />} label="Strikethrough"
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()} />

      <Sep />

      <Btn icon={<Icon.Link size={14} />} label="Link, ⌘K (paste markdown)"
        onClick={() => {
          const url = prompt('Link URL');
          if (!url) return;
          editor.chain().focus().insertContent(`[${editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) || 'link'}](${url})`).run();
        }} />
      <Btn icon={<Icon.Image size={14} />} label="Image (paste URL)"
        onClick={() => {
          const url = prompt('Image URL');
          if (!url) return;
          editor.chain().focus().insertContent(`![](${url})`).run();
        }} />
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

      <button type="button" title="AI actions, /" className="ai-toolbar-btn">
        <Icon.Sparkle size={14} stroke="var(--ai)" />
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

// --- markdown ↔ HTML translators ---

function htmlFromMarkdown(md: string): string {
  if (!md) return '';
  const lines = md.split('\n');
  const out: string[] = [];
  let inList: null | 'ul' | 'ol' = null;
  let inCode = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('```')) {
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { out.push('<pre><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(escapeHtml(line)); continue; }
    if (line.startsWith('# ')) { closeList(); out.push(`<h1>${inline(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('## ')) { closeList(); out.push(`<h2>${inline(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('### ')) { closeList(); out.push(`<h3>${inline(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('> ')) { closeList(); out.push(`<blockquote><p>${inline(line.slice(2))}</p></blockquote>`); continue; }
    if (/^---+$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    const ulMatch = line.match(/^[-*] (.+)$/);
    const olMatch = line.match(/^\d+\. (.+)$/);
    if (ulMatch) { openList('ul'); out.push(`<li><p>${inline(ulMatch[1])}</p></li>`); continue; }
    if (olMatch) { openList('ol'); out.push(`<li><p>${inline(olMatch[1])}</p></li>`); continue; }
    if (line.trim() === '') { closeList(); out.push(''); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('');

  function openList(kind: 'ul' | 'ol') {
    if (inList === kind) return;
    if (inList) out.push(`</${inList}>`);
    out.push(`<${kind}>`);
    inList = kind;
  }
  function closeList() {
    if (inList) { out.push(`</${inList}>`); inList = null; }
  }
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
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
    case 'pre': return `\n\`\`\`\n${inner.trim()}\n\`\`\`\n`;
    case 'blockquote': return inner.split('\n').filter(Boolean).map(l => `> ${l.replace(/^\s+/, '')}`).join('\n') + '\n';
    case 'ul': {
      const items = Array.from(el.children).map(li => `- ${walk(li).trim()}`).join('\n');
      return `\n${items}\n`;
    }
    case 'ol': {
      const items = Array.from(el.children).map((li, i) => `${i + 1}. ${walk(li).trim()}`).join('\n');
      return `\n${items}\n`;
    }
    case 'li': return inner.trim();
    case 'hr': return `\n---\n`;
    case 'br': return `\n`;
    default: return inner;
  }
}
