// Single in-memory store for the active session, since Expo Router
// re-renders screens and we don't want to re-derive the master key.
import type { MobileSession } from './session';

let session: MobileSession | null = null;

export function setSession(s: MobileSession | null) { session = s; }
export function getSession(): MobileSession | null { return session; }
