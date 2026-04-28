// In-memory session: master key + decrypted notes. Lost on tab refresh by design.

import {
  ApiClient, SupabaseApiClient, encryptNote, decryptNote, base64ToBytes, bytesToBase64,
  hlcZero, hlcTick, hlcEncode, hlcCompare, uuidv4,
  type Note, type EncryptedNoteRow,
} from '@meo/shared';
import { getMeta, setMeta, listCachedNotes, putCachedNote } from './storage';

declare const __API_URL__: string;
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;
declare const __DATA_BACKEND__: string;

// Discriminated union: same surface, different implementation.
export type AnyApiClient = ApiClient | SupabaseApiClient;

export interface Session {
  api: AnyApiClient;
  masterRaw: Uint8Array;
  user_id: string;
  email: string;
  notes: Map<string, Note>;
  syncCursor: number;
  hlc: ReturnType<typeof hlcZero>;
}

export const dataBackend = (typeof __DATA_BACKEND__ !== 'undefined' ? __DATA_BACKEND__ : 'supabase') as 'supabase' | 'hono';
export const apiBaseUrl = (typeof __API_URL__ !== 'undefined' ? __API_URL__ : 'http://localhost:8787');
export const supabaseUrl = (typeof __SUPABASE_URL__ !== 'undefined' ? __SUPABASE_URL__ : 'http://127.0.0.1:54321');
export const supabaseAnonKey = (typeof __SUPABASE_ANON_KEY__ !== 'undefined' ? __SUPABASE_ANON_KEY__ : '');

export function makeApiClient(jwt?: string): AnyApiClient {
  if (dataBackend === 'supabase') {
    return new SupabaseApiClient({ url: supabaseUrl, anonKey: supabaseAnonKey }, jwt);
  }
  return new ApiClient(apiBaseUrl, jwt);
}

export async function rehydrateNotes(session: Session): Promise<void> {
  const cached = await listCachedNotes();
  for (const row of cached) {
    if (row.deleted_at) continue;
    try {
      const note = await decryptNote(base64ToBytes(row.encrypted_content), base64ToBytes(row.nonce), row.id, session.masterRaw);
      session.notes.set(row.id, note);
    } catch (e) {
      console.warn('failed to decrypt cached note', row.id, e);
    }
  }
}

export async function pullSync(session: Session): Promise<{ pulled: number }> {
  const resp = await session.api.syncNotes(session.syncCursor);
  for (const row of resp.notes) {
    await putCachedNote(row);
    if (row.deleted_at) {
      session.notes.delete(row.id);
    } else {
      try {
        const note = await decryptNote(base64ToBytes(row.encrypted_content), base64ToBytes(row.nonce), row.id, session.masterRaw);
        session.notes.set(row.id, note);
        // advance HLC to dominate any inbound clock
        const inboundMs = Number(row.hlc_timestamp.split('-')[0]);
        if (inboundMs >= session.hlc.ms) session.hlc = { ms: inboundMs, counter: session.hlc.counter };
      } catch (e) {
        console.warn('failed to decrypt synced note', row.id, e);
      }
    }
  }
  if (resp.notes.length) {
    session.syncCursor = resp.cursor;
    await setMeta({ sync_cursor: session.syncCursor });
  }
  return { pulled: resp.notes.length };
}

export async function saveNote(session: Session, note: Note): Promise<Note> {
  session.hlc = hlcTick(session.hlc);
  const updated: Note = {
    ...note,
    updated_at: new Date().toISOString(),
    hlc: hlcEncode(session.hlc),
  };
  const enc = await encryptNote(updated, session.masterRaw);
  const row: EncryptedNoteRow = {
    id: updated.id,
    encrypted_content: bytesToBase64(enc.ciphertext),
    nonce: bytesToBase64(enc.nonce),
    hlc_timestamp: updated.hlc,
    updated_at: 0, deleted_at: null, version: 0, size_bytes: enc.ciphertext.length,
  };
  const saved = await session.api.upsertNote(row);
  await putCachedNote(saved);
  session.notes.set(updated.id, updated);
  if (saved.version > session.syncCursor) {
    session.syncCursor = saved.version;
    await setMeta({ sync_cursor: session.syncCursor });
  }
  return updated;
}

export async function deleteNote(session: Session, id: string): Promise<void> {
  const tomb = await session.api.deleteNote(id);
  await putCachedNote(tomb);
  session.notes.delete(id);
  if (tomb.version > session.syncCursor) {
    session.syncCursor = tomb.version;
    await setMeta({ sync_cursor: session.syncCursor });
  }
}

export function newDraft(): Note {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    title: 'Untitled',
    body: '',
    folder: [],
    tags: [],
    links: [],
    created_at: now,
    updated_at: now,
    hlc: hlcEncode(hlcZero()),
    version: 0,
  };
}

export function buildFolderTree(
  notes: Note[],
  emptyFolders: string[] = [],
): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of notes) {
    let acc = '';
    for (let i = 0; i < n.folder.length; i++) {
      acc = acc ? `${acc}/${n.folder[i]}` : n.folder[i];
      counts.set(acc, (counts.get(acc) ?? 0) + 1);
    }
  }
  // Empty folders that have no notes yet
  for (const path of emptyFolders) {
    if (!counts.has(path)) counts.set(path, 0);
    // also walk up so parents exist
    let acc = '';
    for (const part of path.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      if (!counts.has(acc)) counts.set(acc, 0);
    }
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, count]) => ({ path, count }));
}

// Distinct tags from all notes, with usage count.
export function buildTagList(notes: Note[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of notes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

// Rename a folder: rewrites folder paths on every affected note.
export async function renameFolderEverywhere(
  session: Session, oldPath: string, newPath: string,
): Promise<number> {
  const oldParts = oldPath.split('/');
  let n = 0;
  for (const note of Array.from(session.notes.values())) {
    const p = note.folder;
    if (p.length < oldParts.length) continue;
    const matches = oldParts.every((part, i) => p[i] === part);
    if (!matches) continue;
    const newParts = newPath.split('/');
    const next: Note = { ...note, folder: [...newParts, ...p.slice(oldParts.length)] };
    await saveNote(session, next);
    n++;
  }
  return n;
}

// Move a note to a new folder path (absolute).
export async function moveNoteToFolder(
  session: Session, noteId: string, newPath: string,
): Promise<void> {
  const note = session.notes.get(noteId);
  if (!note) return;
  const folder = newPath ? newPath.split('/').filter(Boolean) : [];
  const next: Note = { ...note, folder };
  await saveNote(session, next);
}

export { hlcCompare };
