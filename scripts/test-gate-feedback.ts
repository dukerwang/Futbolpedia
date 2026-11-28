#!/usr/bin/env npx tsx
/**
 * Offline checks for gates as feedback (`services/gateFeedback.ts`): what each gate returns beside
 * its sanitized text, the one correction round (a flagged figure rewritten and kept, rewritten and
 * still unsupported, dropped without a fragment, every unflagged sentence byte-identical, attribute
 * and coach findings in the prompt and applied, a failed, slow or malformed call leaving the gated
 * reply), the log line's counts, and where the round runs (the chat loop counts it against its call
 * budget; the stage path skips it past its cutoff). The model, the tools and the clock are faked:
 * no network, Supabase or API keys, and no model call is made.
 *
 * Usage:
 *   npx tsx scripts/test-gate-feedback.ts
 */
import assert from 'node:assert/strict';
import type { Attributes, PlayerProfile } from '../types';
import { formatClubReport, type ClubMatch, type LiveClubReport } from '../services/liveFootball';
import type { ResearchToolset, ToolOutcome } from '../services/researchTools';
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

// Nothing here may reach a model: Gemini is refused at fetch, and the tests count the attempts.
const geminiAsked: string[] = [];
globalThis.fetch = (async (input: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.includes('generativelanguage.googleapis.com')) geminiAsked.push(url);
  return new Response(JSON.stringify({ error: { code: 400, message: 'offline test' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const { gateFigureFindings, gateUnsupportedFigures, nearestEvidence } = await import('../services/figureGate');
const { reconcileDossierNumbers } = await import('../services/dossierNumberGate');
const { scrubUnverifiedManagerText, scrubUnverifiedManagerTextDetailed } = await import('../packages/engine/src/gates/managerMentions.ts');
const { sanitizeScoutProse, sanitizeScoutProseDetailed, stripScoutMarkup } = await import('../services/conversationalScout');
const feedback = await import('../services/gateFeedback');
const { correctReply, flaggedSentences, parseReplacements, applyReplacements, buildFeedbackPrompt, stageFeedbackAllowed, GATE_FEEDBACK_CUTOFF_MS, GATE_FEEDBACK_TIMEOUT_MS } = feedback;
const { REFLECT_CUTOFF_MS } = await import('../services/researchAgent');
const { runChatTurn } = await import('../services/chatTurn');
type CorrectionModel = import('../services/gateFeedback').CorrectionModel;
type ChatModel = import('../services/chatTurn').ChatModel;
type ChatRoundReply = import('../services/chatTurn').ChatRoundReply;

/** Console output of `fn`, so the log line can be read and the run stays quiet. */
async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const { log, info, warn } = console;
  console.log = console.info = console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, { log, info, warn });
  }
}

// --- Fixtures ---------------------------------------------------------------------------------

const EVIDENCE = [
  '[E1] Web search: Main Nine goals 2026-27',
  '[2026-10-28] Main Nine has scored 9 league goals for Southside, with 4 assists.',
  '1. Southside 30 pts',
  'Verified coach: Ivan Verity (Southside)',
].join('\n');

const salahAttributes = { flair: 89, finishing: 96 } as unknown as Attributes;
const SALAH: PlayerProfile = {
  basicInfo: { name: 'Mohamed Salah', age: 26, nationality: 'N/A', club: 'Liverpool', position: 'Right Winger' },
  ratings: { overall: 95, potential: 95 },
  attributes: salahAttributes,
  strengths: [],
  weaknesses: [],
  playstyleAndRole: { playstyle: { archetype: 'Archetype', description: 'Prose.' }, bestRoles: [] },
  shortBio: 'Bio.',
  latestUpdate: 'Update.',
} as unknown as PlayerProfile;

const managers = [{ club: 'Southside', coach: 'Ivan Verity', previousCoach: 'Marco Olde' }];

/** The turn's gates over a text, as the app builds them. */
const gates = (cards: PlayerProfile[] = []) => (text: string) =>
  sanitizeScoutProseDetailed(text, { verifiedFacts: [], clubManagers: managers }, cards, { evidence: () => EVIDENCE, grounded: [] });

/** The flagged sentences a prompt lists, as the model would read them. */
const flaggedIn = (prompt: string): string[] => [...prompt.matchAll(/^\d+\. Sentence: (".*?")(?: \(a table cell\))?$/gm)].map((m) => JSON.parse(m[1]) as string);

/** A fake correction model: records each prompt and answers with what `answer` makes of the flagged sentences. */
function fakeCorrection(answer: (flagged: string[], prompt: string) => { original: string; replacement: string }[] | unknown) {
  const prompts: string[] = [];
  const correct: CorrectionModel = async ({ prompt }) => {
    prompts.push(prompt);
    const result = answer(flaggedIn(prompt), prompt);
    return Array.isArray(result) ? { replacements: result } : result;
  };
  return { correct, prompts };
}

const run = (raw: string, correct: CorrectionModel, cards: PlayerProfile[] = [], extra: Partial<Parameters<typeof correctReply>[0]> = {}) =>
  captured(() => correctReply({ raw, sanitize: gates(cards), strip: stripScoutMarkup, correct, ...extra }));

// --- What each gate returns -------------------------------------------------------------------

await test('the figure gate returns each unsupported figure with its sentence, kind and nearest evidence, and the same text as before', () => {
  const reply = 'Main Nine has scored 14 league goals this season. Southside allow a PPDA of 8.4 when they press. Keeper is calm.';
  const plain = gateUnsupportedFigures(reply, EVIDENCE);
  const detailed = gateFigureFindings(reply, EVIDENCE);
  assert.equal(detailed.text, plain.text);
  assert.deepEqual(detailed.removed, plain.removed);
  assert.deepEqual(detailed.trimmed, plain.trimmed);
  assert.deepEqual(Object.keys(plain).sort(), ['removed', 'text', 'trimmed'], 'the plain gate returns the shape it always did');
  assert.equal(detailed.findings.length, 2);
  const [goals, ppda] = detailed.findings;
  assert.equal(goals.sentence, 'Main Nine has scored 14 league goals this season.');
  assert.equal(goals.claim.kind, 'stat');
  assert.equal(reply.slice(goals.at, goals.at + goals.sentence.length), goals.sentence, 'the offset points at the sentence');
  assert.deepEqual(goals.evidence, ['[2026-10-28] Main Nine has scored 9 league goals for Southside, with 4 assists.']);
  assert.equal(ppda.claim.kind, 'decimal');
  assert.deepEqual(ppda.evidence, [], 'no line of the evidence holds a figure of this kind about these words');
});

await test('a table cell with an unsupported figure is a finding for that cell', () => {
  const table = '| Player | Goals |\n| --- | --- |\n| Main Nine | 14 league goals |';
  const { findings, text } = gateFigureFindings(table, EVIDENCE);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sentence, '14 league goals', 'the cell, not the row');
  assert.ok(text.includes('| – |') || text.includes('–'), 'the gate still blanks the cell');
});

await test('nearest evidence is of the same kind about similar words, and a quote has none', () => {
  const claim = gateFigureFindings('Main Nine has scored 14 league goals.', EVIDENCE).findings[0].claim;
  assert.equal(nearestEvidence(claim, 'Main Nine has scored 14 league goals.', EVIDENCE).length, 1);
  assert.deepEqual(nearestEvidence(claim, 'Zzzz qqqq netted lots.', EVIDENCE), [], 'a line that shares no words with the sentence is no help');
  const quote = { kind: 'quote' as const, text: '"x"', value: 'x', near: [] };
  assert.deepEqual(nearestEvidence(quote, 'He said "something long enough to count as a quote here".', EVIDENCE), []);
});

await test('the number gate returns each misquoted attribute with the card, the stated and the stored value', () => {
  const text = "Mohamed Salah's Flair 88 stands out.";
  const out = reconcileDossierNumbers(text, [SALAH]);
  assert.equal(out.text, "Mohamed Salah's Flair 89 stands out.");
  assert.deepEqual(out.corrections, [{ player: 'Mohamed Salah', key: 'flair', from: 88, to: 89 }]);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].player, 'Mohamed Salah');
  assert.equal(out.findings[0].label, 'Flair');
  assert.equal(out.findings[0].from, 88);
  assert.equal(out.findings[0].to, 89);
  assert.equal(out.findings[0].sentence, text);
  assert.equal(text.slice(out.findings[0].at, out.findings[0].at + 2), '88');
});

await test('the manager scrub returns each replaced name and the verified coach, with the same text as before', () => {
  const ctx = { currentHeadCoach: null, verifiedFacts: [], clubManagers: managers };
  const text = 'Southside press high under Marco Olde. Elsewhere sit deep under Mystery Person.';
  const detailed = scrubUnverifiedManagerTextDetailed(text, ctx);
  assert.equal(detailed.text, scrubUnverifiedManagerText(text, ctx));
  assert.deepEqual(detailed.replaced, [
    { name: 'Marco Olde', verifiedCoach: 'Ivan Verity', club: 'Southside', kind: 'former' },
    { name: 'Mystery Person', verifiedCoach: null, kind: 'unverified' },
  ]);
});

await test('sanitizeScoutProseDetailed returns the same text as sanitizeScoutProse and points its findings into the stripped reply', () => {
  const raw = 'Main Nine has scored 14 league goals this season [E1]. Southside press under Marco Olde.';
  const figures = { evidence: () => EVIDENCE, grounded: [] as string[] };
  const ctx = { verifiedFacts: [], clubManagers: managers };
  const detailed = sanitizeScoutProseDetailed(raw, ctx, [], figures);
  assert.equal(detailed.text, sanitizeScoutProse(raw, ctx, [], figures));
  assert.equal(detailed.stripped, stripScoutMarkup(raw));
  assert.ok(!detailed.stripped.includes('[E1]'));
  assert.equal(detailed.findings.figures.length, 1);
  assert.equal(detailed.findings.coaches.length, 1);
  assert.equal(sanitizeScoutProseDetailed('Plain.', ctx, [], figures).findings.figures.length, 0);
});

// --- The correction round ---------------------------------------------------------------------

const FIRST = 'Southside sit top of the table.';
const GOALS = 'Main Nine has scored 14 league goals this season.';
const LAST = 'The press is aggressive.';

await test('a flagged figure rewritten with a supported figure survives, and the prompt carries the sentence, the reason and the evidence', async () => {
  const fake = fakeCorrection(([sentence]) => [{ original: sentence, replacement: 'Main Nine has scored 9 league goals this season.' }]);
  const { result, lines } = await run(`${FIRST} ${GOALS} ${LAST}`, fake.correct);
  assert.equal(result.text, `${FIRST} Main Nine has scored 9 league goals this season. ${LAST}`);
  assert.deepEqual(result.stats && { ...result.stats, ms: 0 }, { flagged: 1, fixed: 1, dropped: 0, removed: 0, left: 0, ms: 0 });
  assert.equal(result.called, true);
  assert.equal(fake.prompts.length, 1);
  const prompt = fake.prompts[0];
  assert.ok(prompt.includes(JSON.stringify(GOALS)), 'the flagged sentence');
  assert.match(prompt, /No source in the evidence for the figure "14 league goals" \(a count\)/);
  assert.ok(prompt.includes('- [2026-10-28] Main Nine has scored 9 league goals for Southside, with 4 assists.'), 'the evidence for it');
  assert.ok(prompt.includes(`${FIRST} ${GOALS} ${LAST}`), 'the whole reply, for context');
  assert.ok(lines.some((l) => /^\[GateFeedback\] flagged 1, fixed 1, dropped 0, removed 0 \(\d+ ms\)$/.test(l)), lines.join('\n'));
});

await test('a rewrite that is still unsupported is removed by the second pass, exactly as today', async () => {
  const fake = fakeCorrection(([sentence]) => [{ original: sentence, replacement: 'Main Nine has scored 12 league goals this season.' }]);
  const { result, lines } = await run(`${FIRST} ${GOALS} ${LAST}`, fake.correct);
  assert.equal(result.text, `${FIRST} ${LAST}`);
  assert.equal(result.text, gates()(`${FIRST} ${GOALS} ${LAST}`).text, 'the same reply the gates alone would have produced');
  assert.deepEqual(result.stats && { flagged: result.stats.flagged, fixed: result.stats.fixed, dropped: result.stats.dropped, removed: result.stats.removed }, { flagged: 1, fixed: 0, dropped: 0, removed: 1 });
  assert.ok(lines.some((l) => /^\[GateFeedback\] flagged 1, fixed 0, dropped 0, removed 1 \(\d+ ms\)$/.test(l)));
});

await test('a flagged sentence the model leaves alone is removed, and counts as removed', async () => {
  const fake = fakeCorrection(() => []);
  const { result } = await run(`${FIRST} ${GOALS} ${LAST}`, fake.correct);
  assert.equal(result.text, `${FIRST} ${LAST}`);
  assert.equal(result.stats?.removed, 1);
});

await test('a dropped sentence leaves no fragment: its label moves to what is left, and an item with nothing left goes', async () => {
  const reply = ['- **Main Nine (£40m, from Elsewhere):** He has scored 14 league goals. He presses well.', '- **Anchor:** Holds the shape.', '- Keeper has made 7 saves a game.', '- Eight One links play.'].join('\n');
  const fake = fakeCorrection((flagged) => flagged.map((original) => ({ original, replacement: '' })));
  const { result } = await run(reply, fake.correct);
  assert.deepEqual(flaggedIn(fake.prompts[0]).length, 2);
  assert.equal(result.text, ['- **Main Nine:** He presses well.', '- **Anchor:** Holds the shape.', '- Eight One links play.'].join('\n'));
  assert.equal(result.stats?.dropped, 2);
  assert.equal(result.stats?.fixed, 0);
  assert.equal(result.stats?.removed, 0);
});

await test('every unflagged sentence stays byte-identical, and a replacement for one that was not flagged is ignored', async () => {
  const reply = `# Southside\n\n  ${FIRST}   Odd  spacing stays,  here.\n\n| Player | Role |\n| --- | --- |\n| Main Nine | Striker |\n\n- ${GOALS}\n- ${LAST}  \n`;
  const fake = fakeCorrection(([sentence]) => [
    { original: sentence, replacement: 'Main Nine has scored 9 league goals this season.' },
    { original: LAST, replacement: 'Replaced without being flagged.' },
    { original: 'A sentence that is not in the reply.', replacement: 'Nope.' },
  ]);
  const { result } = await run(reply, fake.correct);
  const expected = stripScoutMarkup(reply).replace(GOALS, 'Main Nine has scored 9 league goals this season.');
  assert.equal(result.text, expected);
  assert.ok(!result.text.includes('Replaced without being flagged'));
  assert.equal(result.stats?.flagged, 1);
  // The parser alone: only the flagged sentence's entry is kept.
  const flagged = flaggedSentences(stripScoutMarkup(reply), gates()(reply).findings);
  const parsed = parseReplacements({ replacements: [{ original: LAST, replacement: 'x' }, { original: GOALS, replacement: 'Fine.' }] }, flagged);
  assert.deepEqual([...parsed!], [[GOALS, 'Fine.']]);
});

await test('a table cell replacement stays one cell, and a rewrite far longer than its sentence is ignored', async () => {
  const flagged = [{ text: GOALS, cell: false, reasons: [], evidence: [] }, { text: '14 league goals', cell: true, reasons: [], evidence: [] }];
  const parsed = parseReplacements(
    { replacements: [{ original: '14 league goals', replacement: '9 | extra' }, { original: GOALS, replacement: 'x'.repeat(1000) }] },
    flagged,
  );
  assert.equal(parsed!.size, 0);
  assert.equal(parseReplacements({ replacements: 'no' }, flagged), null);
  assert.equal(parseReplacements(null, flagged), null);
  const { text } = applyReplacements(`${FIRST} ${GOALS}`, new Map([[GOALS, 'Short.']]));
  assert.equal(text, `${FIRST} Short.`);
});

await test('attribute and coach findings reach the prompt and are applied', async () => {
  const reply = ["Mohamed Salah's Flair 88 stands out.", 'Southside press high under Marco Olde.', 'Elsewhere sit deep under Mystery Person.', FIRST].join(' ');
  const fake = fakeCorrection((flagged) =>
    flagged.map((original) => ({
      original,
      replacement: original.replace('Flair 88', 'Flair 89').replace('Marco Olde', 'Ivan Verity').replace(' under Mystery Person', ''),
    })),
  );
  const { result } = await run(reply, fake.correct, [SALAH]);
  const prompt = fake.prompts[0];
  assert.match(prompt, /It gives Mohamed Salah's Flair as 88, but his card stores 89\./);
  assert.match(prompt, /Marco Olde is a former coach of Southside, not its current one\./);
  assert.match(prompt, /Verified coach: Ivan Verity\./);
  assert.match(prompt, /Mystery Person is not a coach this turn verified\./);
  assert.match(prompt, /No coach is verified for the club here, so name nobody\./);
  assert.equal(result.text, ["Mohamed Salah's Flair 89 stands out.", 'Southside press high under Ivan Verity.', 'Elsewhere sit deep.', FIRST].join(' '));
  assert.deepEqual(result.stats && { flagged: result.stats.flagged, fixed: result.stats.fixed, dropped: result.stats.dropped, removed: result.stats.removed }, { flagged: 3, fixed: 3, dropped: 0, removed: 0 });
});

await test('a sentence flagged by several checks is sent once with every reason', () => {
  const reply = 'Southside press under Marco Olde, who has 14 league goals to his name.';
  const out = gates()(reply);
  const flagged = flaggedSentences(out.stripped, out.findings);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].reasons.length, 2);
});

await test('a failed, slow or malformed call leaves exactly the gated reply', async () => {
  const reply = `${FIRST} ${GOALS} ${LAST}`;
  const gated = gates()(reply).text;
  assert.equal(gated, `${FIRST} ${LAST}`);
  const cases: [string, CorrectionModel][] = [
    ['throws', async () => { throw new Error('boom'); }],
    ['hangs', () => new Promise(() => {})],
    ['malformed', async () => ({ answer: 'no replacements here' })],
    ['not json', async () => 'Sure, here you go.'],
  ];
  for (const [label, correct] of cases) {
    const { result, lines } = await run(reply, correct, [], { timeoutMs: 20 });
    assert.equal(result.text, gated, label);
    assert.equal(result.stats, null, label);
    assert.equal(result.called, true, `${label}: the model was called`);
    assert.ok(lines.some((l) => l.startsWith('[GateFeedback] failed')), `${label}: logged`);
    assert.ok(!lines.some((l) => /^\[GateFeedback\] flagged \d+, fixed/.test(l)), `${label}: no correction line`);
  }
  assert.equal(GATE_FEEDBACK_TIMEOUT_MS, 8_000);
});

await test('nothing flagged means no model call', async () => {
  const fake = fakeCorrection(() => []);
  const { result } = await run(`${FIRST} ${LAST}`, fake.correct);
  assert.equal(result.text, `${FIRST} ${LAST}`);
  assert.equal(result.called, false);
  assert.equal(result.stats, null);
  assert.equal(fake.prompts.length, 0);
});

await test('the stage label shows while the round runs, and the log line counts each outcome', async () => {
  const reply = ['- **Main Nine:** 14 league goals.', '- **Anchor:** Allows a PPDA of 8.4 when pressing.', '- **Keeper:** Has 7 clean sheets.', '- Eight One links play.'].join('\n');
  const fake = fakeCorrection(([a, b, c]) => [
    { original: a, replacement: '**Main Nine:** 9 league goals.' },
    { original: b, replacement: '' },
    { original: c, replacement: '**Keeper:** Has 11 clean sheets.' },
  ]);
  let shown = 0;
  const { result, lines } = await run(reply, fake.correct, [], { onCorrecting: () => shown++ });
  assert.equal(shown, 1);
  assert.equal(result.text, ['- **Main Nine:** 9 league goals.', '- Eight One links play.'].join('\n'));
  assert.ok(lines.some((l) => /^\[GateFeedback\] flagged 3, fixed 1, dropped 1, removed 1 \(\d+ ms\)$/.test(l)), lines.join('\n'));
});

await test('the prompt is descriptive: it names no player or club', () => {
  const prompt = buildFeedbackPrompt('Reply.', [{ text: 'Sentence.', cell: false, reasons: ['Why.'], evidence: ['Line.'] }]);
  const rules = prompt.slice(prompt.indexOf('How to rewrite:'));
  assert.doesNotMatch(rules, /[A-Z][a-z]+ [A-Z][a-z]+/, 'no proper names in the rules');
});

// --- Where it runs ----------------------------------------------------------------------------

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
const report: LiveClubReport = {
  team: 'Southside',
  league: 'LaLiga',
  lineups: [{ match: match('m1', '2026-10-25'), formation: '4-3-3', starters: [{ name: 'Keeper', role: 'G' }], subsUsed: [] }],
  results: [match('m1', '2026-10-25')],
  fixtures: [],
  fplPlayers: null,
  asOf: '2026-11-01',
};
const tools = (clock: { t: number }, delayMs = 0): ResearchToolset => {
  const run = async (outcome: ToolOutcome): Promise<ToolOutcome> => {
    clock.t += delayMs;
    return outcome;
  };
  return {
    clubRecentTeam: () => run({ status: 'found', result: { kind: 'club_context', label: 'Southside: recent matches', content: formatClubReport(report), stage: 'facts', club: report }, missing: [] }),
    playerSeason: () => run({ status: 'not_covered', result: null, missing: [] }),
    leagueTable: () => run({ status: 'empty', result: null, missing: [] }),
    webSearch: (q) => run({ status: 'found', result: { kind: 'web', label: q, content: '[2026-10-28] Main Nine has scored 9 league goals for Southside.', sources: ['Example (https://example.com)'] }, missing: [] }),
    card: () => run({ status: 'empty', result: null, missing: [] }),
    clubSeason: () => run({ status: 'empty', result: null, missing: [] }),
    playerCareer: () => run({ status: 'empty', result: null, missing: [] }),
  };
};
const script = (...replies: ChatRoundReply[]): ChatModel => {
  let n = 0;
  return { open: () => ({ send: async () => replies[Math.min(n++, replies.length - 1)] }) };
};
const search = (query: string): ChatRoundReply => ({ text: '', calls: [{ name: 'web_search', args: { query } }] });
const written = (text: string): ChatRoundReply => ({ text, calls: [] });
const loopParams = (extra: object = {}) => ({
  message: 'How is Main Nine doing?',
  route: { intent: 'tactical_chat', analyticalMode: 'player_qa', targetPlayers: [], targetClubs: ['Southside'], searchQueries: [], isHistorical: false, wantsRegeneration: false, needsSearch: true } as import('../services/turnRouter').TurnRoute,
  history: [],
  isEAFCRequest: false,
  conversationDossiers: [],
  savedDossiers: [],
  lockedDossiersBlock: '',
  savedDossiersBlock: '',
  composer: new ReplyComposer(),
  conversationId: `gate-feedback-${Math.random()}`,
  ...extra,
});
const LOOP_REPLY = 'Main Nine has scored 14 league goals this season. Southside play a 4-3-3.';
const chatDeps = (extra: object = {}) => ({ snapshots: null, managers: async () => [], tools: tools({ t: 0 }), ...extra });

await test('the chat loop runs the round when the budget allows, counts it as a lookup, and puts the counts in its perf summary', async () => {
  const fake = fakeCorrection(([sentence]) => [{ original: sentence, replacement: 'Main Nine has scored 9 league goals this season.' }]);
  let stats: import('../services/chatTurn').TurnStats | null = null;
  const perf: string[] = [];
  const stages: string[] = [];
  const { result } = await captured(() =>
    runChatTurn(loopParams({ perf: (l: string) => perf.push(l), onStageChange: (s: string) => stages.push(s) }), chatDeps({ model: script(search('Main Nine goals'), written(LOOP_REPLY)), gateFeedback: fake.correct, onStats: (s: import('../services/chatTurn').TurnStats) => (stats = s) })),
  );
  assert.equal(result, 'Main Nine has scored 9 league goals this season. Southside play a 4-3-3.');
  assert.equal(fake.prompts.length, 1);
  assert.equal(stats!.calls, 2, 'the search and the correction');
  assert.equal(stats!.gateFeedback?.fixed, 1);
  assert.ok(stages.includes('Polishing the report...'));
  assert.ok(perf.some((l) => l.startsWith('gate feedback: flagged 1, fixed 1, dropped 0, removed 0')), perf.join('\n'));
  assert.ok(perf.some((l) => l.startsWith('chat turn:') && l.includes('gate feedback flagged 1, fixed 1, dropped 0, removed 0')), perf.join('\n'));
});

await test('the chat loop skips the round when its lookup budget is spent, and the gated reply stands', async () => {
  const fake = fakeCorrection(([sentence]) => [{ original: sentence, replacement: 'Main Nine has scored 9 league goals this season.' }]);
  let stats: import('../services/chatTurn').TurnStats | null = null;
  const { result } = await captured(() =>
    runChatTurn(loopParams(), chatDeps({ model: script(search('Main Nine goals'), written(LOOP_REPLY)), gateFeedback: fake.correct, budget: { calls: 1 }, onStats: (s: import('../services/chatTurn').TurnStats) => (stats = s) })),
  );
  assert.equal(result, 'Southside play a 4-3-3.');
  assert.equal(fake.prompts.length, 0);
  assert.equal(stats!.calls, 1);
  assert.equal(stats!.gateFeedback, null);
});

await test('the chat loop skips the round when its time budget is spent, and when the off switch is set', async () => {
  const clock = { t: 0 };
  const fake = fakeCorrection(() => []);
  const timed = await captured(() => runChatTurn(loopParams(), chatDeps({ model: script(search('Main Nine goals'), written(LOOP_REPLY)), tools: tools(clock, 130_000), now: () => clock.t, gateFeedback: fake.correct })));
  assert.equal(timed.result, 'Southside play a 4-3-3.');
  process.env.GATE_FEEDBACK = 'off';
  try {
    const off = await captured(() => runChatTurn(loopParams(), chatDeps({ model: script(search('Main Nine goals'), written(LOOP_REPLY)), gateFeedback: fake.correct })));
    assert.equal(off.result, 'Southside play a 4-3-3.');
  } finally {
    delete process.env.GATE_FEEDBACK;
  }
  assert.equal(fake.prompts.length, 0);
});

await test('the chat loop makes no call when nothing is flagged, and its stream shows only the gated text', async () => {
  const fake = fakeCorrection(() => []);
  const streamed: string[] = [];
  let stats: import('../services/chatTurn').TurnStats | null = null;
  const reply = `Southside play a 4-3-3 and Keeper is calm in goal, with the back line sitting deep and the shape staying compact through the whole of the second half. ${'The press is aggressive. '.repeat(3)}`.trim();
  const { result } = await captured(() =>
    runChatTurn(loopParams({ onStreamChunk: (t: string) => streamed.push(t) }), chatDeps({ model: script(written(reply)), gateFeedback: fake.correct, onStats: (s: import('../services/chatTurn').TurnStats) => (stats = s) })),
  );
  assert.equal(result, reply);
  assert.equal(fake.prompts.length, 0);
  assert.equal(stats!.calls, 0);
  const flaggedReply = `${LOOP_REPLY} ${'The press is aggressive. '.repeat(8)}`.trim();
  const fake2 = fakeCorrection(([s]) => [{ original: s, replacement: 'Main Nine has scored 9 league goals this season.' }]);
  const streamed2: string[] = [];
  await captured(() => runChatTurn(loopParams({ onStreamChunk: (t: string) => streamed2.push(t) }), chatDeps({ model: script(search('Main Nine goals'), written(flaggedReply)), gateFeedback: fake2.correct })));
  assert.ok(streamed2.length > 0);
  assert.ok(streamed2.every((t) => !t.includes('14 league goals')), 'the stream shows the gated text, never the unsupported figure');
});

await test('the stage path skips the round past its cutoff, on an unresearched turn and without a figure check', () => {
  assert.equal(GATE_FEEDBACK_CUTOFF_MS, REFLECT_CUTOFF_MS);
  assert.equal(stageFeedbackAllowed({ researched: true, figureCheck: true, writerMs: 1_000 }), true);
  assert.equal(stageFeedbackAllowed({ researched: true, figureCheck: true, writerMs: GATE_FEEDBACK_CUTOFF_MS }), true, 'at the mark is still inside it');
  assert.equal(stageFeedbackAllowed({ researched: true, figureCheck: true, writerMs: GATE_FEEDBACK_CUTOFF_MS + 1 }), false);
  assert.equal(stageFeedbackAllowed({ researched: false, figureCheck: true, writerMs: 1_000 }), false);
  assert.equal(stageFeedbackAllowed({ researched: true, figureCheck: false, writerMs: 1_000 }), false);
  process.env.GATE_FEEDBACK = 'off';
  try {
    assert.equal(stageFeedbackAllowed({ researched: true, figureCheck: true, writerMs: 1_000 }), false);
  } finally {
    delete process.env.GATE_FEEDBACK;
  }
});

await test('no test reached a model', () => {
  assert.deepEqual(geminiAsked, []);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
