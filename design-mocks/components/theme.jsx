// Theme — Meo: warm paper-minimal aesthetic
// Distinctive color system: warm off-white "paper" bg, inky text, single
// mossy-green accent. NOT a copy of any existing notes app.

const MEO = {
  // surface
  paper:       '#F6F2EA',     // page bg (warm cream)
  paperDeep:   '#EDE7DA',     // raised cards, chips
  paperEdge:   '#E3DCCC',     // borders, dividers
  overlay:     '#FFFBF3',     // elevated panes
  sidebar:     '#EFE9DD',

  // ink
  ink:         '#1F1C17',     // primary
  ink2:        '#4A443B',     // secondary
  ink3:        '#8A8375',     // tertiary / muted
  ink4:        '#B8B0A0',     // placeholder

  // accent — single mossy green
  accent:      '#4F6B3A',
  accentSoft:  '#D9E0C7',
  accentInk:   '#2C3D1E',

  // highlighter / AI tint
  ai:          '#B4632A',     // rust
  aiSoft:      '#F4E2CB',

  // state
  red:         '#B04A3A',
  danger:      '#C4553F',

  // dark variant tokens (used when dark=true)
  darkPaper:   '#1B1915',
  darkSide:    '#16140F',
  darkInk:     '#EFE9DD',
  darkInk2:    '#B8B0A0',
  darkInk3:    '#7A7264',
  darkEdge:    '#2A2720',
  darkOverlay: '#221F19',
};

const MEO_FONT = '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
const MEO_SERIF = '"Source Serif 4", "Source Serif Pro", "Iowan Old Style", Georgia, serif';
const MEO_MONO  = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace';

Object.assign(window, { MEO, MEO_FONT, MEO_SERIF, MEO_MONO });
