#!/usr/bin/env npx tsx
/**
 * Offline checks for the situation snapshot and the shared daily club snapshots, with the feeds,
 * the model and Supabase faked: the first-choice XI comes from recent starts (recent matches
 * counting more, injured players never picked, close splits named as rotation), news absences
 * land on the right slot, the store reuses a fresh row, rebuilds a stale one once, never stores a
 * failed build, and a build researches what changed and reads its analysis against the live facts.
 *
 * Usage:
 *   npx tsx scripts/test-situation-snapshot.ts
 */
import assert from 'node:assert/strict';
import type { ClubMatch, FplPlayer, LiveClubReport, LiveLineup } from '../services/liveFootball';
import {
  applyStory,
  isDomesticCup,
  buildSituation,
  buildSituationPrompt,
  deriveClubCore,
  firstChoiceXI,
  formatFactContext,
  formatSituation,
  sanitizeEnrichment,
  type ClubSnapshot,
  type SituationInput,
  type SituationModel,
} from '../services/situationSnapshot';
import {
  buildClubSnapshot,
  createClubSnapshotStore,
  isSnapshotFresh,
  rowToSnapshot,
  SNAPSHOT_REFRESH_MS,
  SNAPSHOT_VERSION,
  snapshotToRow,
  type SnapshotRow,
} from '../services/clubSnapshots';
import { toClubKey } from '../services/clubManagers';
import { addEvidence, emptyLedger } from '../services/evidenceLedger';
import type { ResearchToolset, ToolOutcome } from '../services/researchTools';

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

// --- Fixtures ---------------------------------------------------------------------------------

const match = (id: string, date: string, goalsFor: number, goalsAgainst: number): ClubMatch => ({
  id,
  date,
  competition: 'Premier League',
  leagueSlug: 'eng.1',
  home: true,
  opponent: `Opponent ${id}`,
  completed: true,
  goalsFor,
  goalsAgainst,
  penaltiesFor: null,
  penaltiesAgainst: null,
});

const XI_433 = (lb: string, cdr: string, nine: string) => [
  { name: 'Keeper', role: 'G' },
  { name: lb, role: 'LB' },
  { name: 'Centre Left', role: 'CD-L' },
  { name: cdr, role: 'CD-R' },
  { name: 'Right Back', role: 'RB' },
  { name: 'Anchor', role: 'DM' },
  { name: 'Eight One', role: 'CM-L' },
  { name: 'Eight Two', role: 'CM-R' },
  { name: 'Left Wing', role: 'LF' },
  { name: nine, role: 'F' },
  { name: 'Right Wing', role: 'RF' },
];

// Most recent first. The new left-back started the last two, the old one the two before; the
// regular nine is now injured, and a reserve forward started the third match.
const lineups: LiveLineup[] = [
  { match: match('m4', '2026-10-25', 2, 0), formation: '4-3-3', starters: XI_433('New Fullback', 'Centre Right', 'Main Nine'), subsUsed: ['Old Fullback'] },
  { match: match('m3', '2026-10-18', 1, 1), formation: '4-3-3', starters: XI_433('New Fullback', 'Centre Right', 'Main Nine'), subsUsed: [] },
  { match: match('m2', '2026-10-04', 0, 1), formation: '4-3-3', starters: XI_433('Old Fullback', 'Spare Centre', 'Reserve Forward'), subsUsed: [] },
  { match: match('m1', '2026-09-27', 3, 1), formation: '4-3-3', starters: XI_433('Old Fullback', 'Centre Right', 'Main Nine'), subsUsed: [] },
];

const fpl = (fullName: string, extra: Partial<FplPlayer> = {}): FplPlayer => ({
  id: fullName.length,
  fullName,
  webName: fullName.split(' ').pop()!,
  teamId: 1,
  team: 'Northside',
  position: 'Midfielder',
  status: 'a',
  news: '',
  chance: null,
  minutes: 600,
  starts: 7,
  goals: 0,
  assists: 0,
  cleanSheets: 0,
  xg: null,
  xa: null,
  ...extra,
});

const report = (overrides: Partial<LiveClubReport> = {}): LiveClubReport => ({
  team: 'Northside',
  league: 'Premier League',
  lineups,
  results: lineups.map((l) => l.match),
  fixtures: [{ ...match('n1', '2026-11-08', 0, 0), completed: false, goalsFor: null, goalsAgainst: null, home: false }],
  fplPlayers: [
    fpl('Main Nine', { status: 'i', chance: 0, news: 'Hamstring injury - Expected back 29 Nov', position: 'Forward' }),
    fpl('Anchor', { status: 'd', chance: 75, news: 'Knock - 75% chance of playing' }),
    fpl('Keeper', { position: 'Goalkeeper' }),
  ],
  asOf: '2026-11-01',
  ...overrides,
});

// --- The core ---------------------------------------------------------------------------------

await test('the first-choice XI follows recent starts, skips the injured and names close splits as rotation', () => {
  const { xi, formation, basis } = firstChoiceXI(report());
  assert.equal(formation, '4-3-3');
  assert.equal(basis, 'lineups');
  const at = (role: string) => xi.find((s) => s.role === role)!;
  // Two starts each, but the new left-back's are the recent ones.
  assert.equal(at('LB').name, 'New Fullback');
  assert.equal(at('LB').rotation, 'Old Fullback');
  // Three starts to one is no split.
  assert.equal(at('CD-R').name, 'Centre Right');
  assert.equal(at('CD-R').rotation, undefined);
  // The injured nine is out; the reserve who has started there fills the slot, and the note says why.
  assert.equal(at('F').name, 'Reserve Forward');
  assert.match(at('F').note ?? '', /Main Nine, who started here last, is out/);
  assert.match(at('DM').note ?? '', /doubtful: Knock - 75% chance of playing/);
  assert.deepEqual(xi.map((s) => s.role), ['G', 'LB', 'CD-L', 'CD-R', 'RB', 'DM', 'CM-L', 'CM-R', 'LF', 'F', 'RF']);
});

await test('domestic cups are told apart from league and European matches', () => {
  for (const c of ['Carabao Cup (Fourth Round)', 'Copa del Rey', 'Coppa Italia', 'DFB Pokal', 'Coupe de France', 'FA Cup']) assert.equal(isDomesticCup(c), true, c);
  for (const c of ['Premier League', 'UEFA Champions League (League Phase)', 'UEFA Europa League', 'LALIGA']) assert.equal(isDomesticCup(c), false, c);
});

await test('a rotated cup XI counts half and never makes a slot read as shared', () => {
  const cup = { ...match('c1', '2026-10-28', 1, 0), competition: 'Carabao Cup (Fourth Round)' };
  const withCup: LiveLineup[] = [
    { match: cup, formation: '4-3-3', starters: XI_433('Cup Fullback', 'Cup Centre', 'Cup Nine'), subsUsed: [] },
    ...lineups.slice(0, 2),
  ];
  const { xi } = firstChoiceXI(report({ lineups: withCup, fplPlayers: null }));
  const at = (role: string) => xi.find((s) => s.role === role)!;
  assert.equal(at('LB').name, 'New Fullback');
  assert.equal(at('LB').rotation, undefined);
  assert.equal(at('F').name, 'Main Nine');
  assert.equal(at('F').rotation, undefined);
});

await test('with no lineups, a Premier League XI comes from season starts, and with nothing at all it is unknown', () => {
  const fromStarts = firstChoiceXI(
    report({
      lineups: [],
      fplPlayers: [
        fpl('Gloves', { position: 'Goalkeeper', starts: 9 }),
        ...Array.from({ length: 12 }, (_, i) => fpl(`Outfield ${i}`, { starts: 12 - i, position: i < 4 ? 'Defender' : 'Midfielder' })),
        fpl('Crocked', { starts: 20, status: 'i', chance: 0 }),
      ],
    }),
  );
  assert.equal(fromStarts.basis, 'season_starts');
  assert.equal(fromStarts.xi.length, 11);
  assert.equal(fromStarts.xi[0].name, 'Gloves');
  assert.ok(!fromStarts.xi.some((s) => s.name === 'Crocked' || s.name === 'Outfield 11'));
  assert.deepEqual(firstChoiceXI(report({ lineups: [], fplPlayers: null })), { xi: [], formation: null, basis: 'none' });
});

await test('the core carries form, absences from the injury list and the next fixture', () => {
  const core = deriveClubCore(report());
  assert.equal(core.record, 'WDLW');
  assert.equal(core.form[0], '2026-10-25 Premier League: home to Opponent m4, W 2-0');
  assert.equal(core.outCovered, true);
  assert.deepEqual(core.out.map((o) => o.name), ['Main Nine', 'Anchor']);
  assert.match(core.nextFixture ?? '', /^2026-11-08 Premier League: away at Opponent n1$/);
  assert.equal(core.matchesRead, 4);
});

await test('a story lays over the core; news absences only count where no injury list does, and land on the slot', () => {
  const uncovered = deriveClubCore(report({ fplPlayers: null }));
  const story = {
    changes: ['A new left-back signed in August'],
    distinctive: 'The full-backs invert more than last season.',
    newsAbsences: [{ name: 'Eight One', note: 'knee, out until December (report 2026-10-28)' }],
    unknowns: ['How long the knee injury lasts'],
  };
  const merged = applyStory(uncovered, story);
  assert.match(merged.xi.find((s) => s.role === 'CM-L')!.note ?? '', /news reports him out: knee/);
  assert.deepEqual(merged.newsAbsences?.map((a) => a.name), ['Eight One']);
  // A club the injury list covers ignores news absences.
  assert.deepEqual(applyStory(deriveClubCore(report()), story).newsAbsences, []);
});

await test('the snapshot reads as one dated block the writer can argue from', () => {
  const club = applyStory(deriveClubCore(report()), {
    changes: ['A new left-back signed in August'],
    distinctive: 'The full-backs invert more than last season.',
    newsAbsences: [],
    unknowns: ['Who takes set pieces'],
  });
  const text = formatSituation({ asOf: '2026-11-01', clubs: [club], players: [], unknowns: [] });
  assert.match(text, /^<situation_snapshot>\nThe present as of 2026-11-01/);
  assert.match(text, /First-choice XI \(4-3-3, from the last 4 starting XIs\): G Keeper \(4\/4\) \| LB New Fullback \(2\/4, rotates with Old Fullback\)/);
  assert.match(text, /Out or doubtful \(injury list\): Main Nine \(Hamstring injury - Expected back 29 Nov\); Anchor/);
  assert.match(text, /Form, most recent first \(WDLW\)/);
  assert.match(text, /Changed since last season: A new left-back signed in August/);
  assert.match(text, /Distinctive this season: The full-backs invert/);
  assert.match(text, /Still unknown: Who takes set pieces/);
  assert.match(formatSituation({ asOf: '2026-11-01', clubs: [deriveClubCore(report({ fplPlayers: null }))], players: [], unknowns: [] }), /Out: no injury list covers this club/);
  assert.equal(formatSituation({ asOf: '2026-11-01', clubs: [], players: [], unknowns: [] }), '');
  assert.equal(formatSituation(null), '');
});

await test('fact context for analysis searches names the regulars, who is out and recent results', () => {
  assert.equal(
    formatFactContext([deriveClubCore(report())], ['A player line.']),
    'Northside, as of 2026-11-01: regular starters Keeper, New Fullback, Centre Left, Centre Right, Right Back, Anchor, Eight One, Eight Two, Left Wing, Reserve Forward, Right Wing (4-3-3); out: Main Nine, Anchor; last results WDLW.\nA player line.',
  );
});

await test("the model's answer is cleaned before it's used", () => {
  const clean = sanitizeEnrichment({
    clubs: [{ club: ' Northside ', changes: ['a', '', 7, 'b'], distinctive: ' x ', newsAbsences: [{ name: '' }, { name: 'P' }], unknowns: null }, { club: '' }],
    players: [{ name: 'Q', club: 'C' }],
    unknowns: 'nope',
  });
  assert.deepEqual(clean, {
    clubs: [{ club: 'Northside', changes: ['a', 'b'], distinctive: 'x', newsAbsences: [{ name: 'P', note: 'reported out' }], unknowns: [] }],
    players: [{ name: 'Q', club: 'C', role: '', form: '', status: '', changes: '' }],
    unknowns: [],
  });
  assert.deepEqual(sanitizeEnrichment(null), { clubs: [], players: [], unknowns: [] });
});

await test('the situation call fills clubs with no stored story and the players asked about, and is skipped when nothing needs it', async () => {
  const ledger = addEvidence(emptyLedger(), { kind: 'club_context', label: 'Northside', content: 'XIs', club: report() });
  const inputs: SituationInput[] = [];
  const model: SituationModel = {
    enrich: async (input) => {
      inputs.push(input);
      return {
        clubs: [{ club: 'Northside', changes: ['New coach'], distinctive: 'Higher press.', newsAbsences: [], unknowns: [] }],
        players: [{ name: 'Someone', club: 'Northside', role: 'left winger', form: 'three goals in four', status: 'fit', changes: 'moved wide' }],
        unknowns: ['Set-piece taker'],
      };
    },
  };
  const base = { ledger, players: ['Someone'], question: 'How do they play?', focus: 'What changed', today: '2026-11-01', season: '2026-27', seasonStart: '2026-07-01', model };
  const { situation, usedModel } = await buildSituation({ ...base, stored: [], allowModel: true });
  assert.equal(usedModel, true);
  assert.deepEqual(inputs[0].clubs.map((c) => c.club), ['Northside']);
  assert.deepEqual(inputs[0].players, ['Someone']);
  assert.equal(situation.clubs[0].distinctive, 'Higher press.');
  assert.equal(situation.players[0].role, 'left winger');
  assert.deepEqual(situation.unknowns, ['Set-piece taker']);

  const stored: ClubSnapshot = {
    club: 'Northside',
    league: 'Premier League',
    core: deriveClubCore(report()),
    story: { changes: ['Stored change'], distinctive: 'Stored story.', newsAbsences: [], unknowns: [] },
    sources: [],
    builtAt: '2026-11-01T06:00:00Z',
    version: SNAPSHOT_VERSION,
  };
  const noCall: SituationModel = { enrich: async () => assert.fail('nothing needs the call') };
  const fromStore = await buildSituation({ ...base, players: [], stored: [stored], allowModel: true, model: noCall });
  assert.equal(fromStore.usedModel, false);
  assert.equal(fromStore.situation.clubs[0].distinctive, 'Stored story.');
  const codeOnly = await buildSituation({ ...base, stored: [], allowModel: false, model: noCall });
  assert.equal(codeOnly.situation.clubs[0].distinctive, undefined);
  assert.equal(codeOnly.situation.clubs[0].xi.length, 11);
});

await test('the situation prompt is descriptive: it carries the evidence and the cores, and no example names', () => {
  const prompt = buildSituationPrompt({
    today: '2026-11-01',
    season: '2026-27',
    focus: 'What is new this season',
    question: 'How do they play?',
    clubs: [deriveClubCore(report())],
    players: [],
    evidence: '[E1] evidence text',
  });
  assert.match(prompt, /Today is 2026-11-01, in the 2026-27 season/);
  assert.match(prompt, /Club: Northside\nFirst-choice XI: G Keeper, LB New Fullback/);
  assert.match(prompt, /\[E1\] evidence text/);
  assert.match(prompt, /return an empty players list/);
  // The only names in the prompt are the ones the evidence brought.
  const withoutInputs = prompt.replace(/Club: Northside[\s\S]*?Record, most recent first: WDLW/, '').replace('[E1] evidence text', '');
  assert.doesNotMatch(withoutInputs, /Northside|Keeper|Fullback/);
});

// --- The shared store -------------------------------------------------------------------------

const NOW = Date.parse('2026-11-01T12:00:00Z');
const snapshot = (club: string, builtAt = new Date(NOW - 60 * 60 * 1000).toISOString()): ClubSnapshot => ({
  club,
  league: 'Premier League',
  core: deriveClubCore(report({ team: club })),
  story: { changes: ['x'], distinctive: 'y', newsAbsences: [], unknowns: [] },
  sources: ['Source (https://example.com)'],
  builtAt,
  version: SNAPSHOT_VERSION,
});
const liveOutcome = (team: string): Promise<ToolOutcome> =>
  Promise.resolve({ status: 'found', result: { kind: 'club_context', label: team, content: 'XIs', club: report({ team }) }, missing: [] });

const fakeStore = (rows: Record<string, SnapshotRow>, built: (club: string) => ClubSnapshot | null, now = () => NOW) => {
  const log = { reads: [] as string[], writes: [] as SnapshotRow[], builds: [] as string[] };
  const store = createClubSnapshotStore({
    read: async (key) => {
      log.reads.push(key);
      return rows[key] ?? null;
    },
    write: async (row) => {
      log.writes.push(row);
      rows[row.club_key] = row;
    },
    build: async (club) => {
      log.builds.push(club);
      await new Promise((r) => setTimeout(r, 5));
      return built(club);
    },
    now,
  });
  return { store, log };
};

await test('a row round-trips, and freshness needs this version and less than a day', () => {
  const s = snapshot('Northside');
  assert.deepEqual(rowToSnapshot(snapshotToRow(s)), s);
  assert.equal(snapshotToRow(s).club_key, toClubKey('Northside'));
  assert.equal(isSnapshotFresh(NOW - SNAPSHOT_REFRESH_MS + 1000, SNAPSHOT_VERSION, NOW), true);
  assert.equal(isSnapshotFresh(NOW - SNAPSHOT_REFRESH_MS - 1000, SNAPSHOT_VERSION, NOW), false);
  assert.equal(isSnapshotFresh(NOW, SNAPSHOT_VERSION + 1, NOW), false);
  assert.equal(rowToSnapshot({ ...snapshotToRow(s), snapshot: {} as any }), null);
});

await test("a fresh row is served without building, found under the live data's name when the typed one misses", async () => {
  const rows = { [toClubKey('Northside Athletic')]: snapshotToRow(snapshot('Northside Athletic')) };
  const { store, log } = fakeStore(rows, () => assert.fail('no build'));
  const hit = await store.get('Northside', liveOutcome('Northside Athletic'));
  assert.equal(hit?.club, 'Northside Athletic');
  assert.deepEqual(log.reads, [toClubKey('Northside'), toClubKey('Northside Athletic')]);
  // The second ask comes from memory.
  await store.get('Northside Athletic', liveOutcome('Northside Athletic'));
  assert.equal(log.reads.length, 2);
});

await test('a stale or old-version row is rebuilt once, however many turns ask at the same time, and stored for everyone', async () => {
  const stale = snapshotToRow(snapshot('Northside', new Date(NOW - 2 * SNAPSHOT_REFRESH_MS).toISOString()));
  const { store, log } = fakeStore({ [toClubKey('Northside')]: stale }, (club) => snapshot(club, new Date(NOW).toISOString()));
  assert.equal(await store.stored('Northside', liveOutcome('Northside')), null);
  const [a, b] = await Promise.all([store.get('Northside', liveOutcome('Northside')), store.get('Northside', liveOutcome('Northside'))]);
  assert.equal(a?.builtAt, new Date(NOW).toISOString());
  assert.equal(a, b);
  assert.deepEqual(log.builds, ['Northside']);
  assert.equal(log.writes.length, 1);
  assert.equal(log.writes[0].built_at, new Date(NOW).toISOString());

  const oldVersion = { ...snapshotToRow(snapshot('Westside')), version: SNAPSHOT_VERSION - 1 };
  const second = fakeStore({ [toClubKey('Westside')]: oldVersion }, (club) => snapshot(club));
  await second.store.get('Westside', liveOutcome('Westside'));
  assert.deepEqual(second.log.builds, ['Westside']);
});

await test('a failed build is never stored, and is retried after a few minutes rather than straight away', async () => {
  let clock = NOW;
  let result: ClubSnapshot | null = null;
  const { store, log } = fakeStore({}, () => result, () => clock);
  assert.equal(await store.get('Northside', liveOutcome('Northside')), null);
  assert.equal(await store.get('Northside', liveOutcome('Northside')), null);
  assert.equal(log.builds.length, 1);
  assert.equal(log.writes.length, 0);
  clock += 11 * 60 * 1000;
  result = snapshot('Northside');
  assert.equal((await store.get('Northside', liveOutcome('Northside')))?.club, 'Northside');
  assert.equal(log.builds.length, 2);
  assert.equal(log.writes.length, 1);
});

await test('a build researches what changed, reads its analysis against the live facts, and adds team news where no injury list exists', async () => {
  const asked: { query: string; context?: string }[] = [];
  const tools: ResearchToolset = {
    clubRecentTeam: async () => assert.fail('the build reuses the live lookup'),
    playerSeason: async () => assert.fail('unused'),
    leagueTable: async () => assert.fail('unused'),
    card: async () => assert.fail('unused'),
    webSearch: async (query, options) => {
      asked.push({ query, context: options?.context });
      return { status: 'found', result: { kind: 'web', label: query, content: `[2026-10-20] Digest for ${query}`, sources: [`S (https://example.com/${asked.length})`] }, missing: [] };
    },
  };
  const inputs: SituationInput[] = [];
  const model: SituationModel = {
    enrich: async (input) => {
      inputs.push(input);
      return { clubs: [{ club: 'Southside', changes: ['New coach in June'], distinctive: 'Plays a back three now.', newsAbsences: [{ name: 'Eight Two', note: 'ankle (2026-10-29)' }], unknowns: [] }], players: [], unknowns: [] };
    },
  };
  const live = await liveOutcome('Southside');
  const uncovered: ToolOutcome = { ...live, result: { ...live.result!, club: report({ team: 'Southside', league: 'LaLiga', fplPlayers: null }) } };
  const built = await buildClubSnapshot('Southside', uncovered, tools, model, () => NOW);
  assert.ok(built);
  assert.equal(asked.length, 3);
  assert.match(asked[0].query, /^Southside transfers in and out and coaching changes since last season, 2026-27$/);
  assert.equal(asked[0].context, undefined);
  assert.match(asked[1].query, /^Southside tactical analysis 2026-27/);
  assert.match(asked[1].context ?? '', /^Southside, as of 2026-11-01: regular starters/);
  assert.match(asked[2].query, /^Southside team news, injuries and suspensions, November 2026$/);
  assert.match(inputs[0].evidence, /\[E1\] Live club data/);
  assert.match(inputs[0].evidence, /Digest for Southside tactical analysis/);
  assert.equal(built.story.distinctive, 'Plays a back three now.');
  assert.deepEqual(built.story.newsAbsences, [{ name: 'Eight Two', note: 'ankle (2026-10-29)' }]);
  assert.equal(built.builtAt, new Date(NOW).toISOString());
  assert.equal(built.sources.length, 3);

  // A Premier League club has an injury list, so no team-news search; no report means no build.
  asked.length = 0;
  await buildClubSnapshot('Northside', await liveOutcome('Northside'), tools, model, () => NOW);
  assert.equal(asked.length, 2);
  assert.equal(await buildClubSnapshot('Nowhere', { status: 'failed', result: null, missing: [] }, tools, model), null);
  const failing: SituationModel = { enrich: async () => Promise.reject(new Error('model down')) };
  assert.equal(await buildClubSnapshot('Northside', await liveOutcome('Northside'), tools, failing, () => NOW), null);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
