#!/usr/bin/env npx tsx
/**
 * Offline end-to-end check for a chat question about the past: sendMessageToAI runs for real,
 * with Gemini and the history routes faked at the fetch layer (no network, Supabase or API keys).
 * It checks that a prime-versus-prime debate gets a debate brief whose verdict is held to the
 * stored cards, the career lookup reaches the writer as evidence, an invented figure is cut
 * while a sourced one and a past coach stand, and the same question asked again reuses the
 * settled debate without another brief call.
 *
 * Usage:
 *   npx tsx scripts/test-history-chat-pipeline.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';

process.env.API_KEY = 'offline-test-key';

const { CALIBRATION_EPOCH_MS } = await import('../services/dossierStore');

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

const prime = (name: string, overall: number, season: string): PlayerProfile =>
  ({
    basicInfo: { name, age: 28, nationality: 'N/A', club: 'Club', position: 'Attacking Midfielder' },
    ratings: { overall, potential: overall },
    attributes: {},
    strengths: [],
    weaknesses: [],
    playstyleAndRole: { playstyle: { archetype: 'Archetype', description: 'Prose.' }, bestRoles: [] },
    shortBio: 'Bio.',
    latestUpdate: 'Update.',
    evaluationDate: '2026-10-25',
    createdAt: CALIBRATION_EPOCH_MS + 1000,
    version: { id: `${name}-prime`, type: 'prime', label: `Prime (${season})`, evaluationDate: '2026-10-25', seasonOrEra: season },
  }) as unknown as PlayerProfile;
const ZIDANE = prime('Zinedine Zidane', 96, '1999-02');
const KAKA = prime('Kaká', 95, '2005-07');

const ROUTE = {
  intent: 'compare',
  analyticalMode: 'head_to_head',
  targetPlayers: ['Zinedine Zidane', 'Kaká'],
  targetClubs: [],
  searchQueries: [],
  reasoningComplexity: 'high',
  isHistorical: true,
  wantsRegeneration: false,
  needsSearch: false,
};
const BRIEF = {
  understanding: 'Which prime was better',
  kind: 'head_to_head',
  criterion: 'peak_level',
  criteria: [{ name: 'Control of big matches', why: 'Both were judged on them' }],
  versions: [{ subject: 'Zinedine Zidane', period: '1999-02' }, { subject: 'Kaká', period: '2005-07' }],
  disagreement: 'Peak brilliance against directness',
  counterCase: 'Kaká decided more matches on his own',
  verdict: 'Kaká',
  ranking: [],
  outline: ['Big matches', 'Counter-case'],
  calls: [{ tool: 'player_career', subject: 'Kaká', purpose: 'his numbers in the window' }],
};
const CAREER = `Wikipedia, "Kaká".
Club appearances and goals by season (Wikipedia career statistics):
Club | Season | League Apps | League Goals
Milan | 2006–07 | 31 | 8`;
const WRITER =
  'Under Ancelotti, Kaká scored 8 league goals in 2006-07. He won 5 titles that season. Zidane still controlled the biggest matches better, so he edges it.';

const calls: { prompt: string; structured: boolean }[] = [];
const historyRequests: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith('/api/history/')) {
    historyRequests.push(url);
    return json({ found: true, title: 'Kaká', text: CAREER, sources: ['https://en.wikipedia.org/wiki/Kak%C3%A1'], missing: [] });
  }
  if (url.startsWith('/api/')) return new Response('{}', { status: 404 });
  if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
  const body = JSON.parse(init?.body ?? '{}');
  const raw = JSON.stringify(body);
  const prompt = JSON.stringify([body.contents ?? '', body.systemInstruction ?? '']);
  const structured = raw.includes('responseSchema') || raw.includes('responseJsonSchema');
  calls.push({ prompt, structured });
  let text = '';
  if (structured && prompt.includes('Classify the user')) text = JSON.stringify(ROUTE);
  else if (structured && prompt.includes('question about the past')) text = JSON.stringify(BRIEF);
  else if (structured && prompt.includes('permanent reference note')) {
    text = JSON.stringify({ summary: 'His best years.', setup: 'Runs from deep', people: ['Milan'], record: 'Won the league', figures: [], disputed: [] });
  } else if (structured) text = '{}';
  else if (prompt.includes('<task>')) text = WRITER;
  else text = '[2007-05-23] A digest of contemporary reports.';
  return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

const { sendMessageToAI } = await import('../services/geminiService');
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { log, info, warn } = console;
  console.log = console.info = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, info, warn });
  }
};
const briefCalls = () => calls.filter((c) => c.structured && c.prompt.includes('question about the past')).length;

await test('a debate about two primes is planned, held to the cards, and written from its records', async () => {
  const reply = await quietly(() => sendMessageToAI('Prime Zidane or prime Kaká?', [], undefined, [], [ZIDANE, KAKA]));
  assert.equal(briefCalls(), 1);
  assert.ok(historyRequests.some((u) => u.startsWith('/api/history/player?name=Kak')));
  const writer = calls.filter((c) => !c.structured && c.prompt.includes('<task>')).at(-1)?.prompt ?? '';
  assert.ok(writer.includes('<debate_brief>'));
  assert.ok(writer.includes('The verdict, settled before writing (keep it): Zinedine Zidane'));
  assert.ok(writer.includes('Held to the stored cards'));
  assert.ok(writer.includes('Career record (Wikipedia)'));
  assert.ok(!writer.includes('<research_brief>'));
  // The sourced figure and the past coach stand; the invented tally goes with its sentence.
  assert.equal(reply, 'Under Ancelotti, Kaká scored 8 league goals in 2006-07. Zidane still controlled the biggest matches better, so he edges it.');
});

await test('the same question asked again keeps its settled verdict without a new brief', async () => {
  const before = briefCalls();
  await quietly(() => sendMessageToAI('prime kaka or prime ZIDANE', [], undefined, [], [ZIDANE, KAKA]));
  assert.equal(briefCalls(), before);
  const writer = calls.filter((c) => !c.structured && c.prompt.includes('<task>')).at(-1)?.prompt ?? '';
  assert.ok(writer.includes('The verdict, settled before writing (keep it): Zinedine Zidane'));
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
