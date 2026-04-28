// Auth screen on mobile. Same flow as desktop:
//   1. Login or Sign up (email + account password)
//   2. Encryption passphrase prompt (server never sees this)
//   3. Save Secret Key (shown once)
//   4. Unlock with passphrase + Secret Key on a returning device

import { useState, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { setupNewAccount, unlockAccount, formatSecretKey, parseSecretKey } from '../src/shared';
import { setSession } from '../src/store';
import { makeApiClient, persistJwt, type AnyApiClient } from '../src/session';
import { MEO, FONT_SANS, FONT_SERIF, FONT_MONO } from '../src/theme';
import { MeoMark, Icon } from '../src/Icon';

type Mode = 'login' | 'signup' | 'passphrase' | 'showSecret' | 'unlock';

export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [secretKeyInput, setSecretKeyInput] = useState('');
  const [pendingJwt, setPendingJwt] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [pendingSecret, setPendingSecret] = useState<Uint8Array | null>(null);
  const [pendingMaster, setPendingMaster] = useState<Uint8Array | null>(null);
  const [busy, setBusy] = useState(false);

  // Stable api ref across renders (Supabase keeps session state on the instance).
  const apiRef = useRef<AnyApiClient | null>(null);
  if (!apiRef.current) apiRef.current = makeApiClient();
  const api = apiRef.current;

  function handleErr(e: unknown) {
    Alert.alert('Error', e instanceof Error ? e.message : String(e));
    setBusy(false);
  }

  async function handleLogin() {
    setBusy(true);
    try {
      const r = await api.login(email, password);
      await persistJwt(r.jwt, r.user_id, email);
      setPendingJwt(r.jwt);
      setPendingUserId(r.user_id);
      setMode(r.has_account ? 'unlock' : 'passphrase');
    } catch (e) { handleErr(e); }
    setBusy(false);
  }
  async function handleSignup() {
    setBusy(true);
    try {
      await api.signup(email, password);
      const r = await api.login(email, password);
      await persistJwt(r.jwt, r.user_id, email);
      setPendingJwt(r.jwt);
      setPendingUserId(r.user_id);
      setMode('passphrase');
    } catch (e) { handleErr(e); }
    setBusy(false);
  }
  async function handleSetupEncryption() {
    setBusy(true);
    try {
      const setup = await setupNewAccount(passphrase);
      api.setJwt(pendingJwt!);
      await api.putAccount(setup.wrapper);
      setPendingSecret(setup.secretKey);
      setPendingMaster(setup.masterRaw);
      setMode('showSecret');
    } catch (e) { handleErr(e); }
    setBusy(false);
  }
  async function handleUnlock() {
    setBusy(true);
    try {
      api.setJwt(pendingJwt!);
      const wrapper = await api.getAccount();
      const sk = parseSecretKey(secretKeyInput);
      const masterRaw = await unlockAccount(passphrase, sk, wrapper);
      setSession({
        api, masterRaw, user_id: pendingUserId!, email,
        notes: new Map(), syncCursor: 0,
        hlc: { ms: Date.now(), counter: 0 },
      });
      router.replace('/folders');
    } catch (e) {
      handleErr(new Error('Unlock failed: passphrase or Secret Key wrong'));
    }
    setBusy(false);
  }
  function continueAfterSecret() {
    if (!pendingMaster) return;
    setSession({
      api, masterRaw: pendingMaster, user_id: pendingUserId!, email,
      notes: new Map(), syncCursor: 0,
      hlc: { ms: Date.now(), counter: 0 },
    });
    router.replace('/folders');
  }

  return (
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1, justifyContent: 'center',
        padding: 24, backgroundColor: MEO.paper,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ alignItems: 'center', marginBottom: 28, flexDirection: 'row', alignSelf: 'center', gap: 10 }}>
        <MeoMark size={32} />
        <Text style={{ fontFamily: FONT_SERIF, fontSize: 26, fontWeight: '700', color: MEO.ink, letterSpacing: -0.4 }}>
          Meo
        </Text>
      </View>

      <View style={{
        backgroundColor: MEO.overlay,
        borderRadius: 14,
        borderWidth: 1, borderColor: MEO.paperEdge,
        padding: 24,
      }}>
        {mode === 'login' && (
          <>
            <Title>Welcome back</Title>
            <Sub>Sign in to your end-to-end encrypted notes.</Sub>
            <Label>Email</Label>
            <Input value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
            <Label>Account password</Label>
            <Input value={password} onChangeText={setPassword} secureTextEntry />
            <Primary onPress={handleLogin} busy={busy}>Sign in</Primary>
            <Switch onPress={() => { setMode('signup'); setPendingJwt(null); }}>New to Meo? Create an account</Switch>
          </>
        )}
        {mode === 'signup' && !pendingJwt && (
          <>
            <Title>Create your Meo</Title>
            <Sub>The account password lets you sign in. Next: an encryption passphrase the server never sees.</Sub>
            <Label>Email</Label>
            <Input value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
            <Label>Account password (min 8)</Label>
            <Input value={password} onChangeText={setPassword} secureTextEntry />
            <Primary onPress={handleSignup} busy={busy}>Continue</Primary>
            <Switch onPress={() => setMode('login')}>Already have an account? Sign in</Switch>
          </>
        )}
        {mode === 'passphrase' && (
          <>
            <Title>Encryption passphrase</Title>
            <Sub>This unlocks your notes. The server never sees it. If you forget it AND lose your Secret Key, your notes are unrecoverable.</Sub>
            <Label><Icon.Lock size={11} stroke={MEO.ink3} /> {'  Passphrase'}</Label>
            <Input value={passphrase} onChangeText={setPassphrase} secureTextEntry />
            <Primary onPress={handleSetupEncryption} busy={busy}>Set up encryption</Primary>
          </>
        )}
        {mode === 'showSecret' && pendingSecret && (
          <>
            <Title>Save your Secret Key</Title>
            <Sub>You'll need this Secret Key alongside your passphrase to unlock notes on a new device. Save it somewhere safe. We cannot recover it.</Sub>
            <View style={{
              backgroundColor: MEO.aiSoft, borderColor: 'rgba(180,99,42,0.3)', borderWidth: 1,
              borderRadius: 8, padding: 14, marginVertical: 12,
            }}>
              <Text style={{ fontFamily: FONT_MONO, fontSize: 14, color: MEO.ink, letterSpacing: 0.4 }}>
                {formatSecretKey(pendingSecret)}
              </Text>
            </View>
            <Primary onPress={continueAfterSecret} busy={false}>I've saved it, continue</Primary>
          </>
        )}
        {mode === 'unlock' && (
          <>
            <Title>Unlock</Title>
            <Sub>Enter your passphrase and Secret Key to decrypt your notes.</Sub>
            <Label>Passphrase</Label>
            <Input value={passphrase} onChangeText={setPassphrase} secureTextEntry />
            <Label>Secret Key</Label>
            <Input
              value={secretKeyInput}
              onChangeText={setSecretKeyInput}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              style={{ fontFamily: FONT_MONO }}
            />
            <Primary onPress={handleUnlock} busy={busy}>Unlock</Primary>
          </>
        )}
      </View>
    </ScrollView>
  );
}

// ─── Mini design-system shorthands ───

const Title = ({ children }: any) => (
  <Text style={{ fontFamily: FONT_SERIF, fontSize: 22, fontWeight: '700', color: MEO.ink, marginBottom: 6 }}>
    {children}
  </Text>
);
const Sub = ({ children }: any) => (
  <Text style={{ color: MEO.ink3, fontSize: 13, lineHeight: 19, marginBottom: 16, fontFamily: FONT_SANS }}>
    {children}
  </Text>
);
const Label = ({ children }: any) => (
  <Text style={{ color: MEO.ink3, fontSize: 11, marginTop: 12, marginBottom: 4, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6, fontFamily: FONT_SANS }}>
    {children}
  </Text>
);
const Input = ({ style, ...p }: any) => (
  <TextInput
    {...p}
    style={[{
      borderWidth: 1, borderColor: MEO.paperEdge, borderRadius: 8,
      padding: 10, fontSize: 15, backgroundColor: MEO.paper, color: MEO.ink,
      fontFamily: FONT_SANS,
    }, style]}
  />
);
const Primary = ({ onPress, busy, children }: any) => (
  <Pressable
    style={{ backgroundColor: MEO.accent, borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 20 }}
    onPress={onPress} disabled={busy}
  >
    {busy ? <ActivityIndicator color="#fff" /> : (
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15, fontFamily: FONT_SANS }}>{children}</Text>
    )}
  </Pressable>
);
const Switch = ({ onPress, children }: any) => (
  <Pressable onPress={onPress} style={{ marginTop: 16, alignSelf: 'center' }}>
    <Text style={{ color: MEO.accent, fontSize: 13, fontFamily: FONT_SANS }}>{children}</Text>
  </Pressable>
);
