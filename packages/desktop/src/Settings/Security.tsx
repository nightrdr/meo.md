// Settings → Security pane (Agent 8).
//
// Hosts the 2FA enrollment surface for Business/Enterprise users. Free and
// Hobbyist see an upgrade pitch instead — the spec restricts 2FA to Business+
// (see mvp-development.md "Pricing tiers").
//
// Layout:
//   - Tier-gated header.
//   - Status row: "Two-factor: ON" / "Two-factor: OFF" + Configure / Disable.
//   - Inline <TFAEnroll> when the user clicks Configure.
//
// The "Disable" button doesn't fully delete the row — it flips `enabled` so
// the cold-start gate stops firing. Re-enabling re-enrolls (new secret), so
// the user is forced to scan a fresh QR code.

import React, { useEffect, useState, useCallback } from 'react';
import { Icon } from '../Icon';
import { TFAEnroll } from '../TFA';
import { SupabaseApiClient, type Tier } from '@meo/shared';
import { type Session, getCurrentTier } from '../session';

interface Props {
  session: Session;
}

export function Security({ session }: Props) {
  const tier = getCurrentTier(session);
  const allowed = tier === 'business' || tier === 'enterprise';
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [showEnroll, setShowEnroll] = useState(false);

  const refresh = useCallback(async () => {
    if (!(session.api instanceof SupabaseApiClient)) { setEnabled(false); return; }
    try {
      const r = await session.api.tfaStatus();
      setEnabled(r);
    } catch {
      setEnabled(false);
    }
  }, [session]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <section className="settings-section">
      <h2>Security</h2>
      <p className="muted">
        Two-factor authentication adds a one-time-code step every time you open meo.
      </p>

      {!allowed && (
        <div className="settings-callout">
          <Icon.Sparkle size={13} stroke="var(--ai)" />
          <div>
            <b>Two-factor authentication is a Business feature.</b><br />
            <span className="muted small">Available on Business and Enterprise.</span>
          </div>
        </div>
      )}

      {allowed && (
        <>
          <div className="settings-row">
            <div style={{ flex: 1 }}>
              <div className="settings-row-label">Two-factor authentication</div>
              <div className="settings-row-value">
                {enabled == null && <span className="muted">checking…</span>}
                {enabled === true && <>ON <span className="muted small">— required at every cold start</span></>}
                {enabled === false && <>OFF</>}
              </div>
            </div>
            {!showEnroll && (
              <button className="btn" onClick={() => setShowEnroll(true)}>
                {enabled ? 'Re-configure' : 'Configure'}
              </button>
            )}
          </div>

          {showEnroll && (
            <TFAEnroll
              session={session}
              onEnrolled={() => { setShowEnroll(false); refresh(); }}
              onCancel={() => setShowEnroll(false)}
            />
          )}
        </>
      )}
    </section>
  );
}

/** Convenience widget for Settings → Subscription to link to the Security tab. */
export function TFAStatusBadge({ tier, enabled }: { tier: Tier; enabled: boolean | null }) {
  if (tier !== 'business' && tier !== 'enterprise') return null;
  return (
    <span className="tfa-badge">
      <Icon.Lock size={11} />
      <span>Two-factor: {enabled ? 'ON' : 'OFF'}</span>
    </span>
  );
}
