import React, { useEffect, useRef } from 'react';
import { Icon } from './Icon';

export interface MenuItem {
  label: string;
  shortcut?: string;
  icon?: keyof typeof Icon;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  separator?: never;
}
export interface MenuSeparator { separator: true; }
export type MenuEntry = MenuItem | MenuSeparator;

interface Props {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer subscribing so the click that opened the menu doesn't close it
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('contextmenu', onDocClick);
    }, 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('contextmenu', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp to viewport so the menu doesn't overflow
  const vw = window.innerWidth, vh = window.innerHeight;
  const ESTIMATED_W = 240, ESTIMATED_H = items.length * 32 + 12;
  const left = Math.min(x, vw - ESTIMATED_W - 8);
  const top = Math.min(y, vh - ESTIMATED_H - 8);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if ('separator' in it) {
          return <div key={i} className="ctx-sep" />;
        }
        const IconComp = it.icon ? Icon[it.icon] : null;
        return (
          <button
            key={i}
            className={`ctx-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick?.();
              onClose();
            }}
          >
            <span className="ctx-icon">
              {IconComp ? <IconComp size={14} /> : null}
            </span>
            <span className="ctx-label">{it.label}</span>
            {it.shortcut && <span className="ctx-shortcut">{it.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}
