// Authentication UI — email-OTP flow.
//
// Modes (linear progression, no back-step needed since each gates the next):
//
//   email   → user types email; we send a 6-digit code via Supabase GoTrue
//   otp     → user enters the code; on success we get a JWT and check
//             has_account; new users go to setup, returning users go to unlock
//   setup   → new user picks an encryption passphrase; we generate the
//             Secret Key on-device, wrap the master key, upload the wrapper
//   showSecret → display the just-generated Secret Key; user copies it
//   unlock  → returning user enters passphrase + Secret Key; we decrypt
//             the master key and hand a Session to the app shell
//
// Crypto note: OTP only authenticates the *account* (yields a JWT for
// the server). The encryption layer is independent — passphrase + Secret
// Key are still required to derive the master key. The server never
// sees either.

import React, { useState, useRef } from 'react';
import {
  setupNewAccount, unlockAccount, formatSecretKey, parseSecretKey,
  humanizeAuthError,
  decodeQr, makeBKeypair, derivePairKey, openBundle,
  SupabaseApiClient, b64ToBytes,
} from '@meo/shared';
import { setMeta } from './storage';
import { makeApiClient, supabaseUrl, type Session } from './session';
import { MeoMark, Icon } from './Icon';

type Mode = 'email' | 'otp' | 'setup' | 'showSecret' | 'unlock' | 'pair';

interface Props {
  onAuthenticated: (s: Session) => void;
}

// Inbucket / Mailpit catches outgoing email when running against a
// local self-hosted Supabase. Show a tip in the OTP screen so devs
// don't have to hunt for it.
const isLocalSupabase =
  /127\.0\.0\.1|localhost/i.test(supabaseUrl);
const localInboxUrl = 'http://127.0.0.1:54324';

export function AuthScreen({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<Mode>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [secretKeyInput, setSecretKeyInput] = useState('');
  const [pendingSecretKey, setPendingSecretKey] = useState<Uint8Array | null>(null);
  const [pendingJwt, setPendingJwt] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Stable api instance across renders — supabase-js holds session state.
  const apiRef = useRef<ReturnType<typeof makeApiClient> | null>(null);
  if (!apiRef.current) apiRef.current = makeApiClient();
  const api = apiRef.current;

  // ── Centralized error handler — turns any thrown API/auth/network
  //    error into the most helpful sentence we can manage. ──
  function handleErr(e: unknown) {
    setError(humanizeAuthError(e));
    setBusy(false);
  }

  // ── Step 1: send the OTP code ──
  async function handleRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setInfo(null); setBusy(true);
    try {
      if (!('requestEmailOtp' in api)) {
        throw new Error('Email-OTP login is not available on this backend.');
      }
      await (api as any).requestEmailOtp(email);
      setMode('otp');
      setInfo(`We sent a 6-digit code to ${email}.`);
      setOtp('');
    } catch (e) { handleErr(e); }
    setBusy(false);
  }

  async function handleResendOtp() {
    setError(null); setInfo(null); setBusy(true);
    try {
      await (api as any).requestEmailOtp(email);
      setInfo(`A new code has been sent to ${email}.`);
    } catch (e) { handleErr(e); }
    setBusy(false);
  }

  // ── Step 2: verify the OTP, then route to setup or unlock ──
  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setInfo(null); setBusy(true);
    try {
      if (!('verifyEmailOtp' in api)) {
        throw new Error('Email-OTP login is not available on this backend.');
      }
      const code = otp.trim().replace(/\s+/g, '');
      const r = await (api as any).verifyEmailOtp(email, code);
      await setMeta({ jwt: r.jwt, user_id: r.user_id, email });
      setPendingJwt(r.jwt);
      setPendingUserId(r.user_id);
      setMode(r.has_account ? 'unlock' : 'setup');
    } catch (e) { handleErr(e); }
    setBusy(false);
  }

  // ── Step 3a (new user): pick a passphrase, generate Secret Key ──
  async function handleSetupEncryption(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      if (!pendingJwt) throw new Error('Session expired. Sign in again.');
      const setup = await setupNewAccount(passphrase);
      setPendingSecretKey(setup.secretKey);
      api.setJwt(pendingJwt);
      await api.putAccount(setup.wrapper);
      const session: Session = {
        api, masterRaw: setup.masterRaw, user_id: pendingUserId!, email,
        notes: new Map(), syncCursor: 0,
        hlc: { ms: Date.now(), counter: 0 },
      };
      setMode('showSecret');
      (window as any).__pendingSession = session;
    } catch (e) { handleErr(e); }
    setBusy(false);
  }

  // ── Step 3b (returning user): unlock with passphrase + Secret Key ──
  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      if (!pendingJwt || !pendingUserId) throw new Error('Session expired. Sign in again.');
      api.setJwt(pendingJwt);
      const wrapper = await api.getAccount();
      const sk = parseSecretKey(secretKeyInput);
      const masterRaw = await unlockAccount(passphrase, sk, wrapper);
      const session: Session = {
        api, masterRaw, user_id: pendingUserId, email,
        notes: new Map(), syncCursor: 0,
        hlc: { ms: Date.now(), counter: 0 },
      };
      onAuthenticated(session);
    } catch {
      handleErr(new Error('Couldn\'t unlock — check your passphrase and Secret Key.'));
    }
    setBusy(false);
  }

  // ── QR pairing (Device B side, Agent 9) ───────────────────────────
  // Camera support is punted for v1 — we accept a paste of the QR
  // payload (the modal on Device A shows a copyable text fallback).
  // Once on Device B the flow is:
  //   1. parse the QR text → ek_a_pub + handover_id
  //   2. generate ek_b_pub locally, deposit it on the handovers row
  //   3. poll the row for payload_for_b (encrypted bundle from A)
  //   4. derive pair_key, decrypt bundle, hand off via onAuthenticated
  // Failure modes: any error short-circuits to "use passphrase instead"
  // so we never silently fall back to a less-secure flow.
  const [pairText, setPairText] = useState('');
  const [pairBusy, setPairBusy] = useState(false);

  async function handlePair(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setInfo(null); setPairBusy(true);
    try {
      const payload = decodeQr(pairText);
      if (!(api instanceof SupabaseApiClient)) {
        throw new Error('QR pairing requires the Supabase backend.');
      }
      const ekA = b64ToBytes(payload.ek_a_pub);
      const { ek_pub: ekBPub, ek_priv: ekBPriv } = await makeBKeypair();

      // Deposit B's pubkey
      await api.handoverPutB(payload.handover_id, ekBPub);

      // Poll for payload (max ~50s before expires_at hits)
      const started = Date.now();
      let row: Awaited<ReturnType<SupabaseApiClient['handoverGet']>> | null = null;
      while (Date.now() - started < 55_000) {
        row = await api.handoverGet(payload.handover_id);
        if (row?.payload_for_b && row.payload_nonce) break;
        if (!row) break;          // expired or cleared
        await sleep(1000);
      }
      if (!row || !row.payload_for_b || !row.payload_nonce) {
        throw new Error('Pairing timed out. Try again from your existing device.');
      }

      // Derive pair_key + decrypt
      const pairKey = await derivePairKey(ekBPriv, ekA, payload.handover_id);
      const bundle = await openBundle(row.payload_for_b, row.payload_nonce, pairKey);

      // Best-effort cleanup; keep going even if this fails.
      try { await api.handoverClear(payload.handover_id); } catch { /* noop */ }

      // Persist + hand off as a Session.
      api.setJwt(bundle.jwt);
      const masterRaw = b64ToBytes(bundle.master_key_raw);
      await setMeta({ jwt: bundle.jwt, user_id: bundle.user_id, email: bundle.email });
      const session: Session = {
        api,
        masterRaw,
        user_id: bundle.user_id,
        email: bundle.email,
        notes: new Map(),
        syncCursor: 0,
        hlc: { ms: Date.now(), counter: 0 },
      };
      onAuthenticated(session);
    } catch (e) {
      setError(humanizePairingError(e));
    }
    setPairBusy(false);
  }

  function continuePastSecret() {
    const session = (window as any).__pendingSession as Session | undefined;
    if (!session) return;
    delete (window as any).__pendingSession;
    onAuthenticated(session);
  }

  // ────────────────────────────────────────────────────────────────────

  const Brand = () => (
    <div className="auth-brand">
      <MeoMark size={28} />
      <span className="name">Meo</span>
    </div>
  );

  const Notices = () => (
    <>
      {info && <div className="info">{info}</div>}
      {error && <div className="error">{error}</div>}
    </>
  );

  if (mode === 'email') {
    return (
      <div className="auth-wrap">
        <div>
          <Brand />
          <div className="auth-card">
            <h1>Sign in</h1>
            <p className="sub">We'll email you a 6-digit code. No password needed.</p>
            <form onSubmit={handleRequestOtp}>
              <label>Email</label>
              <input
                type="email" required value={email}
                onChange={e => setEmail(e.target.value)}
                autoFocus autoComplete="email"
                placeholder="you@example.com"
              />
              <Notices />
              <div className="actions">
                <button className="btn primary" disabled={busy || !email} type="submit" style={{ flex: 1 }}>
                  {busy ? 'Sending…' : 'Send code'}
                </button>
              </div>
            </form>
            <div className="switch" style={{ color: 'var(--ink3)', fontSize: 12 }}>
              First time? The same flow signs you up.
            </div>
            <div className="switch" style={{ marginTop: 12 }}>
              <a
                onClick={() => { setMode('pair'); setError(null); setInfo(null); }}
                style={{ cursor: 'pointer' }}
              >
                Already have Meo on another device? Scan QR from existing device →
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'pair') {
    return (
      <div className="auth-wrap">
        <div>
          <Brand />
          <div className="auth-card">
            <h1>Pair from existing device</h1>
            <p className="sub">
              On your other device, open <b>File ▸ New Device…</b>. It'll show a QR code
              and a copyable text fallback. Paste that text below and we'll do the rest —
              no passphrase needed.
            </p>
            <form onSubmit={handlePair}>
              <label>Pairing code</label>
              <textarea
                rows={5}
                required
                value={pairText}
                onChange={(e) => setPairText(e.target.value)}
                placeholder="Paste the pairing text from your existing device…"
                style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                autoFocus
              />
              <Notices />
              <div className="actions">
                <button
                  className="btn primary"
                  type="submit"
                  disabled={pairBusy || pairText.trim().length < 20}
                  style={{ flex: 1 }}
                >
                  {pairBusy ? 'Pairing…' : 'Pair this device'}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={pairBusy}
                  onClick={() => { setMode('email'); setError(null); setInfo(null); }}
                >
                  Use email instead
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'otp') {
    return (
      <div className="auth-wrap">
        <div>
          <Brand />
          <div className="auth-card">
            <h1>Enter code</h1>
            <p className="sub">
              Sent to <strong>{email}</strong>.{' '}
              <a onClick={() => { setMode('email'); setError(null); setInfo(null); setOtp(''); }}>Wrong email?</a>
            </p>
            <form onSubmit={handleVerifyOtp}>
              <label>6-digit code</label>
              <input
                type="text" inputMode="numeric" pattern="\d*" maxLength={6}
                required value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                autoFocus autoComplete="one-time-code"
                className="otp-input"
                placeholder="000000"
              />
              <Notices />
              {isLocalSupabase && (
                <div className="hint">
                  Dev tip: codes appear in Mailpit at{' '}
                  <a href={localInboxUrl} target="_blank" rel="noreferrer">{localInboxUrl}</a>
                </div>
              )}
              <div className="actions">
                <button className="btn primary" disabled={busy || otp.length < 6} type="submit" style={{ flex: 1 }}>
                  {busy ? 'Verifying…' : 'Verify'}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={handleResendOtp}>
                  Resend
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'setup') {
    return (
      <div className="auth-wrap">
        <div>
          <Brand />
          <div className="auth-card">
            <h1>Encryption passphrase</h1>
            <p className="sub">
              This unlocks your notes locally. <strong>The server never sees it.</strong>{' '}
              If you forget it AND lose your Secret Key, your notes are unrecoverable.
              That is the privacy guarantee.
            </p>
            <form onSubmit={handleSetupEncryption}>
              <label>
                <Icon.Lock size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                Passphrase (min 8 chars)
              </label>
              <input
                type="password" required minLength={8} value={passphrase}
                onChange={e => setPassphrase(e.target.value)}
                autoFocus autoComplete="new-password"
              />
              <Notices />
              <div className="actions">
                <button className="btn primary" disabled={busy || passphrase.length < 8} type="submit" style={{ flex: 1 }}>
                  {busy ? 'Setting up…' : 'Set up encryption'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'showSecret') {
    return (
      <div className="auth-wrap">
        <div>
          <Brand />
          <div className="auth-card">
            <h1>Save your Secret Key</h1>
            <p className="sub">
              You'll need this Secret Key alongside your passphrase to unlock notes on a new device.
              Save it somewhere safe. <strong>We cannot recover it.</strong>
            </p>
            <div className="secret-display">{pendingSecretKey ? formatSecretKey(pendingSecretKey) : ''}</div>
            <button
              className="btn"
              style={{ width: '100%' }}
              onClick={() => navigator.clipboard.writeText(pendingSecretKey ? formatSecretKey(pendingSecretKey) : '')}
            >
              <Icon.Copy size={12} style={{ verticalAlign: -1, marginRight: 6 }} /> Copy to clipboard
            </button>
            <div className="actions" style={{ marginTop: 24 }}>
              <button className="btn primary" onClick={continuePastSecret} style={{ flex: 1 }}>
                I've saved it, continue
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'unlock') {
    return (
      <div className="auth-wrap">
        <div>
          <Brand />
          <div className="auth-card">
            <h1>Unlock</h1>
            <p className="sub">Enter your encryption passphrase and Secret Key to decrypt your notes.</p>
            <form onSubmit={handleUnlock}>
              <label>Passphrase</label>
              <input
                type="password" required value={passphrase}
                onChange={e => setPassphrase(e.target.value)}
                autoFocus autoComplete="current-password"
              />
              <label>Secret Key</label>
              <input
                value={secretKeyInput}
                onChange={e => setSecretKeyInput(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                style={{ fontFamily: 'var(--font-mono)', letterSpacing: 0.4 }}
                autoComplete="off"
              />
              <Notices />
              <div className="actions">
                <button className="btn primary" disabled={busy} type="submit" style={{ flex: 1 }}>
                  {busy ? 'Unlocking…' : 'Unlock'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// ── Pairing helpers (Agent 9) ──

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function humanizePairingError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/expired/i.test(msg)) return 'That pairing code expired — generate a new one on your other device.';
  if (/timed out/i.test(msg)) return 'Pairing timed out. Try again.';
  if (/Invalid QR/i.test(msg) || /Unexpected token/i.test(msg) || /JSON/i.test(msg))
    return 'That pairing code didn\'t parse. Make sure you copied the entire string.';
  if (/Supabase backend/i.test(msg)) return msg;
  return 'Pairing failed. Sign in with email instead.';
}
