// Desktop — Meo 3-pane app (folders | notes list | editor)
// Original design: warm paper palette, serif body, sans UI, mossy accent.
// Includes: folder tree, notes list, note editor, ⌘K search overlay,
// AI slash menu and side panel.

function DesktopApp({
  dark = false,
  density = 'balanced',       // compact | balanced | airy
  aiMode = 'slash',           // slash | panel | both
  searchOpen = false,
  aiPanelOpen = false,
  selectedNoteId = 'n1',
  selectedFolder = 'work',
  aiOn = true,
  model = 'meo-mini',
  modelDropdownOpen = false,
  editorMode = 'wysiwyg',     // wysiwyg | split
  onOpenSearch,
  onOpenAI,
  onToggleAI = () => {},
  onOpenModelDropdown = () => {},
  onOpenDownloads = () => {},
}) {
  const t = dark
    ? { bg: MEO.darkPaper, side: MEO.darkSide, edge: MEO.darkEdge,
        ink: MEO.darkInk, ink2: MEO.darkInk2, ink3: MEO.darkInk3,
        overlay: MEO.darkOverlay, hover: 'rgba(255,255,255,0.04)',
        rowSel: 'rgba(79,107,58,0.25)', chip: '#2A2720' }
    : { bg: MEO.paper, side: MEO.sidebar, edge: MEO.paperEdge,
        ink: MEO.ink, ink2: MEO.ink2, ink3: MEO.ink3,
        overlay: MEO.overlay, hover: 'rgba(31,28,23,0.04)',
        rowSel: 'rgba(79,107,58,0.14)', chip: MEO.paperDeep };

  const rowH  = density === 'compact' ? 26 : density === 'airy' ? 34 : 30;
  const noteRowP = density === 'compact' ? '10px 14px' : density === 'airy' ? '16px 16px' : '13px 16px';

  const note = NOTES.find(n => n.id === selectedNoteId) || NOTES[0];
  const folderNotes = NOTES.filter(n =>
    selectedFolder === 'all' ? true :
    selectedFolder === 'pinned' ? n.pinned :
    selectedFolder === 'recent' ? true :
    n.folder === selectedFolder
  );

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex',
      background: t.bg, color: t.ink, fontFamily: MEO_FONT,
      position: 'relative',
    }}>
      {/* ─────── Sidebar ─────── */}
      <div style={{
        width: 232, background: t.side, flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        borderRight: `1px solid ${t.edge}`,
      }}>
        {/* traffic lights row */}
        <div style={{
          height: 44, display: 'flex', alignItems: 'center',
          padding: '0 14px', gap: 8,
        }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#E46F65', border: '0.5px solid rgba(0,0,0,0.08)' }}/>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#E5B137', border: '0.5px solid rgba(0,0,0,0.08)' }}/>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#5EB25C', border: '0.5px solid rgba(0,0,0,0.08)' }}/>
          </div>
        </div>

        {/* brand */}
        <div style={{
          padding: '4px 18px 14px', display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <MeoMark size={24}/>
          <span style={{ fontFamily: MEO_SERIF, fontSize: 19, fontWeight: 600, letterSpacing: -0.3, color: t.ink }}>
            Meo
          </span>
          <div style={{ flex: 1 }}/>
          <button style={iconBtn(t)}><Icon.Edit size={15}/></button>
        </div>

        {/* search button */}
        <div style={{ padding: '0 12px 10px' }}>
          <button onClick={onOpenSearch} style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 10px', borderRadius: 8,
            background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(31,28,23,0.05)',
            border: 'none', cursor: 'pointer', color: t.ink3,
            fontFamily: MEO_FONT, fontSize: 13,
          }}>
            <Icon.Search size={14}/>
            <span style={{ flex: 1, textAlign: 'left' }}>Search</span>
            <kbd style={kbdStyle(t)}>⌘K</kbd>
          </button>
        </div>

        {/* system folders */}
        <div style={{ padding: '0 8px' }}>
          {FOLDERS.map(f => (
            <SidebarRow key={f.id} t={t} rowH={rowH}
              label={f.name} count={f.count} icon={f.icon}
              selected={selectedFolder === f.id}/>
          ))}
        </div>

        {/* section header */}
        <SectionHeader t={t}>Folders</SectionHeader>

        <div style={{ padding: '0 8px', flex: 1, overflow: 'auto' }}>
          {USER_FOLDERS.map(f => (
            <React.Fragment key={f.id}>
              <SidebarRow t={t} rowH={rowH}
                label={f.name} count={f.count} icon="Folder"
                selected={selectedFolder === f.id}
                expandable={!!f.children} expanded={f.id === 'work'}/>
              {f.children && f.id === 'work' && f.children.map(c => (
                <SidebarRow key={c.id} t={t} rowH={rowH}
                  label={c.name} count={c.count} icon="Folder" indent={1}/>
              ))}
            </React.Fragment>
          ))}

          <SectionHeader t={t}>Tags</SectionHeader>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '2px 8px 8px' }}>
            {TAGS.map(tg => (
              <div key={tg} style={{
                fontSize: 11, fontWeight: 500, color: t.ink2,
                padding: '3px 8px', borderRadius: 4,
                background: t.chip, fontFamily: MEO_MONO,
              }}>#{tg}</div>
            ))}
          </div>
        </div>

        {/* footer — AI controls (switch + model dropdown) */}
        <AIControls
          t={t} dark={dark}
          aiOn={aiOn} model={model}
          dropdownOpen={modelDropdownOpen}
          onToggle={onToggleAI}
          onOpenDropdown={onOpenModelDropdown}
          onOpenDownloads={onOpenDownloads}/>
      </div>

      {/* ─────── Notes list ─────── */}
      <div style={{
        width: 300, flexShrink: 0, background: t.bg,
        borderRight: `1px solid ${t.edge}`,
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          height: 44, display: 'flex', alignItems: 'center',
          padding: '0 16px', gap: 8,
          borderBottom: `1px solid ${t.edge}`,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: t.ink, textTransform: 'capitalize' }}>
            {selectedFolder === 'all' ? 'All notes' : selectedFolder === 'pinned' ? 'Pinned' : selectedFolder}
          </div>
          <div style={{ flex: 1 }}/>
          <div style={{ fontSize: 11, color: t.ink3 }}>{folderNotes.length} notes</div>
          <button style={iconBtn(t)}><Icon.Plus size={14}/></button>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {folderNotes.map((n, i) => (
            <div key={n.id} style={{
              padding: noteRowP,
              borderBottom: `1px solid ${t.edge}`,
              background: n.id === selectedNoteId ? t.rowSel : 'transparent',
              cursor: 'pointer', position: 'relative',
            }}>
              {n.id === selectedNoteId && (
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
                  background: MEO.accent,
                }}/>
              )}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                marginBottom: 3,
              }}>
                {n.pinned && <Icon.Pin size={10} stroke={MEO.ai}/>}
                <div style={{
                  fontSize: 13.5, fontWeight: 600, color: t.ink,
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{n.title}</div>
                <div style={{ fontSize: 10.5, color: t.ink3, fontWeight: 500 }}>{n.updated}</div>
              </div>
              <div style={{
                fontSize: 12, color: t.ink3, lineHeight: 1.45,
                display: '-webkit-box', WebkitLineClamp: density === 'compact' ? 1 : 2,
                WebkitBoxOrient: 'vertical', overflow: 'hidden',
                marginBottom: density === 'compact' ? 0 : 4,
              }}>{n.preview}</div>
              {density !== 'compact' && n.tags && (
                <div style={{ display: 'flex', gap: 4 }}>
                  {n.tags.slice(0,2).map(tg => (
                    <div key={tg} style={{
                      fontSize: 10, color: t.ink3, fontFamily: MEO_MONO,
                    }}>#{tg}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ─────── Editor ─────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* breadcrumb / title bar */}
        <div style={{
          height: 40, display: 'flex', alignItems: 'center',
          padding: '0 16px', gap: 6,
          borderBottom: `1px solid ${t.edge}`,
        }}>
          <div style={{ fontSize: 12, color: t.ink3, fontWeight: 500 }}>
            Work <span style={{ margin: '0 6px', opacity: 0.5 }}>›</span>
            <span style={{ color: t.ink2, fontWeight: 600 }}>{note.title}</span>
          </div>
          <div style={{ flex: 1 }}/>
          <button style={iconBtn(t)}><Icon.Share size={14}/></button>
          <button style={iconBtn(t)}><Icon.Dots size={14}/></button>
        </div>

        {/* full markdown toolbar */}
        <MarkdownToolbar t={t} dark={dark} mode={editorMode}/>

        {/* editor canvas — split view (markdown + preview) */}
        {editorMode === 'split' ? (
          <SplitEditor t={t} dark={dark} note={note}/>
        ) : (
          <div style={{
            flex: 1, overflow: 'auto', padding: '40px 64px 64px',
            background: t.bg, position: 'relative',
          }}>
            <div style={{ maxWidth: 680, margin: '0 auto', position: 'relative' }}>
              <NoteRenderer note={note} dark={dark}/>

              {(aiMode === 'slash' || aiMode === 'both') && aiOn && !searchOpen && !aiPanelOpen && (
                <SlashMenu t={t} dark={dark}/>
              )}
            </div>
          </div>
        )}

        {/* bottom status */}
        <div style={{
          height: 28, borderTop: `1px solid ${t.edge}`,
          display: 'flex', alignItems: 'center', padding: '0 16px',
          fontSize: 11, color: t.ink3, gap: 16,
        }}>
          <span>412 words</span>
          <span>Saved just now</span>
          <div style={{ flex: 1 }}/>
          <span>Markdown</span>
        </div>
      </div>

      {/* ─────── AI side panel ─────── */}
      {(aiMode === 'panel' || aiMode === 'both') && aiPanelOpen && (
        <AIPanel t={t} dark={dark}/>
      )}

      {/* ─────── ⌘K search overlay ─────── */}
      {searchOpen && <SearchOverlay t={t} dark={dark}/>}
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────

function SectionHeader({ t, children }) {
  return (
    <div style={{
      padding: '16px 18px 6px', fontSize: 10.5, fontWeight: 600,
      color: t.ink3, textTransform: 'uppercase', letterSpacing: 0.8,
    }}>{children}</div>
  );
}

function SidebarRow({ t, rowH, label, count, icon, selected, indent = 0, expandable, expanded }) {
  const IconComp = Icon[icon] || Icon.Folder;
  return (
    <div style={{
      height: rowH, display: 'flex', alignItems: 'center', gap: 8,
      padding: `0 10px 0 ${10 + indent * 16}px`,
      borderRadius: 6,
      background: selected ? (t.chip === MEO.paperDeep ? 'rgba(31,28,23,0.07)' : 'rgba(255,255,255,0.06)') : 'transparent',
      color: selected ? t.ink : t.ink2,
      fontSize: 13, fontWeight: selected ? 600 : 500,
      cursor: 'pointer', marginBottom: 1,
    }}>
      {expandable ? (
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .1s', opacity: 0.6 }}>
          <path d="m3 2 4 3-4 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ) : <div style={{ width: 10 }}/>}
      <IconComp size={14} stroke={selected ? MEO.accent : 'currentColor'}/>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {count !== undefined && <span style={{ fontSize: 11, color: t.ink3, fontWeight: 500 }}>{count}</span>}
    </div>
  );
}

function iconBtn(t) {
  return {
    width: 26, height: 26, borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: t.ink2,
  };
}

function kbdStyle(t) {
  return {
    fontFamily: MEO_MONO, fontSize: 10.5, color: t.ink3,
    padding: '1px 5px', borderRadius: 3,
    background: t.chip === MEO.paperDeep ? 'rgba(31,28,23,0.06)' : 'rgba(255,255,255,0.06)',
    border: `0.5px solid ${t.edge}`,
  };
}

// ─── Slash menu (inline AI) ──────────────────────────────────────────────

function SlashMenu({ t, dark }) {
  const items = [
    { icon: 'Sparkle', label: 'Summarize this note', hint: 'Abstract in 3 sentences' },
    { icon: 'Edit',    label: 'Improve writing',     hint: 'Clarity + flow' },
    { icon: 'List',    label: 'Turn into outline',   hint: 'Headings + bullets' },
    { icon: 'Checklist', label: 'Extract action items', hint: 'As a checklist' },
    { icon: 'Link',    label: 'Find related notes',  hint: 'Across your workspace' },
    { icon: 'Quote',   label: 'Change tone',         hint: 'Formal, casual, playful…' },
  ];
  return (
    <div style={{
      position: 'absolute', top: 280, left: 0, width: 340,
      background: t.overlay, borderRadius: 10,
      boxShadow: '0 18px 56px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)',
      border: `1px solid ${t.edge}`,
      overflow: 'hidden', fontFamily: MEO_FONT,
    }}>
      <div style={{
        padding: '8px 12px', fontSize: 11, color: t.ink3, fontWeight: 500,
        borderBottom: `1px solid ${t.edge}`, display: 'flex', gap: 6, alignItems: 'center',
      }}>
        <Icon.Sparkle size={11} stroke={MEO.ai}/>
        <span style={{ color: MEO.ai, fontWeight: 600 }}>AI actions</span>
        <div style={{ flex: 1 }}/>
        <span style={{ fontFamily: MEO_MONO }}>/</span>
      </div>
      {items.map((it, i) => {
        const IconComp = Icon[it.icon];
        return (
          <div key={i} style={{
            padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 10,
            background: i === 0 ? (dark ? 'rgba(180,99,42,0.14)' : MEO.aiSoft) : 'transparent',
            cursor: 'pointer',
          }}>
            <div style={{
              width: 24, height: 24, borderRadius: 5,
              background: dark ? 'rgba(180,99,42,0.2)' : '#F4E2CB',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: MEO.ai,
            }}>
              <IconComp size={12}/>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: t.ink }}>{it.label}</div>
              <div style={{ fontSize: 11, color: t.ink3, marginTop: 1 }}>{it.hint}</div>
            </div>
            {i === 0 && <Icon.Return size={12} stroke={t.ink3}/>}
          </div>
        );
      })}
    </div>
  );
}

// ─── AI panel (right-side drawer) ─────────────────────────────────────────

function AIPanel({ t, dark }) {
  return (
    <div style={{
      width: 340, background: t.overlay,
      borderLeft: `1px solid ${t.edge}`,
      display: 'flex', flexDirection: 'column',
      fontFamily: MEO_FONT,
    }}>
      <div style={{
        height: 44, borderBottom: `1px solid ${t.edge}`,
        display: 'flex', alignItems: 'center', padding: '0 16px', gap: 8,
      }}>
        <Icon.Sparkle size={14} stroke={MEO.ai}/>
        <span style={{ fontSize: 13, fontWeight: 600, color: t.ink }}>Ask Meo</span>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 10, color: t.ink3, padding: '2px 6px', borderRadius: 3, background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(31,28,23,0.05)' }}>
          Scope: this note
        </span>
      </div>

      <div style={{ flex: 1, padding: '16px', overflow: 'auto' }}>
        <div style={{
          fontSize: 11, color: t.ink3, textTransform: 'uppercase',
          letterSpacing: 0.6, marginBottom: 10, fontWeight: 600,
        }}>Suggested</div>
        {[
          { icon: 'Sparkle', label: 'Summarize' },
          { icon: 'Checklist', label: 'Extract action items' },
          { icon: 'Link', label: 'Find 3 related notes' },
        ].map((s, i) => {
          const IconComp = Icon[s.icon];
          return (
            <div key={i} style={{
              padding: '10px 12px', borderRadius: 8,
              background: dark ? 'rgba(255,255,255,0.03)' : 'rgba(31,28,23,0.03)',
              marginBottom: 6, display: 'flex', gap: 9, alignItems: 'center',
              fontSize: 13, color: t.ink, cursor: 'pointer',
            }}>
              <IconComp size={13} stroke={MEO.ai}/>
              {s.label}
            </div>
          );
        })}

        <div style={{
          fontSize: 11, color: t.ink3, textTransform: 'uppercase',
          letterSpacing: 0.6, margin: '20px 0 10px', fontWeight: 600,
        }}>Conversation</div>

        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: dark ? 'rgba(31,28,23,0.4)' : MEO.paperDeep,
          marginBottom: 8, fontSize: 12.5, color: t.ink2,
          alignSelf: 'flex-end', marginLeft: 40,
        }}>Summarize this note for Priya.</div>

        <div style={{
          padding: '12px 14px', borderRadius: 8,
          background: dark ? 'rgba(180,99,42,0.10)' : MEO.aiSoft,
          fontSize: 13, color: t.ink, lineHeight: 1.55,
          marginRight: 20, fontFamily: MEO_SERIF,
        }}>
          Q3 was anchored by three shipped bets — onboarding v2, the settings refresh, and a cleaner notifications story. Dashboard redesign is the big Q4 lift; usability testing lands Thursday with Priya joining.
          <div style={{ display: 'flex', gap: 6, marginTop: 10, fontFamily: MEO_FONT }}>
            <span style={chipStyle(t)}>Insert</span>
            <span style={chipStyle(t)}>Copy</span>
            <span style={chipStyle(t)}>Rewrite</span>
          </div>
        </div>
      </div>

      <div style={{
        padding: 12, borderTop: `1px solid ${t.edge}`,
      }}>
        <div style={{
          background: dark ? 'rgba(255,255,255,0.04)' : '#fff',
          border: `1px solid ${t.edge}`, borderRadius: 10,
          padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <input placeholder="Ask about this note…" style={{
            flex: 1, border: 'none', outline: 'none', background: 'transparent',
            fontFamily: MEO_FONT, fontSize: 13, color: t.ink,
          }}/>
          <div style={{
            width: 26, height: 26, borderRadius: '50%',
            background: MEO.ai, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon.ArrowUp size={12} stroke="#fff"/>
          </div>
        </div>
      </div>
    </div>
  );
}

function chipStyle(t) {
  return {
    fontSize: 11, padding: '3px 8px', borderRadius: 4,
    background: 'rgba(31,28,23,0.06)', color: t.ink2,
    cursor: 'pointer', fontWeight: 500,
  };
}

// ─── ⌘K search overlay ───────────────────────────────────────────────────

function SearchOverlay({ t, dark }) {
  const results = [
    { type: 'ai', q: 'Who is joining Thursday research?', ans: 'Priya. You flagged her pilot notes as the reason to invite her.' },
    { type: 'note', title: 'Thursday research session — script', folder: 'Work', snip: '…Priya joining. Six participants for 45 minutes…' },
    { type: 'note', title: 'Q3 review — design team', folder: 'Work', snip: '…invite Priya to the Thursday session…' },
    { type: 'folder', title: 'Work / Reviews', count: 1 },
    { type: 'tag', title: '#research', count: 1 },
  ];
  return (
    <div style={{
      position: 'absolute', inset: 0, background: dark ? 'rgba(0,0,0,0.5)' : 'rgba(31,28,23,0.22)',
      backdropFilter: 'blur(2px)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
      paddingTop: 84, zIndex: 100,
    }}>
      <div style={{
        width: 620, background: t.overlay, borderRadius: 14,
        boxShadow: '0 24px 80px rgba(0,0,0,0.3)',
        border: `1px solid ${t.edge}`, overflow: 'hidden',
      }}>
        <div style={{
          padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12,
          borderBottom: `1px solid ${t.edge}`,
        }}>
          <Icon.Search size={16} stroke={t.ink3}/>
          <div style={{ flex: 1, fontSize: 16, color: t.ink, fontFamily: MEO_FONT }}>
            Thursday research<span style={{
              display: 'inline-block', width: 1.5, height: 16, background: MEO.accent,
              verticalAlign: 'middle', marginLeft: 2, animation: 'meo-caret 1s steps(2) infinite',
            }}/>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <span style={kbdStyle(t)}>esc</span>
          </div>
        </div>

        {/* AI answer */}
        <div style={{
          padding: '14px 18px', display: 'flex', gap: 12,
          background: dark ? 'rgba(180,99,42,0.07)' : MEO.aiSoft,
          borderBottom: `1px solid ${t.edge}`,
        }}>
          <div style={{
            width: 26, height: 26, borderRadius: 6, flexShrink: 0,
            background: MEO.ai, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon.Sparkle size={14} stroke="#fff"/>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: MEO.ai, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 }}>
              Answer from your notes
            </div>
            <div style={{ fontSize: 14, color: t.ink, lineHeight: 1.5, fontFamily: MEO_SERIF }}>
              <b>Priya</b> is joining the Thursday session. Your Q3 review note flags it as the reason to invite her.
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <span style={{ ...chipStyle(t), background: 'rgba(180,99,42,0.15)', color: MEO.ai }}>Q3 review</span>
              <span style={{ ...chipStyle(t), background: 'rgba(180,99,42,0.15)', color: MEO.ai }}>Research script</span>
            </div>
          </div>
        </div>

        {/* section header */}
        <div style={{ padding: '10px 18px 4px', fontSize: 10.5, fontWeight: 600, color: t.ink3, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Notes
        </div>
        {results.filter(r => r.type === 'note').map((r, i) => (
          <div key={i} style={{
            padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 12,
            background: i === 0 ? (dark ? 'rgba(79,107,58,0.18)' : 'rgba(79,107,58,0.08)') : 'transparent',
          }}>
            <Icon.Note size={15} stroke={t.ink3}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: t.ink }}>{r.title}</div>
              <div style={{ fontSize: 12, color: t.ink3, marginTop: 1 }}>{r.snip}</div>
            </div>
            <div style={{ fontSize: 11, color: t.ink3 }}>{r.folder}</div>
            {i === 0 && <Icon.Return size={12} stroke={t.ink3}/>}
          </div>
        ))}

        <div style={{ padding: '10px 18px 4px', fontSize: 10.5, fontWeight: 600, color: t.ink3, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Folders & Tags
        </div>
        <div style={{ padding: '8px 18px 14px', display: 'flex', gap: 6 }}>
          <span style={{ ...chipStyle(t), fontSize: 12, padding: '4px 9px' }}>📁 Work / Reviews</span>
          <span style={{ ...chipStyle(t), fontSize: 12, padding: '4px 9px', fontFamily: MEO_MONO }}>#research</span>
        </div>

        <div style={{
          padding: '10px 18px', borderTop: `1px solid ${t.edge}`,
          display: 'flex', alignItems: 'center', gap: 14,
          fontSize: 11, color: t.ink3, background: dark ? 'rgba(255,255,255,0.02)' : 'rgba(31,28,23,0.02)',
        }}>
          <span><span style={kbdStyle(t)}>↑↓</span> Navigate</span>
          <span><span style={kbdStyle(t)}>↵</span> Open</span>
          <span><span style={kbdStyle(t)}>⌘↵</span> Ask Meo</span>
          <div style={{ flex: 1 }}/>
          <span>Powered by Meo AI</span>
        </div>
      </div>

      <style>{`@keyframes meo-caret { 50% { opacity: 0; } }`}</style>
    </div>
  );
}

Object.assign(window, { DesktopApp });
