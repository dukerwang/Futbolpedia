import React, { useEffect, useState } from 'react';
import type { ChatDossierRef } from '../../types';
import { ATTRIBUTE_CATEGORIES, GK_ATTRIBUTE_CATEGORIES, positionCodes } from '../../constants/ratingTiers';
import type { ComparisonSide, ComparisonViewData } from './viewData';
import { isGoalkeeperSide } from './viewData';
import { CAPTION_TEXT, SkeletonBar, ViewFrame } from './ViewFrame';
import { VersionPill } from './viewParts';

/**
 * Two cards side by side: Overall and Potential, then the attributes in the groups the card
 * itself uses (Technical, Tactical, Physical, Mental; Goalkeeper for a goalkeeper) as bars that
 * mirror from a centre spine. The higher value is emerald; a tie is neither. A goalkeeper
 * against an outfield player shows the headline numbers and archetypes only, since their
 * attributes aren't measured on the same scale.
 */

const ROW_H = 'h-[34px]';
/** Heights both the settled view and its skeleton use, so the skeleton is the same height. */
const NAMES_H = 'min-h-16';
const OVERALL_H = 'h-10';
const POTENTIAL_H = 'h-7';
const TAGS_H = 'min-h-5';

type Verdict = 'a' | 'b' | 'tie';
const verdict = (a: number | undefined, b: number | undefined): Verdict => {
  if (typeof a !== 'number' || typeof b !== 'number' || a === b) return 'tie';
  return a > b ? 'a' : 'b';
};

const BEST = 'text-emerald-700 dark:text-emerald-400';
const REST = 'text-charcoal/60 dark:text-cream-300/70';

const NameButton: React.FC<{ dossier: ChatDossierRef; align: 'left' | 'right'; onOpen?: (d: ChatDossierRef) => void }> = ({ dossier, align, onOpen }) => {
  const meta = [positionCodes(dossier.position ?? ''), dossier.club].filter(Boolean).join(' · ');
  const body = (
    <>
      <span className="block font-serif font-bold text-base leading-tight text-charcoal dark:text-cream-50 break-words">{dossier.name}</span>
      {meta && <span className="block mt-0.5 text-[11px] font-sans leading-snug text-charcoal/60 dark:text-cream-400/70 break-words">{meta}</span>}
    </>
  );
  const alignment = align === 'right' ? 'text-right items-end' : 'text-left items-start';
  if (!onOpen) return <div className={`min-w-0 ${alignment}`}>{body}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpen(dossier)}
      aria-label={`Open ${dossier.name}'s card`}
      className={`min-w-0 min-h-11 -my-2 py-2 ${alignment} hover:underline decoration-charcoal/30 dark:decoration-cream-100/30 underline-offset-2`}
    >
      {body}
    </button>
  );
};

const Headline: React.FC<{ label: string; a?: number; b?: number }> = ({ label, a, b }) => {
  const v = verdict(a, b);
  const cell = (value: number | undefined, mine: boolean) => (
    <span
      className={`font-mono font-medium tabular-nums leading-none ${label === 'Overall' ? 'text-4xl' : 'text-2xl'} ${
        mine ? BEST : label === 'Overall' ? 'text-charcoal dark:text-cream-50' : REST
      }`}
    >
      {typeof value === 'number' && value > 0 ? value : '–'}
    </span>
  );
  return (
    <div className={`${label === 'Overall' ? OVERALL_H : POTENTIAL_H} grid grid-cols-[1fr_auto_1fr] items-end gap-3`}>
      <div className="text-left">{cell(a, v === 'a')}</div>
      <span className={`${CAPTION_TEXT} pb-0.5`}>{label}</span>
      <div className="text-right">{cell(b, v === 'b')}</div>
    </div>
  );
};

/** One attribute: the label over a pair of bars that meet at the spine, each value at its outer end. */
const MirrorRow: React.FC<{ label: string; a: number; b: number; grown: boolean }> = ({ label, a, b, grown }) => {
  const v = verdict(a, b);
  const bar = (value: number, mine: boolean, side: 'a' | 'b') => (
    <span className={`block h-1.5 bg-charcoal/[0.07] dark:bg-cream-100/[0.08] relative overflow-hidden`}>
      <span
        className={`absolute inset-y-0 ${side === 'a' ? 'right-0' : 'left-0'} transition-[width] duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
          mine ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-charcoal/35 dark:bg-cream-100/35'
        }`}
        style={{ width: grown ? `${Math.max(0, Math.min(100, value))}%` : '0%' }}
      />
    </span>
  );
  return (
    <div className={`${ROW_H} grid grid-cols-[1.75rem_1fr_1fr_1.75rem] grid-rows-[auto_auto] gap-x-0.5 content-center`} role="row" aria-label={`${label}: ${a} against ${b}`}>
      <span className={`row-span-2 self-end font-mono text-[12px] tabular-nums leading-none text-left ${v === 'a' ? `${BEST} font-medium` : REST}`}>{a}</span>
      <span className="col-span-2 text-center text-[10px] font-sans leading-none text-charcoal/60 dark:text-cream-400/70 truncate pb-1">{label}</span>
      <span className={`row-span-2 self-end font-mono text-[12px] tabular-nums leading-none text-right ${v === 'b' ? `${BEST} font-medium` : REST}`}>{b}</span>
      <div className="pr-px">{bar(a, v === 'a', 'a')}</div>
      <div className="pl-px">{bar(b, v === 'b', 'b')}</div>
    </div>
  );
};

type Table = Record<string, Array<{ key: string; label: string }>>;

const valueOf = (side: ComparisonSide, key: string, goalkeeper: boolean): number => {
  const source = goalkeeper ? side.goalkeeperAttributes : side.attributes;
  const n = (source as unknown as Record<string, number> | undefined)?.[key];
  return typeof n === 'number' ? n : 0;
};

const Groups: React.FC<{ data: ComparisonViewData; categories: Table; goalkeeper: boolean }> = ({ data, categories, goalkeeper }) => {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    // Bars grow from the spine once the view is on the page.
    // A timer rather than a frame callback: a hidden tab never runs frames, and the bars would stay empty.
    const id = window.setTimeout(() => setGrown(true), 30);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div role="table" aria-label="Attributes" className={goalkeeper ? 'mx-auto max-w-lg' : '@lg:columns-2 @lg:gap-x-8'}>
      {Object.entries(categories).map(([group, list]) => (
        <div key={group} role="rowgroup" className="break-inside-avoid pb-3">
          <p className={`${CAPTION_TEXT} text-center pb-1 mb-1 border-b border-cream-300/80 dark:border-charcoal-border/80`}>{group}</p>
          {list.map(({ key, label }) => (
            <MirrorRow key={key} label={label} a={valueOf(data.a, key, goalkeeper)} b={valueOf(data.b, key, goalkeeper)} grown={grown} />
          ))}
        </div>
      ))}
    </div>
  );
};

const Archetype: React.FC<{ text?: string; align: 'left' | 'right' }> = ({ text, align }) => (
  <p className={`min-w-0 text-[10px] font-mono uppercase tracking-wider text-charcoal/60 dark:text-cream-300/70 ${align === 'right' ? 'text-right' : 'text-left'}`}>
    {text ? <span className="inline-block max-w-full px-1.5 py-0.5 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 break-words">{text}</span> : null}
  </p>
);

export const ComparisonView: React.FC<{
  data: ComparisonViewData;
  onOpenDossier?: (dossier: ChatDossierRef) => void;
}> = ({ data, onOpenDossier }) => {
  const { a, b } = data;
  const gkA = isGoalkeeperSide(a);
  const gkB = isGoalkeeperSide(b);
  const mixed = gkA !== gkB;
  const bothGk = gkA && gkB;
  const sameVersion = (a.dossier.versionLabel ?? '') === (b.dossier.versionLabel ?? '');

  return (
    <ViewFrame kind="comparison" caption={['Comparison', sameVersion ? shortVersion(a.dossier.versionLabel) : null]} label={`${a.dossier.name} compared with ${b.dossier.name}`}>
      <div className="px-3 pt-3 pb-1 space-y-3">
        <div className={`${NAMES_H} grid grid-cols-2 gap-4`}>
          <div className="min-w-0 flex flex-col gap-1.5 items-start">
            <NameButton dossier={a.dossier} align="left" onOpen={onOpenDossier} />
            <VersionPill label={a.dossier.versionLabel} />
          </div>
          <div className="min-w-0 flex flex-col gap-1.5 items-end">
            <NameButton dossier={b.dossier} align="right" onOpen={onOpenDossier} />
            <VersionPill label={b.dossier.versionLabel} />
          </div>
        </div>
        <Headline label="Overall" a={a.dossier.overall} b={b.dossier.overall} />
        <Headline label="Potential" a={a.dossier.potential} b={b.dossier.potential} />
        <div className={`${TAGS_H} grid grid-cols-2 gap-4`}>
          <Archetype text={a.dossier.archetype} align="left" />
          <Archetype text={b.dossier.archetype} align="right" />
        </div>
      </div>
      <div className="px-3 pb-2 pt-2">
        {mixed ? (
          <p className="py-3 border-t border-cream-300 dark:border-charcoal-border text-[12px] font-sans leading-snug text-charcoal/60 dark:text-cream-400/70">
            {`${(gkA ? a : b).dossier.name} is a goalkeeper, so the attributes aren't compared: a goalkeeper's are rated on goalkeeping, an outfield player's on 25 outfield skills, and the two don't share a scale.`}
          </p>
        ) : (
          <div className="pt-2 border-t border-cream-300 dark:border-charcoal-border">
            <Groups data={data} categories={bothGk ? GK_ATTRIBUTE_CATEGORIES : ATTRIBUTE_CATEGORIES} goalkeeper={bothGk} />
          </div>
        )}
      </div>
    </ViewFrame>
  );
};

/** "Current Form (Nov 2026)" as "Current form" for the caption strip when both cards are the same version. */
const shortVersion = (label?: string): string | null => {
  if (!label) return null;
  const name = label.replace(/\s*\(.*\)\s*$/, '').trim();
  return name || null;
};

/**
 * The comparison's shape while both cards load. A goalkeeper pair is shorter than an outfield
 * pair, so say which when the tool arguments already do.
 */
export const ComparisonSkeleton: React.FC<{ goalkeeper?: boolean; mixed?: boolean; caption?: Array<string | null | undefined> }> = ({
  goalkeeper = false,
  mixed = false,
  caption = ['Comparison'],
}) => (
  <ViewFrame kind="comparison" pending caption={caption} label="Comparison, loading">
    <div className="px-3 pt-3 pb-1 space-y-3">
      <div className={`${NAMES_H} grid grid-cols-2 gap-4`}>
        <div className="flex flex-col gap-1.5 items-start">
          <SkeletonBar className="h-4 w-28" />
          <SkeletonBar className="h-2.5 w-20" />
        </div>
        <div className="flex flex-col gap-1.5 items-end">
          <SkeletonBar className="h-4 w-28" />
          <SkeletonBar className="h-2.5 w-20" />
        </div>
      </div>
      <SkeletonRowPair h={OVERALL_H} />
      <SkeletonRowPair h={POTENTIAL_H} />
      <div className={TAGS_H} />
    </div>
    <div className="px-3 pb-2 pt-2">
      {mixed ? (
        <div className="py-3 border-t border-cream-300 dark:border-charcoal-border space-y-2.5">
          <SkeletonBar className="h-3 w-full" />
          <SkeletonBar className="h-3 w-4/5" />
        </div>
      ) : (
        <div className="pt-2 border-t border-cream-300 dark:border-charcoal-border">
          <div className={goalkeeper ? 'mx-auto max-w-lg' : '@lg:columns-2 @lg:gap-x-8'}>
            {(goalkeeper ? Object.entries(GK_ATTRIBUTE_CATEGORIES) : Object.entries(ATTRIBUTE_CATEGORIES)).map(([group, list]) => (
              <div key={group} className="break-inside-avoid pb-3">
                <p className={`${CAPTION_TEXT} pb-1 mb-1 border-b border-cream-300/80 dark:border-charcoal-border/80 flex justify-center`}>
                  <SkeletonBar className="h-[9px] w-14 my-[3px]" />
                </p>
                {list.map(({ key }) => (
                  <div key={key} className={`${ROW_H} flex items-end pb-1`}>
                    <SkeletonBar className="h-1.5 w-full" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  </ViewFrame>
);

const SkeletonRowPair: React.FC<{ h: string }> = ({ h }) => (
  <div className={`${h} flex items-end justify-between`}>
    <SkeletonBar className="h-full w-10" />
    <SkeletonBar className="h-2.5 w-12" />
    <SkeletonBar className="h-full w-10" />
  </div>
);

export default ComparisonView;
