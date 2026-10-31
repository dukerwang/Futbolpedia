import type { PlayerProfile } from '../types';
import { CLUB_CANON } from '../constants/ratingTiers';

/**
 * Card identity and dating. Pure functions: a card is one edition (current or historical) of
 * one player on one evaluation date.
 */

/** Letters NFD doesn't decompose into a base letter plus accent. */
const UNDECOMPOSABLE_LETTERS: Record<string, string> = {
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
};

/**
 * Lowercases and strips accents ("João" -> "joao", "Ødegaard" -> "odegaard"), so names typed
 * with or without accents resolve to the same shared card.
 */
export const foldPlayerName = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øæœßłđðþı]/g, (ch) => UNDECOMPOSABLE_LETTERS[ch]);

export const toPlayerSlug = (name: string): string =>
  foldPlayerName(name)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

/** Name slug with edition markers removed, so "Joshua Kimmich (Prime)" becomes "joshua-kimmich". */
export const toBasePlayerSlug = (name: string): string =>
  toPlayerSlug(name)
    .replace(/^(prime|peak)-/, '')
    .replace(/-(prime|peak)$/, '');

/** Edition marker in a legacy card's name ("Prime Kaká", "Gerrard (Peak)"). */
export const EDITION_NAME_RE = /\b(prime|peak)\b/i;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's UTC date as YYYY-MM-DD. */
export const todayIso = (): string => new Date().toISOString().split('T')[0];

/** True for a well-formed YYYY-MM-DD that isn't in the future. */
export const isValidEvaluationDate = (s?: string | null): s is string =>
  typeof s === 'string' && ISO_DATE_RE.test(s) && s <= todayIso();

/**
 * Resolves or formats a date to standard YYYY-MM-DD.
 */
export const formatIsoDate = (input?: string | number | Date | null): string | null => {
  if (!input) return null;
  try {
    const d =
      typeof input === 'string' && ISO_DATE_RE.test(input)
        ? new Date(`${input}T12:00:00Z`)
        : new Date(input);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
};

/** European season label for a calendar date (Jul–Dec starts the season, Jan–Jun ends it). */
const seasonForDate = (dateStr: string): string => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
};

export const isPlayerProfile = (content: any): content is PlayerProfile =>
  typeof content === 'object' &&
  content !== null &&
  !('players' in content) &&
  'basicInfo' in content &&
  'ratings' in content;

export const isConfidentDossier = (p: PlayerProfile): boolean =>
  !!p?.basicInfo?.name && p.basicInfo.name !== 'N/A' && (p.ratings?.overall ?? 0) > 0;

/**
 * True for any non-"current" card (prime, season snapshot, retro). Legacy cards with no
 * version fall back to an edition marker in the name.
 */
export const isPrimeCard = (p: PlayerProfile): boolean => {
  const t = p.version?.type;
  if (t) return t !== 'current';
  return EDITION_NAME_RE.test(p.basicInfo?.name ?? '');
};

/**
 * The season a message names, if any: "2005/06", "2005-2006" and "2005–06" become "2005-06";
 * a bare year ("Henry 2006") stays "2006", since it could mean either season it touches.
 */
export const parseRequestedSeason = (text: string): string | null => {
  const m = text.match(/\b((?:19|20)\d{2})(?:\s*[-/–]\s*((?:19|20)?\d{2}))?\b/);
  if (!m) return null;
  const start = Number(m[1]);
  if (!m[2]) return m[1];
  const end = Number(m[2].length === 2 ? `${m[1].slice(0, 2)}${m[2]}` : m[2]);
  return end === start + 1 ? `${start}-${String(end).slice(2)}` : m[1];
};

/** First calendar year a season reference covers: "2005-06" -> 2005, "2006" -> 2006. */
export const seasonStartYear = (season: string): number | null => {
  const m = season.match(/(?:19|20)\d{2}/);
  return m ? Number(m[0]) : null;
};

/**
 * The first and last season a card covers, as season start years: "2005-06" -> [2005, 2005],
 * a prime window "2003-06" (2003-04 through 2005-06) -> [2003, 2005], a calendar year "1962" ->
 * [1962, 1962]. Null when unreadable.
 */
export const seasonSpan = (seasonOrEra: string | null | undefined): [number, number] | null => {
  const m = seasonOrEra?.trim().match(/^((?:19|20)\d{2})(?:\s*[-/–]\s*(\d{2}|\d{4}))?$/);
  if (!m) return null;
  const start = Number(m[1]);
  if (!m[2]) return [start, start];
  let end = Number(m[2].length === 2 ? `${m[1].slice(0, 2)}${m[2]}` : m[2]);
  if (end < start) end += 100;
  if (end === start) return [start, start];
  return end === start + 1 ? [start, start] : [start, end - 1];
};

/**
 * A prime window from its first and last season ("2003-04", "2005-06" -> "2003-06"; one season
 * stays as it is). Calendar-year seasons ("1958", "1962") give "1958-1962". Null when either end
 * is unreadable or the window runs backwards.
 */
export const formatPrimeWindow = (
  startSeason: string | null | undefined,
  endSeason: string | null | undefined,
): { seasonOrEra: string; seasons: number } | null => {
  const isSeason = (s: string) => {
    const span = seasonSpan(s);
    return /^\d{4}-\d{2}$/.test(s) && span !== null && span[0] === span[1];
  };
  const isYear = (s: string) => /^(?:19|20)\d{2}$/.test(s);
  const a = startSeason?.trim().replace(/[/–]/g, '-') ?? '';
  const b = endSeason?.trim().replace(/[/–]/g, '-') ?? '';
  if (!(isSeason(a) || isYear(a)) || !(isSeason(b) || isYear(b))) return null;
  const from = seasonStartYear(a)!;
  const to = seasonStartYear(b)!;
  if (to < from) return null;
  if (a === b) return { seasonOrEra: a, seasons: 1 };
  const seasons = to - from + 1;
  const seasonOrEra =
    isYear(a) && isYear(b) ? `${from}-${to}` : `${from}-${String(to + 1).slice(2)}`;
  return { seasonOrEra, seasons };
};

/**
 * Whether a card's season describes the requested one. A range must match exactly; a bare
 * year matches either season it touches ("2006" matches 2005-06 and 2006-07). A prime window
 * spanning several seasons is its own version and never stands in for one of them.
 */
export const seasonMatches = (seasonOrEra: string | null | undefined, requested: string): boolean => {
  if (!seasonOrEra) return false;
  const span = seasonSpan(seasonOrEra);
  if (span && span[1] > span[0]) return false;
  const cardStart = seasonStartYear(seasonOrEra);
  const reqStart = seasonStartYear(requested);
  if (cardStart == null || reqStart == null) return false;
  const cardIsRange = /\d{4}\s*[-/–]\s*\d{2}/.test(seasonOrEra);
  if (/^\d{4}-\d{2}$/.test(requested)) return cardStart === reqStart;
  return cardStart === reqStart || (cardIsRange && cardStart + 1 === reqStart);
};

/** Edition segment of card keys and archive slugs. */
export const cardEdition = (p: PlayerProfile): string =>
  isPrimeCard(p) ? p.version?.type ?? 'prime' : 'current';

/** True when two seasons or windows cover the same seasons ("2017-20" and "2017-2020"). */
export const isSameWindow = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = seasonSpan(a);
  const y = seasonSpan(b);
  return !!x && !!y && x[0] === y[0] && x[1] === y[1];
};

const clubCanonOf = (qualifier: string): string | undefined =>
  CLUB_CANON[qualifier.toLowerCase().replace(/[^a-z]/g, '')];

/**
 * Comparable form of an era's name, so "PSG", "Paris Saint-Germain" and "psg" name the same era.
 * Clubs go through the club aliases; anything else is compared as typed, without case or accents.
 */
export const toEraKey = (qualifier: string | null | undefined): string => {
  const q = qualifier?.trim() ?? '';
  if (!q) return '';
  return toPlayerSlug(clubCanonOf(q) ?? q);
};

/** An era's name for display: a club's full name, otherwise the words as typed in title case. */
export const formatEraQualifier = (qualifier: string): string => {
  const q = qualifier.trim().replace(/\s+/g, ' ');
  return (
    clubCanonOf(q) ??
    q.replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
  );
};

/**
 * The card that already rates a requested era. An era is defined by its years, so a card covering
 * the same seasons answers it whatever it was called: another era card, the prime card, or (for a
 * one-season era) the season card. Before rating, only the era's name is known, so an era card of
 * the same name answers it too. The first card in `cards` wins, so list them oldest first.
 */
export const findEraCard = (
  cards: PlayerProfile[],
  criteria: { qualifier?: string | null; window?: string | null },
): PlayerProfile | null => {
  const key = toEraKey(criteria.qualifier);
  return (
    cards.find((p) => {
      const edition = cardEdition(p);
      if (key && edition === 'era' && toEraKey(p.version?.qualifier) === key) return true;
      if (!criteria.window) return false;
      if (edition === 'era' || edition === 'prime') {
        return isSameWindow(p.version?.seasonOrEra, criteria.window);
      }
      return edition === 'season_snapshot' && isSameWindow(p.version?.seasonOrEra, criteria.window);
    }) ?? null
  );
};

/**
 * Returns the verified evaluation date of a dossier, or null if it can't be dated.
 * A current card may fall back to the day it was created, because that is the day it was
 * rated. A historical card never falls back: its date must be the verified peak date.
 */
export const getDossierEvaluationDate = (p: PlayerProfile): string | null => {
  if (isValidEvaluationDate(p.version?.evaluationDate)) return p.version!.evaluationDate;
  if (isValidEvaluationDate(p.evaluationDate)) return p.evaluationDate!;
  if (isPrimeCard(p)) return null;
  if (p.createdAt && p.createdAt > 0) return formatIsoDate(p.createdAt);
  return null;
};

/**
 * Renames a card without changing its edition. A legacy card with no `version` gets its edition
 * from its name ("Prime Kaká"), so renaming it to "Kaká" would silently turn a prime card into a
 * current one, and the reverse. Record the edition and date on the card before the name changes.
 */
export const renameDossierCard = (p: PlayerProfile, newName: string): PlayerProfile => {
  const renamed = { ...p, basicInfo: { ...p.basicInfo, name: newName } };
  if (p.version?.type) return renamed;
  const prime = isPrimeCard(p);
  const date = getDossierEvaluationDate(p) ?? '';
  return {
    ...renamed,
    version: {
      id: `${toBasePlayerSlug(p.basicInfo.name)}-${prime ? 'prime' : 'current'}-${date || 'undated'}`,
      type: prime ? 'prime' : 'current',
      label: prime ? 'Prime Zenith' : 'Current Form',
      evaluationDate: date,
      seasonOrEra: '',
    },
  };
};

/**
 * Check whether a dossier has a valid, verifiable evaluation date.
 */
export const isDossierDated = (p: PlayerProfile): boolean => {
  return Boolean(getDossierEvaluationDate(p));
};

/**
 * Strictly ensures a dossier is dated. If it cannot be dated, returns null.
 * When dateable, guarantees p.evaluationDate and p.version are fully populated.
 */
export const ensureDossierDated = (
  p: PlayerProfile,
  fallbackMs?: number,
): PlayerProfile | null => {
  if (!p || !p.basicInfo?.name) return null;
  const prime = isPrimeCard(p);
  const dateStr =
    getDossierEvaluationDate(p) || (!prime && fallbackMs ? formatIsoDate(fallbackMs) : null);
  if (!dateStr) {
    return null; // Enforce rule: undated dossiers cannot be used in the shared database
  }

  const versionType = p.version?.type || (prime ? 'prime' : 'current');
  const d = new Date(`${dateStr}T12:00:00Z`);
  const monthName = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const season = seasonForDate(dateStr);

  const version = p.version || {
    id: `${toBasePlayerSlug(p.basicInfo.name)}-${versionType}-${dateStr}`,
    type: versionType,
    label: prime
      ? `Prime Zenith (${season})`
      : `Current Form (${monthName} ${d.getUTCFullYear()})`,
    evaluationDate: dateStr,
    seasonOrEra: season,
    peakContext: null,
  };

  return {
    ...p,
    evaluationDate: dateStr,
    // createdAt is when the card was generated. For a prime card that is not its peak date.
    createdAt: p.createdAt || fallbackMs || d.getTime(),
    version: {
      ...version,
      evaluationDate: dateStr,
    },
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a player's current card stays the one shared card before a fresh rating is allowed. */
export const CARD_REFRESH_DAYS = 30;

/**
 * How often a shared current card's Latest Update is rewritten from fresh facts. Ratings hold
 * for CARD_REFRESH_DAYS; the news line shouldn't be a month old.
 */
export const LATEST_UPDATE_REFRESH_DAYS = 7;

/**
 * True while a card should be served instead of re-rated: always for prime cards (a peak
 * doesn't change), and for CARD_REFRESH_DAYS after a current card's evaluation date.
 */
export const isCardInRefreshWindow = (p: PlayerProfile, nowMs: number = Date.now()): boolean => {
  if (isPrimeCard(p)) return true;
  const date = getDossierEvaluationDate(p);
  return !!date && nowMs - Date.parse(`${date}T00:00:00Z`) < CARD_REFRESH_DAYS * DAY_MS;
};

/** YYYY-MM-DD the card's Latest Update describes: its own refresh stamp, else the card's date. */
export const getLatestUpdateDate = (p: PlayerProfile): string | null =>
  p.latestUpdateAsOf ?? getDossierEvaluationDate(p);

/**
 * True when a shared current card is still inside its rating window but its Latest Update is
 * LATEST_UPDATE_REFRESH_DAYS old. Prime cards and personal revisions never refresh.
 */
export const needsLatestUpdateRefresh = (p: PlayerProfile, nowMs: number = Date.now()): boolean => {
  if (isPrimeCard(p) || p.revision || !isCardInRefreshWindow(p, nowMs)) return false;
  const date = getLatestUpdateDate(p);
  return !!date && nowMs - Date.parse(`${date}T00:00:00Z`) >= LATEST_UPDATE_REFRESH_DAYS * DAY_MS;
};

/** Dated copy of a card, or the card with a createdAt stamp when it can't be dated. */
export const stampDossier = (p: PlayerProfile, nowMs: number): PlayerProfile =>
  ensureDossierDated(p, nowMs) ?? { ...p, createdAt: p.createdAt || nowMs };

/**
 * What tells a player's cards of one edition apart: the evaluation date, or for an era card its
 * window, since an era is defined by its years.
 */
const cardMoment = (p: PlayerProfile): string | null => {
  const window = cardEdition(p) === 'era' ? p.version?.seasonOrEra?.trim() : '';
  return window && seasonSpan(window) ? window : getDossierEvaluationDate(p);
};

/**
 * Stable identity for one card version of one player. Two cards of the same player share a
 * key only when edition and evaluation date (an era card's window) both match.
 */
export const getCardKey = (p: PlayerProfile): string =>
  `${toBasePlayerSlug(p.basicInfo.name)}:${cardEdition(p)}:${cardMoment(p) ?? p.createdAt ?? 'undated'}`;

/**
 * Keeps each player's newest current card and newest prime card, so an archived re-rating never
 * sits next to the live one in locks, peer ledgers or grep results. Current cards go by
 * evaluation date (on equal dates the later entry wins, so list sources from broadest to most
 * local); prime cards by the latest re-rating, then the latest generated. Season and era cards
 * keep their own key, one per season or window.
 */
export const latestCardPerPlayer = (cards: PlayerProfile[]): PlayerProfile[] => {
  const byPlayer = new Map<string, PlayerProfile>();
  const primeRank = (p: PlayerProfile): [number, number] => [p.rerateAt ?? 0, p.createdAt ?? 0];
  for (const p of cards) {
    const edition = cardEdition(p);
    const base = toBasePlayerSlug(p.basicInfo.name);
    const key =
      edition === 'current' ? `${base}:current` : edition === 'prime' ? `${base}:prime` : getCardKey(p);
    const existing = byPlayer.get(key);
    if (existing && edition === 'prime') {
      const [a, b] = [primeRank(existing), primeRank(p)];
      if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) continue;
    } else if (existing && (getDossierEvaluationDate(existing) ?? '') > (getDossierEvaluationDate(p) ?? '')) {
      continue;
    }
    byPlayer.set(key, p);
  }
  return [...byPlayer.values()];
};

/**
 * Drops prime cards a re-rating has replaced. A re-rating can move the prime's window and with it
 * the evaluation date, so the old card keeps its own archive row and card key; any prime card of
 * the same player re-rated later supersedes it.
 */
/** How a player's versions line up: current form, prime, eras, then single seasons. */
const EDITION_ORDER: Record<string, number> = { current: 0, prime: 1, era: 2, season_snapshot: 3 };
export const compareVersions = (a: PlayerProfile, b: PlayerProfile): number =>
  (EDITION_ORDER[cardEdition(a)] ?? 4) - (EDITION_ORDER[cardEdition(b)] ?? 4) ||
  (a.version?.seasonOrEra || '').localeCompare(b.version?.seasonOrEra || '');

export const dropSupersededPrimes = (cards: PlayerProfile[]): PlayerProfile[] => {
  const latestRerate = new Map<string, number>();
  for (const p of cards) {
    if (cardEdition(p) !== 'prime' || !p.rerateAt) continue;
    const base = toBasePlayerSlug(p.basicInfo.name);
    latestRerate.set(base, Math.max(latestRerate.get(base) ?? 0, p.rerateAt));
  }
  return cards.filter(
    (p) =>
      cardEdition(p) !== 'prime' ||
      (p.rerateAt ?? 0) >= (latestRerate.get(toBasePlayerSlug(p.basicInfo.name)) ?? 0),
  );
};

/**
 * Immutable archive slug for a dated card, e.g. "joshua-kimmich--current--2026-10-25". An era
 * card is filed under its window ("neymar-jr--era--2017-20"), so one era has one card.
 */
export const toVersionedSlug = (p: PlayerProfile): string | null => {
  if (!getDossierEvaluationDate(p)) return null;
  return `${toBasePlayerSlug(p.basicInfo.name)}--${cardEdition(p)}--${cardMoment(p)}`;
};

/** Mutable "latest card" pointer slug. Share links and cache lookups use this one. */
export const toDossierCardSlug = (name: string, isHistorical = false): string => {
  const base = toBasePlayerSlug(name);
  return isHistorical ? `prime-${base}` : base;
};
