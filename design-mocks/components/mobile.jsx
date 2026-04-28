// Mobile — Meo notes app. iOS-style but original Meo aesthetic.
// Three screens: folders list, notes list, note editor.

function MobileFolders({ dark = false }) {
  const t = dark
    ? { bg: MEO.darkPaper, card: MEO.darkOverlay, ink: MEO.darkInk, ink2: MEO.darkInk2, ink3: MEO.darkInk3, edge: MEO.darkEdge }
    : { bg: MEO.paper, card: '#fff', ink: MEO.ink, ink2: MEO.ink2, ink3: MEO.ink3, edge: MEO.paperEdge };

  return (
    <div style={{
      width: '100%', minHeight: '100%', background: t.bg,
      fontFamily: MEO_FONT, paddingBottom: 100,
    }}>
      {/* header */}
      <div style={{ padding: '70px 20px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <MeoMark size={28}/>
        <div style={{
          fontFamily: MEO_SERIF, fontSize: 28, fontWeight: 700,
          letterSpacing: -0.5, color: t.ink, flex: 1,
        }}>Meo</div>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(31,28,23,0.06)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.ink2,
        }}><Icon.Sparkle size={15} stroke={MEO.ai}/></div>
      </div>

      {/* search */}
      <div style={{ padding: '6px 16px 18px' }}>
        <div style={{
          height: 40, borderRadius: 10, background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(31,28,23,0.05)',
          display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8,
        }}>
          <Icon.Search size={15} stroke={t.ink3}/>
          <span style={{ fontSize: 15, color: t.ink3 }}>Search notes & ask Meo</span>
        </div>
      </div>

      {/* system folders — card */}
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{
          background: t.card, borderRadius: 14,
          boxShadow: dark ? 'none' : '0 1px 2px rgba(31,28,23,0.04)',
          border: `1px solid ${t.edge}`, overflow: 'hidden',
        }}>
          {[
            { n: 'All notes', c: 10, i: 'Note', a: MEO.accent },
            { n: 'Pinned', c: 2, i: 'Pin', a: MEO.ai },
            { n: 'Recent', c: 6, i: 'Star', a: '#C8A15A' },
          ].map((f, i, arr) => {
            const IconComp = Icon[f.i];
            return (
              <div key={f.n} style={{
                display: 'flex', alignItems: 'center', padding: '12px 14px', gap: 12,
                borderBottom: i < arr.length - 1 ? `0.5px solid ${t.edge}` : 'none',
              }}>
                <div style={{
                  width: 30, height: 30, borderRadius: 7,
                  background: f.a + '22',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <IconComp size={15} stroke={f.a}/>
                </div>
                <span style={{ flex: 1, fontSize: 16, color: t.ink, fontWeight: 500 }}>{f.n}</span>
                <span style={{ fontSize: 14, color: t.ink3 }}>{f.c}</span>
                <Icon.Chevron size={13} stroke={t.ink3}/>
              </div>
            );
          })}
        </div>
      </div>

      {/* user folders */}
      <div style={{ padding: '4px 22px 6px', fontSize: 11, fontWeight: 600, color: t.ink3, textTransform: 'uppercase', letterSpacing: 0.8 }}>
        Folders
      </div>
      <div style={{ padding: '0 16px' }}>
        <div style={{
          background: t.card, borderRadius: 14, overflow: 'hidden',
          border: `1px solid ${t.edge}`,
        }}>
          {USER_FOLDERS.map((f, i) => (
            <div key={f.id} style={{
              display: 'flex', alignItems: 'center', padding: '12px 14px', gap: 12,
              borderBottom: i < USER_FOLDERS.length - 1 ? `0.5px solid ${t.edge}` : 'none',
            }}>
              <Icon.Folder size={17} stroke={MEO.accent}/>
              <span style={{ flex: 1, fontSize: 16, color: t.ink, fontWeight: 500 }}>{f.name}</span>
              <span style={{ fontSize: 14, color: t.ink3 }}>{f.count}</span>
              <Icon.Chevron size={13} stroke={t.ink3}/>
            </div>
          ))}
        </div>
      </div>

      {/* floating new button */}
      <div style={{
        position: 'absolute', bottom: 42, right: 20,
        width: 58, height: 58, borderRadius: '50%',
        background: MEO.ink, color: '#F6F2EA',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 8px 22px rgba(0,0,0,0.25)',
      }}>
        <Icon.Edit size={22} stroke="#F6F2EA"/>
      </div>
    </div>
  );
}

function MobileNotesList({ dark = false }) {
  const t = dark
    ? { bg: MEO.darkPaper, card: MEO.darkOverlay, ink: MEO.darkInk, ink2: MEO.darkInk2, ink3: MEO.darkInk3, edge: MEO.darkEdge }
    : { bg: MEO.paper, card: '#fff', ink: MEO.ink, ink2: MEO.ink2, ink3: MEO.ink3, edge: MEO.paperEdge };

  const workNotes = NOTES.filter(n => n.folder === 'work');

  return (
    <div style={{
      width: '100%', minHeight: '100%', background: t.bg,
      fontFamily: MEO_FONT, paddingBottom: 40,
    }}>
      {/* back nav */}
      <div style={{ padding: '60px 16px 4px', display: 'flex', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: MEO.accent, fontSize: 15 }}>
          <Icon.Back size={16} stroke={MEO.accent}/> Folders
        </div>
        <div style={{ flex: 1 }}/>
        <Icon.Dots size={18} stroke={t.ink2}/>
      </div>

      {/* large title */}
      <div style={{ padding: '16px 20px 10px' }}>
        <div style={{ fontSize: 12, color: MEO.accent, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>
          <Icon.Folder size={11} stroke={MEO.accent}/> Work
        </div>
        <div style={{ fontFamily: MEO_SERIF, fontSize: 32, fontWeight: 700, letterSpacing: -0.5, color: t.ink }}>
          Work
        </div>
        <div style={{ fontSize: 13, color: t.ink3, marginTop: 2 }}>3 notes · 2 sub-folders</div>
      </div>

      {/* search */}
      <div style={{ padding: '6px 16px 14px' }}>
        <div style={{
          height: 38, borderRadius: 10, background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(31,28,23,0.05)',
          display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8,
        }}>
          <Icon.Search size={14} stroke={t.ink3}/>
          <span style={{ fontSize: 14, color: t.ink3 }}>Search in Work</span>
        </div>
      </div>

      {/* pinned */}
      <div style={{ padding: '2px 22px 6px', fontSize: 11, fontWeight: 600, color: t.ink3, textTransform: 'uppercase', letterSpacing: 0.8, display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon.Pin size={10} stroke={t.ink3}/> Pinned
      </div>
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{
          background: t.card, borderRadius: 14, overflow: 'hidden',
          border: `1px solid ${t.edge}`, padding: '2px 0',
        }}>
          {workNotes.filter(n => n.pinned).map(n => (
            <MobileNoteRow key={n.id} n={n} t={t}/>
          ))}
        </div>
      </div>

      {/* all */}
      <div style={{ padding: '2px 22px 6px', fontSize: 11, fontWeight: 600, color: t.ink3, textTransform: 'uppercase', letterSpacing: 0.8 }}>
        All
      </div>
      <div style={{ padding: '0 16px' }}>
        <div style={{
          background: t.card, borderRadius: 14, overflow: 'hidden',
          border: `1px solid ${t.edge}`, padding: '2px 0',
        }}>
          {workNotes.map(n => (
            <MobileNoteRow key={n.id} n={n} t={t}/>
          ))}
        </div>
      </div>
    </div>
  );
}

function MobileNoteRow({ n, t }) {
  return (
    <div style={{
      padding: '12px 14px', borderBottom: `0.5px solid ${t.edge}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
        <div style={{ fontSize: 15.5, fontWeight: 600, color: t.ink, flex: 1 }}>{n.title}</div>
        <div style={{ fontSize: 12, color: t.ink3 }}>{n.updated}</div>
      </div>
      <div style={{
        fontSize: 13, color: t.ink3, lineHeight: 1.45,
        display: '-webkit-box', WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>{n.preview}</div>
    </div>
  );
}

function MobileNoteEditor({ dark = false, showAI = false }) {
  const t = dark
    ? { bg: MEO.darkPaper, card: MEO.darkOverlay, ink: MEO.darkInk, ink2: MEO.darkInk2, ink3: MEO.darkInk3, edge: MEO.darkEdge }
    : { bg: MEO.paper, card: '#fff', ink: MEO.ink, ink2: MEO.ink2, ink3: MEO.ink3, edge: MEO.paperEdge };

  const note = NOTES[0];

  return (
    <div style={{
      width: '100%', minHeight: '100%', background: t.bg,
      fontFamily: MEO_FONT, display: 'flex', flexDirection: 'column',
    }}>
      {/* nav */}
      <div style={{ padding: '60px 16px 6px', display: 'flex', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: MEO.accent, fontSize: 15 }}>
          <Icon.Back size={16} stroke={MEO.accent}/> Work
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{ display: 'flex', gap: 14, color: t.ink2 }}>
          <Icon.Share size={18} stroke={t.ink2}/>
          <Icon.Dots size={18} stroke={t.ink2}/>
        </div>
      </div>

      {/* editor */}
      <div style={{ padding: '8px 22px 10px', flex: 1 }}>
        <NoteRenderer note={note} size="mobile" dark={dark}/>
      </div>

      {/* AI sheet */}
      {showAI && (
        <div style={{
          margin: '0 12px 12px', padding: 14, borderRadius: 18,
          background: dark ? 'rgba(180,99,42,0.12)' : MEO.aiSoft,
          border: `1px solid ${dark ? 'rgba(180,99,42,0.25)' : '#E8D0A8'}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Icon.Sparkle size={15} stroke={MEO.ai}/>
            <div style={{ fontSize: 13, fontWeight: 600, color: MEO.ai }}>Ask Meo</div>
            <div style={{ flex: 1 }}/>
            <div style={{ fontSize: 11, color: MEO.ai, padding: '2px 7px', borderRadius: 10, background: dark ? 'rgba(255,255,255,0.06)' : '#fff' }}>This note</div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {['Summarize', 'Action items', 'Rewrite tone', 'Find related'].map(s => (
              <div key={s} style={{
                fontSize: 13, color: t.ink, padding: '7px 11px', borderRadius: 20,
                background: dark ? 'rgba(255,255,255,0.08)' : '#fff',
                border: `1px solid ${dark ? 'rgba(255,255,255,0.1)' : '#E8D0A8'}`,
              }}>{s}</div>
            ))}
          </div>
          <div style={{
            height: 40, borderRadius: 12, background: dark ? 'rgba(0,0,0,0.3)' : '#fff',
            display: 'flex', alignItems: 'center', padding: '0 6px 0 14px', gap: 8,
          }}>
            <span style={{ flex: 1, fontSize: 14, color: t.ink3 }}>Ask anything…</span>
            <Icon.Mic size={17} stroke={t.ink3}/>
            <div style={{
              width: 30, height: 30, borderRadius: '50%', background: MEO.ai,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icon.ArrowUp size={14} stroke="#fff"/>
            </div>
          </div>
        </div>
      )}

      {/* bottom formatting bar */}
      {!showAI && (
        <div style={{
          borderTop: `1px solid ${t.edge}`, padding: '8px 12px',
          display: 'flex', gap: 14, alignItems: 'center',
          background: dark ? 'rgba(0,0,0,0.2)' : 'rgba(246,242,234,0.85)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}>
          <Icon.Sparkle size={19} stroke={MEO.ai}/>
          <div style={{ width: 1, height: 18, background: t.edge }}/>
          <Icon.Checklist size={19} stroke={t.ink2}/>
          <Icon.List size={19} stroke={t.ink2}/>
          <Icon.H1 size={19} stroke={t.ink2}/>
          <Icon.Bold size={19} stroke={t.ink2}/>
          <Icon.Italic size={19} stroke={t.ink2}/>
          <div style={{ flex: 1 }}/>
          <div style={{ fontSize: 13, fontWeight: 600, color: MEO.accent }}>Done</div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { MobileFolders, MobileNotesList, MobileNoteEditor });
