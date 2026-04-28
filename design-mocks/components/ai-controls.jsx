// AI controls — on/off switch + model dropdown
// Local models: green theme. Commercial/cloud models: red theme + warning.

const MODELS = [
  // local — green
  { id: 'meo-mini',     name: 'Meo Mini',          size: '1.1 GB', kind: 'local',      tag: 'Fast · on-device',     installed: true,  default: true },
  { id: 'llama-3.1-8b', name: 'Llama 3.1 8B',      size: '4.7 GB', kind: 'local',      tag: 'Balanced',             installed: true },
  { id: 'qwen-2.5-7b',  name: 'Qwen 2.5 7B',       size: '4.4 GB', kind: 'local',      tag: 'Long context',         installed: true },
  { id: 'mistral-7b',   name: 'Mistral 7B',        size: '4.1 GB', kind: 'local',      tag: 'Reasoning',            installed: false },
  { id: 'phi-3.5-mini', name: 'Phi-3.5 Mini',      size: '2.3 GB', kind: 'local',      tag: 'Lightweight',          installed: false },
  { id: 'gemma-2-9b',   name: 'Gemma 2 9B',        size: '5.4 GB', kind: 'local',      tag: 'High quality',         installed: false },
  // commercial — red
  { id: 'gpt-4o',       name: 'GPT-4o',            vendor: 'OpenAI',     kind: 'commercial', tag: 'Frontier' },
  { id: 'claude-sonnet',name: 'Claude Sonnet 4.5', vendor: 'Anthropic',  kind: 'commercial', tag: 'Frontier' },
  { id: 'gemini-pro',   name: 'Gemini 2.5 Pro',    vendor: 'Google',     kind: 'commercial', tag: 'Frontier' },
];

// Color tokens for model kind
const KIND_C = {
  local:      { fg: '#3F5A2C', bg: '#E1EBD2', dot: '#4F6B3A', label: 'Local' },
  commercial: { fg: '#923524', bg: '#F4D7CF', dot: '#B04A3A', label: 'Cloud' },
};

function ModelDot({ kind, size = 7 }) {
  return <div style={{ width: size, height: size, borderRadius: '50%', background: KIND_C[kind].dot, flexShrink: 0 }}/>;
}

// Compact AI rail used in sidebar — switch + dropdown trigger
function AIControls({ t, dark, aiOn, model, dropdownOpen, onToggle, onOpenDropdown, onOpenDownloads }) {
  const m = MODELS.find(x => x.id === model) || MODELS[0];
  const kc = KIND_C[m.kind];

  return (
    <div style={{
      borderTop: `1px solid ${t.edge}`, padding: '10px 10px 10px',
      display: 'flex', flexDirection: 'column', gap: 8,
      position: 'relative',
    }}>
      {/* on/off row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px',
      }}>
        <Icon.Sparkle size={13} stroke={aiOn ? MEO.ai : t.ink3}/>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: aiOn ? t.ink : t.ink3, flex: 1 }}>
          AI assistant
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600, color: aiOn ? MEO.accent : t.ink3,
          textTransform: 'uppercase', letterSpacing: 0.6,
        }}>{aiOn ? 'On' : 'Off'}</span>
        {/* switch */}
        <button onClick={onToggle} style={{
          width: 30, height: 18, borderRadius: 999, border: 'none', padding: 0,
          background: aiOn ? MEO.accent : (dark ? 'rgba(255,255,255,0.15)' : 'rgba(31,28,23,0.18)'),
          position: 'relative', cursor: 'pointer', flexShrink: 0,
          transition: 'background .15s',
        }}>
          <div style={{
            position: 'absolute', top: 2, left: aiOn ? 14 : 2,
            width: 14, height: 14, borderRadius: '50%', background: '#fff',
            transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
          }}/>
        </button>
      </div>

      {/* model dropdown trigger */}
      <button onClick={aiOn ? onOpenDropdown : undefined} disabled={!aiOn} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 10px', borderRadius: 8,
        background: aiOn ? (dark ? 'rgba(255,255,255,0.05)' : '#fff') : 'transparent',
        border: `1px solid ${aiOn ? t.edge : 'transparent'}`,
        cursor: aiOn ? 'pointer' : 'not-allowed',
        opacity: aiOn ? 1 : 0.4,
        fontFamily: MEO_FONT,
      }}>
        <ModelDot kind={m.kind}/>
        <div style={{ flex: 1, textAlign: 'left', overflow: 'hidden' }}>
          <div style={{
            fontSize: 12.5, fontWeight: 600, color: t.ink,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{m.name}</div>
          <div style={{
            fontSize: 10, color: t.ink3, marginTop: 1,
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <span style={{ color: kc.fg, fontWeight: 600 }}>{kc.label}</span>
            <span>·</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.tag}</span>
          </div>
        </div>
        <Icon.ChevronD size={12} stroke={t.ink3}/>
      </button>

      {/* dropdown menu */}
      {aiOn && dropdownOpen && (
        <ModelDropdown t={t} dark={dark} model={model} onOpenDownloads={onOpenDownloads}/>
      )}
    </div>
  );
}

function ModelDropdown({ t, dark, model, onOpenDownloads }) {
  const local = MODELS.filter(m => m.kind === 'local' && m.installed);
  const commercial = MODELS.filter(m => m.kind === 'commercial');

  return (
    <div style={{
      position: 'absolute', bottom: 'calc(100% - 4px)', left: 10, right: 10,
      background: dark ? '#221F19' : '#FFFBF3',
      border: `1px solid ${t.edge}`, borderRadius: 12,
      boxShadow: '0 24px 60px rgba(0,0,0,0.22), 0 4px 12px rgba(0,0,0,0.08)',
      padding: 6, fontFamily: MEO_FONT, zIndex: 50,
      maxHeight: 460, overflow: 'auto',
    }}>
      {/* Local section */}
      <div style={{
        padding: '8px 10px 6px', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <ModelDot kind="local" size={8}/>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: KIND_C.local.fg, letterSpacing: 0.6, textTransform: 'uppercase' }}>
          Local · runs on this device
        </span>
      </div>
      {local.map(m => (
        <ModelRow key={m.id} m={m} selected={m.id === model} t={t} dark={dark}/>
      ))}

      {/* Download more */}
      <button onClick={onOpenDownloads} style={{
        width: '100%', textAlign: 'left',
        padding: '8px 10px', margin: '2px 0', borderRadius: 7,
        background: 'transparent', border: `1px dashed ${KIND_C.local.dot}`,
        color: KIND_C.local.fg, fontFamily: MEO_FONT, cursor: 'pointer',
        fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <Icon.Plus size={11} stroke={KIND_C.local.fg}/> Download more local models
      </button>

      {/* Commercial section */}
      <div style={{
        padding: '12px 10px 6px', display: 'flex', alignItems: 'center', gap: 6, marginTop: 4,
        borderTop: `1px solid ${t.edge}`,
      }}>
        <ModelDot kind="commercial" size={8}/>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: KIND_C.commercial.fg, letterSpacing: 0.6, textTransform: 'uppercase' }}>
          Cloud · 3rd party
        </span>
      </div>
      <div style={{
        margin: '0 8px 6px', padding: '7px 10px', borderRadius: 6,
        background: dark ? 'rgba(176,74,58,0.12)' : '#F8E6E0',
        border: `1px solid ${dark ? 'rgba(176,74,58,0.3)' : '#E8C4B7'}`,
        fontSize: 10.5, color: KIND_C.commercial.fg, lineHeight: 1.4,
        display: 'flex', gap: 6, alignItems: 'flex-start',
      }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={KIND_C.commercial.fg} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 1, flexShrink: 0 }}>
          <path d="M12 2 1 21h22L12 2zM12 9v5M12 17.5v.5"/>
        </svg>
        <span><b>Note privacy:</b> using a cloud model sends your note contents to the provider. Their terms apply.</span>
      </div>
      {commercial.map(m => (
        <ModelRow key={m.id} m={m} selected={m.id === model} t={t} dark={dark}/>
      ))}
    </div>
  );
}

function ModelRow({ m, selected, t, dark }) {
  const kc = KIND_C[m.kind];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 9,
      padding: '8px 10px', borderRadius: 7, cursor: 'pointer',
      background: selected
        ? (m.kind === 'local'
            ? (dark ? 'rgba(79,107,58,0.22)' : '#E1EBD2')
            : (dark ? 'rgba(176,74,58,0.18)' : '#F8E6E0'))
        : 'transparent',
      border: selected
        ? `1px solid ${m.kind === 'local' ? '#B6C99A' : '#E8C4B7'}`
        : '1px solid transparent',
    }}>
      <ModelDot kind={m.kind}/>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12.5, fontWeight: 600, color: t.ink,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
          {m.default && (
            <span style={{
              fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
              background: kc.bg, color: kc.fg, letterSpacing: 0.5, textTransform: 'uppercase',
            }}>Default</span>
          )}
        </div>
        <div style={{
          fontSize: 10.5, color: t.ink3, marginTop: 1,
          display: 'flex', gap: 5, alignItems: 'center',
        }}>
          <span style={{ color: kc.fg, fontWeight: 600 }}>
            {m.kind === 'local' ? `Local · ${m.size}` : `${m.vendor} · shares data`}
          </span>
          <span>·</span>
          <span>{m.tag}</span>
        </div>
      </div>
      {selected && <Icon.Check size={12} stroke={kc.fg}/>}
    </div>
  );
}

Object.assign(window, { MODELS, KIND_C, ModelDot, AIControls, ModelDropdown, ModelRow });
