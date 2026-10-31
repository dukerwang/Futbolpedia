import React, { useEffect, useRef } from 'react';
import type { PlayerProfile, RatingRequest } from '../types';
import { cardEdition } from '../services/dossierStore';
import type { PlayerMatch } from '../services/playerSearch';
import { describeCardEdition, pillClass } from './pills';

/** One pickable line of the Rate suggestions: a card a player already has, or a new rating. */
export type RateRow =
  | { kind: 'card'; id: string; match: PlayerMatch; card: PlayerProfile; first: boolean; request: RatingRequest }
  | { kind: 'new'; id: string; label: string; request: RatingRequest };

/** The request that serves this card: its edition, and its season or era for those editions. */
const requestForCard = (name: string, card: PlayerProfile): RatingRequest | null => {
  switch (cardEdition(card)) {
    case 'current':
      return { name, edition: 'current' };
    case 'season_snapshot':
      return card.version?.seasonOrEra ? { name, edition: 'season', season: card.version.seasonOrEra } : null;
    case 'era':
      return card.version?.qualifier ? { name, edition: 'era', era: card.version.qualifier } : null;
    default:
      return { name, edition: 'prime' };
  }
};

/**
 * The suggestions in display order: each matched player's cards, then rating the typed name as a
 * new card, at his current form (or prime, once retired) and at his prime.
 */
export const buildRateRows = (query: string, matches: PlayerMatch[]): RateRow[] => {
  const rows: RateRow[] = [];
  for (const match of matches) {
    let first = true;
    for (const card of match.cards) {
      const request = requestForCard(match.name, card);
      if (!request) continue;
      rows.push({ kind: 'card', id: `${match.key}:${rows.length}`, match, card, first, request });
      first = false;
    }
  }
  const name = query.trim().replace(/\s+/g, ' ');
  if (name.length >= 2) {
    rows.push({ kind: 'new', id: 'new-auto', label: `Rate “${name}”`, request: { name, edition: 'auto' } });
    rows.push({ kind: 'new', id: 'new-prime', label: `Rate “${name}” at his prime`, request: { name, edition: 'prime' } });
  }
  return rows;
};

interface RatePickerProps {
  rows: RateRow[];
  /** Index of the highlighted row, or null when Enter should send the text as typed. */
  highlighted: number | null;
  onHighlight: (index: number) => void;
  onPick: (request: RatingRequest) => void;
  /** True while the shared card index is still loading. */
  searching: boolean;
}

export const RatePicker: React.FC<RatePickerProps> = ({ rows, highlighted, onHighlight, onPick, searching }) => {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (highlighted === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${highlighted}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  if (rows.length === 0 && !searching) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-30 bg-cream-50 dark:bg-charcoal-surface border border-charcoal/15 dark:border-cream-400/20 shadow-float dark:shadow-dark-float">
      <ul
        ref={listRef}
        id="rate-suggestions"
        role="listbox"
        aria-label="Players to rate"
        className="overflow-y-auto overscroll-contain max-h-[min(320px,40dvh)] py-1"
        // Keep focus in the text box when a row is tapped.
        onMouseDown={(e) => e.preventDefault()}
      >
        {rows.map((row, index) => {
          const active = index === highlighted;
          const base = `w-full flex items-center gap-3 px-4 min-h-12 sm:min-h-10 text-left cursor-pointer ${
            active ? 'bg-cream-200 dark:bg-charcoal-light' : 'hover:bg-cream-200/60 dark:hover:bg-charcoal-light/60'
          }`;
          if (row.kind === 'new') {
            return (
              <li
                key={row.id}
                id={`rate-row-${index}`}
                data-row={index}
                role="option"
                aria-selected={active}
                className={`${base} ${index > 0 && rows[index - 1].kind === 'card' ? 'border-t border-charcoal/10 dark:border-cream-400/10' : ''}`}
                onMouseEnter={() => onHighlight(index)}
                onClick={() => onPick(row.request)}
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-emerald-600 dark:text-emerald-400">
                  {row.request.edition === 'prime' ? 'history' : 'add'}
                </span>
                <span className="flex-1 min-w-0 truncate font-serif italic text-[15px] text-charcoal dark:text-cream-100">
                  {row.label}
                </span>
                <span className="shrink-0 text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/40 dark:text-cream-400/50">
                  New card
                </span>
              </li>
            );
          }
          const edition = describeCardEdition(row.card);
          const meta = [row.match.position, row.match.club].filter(Boolean).join(' · ');
          return (
            <li
              key={row.id}
              id={`rate-row-${index}`}
              data-row={index}
              role="option"
              aria-selected={active}
              aria-label={`${row.match.name}, ${edition.label}, ${row.card.ratings?.overall ?? ''} overall`}
              className={`${base} ${row.first && index > 0 ? 'border-t border-charcoal/10 dark:border-cream-400/10' : ''}`}
              onMouseEnter={() => onHighlight(index)}
              onClick={() => onPick(row.request)}
            >
              <span className={`flex-1 min-w-0 ${row.first ? '' : 'pl-4'}`}>
                {row.first && (
                  <span className="block truncate font-serif font-bold text-[15px] leading-tight text-charcoal dark:text-cream-50">
                    {row.match.name}
                  </span>
                )}
                {row.first && meta && (
                  <span className="block truncate text-[11px] font-sans text-charcoal/50 dark:text-cream-400/60">{meta}</span>
                )}
              </span>
              <span className={`${pillClass(edition.tone, 'xs')} shrink-0 max-w-[45%] truncate`}>{edition.label}</span>
              <span className="shrink-0 w-7 text-right font-serif font-black text-lg tabular-nums text-charcoal dark:text-cream-50">
                {row.card.ratings?.overall ?? '–'}
              </span>
            </li>
          );
        })}
        {searching && (
          <li className="px-4 py-2 text-[11px] font-sans uppercase tracking-widest text-charcoal/40 dark:text-cream-400/50">
            Searching shared cards…
          </li>
        )}
      </ul>
    </div>
  );
};
