import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor as TipTapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import type { Note } from '@meo/shared';
import { ATTACHMENT_URL_PREFIX, MAX_ATTACHMENT_BYTES } from '@meo/shared';
import { Icon } from './Icon';
import { SlashMenu } from './SlashMenu';
import { AttachmentImageExtension, makeAttachmentsClient } from './AttachmentRenderer';

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
  const [uploadStatus, setUploadStatus] = useState<{ kind: 'idle' } | { kind: 'busy'; filename: string } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const [dropActive, setDropActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [
      // Disable any built-in image so our AttachmentImageExtension owns the
      // 'image' name. (StarterKit doesn't include images by default at the
      // time of this writing, but be defensive.)
      StarterKit.configure({}),
      Placeholder.configure({ placeholder: 'Start writing in markdown' }),
      AttachmentImageExtension,
    ],
    content: htmlFromMarkdown(note.body),
    onUpdate: ({ editor }) => {
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
    for (const file of list) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setUploadStatus({
          kind: 'error',
          message: `${file.name} is larger than ${(MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0)} MiB`,
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
        const isImage = (file.type || '').startsWith('image/');
        if (isImage) {
          editor.chain().focus().insertContent({
            type: 'image',
            attrs: {
              src: attachmentUrl,
              alt: file.name,
              'data-attachment-id': result.id,
            },
          }).run();
        } else {
          // For non-image attachments, drop a markdown-style link so the
          // editor body still round-trips.
          editor.chain().focus().insertContent(`[${file.name}](${attachmentUrl})`).run();
        }
        setUploadStatus({ kind: 'idle' });
      } catch (e: any) {
        console.error('attachment upload failed', e);
        setUploadStatus({ kind: 'error', message: String(e?.message ?? e) });
      }
    }
  }, [editor, noteId]);

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

      <Toolbar
        editor={editor}
        mode={mode}
        setMode={setMode}
        onPickAttachment={() => fileInputRef.current?.click()}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) void handleAttachmentFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <div
        className={`editor-body ${mode === 'split' ? 'split' : ''}${dropActive ? ' drop-active' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
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

      {uploadStatus.kind !== 'idle' && (
        <div className={`upload-banner ${uploadStatus.kind}`}>
          {uploadStatus.kind === 'busy'
            ? `Encrypting and uploading ${uploadStatus.filename}…`
            : `Upload error: ${uploadStatus.message}`}
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
  editor, mode, setMode, onPickAttachment,
}: {
  editor: TipTapEditor | null;
  mode: EditorMode;
  setMode: (m: EditorMode) => void;
  onPickAttachment: () => void;
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
      <Btn icon={<Icon.Image size={14} />} label="Insert image / file (encrypted upload)"
        onClick={onPickAttachment} />
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
  let html = escapeHtml(withLinks)
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
    case 'a': {
      const href = (el as HTMLAnchorElement).getAttribute('href') ?? '';
      return `[${inner}](${href})`;
    }
    default: return inner;
  }
}
