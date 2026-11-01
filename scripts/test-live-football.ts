#!/usr/bin/env npx tsx
/**
 * Offline checks for live football data (ESPN match data and the Fantasy Premier League feed),
 * with the feeds faked: club names resolve across leagues and nicknames, schedules drop friendlies
 * and read shootouts, lineups print back to front, FPL names and injuries line up with ESPN's, and
 * a club lookup reports what it couldn't get instead of failing.
 *
 * Usage:
 *   npx tsx scripts/test-live-football.ts
 */
import assert from 'node:assert/strict';
import {
  createLiveFootball,
  ESPN_SITE,
  ESPN_STANDINGS,
  findClub,
  findFplPlayer,
  findFplTeam,
  findLeague,
  formatLiveXI,
  FPL_BOOTSTRAP,
  parseClubSchedule,
  parseEspnTeams,
  parseFpl,
  parseMatchLineup,
} from '../services/liveFootball';
import { runCalls, type ResearchToolset } from '../services/researchTools';
import { emptyLedger } from '../services/evidenceLedger';

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

// --- Fixtures shaped like the feeds -------------------------------------------------------------

const teamsJson = (teams: { id: string; displayName: string; shortDisplayName?: string; abbreviation?: string }[]) => ({
  sports: [{ leagues: [{ teams: teams.map((team) => ({ team: { name: team.displayName, location: team.displayName, ...team } })) }] }],
});

const LEAGUE_TEAMS: Record<string, ReturnType<typeof teamsJson>> = {
  'eng.1': teamsJson([
    { id: '1', displayName: 'Club United', shortDisplayName: 'Club Utd', abbreviation: 'CLU' },
    { id: '2', displayName: 'Manchester United', shortDisplayName: 'Man United', abbreviation: 'MAN' },
    { id: '3', displayName: 'Tottenham Hotspur', shortDisplayName: 'Spurs', abbreviation: 'TOT' },
    { id: '4', displayName: 'Nottingham Forest', shortDisplayName: 'Nottm Forest', abbreviation: 'NFO' },
  ]),
  'ita.1': teamsJson([{ id: '10', displayName: 'Internazionale', abbreviation: 'INT' }]),
  'fra.1': teamsJson([{ id: '11', displayName: 'Paris Saint-Germain', abbreviation: 'PSG' }]),
  'usa.1': teamsJson([{ id: '12', displayName: 'Inter Miami CF', abbreviation: 'MIA' }]),
  'arg.1': teamsJson([{ id: '13', displayName: 'Club United de Sur', abbreviation: 'CUS' }]),
  'esp.1': teamsJson([{ id: '20', displayName: 'Rivals FC', abbreviation: 'RIV' }]),
};

const competitor = (id: string, name: string, homeAway: string, score?: number, shootout?: number) => ({
  id,
  homeAway,
  team: { id, displayName: name },
  ...(score !== undefined ? { score: { value: score, displayValue: String(score), ...(shootout !== undefined ? { shootoutScore: shootout } : {}) } } : {}),
});

const event = (
  id: string,
  date: string,
  slug: string,
  league: string,
  stage: string,
  us: ReturnType<typeof competitor>,
  them: ReturnType<typeof competitor>,
  completed = true,
) => ({
  id,
  date: `${date}T15:00Z`,
  league: { slug, abbreviation: league },
  seasonType: { name: stage },
  competitions: [{ status: { type: { completed } }, competitors: [us, them] }],
});

const schedule = {
  events: [
    event('e1', '2026-10-05', 'eng.1', 'Premier League', '2026-27 English Premier League', competitor('1', 'Club United', 'home', 2), competitor('5', 'Leeds United', 'away', 1)),
    event('e2', '2026-10-12', 'eng.league_cup', 'Carabao Cup', 'Fourth Round', competitor('1', 'Club United', 'away', 1, 3), competitor('6', 'Fleetwood Town', 'home', 1, 5)),
    event('e0', '2026-07-30', 'club.friendly', 'Club Friendly', '2026 Club Friendly', competitor('1', 'Club United', 'home', 4), competitor('7', 'Tourists', 'away', 0)),
    event('e3', '2026-10-19', 'eng.1', 'Premier League', '2026-27 English Premier League', competitor('1', 'Club United', 'away', 0), competitor('8', 'Everton', 'home', 0)),
  ],
};
const fixtures = {
  events: [event('f1', '2026-11-02', 'eng.1', 'Premier League', '2026-27 English Premier League', competitor('1', 'Club United', 'away'), competitor('9', 'Liverpool', 'home'), false)],
};

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
const summary = (xi: [string, string][], subs: string[] = []) => ({
  rosters: [
    { team: { id: '5' }, formation: '4-4-2', roster: [] },
    {
      team: { id: '1' },
      formation: '4-2-3-1',
      roster: [
        ...xi.map(([name, role]) => ({ starter: true, athlete: { displayName: name }, position: { abbreviation: role } })),
        ...subs.map((name) => ({ starter: false, subbedIn: true, athlete: { displayName: name }, position: { abbreviation: 'SUB' } })),
        { starter: false, subbedIn: false, athlete: { displayName: 'Unused Sub' }, position: { abbreviation: 'SUB' } },
      ],
    },
  ],
});

const fplJson = {
  teams: [
    { id: 1, name: 'Club Utd' },
    { id: 2, name: 'Man Utd' },
    { id: 3, name: "Nott'm Forest" },
  ],
  elements: [
    { id: 1, first_name: 'Benjamin', second_name: 'Striker', web_name: 'Striker', team: 1, element_type: 4, status: 'a', news: '', minutes: 700, starts: 8, goals_scored: 6, assists: 1 },
    { id: 2, first_name: 'Ten', second_name: 'Man', web_name: 'Man', team: 1, element_type: 3, status: 'i', news: 'Thigh injury - Unknown return date', minutes: 500, starts: 6, goals_scored: 2, assists: 3 },
    { id: 3, first_name: 'Gabriel', second_name: 'dos Santos Magalhães', web_name: 'Gabriel', team: 1, element_type: 2, status: 'd', news: 'Hip injury - 75% chance of playing', chance_of_playing_next_round: 75, minutes: 720, starts: 8, goals_scored: 1, assists: 0, clean_sheets: 5 },
    { id: 4, first_name: 'Gone', second_name: 'Away', web_name: 'Away', team: 1, element_type: 3, status: 'u', news: 'Joined another club on loan', minutes: 0, starts: 0 },
    { id: 5, first_name: 'Gabriel', second_name: 'Other', web_name: 'G.Other', team: 2, element_type: 4, status: 'a', news: '', minutes: 90, starts: 1 },
  ],
};

const fakeFeeds = (overrides: Record<string, unknown> = {}, log: string[] = []) => async (url: string) => {
  log.push(url);
  if (url in overrides) {
    const v = overrides[url];
    if (v instanceof Error) throw v;
    return v;
  }
  for (const [slug, json] of Object.entries(LEAGUE_TEAMS)) if (url === `${ESPN_SITE}/${slug}/teams`) return json;
  if (url.endsWith('/teams')) return teamsJson([]);
  if (url === `${ESPN_SITE}/all/teams/1/schedule`) return schedule;
  if (url === `${ESPN_SITE}/all/teams/1/schedule?fixture=true`) return fixtures;
  if (url === `${ESPN_SITE}/all/summary?event=e3`) return summary(XI, ['Gabriel Magalhães']);
  if (url === `${ESPN_SITE}/all/summary?event=e1`) return summary(XI);
  if (url === `${ESPN_SITE}/all/summary?event=e2`) return { rosters: [] };
  if (url === FPL_BOOTSTRAP) return fplJson;
  if (url === `${ESPN_SITE}/all/summary?event=r1`) {
    const ours = summary(XI).rosters[1];
    return { rosters: [{ ...ours, team: { id: '20' } }] };
  }
  if (url === `${ESPN_SITE}/all/teams/20/schedule`) return { events: [event('r1', '2026-10-20', 'esp.1', 'LALIGA', '2026-27 LALIGA', competitor('20', 'Rivals FC', 'home', 3), competitor('21', 'Other', 'away', 0))] };
  if (url === `${ESPN_STANDINGS}/eng.1/standings`) {
    return {
      season: { displayName: '2026-27 English Premier League' },
      children: [
        {
          name: 'Premier League',
          standings: {
            entries: [
              { team: { displayName: 'Club United' }, stats: [{ name: 'rank', value: 1 }, { name: 'points', value: 21 }, { name: 'gamesPlayed', value: 8 }, { name: 'wins', value: 7 }, { name: 'ties', value: 0 }, { name: 'losses', value: 1 }, { name: 'pointDifferential', value: 8 }] },
            ],
          },
        },
      ],
    };
  }
  throw new Error(`unexpected ${url}`);
};

const allTeams = Object.entries(LEAGUE_TEAMS).flatMap(([slug, json]) => parseEspnTeams(json, slug));

// --- Tests ----------------------------------------------------------------------------------------

await test('club names resolve through nicknames, short forms and league priority', () => {
  assert.equal(findClub('Man Utd', allTeams)?.name, 'Manchester United');
  assert.equal(findClub('Spurs', allTeams)?.name, 'Tottenham Hotspur');
  assert.equal(findClub("Nott'm Forest", allTeams)?.name, 'Nottingham Forest');
  assert.equal(findClub('PSG', allTeams)?.name, 'Paris Saint-Germain');
  assert.equal(findClub('Inter', allTeams)?.name, 'Internazionale');
  assert.equal(findClub('Inter Miami', allTeams)?.name, 'Inter Miami CF');
  // An exact name wins, and a shared one goes to the higher-priority league.
  assert.equal(findClub('Club United', allTeams)?.league, 'eng.1');
  assert.equal(findClub('Nowhere Rovers', allTeams), null);
});

await test('a schedule drops friendlies, keeps cups and reads shootouts', () => {
  const matches = parseClubSchedule(schedule, '1');
  assert.deepEqual(matches.map((m) => m.id), ['e1', 'e2', 'e3']);
  const cup = matches[1];
  assert.equal(cup.competition, 'Carabao Cup (Fourth Round)');
  assert.equal(cup.home, false);
  assert.deepEqual([cup.goalsFor, cup.goalsAgainst, cup.penaltiesFor, cup.penaltiesAgainst], [1, 1, 3, 5]);
  assert.equal(matches[0].competition, 'Premier League');
});

await test('a lineup prints back to front, left to right, with its subs', () => {
  const match = parseClubSchedule(schedule, '1')[2];
  const lineup = parseMatchLineup(summary(XI, ['Gabriel Magalhães']), '1', match);
  assert.ok(lineup);
  assert.equal(lineup.formation, '4-2-3-1');
  assert.deepEqual(lineup.subsUsed, ['Gabriel Magalhães']);
  assert.equal(
    formatLiveXI(lineup.starters),
    'Keeper One (GK) | Left Back (LB), Centre Left (CD-L), Centre Right (CD-R), Right Back (RB) | Pivot Left (LM), Pivot Right (RM) | Wide Left (AM-L), Ten Man (AM), Wide Right (AM-R) | Ben Striker (F)',
  );
  assert.equal(parseMatchLineup({ rosters: [] }, '1', match), null);
});

await test('FPL teams and players match by name, preferring the one who plays more', () => {
  const fpl = parseFpl(fplJson)!;
  const byName = (name: string) => allTeams.find((t) => t.name === name)!;
  assert.equal(findFplTeam(byName('Manchester United'), fpl)?.name, 'Man Utd');
  assert.equal(findFplTeam(byName('Nottingham Forest'), fpl)?.name, "Nott'm Forest");
  assert.equal(findFplTeam(byName('Club United'), fpl)?.name, 'Club Utd');
  assert.equal(findFplPlayer('Gabriel Magalhães', fpl)?.id, 3);
  assert.equal(findFplPlayer('Gabriel', fpl)?.id, 3);
  assert.equal(findFplPlayer('Lionel Nobody', fpl), null);
});

await test('leagues resolve by name, with the country splitting shared names', () => {
  assert.equal(findLeague('Premier League')?.slug, 'eng.1');
  assert.equal(findLeague('La Liga')?.slug, 'esp.1');
  assert.equal(findLeague('Serie A')?.slug, 'ita.1');
  assert.equal(findLeague('Serie A', 'Brazil')?.slug, 'bra.1');
  assert.equal(findLeague('Champions League')?.slug, 'uefa.champions');
  assert.equal(findLeague('Sunday League'), null);
});

await test('a Premier League club report has results, XIs, season usage, injuries and fixtures', async () => {
  const live = createLiveFootball(fakeFeeds(), () => Date.parse('2026-11-01T12:00:00Z'));
  const result = await live.club('Club Utd');
  assert.ok(result.found);
  assert.deepEqual(result.missing, []);
  const text = result.text;
  assert.match(text, /^Club United \(Premier League\), live data as of 2026-11-01 from ESPN match data and the Fantasy Premier League feed\./);
  assert.match(text, /2026-10-12 Carabao Cup \(Fourth Round\), away at Fleetwood Town, D 1-1 \(lost 3-5 on penalties\)/);
  assert.doesNotMatch(text, /Tourists/);
  // The cup match had no lineup, so two XIs, most recent first, with start counts.
  assert.match(text, /- 2026-10-19, Premier League, away at Everton, D 0-0, 4-2-3-1: Keeper One \(GK\)/);
  assert.match(text, /Subs used: Gabriel Magalhães/);
  assert.match(text, /Starts in these 2 matches: Keeper One 2\/2/);
  // FPL names follow ESPN's ("Ben Striker", "Gabriel Magalhães"); a departed player is left out.
  assert.match(text, /by minutes .*Gabriel Magalhães 8, 720', 1G 0A; Ben Striker 8, 700', 6G 1A; Ten Man 6, 500'/);
  assert.doesNotMatch(text, /Gone Away/);
  assert.match(text, /Injured, suspended or doubtful .*: Ten Man \(Thigh injury - Unknown return date\); Gabriel Magalhães \(Hip injury - 75% chance of playing\)\./);
  assert.match(text, /Next fixtures: 2026-11-02 Premier League, away at Liverpool\./);
});

await test("a club outside the Premier League says its injury list isn't covered", async () => {
  const live = createLiveFootball(fakeFeeds());
  const result = await live.club('Rivals');
  assert.ok(result.found);
  assert.doesNotMatch(result.text, /Fantasy Premier League/);
  assert.deepEqual(result.missing, [{ item: 'Injury list for Rivals FC (no free source outside the Premier League)', status: 'not_covered' }]);
});

await test("an unknown club, a failed feed and a non-Premier League player report what's missing", async () => {
  const log: string[] = [];
  const live = createLiveFootball(fakeFeeds({ [FPL_BOOTSTRAP]: new Error('blocked') }, log));
  const nowhere = await live.club('Nowhere Rovers');
  assert.equal(nowhere.found, false);
  assert.equal('status' in nowhere && nowhere.status, 'not_covered');
  const club = await live.club('Club United');
  assert.ok(club.found);
  assert.deepEqual(club.missing, [{ item: "Season starts and injury list for Club United (Fantasy Premier League feed didn't answer)", status: 'failed' }]);
  assert.deepEqual(await live.player('Someone'), { found: false, status: 'failed', reason: "the Fantasy Premier League feed didn't answer" });
  // A failed feed isn't cached: the next lookup asks again.
  const asked = log.filter((u) => u === FPL_BOOTSTRAP).length;
  await live.player('Someone');
  assert.equal(log.filter((u) => u === FPL_BOOTSTRAP).length, asked + 1);
});

await test('player seasons use the name asked for, and tables read from ESPN standings', async () => {
  const live = createLiveFootball(fakeFeeds());
  const gabriel = await live.player('Gabriel Magalhães');
  assert.ok(gabriel.found);
  assert.equal(gabriel.name, 'Gabriel Magalhães');
  assert.match(gabriel.text, /Defender\. .*8 starts, 720 minutes, 1 goal, 0 assists, 5 clean sheets\. Status: Hip injury - 75% chance of playing\./);
  const table = await live.table('Premier League');
  assert.ok(table.found);
  assert.equal(table.text, '1. Club United — 21 pts, P8 W7 D0 L1, GD +8');
  assert.deepEqual(await live.table('Sunday League'), { found: false, status: 'not_covered', reason: 'no table source for "Sunday League"' });
  assert.deepEqual(await live.player('Lionel Nobody'), {
    found: false,
    status: 'not_covered',
    reason: 'not a Premier League player (only Premier League players are covered)',
  });
});

await test("a club lookup fails, rather than saying it isn't covered, when ESPN's club lists don't answer", async () => {
  const down = Object.fromEntries(Object.keys(LEAGUE_TEAMS).map((slug) => [`${ESPN_SITE}/${slug}/teams`, new Error('down')]));
  const live = createLiveFootball(fakeFeeds(down));
  const result = await live.club('Club United');
  assert.equal(result.found, false);
  assert.equal('status' in result && result.status, 'failed');
});

await test('a found club carries its structured report for the situation snapshot', async () => {
  const live = createLiveFootball(fakeFeeds(), () => Date.parse('2026-11-01T12:00:00Z'));
  const result = await live.club('Club United');
  assert.ok(result.found && 'report' in result);
  assert.equal(result.report.team, 'Club United');
  assert.equal(result.report.lineups.length, 2);
  assert.ok(result.report.fplPlayers?.length);
});

await test("a lookup that says what it couldn't get files that, not a second generic gap", async () => {
  const tools: ResearchToolset = {
    clubRecentTeam: async () => ({
      status: 'not_covered',
      result: null,
      missing: [{ item: 'Live match data for Nowhere (no club by that name)', status: 'not_covered' }],
    }),
    playerSeason: async () => ({ status: 'not_covered', result: null, missing: [], note: 'not a Premier League player' }),
    leagueTable: async () => ({ status: 'empty', result: null, missing: [] }),
    webSearch: async () => ({ status: 'failed', result: null, missing: [], note: 'refused (rate limited)' }),
    card: async () => ({ status: 'empty', result: null, missing: [] }),
    clubSeason: async () => ({ status: 'empty', result: null, missing: [] }),
    playerCareer: async () => ({ status: 'empty', result: null, missing: [] }),
  };
  const ledger = await runCalls(
    [
      { tool: 'club_recent_team', subject: 'Nowhere' },
      { tool: 'player_season', subject: 'Someone' },
      { tool: 'web_search', subject: 'Someone news' },
    ],
    tools,
    emptyLedger(),
  );
  assert.deepEqual(ledger.gaps, [
    { label: 'Live match data for Nowhere (no club by that name)', status: 'not_covered' },
    { label: 'Season record for Someone (covered for Premier League players only): not a Premier League player', status: 'not_covered' },
    { label: 'Web search: Someone news: refused (rate limited)', status: 'failed' },
  ]);
  assert.deepEqual(
    ledger.lookups.map((l) => l.status),
    ['not_covered', 'not_covered', 'failed'],
  );
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
