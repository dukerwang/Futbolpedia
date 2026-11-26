import React, { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from 'react';
import type { PlayerProfile } from '../types';
import { fetchGlobalHubDossiers, type GlobalHubDossierItem, getCardKey, isPrimeCard } from '../services/geminiService';
import { cardEdition, compareVersions, formatEraQualifier } from '../services/dossierStore';
import { getTierDefinition, RATING_TIERS } from '../constants/ratingTiers';
import { SelectMenu } from './hub/Menu';
import { HubCard, HubRow } from './hub/HubEntries';
import { INK_DOT } from './hub/editionInk';

/** "global" is every shared card in Supabase; "mine" is the user's own dossiers (localStorage). */
export type HubTab = 'global' | 'mine';

interface DossierHubProps {
  /** The hub is the visible view; the global tab only fetches while it's on screen. */
  isActive: boolean;
  tab: HubTab;
  onTabChange: (tab: HubTab) => void;
  savedProfiles: PlayerProfile[];
  /** Card open in the side panel, highlighted in the grid. */
  activeCardKey: string | null;
  onSelectDossier: (profile: PlayerProfile, from: HubTab) => void;
  /** Takes the card into the chat to ask about it. */
  onAskAbout: (profile: PlayerProfile, from: HubTab) => void;
  onRenameDossier: (cardKey: string, newName: string) => void;
  onDeleteDossier: (cardKey: string) => void;
  /** Opens Scout, with a name to rate when the search found no card for it. */
  onScout: (name?: string) => void;
}

type EditionFilter = 'all' | 'current' | 'prime' | 'era' | 'season';
type PositionFilter = 'all' | 'forward' | 'midfield' | 'defender' | 'goalkeeper';
type SortOption = 'overall_desc' | 'recent' | 'name_asc' | 'trajectory_desc';
type HubLayout = 'grid' | 'list';

/** A background refetch of the global tab runs when it's re-entered after this long. */
const GLOBAL_STALE_MS = 2 * 60 * 1000;
const LAYOUT_KEY = 'futbolpedia-hub-layout';
/** Entries past this many are offscreen on first paint, so they skip the entrance. */
const ANIMATED_ENTRIES = 14;

const EDITION_OPTIONS: Array<{ id: EditionFilter; label: string; dot?: string }> = [
  { id: 'all', label: 'All' },
  { id: 'current', label: 'Current', dot: INK_DOT.current },
  { id: 'prime', label: 'Prime', dot: INK_DOT.prime },
  { id: 'era', label: 'Eras', dot: INK_DOT.era },
  { id: 'season', label: 'Seasons', dot: INK_DOT.season },
];

/** The card editions each edition filter keeps. Current needs a recorded edition, so pre-edition cards stay under All. */
const matchesEdition = (p: PlayerProfile, filter: EditionFilter): boolean => {
  if (filter === 'all') return true;
  if (filter === 'current') return p.version?.type === 'current';
  const edition = cardEdition(p);
  if (filter === 'era') return edition === 'era';
  if (filter === 'season') return edition === 'season_snapshot';
  return edition === 'prime';
};

const SORT_OPTIONS: Array<{ id: SortOption; label: string; globalOnly?: boolean }> = [
  { id: 'overall_desc', label: 'Rating' },
  { id: 'recent', label: 'Most recent' },
  { id: 'name_asc', label: 'Name' },
  { id: 'trajectory_desc', label: 'Biggest risers', globalOnly: true },
];

const POSITION_OPTIONS: Array<{ id: PositionFilter; label: string }> = [
  { id: 'all', label: 'All positions' },
  { id: 'forward', label: 'Attackers' },
  { id: 'midfield', label: 'Midfielders' },
  { id: 'defender', label: 'Defenders' },
  { id: 'goalkeeper', label: 'Goalkeepers' },
];

const RATING_OPTIONS: Array<{ id: number; label: string; hint?: string }> = [
  { id: 0, label: 'Any rating' },
  { id: 96, label: '96 and up', hint: 'Icons' },
  { id: 90, label: '90 and up', hint: 'World-class' },
  { id: 85, label: '85 and up' },
  { id: 80, label: '80 and up' },
];

/** Substrings of a lowercased position that put a card in each position filter. */
const POSITION_FILTER_KEYWORDS: Record<Exclude<PositionFilter, 'all'>, string[]> = {
  forward: ['striker', 'forward', 'winger', 'st', 'cf'],
  midfield: ['midfielder', 'cm', 'cdm', 'cam'],
  defender: ['back', 'cb', 'lb', 'rb', 'libero'],
  goalkeeper: ['goalkeeper', 'gk'],
};

const playerKey = (p: PlayerProfile) => getCardKey(p).split(':')[0];

/**
 * When a shared card was rated: a re-rating, else its generation time. The evaluation date is no
 * use here, since a prime card's is the end of his peak, years ago.
 */
const ratedAtMs = (p: PlayerProfile): number =>
  p.rerateAt || p.createdAt || Date.parse(p.evaluationDate || p.version?.evaluationDate || '') || 0;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

/** "26 November", with the year only when it isn't this one. */
const dayInWords = (iso: string): string => {
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
};

const initialLayout = (): HubLayout => {
  try {
    const stored = localStorage.getItem(LAYOUT_KEY);
    if (stored === 'grid' || stored === 'list') return stored;
  } catch {
    /* storage blocked */
  }
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches ? 'grid' : 'list';
};

/**
 * A highlight that slides between a row of options: measures the active option and moves one
 * element to it. The first measurement places it without a transition, so it never sweeps in
 * from the edge on load.
 */
function useSlidingIndicator<K extends string>(active: K) {
  const nodes = useRef(new Map<K, HTMLElement>());
  const [box, setBox] = useState<{ x: number; w: number; animate: boolean } | null>(null);
  const measured = useRef(false);

  useLayoutEffect(() => {
    const update = () => {
      const el = nodes.current.get(active);
      if (!el) return;
      setBox({ x: el.offsetLeft, w: el.offsetWidth, animate: measured.current });
      measured.current = true;
    };
    update();
    const ro = new ResizeObserver(update);
    nodes.current.forEach((el) => ro.observe(el));
    document.fonts?.ready.then(update).catch(() => {});
    return () => ro.disconnect();
  }, [active]);

  const register = useCallback(
    (key: K) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(key, el);
      else nodes.current.delete(key);
    },
    [],
  );

  const style: React.CSSProperties = box
    ? { transform: `translateX(${box.x}px)`, width: box.w, transition: box.animate ? undefined : 'none' }
    : { opacity: 0 };
  return { register, style };
}

const Skeleton: React.FC<{ layout: HubLayout }> = ({ layout }) => {
  const shimmer =
    'bg-[linear-gradient(100deg,transparent_30%,rgba(26,31,46,0.05)_50%,transparent_70%)] dark:bg-[linear-gradient(100deg,transparent_30%,rgba(255,255,255,0.05)_50%,transparent_70%)] bg-[length:200%_100%] motion-safe:animate-shimmer';
  if (layout === 'list') {
    return (
      <div className="pt-6 divide-y divide-charcoal/[0.06] dark:divide-white/[0.05]" aria-hidden="true">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 py-4 px-2">
            <div className={`w-9 h-7 rounded-md bg-charcoal/[0.05] dark:bg-white/[0.05] ${shimmer}`} />
            <div className="flex-1 space-y-2">
              <div className={`h-3.5 w-40 rounded bg-charcoal/[0.06] dark:bg-white/[0.06] ${shimmer}`} />
              <div className={`h-2.5 w-56 rounded bg-charcoal/[0.04] dark:bg-white/[0.04] ${shimmer}`} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="pt-8 grid grid-cols-[repeat(auto-fill,minmax(min(100%,18.5rem),1fr))] gap-5" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-[19.5rem] rounded-[14px] p-5 bg-cream-50/70 dark:bg-charcoal-surface/60 border border-charcoal/[0.06] dark:border-white/[0.05]">
          <div className="flex gap-4">
            <div className={`w-14 h-10 rounded-md bg-charcoal/[0.06] dark:bg-white/[0.06] ${shimmer}`} />
            <div className="flex-1 space-y-2 pt-1">
              <div className={`h-2.5 w-24 rounded bg-charcoal/[0.05] dark:bg-white/[0.05] ${shimmer}`} />
              <div className={`h-2.5 w-32 rounded bg-charcoal/[0.05] dark:bg-white/[0.05] ${shimmer}`} />
            </div>
          </div>
          <div className={`mt-7 h-5 w-44 rounded bg-charcoal/[0.07] dark:bg-white/[0.07] ${shimmer}`} />
          <div className={`mt-2 h-3 w-36 rounded bg-charcoal/[0.04] dark:bg-white/[0.04] ${shimmer}`} />
          <div className="mt-8 space-y-3">
            {[0, 1, 2].map((r) => (
              <div key={r} className={`h-2.5 rounded bg-charcoal/[0.04] dark:bg-white/[0.04] ${shimmer}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

const EmptyState: React.FC<{ icon: string; title: string; body: string; children?: React.ReactNode }> = ({ icon, title, body, children }) => (
  <div className="flex flex-col items-center text-center py-24 px-6 motion-safe:animate-fade-in">
    <span aria-hidden="true" className="grid place-items-center w-12 h-12 rounded-full border border-charcoal/10 dark:border-white/10 text-charcoal/40 dark:text-cream-400/60">
      <span className="material-symbols-outlined text-[22px]">{icon}</span>
    </span>
    <h3 className="mt-5 font-serif font-bold text-[22px] tracking-[-0.01em] text-charcoal dark:text-cream-50">{title}</h3>
    <p className="mt-2 max-w-sm text-[14px] leading-relaxed text-charcoal/60 dark:text-cream-400">{body}</p>
    {children && <div className="flex flex-wrap justify-center gap-2.5 mt-7">{children}</div>}
  </div>
);

const primaryButton =
  'inline-flex items-center gap-2 h-10 px-4 rounded-lg text-[13px] font-medium bg-charcoal text-cream-50 dark:bg-cream-100 dark:text-charcoal hover:bg-charcoal/90 dark:hover:bg-white transition-[background-color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-200 dark:focus-visible:ring-offset-charcoal';
const secondaryButton =
  'inline-flex items-center gap-2 h-10 px-4 rounded-lg text-[13px] font-medium text-charcoal dark:text-cream-100 border border-charcoal/15 dark:border-white/15 hover:border-charcoal/30 dark:hover:border-white/30 transition-[border-color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60';

/**
 * The dossier library as a main view: the global hub (every shared card) and "Your dossiers"
 * (cards this browser has scouted or opened) as tabs over one set of filters. Ordered by rating,
 * the cards fall into chapters by tier band, like an almanac; shown as collectible cards or as a
 * ranked register.
 */
export const DossierHub: React.FC<DossierHubProps> = ({
  isActive,
  tab,
  onTabChange,
  savedProfiles,
  activeCardKey,
  onSelectDossier,
  onAskAbout,
  onRenameDossier,
  onDeleteDossier,
  onScout,
}) => {
  const [globalItems, setGlobalItems] = useState<GlobalHubDossierItem[]>([]);
  const [globalStatus, setGlobalStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const lastGlobalFetchRef = useRef(0);
  const savedProfilesRef = useRef(savedProfiles);
  savedProfilesRef.current = savedProfiles;
  const searchRef = useRef<HTMLInputElement>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [editionFilter, setEditionFilter] = useState<EditionFilter>('all');
  const [positionFilter, setPositionFilter] = useState<PositionFilter>('all');
  const [minTierFilter, setMinTierFilter] = useState<number>(0);
  const [sortByTab, setSortByTab] = useState<Record<HubTab, SortOption>>({ mine: 'recent', global: 'overall_desc' });
  const [layout, setLayout] = useState<HubLayout>(initialLayout);
  const sortOption = sortByTab[tab];

  const changeLayout = (next: HubLayout) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* storage blocked */
    }
  };

  const loadGlobal = useCallback(async (showSkeleton: boolean) => {
    if (showSkeleton) setGlobalStatus('loading');
    setIsRefreshing(true);
    try {
      // Local cards only stand in when the shared database is unreachable.
      setGlobalItems(await fetchGlobalHubDossiers(savedProfilesRef.current));
      lastGlobalFetchRef.current = Date.now();
    } catch (err) {
      console.error('Failed to load the global hub:', err);
    } finally {
      setGlobalStatus('ready');
      setIsRefreshing(false);
    }
  }, []);

  // A card rated after the last fetch makes the global list stale, so it shows up straight away.
  const newestRatedMs = useMemo(() => Math.max(0, ...savedProfiles.map(ratedAtMs)), [savedProfiles]);

  useEffect(() => {
    if (!isActive || tab !== 'global') return;
    const stale = Date.now() - lastGlobalFetchRef.current > GLOBAL_STALE_MS || newestRatedMs > lastGlobalFetchRef.current;
    if (globalStatus === 'idle') loadGlobal(true);
    else if (globalStatus === 'ready' && stale) loadGlobal(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, tab, newestRatedMs]);

  // "/" jumps to the search, as in most libraries, unless the user is already typing somewhere.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive]);

  const mineItems = useMemo<GlobalHubDossierItem[]>(() => savedProfiles.map((profile) => ({ profile, isCurrentRating: false })), [savedProfiles]);
  const savedKeys = useMemo(() => new Set(savedProfiles.map(getCardKey)), [savedProfiles]);
  const libraryOrder = useMemo(() => new Map(savedProfiles.map((p, i) => [getCardKey(p), i] as const)), [savedProfiles]);

  const items = tab === 'mine' ? mineItems : globalItems;

  // Each player's versions in this tab, so a card can link to his other eras. In the global hub an
  // older current rating isn't a version of its own, just an earlier reading of current form.
  const versionsByPlayer = useMemo(() => {
    const map = new Map<string, PlayerProfile[]>();
    for (const { profile, isCurrentRating } of items) {
      if (tab === 'global' && !isCurrentRating && !isPrimeCard(profile)) continue;
      const key = playerKey(profile);
      map.set(key, [...(map.get(key) ?? []), profile]);
    }
    for (const versions of map.values()) versions.sort(compareVersions);
    return map;
  }, [items, tab]);
  const isLoading = tab === 'global' && globalStatus !== 'ready';

  /** One plain sentence about the collection. */
  const standfirst = useMemo(() => {
    const players = new Set(items.map((i) => playerKey(i.profile))).size;
    if (tab === 'mine') {
      if (items.length === 0) return 'Players you scout or open are kept here, on this device.';
      const revisions = items.filter((i) => i.profile.revision).length;
      const revisionNote = revisions ? `, ${plural(revisions, 'of them your own revision', 'of them your own revisions')}` : '';
      return `${plural(items.length, 'card')} on ${plural(players, 'player')} you've scouted or opened${revisionNote}, kept on this device.`;
    }
    if (isLoading) return 'Every shared card on Futbolpedia, one version of a player each.';
    if (items.length === 0) return 'Every shared card on Futbolpedia appears here once a player is scouted.';
    const latest = items
      .map((i) => i.profile.evaluationDate)
      .filter(Boolean)
      .sort()
      .reverse()[0];
    return `${plural(items.length, 'card')} on ${plural(players, 'player')}${latest ? `, the latest rated on ${dayInWords(latest)}` : ''}.`;
  }, [items, tab, isLoading]);

  const filtersActive = searchQuery.trim() !== '' || editionFilter !== 'all' || positionFilter !== 'all' || minTierFilter > 0;

  const resetFilters = () => {
    setSearchQuery('');
    setEditionFilter('all');
    setPositionFilter('all');
    setMinTierFilter(0);
  };

  const filteredItems = useMemo(() => {
    let result = [...items];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((item) => {
        const p = item.profile;
        return [
          p.basicInfo.name,
          p.basicInfo.club,
          p.basicInfo.nationality,
          p.basicInfo.position,
          p.playstyleAndRole?.playstyle?.archetype || '',
          p.version?.label || '',
          p.version?.seasonOrEra || '',
          p.version?.qualifier ? `${p.version.qualifier} ${formatEraQualifier(p.version.qualifier)} era` : '',
        ]
          .join(' ')
          .toLowerCase()
          .includes(q);
      });
    }

    if (editionFilter !== 'all') result = result.filter((i) => matchesEdition(i.profile, editionFilter));

    if (positionFilter !== 'all') {
      const keywords = POSITION_FILTER_KEYWORDS[positionFilter];
      result = result.filter((i) => {
        const pos = i.profile.basicInfo.position.toLowerCase();
        return keywords.some((k) => pos.includes(k));
      });
    }

    if (minTierFilter > 0) result = result.filter((i) => i.profile.ratings.overall >= minTierFilter);

    result.sort((a, b) => {
      if (sortOption === 'overall_desc') {
        if (a.isCurrentRating && !b.isCurrentRating && a.profile.ratings.overall === b.profile.ratings.overall) return -1;
        return b.profile.ratings.overall - a.profile.ratings.overall;
      }
      if (sortOption === 'recent') {
        // Your dossiers are newest-last in the order they joined, so a card Scout just served from
        // the shared store comes first even though it was rated earlier.
        return tab === 'mine'
          ? (libraryOrder.get(getCardKey(b.profile)) ?? -1) - (libraryOrder.get(getCardKey(a.profile)) ?? -1)
          : ratedAtMs(b.profile) - ratedAtMs(a.profile);
      }
      if (sortOption === 'name_asc') return playerKey(a.profile).localeCompare(playerKey(b.profile)) || compareVersions(a.profile, b.profile);
      if (sortOption === 'trajectory_desc') return (b.trajectoryDiff ?? -999) - (a.trajectoryDiff ?? -999);
      return 0;
    });

    return result;
  }, [items, tab, libraryOrder, searchQuery, editionFilter, positionFilter, minTierFilter, sortOption]);

  // Ordered by rating, the cards fall into chapters by tier band.
  const sections = useMemo(() => {
    if (sortOption !== 'overall_desc') return [{ id: 'all', tier: null as (typeof RATING_TIERS)[number] | null, items: filteredItems }];
    const byTier = new Map<string, GlobalHubDossierItem[]>();
    for (const item of filteredItems) {
      const tier = getTierDefinition(Math.round(item.profile.ratings.overall));
      byTier.set(tier.id, [...(byTier.get(tier.id) ?? []), item]);
    }
    return RATING_TIERS.filter((t) => byTier.has(t.id)).map((tier) => ({ id: tier.id, tier, items: byTier.get(tier.id)! }));
  }, [filteredItems, sortOption]);

  const tabs: Array<{ id: HubTab; label: string; count?: number }> = [
    { id: 'global', label: 'Global hub', count: globalStatus === 'ready' ? globalItems.length : undefined },
    { id: 'mine', label: 'Your dossiers', count: savedProfiles.length },
  ];
  const tabIndicator = useSlidingIndicator<HubTab>(tab);
  const editionIndicator = useSlidingIndicator<EditionFilter>(editionFilter);
  const layoutIndicator = useSlidingIndicator<HubLayout>(layout);

  // A search that found nothing is usually a player nobody has rated yet.
  const scoutQuery = searchQuery.trim().length >= 2 ? searchQuery.trim() : '';
  // Re-run the entrance when the view changes shape, not on every keystroke of a search.
  const viewKey = `${tab}|${editionFilter}|${positionFilter}|${minTierFilter}|${sortOption}|${layout}`;
  const ranked = sortOption === 'overall_desc' && layout === 'list';

  let entryIndex = 0;
  const renderEntry = (item: GlobalHubDossierItem) => {
    const cardKey = getCardKey(item.profile);
    const index = entryIndex++;
    const props = {
      item,
      tab,
      rank: ranked ? index + 1 : undefined,
      isSelected: cardKey === activeCardKey,
      isSaved: savedKeys.has(cardKey),
      otherVersions: (versionsByPlayer.get(playerKey(item.profile)) ?? []).filter((v) => getCardKey(v) !== cardKey),
      enterIndex: index < ANIMATED_ENTRIES ? index : undefined,
      showTier: sortOption !== 'overall_desc',
      onOpen: () => onSelectDossier(item.profile, tab),
      onOpenVersion: (version: PlayerProfile) => onSelectDossier(version, tab),
      onAsk: () => onAskAbout(item.profile, tab),
      onShowAllVersions: () => {
        setEditionFilter('all');
        setSearchQuery(item.profile.basicInfo.name);
      },
      onRename: tab === 'mine' ? (name: string) => onRenameDossier(cardKey, name) : undefined,
      onDelete: tab === 'mine' ? () => onDeleteDossier(cardKey) : undefined,
    };
    return layout === 'grid' ? <HubCard key={cardKey} {...props} /> : <HubRow key={cardKey} {...props} />;
  };

  const toolbarButtonRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60';

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]">
      {/* Masthead */}
      <header className="max-w-6xl mx-auto px-5 md:px-8 pt-8 md:pt-12">
        <div className="flex items-end justify-between gap-6">
          <div className="min-w-0">
            <h2 className="font-serif font-bold text-[40px] md:text-[56px] leading-[0.95] tracking-[-0.03em] text-charcoal dark:text-cream-50">Dossiers</h2>
            <p className="mt-3 max-w-xl text-[14.5px] leading-relaxed text-charcoal/60 dark:text-cream-400 [text-wrap:pretty]">{standfirst}</p>
          </div>
          {tab === 'global' && (
            <button
              onClick={() => loadGlobal(false)}
              disabled={isRefreshing}
              className={`shrink-0 grid place-items-center w-10 h-10 rounded-full text-charcoal/50 dark:text-cream-400 hover:text-charcoal dark:hover:text-cream-50 hover:bg-charcoal/[0.05] dark:hover:bg-white/[0.06] transition-[background-color,color,transform] duration-150 active:scale-[0.94] disabled:opacity-60 ${toolbarButtonRing}`}
              title="Refresh the global hub"
              aria-label="Refresh the global hub"
            >
              <span aria-hidden="true" className={`material-symbols-outlined text-[20px] block ${isRefreshing ? 'animate-spin' : ''}`}>
                refresh
              </span>
            </button>
          )}
        </div>

        <div className="flex items-end gap-4 mt-8 border-b border-charcoal/[0.1] dark:border-white/[0.08]">
        <div role="tablist" aria-label="Dossier collections" className="relative flex gap-5 md:gap-7 min-w-0">
          {tabs.map(({ id, label, count }) => {
            const selected = tab === id;
            return (
              <button
                key={id}
                ref={tabIndicator.register(id)}
                role="tab"
                aria-selected={selected}
                onClick={() => onTabChange(id)}
                className={`relative flex items-baseline gap-1.5 md:gap-2 whitespace-nowrap pb-3.5 pt-1 text-[14.5px] md:text-[15px] font-sans font-medium transition-colors duration-200 rounded-sm ${toolbarButtonRing} ${
                  selected ? 'text-charcoal dark:text-cream-50' : 'text-charcoal/45 dark:text-cream-400/70 hover:text-charcoal/80 dark:hover:text-cream-200'
                }`}
              >
                {label}
                {count != null && (
                  <span className={`font-mono text-[11px] [font-variant-numeric:tabular-nums] transition-colors duration-200 ${selected ? 'text-charcoal/50 dark:text-cream-400' : 'text-charcoal/30 dark:text-cream-400/50'}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
          <span
            aria-hidden="true"
            style={tabIndicator.style}
            className="absolute left-0 -bottom-px h-[2px] rounded-full bg-charcoal dark:bg-cream-50 transition-[transform,width] duration-[420ms] ease-out-expo"
          />
        </div>
        <div className="ml-auto pb-2">
            <div className="relative shrink-0 self-center -mt-1 flex items-center p-0.5 rounded-lg" role="group" aria-label="Layout">
            <span
              aria-hidden="true"
              style={layoutIndicator.style}
              className="absolute left-0 top-0.5 bottom-0.5 rounded-md bg-charcoal/[0.07] dark:bg-white/[0.09] transition-[transform,width] duration-300 ease-out-expo"
            />
            {(
              [
                { id: 'grid', icon: 'grid_view', label: 'Cards' },
                { id: 'list', icon: 'view_list', label: 'List' },
              ] as const
            ).map(({ id, icon, label }) => (
              <button
                key={id}
                ref={layoutIndicator.register(id)}
                onClick={() => changeLayout(id)}
                aria-pressed={layout === id}
                aria-label={`Show as ${label.toLowerCase()}`}
                title={label}
                className={`relative grid place-items-center w-8 h-8 rounded-md transition-colors duration-150 ${toolbarButtonRing} ${
                  layout === id ? 'text-charcoal dark:text-cream-50' : 'text-charcoal/40 dark:text-cream-400/60 hover:text-charcoal/70 dark:hover:text-cream-200'
                }`}
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[19px]">{icon}</span>
              </button>
            ))}
          </div>
        </div>
        </div>
      </header>

      {/* Search and filters stay pinned while the cards scroll */}
      <div className="sticky top-0 z-20 bg-cream-200/85 dark:bg-charcoal/85 backdrop-blur-md backdrop-saturate-150 border-b border-charcoal/[0.06] dark:border-white/[0.05]">
        <div className="max-w-6xl mx-auto px-5 md:px-8 py-3 flex flex-col lg:flex-row lg:items-center gap-2.5">
          <div className="flex items-center lg:contents">
            <label className="relative flex-1 lg:flex-none lg:w-64 group/search">
              <span aria-hidden="true" className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[19px] text-charcoal/35 dark:text-cream-400/60 group-focus-within/search:text-charcoal/70 dark:group-focus-within/search:text-cream-200 transition-colors">
                search
              </span>
              <input
                ref={searchRef}
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearchQuery('');
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Search players, clubs, roles"
                aria-label="Search dossiers"
                className="w-full h-9 pl-9 pr-9 text-[13.5px] font-sans rounded-lg bg-cream-50/80 dark:bg-white/[0.04] border border-charcoal/[0.1] dark:border-white/[0.08] text-charcoal dark:text-cream-50 placeholder:text-charcoal/40 dark:placeholder:text-cream-400/50 hover:border-charcoal/20 dark:hover:border-white/15 focus:outline-none focus:border-charcoal/30 dark:focus:border-white/25 focus:bg-cream-50 dark:focus:bg-white/[0.06] focus:ring-4 focus:ring-charcoal/[0.04] dark:focus:ring-white/[0.04] transition-[border-color,background-color,box-shadow] duration-150 [&::-webkit-search-cancel-button]:appearance-none"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    searchRef.current?.focus();
                  }}
                  className={`absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center w-6 h-6 rounded-md text-charcoal/40 hover:text-charcoal dark:text-cream-400/70 dark:hover:text-cream-50 hover:bg-charcoal/[0.06] dark:hover:bg-white/[0.08] transition-colors ${toolbarButtonRing}`}
                  aria-label="Clear search"
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[16px]">close</span>
                </button>
              ) : (
                <kbd className="hidden md:grid absolute right-2 top-1/2 -translate-y-1/2 place-items-center w-5 h-5 rounded border border-charcoal/15 dark:border-white/15 font-mono text-[10.5px] text-charcoal/40 dark:text-cream-400/60">
                  /
                </kbd>
              )}
            </label>

          </div>

          <div className="-mx-5 px-5 lg:mx-0 lg:px-0 flex items-center gap-2 overflow-x-auto scrollbar-hide lg:flex-1 lg:overflow-visible">
            <div className="relative shrink-0 flex items-center" role="group" aria-label="Version">
              <span
                aria-hidden="true"
                style={editionIndicator.style}
                className="absolute left-0 inset-y-0 rounded-lg bg-cream-50 dark:bg-white/[0.08] border border-charcoal/[0.1] dark:border-white/[0.08] shadow-[0_1px_2px_rgba(26,31,46,0.06)] transition-[transform,width] duration-300 ease-out-expo"
              />
              {EDITION_OPTIONS.map(({ id, label, dot }) => (
                <button
                  key={id}
                  ref={editionIndicator.register(id)}
                  onClick={() => setEditionFilter(id)}
                  aria-pressed={editionFilter === id}
                  className={`relative flex items-center gap-2 h-9 px-3 rounded-lg text-[13px] font-sans transition-colors duration-150 ${toolbarButtonRing} ${
                    editionFilter === id ? 'text-charcoal dark:text-cream-50 font-medium' : 'text-charcoal/50 dark:text-cream-400/70 hover:text-charcoal/80 dark:hover:text-cream-200'
                  }`}
                >
                  {dot && <span aria-hidden="true" className={`w-[6px] h-[6px] rotate-45 rounded-[1px] ${dot} ${editionFilter === id || editionFilter === 'all' ? '' : 'opacity-50'}`} />}
                  {label}
                </button>
              ))}
            </div>

            <span aria-hidden="true" className="shrink-0 w-px h-5 mx-1 bg-charcoal/10 dark:bg-white/10" />

            <div className="flex items-center gap-2 lg:ml-auto">
              <SelectMenu<PositionFilter> label="Position" value={positionFilter} options={POSITION_OPTIONS} onChange={setPositionFilter} />
              <SelectMenu<number> label="Rating" value={minTierFilter} options={RATING_OPTIONS} onChange={setMinTierFilter} />
              <SelectMenu
                label="Sort"
                showLabel
                align="end"
                value={sortOption}
                options={SORT_OPTIONS.filter((o) => !o.globalOnly || tab === 'global')}
                onChange={(value) => setSortByTab((prev) => ({ ...prev, [tab]: value }))}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-5 md:px-8 pb-24">
        {filtersActive && !isLoading && items.length > 0 && (
          <div className="flex items-center gap-3 pt-5 text-[13px] text-charcoal/60 dark:text-cream-400 motion-safe:animate-fade-in" aria-live="polite">
            <span>
              {filteredItems.length === 0
                ? 'Nothing matches.'
                : `${filteredItems.length.toLocaleString('en-GB')} of ${plural(items.length, 'card')} ${filteredItems.length === 1 ? 'matches' : 'match'}.`}
            </span>
            <button onClick={resetFilters} className={`font-medium text-charcoal dark:text-cream-100 underline decoration-charcoal/25 dark:decoration-white/25 underline-offset-[3px] hover:decoration-current transition-[text-decoration-color] rounded-sm ${toolbarButtonRing}`}>
              Clear filters
            </button>
          </div>
        )}

        {isLoading ? (
          <Skeleton layout={layout} />
        ) : tab === 'mine' && items.length === 0 ? (
          <EmptyState icon="folder_open" title="No dossiers yet" body="Scout a player and his card lands here. Any card you open from the global hub is kept here too.">
            <button onClick={() => onScout()} className={primaryButton}>
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">person_search</span>
              Scout a player
            </button>
            <button onClick={() => onTabChange('global')} className={secondaryButton}>
              Browse the global hub
            </button>
          </EmptyState>
        ) : filteredItems.length === 0 ? (
          <EmptyState
            icon={scoutQuery ? 'person_search' : 'filter_alt_off'}
            title={items.length === 0 ? 'No shared cards yet' : scoutQuery ? `No card for “${scoutQuery}”` : 'No dossiers match'}
            body={
              items.length === 0
                ? 'Cards appear here once players are scouted.'
                : scoutQuery
                  ? 'Nobody has scouted him yet. Scout him and his card lands here for everyone.'
                  : 'Try a broader filter, or clear them all.'
            }
          >
            {scoutQuery && (
              <button onClick={() => onScout(scoutQuery)} className={primaryButton}>
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">person_search</span>
                Scout {scoutQuery}
              </button>
            )}
            {filtersActive && (
              <button onClick={resetFilters} className={secondaryButton}>
                Clear filters
              </button>
            )}
          </EmptyState>
        ) : (
          <div key={viewKey}>
            {sections.map(({ id, tier, items: sectionItems }) => (
              <section key={id} aria-labelledby={tier ? `tier-${id}` : undefined} className={tier ? 'pt-10 md:pt-14 first:pt-8' : 'pt-6'}>
                {tier && (
                  <header className="flex items-baseline gap-3 md:gap-4 pb-3 mb-5 border-b border-charcoal/[0.12] dark:border-white/[0.1]">
                    <h3 id={`tier-${id}`} className="font-serif font-bold text-[24px] md:text-[30px] leading-none tracking-[-0.02em] text-charcoal dark:text-cream-50">
                      {tier.label}
                    </h3>
                    <span className="font-mono text-[12px] text-charcoal/40 dark:text-cream-400/60 [font-variant-numeric:tabular-nums]">
                      {tier.min === tier.max ? tier.min : `${tier.min}–${tier.max}`}
                    </span>
                    <span className="ml-auto text-[12.5px] text-charcoal/45 dark:text-cream-400/70 [font-variant-numeric:tabular-nums]">
                      {plural(sectionItems.length, 'card')}
                    </span>
                  </header>
                )}
                {layout === 'grid' ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18.5rem),1fr))] gap-4 md:gap-5">{sectionItems.map(renderEntry)}</div>
                ) : (
                  <div className={`divide-y divide-charcoal/[0.06] dark:divide-white/[0.05] ${tier ? '-mt-2' : ''}`}>{sectionItems.map(renderEntry)}</div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
