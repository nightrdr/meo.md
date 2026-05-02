// First-run model setup. Shown to a brand-new user the first time
// they finish Auth.tsx (signup OR returning-user unlock on a fresh
// device). Lists the manifest entries marked `default_for: desktop`
// and lets the user kick off downloads with progress, or skip and
// install later from Settings.
//
// We persist `meta.onboarding_done` so this screen never re-appears.
// `meta.installed_models` is a hint of what's already cached on this
// device, so future runs know whether to show the empty-state.

import React, { useEffect, useMemo, useState } from 'react';
import { Icon, MeoMark } from './Icon';
import { setMeta } from './storage';
import { fetchManifest, downloadModel, type ManifestEntry, type DownloadProgress } from './modelDownload';

interface Props {
  onDone: () => void;
}

interface RowState {
  status: 'idle' | 'downloading' | 'installed' | 'error';
  loaded: number;
  total: number | null;
  error?: string;
}

export function Onboarding({ onDone }: Props) {
  const [manifest, setManifest] = useState<ManifestEntry[] | null>(null);
  const [manifestErr, setManifestErr] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  useEffect(() => {
    let alive = true;
    fetchManifest()
      .then(m => { if (alive) setManifest(m); })
      .catch(e => { if (alive) setManifestErr((e as Error).message); });
    return () => { alive = false; };
  }, []);

  const desktopEntries = useMemo(
    () => (manifest ?? []).filter(e => e.default_for.includes('desktop')),
    [manifest],
  );

  const startDownload = async (entry: ManifestEntry) => {
    setRows(r => ({ ...r, [entry.id]: { status: 'downloading', loaded: 0, total: entry.size_bytes } }));
    try {
      await downloadModel(entry, (p: DownloadProgress) => {
        setRows(r => ({
          ...r,
          [entry.id]: { status: 'downloading', loaded: p.loaded, total: p.total ?? entry.size_bytes },
        }));
      });
      setRows(r => ({ ...r, [entry.id]: { status: 'installed', loaded: entry.size_bytes, total: entry.size_bytes } }));
    } catch (e) {
      setRows(r => ({
        ...r,
        [entry.id]: { status: 'error', loaded: 0, total: null, error: (e as Error).message },
      }));
    }
  };

  const finish = async () => {
    const installed = Object.entries(rows)
      .filter(([, s]) => s.status === 'installed')
      .map(([id]) => id);
    await setMeta({ onboarding_done: true, installed_models: installed });
    onDone();
  };

  const skip = async () => {
    await setMeta({ onboarding_done: true });
    onDone();
  };

  const anyDownloading = Object.values(rows).some(s => s.status === 'downloading');

  return (
    <div className="auth-shell" data-testid="onboarding">
      <div className="auth-card">
        <div className="auth-brand">
          <MeoMark size={28} />
          <span className="name">Meo</span>
        </div>
        <h2>Set up AI</h2>
        <p className="muted">
          Meo runs AI features on your device. Download a model now, or skip and grab one later from Settings.
        </p>

        {manifestErr && (
          <div className="settings-callout warn">
            <Icon.Warning size={13} stroke="var(--ai)" />
            <div>
              <b>Couldn't reach the model server.</b><br />
              <span className="muted small">{manifestErr}</span>
            </div>
          </div>
        )}

        {!manifest && !manifestErr && (
          <p className="muted small">Loading available models…</p>
        )}

        {manifest && desktopEntries.length === 0 && (
          <p className="muted small">No models are available right now. You can skip this step.</p>
        )}

        <div className="model-list" style={{ marginTop: 12 }}>
          {desktopEntries.map(e => {
            const row = rows[e.id];
            const sizeGb = (e.size_bytes / 1e9).toFixed(1);
            return (
              <div key={e.id} className="settings-model-row">
                <span className="model-dot" style={{ background: e.family === 'embedder' ? '#8B6F4A' : '#4F6B3A' }} />
                <div className="model-row-body">
                  <div className="model-row-name">
                    <span>{e.name}</span>
                  </div>
                  <div className="model-row-meta">{e.params} · {e.quant} · {sizeGb} GB</div>
                  {row?.status === 'downloading' && (
                    <div className="pull-progress">
                      <div className="pull-status">
                        {formatBytes(row.loaded)}{row.total ? ` / ${formatBytes(row.total)}` : ''}
                      </div>
                      <div className="progress-bar">
                        <div
                          className="progress-fill"
                          style={{
                            width: row.total
                              ? `${Math.min(100, (row.loaded / row.total) * 100)}%`
                              : '15%',
                          }}
                        />
                      </div>
                    </div>
                  )}
                  {row?.status === 'error' && row.error && (
                    <div className="pull-error">{row.error}</div>
                  )}
                </div>
                <div className="model-row-action">
                  {row?.status === 'installed' ? (
                    <Icon.Check size={14} stroke="#3F5A2C" />
                  ) : row?.status === 'downloading' ? (
                    <span className="kbd">downloading</span>
                  ) : (
                    <button className="btn primary small" onClick={() => startDownload(e)}>
                      <Icon.Plus size={11} /> Download
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={skip} disabled={anyDownloading}>Skip for now</button>
          <button className="btn primary" onClick={finish} disabled={anyDownloading}>Done</button>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
