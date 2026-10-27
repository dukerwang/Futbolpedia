import type { EvidenceGrade, PlayerProfile } from '../types';
import {
  cardEdition,
  formatEraQualifier,
  getDossierEvaluationDate,
  getLatestUpdateDate,
} from '../services/dossierStore';

/**
 * The one pill style used across dossier cards, the side panel and the Global Dossier Hub:
 * rounded, sans-serif, softly tinted. Based on the card's original metadata pills.
 */
export type PillTone = 'neutral' | 'emerald' | 'amber' | 'indigo' | 'blue' | 'red';

const PILL_BASE = 'inline-flex items-center gap-1 rounded-full border font-sans whitespace-nowrap';

const PILL_SIZE = {
  md: 'px-3 py-1 text-xs font-medium',
  sm: 'px-2.5 py-0.5 text-[11px] font-medium',
  xs: 'px-2 py-px text-[10px] font-medium',
} as const;

const PILL_TONE: Record<PillTone, string> = {
  neutral: 'bg-cream-200/60 dark:bg-charcoal text-charcoal/80 dark:text-cream-200 border-cream-300/80 dark:border-charcoal-border',
  emerald: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25',
  indigo: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/25',
  blue: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/25',
  red: 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/25',
};

export const pillClass = (tone: PillTone = 'neutral', size: keyof typeof PILL_SIZE = 'md'): string =>
  `${PILL_BASE} ${PILL_SIZE[size]} ${PILL_TONE[tone]}`;

/** Material Symbols icon sized to sit inside a pill. */
export const PILL_ICON_CLASS = 'material-symbols-outlined text-[14px] leading-none';

const EDITION_NAMES: Record<string, string> = {
  current: 'Current form',
  prime: 'Prime',
  season_snapshot: 'Season',
  era: 'Era',
  retro: 'Retro',
};

/** "2013-14" -> "2013–14". */
const formatSeason = (era: string): string => era.replace(/^(\d{4})\s*[-/–]\s*(\d{2,4})$/, '$1–$2');

const formatMonth = (isoDate: string): string =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * The card's edition and when it describes, for the header pill: "Current form · Oct 2026",
 * "Prime · 2003–06" or "Paris Saint-Germain era · 2017–20". Current cards show their month;
 * historical cards show their season, since a peak is a season or a window of seasons rather
 * than a day.
 */
export function describeCardEdition(profile: PlayerProfile): {
  tone: PillTone;
  icon: string;
  label: string;
  title?: string;
} {
  const edition = cardEdition(profile);
  const date = getDossierEvaluationDate(profile);
  // Cards from before editions existed don't say whether they rated current form or a peak,
  // so don't claim either.
  if (!profile.version && edition === 'current') {
    return {
      tone: 'neutral',
      icon: 'history',
      label: date ? `Older card · ${formatMonth(date)}` : 'Older card',
      title: 'Rated before cards recorded their edition, so it may be a current or a prime rating. Ask for the player again for a fresh card.',
    };
  }
  if (edition === 'current') {
    return {
      tone: 'emerald',
      icon: 'bolt',
      label: date ? `${EDITION_NAMES.current} · ${formatMonth(date)}` : EDITION_NAMES.current,
    };
  }
  const era = profile.version?.seasonOrEra?.trim();
  const when = era ? formatSeason(era) : date ? date.slice(0, 4) : '';
  const qualifier = edition === 'era' ? profile.version?.qualifier?.trim() : '';
  const name = qualifier
    ? `${formatEraQualifier(qualifier)} era`
    : EDITION_NAMES[edition] ?? EDITION_NAMES.prime;
  const label = when ? `${name} · ${when}` : name;
  // An era is a chapter of a career the user named, not the player at his best, so it doesn't
  // wear the prime's colours.
  if (edition === 'era') return { tone: 'blue', icon: 'auto_stories', label };
  return { tone: 'amber', icon: 'workspace_premium', label };
}

/**
 * A few words naming the card among the player's other versions: "Current", "Prime",
 * "PSG era" or "2015–16".
 */
export function shortEditionLabel(profile: PlayerProfile): string {
  const edition = cardEdition(profile);
  if (edition === 'current') return profile.version ? 'Current' : 'Older card';
  const window = profile.version?.seasonOrEra?.trim();
  const when = window ? formatSeason(window) : '';
  if (edition === 'era') {
    const qualifier = profile.version?.qualifier?.trim();
    return qualifier ? `${formatEraQualifier(qualifier)} era` : when ? `Era ${when}` : 'Era';
  }
  if (edition === 'season_snapshot') return when || EDITION_NAMES.season_snapshot;
  return EDITION_NAMES[edition] ?? EDITION_NAMES.prime;
}

/** "As of Oct 25" for a current card's Latest Update, which refreshes weekly; null on prime cards. */
export function latestUpdateLabel(profile: PlayerProfile): string | null {
  if (cardEdition(profile) !== 'current') return null;
  const date = getLatestUpdateDate(profile);
  if (!date) return null;
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return `As of ${day}`;
}

/**
 * The evidence grade in words. It rates how much evidence sits behind the rating (sample size
 * and data coverage), not how good the player is.
 */
const CONFIDENCE: Record<EvidenceGrade, { tone: PillTone; label: string; hint: string }> = {
  A: { tone: 'emerald', label: 'High confidence', hint: 'Large senior sample (80+ starts) with stable, well-covered data.' },
  B: { tone: 'blue', label: 'Medium confidence', hint: 'Moderate sample (20–80 senior starts) or a recent move or role change.' },
  C: { tone: 'amber', label: 'Low confidence', hint: 'Small senior sample (under 20 starts), a young prospect, or a long injury.' },
};

export const describeConfidence = (grade: EvidenceGrade) => CONFIDENCE[grade] ?? CONFIDENCE.C;
