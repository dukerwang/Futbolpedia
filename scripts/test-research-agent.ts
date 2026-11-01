#!/usr/bin/env npx tsx
/**
 * Offline checks for chat research, with the model and the tools faked: the brief's lookups run
 * in one parallel round, the reflect step can add a second round that never repeats the first,
 * research stops after one round when time runs short, a failed brief falls back to the names in
 * the message, and the writer gets the brief with anything research couldn't establish.
 *
 * Usage:
 *   npx tsx scripts/test-research-agent.ts
 */
import assert from 'node:assert/strict';
import {
  buildBriefPrompt,
  describeRound,
  fallbackBrief,
  formatBriefForWriter,
  REFLECT_CUTOFF_MS,
  looksLikePresentQuestion,
  RESEARCH_DEADLINE_MS,
  runResearch,
  startQuestionSearch,
  type ResearchBrief,
  type ResearchContext,
  type ResearchModel,
} from '../services/researchAgent';
import {
  formatLeagueTable,
  RESEARCH_COVERAGE_NOTE,
  runCalls,
  sanitizeCalls,
  type ResearchToolset,
  type ToolOutcome,
} from '../services/researchTools';
import { addEvidence, emptyLedger } from '../services/evidenceLedger';
import { buildReflectPrompt } from '../services/researchAgent';
import type { SnapshotSource } from '../services/clubSnapshots';
import type { ClubSnapshot, SituationInput, SituationModel } from '../services/situationSnapshot';
import type { LiveClubReport } from '../services/liveFootball';

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

const ctx: ResearchContext = {
  message: "Break down Club's build-up shape this season",
  thread: '',
  cardsInPlay: [],
  hints: { clubs: ['Club'], players: [] },
};

/** Tools that record what was asked and answer from a fixed table; anything else finds nothing. */
const fakeTools = (found: Record<string, string>, calls: string[] = [], contexts: Record<string, string | undefined> = {}): ResearchToolset => {
  const answer = (key: string, kind: 'web' | 'player_record' | 'league_table' | 'card'): Promise<ToolOutcome> => {
    calls.push(key);
    return Promise.resolve(
      found[key] ? { status: 'found', result: { kind, label: key, content: found[key] }, missing: [] } : { status: 'empty', result: null, missing: [] },
    );
  };
  return {
    clubRecentTeam: (club) => {
      calls.push(`club:${club}`);
      return Promise.resolve(
        found[`club:${club}`]
          ? {
              status: 'found',
              result: { kind: 'club_context', label: `${club}: recent team`, content: found[`club:${club}`] },
              missing: [{ item: `Injury list for ${club} (no free source outside the Premier League)`, status: 'not_covered' }],
            }
          : { status: 'empty', result: null, missing: [] },
      );
    },
    playerSeason: (name) => answer(`player:${name}`, 'player_record'),
    leagueTable: (league) => answer(`table:${league}`, 'league_table'),
    webSearch: (query, options) => {
      contexts[query] = options?.context;
      return answer(`web:${query}`, 'web');
    },
    card: (name) => answer(`card:${name}`, 'card'),
  };
};

const brief = (calls: ResearchBrief['calls']): ResearchBrief => ({
  understanding: 'Who plays and how the team builds up',
  focus: 'What is new in the build-up this season, and why',
  timeframe: 'live',
  outline: ['Who has been starting', 'First phase', 'Trade-offs'],
  calls,
  unresolved: [],
});

await test("the model's calls are cleaned: known tools, a subject, no repeats, capped", () => {
  const calls = sanitizeCalls(
    [
      { tool: 'club_recent_team', subject: ' Club ', purpose: 'who plays' },
      { tool: 'club_recent_team', subject: 'club' },
      { tool: 'teleport', subject: 'Club' },
      { tool: 'web_search', subject: '' },
      { tool: 'card', subject: 'Some Player', edition: 'prime' },
      { tool: 'league_table', subject: 'Premier League', country: 'England' },
    ],
    2,
  );
  assert.deepEqual(calls, [
    { tool: 'club_recent_team', subject: 'Club', purpose: 'who plays' },
    { tool: 'card', subject: 'Some Player', edition: 'prime' },
  ]);
  // A second round never repeats the first.
  assert.equal(sanitizeCalls([{ tool: 'club_recent_team', subject: 'CLUB' }], 3, calls).length, 0);
});

await test('a round runs every call and files findings and gaps', async () => {
  const asked: string[] = [];
  const ledger = await runCalls(
    [
      { tool: 'club_recent_team', subject: 'Club' },
      { tool: 'web_search', subject: 'Club build-up analysis' },
      { tool: 'web_search', subject: 'Club transfers' },
    ],
    fakeTools({ 'club:Club': 'Recent Starting XIs …', 'web:Club build-up analysis': 'Analysis …' }, asked),
    emptyLedger(),
  );
  assert.deepEqual(asked, ['club:Club', 'web:Club build-up analysis', 'web:Club transfers']);
  assert.deepEqual(ledger.entries.map((e) => e.id), ['E1', 'E2']);
  assert.deepEqual(ledger.gaps, [
    { label: 'Injury list for Club (no free source outside the Premier League)', status: 'not_covered' },
    { label: 'Web search: Club transfers', status: 'empty' },
  ]);
  assert.deepEqual(
    ledger.lookups.map((l) => `${l.tool}:${l.status}`),
    ['club_recent_team:found', 'web_search:found', 'web_search:empty'],
  );
  assert.match(ledger.lookups[0].note ?? '', /Injury list for Club .*\[not covered\]/);
});

await test('reflect adds a second round only when the first left a gap', async () => {
  const asked: string[] = [];
  const model: ResearchModel = {
    writeBrief: async () => brief([{ tool: 'club_recent_team', subject: 'Club' }]),
    reflect: async () => ({
      enough: false,
      calls: [{ tool: 'web_search', subject: 'Club injury news' }],
      unresolved: ['How long the injured centre-back is out'],
      discard: [],
    }),
  };
  const stages: string[] = [];
  const { brief: final, ledger } = await runResearch(ctx, fakeTools({ 'club:Club': 'XIs', 'web:Club injury news': 'News' }, asked), {
    model,
    onStage: (s) => stages.push(s),
  });
  assert.deepEqual(asked, ['club:Club', 'web:Club injury news']);
  assert.equal(ledger.entries.length, 2);
  assert.deepEqual(final.unresolved, ['How long the injured centre-back is out']);
  assert.deepEqual(stages, [
    'Working out what the question needs...',
    'Checking Club recent team...',
    'Reading the evidence...',
    'Checking 1 search...',
  ]);
});

await test('a question that needs no lookups skips research', async () => {
  const model: ResearchModel = {
    writeBrief: async () => ({ ...brief([]), timeframe: 'historical' }),
    reflect: async () => assert.fail('reflect should not run'),
  };
  const { brief: final, ledger } = await runResearch(ctx, fakeTools({}), { model });
  assert.equal(final.timeframe, 'historical');
  assert.equal(ledger.entries.length + ledger.gaps.length, 0);
});

await test('research stops after one round when the turn is running long', async () => {
  let clock = 0;
  const model: ResearchModel = {
    writeBrief: async () => {
      clock += REFLECT_CUTOFF_MS;
      return brief([{ tool: 'club_recent_team', subject: 'Club' }]);
    },
    reflect: async () => assert.fail('reflect should be skipped'),
  };
  const { ledger } = await runResearch(ctx, fakeTools({ 'club:Club': 'XIs' }), { model, now: () => clock });
  assert.equal(ledger.entries.length, 1);
});

await test('a failed brief plans from the names in the message', async () => {
  const asked: string[] = [];
  const model: ResearchModel = {
    writeBrief: async () => {
      throw new Error('model unavailable');
    },
    reflect: async () => ({ enough: true, calls: [], unresolved: [], discard: [] }),
  };
  await runResearch(ctx, fakeTools({}, asked), { model });
  assert.deepEqual(asked, ['club:Club', `web:${ctx.message}`]);
  assert.equal(fallbackBrief(ctx).calls.length, 2);
});

await test("the writer's brief carries the outline and what couldn't be established", () => {
  const text = formatBriefForWriter({ ...brief([]), unresolved: ['Who starts on the left'] });
  assert.match(text, /What the user is asking: Who plays and how the team builds up/);
  assert.match(text, /What's distinctive this season, for the answer to lead with: What is new in the build-up/);
  assert.match(text, /- First phase/);
  assert.match(text, /couldn't establish: Who starts on the left/);
  assert.doesNotMatch(formatBriefForWriter(brief([])), /couldn't establish/);
});

await test('the brief prompt lists the tools and the names spotted, and asks for purposes', () => {
  const prompt = buildBriefPrompt({ ...ctx, cardsInPlay: ['Some Player (prime)'] });
  for (const tool of ['club_recent_team', 'player_season', 'league_table', 'web_search', 'card']) {
    assert.match(prompt, new RegExp(`- ${tool} `));
  }
  assert.match(prompt, /Names spotted in the message: Club/);
  assert.match(prompt, /Cards already in play: Some Player \(prime\)/);
  assert.match(prompt, /Each call needs a purpose/);
  // Change leads, in two stages, with the sources' limits spelled out.
  assert.match(prompt, /what is distinctive about this team or player this season/);
  assert.match(prompt, /stage "facts"/);
  assert.match(prompt, /stage "analysis"/);
  assert.ok(prompt.includes(RESEARCH_COVERAGE_NOTE));
  assert.doesNotMatch(prompt, /Already loaded/);
  assert.match(buildBriefPrompt({ ...ctx, storedSnapshots: [{ club: 'Club', asOf: '2026-11-01' }] }), /Already loaded: today's stored snapshot for Club \(as of 2026-11-01\)/);
});

await test('progress lines and league tables read plainly', () => {
  assert.equal(
    describeRound([
      { tool: 'club_recent_team', subject: 'Club' },
      { tool: 'web_search', subject: 'a' },
      { tool: 'web_search', subject: 'b' },
      { tool: 'player_season', subject: 'c' },
    ]),
    'Checking Club recent team, 2 searches, 1 more lookup...',
  );
  assert.equal(
    formatLeagueTable([
      { rank: 1, team: 'Club', group: null, played: 10, won: 8, drawn: 1, lost: 1, goalDiff: 15, points: 25, form: 'WWDWL' },
      { rank: 2, team: 'Other', group: null, played: 10, won: 7, drawn: 1, lost: 2, goalDiff: -2, points: 22, form: null },
    ]),
    '1. Club — 25 pts, P10 W8 D1 L1, GD +15, form WWDWL\n2. Other — 22 pts, P10 W7 D1 L2, GD -2',
  );
});


// --- Two stages, snapshots and the situation step ---------------------------------------------

/** A club report with one XI repeated, enough for the snapshot to work out a core. */
const clubReport = (team: string): LiveClubReport => {
  const match = { id: 'm1', date: '2026-10-25', competition: 'Premier League', leagueSlug: 'eng.1', home: true, opponent: 'Rivals', completed: true, goalsFor: 2, goalsAgainst: 0, penaltiesFor: null, penaltiesAgainst: null };
  const roles = ['G', 'LB', 'CD-L', 'CD-R', 'RB', 'DM', 'CM-L', 'CM-R', 'LF', 'F', 'RF'];
  return {
    team,
    league: 'Premier League',
    lineups: [{ match, formation: '4-3-3', starters: roles.map((role, i) => ({ name: `${team} Player ${i + 1}`, role })), subsUsed: [] }],
    results: [match],
    fixtures: [],
    fplPlayers: null,
    asOf: '2026-11-01',
  };
};

/** Tools whose club lookups carry a structured report. */
const reportTools = (asked: string[], contexts: Record<string, string | undefined>): ResearchToolset => ({
  ...fakeTools({ 'web:Club tactical analysis 2026-27': 'Analysis', 'web:Club transfers 2026-27': 'Transfers' }, asked, contexts),
  clubRecentTeam: async (club) => {
    asked.push(`club:${club}`);
    return { status: 'found', result: { kind: 'club_context', label: club, content: 'XIs', club: clubReport(club) }, missing: [] };
  },
});

const noModel: SituationModel = { enrich: async () => assert.fail('the situation call should not run') };

await test('analysis searches start after the live facts and read their sources against them; fact searches do not', async () => {
  const asked: string[] = [];
  const contexts: Record<string, string | undefined> = {};
  const model: ResearchModel = {
    writeBrief: async () =>
      brief([
        { tool: 'web_search', subject: 'Club tactical analysis 2026-27', stage: 'analysis' },
        { tool: 'web_search', subject: 'Club transfers 2026-27', stage: 'facts' },
      ]),
    reflect: async () => ({ enough: true, calls: [], unresolved: [], discard: [] }),
  };
  const inputs: SituationInput[] = [];
  const situationModel: SituationModel = {
    enrich: async (input) => {
      inputs.push(input);
      return { clubs: [{ club: 'Club', changes: ['A new left-back arrived in August'], distinctive: 'Builds through a back three.', newsAbsences: [], unknowns: [] }], players: [], unknowns: [] };
    },
  };
  const { ledger, situation } = await runResearch(ctx, reportTools(asked, contexts), { model, situationModel });
  assert.match(contexts['Club tactical analysis 2026-27'] ?? '', /^Club, as of 2026-11-01: regular starters Club Player 1, .*\(4-3-3\); last results W\./);
  assert.equal(contexts['Club transfers 2026-27'], undefined);
  // Club first, then facts, then analysis; the analysis entry is marked as such.
  assert.deepEqual(ledger.entries.map((e) => [e.id, e.kind, e.stage ?? '']), [
    ['E1', 'club_context', 'facts'],
    ['E2', 'web', 'facts'],
    ['E3', 'web', 'analysis'],
  ]);
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0].clubs.map((c) => c.club), ['Club']);
  assert.equal(situation?.clubs[0].distinctive, 'Builds through a back three.');
  assert.equal(situation?.clubs[0].xi.length, 11);
});

/** A snapshot source that serves `stored` and records what it was asked to build. */
const fakeSnapshots = (stored: Record<string, ClubSnapshot>, builds: string[] = [], researched: string[] = []): SnapshotSource => ({
  stored: async (club) => stored[club] ?? null,
  research: async (club) => {
    researched.push(club);
    return {
      calls: [{ tool: 'web_search', subject: `${club} changes since last season`, stage: 'facts' }],
      outcomes: [{ status: 'found', result: { kind: 'web', label: `${club} changes since last season`, content: '[2026-08-01] A new coach.' }, missing: [] }],
    };
  },
  get: async (club) => {
    if (stored[club]) return stored[club];
    builds.push(club);
    return null;
  },
});

const snapshotOf = (club: string): ClubSnapshot => ({
  club,
  league: 'Premier League',
  core: { club, league: 'Premier League', asOf: '2026-11-01', formation: '4-3-3', matchesRead: 1, xi: [], xiBasis: 'lineups', out: [], outCovered: true, form: [], record: 'W', nextFixture: null },
  story: { changes: ['A new coach since the summer'], distinctive: 'Presses far higher than last season.', newsAbsences: [], unknowns: [] },
  sources: [],
  builtAt: '2026-11-01T08:00:00Z',
  version: 1,
});

await test("a stored snapshot reaches the brief and stands in for the situation call", async () => {
  const asked: string[] = [];
  const seen: ResearchContext[] = [];
  const model: ResearchModel = {
    writeBrief: async (c) => {
      seen.push(c);
      return brief([]);
    },
    reflect: async () => ({ enough: true, calls: [], unresolved: [], discard: [] }),
  };
  const { situation, ledger } = await runResearch({ ...ctx, present: true }, reportTools(asked, {}), {
    model,
    situationModel: noModel,
    snapshots: fakeSnapshots({ Club: snapshotOf('Club') }),
  });
  assert.deepEqual(seen[0].storedSnapshots, [{ club: 'Club', asOf: '2026-11-01' }]);
  // The brief planned nothing, but a question about the present still gets the club's live data.
  // With today's snapshot for every club, there's no research pass and no wait on a search.
  assert.deepEqual(asked, ['club:Club']);
  assert.deepEqual(seen[0].running, []);
  assert.equal(ledger.entries.length, 1);
  assert.equal(situation?.clubs[0].distinctive, 'Presses far higher than last season.');
  // The live core wins over the stored one: today's XI, the stored story.
  assert.equal(situation?.clubs[0].xi.length, 11);
});

await test('a missing snapshot is built for a question about the present, and never for one about the past', async () => {
  const builds: string[] = [];
  const asked: string[] = [];
  const live: ResearchModel = {
    writeBrief: async () => brief([]),
    reflect: async () => ({ enough: true, calls: [], unresolved: [], discard: [] }),
  };
  const situationModel: SituationModel = { enrich: async () => ({ clubs: [], players: [], unknowns: [] }) };
  await runResearch({ ...ctx, present: true }, reportTools(asked, {}), { model: live, situationModel, snapshots: fakeSnapshots({}, builds) });
  assert.deepEqual(builds, ['Club']);

  const pastBuilds: string[] = [];
  const pastAsked: string[] = [];
  const past: ResearchModel = { writeBrief: async () => ({ ...brief([]), timeframe: 'historical' }), reflect: async () => assert.fail('no reflect') };
  const result = await runResearch({ ...ctx, present: false }, reportTools(pastAsked, {}), { model: past, snapshots: fakeSnapshots({}, pastBuilds) });
  assert.deepEqual(pastBuilds, []);
  assert.deepEqual(pastAsked, []);
  assert.equal(result.situation, null);
});

await test('reflect sets aside stale web sources and reads the lookup log and coverage note', async () => {
  const model: ResearchModel = {
    writeBrief: async () =>
      brief([
        { tool: 'club_recent_team', subject: 'Club' },
        { tool: 'web_search', subject: 'Club tactical analysis 2026-27', stage: 'analysis' },
      ]),
    reflect: async (_b, l) => ({ enough: true, calls: [], unresolved: [], discard: l.entries.filter((e) => e.kind === 'web').map((e) => ({ id: e.id, reason: 'describes last season' })) }),
  };
  const { ledger } = await runResearch(ctx, reportTools([], {}), { model, situationModel: { enrich: async () => ({ clubs: [], players: [], unknowns: [] }) } });
  assert.deepEqual(ledger.entries.map((e) => e.kind), ['club_context']);
  assert.deepEqual(ledger.discarded.map((d) => d.reason), ['describes last season']);

  let l = addEvidence(emptyLedger(), { kind: 'web', label: 'Club tactics', content: '[2025-03-01] A back three.' });
  l = { ...l, lookups: [{ tool: 'player_season', subject: 'Someone', status: 'not_covered' }] };
  const prompt = buildReflectPrompt(brief([]), l);
  assert.match(prompt, /player_season "Someone": not covered by any source/);
  assert.match(prompt, /Club tactics \(every source here predates this season/);
  assert.match(prompt, /What it should settle about this season: What is new in the build-up/);
  assert.ok(prompt.includes(RESEARCH_COVERAGE_NOTE));
});

await test('past the cutoff, the situation snapshot is what code worked out, without the model', async () => {
  let clock = 0;
  const model: ResearchModel = {
    writeBrief: async () => {
      clock += 20_000;
      return brief([{ tool: 'club_recent_team', subject: 'Club' }]);
    },
    reflect: async () => assert.fail('reflect should be skipped'),
  };
  const { situation } = await runResearch(ctx, reportTools([], {}), { model, situationModel: noModel, now: () => clock });
  assert.equal(situation?.clubs[0].club, 'Club');
  assert.equal(situation?.clubs[0].distinctive, undefined);
});

await test("a club with no snapshot gets a research pass the turn reads, and the brief hears what's running", async () => {
  const asked: string[] = [];
  const researched: string[] = [];
  const seen: ResearchContext[] = [];
  const model: ResearchModel = {
    writeBrief: async (c) => {
      seen.push(c);
      // The brief repeats the question search; it isn't run twice.
      return brief([{ tool: 'web_search', subject: ctx.message, stage: 'facts' }]);
    },
    reflect: async () => ({ enough: true, calls: [], unresolved: [], discard: [] }),
  };
  const situationModel: SituationModel = { enrich: async () => ({ clubs: [], players: [], unknowns: [] }) };
  const { ledger } = await runResearch({ ...ctx, present: true }, reportTools(asked, {}), { model, situationModel, snapshots: fakeSnapshots({}, [], researched) });
  assert.deepEqual(researched, ['Club']);
  assert.equal(seen[0].running?.length, 2);
  assert.match(seen[0].running![1], /^for Club, searches on what changed since last season/);
  assert.deepEqual(asked.filter((a) => a.startsWith('web:')), [`web:${ctx.message}`]);
  assert.deepEqual(ledger.entries.map((e) => e.label), ['Club', 'Club changes since last season']);
});

await test('a web search that cannot finish by the deadline is not started, and a slow lookup is left out at the deadline', async () => {
  let clock = 0;
  const asked: string[] = [];
  const tools: ResearchToolset = {
    ...fakeTools({ 'table:League': 'Table' }, asked),
    // A feed that never answers.
    playerSeason: () => new Promise(() => {}),
  };
  const model: ResearchModel = {
    writeBrief: async () => {
      // 300 ms left: too little for any search, and a short wait for the slow feed.
      clock = RESEARCH_DEADLINE_MS - 300;
      return brief([
        { tool: 'web_search', subject: 'Club analysis', stage: 'analysis' },
        { tool: 'league_table', subject: 'League' },
        { tool: 'player_season', subject: 'Someone' },
      ]);
    },
    reflect: async () => ({ enough: true, calls: [], unresolved: [], discard: [] }),
  };
  const started = Date.now();
  const { ledger } = await runResearch({ ...ctx, hints: { clubs: [], players: [] } }, tools, {
    model,
    situationModel: { enrich: async () => ({ clubs: [], players: [], unknowns: [] }) },
    now: () => clock + (Date.now() - started),
  });
  assert.ok(!asked.includes('web:Club analysis'), 'the search was never started');
  assert.ok(asked.includes('table:League'));
  assert.ok(Date.now() - started < 2_000, 'research stopped at the deadline');
  assert.deepEqual(ledger.entries.map((e) => e.kind), ['league_table']);
  const notes = ledger.lookups.map((l) => `${l.tool}:${l.status}:${l.note ?? ''}`);
  assert.ok(notes.includes('web_search:failed:not started: no time left for a web search'));
  assert.ok(notes.includes('player_season:failed:still running when the writer started'));
});

await test('a lookup that misses the deadline but finishes while reflect and the snapshot run still reaches the writer', async () => {
  let clock = 0;
  const started = Date.now();
  const tools: ResearchToolset = {
    ...fakeTools({}),
    // Answers 150 ms after the deadline, inside the situation call's 300 ms.
    leagueTable: () => new Promise((r) => setTimeout(() => r({ status: 'found', result: { kind: 'league_table', label: 'League', content: 'Table' }, missing: [] }), 250)),
  };
  const model: ResearchModel = {
    writeBrief: async () => {
      clock = RESEARCH_DEADLINE_MS - 100;
      return brief([{ tool: 'league_table', subject: 'League' }]);
    },
    reflect: async () => assert.fail('a turn that ran to the deadline skips reflect'),
  };
  const situationModel: SituationModel = {
    enrich: async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { clubs: [], players: [], unknowns: [] };
    },
  };
  const { ledger } = await runResearch({ ...ctx, hints: { clubs: [], players: ['Someone'] } }, tools, {
    model,
    situationModel,
    now: () => clock + (Date.now() - started),
  });
  assert.deepEqual(ledger.entries.map((e) => e.kind), ['league_table']);
  assert.ok(!ledger.gaps.some((g) => /League/.test(g.label)));
});

await test('a question about the present starts its search during routing, and research uses that search rather than a second one', async () => {
  assert.equal(looksLikePresentQuestion("How is Liverpool's midfield set up right now?"), true);
  assert.equal(looksLikePresentQuestion("Who's injured at Manchester City at the moment?"), true);
  assert.equal(looksLikePresentQuestion('Prime Zidane or prime Kaká?'), false);
  assert.equal(looksLikePresentQuestion('Rank the best centre-backs of the 2000s'), false);
  assert.equal(looksLikePresentQuestion('rate Bukayo Saka'), false);

  const asked: string[] = [];
  const tools = fakeTools({ [`web:${ctx.message}`]: 'Found early.' }, asked);
  const early = startQuestionSearch("Break down Club's build-up shape this season", tools);
  assert.ok(early);
  const model: ResearchModel = {
    writeBrief: async () => brief([]),
    reflect: async () => ({ enough: true, calls: [], unresolved: [], discard: [] }),
  };
  const { ledger } = await runResearch({ ...ctx, hints: { clubs: [], players: [] }, present: true, questionSearch: early }, tools, {
    model,
    situationModel: { enrich: async () => ({ clubs: [], players: [], unknowns: [] }) },
  });
  assert.deepEqual(asked, [`web:${ctx.message}`]);
  assert.deepEqual(ledger.entries.map((e) => e.content), ['Found early.']);
});

await test("a spotted player's record opens the club he plays for, and the snapshot runs alongside the brief", async () => {
  const asked: string[] = [];
  const order: string[] = [];
  const tools: ResearchToolset = {
    ...reportTools(asked, {}),
    playerSeason: async (name) => {
      asked.push(`player:${name}`);
      return { status: 'found', result: { kind: 'player_record', label: `${name} (Eastside)`, content: `${name} — Eastside, Midfielder.`, team: 'Eastside' }, missing: [] };
    },
  };
  let releaseBrief: () => void = () => {};
  const model: ResearchModel = {
    writeBrief: async () => {
      // The brief only returns once the snapshot call has started.
      await new Promise<void>((r) => (releaseBrief = r));
      order.push('brief');
      return brief([{ tool: 'player_season', subject: 'Some Player' }]);
    },
    reflect: async () => ({ enough: true, calls: [], unresolved: [], discard: [] }),
  };
  const inputs: SituationInput[] = [];
  const situationModel: SituationModel = {
    enrich: async (input) => {
      inputs.push(input);
      order.push('situation');
      releaseBrief();
      return { clubs: [], players: [{ name: 'Some Player', club: 'Eastside', role: 'left of a midfield three', form: '', status: 'fit', changes: '' }], unknowns: [] };
    },
  };
  const { situation, ledger } = await runResearch(
    { ...ctx, hints: { clubs: ['Westside'], players: ['Some Player'] }, present: true },
    tools,
    { model, situationModel },
  );
  assert.deepEqual(order, ['situation', 'brief']);
  // The guessed club and the real one are both looked up; the player is asked about once.
  assert.deepEqual(asked.filter((a) => a.startsWith('club:') || a.startsWith('player:')).sort(), ['club:Eastside', 'club:Westside', 'player:Some Player']);
  assert.deepEqual(inputs[0].clubs.map((c) => c.club).sort(), ['Eastside', 'Westside']);
  assert.equal(situation?.players[0].role, 'left of a midfield three');
  assert.ok(ledger.entries.some((e) => e.kind === 'player_record'));
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
