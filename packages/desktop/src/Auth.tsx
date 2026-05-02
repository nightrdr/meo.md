// Authentication UI — email-OTP flow.
//
// Modes (linear progression, no back-step needed since each gates the next):
//
//   email     → user types email; we send a 6-digit code via Supabase GoTrue
//   otp       → user enters the code; on success we get a JWT and check
//               has_account; new users go to setup, returning users go to unlock
//   setup     → new user picks an encryption passphrase; we generate the
//               Secret Key on-device, wrap the master key, upload the wrapper
//   showSecret → display the just-generated Secret Key; user copies it
//   unlock    → returning user enters passphrase + Secret Key; we decrypt
//               the master key and hand a Session to the app shell
//   biometric → returning user with a still-valid JWT + a wrap_blob in
//               IndexedDB unlocks via Touch ID / Windows Hello / OS keychain
//               (Agent 1). Falls back to `unlock` if cancelled or if the
//               keychain entry was removed (e.g. wiped by macOS after
//               biometric re-enrollment).
//
// Crypto note: OTP only authenticates the *account* (yields a JWT for
// the server). The encryption layer is independent — passphrase + Secret
// Key are still required to derive the master key. The server never
// sees either.

import React, { useState, useRef, useEffect } from 'react';
import {
  setupNewAccount, unlockAccount, formatSecretKey, parseSecretKey,
  humanizeAuthError,
} from '@meo/shared';
import { setMeta, getMeta } from './storage';
import { makeApiClient, supabaseUrl, type Session } from './session';
import { MeoMark, Icon } from './Icon';
import {
  biometricAvailable, loadWrapKey, unwrapMasterRaw, clearWrapKey,
  wrapMasterRaw, saveWrapKey,
} from './biometric';
import { isMac, isWindows } from './platform';

type Mode = 'email' | 'otp' | 'setup' | 'showSecret' | 'unlock' | 'biometric';

interface Props {
  onAuthenticated: (s: Session) => void;
  // Boot routing: App.tsx sets this to 'biometric' when there's a
  // valid JWT + wrap blob already in IndexedDB. Otherwise we fall
  // through to the email-OTP flow as before.
  startMode?: Mode;
  // Pre-populated email shown on the biometric/unlock screens. Kept
  // separate from the form's editable `email` state so cancelling
  // biometric doesn't lose context for "Welcome back, X".
  initialEmail?: string;
}

// Per-platform display copy for the biometric primary button.
function biometricButtonLabel(): string {
  if (isMac) return 'Unlock with Touch ID';
  if (isWindows) return 'Unlock with Windows Hello';
  return 'Unlock with OS keychain';
}

// Inbucket / Mailpit catches outgoing email when running against a
// local self-hosted Supabase. Show a tip in the OTP screen so devs
// don't have to hunt for it.
const isLocalSupabase =
  /127\.0\.0\.1|localhost/i.test(supabaseUrl);
const localInboxUrl = 'http://127.0.0.1:54324';

export function AuthScreen({ onAuthenticated, startMode, initialEmail }: Props) {
  const [mode, setMode] = useState<Mode>(startMode ?? 'email');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [otp, setOtp] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [secretKeyInput, setSecretKeyInput] = useState('');
  const [pendingSecretKey, setPendingSecretKey] = useState<Uint8Array | null>(null);
  const [pendingJwt, setPendingJwt] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Toggle controlling whether the FIRST passphrase unlock also stashes
  // a wrap_key in the OS keychain. Default ON because the brief asks for
  // it; the user can flip it off if they want to keep typing the Secret
  // Key on every session (e.g. shared workstation).
  const [biometricOptIn, setBiometricOptIn] = useState(true);
  // Pre-flight: hide the biometric checkbox entirely on platforms that
  // don't have it (Linux desktop without libsecret-biometric, plain
  // browser tabs running `npm run dev`).
  const [biometricShown, setBiometricShown] = useState(false);
  useEffect(() => {
    biometricAvailable().then(setBiometricShown).catch(() => setBiometricShown(false));
  }, []);

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
  //
  // After a successful unlock, if the user opted into biometric AND
  // we're running on a platform that supports it, we wrap masterRaw
  // with a fresh per-device wrap_key, persist the ciphertext blob in
  // IndexedDB, and stash the wrap_key in the OS keychain behind the
  // userPresence ACL. Failures here are non-fatal — the user has a
  // valid session, biometric is just convenience.
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
      // Best-effort biometric setup. Two opt-out cases:
      //   1) the user unchecked the toggle on this screen
      //   2) the platform doesn't support biometric (Linux / browser)
      if (biometricOptIn && biometricShown) {
        try {
          const { keyB64, blob, nonce } = await wrapMasterRaw(masterRaw);
          await setMeta({
            master_wrap_blob: blob,
            master_wrap_nonce: nonce,
            biometric_enabled: true,
          });
          // saveWrapKey triggers the OS biometric-setup prompt on
          // macOS ("Allow Meo to use Touch ID"). Failures here mean
          // the user denied permission — flip the flag back off so
          // the next cold start doesn't show the biometric screen.
          await saveWrapKey(keyB64);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('biometric setup failed (continuing without):', e);
          await setMeta({
            master_wrap_blob: undefined,
            master_wrap_nonce: undefined,
            biometric_enabled: false,
          });
        }
      } else {
        // User explicitly opted out — make sure no stale blob remains
        // from a previous session.
        await setMeta({
          master_wrap_blob: undefined,
          master_wrap_nonce: undefined,
          biometric_enabled: false,
        });
        await clearWrapKey();
      }
      onAuthenticated(session);
    } catch {
      handleErr(new Error('Couldn\'t unlock — check your passphrase and Secret Key.'));
    }
    setBusy(false);
  }

  // ── Cold-start biometric unlock ──
  // Runs when App.tsx routes us into 'biometric' mode (valid JWT +
  // wrap_blob present in IndexedDB). The OS prompts for Touch ID /
  // Hello inside loadWrapKey(); we then decrypt the blob to rebuild
  // masterRaw and rebuild the in-memory Session.
  async function handleBiometricUnlock() {
    setError(null); setBusy(true);
    try {
      const meta = await getMeta();
      if (!meta.jwt || !meta.user_id || !meta.master_wrap_blob || !meta.master_wrap_nonce) {
        throw new Error('Quick-unlock data missing — please use your passphrase.');
      }
      const keyB64 = await loadWrapKey();
      const masterRaw = await unwrapMasterRaw(keyB64, meta.master_wrap_blob, meta.master_wrap_nonce);
      api.setJwt(meta.jwt);
      const session: Session = {
        api,
        masterRaw,
        user_id: meta.user_id,
        email: meta.email ?? '',
        notes: new Map(),
        syncCursor: meta.sync_cursor ?? 0,
        hlc: { ms: Date.now(), counter: 0 },
      };
      onAuthenticated(session);
    } catch (e) {
      // The most common failures here are user cancellation (which
      // should silently route to passphrase) and stale keychain
      // entries (e.g. user wiped the keychain or re-enrolled Touch
      // ID). We surface a short message and let them retry or fall
      // back. We don't auto-route because cancellation should NOT
      // force a passphrase entry — the user might just have hit Esc
      // by accident.
      const msg = (e as Error).message ?? '';
      if (/cancel|denied/i.test(msg)) {
        setError('Authentication cancelled.');
      } else {
        setError('Touch ID unlock failed. Use your passphrase to continue.');
      }
    }
    setBusy(false);
  }

  // Auto-trigger the OS prompt the moment we land on the biometric
  // screen. The user shouldn't have to click a button to "request the
  // prompt that asks them to authenticate" — that's a redundant step.
  // If they Esc / cancel, the button is still there for retry.
  //
  // Also: prime `pendingJwt` / `pendingUserId` from the persisted meta
  // so that "Use passphrase instead" (which routes to mode='unlock')
  // can complete handleUnlock without going back through OTP.
  useEffect(() => {
    if (mode === 'biometric') {
      let cancelled = false;
      (async () => {
        const meta = await getMeta();
        if (cancelled) return;
        if (meta.jwt) setPendingJwt(meta.jwt);
        if (meta.user_id) setPendingUserId(meta.user_id);
        // Defer one tick so the screen renders before the OS modal —
        // otherwise the JS event loop blocks long enough that the
        // biometric sheet appears on top of a blank window.
        window.setTimeout(() => {
          if (!cancelled) void handleBiometricUnlock();
        }, 50);
      })();
      return () => { cancelled = true; };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function handleBiometricSignOut() {
    if (!confirm('Sign out and clear local cache on this device?')) return;
    setBusy(true);
    try {
      await clearWrapKey();
      await setMeta({
        jwt: undefined,
        master_wrap_blob: undefined,
        master_wrap_nonce: undefined,
        biometric_enabled: false,
      });
      // Drop back to the email screen rather than reloading the page.
      setMode('email');
      setEmail('');
      setError(null);
    } finally {
      setBusy(false);
    }
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
              {biometricShown && (
                <label
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontWeight: 'normal', marginTop: 8, color: 'var(--ink2)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={biometricOptIn}
                    onChange={(e) => setBiometricOptIn(e.target.checked)}
                  />
                  <span>Enable {biometricButtonLabel().replace(/^Unlock with /, '')} for next time</span>
                </label>
              )}
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

  if (mode === 'biometric') {
    return (
      <div className="auth-wrap">
        <div>
          <Brand />
          <div className="auth-card">
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <Icon.Lock size={48} stroke="var(--accent)" />
            </div>
            <h1 style={{ textAlign: 'center' }}>
              Welcome back{email ? `, ${email}` : ''}
            </h1>
            <p className="sub" style={{ textAlign: 'center' }}>
              Authenticate to unlock your notes.
            </p>
            <Notices />
            <div className="actions" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => { void handleBiometricUnlock(); }}
                style={{ flex: 1 }}
              >
                {busy ? 'Waiting…' : biometricButtonLabel()}
              </button>
            </div>
            <div className="switch" style={{ marginTop: 16, textAlign: 'center' }}>
              <a
                onClick={() => {
                  setError(null);
                  setMode('unlock');
                }}
              >Use passphrase instead</a>
            </div>
            <div
              className="switch"
              style={{ marginTop: 8, textAlign: 'center', fontSize: 12, color: 'var(--ink3)' }}
            >
              <a onClick={handleBiometricSignOut}>Sign out</a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
