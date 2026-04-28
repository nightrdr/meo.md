// Full-featured markdown editor toolbar — modeled after the toolset in
// markdowneditoronline.com. NOT a copy — Meo's own visual language.
//
// Includes: undo/redo, headings menu, bold/italic/strike, link, image,
// quote, code/codeblock, lists (ul/ol/task), table, hr, indent/outdent,
// preview toggle.

function MarkdownToolbar({ t, dark, mode = 'edit' }) {
  const Group = ({ children }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>{children}</div>
  );
  const Sep = () => (
    <div style={{ width: 1, height: 18, background: t.edge, margin: '0 6px' }}/>
  );

  // small svgs not in icon set (kept inline so we don't bloat icons file)
  const HSel = () => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 3,
      padding: '0 7px', height: 26, borderRadius: 6,
      cursor: 'pointer', color: t.ink2, fontSize: 12, fontWeight: 600,
    }}>
      H<span style={{ fontSize: 9, opacity: 0.7 }}>1·6</span>
      <Icon.ChevronD size={9}/>
    </div>
  );
  const Strike = (p) => (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14"/><path d="M16 6c-.7-1.5-2.5-2-4.5-2-2.8 0-4.5 1.4-4.5 3.5 0 1.6 1 2.7 3 3.5"/><path d="M8 18c.6 1.5 2.5 2 4.5 2 3 0 4.5-1.4 4.5-3.5 0-1-.4-1.8-1-2.5"/>
    </svg>
  );
  const ImageI = () => (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 18 5-5 4 4 3-3 4 4"/>
    </svg>
  );
  const Table = () => (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 10h18M3 16h18M9 4v16M15 4v16"/>
    </svg>
  );
  const Hr = () => (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h18"/>
    </svg>
  );
  const Undo = () => (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7v6h6"/><path d="M21 17a8 8 0 0 0-15-4"/>
    </svg>
  );
  const Redo = () => (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 7v6h-6"/><path d="M3 17a8 8 0 0 1 15-4"/>
    </svg>
  );
  const Indent = () => (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M11 12h10M11 18h10M3 9l3 3-3 3"/>
    </svg>
  );
  const Outdent = () => (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M11 12h10M11 18h10M9 9l-3 3 3 3"/>
    </svg>
  );
  const CodeBlock = () => (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2"/><path d="m9 10-2 2 2 2M15 10l2 2-2 2"/>
    </svg>
  );

  const tb = (icon, label) => (
    <button title={label} style={iconBtnTb(t)}>{icon}</button>
  );

  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '6px 12px', gap: 0, flexWrap: 'wrap',
      borderBottom: `1px solid ${t.edge}`,
      background: dark ? 'rgba(255,255,255,0.02)' : 'rgba(31,28,23,0.02)',
    }}>
      <Group>
        {tb(<Undo/>, 'Undo  ⌘Z')}
        {tb(<Redo/>, 'Redo  ⇧⌘Z')}
      </Group>
      <Sep/>
      <Group>
        <button style={iconBtnTb(t)}><HSel/></button>
        {tb(<Icon.Bold size={14}/>, 'Bold  ⌘B')}
        {tb(<Icon.Italic size={14}/>, 'Italic  ⌘I')}
        {tb(<Strike/>, 'Strikethrough')}
      </Group>
      <Sep/>
      <Group>
        {tb(<Icon.Link size={14}/>, 'Link  ⌘K')}
        {tb(<ImageI/>, 'Image')}
        {tb(<Icon.Code size={14}/>, 'Inline code')}
        {tb(<CodeBlock/>, 'Code block')}
      </Group>
      <Sep/>
      <Group>
        {tb(<Icon.List size={14}/>, 'Bullet list')}
        {tb(<svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6h12M9 12h12M9 18h12"/><text x="2" y="8" fontSize="6" fill="currentColor" stroke="none">1.</text><text x="2" y="14" fontSize="6" fill="currentColor" stroke="none">2.</text><text x="2" y="20" fontSize="6" fill="currentColor" stroke="none">3.</text></svg>, 'Numbered list')}
        {tb(<Icon.Checklist size={14}/>, 'Task list')}
        {tb(<Outdent/>, 'Outdent')}
        {tb(<Indent/>, 'Indent')}
      </Group>
      <Sep/>
      <Group>
        {tb(<Icon.Quote size={14}/>, 'Blockquote')}
        {tb(<Hr/>, 'Horizontal rule')}
        {tb(<Table/>, 'Table')}
      </Group>
      <Sep/>
      <Group>
        <button style={{ ...iconBtnTb(t), color: MEO.ai }} title="AI actions  /">
          <Icon.Sparkle size={14}/>
        </button>
      </Group>

      <div style={{ flex: 1 }}/>

      {/* mode segmented control: Edit · Split · Preview */}
      <div style={{
        display: 'flex', borderRadius: 6, padding: 2, gap: 1,
        background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(31,28,23,0.06)',
      }}>
        {['Edit', 'Split', 'Preview'].map(m => (
          <div key={m} style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 11.5, fontWeight: 600,
            color: m === 'Split' ? t.ink : t.ink3,
            background: m === 'Split' ? (dark ? '#221F19' : '#fff') : 'transparent',
            boxShadow: m === 'Split' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
            cursor: 'pointer',
          }}>{m}</div>
        ))}
      </div>
    </div>
  );
}

function iconBtnTb(t) {
  return {
    width: 26, height: 26, borderRadius: 5,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: t.ink2,
  };
}

// Split-pane editor body — markdown source on left, live preview on right.
function SplitEditor({ t, dark, note }) {
  const md = sampleMarkdown(note);
  return (
    <div style={{
      flex: 1, display: 'flex', minHeight: 0, background: t.bg,
    }}>
      {/* source */}
      <div style={{
        flex: 1, overflow: 'auto', padding: '24px 28px 40px',
        borderRight: `1px solid ${t.edge}`,
        fontFamily: MEO_MONO, fontSize: 13, lineHeight: 1.6,
        color: t.ink, whiteSpace: 'pre-wrap',
        background: dark ? 'rgba(0,0,0,0.18)' : 'rgba(31,28,23,0.015)',
      }}>
        <MarkdownSource md={md} dark={dark}/>
      </div>
      {/* preview */}
      <div style={{
        flex: 1, overflow: 'auto', padding: '24px 36px 40px',
      }}>
        <div style={{ maxWidth: 600 }}>
          <NoteRenderer note={note} dark={dark}/>
        </div>
      </div>
    </div>
  );
}

function MarkdownSource({ md, dark }) {
  // very light syntax highlight
  const lines = md.split('\n');
  const c = dark
    ? { h: '#9DBE6E', b: '#D9A86A', em: '#C9C0B0', tag: '#7AA095', muted: '#7A7264' }
    : { h: '#3F5A2C', b: '#8E5424', em: '#1F1C17', tag: '#3D6962', muted: '#8A8375' };
  return (
    <>{lines.map((ln, i) => {
      let color = 'inherit', weight = 400;
      if (/^#{1,6}\s/.test(ln)) { color = c.h; weight = 700; }
      else if (/^>\s/.test(ln))  { color = c.muted; }
      else if (/^[-*]\s\[[ x]\]/.test(ln)) { color = c.tag; }
      else if (/^[-*]\s/.test(ln) || /^\d+\.\s/.test(ln)) { color = c.b; }
      else if (/^```/.test(ln)) { color = c.tag; }
      return (
        <div key={i} style={{ color, fontWeight: weight }}>
          {ln || '\u00a0'}
        </div>
      );
    })}</>
  );
}

function sampleMarkdown(note) {
  return `# ${note.title}

*Oct 14  ·  Apr Kaelin*

Three themes stood out this quarter. We shipped the long-delayed onboarding rewrite, we made a real dent in the notifications mess, and we started — finally — to treat **mobile** as a first-class surface.

## Shipped

- [x] Onboarding v2 — rolled to 100% on Tuesday
- [x] Settings refresh (desktop + web)
- [x] Notification preference audit
- [ ] Mobile editor parity — still 3 blockers

## In flight

Dashboard redesign goes to usability testing next week. I'm nervous about the density — we'll know on Thursday.

> Reminder: invite Priya to the Thursday session. Her notes from the pilot were what made this work.

## Links

- [→ Mobile editor tracker](#)
- [→ Dashboard research plan](#)
`;
}

Object.assign(window, { MarkdownToolbar, SplitEditor, MarkdownSource, sampleMarkdown });
