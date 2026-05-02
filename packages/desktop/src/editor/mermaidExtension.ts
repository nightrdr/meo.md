// Agent 2 - Mermaid diagram block for TipTap.
//
// Approach: a custom Node that mirrors a fenced ```mermaid block in
// markdown. The node holds the source as plain text content; the
// NodeView renders the source and a debounced Mermaid SVG below.
// Errors render as a red placeholder with the message.
//
// Mermaid is heavy (~600 KB). Dynamic-import on first node mount.

import { Node, mergeAttributes } from '@tiptap/react';

let mermaidModulePromise: Promise<any> | null = null;
let mermaidIdCounter = 0;

async function loadMermaid(): Promise<any> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((m) => {
      const mermaid = (m as any).default ?? m;
      const isDark = document.documentElement.classList.contains('dark') ||
        window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? 'dark' : 'default',
        securityLevel: 'loose',
      });
      return mermaid;
    });
  }
  return mermaidModulePromise;
}

/**
 * Block-level mermaid node - markdown shape: ```mermaid …```
 *
 * Stored as `<pre data-meo-mermaid="true"><code>SOURCE</code></pre>`
 * in serialized HTML, but the editor body uses a NodeView so the
 * user sees rendered SVG plus an editable source pane.
 */
export const Mermaid = Node.create({
  name: 'mermaid',
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,

  addAttributes() {
    return {
      source: {
        default: '',
        parseHTML: (el) => {
          const code = el.querySelector('code');
          return code ? code.textContent ?? '' : el.textContent ?? '';
        },
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'pre[data-meo-mermaid]' },
      { tag: 'pre.meo-mermaid' },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, {
        class: 'meo-mermaid',
        'data-meo-mermaid': 'true',
      }),
      ['code', {}, node.attrs.source ?? ''],
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const wrap = document.createElement('div');
      wrap.className = 'meo-mermaid-block';
      wrap.setAttribute('contenteditable', 'false');

      const ta = document.createElement('textarea');
      ta.className = 'meo-mermaid-source';
      ta.value = node.attrs.source ?? '';
      ta.spellcheck = false;
      ta.rows = Math.max(3, (node.attrs.source ?? '').split('\n').length);

      const out = document.createElement('div');
      out.className = 'meo-mermaid-output';

      wrap.appendChild(ta);
      wrap.appendChild(out);

      let renderTimer: number | undefined;
      const render = (src: string) => {
        if (renderTimer) window.clearTimeout(renderTimer);
        renderTimer = window.setTimeout(async () => {
          out.textContent = '';
          if (!src.trim()) {
            out.innerHTML = '<div class="meo-mermaid-empty">Empty diagram</div>';
            return;
          }
          try {
            const mermaid = await loadMermaid();
            const id = `meo-mermaid-${++mermaidIdCounter}`;
            const { svg } = await mermaid.render(id, src);
            out.innerHTML = svg;
          } catch (e: any) {
            out.innerHTML = `<div class="meo-mermaid-error">${escapeHtml(
              e?.message ?? String(e),
            )}</div>`;
          }
        }, 250);
      };

      // Initial render.
      render(ta.value);

      ta.addEventListener('input', () => {
        const src = ta.value;
        render(src);
        if (typeof getPos === 'function') {
          const pos = getPos();
          if (typeof pos === 'number') {
            editor.view.dispatch(
              editor.view.state.tr.setNodeMarkup(pos, undefined, { source: src }),
            );
          }
        }
      });

      return {
        dom: wrap,
        update(updated) {
          if (updated.type.name !== 'mermaid') return false;
          if ((updated.attrs.source ?? '') !== ta.value) {
            ta.value = updated.attrs.source ?? '';
            render(ta.value);
          }
          return true;
        },
        destroy() {
          if (renderTimer) window.clearTimeout(renderTimer);
        },
      };
    };
  },
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
