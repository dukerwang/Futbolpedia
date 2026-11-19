#!/usr/bin/env npx tsx
/**
 * Offline checks for past mode in the chat loop (`services/pastTurn.ts`, `services/chatTurn.ts`,
 * behind `PAST_MODE`): which turns take the loop with the switch on and off, the first message's
 * cards, era snapshots and settled verdicts, the past budget and instructions, `commit_verdict` against the cards and a settled verdict, card pairs reported
 * with path `commit`, proposals and departures sent to the settled-verdict store, the figure budget
 * from a commitment, a present turn comparing carded versions, and that with the switch off every
 * path builds exactly what it built before. The model, tools, stores and network are faked; Gemini
 * is refused at fetch.
 *
 * Usage:
 *   npx tsx scripts/test-past-mode.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';
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

// Gemini is refused at fetch, and every request is kept so a test can say what was asked.
const fetched: { url: string; body: string }[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  fetched.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
  return new Response(JSON.stringify({ error: { code: 400, message: 'offline test' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const { CALIBRATION_EPOCH_MS } = await import('../services/dossierCache');
const { getCardKey } = await import('../services/dossierCards');
const { ReplyComposer } = await import('../services/replyBlocks');
const { PAST_MODE, runChatTurn, takesChatLoop, DEFAULT_RESEARCH_BUDGET, MAX_CARD_READS } = await import('../services/chatTurn');
const {
  CARD_ANCHOR_NOTE,
  COMMIT_VERDICT_DECLARATION,
  PAST_LOOP_RULES,
  PAST_RESEARCH_NOTE,
  createCommitTool,
  pastFigureBudget,
  pastUncheckedFor,
  proposalFor,
  readCommitment,
} = await import('../services/pastTurn');
const { checkCommitment, toStanding } = await import('../services/debateConsistency');
const { memoryVerdictDb, verdictKey, fingerprintOf, DEBATE_VERDICT_VERSION } = await import('../services/debateVerdicts');
const { readDisagreementReport } = await import('../services/cardDisagreements');
const { addEvidence, emptyLedger } = await import('../services/evidenceLedger');
type ChatModel = import('../services/chatTurn').ChatModel;
type ChatRoundReply = import('../services/chatTurn').ChatRoundReply;
type ChatToolResponse = import('../services/chatTurn').ChatToolResponse;
type TurnStats = import('../services/chatTurn').TurnStats;

// --- Fakes ------------------------------------------------------------------------------------

const card = (name: string, overall: number, window: string | null, placement?: PlayerProfile['peerPlacement']): PlayerProfile =>
  ({
    basicInfo: { name, age: 28, nationality: 'N/A', club: 'Northside', position: 'Centre-Back' },
    ratings: { overall, potential: overall },
    attributes: {},
    strengths: [],
    weaknesses: [],
    playstyleAndRole: { playstyle: { archetype: 'Archetype', description: 'Prose.' }, bestRoles: [] },
    shortBio: 'Bio.',
    latestUpdate: 'Update.',
    evaluationDate: '2026-10-25',
    createdAt: CALIBRATION_EPOCH_MS + 1000,
    version: window
      ? { id: `${name}-prime`, type: 'prime', label: `Prime (${window})`, evaluationDate: '2026-10-25', seasonOrEra: window }
      : { id: `${name}-current`, type: 'current', label: 'Current form', evaluationDate: '2026-11-01' },
    ...(placement ? { peerPlacement: placement } : {}),
  }) as unknown as PlayerProfile;

const HIGH = card('Aldo Stopper', 93, '2003-06', { betterThan: ['Carlo Sweeper'], levelWith: [], notAsGoodAs: [] });
const LOW = card('Bruno Marker', 90, '2004-07');
const NOW = card('Dario Current', 88, null);

const found = (kind: 'career_record' | 'season_record', label: string, content: string): ToolOutcome => ({
  status: 'found',
  result: { kind, label, content, sources: ['Wikipedia'], stage: 'facts' },
  missing: [],
});

function fakeTools(log: string[] = []): ResearchToolset {
  return {
    clubRecentTeam: async (club) => (log.push(`club ${club}`), { status: 'empty', result: null, missing: [] }),
    playerSeason: async (name) => (log.push(`season ${name}`), { status: 'empty', result: null, missing: [] }),
    leagueTable: async () => ({ status: 'empty', result: null, missing: [] }),
    webSearch: async (q) => (log.push(`search ${q}`), { status: 'empty', result: null, missing: [] }),
    card: async () => ({ status: 'empty', result: null, missing: [] }),
    clubSeason: async (club, season) => (log.push(`club_season ${club} ${season}`), found('season_record', `${season} ${club} F.C. season`, `${club} won the league in ${season} with 90 points.`)),
    playerCareer: async (name) => (log.push(`career ${name}`), found('career_record', `${name} (footballer)`, `${name} played 120 league matches from 2003 to 2006.`)),
  };
}

interface Sent {
  message: string | ChatToolResponse[];
  tools: boolean;
  only?: string[];
}

function fakeModel(script: (ChatRoundReply | ((sent: Sent[]) => ChatRoundReply))[]) {
  const sent: Sent[] = [];
  let opened: { systemInstruction: string; declarations: string[] } | null = null;
  const model: ChatModel = {
    open(args) {
      opened = { systemInstruction: args.systemInstruction, declarations: args.declarations.map((d) => String(d.name)) };
      return {
        async send(message, { tools, only, onText }) {
          sent.push({ message, tools, ...(only ? { only } : {}) });
          const next = script[Math.min(sent.length - 1, script.length - 1)];
          const reply = typeof next === 'function' ? next(sent) : next;
          if (reply.text) onText?.(reply.text);
          return reply;
        },
      };
    },
  };
  return { model, sent, opened: () => opened! };
}
const call = (name: string, args: Record<string, unknown>) => ({ name, args });
const callsReply = (...calls: { name: string; args: Record<string, unknown> }[]): ChatRoundReply => ({ text: '', calls });
const answer = (text: string): ChatRoundReply => ({ text, calls: [] });
const responsesOf = (s: Sent): ChatToolResponse[] => (Array.isArray(s.message) ? s.message : []);

const route = (over: Record<string, unknown> = {}) =>
  ({
    intent: 'compare',
    analyticalMode: 'head_to_head',
    targetPlayers: ['Aldo Stopper', 'Bruno Marker'],
    targetClubs: [],
    searchQueries: [],
    isHistorical: true,
    wantsRegeneration: false,
    needsSearch: false,
    ...over,
  }) as any;

const params = (message: string, cards: PlayerProfile[], over: Record<string, unknown> = {}) => ({
  message,
  route: route(),
  history: [],
  isEAFCRequest: false,
  conversationDossiers: cards,
  savedDossiers: [],
  lockedDossiersBlock: '',
  savedDossiersBlock: '',
  composer: new ReplyComposer(),
  conversationId: `past-${Math.random()}`,
  ...over,
});

const eraStore = (builtAt = '2026-11-01T00:00:00Z') => {
  const asked: string[] = [];
  const builds: string[] = [];
  return {
    asked,
    builds,
    source: {
      stored: async (req: any) => {
        asked.push(`${req.kind}:${req.subject}:${req.period}`);
        await req.facts;
        return req.kind === 'player_window' && req.subject === 'Aldo Stopper'
          ? {
              key: 'player_window:aldo-stopper:2003-06',
              kind: 'player_window' as const,
              subject: 'Aldo Stopper',
              period: '2003-06',
              story: { summary: 'The best defender of his league in those seasons.', setup: 'Left of a back four.', people: [], record: 'Two league titles.', figures: ['36 league appearances in 2004-05 (Wikipedia)'], disputed: [] },
              sources: ['Wikipedia'],
              builtAt,
              version: 1,
            }
          : null;
      },
      get: async (req: any) => (builds.push(`${req.kind}:${req.subject}:${req.period}`), null),
    },
  };
};

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { log, info, warn } = console;
  console.log = console.info = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, info, warn });
  }
};

function pastDeps(over: Record<string, unknown> = {}) {
  const net = { settled: [] as Record<string, unknown>[], departed: [] as string[] };
  const pairs: unknown[] = [];
  const managersAsked: string[][] = [];
  let stats: TurnStats | null = null;
  const deps = {
    tools: fakeTools(),
    snapshots: null,
    managers: async (clubs: string[]) => (managersAsked.push(clubs), []),
    eras: eraStore().source,
    verdicts: memoryVerdictDb(),
    pastNetwork: { settle: (b: Record<string, unknown>) => net.settled.push(b), depart: (k: string) => net.departed.push(k) },
    reportDisagreements: (p: unknown[]) => pairs.push(...p),
    onStats: (s: TurnStats) => (stats = s),
    ...over,
  };
  return { deps, net, pairs, managersAsked, stats: () => stats! };
}

// --- The switch and the entry -----------------------------------------------------------------

await test('PAST_MODE is on: a question about the past takes the loop, and with it off it never does', () => {
  assert.equal(PAST_MODE, true);
  const r = (intent: string) => ({ intent }) as any;
  assert.equal(takesChatLoop({ route: r('compare'), historical: true }), true);
  assert.equal(takesChatLoop({ route: r('compare'), historical: true, pastMode: false }), false);
  assert.equal(takesChatLoop({ route: r('compare'), historical: true, pastMode: true }), true);
  assert.equal(takesChatLoop({ route: r('tactical_chat'), historical: true, pastMode: true }), true);
  // Every other exclusion holds with past mode on.
  for (const extra of [{ stage: true }, { noRating: true }, { gaffaTrade: true }, { image: true }]) {
    assert.equal(takesChatLoop({ route: r('compare'), historical: true, pastMode: true, ...extra }), false, JSON.stringify(extra));
  }
  for (const intent of ['single_dossier', 'challenge_or_revise', 'archive_inventory']) {
    assert.equal(takesChatLoop({ route: r(intent), historical: true, pastMode: true }), false, intent);
  }
});

const BRIEF_PROMPT = "planning a football analyst's answer to a question about the past";

await test('through sendMessageToAI: off, a past question takes the debate path; on, the loop, with no early debate brief', async () => {
  const { sendMessageToAI } = await import('../services/geminiService');
  const run = async (pastMode?: boolean) => {
    fetched.length = 0;
    const fake = fakeModel([answer('A loop answer about the past.')]);
    let opened = false;
    const wrapped: ChatModel = { open: (a) => ((opened = true), fake.model.open(a)) };
    await quietly(() =>
      sendMessageToAI('Prime Zidane or prime Kaká?', [], undefined, [], [], {
        ...(pastMode === undefined ? {} : { pastMode }),
        chatDeps: { model: wrapped, tools: fakeTools(), snapshots: null, managers: async () => [], eras: null, verdicts: memoryVerdictDb(false), pastNetwork: { settle: () => {}, depart: () => {} } },
      }).catch(() => ''),
    );
    return { opened, briefAsked: fetched.some((f) => f.body.includes(BRIEF_PROMPT)), system: opened ? fake.opened().systemInstruction : '' };
  };
  const byDefault = await run();
  assert.equal(byDefault.opened, true, 'by default (PAST_MODE on): the loop answers');
  assert.equal(byDefault.briefAsked, false, 'by default: no debate brief is written');
  const off = await run(false);
  assert.equal(off.opened, false, 'off: the debate pipeline answers');
  assert.equal(off.briefAsked, true, 'off: the early debate brief starts as before');
  const on = await run(true);
  assert.equal(on.opened, true, 'on: the loop answers');
  assert.equal(on.briefAsked, false, 'on: no debate brief is written');
  assert.ok(on.system.includes(PAST_RESEARCH_NOTE));
});

await test('a Gaffa-club conversation whose user names the past runs the loop without the club', async () => {
  const { sendMessageToAI } = await import('../services/geminiService');
  let gaffaBuilt = false;
  const fake = fakeModel([answer('An answer about two primes.')]);
  await quietly(() =>
    sendMessageToAI('Prime Zidane or prime Kaká?', [], undefined, [], [], {
      pastMode: true,
      gaffaBag: { connected: true, club_id: 'c1', league_id: 'l1', club_name: 'Club' } as any,
      chatDeps: { model: fake.model, tools: fakeTools(), snapshots: null, managers: async () => [], eras: null, verdicts: memoryVerdictDb(false), pastNetwork: { settle: () => {}, depart: () => {} }, onGaffaTurn: () => (gaffaBuilt = true) },
    }).catch(() => ''),
  );
  assert.ok(fake.opened(), 'the loop ran');
  assert.equal(gaffaBuilt, false);
  assert.ok(!fake.opened().declarations.includes('grep_gaffa_market'));
});

// --- The first message ------------------------------------------------------------------------

await test('a past turn reads the cards in order, their era snapshots and the settled verdicts, and looks up no coach', async () => {
  const db = memoryVerdictDb();
  await db.write({
    verdict_key: verdictKey('head_to_head', 'output', [`card:${getCardKey(HIGH)}`, `card:${getCardKey(LOW)}`]),
    kind: 'head_to_head',
    criterion: 'output',
    subject_set: [`card:${getCardKey(HIGH)}`, `card:${getCardKey(LOW)}`].sort().join('|'),
    scope_key: null,
    subjects: [
      { key: `card:${getCardKey(HIGH)}`, label: 'Aldo Stopper (prime, 2003-06)' },
      { key: `card:${getCardKey(LOW)}`, label: 'Bruno Marker (prime, 2004-07)' },
    ],
    verdict: [`card:${getCardKey(LOW)}`],
    criteria: ['Goals from set pieces'],
    counter_case: 'The other won more.',
    fingerprint: fingerprintOf([`card:${getCardKey(HIGH)}`, `card:${getCardKey(LOW)}`], new Map([[getCardKey(HIGH), HIGH], [getCardKey(LOW), LOW]])),
    era_mark: null,
    status: 'current',
    departures: 0,
    version: DEBATE_VERDICT_VERSION,
    settled_at: '2026-11-15T00:00:00Z',
  });
  const eras = eraStore('2026-11-01T00:00:00Z');
  const h = pastDeps({ verdicts: db, eras: eras.source });
  const fake = fakeModel([answer('An answer about two primes.')]);
  await quietly(() => runChatTurn(params('Prime Stopper or prime Marker?', [LOW, HIGH], { historical: true, pastMode: true }), { ...h.deps, model: fake.model }));
  const prompt = String(fake.sent[0].message);
  assert.match(prompt, /<cards_in_play>[\s\S]*1\. Aldo Stopper's prime \(2003-06\) card, 93[\s\S]*2\. Bruno Marker's prime \(2004-07\) card, 90[\s\S]*judged better than Carlo Sweeper[\s\S]*<\/cards_in_play>/);
  assert.match(prompt, /<settled_verdicts>\n- output: Bruno Marker \(prime, 2004-07\) over Aldo Stopper \(prime, 2003-06\) \(settled 2026-11-15, current\)\. Argued on: Goals from set pieces\. Against it: The other won more\.\n<\/settled_verdicts>/);
  assert.match(prompt, /<factual_foundation>[\s\S]*The best defender of his league in those seasons[\s\S]*<\/factual_foundation>/, 'the era snapshot is evidence');
  assert.match(prompt, /<factual_foundation>[\s\S]*Aldo Stopper played 120 league matches[\s\S]*Bruno Marker played 120 league matches[\s\S]*<\/factual_foundation>/, 'the records fetched before the first round are in it');
  assert.ok(prompt.includes(PAST_LOOP_RULES), 'the past writing rules, under the old instruction set');
  assert.doesNotMatch(prompt, /<verified_managers>/);
  assert.deepEqual(h.managersAsked, [], 'no coach is looked up for the first message');
  assert.ok(eras.asked.includes('player_window:Aldo Stopper:2003-06'));
  const opened = fake.opened();
  assert.ok(opened.systemInstruction.includes(PAST_RESEARCH_NOTE) && opened.systemInstruction.includes(CARD_ANCHOR_NOTE));
  assert.match(opened.systemInstruction, /Budget for this turn: 60 seconds of research, 8 lookups \(at most 2 of them web searches\) and 5 rounds/);
  assert.ok(opened.declarations.includes('commit_verdict'));
});

// --- commit_verdict ---------------------------------------------------------------------------

await test('a commitment against the cards: told so, asked for a reason, the pair reported as a commitment, and the reason recorded', async () => {
  const h = pastDeps();
  const commit = (departs?: string) =>
    call('commit_verdict', { kind: 'head_to_head', criterion: 'peak_level', sides: ['Aldo Stopper', 'Bruno Marker'], verdict: 'Bruno Marker', ...(departs ? { departs } : {}) });
  const fake = fakeModel([
    callsReply(call('player_career', { name: 'Bruno Marker' }), commit()),
    callsReply(commit('His record in those seasons was stronger.')),
    answer('Marker, though the cards rate Stopper higher: his record in those seasons was stronger.'),
  ]);
  await quietly(() => runChatTurn(params('Prime Stopper or prime Marker?', [HIGH, LOW], { historical: true, pastMode: true }), { ...h.deps, model: fake.model }));
  const first = responsesOf(fake.sent[1]).find((r) => r.name === 'commit_verdict')!.response;
  assert.equal(first.cards, 'against');
  assert.match(String(first.cardsSay), /Aldo Stopper's prime \(2003-06\) card, 93 is rated above Bruno Marker's prime \(2004-07\) card, 90/);
  assert.match(String(first.next), /call commit_verdict again with departs/);
  const second = responsesOf(fake.sent[2]).find((r) => r.name === 'commit_verdict')!.response;
  assert.equal(second.next, 'Write the answer.');
  assert.deepEqual(h.pairs, [{ higher: getCardKey(HIGH), lower: getCardKey(LOW), via: 'commit' }], 'reported once, as a commitment');
  assert.deepEqual(readDisagreementReport({ pairs: h.pairs }), h.pairs, 'the server route accepts the deep path');
  const s = h.stats();
  assert.equal(s.past?.committed, true);
  assert.equal(s.past?.cards, 'against');
  assert.equal(s.past?.departed, true);
  assert.equal(s.past?.departedSilently, false);
  assert.equal(s.rounds, 1, 'a round that only commits costs no round');
  assert.equal(s.calls, 1, 'committing costs no lookup');
  assert.deepEqual(h.net.settled, [{ kind: 'head_to_head', criterion: 'peak_level', subjects: [`card:${getCardKey(HIGH)}`, `card:${getCardKey(LOW)}`], verdict: [`card:${getCardKey(LOW)}`] }]);
  assert.deepEqual(h.net.departed, []);
});

await test('a second commitment against the cards with no reason is recorded as a silent departure', async () => {
  const h = pastDeps();
  const commit = call('commit_verdict', { kind: 'head_to_head', criterion: 'mixed', sides: ['Aldo Stopper', 'Bruno Marker'], verdict: 'Bruno Marker' });
  const fake = fakeModel([callsReply(commit), callsReply(commit), answer('Marker.')]);
  await quietly(() => runChatTurn(params('Stopper or Marker at their best?', [HIGH, LOW], { historical: true, pastMode: true }), { ...h.deps, model: fake.model }));
  assert.equal(h.stats().past?.departedSilently, true);
  assert.equal(h.pairs.length, 1, 'the pair is reported once a turn');
});

await test('a commitment on a measure the cards do not settle is not held to them; one that agrees is recorded quietly', async () => {
  for (const [criterion, verdict, cards] of [
    ['output', 'Bruno Marker', 'unsettled'],
    ['big_games', 'Bruno Marker', 'unsettled'],
    ['peak_level', 'Aldo Stopper', 'agree'],
  ] as const) {
    const h = pastDeps();
    const fake = fakeModel([callsReply(call('commit_verdict', { kind: 'head_to_head', criterion, sides: ['Aldo Stopper', 'Bruno Marker'], verdict })), answer('An answer.')]);
    await quietly(() => runChatTurn(params('Stopper or Marker?', [HIGH, LOW], { historical: true, pastMode: true }), { ...h.deps, model: fake.model }));
    const r = responsesOf(fake.sent[1])[0].response;
    assert.equal(r.cards, cards, criterion);
    assert.equal(r.next, 'Write the answer.');
    assert.deepEqual(h.pairs, []);
  }
});

await test('departing from a current settled verdict is recorded against its key, with no text', async () => {
  const subjects = [`card:${getCardKey(HIGH)}`, `card:${getCardKey(LOW)}`];
  const key = verdictKey('head_to_head', 'influence', subjects);
  const db = memoryVerdictDb();
  await db.write({
    verdict_key: key,
    kind: 'head_to_head',
    criterion: 'influence',
    subject_set: [...subjects].sort().join('|'),
    scope_key: null,
    subjects: subjects.map((k) => ({ key: k, label: k })),
    verdict: [subjects[1]],
    criteria: [],
    counter_case: '',
    fingerprint: fingerprintOf(subjects, new Map([[getCardKey(HIGH), HIGH], [getCardKey(LOW), LOW]])),
    era_mark: null,
    status: 'current',
    departures: 0,
    version: DEBATE_VERDICT_VERSION,
    settled_at: '2026-11-15T00:00:00Z',
  });
  const h = pastDeps({ verdicts: db, eras: null });
  const fake = fakeModel([
    callsReply(call('commit_verdict', { kind: 'head_to_head', criterion: 'influence', sides: ['Aldo Stopper', 'Bruno Marker'], verdict: 'Aldo Stopper', departs: 'His side lost far less often with him.' })),
    answer('Stopper.'),
  ]);
  await quietly(() => runChatTurn(params('Who mattered more to his side?', [HIGH, LOW], { historical: true, pastMode: true }), { ...h.deps, model: fake.model }));
  const r = responsesOf(fake.sent[1])[0].response;
  assert.equal(r.settledVerdict, 'differs');
  assert.deepEqual(h.net.departed, [key]);
  assert.equal(h.stats().past?.settled, 'against');
  assert.equal(h.stats().past?.priors.current, 1);
});

await test('commit_verdict reads its arguments strictly', () => {
  assert.ok('error' in readCommitment({ kind: 'verdict', criterion: 'output', sides: ['a', 'b'] }));
  assert.ok('error' in readCommitment({ kind: 'head_to_head', criterion: 'legacy', sides: ['a', 'b'], verdict: 'a' }));
  assert.ok('error' in readCommitment({ kind: 'head_to_head', criterion: 'output', sides: ['a'], verdict: 'a' }));
  assert.ok('error' in readCommitment({ kind: 'ranking', criterion: 'output', sides: ['a'], order: ['a'] }));
  const ok = readCommitment({ kind: 'ranking', criterion: 'Big games', sides: [], order: ['a', 'b'], scope: { position: 'centre-backs', period: '2000s' }, figures: ['1', '2', '3', '4', '5'] });
  assert.ok(!('error' in ok));
  if (!('error' in ok)) {
    assert.equal(ok.criterion, 'big_games');
    assert.equal(ok.scope?.key, 'centre-back|2000s');
    assert.equal(ok.figures.length, 4);
  }
});

await test('checkCommitment: agree, level, against, unsettled and uncarded', () => {
  const level = card('Elio Libero', 93, '1998-01');
  const st = [HIGH, LOW, level].map(toStanding);
  const h2h = (verdict: string, criterion = 'peak_level', sides = ['Aldo Stopper', 'Bruno Marker']) => checkCommitment({ kind: 'head_to_head', criterion, sides, verdict }, st).cards;
  assert.equal(h2h('Aldo Stopper'), 'agree');
  assert.equal(h2h('Bruno Marker'), 'against');
  assert.equal(h2h('Bruno Marker', 'sustained_level'), 'unsettled');
  assert.equal(h2h('Aldo Stopper', 'mixed', ['Aldo Stopper', 'Nobody Carded']), 'uncarded');
  assert.equal(checkCommitment({ kind: 'ranking', criterion: 'mixed', sides: [], order: ['Bruno Marker', 'Aldo Stopper', 'Someone Else'] }, st).cards, 'against');
  assert.equal(checkCommitment({ kind: 'ranking', criterion: 'mixed', sides: [], order: ['Aldo Stopper', 'Elio Libero', 'Bruno Marker'] }, st).cards, 'level', 'equal Overall and no placement between them');
});

await test('a proposal keys club seasons through the records read this turn, and leaves out what it cannot key', () => {
  let ledger = emptyLedger();
  ledger = addEvidence(ledger, { kind: 'season_record', label: '2003–04 Northside F.C. season', content: 'x' });
  ledger = addEvidence(ledger, { kind: 'season_record', label: '1998–99 Southside F.C. season', content: 'y' });
  const c = readCommitment({ kind: 'head_to_head', criterion: 'mixed', sides: ['Northside 2003-04', 'Southside 1998-99'], verdict: 'Northside 2003-04' });
  assert.ok(!('error' in c));
  if ('error' in c) return;
  assert.deepEqual(proposalFor(c, [], ledger, ''), { kind: 'head_to_head', criterion: 'mixed', subjects: ['club_season:northside-fc:2003-04', 'club_season:southside-fc:1998-99'], verdict: ['club_season:northside-fc:2003-04'] });
  assert.equal(proposalFor(c, [], emptyLedger(), ''), null, 'no record, no key');
  const single = readCommitment({ kind: 'single', criterion: 'mixed', sides: ['Northside 2003-04'] });
  assert.ok(!('error' in single) && proposalFor(single, [], ledger, '') === null, 'a single verdict is not stored');
});

await test('the figure budget comes from the figures a commitment named, and there is none otherwise', () => {
  assert.equal(pastFigureBudget(null), undefined);
  const bare = createCommitTool({ standings: () => [], ledger: () => null, settled: [], message: '', report: () => {} });
  bare.handle({ kind: 'head_to_head', criterion: 'output', sides: ['a', 'b'], verdict: 'a' });
  assert.equal(pastFigureBudget(bare.state), undefined, 'a judgment that named no figures has no budget');
  const tool = createCommitTool({ standings: () => [], ledger: () => null, settled: [], message: '', report: () => {} });
  tool.handle({ kind: 'head_to_head', criterion: 'output', sides: ['a', 'b'], verdict: 'a', figures: ['league goals in the 2004-05 season', 'assists in all competitions across the window'] });
  assert.deepEqual(pastFigureBudget(tool.state), { max: 5, slots: ['league goals in the 2004-05 season', 'assists in all competitions across the window'] });
});

await test('a past answer to a question asking for numbers keeps every figure its records give, however many', async () => {
  // Eight figures, all in the record: the ceiling of six the first eval used would cut the last two sentences.
  const season = 'In 2004-05 Aldo Stopper scored 30 league goals, 5 Champions League goals, 3 FA Cup goals and 1 Community Shield goal. By type: 18 goals with his right foot, 9 goals with his left foot, 3 headed goals and 11 goals from outside the box; 9 league assists.';
  const tools: ResearchToolset = { ...fakeTools(), playerCareer: async (name) => found('career_record', `${name} (footballer)`, season) };
  const h = pastDeps({ eras: null, tools });
  const reply = 'Aldo Stopper scored 30 league goals in 2004-05. He added 5 Champions League goals and 3 FA Cup goals. He scored 1 Community Shield goal. He scored 18 goals with his right foot and 9 goals with his left foot. He scored 3 headed goals. He scored 11 goals from outside the box. He made 9 league assists.';
  const fake = fakeModel([answer(reply)]);
  const out = await quietly(() =>
    runChatTurn(params('How many goals did Aldo Stopper score in 2004-05?', [HIGH], { route: route({ intent: 'tactical_chat', analyticalMode: 'player_qa', targetPlayers: ['Aldo Stopper'], requestedSeason: '2004-05' }), historical: true, pastMode: true }), {
      ...h.deps,
      model: fake.model,
    }),
  );
  for (const figure of ['30 league goals', '5 Champions League goals', '3 FA Cup goals', '18 goals with his right foot', '3 headed goals', '11 goals from outside the box', '9 league assists']) {
    assert.ok(out.includes(figure), figure);
  }
});

await test('a past reply is held to its committed figures, by the scoped gate', async () => {
  const h = pastDeps({ eras: null });
  const figures = ['league appearances in the 2004-05 season'];
  const fake = fakeModel([
    callsReply(call('player_career', { name: 'Aldo Stopper' }), call('commit_verdict', { kind: 'head_to_head', criterion: 'output', sides: ['Aldo Stopper', 'Bruno Marker'], verdict: 'Aldo Stopper', figures })),
    answer('Stopper played 120 league matches from 2003 to 2006. He also won 7 trophies in one night. He scored 45 league goals in 2004-05.'),
  ]);
  const reply = await quietly(() => runChatTurn(params('Stopper or Marker?', [HIGH, LOW], { historical: true, pastMode: true }), { ...h.deps, model: fake.model, gateFeedback: async () => ({ replacements: [] }) }));
  assert.match(reply, /120 league matches/, 'a figure the record gives stays');
  assert.doesNotMatch(reply, /45 league goals|7 trophies/, 'figures no source gives go');
});

await test('the unchecked line names the records a past turn has not read', () => {
  let ledger = emptyLedger();
  assert.deepEqual(pastUncheckedFor({ cards: [HIGH, LOW], clubs: ['Northside'], season: '2003-04' }, ledger), [
    "Aldo Stopper's career record",
    "Bruno Marker's career record",
    "Northside's 2003-04 season record",
  ]);
  ledger = addEvidence(ledger, { kind: 'career_record', label: 'Aldo Stopper (footballer)', content: 'x' });
  ledger = addEvidence(ledger, { kind: 'season_record', label: '2003–04 Northside F.C. season', content: 'y' });
  assert.deepEqual(pastUncheckedFor({ cards: [HIGH, LOW], clubs: ['Northside'], season: '2003-04' }, ledger), ["Bruno Marker's career record"]);
});

await test('a record read on a past turn whose era snapshot is missing starts one build', async () => {
  const eras = eraStore();
  const h = pastDeps({ eras: eras.source });
  const fake = fakeModel([callsReply(call('player_career', { name: 'Bruno Marker' }), call('club_season', { club: 'Northside', season: '2004-05' })), answer('An answer.')]);
  await quietly(() => runChatTurn(params('Stopper or Marker?', [HIGH, LOW], { historical: true, pastMode: true }), { ...h.deps, model: fake.model }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(eras.builds, ['player_window:Bruno Marker:2004-07']);
});

// --- A present turn comparing versions --------------------------------------------------------

await test('a present turn comparing two carded versions gets the card order and commit_verdict, and nothing else past', async () => {
  const h = pastDeps({ eras: null });
  const fake = fakeModel([answer('An answer.')]);
  await quietly(() =>
    runChatTurn(params('Is Dario Current already better than prime Aldo Stopper?', [HIGH, NOW], { route: route({ isHistorical: false, targetPlayers: ['Dario Current', 'Aldo Stopper'] }), historical: false, pastMode: true }), {
      ...h.deps,
      model: fake.model,
    }),
  );
  const prompt = String(fake.sent[0].message);
  assert.match(prompt, /<cards_in_play>/);
  assert.ok(fake.opened().declarations.includes('commit_verdict'));
  assert.ok(fake.opened().systemInstruction.includes(CARD_ANCHOR_NOTE));
  assert.ok(!fake.opened().systemInstruction.includes(PAST_RESEARCH_NOTE));
  assert.match(fake.opened().systemInstruction, new RegExp(`Budget for this turn: ${DEFAULT_RESEARCH_BUDGET.ms / 1000} seconds`), 'the present budget');
  assert.ok(!prompt.includes(PAST_LOOP_RULES));
  assert.equal(h.stats().past?.historical, false);
});

// --- Off is as before ---------------------------------------------------------------------------

await test('with past mode off, the loop builds exactly what it built before, past flags or not', async () => {
  const runOnce = async (extra: Record<string, unknown>) => {
    const h = pastDeps({ eras: null });
    const fake = fakeModel([answer('An answer.')]);
    let stats: TurnStats | null = null;
    const p = params('Is Dario Current already better than prime Aldo Stopper?', [HIGH, NOW], { route: route({ isHistorical: false, targetPlayers: ['Dario Current', 'Aldo Stopper'] }), conversationId: 'same', ...extra });
    await quietly(() => runChatTurn(p, { ...h.deps, model: fake.model, onStats: (s) => (stats = s) }));
    return { prompt: String(fake.sent[0].message), system: fake.opened().systemInstruction, declarations: fake.opened().declarations, stats: stats!, settled: h.net.settled, pairs: h.pairs };
  };
  const before = await runOnce({ pastMode: false });
  for (const extra of [{ pastMode: false, historical: true }]) {
    const after = await runOnce(extra);
    assert.equal(after.prompt, before.prompt, JSON.stringify(extra));
    assert.equal(after.system, before.system);
    assert.deepEqual(after.declarations, before.declarations);
    assert.equal(after.stats.past, undefined);
    assert.deepEqual(after.settled, []);
  }
  assert.ok(!before.declarations.includes('commit_verdict'));
  assert.doesNotMatch(before.prompt, /<cards_in_play>|<settled_verdicts>/);
  assert.ok(!before.system.includes(CARD_ANCHOR_NOTE));
});

// --- Prompts ------------------------------------------------------------------------------------

await test('the card note tells the loop that level cards leave the order to the criteria, not to a tie', () => {
  assert.match(CARD_ANCHOR_NOTE, /Cards that are level don't decide between those versions; the criteria do/);
  assert.match(CARD_ANCHOR_NOTE, /Leave two versions tied only when the criteria can't separate them either/);
  const level = card('Elio Libero', 93, '1998-01');
  const check = checkCommitment({ kind: 'ranking', criterion: 'mixed', sides: [], order: ['Aldo Stopper', 'Elio Libero'] }, [HIGH, level].map(toStanding));
  assert.equal(check.cards, 'level');
  assert.match(String(check.note), /commit to one/);
});

await test('the past notes and the tool description are descriptive: no players, clubs or quoted phrases', () => {
  for (const text of [PAST_RESEARCH_NOTE, CARD_ANCHOR_NOTE, PAST_LOOP_RULES, String(COMMIT_VERDICT_DECLARATION.description)]) {
    assert.doesNotMatch(text, /["“”]/);
    assert.doesNotMatch(text, /\b(Arsenal|Barcelona|Milan|Madrid|Zidane|Messi|Maldini|\d{2} Overall)\b/);
  }
});

// --- Eval support ------------------------------------------------------------------------------

await test('the historical report compares committed verdicts in code and lists each run\'s research and commitment', async () => {
  const { sameCommitment, researchTable, researchSummary, parseHistoryGrade } = await import('./eval-history');
  const past = (verdict: string[], extra: Record<string, unknown> = {}) => ({
    path: 'chat' as const,
    lookups: 2,
    searches: 0,
    rounds: 1,
    views: { ranking: 1 },
    past: { committed: true, kind: 'head_to_head', criterion: 'peak_level', verdict, cards: 'agree', settled: 'none', departed: false, departedSilently: false, priors: { current: 1, stale: 0, contested: 0 }, rankingPriorFound: null, ...extra },
  });
  assert.equal(sameCommitment(past(['Aldo Stopper']), past(['Stopper (prime, 2003-06)'])), 'same', 'names compared by surname, windows ignored');
  assert.equal(sameCommitment(past(['Aldo Stopper']), past(['Bruno Marker'])), 'different');
  assert.equal(sameCommitment(past(['Aldo Stopper']), { ...past([]), past: undefined } as any), null, 'no commitment, no code comparison');
  const q = { n: 1, text: 'Prime Stopper or prime Marker?', tests: 'Head-to-head' };
  const runs = [
    { q, attempt: 1, run: { answer: 'a', firstTokenMs: 1, totalMs: 2, perf: [], research: past(['Aldo Stopper']) }, grade: null },
    { q, attempt: 2, run: { answer: 'b', firstTokenMs: 1, totalMs: 2, perf: [], research: past(['Bruno Marker'], { cards: 'against', departed: true }) }, grade: null },
  ] as any;
  const table = researchTable(runs);
  assert.match(table, /\| 1 \| 1 \| chat \| 2 \| 0 \| 1 \| 1 ranking \| 0\/0\/0 \| head_to_head, peak_level: Aldo Stopper \| agree \| none \(1 current, 0 stale\) \| – \| – \|/);
  const stored = researchTable([{ q, attempt: 1, run: { answer: 'a', firstTokenMs: 1, totalMs: 2, perf: [], research: { ...past(['Aldo Stopper']), settles: ['invalid (club_season:x-fc:2003-04)'] } }, grade: null }] as any);
  assert.match(stored, /\| invalid \(club_season:x-fc:2003-04\) \|$/m, 'what the store answered, with the subject it could not resolve');
  assert.match(researchSummary([{ q, attempt: 1, run: { answer: 'a', firstTokenMs: 1, totalMs: 2, perf: [], research: { ...past(['A']), settles: ['stored', 'refused', 'stored'] } }, grade: null }] as any), /Settled-verdict store: 3 proposals; 2 stored, 1 refused/);
  assert.match(table, /against, departed/);
  assert.match(researchSummary(runs), /Committed a verdict: 2 of 2 chat loop answers; against the cards 1 \(departed with a reason 1, silently 0\)/);
  assert.equal(researchTable([{ q, attempt: 1, run: { answer: 'a', firstTokenMs: 1, totalMs: 2, perf: [] }, grade: null }] as any), '', 'a stage run reports no research table');
  const grade = parseHistoryGrade('{"wrongFigures":[],"blendedSeasons":[],"myths":[],"criteria":4,"counterCase":"yes","decisiveness":5,"verdict":"A","notes":"n","ratingsOutOfPlace":"yes"}');
  assert.equal(grade?.ratingsOutOfPlace, 'yes');
  assert.equal(parseHistoryGrade('{"criteria":4}')?.ratingsOutOfPlace, 'no');
});

// --- Cards in play, end to end ----------------------------------------------------------------

await test('a past head-to-head has its cards in play, and a commitment naming their windows agrees with them', async () => {
  const h = pastDeps({ eras: null });
  const fake = fakeModel([
    callsReply(call('commit_verdict', { kind: 'head_to_head', criterion: 'peak_level', sides: ['Aldo Stopper (prime, 2003-06)', 'Bruno Marker (prime, 2004-07)'], verdict: 'Aldo Stopper (prime, 2003-06)' })),
    answer('Stopper, at his best.'),
  ]);
  await quietly(() => runChatTurn(params('Who was better at his best, Stopper or Marker?', [HIGH, LOW], { historical: true, pastMode: true }), { ...h.deps, model: fake.model }));
  assert.match(String(fake.sent[0].message), /<cards_in_play>[\s\S]*1\. Aldo Stopper's prime \(2003-06\) card, 93[\s\S]*2\. Bruno Marker's prime \(2004-07\) card, 90/);
  const r = responsesOf(fake.sent[1])[0].response;
  assert.equal(r.cards, 'agree');
  assert.equal(h.stats().past?.cards, 'agree');
  assert.deepEqual(h.net.settled, [{ kind: 'head_to_head', criterion: 'peak_level', subjects: [`card:${getCardKey(HIGH)}`, `card:${getCardKey(LOW)}`], verdict: [`card:${getCardKey(HIGH)}`] }], 'the commitment is proposed under its card keys');
});

await test('a ranking committed without looking anyone up is still held to the cards: the sides it names are read through the card lookup', async () => {
  const h = pastDeps({ eras: null });
  const commit = (order: string[]) => call('commit_verdict', { kind: 'ranking', criterion: 'mixed', sides: [], order, scope: { position: 'Centre-Back', period: '2000s' } });
  const fake = fakeModel([callsReply(commit(['Bruno Marker (2000–2007)', 'Aldo Stopper (2001–2008)'])), answer('An order.')]);
  // No player is named in the question and none was looked up: the cards are only in your dossiers.
  await quietly(() =>
    runChatTurn(params('Who were the best centre-backs of the 2000s, in order?', [], { route: route({ intent: 'tactical_chat', analyticalMode: 'ranking_or_tierlist', targetPlayers: [] }), savedDossiers: [HIGH, LOW], historical: true, pastMode: true }), {
      ...h.deps,
      model: fake.model,
    }),
  );
  const r = responsesOf(fake.sent[1])[0].response;
  assert.equal(r.cards, 'against', 'the decade windows the model wrote still resolve to the prime cards');
  assert.deepEqual(h.pairs, [{ higher: getCardKey(HIGH), lower: getCardKey(LOW), via: 'commit' }]);
  assert.equal(h.stats().calls, 0, 'reading the cards costs no lookup');
});

// --- The eval's setup ---------------------------------------------------------------------------

await test('the eval installs the read-only Supabase client before any app module loads, and a late install is caught', async () => {
  const { readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(root, 'scripts/eval-live-questions.ts'), 'utf8');
  const install = source.indexOf('history.installReadOnlySupabase()');
  assert.ok(install > 0 && install < source.indexOf('startEvalSessionOrExit(flags'), 'installed before the session, which loads the model client');
  // Only the dry run, which exits before anything is asked, imports a service module earlier.
  const dryRunBlock = [source.indexOf('if (flags.dryRun) {'), source.indexOf('process.exit(0);', source.indexOf('if (flags.dryRun) {'))];
  const early = [...source.matchAll(/await import\('\.\.\/services\//g)].map((m) => m.index!).filter((i) => i < install);
  assert.ok(dryRunBlock[0] > 0 && early.every((i) => i > dryRunBlock[0] && i < dryRunBlock[1]), 'and before any service module outside the dry run');
  // The card store reads the client once, when it loads: installed after the model client, it has none.
  const loaded = (late: boolean) => {
    const code = `(async () => { const h = await import(${JSON.stringify(join(root, 'scripts/eval-history.ts'))}); ${late ? `await import(${JSON.stringify(join(root, 'services/aiClient.ts'))});` : ''} h.installReadOnlySupabase(); process.stdout.write(String(await h.sharedCardsLoaded())); })();`;
    const out = spawnSync('npx', ['tsx', '-e', code], { cwd: root, encoding: 'utf8', timeout: 90_000 });
    return out.stdout.trim().split('\n').pop();
  };
  assert.equal(loaded(false), 'true');
  assert.equal(loaded(true), 'false');
});

// --- Card reads and the budget -----------------------------------------------------------------

/** Ten centre-backs' prime cards, best first by Overall, for a ranking. */
const BACKS = Array.from({ length: 10 }, (_, i) => card(`Back Number${String.fromCharCode(65 + i)}`, 95 - i, `${2000 + i}-${String(3 + i).padStart(2, '0')}`));
const rankingParams = (cards: PlayerProfile[], over: Record<string, unknown> = {}) =>
  params('Who were the ten best centre-backs of the 2000s, in order?', [], {
    route: route({ intent: 'tactical_chat', analyticalMode: 'ranking_or_tierlist', targetPlayers: [] }),
    savedDossiers: cards,
    historical: true,
    pastMode: true,
    ...over,
  });

await test('a ranking whose card reads would have spent the old lookup budget still commits, and is held to the cards', async () => {
  const h = pastDeps({ eras: null });
  const names = BACKS.map((c) => c.basicInfo.name);
  const fake = fakeModel([
    callsReply(...names.map((name) => call('look_up_dossier', { name }))),
    // The model swaps the first two: the cards put them the other way.
    callsReply(call('commit_verdict', { kind: 'ranking', criterion: 'peak_level', sides: [], order: [names[1], names[0], ...names.slice(2)], scope: { position: 'Centre-Back', period: '2000s' } })),
    answer('An order.'),
  ]);
  await quietly(() => runChatTurn(rankingParams(BACKS), { ...h.deps, model: fake.model }));
  const reads = responsesOf(fake.sent[1]);
  assert.equal(reads.length, 10);
  assert.ok(reads.every((r) => r.response.status !== 'not_run'), 'every card was read');
  assert.equal(h.stats().calls, 0, 'ten card reads cost no lookup (the past budget is 8)');
  assert.equal(h.stats().rounds, 1, 'the round still counts');
  assert.equal(h.stats().past?.committed, true);
  assert.equal(h.stats().past?.cards, 'against');
  assert.deepEqual(h.pairs, [{ higher: getCardKey(BACKS[0]), lower: getCardKey(BACKS[1]), via: 'commit' }]);
});

await test(`card reads stop at ${MAX_CARD_READS} a turn`, async () => {
  const h = pastDeps({ eras: null });
  const fake = fakeModel([callsReply(...Array.from({ length: MAX_CARD_READS + 2 }, (_, i) => call('look_up_dossier', { name: BACKS[i % BACKS.length].basicInfo.name }))), answer('An order.')]);
  await quietly(() => runChatTurn(rankingParams(BACKS), { ...h.deps, model: fake.model }));
  const reads = responsesOf(fake.sent[1]);
  assert.equal(reads.filter((r) => r.response.status === 'not_run').length, 2);
  assert.match(String(reads[reads.length - 1].response.reason), new RegExp(`card-read ceiling \\(${MAX_CARD_READS} a turn\\)`));
  assert.equal(h.stats().calls, 0);
});

await test('a past turn at its budget may still call commit_verdict, and only it, before writing', async () => {
  const h = pastDeps({ eras: null, budget: { calls: 1 } });
  const fake = fakeModel([
    callsReply(call('player_career', { name: 'Aldo Stopper' })),
    callsReply(call('commit_verdict', { kind: 'head_to_head', criterion: 'peak_level', sides: ['Aldo Stopper', 'Bruno Marker'], verdict: 'Aldo Stopper' })),
    answer('Stopper.'),
  ]);
  const reply = await quietly(() => runChatTurn(params('Stopper or Marker at their best?', [HIGH, LOW], { historical: true, pastMode: true }), { ...h.deps, model: fake.model }));
  assert.equal(reply, 'Stopper.');
  assert.equal(fake.sent[1].tools, true);
  assert.deepEqual(fake.sent[1].only, ['commit_verdict'], 'the round after the budget allows only commit_verdict');
  assert.match(String(responsesOf(fake.sent[1])[0].response.researchOver), /call it now, before you write; no other tool is available/);
  assert.equal(fake.sent[2].tools, false, 'then calling is off and the model writes');
  assert.equal(responsesOf(fake.sent[2])[0].response.cards, 'agree');
  assert.equal(h.stats().stop, 'calls');
  assert.equal(h.stats().past?.committed, true);
  assert.deepEqual(h.net.settled.length, 1, 'the commitment is proposed');
});

await test('at the budget, a past turn that already committed, or writes instead, and a present turn are unchanged', async () => {
  // Already committed: calling goes off as before.
  const done = pastDeps({ eras: null, budget: { calls: 1 } });
  const commit = call('commit_verdict', { kind: 'head_to_head', criterion: 'peak_level', sides: ['Aldo Stopper', 'Bruno Marker'], verdict: 'Aldo Stopper' });
  const fake = fakeModel([callsReply(commit, call('player_career', { name: 'Aldo Stopper' })), answer('Stopper.')]);
  await quietly(() => runChatTurn(params('Stopper or Marker at their best?', [HIGH, LOW], { historical: true, pastMode: true }), { ...done.deps, model: fake.model }));
  assert.equal(fake.sent[1].tools, false);
  assert.equal(fake.sent[1].only, undefined);
  // Offered the commit and wrote instead: the text is the answer.
  const wrote = pastDeps({ eras: null, budget: { calls: 1 } });
  const fake2 = fakeModel([callsReply(call('player_career', { name: 'Aldo Stopper' })), answer('Stopper, on the record.')]);
  const reply = await quietly(() => runChatTurn(params('Stopper or Marker at their best?', [HIGH, LOW], { historical: true, pastMode: true }), { ...wrote.deps, model: fake2.model }));
  assert.equal(reply, 'Stopper, on the record.');
  assert.equal(fake2.sent.length, 2);
  // A present turn comparing carded versions keeps calling off at its budget.
  const present = pastDeps({ eras: null, budget: { calls: 1 } });
  const fake3 = fakeModel([callsReply(call('get_player_season', { name: 'Dario Current' })), answer('An answer.')]);
  await quietly(() =>
    runChatTurn(params('Is Dario Current already better than prime Aldo Stopper?', [HIGH, NOW], { route: route({ isHistorical: false, targetPlayers: ['Dario Current', 'Aldo Stopper'] }), historical: false, pastMode: true }), {
      ...present.deps,
      model: fake3.model,
    }),
  );
  assert.equal(fake3.sent[1].tools, false);
  assert.equal(fake3.sent[1].only, undefined);
});

await test('a model that refuses the commit-only round gets it again with calling off, and the turn still answers', async () => {
  const h = pastDeps({ eras: null, budget: { calls: 1 } });
  const sent: { tools: boolean; only?: string[] }[] = [];
  const model = {
    open: () => ({
      async send(_message: unknown, { tools, only }: { tools: boolean; only?: string[] }) {
        sent.push({ tools, ...(only ? { only } : {}) });
        if (sent.length === 1) return callsReply(call('player_career', { name: 'Aldo Stopper' }));
        if (only) throw new Error('HTTP 400: mode VALIDATED is not supported');
        return answer('Stopper.');
      },
    }),
  };
  const perfLines: string[] = [];
  const reply = await quietly(() =>
    runChatTurn({ ...params('Stopper or Marker at their best?', [HIGH, LOW], { historical: true, pastMode: true }), perf: (l: string) => perfLines.push(l) }, { ...h.deps, model: model as any }),
  );
  assert.equal(reply, 'Stopper.');
  assert.deepEqual(sent.slice(1), [{ tools: true, only: ['commit_verdict'] }, { tools: false }]);
  assert.ok(perfLines.includes('commit-only round refused'), 'the eval sees the refusal in its perf lines');
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
