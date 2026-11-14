import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GaffaUserClub } from '../types';
import type { GaffaClubRef } from '../services/gaffaContext';

/** Gaffa's mark: a football head on a manager's suit and tie. */
export const GaffaMark: React.FC<{ className?: string }> = ({ className = 'size-[18px]' }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 128 128"
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth="5.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="64" cy="64" r="56" />
    <g transform="translate(35.2, 82.8) scale(0.06)">
      <path
        fill="currentColor"
        stroke="none"
        d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm200-500 54-18 16-54q-32-48-77-82.5T574-786l-54 38v56l160 112Zm-400 0 160-112v-56l-54-38q-54 17-99 51.5T210-652l16 54 54 18Zm-42 308 46-4 30-54-58-174-56-20-40 30q0 65 18 118.5T238-272Zm242 112q26 0 51-4t49-12l28-60-26-44H378l-26 44 28 60q24 8 49 12t51 4Zm-90-200h180l56-160-146-102-144 102 54 160Zm332 88q42-50 60-103.5T800-494l-40-28-56 18-58 174 30 54 46 4Z"
      />
    </g>
    <path d="M 24.8 104 C 34 88, 42 82, 50 82 M 103.2 104 C 94 88, 86 82, 78 82" />
    <path d="M 50 82 L 44 94 H 49 L 64 116 L 79 94 H 84 L 78 82" />
    <path d="M 54 82 L 64 96 L 74 82" />
    <path fill="currentColor" stroke="none" d="M 61 82 H 67 L 66 90 L 67.5 106 L 64 111 L 60.5 106 L 62 90 Z" />
  </svg>
);

interface GaffaClubChipProps {
  connected: boolean;
  clubs: GaffaUserClub[];
  /** The conversation's attached club, if any. */
  selected: GaffaClubRef | null;
  loadingClubs: boolean;
  connecting: boolean;
  error: string | null;
  gaffaBaseUrl: string | null;
  disabled?: boolean;
  onConnect: () => void;
  onSelect: (club: GaffaClubRef | null) => void;
  onDisconnect: () => void;
}

const MENU_ROW =
  'w-full text-left px-3 py-2 min-h-10 flex items-center gap-2 text-sm font-serif text-charcoal dark:text-cream-100 hover:bg-cream-200/70 dark:hover:bg-charcoal-light/70 disabled:opacity-50';

/**
 * The composer's Gaffa control. Signed out of Gaffa it offers Connect Gaffa; connected, it attaches
 * one of your clubs to the conversation, so chat answers with your squad, league and market in mind.
 */
export const GaffaClubChip: React.FC<GaffaClubChipProps> = ({
  connected,
  clubs,
  selected,
  loadingClubs,
  connecting,
  error,
  gaffaBaseUrl,
  disabled,
  onConnect,
  onSelect,
  onDisconnect,
}) => {
  const [open, setOpen] = useState(false);
  // The composer clips overflow, so the menu is placed against the viewport, above the chip.
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(288, window.innerWidth - 32);
      setAnchor({
        left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
        bottom: window.innerHeight - rect.top + 8,
      });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('resize', close);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const attached = useMemo(
    () => (selected ? clubs.find((c) => c.league_id === selected.leagueId && c.club_id === selected.clubId) ?? null : null),
    [clubs, selected],
  );

  const byLeague = useMemo(() => {
    const groups = new Map<string, { name: string; clubs: GaffaUserClub[] }>();
    for (const c of clubs) {
      const g = groups.get(c.league_id) ?? { name: c.league_name, clubs: [] };
      g.clubs.push(c);
      groups.set(c.league_id, g);
    }
    return [...groups.values()];
  }, [clubs]);

  const label = !connected ? 'Gaffa' : attached ? attached.club_name : selected && loadingClubs ? 'Gaffa club' : 'No club';
  const active = connected && Boolean(attached);

  const pick = (club: GaffaClubRef | null) => {
    onSelect(club);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={active ? `Gaffa club: ${attached!.club_name} · ${attached!.league_name}` : 'Gaffa club'}
        className={`h-10 sm:h-9 max-w-[11rem] sm:max-w-[14rem] pl-2 pr-2.5 flex items-center gap-1.5 rounded-full border transition-colors disabled:opacity-60 ${
          active
            ? 'border-emerald-600/40 dark:border-emerald-400/40 text-emerald-700 dark:text-emerald-300 bg-emerald-50/60 dark:bg-emerald-400/10'
            : 'border-cream-300 dark:border-charcoal-border text-charcoal/60 dark:text-cream-400/70 hover:text-charcoal dark:hover:text-cream-100'
        }`}
      >
        <GaffaMark className="size-[18px] shrink-0" />
        <span className="truncate text-xs font-sans font-semibold">{label}</span>
        <span className="material-symbols-outlined text-[16px] shrink-0">{open ? 'expand_more' : 'expand_less'}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Gaffa club"
          style={anchor ? { left: anchor.left, bottom: anchor.bottom } : undefined}
          className="fixed w-[min(18rem,calc(100vw-2rem))] z-50 bg-cream-50 dark:bg-charcoal-surface border border-charcoal/15 dark:border-cream-400/15 shadow-float dark:shadow-dark-float"
        >
          {!connected ? (
            <div className="p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-charcoal dark:text-cream-100">
                <GaffaMark className="size-5" />
                <span className="font-serif text-base font-semibold">Gaffa</span>
              </div>
              <p className="text-sm font-serif text-charcoal/75 dark:text-cream-200/75 leading-snug">
                Bring your Gaffa club into the chat. Futbolpedia reads your squad, lineup, Club Balance and league
                market, and can&apos;t change any of them.
              </p>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onConnect();
                }}
                disabled={connecting}
                className="min-h-10 px-3 bg-charcoal dark:bg-emerald-600 text-cream-50 text-xs font-sans font-semibold tracking-wide disabled:opacity-50"
              >
                {connecting ? 'Waiting for Gaffa…' : 'Connect Gaffa'}
              </button>
              {error && <p className="text-xs font-sans text-red-600 dark:text-red-400">{error}</p>}
            </div>
          ) : (
            <div className="py-1.5 max-h-[60vh] overflow-y-auto">
              {loadingClubs && clubs.length === 0 ? (
                <p className="px-3 py-2 text-sm font-serif italic text-charcoal/60 dark:text-cream-400/60">Loading your clubs…</p>
              ) : clubs.length === 0 ? (
                <p className="px-3 py-2 text-sm font-serif italic text-charcoal/60 dark:text-cream-400/60">
                  No clubs on your Gaffa account yet.
                </p>
              ) : (
                byLeague.map((league) => (
                  <div key={league.name + league.clubs[0].league_id} className="py-1">
                    <p className="px-3 pt-1 pb-0.5 text-[11px] font-sans text-charcoal/50 dark:text-cream-400/55 truncate">
                      {league.name}
                    </p>
                    {league.clubs.map((c) => {
                      const isOn = attached?.club_id === c.club_id;
                      return (
                        <button
                          key={c.club_id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isOn}
                          onClick={() => pick({ leagueId: c.league_id, clubId: c.club_id })}
                          className={MENU_ROW}
                        >
                          <span className="material-symbols-outlined text-[18px] text-emerald-600 dark:text-emerald-400 w-5">
                            {isOn ? 'check' : ''}
                          </span>
                          <span className="flex-1 min-w-0 truncate">{c.club_name}</span>
                          <span className="text-xs font-mono text-charcoal/50 dark:text-cream-400/50">€{c.budget_eur_m}m</span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!attached}
                onClick={() => pick(null)}
                className={MENU_ROW}
              >
                <span className="material-symbols-outlined text-[18px] text-emerald-600 dark:text-emerald-400 w-5">
                  {!attached ? 'check' : ''}
                </span>
                <span className="flex-1 italic text-charcoal/70 dark:text-cream-300/70">No club</span>
              </button>
              {error && <p className="px-3 py-1.5 text-xs font-sans text-red-600 dark:text-red-400">{error}</p>}
              <div className="my-1 border-t border-charcoal/10 dark:border-cream-400/10" />
              {attached && gaffaBaseUrl && (
                <a
                  href={`${gaffaBaseUrl}/league/${attached.league_id}/team/roster`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className={MENU_ROW}
                >
                  <span className="material-symbols-outlined text-[18px] w-5 text-charcoal/50 dark:text-cream-400/60">open_in_new</span>
                  <span className="flex-1">Open in Gaffa</span>
                </a>
              )}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onDisconnect();
                }}
                className={MENU_ROW}
              >
                <span className="material-symbols-outlined text-[18px] w-5 text-charcoal/50 dark:text-cream-400/60">link_off</span>
                <span className="flex-1">Disconnect Gaffa</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
