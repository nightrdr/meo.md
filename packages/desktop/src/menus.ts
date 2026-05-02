// Native-menu → React bridge.
//
// Agent 5's lib.rs forwards every custom menu item click to the
// frontend as a Tauri event named `menu://<id>` (e.g.
// `menu://new-note`, `menu://export.pdf`, `menu://mode.split`).
// This module subscribes to those events and turns them back into
// typed React callbacks via the `useMenuEvents` hook.
//
// Why a hook and not a context: App.tsx already owns the relevant
// state setters (setSettingsOpen, handleNew, setSearchOpen, …) and
// the menu maps cleanly to direct callbacks. A hook keeps the
// dispatch wiring local to App.tsx without prop-drilling or yet
// another provider.
//
// On platforms without a Tauri runtime (the Vite dev server in a
// plain browser tab, e.g. `npm run dev` without `tauri:dev`), the
// `@tauri-apps/api/event` import still resolves but `listen` is a
// no-op in that case. Either way, importing the module is safe.

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Mode value sent by the View menu. */
export type EditorMode = 'edit' | 'split' | 'preview';

/** Format value sent by File ▸ Export as. */
export type ExportFormat = 'md' | 'pdf' | 'docx' | 'txt' | 'html';

/**
 * Handlers the native menu can fire. Every field is optional - only
 * wire what you've actually built. The hook is permissive so menu
 * items for features not yet implemented can stay in the menu (and
 * still fire) without forcing App.tsx to provide a no-op for each.
 */
export interface MenuHandlers {
  // ─── App menu ───
  onAbout?: () => void;
  onSettings?: () => void;
  // Agent 8 - App ▸ Lock all vault notes. Re-locks every currently-unlocked
  // vault note in this session. Invoked from the App menu under Settings…
  // (the spec asks us to coordinate with Agent 5's existing menu structure
  // rather than adding a new top-level menu).
  onLockAllVault?: () => void;
  // ─── File ───
  onNewNote?: () => void;
  onNewFolder?: () => void;
  onNewTag?: () => void;
  onNewDevice?: () => void;
  onImportMarkdown?: () => void;
  onExport?: (format: ExportFormat) => void;
  onPrint?: () => void;
  // ─── Edit ───
  onFind?: () => void;
  onSearchNotes?: () => void;
  onInsertLink?: () => void;
  // ─── View ───
  onToggleSidebar?: () => void;
  onModeChange?: (mode: EditorMode) => void;
  onAskMeo?: () => void;
  // Collapse / expand sections by heading rank (Agent 4). The menu
  // items are placeholders - Agent 5's macOS menu doesn't ship these
  // ids yet, but the handlers are wired here so when it does, the
  // editor will respond. Keyboard shortcuts cover the gap meanwhile.
  onCollapseSection?: () => void;
  onExpandSection?: () => void;
  onCollapseAllSections?: () => void;
  onExpandAllSections?: () => void;
}

// Every menu id we listen for. Keep this in sync with `lib.rs`.
const MENU_IDS = [
  'about',
  'settings',
  'lock-all-vault',
  'new-note',
  'new-folder',
  'new-tag',
  'new-device',
  'import-markdown',
  'export.md',
  'export.pdf',
  'export.docx',
  'export.txt',
  'export.html',
  'print',
  'find',
  'search-notes',
  'insert-link',
  'toggle-sidebar',
  'mode.edit',
  'mode.split',
  'mode.preview',
  'ask-meo',
  'collapse-section',
  'expand-section',
  'collapse-all-sections',
  'expand-all-sections',
] as const;

type MenuId = (typeof MENU_IDS)[number];

/**
 * Subscribe to native menu events for the lifetime of the calling
 * component. Pass an object of handlers; missing handlers fall back
 * to a `console.warn` so unwired features are easy to spot in dev.
 *
 * The handlers object is captured fresh on every render via a ref-
 * less closure - that's fine because the listener wrappers only
 * read `handlers` at call time. We *do* re-subscribe whenever the
 * identity of any handler changes, but in practice App.tsx wraps
 * them with `useCallback` so the listener registration is stable.
 */
export function useMenuEvents(handlers: MenuHandlers): void {
  useEffect(() => {
    const unlistenFns: UnlistenFn[] = [];
    let cancelled = false;

    (async () => {
      for (const id of MENU_IDS) {
        try {
          const off = await listen(`menu://${id}`, () => {
            dispatch(id, handlers);
          });
          if (cancelled) {
            off();
          } else {
            unlistenFns.push(off);
          }
        } catch (err) {
          // Tauri runtime not present (plain `npm run dev` in a
          // browser tab). Nothing to do - silently skip.
          // eslint-disable-next-line no-console
          console.debug('[meo] menu listen skipped:', id, err);
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const off of unlistenFns) {
        try { off(); } catch { /* noop */ }
      }
    };
    // We re-bind whenever the handlers object identity changes.
    // Callers should memoize handlers with useCallback to avoid
    // tearing down listeners on every render.
  }, [handlers]);
}

function dispatch(id: MenuId, h: MenuHandlers): void {
  switch (id) {
    case 'about':           return runOrWarn(id, h.onAbout);
    case 'settings':        return runOrWarn(id, h.onSettings);
    case 'lock-all-vault':  return runOrWarn(id, h.onLockAllVault);
    case 'new-note':        return runOrWarn(id, h.onNewNote);
    case 'new-folder':      return runOrWarn(id, h.onNewFolder);
    case 'new-tag':         return runOrWarn(id, h.onNewTag);
    case 'new-device':      return runOrWarn(id, h.onNewDevice);
    case 'import-markdown': return runOrWarn(id, h.onImportMarkdown);
    case 'export.md':       return runExport(id, h, 'md');
    case 'export.pdf':      return runExport(id, h, 'pdf');
    case 'export.docx':     return runExport(id, h, 'docx');
    case 'export.txt':      return runExport(id, h, 'txt');
    case 'export.html':     return runExport(id, h, 'html');
    case 'print':           return runOrWarn(id, h.onPrint);
    case 'find':            return runOrWarn(id, h.onFind);
    case 'search-notes':    return runOrWarn(id, h.onSearchNotes);
    case 'insert-link':     return runOrWarn(id, h.onInsertLink);
    case 'toggle-sidebar':  return runOrWarn(id, h.onToggleSidebar);
    case 'mode.edit':       return runMode(id, h, 'edit');
    case 'mode.split':      return runMode(id, h, 'split');
    case 'mode.preview':    return runMode(id, h, 'preview');
    case 'ask-meo':         return runOrWarn(id, h.onAskMeo);
    case 'collapse-section':      return runOrWarn(id, h.onCollapseSection);
    case 'expand-section':        return runOrWarn(id, h.onExpandSection);
    case 'collapse-all-sections': return runOrWarn(id, h.onCollapseAllSections);
    case 'expand-all-sections':   return runOrWarn(id, h.onExpandAllSections);
  }
}

function runOrWarn(id: string, fn: (() => void) | undefined): void {
  if (fn) { fn(); return; }
  // eslint-disable-next-line no-console
  console.warn('[meo] menu event not yet wired:', id);
}

function runExport(
  id: string,
  h: MenuHandlers,
  format: ExportFormat,
): void {
  if (h.onExport) { h.onExport(format); return; }
  // eslint-disable-next-line no-console
  console.warn('[meo] menu event not yet wired:', id);
}

function runMode(id: string, h: MenuHandlers, mode: EditorMode): void {
  if (h.onModeChange) { h.onModeChange(mode); return; }
  // eslint-disable-next-line no-console
  console.warn('[meo] menu event not yet wired:', id);
}
