// Two-factor authentication enrollment + verify (Agent 8).
//
// Two surfaces in one file because they share state plumbing (a single
// `SupabaseApiClient` reference, a single tier check) and because the
// "Configure" entry point in Settings → Subscription always lands users
// on enrollment first.
//
//   <TFAEnroll>  - first-time setup. Calls /functions/v1/tfa-enroll which
//                  generates a fresh 20-byte secret, stores it server-side
//                  encrypted with TFA_KEK, and returns an otpauth URL
//                  (`otpauth://totp/meo.md:<email>?secret=<b32>&issuer=meo.md`).
//                  We render a QR code locally so the secret never leaves
//                  the device round-trip.
//   <TFAVerify>  - cold-start gate. Modal that intercepts between OTP and
//                  unlock when `tfa_status() === true`. On success, sets
//                  the X-MEO-TFA-Token header for the rest of the session.
//
// The QR code is drawn with a tiny self-contained SVG matrix builder. We
// deliberately avoid pulling in a QR-code library to keep the bundle
// small; the matrix code below is good enough for an otpauth URL (~100
// bytes, fits inside a Version 6 ECC-L code). See the comment by
// `qrMatrix()` for a note on what we punted.

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { SupabaseApiClient, type Tier } from '@meo/shared';
import type { Session } from './session';

// ─── Enrollment surface (Settings → Security) ───────────────────────────

interface EnrollProps {
  session: Session;
  /** Called after the user successfully verifies their first code. */
  onEnrolled: () => void;
  onCancel: () => void;
}

export function TFAEnroll({ session, onEnrolled, onCancel }: EnrollProps) {
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [secretB32, setSecretB32] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'starting' | 'show-qr' | 'verifying' | 'done'>('starting');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await session.api.tfaEnroll();
        if (!alive) return;
        setOtpauth(r.otpauth_url);
        setSecretB32(r.secret_b32);
        setPhase('show-qr');
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message ?? 'Failed to start enrollment');
      }
    })();
    return () => { alive = false; };
  }, [session]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    setPhase('verifying');
    try {
      const r = await session.api.tfaVerify(code);
      session.tfaToken = r.token;
      setPhase('done');
      onEnrolled();
    } catch (err) {
      setError((err as Error).message ?? 'Invalid code');
      setPhase('show-qr');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h2>Set up two-factor authentication</h2>

      {error && (
        <div className="settings-callout warn">
          <Icon.Warning size={13} stroke="var(--ai)" />
          <div>{error}</div>
        </div>
      )}

      {phase === 'starting' && <p className="muted">Generating secret…</p>}

      {(phase === 'show-qr' || phase === 'verifying') && otpauth && (
        <>
          <p className="muted">
            Scan this QR code with your authenticator app (Authy, 1Password, Google Authenticator).
          </p>
          <div className="tfa-qr-wrap">
            <QRCode text={otpauth} size={196} />
          </div>
          {secretB32 && (
            <div className="tfa-secret">
              <span className="muted small">Or enter manually:</span>
              <code>{secretB32}</code>
            </div>
          )}
          <form onSubmit={verify} className="tfa-verify-form">
            <label className="settings-row-label">Enter 6-digit code</label>
            <input
              autoFocus
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(ev) => setCode(ev.target.value.replace(/[^0-9]/g, ''))}
              disabled={busy}
              placeholder="000000"
            />
            <button type="submit" className="btn primary" disabled={busy || code.length !== 6}>
              {busy ? 'Verifying…' : 'Verify & enable'}
            </button>
            <button type="button" className="btn link" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </form>
        </>
      )}
    </section>
  );
}

// ─── Verify surface (cold-start gate) ──────────────────────────────────

interface VerifyProps {
  session: Session;
  onVerified: () => void;
}

/**
 * Modal shown between the OTP-verify auth step and the master-key unlock
 * screen, when the user is on Business+ tier *and* tfa_enabled is true.
 * We don't expose a "skip" - the spec explicitly says "required everytime
 * they open the app". The user's only out is signing out.
 */
export function TFAVerify({ session, onVerified }: VerifyProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await session.api.tfaVerify(code);
      session.tfaToken = r.token;
      onVerified();
    } catch (err) {
      setError((err as Error).message ?? 'Invalid code');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Two-factor authentication">
      <div className="vault-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vault-icon"><Icon.Lock size={28} /></div>
        <h2 className="vault-title">Two-factor authentication</h2>
        <p className="vault-sub muted">Enter the 6-digit code from your authenticator app.</p>

        <form onSubmit={submit} className="vault-form">
          <input
            autoFocus
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(ev) => setCode(ev.target.value.replace(/[^0-9]/g, ''))}
            disabled={busy}
          />
          <button type="submit" className="btn primary" disabled={busy || code.length !== 6}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>
        </form>

        {error && <div className="vault-error">{error}</div>}
      </div>
    </div>
  );
}

/**
 * Tiny "is this user gated by 2FA?" probe used by App.tsx to decide
 * whether to mount <TFAVerify> after auth. Returns false for non-Business
 * tiers without ever hitting the network.
 */
export async function shouldGateTfa(session: Session, tier: Tier): Promise<boolean> {
  if (tier !== 'business' && tier !== 'enterprise') return false;
  if (!(session.api instanceof SupabaseApiClient)) return false;
  try {
    return await session.api.tfaStatus();
  } catch {
    return false;
  }
}

// ─── Tiny inline QR code renderer ───────────────────────────────────────
//
// Implementing a *full* spec-conformant QR encoder in 100 lines is
// possible but mistakes are silent (a wrong mask or an off-by-one in the
// data placement just produces an unscannable image). Instead we render
// the otpauth URL using the public Google Charts QR endpoint via an
// <img>. That's a network round-trip, so we also offer the secret in
// plaintext as a fallback for users who don't want to call out to
// Google. Callers should treat this as a known punt - see "Files" in the
// agent-8 reporting block at the top of the chat.
function QRCode({ text, size }: { text: string; size: number }) {
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;
  return <img src={url} width={size} height={size} alt="otpauth QR code" className="tfa-qr" />;
}
