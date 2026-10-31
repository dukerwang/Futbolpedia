#!/usr/bin/env npx tsx
/**
 * Offline checks that chat replies stay consistent with the stored dossiers: the number gate,
 * dossier stubs resolving to their cards in history, and a replay of a prime Ronaldinho vs
 * prime Salah debate through sendMessageToAI with Gemini faked at the fetch layer.
 *
 * Usage:
 *   npx tsx scripts/test-chat-consistency.ts
 */
import assert from 'node:assert/strict';
import type { Attributes, ChatMessage, PlayerProfile } from '../types';

process.env.API_KEY = 'offline-test-key';

const { reconcileDossierNumbers } = await import('../services/dossierNumberGate');
const { buildHistoryContents, CALIBRATION_EPOCH_MS, getCardKey, mostRecentlyShownCard } =
  await import('../services/dossierStore');

function primeCard(
  name: string,
  club: string,
  position: string,
  season: string,
  date: string,
  attributes: Attributes,
): PlayerProfile {
  return {
    basicInfo: { name, age: 26, nationality: 'N/A', club, position },
    ratings: { overall: 95, potential: 95 },
    attributes,
    strengths: [],
    weaknesses: [],
    playstyleAndRole: { playstyle: { archetype: 'Archetype', description: 'Prose.' }, bestRoles: [] },
    shortBio: 'Bio.',
    latestUpdate: 'Update.',
    evaluationDate: date,
    createdAt: CALIBRATION_EPOCH_MS + 1000,
    version: {
      id: `${name}-prime-${date}`,
      type: 'prime',
      label: `Prime Zenith (${season})`,
      evaluationDate: date,
      seasonOrEra: season,
    },
  };
}

// The stored cards from the conversation that prompted these checks.
const RONALDINHO = primeCard('Ronaldinho', 'FC Barcelona', 'Left Winger/Attacking Midfielder', '2005-06', '2006-05-17', {
  finishing: 91, firstTouch: 97, dribbling: 99, vision: 96, retention: 95, combinationPlay: 94,
  delivery: 93, progressivePassing: 92, footballIQ: 93, offensivePositioning: 92,
  defensivePositioning: 34, tackling: 36, interceptions: 41, pressingIntensity: 42,
  speed: 89, acceleration: 94, agility: 95, strength: 84, aerialProwess: 72, stamina: 83,
  composure: 94, clutch: 95, leadership: 82, consistency: 89, flair: 99,
});
const SALAH = primeCard('Mohamed Salah', 'Liverpool', 'Right Winger/Centre Forward', '2017-18', '2018-05-26', {
  finishing: 96, firstTouch: 91, dribbling: 93, vision: 86, retention: 91, combinationPlay: 88,
  delivery: 84, progressivePassing: 82, footballIQ: 93, offensivePositioning: 98,
  defensivePositioning: 48, tackling: 45, interceptions: 52, pressingIntensity: 85,
  speed: 94, acceleration: 97, agility: 95, strength: 82, aerialProwess: 58, stamina: 92,
  composure: 92, clutch: 94, leadership: 82, consistency: 95, flair: 89,
});

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

// --- Number gate -------------------------------------------------------------------------

await test('a misquoted attribute in a two-player sentence gets the stored value', () => {
  const text =
    "Salah didn't have Ronaldinho's elastico or street improvisation (Flair 99 vs. 88), but Ronaldinho never matched Salah's off-ball menace.";
  const { text: out, corrections } = reconcileDossierNumbers(text, [RONALDINHO, SALAH]);
  assert.match(out, /\(Flair 99 vs\. 89\)/);
  assert.deepEqual(corrections, [{ player: 'Mohamed Salah', key: 'flair', from: 88, to: 89 }]);
});

await test('number-first and label-first mentions are both checked', () => {
  const text = 'Ronaldinho blended a 98 Dribbling and 97 First Touch with real power (Strength 86).';
  const { text: out } = reconcileDossierNumbers(text, [RONALDINHO, SALAH]);
  assert.equal(out, 'Ronaldinho blended a 99 Dribbling and 97 First Touch with real power (Strength 84).');
});

await test('table cells are checked against the player named in their column', () => {
  const text = [
    '| Dimension | Ronaldinho (Prime 2005-06) | Salah (Prime 2017-18) | Separator |',
    '|---|---|---|---|',
    '| Pure Dribbling / 1v1 | 99 | 92 | Ronaldinho. |',
    '| Vision & Disguise | **95** | 86 | Ronaldinho. |',
    '| Pace Profile (Acc / Speed) | 94 / 89 | 97 / 94 | Salah. |',
    '| Off-Ball Movement | 92 | 98 | Salah. |',
  ].join('\n');
  const { text: out, corrections } = reconcileDossierNumbers(text, [RONALDINHO, SALAH]);
  assert.match(out, /\| Pure Dribbling \/ 1v1 \| 99 \| 93 \|/);
  assert.match(out, /\| Vision & Disguise \| \*\*96\*\* \| 86 \|/);
  assert.match(out, /\| Pace Profile \(Acc \/ Speed\) \| 94 \/ 89 \| 97 \/ 94 \|/);
  assert.match(out, /\| Off-Ball Movement \| 92 \| 98 \|/);
  assert.equal(corrections.length, 2);
});

await test('players without a card in play, stats and ratings are left alone', () => {
  const text = [
    'Cruyff had Vision 99 and Henry had Speed 97.',
    'In 2005-06 Ronaldinho delivered 26 goals and 24 assists in 45 appearances.',
    'Salah sits at 95 Overall, and a case exists for 96 OVR.',
  ].join('\n');
  assert.equal(reconcileDossierNumbers(text, [RONALDINHO, SALAH]).text, text);
});

await test('an attribute that could belong to either named player is not guessed', () => {
  const text = 'Ronaldinho and Salah both carried Composure 90 into big matches.';
  assert.equal(reconcileDossierNumbers(text, [RONALDINHO, SALAH]).text, text);
});

// --- Dossier stubs in history ------------------------------------------------------------

const stub = (card: PlayerProfile, withKey: boolean): ChatMessage => ({
  id: `ai-${card.basicInfo.name}`,
  sender: 'ai',
  content: `Dossier generated for **${card.basicInfo.name}**. See the side panel for full analysis.`,
  ...(withKey ? { dossierKey: getCardKey(card) } : {}),
});

await test('a dossier stub is replaced by its card in the model history', () => {
  const history: ChatMessage[] = [
    { id: 'u1', sender: 'user', content: 'rate prime ronaldinho' },
    stub(RONALDINHO, true),
    { id: 'u2', sender: 'user', content: 'rate prime salah' },
    stub(SALAH, false), // a stub saved before stubs carried the card key
  ];
  const contents = buildHistoryContents(history, [RONALDINHO, SALAH]);
  const texts = contents.map((c) => c.parts?.map((p) => p.text).join('') ?? '');
  assert.equal(contents.length, 4, 'cards are not appended a second time');
  assert.match(texts[1], /Name: Ronaldinho[\s\S]*Flair 99/);
  assert.match(texts[3], /Name: Mohamed Salah[\s\S]*Flair 89/);
  assert.doesNotMatch(texts.join('\n'), /See the side panel/);
});

await test('the most recently shown card is found through its stub', () => {
  const history: ChatMessage[] = [stub(SALAH, true), stub(RONALDINHO, true)];
  assert.equal(mostRecentlyShownCard(history, [SALAH, RONALDINHO]), RONALDINHO);
});

// --- End to end: the debate that prompted these checks ----------------------------------

interface GeminiCall {
  prompt: string;
  structured: boolean;
}
let calls: GeminiCall[] = [];
let challengeReply = '';
let proseReply = '';
let route: Record<string, unknown> = {};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!url.includes('generativelanguage.googleapis.com')) {
    if (url.startsWith('/api/')) return new Response('{}', { status: 404 });
    return realFetch(input, init);
  }
  const body = JSON.parse(init?.body ?? '{}');
  const raw = JSON.stringify(body);
  const prompt = JSON.stringify([body.contents ?? '', body.systemInstruction ?? '']);
  const structured = raw.includes('responseSchema') || raw.includes('responseJsonSchema');
  calls.push({ prompt, structured });
  let text = '';
  if (prompt.includes('first-team head coach')) {
    text = 'COACH: UNKNOWN | SINCE: UNKNOWN | PREVIOUS: UNKNOWN | SOURCE_DATE: UNKNOWN';
  } else if (structured && prompt.includes('Classify the user')) {
    text = JSON.stringify(route);
  } else if (structured && prompt.includes('active_dossier')) {
    text = JSON.stringify({ replyProse: challengeReply, revisedDossier: false });
  } else if (structured) {
    text = '{}';
  } else {
    text = proseReply;
  }
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: {},
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
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

const EARLIER_VERDICT =
  'However, in a direct, one-match, neutral-context vacuum: Ronaldinho holds the higher intrinsic footballing ceiling.';
const debateHistory: ChatMessage[] = [
  { id: 'u1', sender: 'user', content: 'rate prime ronaldinho' },
  stub(RONALDINHO, true),
  { id: 'u2', sender: 'user', content: "prime RONALDINHO wasn't better than salah??? you're actually having a laugh" },
  {
    id: 'a2',
    sender: 'ai',
    content: `To look at Ronaldinho and Mohamed Salah sharing a 95 Overall... ${'Long tactical breakdown. '.repeat(150)}${EARLIER_VERDICT}`,
  },
];
const PUSHBACK =
  "no, they're not identical footballers, but it's quite literally near blasphemous to say ronaldinho wasn't better than salah. like that is a laughable take come on...";

await test('a challenge sees every card in the debate and its own earlier verdict', async () => {
  calls = [];
  route = {
    intent: 'challenge_or_revise',
    analyticalMode: 'debate_or_verdict',
    targetPlayers: ['Ronaldinho'],
    targetClubs: [],
    searchQueries: [],
    reasoningComplexity: 'high',
    isHistorical: false,
    wantsRegeneration: false,
    needsSearch: false,
  };
  challengeReply =
    "Salah didn't have Ronaldinho's elastico or street improvisation (Flair 99 vs. 88), but Ronaldinho never matched Salah's off-ball menace.";
  const reply = await quietly(() =>
    sendMessageToAI(PUSHBACK, debateHistory, undefined, [RONALDINHO, SALAH], []),
  );
  const challengePrompt = calls.find((c) => c.structured && c.prompt.includes('active_dossier'))?.prompt ?? '';
  assert.ok(challengePrompt, 'the challenge path ran');
  assert.match(challengePrompt, /locked_dossiers[\s\S]*Name: Mohamed Salah[\s\S]*Flair 89/);
  assert.match(challengePrompt, /Prime Zenith \(2017-18\)/);
  assert.ok(challengePrompt.includes('Ronaldinho holds the higher intrinsic footballing ceiling'));
  assert.equal(typeof reply, 'string');
  assert.match(reply as string, /\(Flair 99 vs\. 89\)/);
});

await test('a debate turn locks both prime cards and corrects misquotes', async () => {
  calls = [];
  route = {
    intent: 'tactical_chat',
    analyticalMode: 'debate_or_verdict',
    targetPlayers: ['Ronaldinho', 'Mohamed Salah'],
    targetClubs: [],
    searchQueries: [],
    reasoningComplexity: 'high',
    isHistorical: false,
    wantsRegeneration: false,
    needsSearch: false,
  };
  proseReply = 'Salah offered Stamina 90 and Pressing Intensity 85 that Ronaldinho never did.';
  const reply = await quietly(() =>
    sendMessageToAI(PUSHBACK, debateHistory, undefined, [RONALDINHO, SALAH], []),
  );
  const prosePrompt = calls.filter((c) => !c.structured).at(-1)?.prompt ?? '';
  assert.match(prosePrompt, /locked_dossiers[\s\S]*Name: Ronaldinho[\s\S]*Name: Mohamed Salah/);
  assert.match(prosePrompt, /Answer the Argument, Not the Person/);
  assert.equal(reply, 'Salah offered Stamina 92 and Pressing Intensity 85 that Ronaldinho never did.');
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
