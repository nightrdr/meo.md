import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface MenuItem {
  label: string;
  shortcut?: string;
  icon?: keyof typeof Icon;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /**
   * Nested submenu - if present, the item renders an arrow on the
   * right and pops out the submenu on hover. `onClick` is ignored
   * when `items` is non-empty.
   */
  items?: MenuEntry[];
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
        if (it.items && it.items.length > 0) {
          return <SubmenuItem key={i} item={it} onClose={onClose} />;
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

/**
 * Submenu wrapper - hovers open a popout menu to the right of the
 * parent item. Clicking a leaf entry inside fires its onClick and
 * closes the entire menu (via the parent's `onClose`).
 */
function SubmenuItem({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const itemRef = useRef<HTMLDivElement>(null);
  const IconComp = item.icon ? Icon[item.icon] : null;

  const cancelClose = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 200);
  };

  // Calculate submenu position based on parent item's right edge.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (open && itemRef.current) {
      const rect = itemRef.current.getBoundingClientRect();
      setPos({ left: rect.right - 4, top: rect.top - 4 });
    } else {
      setPos(null);
    }
  }, [open]);

  return (
    <div
      ref={itemRef}
      className={`ctx-item ${item.disabled ? '' : ''}`}
      onMouseEnter={() => { cancelClose(); setOpen(true); }}
      onMouseLeave={scheduleClose}
      style={{ position: 'relative' }}
    >
      <span className="ctx-icon">
        {IconComp ? <IconComp size={14} /> : null}
      </span>
      <span className="ctx-label">{item.label}</span>
      <span className="ctx-shortcut">▸</span>
      {open && pos && (
        <div
          className="ctx-menu ctx-submenu"
          style={{ position: 'fixed', left: pos.left, top: pos.top }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {item.items!.map((sub, j) => {
            if ('separator' in sub) return <div key={j} className="ctx-sep" />;
            const SubIcon = sub.icon ? Icon[sub.icon] : null;
            return (
              <button
                key={j}
                className={`ctx-item ${sub.danger ? 'danger' : ''}`}
                disabled={sub.disabled}
                onClick={() => {
                  if (sub.disabled) return;
                  sub.onClick?.();
                  onClose();
                }}
              >
                <span className="ctx-icon">
                  {SubIcon ? <SubIcon size={14} /> : null}
                </span>
                <span className="ctx-label">{sub.label}</span>
                {sub.shortcut && <span className="ctx-shortcut">{sub.shortcut}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
