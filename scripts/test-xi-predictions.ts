#!/usr/bin/env npx tsx
/**
 * Offline checks for the XI track record: scoring rules on hand-built lineups, the adjusted
 * prediction's input and its fallbacks, predictions created only inside the window and once per
 * match, scoring after the match (a late prediction scored but kept out of the record), the lazy
 * path, the sweep guard and budget, the record's totals, and the live feed's match lookup. The
 * model, the feeds and the table are faked; nothing touches the network.
 *
 * Usage:
 *   npx tsx scripts/test-xi-predictions.ts
 */
import assert from 'node:assert/strict';
import { SNAPSHOT_VERSION } from '../services/clubSnapshots';
import { createLiveFootball, ESPN_SITE, FPL_BOOTSTRAP, samePlayerName, type ClubMatch, type LiveClubReport, type LiveLineup, type LiveStarter } from '../services/liveFootball';
import { inProcessGet } from '../services/snapshotServer';
import { deriveClubCore, type ClubSnapshot } from '../services/situationSnapshot';
import {
  buildAdjustedPrompt,
  buildClubRecord,
  createXiPredictions,
  memoryXiStore,
  sanitizeAdjustedXi,
  type AdjustedXiInput,
  type AdjustedXiModel,
  type XiPredictionRow,
} from '../services/xiPredictions';
import { isLatePrediction, scoreXi, totalsOf, type PredictedSlot } from '../services/xiScoring';

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
// The code under test logs a [predictions] line per run; keep the output to the checks.
const realLog = console.log;
const realWarn = console.warn;
console.log = (...args: unknown[]) => (typeof args[0] === 'string' && args[0].startsWith('[predictions]') ? undefined : realLog(...args));
console.warn = (...args: unknown[]) => (typeof args[0] === 'string' && args[0].startsWith('[predictions]') ? undefined : realWarn(...args));
const quiet = <T>(fn: () => Promise<T>): Promise<T> => fn();

// --- Hand-built lineups -----------------------------------------------------------------------

const XI: [string, string][] = [
  ['Keeper One', 'G'],
  ['Right Back', 'RB'],
  ['Centre Left', 'CD-L'],
  ['Centre Right', 'CD-R'],
  ['Left Back', 'LB'],
  ['Pivot Right', 'RM'],
  ['Pivot Left', 'LM'],
  ['Wide Right', 'AM-R'],
  ['Ten Man', 'AM'],
  ['Wide Left', 'AM-L'],
  ['Ben Striker', 'F'],
];
const starters = (xi: [string, string][] = XI): LiveStarter[] => xi.map(([name, role]) => ({ name, role }));
const slots = (xi: [string, string][] = XI): PredictedSlot[] => xi.map(([name, role]) => ({ role, name }));
const withRole = (xi: [string, string][], role: string, name: string): [string, string][] => xi.map(([n, r]) => (r === role ? [name, r] : [n, r]));
const actual = (xi: [string, string][], formation: string | null = '4-2-3-1') => ({ starters: starters(xi), formation });

// --- Scoring ----------------------------------------------------------------------------------

await test('a full hit scores eleven names, eleven slots and the formation', () => {
  assert.deepEqual(scoreXi(slots(), '4-2-3-1', actual(XI)), { namesRight: 11, slotsRight: 11, formationRight: true });
});

await test('swapped full-backs are eleven names right but nine slots right', () => {
  const swapped = XI.map(([n, r]): [string, string] => (r === 'LB' ? ['Right Back', 'LB'] : r === 'RB' ? ['Left Back', 'RB'] : [n, r]));
  assert.deepEqual(scoreXi(slots(), '4-2-3-1', actual(swapped)), { namesRight: 11, slotsRight: 9, formationRight: true });
});

await test('a rotation alternative counts as a name hit when the first choice sat out, never as a slot hit', () => {
  const predicted = slots().map((s) => (s.role === 'F' ? { ...s, rotation: 'Other Striker' } : s));
  const played = actual(withRole(XI, 'F', 'Other Striker'));
  assert.deepEqual(scoreXi(predicted, '4-2-3-1', played), { namesRight: 11, slotsRight: 10, formationRight: true });
  // When the first choice starts, the alternative adds nothing, and nobody counts twice.
  assert.deepEqual(scoreXi(predicted, '4-2-3-1', actual(XI)), { namesRight: 11, slotsRight: 11, formationRight: true });
  const doubled = slots().map((s) => (s.role === 'AM' ? { ...s, rotation: 'Ben Striker' } : s));
  assert.equal(scoreXi(doubled, null, actual(withRole(XI, 'AM', 'Someone Else'))).namesRight, 10);
});

await test('a slot with no predicted player never scores, even with a rotation', () => {
  const predicted: PredictedSlot[] = slots().map((s) => (s.role === 'F' ? { role: 'F', name: null, rotation: 'Ben Striker' } : s));
  assert.deepEqual(scoreXi(predicted, '4-2-3-1', actual(XI)), { namesRight: 10, slotsRight: 10, formationRight: true });
});

await test('a signing the code XI missed but the adjusted XI named scores only for the adjusted one', () => {
  const played = actual(withRole(XI, 'F', 'New Signing'));
  const code = scoreXi(slots(), '4-2-3-1', played);
  const adjusted = scoreXi(slots(withRole(XI, 'F', 'New Signing')), '4-2-3-1', played);
  assert.deepEqual([code.namesRight, code.slotsRight], [10, 10]);
  assert.deepEqual([adjusted.namesRight, adjusted.slotsRight], [11, 11]);
});

await test('names are matched the way the live data matches them: accents, case and formal full names', () => {
  assert.ok(samePlayerName('Gabriel Magalhães', 'Gabriel dos Santos Magalhães'));
  assert.ok(samePlayerName('RAYA', 'David Raya Martín'));
  assert.ok(samePlayerName('Rúben Dias', 'Ruben Dias'));
  assert.ok(!samePlayerName('Gabriel Jesus', 'Gabriel Magalhães'));
  const predicted = slots().map((s) => (s.role === 'CD-L' ? { ...s, name: 'Centre Léft' } : s));
  assert.equal(scoreXi(predicted, '4-2-3-1', actual(XI)).slotsRight, 11);
  const formal = slots(withRole(XI, 'CD-L', 'Gabriel dos Santos Magalhães'));
  assert.equal(scoreXi(formal, '4-2-3-1', actual(withRole(XI, 'CD-L', 'Gabriel Magalhães'))).slotsRight, 11);
});

await test('the formation is unknown, not wrong, when either side has none', () => {
  assert.equal(scoreXi(slots(), null, actual(XI)).formationRight, null);
  assert.equal(scoreXi(slots(), '4-2-3-1', actual(XI, null)).formationRight, null);
  assert.equal(scoreXi(slots(), '4-3-3', actual(XI)).formationRight, false);
  assert.equal(scoreXi(slots(), '4-2-3-1', actual(XI, '4-2-3-1 ')).formationRight, true);
});

await test('a prediction at or after kickoff is late', () => {
  assert.ok(isLatePrediction(Date.parse('2026-11-21T15:00:00Z'), Date.parse('2026-11-21T15:00:00Z')));
  assert.ok(isLatePrediction(Date.parse('2026-11-21T15:30:00Z'), Date.parse('2026-11-21T15:00:00Z')));
  assert.ok(!isLatePrediction(Date.parse('2026-11-20T15:00:00Z'), Date.parse('2026-11-21T15:00:00Z')));
});

await test('totals average the scores and count the formation only where it is known', () => {
  const totals = totalsOf([
    { namesRight: 11, slotsRight: 9, formationRight: true },
    { namesRight: 9, slotsRight: 5, formationRight: false },
    { namesRight: 10, slotsRight: 7, formationRight: null },
  ]);
  assert.deepEqual(totals, { matches: 3, meanNamesRight: 10, meanSlotsRight: 7, formationHitRate: 0.5 });
  assert.deepEqual(totalsOf([]), { matches: 0, meanNamesRight: null, meanSlotsRight: null, formationHitRate: null });
});

// --- The adjusted prediction ------------------------------------------------------------------

const NOW = Date.parse('2026-11-20T12:00:00Z');
const KICKOFF = '2026-11-21T15:00:00.000Z';
const LATER_KICKOFF = '2026-11-24T15:00:00.000Z';

const match = (id: string, date: string, over: Partial<ClubMatch> = {}): ClubMatch => ({
  id,
  date: date.slice(0, 10),
  kickoff: date,
  competition: 'Premier League',
  leagueSlug: 'eng.1',
  home: true,
  opponent: 'Rivals FC',
  completed: false,
  goalsFor: null,
  goalsAgainst: null,
  penaltiesFor: null,
  penaltiesAgainst: null,
  ...over,
});
const played = (id: string, date: string) => match(id, date, { completed: true, goalsFor: 1, goalsAgainst: 0 });
const lineup = (m: ClubMatch, xi: [string, string][] = XI, formation = '4-2-3-1'): LiveLineup => ({ match: m, formation, starters: starters(xi), subsUsed: [] });

const reportFor = (fixtures: ClubMatch[], over: Partial<LiveClubReport> = {}): LiveClubReport => ({
  team: 'Northside',
  league: 'Premier League',
  lineups: [lineup(played('p4', '2026-11-08T15:00:00.000Z')), lineup(played('p3', '2026-11-01T15:00:00.000Z')), lineup(played('p2', '2026-10-25T15:00:00.000Z')), lineup(played('p1', '2026-10-18T15:00:00.000Z'))],
  results: [played('p4', '2026-11-08T15:00:00.000Z')],
  fixtures,
  fplPlayers: null,
  asOf: '2026-11-20',
  ...over,
});

const snapshot = (): ClubSnapshot => ({
  club: 'Northside',
  league: 'Premier League',
  core: deriveClubCore(reportFor([])),
  story: {
    changes: ['A new attacker arrived from abroad in the summer'],
    distinctive: 'A high line and quick wide play',
    newsAbsences: [{ name: 'Wide Left', note: 'out for a month' }],
    unknowns: ['Whether the new attacker is fit'],
  },
  sources: [],
  builtAt: '2026-11-19T09:00:00.000Z',
  version: SNAPSHOT_VERSION,
});

const adjustedWith = (role: string, name: string, reason = 'the attacker who joined in the summer has been starting in training'): AdjustedXiModel => ({
  async adjust(input) {
    return { slots: input.code.slots.map((s) => (s.role === role ? { role: s.role, name, reason } : { role: s.role, name: s.name, reason: '' })) };
  },
});

await test('the adjusted prompt carries the story, the fixture, the absences and how many lineups this season were read', () => {
  const report = reportFor([match('f1', KICKOFF, { opponent: 'Harbour Town', competition: 'Carabao Cup', home: false })]);
  const core = deriveClubCore(report);
  const input: AdjustedXiInput = {
    today: '2026-11-20',
    season: '2026-27',
    club: report.team,
    league: report.league,
    fixture: { opponent: 'Harbour Town', competition: 'Carabao Cup', home: false, kickoff: KICKOFF },
    code: { formation: core.formation, basis: core.xiBasis, matchesRead: core.matchesRead, slots: slots() },
    lineupsThisSeason: 4,
    story: { ...snapshot().story, builtAt: snapshot().builtAt },
    out: [{ name: 'Ten Man', note: 'thigh injury' }],
    outCovered: true,
    form: ['2026-11-08 Premier League: home to Somewhere, W 1-0'],
    record: 'W',
    squad: ['Ben Striker (Forward, 8 league starts)'],
  };
  const prompt = buildAdjustedPrompt(input);
  for (const part of ['Harbour Town', 'Carabao Cup', 'away at', 'A new attacker arrived from abroad', 'A high line and quick wide play', 'Whether the new attacker is fit', 'Ten Man (thigh injury)', 'Wide Left (out for a month)', '4 of them from this season', 'G: Keeper One', 'AM-R: Wide Right', '2026-11-19', 'Today is 2026-11-20']) {
    assert.ok(prompt.includes(part), `prompt lacks "${part}"`);
  }
});

await test('the adjusted answer keeps the code XI for slots it leaves alone and gives a reason for each change', () => {
  const answer = { slots: slots().map((s) => (s.role === 'F' ? { role: 'f', name: 'New Signing', reason: 'joined in the summer and is leading the line' } : { role: s.role, name: s.name?.toUpperCase(), reason: '' })) };
  const adjusted = sanitizeAdjustedXi(answer, slots());
  assert.ok(adjusted);
  assert.equal(adjusted.slots.find((s) => s.role === 'F')?.name, 'New Signing');
  // Same player, other spelling: the code XI's name stays, with no reason.
  assert.deepEqual(adjusted.slots.find((s) => s.role === 'G'), { role: 'G', name: 'Keeper One' });
  assert.equal(adjusted.reasons?.length, 1);
  assert.match(adjusted.reasons![0], /^F: New Signing for Ben Striker\. joined in the summer/);
});

await test('an adjusted answer that misses a role, adds a nameless slot or repeats a player is not used', () => {
  const full = slots().map((s) => ({ role: s.role, name: s.name, reason: '' }));
  assert.equal(sanitizeAdjustedXi({ slots: full.slice(1) }, slots()), null);
  assert.equal(sanitizeAdjustedXi({ slots: full.map((s) => (s.role === 'F' ? { ...s, name: '' } : s)) }, slots()), null);
  assert.equal(sanitizeAdjustedXi({ slots: full.map((s) => (s.role === 'F' ? { ...s, name: 'Ten Man' } : s)) }, slots()), null);
  assert.equal(sanitizeAdjustedXi(null, slots()), null);
});

// --- Sweeps -----------------------------------------------------------------------------------

interface Harness {
  predictions: ReturnType<typeof createXiPredictions>;
  store: ReturnType<typeof memoryXiStore>;
  inputs: AdjustedXiInput[];
  clock: { now: number };
  feed: { report: LiveClubReport; lineups: Record<string, { xi: [string, string][]; formation: string | null }> };
}
function harness(opts: { model?: AdjustedXiModel; snapshots?: ClubSnapshot[]; fixtures?: ClubMatch[]; maxAdjustedPerSweep?: number; adjustTimeoutMs?: number } = {}): Harness {
  const clock = { now: NOW };
  const store = memoryXiStore();
  const inputs: AdjustedXiInput[] = [];
  const base = opts.model ?? adjustedWith('F', 'New Signing');
  const model: AdjustedXiModel = { adjust: (input) => (inputs.push(input), base.adjust(input)) };
  const feed: Harness['feed'] = { report: reportFor(opts.fixtures ?? [match('f1', KICKOFF), match('f2', LATER_KICKOFF)]), lineups: {} };
  const snapshots = opts.snapshots ?? [snapshot()];
  const predictions = createXiPredictions({
    store,
    model,
    now: () => clock.now,
    maxAdjustedPerSweep: opts.maxAdjustedPerSweep,
    adjustTimeoutMs: opts.adjustTimeoutMs,
    listSnapshots: async () => snapshots,
    snapshotFor: async (club) => snapshots.find((s) => s.club.toLowerCase().startsWith(club.toLowerCase())) ?? null,
    get: async <T>(url: string) => {
      const u = new URL(url, 'http://local');
      if (u.pathname === '/api/live/club') {
        return { data: { found: true, team: feed.report.team, league: feed.report.league, text: '', missing: [], report: feed.report } as unknown as T };
      }
      if (u.pathname === '/api/live/match') {
        const played = feed.lineups[u.searchParams.get('match') ?? ''];
        const m = match(u.searchParams.get('match') ?? '', KICKOFF, { completed: true });
        return { data: (played ? { found: true, lineup: lineup(m, played.xi, played.formation ?? undefined) } : { found: false, status: 'pending', reason: 'not finished' }) as unknown as T };
      }
      return { error: 'HTTP 404' };
    },
  });
  return { predictions, store, inputs, clock, feed };
}
const rowsOf = (h: Harness) => h.store.forClub('northside');

await test('a prediction is stored only for fixtures inside the 48-hour window, and once per match', async () => {
  const h = harness();
  const first = await quiet(() => h.predictions.sweep());
  assert.equal(first?.predicted, 1);
  const rows = await rowsOf(h);
  assert.deepEqual(rows.map((r) => r.match_id), ['f1']);
  assert.equal(h.inputs.length, 1);
  const again = await quiet(() => h.predictions.sweep());
  assert.equal(again?.predicted, 0);
  assert.equal(h.inputs.length, 1, 'the model isn\'t called again for a match that has a row');
  // Two days on, the later fixture comes inside the window.
  h.clock.now += 60 * 60 * 60 * 1000;
  h.feed.report = reportFor([match('f2', LATER_KICKOFF)]);
  await quiet(() => h.predictions.sweep());
  assert.deepEqual((await rowsOf(h)).map((r) => r.match_id).sort(), ['f1', 'f2']);
});

await test('a stored row holds both predictions, the club and fixture, the basis and the snapshot it used', async () => {
  const h = harness();
  await quiet(() => h.predictions.sweep());
  const [row] = await rowsOf(h);
  assert.equal(row.club_key, 'northside');
  assert.equal(row.club_name, 'Northside');
  assert.equal(row.kickoff_at, KICKOFF);
  assert.equal(row.opponent, 'Rivals FC');
  assert.equal(row.competition, 'Premier League');
  assert.equal(row.basis, 'lineups');
  assert.equal(row.matches_read, 4);
  assert.equal(row.formation_code, '4-2-3-1');
  assert.equal(row.snapshot_built_at, '2026-11-19T09:00:00.000Z');
  assert.equal(row.snapshot_version, SNAPSHOT_VERSION);
  assert.equal(row.predicted_at, new Date(NOW).toISOString());
  assert.equal(row.predicted_code.slots.find((s) => s.role === 'F')?.name, 'Ben Striker');
  assert.equal(row.adjusted_status, 'ok');
  assert.equal(row.predicted_adjusted?.slots.find((s) => s.role === 'F')?.name, 'New Signing');
  assert.equal(row.predicted_adjusted?.reasons?.length, 1);
  assert.equal(row.scored_at, null);
});

await test('the adjusted call is given the story, the fixture and the lineups read this season', async () => {
  const h = harness();
  await quiet(() => h.predictions.sweep());
  assert.equal(h.inputs.length, 1);
  const [input] = h.inputs;
  assert.deepEqual(input.story.changes, ['A new attacker arrived from abroad in the summer']);
  assert.equal(input.story.builtAt, '2026-11-19T09:00:00.000Z');
  assert.deepEqual(input.fixture, { opponent: 'Rivals FC', competition: 'Premier League', home: true, kickoff: KICKOFF });
  assert.equal(input.lineupsThisSeason, 4);
  assert.equal(input.code.matchesRead, 4);
  assert.equal(input.code.slots.length, 11);
  assert.equal(input.today, '2026-11-20');
  assert.equal(input.season, '2026-27');
});

await test('a failed, slow or unusable adjusted call stores the code prediction alone and marks the adjusted one missing', async () => {
  const cases: [string, AdjustedXiModel][] = [
    ['fails', { adjust: async () => Promise.reject(new Error('model down')) }],
    ['is slow', { adjust: () => new Promise(() => {}) }],
    ['is unusable', { adjust: async () => ({ slots: [] }) }],
  ];
  for (const [label, model] of cases) {
    const h = harness({ model, adjustTimeoutMs: 20 });
    const result = await quiet(() => h.predictions.sweep());
    assert.equal(result?.predicted, 1, label);
    assert.equal(result?.adjustedFailed, 1, label);
    const [row] = await rowsOf(h);
    assert.equal(row.predicted_adjusted, null, label);
    assert.equal(row.adjusted_status, 'failed', label);
    assert.equal(row.formation_adjusted, null, label);
    assert.equal(row.predicted_code.slots.length, 11, label);
  }
});

await test('a club with no XI to predict from gets no row and no model call', async () => {
  const h = harness();
  h.feed.report = reportFor([match('f1', KICKOFF)], { lineups: [], fplPlayers: null });
  const result = await quiet(() => h.predictions.sweep());
  assert.equal(result?.predicted, 0);
  assert.equal(result?.skipped, 1);
  assert.equal(h.inputs.length, 0);
});

await test('only clubs with a stored snapshot are predicted', async () => {
  const h = harness({ snapshots: [] });
  const result = await quiet(() => h.predictions.sweep());
  assert.equal(result?.clubs, 0);
  assert.equal(h.inputs.length, 0);
  assert.equal((await rowsOf(h)).length, 0);
});

await test('a sweep makes at most its model budget of calls, and the next sweep takes the rest', async () => {
  const h = harness({ fixtures: [match('f1', KICKOFF), match('f2', '2026-11-22T12:00:00.000Z')], maxAdjustedPerSweep: 1 });
  const first = await quiet(() => h.predictions.sweep());
  assert.deepEqual([first?.predicted, first?.deferred], [1, 1]);
  const second = await quiet(() => h.predictions.sweep());
  assert.deepEqual([second?.predicted, second?.deferred], [1, 0]);
  assert.equal(h.inputs.length, 2);
});

await test('sweeps never overlap', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = harness({ model: { adjust: async (input) => (await gate, adjustedWith('F', 'New Signing').adjust(input)) } });
  const running = quiet(() => h.predictions.sweep());
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await quiet(() => h.predictions.sweep()), null);
  release();
  assert.equal((await running)?.predicted, 1);
  assert.equal(h.inputs.length, 1);
});

await test('the lazy path predicts for a club somebody asked about, once, and not for a club with no snapshot', async () => {
  const h = harness();
  const first = await quiet(() => h.predictions.lazy('Northside'));
  assert.equal(first?.predicted, 1);
  assert.equal((await rowsOf(h)).length, 1);
  // Asked about again within the cooldown: no new check.
  assert.equal(await quiet(() => h.predictions.lazy('Northside')), null);
  assert.equal(await quiet(() => h.predictions.lazy('Nowhere Rovers')), null);
  assert.equal(h.inputs.length, 1);
});

await test('a lazy run and a sweep at the same time predict a match once', async () => {
  const h = harness();
  await quiet(() => Promise.all([h.predictions.lazy('Northside'), h.predictions.sweep()]));
  assert.equal(h.inputs.length, 1);
  assert.equal((await rowsOf(h)).length, 1);
});

// --- Scoring after the match ------------------------------------------------------------------

await test('after the match both predictions are scored against the published lineup', async () => {
  const h = harness();
  await quiet(() => h.predictions.sweep());
  // The match is finished, and the new signing started up front while the winger sat out.
  h.clock.now = Date.parse('2026-11-21T18:30:00Z');
  h.feed.report = reportFor([]);
  h.feed.lineups.f1 = { xi: withRole(withRole(XI, 'F', 'New Signing'), 'AM-L', 'Young Winger'), formation: '4-3-3' };
  const result = await quiet(() => h.predictions.sweep());
  assert.equal(result?.scored, 1);
  const [row] = await rowsOf(h);
  assert.equal(row.scored_at, new Date(h.clock.now).toISOString());
  assert.equal(row.late, false);
  assert.equal(row.actual?.starters.length, 11);
  assert.equal(row.actual_formation, '4-3-3');
  assert.deepEqual([row.names_right_code, row.slots_right_code, row.formation_right_code], [9, 9, false]);
  assert.deepEqual([row.names_right_adjusted, row.slots_right_adjusted, row.formation_right_adjusted], [10, 10, false]);
  // Scored once: a later sweep reads nothing more.
  assert.equal((await quiet(() => h.predictions.sweep()))?.scored, 0);
});

await test('a match that has not finished, or whose lineup is not out, stays unscored', async () => {
  const h = harness();
  await quiet(() => h.predictions.sweep());
  h.clock.now = Date.parse('2026-11-21T16:00:00Z');
  assert.equal((await quiet(() => h.predictions.sweep()))?.scored, 0, 'two hours have not passed');
  h.clock.now = Date.parse('2026-11-21T18:30:00Z');
  assert.equal((await quiet(() => h.predictions.sweep()))?.scored, 0, 'no lineup yet');
  assert.equal((await rowsOf(h))[0].scored_at, null);
});

const seedRow = (over: Partial<XiPredictionRow>): XiPredictionRow => ({
  club_key: 'northside',
  match_id: 'late1',
  club_name: 'Northside',
  league: 'Premier League',
  kickoff_at: '2026-11-14T15:00:00.000Z',
  opponent: 'Harbour Town',
  competition: 'Premier League',
  home: true,
  predicted_code: { slots: slots() },
  predicted_adjusted: { slots: slots(), reasons: [] },
  adjusted_status: 'ok',
  formation_code: '4-2-3-1',
  formation_adjusted: '4-2-3-1',
  basis: 'lineups',
  matches_read: 4,
  snapshot_built_at: '2026-11-13T09:00:00.000Z',
  snapshot_version: SNAPSHOT_VERSION,
  predicted_at: '2026-11-13T12:00:00.000Z',
  actual: null,
  actual_formation: null,
  scored_at: null,
  late: false,
  names_right_code: null,
  slots_right_code: null,
  formation_right_code: null,
  names_right_adjusted: null,
  slots_right_adjusted: null,
  formation_right_adjusted: null,
  ...over,
});

await test('a prediction made after kickoff is scored but flagged late and left out of the record', async () => {
  const h = harness({ fixtures: [] });
  await h.store.put(seedRow({ match_id: 'late1', predicted_at: '2026-11-14T15:40:00.000Z' }));
  await h.store.put(seedRow({ match_id: 'ontime1', kickoff_at: '2026-11-16T15:00:00.000Z', predicted_at: '2026-11-15T09:00:00.000Z' }));
  h.feed.lineups.late1 = { xi: XI, formation: '4-2-3-1' };
  h.feed.lineups.ontime1 = { xi: withRole(XI, 'F', 'New Signing'), formation: '4-2-3-1' };
  const result = await quiet(() => h.predictions.sweep());
  assert.deepEqual([result?.scored, result?.late], [2, 1]);
  const rows = await rowsOf(h);
  const late = rows.find((r) => r.match_id === 'late1')!;
  assert.equal(late.late, true);
  assert.equal(late.names_right_code, 11);
  const record = await h.predictions.record('Northside');
  assert.deepEqual(record?.scored.map((m) => m.matchId), ['ontime1']);
  assert.equal(record?.lateExcluded, 1);
  assert.equal(record?.totals.code.matches, 1);
});

// --- The record -------------------------------------------------------------------------------

await test('the record lists scored matches newest first, with totals per kind and the pending prediction', async () => {
  const scored = (id: string, kickoff: string, code: [number, number, boolean | null], adjusted: [number, number, boolean | null] | null): XiPredictionRow =>
    seedRow({
      match_id: id,
      kickoff_at: kickoff,
      predicted_adjusted: adjusted ? { slots: slots(), reasons: [] } : null,
      adjusted_status: adjusted ? 'ok' : 'failed',
      actual: { starters: starters() },
      actual_formation: '4-2-3-1',
      scored_at: '2026-12-01T00:00:00.000Z',
      names_right_code: code[0],
      slots_right_code: code[1],
      formation_right_code: code[2],
      names_right_adjusted: adjusted?.[0] ?? null,
      slots_right_adjusted: adjusted?.[1] ?? null,
      formation_right_adjusted: adjusted?.[2] ?? null,
    });
  const rows = [
    scored('m1', '2026-10-01T15:00:00.000Z', [9, 6, true], [10, 8, true]),
    scored('m2', '2026-10-08T15:00:00.000Z', [11, 11, true], [11, 11, true]),
    scored('m3', '2026-10-15T15:00:00.000Z', [8, 4, false], null),
    seedRow({ match_id: 'late', kickoff_at: '2026-10-20T15:00:00.000Z', late: true, scored_at: '2026-12-01T00:00:00.000Z', names_right_code: 11, slots_right_code: 11, formation_right_code: true }),
    seedRow({ match_id: 'next', kickoff_at: '2026-11-21T15:00:00.000Z' }),
    seedRow({ match_id: 'next2', kickoff_at: '2026-11-28T15:00:00.000Z' }),
  ];
  const record = buildClubRecord('Northside', 'northside', rows, NOW);
  assert.deepEqual(record.scored.map((m) => m.matchId), ['m3', 'm2', 'm1']);
  assert.deepEqual(record.totals.code, { matches: 3, meanNamesRight: 9.33, meanSlotsRight: 7, formationHitRate: 0.67 });
  assert.deepEqual(record.totals.adjusted, { matches: 2, meanNamesRight: 10.5, meanSlotsRight: 9.5, formationHitRate: 1 });
  // The fair comparison: both kinds over the two matches that have both.
  assert.equal(record.totals.paired.matches, 2);
  assert.deepEqual([record.totals.paired.code.meanNamesRight, record.totals.paired.adjusted.meanNamesRight], [10, 10.5]);
  assert.equal(record.pending?.matchId, 'next');
  assert.equal(record.lateExcluded, 1);
  assert.equal(record.scored[0].scores.adjusted, null);
  assert.equal(record.pending?.scores.code, null, 'a pending match has no scores yet');
  assert.deepEqual(record.scored[1].scores.code, { namesRight: 11, slotsRight: 11, formationRight: true });
});

await test('the record is read by any name the live data knows, and is cached for a few minutes', async () => {
  const h = harness();
  await quiet(() => h.predictions.sweep());
  const first = await h.predictions.record('Northside FC');
  assert.equal(first?.club, 'Northside');
  assert.equal(first?.pending?.matchId, 'f1');
  await h.store.put(seedRow({ match_id: 'extra', kickoff_at: '2026-11-10T15:00:00.000Z', scored_at: '2026-11-11T00:00:00.000Z', names_right_code: 11, slots_right_code: 11 }));
  assert.equal((await h.predictions.record('Northside'))?.scored.length, 0, 'served from the cache');
  h.clock.now += 6 * 60 * 1000;
  assert.equal((await h.predictions.record('Northside'))?.scored.length, 1);
});

// --- The feed's match lookup ------------------------------------------------------------------

const espnEvent = (id: string, date: string, completed: boolean) => ({
  id,
  date,
  league: { slug: 'eng.1', abbreviation: 'Premier League' },
  seasonType: { name: '2026-27 English Premier League' },
  competitions: [
    {
      status: { type: { completed } },
      competitors: [
        { id: '1', homeAway: 'home', team: { id: '1', displayName: 'Club United' }, ...(completed ? { score: { value: 2 } } : {}) },
        { id: '9', homeAway: 'away', team: { id: '9', displayName: 'Liverpool' }, ...(completed ? { score: { value: 1 } } : {}) },
      ],
    },
  ],
});
const summaryFor = (xi: [string, string][]) => ({
  rosters: [{ team: { id: '1' }, formation: '4-2-3-1', roster: xi.map(([name, role]) => ({ starter: true, athlete: { displayName: name }, position: { abbreviation: role } })) }],
});

await test('a finished match\'s lineup is read from the feed, and a lineup that is not out yet is retried', async () => {
  const requests: string[] = [];
  let published = false;
  const live = createLiveFootball(async (url) => {
    requests.push(url);
    if (url === `${ESPN_SITE}/eng.1/teams`) return { sports: [{ leagues: [{ teams: [{ team: { id: '1', displayName: 'Club United', shortDisplayName: 'Club Utd', abbreviation: 'CLU' } }] }] }] };
    if (url.endsWith('/teams')) return { sports: [{ leagues: [{ teams: [] }] }] };
    if (url === `${ESPN_SITE}/all/teams/1/schedule`) return { events: [espnEvent('done', '2026-11-14T15:00Z', true), espnEvent('next', '2026-11-21T15:00Z', false)] };
    if (url === `${ESPN_SITE}/all/summary?event=done`) return published ? summaryFor(XI) : { rosters: [] };
    if (url === FPL_BOOTSTRAP) return { teams: [], elements: [] };
    throw new Error(`unexpected ${url}`);
  }, () => NOW);
  const pending = await live.matchLineup('Club Utd', 'next');
  assert.deepEqual('status' in pending ? pending.status : null, 'pending');
  assert.equal((await live.matchLineup('Club Utd', 'nope')).found, false);
  assert.equal((await live.matchLineup('Nowhere Rovers', 'done')).found, false);
  const missing = await live.matchLineup('Club Utd', 'done');
  assert.deepEqual('status' in missing ? missing.status : null, 'empty');
  published = true;
  const found = await live.matchLineup('Club Utd', 'done');
  assert.ok(found.found);
  assert.equal(found.lineup.formation, '4-2-3-1');
  assert.equal(found.lineup.starters.length, 11);
  assert.equal(found.lineup.match.opponent, 'Liverpool');
  assert.equal(requests.filter((u) => u.endsWith('summary?event=done')).length, 2, 'the empty answer was not kept');
});

await test('the research toolset\'s in-process routes include the match lookup', async () => {
  const get = inProcessGet({
    live: { matchLineup: async (name: string, id: string) => ({ found: false, status: 'pending', reason: `${name}:${id}` }) },
    history: {},
  } as any);
  assert.deepEqual(await get('/api/live/match?name=Club+Utd&match=e9'), { data: { found: false, status: 'pending', reason: 'Club Utd:e9' } });
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
