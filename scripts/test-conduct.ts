#!/usr/bin/env npx tsx
/**
 * Offline checks for reading the user's need and for conduct under pushback, with the model and
 * the tools faked: the need read on both briefs and how the writer gets it, a disputed fact always
 * researched, too-slow lookups filed as unchecked rather than unknowable (and the writer given its
 * tools for them), the conduct rules on every path, and the multi-turn eval cases (parsed from the
 * live set, run with a fake pipeline and grader).
 *
 * Usage:
 *   npx tsx scripts/test-conduct.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatNeedForWriter, hasCheckableObjection, NEED_SCHEMA, readNeed } from '../services/userNeed';
import {
  BRIEF_SCHEMA,
  buildBriefPrompt,
  ensureObjectionCheck,
  formatBriefNeedForWriter,
  runResearch,
  type ResearchBrief,
  type ResearchContext,
  type ResearchModel,
} from '../services/researchAgent';
import {
  BRIEF_SCHEMA as DEBATE_BRIEF_SCHEMA,
  buildDebateBriefPrompt,
  ensureDebateObjectionCheck,
  readDebateBrief,
} from '../services/debateBrief';
import { addGap, emptyLedger, formatLedger } from '../services/evidenceLedger';
import { fileOutcomes, type ResearchToolset, type ToolOutcome } from '../services/researchTools';
import { CONVERSATIONAL_SCOUT_MANDATE } from '../prompts/chatPrompt';
import { presentFactRules, proseModeGuidance, writerNeedsNetwork } from '../services/conversationalScout';
import { DEFAULT_DEEP_BUDGET, deepModeRules } from '../services/deepTurn';
import {
  checksFor,
  conductPrompt,
  conversationReport,
  gaffaClubFromEnv,
  historyFor,
  parseConductGrade,
  readConversations,
  runConversation,
  testedTurns,
  UNIVERSAL_CHECKS,
  type ConversationCase,
} from './eval-conversations';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const need = {
  goal: 'Decide whether to spend the last roster spot on cover for an injured starter',
  settle: ['When the starter is likely back', 'Whether cover is worth the spot'],
  objection: 'The last reply recommended a third player in a position the user already covers',
  objectionFact: "What is the starter's current availability?",
};

// --- The need read ------------------------------------------------------------------------------

await test('a need is read from the model, trimmed and capped, and an empty one is none', () => {
  const read = readNeed({ ...need, goal: `  ${need.goal}  `, settle: ['a', '', 'b', 'c', 'd', 'e', 3] });
  assert.equal(read?.goal, need.goal);
  assert.deepEqual(read?.settle, ['a', 'b', 'c', 'd']);
  assert.equal(readNeed({}), null);
  assert.equal(readNeed(undefined), null);
  assert.equal(readNeed('nonsense'), null);
  assert.equal(hasCheckableObjection(read), true);
  assert.equal(hasCheckableObjection(readNeed({ goal: 'x', objection: 'a judgment call' })), false);
});

await test('both briefs ask for the need in their schema and prompt', () => {
  for (const schema of [BRIEF_SCHEMA, DEBATE_BRIEF_SCHEMA] as any[]) {
    assert.equal(schema.properties.need, NEED_SCHEMA);
    assert.ok(schema.required.includes('need'));
  }
  assert.deepEqual((NEED_SCHEMA as any).required, ['goal', 'settle', 'objection', 'objectionFact']);
  const ctx: ResearchContext = { message: 'm', thread: '', cardsInPlay: [], hints: { clubs: [], players: [] } };
  const live = buildBriefPrompt(ctx);
  const past = buildDebateBriefPrompt({ message: 'm', thread: '', cards: [], hints: { clubs: [], players: [] } });
  for (const prompt of [live, past]) {
    assert.match(prompt, /objectionFact: when the objection rests on a fact that can be checked/);
    assert.match(prompt, /the user's word neither settles it nor is dismissed, so plan the lookup that settles it/);
    assert.match(prompt, /what they own or control, what they can do next, and what they have already told you/);
  }
  assert.match(live, /When need\.objectionFact is set, one call has to settle it/);
  assert.match(past, /when need\.objectionFact is set, plan the call that settles it/);
});

await test('the writer reads the need as its own block, with the disputed fact to settle', () => {
  const block = formatNeedForWriter(need);
  assert.match(block, /^<user_need>\n/);
  assert.match(block, /What the user is trying to do: Decide whether/);
  assert.match(block, /- When the starter is likely back/);
  assert.match(block, /What they object to in the last reply: /);
  assert.match(block, /The fact the objection turns on: What is the starter's current availability\?/);
  assert.match(block, /partial evidence included\. Don't accept or reject it on the user's word/);
  // No objection: no instruction about one.
  assert.doesNotMatch(formatNeedForWriter({ ...need, objection: '', objectionFact: '' }), /objection/);
  assert.equal(formatNeedForWriter(null), '');
  assert.equal(formatBriefNeedForWriter(null), '');
  assert.equal(formatBriefNeedForWriter({ need } as ResearchBrief), block);
});

await test('a stored settled debate without a need still reads, and a new one keeps its need', () => {
  assert.equal(readDebateBrief({ verdict: 'x', kind: 'head_to_head' }, { message: 'm' }).need, null);
  assert.deepEqual(readDebateBrief({ kind: 'other', need }, { message: 'm' }).need, need);
});

// --- A disputed fact is always researched --------------------------------------------------------

const briefOf = (calls: ResearchBrief['calls'], n = need): ResearchBrief => ({
  understanding: 'u',
  focus: '',
  timeframe: 'timeless',
  outline: [],
  calls,
  unresolved: [],
  need: n,
});

await test('a brief with a disputed fact and no calls gets the lookups for the names spotted, or a search', () => {
  const players = ensureObjectionCheck(briefOf([]), { hints: { clubs: ['Club'], players: ['Some Player'] } });
  assert.deepEqual(players.calls.map((c) => `${c.tool}:${c.subject}`), ['player_season:Some Player', 'club_recent_team:Club']);
  assert.equal(players.timeframe, 'live');
  assert.ok(players.calls.every((c) => c.purpose === need.objectionFact));
  const search = ensureObjectionCheck(briefOf([]), { hints: { clubs: [], players: [] } });
  assert.deepEqual(search.calls.map((c) => `${c.tool}:${c.subject}`), [`web_search:${need.objectionFact}`]);
  // A brief that planned its own calls, or has no disputed fact, is left alone.
  const planned = briefOf([{ tool: 'card', subject: 'Some Player' }]);
  assert.equal(ensureObjectionCheck(planned, { hints: { clubs: [], players: ['Some Player'] } }), planned);
  const noFact = briefOf([], { ...need, objectionFact: '' });
  assert.equal(ensureObjectionCheck(noFact, { hints: { clubs: [], players: ['Some Player'] } }), noFact);
});

await test('research on a pushback turn looks up the disputed fact even when the brief planned nothing', async () => {
  const asked: string[] = [];
  const tools = {
    playerSeason: async (name: string) => (asked.push(`player:${name}`), { status: 'found', result: { kind: 'player_record', label: name, content: 'Status: doubtful, 75% chance of playing' }, missing: [] }),
    clubRecentTeam: async (club: string) => (asked.push(`club:${club}`), { status: 'empty', result: null, missing: [] }),
  } as unknown as ResearchToolset;
  const model: ResearchModel = { writeBrief: async () => briefOf([]), reflect: async () => ({ enough: true, calls: [], unresolved: [], discard: [] }) };
  const quiet = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = () => {};
  const { brief, ledger } = await runResearch(
    { message: 'shouldn’t you know?', thread: '<ongoing_thread>…</ongoing_thread>', cardsInPlay: [], hints: { clubs: [], players: ['Some Player'] } },
    tools,
    {
      model,
      situationModel: { enrich: async () => ({ clubs: [], players: [], unknowns: [] }) },
      scoutNotes: null,
      cardReviews: null,
      snapshots: null,
    },
  ).finally(() => Object.assign(console, quiet));
  assert.deepEqual(asked, ['player:Some Player']);
  assert.equal(brief.calls.length, 1);
  assert.match(formatLedger(ledger), /75% chance of playing/);
});

await test('the debate brief checks a disputed past fact the same way', () => {
  const b = readDebateBrief({ kind: 'other', need, calls: [] }, { message: 'm' });
  const checked = ensureDebateObjectionCheck(b, { hints: { clubs: [], players: ['Player A', 'Player B'] } });
  assert.deepEqual(checked.calls.map((c) => `${c.tool}:${c.subject}`), ['player_career:Player A', 'player_career:Player B']);
  const search = ensureDebateObjectionCheck(b, { hints: { clubs: [], players: [] } });
  assert.deepEqual(search.calls.map((c) => c.tool), ['web_search']);
  const none = readDebateBrief({ kind: 'other', calls: [] }, { message: 'm' });
  assert.equal(ensureDebateObjectionCheck(none, { hints: { clubs: [], players: ['Player A'] } }), none);
});

// --- Too-slow lookups --------------------------------------------------------------------------

await test('a slow lookup is filed as unchecked, under its own heading, and the other headings are unchanged', () => {
  const slow: ToolOutcome = { status: 'failed', result: null, missing: [], note: 'still running when the writer started', slow: true };
  const failed: ToolOutcome = { status: 'failed', result: null, missing: [], note: 'HTTP 500' };
  let ledger = fileOutcomes(emptyLedger(), [{ tool: 'web_search', subject: 'team news' }, { tool: 'league_table', subject: 'League' }], [slow, failed]);
  ledger = addGap(addGap(ledger, 'Injury list (no source)', 'not_covered'), 'Nothing here');
  assert.deepEqual(ledger.gaps.map((g) => g.status), ['slow', 'failed', 'not_covered', 'empty']);
  // The lookup log, which reflect reads, still calls it failed.
  assert.deepEqual(ledger.lookups.map((l) => l.status), ['failed', 'failed']);
  const text = formatLedger(ledger);
  assert.match(text, /\[Not back in time\] These lookups were still running, or never started, when the answer began\. They are unchecked, not unverifiable: where the answer depends on one, check it with your tools before saying it can't be confirmed, and never tell the user about the lookup itself:\n- Web search: team news: still running when the writer started/);
  assert.match(text, /\[Not covered\] No source covers these, so don't fill them from memory; say so where the answer depends on them:\n- Injury list/);
  assert.match(text, /\[Lookup failed\] These lookups failed or were refused; treat their subjects as unverified unless a tool call finds them:\n- League table for League: HTTP 500/);
  assert.match(text, /\[Not found\] These lookups returned nothing; treat their subjects as unverified unless a tool call finds them:\n- Nothing here/);
  // The slow heading comes after the failed one and before not found.
  assert.ok(text.indexOf('[Lookup failed]') < text.indexOf('[Not back in time]') && text.indexOf('[Not back in time]') < text.indexOf('[Not found]'));
});

await test('a records-only writer gets its network tools when a lookup was too slow, as when one failed', () => {
  assert.equal(writerNeedsNetwork(null), false);
  assert.equal(writerNeedsNetwork(addGap(emptyLedger(), 'x', 'empty')), false);
  assert.equal(writerNeedsNetwork(addGap(emptyLedger(), 'x', 'not_covered')), false);
  assert.equal(writerNeedsNetwork(addGap(emptyLedger(), 'x', 'failed')), true);
  assert.equal(writerNeedsNetwork(addGap(emptyLedger(), 'x', 'slow')), true);
});

// --- Conduct rules -----------------------------------------------------------------------------

await test('the system prompt reads the user, checks before conceding and never narrates the pipeline', () => {
  const m = CONVERSATIONAL_SCOUT_MANDATE;
  assert.match(m, /Never describe your own lookups, searches, timeouts, tools or the steps behind an answer/);
  assert.match(m, /\*\*Reading the User:\*\*/);
  assert.match(m, /When \\?`<user_need>\\?` is present, it is that reading/);
  assert.match(m, /what they own or control, what they can actually do next, the limits they work within, and what they have already told you/);
  assert.match(m, /Before saying a fact can't be verified, make sure no entry in the evidence answers it and that you tried the tool that would/);
  assert.match(m, /a status, a percentage chance of playing, a dated report or the latest lineup is an answer/);
  assert.match(m, /Only when the evidence and the tools come back empty, say so plainly in one sentence/);
  assert.match(m, /find the fact now, in \\?`<factual_foundation>\\?` or with a tool, and answer with it/);
  assert.match(m, /Never concede without checking, never answer with an apology alone/);
  assert.doesNotMatch(m, /When the answer needs a fact you can't verify, say so plainly in one sentence and work around it\./);
});

await test('the per-turn fact rules and the past-debate rules say the same', () => {
  assert.match(presentFactRules('2026-27'), /first look for it in every entry and tool result \(partial evidence, such as a status or a percentage chance of playing, is an answer\); if none gives it, look it up with a tool; only if that comes back empty, say so in one sentence/);
  const route = { intent: 'player_qa', targetPlayers: [], targetClubs: [] } as any;
  const other = proseModeGuidance(route, 'debate_or_verdict', '2026-27', readDebateBrief({ kind: 'other' }, { message: 'm' }));
  assert.match(other, /Check a disputed fact against <factual_foundation> or with a tool before conceding or holding firm, never on the user's word alone/);
  const debate = proseModeGuidance(route, 'debate_or_verdict', '2026-27', readDebateBrief({ kind: 'head_to_head' }, { message: 'm' }));
  assert.match(debate, /check a disputed fact against <factual_foundation> or with a tool before conceding or holding firm/);
  assert.match(proseModeGuidance(route, 'debate_or_verdict', '2026-27'), /check it against <factual_foundation> or with a tool before agreeing or holding firm/);
});

await test("deep mode's rules read the need and check a disputed fact this turn", () => {
  const rules = deepModeRules(DEFAULT_DEEP_BUDGET);
  assert.match(rules, /First work out what the user is trying to decide or do, read from the whole conversation, and what a useful answer has to settle for that/);
  assert.match(rules, /pushes back on your last reply over a fact that can be checked, or asks why you didn't know something, look that fact up this turn and answer with it/);
  assert.match(rules, /The user's word neither settles it nor is dismissed/);
});

await test('the new guidance is descriptive: no players, clubs or sample replies', () => {
  const text = [CONVERSATIONAL_SCOUT_MANDATE, deepModeRules(DEFAULT_DEEP_BUDGET), formatNeedForWriter(need), buildBriefPrompt({ message: '', thread: '', cardsInPlay: [], hints: { clubs: [], players: [] } })].join('\n');
  for (const word of ['Martínez', 'Martinez', 'Kinský', 'Gaffa', 'goalkeeper', "You're right", 'timed out']) {
    assert.ok(!text.includes(word), `the guidance mentions ${word}`);
  }
});

// --- Multi-turn eval cases ---------------------------------------------------------------------

const liveSet = readFileSync(join(root, 'docs/superpowers/evals/live-questions.md'), 'utf8');
const cases = readConversations(liveSet);

await test('the live set carries the conversation cases, the shared conversation first', () => {
  assert.deepEqual(cases.map((c) => c.id), ['C1', 'C2', 'C3', 'C4']);
  const c1 = cases[0];
  assert.equal(c1.gaffaClub, true);
  assert.equal(c1.turns.length, 4);
  assert.equal(c1.turns[0].user, 'Which free agent would most improve my weakest starting slot, and what would he cost?');
  assert.equal(c1.turns[3].user, '?? well why can\'t you fuckin confirm it yourself, the fuck?');
  assert.deepEqual(c1.turns.map((t) => Boolean(t.recorded)), [true, true, true, false]);
  assert.deepEqual(testedTurns(c1), [0, 1, 2, 3]);
  assert.match(c1.turns[2].recorded!, /I don't have a verified return date/);
  // No case writes a manager's club ids into the repo.
  assert.doesNotMatch(liveSet, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  // Every tested turn says what a good answer must do; the question table still parses as before.
  for (const c of cases) for (const i of testedTurns(c)) assert.ok(c.turns[i].mustDo!.length >= 2);
  const md = liveSet.slice(liveSet.indexOf('## Questions'), liveSet.indexOf('## Scoring'));
  assert.equal([...md.matchAll(/^\|\s*(\d+)\s*\|/gm)].length, 15);
});

await test('a malformed case block fails loudly, and a section with none has none', () => {
  assert.throws(() => readConversations('## Conversations\n\n```json conversation\n{ nope\n```\n'), /isn't valid JSON/);
  assert.throws(() => readConversations('## Conversations\n\n```json conversation\n{"id": "X", "turns": []}\n```\n'), /needs an id/);
  assert.deepEqual(readConversations('# Nothing'), []);
  assert.deepEqual(gaffaClubFromEnv(' league-1 / club-2 '), { leagueId: 'league-1', clubId: 'club-2' });
  assert.equal(gaffaClubFromEnv('only-one'), null);
  assert.equal(gaffaClubFromEnv(undefined), null);
});

const fakeCase: ConversationCase = {
  id: 'T1',
  title: 'Test case',
  subjects: { players: ['Some Player'] },
  turns: [
    { user: 'first', recorded: 'recorded first' },
    { user: 'second' },
    { user: 'third', mustDo: ['Checks the fact.'] },
    { user: 'fourth', recorded: 'recorded fourth', mustDo: ['Answers plainly.'] },
  ],
};

await test('a run replays recorded turns, chains the rest from live answers, and grades each tested turn', async () => {
  const asked: { message: string; history: string[]; id: string }[] = [];
  const prompts: string[] = [];
  const result = await runConversation(fakeCase, {
    ask: async (message, history, options) => {
      asked.push({ message, history: history.map((m) => `${m.sender}:${m.content}`), id: options.conversationId });
      return { answer: `live ${message}`, totalMs: 1000, perf: [] };
    },
    grade: async (prompt) => {
      prompts.push(prompt);
      const n = prompt.split('\nChecks:\n')[1].trim().split('\n').length;
      return JSON.stringify({ checks: Array.from({ length: n }, (_, i) => ({ check: 'x', met: i !== 0, why: 'because' })) });
    },
    facts: async (subjects) => `facts for ${subjects?.players?.join(', ')}`,
  });
  // The second turn has no recorded reply, so it runs live for the third to follow.
  assert.deepEqual(asked.map((a) => a.message), ['second', 'third', 'fourth']);
  assert.deepEqual(asked[1].history, ['user:first', 'ai:recorded first', 'user:second', 'ai:live second']);
  // Each tested turn gets a conversation of its own, so no research carries over between replays.
  assert.deepEqual(asked.map((a) => a.id), ['eval-T1-t1', 'eval-T1-t2', 'eval-T1-t3']);
  assert.deepEqual(result.turns.map((t) => t.turn), [2, 3]);
  assert.equal(result.turns[0].checks!.length, 1 + UNIVERSAL_CHECKS.length);
  assert.deepEqual(result.turns[0].checks!.map((k) => k.met), [false, true, true, true]);
  assert.equal(result.turns[0].checks![0].check, 'Checks the fact.');
  assert.match(prompts[0], /Live feed data:\nfacts for Some Player/);
  assert.match(prompts[0], /Latest message: third/);
  assert.match(prompts[0], /Scout: live second/);
  const report = conversationReport([result], { today: '2026-11-17', label: 'test', model: 'fake' });
  assert.match(report, /Checks met: 6 of 8/);
  assert.match(report, /\| T1 \| 3 \| 3 \/ 4 \| 1\.0 \| Checks the fact\. \|/);
});

await test('only the turns asked for run, and a turn with nothing to follow is skipped, not run blind', async () => {
  const asked: string[] = [];
  const result = await runConversation(fakeCase, {
    ask: async (message) => (asked.push(message), { answer: message === 'second' ? '' : 'ok', error: message === 'second' ? 'boom' : undefined, totalMs: 1, perf: [] }),
    grade: async () => '{"checks": []}',
    only: [2],
  });
  assert.deepEqual(asked, ['second']);
  assert.equal(result.turns[0].skipped, 'an earlier turn has no reply to follow');
  assert.equal(historyFor(fakeCase, 2, new Map()), null);
  assert.equal(historyFor(fakeCase, 1, new Map())!.length, 2);
});

await test("the grader's answer is read by position, and a short or broken one is none", () => {
  const expected = checksFor({ user: 'x', mustDo: ['A'] });
  const good = parseConductGrade(`Here: {"checks": ${JSON.stringify(expected.map((_, i) => ({ met: i % 2 === 0, why: `w${i}` })))}}`, expected);
  assert.deepEqual(good!.map((k) => k.met), [true, false, true, false]);
  assert.equal(good![0].check, 'A');
  assert.equal(parseConductGrade('{"checks": [{"met": true}]}', expected), null);
  assert.equal(parseConductGrade('no json', expected), null);
  assert.match(conductPrompt(fakeCase, 0, [], 'answer', ''), /\(none: this is the first message\)[\s\S]*None for this case\./);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
