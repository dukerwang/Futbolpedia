import React from 'react';
import type { ChatDossierRef, PlayerProfile } from '../types';
import { getCardKey } from '../services/dossierStore';
import { getShortTierLabel } from '../constants/ratingTiers';

export const toChatDossierRef = (p: PlayerProfile): ChatDossierRef => ({
  cardKey: getCardKey(p),
  name: p.basicInfo.name,
  club: p.basicInfo.club,
  position: p.basicInfo.position,
  nationality: p.basicInfo.nationality,
  age: p.basicInfo.age,
  overall: p.ratings?.overall,
  potential: p.ratings?.potential,
  archetype: p.playstyleAndRole?.playstyle?.archetype,
  versionLabel: p.version?.label,
});

const LEGACY_DOSSIER_PATTERN = /^Dossier generated for \*\*(.+?)\*\*/;

/** Older chats only stored the prose notice; recover the player name so the card can still open. */
export const getLegacyDossierRef = (content: unknown): ChatDossierRef | null => {
  if (typeof content !== 'string') return null;
  const match = content.match(LEGACY_DOSSIER_PATTERN);
  return match ? { cardKey: '', name: match[1] } : null;
};

function RatingBlock({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center min-w-[3.25rem]">
      <span className="font-serif font-black text-3xl leading-none tabular-nums text-charcoal dark:text-cream-50">
        {value}
      </span>
      <span className="mt-1 text-[9px] font-sans font-bold uppercase tracking-widest text-charcoal/45 dark:text-cream-400/50">
        {label}
      </span>
    </div>
  );
}

export const DossierChatCard: React.FC<{
  dossier: ChatDossierRef;
  onOpen?: (dossier: ChatDossierRef) => void;
}> = ({ dossier, onOpen }) => {
  const hasRatings = typeof dossier.overall === 'number' && dossier.overall > 0;
  const meta = [dossier.position, dossier.club, dossier.nationality, dossier.age ? `${dossier.age} yrs` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="border border-cream-300 dark:border-charcoal-border bg-cream-50/70 dark:bg-charcoal-surface/70 overflow-hidden">
      <div className="h-0.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600" />
      <div className="flex items-center gap-4 px-4 py-3.5">
        {hasRatings && (
          <div className="flex items-center gap-3 shrink-0 pr-4 border-r border-cream-300 dark:border-charcoal-border">
            <RatingBlock label="OVR" value={dossier.overall!} />
            {typeof dossier.potential === 'number' && dossier.potential > 0 && (
              <RatingBlock label="POT" value={dossier.potential} />
            )}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-emerald-600 dark:text-emerald-400">folder_shared</span>
            <span className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/60 truncate">
              {dossier.versionLabel || 'Dossier filed'}
            </span>
          </div>
          <p className="mt-0.5 font-serif font-bold text-lg leading-tight text-charcoal dark:text-cream-50 truncate">
            {dossier.name}
          </p>
          {meta && (
            <p className="text-xs font-sans text-charcoal/60 dark:text-cream-400/70 truncate">{meta}</p>
          )}
          {(dossier.archetype || hasRatings) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {dossier.archetype && (
                <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                  {dossier.archetype}
                </span>
              )}
              {hasRatings && (
                <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 bg-charcoal/5 dark:bg-cream-400/10 text-charcoal/60 dark:text-cream-300/70">
                  {getShortTierLabel(dossier.overall!)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {onOpen && (
        <button
          type="button"
          onClick={() => onOpen(dossier)}
          className="w-full flex items-center justify-between gap-2 px-4 min-h-11 border-t border-cream-300 dark:border-charcoal-border text-[11px] font-sans font-bold uppercase tracking-widest text-charcoal dark:text-cream-100 hover:bg-cream-200/70 dark:hover:bg-charcoal-light active:bg-cream-300/60 dark:active:bg-charcoal-light transition-colors"
        >
          Open full dossier
          <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
        </button>
      )}
    </div>
  );
};
