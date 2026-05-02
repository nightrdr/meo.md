// AttachmentRenderer
// ----------------------------------------------------------------------------
// Custom TipTap image extension that recognizes `attachment:<uuid>` URLs and
// renders them by fetching + decrypting the bytes via the AttachmentsClient.
//
// Usage from Editor.tsx:
//   import { AttachmentImageExtension, AttachmentRendererContext } from './AttachmentRenderer';
//   ...
//   useEditor({ extensions: [..., AttachmentImageExtension] });
//
// The renderer reads the active session from a window-level context (see
// `getAttachmentsContext` below) — App.tsx is expected to populate
// `(window as any).__meoAttachmentsContext = { masterRaw, jwt, supabaseUrl, supabaseAnonKey }`
// once the user has unlocked.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import {
  AttachmentsClient, parseAttachmentUrl, ATTACHMENT_URL_PREFIX,
  type AttachmentMetadata,
} from '@meo/shared';
import { createClient } from '@supabase/supabase-js';

// Heuristic mime sniff used by the URL-paste insert path. We trust the file
// extension (no network probe), since the value is purely cosmetic — the
// browser will pick the actual codec when it loads the URL.
function mimeFromExt(url: string, fallback: string): string {
  const m = url.toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/);
  const ext = m?.[1];
  if (!ext) return fallback;
  const map: Record<string, string> = {
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  };
  return map[ext] ?? fallback;
}

// ----------------------------------------------------------------------------
// Session bridge.
// App.tsx populates `(window as any).__meoAttachmentsContext` once the user
// has unlocked. This indirection lets the Editor + AttachmentRenderer access
// the master key without taking it as a prop on every render.
// ----------------------------------------------------------------------------

export interface AttachmentsContext {
  masterRaw: Uint8Array;
  jwt: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __meoAttachmentsContext: AttachmentsContext | undefined;
}

export function getAttachmentsContext(): AttachmentsContext | null {
  if (typeof globalThis === 'undefined') return null;
  const ctx = (globalThis as any).__meoAttachmentsContext as AttachmentsContext | undefined;
  return ctx ?? null;
}

export function setAttachmentsContext(ctx: AttachmentsContext | null): void {
  if (typeof globalThis === 'undefined') return;
  if (ctx) (globalThis as any).__meoAttachmentsContext = ctx;
  else delete (globalThis as any).__meoAttachmentsContext;
}

// Build a freshly authed AttachmentsClient. Returns null if no session yet.
export function makeAttachmentsClient(): AttachmentsClient | null {
  const ctx = getAttachmentsContext();
  if (!ctx) return null;
  const sb = createClient(ctx.supabaseUrl, ctx.supabaseAnonKey, {
    global: { headers: { authorization: `Bearer ${ctx.jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'meo' as any },
  });
  (sb as any).rest.headers['authorization'] = `Bearer ${ctx.jwt}`;
  (sb as any).functions.setAuth?.(ctx.jwt);
  return new AttachmentsClient({ supabase: sb, masterRaw: ctx.masterRaw });
}

// ----------------------------------------------------------------------------
// TipTap node — replaces the StarterKit's image (StarterKit doesn't include
// images by default in our config; we add this one explicitly).
// ----------------------------------------------------------------------------

export const AttachmentImageExtension = Node.create({
  name: 'image',
  group: 'inline',
  inline: true,
  draggable: true,
  atom: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      // For uploaded attachments we store the id on a data attribute so the
      // markdown round-trips even if `src` is rewritten to a blob URL.
      'data-attachment-id': { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'img[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentNodeView);
  },
});

// ----------------------------------------------------------------------------
// React node view — handles plain image URLs (just renders <img>) AND the
// custom `attachment:<id>` URLs (decrypts then renders).
// ----------------------------------------------------------------------------

function AttachmentNodeView({ node }: NodeViewProps) {
  const src: string = node.attrs.src ?? '';
  const alt: string = node.attrs.alt ?? '';
  const dataId: string | null = node.attrs['data-attachment-id'] ?? null;

  const attachmentId = useMemo(() => {
    if (dataId) return dataId;
    return parseAttachmentUrl(src);
  }, [src, dataId]);

  if (!attachmentId) {
    // Regular external image
    return (
      <NodeViewWrapper as="span" className="att-image-wrap">
        <img src={src} alt={alt} />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" className="att-image-wrap">
      <DecryptedImage attachmentId={attachmentId} alt={alt} />
    </NodeViewWrapper>
  );
}

function DecryptedImage({ attachmentId, alt }: { attachmentId: string; alt: string }) {
  const state = useDecryptedAttachment(attachmentId);
  if (state.kind === 'loading') {
    return (
      <span className="att-image att-loading">
        <span className="att-spinner" /> Decrypting…
      </span>
    );
  }
  if (state.kind === 'error') {
    return (
      <span className="att-image att-error" title={state.error}>
        Failed to decrypt attachment
      </span>
    );
  }
  return (
    <img
      className="att-image"
      src={state.url}
      alt={alt || state.metadata.filename}
      title={state.metadata.filename}
    />
  );
}

// Shared decrypt-to-blob-URL hook — used by image, video, and audio node views.
function useDecryptedAttachment(attachmentId: string):
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; metadata: AttachmentMetadata }
  | { kind: 'error'; error: string }
{
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; url: string; metadata: AttachmentMetadata }
    | { kind: 'error'; error: string }
  >({ kind: 'loading' });

  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      const client = makeAttachmentsClient();
      if (!client) {
        if (!cancelled) setState({ kind: 'error', error: 'session not available' });
        return;
      }
      try {
        const { bytes, metadata } = await client.download(attachmentId);
        if (cancelled) return;
        // Use the metadata-recorded mime so the browser picks the right
        // codec (mp4 vs webm, mp3 vs wav, etc.). Fall back to
        // application/octet-stream if missing — the <video>/<audio>
        // tag will then refuse to play, which is the correct signal.
        const blob = new Blob([bytes as BlobPart], { type: metadata.mime_type || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setState({ kind: 'ready', url, metadata });
      } catch (e: any) {
        if (cancelled) return;
        setState({ kind: 'error', error: String(e?.message ?? e) });
      }
    })();
    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [attachmentId]);

  return state;
}

// ────────────────────────────────────────────────────────────────────
// Video — TipTap node for `<video src controls></video>`. Roundtrips
// through markdown as raw HTML (CommonMark allows inline HTML), which
// preserves both URL-pasted videos and `attachment:<id>` videos
// without a custom syntax.
// ────────────────────────────────────────────────────────────────────

export const AttachmentVideoExtension = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      controls: { default: true },
      'data-attachment-id': { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'video[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes, { controls: 'true' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(VideoNodeView);
  },
});

function VideoNodeView({ node }: NodeViewProps) {
  const src: string = node.attrs.src ?? '';
  const dataId: string | null = node.attrs['data-attachment-id'] ?? null;
  const attachmentId = useMemo(() => dataId ?? parseAttachmentUrl(src), [src, dataId]);

  if (!attachmentId) {
    return (
      <NodeViewWrapper as="div" className="att-media-wrap">
        <video src={src} controls preload="metadata" />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="div" className="att-media-wrap">
      <DecryptedMedia attachmentId={attachmentId} kind="video" />
    </NodeViewWrapper>
  );
}

// ────────────────────────────────────────────────────────────────────
// Audio — same pattern as Video, just an <audio> element.
// ────────────────────────────────────────────────────────────────────

export const AttachmentAudioExtension = Node.create({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      controls: { default: true },
      'data-attachment-id': { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'audio[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['audio', mergeAttributes(HTMLAttributes, { controls: 'true' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AudioNodeView);
  },
});

function AudioNodeView({ node }: NodeViewProps) {
  const src: string = node.attrs.src ?? '';
  const dataId: string | null = node.attrs['data-attachment-id'] ?? null;
  const attachmentId = useMemo(() => dataId ?? parseAttachmentUrl(src), [src, dataId]);

  if (!attachmentId) {
    return (
      <NodeViewWrapper as="div" className="att-media-wrap">
        <audio src={src} controls preload="metadata" />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="div" className="att-media-wrap">
      <DecryptedMedia attachmentId={attachmentId} kind="audio" />
    </NodeViewWrapper>
  );
}

function DecryptedMedia({ attachmentId, kind }: { attachmentId: string; kind: 'video' | 'audio' }) {
  const state = useDecryptedAttachment(attachmentId);
  if (state.kind === 'loading') {
    return <span className="att-image att-loading"><span className="att-spinner" /> Decrypting…</span>;
  }
  if (state.kind === 'error') {
    return <span className="att-image att-error" title={state.error}>Failed to decrypt {kind}</span>;
  }
  if (kind === 'video') {
    return <video className="att-media" src={state.url} controls preload="metadata" title={state.metadata.filename} />;
  }
  return <audio className="att-media" src={state.url} controls preload="metadata" title={state.metadata.filename} />;
}

export { ATTACHMENT_URL_PREFIX, mimeFromExt };
