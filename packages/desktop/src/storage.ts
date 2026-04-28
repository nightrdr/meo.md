import { openDB, type IDBPDatabase } from 'idb';
import type { EncryptedNoteRow, AccountWrapper } from '@meo/shared';

interface Meta {
  jwt?: string;
  user_id?: string;
  email?: string;
  sync_cursor: number;
  account_wrapper?: AccountWrapper;
  // user prefs
  empty_folders?: string[];      // folders without notes (so they show in tree)
  ai_on?: boolean;
  model_id?: string;
  expanded_folders?: string[];
}

const DB_NAME = 'meo-md';
const VERSION = 2;   // bumped: added 'vectors' object store

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, VERSION, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (oldVersion < 2 && !db.objectStoreNames.contains('vectors')) {
        db.createObjectStore('vectors', { keyPath: 'noteId' });
      }
    },
  });
}

export async function getMeta(): Promise<Meta> {
  const db = await getDb();
  const meta = (await db.get('meta', 'state')) as Meta | undefined;
  return meta ?? { sync_cursor: 0 };
}

export async function setMeta(patch: Partial<Meta>): Promise<Meta> {
  const db = await getDb();
  const existing = ((await db.get('meta', 'state')) as Meta | undefined) ?? { sync_cursor: 0 };
  const next = { ...existing, ...patch };
  await db.put('meta', next, 'state');
  return next;
}

export async function clearAll() {
  const db = await getDb();
  await db.clear('meta');
  await db.clear('notes');
  if (db.objectStoreNames.contains('vectors')) await db.clear('vectors');
}

// ─── Vector persistence ────────────────────────────────────────────

export interface PersistedVector {
  noteId: string;
  vec: ArrayBuffer;        // serialized Float32Array buffer
  vec_hash: string;
  embedder_id: string;
}

export async function loadAllVectors(): Promise<PersistedVector[]> {
  const db = await getDb();
  return (await db.getAll('vectors')) as PersistedVector[];
}

export async function putVector(row: PersistedVector): Promise<void> {
  const db = await getDb();
  await db.put('vectors', row);
}

export async function deleteVector(noteId: string): Promise<void> {
  const db = await getDb();
  await db.delete('vectors', noteId);
}

export async function getCachedNote(id: string): Promise<EncryptedNoteRow | undefined> {
  const db = await getDb();
  return (await db.get('notes', id)) as EncryptedNoteRow | undefined;
}

export async function listCachedNotes(): Promise<EncryptedNoteRow[]> {
  const db = await getDb();
  return (await db.getAll('notes')) as EncryptedNoteRow[];
}

export async function putCachedNote(row: EncryptedNoteRow) {
  const db = await getDb();
  await db.put('notes', row);
}
