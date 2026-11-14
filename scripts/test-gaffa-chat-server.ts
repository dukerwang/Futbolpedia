#!/usr/bin/env npx tsx
/**
 * Offline checks for Gaffa's panel on Futbolpedia's server: the daily turn budget, a turn's events
 * and result, Continue in Futbolpedia's shared conversation, card links, and follow-up state kept
 * per conversation (two conversations with the same opening never see each other's research).
 * Gemini, Gaffa and the card index are faked; no network, Supabase or API keys.
 *
 * Usage:
 *   npx tsx scripts/test-gaffa-chat-server.ts
 */
import assert from 'node:assert/strict';
import type { ChatMessage, Conversation, GaffaClubContextResponse, PlayerProfile } from '../types';

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
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { log, info, warn } = console;
  console.log = console.info = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, info, warn });
  }
};

const { createTurnBudget } = await import('../services/gaffaTurnBudget');
const { runGaffaChatTurn, shareGaffaThread } = await import('../services/gaffaChatApi');
const { lookUpCardLinks } = await import('../services/cardLinks');
const { threadStateFor } = await import('../services/conversationalScout');

const LEAGUE = '11111111-1111-4111-8111-111111111111';
const CLUB = '22222222-2222-4222-8222-222222222222';
const context: GaffaClubContextResponse = {
  league_id: LEAGUE,
  club_id: CLUB,
  league_name: 'Sunday League',
  club_name: 'Hackney Wanderers',
  budget_eur_m: 45,
  roster: [{ player_id: 'p1', name: 'Bukayo Saka', primary_position: 'RW', status: 'active', pl_team: 'Arsenal' }],
  standings: { rank: 3, of_teams: 10, wins: 6, draws: 2, losses: 3, points_for: 812 },
  matchup: null,
  lineup: null,
  open_listings: [],
  open_auctions: [],
  free_agents: [],
  synced_at: '2026-11-13T10:00:00Z',
} as unknown as GaffaClubContextResponse;

const card = (name: string, type?: 'prime'): PlayerProfile =>
  ({
    basicInfo: { name, club: 'Arsenal', position: 'Right Winger', age: 25 },
    ratings: { overall: 85, potential: 87 },
    version: type ? { type, seasonOrEra: '2003-06', label: `${name} prime` } : { type: 'current', label: `${name} current` },
    evaluationDate: '2026-11-01',
    createdAt: Date.parse('2026-11-01'),
  }) as unknown as PlayerProfile;

await test('a manager gets ten turns a day; a failed turn is given back; tomorrow starts afresh', () => {
  let now = Date.parse('2026-11-13T09:00:00Z');
  const budget = createTurnBudget(10, () => now);
  for (let i = 0; i < 10; i++) assert.equal(budget.take('u1').ok, true);
  assert.deepEqual(budget.take('u1'), { ok: false, left: 0 });
  assert.equal(budget.left('u2'), 10, 'each manager has their own');
  budget.refund('u1');
  assert.deepEqual(budget.take('u1'), { ok: true, left: 0 });
  now = Date.parse('2026-11-14T00:00:01Z');
  assert.equal(budget.left('u1'), 10);
});

await test('a turn streams its events, returns card links, and asks to continue for a rating request', async () => {
  const events: any[] = [];
  let seen: any = null;
  const result = await quietly(() =>
    runGaffaChatTurn(
      { message: 'Rate Bukayo Saka', leagueId: LEAGUE, clubId: CLUB, userId: 'u1', conversationId: 'c1', history: [{ sender: 'user', content: 'hi' }, { sender: 'robot', content: 'x' }] },
      (e) => events.push(e),
      {
        budget: createTurnBudget(10),
        fetchContext: async () => context,
        send: (async (_m: string, history: ChatMessage[], _i: unknown, _c: unknown, _s: unknown, options: any) => {
          seen = { history, options };
          options.onRoute({ intent: 'single_dossier', targetPlayers: ['Bukayo Saka'] });
          options.onStageChange('Reading your Gaffa club...');
          options.onStreamChunk('Saka is');
          options.onAttachments({ cards: [card('Bukayo Saka')], scoutOffers: [] });
          return 'Saka is your best player.';
        }) as any,
      },
    ),
  );
  assert.equal(result.prose, 'Saka is your best player.');
  assert.equal(result.continueSuggested, true);
  assert.equal(result.turnsLeft, 9);
  assert.equal(result.club.club_name, 'Hackney Wanderers');
  assert.equal(result.cards[0].name, 'Bukayo Saka');
  assert.equal(result.cards[0].edition, 'current');
  assert.ok(result.cards[0].slug.startsWith('bukayo-saka'), result.cards[0].slug);
  assert.ok(!('overall' in result.cards[0]), 'no rating goes to Gaffa');
  assert.deepEqual(events.map((e) => e.type), ['stage', 'text']);
  // The pipeline ran with the club, no rating, and follow-up state of this manager's conversation.
  assert.equal(seen.options.noRating, true);
  assert.equal(seen.options.gaffaBag.club_name, 'Hackney Wanderers');
  assert.equal(seen.options.conversationId, 'gaffa:user:u1:c1');
  assert.equal(seen.history.length, 1, 'malformed history turns are dropped');
});

await test('refused turns: bad ids, a used-up day, and a missing club that costs nothing', async () => {
  const budget = createTurnBudget(1);
  const deps = { budget, fetchContext: async () => null, send: (async () => 'x') as any };
  await assert.rejects(runGaffaChatTurn({ message: 'hi', leagueId: 'nope', clubId: CLUB }, () => {}, deps), { status: 400 });
  await assert.rejects(quietly(() => runGaffaChatTurn({ message: 'hi', leagueId: LEAGUE, clubId: CLUB }, () => {}, deps)), { status: 404 });
  assert.equal(budget.left(`club:${CLUB}`), 1, 'the failed turn was given back');
  const ok = { ...deps, fetchContext: async () => context };
  await quietly(() => runGaffaChatTurn({ message: 'hi', leagueId: LEAGUE, clubId: CLUB }, () => {}, ok));
  await assert.rejects(runGaffaChatTurn({ message: 'hi', leagueId: LEAGUE, clubId: CLUB }, () => {}, ok), (err: any) => {
    assert.equal(err.status, 429);
    assert.equal(err.turnsLeft, 0);
    assert.match(err.message, /Continue in Futbolpedia/);
    return true;
  });
});

await test('Continue in Futbolpedia shares the thread with the club attached', async () => {
  let shared: Conversation | null = null;
  const out = await shareGaffaThread(
    { leagueId: LEAGUE, clubId: CLUB, history: [{ sender: 'user', content: 'Who should I start?' }, { sender: 'ai', content: 'Start Saka.' }] },
    async (conv) => {
      shared = conv;
      return 'ABC234';
    },
  );
  assert.deepEqual(out, { code: 'ABC234', path: '/#/c/ABC234' });
  assert.deepEqual(shared!.gaffaClub, { leagueId: LEAGUE, clubId: CLUB });
  assert.equal(shared!.title, 'Who should I start?');
  assert.deepEqual(shared!.messages.map((m) => m.sender), ['user', 'ai']);
  await assert.rejects(shareGaffaThread({ leagueId: LEAGUE, clubId: CLUB, history: [] }, async () => 'X'), { status: 400 });
});

await test('card links prefer current form, and a player with no card gets none', async () => {
  const links = await lookUpCardLinks(['Bukayo Saka', 'Thierry Henry', 'Nobody Here'], async () => [
    card('Thierry Henry', 'prime'),
    card('Bukayo Saka', 'prime'),
    card('Bukayo Saka'),
  ]);
  assert.equal(links['Bukayo Saka']?.edition, 'current');
  assert.equal(links['Thierry Henry']?.edition, 'prime');
  assert.equal(links['Nobody Here'], null);
});

await test('follow-up state is per conversation, and goes after an hour idle', () => {
  const a = threadStateFor('state-a', 0);
  a.grounding = 'A';
  assert.equal(threadStateFor('state-b', 0).grounding, '');
  assert.equal(threadStateFor('state-a', 1000).grounding, 'A');
  assert.equal(threadStateFor('state-a', 1000 + 61 * 60 * 1000).grounding, '');
});

// Two conversations with the same opening, end to end through the real pipeline.
let searches = 0;
const writerPrompts: string[] = [];
const realFetch = globalThis.fetch;
const respond = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.startsWith('/api/')) return new Response('{}', { status: 404 });
  if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
  const body = JSON.parse(init?.body ?? '{}');
  const raw = JSON.stringify(body);
  const prompt = JSON.stringify([body.contents ?? '', body.systemInstruction ?? '']);
  const structured = raw.includes('responseSchema') || raw.includes('responseJsonSchema');
  if (prompt.includes('first-team head coach')) return respond('COACH: UNKNOWN | SINCE: UNKNOWN | PREVIOUS: UNKNOWN | SOURCE_DATE: UNKNOWN');
  if (structured && prompt.includes('Classify')) {
    return respond(JSON.stringify({ intent: 'tactical_chat', analyticalMode: 'tactical_or_system', targetPlayers: [], targetClubs: ['Southside'], searchQueries: [], reasoningComplexity: 'low', isHistorical: false, wantsRegeneration: false, needsSearch: true }));
  }
  if (structured && prompt.includes('You are planning the research')) {
    return respond(JSON.stringify({ understanding: 'u', focus: 'f', timeframe: 'live', outline: ['o'], calls: [{ tool: 'web_search', subject: 'Southside news', purpose: 'news', stage: 'facts' }] }));
  }
  if (structured) return respond('{}');
  if (raw.includes('googleSearch') && !raw.includes('functionDeclarations')) {
    searches++;
    return respond(searches === 1 ? '[2026-11-10] ALPHA FACT: Southside changed shape.' : '[2026-11-11] Southside won again.');
  }
  writerPrompts.push(prompt);
  return respond('Southside are in form.');
}) as typeof fetch;

const { sendMessageToAI } = await import('../services/geminiService');
const opening = "How are Southside playing this season?";
const thread: ChatMessage[] = [
  { id: '1', sender: 'user', content: opening, timestamp: 1 },
  { id: '2', sender: 'ai', content: 'Southside are in form.', timestamp: 2 },
];

await test('two conversations with the same opening never see each other’s research', async () => {
  await quietly(() => sendMessageToAI(opening, [], undefined, [], [], { conversationId: 'conv-a' }));
  assert.ok(searches >= 1, 'conversation A researched');
  await quietly(() => sendMessageToAI('And their defence?', thread, undefined, [], [], { conversationId: 'conv-b' }));
  assert.doesNotMatch(writerPrompts.at(-1)!, /ALPHA FACT/, 'B never sees what A found');
  await quietly(() => sendMessageToAI('And their defence?', thread, undefined, [], [], { conversationId: 'conv-a' }));
  assert.match(writerPrompts.at(-1)!, /Research from the previous turn[\s\S]*ALPHA FACT/, 'A keeps its own');
});

globalThis.fetch = realFetch;
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
