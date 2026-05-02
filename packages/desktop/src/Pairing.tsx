// Pairing.tsx - Device A side of the QR-pairing handover (Agent 9).
//
// Opened from File ▸ "New Device…" (Agent 5's `menu://new-device`) on a
// device that's already signed in. Generates an ephemeral X25519 keypair,
// uploads ek_a_pub to a fresh meo.handovers row, and renders the
// handover_id + ek_a_pub as a QR code. Polls the row every 1s for
// Device B's pubkey deposit, then encrypts the session bundle under
// pair_key and uploads it. Device B then polls, decrypts, and is
// signed in without ever touching the passphrase.
//
// Failure modes:
//   - 60s expiry → modal shows "expired", user clicks "regenerate"
//   - any RPC error → "pairing failed; use passphrase instead"
//   - both sides clear the row on success or on close

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  SupabaseApiClient,
  makeHandoverPayload,
  derivePairKey,
  sealBundle,
  encodeQr,
  bytesToB64,
  type SessionBundle,
} from '@meo/shared';
import QRCode from 'qrcode';
import { Icon } from './Icon';
import type { Session } from './session';
import { getMeta } from './storage';

type Phase =
  | 'preparing'      // generating keypair / inserting handover row
  | 'awaiting'       // QR shown, waiting for B to deposit pubkey
  | 'sealing'        // B's pubkey arrived, encrypting bundle
  | 'success'        // payload uploaded, B can fetch any time
  | 'expired'
  | 'error';

interface Props {
  session: Session;
  onClose: () => void;
}

export function Pairing({ session, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('preparing');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrText, setQrText] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(60);
  const [bumper, setBumper] = useState(0);   // forces a re-init via useEffect

  // Hold ephemeral material in refs so closing/cancelling drops it from
  // memory cleanly. Never persisted.
  const ekPrivRef = useRef<Uint8Array | null>(null);
  const handoverIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const ttlTimerRef = useRef<number | null>(null);
  const expiresAtRef = useRef<number>(0);

  const isSupabase = session.api instanceof SupabaseApiClient;

  // ── Cleanup ──
  const cleanup = useCallback(async (clearRow: boolean) => {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    if (ttlTimerRef.current)  { clearInterval(ttlTimerRef.current);  ttlTimerRef.current = null; }
    if (clearRow && handoverIdRef.current && session.api instanceof SupabaseApiClient) {
      try { await session.api.handoverClear(handoverIdRef.current); } catch { /* best-effort */ }
    }
    ekPrivRef.current = null;
  }, [session.api]);

  // ── Initialize handover ──
  useEffect(() => {
    let cancelled = false;
    if (!isSupabase) {
      setErrorMsg('Pairing requires the Supabase backend.');
      setPhase('error');
      return;
    }
    const api = session.api as SupabaseApiClient;

    (async () => {
      try {
        setPhase('preparing');
        setErrorMsg(null);
        setQrDataUrl(null);
        setQrText(null);
        const { payload, ek_priv } = await makeHandoverPayload();
        if (cancelled) return;
        ekPrivRef.current = ek_priv;
        handoverIdRef.current = payload.handover_id;
        expiresAtRef.current = payload.expires_at;

        // Insert the row server-side. The id is the bearer token; ek_a_pub
        // is the public half of our ephemeral X25519 keypair.
        await api.handoverCreate(payload.handover_id, base64ToBytes(payload.ek_a_pub));

        const qrBody = encodeQr(payload);
        const dataUrl = await QRCode.toDataURL(qrBody, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 280,
          color: { dark: '#101010', light: '#ffffff' },
        });
        if (cancelled) return;
        setQrText(qrBody);
        setQrDataUrl(dataUrl);
        setPhase('awaiting');
        startPolling(api);
        startTtl();
      } catch (e) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn('[meo] pairing init failed', e);
        setErrorMsg(humanizePairingError(e));
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      cleanup(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bumper, isSupabase, session.api]);

  // ── Polling for B's pubkey ──
  const startPolling = useCallback((api: SupabaseApiClient) => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = window.setInterval(async () => {
      const id = handoverIdRef.current;
      if (!id || !ekPrivRef.current) return;
      try {
        const row = await api.handoverGet(id);
        if (!row) {
          setPhase('expired');
          if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
          return;
        }
        if (!row.ek_b_pub) return;       // B hasn't deposited yet
        // We have B's pubkey. Stop polling, derive pair_key, seal bundle.
        if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
        setPhase('sealing');
        const pairKey = await derivePairKey(ekPrivRef.current, row.ek_b_pub, id);
        const meta = await getMeta();
        const bundle: SessionBundle = {
          master_key_raw: bytesToB64(session.masterRaw),
          jwt: meta.jwt ?? (session.api as SupabaseApiClient).jwt ?? '',
          user_id: session.user_id,
          email: session.email,
          // Secret Key stays formatted so Device B sees it the same way A did.
          secret_key: meta.account_wrapper ? '' : '',  // we don't store the SK; placeholder
        };
        // The Secret Key isn't stored in IndexedDB by design. Device A
        // delivers everything *except* the Secret Key; Device B never
        // needs it because the master key itself is what unlocks notes.
        // Including the SK would be a nicer UX (so the new device can
        // re-show "Save your Secret Key" later), but it isn't required
        // for unlock. Leave as empty string.
        const { ciphertext, nonce } = await sealBundle(bundle, pairKey);
        await api.handoverPutPayload(id, ciphertext, nonce);
        setPhase('success');
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[meo] pairing poll failed', e);
        setErrorMsg(humanizePairingError(e));
        setPhase('error');
        if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
      }
    }, 1000);
  }, [session.email, session.masterRaw, session.user_id, session.api]);

  // ── Countdown ──
  const startTtl = useCallback(() => {
    if (ttlTimerRef.current) clearInterval(ttlTimerRef.current);
    ttlTimerRef.current = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((expiresAtRef.current - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) {
        if (ttlTimerRef.current) { clearInterval(ttlTimerRef.current); ttlTimerRef.current = null; }
        setPhase(p => (p === 'awaiting' ? 'expired' : p));
      }
    }, 250);
  }, []);

  const handleRegenerate = () => {
    setBumper(x => x + 1);
  };
  const handleClose = async () => {
    await cleanup(true);
    onClose();
  };

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { handleClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={handleClose}>
      <div className="pairing-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pairing-header">
          <Icon.Sparkle size={16} stroke="var(--accent)" />
          <h1>Add a new device</h1>
          <button className="btn icon-btn" onClick={handleClose} title="Close">
            <Icon.X size={14} />
          </button>
        </div>

        {phase === 'preparing' && (
          <div className="pairing-body">
            <p className="muted">Generating a one-time pairing code…</p>
          </div>
        )}

        {phase === 'awaiting' && qrDataUrl && (
          <div className="pairing-body">
            <p className="muted" style={{ marginTop: 0 }}>
              On your new device, open Meo and tap{' '}
              <b>Sign in</b> → <b>Scan QR from existing device</b>. Then point the camera at this code,
              or paste the text below.
            </p>
            <div className="pairing-qr-wrap">
              <img src={qrDataUrl} alt="Pairing QR code" className="pairing-qr" />
              <div className="pairing-ttl">
                <Icon.Lock size={11} /> Expires in {secondsLeft}s
              </div>
            </div>
            <details className="pairing-fallback">
              <summary>Can't scan? Copy this text instead</summary>
              <textarea
                readOnly
                value={qrText ?? ''}
                rows={4}
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              />
              <button
                className="btn small"
                onClick={() => qrText && navigator.clipboard.writeText(qrText)}
              >
                <Icon.Copy size={11} /> Copy
              </button>
            </details>
            <p className="muted small" style={{ marginTop: 12 }}>
              The new device will need your Secret Key the first time you unlock notes there -
              keep it handy.
            </p>
          </div>
        )}

        {phase === 'sealing' && (
          <div className="pairing-body">
            <p className="muted">New device detected. Encrypting session bundle…</p>
          </div>
        )}

        {phase === 'success' && (
          <div className="pairing-body">
            <div className="settings-callout" style={{ background: '#E8F1DC' }}>
              <Icon.Check size={14} stroke="#3F5A2C" />
              <div>
                <b>Paired.</b> Your other device will pick up the session within a second.
              </div>
            </div>
            <div className="actions" style={{ marginTop: 16 }}>
              <button className="btn primary" onClick={handleClose} style={{ flex: 1 }}>
                Done
              </button>
            </div>
          </div>
        )}

        {phase === 'expired' && (
          <div className="pairing-body">
            <div className="settings-callout warn">
              <Icon.Warning size={13} stroke="var(--ai)" />
              <div>This pairing code expired before the new device finished. Try again.</div>
            </div>
            <div className="actions" style={{ marginTop: 16 }}>
              <button className="btn primary" onClick={handleRegenerate} style={{ flex: 1 }}>
                Regenerate
              </button>
              <button className="btn" onClick={handleClose}>Cancel</button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="pairing-body">
            <div className="settings-callout warn">
              <Icon.Warning size={13} stroke="var(--ai)" />
              <div>
                <b>Pairing failed.</b><br />
                {errorMsg ?? 'Something went wrong. Use your passphrase + Secret Key on the new device instead.'}
              </div>
            </div>
            <div className="actions" style={{ marginTop: 16 }}>
              <button className="btn primary" onClick={handleRegenerate} style={{ flex: 1 }}>
                Try again
              </button>
              <button className="btn" onClick={handleClose}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Local helper - pairing.ts encodes the QR payload's ek_a_pub as base64;
// the handover_create RPC wants raw bytes. (handover_create's wire path
// converts to PostgREST's hex bytea.)
function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function humanizePairingError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/expired/i.test(msg)) return 'That pairing code expired. Try again.';
  if (/not found/i.test(msg)) return 'Pairing record vanished - try regenerating the code.';
  return 'Pairing failed; use your passphrase + Secret Key on the new device instead.';
}
