import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { Note } from '@meo/shared';
import { AuthScreen } from './Auth';
import { Editor } from './Editor';
import {
  rehydrateNotes, pullSync, saveNote, deleteNote, newDraft, buildFolderTree,
  buildTagList, renameFolderEverywhere, moveNoteToFolder,
  type Session,
} from './session';
import { clearAll, getMeta, setMeta } from './storage';
import { MeoMark, Icon } from './Icon';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { SearchOverlay } from './SearchOverlay';
import { AIControls, MODELS } from './AIControls';
import { AIPanel } from './AIPanel';
import { Settings } from './Settings';
import { peekAIRuntime } from './aiStore';
import { Mod, shortcut } from './platform';
import { setAttachmentsContext } from './AttachmentRenderer';
import { supabaseUrl, supabaseAnonKey } from './session';

type Status = 'idle' | 'syncing' | 'saving' | 'error';

interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [tick, setTick] = useState(0);
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const [modelId, setModelId] = useState<string>(MODELS[0].id);
  const [dynamicModels, setDynamicModels] = useState<typeof MODELS>([]);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const saveTimer = useRef<number | null>(null);

  const refresh = useCallback(() => setTick(x => x + 1), []);

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
  // button — this handles the F11/document.fullscreenElement case).
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
      if (e.key === 'Escape') {
        // Topmost overlay first — order matches z-index reading.
        if (menu) { setMenu(null); e.preventDefault(); return; }
        if (searchOpen) { setSearchOpen(false); e.preventDefault(); return; }
        if (settingsOpen) { setSettingsOpen(false); e.preventDefault(); return; }
        if (tagAddOpen) { setTagAddOpen(false); setTagAddInput(''); e.preventDefault(); return; }
        if (creatingFolder) { setCreatingFolder(null); setFolderInput(''); e.preventDefault(); return; }
        if (renamingFolder) { setRenamingFolder(null); setFolderInput(''); e.preventDefault(); return; }
        if (aiPanelOpen) { setAiPanelOpen(false); e.preventDefault(); return; }
        // Editor-internal overlays (find bar, AI bubbles, slash menu) handle
        // Esc themselves at a deeper level and stopPropagation when they
        // consume it. If we got here, nothing app-level is open — try to
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
  }, [session, aiOn, menu, searchOpen, settingsOpen, tagAddOpen, creatingFolder, renamingFolder, aiPanelOpen]);

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
    setModelId(meta.model_id ?? MODELS[0].id);
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
    await clearAll();
    setAttachmentsContext(null);
    setSession(null);
    setSelectedId(null);
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
    return [
      { label: 'Open', icon: 'Note', onClick: () => setSelectedId(note.id) },
      { label: 'Duplicate', icon: 'Copy', onClick: async () => {
        if (!session) return;
        const copy: Note = {
          ...note,
          id: crypto.randomUUID(),
          title: `${note.title || 'Untitled'} copy`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        session.notes.set(copy.id, copy);
        await saveNote(session, copy);
        setSelectedId(copy.id);
        refresh();
      }},
      { separator: true },
      { label: 'Copy title', icon: 'Copy', onClick: () => navigator.clipboard.writeText(note.title || 'Untitled') },
      { label: 'Copy markdown body', icon: 'Copy', onClick: () => navigator.clipboard.writeText(note.body) },
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
        setDynamicModels(list as any);
        // If the currently-selected model id isn't in the list AND
        // there's at least one Ollama model, auto-select the first one.
        if (list.length > 0 && !list.some(l => l.id === modelId) &&
            !MODELS.some(s => s.id === modelId && s.kind === 'commercial')) {
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

  if (!session) {
    return <AuthScreen onAuthenticated={onAuth} />;
  }

  // Word count for status bar
  const wordCount = selected ? selected.body.split(/\s+/).filter(Boolean).length : 0;

  return (
    <div className={`app ${aiPanelOpen ? 'ai-open' : ''}`}>
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
          {visibleNotes.map((n) => (
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
                <span className="title">{n.title || 'Untitled'}</span>
                <span className="updated">{formatTimeAgo(n.updated_at)}</span>
              </div>
              <div className="preview">
                {(n.body.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? '').slice(0, 200) || ' '}
              </div>
              {n.tags.length > 0 && (
                <div className="note-item-tags">
                  {n.tags.slice(0, 3).map(t => (
                    <span key={t} className="note-item-tag">#{t}</span>
                  ))}
                </div>
              )}
            </div>
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
          onChange={handleEditorChange}
          onDelete={() => handleDeleteNote(selected.id)}
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
        />
      )}

      {/* Settings */}
      {settingsOpen && session && (
        <Settings
          notes={session.notes}
          modelId={modelId}
          onSelectModel={setModelId}
          onClose={() => setSettingsOpen(false)}
        />
      )}
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
