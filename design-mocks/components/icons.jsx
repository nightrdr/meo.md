// Meo icons — hand-drawn-feeling line icons, 1.6 stroke, rounded caps.
// Deliberately simple: folder, search, plus, sparkle, etc. No emoji.

const I = ({ d, size = 18, s = 1.6, fill = 'none', stroke = 'currentColor', children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}
       stroke={stroke} strokeWidth={s} strokeLinecap="round" strokeLinejoin="round">
    {d ? <path d={d}/> : children}
  </svg>
);

const Icon = {
  Folder:   (p) => <I {...p}><path d="M3 7c0-1.1.9-2 2-2h4l2 2h8c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H5a2 2 0 0 1-2-2V7z"/></I>,
  FolderOpen:(p) => <I {...p}><path d="M3 7c0-1.1.9-2 2-2h4l2 2h8c1.1 0 2 .9 2 2v1"/><path d="M3 9l2.3 9c.2.6.8 1 1.4 1H19c.7 0 1.3-.4 1.5-1L22 11H5"/></I>,
  Note:     (p) => <I {...p}><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></I>,
  Search:   (p) => <I {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></I>,
  Plus:     (p) => <I {...p} d="M12 5v14M5 12h14"/>,
  Sparkle:  (p) => <I {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/><circle cx="12" cy="12" r="2.2"/></I>,
  Star:     (p) => <I {...p} d="m12 3 2.7 5.8 6.3.6-4.8 4.3 1.4 6.3L12 16.8 6.4 20l1.4-6.3L3 9.4l6.3-.6L12 3z"/>,
  Pin:      (p) => <I {...p}><path d="M12 2l2 4 4 1-3 3 1 5-4-2-4 2 1-5-3-3 4-1 2-4z" transform="rotate(30 12 12)"/></I>,
  Tag:      (p) => <I {...p}><path d="M4 4h7l9 9-7 7-9-9V4z"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/></I>,
  Check:    (p) => <I {...p} d="M5 12.5 10 17 20 7"/>,
  Chevron:  (p) => <I {...p} d="m9 6 6 6-6 6"/>,
  ChevronD: (p) => <I {...p} d="m6 9 6 6 6-6"/>,
  Dots:     (p) => <I {...p}><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></I>,
  Edit:     (p) => <I {...p}><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="m13 6 4 4"/></I>,
  Bold:     (p) => <I {...p}><path d="M7 5h5a3 3 0 0 1 0 6H7zM7 11h6a3 3 0 0 1 0 6H7z"/></I>,
  Italic:   (p) => <I {...p} d="M14 4h-4M14 20h-4M15 4l-6 16"/>,
  List:     (p) => <I {...p}><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/></I>,
  Checklist:(p) => <I {...p}><path d="m3 6 2 2 3-3M3 13l2 2 3-3M3 20l2 2 3-3M12 7h10M12 14h10M12 21h6"/></I>,
  Code:     (p) => <I {...p} d="m8 6-6 6 6 6M16 6l6 6-6 6M14 4l-4 16"/>,
  Link:     (p) => <I {...p}><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1"/></I>,
  Trash:    (p) => <I {...p}><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></I>,
  Command:  (p) => <I {...p}><path d="M8 6a2 2 0 1 0-2 2h12a2 2 0 1 0-2-2v12a2 2 0 1 0 2-2H6a2 2 0 1 0 2 2V6z"/></I>,
  Return:   (p) => <I {...p} d="M9 10h9a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-9m0-4-3-3m3 3-3 3"/>,
  Sun:      (p) => <I {...p}><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></I>,
  Moon:     (p) => <I {...p} d="M20 14.5A8 8 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>,
  Mic:      (p) => <I {...p}><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></I>,
  ArrowUp:  (p) => <I {...p} d="M12 19V5M6 11l6-6 6 6"/>,
  Back:     (p) => <I {...p} d="m15 6-6 6 6 6"/>,
  Share:    (p) => <I {...p}><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></I>,
  Grip:     (p) => <I {...p}><circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/></I>,
  Sidebar:  (p) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></I>,
  Quote:    (p) => <I {...p} d="M7 7h4v4H7c0 3 1 4 3 5M15 7h4v4h-4c0 3 1 4 3 5"/>,
  H1:       (p) => <I {...p}><path d="M4 5v14M12 5v14M4 12h8M16 9l3-2v12"/></I>,
};

// Logo mark — Meo: a filleted-square "M" notch in warm ink
const MeoMark = ({ size = 22, color }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
    <rect x="2" y="2" width="24" height="24" rx="7"
          fill={color || '#1F1C17'}/>
    <path d="M8 20V9l3 7h0l3-7v11" stroke="#F6F2EA" strokeWidth="2"
          fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="20" cy="20" r="1.7" fill="#4F6B3A"/>
  </svg>
);

Object.assign(window, { Icon, MeoMark });
