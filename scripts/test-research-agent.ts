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
  runResearch,
  type ResearchBrief,
  type ResearchContext,
  type ResearchModel,
} from '../services/researchAgent';
import { formatLeagueTable, runCalls, sanitizeCalls, type ResearchToolset } from '../services/researchTools';
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

const ctx: ResearchContext = {
  message: "Break down Club's build-up shape this season",
  thread: '',
  cardsInPlay: [],
  hints: { clubs: ['Club'], players: [] },
};

/** Tools that record what was asked and answer from a fixed table; anything else finds nothing. */
const fakeTools = (found: Record<string, string>, calls: string[] = []): ResearchToolset => {
  const answer = (key: string, kind: 'web' | 'player_record' | 'league_table' | 'card') => {
    calls.push(key);
    return Promise.resolve(found[key] ? { kind, label: key, content: found[key] } : null);
  };
  return {
    clubRecentTeam: (club) => {
      calls.push(`club:${club}`);
      return Promise.resolve(
        found[`club:${club}`]
          ? { result: { kind: 'club_context', label: `${club}: recent team`, content: found[`club:${club}`] }, missing: [`Injury list for ${club} (API-Football returned none)`] }
          : { result: null, missing: [] },
      );
    },
    playerSeason: (name) => answer(`player:${name}`, 'player_record'),
    leagueTable: (league) => answer(`table:${league}`, 'league_table'),
    webSearch: (query) => answer(`web:${query}`, 'web'),
    card: (name) => answer(`card:${name}`, 'card'),
  };
};

const brief = (calls: ResearchBrief['calls']): ResearchBrief => ({
  understanding: 'Who plays and how the team builds up',
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
  assert.deepEqual(ledger.gaps, ['Injury list for Club (API-Football returned none)', 'Web search: Club transfers']);
});

await test('reflect adds a second round only when the first left a gap', async () => {
  const asked: string[] = [];
  const model: ResearchModel = {
    writeBrief: async () => brief([{ tool: 'club_recent_team', subject: 'Club' }]),
    reflect: async () => ({
      enough: false,
      calls: [{ tool: 'web_search', subject: 'Club injury news' }],
      unresolved: ['How long the injured centre-back is out'],
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
    reflect: async () => ({ enough: true, calls: [], unresolved: [] }),
  };
  await runResearch(ctx, fakeTools({}, asked), { model });
  assert.deepEqual(asked, ['club:Club', `web:${ctx.message}`]);
  assert.equal(fallbackBrief(ctx).calls.length, 2);
});

await test("the writer's brief carries the outline and what couldn't be established", () => {
  const text = formatBriefForWriter({ ...brief([]), unresolved: ['Who starts on the left'] });
  assert.match(text, /What the user is asking: Who plays and how the team builds up/);
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

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
