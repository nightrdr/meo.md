// Email-OTP auth + encryption setup/unlock for the RN shell.
//
// Flow (matches packages/desktop/src/Auth.tsx for pre-biometric path):
//
//   email      → user types their email; we call requestEmailOtp()
//   otp        → user types the 6-digit code; verifyEmailOtp() returns
//                a JWT + has_account flag
//   setup      → new user picks an encryption passphrase; we generate
//                a Secret Key on-device, wrap the master key, upload
//   showSecret → display the just-generated Secret Key once
//   unlock     → returning user enters passphrase + Secret Key; we
//                derive the unlock key locally and decrypt the master
//
// On success we hand a Session to the parent shell. The crypto + API
// helpers all come from @meo/shared (same code the desktop uses).

import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  setupNewAccount,
  unlockAccount,
  formatSecretKey,
  parseSecretKey,
  hlcZero,
} from '@meo/shared';
import {
  loadNotes,
  makeApiClient,
  refreshSubscription,
  setSession,
  type Session,
} from '../lib/session';
import { configureRevenueCat } from '../lib/revenuecat';
import { MEO, FONT_SANS, FONT_SERIF, FONT_MONO } from '../lib/theme';

type Mode = 'email' | 'otp' | 'setup' | 'showSecret' | 'unlock';

interface Props {
  onAuthenticated: (s: Session) => void;
}

export function AuthScreen({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<Mode>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [secretKeyInput, setSecretKeyInput] = useState('');
  const [pendingJwt, setPendingJwt] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [pendingSecret, setPendingSecret] = useState<Uint8Array | null>(null);
  const [pendingMaster, setPendingMaster] = useState<Uint8Array | null>(null);
  const [busy, setBusy] = useState(false);

  // Stable api ref — Supabase keeps session state on the instance,
  // so we want one client across the entire auth flow.
  const apiRef = useRef(makeApiClient());
  const api = apiRef.current;

  function fail(e: unknown) {
    Alert.alert('Error', e instanceof Error ? e.message : String(e));
    setBusy(false);
  }

  async function handleSendOtp() {
    if (!email.trim()) {
      Alert.alert('Email required');
      return;
    }
    setBusy(true);
    try {
      await api.requestEmailOtp(email.trim());
      setMode('otp');
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  }

  async function handleVerifyOtp() {
    setBusy(true);
    try {
      const r = await api.verifyEmailOtp(email.trim(), otp.trim());
      setPendingJwt(r.jwt);
      setPendingUserId(r.user_id);
      setMode(r.has_account ? 'unlock' : 'setup');
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  }

  async function handleSetup() {
    setBusy(true);
    try {
      const setup = await setupNewAccount(passphrase);
      api.setJwt(pendingJwt!);
      await api.putAccount(setup.wrapper);
      setPendingSecret(setup.secretKey);
      setPendingMaster(setup.masterRaw);
      setMode('showSecret');
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  }

  async function finishAuth(masterRaw: Uint8Array) {
    if (!pendingUserId || !pendingJwt) return;
    const session: Session = {
      api,
      masterRaw,
      user_id: pendingUserId,
      email: email.trim(),
      jwt: pendingJwt,
      notes: new Map(),
      syncCursor: 0,
      hlc: hlcZero(),
    };
    setSession(session);
    // Best-effort post-auth wiring — none of these should block the
    // user from getting to the notes list.
    try {
      await loadNotes(session);
    } catch (e) {
      console.warn('initial sync failed', e);
    }
    refreshSubscription(session).catch(() => {});
    configureRevenueCat(pendingUserId).catch(() => {});
    onAuthenticated(session);
  }

  async function handleUnlock() {
    setBusy(true);
    try {
      api.setJwt(pendingJwt!);
      const wrapper = await api.getAccount();
      const sk = parseSecretKey(secretKeyInput);
      const masterRaw = await unlockAccount(passphrase, sk, wrapper);
      await finishAuth(masterRaw);
    } catch (e) {
      fail(new Error('Unlock failed: passphrase or Secret Key wrong'));
    }
    setBusy(false);
  }

  async function continueAfterSecret() {
    if (!pendingMaster) return;
    await finishAuth(pendingMaster);
  }

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Text style={styles.brand}>Meo</Text>
      </View>

      <View style={styles.card}>
        {mode === 'email' && (
          <>
            <Title>Sign in</Title>
            <Sub>
              We'll email you a 6-digit code. New users sign up automatically
              on first verify.
            </Sub>
            <Label>Email</Label>
            <Input
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <Primary onPress={handleSendOtp} busy={busy}>
              Send code
            </Primary>
          </>
        )}

        {mode === 'otp' && (
          <>
            <Title>Enter the code</Title>
            <Sub>Sent to {email}.</Sub>
            <Label>6-digit code</Label>
            <Input
              value={otp}
              onChangeText={setOtp}
              keyboardType="number-pad"
              autoCapitalize="none"
              maxLength={6}
            />
            <Primary onPress={handleVerifyOtp} busy={busy}>
              Verify
            </Primary>
            <SwitchLink onPress={() => setMode('email')}>
              Wrong email? Start over
            </SwitchLink>
          </>
        )}

        {mode === 'setup' && (
          <>
            <Title>Encryption passphrase</Title>
            <Sub>
              This unlocks your notes. The server never sees it. If you forget
              it AND lose your Secret Key, your notes are unrecoverable.
            </Sub>
            <Label>Passphrase</Label>
            <Input
              value={passphrase}
              onChangeText={setPassphrase}
              secureTextEntry
            />
            <Primary onPress={handleSetup} busy={busy}>
              Set up encryption
            </Primary>
          </>
        )}

        {mode === 'showSecret' && pendingSecret && (
          <>
            <Title>Save your Secret Key</Title>
            <Sub>
              You'll need this Secret Key alongside your passphrase to unlock
              notes on a new device. Save it somewhere safe. We cannot recover
              it.
            </Sub>
            <View style={styles.secretBox}>
              <Text style={styles.secretText}>
                {formatSecretKey(pendingSecret)}
              </Text>
            </View>
            <Primary onPress={continueAfterSecret} busy={false}>
              I've saved it, continue
            </Primary>
          </>
        )}

        {mode === 'unlock' && (
          <>
            <Title>Unlock</Title>
            <Sub>
              Enter your passphrase and Secret Key to decrypt your notes.
            </Sub>
            <Label>Passphrase</Label>
            <Input
              value={passphrase}
              onChangeText={setPassphrase}
              secureTextEntry
            />
            <Label>Secret Key</Label>
            <Input
              value={secretKeyInput}
              onChangeText={setSecretKeyInput}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              style={{ fontFamily: FONT_MONO }}
            />
            <Primary onPress={handleUnlock} busy={busy}>
              Unlock
            </Primary>
          </>
        )}
      </View>
    </ScrollView>
  );
}

// ─── Local mini design-system ─────────────────────────────────────

function Title({ children }: { children: any }) {
  return <Text style={styles.title}>{children}</Text>;
}
function Sub({ children }: { children: any }) {
  return <Text style={styles.sub}>{children}</Text>;
}
function Label({ children }: { children: any }) {
  return <Text style={styles.label}>{children}</Text>;
}
function Input({ style, ...p }: any) {
  return <TextInput {...p} style={[styles.input, style]} />;
}
function Primary({ onPress, busy, children }: any) {
  return (
    <Pressable
      style={styles.primary}
      onPress={onPress}
      disabled={busy}
    >
      {busy ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <Text style={styles.primaryText}>{children}</Text>
      )}
    </Pressable>
  );
}
function SwitchLink({ onPress, children }: any) {
  return (
    <Pressable onPress={onPress} style={styles.switch}>
      <Text style={styles.switchText}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: MEO.paper,
  },
  header: {
    alignItems: 'center',
    marginBottom: 28,
    flexDirection: 'row',
    alignSelf: 'center',
    gap: 10,
  },
  brand: {
    fontFamily: FONT_SERIF,
    fontSize: 26,
    fontWeight: '700',
    color: MEO.ink,
    letterSpacing: -0.4,
  },
  card: {
    backgroundColor: MEO.overlay,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: MEO.paperEdge,
    padding: 24,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    fontFamily: FONT_SERIF,
    fontSize: 22,
    fontWeight: '700',
    color: MEO.ink,
    marginBottom: 6,
  },
  sub: {
    color: MEO.ink3,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 16,
    fontFamily: FONT_SANS,
  },
  label: {
    color: MEO.ink3,
    fontSize: 11,
    marginTop: 12,
    marginBottom: 4,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontFamily: FONT_SANS,
  },
  input: {
    borderWidth: 1,
    borderColor: MEO.paperEdge,
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    backgroundColor: MEO.paper,
    color: MEO.ink,
    fontFamily: FONT_SANS,
  },
  primary: {
    backgroundColor: MEO.accent,
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    marginTop: 20,
  },
  primaryText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
    fontFamily: FONT_SANS,
  },
  switch: { marginTop: 16, alignSelf: 'center' },
  switchText: { color: MEO.accent, fontSize: 13, fontFamily: FONT_SANS },
  secretBox: {
    backgroundColor: MEO.aiSoft,
    borderColor: 'rgba(180,99,42,0.3)',
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    marginVertical: 12,
  },
  secretText: {
    fontFamily: FONT_MONO,
    fontSize: 14,
    color: MEO.ink,
    letterSpacing: 0.4,
  },
});
