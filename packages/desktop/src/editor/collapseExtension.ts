// Agent 4 — Collapse / expand sections by heading rank.
//
// A TipTap extension (`meoCollapse`) that lets the user collapse a
// section in the editor by heading rank. Sections are defined by
// heading hierarchy: H1 > H2 > H3 > H4 > H5 > H6 > paragraph. Collapsing
// a section hides everything between that heading and the next heading
// of *equal or higher* rank. Sub-sections collapse with their parent.
//
// Implementation notes:
//   - The plugin keeps a `Set<number>` of collapsed heading positions
//     (positions in the doc — they shift as content edits). The set
//     is the single source of truth; decorations are derived.
//   - To find the section's range we walk forward from the heading
//     and stop at the first sibling heading whose level is `<=` ours,
//     or at doc end.
//   - Decorations are *node* decorations (`class: meo-collapsed-hidden`)
//     wrapping every block between heading-end and section-end. CSS
//     hides them via `display: none`. The underlying markdown bytes
//     are untouched — round-trip safe.
//   - A widget decoration adds the chevron toggle next to every heading.
//   - Collapsed positions persist per-note via storage `meta`. The
//     parent (Editor.tsx) restores them on note open and snapshots
//     them on change.
//
// Does NOT depend on the find plugin — distinct PluginKey, distinct
// decoration set.

import { Extension } from '@tiptap/react';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface CollapseMeta {
  /** Toggle a heading at this doc position (heading start). */
  toggle?: number;
  /** Replace the entire collapsed set (used on note-open restore). */
  set?: number[];
  /** Collapse all top-level (and equally-ranked) sections. */
  collapseAll?: boolean;
  /** Expand everything. */
  expandAll?: boolean;
}

export interface CollapseState {
  collapsed: Set<number>;
  decos: DecorationSet;
}

export const meoCollapsePluginKey = new PluginKey<CollapseState>('meo-collapse');

/**
 * Find the next heading position whose level is ≤ `level`, starting
 * AFTER the heading at position `headingPos`. Returns the doc end if
 * there is no such heading (i.e. the section runs to the bottom).
 */
function findSectionEnd(doc: PMNode, headingPos: number, level: number): number {
  const heading = doc.nodeAt(headingPos);
  if (!heading || heading.type.name !== 'heading') return doc.content.size;
  let end = doc.content.size;
  let foundEnd = false;
  doc.descendants((node, pos) => {
    if (foundEnd) return false;
    if (pos <= headingPos) return false; // skip self + don't descend into it
    if (node.type.name === 'heading') {
      const lvl = (node.attrs?.level as number) ?? 1;
      if (lvl <= level) {
        end = pos;
        foundEnd = true;
      }
      return false; // never descend into heading text
    }
    return false; // only walk top-level blocks
  });
  return end;
}

/** Build the decoration set from the current collapsed set. */
function buildDecorations(doc: PMNode, collapsed: Set<number>): DecorationSet {
  const decos: Decoration[] = [];
  // Collect (pos, node) for every heading once — cheaper than descending
  // the tree multiple times.
  const headings: { pos: number; level: number; node: PMNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      headings.push({ pos, level: (node.attrs?.level as number) ?? 1, node });
      return false; // don't descend into headings
    }
    return true;
  });

  // Toggle widgets for every heading (always shown — CSS hover controls
  // visibility). The widget element captures clicks and dispatches a
  // toggle transaction.
  for (const h of headings) {
    const isCollapsed = collapsed.has(h.pos);
    decos.push(
      Decoration.widget(
        h.pos + 1,
        (view) => makeChevron(view, h.pos, isCollapsed),
        { side: -1, key: `chev:${h.pos}:${isCollapsed ? 1 : 0}`, ignoreSelection: true },
      ),
    );
  }

  // For every COLLAPSED heading, hide everything from heading-end to
  // section-end. We find the section end by skipping any nested
  // collapsed headings — but a single inline decoration covering the
  // whole range with `display: none` does that automatically because
  // the children are inside the hidden block.
  for (const pos of collapsed) {
    const h = headings.find(x => x.pos === pos);
    if (!h) continue; // stale position (heading was deleted) — ignore
    const headingEnd = pos + h.node.nodeSize;
    const sectionEnd = findSectionEnd(doc, pos, h.level);
    if (sectionEnd <= headingEnd) continue;
    // Use an inline decoration with display:none on a wrapper span.
    // Inline decorations can span block boundaries when applied as
    // `inclusiveStart/inclusiveEnd` and rendered through CSS.
    decos.push(
      Decoration.inline(headingEnd, sectionEnd, { class: 'meo-collapsed-hidden' }),
    );
    // Pill / "N items hidden" hint as a widget right after the heading.
    const hiddenCount = countTopLevelChildren(doc, headingEnd, sectionEnd);
    decos.push(
      Decoration.widget(headingEnd, () => makePill(hiddenCount), {
        side: 1, key: `pill:${pos}:${hiddenCount}`, ignoreSelection: true,
      }),
    );
  }

  return DecorationSet.create(doc, decos);
}

/** Count the top-level block children inside [from, to). */
function countTopLevelChildren(doc: PMNode, from: number, to: number): number {
  let count = 0;
  doc.nodesBetween(from, to, (_node, pos) => {
    // Only count direct doc children — depth 1 — by checking that
    // the node's parent is the doc. Cheap proxy: any block whose
    // start position equals the start of a top-level slice.
    if (pos >= from && pos < to) {
      const $ = doc.resolve(pos + 1);
      if ($.depth === 1) count++;
    }
    return false; // don't descend
  });
  return count;
}

function makeChevron(view: EditorView, headingPos: number, isCollapsed: boolean): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'meo-collapse-toggle' + (isCollapsed ? ' collapsed' : '');
  btn.setAttribute('contenteditable', 'false');
  btn.setAttribute('tabindex', '-1');
  btn.title = isCollapsed ? 'Expand section' : 'Collapse section';
  btn.innerHTML =
    '<svg class="chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    view.dispatch(view.state.tr.setMeta(meoCollapsePluginKey, { toggle: headingPos } as CollapseMeta));
  });
  return btn;
}

function makePill(n: number): HTMLElement {
  const span = document.createElement('span');
  span.className = 'meo-collapsed-pill';
  span.setAttribute('contenteditable', 'false');
  span.textContent = `${n} ${n === 1 ? 'item' : 'items'} hidden`;
  return span;
}

/**
 * Map collapsed positions through a transaction's mapping, dropping
 * any that no longer point at a heading.
 */
function remap(prev: Set<number>, tr: Transaction): Set<number> {
  if (!tr.docChanged) return prev;
  const next = new Set<number>();
  for (const pos of prev) {
    const mapped = tr.mapping.map(pos, -1);
    const node = tr.doc.nodeAt(mapped);
    if (node && node.type.name === 'heading') next.add(mapped);
  }
  return next;
}

export const MeoCollapseExtension = Extension.create({
  name: 'meoCollapse',
  addProseMirrorPlugins() {
    return [
      new Plugin<CollapseState>({
        key: meoCollapsePluginKey,
        state: {
          init: (_cfg, state) => ({
            collapsed: new Set<number>(),
            decos: buildDecorations(state.doc, new Set<number>()),
          }),
          apply(tr, prev) {
            const meta = tr.getMeta(meoCollapsePluginKey) as CollapseMeta | undefined;
            let collapsed = remap(prev.collapsed, tr);
            let changed = collapsed !== prev.collapsed;
            if (meta) {
              if (meta.set !== undefined) {
                // Restore from persistence — filter to positions that
                // actually point at a heading right now.
                const next = new Set<number>();
                for (const pos of meta.set) {
                  const node = tr.doc.nodeAt(pos);
                  if (node && node.type.name === 'heading') next.add(pos);
                }
                collapsed = next;
                changed = true;
              }
              if (meta.toggle !== undefined) {
                const pos = meta.toggle;
                const next = new Set(collapsed);
                if (next.has(pos)) next.delete(pos); else next.add(pos);
                collapsed = next;
                changed = true;
              }
              if (meta.expandAll) {
                if (collapsed.size > 0) { collapsed = new Set(); changed = true; }
              }
              if (meta.collapseAll) {
                // Collapse every heading at the *minimum* level present.
                let minLvl = 7;
                tr.doc.descendants((node) => {
                  if (node.type.name === 'heading') {
                    const lvl = (node.attrs?.level as number) ?? 1;
                    if (lvl < minLvl) minLvl = lvl;
                    return false;
                  }
                  return true;
                });
                if (minLvl <= 6) {
                  const next = new Set<number>();
                  tr.doc.descendants((node, pos) => {
                    if (node.type.name === 'heading') {
                      const lvl = (node.attrs?.level as number) ?? 1;
                      if (lvl === minLvl) next.add(pos);
                      return false;
                    }
                    return true;
                  });
                  collapsed = next;
                  changed = true;
                }
              }
            }
            if (!changed && !tr.docChanged) return prev;
            return {
              collapsed,
              decos: buildDecorations(tr.doc, collapsed),
            };
          },
        },
        props: {
          decorations(state) {
            return meoCollapsePluginKey.getState(state)?.decos;
          },
        },
      }),
    ];
  },
});

// ─── Public helpers (Editor.tsx wires these to keyboard shortcuts /
//     menu events) ────────────────────────────────────────────────

/** Find the nearest preceding heading position from the current selection. */
export function nearestHeadingPos(state: EditorState): number | null {
  const { from } = state.selection;
  let found: number | null = null;
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      if (pos <= from) found = pos;
      else return false; // stop descending forward
      return false;
    }
    return true;
  });
  return found;
}

export function getCollapsedSet(state: EditorState): Set<number> {
  return meoCollapsePluginKey.getState(state)?.collapsed ?? new Set<number>();
}

export function dispatchCollapseMeta(view: EditorView, meta: CollapseMeta): void {
  view.dispatch(view.state.tr.setMeta(meoCollapsePluginKey, meta));
}

/** Convenience wrappers used by Editor.tsx + menu handlers. */
export function collapseCurrentSection(view: EditorView): boolean {
  const headingPos = nearestHeadingPos(view.state);
  if (headingPos == null) return false;
  const set = getCollapsedSet(view.state);
  if (set.has(headingPos)) return false; // already collapsed
  dispatchCollapseMeta(view, { toggle: headingPos });
  return true;
}

export function expandCurrentSection(view: EditorView): boolean {
  const headingPos = nearestHeadingPos(view.state);
  if (headingPos == null) return false;
  const set = getCollapsedSet(view.state);
  if (!set.has(headingPos)) return false;
  dispatchCollapseMeta(view, { toggle: headingPos });
  return true;
}

export function collapseAllSections(view: EditorView): void {
  dispatchCollapseMeta(view, { collapseAll: true });
}

export function expandAllSections(view: EditorView): void {
  dispatchCollapseMeta(view, { expandAll: true });
}

export function restoreCollapsed(view: EditorView, positions: number[]): void {
  dispatchCollapseMeta(view, { set: positions });
}

/**
 * A heading is identified across save/load by a stable string anchor:
 *   `<level>:<line-text-trimmed-lowercased>`
 * Per-note we persist a list of these. On note open we look up each
 * anchor in the current doc and re-collapse the matching headings.
 */
export function anchorsFromState(state: EditorState): string[] {
  const collapsed = getCollapsedSet(state);
  const out: string[] = [];
  for (const pos of collapsed) {
    const node = state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'heading') continue;
    const level = (node.attrs?.level as number) ?? 1;
    const text = node.textContent.trim().toLowerCase();
    out.push(`${level}:${text}`);
  }
  return out;
}

export function positionsFromAnchors(state: EditorState, anchors: string[]): number[] {
  if (anchors.length === 0) return [];
  const want = new Set(anchors);
  const out: number[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const level = (node.attrs?.level as number) ?? 1;
      const text = node.textContent.trim().toLowerCase();
      const key = `${level}:${text}`;
      if (want.has(key)) out.push(pos);
      return false;
    }
    return true;
  });
  return out;
}
