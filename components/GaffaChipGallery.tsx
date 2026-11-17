import React, { useState } from 'react';
import { GaffaClubChip } from './GaffaClubChip';
import type { GaffaUserClub } from '../types';
import type { GaffaClubRef } from '../services/gaffaContext';

/**
 * `/dev/gaffa-chip`: the composer's Gaffa chip in its three states, drawn from fixture clubs with no
 * Gaffa grant and no model call. Each specimen is live, so its menu and detach button work. It is
 * mounted only by `index.tsx` behind `import.meta.env.DEV`, so it isn't part of the production build.
 */

const CLUBS: GaffaUserClub[] = [
  { club_id: 'c1', club_name: 'Hackney Wanderers', budget_eur_m: 45, league_id: 'l1', league_name: 'Sunday League' },
  { club_id: 'c2', club_name: 'Bow Rovers', budget_eur_m: 38, league_id: 'l1', league_name: 'Sunday League' },
  { club_id: 'c3', club_name: 'Leyton Athletic', budget_eur_m: 52, league_id: 'l2', league_name: 'Office Cup' },
];

const Specimen: React.FC<{ title: string; connected: boolean; start: GaffaClubRef | null }> = ({ title, connected, start }) => {
  const [selected, setSelected] = useState<GaffaClubRef | null>(start);
  return (
    <div className="min-w-0">
      <p className="mb-2 text-[11px] font-sans font-bold uppercase tracking-widest text-charcoal/60 dark:text-cream-400/70">{title}</p>
      <div className="p-3 bg-cream-50 dark:bg-charcoal-surface border border-cream-300 dark:border-charcoal-border">
        <GaffaClubChip
          connected={connected}
          clubs={CLUBS}
          selected={selected}
          loadingClubs={false}
          connecting={false}
          error={null}
          gaffaBaseUrl="https://www.gaffa.live"
          onConnect={() => {}}
          onSelect={setSelected}
          onDisconnect={() => {}}
        />
      </div>
    </div>
  );
};

export const GaffaChipGallery: React.FC = () => {
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  const toggle = () => {
    document.documentElement.classList.toggle('dark');
    setDark(document.documentElement.classList.contains('dark'));
  };
  return (
    <div className="min-h-screen bg-cream-200 dark:bg-charcoal px-4 py-6 sm:px-8">
      <div className="max-w-[800px] mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="font-serif font-bold text-2xl text-charcoal dark:text-cream-50">Gaffa chip</h1>
          <button type="button" onClick={toggle} className="min-h-10 px-3 text-xs font-sans font-semibold border border-cream-300 dark:border-charcoal-border text-charcoal dark:text-cream-100">
            {dark ? 'Light' : 'Dark'}
          </button>
        </div>
        <Specimen title="Not connected" connected={false} start={null} />
        <Specimen title="Connected, no club" connected start={null} />
        <Specimen title="Club attached" connected start={{ leagueId: 'l1', clubId: 'c1' }} />
      </div>
    </div>
  );
};
