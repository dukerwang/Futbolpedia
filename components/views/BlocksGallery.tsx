import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ChatDossierRef } from '../../types';
import { LeagueTableSkeleton, LeagueTableView, tableSkeletonProps } from './LeagueTableView';
import { ComparisonSkeleton, ComparisonView } from './ComparisonView';
import { RankingSkeleton, RankingView } from './RankingView';
import { PitchBlockView, PitchSkeleton } from './PitchBlockView';
import {
  comparisonEdge, comparisonGoalkeepers, comparisonMixed, comparisonOutfield, comparisonVersions,
  pitchLineup, pitchSeasonStarts, rankingLong, rankingOutput, rankingPeak, rankingUncarded,
  tableGrouped, tableLeague, tableMidTable, tableNoForm, tableSmallGroups,
} from './fixtures';

/**
 * `/dev/blocks`: every reply view in every state, drawn from fixtures with no model call. It is
 * mounted only by `index.tsx` behind `import.meta.env.DEV`, so it isn't part of the production
 * build. Pending views sit above the settled ones, with a readout of both heights: a skeleton
 * must be as tall as the view that replaces it.
 */

type Log = (message: string) => void;

const Section: React.FC<{ id: string; title: string; single?: boolean; children: React.ReactNode }> = ({ id, title, single, children }) => (
  <section id={id} className="scroll-mt-24 mb-12">
    <h2 className="font-serif font-bold text-2xl text-charcoal dark:text-cream-50 pb-2 mb-5 border-b border-cream-300 dark:border-charcoal-border">{title}</h2>
    <div className={`grid gap-8 grid-cols-1 items-start ${single ? '' : 'xl:grid-cols-2'}`}>{children}</div>
  </section>
);

const Specimen: React.FC<{ title: string; note?: string; children: React.ReactNode }> = ({ title, note, children }) => (
  <div className="min-w-0">
    <p className="text-[11px] font-sans font-bold uppercase tracking-widest text-charcoal/60 dark:text-cream-400/70">{title}</p>
    {note && <p className="mt-0.5 mb-2 text-xs font-sans text-charcoal/50 dark:text-cream-400/60">{note}</p>}
    <div className={note ? '' : 'mt-2'}>{children}</div>
  </div>
);

/** A skeleton and its settled view, with the heights they measure at the current width. */
const Pair: React.FC<{ title: string; note?: string; skeleton: React.ReactNode; settled: React.ReactNode }> = ({ title, note, skeleton, settled }) => {
  const box = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<[number, number] | null>(null);
  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const pending = el.querySelector<HTMLElement>('[data-state="pending"]');
    const ready = el.querySelector<HTMLElement>('[data-state="ready"]');
    if (pending && ready) setHeights([Math.round(pending.getBoundingClientRect().height), Math.round(ready.getBoundingClientRect().height)]);
  }, []);
  useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);
  // Bars and fonts settle after first paint; measure again once they have.
  useLayoutEffect(() => {
    const id = window.setTimeout(measure, 700);
    return () => window.clearTimeout(id);
  }, [measure]);
  return (
    <Specimen title={title} note={note}>
      <div ref={box} className="space-y-3">
        <div>{skeleton}</div>
        <div>{settled}</div>
        {heights && (
          <p data-testid="heights" className="text-[11px] font-mono text-charcoal/60 dark:text-cream-400/70">
            {`pending ${heights[0]} px · settled ${heights[1]} px · ${heights[0] === heights[1] ? 'same height' : `off by ${Math.abs(heights[0] - heights[1])} px`}`}
          </p>
        )}
      </div>
    </Specimen>
  );
};

const Failed: React.FC = () => (
  <p className="px-3 py-2 border border-dashed border-cream-400 dark:border-charcoal-border text-xs font-sans text-charcoal/50 dark:text-cream-400/60">
    A failed view draws nothing: the reply goes on without it.
  </p>
);

const NAV: Array<[string, string]> = [['pitch', 'Pitch'], ['table', 'Table'], ['comparison', 'Comparison'], ['ranking', 'Ranking']];

export const BlocksGallery: React.FC = () => {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [last, setLast] = useState('Nothing tapped yet.');
  const log: Log = (m) => setLast(m);
  const open = (d: ChatDossierRef) => log(`onOpenDossier: ${d.name} (${d.cardKey})`);
  const scout = (name: string) => log(`onScoutName: ${name}`);

  const toggleTheme = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    setDark(next);
  };

  const gkSkeletonProps = { goalkeeper: true };
  return (
    <div className="min-h-screen bg-cream-200 dark:bg-charcoal text-charcoal dark:text-cream-100 font-sans transition-colors duration-300">
      <header className="sticky top-0 z-50 bg-cream-200/95 dark:bg-charcoal/95 backdrop-blur border-b border-cream-300 dark:border-charcoal-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-serif font-bold text-xl leading-none text-charcoal dark:text-cream-50">Reply views</h1>
            <nav aria-label="Views" className="mt-1.5 flex gap-4 text-[11px] font-bold uppercase tracking-widest text-charcoal/60 dark:text-cream-400/70">
              {NAV.map(([id, label]) => (
                <a key={id} href={`#${id}`} className="hover:text-emerald-700 dark:hover:text-emerald-400">{label}</a>
              ))}
            </nav>
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            aria-pressed={dark}
            className="shrink-0 min-h-11 px-3 inline-flex items-center gap-2 border border-charcoal/70 dark:border-cream-300/70 text-xs font-bold uppercase tracking-widest hover:bg-charcoal hover:text-cream-50 dark:hover:bg-cream-100 dark:hover:text-charcoal transition-colors"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[18px] leading-none">{dark ? 'light_mode' : 'dark_mode'}</span>
            {dark ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-8 pt-8 pb-24">
        <Section id="pitch" title="Pitch">
          <Pair title="Pending, then settled" note="With nobody out. The 'Out' list adds height a skeleton can’t know." skeleton={<PitchSkeleton />} settled={<PitchBlockView lineup={{ ...pitchLineup, out: [] }} />} />
          <Specimen title="With an even split, a doubt and two absences">
            <PitchBlockView lineup={pitchLineup} />
          </Specimen>
          <Specimen title="Season-starts XI" note="No formation, an empty slot, nobody out.">
            <PitchBlockView lineup={pitchSeasonStarts} />
          </Specimen>
        </Section>

        <Section id="table" title="Table">
          <Pair
            title="Highlights near both ends"
            note="On a phone: top four, bottom three, a neighbour each side of a highlighted club."
            skeleton={<LeagueTableSkeleton caption={['Table', 'Premier League', '2026-27']} {...tableSkeletonProps(tableLeague)} />}
            settled={<LeagueTableView data={tableLeague} />}
          />
          <Specimen title="Highlights mid-table" note="Each club keeps one neighbour either side; the neighbours of two clubs merge.">
            <LeagueTableView data={tableMidTable} />
          </Specimen>
          <Specimen title="Grouped" note="Two conferences, each folds on its own.">
            <LeagueTableView data={tableGrouped} />
          </Specimen>
          <Pair
            title="Small groups"
            note="Groups of eight or fewer never fold, so no footer."
            skeleton={<LeagueTableSkeleton caption={['Table', 'Champions League', '2026-27']} {...tableSkeletonProps(tableSmallGroups)} foldable={false} />}
            settled={<LeagueTableView data={tableSmallGroups} />}
          />
          <Specimen title="No form, gaps in the feed" note="No form column; a dash where a number is missing.">
            <LeagueTableView data={tableNoForm} />
          </Specimen>
          <Specimen title="Failed">
            <Failed />
          </Specimen>
        </Section>

        <Section id="comparison" title="Comparison" single>
          <Pair
            title="Two outfield players, same version"
            skeleton={<ComparisonSkeleton caption={['Comparison', 'Current Form']} />}
            settled={<ComparisonView data={comparisonOutfield} onOpenDossier={open} />}
          />
          <Specimen title="Different versions" note="Each side wears its version pill; the caption names neither.">
            <ComparisonView data={comparisonVersions} onOpenDossier={open} />
          </Specimen>
          <Pair
            title="Two goalkeepers"
            skeleton={<ComparisonSkeleton caption={['Comparison', 'Current Form']} {...gkSkeletonProps} />}
            settled={<ComparisonView data={comparisonGoalkeepers} onOpenDossier={open} />}
          />
          <Pair
            title="Goalkeeper against an outfield player"
            note="Headline numbers and archetypes only."
            skeleton={<ComparisonSkeleton caption={['Comparison', 'Current Form']} mixed />}
            settled={<ComparisonView data={comparisonMixed} onOpenDossier={open} />}
          />
          <Specimen title="Long names, tied Overall" note="A tie takes no colour; the long name wraps.">
            <ComparisonView data={comparisonEdge} onOpenDossier={open} />
          </Specimen>
          <Specimen title="Failed">
            <Failed />
          </Specimen>
        </Section>

        <Section id="ranking" title="Ranking">
          <Pair
            title="Peak level, uncarded rows"
            note="Three players have no card: a Scout action each. The moves footer is left out here: it is known only after the cards are checked, so a skeleton can’t hold room for it."
            skeleton={<RankingSkeleton title={rankingPeak.title} rows={rankingPeak.entries.length} caption={['Ranking', 'peak level']} />}
            settled={<RankingView data={{ ...rankingPeak, moves: [] }} onOpenDossier={open} onScoutName={scout} />}
          />
          <Specimen title="Peak level with moves" note="Two moves follow the cards.">
            <RankingView data={rankingPeak} onOpenDossier={open} onScoutName={scout} />
          </Specimen>
          <Specimen title="Output, the model’s order" note="No moves, no footer.">
            <RankingView data={rankingOutput} onOpenDossier={open} onScoutName={scout} />
          </Specimen>
          <Specimen title="Nobody has a card">
            <RankingView data={rankingUncarded} onOpenDossier={open} onScoutName={scout} />
          </Specimen>
          <Specimen title="Fifteen entries, a title that wraps">
            <RankingView data={rankingLong} onOpenDossier={open} onScoutName={scout} />
          </Specimen>
          <Specimen title="Without callbacks" note="A surface that can't open cards or queue Scout: rows are plain.">
            <RankingView data={rankingUncarded} />
          </Specimen>
          <Specimen title="Failed">
            <Failed />
          </Specimen>
        </Section>
      </main>

      <div role="status" className="fixed bottom-0 inset-x-0 z-50 px-4 sm:px-8 py-2 bg-cream-100/95 dark:bg-charcoal-surface/95 border-t border-cream-300 dark:border-charcoal-border text-[11px] font-mono text-charcoal/70 dark:text-cream-300/80 truncate">
        {last}
      </div>
    </div>
  );
};

export default BlocksGallery;
