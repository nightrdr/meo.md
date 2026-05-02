// AI controls in the sidebar: on/off switch + model picker dropdown.
//
// The picker is driven entirely by the model service manifest
// (GET /models/manifest from the Go backend) — no hardcoded list.
// The manifest returns three kinds of entries:
//
//   - local-llm  → green dot, runs on-device via Ollama / llama.cpp
//   - cloud-llm  → red dot, frontier vendor APIs (OpenAI / Anthropic /
//                  Google / xAI). Uses BYO API keys per the tier policy.
//   - embedder   → not shown in the picker (the embedder is configured
//                  in Settings → AI → Embeddings, not chosen per query).
//
// We also merge in *runtime-discovered* models from Ollama's /api/tags
// (passed in as `dynamicModels`) so locally-pulled models that aren't
// in the manifest still show up. Manifest entry beats dynamic on id
// collision because the manifest's display name + tag are nicer.

import React, { useState, useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { fetchManifest, type ManifestEntry } from './modelDownload';

// UI-side narrowed enum. The manifest uses `local-llm | cloud-llm |
// embedder`; the picker only ever shows the first two, mapped to:
type UIKind = 'local' | 'commercial';

export interface Model {
  id: string;
  name: string;
  size?: string;
  vendor?: string;
  kind: UIKind;
  tag: string;
  installed?: boolean;
  default?: boolean;
}

/**
 * The picker's first-paint default while the manifest is fetching.
 * Empty list means "show a small loading state in the dropdown."
 * Once the manifest resolves we replace this entirely.
 */
export const FALLBACK_DEFAULT_MODEL_ID = 'qwen2.5-1.5b-q4';

// Re-exported so App.tsx can use it as the initial value for `modelId`
// state without crashing on first render. Replaced by manifest-driven
// data once `useManifestModels` returns.
export const MODELS: readonly Model[] = [];

export const KIND_C = {
  local:      { fg: '#3F5A2C', bg: '#E1EBD2', dot: '#4F6B3A', label: 'Local' },
  commercial: { fg: '#923524', bg: '#F4D7CF', dot: '#B04A3A', label: 'Cloud' },
} as const;

/**
 * Loose shape for runtime-discovered models. The shared AI registry
 * uses a richer enum ('local-gguf' | 'system-os' | 'cloud'); we
 * normalize to this file's narrower 'local' | 'commercial' for render.
 */
export interface DynamicModel {
  id: string;
  name: string;
  kind: string;
  tag: string;
  size?: string;
  vendor?: string;
}

function normalizeDynamic(m: DynamicModel): Model {
  if ((m.kind as any) === 'local' || (m.kind as any) === 'commercial') {
    return m as unknown as Model;
  }
  const isCloud = m.kind === 'cloud';
  return {
    id: m.id,
    name: m.name,
    kind: isCloud ? 'commercial' : 'local',
    tag: m.tag,
    size: m.size,
    vendor: m.vendor,
    installed: !isCloud,
  };
}

function manifestToModel(e: ManifestEntry): Model {
  if (e.kind === 'cloud-llm') {
    return {
      id: e.id,
      name: e.name,
      kind: 'commercial',
      tag: e.tag ?? 'Frontier',
      vendor: e.vendor,
    };
  }
  return {
    id: e.id,
    name: e.name,
    kind: 'local',
    tag: e.tag ?? '',
    size: e.size_bytes ? humanBytes(e.size_bytes) : undefined,
    installed: false,         // installed status comes from runtime probes
    default: e.default_for.includes('desktop') && e.id === FALLBACK_DEFAULT_MODEL_ID,
  };
}

function humanBytes(n: number): string {
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Live-load the manifest from the model service. Returns:
 *   - models: the list (or empty until first fetch resolves)
 *   - loading: true on first paint
 *   - error: non-null if fetch failed (offline, backend down)
 *
 * We deliberately don't retry — a one-shot is enough; the UI shows a
 * static fallback list (just the default Ollama models we know we
 * pull) when the backend is unreachable.
 */
export function useManifestModels(): {
  models: Model[];
  loading: boolean;
  error: string | null;
} {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchManifest()
      .then(entries => {
        if (!alive) return;
        // The picker only shows local-llm + cloud-llm. Embedders are
        // configured separately under Settings → AI → Embeddings.
        const picker = entries
          .filter(e => e.kind === 'local-llm' || e.kind === 'cloud-llm')
          .map(manifestToModel);
        setModels(picker);
        setLoading(false);
      })
      .catch(e => {
        if (!alive) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  return { models, loading, error };
}

interface Props {
  aiOn: boolean;
  modelId: string;
  /**
   * Models discovered at runtime (e.g. via Ollama's /api/tags). Merged
   * into the local section of the dropdown ahead of the manifest list.
   */
  dynamicModels?: DynamicModel[];
  onToggle: () => void;
  onSelect: (id: string) => void;
}

export function AIControls({ aiOn, modelId, dynamicModels = [], onToggle, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { models: manifestModels, loading } = useManifestModels();

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const t = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Merge dynamic + manifest. Dynamic-discovered installed entries
  // (Ollama-pulled) win on id collision because they signal "actually
  // available right now", but for unknown-to-Ollama manifest entries
  // we still show the manifest version (download path).
  const dynNorm = dynamicModels.map(normalizeDynamic);
  const allModels: Model[] = [
    ...dynNorm,
    ...manifestModels.filter(m => !dynNorm.some(d => d.id === m.id)),
  ];
  const m = allModels.find(x => x.id === modelId)
    ?? allModels[0]
    ?? { id: '', name: loading ? 'Loading models…' : 'No models', kind: 'local' as UIKind, tag: '' };
  const kc = KIND_C[m.kind] ?? KIND_C.local;

  return (
    <div className="ai-controls" ref={ref}>
      <div className="ai-row-top">
        <Icon.Sparkle size={13} stroke={aiOn ? 'var(--ai)' : 'var(--ink3)'} />
        <span className="ai-label" style={{ color: aiOn ? 'var(--ink)' : 'var(--ink3)' }}>AI assistant</span>
        <span className="ai-state" style={{ color: aiOn ? 'var(--accent)' : 'var(--ink3)' }}>{aiOn ? 'On' : 'Off'}</span>
        <button
          type="button"
          className={`ai-switch ${aiOn ? 'on' : ''}`}
          onClick={onToggle}
          aria-label={aiOn ? 'Turn AI off' : 'Turn AI on'}
        >
          <span className="ai-switch-thumb" />
        </button>
      </div>

      <button
        type="button"
        className={`ai-model-trigger ${aiOn ? '' : 'disabled'}`}
        disabled={!aiOn}
        onClick={() => aiOn && setOpen(o => !o)}
      >
        <span className="model-dot" style={{ background: kc.dot }} />
        <span className="model-trigger-body">
          <span className="model-name">{m.name}</span>
          <span className="model-meta">
            <span style={{ color: kc.fg, fontWeight: 600 }}>{kc.label}</span>
            {m.tag && <span> · {m.tag}</span>}
          </span>
        </span>
        <Icon.ChevronD size={12} stroke="var(--ink3)" />
      </button>

      {aiOn && open && (
        <ModelDropdown
          modelId={modelId}
          allModels={allModels}
          loading={loading}
          onSelect={(id) => { onSelect(id); setOpen(false); }}
        />
      )}
    </div>
  );
}

function ModelDropdown({
  modelId, allModels, loading, onSelect,
}: {
  modelId: string;
  allModels: Model[];
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  const local = allModels.filter(m => m.kind === 'local');
  const commercial = allModels.filter(m => m.kind === 'commercial');

  return (
    <div className="model-dropdown">
      <div className="model-section-header">
        <span className="model-dot" style={{ background: KIND_C.local.dot, width: 8, height: 8 }} />
        <span style={{ color: KIND_C.local.fg }}>Local, runs on this device</span>
      </div>
      {loading && local.length === 0 && (
        <div className="model-row-loading">Loading models…</div>
      )}
      {!loading && local.length === 0 && (
        <div className="model-row-loading">No local models available.</div>
      )}
      {local.map(m => (
        <ModelRow key={m.id} m={m} selected={m.id === modelId} onClick={() => onSelect(m.id)} />
      ))}

      <div className="model-section-header" style={{ borderTop: '1px solid var(--paper-edge)', marginTop: 6, paddingTop: 12 }}>
        <span className="model-dot" style={{ background: KIND_C.commercial.dot, width: 8, height: 8 }} />
        <span style={{ color: KIND_C.commercial.fg }}>Cloud, 3rd party</span>
      </div>
      <div className="model-warning">
        <Icon.Warning size={11} stroke={KIND_C.commercial.fg} style={{ marginTop: 1, flexShrink: 0 }} />
        <span><b>Note privacy:</b> using a cloud model sends your note contents to the provider. Their terms apply.</span>
      </div>
      {commercial.map(m => (
        <ModelRow key={m.id} m={m} selected={m.id === modelId} onClick={() => onSelect(m.id)} />
      ))}
    </div>
  );
}

function ModelRow({ m, selected, onClick }: { m: Model; selected: boolean; onClick: () => void }) {
  const kc = KIND_C[m.kind];
  return (
    <button type="button" className={`model-row ${selected ? 'selected' : ''} ${m.kind}`} onClick={onClick}>
      <span className="model-dot" style={{ background: kc.dot }} />
      <div className="model-row-body">
        <div className="model-row-name">
          <span>{m.name}</span>
          {m.default && <span className="default-badge" style={{ background: kc.bg, color: kc.fg }}>Default</span>}
        </div>
        <div className="model-row-meta">
          <span style={{ color: kc.fg, fontWeight: 600 }}>
            {m.kind === 'local' ? (m.size ? `Local · ${m.size}` : 'Local') : `${m.vendor ?? 'Cloud'} · shares data`}
          </span>
          {m.tag && <span> · {m.tag}</span>}
        </div>
      </div>
      {selected && <Icon.Check size={12} stroke={kc.fg} />}
    </button>
  );
}
