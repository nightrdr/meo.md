// AddModelPicker — desktop UI for browsing the curated GGUF catalogue
// and pulling models into the local Ollama daemon.
//
// Each row shows:
//   - friendly name + tag                  (from LOCAL_GGUF_CATALOGUE)
//   - on-disk size                         (e.g. "4.4 GB")
//   - VRAM/RAM estimate                    (from sysreq.estimateRequirements)
//   - "CPU OK" badge when the model is small enough to be reasonable
//     without a discrete GPU
//   - Download button — calls OllamaBackend.pull() and streams progress
//
// We deliberately keep this component pure-presentational w.r.t.
// installed state; the parent decides what to do once a download
// completes (e.g. refresh the AIControls dropdown, auto-select the
// new model). Callers wire `onInstalled` for that.
//
// Note: parameter counts in *billions* are inferred from the registry
// id ("qwen2.5-1.5b-q4" → 1.5). The catalogue ids carry the params
// segment by convention; if that ever changes we'll add a `paramsB`
// field on Model in registry.ts.

import React, { useMemo, useState } from 'react';
import { ai } from '@meo/shared';

const {
  LOCAL_GGUF_CATALOGUE,
  estimateRequirements,
  paramsBFromId,
  ollamaTagForId,
  OllamaBackend,
} = ai;
type Model = ai.Model;

import { Icon } from './Icon';

export interface AddModelPickerProps {
  /**
   * Ollama-reported model tags currently installed (e.g. "qwen2.5:1.5b").
   * Pass `dynamicModels.map(m => m.id)` from App.tsx; we'll match each
   * catalogue row against its mapped Ollama tag internally.
   */
  installedOllamaTags?: readonly string[];
  /** Called after a successful pull so the parent can refresh state. */
  onInstalled?: (id: string) => void;
}

interface RowState {
  /** undefined = idle; 0..1 = pulling; 1 = done. */
  fraction?: number;
  status?: string;
  error?: string;
}

export function AddModelPicker({ installedOllamaTags, onInstalled }: AddModelPickerProps) {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const backend = useMemo(() => new OllamaBackend(), []);
  const installedSet = useMemo(
    () => new Set(installedOllamaTags ?? []),
    [installedOllamaTags],
  );

  const update = (id: string, patch: RowState) =>
    setRows(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const startPull = async (m: Model) => {
    const tag = ollamaTagForId(m.id);
    update(m.id, { fraction: 0, status: 'starting…', error: undefined });
    try {
      for await (const ev of backend.pull(tag)) {
        const frac = ev.total && ev.completed
          ? Math.min(1, ev.completed / ev.total)
          : undefined;
        update(m.id, { fraction: frac ?? 0, status: ev.status });
      }
      update(m.id, { fraction: 1, status: 'installed' });
      onInstalled?.(m.id);
    } catch (e) {
      update(m.id, { error: (e as Error).message ?? 'download failed' });
    }
  };

  return (
    <div className="add-model-picker">
      <div className="add-model-intro">
        <Icon.Sparkle size={14} stroke="var(--accent)" />
        <span>
          Pick a model to download into Ollama. All run fully on this
          device — your notes never leave the machine.
        </span>
      </div>

      <ul className="add-model-list">
        {LOCAL_GGUF_CATALOGUE.map(m => (
          <ModelPickerRow
            key={m.id}
            model={m}
            installed={installedSet.has(ollamaTagForId(m.id))}
            state={rows[m.id]}
            onDownload={() => void startPull(m)}
          />
        ))}
      </ul>
    </div>
  );
}

function ModelPickerRow({
  model, installed, state, onDownload,
}: {
  model: Model;
  installed: boolean;
  state?: RowState;
  onDownload: () => void;
}) {
  const sizeBytes = parseSizeStr(model.size);
  const paramsB = paramsBFromId(model.id);
  const req = estimateRequirements(sizeBytes, paramsB);

  const downloading = state && state.fraction !== undefined && state.fraction < 1;
  const done = state?.fraction === 1 || installed;

  return (
    <li className="add-model-row">
      <div className="add-model-row-head">
        <div className="add-model-row-title">
          <span className="add-model-row-name">{model.name}</span>
          {model.tag && <span className="add-model-row-tag">{model.tag}</span>}
          {req.runsOnCpu && (
            <span className="add-model-badge cpu-ok">CPU OK</span>
          )}
        </div>
        <div className="add-model-row-actions">
          {done ? (
            <span className="add-model-installed">Installed</span>
          ) : downloading ? (
            <span className="add-model-progress">
              {state?.status ?? 'downloading'} {Math.round((state?.fraction ?? 0) * 100)}%
            </span>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onDownload}>
              Download
            </button>
          )}
        </div>
      </div>

      <div className="add-model-row-meta">
        <span><b>Size</b> {model.size ?? '—'}</span>
        <span><b>VRAM</b> ~{req.recommendedVramGb} GB</span>
        <span><b>RAM</b> ~{req.minRamGb} GB</span>
        {paramsB > 0 && <span><b>Params</b> {formatParams(paramsB)}</span>}
      </div>

      {state?.error && (
        <div className="add-model-row-error">{state.error}</div>
      )}
    </li>
  );
}

/**
 * Parse a human-readable size string ("4.4 GB", "1.1 GB", "270 MB")
 * into bytes. Tolerates a missing unit (assumed GB) and weird
 * spacing. Returns 0 if we can't parse.
 */
function parseSizeStr(s?: string): number {
  if (!s) return 0;
  const m = /([\d.]+)\s*(GB|MB|KB|B)?/i.exec(s.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] ?? 'GB').toUpperCase();
  switch (unit) {
    case 'B':  return n;
    case 'KB': return n * 1024;
    case 'MB': return n * 1024 * 1024;
    case 'GB': return n * 1024 * 1024 * 1024;
    default:   return n * 1024 * 1024 * 1024;
  }
}

function formatParams(b: number): string {
  if (b >= 1) return `${b.toFixed(b % 1 === 0 ? 0 : 1)}B`;
  const m = b * 1000;
  return `${m.toFixed(m % 1 === 0 ? 0 : 0)}M`;
}
