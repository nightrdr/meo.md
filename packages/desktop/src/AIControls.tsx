import React, { useState, useEffect, useRef } from 'react';
import { Icon } from './Icon';

// Mirrors design-mocks/components/ai-controls.jsx — the model catalogue is
// UI-only for now. Selecting a model persists to localStorage; actual local
// LLM inference is deferred (per spec §3.6).

export interface Model {
  id: string;
  name: string;
  size?: string;
  vendor?: string;
  kind: 'local' | 'commercial';
  tag: string;
  installed?: boolean;
  default?: boolean;
}

export const MODELS: Model[] = [
  // local — green
  { id: 'meo-mini',     name: 'Meo Mini',          size: '1.1 GB', kind: 'local',      tag: 'Fast, on-device',  installed: true,  default: true },
  { id: 'llama-3.1-8b', name: 'Llama 3.1 8B',      size: '4.7 GB', kind: 'local',      tag: 'Balanced',         installed: true },
  { id: 'qwen-2.5-7b',  name: 'Qwen 2.5 7B',       size: '4.4 GB', kind: 'local',      tag: 'Long context',     installed: true },
  { id: 'mistral-7b',   name: 'Mistral 7B',        size: '4.1 GB', kind: 'local',      tag: 'Reasoning',        installed: false },
  { id: 'phi-3.5-mini', name: 'Phi-3.5 Mini',      size: '2.3 GB', kind: 'local',      tag: 'Lightweight',      installed: false },
  { id: 'gemma-2-9b',   name: 'Gemma 2 9B',        size: '5.4 GB', kind: 'local',      tag: 'High quality',     installed: false },
  // commercial — red
  { id: 'gpt-4o',        name: 'GPT-4o',             vendor: 'OpenAI',    kind: 'commercial', tag: 'Frontier' },
  { id: 'claude-sonnet', name: 'Claude Sonnet 4.5',  vendor: 'Anthropic', kind: 'commercial', tag: 'Frontier' },
  { id: 'gemini-pro',    name: 'Gemini 2.5 Pro',     vendor: 'Google',    kind: 'commercial', tag: 'Frontier' },
];

export const KIND_C = {
  local:      { fg: '#3F5A2C', bg: '#E1EBD2', dot: '#4F6B3A', label: 'Local' },
  commercial: { fg: '#923524', bg: '#F4D7CF', dot: '#B04A3A', label: 'Cloud' },
} as const;

/**
 * Loose shape for runtime-discovered models. The shared AI registry uses
 * a richer enum ('local-gguf' | 'system-os' | 'cloud'); we normalize
 * those to this file's narrower 'local' | 'commercial' before render.
 */
export interface DynamicModel {
  id: string;
  name: string;
  kind: string;          // 'local-gguf' | 'system-os' | 'cloud' from shared
  tag: string;
  size?: string;
  vendor?: string;
}

function normalizeModel(m: DynamicModel | Model): Model {
  if ((m.kind as any) === 'local' || (m.kind as any) === 'commercial') return m as Model;
  // Map shared/AI enum to local UI enum
  const isCloud = m.kind === 'cloud';
  return {
    id: m.id,
    name: m.name,
    kind: isCloud ? 'commercial' : 'local',
    tag: m.tag,
    size: m.size,
    vendor: (m as any).vendor,
    installed: !isCloud,           // dynamically discovered ⇒ already installed
  };
}

interface Props {
  aiOn: boolean;
  modelId: string;
  /**
   * Models discovered at runtime (e.g. via Ollama's /api/tags). Merged
   * into the local section of the dropdown ahead of the static catalogue.
   */
  dynamicModels?: DynamicModel[];
  onToggle: () => void;
  onSelect: (id: string) => void;
}

export function AIControls({ aiOn, modelId, dynamicModels = [], onToggle, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  // Merge dynamic + static for the selector. Dynamic-installed entries
  // win when ids overlap. Both must be normalized to the local enum.
  const dynNorm = dynamicModels.map(normalizeModel);
  const allModels: Model[] = [
    ...dynNorm,
    ...MODELS.filter(s => !dynNorm.some(d => d.id === s.id)),
  ];
  const m = allModels.find(x => x.id === modelId) ?? allModels[0];
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
            <span> · </span>
            <span>{m.tag}</span>
          </span>
        </span>
        <Icon.ChevronD size={12} stroke="var(--ink3)" />
      </button>

      {aiOn && open && (
        <ModelDropdown
          modelId={modelId}
          dynamicModels={dynamicModels}
          onSelect={(id) => { onSelect(id); setOpen(false); }}
        />
      )}
    </div>
  );
}

function ModelDropdown({
  modelId, dynamicModels, onSelect,
}: { modelId: string; dynamicModels: DynamicModel[]; onSelect: (id: string) => void }) {
  const dynNorm = dynamicModels.map(normalizeModel);
  // Local section: dynamically discovered first, then statically known
  // local models that aren't already in the dynamic list.
  const dynLocal = dynNorm.filter(m => m.kind === 'local');
  const staticLocal = MODELS.filter(m => m.kind === 'local' && m.installed && !dynLocal.some(d => d.id === m.id));
  const local = [...dynLocal, ...staticLocal];
  const commercial = MODELS.filter(m => m.kind === 'commercial');

  return (
    <div className="model-dropdown">
      <div className="model-section-header">
        <span className="model-dot" style={{ background: KIND_C.local.dot, width: 8, height: 8 }} />
        <span style={{ color: KIND_C.local.fg }}>Local, runs on this device</span>
      </div>
      {local.map(m => (
        <ModelRow key={m.id} m={m} selected={m.id === modelId} onClick={() => onSelect(m.id)} />
      ))}

      <button className="model-download-more" type="button">
        <Icon.Plus size={11} stroke={KIND_C.local.fg} />
        <span>Download more local models</span>
      </button>

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
            {m.kind === 'local' ? `Local · ${m.size}` : `${m.vendor} · shares data`}
          </span>
          <span>·</span>
          <span>{m.tag}</span>
        </div>
      </div>
      {selected && <Icon.Check size={12} stroke={kc.fg} />}
    </button>
  );
}
