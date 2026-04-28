import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import {
  ApiClient, SupabaseApiClient, encryptNote, decryptNote, base64ToBytes, bytesToBase64,
  hlcZero, hlcTick, hlcEncode, uuidv4,
} from './shared';
import type { Note, EncryptedNoteRow } from './shared';

const STORAGE_KEYS = {
  jwt: 'meo.jwt',
  user_id: 'meo.user_id',
  email: 'meo.email',
  cursor: 'meo.cursor',
  notes: 'meo.notes',
  empty_folders: 'meo.empty_folders',
};

export type AnyApiClient = ApiClient | SupabaseApiClient;

export interface MobileSession {
  api: AnyApiClient;
  masterRaw: Uint8Array;
  user_id: string;
  email: string;
  notes: Map<string, Note>;
  syncCursor: number;
  hlc: ReturnType<typeof hlcZero>;
}

/**
 * Factory that picks the data backend per app.json `extra` config:
 *   extra.dataBackend: 'supabase' (default) | 'hono'
 *   extra.supabaseUrl, extra.supabaseAnonKey, extra.apiUrl
 */
export function makeApiClient(jwt?: string): AnyApiClient {
  const extra = (Constants.expoConfig?.extra as any) ?? {};
  const backend = extra.dataBackend ?? 'supabase';
  if (backend === 'supabase') {
    const url = extra.supabaseUrl ?? 'http://127.0.0.1:54321';
    const anonKey = extra.supabaseAnonKey ?? '';
    return new SupabaseApiClient({ url, anonKey }, jwt);
  }
  return new ApiClient(extra.apiUrl ?? 'http://localhost:8787', jwt);
}

export async function getEmptyFolders(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.empty_folders);
  return raw ? JSON.parse(raw) : [];
}
export async function setEmptyFolders(list: string[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.empty_folders, JSON.stringify(list));
}

export async function persistJwt(jwt: string, userId: string, email: string) {
  await SecureStore.setItemAsync(STORAGE_KEYS.jwt, jwt);
  await AsyncStorage.setItem(STORAGE_KEYS.user_id, userId);
  await AsyncStorage.setItem(STORAGE_KEYS.email, email);
}

export async function loadJwt(): Promise<{ jwt: string; user_id: string; email: string } | null> {
  const jwt = await SecureStore.getItemAsync(STORAGE_KEYS.jwt);
  const user_id = await AsyncStorage.getItem(STORAGE_KEYS.user_id);
  const email = await AsyncStorage.getItem(STORAGE_KEYS.email);
  if (!jwt || !user_id || !email) return null;
  return { jwt, user_id, email };
}

export async function clearLocal() {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.jwt).catch(() => {});
  await AsyncStorage.multiRemove([STORAGE_KEYS.user_id, STORAGE_KEYS.email, STORAGE_KEYS.cursor, STORAGE_KEYS.notes]);
}

async function loadCachedRows(): Promise<EncryptedNoteRow[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.notes);
  return raw ? JSON.parse(raw) : [];
}

async function saveCachedRows(rows: EncryptedNoteRow[]) {
  await AsyncStorage.setItem(STORAGE_KEYS.notes, JSON.stringify(rows));
}

async function loadCursor(): Promise<number> {
  const v = await AsyncStorage.getItem(STORAGE_KEYS.cursor);
  return v ? Number(v) : 0;
}

async function saveCursor(v: number) {
  await AsyncStorage.setItem(STORAGE_KEYS.cursor, String(v));
}

export async function rehydrate(session: MobileSession) {
  const rows = await loadCachedRows();
  for (const row of rows) {
    if (row.deleted_at) continue;
    try {
      const note = decryptNote(base64ToBytes(row.encrypted_content), base64ToBytes(row.nonce), row.id, session.masterRaw);
      session.notes.set(row.id, note);
    } catch {}
  }
  session.syncCursor = await loadCursor();
}

export async function pullSync(session: MobileSession): Promise<{ pulled: number }> {
  const resp = await session.api.syncNotes(session.syncCursor);
  if (!resp.notes.length) return { pulled: 0 };
  const cached = await loadCachedRows();
  const byId = new Map(cached.map((r) => [r.id, r]));
  for (const row of resp.notes) {
    byId.set(row.id, row);
    if (row.deleted_at) {
      session.notes.delete(row.id);
    } else {
      try {
        const note = decryptNote(base64ToBytes(row.encrypted_content), base64ToBytes(row.nonce), row.id, session.masterRaw);
        session.notes.set(row.id, note);
        const inboundMs = Number(row.hlc_timestamp.split('-')[0]);
        if (inboundMs >= session.hlc.ms) session.hlc = { ms: inboundMs, counter: session.hlc.counter };
      } catch {}
    }
  }
  await saveCachedRows(Array.from(byId.values()));
  session.syncCursor = resp.cursor;
  await saveCursor(resp.cursor);
  return { pulled: resp.notes.length };
}

export async function saveNote(session: MobileSession, note: Note): Promise<Note> {
  session.hlc = hlcTick(session.hlc);
  const updated: Note = {
    ...note,
    updated_at: new Date().toISOString(),
    hlc: hlcEncode(session.hlc),
  };
  const enc = encryptNote(updated, session.masterRaw);
  const row: EncryptedNoteRow = {
    id: updated.id,
    encrypted_content: bytesToBase64(enc.ciphertext),
    nonce: bytesToBase64(enc.nonce),
    hlc_timestamp: updated.hlc,
    updated_at: 0, deleted_at: null, version: 0, size_bytes: enc.ciphertext.length,
  };
  const saved = await session.api.upsertNote(row);
  session.notes.set(updated.id, updated);
  const cached = await loadCachedRows();
  const next = cached.filter((r) => r.id !== saved.id);
  next.push(saved);
  await saveCachedRows(next);
  if (saved.version > session.syncCursor) {
    session.syncCursor = saved.version;
    await saveCursor(saved.version);
  }
  return updated;
}

export async function deleteNote(session: MobileSession, id: string) {
  const tomb = await session.api.deleteNote(id);
  session.notes.delete(id);
  const cached = await loadCachedRows();
  const next = cached.filter((r) => r.id !== id);
  next.push(tomb);
  await saveCachedRows(next);
  if (tomb.version > session.syncCursor) {
    session.syncCursor = tomb.version;
    await saveCursor(tomb.version);
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
  for (const path of emptyFolders) {
    if (!counts.has(path)) counts.set(path, 0);
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

export function buildTagList(notes: Note[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of notes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}
