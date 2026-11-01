#!/usr/bin/env npx tsx
/**
 * Offline checks for research about the past: Wikipedia articles and ESPN's past seasons read
 * into evidence (with both sources faked), lookups kept for good, permanent era snapshots and
 * settled debates, and the check that keeps a ranking or verdict in line with the stored cards.
 *
 * Usage:
 *   npx tsx scripts/test-history-research.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';
import {
  cellText,
  competitionRecords,
  createHistoryFootball,
  formatClubSeasonPage,
  formatPlayerPage,
  formatTable,
  infoboxLines,
  leadText,
  parseSeason,
  parseTableGrid,
  pickPlayerTitle,
  pickSeasonTitle,
  spreadSample,
  usualStarters,
  WIKI_API,
  type PermanentStore,
} from '../services/historyFootball';
import { ESPN_SITE, ESPN_STANDINGS, type ClubMatch } from '../services/liveFootball';
import {
  cardAbove,
  checkOrderAgainstCards,
  checkVerdictAgainstCards,
  matchStanding,
  standingsFor,
  toStanding,
} from '../services/debateConsistency';
import {
  buildEraSnapshot,
  cardFingerprint,
  createDebateStore,
  createEraSnapshotStore,
  debateSignature,
  ERA_SNAPSHOT_VERSION,
  eraEntry,
  normalizePeriod,
  subjectFromTitle,
  type EraRow,
  type EraSnapshot,
} from '../services/eraSnapshots';
import { checkFigures, paraphrasePairs, parseAgreement, parseHistoryGrade, readQuestionTable } from './eval-history';
import { executeCall, historyOutcome, sanitizeCalls, type ResearchToolset, type ToolOutcome } from '../services/researchTools';
import {
  looksLikePastQuestion,
  startDebateBrief,
  buildDebateBriefPrompt,
  checkBriefAgainstCards,
  formatDebateBriefForWriter,
  readDebateBrief,
  runDebateResearch,
  type DebateBrief,
} from '../services/debateBrief';

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

const SEASON_HTML = `<table class="infobox vcard"><tbody>
<tr><th colspan="2" class="infobox-above">Testville season</th></tr>
<tr><th class="infobox-label">Manager</th><td class="infobox-data"><a href="/wiki/A">Ada Coach</a></td></tr>
<tr><th class="infobox-label">Stadium</th><td class="infobox-data">Old Ground</td></tr>
<tr><th class="infobox-label">League</th><td class="infobox-data">Winners<sup class="reference">[1]</sup></td></tr>
<tr><th class="infobox-label">Top goalscorer</th><td class="infobox-data">League: Bo Striker (30)<br>All: Bo Striker (39)</td></tr>
</tbody></table>
<p>The <b>2003–04 season</b> was Testville's best, ending unbeaten in the league with 26 wins and 12 draws.<sup class="reference">[2]</sup></p>
<div class="mw-heading mw-heading2"><h2 id="Player_statistics">Player statistics</h2></div>
<table class="wikitable"><tbody>
<tr><th rowspan="2">No.</th><th rowspan="2">Pos.</th><th rowspan="2">Name</th><th colspan="2">League</th><th colspan="2">Total</th></tr>
<tr><th>Apps</th><th>Goals</th><th>Apps</th><th>Goals</th></tr>
<tr><td>1</td><td>GK</td><td>Cy Keeper</td><td>38</td><td>0</td><td>54</td><td>0</td></tr>
<tr><td>14</td><td>FW</td><td>Bo Striker</td><td>37</td><td>30</td><td>50 (1)</td><td>39</td></tr>
</tbody></table>
<div class="mw-heading mw-heading3"><h3 id="League_table">League table</h3></div>
<table class="wikitable"><tbody>
<tr><th>Pos</th><th>Team<span class="navbar">v t e</span></th><th>Pld</th><th>W</th><th>D</th><th>L</th><th>Pts</th></tr>
<tr><td>1</td><td>Testville (C)</td><td>38</td><td>26</td><td>12</td><td>0</td><td>90</td></tr>
<tr><td>2</td><td>Rival Town</td><td>38</td><td>24</td><td>7</td><td>7</td><td>79</td></tr>
</tbody></table>`;

const PLAYER_HTML = `<table class="infobox biography vcard"><tbody>
<tr><th colspan="3" class="infobox-header">Personal information</th></tr>
<tr><th class="infobox-label">Date of birth</th><td class="infobox-data"><span style="display:none"> (<span class="bday">1972-06-23</span>) </span>23 June 1972</td></tr>
<tr><th class="infobox-label">Position</th><td class="infobox-data">Attacking midfielder</td></tr>
<tr><th colspan="3" class="infobox-header">Senior career*</th></tr>
<tr><th class="infobox-label">1996–2001</th><td class="infobox-data">Juve</td><td>151</td><td>(24)</td></tr>
</tbody></table>
<p>Zed Player is a retired footballer who played as an attacking midfielder for Juve and Madrid.</p>
<div class="mw-heading mw-heading2"><h2 id="Career_statistics">Career statistics</h2></div>
<div class="mw-heading mw-heading3"><h3 id="Club">Club</h3></div>
<table class="wikitable"><tbody>
<tr><th rowspan="2">Club</th><th rowspan="2">Season</th><th colspan="2">League</th></tr>
<tr><th>Apps</th><th>Goals</th></tr>
<tr><td rowspan="2">Juve</td><td>1996–97</td><td>29</td><td>5</td></tr>
<tr><td>1997–98</td><td>32</td><td>7</td></tr>
</tbody></table>
<div class="mw-heading mw-heading2"><h2 id="Honours">Honours</h2></div>
<div class="mw-heading mw-heading3"><h3 id="Player">Player</h3></div>
<div class="mw-heading mw-heading4"><h4 id="Juve">Juve</h4></div>
<ul><li>Serie A: 1996–97, 1997–98</li></ul>`;

const event = (id: string, date: string, home: boolean, us: number, them: number, slug = 'eng.1') => ({
  id,
  date: `${date}T15:00Z`,
  league: { slug, abbreviation: slug === 'eng.1' ? 'Premier League' : 'Champions League' },
  competitions: [
    {
      status: { type: { completed: true } },
      competitors: [
        { team: { id: '359', displayName: 'Testville' }, homeAway: home ? 'home' : 'away', score: { value: us } },
        { team: { id: '9', displayName: 'Other' }, homeAway: home ? 'away' : 'home', score: { value: them } },
      ],
    },
  ],
});
const lineup = (eventId: string, keeper: string) => ({
  rosters: [
    {
      team: { id: '359' },
      formation: '4-4-2',
      roster: [keeper, 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'].map((n, i) => ({
        starter: true,
        athlete: { displayName: n },
        position: { abbreviation: i === 0 ? 'G' : 'M' },
      })),
    },
  ],
  eventId,
});

function fakeSources() {
  const calls: string[] = [];
  const getJson = async (url: string) => {
    calls.push(url);
    if (url.startsWith(WIKI_API)) {
      const u = new URL(url);
      if (u.searchParams.get('list') === 'search') {
        const q = u.searchParams.get('srsearch') ?? '';
        if (q.includes('footballer')) return { query: { search: [{ title: 'Zed Player', snippet: 'retired footballer' }] } };
        return { query: { search: [{ title: '2003–04 Testville Women season', snippet: '' }, { title: `${q.slice(0, 7)} Testville F.C. season`, snippet: '' }] } };
      }
      const page = u.searchParams.get('page') ?? '';
      return { parse: { title: page, text: page.includes('season') ? SEASON_HTML : PLAYER_HTML } };
    }
    if (url === `${ESPN_SITE}/eng.1/teams`) return { sports: [{ leagues: [{ teams: [{ team: { id: '359', displayName: 'Testville' } }] }] }] };
    if (url.endsWith('/teams')) return { sports: [{ leagues: [{ teams: [] }] }] };
    if (url.startsWith(`${ESPN_SITE}/all/teams/359/schedule?season=`)) {
      return {
        events: [
          event('1', '2003-08-16', true, 2, 1),
          event('2', '2003-09-01', false, 1, 1),
          event('3', '2004-04-06', true, 1, 2, 'uefa.champions'),
          event('4', '2004-05-15', true, 2, 1),
        ],
      };
    }
    if (url.startsWith(`${ESPN_STANDINGS}/eng.1/standings?season=`)) {
      return {
        children: [
          {
            standings: {
              entries: [
                { team: { displayName: 'Testville' }, stats: [{ name: 'rank', value: 1 }, { name: 'points', value: 90 }] },
                { team: { displayName: 'Rival Town' }, stats: [{ name: 'rank', value: 2 }, { name: 'points', value: 79 }] },
              ],
            },
          },
        ],
      };
    }
    const summary = url.match(/summary\?event=(\d+)/);
    if (summary) return lineup(summary[1], summary[1] === '2' ? 'Backup' : 'Cy Keeper');
    throw new Error(`unexpected ${url}`);
  };
  return { calls, getJson };
}

const memoryStore = (): PermanentStore & { data: Map<string, any> } => {
  const data = new Map<string, any>();
  return { data, get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
};

const card = (name: string, overall: number, extra: Partial<PlayerProfile> = {}): PlayerProfile =>
  ({
    basicInfo: { name, club: 'Club', position: 'Centre-Back', age: 30, nationality: 'X' },
    ratings: { overall, potential: overall },
    version: { id: 'v', type: 'prime', label: 'Prime', evaluationDate: '2026-10-20', seasonOrEra: '2003-06' },
    ...extra,
  }) as unknown as PlayerProfile;

// --- Seasons and HTML -------------------------------------------------------------------------

await test('seasons parse from the ways people write them', () => {
  assert.equal(parseSeason('2003-04')?.label, '2003-04');
  assert.equal(parseSeason('2003/04')?.wikiLabel, '2003–04');
  assert.equal(parseSeason('1999–2000')?.label, '1999-00');
  assert.equal(parseSeason('the 88-89 side')?.start, 1988);
  // One year is the season that ends in it.
  assert.equal(parseSeason('Liverpool 2005')?.label, '2004-05');
  assert.equal(parseSeason('no season here'), null);
});

await test('cell text drops footnotes, hidden spans and table navigation', () => {
  assert.equal(cellText('Winners<sup class="reference">[1]</sup>'), 'Winners');
  assert.equal(cellText('<span style="display:none"> (<span class="bday">1972-06-23</span>) </span>23 June 1972'), '23 June 1972');
  assert.equal(cellText('Team<span class="navbar">v t e</span>'.replace('v t e', 'v, t, e')), 'Team');
  assert.equal(cellText('League: A (30)<br>All: A (39)'), 'League: A (30), All: A (39)');
});

await test('a table grid fills rowspans and colspans so rows line up with the header', () => {
  const grid = parseTableGrid(PLAYER_HTML.slice(PLAYER_HTML.indexOf('<table class="wikitable">'), PLAYER_HTML.indexOf('</table>', PLAYER_HTML.indexOf('wikitable')) + 8));
  assert.deepEqual(grid[3].map((c) => c.text), ['Juve', '1997–98', '32', '7']);
  const text = formatTable(grid);
  assert.equal(text.split('\n')[0], 'Club | Season | League Apps | League Goals');
  assert.ok(text.includes('Juve | 1996–97 | 29 | 5'));
});

await test('the infobox reads as labelled lines with career rows', () => {
  const lines = infoboxLines(PLAYER_HTML);
  assert.ok(lines.includes('Date of birth: 23 June 1972'));
  assert.ok(lines.includes('Senior career:'));
  assert.ok(lines.includes('1996–2001: Juve, 151, (24)'));
  assert.ok(leadText(SEASON_HTML).startsWith('The 2003–04 season was Testville'));
});

await test("a season article's digest keeps the facts, the squad table and the club's table row", () => {
  const text = formatClubSeasonPage({ title: '2003–04 Testville F.C. season', html: SEASON_HTML }, 'Testville');
  assert.ok(text.includes('- Manager: Ada Coach'));
  assert.ok(!text.includes('Stadium'));
  assert.ok(text.includes('14 | FW | Bo Striker | 37 | 30 | 50 (1) | 39'));
  assert.ok(text.includes('1 | Testville (C) | 38 | 26 | 12 | 0 | 90'));
  assert.ok(text.includes('Pos | Team | Pld'));
});

await test("a player article's digest keeps his career table and honours under their club", () => {
  const text = formatPlayerPage({ title: 'Zed Player', html: PLAYER_HTML });
  assert.ok(text.includes('Club appearances and goals by season'));
  assert.ok(text.includes('Juve | 1997–98 | 32 | 7'));
  assert.ok(text.includes('- Juve: Serie A: 1996–97, 1997–98'));
});

await test('search hits resolve to the right article', () => {
  const season = parseSeason('2003-04')!;
  assert.equal(
    pickSeasonTitle(['2003–04 Arsenal W.F.C. season', '2004–05 Arsenal F.C. season', '2003–04 Arsenal F.C. season'], 'Arsenal', season),
    '2003–04 Arsenal F.C. season',
  );
  assert.equal(pickSeasonTitle(['2003–04 Chelsea F.C. season'], 'Arsenal', season), null);
  assert.equal(
    pickPlayerTitle(
      [
        { title: 'List of Ronaldo awards', snippet: '' },
        { title: 'Ronaldo (Brazilian footballer)', snippet: 'Brazilian striker' },
      ],
      'Ronaldo',
    ),
    'Ronaldo (Brazilian footballer)',
  );
  // An article named after him isn't his.
  assert.equal(
    pickPlayerTitle(
      [
        { title: 'Franz Beckenbauer Supercup', snippet: 'football match' },
        { title: 'Franz Beckenbauer', snippet: 'German footballer and manager' },
      ],
      'Franz Beckenbauer',
    ),
    'Franz Beckenbauer',
  );
});

// --- ESPN past seasons ------------------------------------------------------------------------

await test('competition records and the usual starters come from the sampled matches', () => {
  const m = (date: string, gf: number, ga: number, competition = 'Premier League'): ClubMatch => ({
    id: date, date, competition, leagueSlug: null, home: true, opponent: 'X', completed: true, goalsFor: gf, goalsAgainst: ga, penaltiesFor: null, penaltiesAgainst: null,
  });
  const records = competitionRecords([m('a', 2, 1), m('b', 1, 1), m('c', 0, 1, 'FA Cup (Semi-finals)')]);
  assert.deepEqual(records.map((r) => [r.competition, r.won, r.drawn, r.lost]), [['Premier League', 1, 1, 0], ['FA Cup', 0, 0, 1]]);
  assert.deepEqual(spreadSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4), [1, 4, 7, 10]);
  const starters = usualStarters([
    { match: m('a', 1, 0), formation: '4-4-2', starters: [{ name: 'A', role: 'G' }, { name: 'B', role: 'F' }], subsUsed: [] },
    { match: m('b', 1, 0), formation: '4-4-2', starters: [{ name: 'A', role: 'G' }, { name: 'C', role: 'F' }], subsUsed: [] },
  ]);
  assert.deepEqual(starters[0], { name: 'A', starts: 2, role: 'G' });
});

await test('a club season combines Wikipedia and ESPN, and is kept for good', async () => {
  const { calls, getJson } = fakeSources();
  const store = memoryStore();
  const history = createHistoryFootball({ getJson, store, currentSeasonStart: () => 2026 });
  const r = await history.clubSeason('Testville', '2003-04');
  assert.ok('text' in r);
  assert.ok(r.text.includes('Manager: Ada Coach'));
  assert.ok(r.text.includes('Premier League: finished 1 of 2 with 90 points.'));
  assert.ok(r.text.includes('Premier League: P3 W2 D1 L0, goals 5-3.'));
  assert.ok(r.text.includes('Champions League: P1 W0 D0 L1, goals 1-2; last match 2004-04-06'));
  assert.ok(r.text.includes('Cy Keeper (GK) 2/3'));
  assert.ok(r.text.includes("read the slots loosely"));
  assert.equal(r.title, '2003–04 Testville F.C. season');
  assert.equal(store.data.size, 1);
  assert.equal([...store.data.values()][0].expiresAt, null);
  // A second lookup, even from a new process reading the same store, fetches nothing.
  const fetched = calls.length;
  await history.clubSeason('Testville', '2003/04');
  const fresh = createHistoryFootball({ getJson, store, currentSeasonStart: () => 2026 });
  await fresh.clubSeason('Testville', '2003-04');
  assert.equal(calls.length, fetched);
});

await test('a season before ESPN, or in progress, says what is missing', async () => {
  const { getJson } = fakeSources();
  const history = createHistoryFootball({ getJson, currentSeasonStart: () => 2026 });
  const old = await history.clubSeason('Testville', '1988-89');
  assert.ok('text' in old);
  assert.ok(old.missing.some((m) => m.status === 'not_covered' && m.item.includes('2003-04')));
  const now = await history.clubSeason('Testville', '2026-27');
  assert.ok('reason' in now && now.status === 'not_covered');
});

await test("a player's career comes from his article and is kept a week", async () => {
  const { getJson } = fakeSources();
  const store = memoryStore();
  const history = createHistoryFootball({ getJson, store, now: () => 0, currentSeasonStart: () => 2026 });
  const r = await history.playerCareer('Zed Player');
  assert.ok('text' in r && r.text.includes('Juve | 1996–97 | 29 | 5'));
  assert.equal([...store.data.values()][0].expiresAt, 7 * 24 * 60 * 60 * 1000);
});

await test('history lookups file into the ledger as their own kinds', async () => {
  const outcome = historyOutcome({ found: true, title: 'Zed Player', text: 'career', sources: ['w'], missing: [] }, 'career_record');
  assert.equal(outcome.result?.kind, 'career_record');
  assert.equal(historyOutcome({ found: false, status: 'not_covered', reason: 'in progress', missing: [] }, 'season_record').status, 'not_covered');
  const calls = sanitizeCalls(
    [
      { tool: 'club_season', subject: 'Arsenal', season: '2003-04' },
      { tool: 'club_season', subject: 'Arsenal' },
      { tool: 'club_season', subject: 'Arsenal', season: '2004-05' },
      { tool: 'player_career', subject: 'Thierry Henry' },
    ],
    6,
  );
  assert.deepEqual(calls.map((c) => `${c.tool}:${c.season ?? ''}`), ['club_season:2003-04', 'club_season:2004-05', 'player_career:']);
  const seen: string[] = [];
  const tools = {
    clubSeason: async (club: string, season: string) => (seen.push(`${club} ${season}`), outcome),
    playerCareer: async (name: string) => (seen.push(name), outcome),
  } as unknown as ResearchToolset;
  await executeCall(calls[0], tools);
  await executeCall(calls[2], tools);
  assert.deepEqual(seen, ['Arsenal 2003-04', 'Thierry Henry']);
});

// --- Consistency with the cards ---------------------------------------------------------------

await test('a ranking is reordered to agree with the cards, uncarded entries keep their places', () => {
  const standings = [card('Alessandro Nesta', 92), card('Fabio Cannavaro', 91), card('John Terry', 89)].map(toStanding);
  const check = checkOrderAgainstCards(['John Terry', 'Rio Ferdinand', 'Fabio Cannavaro (Juventus)', 'Nesta'], standings);
  assert.deepEqual(check.order, ['Nesta', 'Rio Ferdinand', 'Fabio Cannavaro (Juventus)', 'John Terry']);
  assert.equal(check.carded.length, 3);
  assert.ok(check.moves[0].startsWith('Nesta above John Terry, Fabio Cannavaro (Juventus)'));
  // Already in card order: nothing moves.
  assert.deepEqual(checkOrderAgainstCards(['Nesta', 'Terry'], standings).moves, []);
});

await test('level cards fall back to peer placement, then the proposed order', () => {
  const a = toStanding(card('Player One', 90, { peerPlacement: { betterThan: ['Player Two'], levelWith: [], notAsGoodAs: [] } }));
  const b = toStanding(card('Player Two', 90));
  const c = toStanding(card('Player Three', 90));
  assert.ok(cardAbove(a, b) && !cardAbove(b, a));
  assert.deepEqual(checkOrderAgainstCards(['Player Two', 'Player One'], [a, b]).order, ['Player One', 'Player Two']);
  assert.deepEqual(checkOrderAgainstCards(['Player Three', 'Player Two'], [b, c]).order, ['Player Three', 'Player Two']);
});

await test("a head-to-head verdict follows the cards only when they settle the question", () => {
  const standings = [card('Zinedine Zidane', 94), card('Kaká', 91)].map(toStanding);
  const flipped = checkVerdictAgainstCards('Kaká', ['Zinedine Zidane', 'Kaká'], standings, 'peak_level');
  assert.equal(flipped.verdict, 'Zinedine Zidane');
  assert.ok(flipped.changed && flipped.note?.includes('94'));
  assert.equal(checkVerdictAgainstCards('Zidane', ['Zinedine Zidane', 'Kaká'], standings, 'mixed').changed, false);
  // Output isn't what a card rates.
  assert.equal(checkVerdictAgainstCards('Kaká', ['Zinedine Zidane', 'Kaká'], standings, 'output').changed, false);
});

await test('a name matches a card by slug or a unique surname, never ambiguously', () => {
  const standings = [card('Ronaldo Nazário', 95), card('Cristiano Ronaldo', 94), card('Paolo Maldini', 93)].map(toStanding);
  assert.equal(matchStanding('Maldini', standings)?.name, 'Paolo Maldini');
  assert.equal(matchStanding('Prime Paolo Maldini', standings)?.name, 'Paolo Maldini');
  assert.equal(matchStanding('Ronaldo', standings), null);
  // One card per player, the prime preferred, and only cards of the turn's edition.
  const current = card('Paolo Maldini', 80, { version: { id: 'c', type: 'current', label: 'Current', evaluationDate: '2026-10-01', seasonOrEra: '2026-27' } } as any);
  const era = card('Paolo Maldini', 90, { version: { id: 'e', type: 'era', label: 'Era', evaluationDate: '2026-10-01', seasonOrEra: '1988-91' } } as any);
  const held = standingsFor([era, current, card('Paolo Maldini', 93)], true);
  assert.equal(held.length, 1);
  assert.equal(held[0].overall, 93);
});

// --- Era snapshots and settled debates --------------------------------------------------------

await test('periods and subjects normalize so one season or window shares a snapshot', () => {
  assert.equal(normalizePeriod('2003-2006'), '2003-06');
  assert.equal(normalizePeriod('2003–06'), '2003-06');
  assert.equal(normalizePeriod('2008-09'), '2008-09');
  assert.equal(normalizePeriod('1998-99 to 2000-01'), '1998-01');
  assert.equal(normalizePeriod('his prime'), null);
  assert.equal(subjectFromTitle('2003–04 Arsenal F.C. season', 'club_season'), 'Arsenal F.C.');
  assert.equal(subjectFromTitle('Ronaldo (Brazilian footballer)', 'player_window'), 'Ronaldo');
});

const seasonFacts: ToolOutcome = {
  status: 'found',
  result: { kind: 'season_record', label: '2003–04 Testville F.C. season', content: 'Manager: Ada Coach. Bo Striker 30 league goals.', sources: ['w'] },
  missing: [],
};
const story = { summary: 'Unbeaten.', setup: '4-4-2', people: ['Coach: Ada Coach'], record: 'Champions, 90 points', figures: ['Bo Striker 30 league goals (Wikipedia)'], disputed: [] };

await test('an era snapshot is read once, built once, stored for good', async () => {
  const rows = new Map<string, EraRow>();
  let builds = 0;
  const store = createEraSnapshotStore({
    read: async (k) => rows.get(k) ?? null,
    write: async (r) => void rows.set(r.snapshot_key, r),
    build: async (req) => {
      builds++;
      return { ...req, story, sources: [], builtAt: '2026-11-01T00:00:00Z', version: ERA_SNAPSHOT_VERSION } as EraSnapshot;
    },
  });
  const req = { kind: 'club_season' as const, subject: 'Testville', period: '2003/04', facts: Promise.resolve(seasonFacts) };
  assert.equal(await store.stored(req), null);
  const [a, b] = await Promise.all([store.get(req), store.get({ ...req, subject: 'Testville FC' })]);
  assert.equal(builds, 1);
  assert.equal(a?.key, 'club_season:testville-fc:2003-04');
  assert.equal(b?.key, a?.key);
  assert.ok(rows.has('club_season:testville-fc:2003-04'));
  // Another process reads the stored row instead of building.
  const other = createEraSnapshotStore({ read: async (k) => rows.get(k) ?? null, write: async () => {}, build: async () => assert.fail('built twice') });
  assert.equal((await other.stored(req))?.story.summary, 'Unbeaten.');
  // A row from an older build version doesn't count.
  rows.set('club_season:testville-fc:2003-04', { ...rows.get('club_season:testville-fc:2003-04')!, version: ERA_SNAPSHOT_VERSION - 1 });
  const stale = createEraSnapshotStore({ read: async (k) => rows.get(k) ?? null, write: async () => {}, build: async () => null });
  assert.equal(await stale.stored(req), null);
});

await test('a failed build is never stored', async () => {
  const rows = new Map<string, EraRow>();
  const store = createEraSnapshotStore({ read: async () => null, write: async (r) => void rows.set(r.snapshot_key, r), build: async () => null });
  assert.equal(await store.get({ kind: 'club_season', subject: 'Testville', period: '2003-04', facts: Promise.resolve(seasonFacts) }), null);
  assert.equal(rows.size, 0);
  // No facts, no snapshot.
  assert.equal(await store.get({ kind: 'club_season', subject: 'X', period: '2003-04', facts: Promise.resolve({ status: 'empty', result: null, missing: [] }) }), null);
});

await test('a build reads the facts and two searches, and the writer reads it as an entry', async () => {
  const searched: string[] = [];
  const tools = {
    webSearch: async (q: string, o?: { context?: string }) => {
      searched.push(`${o?.context ? 'with facts: ' : ''}${q}`);
      return { status: 'found', result: { kind: 'web', label: q, content: 'analysis', sources: ['s'] }, missing: [] } as ToolOutcome;
    },
  } as unknown as ResearchToolset;
  let evidence = '';
  const snap = await buildEraSnapshot(
    { kind: 'club_season', subject: 'Testville F.C.', period: '2003-04', key: 'k' },
    seasonFacts,
    tools,
    { write: async (_req, e) => ((evidence = e), story) },
    () => Date.parse('2026-11-01T00:00:00Z'),
  );
  assert.equal(searched.length, 2);
  assert.ok(searched.every((s) => s.startsWith('with facts: ')));
  assert.ok(evidence.includes('Bo Striker 30 league goals'));
  assert.equal(snap?.version, ERA_SNAPSHOT_VERSION);
  const entry = eraEntry(snap!);
  assert.equal(entry.kind, 'era_snapshot');
  assert.ok(entry.content.includes('Figures from the sources:\n- Bo Striker 30 league goals (Wikipedia)'));
});

await test('a debate is settled by its words and its cards', async () => {
  assert.equal(debateSignature('Prime Zidane or prime Kaká?'), debateSignature('prime kaka or PRIME zidane'));
  assert.notEqual(debateSignature('Rank the top five strikers of the 1990s'), debateSignature('Rank the top ten strikers of the 1990s'));
  const fp = cardFingerprint([{ slug: 'kaka', edition: 'prime', overall: 91 }, { slug: 'zidane', edition: 'prime', overall: 94 }]);
  const rows = new Map<string, EraRow>();
  const store = createDebateStore({ read: async (k) => rows.get(k) ?? null, write: async (r) => void rows.set(r.snapshot_key, r) });
  const sig = debateSignature('Prime Zidane or prime Kaká?');
  await store.write({ signature: sig, cards: fp, brief: { verdict: 'Zidane' }, settledAt: '2026-11-01T00:00:00Z', version: ERA_SNAPSHOT_VERSION });
  const fresh = createDebateStore({ read: async (k) => rows.get(k) ?? null, write: async () => {} });
  assert.equal((await fresh.read(sig, fp))?.brief.verdict, 'Zidane');
  // A re-rated card reopens it.
  assert.equal(await fresh.read(sig, fp.replace('91', '92')), null);
  assert.equal([...rows.values()][0].kind, 'debate');
});


// --- The debate brief -------------------------------------------------------------------------

const zidane = toStanding(card('Zinedine Zidane', 96));
const kaka = toStanding(card('Kaká', 95));
const rawBrief = {
  understanding: 'Which prime was better',
  kind: 'head_to_head',
  criterion: 'peak_level',
  criteria: [{ name: 'Control of big matches', why: 'Both were judged on them' }],
  versions: [{ subject: 'Zinedine Zidane', period: '1999-02' }, { subject: 'Kaká', period: '2005-07' }],
  disagreement: 'Peak brilliance against range',
  counterCase: 'Kaká was more direct',
  verdict: 'Kaká, narrowly',
  ranking: [],
  outline: ['Big matches'],
  calls: [
    { tool: 'player_career', subject: 'Kaká', purpose: 'his numbers in the window' },
    { tool: 'club_season', subject: 'AC Milan', season: '2006-07', purpose: 'the side around him' },
    { tool: 'nonsense', subject: 'x' },
  ],
};

await test('the debate brief prompt names the cards and their order, and no examples', () => {
  const prompt = buildDebateBriefPrompt({ message: 'Prime Zidane or prime Kaká?', thread: '', cards: [kaka, zidane], hints: { clubs: [], players: [] } });
  assert.ok(prompt.indexOf("1. Zinedine Zidane's prime (2003-06) card, 96") < prompt.indexOf("2. Kaká's prime"));
  assert.ok(prompt.includes('club_season (subject: club name; season: YYYY-YY)'));
});

await test('a brief is read defensively and its verdict held to the cards', () => {
  const brief = readDebateBrief(rawBrief, { message: 'q' });
  assert.equal(brief.calls.length, 2);
  assert.equal(brief.calls[1].season, '2006-07');
  const checked = checkBriefAgainstCards(brief, [zidane, kaka]);
  assert.equal(checked.verdict, 'Zinedine Zidane');
  assert.ok(checked.cardNotes[0].includes('96'));
  // A question about output isn't settled by the cards.
  assert.equal(checkBriefAgainstCards({ ...brief, criterion: 'output' }, [zidane, kaka]).verdict, 'Kaká, narrowly');
  const ranking = checkBriefAgainstCards({ ...brief, kind: 'ranking', verdict: '', ranking: ['Kaká', 'Zidane'] }, [zidane, kaka]);
  assert.deepEqual(ranking.ranking, ['Zidane', 'Kaká']);
  const text = formatDebateBriefForWriter(ranking, [zidane, kaka]);
  assert.ok(text.includes('The order, settled before writing (keep it): 1. Zidane 2. Kaká'));
  assert.ok(text.includes('The strongest case against the verdict'));
});

const careerFacts: ToolOutcome = {
  status: 'found',
  result: { kind: 'career_record', label: 'Kaká', content: 'Milan 2006–07 Serie A 31 apps 8 goals', sources: ['w'] },
  missing: [],
};
const fakeTools = (log: string[]) =>
  ({
    playerCareer: async (n: string) => (log.push(`career ${n}`), careerFacts),
    clubSeason: async (c: string, s: string) => (log.push(`season ${c} ${s}`), { ...seasonFacts, result: { ...seasonFacts.result!, label: '2006–07 A.C. Milan season' } }),
  }) as unknown as ResearchToolset;

await test('debate research runs the lookups, attaches stored era snapshots and builds missing ones', async () => {
  const log: string[] = [];
  const stored = new Set(['player_window']);
  const built: string[] = [];
  const eras = {
    stored: async (req: any) =>
      stored.has(req.kind) ? ({ key: 'k', kind: req.kind, subject: req.subject, period: '2005-07', story, sources: [], builtAt: '', version: 1 } as EraSnapshot) : null,
    get: async (req: any) => (built.push(`${req.kind} ${req.period}`), null),
  };
  const writes: any[] = [];
  const debates = { read: async () => null, settledAny: async () => false, write: async (r: any) => void writes.push(r) };
  let briefs = 0;
  const { brief, ledger } = await runDebateResearch(
    { message: 'Prime Zidane or prime Kaká?', thread: '', cards: [zidane, kaka], hints: { clubs: [], players: [] } },
    fakeTools(log),
    { model: { writeBrief: async () => (briefs++, readDebateBrief(rawBrief, { message: '' })) }, eras, debates },
  );
  assert.equal(briefs, 1);
  assert.equal(brief.verdict, 'Zinedine Zidane');
  assert.deepEqual(log, ['career Kaká', 'season AC Milan 2006-07']);
  assert.deepEqual(ledger.entries.map((e) => e.kind), ['career_record', 'season_record', 'era_snapshot']);
  assert.ok(ledger.entries[2].label.includes('the window his card rates'));
  assert.deepEqual(built, ['club_season 2006-07']);
  // The checked brief is settled for next time.
  assert.equal(writes.length, 1);
  assert.equal((writes[0].brief as DebateBrief).verdict, 'Zinedine Zidane');
});

await test('a settled debate is reused without a brief call; a follow-up never is', async () => {
  const settled = { signature: 's', cards: 'c', brief: { ...rawBrief, verdict: 'Zinedine Zidane', calls: [] }, settledAt: '2026-11-01T00:00:00Z', version: 1 };
  const debates = { read: async () => settled, settledAny: async () => true, write: async () => assert.fail('rewrote a settled debate') };
  const model = { writeBrief: async () => assert.fail('wrote a new brief') };
  const { brief } = await runDebateResearch(
    { message: 'Prime Zidane or prime Kaká?', thread: '', cards: [zidane, kaka], hints: { clubs: [], players: [] } },
    fakeTools([]),
    { model: model as any, debates },
  );
  assert.ok(brief.settled);
  assert.equal(brief.verdict, 'Zinedine Zidane');
  let wrote = 0;
  await runDebateResearch(
    { message: 'and at Madrid?', thread: '<ongoing_thread>…</ongoing_thread>', cards: [], hints: { clubs: [], players: [] } },
    fakeTools([]),
    {
      model: { writeBrief: async () => (wrote++, readDebateBrief({ verdict: 'x' }, { message: '' })) },
      debates: { read: async () => assert.fail('read'), settledAny: async () => assert.fail('read'), write: async () => assert.fail('wrote') },
    },
  );
  assert.equal(wrote, 1);
});

await test('a question that looks like it is about the past starts its brief early, without the cards', async () => {
  assert.ok(looksLikePastQuestion('Prime Zidane or prime Kaká?'));
  assert.ok(looksLikePastQuestion('Rank the best centre-backs of the 2000s'));
  assert.ok(looksLikePastQuestion('How did Barcelona play in 2008-09?'));
  assert.ok(!looksLikePastQuestion('How is Barcelona pressing this season?'));
  assert.ok(!looksLikePastQuestion('rate prime Kaká'));
  const seen: any[] = [];
  const model = { writeBrief: async (ctx: any) => (seen.push(ctx), readDebateBrief(rawBrief, ctx)) };
  const brief = await startDebateBrief('Prime Zidane or prime Kaká?', { model, debates: { read: async () => null, settledAny: async () => false, write: async () => {} } });
  assert.equal(brief?.verdict, 'Kaká, narrowly');
  assert.equal(seen[0].cardsPending, true);
  assert.ok(buildDebateBriefPrompt(seen[0]).includes('checked against your verdict separately'));
  // Settled before: no brief at all.
  assert.equal(await startDebateBrief('Prime Zidane or prime Kaká?', { model, debates: { read: async () => null, settledAny: async () => true, write: async () => {} } }), null);
  assert.equal(startDebateBrief('Who is injured at Arsenal right now?', { model }), null);
  // The early brief is used, and still held to the cards.
  const { brief: used } = await runDebateResearch(
    { message: 'Prime Zidane or prime Kaká?', thread: '', cards: [zidane, kaka], hints: { clubs: [], players: [] } },
    fakeTools([]),
    { model: { writeBrief: async () => assert.fail('wrote a second brief') }, early: Promise.resolve(readDebateBrief(rawBrief, { message: '' })) },
  );
  assert.equal(used.verdict, 'Zinedine Zidane');
});

await test('a slow web search is left out of the answer instead of holding it back', async () => {
  const slowBrief = readDebateBrief(
    { ...rawBrief, calls: [{ tool: 'player_career', subject: 'Kaká', purpose: 'p' }, { tool: 'web_search', subject: 'Kaká contemporary reports', purpose: 'p' }] },
    { message: '' },
  );
  const tools = {
    ...fakeTools([]),
    webSearch: () => new Promise<ToolOutcome>((resolve) => setTimeout(() => resolve({ status: 'found', result: { kind: 'web', label: 'late', content: 'late' }, missing: [] }), 200)),
  } as unknown as ResearchToolset;
  const { ledger } = await runDebateResearch(
    { message: 'Prime Zidane or prime Kaká?', thread: '', cards: [zidane, kaka], hints: { clubs: [], players: [] } },
    tools,
    { model: { writeBrief: async () => slowBrief }, searchBudgetMs: 20 },
  );
  assert.deepEqual(ledger.entries.map((e) => e.kind), ['career_record']);
  assert.ok(ledger.gaps.some((g) => g.label.includes('took too long') && g.status === 'empty'));
});

// --- The historical eval's pure parts ---------------------------------------------------------

await test('the eval reads its question set, paraphrase pairs and the grader replies', async () => {
  const questions = readQuestionTable(new URL('../docs/superpowers/evals/historical-questions.md', import.meta.url).pathname);
  assert.equal(questions.length, 14);
  assert.deepEqual(paraphrasePairs(questions), [[1, 13], [5, 14]]);
  const grade = parseHistoryGrade('```json\n{"wrongFigures":[{"claim":"x","why":"y"}],"blendedSeasons":[],"myths":[],"criteria":4,"counterCase":"yes","decisiveness":5,"verdict":"A","notes":"n"}\n```');
  assert.equal(grade?.wrongFigures.length, 1);
  assert.equal(grade?.counterCase, 'yes');
  assert.equal(parseHistoryGrade('not json'), null);
  assert.equal(parseAgreement('{"agreement":"partly","why":"order"}')?.agreement, 'partly');
  assert.equal(parseAgreement('{"agreement":"maybe"}'), null);
  // The figure check lists the figures, then checks each with search.
  const prompts: boolean[] = [];
  const check = await checkFigures('He scored 30 league goals and won 5 titles.', async (_p, withSearch) => {
    prompts.push(withSearch);
    return withSearch
      ? '{"results":[{"n":1,"verdict":"correct"},{"n":2,"verdict":"wrong","note":"two titles"}]}'
      : '{"claims":["Henry scored 30 league goals in 2003-04","Henry won 5 titles in 2003-04"]}';
  });
  assert.deepEqual(prompts, [false, true]);
  assert.equal(check?.stated, 2);
  assert.deepEqual(check?.wrong, [{ claim: 'Henry won 5 titles in 2003-04', note: 'two titles' }]);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
