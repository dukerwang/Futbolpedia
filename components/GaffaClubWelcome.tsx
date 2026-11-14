import React, { useMemo } from 'react';
import type { GaffaContextBag } from '../types';
import { computeGaffaClubAlerts } from '../services/gaffaLineupAudit';
import { GaffaMark } from './GaffaClubChip';

export interface GaffaWelcomeClub {
  clubName: string;
  leagueName: string;
  /** Null until the club's bag has loaded. */
  bag: GaffaContextBag | null;
}

interface Suggestion {
  icon: string;
  label: string;
  prompt: string;
}

/** At most three questions drawn from the club's bag; a live alert, if any, comes first. */
export function gaffaSuggestions(bag: GaffaContextBag | null): Suggestion[] {
  const out: Suggestion[] = [];
  if (bag?.connected) {
    const alert = computeGaffaClubAlerts(bag).find((a) => a.prompt && a.severity !== 'info');
    if (alert?.prompt) out.push({ icon: 'priority_high', label: 'Needs attention', prompt: alert.prompt });
    if (bag.lineup?.starters?.length) {
      const gw = bag.matchup?.gameweek ? `Gameweek ${bag.matchup.gameweek}` : 'saved';
      const opp = bag.matchup?.opponent_club_name ? ` against ${bag.matchup.opponent_club_name}` : '';
      out.push({ icon: 'groups', label: 'Lineup check', prompt: `Check my ${gw} XI and bench cover${opp}. Who should start?` });
    }
    if ((bag.open_auctions?.length ?? 0) > 0 || (bag.open_listings?.some((l) => !l.yours) ?? false)) {
      out.push({ icon: 'gavel', label: 'Live market', prompt: 'Which live auctions or listings are worth bidding on for my squad?' });
    }
    if ((bag.free_agents?.length ?? 0) > 0) {
      out.push({ icon: 'person_add', label: 'Free agents', prompt: 'Which free agent would most improve my weakest starting slot, and what would he cost?' });
    }
  }
  if (out.length < 3) {
    out.push({ icon: 'shield', label: 'Squad read', prompt: 'Where is my squad strongest and weakest right now?' });
  }
  return out.slice(0, 3);
}

/** The new-chat welcome when a Gaffa club is attached: the club's line and three questions. */
export const GaffaClubWelcome: React.FC<{
  club: GaffaWelcomeClub;
  disabled: boolean;
  onSuggestion: (prompt: string) => void;
}> = ({ club, disabled, onSuggestion }) => {
  const suggestions = useMemo(() => gaffaSuggestions(club.bag), [club.bag]);
  const bag = club.bag;
  const s = bag?.standings;
  const facts = [
    s?.rank != null ? `${s.rank}${s.of_teams ? ` of ${s.of_teams}` : ''} · ${s.wins}-${s.draws}-${s.losses}` : null,
    bag?.matchup ? `GW${bag.matchup.gameweek} vs ${bag.matchup.opponent_club_name ?? 'TBD'}` : null,
    bag?.budget_eur_m != null ? `€${bag.budget_eur_m}m` : null,
  ].filter(Boolean);

  return (
    <div className="mt-8 w-full max-w-[560px] flex flex-col gap-3">
      <div className="flex items-center gap-2.5 text-charcoal dark:text-cream-100">
        <GaffaMark className="size-6 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <div className="min-w-0">
          <p className="font-serif text-lg font-semibold leading-tight truncate">{club.clubName}</p>
          <p className="text-xs font-sans text-charcoal/55 dark:text-cream-400/60 truncate">
            {[club.leagueName, ...facts].join(' · ')}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2">
        {suggestions.map((sg) => (
          <button
            key={sg.prompt}
            type="button"
            onClick={() => onSuggestion(sg.prompt)}
            disabled={disabled}
            className="btn-new-chat text-left flex items-start gap-3 px-4 py-3 border border-charcoal/10 dark:border-cream-400/15 bg-cream-50/60 dark:bg-charcoal-surface/60 hover:border-charcoal/30 dark:hover:border-cream-400/35 disabled:opacity-40 select-text"
          >
            <span className="material-symbols-outlined text-[20px] text-emerald-600 dark:text-emerald-400 mt-0.5">{sg.icon}</span>
            <span className="min-w-0">
              <span className="block text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/60">{sg.label}</span>
              <span className="block font-serif italic text-[15px] leading-snug text-charcoal/85 dark:text-cream-100/85">{sg.prompt}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
