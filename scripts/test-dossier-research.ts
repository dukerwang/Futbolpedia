#!/usr/bin/env npx tsx
/**
 * Offline checks for a dossier's research (`services/dossierResearch.ts`), with the tools and the
 * snapshot stores faked: a current card reads the player's live season and the club it names (or
 * his registered club when no season record covers him), works the club's XIs into a first-choice
 * XI with a stored snapshot's story, files a slow lookup as too slow instead of waiting for it, and
 * a past version reads his career record and a requested season's stored era snapshot.
 *
 * Usage:
 *   npx tsx scripts/test-dossier-research.ts
 */
import assert from 'node:assert/strict';
import type { ClubMatch, LiveClubReport, LiveLineup } from '../services/liveFootball';
import {
  formatDossierResearch,
  researchCurrentPlayer,
  researchPastPlayer,
  type DossierResearchDeps,
} from '../services/dossierResearch';
import type { ResearchToolset, ToolOutcome } from '../services/researchTools';
import type { EraSnapshot } from '../services/eraSnapshots';
import type { ClubSnapshot } from '../services/situationSnapshot';

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

const match = (id: string, date: string): ClubMatch => ({
  id,
  date,
  competition: 'LaLiga',
  leagueSlug: 'esp.1',
  home: true,
  opponent: `Opponent ${id}`,
  completed: true,
  goalsFor: 2,
  goalsAgainst: 1,
  penaltiesFor: null,
  penaltiesAgainst: null,
});

const starters = [
  { name: 'Keeper', role: 'G' },
  { name: 'Left Back', role: 'LB' },
  { name: 'Centre Left', role: 'CD-L' },
  { name: 'Centre Right', role: 'CD-R' },
  { name: 'Right Back', role: 'RB' },
  { name: 'Test Player', role: 'DM' },
  { name: 'Eight One', role: 'CM-L' },
  { name: 'Eight Two', role: 'CM-R' },
  { name: 'Left Wing', role: 'LF' },
  { name: 'Nine', role: 'F' },
  { name: 'Right Wing', role: 'RF' },
];

const lineups: LiveLineup[] = ['2026-10-25', '2026-10-18', '2026-10-04'].map((date, i) => ({
  match: match(`m${i}`, date),
  formation: '4-3-3',
  starters,
  subsUsed: [],
}));

const report = (team: string): LiveClubReport => ({
  team,
  league: 'LaLiga',
  lineups,
  results: lineups.map((l) => l.match),
  fixtures: [],
  fplPlayers: null,
  asOf: '2026-11-01',
});

const clubFound = (team: string): ToolOutcome => ({
  status: 'found',
  result: { kind: 'club_context', label: `${team}: recent matches`, content: `${team} recent XIs text.`, stage: 'facts', club: report(team) },
  missing: [{ item: `Injury list for ${team}`, status: 'not_covered' }],
});

const searchFound = (query: string): ToolOutcome => ({
  status: 'found',
  result: { kind: 'web', label: query, content: `- [2026-10-20] Digest for ${query}.`, sources: ['Source (https://example.com)'] },
  missing: [],
});

const notCovered = (note: string): ToolOutcome => ({ status: 'not_covered', result: null, missing: [], note });

interface Recorded {
  playerSeason: string[];
  clubRecentTeam: string[];
  webSearch: string[];
  playerCareer: string[];
}

function fakeTools(overrides: Partial<ResearchToolset> = {}): { tools: ResearchToolset; seen: Recorded } {
  const seen: Recorded = { playerSeason: [], clubRecentTeam: [], webSearch: [], playerCareer: [] };
  const tools: ResearchToolset = {
    async playerSeason(name) {
      seen.playerSeason.push(name);
      return notCovered('not a Premier League player');
    },
    async clubRecentTeam(club) {
      seen.clubRecentTeam.push(club);
      return clubFound(club);
    },
    async webSearch(query) {
      seen.webSearch.push(query);
      return searchFound(query);
    },
    async playerCareer(name) {
      seen.playerCareer.push(name);
      return {
        status: 'found',
        result: { kind: 'career_record', label: 'Test Player (footballer)', content: 'Season by season: 2005-06 Club A 34 apps 5 goals.', stage: 'facts' },
        missing: [],
      };
    },
    leagueTable: async () => notCovered('unused'),
    card: async () => notCovered('unused'),
    clubSeason: async () => notCovered('unused'),
    ...overrides,
  };
  return { tools, seen };
}

const noSnapshots: Pick<DossierResearchDeps, 'clubSnapshots' | 'eraSnapshots'> = {
  clubSnapshots: { stored: async () => null },
  eraSnapshots: { stored: async () => null },
};

// --- Current cards ----------------------------------------------------------------------------

await test("a live season record's club is the club whose live data is read", async () => {
  const { tools, seen } = fakeTools({
    async playerSeason(name) {
      return {
        status: 'found',
        result: { kind: 'player_record', label: `${name} (Northside)`, content: '9 starts, 760 minutes, 2 goals.', stage: 'facts', team: 'Northside' },
        missing: [],
      };
    },
    async clubRecentTeam(club) {
      seen.clubRecentTeam.push(club);
      return clubFound(club);
    },
  });
  const research = await researchCurrentPlayer({
    name: 'Test Player',
    searches: ['query one', 'query two'],
    registeredClub: Promise.resolve('Old Club'),
    deps: { tools, ...noSnapshots },
  });
  assert.deepEqual(seen.clubRecentTeam, ['Northside']);
  assert.deepEqual(seen.webSearch, ['query one', 'query two']);
  assert.deepEqual(research.ledger.entries.map((e) => e.kind), ['player_record', 'club_context', 'web', 'web']);
  assert.equal(research.club, 'Northside');
  assert.match(research.clubSituation, /First-choice XI \(4-3-3, from the last 3 starting XIs\)/);
  assert.match(research.clubSituation, /Test Player/);
});

await test('with no season record, his registered club is read, and what no source covers is filed as such', async () => {
  const { tools, seen } = fakeTools();
  const research = await researchCurrentPlayer({
    name: 'Test Player',
    searches: ['query one'],
    registeredClub: Promise.resolve('Southside'),
    deps: { tools, ...noSnapshots },
  });
  assert.deepEqual(seen.playerSeason, ['Test Player']);
  assert.deepEqual(seen.clubRecentTeam, ['Southside']);
  const text = formatDossierResearch(research, { current: true });
  assert.match(text, /\[CLUB SITUATION/);
  assert.match(text, /\[Not covered\][^]*Season record for Test Player[^]*not a Premier League player/);
  assert.match(text, /Injury list for Southside/);
  assert.ok(text.indexOf('[CLUB SITUATION') < text.indexOf('[E1]'), 'the club situation comes first');
});

await test("a stored club snapshot's story joins the club situation", async () => {
  const { tools } = fakeTools();
  const stored: ClubSnapshot = {
    club: 'Southside',
    league: 'LaLiga',
    core: {} as ClubSnapshot['core'],
    story: { changes: ['A new coach arrived in the summer'], distinctive: 'A back three in possession', newsAbsences: [], unknowns: [] },
    sources: [],
    builtAt: '2026-11-01T08:00:00Z',
    version: 1,
  };
  const research = await researchCurrentPlayer({
    name: 'Test Player',
    searches: [],
    registeredClub: Promise.resolve('Southside'),
    deps: { tools, clubSnapshots: { stored: async () => stored }, eraSnapshots: noSnapshots.eraSnapshots },
  });
  assert.match(research.clubSituation, /Changed since last season: A new coach arrived in the summer/);
  assert.match(research.clubSituation, /Distinctive this season: A back three in possession/);
});

await test('a club lookup still running after the searches is filed as too slow, not waited for', async () => {
  const { tools } = fakeTools({ clubRecentTeam: () => new Promise(() => {}) });
  const start = Date.now();
  const research = await researchCurrentPlayer({
    name: 'Test Player',
    searches: ['query one'],
    registeredClub: Promise.resolve('Southside'),
    deps: { tools, ...noSnapshots },
    graceMs: 50,
  });
  assert.ok(Date.now() - start < 1000);
  assert.equal(research.clubSituation, '');
  assert.ok(research.ledger.gaps.some((g) => g.status === 'failed' && /Southside[^]*too slow/.test(g.label)));
  assert.deepEqual(research.ledger.entries.map((e) => e.kind), ['web']);
});

await test('a player with no season record and no registered club gets no club lookup', async () => {
  const { tools, seen } = fakeTools();
  const research = await researchCurrentPlayer({
    name: 'Test Player',
    searches: ['query one'],
    registeredClub: Promise.resolve(null),
    deps: { tools, ...noSnapshots },
  });
  assert.deepEqual(seen.clubRecentTeam, []);
  assert.equal(research.club, null);
});

// --- Past versions ----------------------------------------------------------------------------

await test("a past version reads his career record, and a requested season reads its stored era snapshot", async () => {
  const { tools, seen } = fakeTools();
  const periods: string[] = [];
  const snapshot: EraSnapshot = {
    key: 'player_window:test-player:2005-06',
    kind: 'player_window',
    subject: 'Test Player',
    period: '2005-06',
    story: { summary: 'His breakthrough season.', setup: 'Deep playmaker.', people: [], record: 'League title.', figures: [], disputed: [] },
    sources: [],
    builtAt: '2026-10-01T00:00:00Z',
    version: 1,
  };
  const research = await researchPastPlayer({
    name: 'Test Player',
    search: 'past query',
    season: '2005-06',
    deps: {
      tools,
      clubSnapshots: noSnapshots.clubSnapshots,
      eraSnapshots: {
        async stored(req) {
          periods.push(req.period);
          return (await req.facts).result ? snapshot : null;
        },
      },
    },
  });
  assert.deepEqual(seen.playerCareer, ['Test Player']);
  assert.deepEqual(seen.webSearch, ['past query']);
  assert.deepEqual(periods, ['2005-06']);
  assert.deepEqual(research.ledger.entries.map((e) => e.kind), ['career_record', 'web', 'era_snapshot']);
  const text = formatDossierResearch(research, { current: false });
  assert.match(text, /Career record \(Wikipedia\)/);
  assert.match(text, /What defined it: His breakthrough season\./);
});

await test('a prime reads no era snapshot: its window is unknown until the card is rated', async () => {
  const { tools } = fakeTools();
  let reads = 0;
  await researchPastPlayer({
    name: 'Test Player',
    search: 'past query',
    deps: { tools, clubSnapshots: noSnapshots.clubSnapshots, eraSnapshots: { stored: async () => (reads++, null) } },
  });
  assert.equal(reads, 0);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
