#!/usr/bin/env npx tsx
/**
 * Offline checks for the knowledge base's team strength (`services/kb/`): parsing ESPN's schedules
 * (fixtures trimmed from real answers, both shapes of a penalty shoot-out among them), the Elo
 * update on hand-built matches, burn-in, how a European match links two leagues, the stored
 * snapshots and the build that writes them (ESPN faked), the backfill's pacing, daily allowance,
 * carry-over and pause (clock faked), the Supabase store (client faked), the
 * public route and its limits, and `team_strength` in the chat loop (model and tools faked). No
 * network, Supabase or API keys.
 *
 * Usage:
 *   npx tsx scripts/test-team-strength.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ELO,
  applyMatch,
  competitionKind,
  computeSnapshots,
  expectedHome,
  goalMultiplier,
  parseResults,
  parseSeasonClubs,
  ratingChange,
  readSnapshot,
  seasonEndDate,
  seasonOfDate,
  wantedDate,
  type ClubState,
  type Snapshot,
  type StrengthMatch,
} from '../services/kb/teamStrength';
import {
  BACKFILL_DELAY_MS,
  BACKFILL_REQUESTS_PER_DAY,
  BUILD_CONCURRENCY,
  BUILD_DELAY_MS,
  PAUSE_AFTER,
  PAUSE_MS,
  createTeamStrengthJob,
} from '../services/kb/teamStrengthBuild';
import { MARKER_TEAM, memoryTeamStrengthStore, supabaseTeamStrengthStore, type TeamStrengthStore } from '../services/kb/teamStrengthStore';
import { createTeamStrengthReader, teamStrengthHandler } from '../services/kb/teamStrengthRoute';
import { lookUpTeamStrength, runTeamStrength, TEAM_STRENGTH_DECLARATION } from '../services/kb/teamStrengthTool';
import { createProxyLimiter } from '../services/geminiProxy';
import { LIVE_LEAGUES } from '../services/liveFootball';
import type { PermanentStore } from '../services/historyFootball';
import type { ResearchToolset } from '../services/researchTools';
import { ReplyComposer } from '../services/replyBlocks';
process.env.API_KEY = 'offline-test-key';

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

globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 400, message: 'offline test' } }), { status: 400 })) as typeof fetch;

const close = (actual: number, expected: number, within = 0.001) => assert.ok(Math.abs(actual - expected) <= within, `${actual} isn't within ${within} of ${expected}`);

// --- Parsing ----------------------------------------------------------------------------------

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/team-strength-espn.json', import.meta.url), 'utf8'));
const parsedFixtures = parseResults({ events: ['shootout', 'shootoutNoScore', 'extraTimeFinal', 'friendly', 'league'].map((k) => fixtures[k]) });
const fixture = (key: string) => parsedFixtures.matches.find((m) => m.id === fixtures[key].id)!;

await test('a penalty shoot-out counts as the draw that was played, with or without ESPN\'s shootoutScore', () => {
  assert.equal(fixtures.shootout.competitions[0].status.type.name, 'STATUS_FINAL_PEN');
  assert.ok(fixtures.shootout.competitions[0].competitors[1].score.shootoutScore > 0, 'the fixture carries a shoot-out score');
  const withScore = fixture('shootout');
  assert.deepEqual([withScore.homeGoals, withScore.awayGoals], [3, 3]);
  assert.equal(fixtures.shootoutNoScore.competitions[0].status.type.name, 'STATUS_FINAL_PEN');
  const older = fixture('shootoutNoScore');
  assert.deepEqual([older.homeGoals, older.awayGoals], [0, 0]);
});

await test('extra-time goals count, finals are neutral whatever ESPN flags, and a friendly is left out and named', () => {
  const final = fixture('extraTimeFinal');
  assert.deepEqual([final.homeGoals, final.awayGoals, final.kind, final.neutral], [2, 3, 'domestic_cup', true]);
  assert.equal(fixtures.extraTimeFinal.competitions[0].neutralSite, false);
  assert.deepEqual([fixture('shootout').kind, fixture('shootout').neutral], ['continental', true]);
  assert.deepEqual([fixture('league').kind, fixture('league').neutral, fixture('league').date], ['league', false, '2005-05-15']);
  assert.equal(parsedFixtures.matches.length, 4);
  assert.deepEqual(parsedFixtures.skipped, ['club.friendly']);
});

await test('competitions are classified, and a pre-season trophy never counts', () => {
  assert.equal(competitionKind('eng.1'), 'league');
  assert.equal(competitionKind('ger.2.promotion.relegation'), 'league');
  assert.equal(competitionKind('esp.copa_del_rey'), 'domestic_cup');
  assert.equal(competitionKind('uefa.uefa'), 'continental');
  for (const slug of ['club.friendly', 'esp.joan_gamper', 'friendly.emirates_cup', 'fifa.world', 'uefa.euro', 'eng.w.1', 'global.world_football_challenge']) {
    assert.equal(competitionKind(slug), null, slug);
  }
});

await test('a match not yet completed, or missing a score, is left out', () => {
  const event = structuredClone(fixtures.league);
  event.competitions[0].status.type.completed = false;
  assert.equal(parseResults({ events: [event] }).matches.length, 0);
  const unscored = structuredClone(fixtures.league);
  unscored.competitions[0].competitors[0].score = {};
  assert.equal(parseResults({ events: [unscored] }).matches.length, 0);
});

await test("a season's clubs are read from ESPN's standings, in groups too", () => {
  const entry = (id: string) => ({ team: { id, displayName: `Club ${id}` } });
  const clubs = parseSeasonClubs({ children: [{ standings: { entries: [entry('1'), entry('2')] } }, { standings: { entries: [entry('2'), entry('3')] } }] });
  assert.deepEqual(clubs.map((c) => c.id), ['1', '2', '3']);
  assert.deepEqual(parseSeasonClubs({}), []);
});

// --- The rating -------------------------------------------------------------------------------

const NAMES: Record<string, string> = { '1': 'Northside', '2': 'Southside', '3': 'Rivergate', '4': 'Hilltop', '5': 'Outlander', '9': 'Minnow Town' };
let nextId = 1000;
function m(date: string, home: string, away: string, score: [number, number], competition = 'eng.1', extra: Partial<StrengthMatch> = {}): StrengthMatch {
  return {
    id: String(nextId++),
    date,
    kickoff: `${date}T15:00:00.000Z`,
    competition,
    kind: competitionKind(competition)!,
    home: { id: home, name: NAMES[home] ?? `Club ${home}` },
    away: { id: away, name: NAMES[away] ?? `Club ${away}` },
    homeGoals: score[0],
    awayGoals: score[1],
    neutral: false,
    ...extra,
  };
}
const played = (matches: StrengthMatch[]) => {
  const clubs = new Map<string, ClubState>();
  matches.forEach((match) => applyMatch(clubs, match));
  return clubs;
};

await test('the expected score and the goal-difference multiplier are the published formulas', () => {
  close(expectedHome(1500, 1500), 1 / (1 + 10 ** -0.25));
  close(expectedHome(1500, 1500, true), 0.5);
  close(expectedHome(1900, 1500, true), 10 / 11);
  assert.deepEqual([0, 1, -1, 2, 3, -5].map(goalMultiplier), [1, 1, 1, 1.5, 1.75, 2]);
  assert.deepEqual(ELO, { initial: 1500, homeAdvantage: 100, k: { league: 20, domestic_cup: 15, continental: 25 } });
});

await test('one match moves both clubs by the same amount: K by competition, the margin and the venue', () => {
  const home = 1 / (1 + 10 ** -0.25);
  close(ratingChange(1500, 1500, { kind: 'league', homeGoals: 1, awayGoals: 0, neutral: false }), 20 * (1 - home));
  close(ratingChange(1500, 1500, { kind: 'league', homeGoals: 1, awayGoals: 1, neutral: false }), 20 * (0.5 - home));
  close(ratingChange(1500, 1500, { kind: 'domestic_cup', homeGoals: 0, awayGoals: 3, neutral: false }), -15 * 1.75 * home);
  close(ratingChange(1500, 1500, { kind: 'continental', homeGoals: 2, awayGoals: 0, neutral: true }), 25 * 1.5 * 0.5);
  const clubs = played([m('2004-09-01', '1', '2', [1, 0])]);
  close(clubs.get('1')!.rating, 1500 + 20 * (1 - home));
  close(clubs.get('1')!.rating + clubs.get('2')!.rating, 3000);
  assert.deepEqual([clubs.get('1')!.matches, clubs.get('1')!.league, clubs.get('1')!.europe], [1, 'eng.1', false]);
});

await test('only a numbered league says where a club plays, and a UEFA match marks it European', () => {
  const clubs = played([m('2004-09-01', '1', '2', [1, 0]), m('2004-09-15', '1', '3', [0, 0], 'uefa.champions'), m('2004-09-20', '2', '9', [1, 0], 'eng.fa')]);
  assert.deepEqual([clubs.get('1')!.league, clubs.get('1')!.europe, clubs.get('3')!.league, clubs.get('3')!.europe], ['eng.1', true, null, true]);
  assert.deepEqual([clubs.get('2')!.league, clubs.get('9')!.league], ['eng.1', null]);
});

await test('leagues separate only through matches between their clubs', () => {
  const domestic: StrengthMatch[] = [];
  for (let day = 1; day <= 20; day++) {
    const d = `2004-09-${String(day).padStart(2, '0')}`;
    domestic.push(m(d, '1', '2', [2, 0], 'eng.1'), m(d, '3', '4', [2, 0], 'esp.1'));
  }
  const average = (clubs: Map<string, ClubState>, ids: string[]) => ids.reduce((sum, id) => sum + clubs.get(id)!.rating, 0) / ids.length;
  const apart = played(domestic);
  close(average(apart, ['1', '2']), 1500);
  close(average(apart, ['3', '4']), 1500);
  close(apart.get('1')!.rating, apart.get('3')!.rating);
  const linked = played([...domestic, m('2004-10-01', '1', '3', [3, 0], 'uefa.champions'), m('2004-10-15', '3', '1', [0, 2], 'uefa.champions')]);
  assert.ok(average(linked, ['1', '2']) > 1500 && average(linked, ['3', '4']) < 1500, 'the winners’ league rises and the losers’ falls');
  // The clubs that never played in Europe keep their rating; their league moved through the one that did.
  close(linked.get('2')!.rating, apart.get('2')!.rating);
});

await test('the season calendar: 30 June ends a season, except 2019-20', () => {
  assert.equal(seasonEndDate(2004), '2005-06-30');
  assert.equal(seasonEndDate(2019), '2020-08-23');
  assert.deepEqual(['2005-06-30', '2005-07-01', '2020-08-23', '2020-08-24'].map(seasonOfDate), [2004, 2005, 2019, 2020]);
});

await test('2003-04 is burn-in: its matches shape the first ratings, and nothing is dated before 2004-07-01', () => {
  const snapshots = computeSnapshots([m('2003-09-01', '1', '2', [4, 0]), m('2004-05-01', '2', '1', [0, 2]), m('2004-09-04', '1', '2', [0, 0])], { today: '2004-10-10' });
  assert.equal(snapshots[0].date, '2004-07-01');
  assert.ok(snapshots.every((s) => s.date >= '2004-07-01'));
  assert.deepEqual(snapshots.map((s) => `${s.kind} ${s.date}`), ['month 2004-07-01', 'month 2004-08-01', 'month 2004-09-01', 'month 2004-10-01', 'latest 2004-10-10']);
  const first = snapshots[0].rows.find((r) => r.team_id === '1')!;
  assert.ok(first.rating > 1500 && first.matches === 2, 'burn-in results are counted');
});

await test('a monthly snapshot holds the ratings before that day, a season end after it, and 30 June stands for 1 July', () => {
  const snapshots = computeSnapshots(
    [m('2004-08-14', '1', '2', [1, 0]), m('2004-09-01', '1', '2', [1, 0]), m('2005-06-30', '2', '1', [5, 0])],
    { today: '2005-08-01' },
  );
  const at = (date: string, kind = 'month') => snapshots.find((s) => s.date === date && s.kind === kind);
  assert.equal(at('2004-07-01'), undefined, 'no club had played by then');
  assert.equal(at('2004-09-01')!.rows.find((r) => r.team_id === '1')!.matches, 1);
  assert.equal(at('2004-10-01')!.rows.find((r) => r.team_id === '1')!.matches, 2);
  assert.equal(at('2005-06-30', 'season_end')!.rows.find((r) => r.team_id === '1')!.matches, 3);
  assert.equal(at('2005-07-01'), undefined);
  assert.ok(at('2005-08-01'));
  assert.equal(snapshots.at(-1)!.kind, 'latest');
});

await test('a monthly snapshot drops a club that stopped playing; a season end keeps every club', () => {
  const snapshots = computeSnapshots([m('2004-08-01', '1', '9', [1, 0], 'eng.fa'), m('2005-05-01', '1', '2', [1, 0])], { today: '2005-07-02' });
  const ids = (date: string, kind: string) => snapshots.find((s) => s.date === date && s.kind === kind)!.rows.map((r) => r.team_id).sort();
  assert.deepEqual(ids('2005-06-01', 'month'), ['1', '2']);
  assert.deepEqual(ids('2005-06-30', 'season_end'), ['1', '2', '9']);
});

await test('what a request means: a date, a season\'s end, the season in progress, and nothing before 2004-05', () => {
  const today = '2026-11-27';
  assert.deepEqual(wantedDate({}, today), { date: today });
  assert.deepEqual(wantedDate({ date: '2012-11-20' }, today), { date: '2012-11-20' });
  assert.deepEqual(wantedDate({ date: '2030-01-01' }, today), { date: today });
  assert.deepEqual(wantedDate({ seasonStart: 2012 }, today), { date: '2013-06-30' });
  assert.deepEqual(wantedDate({ seasonStart: 2019 }, today), { date: '2020-08-23' });
  assert.deepEqual(wantedDate({ seasonStart: 2026 }, today), { date: today });
  for (const early of [wantedDate({ date: '2004-06-30' }, today), wantedDate({ seasonStart: 2003 }, today)]) {
    assert.ok('refused' in early && early.refused.status === 'not_covered' && /start in 2004-05/.test(early.refused.reason));
  }
  assert.ok('refused' in wantedDate({ date: '2012-02-30' }, today));
  assert.ok('refused' in wantedDate({ seasonStart: 2030 }, today));
});

// --- The build --------------------------------------------------------------------------------

/** An ESPN schedule event for a hand-built match. */
const espnEvent = (match: StrengthMatch) => ({
  id: match.id,
  date: match.kickoff,
  league: { slug: match.competition },
  seasonType: { name: 'Season' },
  competitions: [
    {
      neutralSite: match.neutral,
      status: { type: { name: 'STATUS_FULL_TIME', completed: true } },
      competitors: [
        { homeAway: 'home', team: { id: match.home.id, displayName: match.home.name }, score: { value: match.homeGoals } },
        { homeAway: 'away', team: { id: match.away.id, displayName: match.away.name }, score: { value: match.awayGoals } },
      ],
    },
  ],
});

const timedOut = () => Object.assign(new Error('timed out'), { code: 'ECONNABORTED' });
const answered = (status: number) => () => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

/**
 * ESPN with two clubs in each league's table, seasons 2003 to `lastYear`. Club 5 is in neither
 * league: it is met only in Europe, so only following opponents finds it, and club 9 only its
 * schedule sees. A season is 7 requests. A URL holding one of `fail`'s strings gets `failure`.
 */
function fakeEspn(lastYear = 2006) {
  const tables: Record<string, string[]> = { 'eng.1': ['1', '2'], 'esp.1': ['3', '4'] };
  const season: Record<number, StrengthMatch[]> = {};
  for (let y = 2003; y <= lastYear; y++) {
    season[y] = [
      m(`${y}-09-01`, '1', '2', [2, 0]),
      m(`${y}-09-08`, '3', '4', [1, 0], 'esp.1'),
      m(`${y}-10-01`, '1', '3', [1, 0], 'uefa.champions'),
      m(`${y}-11-01`, '5', '4', [2, 1], 'uefa.europa'),
      m(`${y}-11-15`, '5', '9', [3, 0], 'sco.tennents'),
      m(`${y + 1}-04-01`, '2', '1', [1, 1]),
    ];
  }
  const asked: string[] = [];
  const fail = new Set<string>();
  const settings = { failure: timedOut as () => Error };
  const getJson = async (url: string): Promise<any> => {
    asked.push(url);
    if ([...fail].some((f) => url.includes(f))) throw settings.failure();
    const table = url.match(/soccer\/([^/]+)\/standings\?season=(\d+)/);
    if (table) {
      const ids = season[Number(table[2])] ? tables[table[1]] ?? [] : [];
      return { children: [{ standings: { entries: ids.map((id) => ({ team: { id, displayName: NAMES[id] } })) } }] };
    }
    const schedule = url.match(/teams\/(\d+)\/schedule\?season=(\d+)/)!;
    const [, id, y] = schedule;
    const own = (season[Number(y)] ?? []).filter((x) => x.home.id === id || x.away.id === id);
    if (!own.length) throw Object.assign(new Error('not found'), { response: { status: 404 } });
    return { events: own.map(espnEvent) };
  };
  return { getJson, asked, fail, settings, season };
}

const jobLeagues = LIVE_LEAGUES.filter((l) => l.slug === 'eng.1' || l.slug === 'esp.1');
function job(espn: ReturnType<typeof fakeEspn>, store: TeamStrengthStore, today: string, extra: Partial<Parameters<typeof createTeamStrengthJob>[0]> = {}) {
  const lines: string[] = [];
  const built = createTeamStrengthJob({
    getJson: espn.getJson,
    store,
    leagues: jobLeagues,
    now: () => Date.parse(`${today}T12:00:00Z`),
    delayMs: 0,
    sleep: async () => {},
    log: (line) => lines.push(line),
    ...extra,
  });
  return { ...built, lines };
}
const ratingsIn = async (store: TeamStrengthStore, date: string) => {
  const ref = (await store.snapshotOn(date))!;
  return new Map((await store.rows(ref)).map((r) => [r.team_id, r]));
};

await test('a full build follows opponents, counts each match once, stores snapshots and logs one summary line', async () => {
  const espn = fakeEspn();
  const store = memoryTeamStrengthStore();
  const built = job(espn, store, '2005-12-15');
  const summary = await built.build();
  assert.equal(summary.status, 'stored');
  assert.equal(summary.from, null);
  assert.ok(espn.asked.some((u) => u.includes('teams/5/schedule?season=2004')), 'the club met only in Europe is fetched');
  assert.ok(!espn.asked.some((u) => u.includes('teams/9/')), 'a cup opponent isn\'t followed');
  // 2003 to 2005, six matches each, but 2005-06's last (April 2006) is still to come.
  assert.equal(summary.matches, 17);
  const latest = await ratingsIn(store, '2005-12-15');
  assert.deepEqual([...latest.keys()].sort(), ['1', '2', '3', '4', '5', '9']);
  assert.equal(latest.get('1')!.matches, 8);
  assert.equal(latest.get('9')!.matches, 3);
  assert.equal(await store.latestDate(), '2005-12-15');
  assert.equal((await store.checkpoint())!.date, '2005-06-30');
  const line = built.lines.at(-1)!;
  assert.match(line, /^\[kb\] team strength: 6 clubs, 17 matches, \d+ s \(full build, seasons 2003-2005;/);
});

await test('a build carried on from a season end gives the same ratings as a full one, reading only later seasons', async () => {
  const espn = fakeEspn();
  const carried = memoryTeamStrengthStore();
  await job(espn, carried, '2005-08-15').build();
  espn.asked.length = 0;
  const summary = await job(espn, carried, '2006-12-15').build();
  assert.equal(summary.from, '2005-06-30');
  assert.ok(!espn.asked.some((u) => /season=200[23]\b/.test(u)), 'earlier seasons aren\'t read again');
  const full = memoryTeamStrengthStore();
  await job(fakeEspn(), full, '2006-12-15').build();
  for (const date of ['2005-10-01', '2006-06-30', '2006-12-15']) {
    const a = await ratingsIn(carried, date);
    const b = await ratingsIn(full, date);
    assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), date);
    for (const [id, row] of a) {
      close(row.rating, b.get(id)!.rating, 0.05);
      assert.equal(row.matches, b.get(id)!.matches, `${id} on ${date}`);
    }
  }
});

await test('each finished season is stored as the build goes, so a build that fails later keeps it', async () => {
  const espn = fakeEspn();
  espn.fail.add('season=2006');
  espn.settings.failure = answered(403);
  const store = memoryTeamStrengthStore();
  const built = job(espn, store, '2006-12-15');
  const summary = await built.build();
  assert.equal(summary.status, 'aborted');
  assert.equal((await store.checkpoint())!.date, '2005-06-30');
  assert.equal(await store.latestDate(), null, 'no latest state from a part-built season');
  assert.match(built.lines.at(-1)!, /stopped, .*club lists for 2006 couldn't be read; stored through 2005-06-30/);
});

await test('unread club schedules past the limit store nothing from that point; a 404 is just no data', async () => {
  const espn = fakeEspn();
  espn.fail.add('teams/5/schedule?season=2004');
  espn.settings.failure = answered(403);
  const store = memoryTeamStrengthStore();
  const summary = await job(espn, store, '2005-08-15').build();
  assert.equal(summary.status, 'aborted');
  assert.match(summary.reason!, /club schedules couldn't be read/);
  assert.equal(await store.snapshotOn('2005-08-15'), null);
  assert.equal(summary.failed, 1);
  assert.equal(espn.asked.filter((u) => u.includes('teams/5/schedule?season=2004')).length, 3, 'tried three times');
});

await test('a settled season is read from disk the next time; the season in progress never is', async () => {
  const kept = new Map<string, any>();
  const cache: PermanentStore = { get: async (k) => kept.get(k), set: async (k, v) => void kept.set(k, JSON.parse(JSON.stringify(v))) };
  const espn = fakeEspn();
  await job(espn, memoryTeamStrengthStore(), '2005-12-15', { cache }).build();
  espn.asked.length = 0;
  const summary = await job(espn, memoryTeamStrengthStore(), '2005-12-16', { cache }).build();
  assert.ok(espn.asked.length > 0 && espn.asked.every((u) => u.includes('season=2005')), espn.asked.join('\n'));
  assert.ok(summary.cached > 0);
  assert.equal(summary.matches, 17);
});

await test('the daily tick builds once a day, and not at all while the table is missing', async () => {
  const espn = fakeEspn();
  const store = memoryTeamStrengthStore();
  const first = job(espn, store, '2005-12-15');
  await Promise.all([first.tick(), first.tick()]);
  const asked = espn.asked.length;
  await first.tick();
  assert.equal(espn.asked.length, asked, 'today is already stored');
  await job(espn, store, '2005-12-16').tick();
  assert.equal(await store.latestDate(), '2005-12-16');
  assert.equal((await store.snapshotOn('2005-12-15'))!.kind, 'month', 'yesterday\'s latest state is dropped');

  const missing = fakeEspn();
  const waiting = job(missing, { ...memoryTeamStrengthStore(), ready: async () => false }, '2005-12-15');
  await waiting.tick();
  await waiting.tick();
  assert.equal(missing.asked.length, 0);
  assert.equal(waiting.lines.length, 1);
});

// --- Pacing, the daily allowance and the pause --------------------------------------------------

const mapCache = () => {
  const kept = new Map<string, any>();
  const cache: PermanentStore = { get: async (k) => kept.get(k), set: async (k, v) => void kept.set(k, JSON.parse(JSON.stringify(v))) };
  return cache;
};
/** A job on a clock the test moves. */
function timed(espn: ReturnType<typeof fakeEspn>, store: TeamStrengthStore, clock: { t: number }, extra: Partial<Parameters<typeof createTeamStrengthJob>[0]> = {}) {
  return job(espn, store, '2000-01-01', { now: () => clock.t, ...extra });
}
const noon = (day: string) => Date.parse(`${day}T12:00:00Z`);
const seasonAsked = (url: string) => Number(url.match(/season=(\d+)/)![1]);
const sameRatings = async (a: TeamStrengthStore, b: TeamStrengthStore, date: string) => {
  const [left, right] = [await ratingsIn(a, date), await ratingsIn(b, date)];
  assert.deepEqual([...left.keys()].sort(), [...right.keys()].sort(), date);
  for (const [id, row] of left) {
    close(row.rating, right.get(id)!.rating, 0.05);
    assert.equal(row.matches, right.get(id)!.matches, `${id} on ${date}`);
  }
};

await test('the backfill goes one request at a time, a second apart; the season in progress keeps three at once', async () => {
  assert.deepEqual([BACKFILL_DELAY_MS, BUILD_CONCURRENCY, BUILD_DELAY_MS, BACKFILL_REQUESTS_PER_DAY, PAUSE_AFTER, PAUSE_MS], [1_000, 3, 250, 1_500, 3, 3_600_000]);
  const espn = fakeEspn();
  const events: { start?: number; end?: number; sleep?: number }[] = [];
  const inFlight = { backfill: 0, current: 0 };
  const most = { backfill: 0, current: 0, mixed: 0 };
  const getJson = async (url: string) => {
    const kind = seasonAsked(url) < 2005 ? 'backfill' : 'current';
    inFlight[kind]++;
    most[kind] = Math.max(most[kind], inFlight[kind]);
    if (inFlight.backfill && inFlight.current) most.mixed++;
    events.push({ start: seasonAsked(url) });
    await new Promise((r) => setImmediate(r));
    try {
      return await espn.getJson(url);
    } finally {
      inFlight[kind]--;
      events.push({ end: seasonAsked(url) });
    }
  };
  await job(espn, memoryTeamStrengthStore(), '2005-12-15', { getJson, delayMs: undefined, sleep: async (ms) => void events.push({ sleep: ms }) }).build();
  assert.deepEqual([most.backfill, most.current, most.mixed], [1, 3, 0]);
  // Between one backfill answer and the next backfill request there is always a pause of a second or more.
  let waited = Infinity;
  for (const e of events) {
    if (e.end !== undefined && e.end < 2005) waited = 0;
    if (e.sleep !== undefined) waited += e.sleep;
    if (e.start !== undefined && e.start < 2005) assert.ok(waited >= 1_000, `a backfill request ${waited} ms after the last`);
  }
  const sleeps = events.flatMap((e) => (e.sleep !== undefined ? [e.sleep] : []));
  assert.deepEqual([...new Set(sleeps)].sort((a, b) => a - b), [250, 1_000]);
});

await test("the backfill spends at most a day's requests, and carries on from there on the next days", async () => {
  const espn = fakeEspn();
  const store = memoryTeamStrengthStore();
  const cache = mapCache();
  const clock = { t: noon('2006-12-15') };
  const built = timed(espn, store, clock, { cache, backfillPerDay: 10 });
  const settledAsked: string[] = [];
  const day = async (date: string) => {
    clock.t = noon(date);
    espn.asked.length = 0;
    await built.tick();
    const settled = espn.asked.filter((u) => seasonAsked(u) < 2006);
    settledAsked.push(...settled);
    return { settled: settled.length, current: espn.asked.length - settled.length };
  };
  assert.deepEqual(await day('2006-12-15'), { settled: 10, current: 0 });
  assert.match(built.lines.at(-1)!, /^\[kb\] team strength: 0 clubs, \d+ matches read, \d+ s; today's 10 backfill requests are spent, nothing stored yet, carrying on tomorrow \(UTC\)/);
  // Later the same day there is nothing left to spend, so nothing runs at all.
  clock.t += 5 * PAUSE_MS;
  espn.asked.length = 0;
  await built.tick();
  assert.equal(espn.asked.length, 0);
  assert.deepEqual(await day('2006-12-16'), { settled: 10, current: 0 });
  assert.deepEqual(await day('2006-12-17'), { settled: 1, current: 7 }, 'the last backfill request, then the season in progress, which is outside the cap');
  assert.equal(await store.latestDate(), '2006-12-17');
  assert.equal(new Set(settledAsked).size, 21);
  assert.equal(settledAsked.length, 21, 'no settled season is fetched twice');
  const full = memoryTeamStrengthStore();
  await job(fakeEspn(), full, '2006-12-17').build();
  for (const date of ['2005-06-30', '2006-06-30', '2006-12-17']) await sameRatings(store, full, date);
});

await test("a restart keeps the day's count with the disk cache", async () => {
  const cache = mapCache();
  const store = memoryTeamStrengthStore();
  await job(fakeEspn(), store, '2006-12-15', { cache, backfillPerDay: 10 }).build();
  const espn = fakeEspn();
  const summary = await job(espn, store, '2006-12-15', { cache, backfillPerDay: 10 }).build();
  assert.deepEqual([summary.status, summary.halt, espn.asked.length], ['deferred', 'budget', 0]);
});

await test("without a disk cache the backfill still moves on each day, because it doesn't fetch the stored season again", async () => {
  const store = memoryTeamStrengthStore();
  const run = async (date: string, backfillPerDay: number) => {
    const espn = fakeEspn(2008);
    const summary = await job(espn, store, date, { backfillPerDay }).build();
    return { summary, seasons: [...new Set(espn.asked.map(seasonAsked))] };
  };
  const first = await run('2008-12-15', 21);
  assert.deepEqual([first.summary.halt, (await store.checkpoint())!.date], ['budget', '2005-06-30']);
  // 14 requests are two seasons: enough only if 2004-05, already stored, isn't fetched again.
  const second = await run('2008-12-16', 14);
  assert.deepEqual([second.summary.halt, (await store.checkpoint())!.date], ['budget', '2006-06-30']);
  assert.ok(!second.seasons.includes(2004), String(second.seasons));
  const third = await run('2008-12-17', 14);
  assert.equal(third.summary.status, 'stored');
  assert.deepEqual(third.seasons, [2006, 2007, 2008]);
  const full = memoryTeamStrengthStore();
  await job(fakeEspn(2008), full, '2008-12-17').build();
  for (const date of ['2006-06-30', '2007-06-30', '2008-06-30', '2008-12-17']) await sameRatings(store, full, date);
  // Caught up, the daily update reads the season just ended again, from ESPN if the disk is gone.
  const daily = await run('2008-12-18', 1_500);
  assert.deepEqual([daily.summary.status, daily.seasons], ['stored', [2007, 2008]]);
});

for (const [what, failure] of [['timeouts', timedOut], ['429s', answered(429)], ['5xx answers', answered(503)]] as const) {
  await test(`three ${what} in a row pause the backfill for an hour`, async () => {
    const espn = fakeEspn();
    espn.fail.add('season=2004');
    espn.settings.failure = failure;
    const store = memoryTeamStrengthStore();
    const clock = { t: noon('2005-12-15') };
    const built = timed(espn, store, clock, { cache: mapCache() });
    await built.tick();
    assert.equal(espn.asked.filter((u) => u.includes('season=2004')).length, 3, 'nothing is asked after the third');
    assert.equal(espn.asked.length, 10, "2003-04's seven, then the three");
    assert.ok(built.lines.some((l) => l.startsWith('[kb] team strength paused until 2005-12-15T13:00:00.000Z: 3 timeouts, 429s or 5xx answers in a row')), built.lines.join('\n'));
    espn.fail.clear();
    espn.asked.length = 0;
    clock.t += PAUSE_MS - 1;
    await built.tick();
    assert.equal((await built.build()).halt, 'paused');
    assert.equal(espn.asked.length, 0, 'nothing is asked during the pause');
    clock.t += 1;
    await built.tick();
    assert.equal(await store.latestDate(), '2005-12-15');
    assert.ok(espn.asked.every((u) => seasonAsked(u) > 2003), 'the season read before the pause comes from disk');
  });
}

await test('the season in progress obeys the same pause', async () => {
  const espn = fakeEspn();
  const store = memoryTeamStrengthStore();
  const cache = mapCache();
  const clock = { t: noon('2005-12-15') };
  const built = timed(espn, store, clock, { cache });
  await built.tick();
  espn.fail.add('season=2005');
  espn.settings.failure = answered(502);
  espn.asked.length = 0;
  clock.t = noon('2005-12-16');
  await built.tick();
  assert.ok(espn.asked.every((u) => seasonAsked(u) === 2005) && espn.asked.length >= 3 && espn.asked.length <= 4, String(espn.asked.length));
  assert.ok(built.lines.some((l) => l.startsWith('[kb] team strength paused until')));
  espn.fail.clear();
  espn.asked.length = 0;
  clock.t += PAUSE_MS / 2;
  await built.tick();
  assert.equal(espn.asked.length, 0);
  clock.t += PAUSE_MS / 2;
  await built.tick();
  assert.equal(await store.latestDate(), '2005-12-16');
});

await test('only troubles in a row pause: an answer between them starts the count again, and a refusal is no trouble', async () => {
  const espn = fakeEspn();
  const tries = new Map<string, number>();
  const flaky = async (url: string) => {
    const n = (tries.get(url) ?? 0) + 1;
    tries.set(url, n);
    if (n < 3) throw answered(503)();
    return espn.getJson(url);
  };
  const built = job(espn, memoryTeamStrengthStore(), '2005-08-15', { getJson: flaky, concurrency: 1 });
  assert.equal((await built.build()).status, 'stored');
  assert.ok(!built.lines.some((l) => l.includes('paused')));
  const refused = fakeEspn();
  refused.fail.add('season=2004');
  refused.settings.failure = answered(403);
  const other = job(refused, memoryTeamStrengthStore(), '2005-08-15');
  assert.equal((await other.build()).status, 'aborted');
  assert.ok(!other.lines.some((l) => l.includes('paused')));
});

await test("addresses that always fail can't pause the backfill for good, even side by side", async () => {
  const espn = fakeEspn();
  for (const id of ['2', '3', '4']) espn.fail.add(`teams/${id}/schedule?season=2004`);
  espn.settings.failure = answered(500);
  // 2004-05 is settled by December, so it is read one request at a time.
  const clock = { t: noon('2005-12-15') };
  const built = timed(espn, memoryTeamStrengthStore(), clock, { cache: mapCache() });
  const ends: string[] = [];
  for (let i = 0; i < 4; i++) {
    espn.asked.length = 0;
    const summary = await built.build();
    ends.push(summary.halt ?? summary.status);
    clock.t += PAUSE_MS;
  }
  // Each pauses once; after that it gets one try and doesn't count towards another pause.
  assert.deepEqual(ends, ['paused', 'paused', 'paused', 'aborted']);
  for (const id of ['2', '3', '4']) assert.equal(espn.asked.filter((u) => u.includes(`teams/${id}/schedule?season=2004`)).length, 1);
  assert.ok(espn.asked.some((u) => u.includes('season=2005')), 'the build goes on past them to the next season');
});

// --- The Supabase store -----------------------------------------------------------------------

/** Enough of a Supabase client for the store: filters, order, limit, range, upsert and delete. */
function fakeSupabase() {
  const rows: any[] = [];
  const writes: number[] = [];
  const from = () => {
    const filters: ((r: any) => boolean)[] = [];
    let sort: { key: string; ascending: boolean } | null = null;
    let slice: [number, number] | null = null;
    let deleting = false;
    const run = () => {
      if (deleting) {
        for (let i = rows.length - 1; i >= 0; i--) if (filters.every((f) => f(rows[i]))) rows.splice(i, 1);
        return { data: null, error: null };
      }
      let out = rows.filter((r) => filters.every((f) => f(r)));
      if (sort) {
        const { key, ascending } = sort;
        out = [...out].sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
      }
      if (slice) out = out.slice(slice[0], slice[1] + 1);
      return { data: out.map((r) => ({ ...r })), error: null };
    };
    const query: any = {
      select: () => query,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), query),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), query),
      lt: (k: string, v: string) => (filters.push((r) => r[k] < v), query),
      lte: (k: string, v: string) => (filters.push((r) => r[k] <= v), query),
      order: (key: string, o?: { ascending?: boolean }) => ((sort = { key, ascending: o?.ascending ?? true }), query),
      limit: (n: number) => ((slice = [0, n - 1]), query),
      range: (a: number, b: number) => ((slice = [a, b]), query),
      delete: () => ((deleting = true), query),
      upsert: (list: any[]) => {
        writes.push(list.length);
        for (const row of list) {
          const i = rows.findIndex((r) => r.team_id === row.team_id && r.rated_on === row.rated_on && r.kind === row.kind);
          if (i >= 0) rows[i] = { ...row };
          else rows.push({ ...row });
        }
        return Promise.resolve({ error: null });
      },
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    };
    return query;
  };
  return { client: { from }, rows, writes };
}

const storedRow = (id: string, date: string, kind: 'month' | 'season_end' | 'latest') => ({
  team_id: id, club: `Club ${id}`, league: 'eng.1', league_match: date, in_europe: false, rated_on: date, kind, rating: 1500, matches: 1, last_match: date,
});

await test('the table is written in batches with a marker after the rows, read in pages, and a part-written snapshot is not a checkpoint', async () => {
  const db = fakeSupabase();
  const store = supabaseTeamStrengthStore(db.client);
  const many: Snapshot = { date: '2005-06-30', kind: 'season_end', rows: Array.from({ length: 2_300 }, (_, i) => storedRow(String(i + 1), '2005-06-30', 'season_end')) };
  const latest: Snapshot = { date: '2005-08-01', kind: 'latest', rows: [storedRow('1', '2005-08-01', 'latest')] };
  await store.write([many, latest]);
  assert.deepEqual(db.writes, [1_000, 1_000, 301, 2]);
  assert.deepEqual(await store.snapshotOn('2005-07-31'), { date: '2005-06-30', kind: 'season_end' });
  assert.equal((await store.rows({ date: '2005-06-30', kind: 'season_end' })).length, 2_300);
  assert.equal((await store.checkpoint())!.rows.length, 2_300);
  assert.equal(await store.latestDate(), '2005-08-01');
  await store.write([{ date: '2005-08-02', kind: 'latest', rows: [storedRow('1', '2005-08-02', 'latest')] }]);
  assert.ok(!db.rows.some((r) => r.kind === 'latest' && r.rated_on === '2005-08-01'), 'the older latest state is gone');
  db.rows.splice(db.rows.findIndex((r) => r.kind === 'season_end' && r.team_id !== MARKER_TEAM), 1);
  assert.equal(await store.checkpoint(), null);
});

// --- Reading and the route --------------------------------------------------------------------

/** Two seasons of two linked leagues, a club seen only in a cup, and one outside Europe. */
function readingMatches(): StrengthMatch[] {
  const list: StrengthMatch[] = [];
  for (let round = 0; round < 36; round++) {
    const d = new Date(Date.parse('2004-08-07T00:00:00Z') + round * 7 * 86_400_000).toISOString().slice(0, 10);
    list.push(m(d, '1', '2', [2, 0], 'eng.1'), m(d, '3', '4', [1, 0], 'esp.1'), m(d, '7', '8', [3, 0], 'bra.1'));
  }
  list.push(m('2005-03-01', '1', '3', [2, 0], 'uefa.champions'), m('2004-12-15', '1', '9', [6, 0], 'eng.fa'));
  return list;
}
async function readingStore() {
  const store = memoryTeamStrengthStore();
  await store.write(computeSnapshots(readingMatches(), { today: '2005-08-10' }));
  return store;
}
const NOW = () => Date.parse('2005-08-10T12:00:00Z');
const aliasTeams = async () => [{ id: '1', name: 'Northside', names: ['Northside', 'The Northerners'], abbreviation: 'NOR', league: 'eng.1' }];

await test("a reading gives the rating, rank, league average and top clubs, and finds a club by any of ESPN's names", async () => {
  const reader = createTeamStrengthReader({ store: await readingStore(), teams: aliasTeams, now: NOW });
  const r = await reader.lookup({ club: 'the northerners', season: '2004-05' });
  assert.ok(r.found);
  if (!r.found) return;
  assert.deepEqual([r.club.club, r.asOf, r.kind, r.season, r.club.matches, r.rough], ['Northside', '2005-06-30', 'season_end', '2004-05', 38, false]);
  assert.deepEqual(r.rank, { position: 1, of: 4 });
  assert.equal(r.pool, 'Europe');
  assert.deepEqual([r.leagueAverage!.league, r.leagueAverage!.clubs], ['Premier League', 2]);
  assert.ok(r.leagueAverage!.rating > 1500);
  assert.equal(r.top[0].club, 'Northside');
  assert.ok(!r.top.some((t) => t.club.startsWith('Club 7')), 'a club outside Europe isn\'t ranked among European ones');
});

await test('a club with few matches is rough and unranked, and a club outside Europe is ranked only within its league', async () => {
  const reader = createTeamStrengthReader({ store: await readingStore(), now: NOW });
  const minnow = await reader.lookup({ club: 'Minnow Town', date: '2005-05-01' });
  assert.ok(minnow.found && minnow.rough && minnow.rank === null && minnow.club.matches === 1);
  const away = await reader.lookup({ club: 'Club 7', date: '2005-05-01' });
  assert.ok(away.found);
  if (!away.found) return;
  assert.deepEqual([away.outsideEurope, away.pool, away.rank], [true, 'Brasileirão', { position: 1, of: 2 }]);
});

await test('a reading says why there is none: too early, unknown, gone quiet, or not yet built', async () => {
  const store = await readingStore();
  const reader = createTeamStrengthReader({ store, now: NOW });
  const reason = async (request: { club: string; date?: string; season?: string }) => {
    const r = await reader.lookup(request);
    return 'reason' in r ? `${r.status}: ${r.reason}` : 'found';
  };
  assert.match(await reason({ club: 'Northside', season: '2003-04' }), /^not_covered: ratings start in 2004-05/);
  assert.match(await reason({ club: 'Northside', season: 'last year' }), /no season in/);
  assert.match(await reason({ club: 'Nobody FC' }), /no rated club matches/);
  assert.match(await reason({ club: 'Minnow Town' }), /Minnow Town has no rating on 2005-08-10: it had played no counted match since 2004-12-15/);
  const empty = createTeamStrengthReader({ store: memoryTeamStrengthStore(), now: NOW });
  const unbuilt = await empty.lookup({ club: 'Northside' });
  assert.ok('reason' in unbuilt && /haven't been built/.test(unbuilt.reason));
  // A build that has only reached 2004-05 must not pass that season's end off as today's rating.
  const part = createTeamStrengthReader({ store, now: () => Date.parse('2012-03-01T00:00:00Z') });
  const stale = await part.lookup({ club: 'Northside' });
  assert.ok('reason' in stale && /haven't been built for that date/.test(stale.reason));
});

await test('a reading is cached, and an empty answer before the first build is not', async () => {
  const store = memoryTeamStrengthStore();
  let reads = 0;
  const counted: TeamStrengthStore = { ...store, rows: (ref) => (reads++, store.rows(ref)) };
  const reader = createTeamStrengthReader({ store: counted, now: NOW });
  assert.equal((await reader.lookup({ club: 'Northside' })).found, false);
  await store.write(computeSnapshots(readingMatches(), { today: '2005-08-10' }));
  assert.ok((await reader.lookup({ club: 'Northside' })).found);
  assert.ok((await reader.lookup({ club: 'Southside' })).found);
  assert.equal(reads, 1);
});

const fakeRes = () => {
  const res = {
    code: 200,
    body: null as any,
    headers: {} as Record<string, string>,
    status(code: number) { res.code = code; return res; },
    json(body: unknown) { res.body = body; return res; },
    set(k: string, v: string) { res.headers[k] = v; return res; },
  };
  return res;
};

await test('the route needs a club, caches what it finds, and limits each visitor', async () => {
  const reader = createTeamStrengthReader({ store: await readingStore(), now: NOW });
  const handler = teamStrengthHandler(reader, createProxyLimiter({ perMinute: 2, now: NOW }), (req) => req.who, () => {});
  const send = async (query: Record<string, string>, who = 'a') => {
    const res = fakeRes();
    await handler({ query, who }, res);
    return res;
  };
  assert.equal((await send({})).code, 400);
  const hit = await send({ club: 'Northside', season: '2004-05' });
  assert.deepEqual([hit.code, hit.body.found, hit.headers['Cache-Control']], [200, true, 'public, max-age=3600']);
  const miss = await send({ club: 'Nobody FC' });
  assert.deepEqual([miss.code, miss.body.found, miss.headers['Cache-Control']], [200, false, undefined]);
  assert.equal((await send({ club: 'Northside' })).code, 429);
  assert.equal((await send({ club: 'Northside' }, 'b')).code, 200);
  const broken = teamStrengthHandler({ lookup: async () => { throw new Error('store down'); } }, createProxyLimiter(), () => 'a', () => {});
  const res = fakeRes();
  await broken({ query: { club: 'Northside' } }, res);
  assert.deepEqual(res.body, { found: false, status: 'failed', reason: "the ratings couldn't be read" });
});

// --- The tool ---------------------------------------------------------------------------------

await test('the tool reads the route, and its result is a ledger entry that says what the rating measures', async () => {
  const reader = createTeamStrengthReader({ store: await readingStore(), now: NOW });
  const asked: string[] = [];
  const get = async <T>(url: string) => {
    asked.push(url);
    const q = new URL(url, 'http://local').searchParams;
    return { data: (await reader.lookup({ club: q.get('club')!, season: q.get('season') ?? undefined })) as T };
  };
  const out = await runTeamStrength({ club: 'Northside', season: '2004-05' }, (a) => lookUpTeamStrength(a, get));
  assert.deepEqual(asked, ['/api/kb/team-strength?club=Northside&season=2004-05']);
  assert.equal(out.response.status, 'found');
  assert.equal(out.evidence!.kind, 'team_strength');
  assert.equal(out.evidence!.label, 'Northside, end of 2004-05');
  assert.match(out.evidence!.content, /Northside: Elo rating \d{4}, at the end of 2004-05 \(2005-06-30\)\. 38 matches counted since 2003-04\./);
  assert.match(out.evidence!.content, /Rank: 1st place of 4 rated clubs in Europe/);
  assert.match(out.evidence!.content, /not squad quality or style/);
  const none = await runTeamStrength({ club: 'Northside', season: '2001-02' }, (a) => lookUpTeamStrength(a, get));
  assert.deepEqual([none.response.status, none.evidence], ['not_covered', null]);
  const down = await runTeamStrength({ club: 'Northside' }, (a) => lookUpTeamStrength(a, async () => ({ error: 'HTTP 429' })));
  assert.deepEqual([down.response.status, down.evidence], ['failed', null]);
});

await test("the tool's declaration says what the rating measures, when ratings start and what a low count means", () => {
  const text = TEAM_STRENGTH_DECLARATION.description!;
  for (const re of [/results/, /not squad quality/, /start in 2004-05/, /few counted matches is rough/, /outside Europe/]) assert.match(text, re);
});

const { runChatTurn, chatDeclarations, CHAT_DECLARATIONS, researchRules, DEFAULT_RESEARCH_BUDGET, stageLabel } = await import('../services/chatTurn');
type ChatModel = import('../services/chatTurn').ChatModel;
type ChatRoundReply = import('../services/chatTurn').ChatRoundReply;
type ChatToolResponse = import('../services/chatTurn').ChatToolResponse;

await test('the chat loop offers team_strength on present, past and Gaffa turns, with one line about it', () => {
  for (const declarations of [CHAT_DECLARATIONS, chatDeclarations(false), chatDeclarations(true, true)]) {
    assert.equal(declarations.filter((d) => d.name === 'team_strength').length, 1);
  }
  assert.equal(researchRules(DEFAULT_RESEARCH_BUDGET).split('\n').filter((l) => l.includes('team_strength')).length, 1);
  assert.equal(stageLabel({ name: 'team_strength', args: { club: 'Northside' } }), 'Sizing up Northside');
});

const nothing = async () => ({ status: 'empty' as const, result: null, missing: [] });
const noTools: ResearchToolset = { clubRecentTeam: nothing, playerSeason: nothing, leagueTable: nothing, webSearch: nothing, card: nothing, clubSeason: nothing, playerCareer: nothing };

for (const historical of [false, true]) {
  await test(`in a ${historical ? 'past' : 'present'} turn team_strength is free, filed in the ledger, and the figure gate keeps its figures and no others`, async () => {
    const reader = createTeamStrengthReader({ store: await readingStore(), now: NOW });
    const sent: (string | ChatToolResponse[])[] = [];
    const supported = 'Northside held 1st place in the ratings after 38 matches.';
    const script: ChatRoundReply[] = [
      { text: '', calls: [{ name: 'team_strength', args: { club: 'Northside', season: '2004-05' } }] },
      { text: `${supported}\n\nThey also scored 97 goals.`, calls: [] },
    ];
    const model: ChatModel = {
      open: () => ({
        async send(message, { onText }) {
          sent.push(message);
          const reply = script[Math.min(sent.length - 1, script.length - 1)];
          if (reply.text) onText?.(reply.text);
          return reply;
        },
      }),
    };
    const stats: import('../services/chatTurn').TurnStats[] = [];
    const log = { log: console.log, info: console.info, warn: console.warn };
    console.log = console.info = console.warn = () => {};
    process.env.GATE_FEEDBACK = 'off';
    let reply: string;
    try {
      reply = await runChatTurn(
        {
          message: 'How strong were Northside in 2004-05?',
          route: { intent: 'tactical_chat', analyticalMode: 'tactical_or_system', targetPlayers: [], targetClubs: ['Northside'], searchQueries: [], isHistorical: historical, wantsRegeneration: false, needsSearch: true },
          history: [],
          isEAFCRequest: false,
          conversationDossiers: [],
          savedDossiers: [],
          lockedDossiersBlock: '',
          savedDossiersBlock: '',
          composer: new ReplyComposer(),
          conversationId: `strength-${historical}`,
          historical,
          pastMode: true,
        },
        {
          model,
          tools: noTools,
          snapshots: null,
          managers: async () => [],
          eras: null,
          verdicts: null,
          pastNetwork: { propose: async () => {}, depart: async () => {} } as any,
          teamStrength: (a) => reader.lookup(a),
          onStats: (s) => stats.push(s),
        },
      );
    } finally {
      Object.assign(console, log);
      delete process.env.GATE_FEEDBACK;
    }
    const results = sent[1] as ChatToolResponse[];
    assert.equal(results[0].response.status, 'found');
    assert.match(String(results[0].response.budget), new RegExp(`${historical ? 8 : 12} lookups`), 'no lookup was spent');
    assert.equal(stats[0].calls, 0);
    assert.ok(reply.includes(supported), reply);
    assert.ok(!reply.includes('97 goals'), reply);
    const { threadStateFor } = await import('../services/conversationalScout');
    assert.match(threadStateFor(`strength-${historical}`).grounding ?? '', /Team strength \(an Elo rating computed by code from ESPN results\) — Northside, end of 2004-05/);
  });
}

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
