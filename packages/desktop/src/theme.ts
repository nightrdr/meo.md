// meo.md theme — warm paper-minimal palette from the design mocks.
// Mirrors design-mocks/components/theme.jsx (the source of truth).

export const MEO = {
  // surface
  paper:       '#F6F2EA',
  paperDeep:   '#EDE7DA',
  paperEdge:   '#E3DCCC',
  overlay:     '#FFFBF3',
  sidebar:     '#EFE9DD',

  // ink
  ink:         '#1F1C17',
  ink2:        '#4A443B',
  ink3:        '#8A8375',
  ink4:        '#B8B0A0',

  // accent — single mossy green
  accent:      '#4F6B3A',
  accentSoft:  '#D9E0C7',
  accentInk:   '#2C3D1E',

  // AI tint — rust
  ai:          '#B4632A',
  aiSoft:      '#F4E2CB',

  // state
  red:         '#B04A3A',
  danger:      '#C4553F',

  // dark variant
  darkPaper:   '#1B1915',
  darkSide:    '#16140F',
  darkInk:     '#EFE9DD',
  darkInk2:    '#B8B0A0',
  darkInk3:    '#7A7264',
  darkEdge:    '#2A2720',
  darkOverlay: '#221F19',
} as const;

export const FONT_SANS = '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
export const FONT_SERIF = '"Source Serif 4", "Source Serif Pro", "Iowan Old Style", Georgia, serif';
export const FONT_MONO = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace';
