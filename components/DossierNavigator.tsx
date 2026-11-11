import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PlayerProfile } from '../types';
import { getCardKey } from '../services/geminiService';
import { filterDossiers } from '../services/dossierNavigator';
import { describeCardEdition } from './pills';

interface DossierNavigatorProps {
  profiles: PlayerProfile[];
  currentIndex: number;
  onSelect: (profile: PlayerProfile) => void;
}

const ARROW_CLASS =
  'p-1 rounded text-charcoal/60 dark:text-cream-400 hover:text-charcoal dark:hover:text-white hover:bg-cream-200 dark:hover:bg-charcoal-light disabled:opacity-20 disabled:pointer-events-none transition-all active:scale-95';

/** How long the list stays open after the pointer leaves, so it can cross the gap to the list. */
const HOVER_CLOSE_MS = 180;
const LIST_WIDTH = 320;
const EDGE_GAP = 16;

/**
 * The pager under a card's rating ("36/91" with arrows). Hovering or pressing the count opens a
 * searchable list of every dossier to jump straight to one; the arrows still step one by one.
 */
export const DossierNavigator: React.FC<DossierNavigatorProps> = ({ profiles, currentIndex, onSelect }) => {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = pinned || hovered;
  const currentKey = getCardKey(profiles[currentIndex]);

  const matches = useMemo(
    () => (open ? filterDossiers(profiles, query, (p) => describeCardEdition(p).label) : []),
    [open, profiles, query],
  );

  const close = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setHovered(false);
    setPinned(false);
    setQuery('');
  };

  // The list is drawn on the page rather than inside the panel, whose header ignores touch scrolling
  // and moves with the panel's slide. It sits under the pager, right edges together.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(LIST_WIDTH, window.innerWidth - EDGE_GAP * 2);
      const left = Math.max(EDGE_GAP, Math.min(rect.right - width, window.innerWidth - width - EDGE_GAP));
      setAnchor({ top: rect.bottom, left, width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  // Opening starts on the card you're looking at, so the list is centred on where you are.
  useEffect(() => {
    if (!open) return;
    const at = matches.findIndex((m) => m.index === currentIndex);
    setHighlight(at === -1 ? 0 : at);
    // Only when the list opens or the search changes, not on every re-render of the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, highlight, matches]);

  // Pressing the count means "let me search", so the cursor goes straight to the box. A list that
  // is only hovered open leaves focus where it was.
  const listShown = open && anchor !== null;
  useEffect(() => {
    if (pinned && listShown) inputRef.current?.focus();
  }, [pinned, listShown]);

  // A pinned list closes on a press anywhere else.
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [pinned]);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const choose = (profile: PlayerProfile) => {
    close();
    onSelect(profile);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = matches[highlight];
      if (pick) choose(pick.profile);
    }
  };

  const togglePinned = () => {
    if (pinned) {
      close();
      return;
    }
    setPinned(true);
  };

  return (
    <div
      ref={rootRef}
      className="relative mt-4 select-none"
      // Only a mouse hovers; on touch the press below opens the list, and a tap's emulated hover
      // would otherwise stop the second tap from closing it.
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        if (closeTimer.current) clearTimeout(closeTimer.current);
        setHovered(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return;
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setHovered(false), HOVER_CLOSE_MS);
      }}
      onKeyDown={open ? onKeyDown : undefined}
    >
      <div className="flex items-center bg-cream-200/60 dark:bg-charcoal-light/35 rounded-lg p-0.5 border border-cream-300/60 dark:border-charcoal-border">
        <button
          disabled={currentIndex === 0}
          onClick={() => onSelect(profiles[currentIndex - 1])}
          className={ARROW_CLASS}
          title="Previous Dossier"
        >
          <span className="material-symbols-outlined text-[15px] font-bold block">arrow_back</span>
        </button>

        <button
          type="button"
          onClick={togglePinned}
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Search and jump to a dossier"
          className={`text-[10px] font-mono font-bold px-2 py-1 rounded transition-colors text-charcoal/70 dark:text-cream-300 hover:bg-cream-200 dark:hover:bg-charcoal-light hover:text-charcoal dark:hover:text-white ${
            open ? 'bg-cream-200 dark:bg-charcoal-light' : ''
          }`}
        >
          {currentIndex + 1}/{profiles.length}
        </button>

        <button
          disabled={currentIndex === profiles.length - 1}
          onClick={() => onSelect(profiles[currentIndex + 1])}
          className={ARROW_CLASS}
          title="Next Dossier"
        >
          <span className="material-symbols-outlined text-[15px] font-bold block">arrow_forward</span>
        </button>
      </div>

      {open && anchor && createPortal(
        // The pt-2 keeps the pointer inside this wrapper while it crosses from the pager to the list.
        // Portal events still bubble to the pager in React's tree, so hover and keys carry over.
        <div
          ref={popoverRef}
          style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
          className="fixed pt-2 z-[70] text-left"
        >
          <div className="rounded-xl border border-cream-300 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal-surface shadow-right-depth dark:shadow-dark-float overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-cream-300 dark:border-charcoal-border">
              <span className="material-symbols-outlined text-[16px] text-charcoal/40 dark:text-cream-400/60 block">search</span>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  // Typing is a commitment to the list: it stays open when the pointer leaves.
                  setPinned(true);
                }}
                onFocus={() => setPinned(true)}
                placeholder="Search your dossiers"
                aria-label="Search your dossiers"
                autoComplete="off"
                spellCheck={false}
                className="flex-1 min-w-0 bg-transparent outline-none text-sm font-sans text-charcoal dark:text-cream-100 placeholder:text-charcoal/40 dark:placeholder:text-cream-400/50 select-text"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    inputRef.current?.focus();
                  }}
                  className="text-charcoal/40 dark:text-cream-400/60 hover:text-charcoal dark:hover:text-white"
                  title="Clear search"
                >
                  <span className="material-symbols-outlined text-[16px] block">close</span>
                </button>
              )}
            </div>

            <ul ref={listRef} role="listbox" className="max-h-72 overflow-y-auto scrollbar-hide py-1">
              {matches.length === 0 && (
                <li className="px-3 py-4 text-xs font-sans text-charcoal/50 dark:text-cream-400/70 text-center">
                  No dossier matches “{query.trim()}”
                </li>
              )}
              {matches.map(({ profile, index }, i) => {
                const isCurrent = getCardKey(profile) === currentKey;
                const active = i === highlight;
                return (
                  <li key={getCardKey(profile)} role="option" aria-selected={isCurrent} data-active={active}>
                    <button
                      type="button"
                      onClick={() => choose(profile)}
                      onMouseMove={() => active || setHighlight(i)}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                        active ? 'bg-cream-200/70 dark:bg-charcoal-light/50' : ''
                      }`}
                    >
                      <span className="w-6 shrink-0 text-[10px] font-mono text-charcoal/40 dark:text-cream-400/60 text-right">
                        {index + 1}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span
                          className={`block truncate text-sm font-serif font-bold ${
                            isCurrent ? 'text-emerald-600 dark:text-emerald-400' : 'text-charcoal dark:text-white'
                          }`}
                        >
                          {profile.basicInfo.name}
                        </span>
                        <span className="block truncate text-[11px] font-sans text-charcoal/55 dark:text-cream-400">
                          {describeCardEdition(profile).label}
                          {profile.basicInfo.club ? ` · ${profile.basicInfo.club}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-mono font-bold text-charcoal/70 dark:text-cream-200">
                        {profile.ratings.overall}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};
