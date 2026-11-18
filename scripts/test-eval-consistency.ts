#!/usr/bin/env npx tsx
/**
 * Offline checks for the repeat-run eval (`scripts/eval-consistency.ts`, run with
 * `npm run eval:live -- --repeat N`), with the pipeline and the graders faked: repeat runs and their
 * order, one run at a time, the consistency comparison's parsing, the spread, lookup variance, card
 * mention scoring, a spending cap ending the run, the report, and the dry-run estimate. No model is
 * called.
 *
 * Usage:
 *   npx tsx scripts/test-eval-consistency.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSUMED_PRICES,
  CEILING_TURN,
  consistencyPrompt,
  estimateRun,
  EXPECTED_TURN,
  findCardCandidates,
  formatEstimate,
  isSpendLimit,
  lookupProfile,
  lookupVariance,
  parseCardMentions,
  parseConsistency,
  questionSpread,
  readLiveQuestions,
  repeatReport,
  runRepeats,
  scoreCardMentions,
  selectQuestions,
  totalsOf,
  versionMismatch,
  type EvalQuestion,
  type RepeatRun,
  type RubricGrade,
  type RunResult,
} from './eval-consistency';

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

const Q = (n: number, text = `Question ${n}`): EvalQuestion => ({ n, text, tests: `tests ${n}` });

const grade = (over: Partial<RubricGrade> = {}): RubricGrade => ({
  staleFacts: [],
  inventedFacts: [],
  saysWhatChanged: 'yes',
  decisiveness: 5,
  hedgedRoles: 0,
  gapsAdmitted: 'not_needed',
  notes: 'fine',
  ...over,
});

const answerRun = (answer: string, over: Partial<RunResult> = {}, tools = ['get_club_recent_team', 'web_search']): RunResult => ({
  answer,
  firstTokenMs: 20_000,
  totalMs: 25_000,
  perf: ['[Perf] lookup get_club_recent_team "Real Madrid": 900ms (found)', '[Perf] lookup web_search "real madrid lineup": 9000ms (found)'],
  research: { path: 'chat', lookups: 2, searches: 1, rounds: 2, toolCalls: tools, stop: 'answered', views: {} },
  ...over,
});

const consistencyJson = (over: any = {}) =>
  JSON.stringify({
    agreement: 'same',
    compared: 3,
    contradictions: [],
    summary: 'The runs agree.',
    ...over,
  });

// --- Questions ---------------------------------------------------------------------------------

const liveSet = readFileSync(join(root, 'docs/superpowers/evals/live-questions.md'), 'utf8');

await test('the live set parses as before: fourteen questions, the card-mention control skipped', () => {
  const all = readLiveQuestions(liveSet);
  assert.equal(all.length, 14);
  assert.equal(all[0].text, "Break down Arsenal's build-up shape this season");
  assert.equal(all.at(-1)!.n, 14);
});

await test('a subset keeps the order given, drops repeats and unknown numbers, and a maximum keeps the first few', () => {
  const all = [Q(1), Q(4), Q(8), Q(11)];
  assert.deepEqual(selectQuestions(all, {}).map((q) => q.n), [1, 4, 8, 11]);
  assert.deepEqual(selectQuestions(all, { only: [11, 4, 99, 11, 1] }).map((q) => q.n), [11, 4, 1]);
  assert.deepEqual(selectQuestions(all, { only: [11, 4, 1], max: 2 }).map((q) => q.n), [11, 4]);
  assert.deepEqual(selectQuestions(all, { max: 3 }).map((q) => q.n), [1, 4, 8]);
});

// --- Repeat runs -------------------------------------------------------------------------------

await test('each question runs the given number of times, one run at a time and question by question', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const events: string[] = [];
  const track = async <T>(label: string, work: () => T): Promise<T> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    events.push(label);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return work();
  };
  let call = 0;
  const result = await runRepeats({
    questions: [Q(4), Q(11)],
    repeat: 3,
    ask: (text) => track(`ask ${text}`, () => answerRun(`answer ${++call}`)),
    gradeRubric: (text) => track(`rubric ${text}`, () => grade()),
    grade: (prompt) => track(prompt.startsWith('You are reading') ? 'mentions' : 'compare', () => consistencyJson()),
    log: () => {},
  });
  assert.equal(maxInFlight, 1, 'nothing runs in parallel');
  assert.deepEqual(result.runs.map((r) => `${r.q.n}.${r.attempt}`), ['4.1', '4.2', '4.3', '11.1', '11.2', '11.3']);
  // Question by question: a question's three runs and its comparison come before the next question.
  const asks = events.map((e, i) => [e, i] as const).filter(([e]) => e.startsWith('ask '));
  assert.deepEqual(asks.map(([e]) => e), ['ask Question 4', 'ask Question 4', 'ask Question 4', 'ask Question 11', 'ask Question 11', 'ask Question 11']);
  assert.ok(events.indexOf('compare') < asks[3][1], 'the first comparison precedes the second question');
  assert.equal(events.filter((e) => e === 'compare').length, 2);
  assert.equal(result.consistency.length, 2);
  assert.equal(result.stoppedEarly, undefined);
});

await test("each run records its path, lookups, searches and rounds, and the comparison sees every answer", async () => {
  const prompts: string[] = [];
  let n = 0;
  const result = await runRepeats({
    questions: [Q(4)],
    repeat: 2,
    ask: async () => {
      n++;
      return answerRun(`Real Madrid start Valverde at right-back, run ${n}.`, {}, n === 1 ? ['get_club_recent_team', 'web_search', 'show_pitch'] : ['get_club_recent_team', 'get_player_season']);
    },
    gradeRubric: async () => grade({ decisiveness: n === 1 ? 5 : 4 }),
    grade: async (prompt) => {
      prompts.push(prompt);
      return consistencyJson();
    },
    cardMentions: false,
    log: () => {},
  });
  assert.equal(result.runs[0].run.research!.path, 'chat');
  assert.deepEqual([result.runs[0].run.research!.lookups, result.runs[0].run.research!.searches, result.runs[0].run.research!.rounds], [2, 1, 2]);
  assert.equal(prompts.length, 1, 'one comparison per question, and no card-mention calls when switched off');
  assert.match(prompts[0], /Question: Question 4/);
  assert.match(prompts[0], /Run 1:\nReal Madrid start Valverde at right-back, run 1\./);
  assert.match(prompts[0], /Run 2:\nReal Madrid start Valverde at right-back, run 2\./);
  assert.equal(result.consistency[0].check!.agreement, 'same');
  assert.deepEqual(result.runs.map((r) => r.mentions), [null, null]);
});

await test('a failed run is kept without a grade, and a question with fewer than two answers has no comparison', async () => {
  let n = 0;
  const graded: string[] = [];
  const result = await runRepeats({
    questions: [Q(4)],
    repeat: 2,
    ask: async () => (++n === 1 ? answerRun('first answer') : { answer: '', error: 'Pipeline blew up', firstTokenMs: null, totalMs: 5, perf: [] }),
    gradeRubric: async (_q, a) => (graded.push(a), grade()),
    grade: async () => consistencyJson(),
    log: () => {},
  });
  assert.deepEqual(graded, ['first answer']);
  assert.equal(result.runs.length, 2);
  assert.equal(result.runs[1].grade, null);
  assert.equal(result.consistency[0].check, null);
  assert.equal(result.consistency[0].note, 'fewer than two answers');
  assert.equal(result.stoppedEarly, undefined, 'an ordinary failure doesn\'t stop the run');
});

await test('a spending cap or rate limit stops the run at once and keeps what finished', async () => {
  assert.equal(isSpendLimit('HTTP 429: temporarily rate-limited to prevent exceeding its monthly spending cap'), true);
  assert.equal(isSpendLimit('RESOURCE_EXHAUSTED'), true);
  assert.equal(isSpendLimit('Pipeline failed: timeout'), false);
  assert.equal(isSpendLimit(undefined), false);
  const asked: string[] = [];
  const result = await runRepeats({
    questions: [Q(4), Q(11), Q(1)],
    repeat: 2,
    ask: async (text) => {
      asked.push(text);
      // The first question completes; the third turn hits the cap.
      return asked.length === 3 ? { answer: '', error: 'got status: 429 spending cap', firstTokenMs: null, totalMs: 1, perf: [] } : answerRun(`answer ${asked.length}`);
    },
    gradeRubric: async () => grade(),
    grade: async () => consistencyJson(),
    log: () => {},
  });
  assert.equal(asked.length, 3, 'nothing is asked after the cap');
  assert.deepEqual(result.runs.map((r) => `${r.q.n}.${r.attempt}`), ['4.1', '4.2'], 'the capped turn is not recorded as a run');
  assert.equal(result.consistency.length, 1, 'the finished question was compared');
  assert.match(result.stoppedEarly!, /Q11, run 1: .*429/);
  const report = repeatReport(result, { today: '2026-11-17', label: 't', model: 'fake', repeat: 2, path: 'the chat loop', cardMentions: true, sharedCards: false });
  assert.match(report, /\*\*Run stopped early:\*\* Q11, run 1/);
  // A grader hitting the cap stops the run too, with the answer it was grading kept.
  const graderCapped = await runRepeats({
    questions: [Q(4), Q(11)],
    repeat: 2,
    ask: async () => answerRun('an answer'),
    gradeRubric: async () => {
      throw new Error('429 RESOURCE_EXHAUSTED');
    },
    grade: async () => consistencyJson(),
    log: () => {},
  });
  assert.equal(graderCapped.runs.length, 1);
  assert.match(graderCapped.stoppedEarly!, /grader 429/);
});

await test('the report is rewritten after every run, so a run cut short keeps what it finished', async () => {
  const sizes: number[] = [];
  await runRepeats({
    questions: [Q(4)],
    repeat: 2,
    ask: async () => answerRun('an answer'),
    gradeRubric: async () => grade(),
    grade: async () => consistencyJson(),
    onUpdate: (r) => sizes.push(r.runs.length),
    log: () => {},
  });
  assert.deepEqual(sizes, [1, 2, 2], 'after each run, and once more with the comparison');
});

// --- Consistency check -------------------------------------------------------------------------

await test('the comparison prompt asks only about committed judgments and numbers each run', () => {
  const prompt = consistencyPrompt('Who starts?', [{ run: 1, answer: 'A' }, { run: 2, answer: 'B' }]);
  assert.match(prompt, /the verdict .*, who starts in each role, and the main claim about what changed/);
  assert.match(prompt, /Ignore wording, length, detail, formatting and the supporting evidence/);
  assert.match(prompt, /Question: Who starts\?\n\nRun 1:\nA\n\nRun 2:\nB$/);
});

await test('a comparison is read into agreement, judgments compared and contradictions', () => {
  const raw = `Here you go:\n${consistencyJson({
    agreement: 'partly',
    compared: 5,
    contradictions: [
      { kind: 'starter', about: 'left back', claims: [{ run: 1, claim: 'Carreras' }, { run: 2, claim: 'Mendy' }] },
      { kind: 'change', about: 'why the shape changed', claims: [{ run: 1, claim: 'a new coach' }, { run: 3, claim: 'injuries' }] },
    ],
    summary: 'Same verdict, different left back.',
  })}`;
  const c = parseConsistency(raw, 3)!;
  assert.equal(c.agreement, 'partly');
  assert.equal(c.compared, 5);
  assert.equal(c.contradictions.length, 2);
  assert.deepEqual(c.contradictions[0], { kind: 'starter', about: 'left back', claims: [{ run: 1, claim: 'Carreras' }, { run: 2, claim: 'Mendy' }] });
  assert.equal(c.summary, 'Same verdict, different left back.');
});

await test('a contradiction needs claims from two different runs that were compared, and "same" beside one becomes "partly"', () => {
  const c = parseConsistency(
    consistencyJson({
      agreement: 'same',
      compared: 1,
      contradictions: [
        { kind: 'verdict', about: 'one run only', claims: [{ run: 1, claim: 'A' }, { run: 1, claim: 'B' }] },
        { kind: 'verdict', about: 'run that does not exist', claims: [{ run: 1, claim: 'A' }, { run: 9, claim: 'B' }] },
        { kind: 'nonsense', about: 'real', claims: [{ run: 1, claim: 'A' }, { run: 2, claim: 'B' }, { run: 2, claim: '' }] },
      ],
    }),
    2,
  )!;
  assert.deepEqual(c.contradictions.map((x) => x.about), ['real']);
  assert.equal(c.contradictions[0].kind, 'other');
  assert.equal(c.contradictions[0].claims.length, 2, 'an empty claim is dropped');
  assert.equal(c.agreement, 'partly');
  assert.equal(c.compared, 1, 'at least the contradictions found');
});

await test('an unreadable comparison is none', () => {
  assert.equal(parseConsistency('no json here', 2), null);
  assert.equal(parseConsistency('{ nope', 2), null);
  assert.equal(parseConsistency('{"agreement": "maybe"}', 2), null);
  assert.equal(parseConsistency('grader failed: 500', 2), null);
});

// --- Spread ------------------------------------------------------------------------------------

const repeatRun = (n: number, attempt: number, g: RubricGrade | null, run: RunResult = answerRun('a'), mentions: RepeatRun['mentions'] = null): RepeatRun => ({ q: Q(n), attempt, run, grade: g, mentions });

await test('the rubric spread is the range of each measure across a question\'s graded runs', () => {
  const runs = [
    repeatRun(4, 1, grade({ staleFacts: [], inventedFacts: [{ claim: 'x', why: 'y' }], decisiveness: 5, hedgedRoles: 0 })),
    repeatRun(4, 2, grade({ staleFacts: [{ claim: 'a', why: 'b' }, { claim: 'c', why: 'd' }], inventedFacts: [], decisiveness: 3, hedgedRoles: 2, saysWhatChanged: 'no' })),
    repeatRun(4, 3, null),
  ];
  const s = questionSpread(4, runs)!;
  assert.equal(s.graded, 2);
  assert.deepEqual([s.stale.min, s.stale.max, s.stale.range], [0, 2, 2]);
  assert.deepEqual([s.invented.min, s.invented.max, s.invented.range], [0, 1, 1]);
  assert.deepEqual([s.decisiveness.min, s.decisiveness.max, s.decisiveness.range, s.decisiveness.mean], [3, 5, 2, 4]);
  assert.equal(s.hedgedRoles.range, 2);
  assert.deepEqual(s.saysWhatChanged.sort(), ['no', 'yes']);
  assert.equal(questionSpread(4, [runs[0], runs[2]]), null, 'one graded run has no spread');
});

// --- Lookups -----------------------------------------------------------------------------------

await test('a run\'s lookups are its tools, with counts, and what each non-search lookup was about', () => {
  const p = lookupProfile(
    answerRun('x', {
      perf: [
        '[Perf] lookup get_club_recent_team "Real Madrid": 900ms (found)',
        '[Perf] lookup get_player_season "Federico Valverde": 400ms (found)',
        '[Perf] lookup web_search "valverde right back form this season": 9000ms (found)',
        '[Perf] writer tool calls: 1',
      ],
    }, ['get_club_recent_team', 'web_search', 'get_player_season', 'show_pitch', 'get_player_season']),
  );
  assert.deepEqual(p.tools, { get_club_recent_team: 1, web_search: 1, get_player_season: 2 }, 'view tools are not lookups');
  assert.deepEqual(p.subjects, ['get_club_recent_team "real madrid"', 'get_player_season "federico valverde"'], 'a search is by tool only, since its wording always differs');
});

await test('runs that looked up different things are counted, down to tools, counts and subjects', () => {
  const same = lookupVariance(1, [repeatRun(1, 1, grade()), repeatRun(1, 2, grade())])!;
  assert.deepEqual([same.sameToolSet, same.sameToolCounts, same.sameSubjects, same.toolOverlap], [true, true, true, 1]);
  assert.deepEqual([same.lookupsRange, same.searchesRange, same.roundsRange], [0, 0, 0]);

  const differentTools = lookupVariance(2, [
    repeatRun(2, 1, grade(), answerRun('a')),
    repeatRun(2, 2, grade(), answerRun('b', { research: { path: 'chat', lookups: 4, searches: 0, rounds: 3, toolCalls: ['get_club_recent_team', 'get_player_season'], views: {} } })),
  ])!;
  assert.equal(differentTools.sameToolSet, false);
  assert.ok(Math.abs(differentTools.toolOverlap - 1 / 3) < 1e-9, 'one tool of three in common');
  assert.deepEqual([differentTools.lookupsRange, differentTools.searchesRange, differentTools.roundsRange], [2, 1, 1]);

  const moreCalls = lookupVariance(3, [
    repeatRun(3, 1, grade(), answerRun('a', {}, ['get_player_season'])),
    repeatRun(3, 2, grade(), answerRun('b', {}, ['get_player_season', 'get_player_season'])),
  ])!;
  assert.deepEqual([moreCalls.sameToolSet, moreCalls.sameToolCounts], [true, false]);

  const otherSubject = lookupVariance(4, [
    repeatRun(4, 1, grade(), answerRun('a')),
    repeatRun(4, 2, grade(), answerRun('b', { perf: ['[Perf] lookup get_club_recent_team "Barcelona": 900ms (found)'] })),
  ])!;
  assert.deepEqual([otherSubject.sameToolSet, otherSubject.sameSubjects], [true, false]);

  const fellBack = lookupVariance(5, [
    repeatRun(5, 1, grade(), answerRun('a')),
    repeatRun(5, 2, grade(), answerRun('b', { research: { path: 'stage', fallback: 'empty', lookups: 5, searches: 3, rounds: 1, views: {} } })),
  ])!;
  assert.equal(fellBack.pathChanges, 1);
  assert.match(fellBack.perRun[1].path, /chat, then stage \(empty\)/);
  assert.equal(lookupVariance(6, [repeatRun(6, 1, grade())]), null, 'one run has nothing to vary against');
});

// --- Card mentions -----------------------------------------------------------------------------

await test('the scan flags sentences that might quote a card and leaves statistics alone', () => {
  const flagged = findCardCandidates(
    [
      'Futbolpedia rates him 91 overall and a World-Class Elite tier player.',
      'His passing is rated 88, with finishing 84.',
      'He scored 14 goals in 28 league games and the club sit 3rd on 62 points.',
      'Arsenal press high with a 4-2-3-1 and 45 minutes of possession.',
    ].join(' '),
  );
  assert.equal(flagged.length, 2);
  assert.ok(flagged.some((s) => s.includes('91 overall')));
  assert.ok(flagged.some((s) => s.includes('passing is rated 88')));
  assert.deepEqual(findCardCandidates('A plain answer about a lineup. He plays on the right. 14 goals in 28 games.'), []);
});

await test('a version other than the one discussed is flagged, and an all-time debate rejects current form only', () => {
  assert.equal(versionMismatch('current', 'all-time'), true, 'current form in an all-time discussion');
  assert.equal(versionMismatch('prime', 'all-time'), false);
  assert.equal(versionMismatch('era', 'all-time'), false);
  assert.equal(versionMismatch('season', 'all-time'), false);
  assert.equal(versionMismatch('prime', 'current'), true);
  assert.equal(versionMismatch('current', 'prime'), true);
  assert.equal(versionMismatch('current', 'current'), false);
  assert.equal(versionMismatch('unstated', 'prime'), false);
  assert.equal(versionMismatch('current', 'none'), false);
});

await test("a grader's mentions are scored by kind, use and version, and a malformed entry is dropped", () => {
  const raw = JSON.stringify({
    mentions: [
      { quote: 'rated 91 overall', kind: 'rating', version: 'current', discussed: 'all-time', helped: false, why: 'Current form in an all-time debate.' },
      { quote: 'a World-Class tier', kind: 'tier', version: 'prime', discussed: 'prime', helped: true, why: 'Separates the two.' },
      { quote: 'passing 88', kind: 'attribute', version: 'unstated', discussed: 'current', helped: false, why: 'Listed, not used.' },
      { quote: '', kind: 'rating', version: 'current', discussed: 'current', helped: true, why: 'empty quote' },
      { quote: 'something', kind: 'goals', version: 'current', discussed: 'current', helped: true, why: 'not a card figure' },
      { quote: 'odd enums', kind: 'rating', version: 'future', discussed: 'someday', helped: 'yes', why: 'enums fall back' },
    ],
  });
  const s = parseCardMentions(raw, 4)!;
  assert.equal(s.candidates, 4);
  assert.equal(s.mentions.length, 4);
  assert.deepEqual(s.byKind, { rating: 2, tier: 1, attribute: 1 });
  assert.equal(s.helped, 1);
  assert.equal(s.decoration, 3, 'a helped value that isn\'t true counts as decoration');
  assert.equal(s.wrongVersion, 1);
  assert.equal(s.mentions[0].wrongVersion, true);
  assert.equal(s.mentions[3].version, 'unstated');
  assert.equal(s.mentions[3].discussed, 'none');
  assert.equal(parseCardMentions('{"mentions": "none"}', 1), null);
  assert.equal(parseCardMentions('oops', 1), null);
});

await test('an answer the scan finds nothing in costs no grader call', async () => {
  const prompts: string[] = [];
  const none = await scoreCardMentions('Who starts?', 'Valverde starts at right-back and Bellingham plays behind the striker.', async (p) => (prompts.push(p), '{"mentions": []}'));
  assert.deepEqual(prompts, []);
  assert.equal(none!.mentions.length, 0);
  assert.equal(none!.candidates, 0);
  const some = await scoreCardMentions('Who was better?', 'Futbolpedia rates his peak at 95 overall, a World-Class Elite tier.', async (p) => (prompts.push(p), JSON.stringify({ mentions: [{ quote: '95 overall', kind: 'rating', version: 'prime', discussed: 'all-time', helped: true, why: 'x' }] })));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Question: Who was better\?/);
  assert.match(prompts[0], /Sentences a scan flagged[\s\S]*95 overall/);
  assert.equal(some!.helped, 1);
  const broken = await scoreCardMentions('q', 'rated 90 overall', async () => 'garbage');
  assert.equal(broken, null, 'an unreadable reply is a failed score, not a clean one');
});

await test('card mentions are scored for every run and counted in the totals', async () => {
  let n = 0;
  const answers = ['He is rated 91 overall, a current-form number in a debate about all-time greats.', 'No card figures in this one, just who starts.'];
  const result = await runRepeats({
    questions: [Q(13)],
    repeat: 2,
    ask: async () => answerRun(answers[n++]),
    gradeRubric: async () => grade(),
    grade: async (prompt) =>
      prompt.startsWith('You are reading')
        ? JSON.stringify({ mentions: [{ quote: '91 overall', kind: 'rating', version: 'current', discussed: 'all-time', helped: false, why: 'decoration' }] })
        : consistencyJson(),
    log: () => {},
  });
  assert.equal(result.runs[0].mentions!.wrongVersion, 1);
  assert.equal(result.runs[1].mentions!.mentions.length, 0);
  const t = totalsOf(result);
  assert.deepEqual([t.cardFigures, t.runsWithCardFigures, t.runsScored, t.decoration, t.helped, t.wrongVersion], [1, 1, 2, 1, 0, 1]);
  assert.equal(t.mentionBehaviourDiffers, 1, 'one run quoted a card and the other didn\'t');
});

// --- Report ------------------------------------------------------------------------------------

await test('the report has a section for each measure, and headings that name things', async () => {
  let n = 0;
  const result = await runRepeats({
    questions: [Q(4), Q(11)],
    repeat: 2,
    ask: async () => {
      n++;
      return answerRun(n % 2 ? 'Valverde starts at right-back. Futbolpedia rates him 84 overall.' : 'Mendy starts at left-back.', {}, n % 2 ? ['get_club_recent_team', 'web_search'] : ['get_player_season']);
    },
    gradeRubric: async () => grade({ decisiveness: n % 2 ? 5 : 3 }),
    grade: async (prompt) =>
      prompt.startsWith('You are reading')
        ? JSON.stringify({ mentions: [{ quote: '84 overall', kind: 'rating', version: 'current', discussed: 'current', helped: false, why: 'ornament' }] })
        : consistencyJson({ agreement: 'different', compared: 2, contradictions: [{ kind: 'verdict', about: 'who starts', claims: [{ run: 1, claim: 'Valverde' }, { run: 2, claim: 'Mendy' }] }], summary: 'Different starters.' }),
    log: () => {},
  });
  const md = repeatReport(result, { today: '2026-11-17', label: 'drift', model: 'fake-model', repeat: 2, path: 'the chat loop', cardMentions: true, sharedCards: true });
  for (const heading of ['## Summary', '## Spread', '## Consistency', '### Contradictions', '## Lookups', '## Card Mentions', '### Figures Quoted', '## Answers']) {
    assert.ok(md.includes(`\n${heading}\n`), `missing ${heading}`);
  }
  assert.match(md, /Same judgments across runs: 0 same, 0 partly, 2 different, of 2 questions compared/);
  assert.match(md, /Different lookup tools between runs: 2 of 2 questions/);
  assert.match(md, /Card figures: 2 in 2 of 4 answers; 0 helped the answer, 2 decorated it, 0 quoted a version other than the one discussed/);
  assert.match(md, /\| 4 \| 2 \| 0 \(0\) \| 0 \(0\) \| 3–5 \(2\) \| 0 \(0\) \|/, 'decisiveness 3 to 5, range 2');
  assert.match(md, /- Q4, verdict, who starts: run 1 said Valverde; run 2 said Mendy/);
  assert.match(md, /with the shared cards read from Supabase/);
  // Headings name the thing: no question mark, no narration.
  for (const line of md.split('\n').filter((l) => /^#{1,4} /.test(l) && !/^#### Run|^### \d+\./.test(l))) assert.doesNotMatch(line, /\?|\b(how|why|what|where|which|does|is|are)\b/i, line);
  const json = JSON.stringify({ ...result, totals: totalsOf(result) });
  assert.ok(JSON.parse(json).totals.contradictions === 2);
  // A report without card scoring leaves that section out.
  assert.doesNotMatch(repeatReport(result, { today: 'd', label: 'l', model: 'm', repeat: 2, path: 'p', cardMentions: false, sharedCards: false }), /## Card Mentions/);
});

// --- Estimate ----------------------------------------------------------------------------------

const sizes = { chatFixedTokens: 12_000 };

await test('the estimate scales with questions and runs, and the ceiling is the budget\'s worst case', () => {
  const one = estimateRun({ questions: [4], repeat: 1, consistency: false, cardMentions: false, sizes });
  const six = estimateRun({ questions: [4, 11, 1], repeat: 2, consistency: true, cardMentions: true, sizes });
  assert.equal(one.turns, 1);
  assert.equal(six.turns, 6);
  const loopOf = (e: typeof one) => e.expected.components.find((c) => c.name.startsWith('Chat turns'))!;
  assert.equal(loopOf(six).inputTokens, loopOf(one).inputTokens * 6, 'chat turns are linear in turns');
  assert.ok(six.ceiling.total.inputTokens > six.expected.total.inputTokens * 3, 'a full budget costs several times an ordinary turn');
  assert.ok(six.ceiling.total.usd > six.expected.total.usd);
  // A turn re-sends the fixed prompt every round, so a longer prompt costs rounds × tokens more.
  const bigger = estimateRun({ questions: [4], repeat: 1, consistency: false, cardMentions: false, sizes: { chatFixedTokens: 22_000 } });
  assert.equal(loopOf(bigger).inputTokens - loopOf(one).inputTokens, 10_000 * (EXPECTED_TURN.rounds + 1));
  assert.ok(CEILING_TURN.rounds > EXPECTED_TURN.rounds);
});

await test('comparisons, card scoring and the rubric are in the estimate only when they run', () => {
  const names = (e: ReturnType<typeof estimateRun>) => e.expected.components.map((c) => c.name.split(',')[0]);
  const full = estimateRun({ questions: [4, 11], repeat: 2, consistency: true, cardMentions: true, sizes });
  assert.deepEqual(names(full), ['Chat turns', 'Rubric grade', 'Consistency comparison', 'Card-mention scoring']);
  const single = estimateRun({ questions: [4, 11], repeat: 1, consistency: true, cardMentions: false, sizes });
  assert.deepEqual(names(single), ['Chat turns', 'Rubric grade'], 'one run has nothing to compare');
  const bare = estimateRun({ questions: [4], repeat: 2, consistency: false, cardMentions: false, rubric: false, sizes });
  assert.deepEqual(names(bare), ['Chat turns']);
  // The comparison reads every run's answer, so it grows with the repeat count.
  const cmp = (repeat: number) => estimateRun({ questions: [4], repeat, consistency: true, cardMentions: false, sizes }).expected.components.find((c) => c.name.startsWith('Consistency'))!.inputTokens;
  assert.ok(cmp(3) > cmp(2));
});

await test('the historical controls take the stage pipeline and are priced as controls, not chat turns', () => {
  const e = estimateRun({ questions: [4, 13, 14], repeat: 2, consistency: false, cardMentions: false, sizes });
  assert.equal(e.controlTurns, 4);
  assert.deepEqual(e.expected.components.map((c) => c.name.split(',')[0]), ['Chat turns', 'Stage-path controls', 'Rubric grade']);
  assert.match(e.expected.components[0].name, /Chat turns, 2/);
});

await test('the dollar figure follows the prices given and counts grounded searches', () => {
  const base = { questions: [4], repeat: 1, consistency: false, cardMentions: false, sizes };
  const a = estimateRun(base);
  const free = estimateRun({ ...base, prices: { inputPerMillion: 0, outputPerMillion: 0, perGroundedSearch: 0 } });
  assert.equal(free.expected.total.usd, 0);
  assert.equal(free.expected.total.inputTokens, a.expected.total.inputTokens, 'tokens do not depend on prices');
  const searchOnly = estimateRun({ ...base, prices: { inputPerMillion: 0, outputPerMillion: 0, perGroundedSearch: 1 } });
  assert.ok(Math.abs(searchOnly.expected.total.usd - a.expected.total.grounded) < 1e-9);
  const t = a.expected.total;
  const expected = (t.inputTokens * ASSUMED_PRICES.inputPerMillion + t.outputTokens * ASSUMED_PRICES.outputPerMillion) / 1e6 + t.grounded * ASSUMED_PRICES.perGroundedSearch;
  assert.ok(Math.abs(t.usd - expected) < 1e-9);
});

await test('the dry run prints calls, tokens and cost, and says the prices are placeholders', () => {
  const e = estimateRun({ questions: [4, 11, 1], repeat: 2, consistency: true, cardMentions: true, sizes });
  const text = formatEstimate(e, { questions: [4, 11, 1], repeat: 2, path: 'the chat loop' });
  assert.match(text, /^Dry run: 3 questions \(4, 11, 1\) × 2 runs = 6 turns through the chat loop\. No call is made\./);
  assert.match(text, /Expected: \d+ calls, [\d.]+M input tokens, [\d.]+M output tokens, \d+ grounded searches, \$[\d.]+/);
  assert.match(text, /Ceiling \(every chat turn spends its whole budget\): /);
  assert.match(text, /placeholders, so confirm them or pass --price-in, --price-out and --price-search/);
});

await test('--dry-run exits before any key check or call, so it runs with no key and no network', () => {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  delete env.API_KEY;
  const out = spawnSync('npx', ['tsx', 'scripts/eval-live-questions.ts', '--repeat', '2', '--only', '4,11', '--max-questions', '1', '--price-in', '1', '--price-out', '4', '--dry-run'], {
    cwd: root,
    env: { ...env, HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Dry run: 1 question \(4\) × 2 runs = 2 turns through the chat loop\. No call is made\./);
  assert.match(out.stdout, /\$1\.000\/M input|\$1\.00\/M input/);
  const refused = spawnSync('npx', ['tsx', 'scripts/eval-live-questions.ts', '--stage', '--dry-run'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--dry-run estimates the live set on the chat loop/);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
