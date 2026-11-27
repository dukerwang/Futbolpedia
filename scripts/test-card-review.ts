#!/usr/bin/env npx tsx
/**
 * Offline checks for card review, with the model, the rating pipeline, the stores and the clock
 * faked: each signal from seeded card rows (past the window, moved inside it, data gaps a newer
 * record covers, placement contradictions), the calibration gaps on seeded cards and their queue,
 * the coherence finder on hand-built placements, the
 * planner's card actions validated and budgeted apart from the scout's day budget, a current
 * re-rate that publishes, prime drafts that go to review and are never written first, each review
 * outcome and the rows it leaves, code refusing a band jump, and a published review filed in the
 * evidence ledger.
 *
 * Usage:
 *   npx tsx scripts/test-card-review.ts
 */
import assert from 'node:assert/strict';
import type { PeerPlacement, PlayerProfile } from '../types';
import { resolveTaskModelConfig, GEMINI_4_HYDROGEN } from '../constants/modelProfiles';
import {
  bandsCrossed,
  buildReviewPrompt,
  CARD_ACTION_COST,
  coverageFor,
  createCardActors,
  findCalibrationGaps,
  findCoherence,
  formatCardSignals,
  gatherCardSignals,
  guardDraft,
  memoryCardReviewStore,
  queuedFromJournal,
  reviewPrimeCard,
  sanitizeReview,
  servedPool,
  type CardActors,
  type CardActorDeps,
  type CardReviewSignals,
  type CardReviewSources,
  type CardStore,
  type Coverage,
  type Opened,
  type ReviewInput,
  type StoredCard,
} from '../services/cardReview';
import { cardReviewEntry, fileCardReviews, type CardReviewSource, type PublishedReview } from '../services/cardReviewNotes';
import { getCardKey, isPrimeCard, toDossierCardSlug } from '../services/dossierCards';
import { emptyLedger, formatLedger } from '../services/evidenceLedger';
import {
  buildPlanPrompt,
  createScoutDay,
  createScoutTally,
  executePlan,
  memoryScoutStores,
  sanitizePlan,
  type ActionResult,
  type ScoutActors,
  type ScoutPlan,
  type ScoutSignals,
} from '../services/scoutDay';

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).stack ?? err}`);
  }
}
const realLog = console.log;
const realWarn = console.warn;
const quiet = (args: unknown[]) => typeof args[0] === 'string' && /^\[(scout-day|card-review|RatingPlacement)\]/.test(args[0]);
console.log = (...args: unknown[]) => (quiet(args) ? undefined : realLog(...args));
console.warn = (...args: unknown[]) => (quiet(args) ? undefined : realWarn(...args));

// --- A clock and seeded cards -----------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-25T09:00:00Z');
const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysAgo = (n: number) => dayStr(T0 - n * DAY);
const RATED = T0 - 20 * DAY; // after the calibration epoch

function current(name: string, club: string, evaluated: string, overall = 80, placement?: PeerPlacement): PlayerProfile {
  return {
    basicInfo: { name, club, position: 'Central Midfielder', age: 25, nationality: 'X' },
    ratings: { overall, potential: overall + 2 },
    version: { id: 'v', type: 'current', label: 'Current', evaluationDate: evaluated, seasonOrEra: '2026-27' },
    evaluationDate: evaluated,
    createdAt: Date.parse(`${evaluated}T12:00:00Z`),
    latestUpdate: 'News.',
    ...(placement ? { peerPlacement: placement } : {}),
  } as unknown as PlayerProfile;
}

function prime(
  name: string,
  overall: number,
  window: string,
  opts: { placement?: PeerPlacement; gaps?: string[]; position?: string; type?: 'prime' | 'era'; createdAt?: number; club?: string } = {},
): PlayerProfile {
  const start = window.slice(0, 4);
  return {
    basicInfo: { name, club: opts.club ?? 'Northgate FC', position: opts.position ?? 'Centre Forward', age: 27, nationality: 'X' },
    ratings: { overall, potential: overall },
    version: {
      id: 'v',
      type: opts.type ?? 'prime',
      label: 'Prime',
      evaluationDate: `${Number(start) + 1}-05-20`,
      seasonOrEra: window,
      primeWindow: { startSeason: `${start}-${String(Number(start) + 1).slice(2)}`, endSeason: `${Number(start) + 2}-${String(Number(start) + 3).slice(2)}` },
      ...(opts.type === 'era' ? { qualifier: 'Northgate' } : {}),
    },
    evaluationDate: `${Number(start) + 1}-05-20`,
    createdAt: opts.createdAt ?? RATED,
    latestUpdate: '',
    shortBio: 'A forward.',
    confidence: { grade: 'B', sampleSize: 'Three seasons', dataGaps: opts.gaps ?? [], verdict: 'Solid.' },
    ...(opts.placement ? { peerPlacement: opts.placement } : {}),
  } as unknown as PlayerProfile;
}

const row = (slug: string, card: PlayerProfile, rowAt = RATED): StoredCard => ({ slug, card, rowAt });
const P = (betterThan: string[] = [], notAsGoodAs: string[] = [], levelWith: string[] = []): PeerPlacement => ({ betterThan, levelWith, notAsGoodAs });

const ROWS: StoredCard[] = [
  // Current cards: two past their window, three inside it.
  // Rated after the calibration epoch (2026-10-20), so both are on the current scale.
  row('ada-winger', current('Ada Winger', 'Northgate FC', daysAgo(33))),
  row('bo-keeper', current('Bo Keeper', 'Southvale United', daysAgo(31))),
  row('cy-striker', current('Cy Striker', 'Eastport City', daysAgo(10))), // the live record names another club
  row('di-holder', current('Di Holder', 'Northgate FC', daysAgo(12), 84)), // a starter the XI no longer has
  row('ed-back', current('Ed Back', 'Northgate FC', daysAgo(12), 84)), // in the XI
  row('fy-bench', current('Fy Bench', 'Northgate FC', daysAgo(12), 74)), // not in the XI, but not rated a starter
  // A prime whose gap a newer club-season snapshot covers.
  row('prime-fa-legend', prime('Fa Legend', 90, '2002-05', { gaps: ['Appearances for Northgate FC in 2003-04 were not found'] })),
  // An era card whose gap is covered only by a record older than the card.
  row('gi-era--era--2005-08', prime('Gi Era', 86, '2005-08', { type: 'era', gaps: ['League goals in 2006-07'] })),
  // Primes whose placements say each is above the other.
  row('prime-hector-lane', prime('Hector Lane', 93, '2001-04', { placement: P(['Ivo Marsh (2003-06)']) })),
  row('prime-ivo-marsh', prime('Ivo Marsh', 94, '2003-06', { placement: P(['Hector Lane (2001-04)']) })),
  // Three primes in a circle.
  row('prime-jon-reed', prime('Jon Reed', 88, '1990-93', { position: 'Centre-Back', placement: P(['Kai Stone (1992-95)']) })),
  row('prime-kai-stone', prime('Kai Stone', 88, '1992-95', { position: 'Centre-Back', placement: P(['Lev Grant (1994-97)']) })),
  row('prime-lev-grant', prime('Lev Grant', 88, '1994-97', { position: 'Centre-Back', placement: P(['Jon Reed (1990-93)']) })),
];

const COVERAGE: Coverage[] = [
  { source: 'era_snapshot', kind: 'club_season', subject: 'Northgate FC', period: '2003-04', builtAt: new Date(T0 - 2 * DAY).toISOString(), ref: 'club_season:northgate-fc:2003-04' },
  { source: 'era_snapshot', kind: 'player_window', subject: 'Gi Era', period: '2005-08', builtAt: new Date(RATED - DAY).toISOString(), ref: 'player_window:gi-era:2005-08' },
];

const cardSources = (over: Partial<CardReviewSources> = {}): CardReviewSources => ({
  rows: async () => ROWS,
  liveClub: async (p) => (p === 'Cy Striker' ? 'Southvale United' : p === 'Di Holder' ? 'Northgate FC' : null),
  clubXi: async (club) =>
    club === 'Northgate FC'
      ? { club: 'Northgate FC', asOf: new Date(T0 - DAY).toISOString(), names: ['Ed Back', 'A One', 'B Two', 'C Three', 'D Four', 'E Five', 'F Six', 'G Seven', 'H Eight', 'I Nine', 'J Ten'] }
      : null,
  coverage: async () => COVERAGE,
  queued: async () => [{ player: 'Bo Keeper', reason: 'the live record names Westbridge', day: daysAgo(31) }],
  ...over,
});
const asked = (p: string) => (p === 'Ada Winger' ? 5 : p === 'Di Holder' ? 3 : 0);

// --- Signals ------------------------------------------------------------------------------------

let SIGNALS: CardReviewSignals;

await test('signals: current cards past their window, queued ones first, then the most asked about', async () => {
  SIGNALS = await gatherCardSignals(cardSources(), asked, T0);
  assert.deepEqual(SIGNALS.expiredCurrent.map((c) => c.player), ['Bo Keeper', 'Ada Winger']);
  assert.equal(SIGNALS.expiredCurrent[0].queued, true);
  assert.match(SIGNALS.expiredCurrent[0].queuedReason!, /Westbridge/);
  assert.equal(SIGNALS.expiredCurrent[1].asked, 5);
  assert.equal(SIGNALS.expiredCurrent[1].days, 33);
});

await test('signals: a card whose live club differs, or whose club XI dropped a starter, is moved; others are not', () => {
  const moved = new Map(SIGNALS.situationMoved.map((m) => [m.player, m]));
  assert.deepEqual([...moved.keys()].sort(), ['Cy Striker', 'Di Holder']);
  assert.match(moved.get('Cy Striker')!.reason, /live record names Southvale United/);
  assert.match(moved.get('Di Holder')!.reason, /first-choice XI/);
  assert.equal(moved.get('Di Holder')!.windowEnds, dayStr(Date.parse(`${daysAgo(12)}T00:00:00Z`) + 30 * DAY));
  assert.equal(SIGNALS.situationMoved[0].player, 'Di Holder'); // asked about more
});

await test('signals: a historical gap counts only when a record built after the card covers it', () => {
  assert.equal(SIGNALS.historicalGaps.length, 1);
  const g = SIGNALS.historicalGaps[0];
  assert.equal(g.player, 'Fa Legend');
  assert.equal(g.edition, 'prime');
  assert.equal(g.coveredBy.ref, 'club_season:northgate-fc:2003-04');
  assert.equal(g.cardKey, getCardKey(ROWS.find((r) => r.slug === 'prime-fa-legend')!.card));
});

await test('signals: the coherence finder sees the two-way pair and the circle in the served pool', () => {
  assert.equal(SIGNALS.coherence.pairs.length, 1);
  assert.deepEqual([SIGNALS.coherence.pairs[0].a.player, SIGNALS.coherence.pairs[0].b.player].sort(), ['Hector Lane', 'Ivo Marsh']);
  assert.equal(SIGNALS.coherence.cycles.length, 1);
  assert.deepEqual(SIGNALS.coherence.cycles[0].cards.map((c) => c.player).sort(), ['Jon Reed', 'Kai Stone', 'Lev Grant']);
  assert.ok(SIGNALS.coherence.positions.some((p) => p.position === 'Centre-Back' && p.cards === 3 && p.mean === 88));
});

await test('signals: the summary for the planner lists every card list and calls the distribution a figure only', () => {
  const s = formatCardSignals(SIGNALS);
  assert.match(s, /Bo Keeper \(Southvale United\).*queued/);
  assert.match(s, /Di Holder.*window ends/);
  assert.match(s, /\[card fa-legend:prime:2003-05-20\]/);
  assert.match(s, /each above the other/);
  assert.match(s, /not a reason to review a card/);
});

// --- Coherence on hand-built pools ----------------------------------------------------------------

await test('coherence: a both-ways pair stated through notAsGoodAs is found', () => {
  const pool = [prime('Aa Alpha', 90, '2000-03', { placement: P([], ['Bb Bravo (2001-04)']) }), prime('Bb Bravo', 91, '2001-04', { placement: P([], ['Aa Alpha (2000-03)']) })];
  const c = findCoherence(pool);
  assert.equal(c.pairs.length, 1);
  assert.equal(c.cycles.length, 0);
  assert.equal(c.pairs[0].statements.length, 2);
});

await test('coherence: a transitivity break across three cards is one circle, whoever states each link', () => {
  const pool = [
    prime('Cc Charlie', 89, '2000-03', { placement: P(['Dd Delta (2001-04)']) }),
    prime('Dd Delta', 89, '2001-04', { placement: P([], ['Cc Charlie (2000-03)']) }),
    prime('Ee Echo', 89, '2002-05', { placement: P(['Cc Charlie (2000-03)'], ['Dd Delta (2001-04)']) }),
  ];
  const c = findCoherence(pool);
  assert.equal(c.pairs.length, 0);
  assert.equal(c.cycles.length, 1);
});

await test('coherence: a clean pool has no pairs and no circles', () => {
  const pool = [
    prime('Ff Foxtrot', 92, '2000-03', { placement: P(['Gg Golf (2001-04)', 'Hh Hotel (2002-05)']) }),
    prime('Gg Golf', 90, '2001-04', { placement: P(['Hh Hotel (2002-05)'], ['Ff Foxtrot (2000-03)']) }),
    prime('Hh Hotel', 88, '2002-05', { placement: P([], ['Gg Golf (2001-04)']) }),
  ];
  const c = findCoherence(pool);
  assert.equal(c.pairs.length, 0);
  assert.equal(c.cycles.length, 0);
});

await test('coverage: a gap naming a season and the card club matches a club season; one without the season does not', () => {
  const card = prime('Fa Legend', 90, '2002-05');
  assert.ok(coverageFor(card, 'Cup goals in 2003-04', COVERAGE));
  assert.equal(coverageFor(card, 'Cup goals in 2009-10', COVERAGE), null);
});

await test('pool: re-rated primes and current cards past their window are left out of the served pool', () => {
  const pool = servedPool(ROWS, T0);
  assert.ok(!pool.some((p) => p.basicInfo.name === 'Ada Winger'));
  assert.ok(pool.some((p) => p.basicInfo.name === 'Cy Striker'));
});

// --- The plan --------------------------------------------------------------------------------------

const scoutSignals = (cardReview: CardReviewSignals | null = SIGNALS): ScoutSignals => ({
  day: dayStr(T0),
  season: '2026-27',
  tallyHours: 200,
  demand: { clubs: [{ name: 'Northgate FC', hits: 3 }], players: [], seasons: [], gaffaTurns: 0 },
  staleStories: [],
  fixtures: [],
  cards: { nearingRefresh: [], staleLatestUpdate: [] },
  gaps: [],
  cardReview,
  unread: [],
});

await test('plan: card actions are kept only for the cards and players the signals name', () => {
  const key = SIGNALS.historicalGaps[0].cardKey;
  const { plan, dropped } = sanitizePlan(
    {
      summary: 's',
      actions: [
        { type: 'rerate_current', player: 'Ada Winger', reason: 'window closed, asked 5 times' },
        { type: 'rerate_current', player: 'Cy Striker', reason: 'not past its window' },
        { type: 'fill_facts', cardKey: key, reason: 'record covers the gap' },
        { type: 'fill_facts', cardKey: 'nobody:prime:2000-01-01', reason: 'unknown card' },
        { type: 'review_prime', player: 'Hector Lane', reason: 'two-way pair' },
        { type: 'review_prime', player: 'Ada Winger', reason: 'popular' },
        { type: 'refresh_latest_update', player: 'Di Holder', reason: 'dropped from the XI' },
        { type: 'review_prime', player: 'Fa Legend', reason: '' },
      ],
    },
    scoutSignals(),
  );
  assert.deepEqual(plan.actions.map((a) => a.type), ['rerate_current', 'fill_facts', 'review_prime', 'refresh_latest_update']);
  assert.equal(dropped, 4);
});

await test('plan: without card review, card actions are dropped', () => {
  const raw = { summary: 's', actions: [{ type: 'rerate_current', player: 'Ada Winger', reason: 'r' }] };
  assert.equal(sanitizePlan(raw, scoutSignals(), { canReviewCards: false }).plan.actions.length, 0);
  assert.equal(sanitizePlan(raw, scoutSignals(null)).plan.actions.length, 0);
});

await test('plan: the prompt offers card actions with their own budget only when there is one', () => {
  const withCards = buildPlanPrompt({ today: dayStr(T0), season: '2026-27', budget: 29, cardBudget: 24, signals: scoutSignals() });
  assert.match(withCards, /separate budget of 24 model calls/);
  assert.match(withCards, /review_prime\(player\)/);
  assert.match(withCards, /only for a reason the card signals give/);
  const without = buildPlanPrompt({ today: dayStr(T0), season: '2026-27', budget: 29, cardBudget: 0, signals: scoutSignals() });
  assert.doesNotMatch(without, /rerate_current/);
});

const okResult = (calls: number): ActionResult => ({ ok: true, calls, detail: 'done' });
function countingActors(log: string[]): ScoutActors {
  const cards: CardActors = {
    rerateCurrent: async (p) => (log.push(`rerate ${p}`), okResult(8)),
    fillFacts: async (k) => (log.push(`fill ${k}`), okResult(1)),
    reviewPrime: async (p, ctx) => (log.push(`review ${p} with ${ctx.remaining} left`), okResult(9)),
  };
  return {
    rebuildSnapshot: async (c) => (log.push(`rebuild ${c}`), okResult(4)),
    buildEra: async () => okResult(3),
    refreshLatestUpdate: async (p, o) => (log.push(`refresh ${p}${o?.moved ? ' (moved)' : ''}`), okResult(2)),
    researchNote: async () => okResult(1),
    cards,
  };
}

await test('budget: card actions spend the card line and snapshot actions the day line, neither starving the other', async () => {
  const plan: ScoutPlan = {
    summary: '',
    actions: [
      { type: 'review_prime', player: 'Hector Lane', reason: 'r' },
      { type: 'rerate_current', player: 'Ada Winger', reason: 'r' },
      { type: 'rerate_current', player: 'Bo Keeper', reason: 'r' },
      { type: 'rebuild_snapshot', club: 'Northgate FC', reason: 'r' },
      { type: 'refresh_latest_update', player: 'Di Holder', reason: 'r' },
    ],
  };
  const log: string[] = [];
  const out = await executePlan(plan, countingActors(log), { main: 6, cards: 18 }, { signals: scoutSignals(), now: () => T0 });
  assert.deepEqual(log, ['review Hector Lane with 18 left', 'rerate Ada Winger', 'rebuild Northgate FC', 'refresh Di Holder (moved)']);
  assert.equal(out.cardSpent, 17);
  assert.equal(out.spent, 6);
  assert.deepEqual(out.skipped.map((s) => s.reason), ['would cost about 8 calls with 1 left in the card budget']);
});

await test('budget: a plain number is the day line alone, so card actions never run on it', async () => {
  const log: string[] = [];
  const out = await executePlan({ summary: '', actions: [{ type: 'rerate_current', player: 'Ada Winger', reason: 'r' }] }, countingActors(log), 30, { now: () => T0 });
  assert.equal(log.length, 0);
  assert.equal(out.skipped.length, 1);
});

// --- A full prime card and the review --------------------------------------------------------

function fullPrime(overall: number, extra: Partial<PlayerProfile> = {}): PlayerProfile {
  return { ...prime('Fa Legend', overall, '2002-05', { gaps: ['Appearances for Northgate FC in 2003-04 were not found'] }), ...extra } as PlayerProfile;
}

function fakeStore(initial: Record<string, PlayerProfile>) {
  const cards = { ...initial };
  const events: string[] = [];
  const store: CardStore = {
    pointer: async (name, isPrime) => cards[toDossierCardSlug(name, isPrime)] ?? null,
    byKey: async (key) => Object.entries(cards).filter(([, c]) => getCardKey(c) === key).map(([slug, card]) => ({ slug, card, rowAt: RATED })),
    async publish(card, options) {
      events.push(`publish supersede=${options.supersede}`);
      const slug = toDossierCardSlug(card.basicInfo.name, isPrimeCard(card));
      const old = cards[slug];
      // The rerate trigger: a prime pointer changes only for a newer rerateAt.
      if (old && isPrimeCard(old) && !((card.rerateAt ?? 0) > (old.rerateAt ?? 0))) return;
      cards[slug] = card;
    },
    async writeInPlace(slug, card) {
      events.push(`write ${slug}`);
      cards[slug] = card;
      return true;
    },
  };
  return { store, cards, events };
}

const OPENED: Opened = { kind: 'new_record', summary: 'A newer club-season record covers his gaps.', evidence: 'Northgate FC 2003-04: he started every league match.' };

function reviewDeps(over: { drafts: (PlayerProfile | string)[]; answers: unknown[]; store?: ReturnType<typeof fakeStore>; pool?: PlayerProfile[] }) {
  const store = over.store ?? fakeStore({ 'prime-fa-legend': fullPrime(90) });
  const reviews = memoryCardReviewStore();
  const notes: string[] = [];
  const inputs: ReviewInput[] = [];
  const deps: CardActorDeps = {
    store: store.store,
    drafter: {
      rerateCurrent: async () => 'unused',
      async draftPrime(_name, note) {
        notes.push(note);
        store.events.push('draft');
        return over.drafts.shift() ?? 'no more drafts';
      },
    },
    reviewer: {
      async review(input) {
        store.events.push('review');
        inputs.push(input);
        return over.answers.shift();
      },
    },
    filler: { fill: async () => ({ filled: [] }) },
    reviews,
    pool: async () => over.pool ?? [],
    recordText: async () => 'record',
    now: () => T0,
    sleep: async () => {},
  };
  const util = { now: () => T0, iso: () => new Date(T0).toISOString(), day: () => dayStr(T0), record: (r: any) => reviews.put(r) };
  return { deps, store, reviews, notes, inputs, util };
}

const ACCEPT = { verdict: 'accept', reasons: ['Driven by the record.'], notes: '', checks: { evidenceDriven: true, rulesHold: true, figuresSupported: true, proportionate: true } };
const REVISE = { verdict: 'revise', reasons: ['The window moved without evidence.'], notes: 'Keep the window the record supports.', checks: { evidenceDriven: false, rulesHold: true, figuresSupported: true, proportionate: true } };
const REFUSE = { verdict: 'refuse', reasons: ['The record does not change how good he was.'], notes: '', checks: { evidenceDriven: false, rulesHold: true, figuresSupported: true, proportionate: false } };
const ctx = (remaining = 24) => ({ signals: SIGNALS, remaining, reason: 'record covers his gaps' });

await test('review: accept publishes the draft through the rerate path, after the review and never before', async () => {
  const t = reviewDeps({ drafts: [fullPrime(91)], answers: [ACCEPT] });
  const old = (await t.store.store.pointer('Fa Legend', true))!;
  const out = await reviewPrimeCard(old, OPENED, ctx(), t.deps, t.util);
  assert.deepEqual(t.store.events, ['draft', 'review', 'publish supersede=true']);
  assert.equal(out.ok, true);
  assert.equal(out.calls, CARD_ACTION_COST.review_prime);
  assert.equal(t.store.cards['prime-fa-legend'].ratings.overall, 91);
  assert.equal(t.store.cards['prime-fa-legend'].rerateAt, T0);
  const r = t.reviews.rows[0];
  assert.equal(r.verdict, 'accept');
  assert.equal(r.published, true);
  assert.equal(r.old_overall, 90);
  assert.equal(r.new_overall, 91);
  assert.equal(r.revise_notes, null);
  assert.equal(r.published_card_key, getCardKey(t.store.cards['prime-fa-legend']));
  assert.deepEqual(out.before?.overall, 90);
  assert.deepEqual(out.after?.overall, 91);
  // The reviewer saw the evidence and the old card, not the drafting.
  const prompt = buildReviewPrompt(t.inputs[0]);
  assert.match(prompt, /started every league match/);
  assert.match(prompt, /<published_card>[\s\S]*Overall 90/);
  assert.doesNotMatch(prompt, /This rating reviews the published card/);
});

await test('review: revise then accept drafts once more with the notes, then publishes', async () => {
  const t = reviewDeps({ drafts: [fullPrime(93), fullPrime(91)], answers: [REVISE, ACCEPT] });
  const out = await reviewPrimeCard((await t.store.store.pointer('Fa Legend', true))!, OPENED, ctx(), t.deps, t.util);
  assert.deepEqual(t.store.events, ['draft', 'review', 'draft', 'review', 'publish supersede=true']);
  assert.match(t.notes[1], /Keep the window the record supports/);
  assert.doesNotMatch(t.notes[0], /reviewer/);
  assert.equal(t.inputs[1].round, 2);
  assert.equal(out.ok, true);
  assert.equal(out.calls, 2 * CARD_ACTION_COST.review_prime);
  const r = t.reviews.rows[0];
  assert.equal(r.verdict, 'accept');
  assert.equal(r.revise_notes, 'Keep the window the record supports.');
  assert.deepEqual(r.rounds.map((x) => x.verdict), ['revise', 'accept']);
  assert.equal(r.new_overall, 91);
});

await test('review: revise then refuse publishes nothing; a second revise counts as a refusal', async () => {
  for (const second of [REFUSE, REVISE]) {
    const t = reviewDeps({ drafts: [fullPrime(93), fullPrime(92)], answers: [REVISE, second] });
    const out = await reviewPrimeCard((await t.store.store.pointer('Fa Legend', true))!, OPENED, ctx(), t.deps, t.util);
    assert.ok(!t.store.events.some((e) => e.startsWith('publish')));
    assert.equal(out.ok, false);
    assert.equal(t.store.cards['prime-fa-legend'].ratings.overall, 90);
    const r = t.reviews.rows[0];
    assert.equal(r.verdict, 'refuse');
    assert.equal(r.published, false);
    assert.equal(r.revise_notes, 'Keep the window the record supports.');
    assert.equal(r.draft?.ratings.overall, 92);
  }
});

await test('review: refuse publishes nothing and leaves a row with the reasons', async () => {
  const t = reviewDeps({ drafts: [fullPrime(89)], answers: [REFUSE] });
  const out = await reviewPrimeCard((await t.store.store.pointer('Fa Legend', true))!, OPENED, ctx(), t.deps, t.util);
  assert.deepEqual(t.store.events, ['draft', 'review']);
  assert.equal(out.ok, false);
  assert.equal(t.reviews.rows[0].verdict, 'refuse');
  assert.deepEqual(t.reviews.rows[0].reasons, REFUSE.reasons);
});

await test('review: no second draft when the card budget cannot cover it', async () => {
  const t = reviewDeps({ drafts: [fullPrime(93), fullPrime(91)], answers: [REVISE, ACCEPT] });
  const out = await reviewPrimeCard((await t.store.store.pointer('Fa Legend', true))!, OPENED, ctx(12), t.deps, t.util);
  assert.deepEqual(t.store.events, ['draft', 'review']);
  assert.equal(out.calls, CARD_ACTION_COST.review_prime);
  assert.equal(t.reviews.rows[0].verdict, 'refuse');
  assert.match(t.reviews.rows[0].reasons[0], /No budget for draft 2/);
});

await test('guard: code refuses a draft that jumps more than one tier band without a record or contradiction', async () => {
  const noEvidence: Opened = { ...OPENED, evidence: null };
  assert.equal(bandsCrossed(90, 84), 2);
  assert.match(guardDraft(fullPrime(90), fullPrime(84), noEvidence, [])!, /across 2 tier bands/);
  assert.equal(guardDraft(fullPrime(90), fullPrime(84), OPENED, []), null);
  assert.equal(guardDraft(fullPrime(90), fullPrime(88), noEvidence, []), null);
  const t = reviewDeps({ drafts: [fullPrime(84)], answers: [ACCEPT] });
  const out = await reviewPrimeCard((await t.store.store.pointer('Fa Legend', true))!, noEvidence, ctx(), t.deps, t.util);
  assert.deepEqual(t.store.events, ['draft']); // the reviewer never saw it
  assert.equal(out.calls, CARD_ACTION_COST.rerate_current);
  assert.equal(t.reviews.rows[0].verdict, 'refuse');
  assert.equal(t.reviews.rows[0].rounds[0].by, 'code');
});

await test('guard: a window of one season or over three, and an Overall outside its own placement are refused by code', () => {
  const wide = fullPrime(91, { version: { ...fullPrime(91).version!, seasonOrEra: '2001-05', primeWindow: { startSeason: '2001-02', endSeason: '2004-05' } } });
  assert.match(guardDraft(fullPrime(90), wide, OPENED, [])!, /4 seasons/);
  const narrow = fullPrime(91, { version: { ...fullPrime(91).version!, seasonOrEra: '2003-04', primeWindow: { startSeason: '2003-04', endSeason: '2003-04' } } });
  assert.match(guardDraft(fullPrime(90), narrow, OPENED, [])!, /one season/);
  const peer = prime('Zed Peer', 93, '2000-03');
  const above = fullPrime(91, { peerPlacement: P(['Zed Peer (2000-03)']) });
  assert.match(guardDraft(fullPrime(90), above, OPENED, [peer])!, /outside the range/);
});

await test('reviewer: an accept with a failing check does not stand; unknown verdicts refuse', () => {
  assert.equal(sanitizeReview({ ...ACCEPT, checks: { ...ACCEPT.checks, figuresSupported: false }, notes: 'Cut the unsupported figure.' }, 1).verdict, 'revise');
  assert.equal(sanitizeReview({ ...ACCEPT, checks: { ...ACCEPT.checks, figuresSupported: false } }, 2).verdict, 'refuse');
  assert.equal(sanitizeReview({ verdict: 'maybe' }, 1).verdict, 'refuse');
  assert.equal(sanitizeReview(REVISE, 2).verdict, 'refuse');
});

await test('reviewer: the review task thinks harder than synthesis', () => {
  const order = ['minimal', 'low', 'medium', 'high'];
  const review = resolveTaskModelConfig('review', { model: GEMINI_4_HYDROGEN }).thinkingLevel;
  const synthesis = resolveTaskModelConfig('synthesis', { model: GEMINI_4_HYDROGEN }).thinkingLevel;
  assert.ok(order.indexOf(review) > order.indexOf(synthesis));
});

// --- The actors ---------------------------------------------------------------------------------

await test('actors: a current card past its window is re-rated through the pipeline and published as a visitor\'s would be', async () => {
  const old = current('Ada Winger', 'Northgate FC', daysAgo(40), 80);
  const fresh = { ...current('Ada Winger', 'Northgate FC', dayStr(T0), 83), createdAt: T0 } as PlayerProfile;
  const t = fakeStore({ 'ada-winger': old });
  const reviews = memoryCardReviewStore();
  let rated = 0;
  const actors = createCardActors({
    store: t.store,
    drafter: {
      async rerateCurrent(name) {
        rated++;
        await t.store.publish(fresh, { supersede: false }); // the pipeline publishes it itself
        assert.equal(name, 'Ada Winger');
        return fresh;
      },
      draftPrime: async () => 'unused',
    },
    reviewer: { review: async () => ACCEPT },
    filler: { fill: async () => ({ filled: [] }) },
    reviews,
    pool: async () => [],
    recordText: async () => null,
    now: () => T0,
    sleep: async () => {},
  });
  const out = await actors.rerateCurrent('Ada Winger', ctx());
  assert.equal(rated, 1);
  assert.equal(out.ok, true);
  assert.equal(out.before?.overall, 80);
  assert.equal(out.after?.overall, 83);
  assert.equal(reviews.rows[0].verdict, 'rerated');
  assert.equal(reviews.rows[0].published_card_key, getCardKey(fresh));
  // Inside its window nothing runs.
  const inside = createCardActors({ ...({} as CardActorDeps), store: fakeStore({ 'ada-winger': fresh }).store, drafter: { rerateCurrent: async () => { throw new Error('rated'); }, draftPrime: async () => '' }, reviewer: { review: async () => ACCEPT }, filler: { fill: async () => ({}) }, reviews, pool: async () => [], recordText: async () => null, now: () => T0 });
  assert.equal((await inside.rerateCurrent('Ada Winger', ctx())).calls, 0);
});

await test('actors: review_prime opens on the signal\'s record and refuses to run without a signal', async () => {
  const t = reviewDeps({ drafts: [fullPrime(91)], answers: [ACCEPT] });
  const actors = createCardActors(t.deps);
  const out = await actors.reviewPrime('Fa Legend', ctx());
  assert.equal(out.ok, true);
  assert.equal(t.inputs[0].opened.kind, 'new_record');
  assert.equal(t.inputs[0].opened.evidence, 'record');
  const none = await actors.reviewPrime('Fa Legend', { ...ctx(), signals: { ...SIGNALS, historicalGaps: [], coherence: { pairs: [], cycles: [], positions: [] } } });
  assert.equal(none.calls, 0);
});

await test('actors: fill_facts writes only the filled gaps, never the rating', async () => {
  const card = fullPrime(90);
  const t = fakeStore({ 'prime-fa-legend': card });
  const actors = createCardActors({
    ...reviewDeps({ drafts: [], answers: [], store: t }).deps,
    filler: { fill: async () => ({ filled: [{ gap: 'Appearances for Northgate FC in 2003-04 were not found', fact: 'He made 36 league appearances in 2003-04.' }, { gap: 'invented', fact: 'x' }] }) },
  });
  const out = await actors.fillFacts(getCardKey(card), ctx());
  assert.equal(out.ok, true);
  const after = t.cards['prime-fa-legend'];
  assert.deepEqual(after.confidence?.dataGaps, []);
  assert.equal(after.filledGaps?.length, 1);
  assert.equal(after.ratings.overall, 90);
  assert.equal(out.after?.dataGaps, 0);
});

// --- The day ------------------------------------------------------------------------------------

await test('day: the journal row keeps card budget, card spend and each action\'s before and after', async () => {
  const stores = memoryScoutStores();
  const log: string[] = [];
  const actors = countingActors(log);
  actors.cards!.rerateCurrent = async () => ({ ok: true, calls: 8, detail: 'ok', before: { cardKey: 'a', overall: 80, tier: 'Quality Starter', evaluated: daysAgo(40), window: null }, after: { cardKey: 'b', overall: 83, tier: 'Quality Starter', evaluated: dayStr(T0), window: null } });
  const tally = createScoutTally(() => T0);
  for (let i = 0; i < 4; i++) tally.cardView('Ada Winger');
  let seen: number | undefined;
  const day = createScoutDay({
    sources: {
      tally,
      snapshots: async () => [],
      latestScored: async () => null,
      nextFixture: async () => null,
      cards: async () => [],
      cardReview: (askedFn) => gatherCardSignals(cardSources(), askedFn, T0),
    },
    model: {
      plan: async (input) => {
        seen = input.cardBudget;
        return { summary: 'cards', actions: [{ type: 'rerate_current', player: 'Ada Winger', reason: 'window closed, asked 4 times' }] };
      },
    },
    actors,
    journal: stores.journal,
    budget: 30,
    cardBudget: 24,
    now: () => T0,
  });
  const row = await day.tick();
  assert.equal(seen, 24);
  assert.ok(row);
  assert.equal(row!.card_budget, 24);
  assert.equal(row!.card_calls_spent, 8);
  assert.equal(row!.calls_spent, 1); // the planning call only
  assert.equal(row!.ran[0].before?.overall, 80);
  assert.equal(row!.ran[0].after?.overall, 83);
  assert.equal(row!.signals.cardReview?.expiredCurrent.find((c) => c.player === 'Ada Winger')?.asked, 4);
});

// --- Calibration gaps -----------------------------------------------------------------------------

/** A current card at a position, rated `ago` days before today. */
const at = (name: string, position: string, overall: number, ago = 12): PlayerProfile => {
  const card = current(name, 'Westbridge', daysAgo(ago), overall);
  return { ...card, basicInfo: { ...card.basicInfo, position } };
};

await test('gaps: the best current card below every recent historical card at its position, flanks together', () => {
  const pool = [
    at('Left Now', 'Left-Back', 90),
    at('Right Now', 'Right-Back', 88),
    prime('Old Left', 91, '2012-15', { position: 'Left-Back' }),
    prime('Old Right', 93, '2018-21', { position: 'Right Wing-Back', type: 'era' }),
    // Its window ended long ago, so it isn't on the recent scale, though it is rated below.
    prime('Ancient Back', 85, '1996-99', { position: 'Left-Back' }),
  ];
  const gaps = findCalibrationGaps(pool, T0);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].position, 'Full-Back and Wing-Back');
  assert.equal(gaps[0].current.player, 'Left Now');
  assert.equal(gaps[0].current.overall, 90);
  assert.equal(gaps[0].recent, 2);
  assert.deepEqual(gaps[0].above.map((c) => c.player), ['Old Left', 'Old Right']);
  assert.equal(gaps[0].windowEnds, dayStr(Date.parse(`${daysAgo(12)}T00:00:00Z`) + 30 * DAY));
});

await test('gaps: a recent historical card level with or below the best current card closes the gap', () => {
  const above = prime('Old Nine', 93, '2014-17');
  for (const overall of [90, 89]) {
    assert.deepEqual(findCalibrationGaps([at('Nine Now', 'Centre Forward', 90), above, prime('Other Nine', overall, '2019-22')], T0), []);
  }
  // A season card counts as historical too, and a position with no recent historical card has no gap.
  const season = prime('Season Nine', 89, '2024-25');
  season.version = { ...season.version!, type: 'season_snapshot', primeWindow: undefined };
  assert.deepEqual(findCalibrationGaps([at('Nine Now', 'Centre Forward', 90), above, season], T0), []);
  assert.deepEqual(findCalibrationGaps([at('Keeper Now', 'Goalkeeper', 80), above], T0), []);
});

await test("gaps: the recent scale is the last 15 years, and a player's own historical card isn't part of it", () => {
  // 2010-11 closed on 30 June 2011, more than 15 years before; 2011-12 closed inside them.
  const old = (window: string) => {
    const card = prime('Edge Nine', 93, '2009-12');
    return { ...card, version: { ...card.version!, seasonOrEra: window } };
  };
  assert.deepEqual(findCalibrationGaps([at('Nine Now', 'Centre Forward', 90), old('2010-11')], T0), []);
  assert.equal(findCalibrationGaps([at('Nine Now', 'Centre Forward', 90), old('2011-12')], T0).length, 1);
  assert.deepEqual(findCalibrationGaps([at('Nine Now', 'Centre Forward', 90), prime('Nine Now', 94, '2019-22')], T0), []);
});

await test('gaps: tied best current cards are each reported, and the list names the nearest of many', () => {
  const many = Array.from({ length: 12 }, (_, i) => prime(`Past ${i}`, 99 - i, '2015-18', { position: 'Goalkeeper' }));
  const gaps = findCalibrationGaps([at('Gk One', 'Goalkeeper', 87), at('Gk Two', 'Goalkeeper', 87), at('Gk Three', 'Goalkeeper', 86), ...many], T0);
  assert.deepEqual(gaps.map((g) => g.current.player).sort(), ['Gk One', 'Gk Two']);
  assert.equal(gaps[0].recent, 12);
  assert.equal(gaps[0].above.length, 8);
  assert.equal(gaps[0].above[0].overall, 88);
});

const GAP_ROWS: StoredCard[] = [
  row('left-now', at('Left Now', 'Left-Back', 90)),
  // Past its window, so it isn't in the served pool the gap is read from.
  row('stale-winger', at('Stale Winger', 'Left Winger', 84, 33)),
  row('prime-old-left', prime('Old Left', 91, '2012-15', { position: 'Left-Back' })),
  row('prime-old-wing', prime('Old Wing', 92, '2016-19', { position: 'Right Winger' })),
];

await test('gaps: the signals and the planner summary carry them, and no action or rating comes of them', async () => {
  const signals = await gatherCardSignals(cardSources({ rows: async () => GAP_ROWS, queued: async () => [] }), () => 0, T0);
  assert.deepEqual(signals.calibrationGaps?.map((g) => g.current.player), ['Left Now']);
  const text = formatCardSignals(signals);
  assert.match(text, /Calibration gaps[^\n]*changes no rating/);
  assert.match(text, /Full-Back and Wing-Back: Left Now \(current; Overall 90\) sits below all 1 recent historical cards there, nearest first: Old Left \(prime, 2012-15; Overall 91\); window ends /);
  // No action may name him until his window closes.
  const { plan } = sanitizePlan(
    { summary: 's', actions: [{ type: 'rerate_current', player: 'Left Now', reason: 'gap' }, { type: 'refresh_latest_update', player: 'Left Now', reason: 'gap' }, { type: 'review_prime', player: 'Old Left', reason: 'gap' }] },
    scoutSignals(signals),
  );
  assert.deepEqual(plan.actions, []);
  const prompt = buildPlanPrompt({ today: dayStr(T0), season: '2026-27', budget: 30, cardBudget: 24, signals: scoutSignals(signals) });
  assert.match(prompt, /A calibration gap is a figure about the pool and opens no action of its own/);
  assert.equal(GAP_ROWS[0].card.ratings.overall, 90);
});

await test('gaps: a card in a gap is queued from the journal for the day its window ends', async () => {
  const flagged = await gatherCardSignals(cardSources({ rows: async () => GAP_ROWS, queued: async () => [] }), () => 0, T0);
  const journal = [{ day: dayStr(T0), signals: { cardReview: flagged } }];
  const queued = queuedFromJournal(journal);
  assert.deepEqual(queued.map((q) => q.player), ['Left Now']);
  assert.match(queued[0].reason, /best current card at Full-Back and Wing-Back/);
  // The day his window closes he is in the expired list, queued, ahead of a card nothing flagged.
  const later = T0 + 20 * DAY;
  const after = await gatherCardSignals(cardSources({ rows: async () => GAP_ROWS, queued: async () => queued }), (p) => (p === 'Stale Winger' ? 9 : 0), later);
  assert.deepEqual(after.expiredCurrent.map((c) => [c.player, c.queued]), [['Left Now', true], ['Stale Winger', false]]);
  assert.match(after.expiredCurrent[0].queuedReason!, /Full-Back and Wing-Back/);
  // A journal row written before gaps were reported is still read.
  const { calibrationGaps: _none, ...before } = flagged;
  assert.deepEqual(queuedFromJournal([{ day: dayStr(T0), signals: { cardReview: before } }]), []);
});

// --- Chat evidence --------------------------------------------------------------------------------

const REVIEW_ROW = (over: Partial<PublishedReview> = {}): PublishedReview => ({
  day: daysAgo(3),
  action: 'review_prime',
  player: 'Fa Legend',
  player_slug: 'fa-legend',
  edition: 'prime',
  card_key: 'fa-legend:prime:2003-05-20',
  published_card_key: 'fa-legend:prime:2004-05-20',
  published_at: new Date(T0 - 3 * DAY).toISOString(),
  reason: 'A newer club-season record covers his gaps.',
  verdict: 'accept',
  reasons: ['Driven by the record.'],
  old_overall: 90,
  new_overall: 91,
  ...over,
});

await test('ledger: the latest published review of a card lands as dated evidence with the Overall before and after', async () => {
  const source: CardReviewSource = {
    published: async () => [
      REVIEW_ROW(),
      REVIEW_ROW({ published_at: new Date(T0 - 100 * DAY).toISOString(), published_card_key: 'fa-legend:prime:1999-01-01' }), // too old
      REVIEW_ROW({ player: 'Other', player_slug: 'other', published_card_key: 'other:prime:2000-01-01' }), // not asked for
    ],
  };
  const ledger = await fileCardReviews(emptyLedger(), { cardKeys: ['fa-legend:prime:2004-05-20'], players: [] }, source, T0);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].kind, 'card_review');
  const text = formatLedger(ledger);
  assert.match(text, /card review/i);
  assert.match(text, /from Overall 90 to Overall 91/);
  assert.match(text, new RegExp(daysAgo(3)));
  assert.match(text, /A newer club-season record covers his gaps/);
});

await test('ledger: a player the turn names gets his newest review per edition; an exact card match comes first', async () => {
  const source: CardReviewSource = {
    published: async () => [
      REVIEW_ROW({ published_at: new Date(T0 - DAY).toISOString(), published_card_key: 'fa-legend:prime:2005-05-20', new_overall: 92 }),
      REVIEW_ROW(),
      REVIEW_ROW({ action: 'rerate_current', edition: 'current', published_card_key: 'fa-legend:current:2026-11-20' }),
    ],
  };
  const byPlayer = await fileCardReviews(emptyLedger(), { cardKeys: [], players: ['Fa Legend'] }, source, T0);
  assert.equal(byPlayer.entries.length, 2);
  assert.match(byPlayer.entries[0].content, /to Overall 92/);
  const exact = await fileCardReviews(emptyLedger(), { cardKeys: ['fa-legend:prime:2004-05-20'], players: ['Fa Legend'] }, source, T0);
  assert.match(exact.entries[0].content, /to Overall 91/);
  assert.match(cardReviewEntry(REVIEW_ROW({ action: 'rerate_current', edition: 'current' })).content, /end of its rating window/);
});

await test('ledger: a slow or missing table leaves the ledger as it was', async () => {
  const down: CardReviewSource = { published: async () => { throw new Error('no table'); } };
  assert.equal((await fileCardReviews(emptyLedger(), { cardKeys: [], players: ['Fa Legend'] }, down, T0)).entries.length, 0);
});

console.log = realLog;
console.warn = realWarn;
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
