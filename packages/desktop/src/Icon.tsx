// Hand-drawn-feeling line icons matching design-mocks/components/icons.jsx.
// 1.6 stroke, rounded caps. No emoji, no Material/Lucide imports — kept inline.

import React from 'react';

interface IconProps {
  size?: number;
  s?: number;
  fill?: string;
  stroke?: string;
  className?: string;
  style?: React.CSSProperties;
}

const I = ({
  d, size = 18, s = 1.6, fill = 'none', stroke = 'currentColor', children, style, className,
}: IconProps & { d?: string; children?: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke}
       strokeWidth={s} strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
    {d ? <path d={d}/> : children}
  </svg>
);

export const Icon = {
  Folder: (p: IconProps) => <I {...p}><path d="M3 7c0-1.1.9-2 2-2h4l2 2h8c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H5a2 2 0 0 1-2-2V7z"/></I>,
  FolderOpen: (p: IconProps) => <I {...p}><path d="M3 7c0-1.1.9-2 2-2h4l2 2h8c1.1 0 2 .9 2 2v1"/><path d="M3 9l2.3 9c.2.6.8 1 1.4 1H19c.7 0 1.3-.4 1.5-1L22 11H5"/></I>,
  FolderPlus: (p: IconProps) => <I {...p}><path d="M3 7c0-1.1.9-2 2-2h4l2 2h8c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M12 11v6M9 14h6"/></I>,
  Note: (p: IconProps) => <I {...p}><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></I>,
  Search: (p: IconProps) => <I {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></I>,
  // Two independent strokes (instead of one path with two subpaths) —
  // more robust to engines that drop subpath joins, especially at small
  // rendered sizes where the 1.6 viewBox stroke gets sub-pixel scaling.
  Plus: (p: IconProps) => <I {...p}><path d="M12 5v14"/><path d="M5 12h14"/></I>,
  X: (p: IconProps) => <I {...p} d="M6 6l12 12M18 6 6 18"/>,
  Sparkle: (p: IconProps) => <I {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/><circle cx="12" cy="12" r="2.2"/></I>,
  Star: (p: IconProps) => <I {...p} d="m12 3 2.7 5.8 6.3.6-4.8 4.3 1.4 6.3L12 16.8 6.4 20l1.4-6.3L3 9.4l6.3-.6L12 3z"/>,
  Pin: (p: IconProps) => <I {...p}><path d="M12 2l2 4 4 1-3 3 1 5-4-2-4 2 1-5-3-3 4-1 2-4z" transform="rotate(30 12 12)"/></I>,
  Tag: (p: IconProps) => <I {...p}><path d="M4 4h7l9 9-7 7-9-9V4z"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/></I>,
  Check: (p: IconProps) => <I {...p} d="M5 12.5 10 17 20 7"/>,
  Chevron: (p: IconProps) => <I {...p} d="m9 6 6 6-6 6"/>,
  ChevronD: (p: IconProps) => <I {...p} d="m6 9 6 6 6-6"/>,
  Dots: (p: IconProps) => <I {...p}><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></I>,
  Edit: (p: IconProps) => <I {...p}><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="m13 6 4 4"/></I>,
  Bold: (p: IconProps) => <I {...p}><path d="M7 5h5a3 3 0 0 1 0 6H7zM7 11h6a3 3 0 0 1 0 6H7z"/></I>,
  Italic: (p: IconProps) => <I {...p} d="M14 4h-4M14 20h-4M15 4l-6 16"/>,
  Strike: (p: IconProps) => <I {...p}><path d="M5 12h14"/><path d="M16 6c-.7-1.5-2.5-2-4.5-2-2.8 0-4.5 1.4-4.5 3.5 0 1.6 1 2.7 3 3.5"/><path d="M8 18c.6 1.5 2.5 2 4.5 2 3 0 4.5-1.4 4.5-3.5 0-1-.4-1.8-1-2.5"/></I>,
  List: (p: IconProps) => <I {...p}><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/></I>,
  ListNumbered: (p: IconProps) => <I {...p}><path d="M9 6h12M9 12h12M9 18h12M3 6h2M4 6v3M3 12h3l-3 3h3M3 18h2v3"/></I>,
  Checklist: (p: IconProps) => <I {...p}><path d="m3 6 2 2 3-3M3 13l2 2 3-3M3 20l2 2 3-3M12 7h10M12 14h10M12 21h6"/></I>,
  Code: (p: IconProps) => <I {...p} d="m8 6-6 6 6 6M16 6l6 6-6 6M14 4l-4 16"/>,
  CodeBlock: (p: IconProps) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m9 10-2 2 2 2M15 10l2 2-2 2"/></I>,
  Link: (p: IconProps) => <I {...p}><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1"/></I>,
  Image: (p: IconProps) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 18 5-5 4 4 3-3 4 4"/></I>,
  Trash: (p: IconProps) => <I {...p}><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></I>,
  Command: (p: IconProps) => <I {...p}><path d="M8 6a2 2 0 1 0-2 2h12a2 2 0 1 0-2-2v12a2 2 0 1 0 2-2H6a2 2 0 1 0 2 2V6z"/></I>,
  Return: (p: IconProps) => <I {...p} d="M9 10h9a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-9m0-4-3-3m3 3-3 3"/>,
  Eject: (p: IconProps) => <I {...p}><path d="M12 4 4 14h16zM4 18h16"/></I>,
  Quote: (p: IconProps) => <I {...p} d="M7 7h4v4H7c0 3 1 4 3 5M15 7h4v4h-4c0 3 1 4 3 5"/>,
  H1: (p: IconProps) => <I {...p}><path d="M4 5v14M12 5v14M4 12h8M16 9l3-2v12"/></I>,
  Lock: (p: IconProps) => <I {...p}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></I>,
  Copy: (p: IconProps) => <I {...p}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></I>,
  Cloud: (p: IconProps) => <I {...p}><path d="M7 18a4 4 0 0 1-1-7.9A6 6 0 0 1 18 9.5 4 4 0 0 1 17 18z"/></I>,
  Undo: (p: IconProps) => <I {...p}><path d="M3 7v6h6"/><path d="M21 17a8 8 0 0 0-15-4"/></I>,
  Redo: (p: IconProps) => <I {...p}><path d="M21 7v6h-6"/><path d="M3 17a8 8 0 0 1 15-4"/></I>,
  Indent: (p: IconProps) => <I {...p}><path d="M3 6h18M11 12h10M11 18h10M3 9l3 3-3 3"/></I>,
  Outdent: (p: IconProps) => <I {...p}><path d="M3 6h18M11 12h10M11 18h10M9 9l-3 3 3 3"/></I>,
  Table: (p: IconProps) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 10h18M3 16h18M9 4v16M15 4v16"/></I>,
  Hr: (p: IconProps) => <I {...p}><path d="M3 12h18"/></I>,
  Warning: (p: IconProps) => <I {...p}><path d="M12 2 1 21h22L12 2zM12 9v5M12 17.5v.5"/></I>,
  Sun: (p: IconProps) => <I {...p}><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></I>,
  Moon: (p: IconProps) => <I {...p} d="M20 14.5A8 8 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>,
  Settings: (p: IconProps) => <I {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></I>,
  // Spell-check / proofread: an "Aa" with a tick underneath
  Spell: (p: IconProps) => <I {...p}><path d="M3 17 7 7l4 10M4.5 13.5h5"/><path d="m13 16 2.5 2 4-5"/></I>,
  // Sidebar: a rounded rectangle with a vertical divider near the left,
  // matching the macOS Notes show/hide-sidebar glyph.
  Sidebar: (p: IconProps) => <I {...p}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14"/></I>,
  // Summary: lines with a star representing distilled text
  Summary: (p: IconProps) => <I {...p}><path d="M4 8h12M4 12h10M4 16h7"/><path d="m18 14 1.2 2.5L22 17l-2 1.7.5 2.6-2.5-1.4-2.5 1.4.5-2.6L14 17l2.8-.5L18 14z"/></I>,
};

// Logo mark — Meo: a filleted-square "M" notch in warm ink with a green accent dot
export const MeoMark: React.FC<{ size?: number; color?: string }> = ({ size = 22, color }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
    <rect x="2" y="2" width="24" height="24" rx="7" fill={color || '#1F1C17'}/>
    <path d="M8 20V9l3 7h0l3-7v11" stroke="#F6F2EA" strokeWidth="2"
          fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="20" cy="20" r="1.7" fill="#4F6B3A"/>
  </svg>
);
