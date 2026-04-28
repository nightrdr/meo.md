import React, { useEffect, useState, useRef, useMemo } from 'react';
import { Icon } from './Icon';
import type { Note } from '@meo/shared';

interface Props {
  notes: Note[];
  folders: { path: string; count: number }[];
  onSelectNote: (id: string) => void;
  onSelectFolder: (path: string) => void;
  onSelectTag: (tag: string) => void;
  onClose: () => void;
}

interface Match {
  type: 'note' | 'folder' | 'tag';
  id: string;
  title: string;
  snippet?: string;
  folder?: string;
  count?: number;
}

export function SearchOverlay({ notes, folders, onSelectNote, onSelectFolder, onSelectTag, onClose }: Props) {
  const [q, setQ] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const matches = useMemo<Match[]>(() => {
    const needle = q.trim().toLowerCase();
    const out: Match[] = [];
    if (!needle) {
      // recent notes only when empty
      for (const n of notes.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6)) {
        out.push({ type: 'note', id: n.id, title: n.title || 'Untitled', folder: n.folder.join('/'), snippet: firstLine(n.body) });
      }
      return out;
    }
    // Note matches
    for (const n of notes) {
      const hay = ((n.title || '') + ' ' + n.body + ' ' + n.tags.join(' ') + ' ' + n.folder.join(' ')).toLowerCase();
      const idx = hay.indexOf(needle);
      if (idx >= 0) {
        out.push({
          type: 'note', id: n.id, title: n.title || 'Untitled',
          folder: n.folder.join('/'),
          snippet: snippetAround(n.body, needle) || firstLine(n.body),
        });
      }
    }
    // Folder matches (use the materialized folder tree so empty folders are searchable too)
    for (const f of folders) {
      if (f.path && f.path.toLowerCase().includes(needle)) {
        out.push({ type: 'folder', id: f.path, title: f.path, count: f.count });
      }
    }
    // Tag matches
    const tagSet = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) tagSet.set(t, (tagSet.get(t) ?? 0) + 1);
    for (const [tag, count] of tagSet) {
      if (tag.toLowerCase().includes(needle)) {
        out.push({ type: 'tag', id: tag, title: '#' + tag, count });
      }
    }
    return out.slice(0, 30);
  }, [q, notes]);

  useEffect(() => { setActiveIndex(0); }, [q]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = matches[activeIndex];
      if (!m) return;
      if (m.type === 'note') onSelectNote(m.id);
      else if (m.type === 'folder') onSelectFolder(m.id);
      else onSelectTag(m.id);
      onClose();
    }
  };

  const noteMatches = matches.filter(m => m.type === 'note');
  const folderMatches = matches.filter(m => m.type === 'folder');
  const tagMatches = matches.filter(m => m.type === 'tag');

  let runningIdx = -1;
  const idxFor = () => ++runningIdx;

  return (
    <div className="search-overlay" onMouseDown={onClose}>
      <div className="search-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <Icon.Search size={16} stroke="var(--ink3)" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search notes, folders, tags"
          />
          <span className="kbd">esc</span>
        </div>

        <div className="search-results">
          {matches.length === 0 && (
            <div className="search-empty">No matches.</div>
          )}

          {noteMatches.length > 0 && (
            <>
              <div className="search-section">{q ? 'Notes' : 'Recent'}</div>
              {noteMatches.map(m => {
                const idx = idxFor();
                return (
                  <button key={m.id} type="button"
                    className={`search-result note ${idx === activeIndex ? 'active' : ''}`}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => { onSelectNote(m.id); onClose(); }}
                  >
                    <Icon.Note size={15} stroke="var(--ink3)" />
                    <div className="search-result-body">
                      <div className="search-result-title">{m.title}</div>
                      {m.snippet && <div className="search-result-snippet">{m.snippet}</div>}
                    </div>
                    {m.folder && <span className="search-result-folder">{m.folder}</span>}
                    {idx === activeIndex && <Icon.Return size={12} stroke="var(--ink3)" />}
                  </button>
                );
              })}
            </>
          )}

          {folderMatches.length > 0 && (
            <>
              <div className="search-section">Folders</div>
              {folderMatches.map(m => {
                const idx = idxFor();
                return (
                  <button key={m.id} type="button"
                    className={`search-result folder ${idx === activeIndex ? 'active' : ''}`}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => { onSelectFolder(m.id); onClose(); }}
                  >
                    <Icon.Folder size={15} stroke="var(--ink3)" />
                    <div className="search-result-body">
                      <div className="search-result-title">{m.title}</div>
                    </div>
                    <span className="search-result-folder">{m.count} {m.count === 1 ? 'note' : 'notes'}</span>
                  </button>
                );
              })}
            </>
          )}

          {tagMatches.length > 0 && (
            <>
              <div className="search-section">Tags</div>
              {tagMatches.map(m => {
                const idx = idxFor();
                return (
                  <button key={m.id} type="button"
                    className={`search-result tag ${idx === activeIndex ? 'active' : ''}`}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => { onSelectTag(m.id); onClose(); }}
                  >
                    <Icon.Tag size={15} stroke="var(--ink3)" />
                    <div className="search-result-body">
                      <div className="search-result-title">{m.title}</div>
                    </div>
                    <span className="search-result-folder">{m.count} {m.count === 1 ? 'note' : 'notes'}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>

        <div className="search-footer">
          <span><span className="kbd">↑↓</span> Navigate</span>
          <span><span className="kbd">↵</span> Open</span>
          <span><span className="kbd">esc</span> Close</span>
        </div>
      </div>
    </div>
  );
}

function firstLine(body: string): string {
  const ln = body.split('\n').find(l => l.trim() && !l.startsWith('#'));
  return ln?.slice(0, 140) ?? '';
}

function snippetAround(body: string, needle: string): string {
  const lower = body.toLowerCase();
  const i = lower.indexOf(needle);
  if (i < 0) return '';
  const start = Math.max(0, i - 30);
  const end = Math.min(body.length, i + needle.length + 60);
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
}
