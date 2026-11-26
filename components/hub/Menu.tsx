import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A popover list anchored to its trigger. It renders into `document.body` with fixed positioning,
 * so a trigger inside a horizontally scrolling toolbar is never clipped, and closes on outside
 * click, Escape, scroll or resize. Arrow keys move, Enter or Space picks, Tab leaves.
 */

interface MenuItem<T extends string | number> {
  id: T;
  label: string;
  /** A short note beside the label (a range, a count). */
  hint?: string;
  icon?: string;
  tone?: 'default' | 'danger';
}

interface PopoverProps<T extends string | number> {
  anchor: HTMLElement;
  items: MenuItem<T>[];
  selected?: T;
  align: 'start' | 'end';
  role: 'listbox' | 'menu';
  label: string;
  onPick: (id: T) => void;
  onClose: (refocus: boolean) => void;
}

function Popover<T extends string | number>({ anchor, items, selected, align, role, label, onPick, onClose }: PopoverProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number; flip: boolean } | null>(null);
  const [active, setActive] = useState(() => Math.max(0, items.findIndex((i) => i.id === selected)));

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const list = listRef.current;
    const width = list?.offsetWidth ?? 200;
    const height = list?.offsetHeight ?? 200;
    const flip = rect.bottom + 6 + height > window.innerHeight - 8 && rect.top - 6 - height > 8;
    const rawLeft = align === 'end' ? rect.right - Math.max(width, rect.width) : rect.left;
    setPos({
      top: flip ? rect.top - 6 - height : rect.bottom + 6,
      left: Math.min(Math.max(8, rawLeft), window.innerWidth - Math.max(width, rect.width) - 8),
      minWidth: rect.width,
      flip,
    });
  }, [anchor, align]);

  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      if (!listRef.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(false);
    };
    const onScroll = (e: Event) => {
      if (!listRef.current?.contains(e.target as Node)) onClose(false);
    };
    const onResize = () => onClose(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(items.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick(items[active].id);
    } else if (e.key === 'Tab') {
      onClose(false);
    }
  };

  return createPortal(
    <div
      ref={listRef}
      role={role}
      aria-label={label}
      tabIndex={-1}
      aria-activedescendant={`menu-opt-${active}`}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        minWidth: pos?.minWidth,
        transformOrigin: pos?.flip ? 'bottom' : 'top',
      }}
      className={`z-[200] max-h-[min(22rem,70vh)] overflow-y-auto py-1.5 rounded-xl bg-cream-50 dark:bg-charcoal-surface border border-charcoal/[0.08] dark:border-white/[0.07] shadow-menu dark:shadow-dark-float outline-none ${pos ? 'animate-menu-in' : 'opacity-0'}`}
    >
      {items.map((item, i) => {
        const isSelected = item.id === selected;
        return (
          <div
            key={String(item.id)}
            id={`menu-opt-${i}`}
            role={role === 'listbox' ? 'option' : 'menuitem'}
            aria-selected={role === 'listbox' ? isSelected : undefined}
            onPointerMove={() => setActive(i)}
            onClick={() => onPick(item.id)}
            className={`mx-1.5 flex items-center gap-2.5 pl-2.5 pr-3 py-2 rounded-lg cursor-pointer select-none whitespace-nowrap text-[13px] font-sans transition-colors duration-100 ${
              i === active ? 'bg-charcoal/[0.05] dark:bg-white/[0.06]' : ''
            } ${
              item.tone === 'danger'
                ? 'text-red-600 dark:text-red-400'
                : isSelected
                  ? 'text-charcoal dark:text-cream-50 font-medium'
                  : 'text-charcoal/75 dark:text-cream-200'
            }`}
          >
            {role === 'listbox' ? (
              <span aria-hidden="true" className={`material-symbols-outlined text-[16px] w-4 ${isSelected ? 'text-emerald-600 dark:text-emerald-400' : 'opacity-0'}`}>
                check
              </span>
            ) : item.icon ? (
              <span aria-hidden="true" className="material-symbols-outlined text-[18px] w-4 opacity-70">
                {item.icon}
              </span>
            ) : null}
            <span className="flex-1">{item.label}</span>
            {item.hint && <span className="ml-4 font-mono text-[11px] text-charcoal/40 dark:text-cream-400/60">{item.hint}</span>}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

const useMenu = () => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);
  return { open, setOpen, triggerRef, close };
};

interface SelectMenuProps<T extends string | number> {
  /** What the menu sets ("Position"), read by screen readers and shown before the value. */
  label: string;
  value: T;
  options: MenuItem<T>[];
  onChange: (value: T) => void;
  align?: 'start' | 'end';
  /** Shows the label before the value ("Sort · Rating"); otherwise only the value. */
  showLabel?: boolean;
}

/** A select in the hub's own voice: the value in ink, a quiet chevron, and a themed list. */
export function SelectMenu<T extends string | number>({ label, value, options, onChange, align = 'start', showLabel = false }: SelectMenuProps<T>) {
  const { open, setOpen, triggerRef, close } = useMenu();
  const current = options.find((o) => o.id === value) ?? options[0];
  const isDefault = value === options[0].id;
  const listId = useId();
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current.label}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`group shrink-0 inline-flex items-center gap-1.5 h-9 pl-3 pr-2 rounded-lg text-[13px] font-sans border transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
          open
            ? 'bg-cream-50 dark:bg-charcoal-surface border-charcoal/20 dark:border-white/20 text-charcoal dark:text-cream-50'
            : isDefault
              ? 'border-charcoal/[0.1] dark:border-white/[0.08] text-charcoal/70 dark:text-cream-300 hover:border-charcoal/25 dark:hover:border-white/20 hover:text-charcoal dark:hover:text-cream-50'
              : 'border-charcoal/30 dark:border-white/25 bg-cream-50/70 dark:bg-white/[0.04] text-charcoal dark:text-cream-50 font-medium'
        }`}
      >
        {showLabel && <span className="text-charcoal/45 dark:text-cream-400/70 font-normal">{label}</span>}
        <span>{current.label}</span>
        <span
          aria-hidden="true"
          className={`material-symbols-outlined text-[18px] text-charcoal/40 dark:text-cream-400/70 transition-transform duration-200 ease-out-expo ${open ? 'rotate-180' : ''}`}
        >
          expand_more
        </span>
      </button>
      {open && triggerRef.current && (
        <Popover
          anchor={triggerRef.current}
          items={options}
          selected={value}
          align={align}
          role="listbox"
          label={label}
          onPick={(id) => {
            onChange(id);
            close(true);
          }}
          onClose={close}
        />
      )}
    </>
  );
}

interface ActionMenuProps {
  label: string;
  items: MenuItem<string>[];
  onAction: (id: string) => void;
  className?: string;
}

/** A "more" button with a short list of actions on one card. */
export const ActionMenu: React.FC<ActionMenuProps> = ({ label, items, onAction, className = '' }) => {
  const { open, setOpen, triggerRef, close } = useMenu();
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`grid place-items-center w-8 h-8 rounded-lg text-charcoal/50 dark:text-cream-400/80 hover:text-charcoal dark:hover:text-cream-50 hover:bg-charcoal/[0.05] dark:hover:bg-white/[0.06] transition-[background-color,color,transform] duration-150 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
          open ? 'bg-charcoal/[0.05] dark:bg-white/[0.06] text-charcoal dark:text-cream-50' : ''
        } ${className}`}
      >
        <span aria-hidden="true" className="material-symbols-outlined text-[20px]">
          more_horiz
        </span>
      </button>
      {open && triggerRef.current && (
        <div onClick={(e) => e.stopPropagation()}>
          <Popover
            anchor={triggerRef.current}
            items={items}
            align="end"
            role="menu"
            label={label}
            onPick={(id) => {
              close(false);
              onAction(id);
            }}
            onClose={close}
          />
        </div>
      )}
    </>
  );
};
