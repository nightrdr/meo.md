// Agent 2 — note export pipelines.
//
// Five formats, all triggered from the right-click menu and the
// File ▸ Export native menu submenu (Agent 5).
//
//   md   → raw `note.body` (no transform)
//   txt  → markdown stripped of formatting
//   html → standalone HTML document with KaTeX + Mermaid inline
//   docx → markdown rendered through `marked` then mapped to docx
//          paragraphs / runs / headings (basic but readable)
//   pdf  → opens the OS print dialog on a temporary popup window
//          containing the same standalone HTML as the html exporter
//
// Heavy libs (`marked`, `docx`, `mermaid`, `katex`) load via dynamic
// import so they only enter the bundle when the user actually exports.

import type { Note } from '@meo/shared';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Strip path-unsafe chars from a note title for use as a filename. */
function safeFilename(note: Note, ext: string): string {
  const base = (note.title || 'Untitled').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  return `${base || 'Untitled'}.${ext}`;
}

/** Synthesize an `<a download>` and click it to trigger a browser download. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so the click has fired.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const KATEX_CSS_CDN = 'https://cdn.jsdelivr.net/npm/katex@0.16.45/dist/katex.min.css';
const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

/** Render markdown to HTML using `marked` + KaTeX + Mermaid pre-blocks. */
async function renderMarkdownToHtml(md: string): Promise<string> {
  const [{ Marked }, { default: markedKatex }] = await Promise.all([
    import('marked'),
    import('marked-katex-extension'),
  ]);
  const m = new Marked();
  m.use(markedKatex({ throwOnError: false, displayMode: false }) as any);
  // Mermaid extension — turn ```mermaid blocks into <pre class="mermaid">…</pre>.
  m.use({
    renderer: {
      code({ text, lang }: { text: string; lang?: string | null }) {
        if (lang === 'mermaid') {
          return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
        }
        return false as any;
      },
    },
  } as any);
  return m.parse(md, { async: false, breaks: true, gfm: true }) as string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build a fully self-contained HTML document for a note. */
async function buildStandaloneHtml(note: Note): Promise<string> {
  const body = await renderMarkdownToHtml(note.body || '');
  const title = note.title || 'Untitled';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${KATEX_CSS_CDN}" crossorigin="anonymous">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         max-width: 760px; margin: 2.5rem auto; padding: 0 1rem;
         color: #1f1c17; line-height: 1.6; font-size: 15px; }
  h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; margin-top: 1.5em; }
  h1 { font-size: 2em; border-bottom: 1px solid #e5e0d6; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #e5e0d6; padding-bottom: 0.3em; }
  pre { background: #f6f2ea; padding: 1em; border-radius: 6px; overflow-x: auto; }
  pre.mermaid { background: transparent; text-align: center; }
  code { background: #f6f2ea; padding: 0.15em 0.35em; border-radius: 3px;
         font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  pre code { padding: 0; background: transparent; }
  blockquote { border-left: 4px solid #c8c1b3; margin: 1em 0; padding: 0.4em 1em;
               color: #555; background: #f9f6f0; }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #c8c1b3; padding: 0.5em 0.9em; text-align: left; }
  th { background: #f6f2ea; }
  hr { border: 0; border-top: 1px solid #c8c1b3; margin: 2em 0; }
  img { max-width: 100%; height: auto; }
  @media print {
    body { margin: 0; padding: 1cm; max-width: none; }
    pre { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
<script type="module">
  import mermaid from '${MERMAID_CDN}';
  mermaid.initialize({ startOnLoad: true, theme: 'default', securityLevel: 'loose' });
</script>
</body>
</html>`;
}

// ────────────────────────────────────────────────────────────────────
// Exporters
// ────────────────────────────────────────────────────────────────────

/** Markdown — dump `note.body` verbatim. */
export async function exportNoteAsMarkdown(note: Note): Promise<void> {
  const blob = new Blob([note.body || ''], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, safeFilename(note, 'md'));
}

/** Plain text — strip markdown formatting. */
export async function exportNoteAsTXT(note: Note): Promise<void> {
  const txt = (note.body || '')
    // Code fences
    .replace(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/gm, '$1')
    // Block math
    .replace(/^\$\$\n?([\s\S]*?)\n?\$\$$/gm, '$1')
    // Headings
    .replace(/^#{1,6}\s+/gm, '')
    // Blockquote markers
    .replace(/^>\s?/gm, '')
    // Lists
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // Hr
    .replace(/^-{3,}$/gm, '')
    // Tables: drop pipe rows + separator lines.
    .replace(/^\s*\|.*\|\s*$/gm, (m) => /^\s*\|?\s*:?-+:?/.test(m) ? '' : m.replace(/\|/g, ' ').trim())
    // Inline math
    .replace(/\$([^\s$][^$\n]*?)\$/g, '$1')
    // Inline images / links
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Inline emphasis
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    // Collapse 3+ blank lines
    .replace(/\n{3,}/g, '\n\n');
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, safeFilename(note, 'txt'));
}

/** HTML — standalone document. */
export async function exportNoteAsHTML(note: Note): Promise<void> {
  const html = await buildStandaloneHtml(note);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  downloadBlob(blob, safeFilename(note, 'html'));
}

/**
 * PDF — open a popup with the standalone HTML and immediately call
 * `print()`, leaving the user to "Save as PDF" in the system dialog.
 *
 * This is the v1 approach the spec asks for. It avoids bundling
 * `pdfjs-dist` (~2 MB) and works identically on macOS / Windows /
 * Linux because every OS provides a Save-as-PDF print sink.
 */
export async function exportNoteAsPDF(note: Note): Promise<void> {
  const html = await buildStandaloneHtml(note);
  // Try a popup first; if the popup is blocked, fall back to opening
  // a Blob URL in the same tab and letting the user trigger print
  // from there.
  const w = window.open('', '_blank', 'width=900,height=1200');
  if (w) {
    w.document.open();
    w.document.write(html);
    w.document.close();
    // Wait for Mermaid + KaTeX to settle, then print.
    setTimeout(() => {
      try { w.focus(); w.print(); } catch { /* user can print manually */ }
    }, 1200);
    return;
  }
  // Popup blocked — download the HTML and prompt the user to print it.
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  downloadBlob(blob, safeFilename(note, 'html'));
  // eslint-disable-next-line no-alert
  alert('Pop-up blocked — saved as HTML instead. Open it and use your browser to "Save as PDF".');
}

/**
 * DOCX — basic markdown → docx via the `docx` package.
 *
 * We re-use `marked` to lex the markdown into tokens, then map each
 * token type to a docx Paragraph / Run / Heading / Table. This is
 * intentionally simple — perfect fidelity is a follow-up. Math and
 * mermaid render as monospace fenced blocks (the math source / the
 * diagram source) since neither library produces a native docx
 * primitive.
 */
export async function exportNoteAsDOCX(note: Note): Promise<void> {
  const [
    { Document, Packer, Paragraph, TextRun, HeadingLevel,
      AlignmentType, Table, TableRow, TableCell, WidthType },
    { Marked },
  ] = await Promise.all([
    import('docx'),
    import('marked'),
  ]);
  const m = new Marked();
  const tokens = m.lexer(note.body || '');

  // Walk inline tokens (bold/italic/code/links) into `TextRun`s.
  // We try `m.lexer.inlineTokens(text)` first, but in some marked
  // versions only the static class method is available; we fall back
  // to a fresh-paragraph parse and pull its tokens out.
  const inlineRuns = (text: string): InstanceType<typeof TextRun>[] => {
    let tokens: any[] = [];
    try {
      const inlineFn = (m as any).Lexer?.lex && (m as any).Lexer?.lex(text)?.[0]?.tokens;
      if (inlineFn) tokens = inlineFn;
    } catch { /* fall through */ }
    if (tokens.length === 0) {
      try {
        const block = m.lexer(text) as any[];
        const para = block.find((t) => t.type === 'paragraph');
        if (para?.tokens) tokens = para.tokens;
      } catch { /* fall through */ }
    }
    if (tokens.length === 0) tokens = [{ type: 'text', text }];
    const out: InstanceType<typeof TextRun>[] = [];
    walkInline(tokens, {}, out);
    return out.length > 0 ? out : [new TextRun(text)];

    function walkInline(toks: any[], state: any, out: InstanceType<typeof TextRun>[]) {
      for (const t of toks) {
        const tt = t.type;
        if (tt === 'strong')
          walkInline(t.tokens || [], { ...state, bold: true }, out);
        else if (tt === 'em')
          walkInline(t.tokens || [], { ...state, italics: true }, out);
        else if (tt === 'del')
          walkInline(t.tokens || [], { ...state, strike: true }, out);
        else if (tt === 'codespan')
          out.push(new TextRun({ text: t.text, font: 'Menlo', ...state }));
        else if (tt === 'link') {
          walkInline(t.tokens || [{ type: 'text', text: t.text }], state, out);
          out.push(new TextRun({ text: ` (${t.href})`, color: '666666', ...state }));
        } else if (tt === 'br') {
          out.push(new TextRun({ text: '', break: 1, ...state }));
        } else if (t.tokens) {
          walkInline(t.tokens, state, out);
        } else {
          out.push(new TextRun({ text: t.text ?? t.raw ?? '', ...state }));
        }
      }
    }
  };

  // Map each block token to one or more docx paragraphs.
  const children: any[] = [];
  for (const tok of tokens as any[]) {
    switch (tok.type) {
      case 'heading': {
        const level: any = ([
          HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
          HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
        ])[Math.min(5, Math.max(0, tok.depth - 1))];
        children.push(new Paragraph({
          heading: level,
          children: inlineRuns(tok.text),
        }));
        break;
      }
      case 'paragraph': {
        children.push(new Paragraph({ children: inlineRuns(tok.text) }));
        break;
      }
      case 'blockquote': {
        const inner = (tok.tokens ?? []).flatMap((sub: any) =>
          sub.type === 'paragraph' ? [sub.text] : []);
        for (const p of inner) {
          children.push(new Paragraph({
            indent: { left: 720 },
            children: inlineRuns(p),
          }));
        }
        break;
      }
      case 'code': {
        const lines = (tok.text ?? '').split('\n');
        for (const line of lines) {
          children.push(new Paragraph({
            children: [new TextRun({ text: line, font: 'Menlo' })],
            shading: { type: 'solid', color: 'F6F2EA', fill: 'F6F2EA' },
          }));
        }
        break;
      }
      case 'list': {
        for (const item of tok.items as any[]) {
          children.push(new Paragraph({
            bullet: tok.ordered ? undefined : { level: 0 },
            numbering: tok.ordered ? { reference: 'numbers', level: 0 } : undefined,
            children: inlineRuns(item.text),
          }));
        }
        break;
      }
      case 'hr': {
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: '────────────────', color: '999999' })],
        }));
        break;
      }
      case 'table': {
        const header = new TableRow({
          children: tok.header.map((cell: any) =>
            new TableCell({
              children: [new Paragraph({ children: inlineRuns(cell.text ?? '') })],
              width: { size: 100 / tok.header.length, type: WidthType.PERCENTAGE },
              shading: { type: 'solid', color: 'F6F2EA', fill: 'F6F2EA' },
            }),
          ),
        });
        const rows = (tok.rows as any[]).map((row) => new TableRow({
          children: row.map((cell: any) =>
            new TableCell({
              children: [new Paragraph({ children: inlineRuns(cell.text ?? '') })],
              width: { size: 100 / tok.header.length, type: WidthType.PERCENTAGE },
            }),
          ),
        }));
        children.push(new Table({
          rows: [header, ...rows],
          width: { size: 100, type: WidthType.PERCENTAGE },
        }));
        children.push(new Paragraph({ children: [] }));
        break;
      }
      case 'space':
        children.push(new Paragraph({ children: [] }));
        break;
      default:
        if ((tok as any).text) {
          children.push(new Paragraph({ children: inlineRuns((tok as any).text) }));
        }
    }
  }

  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun('')] }));
  }

  const doc = new Document({
    numbering: {
      config: [{
        reference: 'numbers',
        levels: [{
          level: 0,
          format: 'decimal' as any,
          text: '%1.',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          heading: HeadingLevel.TITLE,
          children: [new TextRun(note.title || 'Untitled')],
        }),
        ...children,
      ],
    }],
  });
  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, safeFilename(note, 'docx'));
}
