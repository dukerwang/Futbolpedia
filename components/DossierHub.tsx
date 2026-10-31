import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { PlayerProfile } from '../types';
import {
  fetchGlobalHubDossiers,
  type GlobalHubDossierItem,
  getCardKey,
  isPrimeCard,
  shareDossierCard,
} from '../services/geminiService';
import { cardEdition, compareVersions, formatEraQualifier } from '../services/dossierStore';
import { getAttributeLabel, getShortTierLabel } from '../constants/ratingTiers';
import { describeCardEdition, pillClass, PILL_ICON_CLASS, shortEditionLabel } from './pills';

/** "mine" is the user's own dossiers (localStorage); "global" is every shared card in Supabase. */
export type HubTab = 'mine' | 'global';

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
  onStartChat: () => void;
}

type EditionFilter = 'all' | 'current' | 'prime' | 'era' | 'season';
type PositionFilter = 'all' | 'forward' | 'midfield' | 'defender' | 'goalkeeper';
type SortOption = 'overall_desc' | 'recent' | 'name_asc' | 'trajectory_desc';

/** A background refetch of the global tab runs when it's re-entered after this long. */
const GLOBAL_STALE_MS = 2 * 60 * 1000;

const EDITION_OPTIONS: Array<{ id: EditionFilter; label: string; activeClass: string }> = [
  { id: 'all', label: 'All', activeClass: 'bg-white dark:bg-charcoal text-charcoal dark:text-cream-50 shadow-xs' },
  { id: 'current', label: 'Current', activeClass: 'bg-emerald-600 text-white shadow-xs' },
  { id: 'prime', label: 'Prime', activeClass: 'bg-amber-600 text-white shadow-xs' },
  { id: 'era', label: 'Eras', activeClass: 'bg-blue-600 text-white shadow-xs' },
  { id: 'season', label: 'Seasons', activeClass: 'bg-amber-600 text-white shadow-xs' },
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

/** At most this many of a player's other versions show as chips on a card. */
const MAX_VERSION_CHIPS = 3;

const SORT_OPTIONS: Array<{ id: SortOption; label: string; globalOnly?: boolean }> = [
  { id: 'recent', label: 'Most recent' },
  { id: 'overall_desc', label: 'Rating (high to low)' },
  { id: 'name_asc', label: 'Name (A–Z)' },
  { id: 'trajectory_desc', label: 'Biggest risers', globalOnly: true },
];

/** Substrings of a lowercased position that put a card in each position filter. */
const POSITION_FILTER_KEYWORDS: Record<Exclude<PositionFilter, 'all'>, string[]> = {
  forward: ['striker', 'forward', 'winger', 'st', 'cf'],
  midfield: ['midfielder', 'cm', 'cdm', 'cam'],
  defender: ['back', 'cb', 'lb', 'rb', 'libero'],
  goalkeeper: ['goalkeeper', 'gk'],
};

const SELECT_CLASS =
  'shrink-0 px-2.5 py-1.5 text-xs font-sans rounded-lg bg-cream-100 dark:bg-charcoal-surface border border-cream-300 dark:border-charcoal-border text-charcoal dark:text-cream-50 focus:outline-none focus:ring-1 focus:ring-emerald-500';

const formatPosition = (pos: string): string => {
  if (!pos) return 'N/A';
  return pos.split('/')[0].trim();
};

const playerKey = (p: PlayerProfile) => getCardKey(p).split(':')[0];

/** When the card was added to the user's dossiers, else when it was rated. */
const recencyKey = (p: PlayerProfile, tab: HubTab): string =>
  tab === 'mine' && p.createdAt
    ? new Date(p.createdAt).toISOString()
    : p.evaluationDate || p.version?.evaluationDate || '';

const Dot = () => <span className="w-1 h-1 rounded-full bg-charcoal/20 dark:bg-cream-400/20 shrink-0" />;

interface DossierCardProps {
  item: GlobalHubDossierItem;
  tab: HubTab;
  isSelected: boolean;
  isSaved: boolean;
  /** The player's other cards in this tab (current form, prime, eras, seasons), in version order. */
  otherVersions: PlayerProfile[];
  onOpen: () => void;
  onOpenVersion: (profile: PlayerProfile) => void;
  onShowAllVersions: () => void;
  onAsk: () => void;
  onRename?: (newName: string) => void;
  onDelete?: () => void;
}

const DossierCard: React.FC<DossierCardProps> = ({
  item,
  tab,
  isSelected,
  isSaved,
  otherVersions,
  onOpen,
  onOpenVersion,
  onShowAllVersions,
  onAsk,
  onRename,
  onDelete,
}) => {
  const { profile, isCurrentRating, trajectoryDiff, previousRatingDate } = item;
  const [shareState, setShareState] = useState<'idle' | 'saving' | 'copied'>('idle');
  const [isEditing, setIsEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  const edition = describeCardEdition(profile);
  // In the global registry an older current card is shown as an earlier rating of that player.
  const isEarlierRating = tab === 'global' && !isCurrentRating && !isPrimeCard(profile);

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (shareState === 'saving') return;
    setShareState('saving');
    try {
      const slug = await shareDossierCard(profile);
      await navigator.clipboard.writeText(`${window.location.origin}/#/p/${slug}`);
      setShareState('copied');
      setTimeout(() => setShareState('idle'), 2000);
    } catch (err) {
      console.error('Share failed:', err);
      setShareState('idle');
      if (err instanceof Error) window.alert(err.message);
    }
  };

  const handleSaveRename = (e: React.FormEvent) => {
    e.preventDefault();
    if (nameDraft.trim() && onRename) onRename(nameDraft.trim());
    setIsEditing(false);
  };

  const iconButton =
    'p-1.5 rounded-md transition-colors text-charcoal/50 dark:text-cream-400/70 hover:bg-cream-200 dark:hover:bg-charcoal-light';

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      onClick={() => !isEditing && onOpen()}
      onKeyDown={(e) => {
        if (!isEditing && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group relative flex flex-col justify-between p-5 rounded-2xl bg-white dark:bg-charcoal-surface border shadow-sm hover:shadow-md transition-[border-color,box-shadow] duration-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
        isSelected
          ? 'border-emerald-500 ring-1 ring-emerald-500/40'
          : 'border-cream-300/80 dark:border-charcoal-border hover:border-emerald-500/50'
      }`}
    >
      <div>
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <span className={pillClass(isEarlierRating ? 'neutral' : edition.tone, 'sm')} title={edition.title}>
            <span className={PILL_ICON_CLASS}>{isEarlierRating ? 'history' : edition.icon}</span>
            {isEarlierRating ? edition.label.replace('Current form', 'Earlier rating') : edition.label}
          </span>
          {profile.revision && (
            <span className={pillClass('indigo', 'sm')} title="Your accepted challenge of the shared card">
              Your revision
            </span>
          )}
        </div>

        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0 flex-1 pt-0.5">
            {isEditing ? (
              <form onSubmit={handleSaveRename} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
                <input
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setIsEditing(false)}
                  autoFocus
                  aria-label="Dossier name"
                  className="min-w-0 flex-1 px-2.5 py-1 text-base font-serif font-bold bg-cream-100 dark:bg-charcoal border border-emerald-500/50 rounded-md focus:outline-none focus:ring-1 focus:ring-emerald-500 text-charcoal dark:text-cream-50"
                />
                <button type="submit" className="p-1 text-emerald-600 hover:text-emerald-500" title="Save name">
                  <span className="material-symbols-outlined text-[18px] block">check</span>
                </button>
                <button type="button" onClick={() => setIsEditing(false)} className="p-1 text-red-500 hover:text-red-400" title="Cancel">
                  <span className="material-symbols-outlined text-[18px] block">close</span>
                </button>
              </form>
            ) : (
              <h3 className="text-lg font-serif font-bold text-charcoal dark:text-cream-50 leading-tight truncate group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                {profile.basicInfo.name}
              </h3>
            )}
            {profile.playstyleAndRole?.playstyle?.archetype && (
              <p className="text-xs font-serif italic text-emerald-600 dark:text-emerald-400 mt-0.5 line-clamp-1">
                {profile.playstyleAndRole.playstyle.archetype}
              </p>
            )}
          </div>

          <div className="flex flex-col items-end text-right shrink-0">
            <span className="whitespace-nowrap text-[10px] leading-tight font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-widest mb-1.5">
              {getShortTierLabel(profile.ratings.overall)}
            </span>
            <span
              className={`text-2xl font-mono font-bold leading-none ${
                profile.ratings.overall >= 90 ? 'text-emerald-600 dark:text-emerald-400' : 'text-charcoal dark:text-cream-50'
              }`}
            >
              {profile.ratings.overall}
            </span>
            <span className="text-[8px] font-bold text-charcoal/40 dark:text-cream-400 uppercase tracking-wider mt-1">OVR</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-charcoal/60 dark:text-cream-400 mb-3">
          <span className="font-semibold text-charcoal dark:text-cream-200">{formatPosition(profile.basicInfo.position)}</span>
          <Dot />
          <span className="truncate max-w-[140px]">{profile.basicInfo.club}</span>
          <Dot />
          <span>{profile.basicInfo.nationality}</span>
          {profile.basicInfo.age != null && (
            <>
              <Dot />
              <span>Age {profile.basicInfo.age}</span>
            </>
          )}
        </div>

        {profile.version?.peakContext && (
          <p className="mb-3 text-xs font-serif italic text-charcoal/70 dark:text-cream-300 leading-snug line-clamp-2">
            {profile.version.peakContext}
          </p>
        )}

        {typeof trajectoryDiff === 'number' && trajectoryDiff !== 0 && (
          <div className="flex items-center gap-1.5 text-[11px] font-sans mb-3">
            <span className={pillClass(trajectoryDiff > 0 ? 'emerald' : 'red', 'xs')}>
              {trajectoryDiff > 0 ? `+${trajectoryDiff}` : trajectoryDiff} OVR
            </span>
            <span className="text-charcoal/40 dark:text-cream-400">vs {previousRatingDate} evaluation</span>
          </div>
        )}

        {profile.signatureSpikes && profile.signatureSpikes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {profile.signatureSpikes.slice(0, 3).map((spike) => (
              <span key={spike} className={pillClass('neutral', 'xs')}>
                {getAttributeLabel(spike)}
              </span>
            ))}
          </div>
        )}

        {otherVersions.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-sans font-semibold uppercase tracking-wider text-charcoal/40 dark:text-cream-400/60 mr-0.5">
              Also
            </span>
            {otherVersions.slice(0, MAX_VERSION_CHIPS).map((version) => {
              const versionEdition = describeCardEdition(version);
              return (
                <button
                  key={getCardKey(version)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenVersion(version);
                  }}
                  className={`${pillClass(versionEdition.tone, 'xs')} hover:brightness-95 dark:hover:brightness-125 transition`}
                  title={`Open ${versionEdition.label}`}
                >
                  <span className="max-w-[9rem] truncate">{shortEditionLabel(version)}</span>
                  <span className="font-mono font-bold">{version.ratings.overall}</span>
                </button>
              );
            })}
            {otherVersions.length > MAX_VERSION_CHIPS && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onShowAllVersions();
                }}
                className="text-[10px] font-sans font-semibold text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                +{otherVersions.length - MAX_VERSION_CHIPS} more
              </button>
            )}
          </div>
        )}
      </div>

      <div className="pt-3 mt-4 border-t border-cream-200 dark:border-charcoal-border flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-[11px] font-sans font-semibold text-emerald-600 dark:text-emerald-400">
          {isSelected ? 'Open in panel' : 'Open dossier'}
          <span className="material-symbols-outlined text-[14px] group-hover:translate-x-0.5 transition-transform">arrow_forward</span>
          {tab === 'global' && isSaved && (
            <span className="ml-1 flex items-center gap-0.5 font-medium text-charcoal/40 dark:text-cream-400/70" title="In your dossiers">
              <span className="material-symbols-outlined text-[14px]">bookmark_added</span>
              Saved
            </span>
          )}
        </span>

        <div className="flex items-center gap-0.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAsk();
            }}
            className="mr-1 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-sans font-semibold text-charcoal/70 dark:text-cream-300 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-500/10 transition-colors"
            title={`Ask about ${profile.basicInfo.name} in chat`}
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[16px]">chat_bubble</span>
            Ask
          </button>
          <button
            onClick={handleShare}
            className={`${iconButton} ${shareState === 'copied' ? '!text-emerald-600 dark:!text-emerald-400' : 'hover:text-emerald-600 dark:hover:text-emerald-400'}`}
            title={shareState === 'copied' ? 'Link copied' : 'Copy share link'}
          >
            <span className="material-symbols-outlined text-[16px] block">
              {shareState === 'saving' ? 'hourglass_empty' : shareState === 'copied' ? 'check' : 'link'}
            </span>
          </button>
          {onRename && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setNameDraft(profile.basicInfo.name);
                setIsEditing(true);
              }}
              className={`${iconButton} hover:text-emerald-600 dark:hover:text-emerald-400`}
              title="Rename"
            >
              <span className="material-symbols-outlined text-[16px] block">edit</span>
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (confirmDelete) onDelete();
                else setConfirmDelete(true);
              }}
              className={
                confirmDelete
                  ? 'px-2 py-1 rounded-md bg-red-500/10 text-red-600 border border-red-500/30 hover:bg-red-500 hover:text-white transition-colors text-[10px] font-sans font-bold uppercase tracking-wider'
                  : `${iconButton} hover:text-red-500`
              }
              title={confirmDelete ? 'Click again to remove' : 'Remove from your dossiers'}
            >
              {confirmDelete ? 'Remove' : <span className="material-symbols-outlined text-[16px] block">delete</span>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * The dossier library as a main view: "Your dossiers" (cards this browser has generated or
 * opened) and the global hub (every shared card) as tabs over one card grid and one set of filters.
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
  onStartChat,
}) => {
  const [globalItems, setGlobalItems] = useState<GlobalHubDossierItem[]>([]);
  const [globalStatus, setGlobalStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const lastGlobalFetchRef = useRef(0);
  const savedProfilesRef = useRef(savedProfiles);
  savedProfilesRef.current = savedProfiles;

  const [searchQuery, setSearchQuery] = useState('');
  const [editionFilter, setEditionFilter] = useState<EditionFilter>('all');
  const [positionFilter, setPositionFilter] = useState<PositionFilter>('all');
  const [minTierFilter, setMinTierFilter] = useState<number>(0);
  const [sortByTab, setSortByTab] = useState<Record<HubTab, SortOption>>({ mine: 'recent', global: 'overall_desc' });
  const sortOption = sortByTab[tab];

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

  useEffect(() => {
    if (!isActive || tab !== 'global') return;
    if (globalStatus === 'idle') loadGlobal(true);
    else if (globalStatus === 'ready' && Date.now() - lastGlobalFetchRef.current > GLOBAL_STALE_MS) loadGlobal(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, tab]);

  const mineItems = useMemo<GlobalHubDossierItem[]>(
    () => savedProfiles.map((profile) => ({ profile, isCurrentRating: false })),
    [savedProfiles],
  );
  const savedKeys = useMemo(() => new Set(savedProfiles.map(getCardKey)), [savedProfiles]);

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

  const summary = useMemo(() => {
    const players = new Set(items.map((i) => playerKey(i.profile))).size;
    if (tab === 'mine') {
      const revisions = items.filter((i) => i.profile.revision).length;
      return [
        `${items.length} ${items.length === 1 ? 'dossier' : 'dossiers'}`,
        `${players} ${players === 1 ? 'player' : 'players'}`,
        ...(revisions ? [`${revisions} your ${revisions === 1 ? 'revision' : 'revisions'}`] : []),
      ];
    }
    const worldClass = items.filter((i) => i.profile.ratings.overall >= 90).length;
    const eras = items.filter((i) => cardEdition(i.profile) === 'era').length;
    const latest = items.map((i) => i.profile.evaluationDate).filter(Boolean).sort().reverse()[0];
    return [
      `${items.length} cards`,
      `${players} players`,
      ...(eras ? [`${eras} ${eras === 1 ? 'era' : 'eras'}`] : []),
      `${worldClass} rated 90+`,
      ...(latest ? [`latest ${latest}`] : []),
    ];
  }, [items, tab]);

  const filtersActive =
    searchQuery.trim() !== '' || editionFilter !== 'all' || positionFilter !== 'all' || minTierFilter > 0;

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

    if (editionFilter !== 'all') {
      result = result.filter((i) => matchesEdition(i.profile, editionFilter));
    }

    if (positionFilter !== 'all') {
      const keywords = POSITION_FILTER_KEYWORDS[positionFilter];
      result = result.filter((i) => {
        const pos = i.profile.basicInfo.position.toLowerCase();
        return keywords.some((k) => pos.includes(k));
      });
    }

    if (minTierFilter > 0) {
      result = result.filter((i) => i.profile.ratings.overall >= minTierFilter);
    }

    result.sort((a, b) => {
      if (sortOption === 'overall_desc') {
        if (a.isCurrentRating && !b.isCurrentRating && a.profile.ratings.overall === b.profile.ratings.overall) return -1;
        return b.profile.ratings.overall - a.profile.ratings.overall;
      }
      if (sortOption === 'recent') {
        return recencyKey(b.profile, tab).localeCompare(recencyKey(a.profile, tab));
      }
      if (sortOption === 'name_asc') {
        return (
          playerKey(a.profile).localeCompare(playerKey(b.profile)) || compareVersions(a.profile, b.profile)
        );
      }
      if (sortOption === 'trajectory_desc') {
        return (b.trajectoryDiff ?? -999) - (a.trajectoryDiff ?? -999);
      }
      return 0;
    });

    return result;
  }, [items, tab, searchQuery, editionFilter, positionFilter, minTierFilter, sortOption]);

  const tabs: Array<{ id: HubTab; label: string; icon: string; count?: number }> = [
    { id: 'mine', label: 'Your dossiers', icon: 'folder_shared', count: savedProfiles.length },
    { id: 'global', label: 'Global hub', icon: 'public', count: globalStatus === 'ready' ? globalItems.length : undefined },
  ];

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden">
      {/* Title and tabs */}
      <div className="max-w-6xl mx-auto px-4 md:px-8 pt-6">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-2xl font-serif font-bold tracking-tight text-charcoal dark:text-cream-50">Dossiers</h2>
            <p className="text-xs text-charcoal/60 dark:text-cream-400 font-sans mt-1">
              {tab === 'mine'
                ? 'Players you have scouted or opened, kept on this device.'
                : 'Every shared card on Futbolpedia, with dated versions and rating trajectories.'}
            </p>
          </div>
          {tab === 'global' && (
            <button
              onClick={() => loadGlobal(false)}
              disabled={isRefreshing}
              className="shrink-0 p-2 rounded-lg text-charcoal/60 dark:text-cream-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-cream-300/60 dark:hover:bg-charcoal-light transition-colors disabled:opacity-60"
              title="Refresh global hub"
            >
              <span className={`material-symbols-outlined text-[20px] block ${isRefreshing ? 'animate-spin' : ''}`}>refresh</span>
            </button>
          )}
        </div>

        <div role="tablist" aria-label="Dossier collections" className="flex gap-6 mt-5 border-b border-cream-300 dark:border-charcoal-border">
          {tabs.map(({ id, label, icon, count }) => {
            const selected = tab === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={selected}
                onClick={() => onTabChange(id)}
                className={`-mb-px flex items-center gap-2 pb-3 pt-1 border-b-2 text-sm font-sans font-semibold transition-colors ${
                  selected
                    ? 'border-emerald-600 text-charcoal dark:text-cream-50'
                    : 'border-transparent text-charcoal/50 dark:text-cream-400/70 hover:text-charcoal dark:hover:text-cream-100'
                }`}
              >
                <span className={`material-symbols-outlined text-[18px] ${selected ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{icon}</span>
                {label}
                {count != null && (
                  <span
                    className={`px-1.5 py-px rounded-full text-[10px] font-mono font-bold ${
                      selected ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-cream-300/70 dark:bg-charcoal-light text-charcoal/60 dark:text-cream-400'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Search and filters stay pinned while the grid scrolls */}
      <div className="sticky top-0 z-10 bg-cream-200/95 dark:bg-charcoal/95 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-3 flex flex-col lg:flex-row lg:items-center gap-2.5">
          <div className="relative flex-1 lg:max-w-sm">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-charcoal/40 dark:text-cream-400 text-[18px]">
              search
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search player, club, nationality, role…"
              aria-label="Search dossiers"
              className="w-full pl-9 pr-8 py-2 text-xs font-sans rounded-lg bg-cream-100 dark:bg-charcoal-surface border border-cream-300 dark:border-charcoal-border text-charcoal dark:text-cream-50 placeholder-charcoal/40 dark:placeholder-cream-400/50 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-charcoal/40 hover:text-charcoal dark:text-cream-400"
                title="Clear search"
              >
                <span className="material-symbols-outlined text-[16px] block">close</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide lg:ml-auto">
            <div className="shrink-0 flex items-center p-0.5 rounded-lg bg-cream-300/60 dark:bg-charcoal-light/50 border border-cream-300 dark:border-charcoal-border text-[11px] font-sans font-semibold">
              {EDITION_OPTIONS.map(({ id, label, activeClass }) => (
                <button
                  key={id}
                  onClick={() => setEditionFilter(id)}
                  className={`px-2.5 py-1 rounded-md transition-colors ${
                    editionFilter === id ? activeClass : 'text-charcoal/60 dark:text-cream-400 hover:text-charcoal dark:hover:text-cream-100'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <select
              value={positionFilter}
              onChange={(e) => setPositionFilter(e.target.value as PositionFilter)}
              className={SELECT_CLASS}
              aria-label="Position"
            >
              <option value="all">All positions</option>
              <option value="forward">Attackers</option>
              <option value="midfield">Midfielders</option>
              <option value="defender">Defenders</option>
              <option value="goalkeeper">Goalkeepers</option>
            </select>

            <select
              value={minTierFilter}
              onChange={(e) => setMinTierFilter(Number(e.target.value))}
              className={SELECT_CLASS}
              aria-label="Minimum rating"
            >
              <option value={0}>Any rating</option>
              <option value={90}>90+</option>
              <option value={85}>85+</option>
              <option value={80}>80+</option>
            </select>

            <select
              value={sortOption}
              onChange={(e) => setSortByTab((prev) => ({ ...prev, [tab]: e.target.value as SortOption }))}
              className={SELECT_CLASS}
              aria-label="Sort"
            >
              {SORT_OPTIONS.filter((o) => !o.globalOnly || tab === 'global').map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="border-b border-cream-300/70 dark:border-charcoal-border/70" />
      </div>

      {/* Grid */}
      <div className="max-w-6xl mx-auto px-4 md:px-8 pt-4 pb-12">
        {!isLoading && items.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-4 text-[11px] font-mono text-charcoal/50 dark:text-cream-400/70">
            {filtersActive && (
              <>
                <span className="font-bold text-charcoal/70 dark:text-cream-300">Showing {filteredItems.length}</span>
                <span>of</span>
              </>
            )}
            {summary.map((part, i) => (
              <React.Fragment key={part}>
                {i > 0 && <Dot />}
                <span>{part}</span>
              </React.Fragment>
            ))}
            {filtersActive && (
              <button onClick={resetFilters} className="ml-1 font-sans font-semibold text-emerald-600 dark:text-emerald-400 hover:underline">
                Clear filters
              </button>
            )}
          </div>
        )}

        {isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-56 rounded-2xl bg-white/50 dark:bg-charcoal-surface/40 border border-cream-300 dark:border-charcoal-border animate-pulse"
              />
            ))}
          </div>
        ) : tab === 'mine' && items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <span className="material-symbols-outlined text-[44px] text-charcoal/25 dark:text-cream-400/30 mb-3">folder_open</span>
            <h3 className="text-base font-serif font-bold text-charcoal dark:text-cream-50">No dossiers yet</h3>
            <p className="text-xs text-charcoal/60 dark:text-cream-400 mt-1 max-w-sm leading-relaxed">
              Ask Futbolpedia to rate or scout a player and the dossier lands here. Any card you open from the global hub is kept here too.
            </p>
            <div className="flex flex-wrap justify-center gap-2 mt-5">
              <button
                onClick={onStartChat}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
              >
                <span className="material-symbols-outlined text-[16px]">chat</span>
                Scout a player
              </button>
              <button
                onClick={() => onTabChange('global')}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors"
              >
                <span className="material-symbols-outlined text-[16px]">public</span>
                Browse the global hub
              </button>
            </div>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <span className="material-symbols-outlined text-[44px] text-charcoal/25 dark:text-cream-400/30 mb-3">filter_alt_off</span>
            <h3 className="text-base font-serif font-bold text-charcoal dark:text-cream-50">
              {items.length === 0 ? 'No shared cards yet' : 'No dossiers match'}
            </h3>
            <p className="text-xs text-charcoal/60 dark:text-cream-400 mt-1 max-w-sm">
              {items.length === 0
                ? 'Cards appear here once players are rated in chat.'
                : 'Try a broader search or clear the filters.'}
            </p>
            {filtersActive && (
              <button
                onClick={resetFilters}
                className="mt-4 px-3 py-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded-lg hover:bg-emerald-500/20 transition-colors"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-4">
            {filteredItems.map((item) => {
              const cardKey = getCardKey(item.profile);
              return (
                <DossierCard
                  key={cardKey}
                  item={item}
                  tab={tab}
                  isSelected={cardKey === activeCardKey}
                  isSaved={savedKeys.has(cardKey)}
                  otherVersions={(versionsByPlayer.get(playerKey(item.profile)) ?? []).filter(
                    (v) => getCardKey(v) !== cardKey,
                  )}
                  onOpen={() => onSelectDossier(item.profile, tab)}
                  onOpenVersion={(version) => onSelectDossier(version, tab)}
                  onAsk={() => onAskAbout(item.profile, tab)}
                  onShowAllVersions={() => {
                    setEditionFilter('all');
                    setSearchQuery(item.profile.basicInfo.name);
                  }}
                  onRename={tab === 'mine' ? (name) => onRenameDossier(cardKey, name) : undefined}
                  onDelete={tab === 'mine' ? () => onDeleteDossier(cardKey) : undefined}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
