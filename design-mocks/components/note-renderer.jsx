// Note renderer — takes a list of block objects and renders them with
// the Meo "paper" typography system. Serif for body, sans for headings.
// NOT markdown-visible; this is WYSIWYG.

function NoteRenderer({ note, size = 'desktop', dark = false }) {
  if (!note) return null;
  const p = dark
    ? { ink: MEO.darkInk, ink2: MEO.darkInk2, ink3: MEO.darkInk3, edge: MEO.darkEdge, callout: '#2A2720', accentSoft: '#2D3A20' }
    : { ink: MEO.ink, ink2: MEO.ink2, ink3: MEO.ink3, edge: MEO.paperEdge, callout: '#F3EBD8', accentSoft: MEO.accentSoft };

  const scale = size === 'mobile' ? 0.94 : size === 'compact' ? 0.86 : 1;
  const titleSize = 34 * scale;
  const h2Size = 20 * scale;
  const bodySize = 16.5 * scale;

  return (
    <div style={{ fontFamily: MEO_SERIF, color: p.ink, fontSize: bodySize, lineHeight: 1.65 }}>
      {note.blocks.map((b, i) => {
        if (b.t === 'h1') return (
          <div key={i} style={{
            fontFamily: MEO_FONT, fontWeight: 700, fontSize: titleSize,
            letterSpacing: -0.6, lineHeight: 1.15,
            color: p.ink, marginBottom: 6,
          }}>{b.v}</div>
        );
        if (b.t === 'meta') return (
          <div key={i} style={{
            fontFamily: MEO_FONT, fontSize: 12.5, fontWeight: 500,
            color: p.ink3, letterSpacing: 0.4, textTransform: 'uppercase',
            marginBottom: 22,
          }}>{b.v}</div>
        );
        if (b.t === 'h2') return (
          <div key={i} style={{
            fontFamily: MEO_FONT, fontWeight: 600, fontSize: h2Size,
            color: p.ink, marginTop: 26, marginBottom: 8,
            letterSpacing: -0.2,
          }}>{b.v}</div>
        );
        if (b.t === 'p') return (
          <p key={i} style={{ margin: '0 0 14px', textWrap: 'pretty' }}>{b.v}</p>
        );
        if (b.t === 'check') return (
          <div key={i} style={{
            display: 'flex', gap: 10, alignItems: 'flex-start',
            marginBottom: 7, fontFamily: MEO_FONT, fontSize: bodySize * 0.95,
          }}>
            <div style={{
              width: 17, height: 17, borderRadius: 5, flexShrink: 0,
              marginTop: 4,
              border: `1.5px solid ${b.done ? MEO.accent : p.ink3}`,
              background: b.done ? MEO.accent : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {b.done && <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5l2.5 2.5 5-5" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
            <span style={{
              color: b.done ? p.ink3 : p.ink,
              textDecoration: b.done ? 'line-through' : 'none',
              textDecorationColor: p.ink3,
            }}>{b.v}</span>
          </div>
        );
        if (b.t === 'ul') return (
          <ul key={i} style={{ margin: '0 0 14px', paddingLeft: 20 }}>
            {b.items.map((it, j) => (
              <li key={j} style={{ marginBottom: 4, textWrap: 'pretty' }}>{it}</li>
            ))}
          </ul>
        );
        if (b.t === 'ol') return (
          <ol key={i} style={{ margin: '0 0 14px', paddingLeft: 22 }}>
            {b.items.map((it, j) => (
              <li key={j} style={{ marginBottom: 6, textWrap: 'pretty' }}>{it}</li>
            ))}
          </ol>
        );
        if (b.t === 'callout') return (
          <div key={i} style={{
            background: p.callout, padding: '14px 16px',
            borderRadius: 4, borderLeft: `3px solid ${MEO.ai}`,
            fontFamily: MEO_SERIF, fontStyle: 'italic',
            color: p.ink2, margin: '14px 0', fontSize: bodySize * 0.97,
          }}>{b.v}</div>
        );
        if (b.t === 'link') return (
          <div key={i} style={{
            color: MEO.accent, fontFamily: MEO_FONT, fontSize: bodySize * 0.95,
            marginBottom: 4, cursor: 'pointer',
          }}>{b.v}</div>
        );
        return null;
      })}
    </div>
  );
}

Object.assign(window, { NoteRenderer });
