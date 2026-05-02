// Settings → Devices pane (Agent 9).
//
// Lists meo.devices for the current user, plus a "Sign out" button per
// row that deletes the device record. The current device is marked
// "This device" and cannot be revoked from this UI (use the sidebar's
// sign-out button — that wipes local state in addition to the row).
//
// Free-tier users with > 1 device see a callout explaining the cap.
// Hobbyist with > 3 ditto. Business / Enterprise have no cap.

import React, { useEffect, useState, useCallback } from 'react';
import { Icon } from '../Icon';
import {
  SupabaseApiClient, type DeviceRow, type Tier,
} from '@meo/shared';
import type { Session } from '../session';
import { getCurrentTier } from '../session';
import { getMeta } from '../storage';

interface Props {
  session: Session;
}

const TIER_CAPS: Record<Tier, number> = {
  free: 1,
  hobbyist: 3,
  business: Number.POSITIVE_INFINITY,
  enterprise: Number.POSITIVE_INFINITY,
};

export function Devices({ session }: Props) {
  const [rows, setRows] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    if (!(session.api instanceof SupabaseApiClient)) {
      setError('Devices are only tracked when using the Supabase backend.');
      setRows([]);
      return;
    }
    try {
      const list = await session.api.listDevices();
      setRows(list);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load devices.');
      setRows([]);
    }
  }, [session.api]);

  useEffect(() => {
    let alive = true;
    getMeta().then(m => { if (alive) setThisDeviceId(m.device_id ?? null); });
    reload();
    return () => { alive = false; };
  }, [reload]);

  const tier = getCurrentTier(session);
  const cap = TIER_CAPS[tier];
  const overCap = rows ? rows.length > cap : false;

  const onRevoke = useCallback(async (id: string, label: string) => {
    if (id === thisDeviceId) return;          // safety — UI already disables this
    if (!confirm(`Sign out of "${label}"? It will need to re-pair to access notes again.`)) return;
    if (!(session.api instanceof SupabaseApiClient)) return;
    setBusy(true);
    try {
      await session.api.revokeDevice(id);
      await reload();
    } catch (e) {
      setError((e as Error).message ?? 'Failed to revoke device.');
    } finally {
      setBusy(false);
    }
  }, [session.api, thisDeviceId, reload]);

  return (
    <div>
      <section className="settings-section">
        <h2>Devices</h2>
        <p className="muted">
          Each device that signs into your account shows up here. Sign one out to free up a slot.
        </p>

        {tier === 'free' && (
          <div className="settings-callout">
            <Icon.Lock size={13} stroke="var(--accent)" />
            <div>
              Free tier is limited to <b>1 device</b>. Upgrade to Hobbyist for 3, or Business for unlimited.
            </div>
          </div>
        )}

        {overCap && (
          <div className="settings-callout warn">
            <Icon.Warning size={13} stroke="var(--ai)" />
            <div>
              You've signed in on {rows?.length} devices, more than your tier allows.
              Sign out of one to keep editing notes on this device.
            </div>
          </div>
        )}

        {error && (
          <div className="settings-callout warn">
            <Icon.Warning size={13} stroke="var(--ai)" />
            <div>{error}</div>
          </div>
        )}

        {!rows && <p className="muted">Loading devices…</p>}

        {rows && rows.length === 0 && (
          <p className="muted">No devices yet — your current session will appear here on next sync.</p>
        )}

        {rows && rows.length > 0 && (
          <div className="device-list">
            {rows.map((d) => {
              const isThis = d.device_id === thisDeviceId;
              return (
                <div key={d.device_id} className={`device-row ${isThis ? 'self' : ''}`}>
                  <div className="device-icon">
                    <Icon.Note size={16} />
                  </div>
                  <div className="device-meta">
                    <div className="device-name">
                      {d.name}
                      {isThis && <span className="device-this">This device</span>}
                    </div>
                    <div className="device-sub">
                      {prettyPlatform(d.platform)} · last seen {timeAgo(d.last_seen)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => onRevoke(d.device_id, d.name)}
                    disabled={isThis || busy}
                    title={isThis ? "Use the sidebar's sign-out button to revoke this device" : 'Sign this device out'}
                  >
                    Sign out
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function prettyPlatform(p: string): string {
  switch (p) {
    case 'macos':   return 'macOS';
    case 'windows': return 'Windows';
    case 'linux':   return 'Linux';
    case 'ios':     return 'iOS';
    case 'android': return 'Android';
    case 'web':     return 'Web';
    default:        return p || 'Unknown';
  }
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const ms = Date.now() - t;
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}
