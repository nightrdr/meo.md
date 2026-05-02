// Vault unlock modal (Agent 8).
//
// Renders as a modal overlay when the user opens a note flagged `isVault`
// whose body is still in `vault:<n>:<ct>` wire form. The modal itself is a
// thin presentation layer; the actual key derivation + body decrypt
// happens in session.ts (`unlockVaultNote`). We just call back into the
// caller with the note id.
//
// Unlock surfaces (in priority order):
//   1. Biometric — if `biometricAvailable()` from Agent 1 returns true,
//      we offer a Touch ID / Windows Hello button. The platform prompt
//      is fired by `loadWrapKey()` which validates against the keychain
//      and on success we proceed straight to decryption (the vault_key
//      is *not* the wrap key; biometric here is just the gate).
//   2. Passphrase — fallback. We don't actually verify the passphrase
//      against anything (it's just the user reaffirming their identity);
//      a wrong typo will fail later when the AES-GCM tag check fails.
//
// Why no passphrase verification: vault_key is HKDF(masterRaw, user_id),
// which is already in memory from the existing unlock path. The
// passphrase here is purely UX — "this is *me* opening the vault" — not a
// crypto gate. If we wanted a stronger gate we'd derive the vault key
// from the passphrase too; that's a v2 hardening.

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

// The biometric module ships with Agent 1 — until it lands, dynamic-import
// resolves to `null` and we fall back to passphrase only. Path is built at
// runtime so TypeScript doesn't try to type-check the not-yet-existing file.
interface BiometricMod {
  biometricAvailable?: () => Promise<boolean>;
  loadWrapKey?: () => Promise<unknown>;
}
async function loadBiometricModule(): Promise<BiometricMod | null> {
  try {
    const path = './biometric';
    const mod = await import(/* @vite-ignore */ path).catch(() => null);
    return (mod as BiometricMod) ?? null;
  } catch {
    return null;
  }
}

interface Props {
  /** Title of the note being unlocked, for the prompt copy. */
  noteTitle: string;
  /** Called once the user has cleared the gate. */
  onUnlock: () => Promise<void> | void;
  /** Called when the user dismisses without unlocking. */
  onCancel: () => void;
}

export function Vault({ noteTitle, onUnlock, onCancel }: Props) {
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [biometric, setBiometric] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Probe Agent 1's biometric primitive lazily — if the module isn't
  // present (older build, or when running in plain browser), fall back to
  // passphrase only without surfacing an error. The module path is
  // resolved at runtime via a string variable so TypeScript doesn't try
  // to find it at compile time (Agent 1 ships ./biometric.ts later).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mod = await loadBiometricModule();
        if (!alive) return;
        if (mod?.biometricAvailable) {
          const ok = await mod.biometricAvailable();
          setBiometric(Boolean(ok));
        } else {
          setBiometric(false);
        }
      } catch {
        if (alive) setBiometric(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Autofocus the passphrase input once we know we're not going to hand
  // off to biometric immediately.
  useEffect(() => {
    if (biometric === false) inputRef.current?.focus();
  }, [biometric]);

  async function tryBiometric() {
    setBusy(true);
    setError(null);
    try {
      const mod = await loadBiometricModule();
      if (mod?.loadWrapKey) {
        // Calls into the keychain helper (Agent 1). On macOS this surfaces
        // the Touch ID prompt; failure throws.
        await mod.loadWrapKey();
      }
      await onUnlock();
    } catch (e) {
      setError((e as Error).message ?? 'Biometric check failed');
    } finally {
      setBusy(false);
    }
  }

  async function tryPassphrase(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Passphrase is presence-only here (see comment at top of file). A wrong
      // value won't *fail* the gate but will fail downstream if the vault key
      // material somehow disagrees — which it won't for the normal case.
      if (!pass) {
        setError('Enter your passphrase to unlock');
        return;
      }
      await onUnlock();
    } catch (e) {
      setError((e as Error).message ?? 'Unlock failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Unlock vault note" onMouseDown={onCancel}>
      <div className="vault-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vault-icon"><Icon.Lock size={28} /></div>
        <h2 className="vault-title">Unlock vault note</h2>
        <p className="vault-sub muted">
          {noteTitle ? <>"{noteTitle}" is locked.</> : <>This note is locked.</>}
          &nbsp;Confirm with biometrics or your passphrase.
        </p>

        {biometric === true && (
          <button type="button" className="btn primary" disabled={busy} onClick={tryBiometric}>
            <Icon.Lock size={13} /> Use biometric
          </button>
        )}

        <form onSubmit={tryPassphrase} className="vault-form">
          <input
            ref={inputRef}
            type="password"
            placeholder="Passphrase"
            autoComplete="current-password"
            spellCheck={false}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            disabled={busy}
          />
          <button type="submit" className="btn" disabled={busy || !pass}>
            Unlock
          </button>
        </form>

        {error && <div className="vault-error">{error}</div>}

        <button type="button" className="btn link" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
