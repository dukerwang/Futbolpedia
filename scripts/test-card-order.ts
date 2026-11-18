#!/usr/bin/env npx tsx
/**
 * Offline checks for when cards settle an order and where a model's disagreement goes, with the
 * sink, the card lookup, the stores and the clock faked: the one rule (`cardsSettle`) for every
 * criterion in both spellings, the debate check and `show_ranking` agreeing on every criterion, the
 * pairs each check reports, the browser sink and the route's reader, the server's tally (one count
 * per source a day, its caps and its window), and card review reading the pairs: resolved against
 * the served pool, the threshold, the summary, the planner's targets, a review opened on a
 * disagreement and skipped when it no longer holds, the band guard, and a current card queued.
 *
 * Usage:
 *   npx tsx scripts/test-card-order.ts
 */
import assert from 'node:assert/strict';
import type { PeerPlacement, PlayerProfile, ReplyBlock } from '../types';
import { RANKING_CRITERIA } from '../components/views/viewData';
import {
  CARD_SETTLED_CRITERIA,
  cardsSettle,
  checkOrderAgainstCards,
  checkVerdictAgainstCards,
  DEBATE_CRITERIA,
  toStanding,
} from '../services/debateConsistency';
import { checkBriefAgainstCards, readDebateBrief } from '../services/debateBrief';
import { REPLY_BLOCKS } from '../services/replyBlocks/registry';
import type { BuildContext } from '../services/replyBlocks/entry';
import {
  createBrowserSink,
  createDisagreementTally,
  DISAGREEMENT_ROUTE,
  DISAGREEMENT_TALLY_CAP,
  disagreementsFromSwaps,
  MAX_PAIRS_PER_REPORT,
  MAX_PAIRS_PER_SOURCE_DAY,
  readDisagreementReport,
  reportCardDisagreements,
  setDisagreementSink,
  type CardDisagreement,
  type DisagreementHit,
} from '../services/cardDisagreements';
import {
  cardTargets,
  createCardActors,
  findDisagreements,
  formatCardSignals,
  gatherCardSignals,
  guardDraft,
  memoryCardReviewStore,
  openedForDisagreement,
  queuedFromJournal,
  type CardActorDeps,
  type CardReviewSignals,
  type CardReviewSources,
  type StoredCard,
} from '../services/cardReview';
import { getCardKey, toDossierCardSlug } from '../services/dossierCards';
import { buildPlanPrompt, createScoutTally, describeSignals, sanitizePlan, type ScoutSignals } from '../services/scoutDay';

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
const realWarn = console.warn;
console.warn = (...args: unknown[]) => (typeof args[0] === 'string' && /^\[(RatingPlacement|card-review)\]/.test(args[0]) ? undefined : realWarn(...args));

// --- Clock, cards and the sink ----------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-25T09:00:00Z');
const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysAgo = (n: number) => dayStr(T0 - n * DAY);
const RATED = T0 - 20 * DAY; // after the calibration epoch

function prime(name: string, overall: number, window: string, placement?: PeerPlacement): PlayerProfile {
  const start = Number(window.slice(0, 4));
  return {
    basicInfo: { name, club: 'Northgate FC', position: 'Central Midfielder', age: 27, nationality: 'X' },
    ratings: { overall, potential: overall },
    version: {
      id: 'v',
      type: 'prime',
      label: 'Prime',
      evaluationDate: `${start + 2}-05-20`,
      seasonOrEra: window,
      primeWindow: { startSeason: `${start}-${String(start + 1).slice(2)}`, endSeason: `${start + 2}-${String(start + 3).slice(2)}` },
    },
    evaluationDate: `${start + 2}-05-20`,
    createdAt: RATED,
    latestUpdate: '',
    shortBio: 'A midfielder.',
    confidence: { grade: 'B', sampleSize: 'Three seasons', dataGaps: [], verdict: 'Solid.' },
    ...(placement ? { peerPlacement: placement } : {}),
  } as unknown as PlayerProfile;
}

function current(name: string, evaluated: string, overall: number): PlayerProfile {
  return {
    basicInfo: { name, club: 'Northgate FC', position: 'Central Midfielder', age: 25, nationality: 'X' },
    ratings: { overall, potential: overall + 2 },
    version: { id: 'v', type: 'current', label: 'Current', evaluationDate: evaluated, seasonOrEra: '2026-27' },
    evaluationDate: evaluated,
    createdAt: Date.parse(`${evaluated}T12:00:00Z`),
    latestUpdate: 'News.',
  } as unknown as PlayerProfile;
}

const ALBA = prime('Alba Reyes', 94, '2004-07');
const BRAM = prime('Bram Oduya', 90, '2008-11');
const CATO = prime('Cato Lind', 88, '1998-01');
const DESI = current('Desi Moor', daysAgo(10), 86); // a current card inside its window
const ROWS: StoredCard[] = [
  { slug: 'prime-alba-reyes', card: ALBA, rowAt: RATED },
  { slug: 'prime-bram-oduya', card: BRAM, rowAt: RATED },
  { slug: 'prime-cato-lind', card: CATO, rowAt: RATED },
  { slug: 'desi-moor', card: DESI, rowAt: RATED },
];
const key = (c: PlayerProfile) => getCardKey(c);

/** Collects every pair reported while `fn` runs. */
async function collecting(fn: () => unknown | Promise<unknown>): Promise<CardDisagreement[]> {
  const got: CardDisagreement[] = [];
  setDisagreementSink((pairs) => got.push(...pairs));
  try {
    await fn();
  } finally {
    setDisagreementSink(null);
  }
  return got;
}

// show_ranking's build context, with the cards faked.
const cardsByName = new Map([ALBA, BRAM, CATO].map((c) => [c.basicInfo.name, c] as const));
let counter = 0;
const rankingCtx = (): BuildContext => ({
  tools: {} as BuildContext['tools'],
  ledger: { read: () => ({ entries: [], gaps: [] }) as any, write: () => {} },
  stored: [],
  blocks: () => [] as ReplyBlock[],
  now: () => T0,
  newId: () => `t${++counter}`,
  cards: {
    async lookUp(name) {
      const card = cardsByName.get(name);
      return card ? { status: 'found', card } : { status: 'missing' };
    },
  },
});
const rankingOrder = async (criterion: string, names: string[]) => {
  const out = await REPLY_BLOCKS.ranking.build({ title: 'Best', names, criterion }, rankingCtx());
  assert.ok('block' in out, `ranking built for ${criterion}`);
  return 'block' in out ? out.block.data.entries.map((e) => e.name) : [];
};

const brief = (criterion: string, kind: 'ranking' | 'head_to_head', extra: Record<string, unknown> = {}) =>
  readDebateBrief({ understanding: 'u', kind, criterion, criteria: [], versions: [], verdict: '', ranking: [], calls: [], ...extra }, { message: 'q' });

const STANDINGS = [ALBA, BRAM, CATO].map(toStanding);

// --- The one rule --------------------------------------------------------------------------------

await test('rule: cards settle peak level and mixed in either spelling, and nothing else', () => {
  assert.deepEqual([...CARD_SETTLED_CRITERIA], ['peak_level', 'mixed']);
  for (const c of DEBATE_CRITERIA) assert.equal(cardsSettle(c), c === 'peak_level' || c === 'mixed', c);
  for (const c of RANKING_CRITERIA) assert.equal(cardsSettle(c), c === 'peak level' || c === 'mixed', c);
  assert.equal(cardsSettle('Peak-Level'), true);
  assert.equal(cardsSettle(' sustained level '), false);
  assert.equal(cardsSettle('vibes'), false);
});

await test('rule: the debate check and show_ranking agree on every criterion for the same cards', async () => {
  const proposed = ['Bram Oduya', 'Alba Reyes'];
  for (let i = 0; i < DEBATE_CRITERIA.length; i++) {
    const debate = DEBATE_CRITERIA[i];
    const ranking = RANKING_CRITERIA[i];
    assert.equal(debate.replace('_', ' '), ranking, 'the two lists name the same criteria in the same order');
    const checked = checkBriefAgainstCards(brief(debate, 'ranking', { ranking: proposed }), STANDINGS);
    const drawn = await rankingOrder(ranking, proposed);
    const expected = cardsSettle(debate) ? ['Alba Reyes', 'Bram Oduya'] : proposed;
    assert.deepEqual(checked.ranking, expected, `debate check, ${debate}`);
    assert.deepEqual(drawn, expected, `show_ranking, ${ranking}`);
    // The head-to-head verdict follows the same rule.
    const verdict = checkVerdictAgainstCards('Bram Oduya', proposed, STANDINGS, debate);
    assert.equal(verdict.changed, cardsSettle(debate), `verdict, ${debate}`);
  }
});

await test('rule: show_ranking names the settled criteria from the one list', () => {
  const description = REPLY_BLOCKS.ranking.tool!.description ?? '';
  assert.match(description, /criterion peak level or mixed\)/);
  assert.ok(!/sustained level or mixed/.test(description));
});

// --- Capture -------------------------------------------------------------------------------------

await test('capture: an order check returns each pair it turned round as card standings', () => {
  const check = checkOrderAgainstCards(['Cato Lind', 'Alba Reyes', 'Bram Oduya'], STANDINGS);
  assert.deepEqual(check.order, ['Alba Reyes', 'Bram Oduya', 'Cato Lind']);
  const pairs = disagreementsFromSwaps(check.swaps, 'debate');
  assert.deepEqual(
    pairs.map((p) => [p.higher, p.lower]),
    [
      [key(ALBA), key(CATO)],
      [key(BRAM), key(CATO)],
    ],
  );
  assert.deepEqual(checkOrderAgainstCards(['Alba Reyes', 'Bram Oduya'], STANDINGS).swaps, [], 'an order the cards agree with turns nothing round');
});

await test('capture: a verdict changed from the other side is a pair; one naming neither side, or level cards, is not', () => {
  const changed = checkVerdictAgainstCards('Bram Oduya', ['Alba Reyes', 'Bram Oduya'], STANDINGS, 'peak_level');
  assert.equal(changed.swap?.higher.cardKey, key(ALBA));
  assert.equal(changed.swap?.lower.cardKey, key(BRAM));
  const neither = checkVerdictAgainstCards('Too close to call', ['Alba Reyes', 'Bram Oduya'], STANDINGS, 'peak_level');
  assert.equal(neither.changed, true);
  assert.equal(neither.swap, undefined);
  const twin = toStanding(prime('Eli Vance', 94, '2004-07'));
  const level = checkVerdictAgainstCards('Eli Vance', ['Alba Reyes', 'Eli Vance'], [STANDINGS[0], twin], 'peak_level');
  assert.equal(level.changed, false);
  assert.equal(level.swap, undefined);
});

await test('capture: swaps without a card key, or of one card, are left out', () => {
  const [a, b] = STANDINGS;
  assert.deepEqual(disagreementsFromSwaps([{ higher: { ...a, cardKey: undefined }, lower: b }], 'debate'), []);
  assert.deepEqual(disagreementsFromSwaps([{ higher: a, lower: a }], 'debate'), []);
  assert.equal(disagreementsFromSwaps([{ higher: a, lower: b }, { higher: a, lower: b }], 'ranking').length, 1, 'one pair once');
});

await test('capture: the debate check reports what it turned round, and only on a settled criterion', async () => {
  const ranked = await collecting(() => checkBriefAgainstCards(brief('peak_level', 'ranking', { ranking: ['Bram Oduya', 'Alba Reyes'] }), STANDINGS));
  assert.deepEqual(ranked, [{ higher: key(ALBA), lower: key(BRAM), via: 'debate' }]);
  const h2h = await collecting(() =>
    checkBriefAgainstCards(
      brief('mixed', 'head_to_head', { verdict: 'Bram Oduya, narrowly', versions: [{ subject: 'Alba Reyes', period: '2004-07' }, { subject: 'Bram Oduya', period: '2008-11' }] }),
      STANDINGS,
    ),
  );
  assert.deepEqual(h2h, [{ higher: key(ALBA), lower: key(BRAM), via: 'debate' }]);
  assert.deepEqual(await collecting(() => checkBriefAgainstCards(brief('output', 'ranking', { ranking: ['Bram Oduya', 'Alba Reyes'] }), STANDINGS)), []);
  assert.deepEqual(await collecting(() => checkBriefAgainstCards(brief('sustained_level', 'ranking', { ranking: ['Bram Oduya', 'Alba Reyes'] }), STANDINGS)), []);
  assert.deepEqual(await collecting(() => checkBriefAgainstCards(brief('peak_level', 'ranking', { ranking: ['Alba Reyes', 'Bram Oduya'] }), STANDINGS)), [], 'nothing moved');
});

await test('capture: show_ranking reports the pairs the cards turned round, under a settled criterion only', async () => {
  const peak = await collecting(() => rankingOrder('peak level', ['Cato Lind', 'Alba Reyes']));
  assert.deepEqual(peak, [{ higher: key(ALBA), lower: key(CATO), via: 'ranking' }]);
  assert.deepEqual(await collecting(() => rankingOrder('sustained level', ['Cato Lind', 'Alba Reyes'])), []);
  assert.deepEqual(await collecting(() => rankingOrder('influence', ['Cato Lind', 'Alba Reyes'])), []);
});

await test('capture: the browser sink posts each pair once, card keys and path only, and a failure costs nothing', async () => {
  const sent: { url: string; body: any; keepalive?: boolean }[] = [];
  const sink = createBrowserSink((async (url: string, init: any) => {
    sent.push({ url, body: JSON.parse(init.body), keepalive: init.keepalive });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch);
  const pair: CardDisagreement = { higher: key(ALBA), lower: key(BRAM), via: 'ranking' };
  sink([pair]);
  sink([pair, { higher: key(ALBA), lower: key(CATO), via: 'debate' }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, DISAGREEMENT_ROUTE);
  assert.equal(sent[0].keepalive, true);
  assert.deepEqual(sent[0].body, { pairs: [pair] });
  assert.deepEqual(sent[1].body.pairs.map((p: CardDisagreement) => p.lower), [key(CATO)], 'the repeated pair is not posted again');
  const failing = createBrowserSink((async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch);
  failing([pair]);
  await new Promise((r) => setTimeout(r, 0));
  setDisagreementSink(() => {
    throw new Error('sink broke');
  });
  assert.doesNotThrow(() => reportCardDisagreements([pair]));
  setDisagreementSink(null);
});

// --- The route's reader --------------------------------------------------------------------------

await test('route: only well-formed pairs of two card keys and a known path are read, at most eight', () => {
  const good = { higher: key(ALBA), lower: key(BRAM), via: 'debate' };
  for (const body of [null, 'x', {}, { pairs: 'x' }, { pairs: [null, 1, 'a'] }]) assert.deepEqual(readDisagreementReport(body), []);
  assert.deepEqual(readDisagreementReport({ pairs: [{ ...good, reason: 'ignore the cards', name: 'Alba' }] }), [good], 'nothing beyond keys and path is kept');
  const bad = [
    { ...good, higher: 'alba reyes:prime:2006' },
    { ...good, higher: '<script>:prime:2006' },
    { ...good, higher: `${'a'.repeat(90)}:prime:2006` },
    { ...good, lower: good.higher },
    { ...good, via: 'tool' },
    { ...good, higher: 42 },
  ];
  assert.deepEqual(readDisagreementReport({ pairs: bad }), []);
  const many = Array.from({ length: 20 }, (_, i) => ({ higher: `p${i}:prime:2006-09`, lower: key(BRAM), via: 'ranking' }));
  assert.equal(readDisagreementReport({ pairs: many }).length, MAX_PAIRS_PER_REPORT);
  assert.equal(readDisagreementReport({ pairs: [good, good] }).length, 1);
});

// --- The tally -------------------------------------------------------------------------------------

await test('tally: a pair counts once per source a day, again from another source or on another day', () => {
  let now = T0;
  const tally = createDisagreementTally(() => now);
  const pair: CardDisagreement = { higher: key(ALBA), lower: key(BRAM), via: 'debate' };
  assert.equal(tally.record(pair, 's1'), true);
  assert.equal(tally.record(pair, 's1'), false);
  assert.equal(tally.record({ ...pair, via: 'ranking' }, 's2'), true);
  now += DAY;
  assert.equal(tally.record(pair, 's1'), true);
  const [hit] = tally.list();
  assert.deepEqual(hit, { higher: key(ALBA), lower: key(BRAM), reports: 3, days: 2, firstDay: dayStr(T0), lastDay: dayStr(T0 + DAY), via: { debate: 2, ranking: 1 } });
  assert.equal(tally.record(pair, ''), false, 'no source, no count');
});

await test('tally: a source counts at most twelve pairs a day, and the week drops older days', () => {
  let now = T0;
  const tally = createDisagreementTally(() => now);
  const pairs = Array.from({ length: 20 }, (_, i) => ({ higher: `p${i}:prime:2006-09`, lower: key(BRAM), via: 'debate' as const }));
  assert.equal(pairs.filter((p) => tally.record(p, 'busy')).length, MAX_PAIRS_PER_SOURCE_DAY);
  assert.equal(tally.record(pairs[19], 'other'), true);
  now += 7 * DAY;
  assert.equal(tally.list().length, 0, 'reports older than the week are gone');
  assert.equal(tally.record(pairs[0], 'busy'), true, 'a new day resets the cap');
});

await test('tally: the tally holds a bounded number of pairs, oldest out first', () => {
  const tally = createDisagreementTally(() => T0);
  for (let i = 0; i <= DISAGREEMENT_TALLY_CAP; i++) tally.record({ higher: `p${i}:prime:2006-09`, lower: key(BRAM), via: 'debate' }, `s${i}`);
  const listed = tally.list();
  assert.equal(listed.length, DISAGREEMENT_TALLY_CAP);
  assert.ok(!listed.some((h) => h.higher === 'p0:prime:2006-09'));
});

await test('tally: the scout tally counts disagreements beside its other tallies', () => {
  const tally = createScoutTally(() => T0);
  tally.cardDisagreement({ higher: key(ALBA), lower: key(BRAM), via: 'ranking' }, 'a');
  tally.cardDisagreement({ higher: key(ALBA), lower: key(BRAM), via: 'ranking' }, 'b');
  assert.equal(tally.disagreements()[0].reports, 2);
});

// --- Card review -------------------------------------------------------------------------------

const hit = (higher: PlayerProfile | string, lower: PlayerProfile | string, reports = 3, days = 2): DisagreementHit => ({
  higher: typeof higher === 'string' ? higher : key(higher),
  lower: typeof lower === 'string' ? lower : key(lower),
  reports,
  days,
  firstDay: daysAgo(3),
  lastDay: daysAgo(1),
  via: { debate: reports - 1, ranking: 1 },
});

const sources = (hits: DisagreementHit[], over: Partial<CardReviewSources> = {}): CardReviewSources => ({
  rows: async () => ROWS,
  liveClub: async () => null,
  clubXi: async () => null,
  coverage: async () => [],
  queued: async () => [],
  disagreements: () => hits,
  ...over,
});

let SIGNALS: CardReviewSignals;

await test('review signals: pairs resolve against the served pool; gone keys, pairs the cards now reverse and thin counts drop', async () => {
  SIGNALS = await gatherCardSignals(
    sources([
      hit(ALBA, BRAM, 4, 3),
      hit(BRAM, ALBA), // the cards rank Alba above Bram: this report doesn't hold
      hit('ghost-player:prime:2001-05-20', CATO), // no such card
      hit(BRAM, CATO, 1, 1), // below the threshold
      hit(BRAM, DESI, 2, 2), // a current card inside its window
    ]),
    () => 0,
    T0,
  );
  const pairs = SIGNALS.disagreements!;
  assert.deepEqual(
    pairs.map((d) => [d.higher.player, d.lower.player, d.reports]),
    [
      ['Alba Reyes', 'Bram Oduya', 4],
      ['Bram Oduya', 'Desi Moor', 2],
    ],
  );
  assert.deepEqual(pairs[0].waiting, []);
  assert.deepEqual(pairs[1].waiting, [{ player: 'Desi Moor', windowEnds: dayStr(Date.parse(`${daysAgo(10)}T00:00:00Z`) + 30 * DAY) }]);
  // Without a tally the list is empty, never missing.
  assert.deepEqual((await gatherCardSignals(sources([], { disagreements: undefined }), () => 0, T0)).disagreements, []);
});

await test('review signals: the summary lists each pair with its counts, and the log counts them', () => {
  const text = formatCardSignals(SIGNALS);
  assert.match(text, /Pairs of cards that answers ordered the other way/);
  assert.match(text, /answers put Bram Oduya \(prime, 2008-11; Overall 90\) above Alba Reyes \(prime, 2004-07; Overall 94\): 4 reports on 3 days/);
  assert.match(text, /3 from debate answers, 1 from drawn rankings/);
  assert.match(text, /waiting for its window: Desi Moor until /);
  const scout: ScoutSignals = {
    day: dayStr(T0),
    season: '2026-27',
    tallyHours: 200,
    demand: { clubs: [], players: [], seasons: [], gaffaTurns: 0 },
    staleStories: [],
    fixtures: [],
    cards: { nearingRefresh: [], staleLatestUpdate: [] },
    gaps: [],
    cardReview: SIGNALS,
    unread: [],
  };
  assert.match(describeSignals(scout), /2 disagreement pairs/);
  const prompt = buildPlanPrompt({ today: dayStr(T0), season: '2026-27', budget: 30, cardBudget: 24, signals: scout } as any);
  assert.match(prompt, /in a pair answers ordered against the cards/);
  assert.ok(!/Alba|Bram/.test(prompt.split('<signals>')[0]), 'the instructions name no player');
});

await test('review signals: a prime in a pair is a review target; a current card in one is not re-rated inside its window', () => {
  const targets = cardTargets(SIGNALS);
  assert.ok(targets.review.has('alba-reyes') && targets.review.has('bram-oduya'));
  assert.ok(!targets.rerate.has('desi-moor'));
  const scout = { day: dayStr(T0), season: '2026-27', tallyHours: 200, demand: { clubs: [], players: [], seasons: [], gaffaTurns: 0 }, staleStories: [], fixtures: [], cards: { nearingRefresh: [], staleLatestUpdate: [] }, gaps: [], cardReview: SIGNALS, unread: [] } as ScoutSignals;
  const { plan } = sanitizePlan(
    {
      summary: 's',
      actions: [
        { type: 'review_prime', player: 'Bram Oduya', reason: 'answers keep ranking him above Alba Reyes' },
        { type: 'rerate_current', player: 'Desi Moor', reason: 'disagreement' },
        { type: 'review_prime', player: 'Cato Lind', reason: 'no signal names him' },
      ],
    },
    scout,
  );
  assert.deepEqual(plan.actions.map((a) => `${a.type}:${'player' in a ? a.player : ''}`), ['review_prime:Bram Oduya']);
});

await test('review: a review opened on a disagreement states the count and both cards, and none when the pair no longer holds', () => {
  const d = SIGNALS.disagreements![0];
  const opened = openedForDisagreement(d, d.higher, [ALBA, BRAM, CATO]);
  assert.equal(opened.kind, 'disagreement');
  assert.match(opened.evidence!, /placed Bram Oduya .* above Alba Reyes .* 4 times on 3 days/);
  assert.match(opened.evidence!, /Only the count was kept/);
  const reRated = { ...ALBA, ratings: { overall: 89, potential: 89 } } as PlayerProfile; // same key, now below Bram
  assert.equal(openedForDisagreement(d, d.higher, [reRated, BRAM]).evidence, null);
  assert.equal(openedForDisagreement(d, d.higher, [BRAM]).evidence, null, 'a card gone from the pool');
});

await test('review: the actor skips a disagreement that no longer holds without drafting, and drafts one that does', async () => {
  const drafted: string[] = [];
  const cards: Record<string, PlayerProfile> = { [toDossierCardSlug('Bram Oduya', true)]: BRAM };
  let pool: PlayerProfile[] = [ALBA, BRAM];
  const deps: CardActorDeps = {
    store: {
      pointer: async (name, isPrime) => cards[toDossierCardSlug(name, isPrime)] ?? null,
      byKey: async () => [],
      publish: async () => {},
      writeInPlace: async () => true,
    },
    drafter: {
      rerateCurrent: async () => 'unused',
      async draftPrime(_name, note) {
        drafted.push(note);
        return 'no draft today';
      },
    },
    reviewer: { review: async () => ({}) },
    filler: { fill: async () => ({ filled: [] }) },
    reviews: memoryCardReviewStore(),
    pool: async () => pool,
    recordText: async () => null,
    now: () => T0,
    sleep: async () => {},
  };
  const actors = createCardActors(deps);
  const ctx = { signals: SIGNALS, remaining: 24, reason: 'answers disagree' };
  const held = await actors.reviewPrime('Bram Oduya', ctx);
  assert.equal(drafted.length, 1);
  assert.match(drafted[0], /opened for this reason: Answers about how good the players were ordered/);
  assert.equal(held.calls, 8, 'one draft, which gave no card');
  pool = [{ ...ALBA, ratings: { overall: 89, potential: 89 } } as PlayerProfile, BRAM];
  const gone = await actors.reviewPrime('Bram Oduya', ctx);
  assert.equal(gone.calls, 0);
  assert.equal(gone.detail, "the disagreement no longer holds in today's pool");
  assert.equal(drafted.length, 1);
});

await test('review: a draft opened on a disagreement may move one tier band, never two', () => {
  const opened = openedForDisagreement(SIGNALS.disagreements![0], SIGNALS.disagreements![0].higher, [ALBA, BRAM]);
  const draft = (overall: number) => ({ ...BRAM, ratings: { overall, potential: overall }, rerateAt: T0 }) as PlayerProfile;
  assert.equal(guardDraft(BRAM, draft(93), opened, []), null, 'one band up');
  assert.match(guardDraft(BRAM, draft(96), opened, []) ?? '', /count of disagreements/);
  assert.equal(guardDraft(BRAM, draft(96), { ...opened, kind: 'new_record' }, []), null, 'a new record may move further');
});

await test('review: a current card in a pair is queued from the journal and shows as queued once its window closes', async () => {
  const queued = queuedFromJournal([{ day: daysAgo(5), signals: { cardReview: SIGNALS } }, { day: daysAgo(40), signals: { cardReview: { ...SIGNALS, disagreements: undefined } } }]);
  assert.deepEqual(queued.map((q) => q.player), ['Desi Moor']);
  assert.match(queued[0].reason, /answers ordered his current card against Bram Oduya's prime card/);
  const expired = current('Desi Moor', daysAgo(35), 86);
  const later = await gatherCardSignals(
    sources([], { rows: async () => [...ROWS.filter((r) => r.slug !== 'desi-moor'), { slug: 'desi-moor', card: expired, rowAt: RATED }], queued: async () => queued }),
    () => 0,
    T0,
  );
  const desi = later.expiredCurrent.find((c) => c.player === 'Desi Moor')!;
  assert.equal(desi.queued, true);
  assert.match(desi.queuedReason!, /answers ordered his current card/);
  assert.ok(cardTargets(later).rerate.has('desi-moor'));
});

await test('review: findDisagreements caps the list and keeps the most reported first', () => {
  const hits = [hit(BRAM, CATO, 2, 1), hit(ALBA, CATO, 5, 4), hit(ALBA, BRAM, 3, 2)];
  assert.deepEqual(
    findDisagreements(hits, [ALBA, BRAM, CATO]).map((d) => d.reports),
    [5, 3, 2],
  );
  assert.equal(findDisagreements(hits, [ALBA, BRAM, CATO], 2, 1).length, 1);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
