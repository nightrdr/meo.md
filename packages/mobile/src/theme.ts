// Meo design tokens for mobile. Mirrors design-mocks/components/theme.jsx
// and packages/desktop/src/theme.ts. Used by every screen.

import { Platform } from 'react-native';

export const MEO = {
  paper:       '#F6F2EA',
  paperDeep:   '#EDE7DA',
  paperEdge:   '#E3DCCC',
  overlay:     '#FFFBF3',
  sidebar:     '#EFE9DD',
  card:        '#FFFFFF',

  ink:         '#1F1C17',
  ink2:        '#4A443B',
  ink3:        '#8A8375',
  ink4:        '#B8B0A0',

  accent:      '#4F6B3A',
  accentSoft:  '#D9E0C7',
  accentInk:   '#2C3D1E',

  ai:          '#B4632A',
  aiSoft:      '#F4E2CB',

  red:         '#B04A3A',
  danger:      '#C4553F',

  darkPaper:   '#1B1915',
  darkSide:    '#16140F',
  darkInk:     '#EFE9DD',
  darkInk2:    '#B8B0A0',
  darkInk3:    '#7A7264',
  darkEdge:    '#2A2720',
  darkOverlay: '#221F19',
} as const;

// Mobile uses system fonts. The serif family is "Source Serif" or
// "Iowan Old Style" on iOS (both shipped) and the system serif on Android
// (falling back to monospace if the user disabled it).
export const FONT_SANS = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default: 'System',
})!;

export const FONT_SERIF = Platform.select({
  ios: 'Iowan Old Style',
  android: 'serif',
  default: 'serif',
})!;

export const FONT_MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
})!;

// Helper: hex + alpha-percent → rgba string
export function alpha(hex: string, a: number): string {
  // hex = #RRGGBB
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${a})`;
}
