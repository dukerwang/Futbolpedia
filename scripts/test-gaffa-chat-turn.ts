#!/usr/bin/env npx tsx
/**
 * Offline checks for a Gaffa club in the chat loop: a turn with a club attached in the app takes
 * the loop with the club's blocks in its first message (squad, market and lineup questions), the
 * loop gets `grep_gaffa_market` and runs it free, the market rule removes an unlisted free agent
 * from the loop's reply on the stream and the final reply, a trade and Gaffa's panel stay on the stage
 * pipeline, a failing loop falls back to the stage pipeline with the club, and the four turns of
 * the shared conversation /c/W8BVT5 (case C1 in the live set) replay through the loop. Gemini is
 * refused at fetch and the loop's model, tools and squad availability are faked: no network,
 * Supabase or API keys, and no model calls.
 *
 * Usage:
 *   npx tsx scripts/test-gaffa-chat-turn.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessage, GaffaContextBag } from '../types';
import type { LiveAvailability } from '../services/liveFootball';
import type { SquadAvailability } from '../services/gaffaAvailability';
import type { ResearchToolset, ToolOutcome } from '../services/researchTools';
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

// Gemini and the app's routes are refused at fetch; the bodies sent to Gemini are kept, so a test
// can see what the stage pipeline would have sent.
const geminiBodies: string[] = [];
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.includes('generativelanguage.googleapis.com')) geminiBodies.push(typeof init?.body === 'string' ? init.body : '');
  return new Response(JSON.stringify({ error: { code: 400, message: 'offline test' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const { sendMessageToAI } = await import('../services/geminiService');
const { takesChatLoop, CHAT_GAFFA_RULE, FALLBACK_STAGE_LABEL } = await import('../services/chatTurn');
const { gateGaffaMarket, finishGaffaReply, isGaffaTrade } = await import('../services/gaffaTurn');
const { readConversations, historyFor } = await import('./eval-conversations');
type ChatModel = import('../services/chatTurn').ChatModel;
type ChatRoundReply = import('../services/chatTurn').ChatRoundReply;
type ChatToolResponse = import('../services/chatTurn').ChatToolResponse;
type TurnStats = import('../services/chatTurn').TurnStats;
type GaffaTurn = import('../services/gaffaTurn').GaffaTurn;
type PathInfo = import('../services/chatTurn').PathInfo;

// --- Fixtures ----------------------------------------------------------------------------------

/** A club shaped like the one in /c/W8BVT5: its starting keeper on Gaffa's IR, one healthy keeper, free agents in goal. */
const fa = (id: string, name: string, position: string, pl_team: string, mv: number, age: number) => ({ player_id: id, name, position, pl_team, market_value_eur_m: mv, age });
const bag: GaffaContextBag = {
  gaffa_rules_version: 'test',
  connected: true,
  league_id: 'league-test',
  club_id: 'club-test',
  club_name: 'Harbour Athletic',
  league_name: 'Test Dynasty League',
  budget_eur_m: 193,
  settings: { roster_size: 22, bench_size: 7, ir_size: 3, taxi_size: 3, taxi_age_limit: 21, free_agent_bid_floor: 0.6 } as GaffaContextBag['settings'],
  roster: [
    { player_id: 'r1', name: 'Emiliano Martínez', primary_position: 'GK', status: 'ir', pl_team: 'Aston Villa' },
    { player_id: 'r2', name: 'Antonín Kinský', primary_position: 'GK', status: 'active', pl_team: 'Tottenham Hotspur' },
    { player_id: 'r3', name: 'Bukayo Saka', primary_position: 'RW', status: 'active', pl_team: 'Arsenal' },
    { player_id: 'r4', name: 'Declan Rice', primary_position: 'CM', status: 'active', pl_team: 'Arsenal' },
    { player_id: 'r5', name: 'Virgil van Dijk', primary_position: 'CB', status: 'active', pl_team: 'Liverpool' },
  ],
  lineup: {
    formation: '4-3-3',
    starters: [
      { slot: 'GK', player_id: 'r2', name: 'Antonín Kinský' },
      { slot: 'RW', player_id: 'r3', name: 'Bukayo Saka' },
      { slot: 'CM', player_id: 'r4', name: 'Declan Rice' },
      { slot: 'CB', player_id: 'r5', name: 'Virgil van Dijk' },
    ],
    bench: [],
  } as GaffaContextBag['lineup'],
  free_agents: [
    fa('f1', 'Caoimhín Kelleher', 'GK', 'Brentford', 32, 27),
    fa('f2', 'Zion Suzuki', 'GK', 'Aston Villa', 30, 24),
    fa('f3', 'Giorgi Mamardashvili', 'GK', 'Liverpool', 28, 26),
    fa('f4', 'Đorđe Petrović', 'GK', 'Bournemouth', 28, 27),
    fa('f5', 'Dean Henderson', 'GK', 'Crystal Palace', 28, 29),
    fa('f6', 'Morgan Rogers', 'AM', 'Aston Villa', 45, 24),
  ],
  open_auctions: [],
  open_listings: [],
};

const DOUBTFUL = 'doubtful: 75% chance of playing in the next Premier League gameweek (Thigh injury; FPL note dated 2026-11-10)';
const availability: SquadAvailability = new Map<string, LiveAvailability>([
  ['r1', { name: 'Emiliano Martínez', fplName: 'Emiliano Martínez', team: 'Aston Villa', status: 'd', available: false, line: DOUBTFUL }],
]);
const availabilityReads: number[] = [];
const fakeAvailability = async (roster: GaffaContextBag['roster']) => (availabilityReads.push(roster?.length ?? 0), availability);

/** Tools that answer every lookup from a fixed outcome, recording what was asked. */
function fakeTools() {
  const asked: string[] = [];
  const found = (label: string, content: string): ToolOutcome => ({ status: 'found', result: { kind: 'web', label, content, stage: 'facts' } as any, missing: [] });
  const tools: ResearchToolset = {
    clubRecentTeam: async (club) => (asked.push(`club ${club}`), { status: 'empty', result: null, missing: [] }),
    playerSeason: async (name) => (asked.push(`player ${name}`), found(`${name}: season`, `${name} — Aston Villa, GK. Status: ${DOUBTFUL}.`)),
    leagueTable: async (league) => (asked.push(`table ${league}`), { status: 'empty', result: null, missing: [] }),
    webSearch: async (query) => (asked.push(`search ${query}`), { status: 'empty', result: null, missing: [] }),
    card: async (name) => (asked.push(`card ${name}`), { status: 'empty', result: null, missing: [] }),
    clubSeason: async (club) => (asked.push(`season ${club}`), { status: 'empty', result: null, missing: [] }),
    playerCareer: async (name) => (asked.push(`career ${name}`), { status: 'empty', result: null, missing: [] }),
  };
  return { tools, asked };
}

interface Opened {
  systemInstruction: string;
  history: unknown[];
  declarations: string[];
}

/** A loop model that plays back `script`, one reply per send; a function entry sees what was sent. */
function fakeModel(script: (ChatRoundReply | ((sent: (string | ChatToolResponse[])[]) => ChatRoundReply))[]) {
  const sent: (string | ChatToolResponse[])[] = [];
  let opened: Opened | null = null;
  const model: ChatModel = {
    open(args) {
      opened = { systemInstruction: args.systemInstruction, history: args.history, declarations: args.declarations.map((d) => String(d.name)) };
      return {
        async send(message, { onText }) {
          sent.push(message);
          const next = script[Math.min(sent.length - 1, script.length - 1)];
          const reply = typeof next === 'function' ? next(sent) : next;
          if (reply.text) onText?.(reply.text);
          return reply;
        },
      };
    },
  };
  return { model, sent, opened: () => opened };
}
const answer = (text: string): ChatRoundReply => ({ text, calls: [] });
const calls = (...list: { name: string; args: Record<string, unknown> }[]): ChatRoundReply => ({ text: '', calls: list });

/** Runs `fn` with the console quiet, keeping what was logged. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const { log, info, warn } = console;
  console.log = console.info = console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    return { value: await fn(), logs };
  } finally {
    Object.assign(console, { log, info, warn });
  }
}

/** One turn through sendMessageToAI with a club attached, the loop's model faked. */
async function sendGaffa(
  message: string,
  script: Parameters<typeof fakeModel>[0],
  opts: { history?: ChatMessage[]; options?: Record<string, unknown>; conversationId?: string; bag?: GaffaContextBag } = {},
) {
  const fake = fakeModel(script);
  const { tools, asked } = fakeTools();
  const paths: PathInfo[] = [];
  const stages: string[] = [];
  const chunks: string[] = [];
  let gaffaTurn: GaffaTurn | null = null;
  let stats: TurnStats | null = null;
  const geminiBefore = geminiBodies.length;
  const { value, logs } = await quietly(() =>
    sendMessageToAI(message, opts.history ?? [], undefined, [], [], {
      gaffaBag: opts.bag ?? bag,
      conversationId: opts.conversationId ?? `gaffa-${message.length}-${Math.random()}`,
      onPath: (p) => paths.push(p),
      onStageChange: (l) => stages.push(l),
      onStreamChunk: (t) => chunks.push(t),
      ...opts.options,
      chatDeps: {
        model: fake.model,
        tools,
        snapshots: null,
        managers: async () => [],
        gaffaAvailability: fakeAvailability,
        onGaffaTurn: (t) => (gaffaTurn = t),
        onStats: (s) => (stats = s),
      },
    }).catch((e) => `failed: ${e?.message ?? e}`),
  );
  const first = typeof fake.sent[0] === 'string' ? (fake.sent[0] as string) : '';
  return {
    reply: value as string,
    opened: fake.opened(),
    first,
    sent: fake.sent,
    paths,
    stages,
    chunks,
    asked,
    logs,
    gaffaTurn: gaffaTurn as GaffaTurn | null,
    stats: stats as TurnStats | null,
    stageGemini: geminiBodies.slice(geminiBefore),
  };
}

const user = (content: string): ChatMessage => ({ id: `u-${content.length}`, sender: 'user', content, timestamp: 0 });
const ai = (content: string): ChatMessage => ({ id: `a-${content.length}`, sender: 'ai', content, timestamp: 0 });

// --- The entry rule ----------------------------------------------------------------------------

await test('a club attached in the app no longer keeps a turn off the loop; a trade and the panel still do', () => {
  const r = { intent: 'tactical_chat' } as any;
  assert.equal(takesChatLoop({ route: r, historical: false }), true);
  assert.equal(takesChatLoop({ route: r, historical: false, gaffaTrade: true }), false);
  assert.equal(takesChatLoop({ route: r, historical: false, noRating: true }), false);
  assert.equal(takesChatLoop({ route: r, historical: true }), false);
});

await test('a trade is read from the message, or from a trade thread a short follow-up continues', () => {
  assert.equal(isGaffaTrade('Would you swap Kinský for Kelleher?', [], bag), true);
  assert.equal(isGaffaTrade('Would you trade Saka and €10m for Rogers?', [], bag), true);
  assert.equal(isGaffaTrade('and with Rice instead?', [user('Would you trade Saka for Rogers?'), ai('No.')], bag), true);
  assert.equal(isGaffaTrade('Which free agent should I bid on in goal?', [], bag), false);
  assert.equal(isGaffaTrade('Would you swap Kinský for Kelleher?', [], undefined), false, 'no club, no trade');
});

await test("a club's thread is about the present unless the user's own words name the past", async () => {
  const { threadIsHistorical } = await import('../services/conversationalScout');
  const r = { intent: 'tactical_chat', isHistorical: false } as any;
  const history = [user('Which free agent should I sign in goal?'), ai('Kelleher gives you a starter in his prime years.')];
  assert.equal(threadIsHistorical(r, history, 'why would you suggest that?'), true, 'without a club, the reply\'s word counts, as before');
  assert.equal(threadIsHistorical(r, history, 'why would you suggest that?', { userOnly: true }), false);
  assert.equal(threadIsHistorical(r, [user('Was prime Rooney better than Saka is now?'), ai('No.')], 'why?', { userOnly: true }), true);
});

// --- Squad, market and lineup questions take the loop with their blocks -------------------------

await test('a squad question takes the loop with the club block, its FPL line, the reasoning and the lineup audit', async () => {
  const t = await sendGaffa('Who is the weakest starter in my squad right now?', [answer('Kinský is the weakest starter.')]);
  assert.deepEqual(t.paths, [{ path: 'chat' }]);
  assert.ok(t.opened, 'the loop was opened');
  assert.equal(t.gaffaTurn?.focus, 'squad');
  assert.match(t.first, /<gaffa_club>[\s\S]*Harbour Athletic[\s\S]*<\/gaffa_club>/);
  assert.ok(t.first.includes(`Emiliano Martínez (GK, Aston Villa, ir; FPL: ${DOUBTFUL})`), 'the starter on IR carries his FPL line');
  assert.match(t.first, /<gaffa_manager_reasoning>/);
  assert.match(t.first, /<locked_lineup_audit>/);
  assert.doesNotMatch(t.first, /<locked_market>/, 'a squad question carries no market lock');
  assert.ok(t.first.includes(CHAT_GAFFA_RULE));
  assert.ok(t.first.indexOf('<gaffa_club>') < t.first.indexOf('<task>'));
  assert.ok(t.opened!.declarations.includes('grep_gaffa_market'));
  assert.ok(t.opened!.declarations.includes('get_player_season'));
  assert.ok(t.stages.includes('Reading your Gaffa club...'));
  assert.equal(t.reply, 'Kinský is the weakest starter.');
  // Only the router's classifier reaches the (refused) fetch: no stage writer ran.
  assert.ok(t.stageGemini.every((body) => !body.includes('<gaffa_club>')), 'no stage writer got the club');
  assert.ok(t.stageGemini.every((body) => body.includes('intent')), 'what reached Gemini was the router');
});

await test('a market question takes the loop with the rules, the market lock and the bid calculator', async () => {
  const t = await sendGaffa('Which free agent should I bid on to cover goalkeeper, and what would it cost?', [answer('Kelleher.')]);
  assert.deepEqual(t.paths, [{ path: 'chat' }]);
  assert.equal(t.gaffaTurn?.focus, 'market');
  assert.match(t.first, /<gaffa_club>/);
  assert.match(t.first, /<gaffa_manager_reasoning>/);
  assert.match(t.first, /<gaffa_rules>/);
  assert.match(t.first, /<locked_market>[\s\S]*Caoimhín Kelleher/);
  assert.match(t.first, /<locked_bid_calculator>/);
  assert.ok(t.opened!.declarations.includes('grep_gaffa_market'));
});

await test('a lineup question takes the loop with the rules and the lineup audit', async () => {
  const t = await sendGaffa('Check my lineup for this gameweek.', [answer('Your lineup is set.')]);
  assert.deepEqual(t.paths, [{ path: 'chat' }]);
  assert.equal(t.gaffaTurn?.focus, 'lineup');
  assert.match(t.first, /<gaffa_rules>/);
  assert.match(t.first, /<locked_lineup_audit>/);
  assert.doesNotMatch(t.first, /<locked_bid_calculator>/);
});

await test('a question that isn\'t about the club still carries the club block, and only the chat loop\'s own tools plus the grep', async () => {
  const t = await sendGaffa("Break down Southside's build-up shape this season", [answer('A back three in possession.')]);
  assert.deepEqual(t.paths, [{ path: 'chat' }]);
  assert.equal(t.gaffaTurn?.focus, 'none');
  assert.match(t.first, /<gaffa_club>[\s\S]*may not be about their Gaffa club/);
  assert.doesNotMatch(t.first, /<gaffa_manager_reasoning>/);
  assert.deepEqual(availabilityReads.length > 0, true);
});

await test('a turn with no club offers no market grep and no Gaffa rule', async () => {
  const fake = fakeModel([answer('An answer.')]);
  await quietly(() =>
    sendMessageToAI("Break down Southside's build-up shape this season", [], undefined, [], [], {
      chatDeps: { model: fake.model, tools: fakeTools().tools, snapshots: null, managers: async () => [] },
    }),
  );
  assert.ok(fake.opened());
  assert.ok(!fake.opened()!.declarations.includes('grep_gaffa_market'));
  assert.ok(!(fake.sent[0] as string).includes('<gaffa_club>'));
  assert.ok(!(fake.sent[0] as string).includes(CHAT_GAFFA_RULE));
});

// --- Tools ---------------------------------------------------------------------------------------

await test('grep_gaffa_market reads the bag and costs nothing; get_player_season counts as a lookup', async () => {
  const t = await sendGaffa('Which free agent should I bid on to cover goalkeeper, and what would it cost?', [
    calls({ name: 'grep_gaffa_market', args: { pool: 'free_agents', position: 'GK' } }, { name: 'get_player_season', args: { name: 'Emiliano Martínez' } }),
    answer('Kelleher is the pick.'),
  ]);
  const results = t.sent[1] as ChatToolResponse[];
  const grep = results.find((r) => r.name === 'grep_gaffa_market')!.response as any;
  const names = JSON.stringify(grep);
  assert.ok(names.includes('Caoimhín Kelleher') && names.includes('Dean Henderson'));
  assert.ok(!names.includes('Morgan Rogers'), 'the position filter applied');
  assert.match(String(grep.budget), /11 lookups/, 'one lookup spent: the season record, not the grep');
  assert.equal(t.stats?.calls, 1);
  assert.deepEqual(t.stats?.toolCalls, ['grep_gaffa_market', 'get_player_season']);
  assert.ok(t.stages.includes("Searching your league's market"));
});

// --- The market rule on a loop reply -----------------------------------------------------------

const UNLISTED = 'Alisson Becker';
const marketReply = [
  'Your weakest slot is in goal while Martínez is doubtful.',
  '',
  `* **${UNLISTED}** (Liverpool · age 33) is the best free agent on the board. He would settle the position at once.`,
  '* **Caoimhín Kelleher** (Brentford · age 27 · €32m MV) is the strongest upgrade in the free-agent pool.',
  '',
  `If you want a cheaper route, nominate ${UNLISTED.split(' ')[1]} anyway. Otherwise bid on Kelleher at the €19m floor.`,
].join('\n');

await test('the market rule removes an unlisted free agent from a loop reply, on the stream and the final reply', async () => {
  const t = await sendGaffa('Which free agent should I bid on to cover goalkeeper, and what would it cost?', [answer(marketReply)]);
  assert.deepEqual(t.paths, [{ path: 'chat' }]);
  assert.ok(!t.reply.includes('Alisson') && !t.reply.includes('Becker'), t.reply);
  assert.match(t.reply, /Caoimhín Kelleher\*\* \(Brentford/);
  assert.match(t.reply, /bid on Kelleher at the €19m floor/);
  assert.match(t.reply, /Your weakest slot is in goal/);
  assert.ok(t.chunks.length > 0);
  for (const chunk of t.chunks) assert.ok(!chunk.includes('Alisson') && !chunk.includes('Becker'), `streamed: ${chunk}`);
  assert.ok(t.logs.some((l) => l.startsWith('[GaffaMarket] removed unlisted players: Alisson Becker')));
});

await test('the market rule leaves a listed player, a squad player, a denial and a turn about something else alone', () => {
  const kept = [
    'Kelleher (Brentford) is unowned, so nominate him.',
    'Sign Caoimhín Kelleher before the window shuts.',
    'Bid on Antonín Kinský? He is already yours.',
    'Alisson Becker is not a free agent in this league: another club owns him.',
    "Don't sign Alisson Becker.",
  ].join(' ');
  assert.equal(gateGaffaMarket(kept, bag, 'market').text, kept);
  const other = 'Alisson Becker is available for the weekend.';
  assert.equal(gateGaffaMarket(other, bag, 'squad').text, other, '"available" is about fitness off a market question');
  assert.equal(gateGaffaMarket('Sign Alisson Becker now.', bag, 'none').text, 'Sign Alisson Becker now.', 'a turn not about the club is left alone');
  assert.equal(gateGaffaMarket('Sign Alisson Becker now.', bag, 'squad').text, '', 'but advice to sign him is removed on a squad question');
});

await test('the market rule drops a table row that leads with an unlisted player, and a legacy bag is held to its auctions', () => {
  const table = ['| Player | Club | MV | Floor |', '|---|---|---|---|', '| Caoimhín Kelleher | Brentford | €32m | €19m |', `| ${UNLISTED} | Liverpool | €20m | €12m |`].join('\n');
  const out = gateGaffaMarket(table, bag, 'market').text;
  assert.ok(out.includes('Caoimhín Kelleher'));
  assert.ok(!out.includes(UNLISTED));
  const legacy = { ...bag, free_agents: undefined, open_auctions: [{ player_id: 'a1', name: 'Zion Suzuki', position: 'GK', kind: 'free_agent', highest_bid_eur_m: 20, expires_at: null }] };
  const said = 'Bid on Zion Suzuki now. Nominate Caoimhín Kelleher too.';
  assert.equal(gateGaffaMarket(said, legacy, 'market').text, 'Bid on Zion Suzuki now.');
});

await test('finishGaffaReply copies squad names exactly and leaves a turn about something else alone', () => {
  const turn = { focus: 'squad' as const, scorecard: null };
  assert.equal(finishGaffaReply('Start Antonin Kinský in goal.', bag, turn).includes('Antonín Kinský'), true);
  assert.equal(finishGaffaReply('Sign Alisson Becker now.', bag, { focus: 'none', scorecard: null }), 'Sign Alisson Becker now.');
  assert.equal(finishGaffaReply('Sign Alisson Becker now.', undefined, turn), 'Sign Alisson Becker now.');
});

// --- What stays on the stage pipeline -----------------------------------------------------------

await test('a trade question stays on the stage pipeline, and the loop is never opened', async () => {
  const t = await sendGaffa('Would you trade Saka and €10m for Morgan Rogers?', [answer('SHOULD NOT RUN')]);
  assert.equal(t.opened, null);
  assert.deepEqual(t.paths, [{ path: 'stage' }]);
  assert.ok(t.stages.includes('Scoring the trade...'));
  const followUp = await sendGaffa('and if I add Rice?', [answer('SHOULD NOT RUN')], {
    history: [user('Would you trade Saka and €10m for Morgan Rogers?'), ai('Not at that price.')],
  });
  assert.equal(followUp.opened, null, 'a follow-up in a trade thread stays too');
  assert.deepEqual(followUp.paths, [{ path: 'stage' }]);
});

await test("Gaffa's panel stays on the stage pipeline", async () => {
  const t = await sendGaffa('Who is the weakest starter in my squad right now?', [answer('SHOULD NOT RUN')], { options: { noRating: true } });
  assert.equal(t.opened, null);
  assert.deepEqual(t.paths, [{ path: 'stage' }]);
});

await test('the stage flag still sends a club turn to the stage pipeline', async () => {
  const forced = await sendGaffa('Who is the weakest starter in my squad right now?', [answer('SHOULD NOT RUN')], { options: { stage: true } });
  assert.equal(forced.opened, null);
});

// --- Fallback ------------------------------------------------------------------------------------

await test('a Gaffa turn whose loop gives up falls back to the stage pipeline with the club', async () => {
  const t = await sendGaffa('Who is the weakest starter in my squad right now?', [
    () => {
      throw new Error('model unavailable');
    },
  ]);
  assert.deepEqual(t.paths, [{ path: 'chat' }, { path: 'stage', fallback: 'error' }]);
  assert.ok(t.stages.includes(FALLBACK_STAGE_LABEL));
  assert.equal(t.stages.filter((l) => l === 'Reading your Gaffa club...').length, 2, 'both runs read the club');
  assert.ok(t.stageGemini.some((body) => body.includes('<gaffa_club>') && body.includes('Harbour Athletic')), 'the stage writer got the club block');
});

// --- The shared conversation /c/W8BVT5 ------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const c1 = readConversations(readFileSync(join(root, 'docs/superpowers/evals/live-questions.md'), 'utf8')).find((c) => c.id === 'C1')!;

await test('C1 (/c/W8BVT5): every turn takes the loop with the club, the starter\'s FPL line and the reasoning', async () => {
  assert.equal(c1.gaffaClub, true);
  const focuses: string[] = [];
  for (let i = 0; i < c1.turns.length; i++) {
    const history = historyFor(c1, i, new Map())!;
    assert.ok(history, `turn ${i} has a history`);
    const t = await sendGaffa(c1.turns[i].user, [answer('Martínez is doubtful, a 75% chance of playing, so keep the spot for an outfielder.')], {
      history,
      conversationId: 'eval-C1',
    });
    focuses.push(t.gaffaTurn?.focus ?? 'none');
    assert.deepEqual(t.paths, [{ path: 'chat' }], `turn ${i}`);
    assert.equal(t.opened!.history.length, i * 2, `turn ${i}: the recorded turns before it are the loop's history`);
    assert.match(t.first, /<gaffa_club>/, `turn ${i}`);
    assert.ok(t.first.includes(`FPL: ${DOUBTFUL}`), `turn ${i}: the starter's FPL status`);
    assert.match(t.first, /<gaffa_manager_reasoning>[\s\S]*A player on IR is a roster designation/, `turn ${i}`);
    assert.ok(t.first.includes(`<task>${c1.turns[i].user}</task>`), `turn ${i}`);
    assert.ok(t.opened!.declarations.includes('grep_gaffa_market'), `turn ${i}`);
    assert.ok(t.opened!.declarations.includes('get_player_season'), `turn ${i}`);
    assert.match(t.opened!.systemInstruction, /## Research\n/);
    if (i === 0) {
      assert.match(t.first, /<locked_market>[\s\S]*Caoimhín Kelleher/, 'the first question is about the market');
      assert.match(t.first, /<locked_bid_calculator>/);
    }
    assert.ok(t.stageGemini.every((body) => !body.includes('<gaffa_club>')), `turn ${i}: no stage writer got the club`);
  }
  // The first asks about free agents; every pushback after it is about the squad, thread focus included.
  assert.deepEqual(focuses, ['market', 'squad', 'squad', 'squad']);
});

await test("C1's recorded first reply passes the market rule untouched, and loses only a player taken off the list", () => {
  const recorded = c1.turns[0].recorded!;
  assert.equal(gateGaffaMarket(recorded, bag, 'market').text, recorded);
  const without = { ...bag, free_agents: bag.free_agents!.filter((p) => p.name !== 'Dean Henderson') };
  const gated = gateGaffaMarket(recorded, without, 'market');
  assert.deepEqual(gated.removed, ['Dean Henderson']);
  assert.ok(!gated.text.includes('**Dean Henderson**'));
  assert.ok(gated.text.includes('**Caoimhín Kelleher** (Brentford'));
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
