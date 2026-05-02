// Settings stub.
//
// What ships in v1:
//   - Current tier label + blurb (sourced from the cached subscription row)
//   - "Manage subscription" button:
//       Paddle:     opens the customer portal (web)
//       RevenueCat: shows the App Store / Play Store callout
//                   (Agent 10's cross-store conflict UX)
//       no source / unknown: links to the marketing site
//   - "Open AI" button - currently shows the mobile-only model alert
//     and the "AI is available on desktop only" placeholder. The full
//     panel is deferred to Phase 2.
//
// Deferred (see README): all of Settings → Devices, Security, 2FA, vault,
// model downloads, etc. The desktop ships these; we'll port them when
// the RN shell catches up.

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { type Tier } from '@meo/shared';
import {
  getCurrentTier,
  refreshSubscription,
  type Session,
} from '../lib/session';
import { MEO, FONT_SANS, FONT_SERIF } from '../lib/theme';

interface Props {
  session: Session;
  onBack: () => void;
  onSignOut: () => void;
}

const TIER_LABELS: Record<Tier, string> = {
  free: 'Free',
  hobbyist: 'Hobbyist',
  business: 'Business',
  enterprise: 'Enterprise',
};
const TIER_BLURBS: Record<Tier, string> = {
  free: '1 device · 1 GB storage · 10 MB attachments · no LLM.',
  hobbyist:
    '3 devices · 10 GB storage · 1 GB attachments · bring-your-own-key LLMs.',
  business:
    'Unlimited devices · 1 TB storage · 200k LLM tokens / month · 2FA.',
  enterprise: 'Custom limits, dedicated support, plugins.',
};
const PADDLE_PORTAL_URL = 'https://meo.md/account/billing';

export function SettingsScreen({ session, onBack, onSignOut }: Props) {
  const [tier, setTier] = useState<Tier>(getCurrentTier(session));
  const [source, setSource] = useState<string | null>(
    session.subscription?.source ?? null,
  );

  useEffect(() => {
    let alive = true;
    refreshSubscription(session)
      .then((row) => {
        if (!alive) return;
        setTier(row?.tier ?? 'free');
        setSource(row?.source ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session]);

  function handleManage() {
    if (source === 'paddle') {
      Linking.openURL(PADDLE_PORTAL_URL).catch(() =>
        Alert.alert('Could not open billing portal'),
      );
    } else if (source === 'apple' || source === 'google') {
      // Agent 10's cross-store conflict UX - App / Play stores don't
      // give us a usable web URL for third-party subs, so we tell
      // the user where to look on their phone.
      const store =
        source === 'apple' ? 'App Store → Subscriptions' : 'Google Play → Subscriptions';
      Alert.alert(
        'Manage on device',
        `Your subscription is billed by ${source === 'apple' ? 'Apple' : 'Google'}. ` +
          `Open ${store} to change tier or cancel.`,
      );
    } else {
      Linking.openURL('https://meo.md/upgrade').catch(() =>
        Alert.alert('Could not open upgrade page'),
      );
    }
  }

  function handleAi() {
    // Mobile-only model gating per Agent 7's manifest. The actual
    // "default_for: ['mobile']" filter happens server-side in the
    // model manifest endpoint - here we just warn the user that
    // mobile is curated.
    Alert.alert(
      'Mobile AI is curated',
      'Mobile Meo runs only models we curate for mobile to keep your battery happy. The full AI panel is desktop-only in v1.',
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>{'← Notes'}</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Section label="Account">
          <Row k="Email" v={session.email} />
          <Row k="User ID" v={session.user_id.slice(0, 8) + '…'} />
        </Section>

        <Section label="Subscription">
          <Row k="Tier" v={TIER_LABELS[tier]} />
          <Text style={styles.blurb}>{TIER_BLURBS[tier]}</Text>
          <Pressable style={styles.btn} onPress={handleManage}>
            <Text style={styles.btnText}>Manage subscription</Text>
          </Pressable>
        </Section>

        <Section label="AI">
          <Text style={styles.blurb}>
            AI is available on desktop only in v1.
          </Text>
          <Pressable style={styles.btnSecondary} onPress={handleAi}>
            <Text style={styles.btnSecondaryText}>Open AI panel</Text>
          </Pressable>
        </Section>

        <Section label="Build">
          <Row k="Platform" v={Platform.OS} />
          <Row k="Version" v={String(Platform.Version)} />
        </Section>

        <Pressable style={styles.signOut} onPress={onSignOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Section({ label, children }: { label: string; children: any }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowKey}>{k}</Text>
      <Text style={styles.rowVal}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: MEO.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: MEO.paperEdge,
    gap: 12,
  },
  backBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  backText: { color: MEO.accent, fontFamily: FONT_SANS, fontSize: 14 },
  title: {
    fontFamily: FONT_SERIF,
    fontSize: 18,
    fontWeight: '600',
    color: MEO.ink,
  },
  scroll: { padding: 16 },
  section: {
    backgroundColor: MEO.overlay,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: MEO.paperEdge,
    padding: 16,
    marginBottom: 16,
  },
  sectionLabel: {
    fontFamily: FONT_SANS,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: MEO.ink3,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  rowKey: { fontFamily: FONT_SANS, fontSize: 13, color: MEO.ink2 },
  rowVal: { fontFamily: FONT_SANS, fontSize: 13, color: MEO.ink },
  blurb: {
    fontFamily: FONT_SANS,
    fontSize: 13,
    color: MEO.ink3,
    lineHeight: 18,
    marginVertical: 8,
  },
  btn: {
    backgroundColor: MEO.accent,
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  btnText: {
    color: '#fff',
    fontFamily: FONT_SANS,
    fontWeight: '600',
    fontSize: 14,
  },
  btnSecondary: {
    backgroundColor: MEO.paper,
    borderWidth: 1,
    borderColor: MEO.paperEdge,
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  btnSecondaryText: {
    color: MEO.ink2,
    fontFamily: FONT_SANS,
    fontWeight: '600',
    fontSize: 14,
  },
  signOut: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  signOutText: {
    color: MEO.accent,
    fontFamily: FONT_SANS,
    fontSize: 13,
    fontWeight: '600',
  },
});
