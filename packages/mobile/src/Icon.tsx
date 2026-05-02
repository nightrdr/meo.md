// Hand-drawn-feeling line icons for mobile. Mirrors
// packages/desktop/src/Icon.tsx and the design source.

import React from 'react';
import Svg, { Path, Rect, Circle } from 'react-native-svg';

interface IconProps {
  size?: number;
  stroke?: string;
  fill?: string;
  s?: number;
}

const I: React.FC<IconProps & { children: React.ReactNode }> = ({
  size = 18, stroke = '#1F1C17', fill = 'none', s = 1.6, children,
}) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
    {React.Children.map(children, child =>
      React.cloneElement(child as any, {
        stroke, strokeWidth: s, strokeLinecap: 'round', strokeLinejoin: 'round',
      })
    )}
  </Svg>
);

export const Icon = {
  Folder: (p: IconProps) => <I {...p}><Path d="M3 7c0-1.1.9-2 2-2h4l2 2h8c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H5a2 2 0 0 1-2-2V7z" /></I>,
  Note: (p: IconProps) => <I {...p}><Path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><Path d="M14 3v5h5" /><Path d="M9 13h6M9 17h4" /></I>,
  Search: (p: IconProps) => <I {...p}><Circle cx="11" cy="11" r="7" /><Path d="m20 20-4-4" /></I>,
  Plus: (p: IconProps) => <I {...p}><Path d="M12 5v14M5 12h14" /></I>,
  X: (p: IconProps) => <I {...p}><Path d="M6 6l12 12M18 6 6 18" /></I>,
  Sparkle: (p: IconProps) => <I {...p}><Path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /><Circle cx="12" cy="12" r="2.2" /></I>,
  Star: (p: IconProps) => <I {...p}><Path d="m12 3 2.7 5.8 6.3.6-4.8 4.3 1.4 6.3L12 16.8 6.4 20l1.4-6.3L3 9.4l6.3-.6L12 3z" /></I>,
  Pin: (p: IconProps) => <I {...p}><Path d="M12 2l2 4 4 1-3 3 1 5-4-2-4 2 1-5-3-3 4-1 2-4z" /></I>,
  Tag: (p: IconProps) => <I {...p}><Path d="M4 4h7l9 9-7 7-9-9V4z" /></I>,
  Check: (p: IconProps) => <I {...p}><Path d="M5 12.5 10 17 20 7" /></I>,
  Chevron: (p: IconProps) => <I {...p}><Path d="m9 6 6 6-6 6" /></I>,
  ChevronD: (p: IconProps) => <I {...p}><Path d="m6 9 6 6 6-6" /></I>,
  Back: (p: IconProps) => <I {...p}><Path d="m15 6-6 6 6 6" /></I>,
  Dots: (p: IconProps) => <I {...p}><Circle cx="5" cy="12" r="1.4" fill="currentColor" /><Circle cx="12" cy="12" r="1.4" fill="currentColor" /><Circle cx="19" cy="12" r="1.4" fill="currentColor" /></I>,
  Edit: (p: IconProps) => <I {...p}><Path d="M4 20h4l10-10-4-4L4 16v4z" /><Path d="m13 6 4 4" /></I>,
  Bold: (p: IconProps) => <I {...p}><Path d="M7 5h5a3 3 0 0 1 0 6H7zM7 11h6a3 3 0 0 1 0 6H7z" /></I>,
  Italic: (p: IconProps) => <I {...p}><Path d="M14 4h-4M14 20h-4M15 4l-6 16" /></I>,
  List: (p: IconProps) => <I {...p}><Path d="M9 6h12M9 12h12M9 18h12" /><Circle cx="4" cy="6" r="1" fill="currentColor" /><Circle cx="4" cy="12" r="1" fill="currentColor" /><Circle cx="4" cy="18" r="1" fill="currentColor" /></I>,
  Checklist: (p: IconProps) => <I {...p}><Path d="m3 6 2 2 3-3M3 13l2 2 3-3M3 20l2 2 3-3M12 7h10M12 14h10M12 21h6" /></I>,
  H1: (p: IconProps) => <I {...p}><Path d="M4 5v14M12 5v14M4 12h8M16 9l3-2v12" /></I>,
  Image: (p: IconProps) => <I {...p}><Rect x="3" y="4" width="18" height="16" rx="2" /><Circle cx="9" cy="10" r="1.5" /><Path d="m4 18 5-5 4 4 3-3 4 4" /></I>,
  Paperclip: (p: IconProps) => <I {...p}><Path d="m21 11-9 9a5.5 5.5 0 1 1-7.8-7.8L13 3.7a3.5 3.5 0 0 1 5 5L9.4 17.2a1.5 1.5 0 0 1-2.1-2.1L15 7.5" /></I>,
  Lock: (p: IconProps) => <I {...p}><Rect x="5" y="11" width="14" height="10" rx="2" /><Path d="M8 11V7a4 4 0 0 1 8 0v4" /></I>,
  Copy: (p: IconProps) => <I {...p}><Rect x="9" y="9" width="11" height="11" rx="2" /><Path d="M5 15V5a2 2 0 0 1 2-2h10" /></I>,
  ArrowUp: (p: IconProps) => <I {...p}><Path d="M12 19V5M6 11l6-6 6 6" /></I>,
  Mic: (p: IconProps) => <I {...p}><Rect x="9" y="3" width="6" height="12" rx="3" /><Path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></I>,
  Settings: (p: IconProps) => <I {...p}><Circle cx="12" cy="12" r="3" /><Path d="M12 3v3M12 18v3M21 12h-3M6 12H3M18.36 5.64l-2.12 2.12M7.76 16.24l-2.12 2.12M18.36 18.36l-2.12-2.12M7.76 7.76 5.64 5.64" /></I>,
  Eject: (p: IconProps) => <I {...p}><Path d="M12 4 4 14h16zM4 18h16" /></I>,
};

export const MeoMark: React.FC<{ size?: number; color?: string }> = ({ size = 22, color }) => (
  <Svg width={size} height={size} viewBox="0 0 28 28" fill="none">
    <Rect x="2" y="2" width="24" height="24" rx="7" fill={color || '#1F1C17'} />
    <Path d="M8 20V9l3 7h0l3-7v11" stroke="#F6F2EA" strokeWidth={2}
          fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <Circle cx="20" cy="20" r="1.7" fill="#4F6B3A" />
  </Svg>
);
