import React, { useState, useEffect, useMemo } from 'react';
import type { PlayerProfile } from '../types';
import {
  fetchGlobalHubDossiers,
  type GlobalHubDossierItem,
  getCardKey,
  isPrimeCard,
  shareDossierCard,
} from '../services/geminiService';
import { getAttributeLabel, getShortTierLabel } from '../constants/ratingTiers';
import { describeCardEdition, pillClass, PILL_ICON_CLASS, type PillTone } from './pills';

const GRADE_TONE: Record<string, PillTone> = { A: 'emerald', B: 'blue', C: 'amber' };

interface GlobalDossierHubProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectDossier: (profile: PlayerProfile) => void;
  localSavedProfiles?: PlayerProfile[];
}

type EditionFilter = 'all' | 'current' | 'prime';
type PositionFilter = 'all' | 'forward' | 'midfield' | 'defender' | 'goalkeeper';
type SortOption = 'overall_desc' | 'date_desc' | 'name_asc' | 'trajectory_desc';

const EDITION_OPTIONS: Array<{ id: EditionFilter; label: string; activeClass: string }> = [
  { id: 'all', label: 'All Cards', activeClass: 'bg-white dark:bg-charcoal text-charcoal dark:text-cream-50 shadow-xs' },
  { id: 'current', label: 'Current Ratings', activeClass: 'bg-emerald-600 text-white shadow-xs' },
  { id: 'prime', label: 'Prime Zeniths', activeClass: 'bg-amber-600 text-white shadow-xs' },
];

/** Substrings of a lowercased position that put a card in each position filter. */
const POSITION_FILTER_KEYWORDS: Record<Exclude<PositionFilter, 'all'>, string[]> = {
  forward: ['striker', 'forward', 'winger', 'st', 'cf'],
  midfield: ['midfielder', 'cm', 'cdm', 'cam'],
  defender: ['back', 'cb', 'lb', 'rb'],
  goalkeeper: ['goalkeeper', 'gk'],
};

const SELECT_CLASS =
  'px-2.5 py-1.5 text-xs font-sans rounded-lg bg-cream-100 dark:bg-charcoal-surface border border-cream-300 dark:border-charcoal-border text-charcoal dark:text-cream-50 focus:outline-none focus:ring-1 focus:ring-emerald-500';

const StatTile: React.FC<{
  icon: string;
  iconClass: string;
  label: string;
  valueClass: string;
  children: React.ReactNode;
}> = ({ icon, iconClass, label, valueClass, children }) => (
  <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-cream-50 dark:bg-charcoal-light/40 border border-cream-300/40 dark:border-charcoal-border">
    <span className={`material-symbols-outlined ${iconClass} text-[20px]`}>{icon}</span>
    <div>
      <div className="text-[10px] uppercase font-bold tracking-wider text-charcoal/40 dark:text-cream-400/60 font-mono">
        {label}
      </div>
      <div className={valueClass}>{children}</div>
    </div>
  </div>
);

const formatPosition = (pos: string): string => {
  if (!pos) return 'N/A';
  const parts = pos.split('/');
  return parts[0].trim();
};

export const GlobalDossierHub: React.FC<GlobalDossierHubProps> = ({
  isOpen,
  onClose,
  onSelectDossier,
  localSavedProfiles = [],
}) => {
  const [items, setItems] = useState<GlobalHubDossierItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [editionFilter, setEditionFilter] = useState<EditionFilter>('all');
  const [positionFilter, setPositionFilter] = useState<PositionFilter>('all');
  const [minTierFilter, setMinTierFilter] = useState<number>(0);
  const [sortOption, setSortOption] = useState<SortOption>('overall_desc');
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  const loadHubData = async () => {
    setIsLoading(true);
    try {
      const data = await fetchGlobalHubDossiers(localSavedProfiles);
      setItems(data);
    } catch (err) {
      console.error('Failed to load Global Dossier Hub:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadHubData();
    }
  }, [isOpen, localSavedProfiles.length]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const stats = useMemo(() => {
    const totalCards = items.length;
    const uniquePlayers = new Set(
      items.map((i) => getCardKey(i.profile).split(':')[0]),
    ).size;
    const worldClassCount = items.filter((i) => i.profile.ratings.overall >= 90).length;
    const latestDate = items
      .map((i) => i.profile.evaluationDate)
      .filter(Boolean)
      .sort()
      .reverse()[0] || 'N/A';

    return { totalCards, uniquePlayers, worldClassCount, latestDate };
  }, [items]);

  const filteredItems = useMemo(() => {
    let result = [...items];

    // Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((item) => {
        const p = item.profile;
        const haystack = [
          p.basicInfo.name,
          p.basicInfo.club,
          p.basicInfo.nationality,
          p.basicInfo.position,
          p.playstyleAndRole?.playstyle?.archetype || '',
          p.version?.label || '',
          p.version?.seasonOrEra || '',
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    // Edition filter
    if (editionFilter === 'current') {
      result = result.filter((i) => i.profile.version?.type === 'current');
    } else if (editionFilter === 'prime') {
      result = result.filter((i) => isPrimeCard(i.profile));
    }

    // Position filter
    if (positionFilter !== 'all') {
      const keywords = POSITION_FILTER_KEYWORDS[positionFilter];
      result = result.filter((i) => {
        const pos = i.profile.basicInfo.position.toLowerCase();
        return keywords.some((k) => pos.includes(k));
      });
    }

    // Tier filter
    if (minTierFilter > 0) {
      result = result.filter((i) => i.profile.ratings.overall >= minTierFilter);
    }

    // Sort
    result.sort((a, b) => {
      if (sortOption === 'overall_desc') {
        if (a.isCurrentRating && !b.isCurrentRating && a.profile.ratings.overall === b.profile.ratings.overall) return -1;
        return b.profile.ratings.overall - a.profile.ratings.overall;
      }
      if (sortOption === 'date_desc') {
        const dateA = a.profile.evaluationDate || '';
        const dateB = b.profile.evaluationDate || '';
        return dateB.localeCompare(dateA);
      }
      if (sortOption === 'name_asc') {
        return a.profile.basicInfo.name.localeCompare(b.profile.basicInfo.name);
      }
      if (sortOption === 'trajectory_desc') {
        const diffA = a.trajectoryDiff ?? -999;
        const diffB = b.trajectoryDiff ?? -999;
        return diffB - diffA;
      }
      return 0;
    });

    return result;
  }, [items, searchQuery, editionFilter, positionFilter, minTierFilter, sortOption]);

  const handleCopyLink = async (profile: PlayerProfile, e: React.MouseEvent) => {
    e.stopPropagation();
    const cardKey = getCardKey(profile);
    try {
      const slug = await shareDossierCard(profile);
      await navigator.clipboard.writeText(`${window.location.origin}/#/p/${slug}`);
      setCopiedSlug(cardKey);
      setTimeout(() => setCopiedSlug(null), 2000);
    } catch (err) {
      console.error('Share failed:', err);
      if (err instanceof Error) window.alert(err.message);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-cream-200/95 dark:bg-charcoal/95 backdrop-blur-md animate-fade-in overflow-hidden">
      {/* Top Navigation Bar */}
      <div className="flex-none px-6 py-4 border-b border-cream-300 dark:border-charcoal-border bg-cream-100 dark:bg-charcoal-surface">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shadow-sm">
              <span className="material-symbols-outlined text-[24px]">public</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-serif font-bold tracking-tight text-charcoal dark:text-cream-50">
                  Global Dossier Hub
                </h2>
                <span className={pillClass('emerald', 'sm')}>Public registry</span>
              </div>
              <p className="text-xs text-charcoal/60 dark:text-cream-400 font-sans mt-0.5">
                All authoritative player cards, dated versions, and historical trajectory benchmarks
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={loadHubData}
              disabled={isLoading}
              className="p-2 rounded-lg text-charcoal/60 dark:text-cream-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-cream-200 dark:hover:bg-charcoal-light transition-colors"
              title="Refresh Global Hub"
            >
              <span className={`material-symbols-outlined text-[20px] block ${isLoading ? 'animate-spin' : ''}`}>
                refresh
              </span>
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-charcoal/60 dark:text-cream-400 hover:text-red-500 hover:bg-cream-200 dark:hover:bg-charcoal-light transition-colors"
              title="Close Hub"
            >
              <span className="material-symbols-outlined text-[22px] block">close</span>
            </button>
          </div>
        </div>

        {/* Global Hub Statistics Bar */}
        <div className="max-w-7xl mx-auto mt-4 pt-4 border-t border-cream-200 dark:border-charcoal-border/60 grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile
            icon="style"
            iconClass="text-emerald-600 dark:text-emerald-400"
            label="Total Dated Cards"
            valueClass="text-lg font-mono font-bold text-charcoal dark:text-cream-50"
          >
            {stats.totalCards}
          </StatTile>
          <StatTile
            icon="group"
            iconClass="text-blue-600 dark:text-blue-400"
            label="Unique Players"
            valueClass="text-lg font-mono font-bold text-charcoal dark:text-cream-50"
          >
            {stats.uniquePlayers}
          </StatTile>
          <StatTile
            icon="stars"
            iconClass="text-amber-500"
            label="World-Class (90+)"
            valueClass="text-lg font-mono font-bold text-amber-600 dark:text-amber-400"
          >
            {stats.worldClassCount}
          </StatTile>
          <StatTile
            icon="event_available"
            iconClass="text-purple-600 dark:text-purple-400"
            label="Latest Evaluation"
            valueClass="text-sm font-mono font-bold text-charcoal dark:text-cream-50 truncate"
          >
            {stats.latestDate}
          </StatTile>
        </div>
      </div>

      {/* Search & Filters Toolbar */}
      <div className="flex-none px-6 py-3 border-b border-cream-300 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Search Input */}
          <div className="relative flex-1 max-w-md">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-charcoal/40 dark:text-cream-400 text-[18px]">
              search
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by player, club, nationality, role..."
              className="w-full pl-9 pr-8 py-2 text-xs font-sans rounded-lg bg-cream-100 dark:bg-charcoal-surface border border-cream-300 dark:border-charcoal-border text-charcoal dark:text-cream-50 placeholder-charcoal/40 dark:placeholder-cream-400/50 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-charcoal/40 hover:text-charcoal dark:text-cream-400"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            )}
          </div>

          {/* Filter Pills & Sorting */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Edition Selector */}
            <div className="flex items-center p-0.5 rounded-lg bg-cream-200 dark:bg-charcoal-light/50 border border-cream-300 dark:border-charcoal-border text-[11px] font-sans font-semibold">
              {EDITION_OPTIONS.map(({ id, label, activeClass }) => (
                <button
                  key={id}
                  onClick={() => setEditionFilter(id)}
                  className={`px-2.5 py-1 rounded-md transition-colors ${
                    editionFilter === id
                      ? activeClass
                      : 'text-charcoal/60 dark:text-cream-400 hover:text-charcoal'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Position Filter */}
            <select
              value={positionFilter}
              onChange={(e) => setPositionFilter(e.target.value as PositionFilter)}
              className={SELECT_CLASS}
            >
              <option value="all">All Positions</option>
              <option value="forward">Attackers (ST / W)</option>
              <option value="midfield">Midfielders (CM / CDM / CAM)</option>
              <option value="defender">Defenders (CB / FB)</option>
              <option value="goalkeeper">Goalkeepers (GK)</option>
            </select>

            {/* Tier Filter */}
            <select
              value={minTierFilter}
              onChange={(e) => setMinTierFilter(Number(e.target.value))}
              className={SELECT_CLASS}
            >
              <option value={0}>All Tiers</option>
              <option value={90}>World-Class (90+)</option>
              <option value={85}>Top Flight (85+)</option>
              <option value={80}>First Team (80+)</option>
            </select>

            {/* Sort Options */}
            <select
              value={sortOption}
              onChange={(e) => setSortOption(e.target.value as SortOption)}
              className={SELECT_CLASS}
            >
              <option value="overall_desc">Rating (High to Low)</option>
              <option value="date_desc">Evaluation Date (Newest)</option>
              <option value="name_asc">Player Name (A-Z)</option>
              <option value="trajectory_desc">Trajectory (+ Progression)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Main Content: Cards Grid */}
      <div className="flex-1 overflow-y-auto px-6 py-8">
        <div className="max-w-7xl mx-auto">
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-64 rounded-2xl bg-white/50 dark:bg-charcoal-surface/40 border border-cream-300 dark:border-charcoal-border animate-pulse p-6"
                />
              ))}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-80 text-center">
              <span className="material-symbols-outlined text-[48px] text-charcoal/30 dark:text-cream-400/30 mb-3">
                filter_alt_off
              </span>
              <h3 className="text-base font-serif font-bold text-charcoal dark:text-cream-50">
                No dossiers matched your criteria
              </h3>
              <p className="text-xs text-charcoal/60 dark:text-cream-400 mt-1 max-w-sm">
                Try broadening your search term, clearing position filters, or generating a fresh dated dossier in chat.
              </p>
              <button
                onClick={() => {
                  setSearchQuery('');
                  setEditionFilter('all');
                  setPositionFilter('all');
                  setMinTierFilter(0);
                }}
                className="mt-4 px-3 py-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded-lg hover:bg-emerald-500/20 transition-colors"
              >
                Reset All Filters
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredItems.map(({ profile, isCurrentRating, trajectoryDiff, previousRatingDate }) => {
                const cardKey = getCardKey(profile);
                const isPrime = isPrimeCard(profile);
                const tierLabel = getShortTierLabel(profile.ratings.overall);
                const isCopied = copiedSlug === cardKey;
                const edition = describeCardEdition(profile);

                return (
                  <div
                    key={cardKey}
                    onClick={() => {
                      onSelectDossier(profile);
                      onClose();
                    }}
                    className="group relative flex flex-col justify-between p-6 rounded-2xl bg-white dark:bg-charcoal-surface border border-cream-300/80 dark:border-charcoal-border hover:border-emerald-500/50 dark:hover:border-emerald-500/50 shadow-sm hover:shadow-md transition-all duration-300 cursor-pointer overflow-hidden"
                  >
                    {/* Top Stamp Bar */}
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <span className={pillClass(isCurrentRating || isPrime ? edition.tone : 'neutral', 'sm')}>
                          <span className={PILL_ICON_CLASS}>{isCurrentRating || isPrime ? edition.icon : 'history'}</span>
                          {isCurrentRating || isPrime ? edition.label : edition.label.replace('Current form', 'Earlier rating')}
                        </span>

                        {profile.confidence?.grade && (
                          <span className={pillClass(GRADE_TONE[profile.confidence.grade] ?? 'amber', 'xs')} title="Evidence grade">
                            Grade {profile.confidence.grade}
                          </span>
                        )}
                      </div>

                      {/* Player Headline */}
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div>
                          <h3 className="text-xl font-serif font-bold text-charcoal dark:text-cream-50 leading-tight group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                            {profile.basicInfo.name}
                          </h3>
                          <p className="text-xs font-serif italic text-emerald-600 dark:text-emerald-400 mt-0.5 line-clamp-1">
                            {profile.playstyleAndRole?.playstyle?.archetype || 'Tactical Fulcrum'}
                          </p>
                        </div>

                        {/* Rating Block */}
                        <div className="flex flex-col items-end shrink-0">
                          <div className="flex items-baseline gap-1 bg-cream-100 dark:bg-charcoal-light px-3 py-1 rounded-xl border border-cream-300 dark:border-charcoal-border">
                            <span
                              className={`text-2xl font-mono font-bold leading-none ${
                                profile.ratings.overall >= 90
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-charcoal dark:text-cream-50'
                              }`}
                            >
                              {profile.ratings.overall}
                            </span>
                            <span className="text-[9px] font-mono font-bold text-charcoal/40 dark:text-cream-400">
                              OVR
                            </span>
                          </div>
                          <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-charcoal/40 dark:text-cream-400 mt-1">
                            {tierLabel}
                          </span>
                        </div>
                      </div>

                      {/* Meta Chips */}
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-charcoal/60 dark:text-cream-400 mb-3">
                        <span className="font-semibold text-charcoal dark:text-cream-200">
                          {formatPosition(profile.basicInfo.position)}
                        </span>
                        <span className="w-1 h-1 rounded-full bg-charcoal/20 dark:bg-cream-400/20" />
                        <span className="truncate max-w-[130px]">{profile.basicInfo.club}</span>
                        <span className="w-1 h-1 rounded-full bg-charcoal/20 dark:bg-cream-400/20" />
                        <span>{profile.basicInfo.nationality}</span>
                        {profile.basicInfo.age != null && (
                          <>
                            <span className="w-1 h-1 rounded-full bg-charcoal/20 dark:bg-cream-400/20" />
                            <span>Age {profile.basicInfo.age}</span>
                          </>
                        )}
                      </div>

                      {/* Peak Context Note */}
                      {profile.version?.peakContext && (
                        <p className="mb-3 text-xs font-serif italic text-charcoal/70 dark:text-cream-300 leading-snug line-clamp-2">
                          {profile.version.peakContext}
                        </p>
                      )}

                      {/* Trajectory progression badge */}
                      {typeof trajectoryDiff === 'number' && trajectoryDiff !== 0 && (
                        <div className="flex items-center gap-1.5 text-[11px] font-sans mb-3">
                          <span className={pillClass(trajectoryDiff > 0 ? 'emerald' : 'red', 'xs')}>
                            {trajectoryDiff > 0 ? `+${trajectoryDiff}` : trajectoryDiff} OVR
                          </span>
                          <span className="text-charcoal/40 dark:text-cream-400">
                            vs {previousRatingDate} evaluation
                          </span>
                        </div>
                      )}

                      {/* Signature Spikes Pills */}
                      {profile.signatureSpikes && profile.signatureSpikes.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          {profile.signatureSpikes.slice(0, 3).map((spike) => (
                            <span key={spike} className={pillClass('neutral', 'xs')}>
                              {getAttributeLabel(spike)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Card Action Footer */}
                    <div className="pt-4 mt-4 border-t border-cream-200 dark:border-charcoal-border flex items-center justify-between text-xs">
                      <span className="text-[11px] font-sans font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1 group-hover:translate-x-0.5 transition-transform">
                        Inspect Dossier
                        <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                      </span>

                      <button
                        onClick={(e) => handleCopyLink(profile, e)}
                        className={`p-1.5 rounded-md hover:bg-cream-200 dark:hover:bg-charcoal-light transition-colors ${
                          isCopied
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-charcoal/40 dark:text-cream-400/60'
                        }`}
                        title="Copy Share Link"
                      >
                        <span className="material-symbols-outlined text-[16px] block">
                          {isCopied ? 'check' : 'link'}
                        </span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
