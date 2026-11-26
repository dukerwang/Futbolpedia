import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * A highlight that slides between a row of options: measures the active option and moves one
 * element to it. The first measurement places it without a transition, so it never sweeps in
 * from the edge on load.
 */
export function useSlidingIndicator<K extends string>(active: K) {
  const nodes = useRef(new Map<K, HTMLElement>());
  const [box, setBox] = useState<{ x: number; w: number; animate: boolean } | null>(null);
  const measured = useRef(false);

  useLayoutEffect(() => {
    const update = () => {
      const el = nodes.current.get(active);
      if (!el) return;
      setBox({ x: el.offsetLeft, w: el.offsetWidth, animate: measured.current });
      measured.current = true;
    };
    update();
    const ro = new ResizeObserver(update);
    nodes.current.forEach((el) => ro.observe(el));
    document.fonts?.ready.then(update).catch(() => {});
    return () => ro.disconnect();
  }, [active]);

  const register = useCallback(
    (key: K) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(key, el);
      else nodes.current.delete(key);
    },
    [],
  );

  const style: React.CSSProperties = box
    ? { transform: `translateX(${box.x}px)`, width: box.w, transition: box.animate ? undefined : 'none' }
    : { opacity: 0 };
  return { register, style };
}

export interface SegmentedOption<K extends string> {
  id: K;
  label: string;
  /** Fill class for the option's diamond (an edition's ink). */
  dot?: string;
  /** Text class when this option is active, so an edition reads in its own colour. */
  activeText?: string;
}

interface SegmentedProps<K extends string> {
  label: string;
  value: K;
  options: SegmentedOption<K>[];
  onChange: (value: K) => void;
  /** `radio` for a choice the form submits (Scout's version); `toggle` for a filter. */
  kind?: 'radio' | 'toggle';
  className?: string;
}

/**
 * The app's segmented control: options as words, a raised tile sliding under the active one.
 * Shared by the hub's edition filter and Scout's version switch.
 */
export function Segmented<K extends string>({ label, value, options, onChange, kind = 'toggle', className = '' }: SegmentedProps<K>) {
  const indicator = useSlidingIndicator<K>(value);
  return (
    <div className={`relative shrink-0 flex items-center ${className}`} role={kind === 'radio' ? 'radiogroup' : 'group'} aria-label={label}>
      <span
        aria-hidden="true"
        style={indicator.style}
        className="absolute left-0 inset-y-0 rounded-lg bg-cream-50 dark:bg-white/[0.08] border border-charcoal/[0.1] dark:border-white/[0.08] shadow-[0_1px_2px_rgba(26,31,46,0.06)] transition-[transform,width] duration-300 ease-out-expo"
      />
      {options.map(({ id, label: optionLabel, dot, activeText }) => {
        const active = value === id;
        return (
          <button
            key={id}
            ref={indicator.register(id)}
            type="button"
            onClick={() => onChange(id)}
            {...(kind === 'radio' ? { role: 'radio', 'aria-checked': active } : { 'aria-pressed': active })}
            className={`relative flex items-center gap-2 h-9 px-3 rounded-lg text-[13px] font-sans transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
              active
                ? `font-medium ${activeText ?? 'text-charcoal dark:text-cream-50'}`
                : 'text-charcoal/50 dark:text-cream-400/70 hover:text-charcoal/80 dark:hover:text-cream-200'
            }`}
          >
            {dot && <span aria-hidden="true" className={`w-[6px] h-[6px] rotate-45 rounded-[1px] ${dot} ${active ? '' : 'opacity-60'}`} />}
            {optionLabel}
          </button>
        );
      })}
    </div>
  );
}
