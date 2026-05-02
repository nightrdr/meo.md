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
  sidebar_hidden?: boolean;      // collapse the leftmost sidebar column
  // first-run setup (Agent 7)
  onboarding_done?: boolean;
  installed_models?: string[];   // ids of model files cached in this device
  // BYO cloud LLM keys — local only, never sent to our server.
  // null/empty for tiers that haven't earned the privilege.
  cloud_keys?: { openai?: string; anthropic?: string; google?: string };
  // Stable per-installation device id for the device cap + Devices pane
  // (Agent 9). Generated lazily on first cold start; never sent in the
  // QR pairing payload (B picks its own).
  device_id?: string;
  device_name?: string;
}

const DB_NAME = 'meo-md';
const VERSION = 3;   // v3: added 'model_files' object store (Agent 7)

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, VERSION, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (oldVersion < 2 && !db.objectStoreNames.contains('vectors')) {
        db.createObjectStore('vectors', { keyPath: 'noteId' });
      }
      if (oldVersion < 3 && !db.objectStoreNames.contains('model_files')) {
        // Stores downloaded model binaries keyed by manifest id.
        // We use a separate store so cache eviction can wipe vectors
        // without nuking multi-GB model downloads.
        db.createObjectStore('model_files', { keyPath: 'id' });
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

// ─── Downloaded model files ───────────────────────────────────────
//
// Files are written as a single Blob keyed by the manifest id. We keep
// the byte length and sha256 alongside so a future verification pass
// can detect corruption without re-reading the whole blob.

export interface CachedModelFile {
  id: string;
  blob: Blob;
  size_bytes: number;
  sha256?: string;
  cached_at: string;
}

export async function getModelFile(id: string): Promise<CachedModelFile | undefined> {
  const db = await getDb();
  return (await db.get('model_files', id)) as CachedModelFile | undefined;
}

export async function putModelFile(row: CachedModelFile): Promise<void> {
  const db = await getDb();
  await db.put('model_files', row);
}

export async function deleteModelFile(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('model_files', id);
}

export async function listModelFileIds(): Promise<string[]> {
  const db = await getDb();
  return (await db.getAllKeys('model_files')) as string[];
}
