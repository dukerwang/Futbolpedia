#!/usr/bin/env npx tsx
/**
 * Offline checks for deep mode (`services/deepTurn.ts`): the loop runs with the model, the tools
 * and the clock faked. It checks the budget line on every tool result, each hard stop and the
 * tool-less round after it, parallel calls in a round, the ledger and the figure gate on the
 * reply, show_pitch's lineups, the thread state a follow-up reads, and which turns take the path
 * (through sendMessageToAI, with Gemini refused at fetch). No network, Supabase or API keys.
 *
 * Usage:
 *   npx tsx scripts/test-deep-turn.ts
 */
import assert from 'node:assert/strict';
import { formatClubReport, type ClubMatch, type LiveClubReport } from '../services/liveFootball';
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

// Gemini and the app's routes are refused at fetch: nothing here may reach them by accident.
const geminiAsked: string[] = [];
globalThis.fetch = (async (input: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.includes('generativelanguage.googleapis.com')) geminiAsked.push(url);
  return new Response(JSON.stringify({ error: { code: 400, message: 'offline test' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const {
  runDeepTurn,
  takesDeepPath,
  stageLabel,
  DEEP_DECLARATIONS,
  deepModeRules,
  DEFAULT_DEEP_BUDGET,
  uncheckedFor,
  DEEP_BY_DEFAULT,
  wantsDeep,
  speedToggle,
  runDeepWithFallback,
  DeepFailure,
  FALLBACK_STAGE_LABEL,
} = await import('../services/deepTurn');
type PathInfo = import('../services/deepTurn').PathInfo;
type DeepModel = import('../services/deepTurn').DeepModel;
type DeepReply = import('../services/deepTurn').DeepReply;
type DeepToolResponse = import('../services/deepTurn').DeepToolResponse;
const { threadStateFor } = await import('../services/conversationalScout');

// --- Fakes ------------------------------------------------------------------------------------

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
const roles = ['G', 'LB', 'CD-L', 'CD-R', 'RB', 'DM', 'CM-L', 'CM-R', 'LF', 'F', 'RF'];
const names = ['Keeper', 'New Fullback', 'Centre Left', 'Centre Right', 'Right Back', 'Anchor', 'Eight One', 'Eight Two', 'Left Wing', 'Main Nine', 'Right Wing'];
const report: LiveClubReport = {
  team: 'Southside',
  league: 'LaLiga',
  lineups: ['m3', 'm2', 'm1'].map((id, i) => ({
    match: match(id, `2026-10-${25 - i * 7}`),
    formation: '4-3-3',
    starters: roles.map((role, j) => ({ name: names[j], role })),
    subsUsed: [],
  })),
  results: ['m3', 'm2', 'm1'].map((id, i) => match(id, `2026-10-${25 - i * 7}`)),
  fixtures: [],
  fplPlayers: null,
  asOf: '2026-11-01',
};

/** Tools whose lookups take `delayMs` on a fake clock, and log when each starts and ends. */
function fakeTools(clock: { t: number }, delayMs = 0) {
  const events: string[] = [];
  const run = async (label: string, outcome: ToolOutcome): Promise<ToolOutcome> => {
    events.push(`start ${label}`);
    const startedAt = clock.t;
    if (delayMs) await new Promise((r) => setTimeout(r, 5));
    // Calls that run together end together: the clock moves to the latest end, not the sum.
    clock.t = Math.max(clock.t, startedAt + delayMs);
    events.push(`end ${label}`);
    return outcome;
  };
  const tools: ResearchToolset = {
    clubRecentTeam: (club) =>
      run(`club ${club}`, {
        status: 'found',
        result: { kind: 'club_context', label: `${report.team}: recent matches`, content: formatClubReport(report), stage: 'facts', club: report },
        missing: [{ item: 'Injury list for Southside', status: 'not_covered' }],
      }),
    playerSeason: (name) => run(`player ${name}`, { status: 'not_covered', result: null, missing: [], note: 'not a Premier League player' }),
    leagueTable: (league) =>
      run(`table ${league}`, { status: 'found', result: { kind: 'league_table', label: `${league} table`, content: '1. Southside 30 pts', stage: 'facts' }, missing: [] }),
    webSearch: (query) =>
      run(`search ${query}`, { status: 'found', result: { kind: 'web', label: query, content: `[2026-10-28] Main Nine has scored 9 league goals for Southside.`, sources: ['Example (https://example.com)'] }, missing: [] }),
    card: (name) => run(`card ${name}`, { status: 'empty', result: null, missing: [] }),
    clubSeason: (club, season) => run(`season ${club} ${season}`, { status: 'empty', result: null, missing: [] }),
    playerCareer: (name) => run(`career ${name}`, { status: 'empty', result: null, missing: [] }),
  };
  return { tools, events };
}

interface Sent {
  message: string | DeepToolResponse[];
  tools: boolean;
}

/** A model that plays back `script`: each entry is the reply to the next send, or a function of what was sent. */
function fakeModel(script: (DeepReply | ((sent: Sent[]) => DeepReply))[]) {
  const sent: Sent[] = [];
  let opened: { systemInstruction: string; declarations: string[] } | null = null;
  const model: DeepModel = {
    open(args) {
      opened = { systemInstruction: args.systemInstruction, declarations: args.declarations.map((d) => String(d.name)) };
      return {
        async send(message, { tools, onText }) {
          sent.push({ message, tools });
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

const call = (name: string, args: Record<string, unknown>) => ({ name, args });
const callsReply = (...calls: { name: string; args: Record<string, unknown> }[]): DeepReply => ({ text: '', calls });
const answer = (text: string): DeepReply => ({ text, calls: [] });

const route = (): import('../services/turnRouter').TurnRoute => ({
  intent: 'tactical_chat',
  analyticalMode: 'tactical_or_system',
  targetPlayers: [],
  targetClubs: ['Southside'],
  searchQueries: [],
  isHistorical: false,
  wantsRegeneration: false,
  needsSearch: true,
});

const baseParams = (message: string, attachments = { cards: [], scoutOffers: [] } as import('../services/conversationalScout').ReplyAttachments) => ({
  message,
  route: route(),
  history: [],
  isEAFCRequest: false,
  conversationDossiers: [],
  savedDossiers: [],
  lockedDossiersBlock: '',
  savedDossiersBlock: '',
  attachments,
  conversationId: `test-${Math.random()}`,
});

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { log, info, warn } = console;
  console.log = console.info = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, info, warn });
  }
};

const responsesOf = (s: Sent): DeepToolResponse[] => (Array.isArray(s.message) ? s.message : []);

// --- The loop ---------------------------------------------------------------------------------

await test('every tool result ends with the budget line, and the prompt states the budget', async () => {
  const clock = { t: 0 };
  const { tools } = fakeTools(clock, 4_000);
  const fake = fakeModel([
    callsReply(call('get_club_recent_team', { team: 'Southside' }), call('web_search', { query: 'Southside tactics 2026-27' })),
    callsReply(call('get_league_table', { league: 'LaLiga' })),
    answer('Southside play a 4-3-3 with Main Nine up front.'),
  ]);
  await quietly(() => runDeepTurn(baseParams("How do Southside line up?"), { model: fake.model, tools, snapshots: null, managers: async () => [], now: () => clock.t }));
  const results = fake.sent.flatMap(responsesOf);
  assert.equal(results.length, 3);
  for (const r of results) {
    const keys = Object.keys(r.response);
    assert.equal(keys.at(-1), 'budget', `${r.name}'s result ends with the budget`);
    assert.match(String(r.response.budget), /^Budget left: \d+ s, \d+ lookups, \d+ web searches, \d+ rounds\.$/);
  }
  // Round one cost two lookups (one a search) and four seconds of fake time.
  assert.equal(results[0].response.budget, 'Budget left: 116 s, 10 lookups, 3 web searches, 9 rounds.');
  assert.equal(results[2].response.budget, 'Budget left: 112 s, 9 lookups, 3 web searches, 8 rounds.');
  const system = fake.opened()!.systemInstruction;
  assert.match(system, /Budget for this turn: 120 seconds of research, 12 lookups \(at most 4 of them web searches\) and 10 rounds of tool calls/);
  assert.match(system, /Stop researching as soon as you have what the answer needs/);
});

await test('the deep loop offers the writer\'s tools, the history routes, web search and show_pitch', () => {
  const names = DEEP_DECLARATIONS.map((d) => d.name);
  for (const n of ['get_club_recent_team', 'get_player_season', 'get_league_table', 'look_up_dossier', 'show_dossier', 'grep_saved_dossiers', 'club_season', 'player_career', 'web_search', 'show_pitch']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(new Set(names).size, names.length, 'no tool is declared twice');
});

for (const [cap, budget, script, expectedRounds] of [
  ['rounds', { rounds: 2 }, [callsReply(call('get_league_table', { league: 'A' })), callsReply(call('get_league_table', { league: 'B' }))], 2],
  ['calls', { calls: 3 }, [callsReply(call('get_league_table', { league: 'A' }), call('get_league_table', { league: 'B' })), callsReply(call('get_league_table', { league: 'C' }))], 2],
  ['searches', { searches: 1 }, [callsReply(call('web_search', { query: 'Southside news' }))], 1],
  ['time', { ms: 10_000 }, [callsReply(call('get_league_table', { league: 'A' })), callsReply(call('get_league_table', { league: 'B' }))], 2],
] as const) {
  await test(`the loop stops when the ${cap} budget is spent, and the last round goes out without tools`, async () => {
    const clock = { t: 0 };
    const { tools } = fakeTools(clock, 6_000);
    // The model keeps asking for more; after the cap, the reply to the tool-less round is the answer.
    const fake = fakeModel([
      ...script,
      (sent) => (sent.at(-1)!.tools ? callsReply(call('get_league_table', { league: 'Z' })) : answer('Southside lead the league.')),
    ]);
    let stats: import('../services/deepTurn').DeepStats | null = null;
    const reply = await quietly(() =>
      runDeepTurn(baseParams('Where are Southside?'), { model: fake.model, tools, snapshots: null, managers: async () => [], now: () => clock.t, budget, onStats: (s) => (stats = s) }),
    );
    assert.equal(reply, 'Southside lead the league.');
    assert.equal(stats!.stop, cap);
    assert.equal(stats!.rounds, expectedRounds);
    const last = fake.sent.at(-1)!;
    assert.equal(last.tools, false, 'the last round carries no tools');
    assert.ok(fake.sent.slice(0, -1).every((s) => s.tools), 'every round before it had tools');
    for (const r of responsesOf(last)) assert.match(String(r.response.researchOver), /Research is over/);
  });
}

await test('a reply with no text after research is over gets one plain request to write', async () => {
  const fake = fakeModel([
    callsReply(call('get_league_table', { league: 'A' })),
    callsReply(call('get_league_table', { league: 'B' })),
    answer('Written at last.'),
  ]);
  const reply = await quietly(() => runDeepTurn(baseParams('Q'), { model: fake.model, tools: fakeTools({ t: 0 }).tools, snapshots: null, managers: async () => [], budget: { rounds: 1 } }));
  assert.equal(reply, 'Written at last.');
  assert.deepEqual(fake.sent.map((s) => s.tools), [true, false, false]);
  assert.match(String(fake.sent[2].message), /Research is over/);
});

await test('a call past the lookup budget in the same round is refused, not run', async () => {
  const clock = { t: 0 };
  const { tools, events } = fakeTools(clock);
  const fake = fakeModel([
    callsReply(call('web_search', { query: 'one' }), call('web_search', { query: 'two' }), call('get_league_table', { league: 'A' })),
    answer('Done.'),
  ]);
  await quietly(() => runDeepTurn(baseParams('Q'), { model: fake.model, tools, snapshots: null, managers: async () => [], budget: { searches: 1 } }));
  const results = responsesOf(fake.sent[1]);
  assert.equal(results[0].response.status, 'found');
  assert.equal(results[1].response.status, 'not_run');
  assert.equal(results[2].response.status, 'found', 'a feed still runs once the searches are spent');
  assert.ok(!events.includes('start search two'));
});

await test('parallel calls in one round run together', async () => {
  const clock = { t: 0 };
  const { tools, events } = fakeTools(clock, 1_000);
  const fake = fakeModel([
    callsReply(call('get_club_recent_team', { team: 'Southside' }), call('get_league_table', { league: 'LaLiga' }), call('get_player_season', { name: 'Main Nine' })),
    answer('Answer.'),
  ]);
  await quietly(() => runDeepTurn(baseParams('Q'), { model: fake.model, tools, snapshots: null, managers: async () => [], now: () => clock.t }));
  // All three started before any finished.
  assert.deepEqual(events.slice(0, 3).map((e) => e.split(' ')[0]), ['start', 'start', 'start']);
  assert.equal(fake.sent.length, 2, 'one round of three calls, then the answer');
});

await test('tool results land in the ledger, and the figure gate removes an unsupported figure from the deep reply', async () => {
  const clock = { t: 0 };
  const { tools } = fakeTools(clock);
  const fake = fakeModel([
    callsReply(call('get_club_recent_team', { team: 'Southside' }), call('web_search', { query: 'Main Nine goals 2026-27' })),
    answer('Main Nine has scored 9 league goals this season. Southside allow a PPDA of 8.4 when they press. New Fullback starts at left-back.'),
  ]);
  const streamed: string[] = [];
  const conversationId = 'deep-ledger';
  const reply = await quietly(() =>
    runDeepTurn({ ...baseParams("How are Southside doing?"), conversationId, onStreamChunk: (t) => streamed.push(t) }, { model: fake.model, tools, snapshots: null, managers: async () => [] }),
  );
  assert.equal(reply, 'Main Nine has scored 9 league goals this season. New Fullback starts at left-back.');
  assert.ok(!streamed.some((t) => t.includes('8.4')), 'the stream never shows the removed figure');
  // The follow-up state holds this turn's ledger, as research's does.
  const thread = threadStateFor(conversationId);
  assert.match(thread.grounding, /\[E1\] Live club data \(ESPN, FPL\) — Southside: recent matches/);
  assert.match(thread.grounding, /\[E2\] Web search — Main Nine goals 2026-27/);
  assert.match(thread.grounding, /\[Not covered\][^\n]*\n- Injury list for Southside/);
  assert.equal(thread.signature, 'How are Southside doing?');
});

await test('a follow-up in the same thread starts from the last turn\'s research', async () => {
  const conversationId = 'deep-follow-up';
  const thread = threadStateFor(conversationId);
  thread.signature = 'How are Southside doing?';
  thread.grounding = '[E1] Web search — earlier\nMain Nine scored twice last weekend.';
  let prompt = '';
  const fake = fakeModel([(sent) => ((prompt = String(sent[0].message)), answer('Main Nine scored twice last weekend.'))]);
  const history = [{ id: '1', sender: 'user' as const, content: 'How are Southside doing?', timestamp: 1 }, { id: '2', sender: 'ai' as const, content: 'Well.', timestamp: 2 }];
  const reply = await quietly(() =>
    runDeepTurn({ ...baseParams('And their striker?'), history, conversationId }, { model: fake.model, tools: fakeTools({ t: 0 }).tools, snapshots: null, managers: async () => [] }),
  );
  assert.match(prompt, /Research from the previous turn[\s\S]*scored twice last weekend/);
  assert.equal(reply, 'Main Nine scored twice last weekend.');
});

await test('show_pitch attaches the club\'s XI, reading its live data when the turn hasn\'t', async () => {
  const attachments = { cards: [], scoutOffers: [] } as import('../services/conversationalScout').ReplyAttachments;
  const fake = fakeModel([callsReply(call('show_pitch', { club: 'Southside' })), answer('Here is how Southside line up.')]);
  const stages: string[] = [];
  let stats: import('../services/deepTurn').DeepStats | null = null;
  await quietly(() =>
    runDeepTurn({ ...baseParams('Southside XI?', attachments), onStageChange: (s) => stages.push(s) }, {
      model: fake.model,
      tools: fakeTools({ t: 0 }).tools,
      snapshots: null,
      managers: async () => [],
      onStats: (s) => (stats = s),
    }),
  );
  assert.equal(attachments.lineups?.length, 1);
  const view = attachments.lineups![0];
  assert.equal(view.club, 'Southside');
  assert.equal(view.formation, '4-3-3');
  assert.equal(view.xi.length, 11);
  assert.ok(view.xi.some((s) => s.role === 'LB' && s.name === 'New Fullback'));
  assert.equal(responsesOf(fake.sent[1])[0].response.shown, true);
  assert.ok(stages.includes("Drawing Southside's XI"));
  assert.equal(stats!.calls, 0, 'show_pitch is free');
});

await test('each tool call has a short progress label', () => {
  assert.equal(stageLabel(call('get_club_recent_team', { team: 'Arsenal' })), "Reading Arsenal's recent lineups");
  assert.equal(stageLabel(call('web_search', { query: 'Arsenal build-up 2026-27' })), 'Searching: Arsenal build-up 2026-27');
  assert.equal(stageLabel(call('club_season', { club: 'Arsenal', season: '2003-04' })), "Reading Arsenal's 2003-04 season");
  assert.equal(stageLabel(call('look_up_dossier', {})), 'Reading a card');
});

await test('a club lookup brings the club\'s verified coach, and the scrub knows him', async () => {
  const fake = fakeModel([callsReply(call('get_club_recent_team', { team: 'Southside' })), answer('Southside press high.')]);
  const asked: string[][] = [];
  await quietly(() =>
    runDeepTurn(baseParams('How do Southside press?'), {
      model: fake.model,
      tools: fakeTools({ t: 0 }).tools,
      snapshots: null,
      managers: async (clubs) => (asked.push(clubs), clubs.includes('Southside') ? [{ club: 'Southside', coach: 'Real Coach' }] : []),
    }),
  );
  assert.match(String(responsesOf(fake.sent[1])[0].response.verifiedCoach), /<verified_managers>[\s\S]*Southside: Real Coach/);
});

await test('the budget rules are descriptive: no player, club or rating examples', () => {
  const rules = deepModeRules(DEFAULT_DEEP_BUDGET);
  assert.doesNotMatch(rules, /\b(Arsenal|Chelsea|Madrid|Messi|Saka|\d{2} Overall)\b/);
});

// --- Coverage ---------------------------------------------------------------------------------

await test('each result lists what is still unchecked for the spotted club and player, and the list shrinks as calls land', async () => {
  const fake = fakeModel([
    callsReply(call('get_club_recent_team', { team: 'Southside' })),
    callsReply(call('web_search', { query: 'Southside team news injuries November 2026' }), call('get_player_season', { name: 'Main Nine' })),
    callsReply(call('web_search', { query: 'Southside summer signings and what changed since last season, Main Nine new role 2026-27' })),
    answer('Southside changed shape this summer.'),
  ]);
  const params = { ...baseParams('How is Main Nine doing at Southside?'), route: { ...route(), targetPlayers: ['Main Nine'] } };
  await quietly(() => runDeepTurn(params, { model: fake.model, tools: fakeTools({ t: 0 }).tools, snapshots: null, managers: async () => [] }));
  const lines = fake.sent.slice(1).map((s) => String(responsesOf(s)[0].response.unchecked));
  assert.equal(
    lines[0],
    "Not yet checked: team news on Southside's absences (no injury list covers it); a dated search on what changed at Southside this season; Main Nine's season record (get_player_season; Premier League players only); a dated search on what changed for Main Nine this season.",
  );
  assert.equal(lines[1], 'Not yet checked: a dated search on what changed at Southside this season; a dated search on what changed for Main Nine this season.');
  assert.equal(lines[2], 'Nothing on the usual checklist for this question is unchecked.');
  // It rides beside the budget, which still ends every result.
  for (const sent of fake.sent.slice(1)) {
    for (const r of responsesOf(sent)) assert.deepEqual(Object.keys(r.response).slice(-2), ['unchecked', 'budget']);
  }
});

await test('the unchecked list never forces a round: the model may answer with items left', async () => {
  const fake = fakeModel([callsReply(call('get_club_recent_team', { team: 'Southside' })), answer('Southside line up in a 4-3-3.')]);
  let stats: import('../services/deepTurn').DeepStats | null = null;
  const reply = await quietly(() =>
    runDeepTurn(baseParams('Southside shape?'), { model: fake.model, tools: fakeTools({ t: 0 }).tools, snapshots: null, managers: async () => [], onStats: (s) => (stats = s) }),
  );
  assert.equal(reply, 'Southside line up in a 4-3-3.');
  assert.equal(stats!.rounds, 1);
  assert.equal(stats!.stop, 'answered');
  assert.match(String(responsesOf(fake.sent[1])[0].response.unchecked), /^Not yet checked: /);
});

await test('a club not yet read lists its lineups; a fresh stored snapshot already covers what changed', () => {
  const empty = { entries: [], gaps: [], lookups: [], discarded: [] };
  assert.deepEqual(uncheckedFor({ clubs: ['Southside'], players: [] }, empty), [
    "Southside's recent lineups and injury list (get_club_recent_team)",
    'a dated search on what changed at Southside this season',
  ]);
  const snapshot = { club: 'Southside', league: 'LaLiga', core: {} as any, story: { changes: ['New Fullback signed'], distinctive: '', newsAbsences: [], unknowns: [] }, sources: [], builtAt: '2026-11-15T10:00:00Z', version: 1 };
  assert.deepEqual(uncheckedFor({ clubs: ['Southside'], players: [] }, empty, [snapshot]), ["Southside's recent lineups and injury list (get_club_recent_team)"]);
});

await test('the budget rules ask for what changed and for team news on absences', () => {
  const rules = deepModeRules(DEFAULT_DEEP_BUDGET);
  assert.match(rules, /says what is different this season for the club or player/);
  assert.match(rules, /reads team news as well as the injury list/);
});

// --- The entry rule ---------------------------------------------------------------------------

await test('only a deep question about the present takes the deep path', () => {
  const r = (intent: string) => ({ intent }) as any;
  assert.equal(takesDeepPath({ deep: true, route: r('tactical_chat'), historical: false }), true);
  assert.equal(takesDeepPath({ deep: true, route: r('compare'), historical: false }), true);
  // With the constant on, a present-day turn with no flag takes the loop; Fast sends it to the stage pipeline.
  assert.equal(takesDeepPath({ deep: false, route: r('tactical_chat'), historical: false }), true);
  assert.equal(takesDeepPath({ fast: true, route: r('tactical_chat'), historical: false }), false);
  assert.equal(takesDeepPath({ deep: true, route: r('tactical_chat'), historical: true }), false);
  assert.equal(takesDeepPath({ deep: true, route: r('single_dossier'), historical: false }), false);
  assert.equal(takesDeepPath({ deep: true, route: r('challenge_or_revise'), historical: false }), false);
  assert.equal(takesDeepPath({ deep: true, route: r('tactical_chat'), historical: false, noRating: true }), false);
  assert.equal(takesDeepPath({ deep: true, route: r('tactical_chat'), historical: false, gaffa: true }), false);
  assert.equal(takesDeepPath({ deep: true, route: r('tactical_chat'), historical: false, image: true }), false);
});

const { sendMessageToAI } = await import('../services/geminiService');
const sendDeep = async (message: string) => {
  const fake = fakeModel([answer('A deep answer about the present.')]);
  const reply = await quietly(() =>
    sendMessageToAI(message, [], undefined, [], [], {
      deep: true,
      deepDeps: { model: fake.model, tools: fakeTools({ t: 0 }).tools, snapshots: null, managers: async () => [] },
    }).catch((e) => `failed: ${e?.message ?? e}`),
  );
  return { opened: fake.opened() !== null, reply };
};

await test('with the toggle, a question about the present goes through the deep loop', async () => {
  const { opened, reply } = await sendDeep("Break down Southside's build-up shape this season");
  assert.ok(opened, 'the deep model was opened');
  assert.equal(reply, 'A deep answer about the present.');
});

await test('with the toggle, a historical question and a rating take the normal path', async () => {
  for (const message of ['Prime Zidane or prime Kaká?', 'rate Main Nine']) {
    const { opened } = await sendDeep(message);
    assert.equal(opened, false, message);
  }
});


// --- Deep by default --------------------------------------------------------------------------

await test('the constant is on: deep mode is the default path', () => {
  assert.equal(DEEP_BY_DEFAULT, true);
});

await test('a turn asks for deep through its flag or the default, and fast always says no', () => {
  for (const byDefault of [false, true]) {
    assert.equal(wantsDeep({ deep: true }, byDefault), true);
    assert.equal(wantsDeep({ fast: true }, byDefault), false);
    assert.equal(wantsDeep({ deep: true, fast: true }, byDefault), false, 'fast wins when both arrive');
  }
  assert.equal(wantsDeep({}, false), false);
  assert.equal(wantsDeep({}, true), true);
  assert.equal(wantsDeep({}), DEEP_BY_DEFAULT, 'the default is the constant');
});

await test('with the default on, every turn the entry rule accepts takes the loop without a flag, and Fast does not', () => {
  const r = (intent: string) => ({ intent }) as any;
  const on = { byDefault: true };
  assert.equal(takesDeepPath({ ...on, route: r('tactical_chat'), historical: false }), true);
  assert.equal(takesDeepPath({ ...on, route: r('compare'), historical: false }), true);
  assert.equal(takesDeepPath({ ...on, fast: true, route: r('tactical_chat'), historical: false }), false);
  // The turns the rule rejects are unchanged.
  assert.equal(takesDeepPath({ ...on, route: r('tactical_chat'), historical: true }), false);
  assert.equal(takesDeepPath({ ...on, route: r('single_dossier'), historical: false }), false);
  assert.equal(takesDeepPath({ ...on, route: r('challenge_or_revise'), historical: false }), false);
  assert.equal(takesDeepPath({ ...on, route: r('archive_inventory'), historical: false }), false);
  assert.equal(takesDeepPath({ ...on, route: r('tactical_chat'), historical: false, noRating: true }), false);
  assert.equal(takesDeepPath({ ...on, route: r('tactical_chat'), historical: false, gaffa: true }), false);
  assert.equal(takesDeepPath({ ...on, route: r('tactical_chat'), historical: false, image: true }), false);
});

await test('with the default off, an unflagged turn never takes the loop and the Deep flag still does', () => {
  const r = (intent: string) => ({ intent }) as any;
  assert.equal(takesDeepPath({ byDefault: false, route: r('tactical_chat'), historical: false }), false);
  assert.equal(takesDeepPath({ route: r('tactical_chat'), historical: false }), DEEP_BY_DEFAULT, 'an unflagged turn follows the constant');
  assert.equal(takesDeepPath({ byDefault: false, deep: true, route: r('tactical_chat'), historical: false }), true);
});

await test('the toggle reads Deep and sends deep when the default is off, Fast and sends fast when it is on', () => {
  assert.deepEqual(speedToggle(false), { text: 'Deep', tooltip: 'Deep: the scout takes longer and decides its own research', options: { deep: true } });
  const fast = speedToggle(true);
  assert.equal(fast.text, 'Fast');
  assert.match(fast.tooltip, /answers quickly from a fixed research pass/);
  assert.deepEqual(fast.options, { fast: true });
  assert.equal(speedToggle().text, speedToggle(DEEP_BY_DEFAULT).text);
});

await test('the composer renders each label and wires its option', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ChatInput } = await import('../components/ChatInput');
  const props = { onSendMessage: () => {}, isLoading: false, loadingMessage: '', localCards: [], onScoutName: () => {} };
  const off = renderToStaticMarkup(React.createElement(ChatInput, { ...props, deepByDefault: false }));
  const on = renderToStaticMarkup(React.createElement(ChatInput, { ...props, deepByDefault: true }));
  assert.match(off, /aria-pressed="false"[^>]*title="Deep: the scout takes longer and decides its own research"/);
  assert.match(off, /toggle_off<\/span>Deep<\/button>/);
  assert.match(on, /title="Fast: the scout answers quickly from a fixed research pass"/);
  assert.match(on, /toggle_off<\/span>Fast<\/button>/);
  assert.ok(!on.includes('>Deep<'), 'no Deep label when the default is on');
  assert.ok(!off.includes('>Fast<'), 'no Fast label when the default is off');
});

// --- The fallback -----------------------------------------------------------------------------

/** Runs `fn` with console.warn collected (the rest silenced). */
async function warned<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const { log, info, warn } = console;
  console.log = console.info = () => {};
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(' '));
  try {
    return { value: await fn(), warnings };
  } finally {
    Object.assign(console, { log, info, warn });
  }
}

await test('the loop reports why it gave up: no text at all, or its budget spent with no answer', async () => {
  const params = baseParams('Q');
  const empty = fakeModel([callsReply(call('get_league_table', { league: 'A' })), { text: '', calls: [], finishReason: 'STOP' }]);
  await assert.rejects(
    quietly(() => runDeepTurn(params, { model: empty.model, tools: fakeTools({ t: 0 }).tools, snapshots: null, managers: async () => [] })),
    (e: any) => e instanceof DeepFailure && e.reason === 'empty' && /failed to return a valid text response/.test(e.message),
  );
  // Rounds spent, then nothing but another tool call and an empty reply to the plain request.
  const spent = fakeModel([callsReply(call('get_league_table', { league: 'A' })), callsReply(call('get_league_table', { league: 'B' })), { text: '', calls: [] }]);
  await assert.rejects(
    quietly(() => runDeepTurn(params, { model: spent.model, tools: fakeTools({ t: 0 }).tools, snapshots: null, managers: async () => [], budget: { rounds: 1 } })),
    (e: any) => e instanceof DeepFailure && e.reason === 'budget' && /rounds budget was spent/.test(e.message),
  );
});

await test('a loop that fails runs the stage pipeline once, with its label and a log line; one that answers does not', async () => {
  const labels: string[] = [];
  const paths: PathInfo[] = [];
  let stageRuns = 0;
  const hooks = { onStageChange: (l: string) => labels.push(l), onPath: (p: PathInfo) => paths.push(p) };
  const stage = async () => (++stageRuns, 'the stage answer');

  for (const [reason, failure] of [
    ['error', new Error('network down')],
    ['empty', new DeepFailure('empty', 'no text')],
    ['budget', new DeepFailure('budget', 'spent')],
  ] as const) {
    labels.length = paths.length = stageRuns = 0;
    const { value, warnings } = await warned(() => runDeepWithFallback(async () => Promise.reject(failure), stage, hooks));
    assert.equal(value, 'the stage answer', reason);
    assert.equal(stageRuns, 1, `${reason}: the stage pipeline ran once`);
    assert.deepEqual(labels, [FALLBACK_STAGE_LABEL]);
    assert.deepEqual(paths, [{ path: 'deep' }, { path: 'stage', fallback: reason }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`^\\[deep\\] fallback \\(${reason}\\): `));
  }

  labels.length = paths.length = stageRuns = 0;
  const { value, warnings } = await warned(() => runDeepWithFallback(async () => 'the deep answer', stage, hooks));
  assert.equal(value, 'the deep answer');
  assert.equal(stageRuns, 0);
  assert.deepEqual(labels, []);
  assert.deepEqual(paths, [{ path: 'deep' }]);
  assert.deepEqual(warnings, []);
  assert.match(FALLBACK_STAGE_LABEL, /standard route/);
});

await test('the stage run starts only after the loop has stopped', async () => {
  const events: string[] = [];
  await warned(() =>
    runDeepWithFallback(
      async () => {
        events.push('deep start');
        await new Promise((r) => setTimeout(r, 10));
        events.push('deep end');
        throw new Error('boom');
      },
      async () => (events.push('stage'), 'ok'),
    ),
  );
  assert.deepEqual(events, ['deep start', 'deep end', 'stage']);
});

// --- Both paths through sendMessageToAI -------------------------------------------------------

/** One turn through sendMessageToAI with the deep model faked; the stage pipeline reaches only the refusing fetch. */
async function sendTurn(message: string, options: Record<string, unknown>, script: (DeepReply | ((sent: Sent[]) => DeepReply))[], deepDeps: Record<string, unknown> = {}) {
  const fake = fakeModel(script);
  const paths: PathInfo[] = [];
  const stages: string[] = [];
  const { value, warnings } = await warned(() =>
    sendMessageToAI(message, [], undefined, [], [], {
      onPath: (p) => paths.push(p),
      onStageChange: (l) => stages.push(l),
      ...options,
      deepDeps: { model: fake.model, tools: fakeTools({ t: 0 }).tools, snapshots: null, managers: async () => [], ...deepDeps },
    }).catch((e) => `failed: ${e?.message ?? e}`),
  );
  return { reply: value as string, opened: fake.opened() !== null, sent: fake.sent, paths, stages, warnings };
}
const PRESENT = "Break down Southside's build-up shape this season";
const DEEP_ANSWER = [answer('A deep answer about the present.')];

await test('with the default on, a present-day message runs the loop without a flag, and a past thread takes the stage pipeline', async () => {
  const present = await sendTurn(PRESENT, { deepByDefault: true }, DEEP_ANSWER);
  assert.ok(present.opened);
  assert.equal(present.reply, 'A deep answer about the present.');
  assert.deepEqual(present.paths, [{ path: 'deep' }]);
  const past = await sendTurn('Prime Zidane or prime Kaká?', { deepByDefault: true }, DEEP_ANSWER);
  assert.equal(past.opened, false);
  assert.deepEqual(past.paths, [{ path: 'stage' }]);
  // A rating takes the rating pipeline, which has no chat path to report.
  const rating = await sendTurn('rate Main Nine', { deepByDefault: true }, DEEP_ANSWER);
  assert.equal(rating.opened, false);
  assert.deepEqual(rating.paths, []);
});

await test('with the default on, Fast sends a present-day message to the stage pipeline', async () => {
  const fast = await sendTurn(PRESENT, { deepByDefault: true, fast: true }, DEEP_ANSWER);
  assert.equal(fast.opened, false);
  assert.deepEqual(fast.paths, [{ path: 'stage' }]);
  // Fast is not a fallback: nothing was warned and no label said the route changed.
  assert.deepEqual(fast.warnings.filter((w) => w.includes('[deep]')), []);
  assert.ok(!fast.stages.includes(FALLBACK_STAGE_LABEL));
});

await test('with the default off, an unflagged message takes the stage pipeline and Deep still takes the loop', async () => {
  const plain = await sendTurn(PRESENT, { deepByDefault: false }, DEEP_ANSWER);
  assert.equal(plain.opened, false);
  assert.deepEqual(plain.paths, [{ path: 'stage' }]);
  const unset = await sendTurn(PRESENT, {}, DEEP_ANSWER);
  assert.equal(unset.opened, DEEP_BY_DEFAULT, 'an unflagged message follows the constant');
  const deep = await sendTurn(PRESENT, { deepByDefault: false, deep: true }, DEEP_ANSWER);
  assert.ok(deep.opened);
  assert.deepEqual(deep.paths, [{ path: 'deep' }]);
  // `deep` and `fast` force a path whatever the constant says.
  const forcedStage = await sendTurn(PRESENT, { deepByDefault: true, fast: true, deep: true }, DEEP_ANSWER);
  assert.equal(forcedStage.opened, false);
});

await test('a loop that throws falls back to the stage pipeline once, with the label and the log line', async () => {
  const turn = await sendTurn(PRESENT, { deepByDefault: true }, [
    () => {
      throw new Error('model unavailable');
    },
  ]);
  assert.ok(turn.opened);
  assert.deepEqual(turn.paths, [{ path: 'deep' }, { path: 'stage', fallback: 'error' }]);
  assert.ok(turn.stages.includes(FALLBACK_STAGE_LABEL));
  assert.equal(turn.stages.filter((l) => l === FALLBACK_STAGE_LABEL).length, 1);
  assert.equal(turn.warnings.filter((w) => w.startsWith('[deep] fallback (error)')).length, 1);
  assert.equal(turn.sent.length, 1, 'the loop made one attempt');
});

await test('an empty reply and a spent budget with no answer each fall back once', async () => {
  const empty = await sendTurn(PRESENT, { deepByDefault: true }, [{ text: '', calls: [], finishReason: 'STOP' }]);
  assert.deepEqual(empty.paths, [{ path: 'deep' }, { path: 'stage', fallback: 'empty' }]);
  const spent = await sendTurn(
    PRESENT,
    { deepByDefault: true },
    [callsReply(call('get_league_table', { league: 'A' })), callsReply(call('get_league_table', { league: 'B' })), { text: '', calls: [] }],
    { budget: { rounds: 1 } },
  );
  assert.deepEqual(spent.paths, [{ path: 'deep' }, { path: 'stage', fallback: 'budget' }]);
  assert.equal(spent.warnings.filter((w) => w.startsWith('[deep] fallback (budget)')).length, 1);
});

await test('a loop that is slow but answers never falls back', async () => {
  // Each reading of the clock moves a minute on, so the time budget is spent after the first round.
  let t = 0;
  const turn = await sendTurn(
    PRESENT,
    { deepByDefault: true },
    [callsReply(call('get_league_table', { league: 'A' })), answer('A late but complete answer.')],
    { now: () => (t += 60_000) },
  );
  assert.equal(turn.reply, 'A late but complete answer.');
  assert.deepEqual(turn.paths, [{ path: 'deep' }]);
  assert.deepEqual(turn.warnings.filter((w) => w.includes('[deep] fallback')), []);
  assert.ok(!turn.stages.includes(FALLBACK_STAGE_LABEL));
});

await test('with the default off, a failing Deep turn falls back the same way', async () => {
  const turn = await sendTurn(PRESENT, { deepByDefault: false, deep: true }, [
    () => {
      throw new Error('model unavailable');
    },
  ]);
  assert.deepEqual(turn.paths, [{ path: 'deep' }, { path: 'stage', fallback: 'error' }]);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
