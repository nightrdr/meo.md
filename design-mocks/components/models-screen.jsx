// Models download screen — curated list of open-source models.

const DOWNLOADABLE = [
  { id: 'meo-mini',     name: 'Meo Mini',          publisher: 'Meo',     size: '1.1 GB', params: '1.5B',  ctx: '8K',   tag: 'Fast · on-device',     license: 'Apache 2.0', status: 'installed' },
  { id: 'llama-3.1-8b', name: 'Llama 3.1 8B',      publisher: 'Meta',    size: '4.7 GB', params: '8B',    ctx: '128K', tag: 'Balanced general use', license: 'Llama 3.1', status: 'installed' },
  { id: 'qwen-2.5-7b',  name: 'Qwen 2.5 7B',       publisher: 'Alibaba', size: '4.4 GB', params: '7B',    ctx: '128K', tag: 'Long context, multilingual', license: 'Apache 2.0', status: 'installed' },
  { id: 'mistral-7b',   name: 'Mistral 7B Instruct', publisher: 'Mistral AI', size: '4.1 GB', params: '7B',  ctx: '32K',  tag: 'Strong reasoning',     license: 'Apache 2.0', status: 'downloading', progress: 62 },
  { id: 'phi-3.5-mini', name: 'Phi-3.5 Mini',      publisher: 'Microsoft', size: '2.3 GB', params: '3.8B',  ctx: '128K', tag: 'Lightweight, surprisingly capable', license: 'MIT', status: 'available' },
  { id: 'gemma-2-9b',   name: 'Gemma 2 9B',        publisher: 'Google',  size: '5.4 GB', params: '9B',    ctx: '8K',   tag: 'High quality outputs', license: 'Gemma',     status: 'available' },
  { id: 'deepseek-r1-7b', name: 'DeepSeek-R1 Distill 7B', publisher: 'DeepSeek', size: '4.5 GB', params: '7B', ctx: '32K', tag: 'Reasoning specialist', license: 'MIT',  status: 'available' },
  { id: 'codellama-7b', name: 'Code Llama 7B',     publisher: 'Meta',    size: '3.8 GB', params: '7B',    ctx: '16K',  tag: 'Code-focused',         license: 'Llama 2', status: 'available' },
];

function ModelsDownloadScreen({ dark = false }) {
  const t = dark
    ? { bg: MEO.darkPaper, side: MEO.darkSide, edge: MEO.darkEdge,
        ink: MEO.darkInk, ink2: MEO.darkInk2, ink3: MEO.darkInk3,
        overlay: MEO.darkOverlay, card: MEO.darkOverlay }
    : { bg: MEO.paper, side: MEO.sidebar, edge: MEO.paperEdge,
        ink: MEO.ink, ink2: MEO.ink2, ink3: MEO.ink3,
        overlay: MEO.overlay, card: '#fff' };

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', background: t.bg, fontFamily: MEO_FONT }}>
      {/* settings sidebar */}
      <div style={{
        width: 220, background: t.side, borderRight: `1px solid ${t.edge}`,
        display: 'flex', flexDirection: 'column', flexShrink: 0,
      }}>
        <div style={{ height: 44, padding: '0 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#E46F65' }}/>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#E5B137' }}/>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#5EB25C' }}/>
          </div>
        </div>
        <div style={{ padding: '8px 18px 16px', fontSize: 13, fontWeight: 700, color: t.ink, letterSpacing: -0.2 }}>
          Settings
        </div>
        <div style={{ padding: '0 8px' }}>
          {[
            ['General', false],
            ['Appearance', false],
            ['Editor', false],
            ['AI & Models', true],
            ['Sync & accounts', false],
            ['Shortcuts', false],
            ['About', false],
          ].map(([name, sel]) => (
            <div key={name} style={{
              padding: '7px 10px', borderRadius: 6,
              fontSize: 12.5, fontWeight: sel ? 600 : 500,
              color: sel ? t.ink : t.ink2,
              background: sel ? (dark ? 'rgba(255,255,255,0.06)' : 'rgba(31,28,23,0.06)') : 'transparent',
              marginBottom: 1,
            }}>{name}</div>
          ))}
        </div>
      </div>

      {/* main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        {/* tabs / header */}
        <div style={{ borderBottom: `1px solid ${t.edge}`, padding: '14px 28px 0' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: t.ink3, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>Settings · AI & Models</div>
          <div style={{ fontFamily: MEO_SERIF, fontSize: 26, fontWeight: 700, color: t.ink, letterSpacing: -0.3, marginBottom: 14 }}>
            Local models
          </div>
          <div style={{ display: 'flex', gap: 18, fontSize: 13 }}>
            {['Library', 'Available', 'Cloud providers', 'Privacy'].map((tb, i) => (
              <div key={tb} style={{
                paddingBottom: 10, color: i === 1 ? t.ink : t.ink3,
                fontWeight: i === 1 ? 600 : 500,
                borderBottom: i === 1 ? `2px solid ${MEO.accent}` : '2px solid transparent',
                marginBottom: -1,
              }}>{tb}</div>
            ))}
          </div>
        </div>

        {/* body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 28px 40px' }}>
          {/* explainer */}
          <div style={{
            padding: '14px 16px', borderRadius: 10,
            background: dark ? 'rgba(79,107,58,0.14)' : '#E1EBD2',
            border: `1px solid ${dark ? 'rgba(79,107,58,0.3)' : '#B6C99A'}`,
            display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 22,
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: 7, flexShrink: 0,
              background: '#4F6B3A', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 4 6v6c0 5 3.5 9.5 8 10 4.5-.5 8-5 8-10V6l-8-4z"/></svg>
            </div>
            <div style={{ flex: 1, fontSize: 13, color: KIND_C.local.fg, lineHeight: 1.5 }}>
              <b>Your notes never leave this device.</b> Local models run entirely on your machine —
              no internet required after download, no contents shared with any provider.
              Choose from the curated, audited open-source list below.
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: t.ink }}>Available models</div>
            <div style={{ fontSize: 11, color: t.ink3 }}>Curated by Meo · {DOWNLOADABLE.length} models</div>
            <div style={{ flex: 1 }}/>
            <div style={{
              height: 30, padding: '0 10px', borderRadius: 7,
              border: `1px solid ${t.edge}`, display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 12, color: t.ink3, background: dark ? 'rgba(255,255,255,0.04)' : '#fff',
              minWidth: 220,
            }}>
              <Icon.Search size={12} stroke={t.ink3}/> Search models
            </div>
          </div>

          <div style={{
            background: t.card, border: `1px solid ${t.edge}`, borderRadius: 12,
            overflow: 'hidden',
          }}>
            {DOWNLOADABLE.map((m, i) => (
              <DownloadRow key={m.id} m={m} t={t} dark={dark} last={i === DOWNLOADABLE.length - 1}/>
            ))}
          </div>

          <div style={{ marginTop: 22, fontSize: 11.5, color: t.ink3, lineHeight: 1.5 }}>
            Models are downloaded directly from their original publishers and verified by checksum.
            Meo only lists open-source models with permissive or research-use licenses.
            <br/>Want a model added? <span style={{ color: MEO.accent, fontWeight: 600 }}>Request a model →</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DownloadRow({ m, t, dark, last }) {
  const installed   = m.status === 'installed';
  const downloading = m.status === 'downloading';
  const available   = m.status === 'available';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '14px 18px',
      borderBottom: last ? 'none' : `1px solid ${t.edge}`,
    }}>
      {/* avatar */}
      <div style={{
        width: 38, height: 38, borderRadius: 8, flexShrink: 0,
        background: installed ? '#E1EBD2' : (dark ? 'rgba(255,255,255,0.05)' : '#EFE9DD'),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: installed ? '1px solid #B6C99A' : `1px solid ${t.edge}`,
      }}>
        <ModelDot kind="local" size={10}/>
      </div>

      {/* info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: t.ink }}>{m.name}</span>
          <span style={{
            fontSize: 9.5, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
            background: KIND_C.local.bg, color: KIND_C.local.fg, letterSpacing: 0.5, textTransform: 'uppercase',
          }}>Local</span>
          {installed && (
            <span style={{ fontSize: 11, color: KIND_C.local.fg, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>
              <Icon.Check size={11} stroke={KIND_C.local.fg}/> Installed
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: t.ink2, marginBottom: 4 }}>{m.tag}</div>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: t.ink3, fontFamily: MEO_MONO }}>
          <span>{m.publisher}</span>
          <span>·</span>
          <span>{m.params}</span>
          <span>·</span>
          <span>{m.ctx} ctx</span>
          <span>·</span>
          <span>{m.size}</span>
          <span>·</span>
          <span>{m.license}</span>
        </div>
        {downloading && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              flex: 1, maxWidth: 320, height: 5, borderRadius: 3,
              background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(31,28,23,0.08)',
              overflow: 'hidden',
            }}>
              <div style={{ width: `${m.progress}%`, height: '100%', background: MEO.accent }}/>
            </div>
            <span style={{ fontSize: 11, color: t.ink3, fontFamily: MEO_MONO }}>{m.progress}% · 1.2 MB/s</span>
          </div>
        )}
      </div>

      {/* action */}
      <div style={{ flexShrink: 0 }}>
        {installed && (
          <button style={btnGhost(t, dark)}>Manage</button>
        )}
        {downloading && (
          <button style={btnGhost(t, dark)}>Cancel</button>
        )}
        {available && (
          <button style={{
            ...btnPrimary(),
            background: MEO.accent,
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14"/></svg>
            Download
          </button>
        )}
      </div>
    </div>
  );
}

function btnGhost(t, dark) {
  return {
    height: 30, padding: '0 12px', borderRadius: 7,
    background: dark ? 'rgba(255,255,255,0.04)' : '#fff',
    border: `1px solid ${t.edge}`, color: t.ink, fontFamily: MEO_FONT,
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
  };
}
function btnPrimary() {
  return {
    height: 30, padding: '0 14px', borderRadius: 7,
    background: MEO.accent, border: 'none', color: '#fff',
    fontFamily: MEO_FONT, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 6,
  };
}

Object.assign(window, { ModelsDownloadScreen, DOWNLOADABLE });
