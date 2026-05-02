import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { isVaultLockedBody, ai as A, type Note } from '@meo/shared';
import { AuthScreen } from './Auth';
import { Onboarding } from './Onboarding';
import { Editor } from './Editor';
import {
  rehydrateNotes, pullSync, saveNote, deleteNote, newDraft, buildFolderTree,
  buildTagList, renameFolderEverywhere, moveNoteToFolder,
  refreshSubscription, getCurrentTier,
  setVault, unlockVaultNote, relockVaultNote, relockAllVaultNotes,
  type Session,
} from './session';
import { Vault } from './Vault';
import { TFAVerify, shouldGateTfa } from './TFA';
import { clearAll, getMeta, setMeta } from './storage';
import { clearWrapKey, jwtExpMs } from './biometric';
import { MeoMark, Icon } from './Icon';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { SearchOverlay } from './SearchOverlay';
import { AIControls, FALLBACK_DEFAULT_MODEL_ID, type DynamicModel } from './AIControls';
import { AIPanel } from './AIPanel';
import { Settings, type SettingsTab } from './Settings';
import { Pairing } from './Pairing';
import { peekAIRuntime } from './aiStore';
import { Mod, shortcut, isMac, isWindows } from './platform';
import { SupabaseApiClient, uuidv4 } from '@meo/shared';
import { setAttachmentsContext } from './AttachmentRenderer';
import { supabaseUrl, supabaseAnonKey } from './session';
import { useMenuEvents, type MenuHandlers, type ExportFormat } from './menus';
import {
  exportNoteAsMarkdown, exportNoteAsHTML, exportNoteAsTXT,
  exportNoteAsDOCX, exportNoteAsPDF,
} from './export';

type Status = 'idle' | 'syncing' | 'saving' | 'error';

// Display-only version for the About modal. The native bundle
// version comes from `tauri.conf.json`; this constant just gives
// the modal something to show without an extra import.
const APP_VERSION = '0.1.0';

interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  // Cold-start auth routing (Agent 1). When the user already has a
  // valid JWT and a wrap_blob in IndexedDB, we route directly to the
  // 'biometric' Auth mode so they can unlock with Touch ID instead of
  // re-typing passphrase + Secret Key. `null` means "still deciding"
  // - we render nothing until the IDB read completes so the user
  // doesn't see the email screen flash before the biometric prompt.
  const [authStart, setAuthStart] = useState<{
    mode: 'email' | 'biometric';
    email?: string;
  } | null>(null);
  // First-run onboarding: shown to a brand-new user after Auth.tsx
  // succeeds, before they see the editor. Persists `onboarding_done`
  // so it never re-appears (Agent 7).
  const [onboardingPending, setOnboardingPending] = useState(false);
  const [tick, setTick] = useState(0);
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Mirror of `selectedId` for use inside callbacks captured by
  // useMemo/useCallback that don't list `selectedId` in their deps -
  // avoids stale-closure issues for the native-menu export handler.
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  const [status, setStatus] = useState<Status>('idle');
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [emptyFolders, setEmptyFolders] = useState<string[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState<{ parent: string } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [folderInput, setFolderInput] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Sidebar tag-add inline input. Adds the tag to the currently
  // selected note since tags only exist as members of notes.
  const [tagAddOpen, setTagAddOpen] = useState(false);
  const [tagAddInput, setTagAddInput] = useState('');
  // Commit (or no-op-and-close) the sidebar tag-add input. Mirrors the
  // editor's own tag-input commit behaviour so blur and Enter both work.
  const commitSidebarTag = useCallback(() => {
    const t = tagAddInput.trim().replace(/^#/, '').toLowerCase();
    if (t && selected && !selected.tags.includes(t)) {
      handleEditorChange({ ...selected, tags: [...selected.tags, t] });
    }
    setTagAddOpen(false);
    setTagAddInput('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagAddInput]);
  const [aiOn, setAiOn] = useState(true);
  const [modelId, setModelId] = useState<string>(FALLBACK_DEFAULT_MODEL_ID);
  const [dynamicModels, setDynamicModels] = useState<DynamicModel[]>([]);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('ai');
  // Renders the free-tier upgrade banner above Ask Meo. Updated lazily when
  // refreshSubscription resolves (and the session reference identity stays
  // stable, so we use a separate state for the rerender trigger).
  const [tier, setTier] = useState<ReturnType<typeof getCurrentTier>>('free');
  // Tiny About modal - opened from the App menu (Agent 5).
  const [aboutOpen, setAboutOpen] = useState(false);
  // QR-pairing modal (Agent 9). Opened via File ▸ "New Device…" from the
  // native menu bar, the sidebar, or programmatically from cap-reached
  // toasts (the latter not wired yet).
  const [pairingOpen, setPairingOpen] = useState(false);
  // Sidebar visibility - persisted via setMeta. Toggle through the
  // list-pane header button, the ⇧⌘S shortcut, or `toggleSidebar()`
  // (Agent 5's native View menu calls into this).
  const [sidebarHidden, setSidebarHidden] = useState(false);
  // Vault unlock modal (Agent 8). When the user clicks a vault-flagged
  // note whose body is still in `vault:...` wire form, we surface this
  // before swapping selectedId → editor.
  const [vaultPrompt, setVaultPrompt] = useState<{ noteId: string } | null>(null);
  // Tracks the previously-open note id so we can re-lock vault notes on
  // switch. Mirrors `selectedId` but lags by one render - see the effect
  // below that runs `relockVaultNote` on the previous id.
  const lastSelectedRef = useRef<string | null>(null);
  // 2FA gate (Agent 8). True when the cold-start TOTP screen is showing.
  // Cleared once the user enters a valid 6-digit code.
  const [tfaGated, setTfaGated] = useState(false);
  const saveTimer = useRef<number | null>(null);

  const toggleSidebar = useCallback(() => {
    setSidebarHidden(v => {
      const next = !v;
      setMeta({ sidebar_hidden: next }).catch(() => {});
      return next;
    });
  }, []);

  const refresh = useCallback(() => setTick(x => x + 1), []);

  // ─── Cold-start auth routing (Agent 1) ───
  // Decide whether to send the user straight into biometric unlock or
  // start at the email screen. The check is conservative: we require
  // a non-expired JWT *and* a wrap blob *and* the biometric_enabled
  // flag to be on. Any failure defaults to the email/passphrase flow.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meta = await getMeta();
        const exp = meta.jwt ? jwtExpMs(meta.jwt) : null;
        const hasValidJwt = !!meta.jwt && !!exp && Date.now() < exp;
        const hasWrap = !!meta.master_wrap_blob && !!meta.master_wrap_nonce;
        if (hasValidJwt && hasWrap && meta.biometric_enabled !== false) {
          if (!cancelled) setAuthStart({ mode: 'biometric', email: meta.email });
          return;
        }
        // JWT expired but wrap data left behind - clean up so the
        // next biometric prompt isn't a no-op against stale meta.
        if (!hasValidJwt && hasWrap) {
          await setMeta({
            master_wrap_blob: undefined,
            master_wrap_nonce: undefined,
            biometric_enabled: false,
          });
          await clearWrapKey();
        }
        if (!cancelled) setAuthStart({ mode: 'email' });
      } catch {
        if (!cancelled) setAuthStart({ mode: 'email' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Block the browser's default context menu app-wide (Inspect Element etc).
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      // Allow native menu in inputs / contenteditable so users keep clipboard ops.
      const tgt = e.target as HTMLElement;
      const tag = tgt.tagName;
      const editable = tgt.isContentEditable
        || tag === 'INPUT' || tag === 'TEXTAREA'
        || !!tgt.closest('.ProseMirror');
      if (editable) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, []);

  // ⌘K opens search; ⌘/ toggles AI panel; ⌘N creates a note.
  // Escape closes the topmost overlay; if nothing is open, exits
  // browser fullscreen (macOS native fullscreen exits via the green
  // button - this handles the F11/document.fullscreenElement case).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        if (aiOn) setAiPanelOpen(o => !o);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && session) {
        e.preventDefault();
        handleNew();
        return;
      }
      // ⇧⌘S / Ctrl+Shift+S - toggle sidebar (matches macOS Notes' ^⌘S).
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's' && session) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (e.key === 'Escape') {
        // Topmost overlay first - order matches z-index reading.
        if (menu) { setMenu(null); e.preventDefault(); return; }
        if (aboutOpen) { setAboutOpen(false); e.preventDefault(); return; }
        if (searchOpen) { setSearchOpen(false); e.preventDefault(); return; }
        if (settingsOpen) { setSettingsOpen(false); e.preventDefault(); return; }
        if (tagAddOpen) { setTagAddOpen(false); setTagAddInput(''); e.preventDefault(); return; }
        if (creatingFolder) { setCreatingFolder(null); setFolderInput(''); e.preventDefault(); return; }
        if (renamingFolder) { setRenamingFolder(null); setFolderInput(''); e.preventDefault(); return; }
        if (aiPanelOpen) { setAiPanelOpen(false); e.preventDefault(); return; }
        // Editor-internal overlays (find bar, AI bubbles, slash menu) handle
        // Esc themselves at a deeper level and stopPropagation when they
        // consume it. If we got here, nothing app-level is open - try to
        // exit fullscreen.
        if (document.fullscreenElement) {
          document.exitFullscreen?.().catch(() => {});
          e.preventDefault();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, aiOn, menu, searchOpen, settingsOpen, aboutOpen, tagAddOpen, creatingFolder, renamingFolder, aiPanelOpen, toggleSidebar]);

  // Native menu wiring (Agent 5) - see the `useMenuEvents` block
  // further down. The hook is called after handleNew /
  // startCreateFolder are defined, since those are `const` and
  // can't be referenced before their `useCallback` runs.

  // Embed-on-save lifecycle. Only re-indexes if the AI runtime is
  // already loaded (the AI panel has been opened this session).
  // This avoids kicking off the embedder cold-start from a note save.
  const lastTickRef = useRef(0);
  const indexingRef = useRef(false);
  useEffect(() => {
    if (!session) return;
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    const rt = peekAIRuntime();
    if (!rt) return;
    if (indexingRef.current) return;     // skip if a re-index is already in flight
    indexingRef.current = true;
    (async () => {
      try {
        // Re-index every note that's currently in session.notes. Cheap
        // because indexNote is a no-op if vec_hash hasn't changed.
        for (const n of session.notes.values()) {
          await rt.indexNote(n);
        }
      } catch (e) {
        // surface in dev only; AI panel will show its own errors
        // eslint-disable-next-line no-console
        console.warn('AI re-index failed:', e);
      } finally {
        indexingRef.current = false;
      }
    })();
  }, [tick, session]);

  // First-time auth → rehydrate cache + initial sync + load prefs
  const onAuth = useCallback(async (s: Session) => {
    const meta = await getMeta();
    s.syncCursor = meta.sync_cursor ?? 0;
    setEmptyFolders(meta.empty_folders ?? []);
    setExpandedFolders(new Set(meta.expanded_folders ?? []));
    setAiOn(meta.ai_on ?? true);
    setModelId(meta.model_id ?? FALLBACK_DEFAULT_MODEL_ID);
    setSidebarHidden(meta.sidebar_hidden ?? false);
    setOnboardingPending(meta.onboarding_done !== true);
    setSession(s);
    // Populate the attachments-renderer shim so Editor.tsx + AttachmentRenderer
    // can build an authed AttachmentsClient on demand without prop-drilling
    // the master key.
    if (s.api.jwt) {
      setAttachmentsContext({
        masterRaw: s.masterRaw,
        jwt: s.api.jwt,
        supabaseUrl,
        supabaseAnonKey,
      });
    }
    await rehydrateNotes(s);
    refresh();
    try {
      setStatus('syncing'); setStatusMsg('Syncing');
      await pullSync(s);
      setStatus('idle'); setStatusMsg('Synced');
      refresh();
    } catch (e) {
      setStatus('error'); setStatusMsg(`Sync failed: ${(e as Error).message}`);
    }
    // Load subscription tier + 2FA gate in the background. Failure is
    // non-fatal - the user stays on the conservative 'free' default.
    refreshSubscription(s).then(async () => {
      const t = getCurrentTier(s);
      setTier(t);
      // Cold-start 2FA gate (Agent 8). For Business+ users with TFA on,
      // present TOTP between OTP-verify and unlock-screen.
      try {
        if (await shouldGateTfa(s, t)) setTfaGated(true);
      } catch { /* server middleware enforces if RPC blip */ }
    }).catch(() => {});

    // Device registration (Agent 9). Generates a stable per-installation
    // device id and registers it so the Devices pane can see "this
    // device" + the per-tier cap can count it. Best-effort.
    (async () => {
      try {
        if (!(s.api instanceof SupabaseApiClient)) return;
        let did = meta.device_id;
        let dname = meta.device_name;
        if (!did) {
          did = uuidv4();
          dname = defaultDeviceName();
          await setMeta({ device_id: did, device_name: dname });
        }
        await s.api.registerDevice(
          did,
          detectPlatform(),
          dname ?? defaultDeviceName(),
          typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[meo] device_register failed', e);
      }
    })();
  }, [refresh]);

  // Periodic poll
  useEffect(() => {
    if (!session) return;
    const id = window.setInterval(async () => {
      try {
        setStatus('syncing'); setStatusMsg('Syncing');
        const r = await pullSync(session);
        setStatus('idle'); setStatusMsg(r.pulled ? `Pulled ${r.pulled} update${r.pulled === 1 ? '' : 's'}` : 'Synced');
        if (r.pulled > 0) refresh();
      } catch (e) {
        setStatus('error'); setStatusMsg(`Sync failed: ${(e as Error).message}`);
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [session, refresh]);

  const allNotes = useMemo(
    () => session ? Array.from(session.notes.values()) : [],
    [session, tick],
  );
  const folderTree = useMemo(
    () => buildFolderTree(allNotes, emptyFolders),
    [allNotes, emptyFolders],
  );
  const tagList = useMemo(() => buildTagList(allNotes), [allNotes]);

  const visibleNotes = useMemo(() => {
    let filtered = allNotes;
    if (selectedTag) {
      filtered = filtered.filter(n => n.tags.includes(selectedTag));
    } else if (selectedFolder !== '') {
      filtered = filtered.filter(n => {
        const path = n.folder.join('/');
        return path === selectedFolder || path.startsWith(selectedFolder + '/');
      });
    }
    return filtered.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [allNotes, selectedFolder, selectedTag]);

  const selected = useMemo(() => {
    if (!session || !selectedId) return null;
    return session.notes.get(selectedId) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, selectedId, tick]);

  const handleEditorChange = useCallback((next: Note) => {
    if (!session) return;
    session.notes.set(next.id, next);
    refresh();
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        setStatus('saving'); setStatusMsg('Saving');
        const saved = await saveNote(session, session.notes.get(next.id)!);
        session.notes.set(saved.id, saved);
        setStatus('idle'); setStatusMsg('Saved just now');
      } catch (e) {
        setStatus('error'); setStatusMsg(`Save failed: ${(e as Error).message}`);
      }
    }, 500);
  }, [session, refresh]);

  const handleNew = useCallback(async () => {
    if (!session) return;
    const draft = newDraft();
    if (selectedFolder) draft.folder = selectedFolder.split('/');
    if (selectedTag) draft.tags = [selectedTag];
    session.notes.set(draft.id, draft);
    setSelectedId(draft.id);
    refresh();
    try {
      setStatus('saving'); setStatusMsg('Creating');
      const saved = await saveNote(session, draft);
      session.notes.set(saved.id, saved);
      setStatus('idle'); setStatusMsg('Saved just now');
    } catch (e) {
      setStatus('error'); setStatusMsg(`Create failed: ${(e as Error).message}`);
    }
  }, [session, selectedFolder, selectedTag, refresh]);

  const handleDeleteNote = useCallback(async (id: string) => {
    if (!session) return;
    if (!confirm('Delete this note?')) return;
    try {
      setStatus('saving'); setStatusMsg('Deleting');
      await deleteNote(session, id);
      if (selectedId === id) setSelectedId(null);
      setStatus('idle'); setStatusMsg('Deleted');
      refresh();
    } catch (e) {
      setStatus('error'); setStatusMsg(`Delete failed: ${(e as Error).message}`);
    }
  }, [session, selectedId, refresh]);

  const handleLogout = useCallback(async () => {
    if (!confirm('Sign out and clear local cache on this device?')) return;
    // Clear the OS keychain wrap key first so a partial failure
    // doesn't leave the keychain entry orphaned. clearWrapKey is
    // best-effort; clearAll then nukes everything else (notes,
    // vectors, meta including the wrap blob).
    await clearWrapKey();
    await clearAll();
    setAttachmentsContext(null);
    setSession(null);
    setSelectedId(null);
    // After sign-out the user should land on the email screen, not
    // the biometric screen - clearAll wipes meta so the next mount
    // would default to 'email' anyway, but we set it explicitly so
    // we don't render `null` while waiting for the IDB read.
    setAuthStart({ mode: 'email' });
  }, []);

  // Folder operations
  const persistEmptyFolders = useCallback(async (next: string[]) => {
    setEmptyFolders(next);
    await setMeta({ empty_folders: next });
  }, []);

  const startCreateFolder = useCallback((parent: string) => {
    setCreatingFolder({ parent });
    setFolderInput('');
    if (parent) {
      setExpandedFolders(s => { const n = new Set(s); n.add(parent); return n; });
    }
  }, []);

  const finishCreateFolder = useCallback(async () => {
    if (!creatingFolder) return;
    const name = folderInput.trim();
    setCreatingFolder(null);
    setFolderInput('');
    if (!name) return;
    if (name.includes('/')) { alert('Folder names cannot contain "/"'); return; }
    const fullPath = creatingFolder.parent
      ? `${creatingFolder.parent}/${name}`
      : name;
    if (emptyFolders.includes(fullPath) || folderTree.some(f => f.path === fullPath)) {
      // already exists; just select it
      setSelectedFolder(fullPath);
      return;
    }
    await persistEmptyFolders([...emptyFolders, fullPath]);
    setSelectedFolder(fullPath);
  }, [creatingFolder, folderInput, emptyFolders, folderTree, persistEmptyFolders]);

  const handleRenameFolder = useCallback(async (oldPath: string, newName: string) => {
    if (!session) return;
    const newName2 = newName.trim();
    if (!newName2 || newName2.includes('/')) {
      setRenamingFolder(null);
      return;
    }
    const parts = oldPath.split('/');
    parts[parts.length - 1] = newName2;
    const newPath = parts.join('/');
    if (newPath === oldPath) { setRenamingFolder(null); return; }
    setRenamingFolder(null);
    setStatus('saving'); setStatusMsg('Renaming folder');
    // Update notes
    await renameFolderEverywhere(session, oldPath, newPath);
    // Update empty folders
    const next = emptyFolders.map(p =>
      p === oldPath ? newPath
      : p.startsWith(oldPath + '/') ? newPath + p.slice(oldPath.length)
      : p,
    );
    await persistEmptyFolders(next);
    if (selectedFolder === oldPath || selectedFolder.startsWith(oldPath + '/')) {
      setSelectedFolder(newPath + selectedFolder.slice(oldPath.length));
    }
    setStatus('idle'); setStatusMsg('Folder renamed');
    refresh();
  }, [session, emptyFolders, persistEmptyFolders, selectedFolder, refresh]);

  const handleDeleteFolder = useCallback(async (path: string) => {
    if (!session) return;
    const affected = allNotes.filter(n => {
      const p = n.folder.join('/');
      return p === path || p.startsWith(path + '/');
    });
    const msg = affected.length
      ? `Delete folder "${path}" and ${affected.length} note${affected.length === 1 ? '' : 's'} inside?`
      : `Delete empty folder "${path}"?`;
    if (!confirm(msg)) return;
    for (const n of affected) {
      await deleteNote(session, n.id);
    }
    const next = emptyFolders.filter(p => p !== path && !p.startsWith(path + '/'));
    await persistEmptyFolders(next);
    if (selectedFolder === path || selectedFolder.startsWith(path + '/')) {
      setSelectedFolder('');
    }
    refresh();
  }, [session, allNotes, emptyFolders, persistEmptyFolders, selectedFolder, refresh]);

  // Drag-and-drop wiring (bonus): note → folder
  const handleDropNote = useCallback(async (noteId: string, folderPath: string) => {
    if (!session) return;
    setStatus('saving'); setStatusMsg('Moving note');
    await moveNoteToFolder(session, noteId, folderPath);
    setStatus('idle'); setStatusMsg('Saved just now');
    refresh();
  }, [session, refresh]);

  // Context menus
  const openMenu = useCallback((e: React.MouseEvent, items: MenuEntry[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  const folderMenuItems = useCallback((path: string): MenuEntry[] => {
    const isAllNotes = path === '';
    return [
      { label: 'New note here', icon: 'Plus', shortcut: shortcut('N'), onClick: () => { setSelectedFolder(path); handleNew(); } },
      { label: 'New sub-folder', icon: 'FolderPlus', onClick: () => startCreateFolder(path), disabled: isAllNotes },
      { separator: true },
      { label: 'Rename folder', icon: 'Edit', onClick: () => { setRenamingFolder(path); setFolderInput(path.split('/').pop() ?? ''); }, disabled: isAllNotes },
      { label: 'Delete folder', icon: 'Trash', danger: true, onClick: () => handleDeleteFolder(path), disabled: isAllNotes },
    ];
  }, [handleNew, startCreateFolder, handleDeleteFolder]);

  const folderHeaderMenuItems: MenuEntry[] = useMemo(() => [
    { label: 'New folder', icon: 'FolderPlus', onClick: () => startCreateFolder('') },
  ], [startCreateFolder]);

  const noteMenuItems = useCallback((note: Note): MenuEntry[] => {
    const locked = !!note.isVault && isVaultLockedBody(note.body);
    return [
      { label: 'Open', icon: 'Note', onClick: () => setSelectedId(note.id) },
      { label: 'Duplicate', icon: 'Copy', disabled: locked, onClick: async () => {
        if (!session) return;
        if (locked) return;
        const copy: Note = {
          ...note,
          id: crypto.randomUUID(),
          title: `${note.title || 'Untitled'} copy`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          // Cloned vault notes start un-vaulted: duplicating a locked note
          // would otherwise require the user to unlock it first, which
          // surprises people. They can re-lock the copy from the menu.
          isVault: false,
        };
        session.notes.set(copy.id, copy);
        await saveNote(session, copy);
        setSelectedId(copy.id);
        refresh();
      }},
      { separator: true },
      { label: 'Copy title', icon: 'Copy', onClick: () => navigator.clipboard.writeText(note.title || 'Untitled') },
      // Copy body is disabled for locked vault notes - copying ciphertext
      // would be confusing and copying after unlock requires opening the
      // editor first.
      { label: 'Copy markdown body', icon: 'Copy', disabled: locked,
        onClick: () => navigator.clipboard.writeText(locked ? '' : note.body) },
      { separator: true },
      // Vault toggle (Agent 8). Locking is always available; unlocking
      // requires opening the note (so the unlock modal can run).
      note.isVault
        ? { label: 'Unlock note', icon: 'Lock',
            onClick: () => { setSelectedId(note.id); if (locked) setVaultPrompt({ noteId: note.id }); }}
        : { label: 'Lock note', icon: 'Lock', onClick: async () => {
            if (!session) return;
            try { await setVault(session, note.id, true); refresh(); }
            catch (e) { setStatus('error'); setStatusMsg(`Lock failed: ${(e as Error).message}`); }
          }},
      { label: 'Remove vault flag', icon: 'Trash', disabled: !note.isVault || locked,
        onClick: async () => {
          if (!session) return;
          try { await setVault(session, note.id, false); refresh(); }
          catch (e) { setStatus('error'); setStatusMsg(`Unlock failed: ${(e as Error).message}`); }
        }},
      { separator: true },
      // Export submenu (Agent 2). Locked vault notes still expose
      // the menu but the exporter sees the encrypted body - the user
      // is expected to unlock first; we don't unlock on their behalf.
      { label: 'Export as', icon: 'Download', disabled: locked, items: [
        { label: 'Markdown',   icon: 'Note', onClick: () => { void exportNoteAsMarkdown(note); } },
        { label: 'PDF',        icon: 'Note', onClick: () => { void exportNoteAsPDF(note); } },
        { label: 'DOCX',       icon: 'Note', onClick: () => { void exportNoteAsDOCX(note); } },
        { label: 'Plain Text', icon: 'Note', onClick: () => { void exportNoteAsTXT(note); } },
        { label: 'HTML',       icon: 'Note', onClick: () => { void exportNoteAsHTML(note); } },
      ]},
      { separator: true },
      { label: 'Delete note', icon: 'Trash', danger: true, onClick: () => handleDeleteNote(note.id) },
    ];
  }, [session, handleDeleteNote, refresh]);

  const tagMenuItems = useCallback((tag: string): MenuEntry[] => [
    { label: 'Filter by this tag', icon: 'Tag', onClick: () => { setSelectedTag(tag); setSelectedFolder(''); } },
    { separator: true },
    {
      label: `Remove "#${tag}" from all notes`,
      icon: 'Trash',
      danger: true,
      onClick: async () => {
        if (!session) return;
        if (!confirm(`Remove tag "#${tag}" from all notes?`)) return;
        for (const n of Array.from(session.notes.values())) {
          if (n.tags.includes(tag)) {
            await saveNote(session, { ...n, tags: n.tags.filter(t => t !== tag) });
          }
        }
        if (selectedTag === tag) setSelectedTag(null);
        refresh();
      },
    },
  ], [session, selectedTag, refresh]);

  // Vault: when selection changes, re-lock the previously-open vault note
  // and auto-prompt the unlock modal for the new selection if it's locked.
  useEffect(() => {
    if (!session) return;
    const prev = lastSelectedRef.current;
    lastSelectedRef.current = selectedId;
    if (prev && prev !== selectedId) {
      relockVaultNote(session, prev).then(() => refresh()).catch(() => {});
    }
    if (selectedId) {
      const n = session.notes.get(selectedId);
      if (n && n.isVault && isVaultLockedBody(n.body)) {
        setVaultPrompt({ noteId: selectedId });
      } else {
        setVaultPrompt(null);
      }
    } else {
      setVaultPrompt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, session]);

  // Persist expandedFolders + AI prefs
  useEffect(() => { setMeta({ expanded_folders: Array.from(expandedFolders) }); }, [expandedFolders]);
  useEffect(() => { setMeta({ ai_on: aiOn }); }, [aiOn]);
  useEffect(() => { setMeta({ model_id: modelId }); }, [modelId]);

  // Discover Ollama-installed models when AI is on; refresh every 30s
  // so newly-pulled models show up without a reload.
  useEffect(() => {
    if (!aiOn) { setDynamicModels([]); return; }
    let alive = true;
    const refresh = async () => {
      try {
        // Probe via the runtime's generator. Lightweight: a single GET.
        const { OllamaBackend } = await import('@meo/shared').then(m => m.ai);
        const backend = new OllamaBackend();
        if (!await backend.isAvailable()) {
          if (alive) setDynamicModels([]);
          return;
        }
        const list = await backend.listModels();
        if (!alive) return;
        setDynamicModels(list as DynamicModel[]);
        // If the currently-selected model id isn't in the Ollama list,
        // auto-select the first one. Cloud-LLM ids (gpt-4o, claude-...,
        // gemini-..., grok-...) intentionally stay sticky — we don't
        // want a transient Ollama probe to kick a user off their
        // chosen frontier model.
        const isCloudId = /^(gpt|claude|gemini|grok)/i.test(modelId);
        if (list.length > 0 && !list.some(l => l.id === modelId) && !isCloudId) {
          setModelId(list[0].id);
        }
      } catch {
        if (alive) setDynamicModels([]);
      }
    };
    refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiOn]);

  // ─── Native menu wiring (Agent 5) ───
  // Bridge for the macOS menu bar. The Rust side emits "menu://<id>"
  // events; this hook turns them into typed callbacks. Handlers for
  // still-unimplemented features (export, print, import-markdown,
  // insert-link, new-tag, new-device) are intentionally omitted so
  // useMenuEvents falls back to a console.warn - that way the gap
  // is visible in dev without the click silently doing nothing.
  // ⌘F is re-routed via a synthetic keydown so Editor.tsx's existing
  // find-bar listener handles it without a new prop.
  const dispatchFind = useCallback(() => {
    const ev = new KeyboardEvent('keydown', {
      key: 'f', code: 'KeyF',
      metaKey: true, ctrlKey: true,
      bubbles: true, cancelable: true,
    });
    document.dispatchEvent(ev);
  }, []);
  const menuHandlers = useMemo<MenuHandlers>(() => ({
    onAbout: () => setAboutOpen(true),
    onSettings: () => setSettingsOpen(true),
    onLockAllVault: () => {
      // Agent 8 - re-lock every currently-unlocked vault note. Cheap when
      // none are unlocked. Refresh fires a re-render so list previews swap
      // back to 🔒.
      if (!session) return;
      relockAllVaultNotes(session).then(() => refresh()).catch(() => {});
    },
    onNewNote: () => { void handleNew(); },
    onNewFolder: () => startCreateFolder(''),
    onSearchNotes: () => setSearchOpen(true),
    onAskMeo: () => { if (aiOn) setAiPanelOpen(o => !o); },
    onFind: dispatchFind,
    onModeChange: (_m) => {
      // Editor mode toggling lands with Agent 2's parity track.
      // eslint-disable-next-line no-console
      console.warn('[meo] menu event not yet wired: mode change');
    },
    onToggleSidebar: toggleSidebar,
    // Collapse/expand section bridges (Agent 4) - dispatched as DOM
    // CustomEvents and consumed by Editor.tsx. Keyboard shortcuts also
    // fire these directly until Agent 5's lib.rs adds the menu rows.
    onCollapseSection: () => document.dispatchEvent(new CustomEvent('meo:collapse-section')),
    onExpandSection: () => document.dispatchEvent(new CustomEvent('meo:expand-section')),
    onCollapseAllSections: () => document.dispatchEvent(new CustomEvent('meo:collapse-all')),
    onExpandAllSections: () => document.dispatchEvent(new CustomEvent('meo:expand-all')),
    // QR pairing (Agent 9) - File ▸ New Device opens the modal.
    onNewDevice: () => setPairingOpen(true),
    // File ▸ Export (Agent 2) - fires for the currently-selected note.
    // We can't read `selected` from inside this useMemo without a stale
    // closure issue, so we look up the current selection via a ref-less
    // closure on `session.notes` + `selectedId` at click time.
    onExport: (format: ExportFormat) => {
      const id = selectedIdRef.current;
      if (!id || !session) {
        // eslint-disable-next-line no-console
        console.warn('[meo] export menu: no note selected');
        return;
      }
      const note = session.notes.get(id);
      if (!note) {
        // eslint-disable-next-line no-console
        console.warn('[meo] export menu: selected note not found:', id);
        return;
      }
      switch (format) {
        case 'md':   void exportNoteAsMarkdown(note); break;
        case 'pdf':  void exportNoteAsPDF(note); break;
        case 'docx': void exportNoteAsDOCX(note); break;
        case 'txt':  void exportNoteAsTXT(note); break;
        case 'html': void exportNoteAsHTML(note); break;
      }
    },
    // import/print/insert-link/new-tag intentionally omitted - useMenuEvents
    // will console.warn until those ship.
  }), [
    handleNew, startCreateFolder, aiOn, dispatchFind, toggleSidebar, session, refresh,
  ]);
  useMenuEvents(menuHandlers);

  if (!session) {
    // Wait for the cold-start boot effect to decide whether to send
    // the user to email-OTP or biometric unlock. This is usually one
    // microtask of IDB read; rendering `null` for that beat keeps us
    // from flashing the email screen before the biometric prompt.
    if (!authStart) return null;
    return (
      <AuthScreen
        onAuthenticated={onAuth}
        startMode={authStart.mode}
        initialEmail={authStart.email}
      />
    );
  }

  if (onboardingPending) {
    return <Onboarding onDone={() => setOnboardingPending(false)} />;
  }

  // Word count for status bar
  const wordCount = selected ? selected.body.split(/\s+/).filter(Boolean).length : 0;

  return (
    <div className={`app ${aiPanelOpen ? 'ai-open' : ''} ${sidebarHidden ? 'sidebar-hidden' : ''}`}>
      {/* ───────── Sidebar ───────── */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark"><MeoMark size={26} /></div>
          <div className="name">Meo</div>
          <div className="brand-actions">
            <button className="btn icon-btn" onClick={() => setSettingsOpen(true)} title="Settings">
              <Icon.Settings size={14} />
            </button>
            <button className="btn icon-btn" onClick={handleLogout} title="Sign out">
              <Icon.Eject size={14} />
            </button>
          </div>
          <div className="email" title={session.email}>{session.email}</div>
        </div>

        <div className="sidebar-search">
          <button onClick={() => setSearchOpen(true)}>
            <Icon.Search size={14} />
            <span>Search</span>
            <span className="kbd">{shortcut('K')}</span>
          </button>
        </div>

        <div className="section-header">Library</div>
        <div className="sidebar-section">
          <FolderRow
            label="All notes"
            count={allNotes.length}
            icon="Note"
            active={!selectedTag && selectedFolder === ''}
            onClick={() => { setSelectedFolder(''); setSelectedTag(null); }}
            onContextMenu={(e) => openMenu(e, folderMenuItems(''))}
          />

          <div
            className="section-header section-header-clickable"
            onContextMenu={(e) => openMenu(e, folderHeaderMenuItems)}
          >
            <span>Folders</span>
            <button
              className="btn icon-btn small"
              onClick={() => startCreateFolder('')}
              title="New folder"
            >
              <Icon.Plus size={14} />
            </button>
          </div>

          <FolderTree
            tree={folderTree.filter(({ path }) => path !== '')}
            expanded={expandedFolders}
            setExpanded={setExpandedFolders}
            selected={selectedFolder}
            tagFilter={selectedTag}
            onSelect={(path) => { setSelectedFolder(path); setSelectedTag(null); }}
            onContext={(e, path) => openMenu(e, folderMenuItems(path))}
            renaming={renamingFolder}
            renameValue={folderInput}
            setRenameValue={setFolderInput}
            onCommitRename={(oldPath) => handleRenameFolder(oldPath, folderInput)}
            onCancelRename={() => setRenamingFolder(null)}
            creatingFolder={creatingFolder}
            createValue={folderInput}
            setCreateValue={setFolderInput}
            onCommitCreate={finishCreateFolder}
            onCancelCreate={() => setCreatingFolder(null)}
            onDropNote={handleDropNote}
          />

          <div className="section-header section-header-clickable">
            <span>Tags</span>
            <button
              className="btn icon-btn small"
              onClick={() => { setTagAddOpen(true); setTagAddInput(''); }}
              disabled={!selected}
              title={selected ? `Add tag to "${selected.title || 'Untitled'}"` : 'Open a note to add a tag'}
            >
              <Icon.Plus size={14} />
            </button>
          </div>
          {tagAddOpen && selected && (
            <div className="sidebar-tag-add">
              <input
                autoFocus
                value={tagAddInput}
                placeholder="tag name"
                onChange={(e) => setTagAddInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitSidebarTag();
                  if (e.key === 'Escape') { setTagAddOpen(false); setTagAddInput(''); }
                }}
                onBlur={commitSidebarTag}
              />
            </div>
          )}
          {tagList.length > 0 && (
            <div className="tag-chips">
              {tagList.map(({ tag, count }) => (
                <button
                  key={tag}
                  type="button"
                  className={`tag-chip ${selectedTag === tag ? 'active' : ''}`}
                  onClick={() => { setSelectedTag(tag); setSelectedFolder(''); }}
                  onContextMenu={(e) => openMenu(e, tagMenuItems(tag))}
                  title={`${count} note${count === 1 ? '' : 's'}`}
                >
                  <span>#{tag}</span>
                  <span className="tag-count">{count}</span>
                </button>
              ))}
              {selectedTag && (
                <button type="button" className="tag-chip clear" onClick={() => setSelectedTag(null)}>
                  <Icon.X size={10} /> Clear
                </button>
              )}
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          {tier === 'free' && (
            <button
              type="button"
              className="upgrade-banner"
              onClick={() => { setSettingsTab('subscription'); setSettingsOpen(true); }}
              title="Upgrade Meo"
            >
              <Icon.Sparkle size={12} />
              <span>Upgrade Meo</span>
              <span className="hint">More storage, AI tokens &amp; devices</span>
            </button>
          )}
          <button
            type="button"
            className="ai-open-btn"
            disabled={!aiOn}
            onClick={() => aiOn && setAiPanelOpen(o => !o)}
            title={aiPanelOpen ? `Close Ask Meo (${shortcut('/')})` : `Open Ask Meo (${shortcut('/')})`}
          >
            <Icon.Sparkle size={13} stroke={aiOn ? 'var(--ai)' : 'var(--ink3)'} />
            <span>Ask Meo</span>
            <span className="kbd">{shortcut('/')}</span>
          </button>
          <AIControls
            aiOn={aiOn}
            modelId={modelId}
            dynamicModels={dynamicModels}
            onToggle={() => setAiOn(v => !v)}
            onSelect={(id) => setModelId(id)}
          />
        </div>
      </aside>

      {/* ───────── Notes list ───────── */}
      <section className="list-pane">
        <div className="list-header">
          <button
            className="btn icon-btn list-sidebar-toggle"
            onClick={toggleSidebar}
            title={`${sidebarHidden ? 'Show' : 'Hide'} sidebar (${shortcut('S', 'shift')})`}
          >
            <Icon.Sidebar size={14} />
          </button>
          <h2>{selectedTag ? `#${selectedTag}` : (selectedFolder || 'All notes')}</h2>
          <span className="count">{visibleNotes.length} {visibleNotes.length === 1 ? 'note' : 'notes'}</span>
          <div style={{ flex: 1 }} />
          <button className="btn icon-btn" onClick={handleNew} title={`New note (${shortcut('N')})`}>
            <Icon.Plus size={14} />
          </button>
        </div>
        <div className="note-list">
          {visibleNotes.length === 0 && (
            <div className="note-list-empty">No notes here yet.</div>
          )}
          {groupNotesByDate(visibleNotes).map(({ label, notes }) => (
            <React.Fragment key={label}>
              <div className="list-date-header">{label}</div>
              {notes.map((n) => {
                // Vault preview redaction (Agent 8). A vault-flagged note
                // whose body is still in `vault:...` wire form (i.e. not
                // unlocked for this open) renders a placeholder - never the
                // ciphertext, never a partial title leak.
                const vaultLocked = !!n.isVault && isVaultLockedBody(n.body);
                const previewText = vaultLocked
                  ? 'Vault note'
                  : ((n.body.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? '').slice(0, 200) || ' ');
                return (
                <div
                  key={n.id}
                  className={`note-item ${n.id === selectedId ? 'active' : ''}`}
                  onClick={() => setSelectedId(n.id)}
                  onContextMenu={(e) => openMenu(e, noteMenuItems(n))}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-meo-note-id', n.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                >
                  <div className="title-row">
                    <span className="title">
                      {n.isVault && <Icon.Lock size={11} className="vault-pad" />}
                      {n.title || 'Untitled'}
                    </span>
                    <span className="updated">{formatTimeAgo(n.updated_at)}</span>
                  </div>
                  <div className="preview">{previewText}</div>
                  {n.tags.length > 0 && !vaultLocked && (
                    <div className="note-item-tags">
                      {n.tags.slice(0, 3).map(t => (
                        <span key={t} className="note-item-tag">#{t}</span>
                      ))}
                    </div>
                  )}
                </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </section>

      {/* ───────── Editor ───────── */}
      {selected ? (
        <Editor
          note={selected}
          breadcrumb={selected.folder}
          status={status}
          statusMsg={statusMsg}
          wordCount={wordCount}
          modelId={modelId}
          notes={session.notes}
          tier={getCurrentTier(session)}
          onChange={handleEditorChange}
          onDelete={() => handleDeleteNote(selected.id)}
          onOpenSubscription={() => { setSettingsTab('subscription'); setSettingsOpen(true); }}
        />
      ) : (
        <div className="editor-pane">
          <div className="editor-header">
            <div className="breadcrumb"><span className="crumb">Meo</span></div>
          </div>
          <div className="empty">Select a note or create a new one.</div>
          <div className="statusbar">
            <span><span className={`dot ${status === 'idle' ? 'ok' : status === 'error' ? 'err' : 'syncing'}`}>●</span> {statusMsg || 'Ready'}</span>
            <div className="grow" />
            <span>{allNotes.length} {allNotes.length === 1 ? 'note' : 'notes'} · cursor {session.syncCursor}</span>
          </div>
        </div>
      )}

      {/* Search overlay */}
      {searchOpen && (
        <SearchOverlay
          notes={allNotes}
          folders={folderTree}
          onSelectNote={(id) => setSelectedId(id)}
          onSelectFolder={(path) => { setSelectedFolder(path); setSelectedTag(null); }}
          onSelectTag={(tag) => { setSelectedTag(tag); setSelectedFolder(''); }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {/* Floating context menu */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}

      {/* AI panel (right drawer) */}
      {aiPanelOpen && session && (
        <AIPanel
          notes={session.notes}
          modelId={modelId}
          onClose={() => setAiPanelOpen(false)}
          onOpenNote={(id) => { setSelectedId(id); }}
          applyToolCall={async (call) => {
            // Funnel AI-proposed CRUD through the same session-bound
            // helpers a manual edit would use, so encryption + sync +
            // HLC bookkeeping all happen exactly once. The user has
            // already clicked Apply on the chip by the time we get here.
            const res = await A.applyNoteToolCall(call, {
              notes: session.notes,
              newDraft,
              saveNote: async (n) => {
                const saved = await saveNote(session, n);
                session.notes.set(saved.id, saved);
                return saved;
              },
              deleteNote: async (id) => {
                await deleteNote(session, id);
                session.notes.delete(id);
              },
            });
            // Force a re-render so the sidebar / editor reflect the
            // mutation. setSession would re-trigger derived state but
            // we don't actually have a "session is new" event yet, so
            // bump selectedId to the affected note (or null on delete).
            if (res.ok && res.resultId && call.type !== 'delete') {
              setSelectedId(res.resultId);
            }
            return res;
          }}
        />
      )}

      {/* Settings */}
      {settingsOpen && session && (
        <Settings
          session={session}
          notes={session.notes}
          modelId={modelId}
          initialTab={settingsTab}
          onSelectModel={setModelId}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* About modal - opened from the macOS App menu (Agent 5). */}
      {aboutOpen && (
        <AboutModal onClose={() => setAboutOpen(false)} />
      )}

      {/* QR-pairing modal - opened from File ▸ New Device… (Agent 9). */}
      {pairingOpen && session && (
        <Pairing session={session} onClose={() => setPairingOpen(false)} />
      )}

      {/* Vault unlock modal (Agent 8). Mounts when the selected note is a
          locked vault note; resolved by calling unlockVaultNote on the
          session, which decrypts the inner body in place. */}
      {vaultPrompt && session && (() => {
        const n = session.notes.get(vaultPrompt.noteId);
        return (
          <Vault
            noteTitle={n?.title ?? ''}
            onUnlock={async () => {
              await unlockVaultNote(session, vaultPrompt.noteId);
              setVaultPrompt(null);
              refresh();
            }}
            onCancel={() => {
              setVaultPrompt(null);
              setSelectedId(null);
            }}
          />
        );
      })()}

      {/* 2FA cold-start gate (Agent 8). Business+ only. Stays mounted
          until the user enters a valid 6-digit TOTP code. */}
      {tfaGated && session && (
        <TFAVerify session={session} onVerified={() => setTfaGated(false)} />
      )}
    </div>
  );
}

// ─── Device naming + platform detection (Agent 9) ────────────────────
//
// `defaultDeviceName` builds a friendly name like "MacBook · Chrome" so
// the Settings → Devices pane can distinguish entries before the user
// renames them. `detectPlatform` returns one of the 5 strings the
// `meo.devices.platform` column accepts.

function defaultDeviceName(): string {
  if (typeof navigator === 'undefined') return 'Desktop';
  const ua = navigator.userAgent;
  let host = 'Desktop';
  if (isMac) host = 'Mac';
  else if (isWindows) host = 'Windows PC';
  else if (/Linux/i.test(ua)) host = 'Linux PC';
  let browser = '';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  return browser ? `${host} · ${browser}` : host;
}

function detectPlatform(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  if (isMac) return 'macos';
  if (isWindows) return 'windows';
  if (/Linux/i.test(navigator.userAgent)) return 'linux';
  return 'web';
}

// Minimal About sheet. We render the Meo wordmark + version + a
// link to the project website. Click the backdrop or press Esc to
// close (Esc is wired by the keydown handler at the top of App).
function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="About Meo"
      onClick={onClose}
    >
      <div
        className="about-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="about-mark"><MeoMark size={48} /></div>
        <div className="about-name">Meo</div>
        <div className="about-version">Version {APP_VERSION}</div>
        <div className="about-tagline">End-to-end encrypted markdown notes.</div>
        <a
          className="about-link"
          href="https://meo.md"
          target="_blank"
          rel="noreferrer noopener"
        >meo.md</a>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ─── Folder tree (recursive-ish, single-level lookahead) ───

interface FolderTreeProps {
  tree: { path: string; count: number }[];
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  selected: string;
  tagFilter: string | null;
  onSelect: (path: string) => void;
  onContext: (e: React.MouseEvent, path: string) => void;
  renaming: string | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  onCommitRename: (oldPath: string) => void;
  onCancelRename: () => void;
  creatingFolder: { parent: string } | null;
  createValue: string;
  setCreateValue: (v: string) => void;
  onCommitCreate: () => void;
  onCancelCreate: () => void;
  onDropNote: (noteId: string, folderPath: string) => void;
}

function FolderTree({
  tree, expanded, setExpanded, selected, tagFilter,
  onSelect, onContext, renaming, renameValue, setRenameValue,
  onCommitRename, onCancelRename, creatingFolder, createValue, setCreateValue,
  onCommitCreate, onCancelCreate, onDropNote,
}: FolderTreeProps) {
  // Determine which paths to show: any path whose parent is in `expanded`,
  // plus all top-level paths.
  const visible = tree.filter(({ path }) => {
    const parts = path.split('/');
    if (parts.length === 1) return true;
    // Show if every ancestor is expanded
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      if (!expanded.has(acc)) return false;
    }
    return true;
  });

  const hasChildren = (path: string) =>
    tree.some(t => t.path.startsWith(path + '/'));

  const toggle = (path: string) => setExpanded(s => {
    const n = new Set(s);
    if (n.has(path)) n.delete(path); else n.add(path);
    return n;
  });

  return (
    <>
      {visible.map(({ path, count }) => {
        const indent = path.split('/').length - 1;
        const label = path.split('/').pop() ?? path;
        const active = !tagFilter && selected === path;
        const expandable = hasChildren(path);
        const isExpanded = expanded.has(path);
        const isRenaming = renaming === path;
        const showCreateInput = creatingFolder?.parent === path;

        return (
          <React.Fragment key={path}>
            <div
              className={`folder-row ${active ? 'active' : ''}`}
              style={{ paddingLeft: 6 + indent * 14 }}
              onClick={() => onSelect(path)}
              onContextMenu={(e) => onContext(e, path)}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('application/x-meo-note-id');
                if (id) onDropNote(id, path);
              }}
            >
              <button
                type="button"
                className="folder-chevron"
                onClick={(e) => { e.stopPropagation(); if (expandable) toggle(path); }}
                style={{ visibility: expandable ? 'visible' : 'hidden' }}
                title={isExpanded ? 'Collapse' : 'Expand'}
              >
                <Icon.Chevron size={10} style={{ transform: isExpanded ? 'rotate(90deg)' : 'none' }} />
              </button>
              <Icon.Folder size={14} className="row-icon" stroke={active ? 'var(--accent)' : 'currentColor'} />
              {isRenaming ? (
                <input
                  className="folder-rename-input"
                  value={renameValue}
                  autoFocus
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onCommitRename(path);
                    if (e.key === 'Escape') onCancelRename();
                  }}
                  onBlur={() => onCommitRename(path)}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <span className="row-label" title={path}>{label}</span>
                  <span className="row-count">{count}</span>
                </>
              )}
            </div>

            {showCreateInput && (
              <div className="folder-row" style={{ paddingLeft: 6 + (indent + 1) * 14 }}>
                <span className="folder-chevron" />
                <Icon.Folder size={14} className="row-icon" stroke="var(--ink3)" />
                <input
                  className="folder-rename-input"
                  value={createValue}
                  autoFocus
                  placeholder="Folder name"
                  onChange={(e) => setCreateValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onCommitCreate();
                    if (e.key === 'Escape') onCancelCreate();
                  }}
                  onBlur={() => onCommitCreate()}
                />
              </div>
            )}
          </React.Fragment>
        );
      })}

      {/* Top-level "create folder" inline input */}
      {creatingFolder?.parent === '' && (
        <div className="folder-row" style={{ paddingLeft: 6 }}>
          <span className="folder-chevron" />
          <Icon.Folder size={14} className="row-icon" stroke="var(--ink3)" />
          <input
            className="folder-rename-input"
            value={createValue}
            autoFocus
            placeholder="Folder name"
            onChange={(e) => setCreateValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommitCreate();
              if (e.key === 'Escape') onCancelCreate();
            }}
            onBlur={() => onCommitCreate()}
          />
        </div>
      )}
    </>
  );
}

// ─── A simple sidebar row ───
function FolderRow({
  label, count, icon, active, onClick, onContextMenu,
}: {
  label: string; count: number; icon: keyof typeof Icon;
  active: boolean; onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const IconComp = Icon[icon];
  return (
    <div
      className={`folder-row ${active ? 'active' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="folder-chevron" />
      <IconComp size={14} className="row-icon" stroke={active ? 'var(--accent)' : 'currentColor'} />
      <span className="row-label">{label}</span>
      <span className="row-count">{count}</span>
    </div>
  );
}

function formatTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Date-grouped notes list (mac Notes pattern) ─────────────────────
//
// Buckets, in order:
//   Today / Yesterday / Previous 7 Days / Previous 30 Days
//   then for each older calendar month within the current year:
//     <Month name> (e.g. "March")
//   then for each older year:
//     <Year> (e.g. "2024")
//
// `notes` is assumed to be already sorted by `updated_at` descending -
// we only iterate once and append to the matching bucket. All cutoffs
// are computed against local-time midnight, so a note touched at
// 12:01 AM "today" goes to **Today**, while 11:59 PM "yesterday" goes
// to **Yesterday** (the cutoff is exclusive on the older side).
//
// Empty buckets are dropped.
export function groupNotesByDate(notes: Note[]): Array<{ label: string; notes: Note[] }> {
  if (notes.length === 0) return [];

  const now = new Date();
  // Local-time midnight today.
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const sevenDaysStart = todayStart - 7 * 86_400_000;
  const thirtyDaysStart = todayStart - 30 * 86_400_000;
  const currentYear = now.getFullYear();

  const monthName = (m: number) =>
    new Date(2000, m, 1).toLocaleDateString(undefined, { month: 'long' });

  // Build ordered buckets via a Map (preserves insertion order). Notes
  // arrive in descending updated_at order, so monthly/year buckets
  // naturally appear in the right top-down order without re-sorting.
  const buckets = new Map<string, { label: string; notes: Note[] }>();
  const ensure = (key: string, label: string) => {
    let b = buckets.get(key);
    if (!b) { b = { label, notes: [] }; buckets.set(key, b); }
    return b;
  };

  for (const n of notes) {
    const t = new Date(n.updated_at).getTime();
    if (Number.isNaN(t)) continue;
    let key: string;
    let label: string;
    if (t >= todayStart) {
      key = 'today'; label = 'Today';
    } else if (t >= yesterdayStart) {
      key = 'yesterday'; label = 'Yesterday';
    } else if (t >= sevenDaysStart) {
      key = '7d'; label = 'Previous 7 Days';
    } else if (t >= thirtyDaysStart) {
      key = '30d'; label = 'Previous 30 Days';
    } else {
      const d = new Date(t);
      const y = d.getFullYear();
      if (y === currentYear) {
        const m = d.getMonth();
        key = `m-${y}-${m}`; label = monthName(m);
      } else {
        key = `y-${y}`; label = String(y);
      }
    }
    ensure(key, label).notes.push(n);
  }

  return Array.from(buckets.values());
}
