import React, { useState, useRef } from 'react';
import {
  setupNewAccount, unlockAccount, formatSecretKey, parseSecretKey,
} from '@meo/shared';
import { setMeta } from './storage';
import { makeApiClient, type Session } from './session';
import { MeoMark, Icon } from './Icon';

type Mode = 'login' | 'signup' | 'showSecret' | 'unlock';

interface Props {
  onAuthenticated: (s: Session) => void;
}

export function AuthScreen({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [secretKeyInput, setSecretKeyInput] = useState('');
  const [pendingSecretKey, setPendingSecretKey] = useState<Uint8Array | null>(null);
  const [pendingJwt, setPendingJwt] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable api instance across renders (supabase-js holds session state).
  const apiRef = useRef<ReturnType<typeof makeApiClient> | null>(null);
  if (!apiRef.current) apiRef.current = makeApiClient();
  const api = apiRef.current;

  function handleErr(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
    setBusy(false);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const r = await api.login(email, password);
      await setMeta({ jwt: r.jwt, user_id: r.user_id, email });
      setPendingJwt(r.jwt);
      setPendingUserId(r.user_id);
      if (!r.has_account) setMode('signup');
      else setMode('unlock');
    } catch (e) { handleErr(e); }
    setBusy(false);
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await api.signup(email, password);
      const r = await api.login(email, password);
      await setMeta({ jwt: r.jwt, user_id: r.user_id, email });
      setPendingJwt(r.jwt);
      setPendingUserId(r.user_id);
      setMode('signup');
    } catch (e) { handleErr(e); }
    setBusy(false);
  }

  async function handleSetupEncryption(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      if (!pendingJwt) throw new Error('no pending session');
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

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      if (!pendingJwt || !pendingUserId) throw new Error('no jwt');
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
    } catch (e) {
      handleErr(new Error('Unlock failed: passphrase or Secret Key is wrong'));
    }
    setBusy(false);
  }

  function continuePastSecret() {
    const session = (window as any).__pendingSession as Session | undefined;
    if (!session) return;
    delete (window as any).__pendingSession;
    onAuthenticated(session);
  }

  // ---- render ----

  const Brand = () => (
    <div className="auth-brand">
      <MeoMark size={28} />
      <span className="name">Meo</span>
    </div>
  );

  if (mode === 'login') {
    return (
      <div className="auth-wrap">
        <div>
          <Brand />
          <div className="auth-card">
            <h1>Welcome back</h1>
            <p className="sub">Sign in to your end-to-end encrypted notes.</p>
            <form onSubmit={handleLogin}>
              <label>Email</label>
              <input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoFocus autoComplete="email" />
              <label>Account password</label>
              <input type="password" required value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
              {error && <div className="error">{error}</div>}
              <div className="actions">
                <button className="btn primary" disabled={busy} type="submit" style={{ flex: 1 }}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
              </div>
            </form>
            <div className="switch">
              New to Meo? <a onClick={() => { setMode('signup'); setError(null); setPendingJwt(null); }}>Create an account</a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'signup' && !pendingJwt) {
    return (
      <div className="auth-wrap">
        <div>
          <Brand />
          <div className="auth-card">
            <h1>Create your Meo</h1>
            <p className="sub">The account password lets you sign in. Next: an encryption passphrase that <strong>the server never sees</strong>.</p>
            <form onSubmit={handleSignup}>
              <label>Email</label>
              <input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoFocus autoComplete="email" />
              <label>Account password (min 8 chars)</label>
              <input type="password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
              {error && <div className="error">{error}</div>}
              <div className="actions">
                <button className="btn primary" disabled={busy} type="submit" style={{ flex: 1 }}>
                  {busy ? '…' : 'Continue'}
                </button>
              </div>
            </form>
            <div className="switch">
              Already have an account? <a onClick={() => { setMode('login'); setError(null); }}>Sign in</a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'signup' && pendingJwt) {
    return (
      <div className="auth-wrap">
        <div>
          <Brand />
          <div className="auth-card">
            <h1>Encryption passphrase</h1>
            <p className="sub">This unlocks your notes locally. <strong>The server never sees it.</strong> If you forget it AND lose your Secret Key, your notes are unrecoverable. That is the privacy guarantee.</p>
            <form onSubmit={handleSetupEncryption}>
              <label><Icon.Lock size={11} style={{ verticalAlign: -1, marginRight: 4 }} /> Passphrase</label>
              <input type="password" required minLength={8} value={passphrase} onChange={e => setPassphrase(e.target.value)} autoFocus autoComplete="new-password" />
              {error && <div className="error">{error}</div>}
              <div className="actions">
                <button className="btn primary" disabled={busy} type="submit" style={{ flex: 1 }}>
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
            <p className="sub">You'll need this Secret Key alongside your passphrase to unlock notes on a new device. Save it somewhere safe. <strong>We cannot recover it.</strong></p>
            <div className="secret-display">{pendingSecretKey ? formatSecretKey(pendingSecretKey) : ''}</div>
            <button className="btn" style={{ width: '100%' }} onClick={() => navigator.clipboard.writeText(pendingSecretKey ? formatSecretKey(pendingSecretKey) : '')}>
              <Icon.Copy size={12} style={{ verticalAlign: -1, marginRight: 6 }} /> Copy to clipboard
            </button>
            <div className="actions" style={{ marginTop: 24 }}>
              <button className="btn primary" onClick={continuePastSecret} style={{ flex: 1 }}>I've saved it, continue</button>
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
              <input type="password" required value={passphrase} onChange={e => setPassphrase(e.target.value)} autoFocus autoComplete="current-password" />
              <label>Secret Key</label>
              <input
                value={secretKeyInput}
                onChange={e => setSecretKeyInput(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                style={{ fontFamily: 'var(--font-mono)', letterSpacing: 0.4 }}
                autoComplete="off"
              />
              {error && <div className="error">{error}</div>}
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
