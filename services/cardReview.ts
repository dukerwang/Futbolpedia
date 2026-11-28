import { Type } from '@google/genai';
import { getTierDefinition, normalizePosition, RATING_TIERS } from '../constants/ratingTiers';
import type { PeerPlacement, PlayerProfile } from '../types';
import { generateStructured } from './aiClient';
import { isSameClub, toClubKey } from './clubManagers';
import { isRatedOnCurrentScale } from './dossierCache';
import {
  CARD_REFRESH_DAYS,
  cardEdition,
  dropSupersededPrimes,
  ensureDossierDated,
  getCardKey,
  getDossierEvaluationDate,
  isCardInRefreshWindow,
  isPrimeCard,
  isSameWindow,
  latestCardPerPlayer,
  seasonSpan,
  toBasePlayerSlug,
  toDossierCardSlug,
  toVersionedSlug,
} from './dossierCards';
import { positionGroups } from './dossierLedger';
import { eraEntry, normalizePeriod, rowToSnapshot as eraRowToSnapshot, type EraRow } from './eraSnapshots';
import { samePlayerName } from './liveFootball';
import { placementRange, resolvePlacement } from './ratingPlacement';
import { cardAbove, toStanding } from './debateConsistency';
import type { DisagreementHit, DisagreementPath } from './cardDisagreements';

/**
 * Card review: the scout's day for players. Code finds the cards whose facts or rating no longer
 * hold (current cards past their window, current cards whose situation moved, historical cards
 * whose data gaps a stored record now covers, placements that contradict each other, and positions
 * where the best current card sits below the whole recent historical scale), the day's planning
 * call chooses which to act on, and code carries it out under the card rules:
 *
 * - `rerate_current` runs the dossier pipeline for a current card past its window, and the new
 *   card publishes exactly as a visitor's request would.
 * - `fill_facts` fills a historical card's data gaps from the stored record that now covers them,
 *   without touching its rating.
 * - `review_prime` drafts a rerate of a prime with the reason in its evidence, never writes it,
 *   and hands it to an independent reviewer call: `accept` publishes through the rerate path,
 *   `revise` allows one more draft with the notes, `refuse` publishes nothing. Code refuses some
 *   drafts before the reviewer sees them.
 *
 * Every re-rating, published or not, is a `card_reviews` row; chat files the latest published one
 * for a card as evidence (services/cardReviewNotes.ts).
 */

// ---------------------------------------------------------------------------------------------
// Constants

/** Model calls a day's card work may spend (`CARD_REVIEW_CALLS`), apart from the scout's day budget. */
export const CARD_REVIEW_DEFAULT_CALLS = 24;
/** The dossier pipeline's calls for one rating: identity, grounding searches, synthesis, traits, manager. */
export const DRAFT_CALLS = 8;
/** The reviewer is one call. */
export const REVIEW_CALLS = 1;
/** One round of `review_prime`: a draft and its review. */
export const REVIEW_ROUND_CALLS = DRAFT_CALLS + REVIEW_CALLS;
/** What each card action costs, in model calls, as the plan prompt tells the model. */
export const CARD_ACTION_COST = { rerate_current: DRAFT_CALLS, fill_facts: 2, review_prime: REVIEW_ROUND_CALLS } as const;
export type CardActionType = keyof typeof CARD_ACTION_COST;
export const CARD_ACTION_TYPES = Object.keys(CARD_ACTION_COST) as CardActionType[];
export const CARD_LIST_CAP = 20;
/** In-window current cards checked against the live data each day, most asked about first. */
export const SITUATION_CHECKS = 60;
/** Mirrors the synthesizer's prime window: at most three consecutive seasons. */
export const MAX_WINDOW_SEASONS = 3;
/** A prime spans at least two seasons; one season is a season card. */
export const MIN_WINDOW_SEASONS = 2;
/** A card rating him at least an everyday starter is contradicted by a first-choice XI without him. */
export const STARTER_MIN_OVERALL = RATING_TIERS.find((t) => t.id === '80_83_QUALITY_STARTER')!.min;
/** A historical card is on the recent scale when its window ended within this many years. */
export const RECENT_HISTORICAL_YEARS = 15;
/** A position is checked for a calibration gap only with this many current cards: one card is the best by default. */
export const GAP_MIN_CURRENT_CARDS = 2;
/** The most historical cards a calibration gap lists; it also counts them all. */
export const GAP_CARDS_LISTED = 8;
/** A disagreement pair enters the signals with at least this many counted reports (each source once a day). */
export const DISAGREEMENT_MIN_REPORTS = 2;
/** How long a re-rated current card is waited for: the pipeline publishes without awaiting the write. */
const PUBLISH_CONFIRM_TRIES = 6;
const PUBLISH_CONFIRM_MS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------------------------------------------------------------------------------------------
// Card rows and pools

/** One stored row of `player_profiles`, as an outline (or a full card) with its slug and time. */
export interface StoredCard {
  slug: string;
  card: PlayerProfile;
  rowAt: number;
}

const isPointerSlug = (slug: string) => !slug.includes('--');
const isCurrentPointer = (r: StoredCard) => isPointerSlug(r.slug) && !r.slug.startsWith('prime-') && !isPrimeCard(r.card);

/** The rows as dated cards on the current scale; personal revisions and undated rows are dropped. */
function datedRows(rows: StoredCard[]): StoredCard[] {
  const out: StoredCard[] = [];
  for (const r of rows) {
    if (!r.card?.basicInfo?.name || r.slug.includes('--rev-')) continue;
    const card = ensureDossierDated(r.card, r.rowAt);
    if (!card || card.revision || !isRatedOnCurrentScale(card, r.rowAt)) continue;
    out.push({ ...r, card });
  }
  return out;
}

/** The shared current cards: each player's pointer row. */
export const currentPointers = (rows: StoredCard[]): StoredCard[] => datedRows(rows).filter(isCurrentPointer);

/** The historical cards a request is served: prime pointers, era and season archive rows, re-rated primes dropped. */
export function servedHistorical(rows: StoredCard[]): StoredCard[] {
  const dated = datedRows(rows).filter(
    (r) => isPrimeCard(r.card) && (r.slug.startsWith('prime-') || /--(era|season_snapshot)--/.test(r.slug)),
  );
  const kept = new Set(dropSupersededPrimes(dated.map((r) => r.card)));
  return dated.filter((r) => kept.has(r.card));
}

/** Every card a request is served today, one per player and version: the pool coherence is judged over. */
export function servedPool(rows: StoredCard[], nowMs: number): PlayerProfile[] {
  const current = currentPointers(rows).filter((r) => isCardInRefreshWindow(r.card, nowMs)).map((r) => r.card);
  return latestCardPerPlayer([...current, ...servedHistorical(rows).map((r) => r.card)]);
}

// ---------------------------------------------------------------------------------------------
// Coherence

export interface CardRef {
  player: string;
  cardKey: string;
  edition: string;
  window: string | null;
  overall: number;
}

const refOf = (p: PlayerProfile): CardRef => ({
  player: p.basicInfo.name,
  cardKey: getCardKey(p),
  edition: cardEdition(p),
  window: isPrimeCard(p) ? p.version?.seasonOrEra ?? null : null,
  overall: Number(p.ratings?.overall) || 0,
});

export interface PlacementPair {
  /** `a` places itself above `b`, or `b` places itself below `a`; and the other way round. */
  a: CardRef;
  b: CardRef;
  /** Which card said which: "A above B (A's card)". */
  statements: string[];
}

export interface PlacementCycle {
  /** Each above the next, and the last above the first. */
  cards: [CardRef, CardRef, CardRef];
  statements: string[];
}

export interface PositionSpread {
  position: string;
  cards: number;
  mean: number;
  median: number;
  /** The pool's figures, for comparison. */
  poolMean: number;
  poolMedian: number;
}

export interface Coherence {
  pairs: PlacementPair[];
  cycles: PlacementCycle[];
  /** Reported figures only: no action is opened on a distribution. */
  positions: PositionSpread[];
}

/**
 * The card a placement name refers to. The stored placement reads "Name (window)" for a historical
 * peer: the name resolves as the rating pipeline resolves it, then the window, else the edition
 * nearest the stating card's, picks among his cards.
 */
function resolveRef(raw: string, pool: PlayerProfile[], subject: PlayerProfile): PlayerProfile | undefined {
  const hit = resolvePlacement({ betterThan: [raw], levelWith: [], notAsGoodAs: [] }, pool, subject).betterThan[0];
  if (!hit) return undefined;
  const base = toBasePlayerSlug(hit.basicInfo.name);
  const his = pool.filter((p) => toBasePlayerSlug(p.basicInfo.name) === base);
  const window = raw.match(/\(([^)]*)\)/)?.[1]?.trim();
  const byWindow = window ? his.find((p) => isPrimeCard(p) && isSameWindow(p.version?.seasonOrEra, window)) : undefined;
  return byWindow ?? his.find((p) => cardEdition(p) === (isPrimeCard(subject) ? 'prime' : 'current')) ?? hit;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : 0);
const round1 = (x: number) => Math.round(x * 10) / 10;

/** A card's position for the distribution: the first canonical position it names. */
export const primaryPosition = (p: PlayerProfile): string => normalizePosition(p.basicInfo?.position ?? '').split('/')[0] || 'N/A';

/**
 * Finds, by code, where the pool's own placements disagree: pairs of cards that each place
 * themselves above the other (either card's betterThan, or the other's notAsGoodAs), and three
 * cards whose placements go round in a circle. Pairs already counted aren't counted again as part
 * of a circle. Each position's Overall distribution is reported against the pool's.
 */
export function findCoherence(pool: PlayerProfile[], cap: number = CARD_LIST_CAP): Coherence {
  const byKey = new Map(pool.map((p) => [getCardKey(p), p]));
  // above.get(x) = cards x is above, with who said so.
  const above = new Map<string, Map<string, string[]>>();
  const state = (hi: PlayerProfile, lo: PlayerProfile, by: PlayerProfile) => {
    const [h, l] = [getCardKey(hi), getCardKey(lo)];
    if (h === l) return;
    const row = above.get(h) ?? new Map<string, string[]>();
    const said = `${hi.basicInfo.name} above ${lo.basicInfo.name} (${by.basicInfo.name}'s ${cardEdition(by)} card)`;
    row.set(l, [...new Set([...(row.get(l) ?? []), said])]);
    above.set(h, row);
  };
  for (const card of pool) {
    const placement = card.peerPlacement as PeerPlacement | undefined;
    if (!placement) continue;
    for (const raw of placement.betterThan ?? []) {
      const peer = resolveRef(raw, pool, card);
      if (peer) state(card, peer, card);
    }
    for (const raw of placement.notAsGoodAs ?? []) {
      const peer = resolveRef(raw, pool, card);
      if (peer) state(peer, card, card);
    }
  }
  const isAbove = (x: string, y: string) => above.get(x)?.has(y) ?? false;
  const said = (x: string, y: string) => above.get(x)?.get(y) ?? [];
  const byOverall = (x: { overall: number }, y: { overall: number }) => y.overall - x.overall;

  const pairs: PlacementPair[] = [];
  const pairKeys = new Set<string>();
  for (const [x, row] of above) {
    for (const y of row.keys()) {
      if (x >= y || !isAbove(y, x)) continue;
      pairKeys.add(`${x}|${y}`);
      pairs.push({ a: refOf(byKey.get(x)!), b: refOf(byKey.get(y)!), statements: [...said(x, y), ...said(y, x)] });
    }
  }
  const inPair = (x: string, y: string) => pairKeys.has(x < y ? `${x}|${y}` : `${y}|${x}`);

  const cycles: PlacementCycle[] = [];
  const seen = new Set<string>();
  for (const [x, row] of above) {
    for (const y of row.keys()) {
      for (const z of above.get(y)?.keys() ?? []) {
        if (z === x || !isAbove(z, x)) continue;
        if (inPair(x, y) || inPair(y, z) || inPair(z, x)) continue;
        const id = [x, y, z].sort().join('|');
        if (seen.has(id)) continue;
        seen.add(id);
        cycles.push({
          cards: [refOf(byKey.get(x)!), refOf(byKey.get(y)!), refOf(byKey.get(z)!)],
          statements: [...said(x, y), ...said(y, z), ...said(z, x)],
        });
      }
    }
  }

  const all = pool.map((p) => Number(p.ratings?.overall) || 0).filter((n) => n > 0);
  const [poolMean, poolMedian] = [round1(mean(all)), median(all)];
  const byPosition = new Map<string, number[]>();
  for (const p of pool) {
    const o = Number(p.ratings?.overall) || 0;
    if (o > 0) byPosition.set(primaryPosition(p), [...(byPosition.get(primaryPosition(p)) ?? []), o]);
  }
  const positions = [...byPosition]
    .map(([position, xs]) => ({ position, cards: xs.length, mean: round1(mean(xs)), median: median(xs), poolMean, poolMedian }))
    .sort((a, b) => Math.abs(b.mean - poolMean) - Math.abs(a.mean - poolMean) || b.cards - a.cards);

  return {
    pairs: pairs.sort((p, q) => byOverall(p.a, q.a)).slice(0, cap),
    cycles: cycles.sort((p, q) => byOverall(p.cards[0], q.cards[0])).slice(0, cap),
    positions: positions.slice(0, cap),
  };
}

// ---------------------------------------------------------------------------------------------
// Calibration gaps

/** The position groups a rating's closest peers are picked in (positionGroups), as the signals name them. */
const POSITION_GROUP_NAMES: Record<string, string> = {
  gk: 'Goalkeeper',
  cb: 'Centre-Back',
  fb: 'Full-Back and Wing-Back',
  dm: 'Defensive Midfielder',
  cm: 'Central Midfielder',
  am: 'Attacking Midfielder',
  wide: 'Winger and Wide Midfielder',
  cf: 'Centre Forward',
};

export interface CalibrationGap {
  position: string;
  /** The best current card at the position. */
  current: CardRef;
  /** The day its window ends and it can be re-rated. */
  windowEnds: string;
  /** Other players' recent prime, era and season cards there, all rated above it: the nearest first. */
  above: CardRef[];
  /** How many there are, listed or not. */
  recent: number;
}

/** The day a historical card's window closed: 30 June after its last split season, or its calendar year's end. */
const windowClosed = (card: PlayerProfile): string | null => {
  const text = card.version?.seasonOrEra?.trim();
  const span = seasonSpan(text);
  if (!text || !span) return null;
  return /^\d{4}\s*[-/–]/.test(text) ? `${span[1] + 1}-06-30` : `${span[1]}-12-31`;
};

/**
 * Finds, by code, the positions where current cards sit below the recent historical scale: the
 * best current card at a position (grouped as closest peers are, so full-backs on either flank are
 * one position) rated below every other player's prime, era and season card there whose window
 * ended in the last RECENT_HISTORICAL_YEARS. A position with fewer than GAP_MIN_CURRENT_CARDS
 * current cards isn't checked: a low lone card says the library is missing players, nothing about
 * how current cards are rated. Tied best cards are each reported. A gap is a figure about the
 * pool: nothing here changes a rating.
 */
export function findCalibrationGaps(pool: PlayerProfile[], nowMs: number, cap: number = CARD_LIST_CAP): CalibrationGap[] {
  const cutoff = new Date(nowMs);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - RECENT_HISTORICAL_YEARS);
  const since = cutoff.toISOString().slice(0, 10);
  const rated = pool.filter((p) => (Number(p.ratings?.overall) || 0) > 0);
  const recent = rated.filter((p) => isPrimeCard(p) && (windowClosed(p) ?? '') >= since);
  const gaps: CalibrationGap[] = [];
  for (const [group, position] of Object.entries(POSITION_GROUP_NAMES)) {
    const here = (p: PlayerProfile) => positionGroups(p.basicInfo?.position).has(group);
    const current = rated.filter((p) => !isPrimeCard(p) && here(p));
    if (current.length < GAP_MIN_CURRENT_CARDS) continue;
    const best = Math.max(0, ...current.map((p) => p.ratings.overall));
    const historical = recent.filter(here);
    for (const card of current.filter((p) => p.ratings.overall === best)) {
      const base = toBasePlayerSlug(card.basicInfo.name);
      // His own historical cards are another version of him, not the scale he is read against.
      const others = historical.filter((p) => toBasePlayerSlug(p.basicInfo.name) !== base);
      const windowEnds = windowEndOf(card);
      if (!windowEnds || others.length === 0 || others.some((p) => p.ratings.overall <= best)) continue;
      gaps.push({
        position,
        current: refOf(card),
        windowEnds,
        above: [...others].sort((a, b) => a.ratings.overall - b.ratings.overall).slice(0, GAP_CARDS_LISTED).map(refOf),
        recent: others.length,
      });
    }
  }
  return gaps.slice(0, cap);
}

// ---------------------------------------------------------------------------------------------
// Signals

/** A stored record that covers a club season or a player's window, and when it was built. */
export interface Coverage {
  source: 'era_snapshot' | 'history';
  kind: 'club_season' | 'player_window' | 'player_career';
  subject: string;
  /** YYYY-YY season or window; null for a player's whole career. */
  period: string | null;
  builtAt: string;
  /** What reads the record back: an era snapshot's key, or the history cache's key. */
  ref: string;
}

export interface ExpiredCard {
  player: string;
  club: string;
  evaluated: string;
  days: number;
  asked: number;
  /** Flagged while inside its window (see queuedFromJournal), and queued for re-rating on the day the window ended. */
  queued: boolean;
  queuedReason?: string;
}

export interface MovedCard {
  player: string;
  club: string;
  reason: string;
  evaluated: string;
  /** The day its window ends and it can be re-rated. */
  windowEnds: string;
  asked: number;
}

export interface GapCard {
  player: string;
  cardKey: string;
  edition: string;
  window: string | null;
  gaps: string[];
  coveredBy: Coverage;
  asked: number;
}

/**
 * A pair of cards answers ordered the other way before the cards settled the order
 * (services/cardDisagreements.ts), resolved against today's pool: the cards rank `higher` above
 * `lower`, and answers put `lower` first.
 */
export interface DisagreementPair {
  higher: CardRef;
  lower: CardRef;
  /** Counted reports: each source once a day. */
  reports: number;
  days: number;
  firstDay: string;
  lastDay: string;
  via: DisagreementHit['via'];
  /** Current cards in the pair, which can be re-rated only once their window ends. */
  waiting: { player: string; windowEnds: string }[];
}

export interface CardReviewSignals {
  expiredCurrent: ExpiredCard[];
  situationMoved: MovedCard[];
  historicalGaps: GapCard[];
  coherence: Coherence;
  /** Absent on journal rows written before disagreements were counted. */
  disagreements?: DisagreementPair[];
  /** Absent on journal rows written before calibration gaps were reported. */
  calibrationGaps?: CalibrationGap[];
}

export interface CardReviewSources {
  /** Every stored card row (pointers and archive), as outlines carrying placement and data gaps. */
  rows(): Promise<StoredCard[]>;
  /** The club the live player record names, or null when no live source covers him. */
  liveClub(player: string): Promise<string | null>;
  /** The first-choice XI names of a club's stored snapshot, or null when it has none. */
  clubXi(club: string): Promise<{ club: string; asOf: string; names: string[] } | null>;
  /** The stored records: era snapshots and the history cache. */
  coverage(): Promise<Coverage[]>;
  /** Current cards the last month's journal rows flagged inside their window, with why and when. */
  queued(): Promise<{ player: string; reason: string; day: string }[]>;
  /** The server's tally of card order disagreements; absent where nothing counts them. */
  disagreements?(): DisagreementHit[] | Promise<DisagreementHit[]>;
}

const SEASON_RE = /\b((?:19|20)\d{2})\s*[-/–]\s*((?:19|20)?\d{2})\b/g;

/** The seasons a gap names, as YYYY-YY. */
export const seasonsIn = (gap: string): string[] =>
  [...gap.matchAll(SEASON_RE)].map((m) => normalizePeriod(m[0])).filter((s): s is string => !!s && /^\d{4}-\d{2}$/.test(s));

const within = (season: string, period: string | null): boolean => {
  const s = seasonSpan(season);
  const p = seasonSpan(period);
  return !!s && !!p && s[0] >= p[0] && s[1] <= p[1];
};

const namesClub = (gap: string, club: string): boolean => {
  const folded = ` ${toClubKey(gap).replace(/-/g, ' ')} `;
  const words = toClubKey(club).split('-').filter((t) => t.length > 2 && !/^(?:fc|cf|afc)$/.test(t));
  return words.length > 0 && words.every((w) => folded.includes(` ${w} `));
};

/**
 * Whether a stored record covers what a gap names: a club season the gap names by season (and by
 * club, or the card's club), a season it names inside a stored window of his, or his career record
 * when the gap names one of his seasons.
 */
export function coverageFor(card: PlayerProfile, gap: string, coverage: Coverage[]): Coverage | null {
  const seasons = seasonsIn(gap);
  const window = card.version?.seasonOrEra ?? null;
  const base = toBasePlayerSlug(card.basicInfo.name);
  const clubs = [card.basicInfo.club, ...String(card.basicInfo.club ?? '').split(/\s*[/,]\s*/)].filter(Boolean);
  for (const c of coverage) {
    if (c.kind === 'club_season') {
      if (!c.period) continue;
      const club = namesClub(gap, c.subject) || clubs.some((k) => isSameClub(k, c.subject));
      const season = seasons.includes(c.period) || (seasons.length === 0 && namesClub(gap, c.subject) && within(c.period, window));
      if (club && season) return c;
    } else if (toBasePlayerSlug(c.subject) === base) {
      if (c.kind === 'player_window' ? seasons.some((s) => within(s, c.period)) : seasons.length > 0) return c;
    }
  }
  return null;
}

const windowEndOf = (card: PlayerProfile): string | null => {
  const evaluated = getDossierEvaluationDate(card);
  return evaluated ? dayOf(Date.parse(`${evaluated}T00:00:00Z`) + CARD_REFRESH_DAYS * DAY_MS) : null;
};

/** The pair's two cards in a pool, when both are served and the cards still rank them that way. */
export function resolveDisagreement(keys: { higher: string; lower: string }, pool: PlayerProfile[]): { higher: PlayerProfile; lower: PlayerProfile } | null {
  const higher = pool.find((p) => getCardKey(p) === keys.higher);
  const lower = pool.find((p) => getCardKey(p) === keys.lower);
  if (!higher || !lower || higher === lower) return null;
  return cardAbove(toStanding(higher), toStanding(lower)) ? { higher, lower } : null;
}

/**
 * The tally's pairs as signals: only pairs with at least `min` counted reports whose card keys
 * resolve to cards served today (so a re-rated card's old key, a personal revision or a key nobody
 * holds drops out) and that the cards still rank that way. Most reported first, capped.
 */
export function findDisagreements(hits: DisagreementHit[], pool: PlayerProfile[], min: number = DISAGREEMENT_MIN_REPORTS, cap: number = CARD_LIST_CAP): DisagreementPair[] {
  const byKey = new Map(pool.map((p) => [getCardKey(p), p] as const));
  const out: DisagreementPair[] = [];
  for (const h of hits) {
    if (h.reports < min) continue;
    const resolved = resolveDisagreement(h, [byKey.get(h.higher), byKey.get(h.lower)].filter((p): p is PlayerProfile => !!p));
    if (!resolved) continue;
    const waiting = [resolved.higher, resolved.lower]
      .filter((c) => cardEdition(c) === 'current')
      .flatMap((c) => {
        const windowEnds = windowEndOf(c);
        return windowEnds ? [{ player: c.basicInfo.name, windowEnds }] : [];
      });
    out.push({ higher: refOf(resolved.higher), lower: refOf(resolved.lower), reports: h.reports, days: h.days, firstDay: h.firstDay, lastDay: h.lastDay, via: { ...h.via }, waiting });
  }
  return out.sort((a, b) => b.reports - a.reports || b.days - a.days).slice(0, cap);
}

const daysSince = (date: string, nowMs: number) => Math.floor((nowMs - Date.parse(`${date}T00:00:00Z`)) / DAY_MS);

/**
 * The card review part of the scout's day summary. `asked` counts how often people looked a player
 * up (card pages, card links, the live player route). Every list is capped at twenty.
 */
export async function gatherCardSignals(
  sources: CardReviewSources,
  asked: (player: string) => number,
  nowMs: number = Date.now(),
): Promise<CardReviewSignals> {
  const rows = await sources.rows();
  const current = currentPointers(rows);
  const flagged = await sources.queued().catch(() => [] as { player: string; reason: string; day: string }[]);
  const queued = new Map(flagged.map((q) => [toBasePlayerSlug(q.player), q] as const));

  const expiredCurrent: ExpiredCard[] = [];
  const inWindow: StoredCard[] = [];
  for (const r of current) {
    const evaluated = getDossierEvaluationDate(r.card);
    if (!evaluated) continue;
    if (isCardInRefreshWindow(r.card, nowMs)) {
      inWindow.push(r);
      continue;
    }
    const q = queued.get(toBasePlayerSlug(r.card.basicInfo.name));
    expiredCurrent.push({
      player: r.card.basicInfo.name,
      club: r.card.basicInfo.club,
      evaluated,
      days: daysSince(evaluated, nowMs),
      asked: asked(r.card.basicInfo.name),
      queued: !!q,
      ...(q ? { queuedReason: `${q.reason} (flagged ${q.day})` } : {}),
    });
  }
  expiredCurrent.sort((a, b) => Number(b.queued) - Number(a.queued) || b.asked - a.asked || a.days - b.days);

  const situationMoved: MovedCard[] = [];
  const checks = inWindow
    .map((r) => ({ r, n: asked(r.card.basicInfo.name) }))
    .sort((a, b) => b.n - a.n || (getDossierEvaluationDate(b.r.card) ?? '').localeCompare(getDossierEvaluationDate(a.r.card) ?? ''))
    .slice(0, SITUATION_CHECKS);
  for (const { r, n } of checks) {
    const card = r.card;
    const evaluated = getDossierEvaluationDate(card)!;
    const windowEnds = dayOf(Date.parse(`${evaluated}T00:00:00Z`) + CARD_REFRESH_DAYS * DAY_MS);
    const base = { player: card.basicInfo.name, club: card.basicInfo.club, evaluated, windowEnds, asked: n };
    const live = await sources.liveClub(card.basicInfo.name).catch(() => null);
    if (live && card.basicInfo.club && card.basicInfo.club !== 'N/A' && !isSameClub(live, card.basicInfo.club)) {
      situationMoved.push({ ...base, reason: `the live record names ${live}, the card ${card.basicInfo.club}` });
      continue;
    }
    if ((Number(card.ratings?.overall) || 0) < STARTER_MIN_OVERALL || !card.basicInfo.club || card.basicInfo.club === 'N/A') continue;
    const xi = await sources.clubXi(card.basicInfo.club).catch(() => null);
    if (xi && xi.names.length >= 9 && !xi.names.some((name) => samePlayerName(name, card.basicInfo.name))) {
      situationMoved.push({ ...base, reason: `${xi.club}'s first-choice XI (stored snapshot, ${xi.asOf.slice(0, 10)}) no longer has him, and the card rates him an everyday starter` });
    }
  }
  situationMoved.sort((a, b) => b.asked - a.asked);

  const coverage = await sources.coverage().catch(() => [] as Coverage[]);
  const historicalGaps: GapCard[] = [];
  for (const r of servedHistorical(rows)) {
    const card = r.card;
    const gaps = card.confidence?.dataGaps ?? [];
    if (gaps.length === 0) continue;
    const ratedAt = Math.max(card.createdAt ?? 0, card.rerateAt ?? 0);
    const fresh = coverage.filter((c) => Date.parse(c.builtAt) > ratedAt);
    const hits = gaps.map((g) => ({ g, c: coverageFor(card, g, fresh) })).filter((h) => h.c);
    if (hits.length === 0) continue;
    historicalGaps.push({
      player: card.basicInfo.name,
      cardKey: getCardKey(card),
      edition: cardEdition(card),
      window: card.version?.seasonOrEra ?? null,
      gaps: hits.filter((h) => h.c === hits[0].c).map((h) => h.g),
      coveredBy: hits[0].c!,
      asked: asked(card.basicInfo.name),
    });
  }
  historicalGaps.sort((a, b) => b.asked - a.asked);

  const pool = servedPool(rows, nowMs);
  const hits = sources.disagreements ? await Promise.resolve(sources.disagreements()).catch(() => [] as DisagreementHit[]) : [];
  return {
    expiredCurrent: expiredCurrent.slice(0, CARD_LIST_CAP),
    situationMoved: situationMoved.slice(0, CARD_LIST_CAP),
    historicalGaps: historicalGaps.slice(0, CARD_LIST_CAP),
    coherence: findCoherence(pool),
    disagreements: findDisagreements(hits, pool),
    calibrationGaps: findCalibrationGaps(pool, nowMs),
  };
}

const refText = (r: CardRef) => `${r.player} (${r.edition}${r.window ? `, ${r.window}` : ''}; Overall ${r.overall})`;

/** The card review signals as the planning call reads them. */
export function formatCardSignals(s: CardReviewSignals): string {
  const list = (lines: string[]) => (lines.length ? lines.map((l) => `- ${l}`).join('\n') : 'none');
  const asked = (n: number) => (n > 0 ? `asked ${n} times` : 'not asked about');
  return `Current cards whose ${CARD_REFRESH_DAYS}-day rating window has closed, so they can be re-rated (queued ones were flagged inside their window, for the reason given):
${list(s.expiredCurrent.map((c) => `${c.player} (${c.club}): rated ${c.evaluated}, ${c.days} days ago; ${asked(c.asked)}${c.queued ? `; queued: ${c.queuedReason}` : ''}`))}

Current cards inside their window whose situation moved (only the Latest Update can change before the window ends; each is queued for re-rating that day):
${list(s.situationMoved.map((c) => `${c.player} (${c.club}): ${c.reason}; window ends ${c.windowEnds}; ${asked(c.asked)}`))}

Historical cards with data gaps that a stored record built after the card now covers:
${list(s.historicalGaps.map((c) => `${c.player}, ${c.edition}${c.window ? ` ${c.window}` : ''} [card ${c.cardKey}]: gaps "${c.gaps.join('"; "')}" covered by the ${c.coveredBy.source === 'era_snapshot' ? 'era snapshot' : 'history record'} of ${c.coveredBy.subject}${c.coveredBy.period ? ` ${c.coveredBy.period}` : ''} (built ${c.coveredBy.builtAt.slice(0, 10)}); ${asked(c.asked)}`))}

Pairs of cards whose placements put each above the other:
${list(s.coherence.pairs.map((p) => `${refText(p.a)} and ${refText(p.b)}: ${p.statements.join('; ')}`))}

Placements that go round in a circle across three cards:
${list(s.coherence.cycles.map((c) => `${c.cards.map(refText).join(' > ')} > back to the first: ${c.statements.join('; ')}`))}

Pairs of cards that answers ordered the other way before the cards settled the order (counted reports, each source once a day; only the counts were kept; either card may be the one out of place; a current card here can be re-rated only once its window ends, and is queued for that day):
${list((s.disagreements ?? []).map((d) => `answers put ${refText(d.lower)} above ${refText(d.higher)}: ${d.reports} reports on ${d.days} days, ${d.firstDay} to ${d.lastDay} (${describeVia(d.via)})${d.waiting.length ? `; waiting for its window: ${d.waiting.map((w) => `${w.player} until ${w.windowEnds}`).join(', ')}` : ''}`))}

Calibration gaps: positions with at least ${GAP_MIN_CURRENT_CARDS} current cards where the best of them sits below every other player's prime, era and season card there whose window ended in the last ${RECENT_HISTORICAL_YEARS} years (reported by code; it doesn't show which side is out of place and changes no rating; the current card can be re-rated only once its window ends, and is queued for that day):
${list((s.calibrationGaps ?? []).map((g) => `${g.position}: ${refText(g.current)} sits below all ${g.recent} recent historical cards there, nearest first: ${g.above.map(refText).join(', ')}; window ends ${g.windowEnds}`))}

Each position's Overall distribution against the whole pool (a reported figure, not a reason to review a card):
${list(s.coherence.positions.map((p) => `${p.position}: ${p.cards} cards, mean ${p.mean}, median ${p.median} (pool mean ${p.poolMean}, median ${p.poolMedian})`))}`;
}

const describeVia = (via: Partial<Record<DisagreementPath, number>>): string =>
  [via.debate ? `${via.debate} from debate answers` : '', via.ranking ? `${via.ranking} from drawn rankings` : '', via.commit ? `${via.commit} from committed verdicts` : '']
    .filter(Boolean)
    .join(', ') || 'no path recorded';

// ---------------------------------------------------------------------------------------------
// What the planner may name

/** Players and cards each card action may name, from the signals. */
export function cardTargets(s: CardReviewSignals | null | undefined) {
  const primeFrom = (refs: CardRef[]) => refs.filter((r) => r.edition === 'prime').map((r) => toBasePlayerSlug(r.player));
  return {
    rerate: new Set((s?.expiredCurrent ?? []).map((c) => toBasePlayerSlug(c.player))),
    refreshable: new Set((s?.situationMoved ?? []).map((c) => toBasePlayerSlug(c.player))),
    fill: new Set((s?.historicalGaps ?? []).map((c) => c.cardKey)),
    review: new Set([
      ...(s?.historicalGaps ?? []).filter((c) => c.edition === 'prime').map((c) => toBasePlayerSlug(c.player)),
      ...primeFrom((s?.coherence.pairs ?? []).flatMap((p) => [p.a, p.b])),
      ...primeFrom((s?.coherence.cycles ?? []).flatMap((c) => c.cards)),
      ...primeFrom((s?.disagreements ?? []).flatMap((d) => [d.higher, d.lower])),
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Why a review was opened

export interface Opened {
  kind: 'new_record' | 'contradiction' | 'disagreement';
  /** One line naming the signal. */
  summary: string;
  /** The record's text, or the contradiction as it stands today; null when it could no longer be read. */
  evidence: string | null;
}

/**
 * The reason to review a player's prime, from today's signals: a stored record that covers his
 * card's gaps, else a placement contradiction his prime is part of, re-checked against the pool as
 * it stands now. Null when the signals give none, so a rating is never reviewed without one.
 */
export async function openedFor(
  player: string,
  signals: CardReviewSignals | null | undefined,
  read: { recordText(c: Coverage): Promise<string | null>; pool(): Promise<PlayerProfile[]> },
): Promise<Opened | null> {
  const base = toBasePlayerSlug(player);
  const gap = signals?.historicalGaps.find((g) => g.edition === 'prime' && toBasePlayerSlug(g.player) === base);
  if (gap) {
    const record = await read.recordText(gap.coveredBy).catch(() => null);
    return {
      kind: 'new_record',
      summary: `His prime card lists gaps ("${gap.gaps.join('"; "')}") that the ${gap.coveredBy.source === 'era_snapshot' ? 'era snapshot' : 'history record'} of ${gap.coveredBy.subject}${gap.coveredBy.period ? ` ${gap.coveredBy.period}` : ''}, built after the card, now covers.`,
      evidence: record,
    };
  }
  const mine = (r: CardRef) => r.edition === 'prime' && toBasePlayerSlug(r.player) === base;
  const flagged = signals?.coherence.pairs.some((p) => mine(p.a) || mine(p.b)) || signals?.coherence.cycles.some((c) => c.cards.some(mine));
  if (!flagged) {
    const d = (signals?.disagreements ?? []).find((x) => mine(x.higher) || mine(x.lower));
    return d ? openedForDisagreement(d, mine(d.higher) ? d.lower : d.higher, await read.pool()) : null;
  }
  const now = findCoherence(await read.pool(), Number.MAX_SAFE_INTEGER);
  const pair = now.pairs.find((p) => mine(p.a) || mine(p.b));
  const cycle = now.cycles.find((c) => c.cards.some(mine));
  const evidence = pair
    ? `${refText(pair.a)} and ${refText(pair.b)} each place themselves above the other: ${pair.statements.join('; ')}.`
    : cycle
      ? `Three cards' placements go round in a circle: ${cycle.cards.map(refText).join(' above ')}, and the last above the first (${cycle.statements.join('; ')}).`
      : null;
  return {
    kind: 'contradiction',
    summary: pair ? 'His prime card and another card each place themselves above the other.' : 'His prime card is part of three placements that go round in a circle.',
    evidence,
  };
}

/**
 * A review opened on a disagreement pair, re-checked against today's pool: the evidence is the
 * count and both cards as they stand, or null when the pair no longer holds (a card was re-rated,
 * or the cards now agree with the answers).
 */
export function openedForDisagreement(d: DisagreementPair, other: CardRef, pool: PlayerProfile[]): Opened {
  const holds = resolveDisagreement({ higher: d.higher.cardKey, lower: d.lower.cardKey }, pool);
  const [higher, lower] = holds ? [refOf(holds.higher), refOf(holds.lower)] : [d.higher, d.lower];
  return {
    kind: 'disagreement',
    summary: `Answers about how good the players were ordered his prime card and ${other.player}'s ${other.edition} card the other way from the cards, and code turned the order round to follow the cards.`,
    evidence: holds
      ? `Answers placed ${refText(lower)} above ${refText(higher)} ${d.reports} times on ${d.days} days (${d.firstDay} to ${d.lastDay}; ${describeVia(d.via)}) before code put them in card order. Today the cards still rank ${refText(higher)} above ${refText(lower)}. Only the count was kept, not the answers' reasons, so it settles nothing about either player's football on its own: either card may be the one out of place, and the rating moves only as far as the evidence the draft gathers shows.`
      : null,
  };
}

/** What the drafting pipeline reads in its task: the reason and the evidence, and the reviewer's notes on a second draft. */
export function draftNote(opened: Opened, notes: string | null): string {
  return `This rating reviews the published card for this version. The review was opened for this reason: ${opened.summary}
Evidence the review was opened on:
${opened.evidence ?? '(not available)'}
Rate the version from all the evidence as always. Where this evidence settles something, follow it; where it settles nothing, it is no reason to move anything.${
    notes ? `\nA reviewer read the previous draft and asked for these changes: ${notes}` : ''
  }`;
}

// ---------------------------------------------------------------------------------------------
// Code guards

const tierIndex = (overall: number) => RATING_TIERS.findIndex((t) => t.id === getTierDefinition(overall).id);

/** Tier bands between two Overalls: 0 in the same band, 1 into the next. */
export const bandsCrossed = (a: number, b: number): number => Math.abs(tierIndex(a) - tierIndex(b));

const windowSeasons = (p: PlayerProfile): number | null => {
  const w = p.version?.primeWindow;
  const span = w ? seasonSpan(`${w.startSeason.slice(0, 4)}-${w.endSeason.slice(5, 7)}`) : seasonSpan(p.version?.seasonOrEra);
  return span ? span[1] - span[0] + 1 : null;
};

/**
 * Code's checks on a prime draft before the reviewer sees it. Returns why the draft is refused, or
 * null. A draft that crosses more than one tier band needs a new record or a contradiction in its
 * evidence; the window rules and the draft's own placement must hold against today's pool.
 */
export function guardDraft(old: PlayerProfile, draft: PlayerProfile, opened: Opened, pool: PlayerProfile[]): string | null {
  if (cardEdition(draft) !== 'prime') return `the draft is a ${cardEdition(draft)} card, not a prime`;
  if (toBasePlayerSlug(draft.basicInfo.name) !== toBasePlayerSlug(old.basicInfo.name)) return `the draft rates ${draft.basicInfo.name}, not ${old.basicInfo.name}`;
  const seasons = windowSeasons(draft);
  if (seasons !== null && seasons > MAX_WINDOW_SEASONS) return `the draft's window covers ${seasons} seasons, more than ${MAX_WINDOW_SEASONS}`;
  if (seasons !== null && seasons < MIN_WINDOW_SEASONS) return `the draft's window covers one season; a prime spans at least ${MIN_WINDOW_SEASONS}`;
  const [before, after] = [Number(old.ratings?.overall) || 0, Number(draft.ratings?.overall) || 0];
  const crossed = bandsCrossed(before, after);
  if (crossed > 1 && !opened.evidence) {
    return `the Overall moves from ${before} to ${after}, across ${crossed} tier bands, without a new record or a contradiction in its evidence`;
  }
  // A count of disagreements is not a record: on its own it never moves a card more than one band.
  if (crossed > 1 && opened.kind === 'disagreement') {
    return `the Overall moves from ${before} to ${after}, across ${crossed} tier bands, on a review opened by a count of disagreements rather than a new record or a contradiction`;
  }
  const resolved = resolvePlacement(draft.peerPlacement, pool.filter((p) => getCardKey(p) !== getCardKey(old)), draft);
  if (resolved.betterThan.length + resolved.levelWith.length + resolved.notAsGoodAs.length > 0) {
    const range = placementRange(resolved);
    if (!range) return "the draft's own peer placement contradicts itself against today's cards";
    if (after < range.min || after > range.max) return `the draft's Overall ${after} lies outside the range its own placement allows against today's cards (${range.min} to ${range.max})`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The reviewer

export type Verdict = 'accept' | 'revise' | 'refuse';

export interface ReviewAnswer {
  verdict: Verdict;
  reasons: string[];
  notes: string;
  checks: { evidenceDriven: boolean; rulesHold: boolean; figuresSupported: boolean; proportionate: boolean };
}

export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    checks: {
      type: Type.OBJECT,
      properties: {
        evidenceDriven: { type: Type.BOOLEAN },
        rulesHold: { type: Type.BOOLEAN },
        figuresSupported: { type: Type.BOOLEAN },
        proportionate: { type: Type.BOOLEAN },
      },
      required: ['evidenceDriven', 'rulesHold', 'figuresSupported', 'proportionate'],
    },
    verdict: { type: Type.STRING, enum: ['accept', 'revise', 'refuse'] },
    reasons: { type: Type.ARRAY, items: { type: Type.STRING } },
    notes: { type: Type.STRING },
  },
  required: ['checks', 'verdict', 'reasons', 'notes'],
};

export interface ReviewInput {
  round: 1 | 2;
  old: PlayerProfile;
  draft: PlayerProfile;
  opened: Opened;
  /** The ledger's neighbouring cards: same position, close in Overall. */
  neighbours: PlayerProfile[];
}

/** A card as the reviewer reads it: rating, window, placement, evidence and the prose that carries its figures. */
export function describeCard(p: PlayerProfile): string {
  const o = Number(p.ratings?.overall) || 0;
  const pl = p.peerPlacement;
  const lines = [
    `${p.basicInfo.name}: ${cardEdition(p)}${p.version?.seasonOrEra ? `, ${p.version.seasonOrEra}` : ''}, evaluated ${getDossierEvaluationDate(p) ?? 'undated'}`,
    `Overall ${o} (${getTierDefinition(o).label}), Potential ${p.ratings?.potential ?? o}; ${p.basicInfo.position}, ${p.basicInfo.club}`,
    pl ? `Placement: better than ${pl.betterThan.join(', ') || 'nobody named'}; level with ${pl.levelWith.join(', ') || 'nobody named'}; not as good as ${pl.notAsGoodAs.join(', ') || 'nobody named'}` : 'Placement: none recorded',
    p.peerBenchmark ? `Benchmark: ${p.peerBenchmark}` : '',
    p.confidence ? `Evidence: grade ${p.confidence.grade}, ${p.confidence.sampleSize}; gaps: ${p.confidence.dataGaps.join('; ') || 'none'}; ${p.confidence.verdict}` : '',
    p.scoutingDebate ? `Case for higher: ${p.scoutingDebate.caseForHigher}\nCase for lower: ${p.scoutingDebate.caseForLower}` : '',
    p.shortBio ? `Bio: ${p.shortBio}` : '',
    p.playstyleAndRole?.playstyle?.description ? `Playstyle: ${p.playstyleAndRole.playstyle.description}` : '',
    p.definingMoments?.length ? `Defining moments: ${p.definingMoments.map((m) => `${m.year} ${m.title}: ${m.description}`).join(' | ')}` : '',
    p.strengths?.length ? `Strengths: ${p.strengths.join(' | ')}` : '',
    p.weaknesses?.length ? `Weaknesses: ${p.weaknesses.join(' | ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

const neighbourLine = (p: PlayerProfile) => {
  const o = Number(p.ratings?.overall) || 0;
  const pl = p.peerPlacement;
  return `${p.basicInfo.name} (${cardEdition(p)}${p.version?.seasonOrEra && isPrimeCard(p) ? `, ${p.version.seasonOrEra}` : ''}): Overall ${o}, ${p.basicInfo.position}${
    pl ? `; better than ${pl.betterThan.join(', ') || 'nobody named'}; not as good as ${pl.notAsGoodAs.join(', ') || 'nobody named'}` : ''
  }`;
};

export const buildReviewPrompt = (i: ReviewInput): string => `You are the reviewing scout of Futbolpedia. A card rates one version of a player; a prime card is otherwise frozen, and every later card is rated against it, so a new rating of a prime is published only when you accept it. Another scout drafted the new rating below. You see the published card, the draft, why the review was opened and its evidence, and the neighbouring cards in the pool; you did not see the drafting.

Answer four questions about the draft:
1. evidenceDriven: is every change from the published card to the draft, in the rating, the window and the placement, driven by the evidence or the contradiction the review was opened for? A change nothing below explains does not hold.
2. rulesHold: do the card rules hold? The Overall agrees with the draft's own placement and with the neighbouring cards it names; a prime is one stretch of ${MIN_WINDOW_SEASONS} to ${MAX_WINDOW_SEASONS} consecutive seasons, rated at the level sustained across it; the rating judges how good a footballer the version was, with numbers and honours as evidence, never as the measure.
3. figuresSupported: is every precise figure in the draft (appearances, goals, trophies, seasons, fees) supported by the evidence below or already on the published card?
4. proportionate: does the rating move no further than the evidence warrants? A record that fills a gap can confirm a rating or move it as far as it shows; a contradiction with another card is resolved by the smallest move that resolves it, and may call for no move on this card when the other card is the one out of place.

Then give the verdict: accept when all four hold; revise when the draft could hold with changes you can name; refuse when it should not replace the published card, including when the evidence doesn't justify changing it. ${
  i.round === 2
    ? 'This is the second and last draft, written with your earlier notes: answer accept or refuse.'
    : 'With revise, write notes for the drafting scout: what to change and why, as a scout would say it, without proposing a number.'
} Give a reason for each question that fails, or one line for the verdict when all hold.

<review_opened>
${i.opened.summary}
Evidence:
${i.opened.evidence ?? '(not available)'}
</review_opened>

<published_card>
${describeCard(i.old)}
</published_card>

<draft>
${describeCard(i.draft)}
</draft>

<neighbouring_cards>
${i.neighbours.map(neighbourLine).join('\n') || 'none'}
</neighbouring_cards>`;

/** The answer as code uses it: unknown verdicts refuse; an accept with a failing check, or a revise on the last round, does not stand. */
export function sanitizeReview(raw: any, round: 1 | 2): ReviewAnswer {
  const checks = {
    evidenceDriven: raw?.checks?.evidenceDriven === true,
    rulesHold: raw?.checks?.rulesHold === true,
    figuresSupported: raw?.checks?.figuresSupported === true,
    proportionate: raw?.checks?.proportionate === true,
  };
  const reasons = (Array.isArray(raw?.reasons) ? raw.reasons : []).map((r: unknown) => text(r, 400)).filter(Boolean).slice(0, 8);
  const notes = text(raw?.notes, 2000);
  let verdict: Verdict = raw?.verdict === 'accept' || raw?.verdict === 'revise' || raw?.verdict === 'refuse' ? raw.verdict : 'refuse';
  if (verdict === 'accept' && !Object.values(checks).every(Boolean)) {
    reasons.push('Accepted with a check that failed, so it does not stand as an accept.');
    verdict = round === 1 && notes ? 'revise' : 'refuse';
  }
  if (verdict === 'revise' && (round === 2 || !notes)) {
    reasons.push(round === 2 ? 'A revise on the last draft is a refusal.' : 'A revise without notes is a refusal.');
    verdict = 'refuse';
  }
  return { verdict, reasons: reasons.length ? reasons : [verdict === 'accept' ? 'Every check holds.' : 'No reason given.'], notes, checks };
}

export interface ReviewModel {
  review(input: ReviewInput): Promise<unknown>;
}

/** One schema-enforced call on the `review` task, which thinks harder than synthesis: nothing waits on it. */
export const liveReviewModel: ReviewModel = {
  review: (input) => generateStructured<unknown>({ task: 'review', prompt: buildReviewPrompt(input), schema: REVIEW_SCHEMA }),
};

/** The cards nearest the reviewed one: same position, Overall within three of the old card or the draft. */
export function neighboursOf(old: PlayerProfile, draft: PlayerProfile, pool: PlayerProfile[], max = 10): PlayerProfile[] {
  const base = toBasePlayerSlug(old.basicInfo.name);
  const position = primaryPosition(old);
  const [a, b] = [Number(old.ratings?.overall) || 0, Number(draft.ratings?.overall) || 0];
  const near = (o: number) => Math.min(Math.abs(o - a), Math.abs(o - b));
  return pool
    .filter((p) => toBasePlayerSlug(p.basicInfo.name) !== base && primaryPosition(p) === position && near(Number(p.ratings?.overall) || 0) <= 3)
    .sort((p, q) => Number(isPrimeCard(q)) - Number(isPrimeCard(p)) || near(Number(p.ratings?.overall) || 0) - near(Number(q.ratings?.overall) || 0))
    .slice(0, max);
}

// ---------------------------------------------------------------------------------------------
// The trail

export interface ReviewRound {
  round: 1 | 2;
  by: 'code' | 'reviewer';
  verdict: Verdict;
  reasons: string[];
  notes?: string;
  draftOverall: number | null;
}

export interface CardReviewRow {
  day: string;
  action: 'rerate_current' | 'review_prime';
  card_key: string;
  player: string;
  player_slug: string;
  edition: string;
  reason: string;
  opened: Opened | Record<string, never>;
  old_card: PlayerProfile;
  draft: PlayerProfile | null;
  verdict: 'accept' | 'refuse' | 'rerated';
  reasons: string[];
  revise_notes: string | null;
  rounds: ReviewRound[];
  published: boolean;
  published_card_key: string | null;
  published_at: string | null;
  old_overall: number | null;
  new_overall: number | null;
}

export interface CardReviewStore {
  put(row: CardReviewRow): Promise<void>;
}

export const memoryCardReviewStore = (): CardReviewStore & { rows: CardReviewRow[] } => {
  const rows: CardReviewRow[] = [];
  return { rows, put: async (row) => void rows.push(row) };
};

export function supabaseCardReviewStore(writer: any | null): CardReviewStore {
  return {
    async put(row) {
      if (!writer) throw new Error('no secret key to write card reviews with');
      const { error } = await writer.from('card_reviews').insert(row);
      if (error) throw new Error(`card_reviews write failed: ${error.message ?? error}`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The actions

/** A card at a moment, for the journal's before and after. */
export interface CardMoment {
  cardKey: string;
  overall: number;
  tier: string;
  evaluated: string | null;
  window: string | null;
  dataGaps?: number;
}

export const momentOf = (p: PlayerProfile): CardMoment => ({
  cardKey: getCardKey(p),
  overall: Number(p.ratings?.overall) || 0,
  tier: getTierDefinition(Number(p.ratings?.overall) || 0).shortLabel,
  evaluated: getDossierEvaluationDate(p),
  window: isPrimeCard(p) ? p.version?.seasonOrEra ?? null : null,
  ...(isPrimeCard(p) ? { dataGaps: p.confidence?.dataGaps?.length ?? 0 } : {}),
});

export interface CardActionResult {
  ok: boolean;
  calls: number;
  detail: string;
  before?: CardMoment;
  after?: CardMoment;
}

/** Reads and writes full cards. Live: the server's secret-key client and `upsertCachedDossier`. */
export interface CardStore {
  /** The full card at a pointer (`prime` for his prime), or null. */
  pointer(name: string, prime: boolean): Promise<PlayerProfile | null>;
  /** The full stored card with this key, by its archive slug or its pointer. */
  byKey(cardKey: string, name: string): Promise<{ slug: string; card: PlayerProfile; rowAt: number }[]>;
  /** Publishes a card through the shared cache's write path (pointer and archive rows). */
  publish(card: PlayerProfile, options: { supersede: boolean }): Promise<void>;
  /** Rewrites a row's card in place, leaving its time alone; true when the write landed. */
  writeInPlace(slug: string, card: PlayerProfile): Promise<boolean>;
}

/** The pipeline. Live: `ratePlayer` and `draftPrimeRerate` in services/geminiService.ts. */
export interface Drafter {
  rerateCurrent(name: string): Promise<string | PlayerProfile>;
  draftPrime(name: string, note: string): Promise<string | PlayerProfile>;
}

export interface FactFillModel {
  fill(input: { card: string; gaps: string[]; record: string }): Promise<unknown>;
}

export const FILL_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    filled: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { gap: { type: Type.STRING }, fact: { type: Type.STRING } }, required: ['gap', 'fact'] },
    },
  },
  required: ['filled'],
};

export const buildFillPrompt = (i: { card: string; gaps: string[]; record: string }): string => `A Futbolpedia card lists facts its sources didn't cover when it was rated. A record built since then may cover some of them. For each listed gap the record settles, write the fact in one plain sentence, as the record gives it, with its competition and season. Leave out a gap the record doesn't settle; don't fill anything from memory, and don't judge the player.

<card>
${i.card}
</card>

<gaps>
${i.gaps.map((g) => `- ${g}`).join('\n')}
</gaps>

<record>
${i.record}
</record>`;

export const liveFactFillModel: FactFillModel = {
  fill: (input) => generateStructured<unknown>({ task: 'extraction', prompt: buildFillPrompt(input), schema: FILL_SCHEMA }),
};

export interface CardActorDeps {
  store: CardStore;
  drafter: Drafter;
  reviewer: ReviewModel;
  filler: FactFillModel;
  reviews: CardReviewStore;
  /** The served pool today, with placements, for guards, neighbours and re-checking contradictions. */
  pool(): Promise<PlayerProfile[]>;
  recordText(c: Coverage): Promise<string | null>;
  now?: () => number;
  /** Waits between reads while a re-rated card's write lands. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CardActionContext {
  signals: CardReviewSignals | null;
  /** Card calls left in today's budget before this action. */
  remaining: number;
  /** The planner's one-line reason. */
  reason: string;
}

export interface CardActors {
  rerateCurrent(player: string, ctx: CardActionContext): Promise<CardActionResult>;
  fillFacts(cardKey: string, ctx: CardActionContext): Promise<CardActionResult>;
  reviewPrime(player: string, ctx: CardActionContext): Promise<CardActionResult>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createCardActors(deps: CardActorDeps): CardActors {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const iso = () => new Date(now()).toISOString();
  const day = () => dayOf(now());

  const record = async (row: CardReviewRow) => {
    try {
      await deps.reviews.put(row);
    } catch (e) {
      console.warn('[card-review] review row not saved:', (e as Error)?.message ?? e);
    }
  };

  return {
    async rerateCurrent(player, ctx) {
      const old = await deps.store.pointer(player, false);
      if (!old || isPrimeCard(old)) return { ok: false, calls: 0, detail: 'no shared current card' };
      if (isCardInRefreshWindow(old, now())) return { ok: false, calls: 0, detail: 'still inside its rating window', before: momentOf(old) };
      const started = now();
      const result = await deps.drafter.rerateCurrent(old.basicInfo.name);
      if (typeof result === 'string') return { ok: false, calls: DRAFT_CALLS, detail: `the pipeline gave no card: ${result.slice(0, 120)}`, before: momentOf(old) };
      if (getCardKey(result) === getCardKey(old) || (result.createdAt ?? 0) < started) {
        return { ok: false, calls: 1, detail: 'a newer card was already published; it was served, not re-rated', before: momentOf(old), after: momentOf(result) };
      }
      let published: PlayerProfile | null = null;
      for (let i = 0; i < PUBLISH_CONFIRM_TRIES && !published; i++) {
        const stored = await deps.store.pointer(result.basicInfo.name, false).catch(() => null);
        if (stored && getCardKey(stored) === getCardKey(result)) published = stored;
        else await sleep(PUBLISH_CONFIRM_MS);
      }
      await record({
        day: day(),
        action: 'rerate_current',
        card_key: getCardKey(old),
        player: old.basicInfo.name,
        player_slug: toBasePlayerSlug(old.basicInfo.name),
        edition: 'current',
        reason: text(ctx.reason, 600) || `Its ${CARD_REFRESH_DAYS}-day rating window closed.`,
        opened: {},
        old_card: old,
        draft: result,
        verdict: 'rerated',
        reasons: [`The current card's ${CARD_REFRESH_DAYS}-day window closed, so it was re-rated through the pipeline a visitor's request uses.`],
        revise_notes: null,
        rounds: [],
        published: !!published,
        published_card_key: published ? getCardKey(published) : null,
        published_at: published ? iso() : null,
        old_overall: Number(old.ratings?.overall) || null,
        new_overall: Number(result.ratings?.overall) || null,
      });
      return {
        ok: !!published,
        calls: DRAFT_CALLS,
        detail: published ? `re-rated: Overall ${old.ratings.overall} to ${result.ratings.overall}` : 'rated, but the published card was not found afterwards',
        before: momentOf(old),
        after: momentOf(result),
      };
    },

    async fillFacts(cardKey, ctx) {
      const signal = ctx.signals?.historicalGaps.find((g) => g.cardKey === cardKey);
      if (!signal) return { ok: false, calls: 0, detail: 'no signal names this card' };
      const rows = await deps.store.byKey(cardKey, signal.player);
      const card = rows[0]?.card;
      if (!card) return { ok: false, calls: 0, detail: 'no stored card with this key' };
      const recordText = await deps.recordText(signal.coveredBy).catch(() => null);
      if (!recordText) return { ok: false, calls: 0, detail: 'the stored record could not be read', before: momentOf(card) };
      const raw: any = await deps.filler.fill({ card: describeCard(card), gaps: signal.gaps, record: recordText });
      const asked = new Set(signal.gaps);
      const filled = (Array.isArray(raw?.filled) ? raw.filled : [])
        .map((f: any) => ({ gap: text(f?.gap, 300), fact: text(f?.fact, 400) }))
        .filter((f: { gap: string; fact: string }) => asked.has(f.gap) && f.fact);
      if (filled.length === 0) return { ok: false, calls: 1, detail: 'the record settles none of the gaps', before: momentOf(card) };
      const source = `${signal.coveredBy.source === 'era_snapshot' ? 'era snapshot' : 'history record'}: ${signal.coveredBy.subject}${signal.coveredBy.period ? ` ${signal.coveredBy.period}` : ''}`;
      const done = new Set(filled.map((f: { gap: string }) => f.gap));
      let landed = 0;
      for (const row of rows) {
        const next: PlayerProfile = {
          ...row.card,
          confidence: row.card.confidence ? { ...row.card.confidence, dataGaps: row.card.confidence.dataGaps.filter((g) => !done.has(g)) } : row.card.confidence,
          filledGaps: [...(row.card.filledGaps ?? []), ...filled.map((f: { gap: string; fact: string }) => ({ ...f, source, filledOn: day() }))],
        };
        if (await deps.store.writeInPlace(row.slug, next).catch(() => false)) landed++;
      }
      const after = { ...card, confidence: card.confidence ? { ...card.confidence, dataGaps: card.confidence.dataGaps.filter((g) => !done.has(g)) } : card.confidence };
      return landed > 0
        ? { ok: true, calls: 1, detail: `${filled.length} of ${signal.gaps.length} gaps filled from the ${source}, on ${landed} of ${rows.length} rows`, before: momentOf(card), after: momentOf(after) }
        : { ok: false, calls: 1, detail: 'the refresh-window trigger skipped the write (its fact-fill migration is not applied)', before: momentOf(card) };
    },

    async reviewPrime(player, ctx) {
      const old = await deps.store.pointer(player, true);
      if (!old || cardEdition(old) !== 'prime' || old.revision) return { ok: false, calls: 0, detail: 'no shared prime card' };
      const opened = await openedFor(player, ctx.signals, { recordText: deps.recordText, pool: deps.pool });
      if (!opened) return { ok: false, calls: 0, detail: 'the signals give no reason to review this card', before: momentOf(old) };
      if (!opened.evidence && opened.kind !== 'new_record') return { ok: false, calls: 0, detail: `the ${opened.kind} no longer holds in today's pool`, before: momentOf(old) };
      return reviewPrimeCard(old, opened, ctx, deps, { now, iso, day, record });
    },
  };
}

/**
 * The prime review: a draft, code's guards, the reviewer; on `revise`, one more draft with the
 * notes and a final review. Only an accepted draft is published, through the rerate path.
 */
export async function reviewPrimeCard(
  old: PlayerProfile,
  opened: Opened,
  ctx: CardActionContext,
  deps: CardActorDeps,
  util: { now: () => number; iso: () => string; day: () => string; record: (row: CardReviewRow) => Promise<void> },
): Promise<CardActionResult> {
  const pool = await deps.pool().catch(() => [] as PlayerProfile[]);
  const rounds: ReviewRound[] = [];
  let calls = 0;
  let notes: string | null = null;
  let draft: PlayerProfile | null = null;
  let final: Verdict = 'refuse';
  let reasons: string[] = [];

  for (const round of [1, 2] as const) {
    if (calls + REVIEW_ROUND_CALLS > ctx.remaining) {
      reasons = [`No budget for draft ${round}: it would cost about ${REVIEW_ROUND_CALLS} calls with ${ctx.remaining - calls} left.`];
      rounds.push({ round, by: 'code', verdict: 'refuse', reasons, draftOverall: null });
      break;
    }
    const result = await deps.drafter.draftPrime(old.basicInfo.name, draftNote(opened, notes));
    calls += DRAFT_CALLS;
    if (typeof result === 'string') {
      reasons = [`The pipeline gave no card: ${result.slice(0, 200)}`];
      rounds.push({ round, by: 'code', verdict: 'refuse', reasons, draftOverall: null });
      break;
    }
    draft = result.rerateAt ? result : { ...result, rerateAt: util.now() };
    const guard = guardDraft(old, draft, opened, pool);
    if (guard) {
      reasons = [`Refused by code: ${guard}.`];
      rounds.push({ round, by: 'code', verdict: 'refuse', reasons, draftOverall: draft.ratings.overall });
      break;
    }
    let answer: ReviewAnswer;
    try {
      answer = sanitizeReview(await deps.reviewer.review({ round, old, draft, opened, neighbours: neighboursOf(old, draft, pool) }), round);
    } catch (e) {
      answer = { verdict: 'refuse', reasons: [`The review call failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`], notes: '', checks: { evidenceDriven: false, rulesHold: false, figuresSupported: false, proportionate: false } };
    }
    calls += REVIEW_CALLS;
    rounds.push({ round, by: 'reviewer', verdict: answer.verdict, reasons: answer.reasons, ...(answer.notes ? { notes: answer.notes } : {}), draftOverall: draft.ratings.overall });
    reasons = answer.reasons;
    if (answer.verdict !== 'revise') {
      final = answer.verdict;
      break;
    }
    notes = answer.notes;
  }

  let published: PlayerProfile | null = null;
  if (final === 'accept' && draft) {
    try {
      await deps.store.publish(draft, { supersede: true });
      const check = await deps.store.pointer(draft.basicInfo.name, true);
      if (check && check.rerateAt === draft.rerateAt) published = check;
      else reasons = [...reasons, 'Accepted, but the write did not land (the rerate trigger skipped it).'];
    } catch (e) {
      reasons = [...reasons, `Accepted, but the write failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`];
    }
  }
  const reviseNotes = rounds.find((r) => r.verdict === 'revise')?.notes ?? null;
  await util.record({
    day: util.day(),
    action: 'review_prime',
    card_key: getCardKey(old),
    player: old.basicInfo.name,
    player_slug: toBasePlayerSlug(old.basicInfo.name),
    edition: 'prime',
    reason: text(`${opened.summary}${ctx.reason ? ` Planner: ${ctx.reason}` : ''}`, 600),
    opened,
    old_card: old,
    draft,
    verdict: final,
    reasons,
    revise_notes: reviseNotes,
    rounds,
    published: !!published,
    published_card_key: published ? getCardKey(published) : null,
    published_at: published ? util.iso() : null,
    old_overall: Number(old.ratings?.overall) || null,
    new_overall: draft ? Number(draft.ratings?.overall) || null : null,
  });
  const last = rounds[rounds.length - 1];
  const how = `${rounds.map((r) => `${r.by === 'code' ? 'code' : 'reviewer'} ${r.verdict}`).join(', then ')}`;
  return {
    ok: !!published,
    calls,
    detail: published
      ? `accepted and published (${how}): Overall ${old.ratings.overall} to ${published.ratings.overall}`
      : `${final === 'accept' ? 'accepted but not published' : 'refused'} (${how})${last ? `: ${last.reasons[0] ?? ''}` : ''}`.slice(0, 240),
    before: momentOf(old),
    ...(draft ? { after: momentOf(published ?? draft) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Live wiring

const OUTLINE_FIELDS =
  'player_slug, updated_at, basicInfo:player_data->basicInfo, ratings:player_data->ratings, version:player_data->version, createdAt:player_data->createdAt, evaluationDate:player_data->evaluationDate, revision:player_data->revision, rerateAt:player_data->rerateAt, peerPlacement:player_data->peerPlacement, confidence:player_data->confidence';

/** Every card row as an outline with its placement and data gaps, through the server's client. */
export async function readCardRows(client: any, limit = 4000): Promise<StoredCard[]> {
  const { data, error } = await client.from('player_profiles').select(OUTLINE_FIELDS).order('updated_at', { ascending: false }).limit(limit);
  if (error || !Array.isArray(data)) throw new Error(error?.message ?? 'no rows');
  return (data as Array<Record<string, any>>)
    .filter((r) => r.basicInfo?.name && typeof r.player_slug === 'string')
    .map((r) => {
      const rowAt = Date.parse(r.updated_at);
      return {
        slug: r.player_slug,
        rowAt,
        card: {
          basicInfo: r.basicInfo,
          ratings: r.ratings ?? {},
          version: r.version ?? undefined,
          createdAt: r.createdAt ?? rowAt,
          evaluationDate: r.evaluationDate ?? undefined,
          revision: r.revision ?? undefined,
          rerateAt: r.rerateAt ?? undefined,
          peerPlacement: r.peerPlacement ?? undefined,
          confidence: r.confidence ?? undefined,
        } as unknown as PlayerProfile,
      };
    });
}

/** The card store through a Supabase client made with the secret key. */
export function supabaseCardStore(client: any, publish: (card: PlayerProfile, options: { supersede: boolean }) => Promise<void>): CardStore {
  const readSlug = async (slug: string) => {
    const { data, error } = await client.from('player_profiles').select('player_slug, player_data, updated_at').eq('player_slug', slug).maybeSingle();
    if (error) throw new Error(error.message ?? String(error));
    if (!data?.player_data) return null;
    const rowAt = Date.parse(data.updated_at);
    const card = ensureDossierDated(data.player_data as PlayerProfile, rowAt);
    return card ? { slug: data.player_slug as string, card, rowAt, updatedAt: data.updated_at as string } : null;
  };
  return {
    async pointer(name, prime) {
      return (await readSlug(toDossierCardSlug(name, prime)))?.card ?? null;
    },
    async byKey(cardKey, name) {
      const out: { slug: string; card: PlayerProfile; rowAt: number }[] = [];
      const pointer = await readSlug(toDossierCardSlug(name, true));
      const anyCard = pointer && getCardKey(pointer.card) === cardKey ? pointer.card : null;
      const versioned = anyCard ? toVersionedSlug(anyCard) : `${cardKey.split(':')[0]}--${cardKey.split(':')[1]}--${cardKey.split(':').slice(2).join(':')}`;
      const archive = versioned ? await readSlug(versioned) : null;
      if (archive && getCardKey(archive.card) === cardKey) out.push(archive);
      if (pointer && getCardKey(pointer.card) === cardKey) out.push(pointer);
      return out;
    },
    publish,
    async writeInPlace(slug, card) {
      const before = await readSlug(slug);
      if (!before) return false;
      const { error } = await client.from('player_profiles').update({ player_data: card }).eq('player_slug', slug);
      if (error) return false;
      const after = await readSlug(slug);
      return JSON.stringify(after?.card.filledGaps ?? null) === JSON.stringify(card.filledGaps ?? null);
    },
  };
}

/** Era snapshot rows and the history cache, as records that may cover a card's gaps. */
export async function readEraCoverage(client: any): Promise<Coverage[]> {
  const { data, error } = await client.from('era_snapshots').select('snapshot_key, kind, subject, period, built_at').limit(2000);
  if (error || !Array.isArray(data)) return [];
  return data
    .filter((r: any) => r.kind === 'club_season' || r.kind === 'player_window')
    .map((r: any) => ({ source: 'era_snapshot' as const, kind: r.kind, subject: String(r.subject), period: String(r.period), builtAt: String(r.built_at), ref: String(r.snapshot_key) }));
}

/** An era snapshot's text, as chat files it. */
export async function readEraRecord(client: any, key: string): Promise<string | null> {
  const { data } = await client.from('era_snapshots').select('*').eq('snapshot_key', key).maybeSingle();
  const snapshot = eraRowToSnapshot((data as EraRow | null) ?? null);
  return snapshot ? eraEntry(snapshot).content : null;
}

/** The pipeline on the server: the same `ratePlayer` a visitor's Rate reaches, and the held prime draft. */
export const liveDrafter: Drafter = {
  async rerateCurrent(name) {
    const [{ ratePlayer }, { fetchSupabaseCalibratedPool }] = await Promise.all([import('./geminiService'), import('./dossierCache')]);
    // The peer ledger reads the shared pool, which the server hasn't loaded until something asks.
    await fetchSupabaseCalibratedPool();
    return ratePlayer({ name, edition: 'current' }, []);
  },
  async draftPrime(name, note) {
    const { draftPrimeRerate } = await import('./geminiService');
    return draftPrimeRerate(name, note);
  },
};

export interface LiveCardReviewDeps {
  /** The Supabase client made with the secret key. */
  client: any;
  /** The server's own routes, answered in-process. */
  get: <T>(url: string) => Promise<{ data: T } | { error: string }>;
  /** Stored club snapshots built recently. */
  storedSnapshots(): Promise<{ club: string; builtAt: string; core: { xi: { name: string | null; rotation?: string }[] } }[]>;
  /** The scout's journal rows of the last month, for cards flagged as moved. */
  recentJournal(days: number): Promise<{ day: string; signals: { cardReview?: CardReviewSignals | null } }[]>;
  /** The history cache's entries and their text. */
  history: { entries(): Promise<{ key: string; title: string; builtAt: string }[]>; text(key: string): Promise<string | null> };
  reviews: CardReviewStore;
  /** The server's tally of card order disagreements (the scout tally's `disagreements`). */
  disagreements?: () => DisagreementHit[];
  drafter?: Drafter;
  reviewer?: ReviewModel;
  filler?: FactFillModel;
}

/** Card review's sources and actors on the server. */
export function liveCardReview(deps: LiveCardReviewDeps): { sources: CardReviewSources; actors: CardActors } {
  // The stored snapshots are read once per pass (a minute), not once per card.
  let snapshots: { at: number; map: Promise<Map<string, { club: string; asOf: string; names: string[] }>> } | null = null;
  const xiByClub = () => {
    if (!snapshots || Date.now() - snapshots.at > 60_000) {
      snapshots = {
        at: Date.now(),
        map: deps.storedSnapshots().then(
          (rows) =>
            new Map(
              rows.map((s) => [
                toClubKey(s.club),
                { club: s.club, asOf: s.builtAt, names: s.core.xi.flatMap((x) => [x.name, x.rotation].filter((n): n is string => !!n)) },
              ]),
            ),
        ),
      };
    }
    return snapshots.map;
  };
  const recordText = async (c: Coverage) => (c.source === 'era_snapshot' ? readEraRecord(deps.client, c.ref) : deps.history.text(c.ref));
  const pool = async () => servedPool(await readCardRows(deps.client), Date.now());
  const sources: CardReviewSources = {
    rows: () => readCardRows(deps.client),
    async liveClub(player) {
      const res = await deps.get<{ found: boolean; team?: string }>(`/api/live/player?${new URLSearchParams({ name: player })}`);
      return 'error' in res || !res.data.found ? null : res.data.team ?? null;
    },
    async clubXi(club) {
      const map = await xiByClub();
      for (const [key, xi] of map) if (key === toClubKey(club) || isSameClub(xi.club, club)) return xi;
      return null;
    },
    async coverage() {
      const [eras, history] = await Promise.all([readEraCoverage(deps.client), deps.history.entries().catch(() => [])]);
      return [...eras, ...history.map(coverageFromHistoryEntry).filter((c): c is Coverage => c !== null)];
    },
    async queued() {
      return queuedFromJournal(await deps.recentJournal(CARD_REFRESH_DAYS + 1));
    },
    ...(deps.disagreements ? { disagreements: deps.disagreements } : {}),
  };
  // The same write a visitor's rating makes: pointer and archive rows, through the server's secret-key writer.
  const publishCard = async (card: PlayerProfile, options: { supersede: boolean }) => (await import('./dossierCache')).upsertCachedDossier('', card, options);
  const actors = createCardActors({
    store: supabaseCardStore(deps.client, publishCard),
    drafter: deps.drafter ?? liveDrafter,
    reviewer: deps.reviewer ?? liveReviewModel,
    filler: deps.filler ?? liveFactFillModel,
    reviews: deps.reviews,
    pool,
    recordText,
  });
  return { sources, actors };
}

/**
 * The current cards the journal flagged inside their window, queued for the day it ends: moved
 * cards, current cards in a disagreement pair, and current cards in a calibration gap.
 */
export function queuedFromJournal(rows: { day: string; signals: { cardReview?: CardReviewSignals | null } }[]): { player: string; reason: string; day: string }[] {
  return rows.flatMap((r) => [
    ...(r.signals?.cardReview?.calibrationGaps ?? []).map((g) => ({
      player: g.current.player,
      reason: `the best current card at ${g.position} sat below every recent historical card there (${g.recent} of them)`,
      day: r.day,
    })),
    ...(r.signals?.cardReview?.situationMoved ?? []).map((m) => ({ player: m.player, reason: m.reason, day: r.day })),
    ...(r.signals?.cardReview?.disagreements ?? []).flatMap((d) =>
      (d.waiting ?? []).map((w) => {
        const other = toBasePlayerSlug(d.higher.player) === toBasePlayerSlug(w.player) ? d.lower : d.higher;
        return { player: w.player, reason: `answers ordered his current card against ${other.player}'s ${other.edition} card the other way from the cards (${d.reports} reports on ${d.days} days)`, day: r.day };
      }),
    ),
  ]);
}

/** A history cache entry ("2003–04 Arsenal F.C. season", a player's article) read from its title. */
export function coverageFromHistoryEntry(entry: { key: string; title: string; builtAt: string }): Coverage | null {
  const season = entry.title.match(/^(\d{4})[–-](\d{2,4})\s+(.+?)\s+season$/i);
  if (season) {
    const period = normalizePeriod(`${season[1]}-${season[2]}`);
    return period ? { source: 'history', kind: 'club_season', subject: season[3], period, builtAt: entry.builtAt, ref: entry.key } : null;
  }
  const subject = entry.title.replace(/\s*\(.*?\)\s*$/, '').trim();
  return subject ? { source: 'history', kind: 'player_career', subject, period: null, builtAt: entry.builtAt, ref: entry.key } : null;
}
