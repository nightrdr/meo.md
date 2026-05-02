// RevenueCat scaffold (Agent 10 cross-store guard, Agent 12 wiring).
//
// We DO NOT have a real RevenueCat API key for the MVP. The wiring
// here is what a follow-on agent needs once the iOS / Android app
// is registered in the RevenueCat dashboard:
//
//   1. Set REVENUECAT_IOS_KEY / REVENUECAT_ANDROID_KEY via your
//      .env strategy of choice (react-native-config, dotenv, etc.).
//   2. Call configureRevenueCat(userId) right after a successful
//      unlockAccount() / setupNewAccount() in the auth screen.
//
// Until then the function is a no-op stub - Purchases.configure with
// a placeholder key would throw at runtime, so we guard on the
// presence of an actual key. See the README's "Phase 2" section.

import { Platform } from 'react-native';

declare const process: { env: Record<string, string | undefined> };
const IOS_KEY =
  (typeof process !== 'undefined' ? process.env.REVENUECAT_IOS_KEY : undefined) ?? '';
const ANDROID_KEY =
  (typeof process !== 'undefined' ? process.env.REVENUECAT_ANDROID_KEY : undefined) ?? '';

export async function configureRevenueCat(userId: string): Promise<void> {
  const key = Platform.OS === 'ios' ? IOS_KEY : ANDROID_KEY;
  if (!key) {
    // Scaffold mode - log and return. Don't crash.
    console.log('[RevenueCat] skipped: no API key configured (scaffold)');
    return;
  }
  try {
    // Lazy require so the macOS bundle (which has no RevenueCat
    // native module) doesn't fail to load.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Purchases = require('react-native-purchases').default;
    await Purchases.configure({ apiKey: key, appUserID: userId });
    console.log('[RevenueCat] configured for', userId);
  } catch (e) {
    console.warn('[RevenueCat] configure failed', e);
  }
}
