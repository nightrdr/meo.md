// Settings → AI screen. Sections in v1.0:
//   - Local models: list dynamically discovered Ollama models +
//     statically known ones with [install] buttons that call
//     OllamaBackend.pull and surface progress.
//   - Embeddings: show the current embedder + indexed-notes progress,
//     [Force re-index] button.
//   - Cloud models: tier-gated per the canonical pricing table.
//
// ─── Tier gating policy (Agent 7) ──────────────────────────────────
// Free      → cloud LLM section disabled, "Upgrade to enable" pitch.
// Hobbyist+ → BYO API key inputs (OpenAI / Anthropic / Google).
// Business+ → BYO + 200k tokens/month included usage bar (placeholder
//             until Agent 10's billing wiring lands).
// Keys are stored locally only (meta.cloud_keys), never proxied.
// ───────────────────────────────────────────────────────────────────

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ai as A, type Note, type Tier } from '@meo/shared';
import { Icon } from './Icon';
import { peekAIRuntime, getAIRuntime } from './aiStore';
import { Subscription } from './Settings/Subscription';
import { Security } from './Settings/Security';
import type { Session } from './session';
import { getCurrentTier } from './session';
import { getMeta, setMeta } from './storage';

export type SettingsTab = 'ai' | 'subscription' | 'security';

interface PullState {
  modelId: string;
  status: string;
  completed?: number;
  total?: number;
  error?: string;
}

interface Props {
  session: Session;
  notes: Map<string, Note>;
  modelId: string;
  initialTab?: SettingsTab;
  onSelectModel: (id: string) => void;
  onClose: () => void;
}

interface DiscoveredModel {
  id: string;
  name: string;
  size?: string;
  tag: string;
}

export function Settings({ session, notes, modelId, initialTab = 'ai', onSelectModel, onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [ollamaUp, setOllamaUp] = useState<boolean | null>(null);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  const [indexed, setIndexed] = useState<{ done: number; total: number } | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [embedderId, setEmbedderId] = useState<string | null>(null);
  const backendRef = useRef<A.OllamaBackend | null>(null);

  // Discover models + initial probe
  const refreshDiscovered = useCallback(async () => {
    if (!backendRef.current) backendRef.current = new A.OllamaBackend();
    const ok = await backendRef.current.isAvailable();
    setOllamaUp(ok);
    if (!ok) { setDiscovered([]); return; }
    const list = await backendRef.current.listModels();
    setDiscovered(list.map(m => ({ id: m.id, name: m.name, size: m.size, tag: m.tag })));
  }, []);

  useEffect(() => { refreshDiscovered(); }, [refreshDiscovered]);

  // Indexed-notes counter (refreshed every 1s while panel is open)
  useEffect(() => {
    const tick = async () => {
      const rt = peekAIRuntime();
      const total = notes.size;
      if (!rt) { setIndexed({ done: 0, total }); setEmbedderId(null); return; }
      const done = await rt.vectorStore.count();
      setIndexed({ done, total });
      setEmbedderId(rt.embedder.id);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [notes]);

  // ─── Pull a model from Ollama ───
  const pull = useCallback(async (modelId: string) => {
    if (!backendRef.current) backendRef.current = new A.OllamaBackend();
    setPulls(p => ({ ...p, [modelId]: { modelId, status: 'starting' } }));
    try {
      for await (const ev of backendRef.current.pull(ollamaIdFor(modelId))) {
        setPulls(p => ({
          ...p,
          [modelId]: {
            modelId,
            status: ev.status,
            completed: ev.completed,
            total: ev.total,
          },
        }));
      }
      setPulls(p => {
        const next = { ...p };
        delete next[modelId];
        return next;
      });
      await refreshDiscovered();
    } catch (e) {
      setPulls(p => ({ ...p, [modelId]: { modelId, status: 'failed', error: (e as Error).message } }));
    }
  }, [refreshDiscovered]);

  // ─── Force re-index ───
  const forceReindex = useCallback(async () => {
    setReindexing(true);
    try {
      const rt = await getAIRuntime();
      // Drop existing vectors so every note re-embeds from scratch
      await rt.vectorStore.clear();
      await rt.rebuild(notes, (done, total) => setIndexed({ done, total }));
    } catch (e) {
      // surface in-status; the UI will recover on next tick
      // eslint-disable-next-line no-console
      console.error('reindex failed:', e);
    } finally {
      setReindexing(false);
    }
  }, [notes]);

  // ─── Render ───

  // Build the row list: discovered first, then static (filtered to those
  // not already discovered).
  const discoveredIds = new Set(discovered.map(d => normalize(d.id)));
  const staticRows = A.LOCAL_GGUF_CATALOGUE.filter(
    s => !discoveredIds.has(normalize(s.id)),
  );

  const tabLabel = tab === 'subscription' ? 'Subscription' : tab === 'security' ? 'Security' : 'AI';

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div className="settings-card" onMouseDown={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <div className="settings-title-row">
            <Icon.Settings size={16} />
            <h1>Settings &nbsp;<span className="muted">/</span>&nbsp; {tabLabel}</h1>
          </div>
          <button className="btn icon-btn" onClick={onClose} title="Close">
            <Icon.X size={14} />
          </button>
        </header>

        <nav className="settings-tabs">
          <button
            className={`settings-tab ${tab === 'ai' ? 'active' : ''}`}
            onClick={() => setTab('ai')}
            type="button"
          >
            AI
          </button>
          <button
            className={`settings-tab ${tab === 'subscription' ? 'active' : ''}`}
            onClick={() => setTab('subscription')}
            type="button"
          >
            Subscription
          </button>
          <button
            className={`settings-tab ${tab === 'security' ? 'active' : ''}`}
            onClick={() => setTab('security')}
            type="button"
          >
            Security
          </button>
        </nav>

        {tab === 'subscription' && (
          <div className="settings-body">
            <Subscription session={session} />
          </div>
        )}

        {tab === 'security' && (
          <div className="settings-body">
            <Security session={session} />
          </div>
        )}

        {tab === 'ai' && (
        <div className="settings-body">
          {/* ─── Local models ─── */}
          <section className="settings-section">
            <h2>Local models</h2>
            <p className="muted">
              Models run on this device with no internet. We use Ollama as the runtime.
            </p>

            {ollamaUp === false && (
              <div className="settings-callout warn">
                <Icon.Warning size={13} stroke="var(--ai)" />
                <div>
                  <b>Ollama is not running.</b><br />
                  Install from <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a> and start it. Then come back and reload.
                </div>
              </div>
            )}

            <div className="model-list">
              {discovered.map(d => (
                <ModelRow
                  key={d.id}
                  rowId={d.id}
                  name={d.name}
                  meta={[d.size, d.tag].filter(Boolean).join(' · ')}
                  state="installed"
                  selected={d.id === modelId}
                  onSelect={() => onSelectModel(d.id)}
                />
              ))}
              {staticRows.map(s => {
                const pull$ = pulls[s.id];
                const state = pull$ ? 'pulling' : 'available';
                return (
                  <ModelRow
                    key={s.id}
                    rowId={s.id}
                    name={s.name}
                    meta={[s.size, s.tag].filter(Boolean).join(' · ')}
                    state={state}
                    pullState={pull$}
                    onInstall={() => pull(s.id)}
                  />
                );
              })}
            </div>

            <p className="muted small">
              meo.md doesn't bundle Ollama. Models pulled here are stored in <code>~/.ollama/models/</code> and managed by Ollama itself.
            </p>
          </section>

          {/* ─── Embeddings ─── */}
          <section className="settings-section">
            <h2>Embeddings</h2>
            <p className="muted">
              Embeddings power Ask Meo's retrieval. They run locally on this device, never uploaded.
            </p>

            <div className="settings-row">
              <div>
                <div className="settings-row-label">Model</div>
                <div className="settings-row-value">{embedderId ?? <span className="muted">not loaded yet — open Ask Meo to load</span>}</div>
              </div>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row-label">Embeds</div>
                <div className="settings-row-value">title + body + tags + folder</div>
              </div>
            </div>

            <div className="settings-row">
              <div style={{ flex: 1 }}>
                <div className="settings-row-label">Indexed</div>
                <div className="settings-row-value">
                  {indexed
                    ? `${indexed.done} / ${indexed.total} notes`
                    : <span className="muted">not loaded yet</span>}
                </div>
                {indexed && indexed.total > 0 && (
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{ width: `${Math.min(100, (indexed.done / indexed.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
              <button
                className="btn"
                disabled={reindexing}
                onClick={forceReindex}
                title="Drop all embeddings and re-embed every note"
              >
                {reindexing ? 'Re-indexing…' : 'Force re-index'}
              </button>
            </div>
          </section>

          {/* ─── Cloud models (tier-gated) ─── */}
          <CloudModelsSection tier={getCurrentTier(session)} />
        </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───

interface ModelRowProps {
  rowId: string;
  name: string;
  meta: string;
  state: 'installed' | 'available' | 'pulling';
  selected?: boolean;
  pullState?: PullState;
  onSelect?: () => void;
  onInstall?: () => void;
}

function ModelRow({ rowId, name, meta, state, selected, pullState, onSelect, onInstall }: ModelRowProps) {
  return (
    <div className={`settings-model-row ${selected ? 'selected' : ''}`}>
      <span className="model-dot" style={{ background: '#4F6B3A' }} />
      <div className="model-row-body">
        <div className="model-row-name">
          <span>{name}</span>
          {selected && (
            <span className="default-badge" style={{ background: '#E1EBD2', color: '#3F5A2C' }}>Active</span>
          )}
        </div>
        <div className="model-row-meta">{meta}</div>
        {state === 'pulling' && pullState && (
          <div className="pull-progress">
            <div className="pull-status">{pullState.status}</div>
            {pullState.total ? (
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.min(100, ((pullState.completed ?? 0) / pullState.total) * 100)}%` }}
                />
              </div>
            ) : null}
            {pullState.error && <div className="pull-error">{pullState.error}</div>}
          </div>
        )}
      </div>
      <div className="model-row-action">
        {state === 'installed' && !selected && (
          <button className="btn small" onClick={onSelect}>Use</button>
        )}
        {state === 'installed' && selected && (
          <Icon.Check size={14} stroke="#3F5A2C" />
        )}
        {state === 'available' && (
          <button className="btn primary small" onClick={onInstall}>
            <Icon.Plus size={11} /> Install
          </button>
        )}
        {state === 'pulling' && (
          <span className="kbd">pulling</span>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ───

/**
 * Map our static catalogue id (e.g. "qwen2.5-1.5b-q4") to the actual
 * Ollama tag (e.g. "qwen2.5:1.5b"). Q4 is the default quant in Ollama
 * for these tags so we strip the suffix.
 */
function ollamaIdFor(catalogueId: string): string {
  // qwen2.5-1.5b-q4 → qwen2.5:1.5b
  // llama3.1-8b-q4  → llama3.1:8b
  const m = catalogueId.match(/^([a-z0-9.]+)-([\d.]+b)(-q\d)?$/);
  if (m) return `${m[1]}:${m[2]}`;
  // phi3.5-mini-q4 → phi3.5:mini
  const m2 = catalogueId.match(/^([a-z0-9.]+)-([a-z]+)(-q\d)?$/);
  if (m2) return `${m2[1]}:${m2[2]}`;
  return catalogueId;
}

/** Normalize id for matching across our catalogue and Ollama's tags. */
function normalize(id: string): string {
  return id.replace(/[^a-z0-9.]/gi, '').toLowerCase();
}

// ─── Cloud models section (tier-gated) ─────────────────────────────

interface CloudKeys {
  openai?: string;
  anthropic?: string;
  google?: string;
}

function CloudModelsSection({ tier }: { tier: Tier }) {
  const [keys, setKeys] = useState<CloudKeys>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    getMeta().then(m => { if (alive) { setKeys(m.cloud_keys ?? {}); setLoaded(true); } });
    return () => { alive = false; };
  }, []);

  const update = useCallback(async (patch: Partial<CloudKeys>) => {
    const next = { ...keys, ...patch };
    setKeys(next);
    await setMeta({ cloud_keys: next });
  }, [keys]);

  // Free → upgrade pitch only.
  if (tier === 'free') {
    return (
      <section className="settings-section">
        <h2>Cloud models</h2>
        <p className="muted">
          Frontier LLMs (GPT-4o, Claude, Gemini) via your own API keys.
        </p>
        <div className="settings-callout">
          <Icon.Sparkle size={13} stroke="var(--ai)" />
          <div>
            <b>Upgrade to enable frontier LLMs via your own API keys.</b><br />
            <span className="muted small">Available on Hobbyist and above.&nbsp;</span>
            <a href="#plans" onClick={(e) => { e.preventDefault(); /* Agent 10's plans page */ }}>See plans</a>
          </div>
        </div>
        <CloudProviderRow label="OpenAI" disabled />
        <CloudProviderRow label="Anthropic" disabled />
        <CloudProviderRow label="Google" disabled />
      </section>
    );
  }

  // Hobbyist+ → BYOK fields. Business+ also gets the included-tokens bar.
  return (
    <section className="settings-section">
      <h2>Cloud models</h2>
      <p className="muted">
        Bring your own API key. Keys are stored on this device only — never sent to meo.md servers.
      </p>

      {(tier === 'business' || tier === 'enterprise') && (
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div className="settings-row-label">Included this month</div>
            <div className="settings-row-value">
              0 / 200,000 tokens
              <span className="muted small">&nbsp;· resets on subscription anniversary</span>
            </div>
            {/* Placeholder until Agent 10's usage wiring lands. */}
            <div className="progress-bar"><div className="progress-fill" style={{ width: '0%' }} /></div>
          </div>
        </div>
      )}

      {loaded && (
        <>
          <CloudProviderRow
            label="OpenAI"
            placeholder="sk-…"
            value={keys.openai ?? ''}
            onChange={(v) => update({ openai: v })}
          />
          <CloudProviderRow
            label="Anthropic"
            placeholder="sk-ant-…"
            value={keys.anthropic ?? ''}
            onChange={(v) => update({ anthropic: v })}
          />
          <CloudProviderRow
            label="Google"
            placeholder="AI…"
            value={keys.google ?? ''}
            onChange={(v) => update({ google: v })}
          />
        </>
      )}
    </section>
  );
}

interface CloudProviderRowProps {
  label: string;
  placeholder?: string;
  value?: string;
  onChange?: (v: string) => void;
  disabled?: boolean;
}

function CloudProviderRow({ label, placeholder, value, onChange, disabled }: CloudProviderRowProps) {
  return (
    <div className="settings-row">
      <div style={{ flex: 1 }}>
        <div className="settings-row-label">{label} API key</div>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={disabled ? 'Upgrade to enter a key' : (placeholder ?? '')}
          value={value ?? ''}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value)}
          style={{ width: '100%' }}
        />
      </div>
    </div>
  );
}
