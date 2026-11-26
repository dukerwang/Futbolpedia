import React, { useMemo } from 'react';
import type { PlayerProfile } from '../../types';
import type { GlobalHubDossierItem } from '../../services/dossierCache';
import { getCardKey, isPrimeCard } from '../../services/dossierCards';
import { getShortTierLabel, positionCodes } from '../../constants/ratingTiers';
import { EditionLabel } from '../EditionLabel';
import { overallText } from './editionInk';

/**
 * The global hub's front page: a spotlight that changes each day, then shelves that each answer a
 * different question about the library (what's new, who's best right now, one club across its
 * eras, who moved, the best at each position). Every shelf shows a few cards and opens the full,
 * filtered list with See all, so Explore is a way in rather than a second library.
 */

export type PositionGroup = 'goalkeeper' | 'defender' | 'midfield' | 'forward';

export interface ExploreProps {
  items: GlobalHubDossierItem[];
  /** Today, as YYYY-MM-DD: the spotlight and the club shelf change with it. */
  today: string;
  positionOf: (profile: PlayerProfile) => PositionGroup | null;
  ratedAtMs: (profile: PlayerProfile) => number;
  /** Draws one hub card or row, as the rest of the hub does. */
  renderEntry: (item: GlobalHubDossierItem, as: 'grid' | 'list') => React.ReactNode;
  onOpen: (profile: PlayerProfile) => void;
  onAsk: (profile: PlayerProfile) => void;
  onSeeRecent: () => void;
  onSeeCurrentForm: () => void;
  onSeeClub: (club: string) => void;
  onSeeRisers: () => void;
  onSeePosition: (group: PositionGroup) => void;
}

const SHELF = 3;
const POSITION_LIST = 5;
/** A club needs this many players with cards before it gets a shelf of its own. */
const CLUB_MIN_PLAYERS = 4;
/** The spotlight is drawn from cards at World-Class Elite and up. */
const SPOTLIGHT_MIN = 93;

const POSITION_GROUPS: Array<{ id: PositionGroup; label: string }> = [
  { id: 'goalkeeper', label: 'Goalkeepers' },
  { id: 'defender', label: 'Defenders' },
  { id: 'midfield', label: 'Midfielders' },
  { id: 'forward', label: 'Attackers' },
];

/** A stable number for a string, so a day picks the same spotlight on every visit. */
const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};

const playerOf = (p: PlayerProfile) => getCardKey(p).split(':')[0];

/** The first two sentences of the scout summary, without markdown. */
const excerpt = (text: string | undefined): string => {
  const plain = (text ?? '').replace(/\*\*|__|[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  // A sentence ends at a stop followed by a space and a capital, so "1.92m" stays whole.
  const sentences = plain.split(/(?<=[.!?])\s+(?=[A-Z\u00C0-\u00DE"“‘])/);
  return sentences.slice(0, 2).join(' ').trim();
};

const byOverall = (a: GlobalHubDossierItem, b: GlobalHubDossierItem) => b.profile.ratings.overall - a.profile.ratings.overall;

const ShelfHeader: React.FC<{ id: string; title: string; note?: string; onSeeAll?: () => void; seeAllLabel?: string }> = ({ id, title, note, onSeeAll, seeAllLabel = 'See All' }) => (
  <header className="flex items-end gap-4 pb-3 mb-5 border-b border-charcoal/[0.12] dark:border-white/[0.1]">
    <div className="min-w-0">
      <h3 id={id} className="font-serif font-bold text-[24px] md:text-[30px] leading-none tracking-[-0.02em] text-charcoal dark:text-cream-50">
        {title}
      </h3>
      {note && <p className="mt-2 text-[13.5px] leading-snug text-charcoal/55 dark:text-cream-400/80 [text-wrap:pretty]">{note}</p>}
    </div>
    {onSeeAll && (
      <button
        type="button"
        onClick={onSeeAll}
        className="group/see ml-auto shrink-0 inline-flex items-center gap-1 h-8 px-2 -mr-2 rounded-lg text-[13px] font-medium text-charcoal/70 dark:text-cream-300 hover:text-charcoal dark:hover:text-cream-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
      >
        {seeAllLabel}
        <span aria-hidden="true" className="material-symbols-outlined text-[17px] transition-transform duration-200 ease-out-expo group-hover/see:translate-x-0.5">
          arrow_forward
        </span>
      </button>
    )}
  </header>
);

const Spotlight: React.FC<{ item: GlobalHubDossierItem; onOpen: () => void; onAsk: () => void }> = ({ item, onOpen, onAsk }) => {
  const { profile } = item;
  const archetype = profile.playstyleAndRole?.playstyle?.archetype;
  const summary = excerpt(profile.shortBio);
  return (
    <section aria-labelledby="explore-spotlight" className="pt-8 motion-safe:animate-rise-in">
      <h3 id="explore-spotlight" className="sr-only">Spotlight</h3>
      <article
        onClick={onOpen}
        className="group relative cursor-pointer rounded-2xl border border-charcoal/[0.1] dark:border-white/[0.08] bg-cream-50 dark:bg-charcoal-surface shadow-card can-hover:hover:shadow-lift dark:can-hover:hover:shadow-lift-dark transition-shadow duration-300"
      >
        <div className="grid grid-cols-1 md:grid-cols-[auto_minmax(0,1fr)] gap-6 md:gap-12 p-6 md:p-10">
          <div className="flex md:flex-col items-end md:items-start gap-4 md:gap-3 md:pr-12 md:border-r border-charcoal/[0.08] dark:border-white/[0.07]">
            <span className="text-[13px] font-medium text-charcoal/55 dark:text-cream-400/80 md:order-first order-last">Spotlight</span>
            <span
              className={`block font-serif font-extrabold leading-[0.8] tracking-[-0.04em] text-[88px] md:text-[132px] [font-variant-numeric:lining-nums_tabular-nums] ${overallText(profile.ratings.overall)}`}
            >
              {profile.ratings.overall}
            </span>
            <span className="text-[14px] font-medium text-charcoal/80 dark:text-cream-200">{getShortTierLabel(profile.ratings.overall)}</span>
          </div>
          <div className="min-w-0 flex flex-col">
            <EditionLabel profile={profile} size="md" />
            <h4 className="mt-3 font-serif font-extrabold text-[34px] md:text-[48px] leading-[1] tracking-[-0.02em] text-charcoal dark:text-cream-50 [text-wrap:balance]">
              {profile.basicInfo.name}
            </h4>
            {archetype && <p className="mt-2.5 font-serif italic text-[18px] md:text-[21px] text-emerald-700 dark:text-emerald-400">{archetype}</p>}
            <p className="mt-2 text-[13px] text-charcoal/50 dark:text-cream-400/75">
              {[positionCodes(profile.basicInfo.position), profile.basicInfo.club, profile.basicInfo.nationality].filter(Boolean).join(' · ')}
            </p>
            {summary && (
              <p className="mt-5 max-w-[62ch] text-[15px] leading-[1.7] font-light text-charcoal/85 dark:text-cream-100/90 line-clamp-4 [text-wrap:pretty]">{summary}</p>
            )}
            <div className="mt-6 flex flex-wrap items-center gap-2.5" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={onOpen}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-lg text-[13px] font-medium bg-charcoal text-cream-50 dark:bg-cream-100 dark:text-charcoal hover:bg-charcoal/90 dark:hover:bg-white transition-[background-color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                Read the Card
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </button>
              <button
                type="button"
                onClick={onAsk}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-lg text-[13px] font-medium text-charcoal dark:text-cream-100 border border-charcoal/15 dark:border-white/15 hover:border-charcoal/30 dark:hover:border-white/30 transition-[border-color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">chat_bubble</span>
                Ask About Him
              </button>
            </div>
          </div>
        </div>
      </article>
    </section>
  );
};

/** One position's best cards as a short ranked list. */
const PositionList: React.FC<{ label: string; items: GlobalHubDossierItem[]; onOpen: (p: PlayerProfile) => void; onSeeAll: () => void }> = ({ label, items, onOpen, onSeeAll }) => (
  <div className="min-w-0">
    <div className="flex items-baseline justify-between gap-3 pb-2 border-b border-charcoal/[0.08] dark:border-white/[0.07]">
      <h4 className="font-serif font-bold text-[18px] text-charcoal dark:text-cream-50">{label}</h4>
      <button
        type="button"
        onClick={onSeeAll}
        className="text-[12.5px] font-medium text-charcoal/50 dark:text-cream-400/80 hover:text-charcoal dark:hover:text-cream-50 transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
        aria-label={`See all ${label.toLowerCase()}`}
      >
        See All
      </button>
    </div>
    <ol className="mt-1">
      {items.map(({ profile }, i) => (
        <li key={getCardKey(profile)}>
          <button
            type="button"
            onClick={() => onOpen(profile)}
            className="w-full grid grid-cols-[1.1rem_2.4rem_minmax(0,1fr)] items-center gap-2 py-2 -mx-2 px-2 rounded-lg text-left can-hover:hover:bg-charcoal/[0.04] dark:can-hover:hover:bg-white/[0.04] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
          >
            <span className="font-mono text-[11px] text-charcoal/35 dark:text-cream-400/50 [font-variant-numeric:tabular-nums]">{i + 1}</span>
            <span className={`font-serif font-extrabold text-[24px] leading-none tracking-[-0.03em] [font-variant-numeric:lining-nums_tabular-nums] ${overallText(profile.ratings.overall)}`}>
              {profile.ratings.overall}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-serif font-bold text-[15px] leading-tight text-charcoal dark:text-cream-50">{profile.basicInfo.name}</span>
              <EditionLabel profile={profile} size="xs" className="mt-0.5 max-w-full" />
            </span>
          </button>
        </li>
      ))}
    </ol>
  </div>
);

export const Explore: React.FC<ExploreProps> = ({
  items,
  today,
  positionOf,
  ratedAtMs,
  renderEntry,
  onOpen,
  onAsk,
  onSeeRecent,
  onSeeCurrentForm,
  onSeeClub,
  onSeeRisers,
  onSeePosition,
}) => {
  const shelves = useMemo(() => {
    // An older current card is an earlier reading of the same version, not a card of its own.
    const live = items.filter((i) => i.isCurrentRating || isPrimeCard(i.profile));

    const elite = live.filter((i) => i.profile.ratings.overall >= SPOTLIGHT_MIN).sort(byOverall);
    const pool = elite.length > 0 ? elite : [...live].sort(byOverall).slice(0, 12);
    const spotlight = pool.length > 0 ? pool[hash(`spotlight|${today}`) % pool.length] : null;
    const notSpotlight = (i: GlobalHubDossierItem) => !spotlight || getCardKey(i.profile) !== getCardKey(spotlight.profile);

    const recent = live
      .filter(notSpotlight)
      .sort((a, b) => ratedAtMs(b.profile) - ratedAtMs(a.profile))
      .slice(0, SHELF);

    const currentForm = live
      .filter((i) => i.profile.version?.type === 'current' && notSpotlight(i))
      .sort(byOverall)
      .slice(0, SHELF);

    const clubs = new Map<string, { name: string; items: GlobalHubDossierItem[]; players: Set<string> }>();
    for (const item of live) {
      const name = item.profile.basicInfo.club?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const entry = clubs.get(key) ?? { name, items: [], players: new Set<string>() };
      entry.items.push(item);
      entry.players.add(playerOf(item.profile));
      clubs.set(key, entry);
    }
    const clubChoices = [...clubs.values()].filter((c) => c.players.size >= CLUB_MIN_PLAYERS).sort((a, b) => a.name.localeCompare(b.name));
    const club = clubChoices.length > 0 ? clubChoices[hash(`club|${today}`) % clubChoices.length] : null;
    // One card per player, his best, so the shelf is a squad rather than one player's versions.
    const clubCards = club
      ? [...club.items]
          .sort(byOverall)
          .filter((item, i, all) => all.findIndex((o) => playerOf(o.profile) === playerOf(item.profile)) === i)
          .slice(0, SHELF)
      : [];

    const movers = items
      .filter((i) => i.isCurrentRating && typeof i.trajectoryDiff === 'number' && i.trajectoryDiff !== 0)
      .sort((a, b) => Math.abs(b.trajectoryDiff!) - Math.abs(a.trajectoryDiff!))
      .slice(0, 4);

    const byPosition = POSITION_GROUPS.map((group) => ({
      ...group,
      items: live
        .filter((i) => positionOf(i.profile) === group.id)
        .sort(byOverall)
        .filter((item, i, all) => all.findIndex((o) => playerOf(o.profile) === playerOf(item.profile)) === i)
        .slice(0, POSITION_LIST),
    })).filter((g) => g.items.length > 0);

    return { spotlight, recent, currentForm, club, clubCards, movers, byPosition };
  }, [items, today, positionOf, ratedAtMs]);

  const { spotlight, recent, currentForm, club, clubCards, movers, byPosition } = shelves;

  return (
    <div>
      {spotlight && <Spotlight item={spotlight} onOpen={() => onOpen(spotlight.profile)} onAsk={() => onAsk(spotlight.profile)} />}

      {recent.length > 0 && (
        <section aria-labelledby="explore-recent" className="pt-12 md:pt-16">
          <ShelfHeader id="explore-recent" title="Just Rated" note="The newest cards in the library." onSeeAll={onSeeRecent} />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18.5rem),1fr))] gap-4 md:gap-5">{recent.map((i) => renderEntry(i, 'grid'))}</div>
        </section>
      )}

      {byPosition.length > 0 && (
        <section aria-labelledby="explore-positions" className="pt-12 md:pt-16">
          <ShelfHeader id="explore-positions" title="Best by Position" note="The highest-rated player at each position, any version." />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-8">
            {byPosition.map((group) => (
              <PositionList key={group.id} label={group.label} items={group.items} onOpen={onOpen} onSeeAll={() => onSeePosition(group.id)} />
            ))}
          </div>
        </section>
      )}

      {currentForm.length > 0 && (
        <section aria-labelledby="explore-current" className="pt-12 md:pt-16">
          <ShelfHeader id="explore-current" title="Current Form" note="The best players in the game right now, on their current-form cards." onSeeAll={onSeeCurrentForm} />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18.5rem),1fr))] gap-4 md:gap-5">{currentForm.map((i) => renderEntry(i, 'grid'))}</div>
        </section>
      )}

      {club && clubCards.length > 0 && (
        <section aria-labelledby="explore-club" className="pt-12 md:pt-16">
          <ShelfHeader
            id="explore-club"
            title={club.name}
            note={`${club.players.size} players with a card at the club, across every era. A different club each day.`}
            onSeeAll={() => onSeeClub(club.name)}
          />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18.5rem),1fr))] gap-4 md:gap-5">{clubCards.map((i) => renderEntry(i, 'grid'))}</div>
        </section>
      )}

      {movers.length > 0 && (
        <section aria-labelledby="explore-movers" className="pt-12 md:pt-16">
          <ShelfHeader id="explore-movers" title="Risers and Fallers" note="Current-form cards whose rating moved at their latest scouting." onSeeAll={onSeeRisers} />
          <div className="-mt-2 divide-y divide-charcoal/[0.06] dark:divide-white/[0.05]">{movers.map((i) => renderEntry(i, 'list'))}</div>
        </section>
      )}
    </div>
  );
};
