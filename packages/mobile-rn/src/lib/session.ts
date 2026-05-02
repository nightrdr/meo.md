// In-memory session for the React Native shell. Held in a single
// shared mutable object so the few screens we ship in v1 (Auth →
// Notes list → Note view → Settings) can all read/write the same
// master key, JWT, and decrypted notes map without prop-drilling.
//
// We deliberately do NOT persist masterRaw to AsyncStorage - even
// react-native-keychain (which uses iOS Keychain / Android Keystore)
// is reserved for the biometric story (Agent 1's mobile follow-up).
// For the MVP scaffold the user re-enters passphrase + Secret Key
// on every cold launch, matching the desktop's pre-Agent-1 behaviour.

import {
  SupabaseApiClient,
  decryptNote,
  base64ToBytes,
  hlcZero,
  type Note,
  type SubscriptionRow,
  type Tier,
} from '@meo/shared';

export interface Session {
  api: SupabaseApiClient;
  masterRaw: Uint8Array;
  user_id: string;
  email: string;
  jwt: string;
  notes: Map<string, Note>;
  syncCursor: number;
  hlc: ReturnType<typeof hlcZero>;
  subscription?: SubscriptionRow | null;
}

let _session: Session | null = null;

export function getSession(): Session | null {
  return _session;
}

export function setSession(s: Session | null): void {
  _session = s;
}

export function getCurrentTier(s: Session | null | undefined): Tier {
  return s?.subscription?.tier ?? 'free';
}

// Supabase URL + anon key - sourced from env at build time. For local
// dev we fall back to the standard Supabase CLI defaults so a fresh
// `npm run macos` pointed at a default dev stack just works.
//
// In production these MUST be replaced with the deployed values via
// react-native-dotenv or `Config.SUPABASE_URL` (react-native-config).
// We deliberately don't pull in another dep for the scaffold - the
// follow-on agent can pick whichever .env strategy fits CI.
declare const process: { env: Record<string, string | undefined> };
export const SUPABASE_URL =
  (typeof process !== 'undefined' ? process.env.SUPABASE_URL : undefined) ??
  'http://127.0.0.1:54321';
export const SUPABASE_ANON_KEY =
  (typeof process !== 'undefined' ? process.env.SUPABASE_ANON_KEY : undefined) ??
  '';

export function makeApiClient(jwt?: string): SupabaseApiClient {
  return new SupabaseApiClient(
    { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY },
    jwt,
  );
}

/**
 * Fetch every undeleted note row, decrypt with the session's master key,
 * and stash in `session.notes`. Read-only - there's no upsert path in
 * v1 of the RN shell. Returns the count loaded.
 */
export async function loadNotes(session: Session): Promise<number> {
  const r = await session.api.syncNotes(0);
  for (const row of r.notes) {
    if (row.deleted_at) continue;
    try {
      const note = await decryptNote(
        base64ToBytes(row.encrypted_content),
        base64ToBytes(row.nonce),
        row.id,
        session.masterRaw,
      );
      session.notes.set(row.id, note);
    } catch (e) {
      // Skip notes we can't decrypt (vault notes need a separate key,
      // wrong-key rows shouldn't crash the list).
      console.warn('decrypt failed', row.id, e);
    }
  }
  session.syncCursor = r.cursor;
  return session.notes.size;
}

export async function refreshSubscription(
  session: Session,
): Promise<SubscriptionRow | null> {
  try {
    const row = await session.api.getSubscription();
    session.subscription = row;
    return row;
  } catch (e) {
    console.warn('subscription refresh failed', e);
    if (session.subscription === undefined) session.subscription = null;
    return session.subscription ?? null;
  }
}
