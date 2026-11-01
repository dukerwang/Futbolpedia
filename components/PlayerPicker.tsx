import React, { useEffect, useRef } from 'react';
import type { PlayerProfile } from '../types';
import type { PlayerMatch } from '../services/playerSearch';
import { positionCodes } from '../constants/ratingTiers';
import { describeCardEdition, pillClass } from './pills';

/** One pickable line: a card a player already has, or an action on what was typed. */
export type PickerRow =
  | { kind: 'card'; id: string; match: PlayerMatch; card: PlayerProfile; first: boolean }
  | { kind: 'action'; id: string; icon: string; label: string; hint?: string };

/** Each matched player's cards, in version order, as rows. */
export const cardRows = (matches: PlayerMatch[]): PickerRow[] =>
  matches.flatMap((match) =>
    match.cards.map((card, i) => ({ kind: 'card' as const, id: `${match.key}:${i}`, match, card, first: i === 0 })),
  );

interface PlayerPickerProps {
  rows: PickerRow[];
  /** Index of the highlighted row, or null when Enter does the field's own action. */
  highlighted: number | null;
  onHighlight: (index: number) => void;
  onPick: (row: PickerRow) => void;
  /** Shown above the rows. */
  title: string;
  /** Opens above the field (the chat box) or below it (the Scout field). */
  placement: 'above' | 'below';
  /** True while the shared card index is still loading. */
  searching?: boolean;
  /** Shown when there are no rows. */
  empty?: string;
  id: string;
}

export const PlayerPicker: React.FC<PlayerPickerProps> = ({
  rows,
  highlighted,
  onHighlight,
  onPick,
  title,
  placement,
  searching,
  empty,
  id,
}) => {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (highlighted === null) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  return (
    <div
      className={`absolute left-0 right-0 z-40 bg-cream-50 dark:bg-charcoal-surface border border-charcoal/15 dark:border-cream-400/20 shadow-float dark:shadow-dark-float animate-picker-in ${
        placement === 'above' ? 'bottom-full mb-2 origin-bottom' : 'top-full mt-1 origin-top'
      }`}
    >
      <div className="flex items-center justify-between px-4 pt-2.5 pb-1.5 border-b border-charcoal/10 dark:border-cream-400/10">
        <span className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/60">
          {title}
        </span>
        {searching && (
          <span className="text-[10px] font-sans text-charcoal/40 dark:text-cream-400/50">Loading shared cards…</span>
        )}
      </div>
      <ul
        ref={listRef}
        id={id}
        role="listbox"
        aria-label={title}
        className="overflow-y-auto overscroll-contain max-h-[min(300px,38dvh)] py-1"
        // Keep focus in the text box when a row is tapped.
        onMouseDown={(e) => e.preventDefault()}
      >
        {rows.length === 0 && empty && (
          <li className="px-4 py-3 font-serif italic text-[15px] text-charcoal/55 dark:text-cream-400/70">{empty}</li>
        )}
        {rows.map((row, index) => {
          const active = index === highlighted;
          const base = `w-full flex items-center gap-3 px-4 min-h-12 sm:min-h-10 text-left cursor-pointer transition-colors duration-100 ${
            active ? 'bg-cream-200 dark:bg-charcoal-light' : 'hover:bg-cream-200/60 dark:hover:bg-charcoal-light/60'
          }`;
          const divider = index > 0 && (row.kind === 'action' ? rows[index - 1].kind === 'card' : row.first);
          const dividerClass = divider ? 'border-t border-charcoal/10 dark:border-cream-400/10' : '';
          if (row.kind === 'action') {
            return (
              <li
                key={row.id}
                id={`${id}-row-${index}`}
                data-row={index}
                role="option"
                aria-selected={active}
                className={`${base} ${dividerClass}`}
                onMouseEnter={() => onHighlight(index)}
                onClick={() => onPick(row)}
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-emerald-600 dark:text-emerald-400">
                  {row.icon}
                </span>
                <span className="flex-1 min-w-0 truncate font-serif italic text-[15px] text-charcoal dark:text-cream-100">
                  {row.label}
                </span>
                {row.hint && (
                  <span className="shrink-0 text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/40 dark:text-cream-400/50">
                    {row.hint}
                  </span>
                )}
              </li>
            );
          }
          const edition = describeCardEdition(row.card);
          const meta = [positionCodes(row.match.position ?? ''), row.match.club].filter(Boolean).join(' · ');
          return (
            <li
              key={row.id}
              id={`${id}-row-${index}`}
              data-row={index}
              role="option"
              aria-selected={active}
              aria-label={`${row.match.name}, ${edition.label}, ${row.card.ratings?.overall ?? ''} overall`}
              className={`${base} ${dividerClass}`}
              onMouseEnter={() => onHighlight(index)}
              onClick={() => onPick(row)}
            >
              <span className={`flex-1 min-w-0 ${row.first ? '' : 'pl-4'}`}>
                {row.first && (
                  <span className="block truncate font-serif font-bold text-[15px] leading-tight text-charcoal dark:text-cream-50">
                    {row.match.name}
                  </span>
                )}
                {row.first && meta && (
                  <span className="block truncate text-[11px] font-sans text-charcoal/55 dark:text-cream-400/60">{meta}</span>
                )}
              </span>
              <span className={`${pillClass(edition.tone, 'xs')} shrink-0 max-w-[45%] truncate`}>{edition.label}</span>
              <span className="shrink-0 w-7 text-right font-mono font-bold text-base tabular-nums text-charcoal dark:text-cream-50">
                {row.card.ratings?.overall ?? '–'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
