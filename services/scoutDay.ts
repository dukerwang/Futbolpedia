import { Type } from '@google/genai';
import type { PlayerProfile } from '../types';
import { generateStructured, getCurrentSeasonInfo } from './aiClient';
import { toClubKey } from './clubManagers';
import {
  CARD_REFRESH_DAYS,
  ensureDossierDated,
  getDossierEvaluationDate,
  getLatestUpdateDate,
  isCardInRefreshWindow,
  isPrimeCard,
  LATEST_UPDATE_REFRESH_DAYS,
  needsLatestUpdateRefresh,
  toBasePlayerSlug,
  toDossierCardSlug,
  toPlayerSlug,
} from './dossierCards';
import { isRatedOnCurrentScale } from './dossierCache';
import { normalizePeriod, subjectFromTitle } from './eraSnapshots';
import { rewriteLatestUpdate } from './latestUpdateRefresh';
import type { LiveClubResult } from './liveFootball';
import type { LiveGet, ResearchToolset } from './researchTools';
import type { SnapshotServer } from './snapshotServer';
import { scoutSubjectKey } from './scoutNotes';
import { createDisagreementTally, type CardDisagreement, type DisagreementHit } from './cardDisagreements';
import {
  CARD_ACTION_COST,
  CARD_REVIEW_DEFAULT_CALLS,
  cardTargets,
  formatCardSignals,
  gatherCardSignals,
  type CardActors,
  type CardReviewSources,
  type CardMoment,
  type CardReviewSignals,
} from './cardReview';

/**
 * The scout's day. Once a day, between conversations, one planning call reads a dated summary of
 * what code gathered (what people asked about, where the XI record shows a club's story has gone
 * stale, who plays soon, which cards are ageing, which lookups keep coming back empty) and chooses
 * what to research from a short typed list of actions. Code then runs the list in order with the
 * builders the app already has, until the day's call budget is spent, and writes the whole pass to
 * a journal row. The model decides what is worth researching; code decides what it may do and how
 * much it may spend.
 *
 * Demand and gap tallies live in the server's memory, so a restart loses them: the first pass
 * after a restart plans from a thinner picture and says so in its summary.
 */

// ---------------------------------------------------------------------------------------------
// Constants

/** Model calls a day's pass may spend, the planning call included (`SCOUT_DAY_CALLS`). */
export const SCOUT_DAY_DEFAULT_CALLS = 30;
export const SCOUT_DAY_TICK_MS = 60 * 60 * 1000;
export const MAX_PLAN_ACTIONS = 20;
/** The planning call is one model call. */
export const PLAN_CALLS = 1;
/** What each action costs, in model calls, as the plan prompt tells the model. Card actions are in `CARD_ACTION_COST`. */
export const ACTION_COST = { rebuild_snapshot: 4, build_era: 3, refresh_latest_update: 2, research_note: 1 } as const;
export { CARD_REVIEW_DEFAULT_CALLS };
export const DEMAND_DAYS = 7;
export const LIST_CAP = 20;
/** A latest scored prediction that missed this many names marks a club's story as stale. */
export const STALE_MISSED_NAMES = 3;
export const FIXTURE_WINDOW_MS = 48 * 60 * 60 * 1000;
/** A card is "nearing its refresh date" for this many days before its window closes. */
export const NEARING_REFRESH_DAYS = 3;
/** Planning that fails is tried again on later ticks this many times before the day gives up. */
const MAX_PLAN_ATTEMPTS = 3;
/** A running journal row untouched this long belongs to a pass that died; the next tick resumes it. */
const STALE_RUNNING_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------------------------------------------------------------------------------------------
// Tallies: what the server was asked about, and what its lookups couldn't find

export interface DemandHit {
  name: string;
  hits: number;
}
export interface SeasonHit {
  club: string;
  season: string;
  hits: number;
}
export interface GapTally {
  item: string;
  status: 'empty' | 'failed';
  count: number;
}

const TALLY_CAP = 2_000;

/**
 * In-memory counts of the clubs, players and club seasons the server's routes resolved in the last
 * seven days, and of the lookup gaps they reported. Only names the routes resolved are recorded,
 * never what a user typed. A restart loses them.
 */
export function createScoutTally(now: () => number = Date.now) {
  type Bucket = Map<string, number>;
  const clubs = new Map<string, { name: string; days: Bucket }>();
  const players = new Map<string, { name: string; days: Bucket }>();
  const seasons = new Map<string, { club: string; season: string; days: Bucket }>();
  const gaps = new Map<string, { item: string; status: 'empty' | 'failed'; days: Bucket }>();
  const cardViews = new Map<string, { name: string; days: Bucket }>();
  const disagreements = createDisagreementTally(now);
  const startedAt = now();
  let gaffaTurns: Bucket = new Map();

  const cutoffDay = () => dayOf(now() - (DEMAND_DAYS - 1) * DAY_MS);
  const total = (days: Bucket): number => {
    const from = cutoffDay();
    let n = 0;
    for (const [d, c] of days) if (d >= from) n += c;
    return n;
  };
  const bump = (days: Bucket) => {
    const day = dayOf(now());
    days.set(day, (days.get(day) ?? 0) + 1);
    const from = cutoffDay();
    for (const d of days.keys()) if (d < from) days.delete(d);
  };
  const touch = <T extends { days: Bucket }>(map: Map<string, T>, key: string, make: () => T) => {
    let entry = map.get(key);
    if (!entry) {
      if (map.size >= TALLY_CAP) map.delete(map.keys().next().value as string);
      entry = make();
      map.set(key, entry);
    }
    bump(entry.days);
  };

  return {
    /** A club the live data resolved a request to. */
    club(name: string) {
      const n = text(name, 80);
      if (n) touch(clubs, toClubKey(n), () => ({ name: n, days: new Map() }));
    },
    /** A player the live data resolved a request to. */
    player(name: string) {
      const n = text(name, 80);
      if (n) touch(players, toPlayerSlug(n), () => ({ name: n, days: new Map() }));
    },
    /** A club season the history route resolved a request to. */
    season(club: string, season: string) {
      const c = text(club, 80);
      const s = normalizePeriod(season);
      if (c && s) touch(seasons, `${toClubKey(c)}|${s}`, () => ({ club: c, season: s, days: new Map() }));
    },
    /**
     * A player whose card someone opened (a card page) or asked for a link to (the card lookup),
     * counted for card review. Only names that resolved to a stored card are recorded.
     */
    cardView(name: string) {
      const n = text(name, 80);
      if (n) touch(cardViews, toPlayerSlug(n), () => ({ name: n, days: new Map() }));
    },
    /**
     * A pair of cards an answer ordered the other way before the cards settled it (services/cardDisagreements.ts),
     * from a source: the server's salted hash of the request's address, or "server" for its own turns.
     */
    cardDisagreement(pair: CardDisagreement, source: string): boolean {
      return disagreements.record(pair, source);
    },
    disagreements(): DisagreementHit[] {
      return disagreements.list();
    },
    demandCards(): DemandHit[] {
      return [...cardViews.values()].map((e) => ({ name: e.name, hits: total(e.days) })).filter((e) => e.hits > 0).sort((a, b) => b.hits - a.hits);
    },
    /** One turn on Gaffa's chat route (the clubs it researches count through the live routes). */
    gaffaTurn() {
      bump(gaffaTurns);
    },
    /** A lookup's `missing` entry with status empty or failed. Other statuses aren't gaps to fill. */
    gap(item: string, status: string) {
      if (status !== 'empty' && status !== 'failed') return;
      const i = text(item, 160);
      if (i) touch(gaps, i.toLowerCase(), () => ({ item: i, status, days: new Map() }));
    },
    demandClubs(): DemandHit[] {
      return [...clubs.values()].map((e) => ({ name: e.name, hits: total(e.days) })).filter((e) => e.hits > 0).sort((a, b) => b.hits - a.hits);
    },
    demandPlayers(): DemandHit[] {
      return [...players.values()].map((e) => ({ name: e.name, hits: total(e.days) })).filter((e) => e.hits > 0).sort((a, b) => b.hits - a.hits);
    },
    demandSeasons(): SeasonHit[] {
      return [...seasons.values()].map((e) => ({ club: e.club, season: e.season, hits: total(e.days) })).filter((e) => e.hits > 0).sort((a, b) => b.hits - a.hits);
    },
    gaffaTurns: () => total(gaffaTurns),
    gaps(): GapTally[] {
      return [...gaps.values()].map((e) => ({ item: e.item, status: e.status, count: total(e.days) })).filter((e) => e.count > 0).sort((a, b) => b.count - a.count);
    },
    /** How long the tallies have been counting, so a short window can be told from a quiet week. */
    countingSinceMs: () => now() - startedAt,
  };
}
export type ScoutTally = ReturnType<typeof createScoutTally>;

// ---------------------------------------------------------------------------------------------
// Signals

export interface CardSignal {
  player: string;
  club: string;
  /** The date the line says it describes, or the evaluation date for a card nearing its refresh. */
  asOf: string;
  days: number;
  asked: number;
}

export interface ScoutSignals {
  day: string;
  season: string;
  /** How long the demand and gap tallies have been counting, in hours: under a week after a restart. */
  tallyHours: number;
  demand: { clubs: DemandHit[]; players: DemandHit[]; seasons: SeasonHit[]; gaffaTurns: number };
  /** Clubs whose latest scored prediction missed by three or more names. */
  staleStories: { club: string; kickoff: string; opponent: string; namesRight: number; missed: number; asked: number }[];
  /** Clubs with a stored snapshot that play within 48 hours. */
  fixtures: { club: string; kickoff: string; opponent: string; competition: string; snapshotBuiltAt: string; snapshotOlderThanDay: boolean; asked: number }[];
  cards: { nearingRefresh: CardSignal[]; staleLatestUpdate: CardSignal[] };
  gaps: GapTally[];
  /** Card review's signals (services/cardReview.ts); null when card review is off or its source failed. */
  cardReview?: CardReviewSignals | null;
  /** Sources that couldn't be read for this summary. */
  unread: string[];
}

export interface ScoutSources {
  tally: ScoutTally;
  /** Every club with a stored snapshot built recently, with when. */
  snapshots(): Promise<{ club: string; builtAt: string }[]>;
  /** The club's latest scored XI prediction: the names the better-informed kind got right. */
  latestScored(club: string): Promise<{ kickoff: string; opponent: string; namesRight: number } | null>;
  /** The club's next fixture, when one is listed. */
  nextFixture(club: string): Promise<{ kickoff: string; opponent: string; competition: string } | null>;
  /** The shared current cards' pointer rows, as card outlines with their dates. */
  cards(): Promise<PlayerProfile[]>;
  /** Card review's signals, with how often each player was asked about; absent when card review is off. */
  cardReview?(asked: (player: string) => number): Promise<CardReviewSignals>;
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** The dated summary the planning call reads. Each source that fails is listed under `unread`; the rest still count. */
export async function gatherSignals(sources: ScoutSources, nowMs: number = Date.now()): Promise<ScoutSignals> {
  const { tally } = sources;
  const unread: string[] = [];
  const guard = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      console.warn(`[scout-day] ${label} unread:`, (e as Error)?.message ?? e);
      unread.push(label);
      return fallback;
    }
  };
  const clubHits = new Map(tally.demandClubs().map((c) => [toClubKey(c.name), c.hits]));
  const playerHits = new Map(tally.demandPlayers().map((p) => [toPlayerSlug(p.name), p.hits]));
  const askedClub = (name: string) => clubHits.get(toClubKey(name)) ?? 0;
  // A player's demand: the live player route, card pages and card links, by his name's slug.
  const cardHits = new Map(tally.demandCards().map((p) => [toPlayerSlug(p.name), p.hits]));
  const askedPlayer = (name: string) => (playerHits.get(toPlayerSlug(name)) ?? 0) + (cardHits.get(toPlayerSlug(name)) ?? 0);
  const byAsked = <T extends { asked: number }>(a: T, b: T) => b.asked - a.asked;

  const snapshots = await guard('stored snapshots', () => sources.snapshots(), []);

  const staleStories = (
    await inBatches(snapshots, 6, async (s) => {
      const last = await guard(`prediction record for ${s.club}`, () => sources.latestScored(s.club), null);
      if (!last) return null;
      const missed = 11 - last.namesRight;
      return missed >= STALE_MISSED_NAMES
        ? { club: s.club, kickoff: last.kickoff, opponent: last.opponent, namesRight: last.namesRight, missed, asked: askedClub(s.club) }
        : null;
    })
  )
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort(byAsked)
    .slice(0, LIST_CAP);

  const fixtures = (
    await inBatches(snapshots, 6, async (s) => {
      const next = await guard(`fixtures for ${s.club}`, () => sources.nextFixture(s.club), null);
      const kickoff = next ? Date.parse(next.kickoff) : NaN;
      if (!next || !(kickoff > nowMs && kickoff <= nowMs + FIXTURE_WINDOW_MS)) return null;
      return {
        club: s.club,
        kickoff: next.kickoff,
        opponent: next.opponent,
        competition: next.competition,
        snapshotBuiltAt: s.builtAt,
        snapshotOlderThanDay: nowMs - Date.parse(s.builtAt) > DAY_MS,
        asked: askedClub(s.club),
      };
    })
  )
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort(byAsked)
    .slice(0, LIST_CAP);

  const outlines = await guard('cards', () => sources.cards(), [] as PlayerProfile[]);
  const nearing: CardSignal[] = [];
  const stale: CardSignal[] = [];
  for (const outline of outlines) {
    const card = ensureDossierDated(outline, nowMs);
    if (!card || card.revision || isPrimeCard(card) || !isRatedOnCurrentScale(card, nowMs)) continue;
    const base = { player: card.basicInfo.name, club: card.basicInfo.club, asked: askedPlayer(card.basicInfo.name) };
    const evaluated = getDossierEvaluationDate(card);
    const evaluatedDays = evaluated ? Math.floor((nowMs - Date.parse(`${evaluated}T00:00:00Z`)) / DAY_MS) : NaN;
    if (Number.isFinite(evaluatedDays) && evaluatedDays >= CARD_REFRESH_DAYS - NEARING_REFRESH_DAYS && evaluatedDays < CARD_REFRESH_DAYS) {
      nearing.push({ ...base, asOf: evaluated!, days: evaluatedDays });
    }
    if (needsLatestUpdateRefresh(card, nowMs)) {
      const asOf = getLatestUpdateDate(card)!;
      stale.push({ ...base, asOf, days: Math.floor((nowMs - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS) });
    }
  }
  const cardOrder = (a: CardSignal, b: CardSignal) => b.asked - a.asked || b.days - a.days;
  const cardReview = sources.cardReview ? await guard('card review', () => sources.cardReview!(askedPlayer), null) : undefined;

  return {
    day: dayOf(nowMs),
    season: getCurrentSeasonInfo(new Date(nowMs)).currentSeason,
    tallyHours: Math.round(tally.countingSinceMs() / 3_600_000),
    demand: {
      clubs: tally.demandClubs().slice(0, LIST_CAP),
      players: tally.demandPlayers().slice(0, LIST_CAP),
      seasons: tally.demandSeasons().slice(0, LIST_CAP),
      gaffaTurns: tally.gaffaTurns(),
    },
    staleStories,
    fixtures,
    cards: { nearingRefresh: nearing.sort(cardOrder).slice(0, LIST_CAP), staleLatestUpdate: stale.sort(cardOrder).slice(0, LIST_CAP) },
    gaps: tally.gaps().slice(0, LIST_CAP),
    ...(cardReview !== undefined ? { cardReview } : {}),
    unread,
  };
}

/** The signal counts for the log line. */
export const describeSignals = (s: ScoutSignals): string =>
  `demand ${s.demand.clubs.length} clubs, ${s.demand.players.length} players, ${s.demand.seasons.length} seasons; ${s.staleStories.length} stale stories; ${s.fixtures.length} fixtures (${s.fixtures.filter((f) => f.snapshotOlderThanDay).length} with a snapshot over a day old); cards ${s.cards.nearingRefresh.length} nearing refresh, ${s.cards.staleLatestUpdate.length} with an old Latest Update; ${s.gaps.length} gaps${
    s.cardReview
      ? `; card review ${s.cardReview.expiredCurrent.length} past their window, ${s.cardReview.situationMoved.length} moved, ${s.cardReview.historicalGaps.length} with covered gaps, ${s.cardReview.coherence.pairs.length} two-way pairs, ${s.cardReview.coherence.cycles.length} circles, ${s.cardReview.disagreements?.length ?? 0} disagreement pairs`
      : ''
  }${s.unread.length ? `; unread: ${s.unread.join(', ')}` : ''}`;

// ---------------------------------------------------------------------------------------------
// The plan

export type ScoutAction =
  | { type: 'rebuild_snapshot'; club: string; reason: string }
  | { type: 'build_era'; club: string; season: string; reason: string }
  | { type: 'refresh_latest_update'; player: string; reason: string }
  | { type: 'research_note'; subject: string; question: string; reason: string }
  | { type: 'rerate_current'; player: string; reason: string }
  | { type: 'fill_facts'; cardKey: string; reason: string }
  | { type: 'review_prime'; player: string; reason: string };

export type ScoutActionType = ScoutAction['type'];

/** Card actions spend the card budget (`CARD_REVIEW_CALLS`); the rest spend the day's. */
export const isCardAction = (a: ScoutAction): a is Extract<ScoutAction, { type: keyof typeof CARD_ACTION_COST }> => a.type in CARD_ACTION_COST;
export const actionCost = (a: ScoutAction): number => (isCardAction(a) ? CARD_ACTION_COST[a.type] : ACTION_COST[a.type as keyof typeof ACTION_COST]);

export interface ScoutPlan {
  /** One line on the day's priorities, or why nothing is worth doing. */
  summary: string;
  actions: ScoutAction[];
}

export const PLAN_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, enum: ['rebuild_snapshot', 'build_era', 'refresh_latest_update', 'research_note', 'rerate_current', 'fill_facts', 'review_prime'] },
          club: { type: Type.STRING },
          season: { type: Type.STRING },
          player: { type: Type.STRING },
          subject: { type: Type.STRING },
          question: { type: Type.STRING },
          cardKey: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ['type', 'reason'],
      },
    },
  },
  required: ['summary', 'actions'],
};

export interface PlanInput {
  today: string;
  season: string;
  /** Model calls the actions may spend: the day's budget less the planning call. */
  budget: number;
  /** Model calls card actions may spend (`CARD_REVIEW_CALLS`); 0 offers no card actions. */
  cardBudget?: number;
  signals: ScoutSignals;
}

const list = (lines: string[]): string => (lines.length ? lines.map((l) => `- ${l}`).join('\n') : 'none');

/** The signals as the planning call reads them. */
export function formatSignals(s: ScoutSignals): string {
  const asked = (n: number) => (n > 0 ? `asked ${n} times` : 'not asked about');
  return `Counting window: the demand and gap counts below cover ${s.tallyHours >= DEMAND_DAYS * 24 ? `the last ${DEMAND_DAYS} days` : `only the last ${s.tallyHours} hours, since the server last started`}.

Clubs people asked about, most first:
${list(s.demand.clubs.map((c) => `${c.name} (${c.hits})`))}

Players people asked about, most first:
${list(s.demand.players.map((p) => `${p.name} (${p.hits})`))}

Past club seasons people looked up, most first:
${list(s.demand.seasons.map((x) => `${x.club}, ${x.season} (${x.hits})`))}

Clubs whose latest scored XI prediction missed by ${STALE_MISSED_NAMES} or more names, which suggests the club's stored story is stale:
${list(s.staleStories.map((c) => `${c.club}: ${c.namesRight} of 11 names right against ${c.opponent} on ${c.kickoff.slice(0, 10)}; ${asked(c.asked)}`))}

Clubs with a stored snapshot that play within 48 hours:
${list(s.fixtures.map((f) => `${f.club}: ${f.competition} against ${f.opponent}, kickoff ${f.kickoff}; snapshot built ${f.snapshotBuiltAt.slice(0, 16)}${f.snapshotOlderThanDay ? ' (more than a day old)' : ' (fresh)'}; ${asked(f.asked)}`))}

Current cards whose rating window closes within ${NEARING_REFRESH_DAYS} days (their ratings stay as rated; only the Latest Update line can be refreshed before then):
${list(s.cards.nearingRefresh.map((c) => `${c.player} (${c.club}): rated ${c.asOf}, ${c.days} days ago; ${asked(c.asked)}`))}

Current cards whose Latest Update is ${LATEST_UPDATE_REFRESH_DAYS} or more days old:
${list(s.cards.staleLatestUpdate.map((c) => `${c.player} (${c.club}): line dated ${c.asOf}, ${c.days} days ago; ${asked(c.asked)}`))}

Lookups that keep coming back empty or failed, most first:
${list(s.gaps.map((g) => `${g.item} [${g.status}] (${g.count})`))}

Gaffa panel turns in the window: ${s.demand.gaffaTurns} (the clubs they research are counted above).${s.cardReview ? `\n\n${formatCardSignals(s.cardReview)}` : ''}${s.unread.length ? `\nSources that could not be read today: ${s.unread.join(', ')}.` : ''}`;
}

/**
 * The card actions, offered only with a card budget and card review signals. A card is a record of
 * when it was rated and anchors later cards, so its rating is reviewed only for a reason the
 * signals give.
 */
const cardActionsPrompt = (cardBudget: number): string => `
Cards have a separate budget of ${cardBudget} model calls, spent only on these actions, so card work never takes calls from the actions above. A card rates one version of a player and anchors every card rated after it, so a rating is re-examined only for a reason the card signals give, never because a player is popular alone:
- rerate_current(player): rates a current card whose rating window has closed through the full dossier pipeline, and publishes the new card as a visitor's request would. About ${CARD_ACTION_COST.rerate_current} calls. Only for a player in the list of current cards whose window has closed; queued ones and the most asked about come first.
- fill_facts(cardKey): fills a historical card's data gaps from the stored record that now covers them, without touching its rating. About ${CARD_ACTION_COST.fill_facts} calls. Only for a card key in the list of historical cards with covered gaps.
- review_prime(player): drafts a new rating of the player's prime with the new record or the contradiction in its evidence, then a separate reviewer decides whether it replaces the card: it may accept, ask for one revision (another ${CARD_ACTION_COST.review_prime} calls), or refuse. About ${CARD_ACTION_COST.review_prime} calls a round. Only for a player whose prime card appears in the covered-gaps list, in a placement contradiction or in a pair answers ordered against the cards, and only when that evidence could change the rating; a gap whose fact can't change how good he was is a fill_facts. A disagreement pair is a count, not a record: either card may be the one out of place, and the more often and on more days it was reported, the more it is worth a review.
A player in the list of moved current cards gets refresh_latest_update now, whatever his line's age; his re-rating waits for the day his window closes.
`;

export const buildPlanPrompt = (i: PlanInput): string => `You are the scout of Futbolpedia, a football scouting service. Once a day, between conversations, you choose what to research so that tomorrow's answers rest on fresher facts where people are looking. Today is ${i.today}, in the ${i.season} season.

You have ${i.budget} model calls for the whole day. Code runs your list in order, counts what each action really spends, and skips whatever no longer fits. The actions you can choose, and what they cost:
- rebuild_snapshot(club): rebuilds the club's shared situation snapshot: its first-choice XI, who is out, recent form, what changed since last season and what is distinctive about it this season. About ${ACTION_COST.rebuild_snapshot} calls. Every chat about the present reads it, and a stored one is reused for a day, so rebuild one only when it has gone stale or a match is close and people ask about the club.
- build_era(club, season): builds the permanent snapshot of one past club season, written as YYYY-YY, from 2003-04 up to last season. About ${ACTION_COST.build_era} calls, and the result is kept for good. Choose one only when people looked that season up; a season already stored costs nothing.
- refresh_latest_update(player): rewrites the news line on a player's current card from fresh facts. About ${ACTION_COST.refresh_latest_update} calls. Only for a player in the list of cards whose Latest Update is old.
- research_note(subject, question): one web search on a club or a player, kept for 14 days as a dated note that chat reads for that subject. About ${ACTION_COST.research_note} call. Write the question as a researcher would type it. Use it for a gap the lookups keep reporting, or a question people keep circling that no stored snapshot answers.
${i.cardBudget && i.signals.cardReview ? cardActionsPrompt(i.cardBudget) : ''}
How to choose:
- What people are asking about comes first, then what the prediction record shows is stale, then fixtures within 48 hours for clubs whose snapshot is old, then ageing cards. Something nobody asks about and no record flags is not worth a call.
- Each budget is counted on its own: leave either unspent when nothing on its side is worth it.
- Name clubs and players exactly as the signals do. Use only clubs and players that appear in the signals, except the subject of a research note.
- Don't repeat an action, and don't rebuild a snapshot that is fresh unless the record shows its story is stale.
- Leave budget unspent when nothing is worth it. An empty list is the right answer on a quiet day. Don't pad the list to use the calls.
- Rank the list, best first. At most ${MAX_PLAN_ACTIONS} actions. Give each a one-line reason that names the signal behind it.
- The summary is one line: what today's priorities are, or why nothing is worth doing.

<signals>
${formatSignals(i.signals)}
</signals>`;

/** What the planning call may name: a rebuild or an era needs a club the signals show, a refresh a card the signals list. */
function knownNames(signals: ScoutSignals) {
  const key = (s: string) => toClubKey(s);
  return {
    clubs: new Set([
      ...signals.demand.clubs.map((c) => key(c.name)),
      ...signals.demand.seasons.map((s) => key(s.club)),
      ...signals.staleStories.map((c) => key(c.club)),
      ...signals.fixtures.map((c) => key(c.club)),
    ]),
    refreshable: new Set([...signals.cards.staleLatestUpdate.map((c) => toPlayerSlug(c.player)), ...(signals.cardReview?.situationMoved ?? []).map((c) => toPlayerSlug(c.player))]),
    cards: cardTargets(signals.cardReview),
  };
}

/** A single past season in 2003-04 or later: the span the history sources cover, up to last season. */
export function pastSeason(raw: unknown, seasonStartYear: number): string | null {
  const period = normalizePeriod(text(raw, 20));
  if (!period) return null;
  const start = Number(period.slice(0, 4));
  const end = Number(period.slice(5));
  return start >= 2003 && start < seasonStartYear && (start + 1) % 100 === end ? period : null;
}

/**
 * The model's answer as a plan code will run: unknown action types, actions missing what they
 * need, names the signals don't support, seasons that aren't past seasons, duplicates and anything
 * past twenty are dropped. What was dropped is counted for the log.
 */
export function sanitizePlan(
  raw: any,
  signals: ScoutSignals,
  options: { canRefreshLatestUpdate?: boolean; seasonStartYear?: number; canReviewCards?: boolean } = {},
): { plan: ScoutPlan; dropped: number } {
  const canRefresh = options.canRefreshLatestUpdate ?? true;
  const canReview = (options.canReviewCards ?? true) && !!signals.cardReview;
  const seasonStartYear = options.seasonStartYear ?? getCurrentSeasonInfo().seasonStartYear;
  const known = knownNames(signals);
  const given: any[] = Array.isArray(raw?.actions) ? raw.actions : [];
  const actions: ScoutAction[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const a of given) {
    const reason = text(a?.reason, 240);
    let action: ScoutAction | null = null;
    let id = '';
    switch (a?.type) {
      case 'rebuild_snapshot': {
        const club = text(a.club, 80);
        if (club && known.clubs.has(toClubKey(club))) {
          action = { type: 'rebuild_snapshot', club, reason };
          id = `rebuild:${toClubKey(club)}`;
        }
        break;
      }
      case 'build_era': {
        const club = text(a.club, 80);
        const season = pastSeason(a.season, seasonStartYear);
        if (club && season && known.clubs.has(toClubKey(club))) {
          action = { type: 'build_era', club, season, reason };
          id = `era:${toClubKey(club)}:${season}`;
        }
        break;
      }
      case 'refresh_latest_update': {
        const player = text(a.player, 80);
        if (canRefresh && player && known.refreshable.has(toPlayerSlug(player))) {
          action = { type: 'refresh_latest_update', player, reason };
          id = `refresh:${toPlayerSlug(player)}`;
        }
        break;
      }
      case 'research_note': {
        const subject = text(a.subject, 120);
        const question = text(a.question, 300);
        if (subject && question) {
          action = { type: 'research_note', subject, question, reason };
          id = `note:${scoutSubjectKey(subject)}:${question.toLowerCase()}`;
        }
        break;
      }
      case 'rerate_current': {
        const player = text(a.player, 80);
        if (canReview && player && known.cards.rerate.has(toBasePlayerSlug(player))) {
          action = { type: 'rerate_current', player, reason };
          id = `rerate:${toBasePlayerSlug(player)}`;
        }
        break;
      }
      case 'fill_facts': {
        const cardKey = text(a.cardKey, 200);
        if (canReview && cardKey && known.cards.fill.has(cardKey)) {
          action = { type: 'fill_facts', cardKey, reason };
          id = `fill:${cardKey}`;
        }
        break;
      }
      case 'review_prime': {
        const player = text(a.player, 80);
        if (canReview && player && known.cards.review.has(toBasePlayerSlug(player))) {
          action = { type: 'review_prime', player, reason };
          id = `review:${toBasePlayerSlug(player)}`;
        }
        break;
      }
    }
    if (!action || !reason || seen.has(id) || actions.length >= MAX_PLAN_ACTIONS) {
      dropped++;
      continue;
    }
    seen.add(id);
    actions.push(action);
  }
  return { plan: { summary: text(raw?.summary, 300) || (actions.length ? '' : 'Nothing is worth researching today.'), actions }, dropped };
}

export interface PlanModel {
  plan(input: PlanInput): Promise<unknown>;
}

/** One schema-enforced call at low thinking, on the `prediction` task's tuning (a short, structured answer). */
export const livePlanModel: PlanModel = {
  plan: (input) => generateStructured<unknown>({ task: 'prediction', prompt: buildPlanPrompt(input), schema: PLAN_SCHEMA, thinkingLevelOverride: 'low' }),
};

// ---------------------------------------------------------------------------------------------
// Execution

export interface ActionResult {
  ok: boolean;
  /** Model calls the action really spent. */
  calls: number;
  detail: string;
  /** A card action's card before and after, for the journal. */
  before?: CardMoment;
  after?: CardMoment;
}

/** What carries each action out. Tests swap in fakes; `liveScoutActors` is the real one. */
export interface ScoutActors {
  rebuildSnapshot(club: string): Promise<ActionResult>;
  buildEra(club: string, season: string): Promise<ActionResult>;
  /** `moved`: the card's situation moved inside its window, so its line is rewritten whatever its age. */
  refreshLatestUpdate(player: string, options?: { moved?: boolean }): Promise<ActionResult>;
  researchNote(subject: string, question: string): Promise<ActionResult>;
  /** Card review's actions (services/cardReview.ts); absent when card review is off. */
  cards?: CardActors;
}

export interface RanEntry {
  index: number;
  action: ScoutAction;
  ok: boolean;
  calls: number;
  detail: string;
  ms: number;
  before?: CardMoment;
  after?: CardMoment;
}
export interface SkippedEntry {
  index: number;
  action: ScoutAction;
  reason: string;
}

export const describeAction = (a: ScoutAction): string => {
  switch (a.type) {
    case 'rebuild_snapshot':
      return `rebuild_snapshot(${a.club})`;
    case 'build_era':
      return `build_era(${a.club}, ${a.season})`;
    case 'refresh_latest_update':
      return `refresh_latest_update(${a.player})`;
    case 'research_note':
      return `research_note(${a.subject}: ${a.question})`;
    case 'rerate_current':
      return `rerate_current(${a.player})`;
    case 'fill_facts':
      return `fill_facts(${a.cardKey})`;
    case 'review_prime':
      return `review_prime(${a.player})`;
  }
};

async function runAction(a: ScoutAction, actors: ScoutActors, ctx: { signals?: ScoutSignals; cardsLeft: number }): Promise<ActionResult> {
  const cards = () => {
    if (!actors.cards) throw new Error('card review is not available');
    return actors.cards;
  };
  const cardCtx = { signals: ctx.signals?.cardReview ?? null, remaining: ctx.cardsLeft, reason: a.reason };
  switch (a.type) {
    case 'rebuild_snapshot':
      return actors.rebuildSnapshot(a.club);
    case 'build_era':
      return actors.buildEra(a.club, a.season);
    case 'refresh_latest_update': {
      const moved = (ctx.signals?.cardReview?.situationMoved ?? []).some((c) => toPlayerSlug(c.player) === toPlayerSlug(a.player));
      return moved ? actors.refreshLatestUpdate(a.player, { moved }) : actors.refreshLatestUpdate(a.player);
    }
    case 'research_note':
      return actors.researchNote(a.subject, a.question);
    case 'rerate_current':
      return cards().rerateCurrent(a.player, cardCtx);
    case 'fill_facts':
      return cards().fillFacts(a.cardKey, cardCtx);
    case 'review_prime':
      return cards().reviewPrime(a.player, cardCtx);
  }
}

/** The day's two budget lines: the scout's day's own, and card review's. */
export interface Budgets {
  main: number;
  cards: number;
}
const asBudgets = (b: number | Budgets): Budgets => (typeof b === 'number' ? { main: b, cards: 0 } : b);

/**
 * Runs the plan in order. Card actions spend the card budget and every other action the day's, so
 * neither can starve the other. An action that doesn't fit in what is left of its budget (by its
 * estimated cost) is skipped, and a cheaper one further down may still run; the budget is checked
 * again after each action against what it really spent. An action that throws doesn't stop the
 * pass and is charged its estimate, since its real cost isn't known. `done` carries actions an
 * interrupted pass already ran, which are neither run again nor re-counted. `spent` is the day's
 * line, `cardSpent` card review's.
 */
export async function executePlan(
  plan: ScoutPlan,
  actors: ScoutActors,
  budget: number | Budgets,
  hooks: {
    done?: RanEntry[];
    signals?: ScoutSignals;
    onProgress?: (ran: RanEntry[], skipped: SkippedEntry[], spent: number, cardSpent: number) => Promise<void> | void;
    now?: () => number;
  } = {},
): Promise<{ ran: RanEntry[]; skipped: SkippedEntry[]; spent: number; cardSpent: number }> {
  const now = hooks.now ?? Date.now;
  const budgets = asBudgets(budget);
  const ran: RanEntry[] = [...(hooks.done ?? [])];
  const skipped: SkippedEntry[] = [];
  let spent = ran.filter((r) => !isCardAction(r.action)).reduce((n, r) => n + r.calls, 0);
  let cardSpent = ran.filter((r) => isCardAction(r.action)).reduce((n, r) => n + r.calls, 0);
  for (const [index, action] of plan.actions.entries()) {
    if (ran.some((r) => r.index === index)) continue;
    const estimate = actionCost(action);
    const card = isCardAction(action);
    const line = card ? budgets.cards : budgets.main;
    const used = card ? cardSpent : spent;
    const name = card ? 'card budget' : 'budget';
    if (used >= line) {
      skipped.push({ index, action, reason: `${name} spent (${used} of ${line} calls)` });
      continue;
    }
    if (used + estimate > line) {
      skipped.push({ index, action, reason: `would cost about ${estimate} calls with ${line - used} left in the ${name}` });
      continue;
    }
    const start = now();
    let result: ActionResult;
    try {
      result = await runAction(action, actors, { signals: hooks.signals, cardsLeft: budgets.cards - cardSpent });
    } catch (e) {
      result = { ok: false, calls: estimate, detail: `failed: ${(e as Error)?.message ?? e}`.slice(0, 200) };
    }
    const entry: RanEntry = {
      index,
      action,
      ok: result.ok,
      calls: result.calls,
      detail: result.detail,
      ms: now() - start,
      ...(result.before ? { before: result.before } : {}),
      ...(result.after ? { after: result.after } : {}),
    };
    ran.push(entry);
    if (card) cardSpent += result.calls;
    else spent += result.calls;
    console.log(`[scout-day] ${describeAction(action)}: ${result.ok ? 'ok' : 'no result'}, ${result.calls} calls (${result.detail}) (${entry.ms}ms)`);
    await hooks.onProgress?.(ran, skipped, spent, cardSpent);
  }
  for (const s of skipped) console.log(`[scout-day] skipped ${describeAction(s.action)}: ${s.reason}`);
  return { ran, skipped, spent, cardSpent };
}

// ---------------------------------------------------------------------------------------------
// Stores: the notes and the journal

export interface ScoutNoteRow {
  day: string;
  subject: string;
  subject_key: string;
  question: string;
  note: string;
  sources: string[];
}

export interface ScoutNoteStore {
  put(row: ScoutNoteRow): Promise<void>;
}

export interface ScoutJournalRow {
  day: string;
  status: 'running' | 'done';
  budget: number;
  calls_spent: number;
  /** Card review's budget line and what it spent (`CARD_REVIEW_CALLS`). */
  card_budget?: number;
  card_calls_spent?: number;
  signals: ScoutSignals;
  plan: ScoutPlan & { dropped?: number; error?: string };
  ran: RanEntry[];
  skipped: SkippedEntry[];
  started_at: string;
  updated_at: string;
}

export interface ScoutJournalStore {
  /** Whether the journal can be kept: its table exists. */
  ready(): Promise<boolean>;
  get(day: string): Promise<ScoutJournalRow | null>;
  put(row: ScoutJournalRow): Promise<void>;
  /** The last `days` rows, newest first. */
  recent(days: number): Promise<ScoutJournalRow[]>;
}

export function memoryScoutStores(): { notes: ScoutNoteStore & { rows: ScoutNoteRow[] }; journal: ScoutJournalStore } {
  const rows: ScoutNoteRow[] = [];
  const days = new Map<string, ScoutJournalRow>();
  return {
    notes: {
      rows,
      async put(row) {
        const at = rows.findIndex((r) => r.day === row.day && r.subject_key === row.subject_key && r.question === row.question);
        if (at >= 0) rows[at] = row;
        else rows.push(row);
      },
    },
    journal: {
      ready: async () => true,
      get: async (day) => days.get(day) ?? null,
      put: async (row) => void days.set(row.day, row),
      recent: async (n) => [...days.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, n),
    },
  };
}

const isMissing = (error: { code?: string; message?: string } | null | undefined): boolean =>
  !!error && (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message ?? ''));

/** The tables through a Supabase client: the secret key writes, either key reads. */
export function supabaseScoutStores(writer: any | null, reader: any): { notes: ScoutNoteStore; journal: ScoutJournalStore } {
  let tables: Promise<boolean> | null = null;
  return {
    notes: {
      async put(row) {
        if (!writer) return;
        const { error } = await writer.from('scout_notes').upsert(row, { onConflict: 'day,subject_key,question' });
        if (error) throw new Error(`scout_notes write failed: ${error.message ?? error}`);
      },
    },
    journal: {
      ready() {
        tables ??= Promise.resolve((writer ?? reader).from('scout_journal').select('day').limit(1)).then(
          ({ error }: { error: any }) => !isMissing(error) && !error,
          () => false,
        );
        return tables;
      },
      async get(day) {
        const { data, error } = await (writer ?? reader).from('scout_journal').select('*').eq('day', day).maybeSingle();
        if (error) throw new Error(`scout_journal read failed: ${error.message ?? error}`);
        return (data as ScoutJournalRow | null) ?? null;
      },
      async put(row) {
        if (!writer) throw new Error('no secret key to write the journal with');
        const { error } = await writer.from('scout_journal').upsert(row, { onConflict: 'day' });
        if (error) throw new Error(`scout_journal write failed: ${error.message ?? error}`);
      },
      async recent(days) {
        const { data, error } = await reader.from('scout_journal').select('*').order('day', { ascending: false }).limit(days);
        if (error) {
          if (isMissing(error)) return [];
          throw new Error(`scout_journal read failed: ${error.message ?? error}`);
        }
        return (data ?? []) as ScoutJournalRow[];
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The live actors

export interface LiveActorDeps {
  snapshots: Pick<SnapshotServer, 'rebuild' | 'eraBuild'>;
  tools: Pick<ResearchToolset, 'webSearch'>;
  notes: ScoutNoteStore;
  /** The Supabase client made with the secret key. */
  client: any;
  /** Card review's actors, when it is on. */
  cards?: CardActors;
  now?: () => number;
}

/**
 * Reads a current card's pointer row, rewrites its Latest Update and writes the row back with the
 * secret key. The `enforce_dossier_refresh_window` trigger lets this through because the card
 * keeps its evaluation date and is still inside its rating window; it skips a blocked write
 * silently, so the row is read again to confirm the new line is there.
 */
export async function refreshLatestUpdateWith(
  client: any,
  player: string,
  rewrite: (card: PlayerProfile) => Promise<PlayerProfile> = rewriteLatestUpdate,
  nowMs: number = Date.now(),
  options: { moved?: boolean } = {},
): Promise<ActionResult> {
  const slug = toDossierCardSlug(player, false);
  const read = async () => {
    const { data, error } = await client.from('player_profiles').select('player_data, updated_at').eq('player_slug', slug).maybeSingle();
    if (error) throw new Error(error.message ?? String(error));
    return data as { player_data: PlayerProfile; updated_at: string } | null;
  };
  const row = await read();
  const card = row?.player_data ? ensureDossierDated(row.player_data, Date.parse(row.updated_at)) : null;
  if (!card) return { ok: false, calls: 0, detail: 'no shared current card' };
  // A card whose situation moved (card review) gets a new line whatever its age, while it is in its window.
  const due = options.moved ? !isPrimeCard(card) && !card.revision && isCardInRefreshWindow(card, nowMs) : needsLatestUpdateRefresh(card, nowMs);
  if (!due) return { ok: false, calls: 0, detail: options.moved ? 'the card left its rating window' : 'its Latest Update is no longer old, or the card left its rating window' };
  const calls = ACTION_COST.refresh_latest_update;
  const refreshed = await rewrite(card);
  if (!refreshed.latestUpdateAsOf || refreshed.latestUpdateAsOf === card.latestUpdateAsOf || refreshed.latestUpdate === card.latestUpdate) {
    return { ok: false, calls, detail: 'the rewrite gave nothing new' };
  }
  // Only while the row still holds the card it was read as, so a re-rating in the meantime is never overwritten.
  const again = await read();
  const current = again?.player_data ? ensureDossierDated(again.player_data, Date.parse(again.updated_at)) : null;
  if (!current || getDossierEvaluationDate(current) !== getDossierEvaluationDate(card)) return { ok: false, calls, detail: 'the card was re-rated meanwhile; left as it is' };
  const { error } = await client.from('player_profiles').update({ player_data: refreshed, updated_at: new Date(nowMs).toISOString() }).eq('player_slug', slug);
  if (error) return { ok: false, calls, detail: `write refused: ${error.message ?? error}` };
  const check = await read();
  if (check?.player_data?.latestUpdateAsOf !== refreshed.latestUpdateAsOf) return { ok: false, calls, detail: 'the write was skipped by the refresh-window trigger' };
  return { ok: true, calls, detail: `Latest Update now dated ${refreshed.latestUpdateAsOf}` };
}

export function liveScoutActors(deps: LiveActorDeps): ScoutActors {
  const now = deps.now ?? Date.now;
  return {
    ...(deps.cards ? { cards: deps.cards } : {}),
    async rebuildSnapshot(club) {
      const { snapshot, calls } = await deps.snapshots.rebuild(club);
      return snapshot
        ? { ok: true, calls, detail: `${snapshot.club} rebuilt, built ${snapshot.builtAt.slice(0, 16)}` }
        : { ok: false, calls, detail: calls === 0 ? 'the live data has no such club' : 'the build produced no snapshot' };
    },
    async buildEra(club, season) {
      const { snapshot, built, calls } = await deps.snapshots.eraBuild('club_season', club, season);
      if (!built) return { ok: !!snapshot, calls, detail: snapshot ? 'already stored' : 'the history sources have no such season, or nowhere to keep it' };
      return snapshot ? { ok: true, calls, detail: `${snapshot.key} stored` } : { ok: false, calls, detail: 'the build produced no snapshot' };
    },
    refreshLatestUpdate: (player, options) => refreshLatestUpdateWith(deps.client, player, rewriteLatestUpdate, now(), options),
    async researchNote(subject, question) {
      const out = await deps.tools.webSearch(`${subject}: ${question}`);
      if (!out.result) return { ok: false, calls: 1, detail: `the search ${out.status === 'failed' ? 'failed' : 'found nothing'}${out.note ? ` (${out.note})` : ''}` };
      await deps.notes.put({
        day: dayOf(now()),
        subject: subject.slice(0, 120),
        subject_key: scoutSubjectKey(subject),
        question: question.slice(0, 300),
        note: out.result.content.slice(0, 8000),
        sources: out.result.sources ?? [],
      });
      return { ok: true, calls: 1, detail: `${out.result.content.length} characters, ${out.result.sources?.length ?? 0} sources` };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Live sources

export interface LiveSourceDeps {
  tally: ScoutTally;
  snapshots: Pick<SnapshotServer, 'listStored'>;
  get: LiveGet;
  /** The club's record, from the XI predictions module. */
  record(club: string): Promise<{ scored: { kickoff: string; opponent: string; scores: { code: { namesRight: number } | null; adjusted: { namesRight: number } | null } }[] } | null>;
  /** The Supabase client the server reads cards with. */
  client: any;
  /** Card review's sources, when it is on. */
  cardReview?: CardReviewSources;
}

const SNAPSHOT_LOOKBACK_MS = 14 * DAY_MS;

export function liveScoutSources(deps: LiveSourceDeps): ScoutSources {
  return {
    tally: deps.tally,
    ...(deps.cardReview ? { cardReview: (asked: (player: string) => number) => gatherCardSignals(deps.cardReview!, asked) } : {}),
    async snapshots() {
      return (await deps.snapshots.listStored(SNAPSHOT_LOOKBACK_MS)).map((s) => ({ club: s.club, builtAt: s.builtAt }));
    },
    async latestScored(club) {
      const record = await deps.record(club);
      const last = record?.scored[0];
      if (!last) return null;
      // The adjusted XI reads the club's story; when it exists it is the one that shows whether the story is stale.
      const score = last.scores.adjusted ?? last.scores.code;
      return score ? { kickoff: last.kickoff, opponent: last.opponent, namesRight: score.namesRight } : null;
    },
    async nextFixture(club) {
      const res = await deps.get<LiveClubResult>(`/api/live/club?${new URLSearchParams({ name: club })}`);
      if ('error' in res || !res.data.found) return null;
      const next = res.data.report.fixtures
        .filter((f) => !f.completed && f.kickoff)
        .sort((a, b) => Date.parse(a.kickoff!) - Date.parse(b.kickoff!))[0];
      return next ? { kickoff: next.kickoff!, opponent: next.opponent, competition: next.competition } : null;
    },
    async cards() {
      const { data, error } = await deps.client
        .from('player_profiles')
        .select(
          'updated_at, basicInfo:player_data->basicInfo, ratings:player_data->ratings, version:player_data->version, createdAt:player_data->createdAt, evaluationDate:player_data->evaluationDate, revision:player_data->revision, latestUpdateAsOf:player_data->latestUpdateAsOf, latestUpdate:player_data->latestUpdate',
        )
        .not('player_slug', 'like', '%--%')
        .order('updated_at', { ascending: false })
        .limit(2000);
      if (error || !Array.isArray(data)) throw new Error(error?.message ?? 'no rows');
      return (data as Array<Record<string, any>>)
        .filter((r) => r.basicInfo?.name)
        .map((r) => ({
          basicInfo: r.basicInfo,
          ratings: r.ratings ?? {},
          version: r.version ?? undefined,
          createdAt: r.createdAt ?? undefined,
          evaluationDate: r.evaluationDate ?? undefined,
          revision: r.revision ?? undefined,
          latestUpdateAsOf: r.latestUpdateAsOf ?? undefined,
          latestUpdate: r.latestUpdate ?? '',
          // The row's time stands in for a card with no stamp of its own, as the card index does.
          ...(r.createdAt ? {} : { createdAt: Date.parse(r.updated_at) }),
        })) as unknown as PlayerProfile[];
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The pass and its schedule

export interface ScoutDayDeps {
  sources: ScoutSources;
  model?: PlanModel;
  actors: ScoutActors;
  journal: ScoutJournalStore;
  /** Model calls the day may spend (`SCOUT_DAY_CALLS`). */
  budget?: number;
  now?: () => number;
  /** Whether the pass is on at all (`SCOUT_DAY` isn't `off`). */
  enabled?: boolean;
  /** Whether the server can keep what the pass finds: it has the Supabase secret key. */
  canWrite?: boolean;
  /** Settles when the prediction sweep has run, so the pass comes after it. */
  afterSweep?: Promise<unknown>;
  /** The refresh action is offered to the planner only when the server can write a card's pointer row. */
  canRefreshLatestUpdate?: boolean;
  /** Model calls card review may spend a day (`CARD_REVIEW_CALLS`); 0, or no card actors, turns card actions off. */
  cardBudget?: number;
}

export function createScoutDay(deps: ScoutDayDeps) {
  const model = deps.model ?? livePlanModel;
  const now = deps.now ?? Date.now;
  const budget = deps.budget ?? SCOUT_DAY_DEFAULT_CALLS;
  const enabled = deps.enabled ?? true;
  const canWrite = deps.canWrite ?? true;
  const cardBudget = deps.actors.cards ? deps.cardBudget ?? CARD_REVIEW_DEFAULT_CALLS : 0;
  let busy = false;
  let swept = false;
  let tableWarned = false;
  const planFailures = new Map<string, number>();

  const iso = () => new Date(now()).toISOString();

  /** One pass for `day`. A running row left by a dead pass is resumed from its stored plan. */
  async function runPass(day: string, existing: ScoutJournalRow | null): Promise<ScoutJournalRow | null> {
    const startedAt = existing?.started_at ?? iso();
    let row: ScoutJournalRow;
    if (existing) {
      row = { ...existing, status: 'running', updated_at: iso() };
      console.log(`[scout-day] resuming ${day}: ${existing.ran.length} actions already ran, ${existing.calls_spent} of ${existing.budget} calls spent`);
    } else {
      const signals = await gatherSignals(deps.sources, now());
      console.log(`[scout-day] signals ${day}: ${describeSignals(signals)}`);
      const today = day;
      const season = getCurrentSeasonInfo(new Date(now()));
      let plan: ScoutJournalRow['plan'];
      try {
        const raw = await model.plan({ today, season: season.currentSeason, budget: budget - PLAN_CALLS, cardBudget, signals });
        const sanitized = sanitizePlan(raw, signals, {
          canRefreshLatestUpdate: deps.canRefreshLatestUpdate,
          seasonStartYear: season.seasonStartYear,
          canReviewCards: cardBudget > 0,
        });
        plan = { ...sanitized.plan, dropped: sanitized.dropped };
      } catch (e) {
        const failures = (planFailures.get(day) ?? 0) + 1;
        planFailures.set(day, failures);
        console.warn(`[scout-day] planning failed (${failures} of ${MAX_PLAN_ATTEMPTS}):`, (e as Error)?.message ?? e);
        if (failures < MAX_PLAN_ATTEMPTS) return null; // the next tick tries again
        plan = { summary: 'The planning call failed, so nothing was researched today.', actions: [], error: String((e as Error)?.message ?? e).slice(0, 200) };
      }
      console.log(`[scout-day] plan: ${plan.summary || '(no summary)'} | ${plan.actions.length} actions${plan.dropped ? `, ${plan.dropped} dropped` : ''}`);
      plan.actions.forEach((a, i) => console.log(`[scout-day]   ${i + 1}. ${describeAction(a)}: ${a.reason}`));
      row = { day, status: 'running', budget, calls_spent: PLAN_CALLS, card_budget: cardBudget, card_calls_spent: 0, signals, plan, ran: [], skipped: [], started_at: startedAt, updated_at: iso() };
    }
    await deps.journal.put(row);

    const cards = row.card_budget ?? cardBudget;
    const { ran, skipped, spent, cardSpent } = await executePlan(row.plan, deps.actors, { main: budget, cards }, {
      done: row.ran,
      signals: row.signals,
      now,
      onProgress: async (r, s, n, c) => {
        row = { ...row, ran: r, skipped: s, calls_spent: n + PLAN_CALLS, card_calls_spent: c, updated_at: iso() };
        await deps.journal.put(row).catch((e) => console.warn('[scout-day] journal progress not saved:', (e as Error)?.message ?? e));
      },
    });
    row = { ...row, status: 'done', ran, skipped, calls_spent: spent + PLAN_CALLS, card_budget: cards, card_calls_spent: cardSpent, updated_at: iso() };
    await deps.journal.put(row);
    console.log(`[scout-day] done ${day}: ${ran.length} ran, ${skipped.length} skipped, ${row.calls_spent} of ${budget} calls spent${cards ? `, ${cardSpent} of ${cards} card calls` : ''}`);
    return row;
  }

  /**
   * Runs today's pass when it hasn't run: no journal row for the day, or a running row left by a
   * pass that died. Never overlaps itself, and never throws.
   */
  async function tick(): Promise<ScoutJournalRow | null> {
    if (!enabled || !canWrite) return null;
    if (busy) return null;
    busy = true;
    try {
      if (!swept) {
        await deps.afterSweep?.catch(() => {});
        swept = true;
      }
      if (!(await deps.journal.ready())) {
        if (!tableWarned) console.warn('[scout-day] skipped: the scout_journal table is missing; apply its migration to run the pass');
        tableWarned = true;
        return null;
      }
      const day = dayOf(now());
      const row = await deps.journal.get(day);
      if (row?.status === 'done') return null;
      if (row && now() - Date.parse(row.updated_at) < STALE_RUNNING_MS) return null;
      return await runPass(day, row);
    } catch (e) {
      console.warn('[scout-day] pass failed:', (e as Error)?.message ?? e);
      return null;
    } finally {
      busy = false;
    }
  }

  /** Runs a pass now if today's hasn't run, then hourly. The timer doesn't keep the process alive. */
  function start(): { stop(): void } {
    if (!enabled) {
      console.log('[scout-day] off (SCOUT_DAY=off)');
      return { stop() {} };
    }
    if (!canWrite) {
      console.log('[scout-day] skipped: SUPABASE_SECRET_KEY is not set, so nothing the pass finds could be kept');
      return { stop() {} };
    }
    console.log(`[scout-day] on: ${budget} calls a day, checked every hour`);
    void tick();
    const timer = setInterval(() => void tick(), SCOUT_DAY_TICK_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  }

  /** The last `days` journal rows, newest first. */
  const recent = (days: number) => deps.journal.recent(Math.max(1, Math.min(30, Math.floor(days) || 7)));

  return { tick, start, recent, runPass };
}

export type ScoutDay = ReturnType<typeof createScoutDay>;

/**
 * `GET /api/scout/journal?days=7`: the last `days` journal rows (one to thirty), newest first.
 * Public and read-only; the rows hold counts and names the live data resolved, never user text.
 */
export function scoutJournalHandler(scoutDay: Pick<ScoutDay, 'recent'>) {
  return async (req: { query: Record<string, unknown> }, res: { set(k: string, v: string): unknown; json(b: unknown): unknown; status(n: number): { json(b: unknown): unknown } }) => {
    const days = Math.max(1, Math.min(30, Math.floor(Number(req.query.days)) || 7));
    try {
      res.set('Cache-Control', 'public, max-age=300');
      return res.json({ days: await scoutDay.recent(days) });
    } catch (err) {
      console.warn('[scout-day] journal read failed:', (err as Error)?.message ?? err);
      return res.status(502).json({ error: 'Journal unavailable' });
    }
  };
}
