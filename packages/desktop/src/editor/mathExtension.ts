// Agent 2 - KaTeX math extensions for TipTap.
//
// Two TipTap nodes:
//   - `mathInline`  - inline `$x$` math, rendered as a non-editable
//                     span containing the KaTeX HTML.
//   - `mathBlock`   - block `$$x$$` math, rendered as a non-editable
//                     div block.
//
// Both store the raw LaTeX source in `latex` attribute and an
// editable text node child so that markdown round-trip can reach the
// source either way. We add NodeViews that swap the visible content
// for KaTeX HTML; clicking the rendered node selects the underlying
// text so the user can re-edit.
//
// KaTeX is heavy (~280 KB). We dynamic-import it so the editor only
// loads it after a math node is inserted/rendered the first time.

import { Node, mergeAttributes } from '@tiptap/react';

let katexModulePromise: Promise<any> | null = null;
let katexCssInjected = false;

/** Load KaTeX once and cache. */
async function loadKatex(): Promise<any> {
  if (!katexModulePromise) {
    katexModulePromise = import('katex').then((m) => (m as any).default ?? m);
    // Inject the KaTeX stylesheet from the bundle (vite serves it as a URL).
    if (!katexCssInjected) {
      katexCssInjected = true;
      try {
        // Side-effect import - vite + esbuild will inline the CSS.
        // @ts-expect-error CSS module side-effect import
        await import('katex/dist/katex.min.css');
      } catch {
        // Fall back to CDN <link> injection if the CSS import fails.
        const id = 'meo-katex-css';
        if (!document.getElementById(id)) {
          const link = document.createElement('link');
          link.id = id;
          link.rel = 'stylesheet';
          link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.45/dist/katex.min.css';
          document.head.appendChild(link);
        }
      }
    }
  }
  return katexModulePromise;
}

/** Render LaTeX to an HTMLElement. Errors render as a red placeholder. */
function renderMath(latex: string, displayMode: boolean): HTMLElement {
  const wrap = document.createElement(displayMode ? 'div' : 'span');
  wrap.className = displayMode ? 'meo-math meo-math-block' : 'meo-math meo-math-inline';
  wrap.setAttribute('data-latex', latex);
  wrap.setAttribute('contenteditable', 'false');
  wrap.textContent = displayMode ? `$$${latex}$$` : `$${latex}$`;
  // Render asynchronously so we don't block the first paint.
  void loadKatex().then((katex) => {
    try {
      wrap.innerHTML = katex.renderToString(latex, {
        displayMode,
        throwOnError: false,
        output: 'html',
      });
    } catch (e: any) {
      wrap.innerHTML = `<span class="meo-math-error">⟂ ${escapeHtml(e?.message ?? String(e))}</span>`;
    }
  });
  return wrap;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline math: `$x$`. */
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) =>
          el.getAttribute('data-latex') ?? (el.textContent ?? '').replace(/^\$|\$$/g, ''),
        renderHTML: (attrs) => ({ 'data-latex': attrs.latex }),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span.meo-math-inline' },
      { tag: 'span[data-meo-math="inline"]' },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'meo-math meo-math-inline',
        'data-meo-math': 'inline',
        'data-latex': node.attrs.latex,
      }),
      `$${node.attrs.latex}$`,
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = renderMath(node.attrs.latex || '', false);
      dom.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (typeof getPos === 'function') {
          const pos = getPos();
          if (typeof pos === 'number') {
            editor.commands.setTextSelection({ from: pos, to: pos + node.nodeSize });
          }
        }
      });
      return {
        dom,
        update(updated) {
          if (updated.type.name !== 'mathInline') return false;
          const next = renderMath(updated.attrs.latex || '', false);
          dom.replaceWith(next);
          return false; // not the same DOM ref - let PM rebuild
        },
      };
    };
  },
});

/** Block math: `$$x$$` on its own line. */
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) =>
          el.getAttribute('data-latex') ?? (el.textContent ?? '').replace(/^\$\$|\$\$$/g, ''),
        renderHTML: (attrs) => ({ 'data-latex': attrs.latex }),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'div.meo-math-block' },
      { tag: 'div[data-meo-math="block"]' },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'meo-math meo-math-block',
        'data-meo-math': 'block',
        'data-latex': node.attrs.latex,
      }),
      `$$${node.attrs.latex}$$`,
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = renderMath(node.attrs.latex || '', true);
      dom.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (typeof getPos === 'function') {
          const pos = getPos();
          if (typeof pos === 'number') {
            editor.commands.setTextSelection({ from: pos, to: pos + node.nodeSize });
          }
        }
      });
      return {
        dom,
        update(updated) {
          if (updated.type.name !== 'mathBlock') return false;
          const next = renderMath(updated.attrs.latex || '', true);
          dom.replaceWith(next);
          return false;
        },
      };
    };
  },
});
