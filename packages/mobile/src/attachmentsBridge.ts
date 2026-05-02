// Bridge between the mobile session and the shared AttachmentsClient.
// Pulls Supabase URL + anon key from app.json's `extra` config, the JWT
// from the active session, and the master key from the session.

import Constants from 'expo-constants';
import { createAttachmentsClient } from './shared/attachments';
import type { UploadInput, UploadResult } from './shared/attachments';
import { getSession } from './store';

function readConfig(): { url: string; anonKey: string } {
  const extra = (Constants.expoConfig?.extra as any) ?? {};
  return {
    url: extra.supabaseUrl ?? 'http://127.0.0.1:54321',
    anonKey: extra.supabaseAnonKey ?? '',
  };
}

/**
 * Build an AttachmentsClient bound to the current session. Returns null
 * when the user is signed out or the data backend isn't Supabase.
 */
export function makeAttachmentsClient() {
  const session = getSession();
  if (!session) return null;
  const { url, anonKey } = readConfig();
  if (!anonKey) return null;
  // session.api may be ApiClient (legacy Hono) or SupabaseApiClient. Only
  // the latter has a JWT we can sign Edge Function calls with — and the
  // attachments path requires Supabase anyway.
  const jwt = (session.api as any).jwt;
  if (!jwt) return null;
  return createAttachmentsClient(url, anonKey, jwt, session.masterRaw);
}

/**
 * Upload an attachment. Throws on failure. Returns { id, encrypted_size }.
 */
export async function uploadAttachment(noteId: string, input: UploadInput): Promise<UploadResult> {
  const client = makeAttachmentsClient();
  if (!client) throw new Error('Sign in to upload attachments');
  return client.upload(noteId, input);
}

export async function downloadAttachment(attachmentId: string) {
  const client = makeAttachmentsClient();
  if (!client) throw new Error('Sign in to download attachments');
  return client.download(attachmentId);
}

export async function listAttachments(noteId: string) {
  const client = makeAttachmentsClient();
  if (!client) return [];
  return client.listForNote(noteId);
}

export async function attachmentsQuota() {
  const client = makeAttachmentsClient();
  if (!client) return { usedBytes: 0, quotaBytes: 10 * 1024 * 1024 * 1024 };
  return client.quota();
}
