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
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; url: string; metadata: AttachmentMetadata }
    | { kind: 'error'; error: string }
  >({ kind: 'loading' });

  // Track the blob URL so we can revoke it on unmount.
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
        const blob = new Blob([bytes], { type: metadata.mime_type });
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

export { ATTACHMENT_URL_PREFIX };
