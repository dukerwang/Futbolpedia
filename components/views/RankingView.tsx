import React from 'react';
import type { ChatDossierRef } from '../../types';
import { positionCodes } from '../../constants/ratingTiers';
import { isCardedEntry, type RankingEntry, type RankingViewData } from './viewData';
import { CAPTION_TEXT, SkeletonBar, ViewFrame } from './ViewFrame';
import { ScoutAction, VersionPill } from './viewParts';

/**
 * An ordered list of players for a question of who was better, or who did more. A player with a
 * card shows his place in the order, name, version pill and Overall, and opens the card; one
 * nobody has rated shows his name and a Scout action. When the order was moved to match the
 * cards, the moves are listed under it, so the reader sees the order isn't only the model's.
 */

const ROW_H = 'h-14';
/** The title's height: one line of text-lg/snug plus its padding. A long title wraps and grows. */
const TITLE_H = 'min-h-[3.1rem]';

const Rank: React.FC<{ n: number }> = ({ n }) => (
  <span className="w-6 shrink-0 text-right font-mono text-[13px] tabular-nums text-charcoal/50 dark:text-cream-400/60">{n}</span>
);

const CardedRow: React.FC<{ entry: ChatDossierRef; n: number; onOpen?: (d: ChatDossierRef) => void }> = ({ entry, n, onOpen }) => {
  const meta = [positionCodes(entry.position ?? ''), entry.club].filter(Boolean).join(' · ');
  const body = (
    <>
      <Rank n={n} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block font-serif font-bold text-[15px] leading-tight text-charcoal dark:text-cream-50 truncate">{entry.name}</span>
        <span className="mt-1 flex items-center gap-2 min-w-0">
          <VersionPill label={entry.versionLabel} />
          {meta && <span className="min-w-0 truncate text-[11px] font-sans text-charcoal/60 dark:text-cream-400/70">{meta}</span>}
        </span>
      </span>
      {typeof entry.overall === 'number' && entry.overall > 0 && (
        <span className="shrink-0 flex flex-col items-end">
          <span className="font-mono font-medium text-xl leading-none tabular-nums text-charcoal dark:text-cream-50">{entry.overall}</span>
          <span className="mt-1 text-[9px] font-sans font-bold uppercase tracking-widest text-charcoal/45 dark:text-cream-400/50">OVR</span>
        </span>
      )}
    </>
  );
  const row = `${ROW_H} w-full flex items-center gap-3 px-3 py-2`;
  if (!onOpen) return <div className={row}>{body}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      aria-label={`${n}. ${entry.name}${entry.overall ? `, ${entry.overall}` : ''}. Open card`}
      className={`${row} hover:bg-cream-200/60 dark:hover:bg-charcoal/50 transition-colors duration-150`}
    >
      {body}
    </button>
  );
};

const UncardedRow: React.FC<{ name: string; n: number; onScoutName?: (name: string) => void }> = ({ name, n, onScoutName }) => (
  <div className={`${ROW_H} flex items-center gap-3 px-3 py-2`}>
    <Rank n={n} />
    <span className="min-w-0 flex-1">
      <span className="block font-serif font-bold text-[15px] leading-tight text-charcoal dark:text-cream-50 truncate">{name}</span>
      <span className="mt-1 block text-[11px] font-sans text-charcoal/50 dark:text-cream-400/60">No card yet</span>
    </span>
    <ScoutAction name={name} onScoutName={onScoutName} />
  </div>
);

const keyOf = (entry: RankingEntry, i: number) => (isCardedEntry(entry) && entry.cardKey ? entry.cardKey : `${entry.name}-${i}`);

export const RankingView: React.FC<{
  data: RankingViewData;
  onOpenDossier?: (dossier: ChatDossierRef) => void;
  onScoutName?: (name: string) => void;
}> = ({ data, onOpenDossier, onScoutName }) => (
  <ViewFrame kind="ranking" caption={['Ranking', data.criterion]} label={`Ranking: ${data.title}`}>
    <h3 className={`${TITLE_H} px-3 pt-3 pb-2 font-serif font-bold text-lg leading-snug text-charcoal dark:text-cream-50 text-pretty`}>{data.title}</h3>
    <ol className="border-t border-cream-300 dark:border-charcoal-border divide-y divide-cream-300/70 dark:divide-charcoal-border/70">
      {data.entries.map((entry, i) => (
        <li key={keyOf(entry, i)}>
          {isCardedEntry(entry) ? (
            <CardedRow entry={entry} n={i + 1} onOpen={onOpenDossier} />
          ) : (
            <UncardedRow name={entry.name} n={i + 1} onScoutName={onScoutName} />
          )}
        </li>
      ))}
    </ol>
    {data.moves.length > 0 && (
      <div className="px-3 py-2.5 border-t border-cream-300 dark:border-charcoal-border">
        <p className={`${CAPTION_TEXT} flex items-center gap-1.5`}>
          <span aria-hidden="true" className="material-symbols-outlined text-[14px] leading-none">swap_vert</span>
          Order follows the cards
        </p>
        <ul className="mt-1.5 space-y-1">
          {data.moves.map((move) => (
            <li key={move} className="text-[12px] font-sans leading-snug text-charcoal/65 dark:text-cream-300/75 break-words">
              {move}
            </li>
          ))}
        </ul>
      </div>
    )}
  </ViewFrame>
);

/**
 * A ranking's shape while its names resolve. Given the title the tool call carried, it shows it,
 * so a title that wraps takes the same lines. Each row is as tall as a settled one; the moves
 * footer is only known once the order is checked against the cards, so it isn't drawn here.
 */
export const RankingSkeleton: React.FC<{ title?: string; rows?: number; caption?: Array<string | null | undefined> }> = ({
  title,
  rows = 8,
  caption = ['Ranking'],
}) => (
  <ViewFrame kind="ranking" pending caption={caption} label="Ranking, loading">
    {title ? (
      <h3 className={`${TITLE_H} px-3 pt-3 pb-2 font-serif font-bold text-lg leading-snug text-charcoal dark:text-cream-50 text-pretty`}>{title}</h3>
    ) : (
      <div className={`${TITLE_H} px-3 pt-3 pb-2 flex items-start`}>
        <SkeletonBar className="h-5 w-3/5" />
      </div>
    )}
    <div className="border-t border-cream-300 dark:border-charcoal-border divide-y divide-cream-300/70 dark:divide-charcoal-border/70">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i}>
          <div className={`${ROW_H} flex items-center gap-3 px-3 py-2`}>
            <SkeletonBar className="h-2.5 w-6" />
            <span className="flex-1 min-w-0 space-y-2">
              <SkeletonBar className="h-3.5 w-2/5" />
              <SkeletonBar className="h-2.5 w-3/5" />
            </span>
            <SkeletonBar className="h-5 w-7" />
          </div>
        </div>
      ))}
    </div>
  </ViewFrame>
);

export default RankingView;
