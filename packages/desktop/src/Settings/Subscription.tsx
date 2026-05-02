// Settings → Subscription pane (Agent 10).
//
// Shows the current tier, billing source, period end, and a "Manage" button
// that opens whichever portal owns the subscription:
//   - Paddle:     external Paddle customer portal in a new tab.
//   - RevenueCat: tells the user to use the App Store / Play Store on their
//                 phone — neither store offers a usable web management UI for
//                 third-party apps. We don't try to deep-link.
//   - Manual / no source: show the upgrade options inline.
//
// The data source is meo.subscriptions via SupabaseApiClient.getSubscription().
// We refresh on mount so the user never sees a stale cached row after a
// successful upgrade.

import React, { useEffect, useState, useCallback } from 'react';
import { SupabaseApiClient, type SubscriptionRow, type Tier } from '@meo/shared';
import { Icon } from '../Icon';
import { type Session, refreshSubscription, getCurrentTier } from '../session';

interface Props {
  session: Session;
}

const PADDLE_PORTAL_URL = 'https://meo.md/account/billing';
const TIER_LABELS: Record<Tier, string> = {
  free:       'Free',
  hobbyist:   'Hobbyist',
  business:   'Business',
  enterprise: 'Enterprise',
};
const TIER_BLURBS: Record<Tier, string> = {
  free:       '1 device · 1 GB storage · 10 MB attachments · no LLM.',
  hobbyist:   '3 devices · 10 GB storage · 1 GB attachments · bring-your-own-key LLMs.',
  business:   'Unlimited devices · 1 TB storage · 200k LLM tokens / month · 2FA.',
  enterprise: 'Custom limits, dedicated support, plugins.',
};

export function Subscription({ session }: Props) {
  const [row, setRow] = useState<SubscriptionRow | null | undefined>(session.subscription);
  const [loading, setLoading] = useState<boolean>(row === undefined);
  const [error, setError] = useState<string | null>(null);
  const [tfaEnabled, setTfaEnabled] = useState<boolean | null>(null);

  // Probe 2FA status (Agent 8) for the side-badge on Business/Enterprise.
  useEffect(() => {
    let alive = true;
    const tier = getCurrentTier(session);
    if ((tier === 'business' || tier === 'enterprise')
        && session.api instanceof SupabaseApiClient) {
      session.api.tfaStatus()
        .then(v => { if (alive) setTfaEnabled(v); })
        .catch(() => { if (alive) setTfaEnabled(false); });
    } else {
      setTfaEnabled(null);
    }
    return () => { alive = false; };
  }, [session]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await refreshSubscription(session);
      setRow(r);
    } catch (e) {
      setError((e as Error).message ?? 'failed to load subscription');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { reload(); }, [reload]);

  const tier = getCurrentTier(session);
  const source = row?.source ?? null;
  const periodEnd = row?.current_period_end
    ? new Date(row.current_period_end).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      })
    : null;

  const onManagePaddle = () => {
    window.open(PADDLE_PORTAL_URL, '_blank', 'noopener,noreferrer');
  };

  // Cross-store conflict guard (Agent 10 deliverable §5). On the desktop
  // build, the only purchase rail is Paddle; if the server says the user is
  // already subscribed via RevenueCat (an active App Store / Play Store sub),
  // we refuse to launch checkout and explain how to manage it instead.
  // The webhooks return 409 for the same case server-side; this is the
  // client-side mirror so users never reach a confusing checkout error.
  const [conflict, setConflict] = useState<null | 'rc-on-paddle'>(null);
  const onUpgrade = () => {
    if (source === 'revenuecat' && tier !== 'free') {
      setConflict('rc-on-paddle');
      return;
    }
    onManagePaddle();
  };

  return (
    <div>
      <section className="settings-section">
        <h2>Plan</h2>

        {loading && (
          <p className="muted">Loading your subscription…</p>
        )}
        {error && (
          <div className="settings-callout warn">
            <Icon.Warning size={13} stroke="var(--ai)" />
            <div>Couldn't load subscription: {error}</div>
          </div>
        )}

        {!loading && (
          <>
            <div className="settings-row">
              <div style={{ flex: 1 }}>
                <div className="settings-row-label">Tier</div>
                <div className="settings-row-value">
                  {TIER_LABELS[tier]}
                  {row?.cancel_at_period_end && (
                    <span className="muted"> · cancels at period end</span>
                  )}
                  {tfaEnabled != null && (
                    <span className="tfa-badge" style={{ marginLeft: 8 }}>
                      <Icon.Lock size={11} />
                      <span>Two-factor: {tfaEnabled ? 'ON' : 'OFF'}</span>
                    </span>
                  )}
                </div>
                <div className="muted small" style={{ marginTop: 6 }}>
                  {TIER_BLURBS[tier]}
                </div>
              </div>
            </div>

            {periodEnd && (
              <div className="settings-row">
                <div>
                  <div className="settings-row-label">
                    {row?.cancel_at_period_end ? 'Access until' : 'Renews on'}
                  </div>
                  <div className="settings-row-value">{periodEnd}</div>
                </div>
              </div>
            )}

            {source && (
              <div className="settings-row">
                <div>
                  <div className="settings-row-label">Billed via</div>
                  <div className="settings-row-value">
                    {source === 'paddle' && 'Paddle (web)'}
                    {source === 'revenuecat' && 'App Store / Play Store'}
                    {source === 'manual' && 'manual'}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Manage / upgrade controls — branch on source. */}
      <section className="settings-section">
        <h2>Manage</h2>

        {source === 'paddle' && (
          <>
            <p className="muted">
              Update your card, switch plan, or cancel anytime.
            </p>
            <button className="btn primary" onClick={onManagePaddle}>
              Open billing portal
            </button>
          </>
        )}

        {source === 'revenuecat' && (
          <div className="settings-callout warn" style={{ background: 'var(--paper-deep)', color: 'var(--ink2)', border: '1px solid var(--paper-edge)' }}>
            <Icon.Sparkle size={13} />
            <div>
              Your subscription is managed through the <b>App Store / Play Store</b>.
              Open the meo mobile app and tap Settings → Subscription to make changes.
            </div>
          </div>
        )}

        {!source && tier === 'free' && (
          <>
            <p className="muted">
              Upgrade to unlock more storage, larger attachments, multiple devices,
              and frontier LLMs.
            </p>
            <div className="upgrade-tiers">
              <UpgradeTierCard
                name="Hobbyist"
                price="$5/mo"
                blurb={TIER_BLURBS.hobbyist}
                onClick={onUpgrade}
                cta="Upgrade"
              />
              <UpgradeTierCard
                name="Business"
                price="$25/mo"
                blurb={TIER_BLURBS.business}
                onClick={onUpgrade}
                cta="Upgrade"
                highlight
              />
            </div>
            <p className="muted small">
              Mobile users: open the meo iOS or Android app to subscribe through your store.
            </p>
          </>
        )}

        {!source && tier !== 'free' && (
          <p className="muted">
            Your plan is active. Contact <a href="mailto:hello@meo.md">hello@meo.md</a> to make changes.
          </p>
        )}
      </section>

      {conflict === 'rc-on-paddle' && (
        <CrossStoreConflictModal
          message="Your plan is already active via the App Store. Open the iOS / Android app to manage it."
          onClose={() => setConflict(null)}
        />
      )}
    </div>
  );
}

interface CrossStoreConflictModalProps {
  message: string;
  onClose: () => void;
}

/**
 * Cross-store conflict explainer (Agent 10 §5). Used both inline (when the
 * user clicks Upgrade on the wrong store) and as a reusable surface for the
 * mobile app's mirror flow.
 */
export function CrossStoreConflictModal({ message, onClose }: CrossStoreConflictModalProps) {
  return (
    <div className="cross-store-overlay" onMouseDown={onClose} role="dialog" aria-modal>
      <div className="cross-store-card" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Already subscribed</h3>
        <p>{message}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}

interface UpgradeTierCardProps {
  name: string;
  price: string;
  blurb: string;
  cta: string;
  highlight?: boolean;
  onClick: () => void;
}

function UpgradeTierCard({ name, price, blurb, cta, highlight, onClick }: UpgradeTierCardProps) {
  return (
    <div className={`upgrade-tier ${highlight ? 'highlight' : ''}`}>
      <div className="upgrade-tier-name">{name}</div>
      <div className="upgrade-tier-price">{price}</div>
      <div className="upgrade-tier-blurb">{blurb}</div>
      <button className={`btn ${highlight ? 'primary' : ''}`} onClick={onClick}>
        {cta}
      </button>
    </div>
  );
}
