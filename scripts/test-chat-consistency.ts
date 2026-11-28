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
  /** The request body as sent, for checks on its schema. */
  raw: string;
}
let calls: GeminiCall[] = [];
let challengeReply = '';
let challengePatch: Record<string, unknown> | null = null;
// What the head-to-head comparison answers (by peer label); unset, it fails.
let comparisonReply: Array<{ peer: string; judgment: string; reason: string }> | null = null;
// What a second round (a prompt carrying <peer_comparisons>) answers; the first answer when unset.
let retryReply = '';
let retryPatch: Record<string, unknown> | null = null;
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
  calls.push({ prompt, structured, raw });
  let text = '';
  if (prompt.includes('first-team head coach')) {
    text = 'COACH: UNKNOWN | SINCE: UNKNOWN | PREVIOUS: UNKNOWN | SOURCE_DATE: UNKNOWN';
  } else if (structured && prompt.includes('Classify the user')) {
    text = JSON.stringify(route);
  } else if (structured && prompt.includes('<peers>') && prompt.includes('which was the better footballer')) {
    if (!comparisonReply) return new Response('{"error":{"message":"boom"}}', { status: 500 });
    text = JSON.stringify({ comparisons: comparisonReply });
  } else if (structured && prompt.includes('active_dossier') && prompt.includes('<peer_comparisons>') && retryPatch) {
    text = JSON.stringify({ replyProse: retryReply, revisedDossier: true, dossierPatch: retryPatch });
  } else if (structured && prompt.includes('active_dossier')) {
    text = JSON.stringify(
      challengePatch
        ? { replyProse: challengeReply, revisedDossier: true, dossierPatch: challengePatch }
        : { replyProse: challengeReply, revisedDossier: false },
    );
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

await test('a challenge the user started sees every card in the debate and its own earlier verdict', async () => {
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
    sendMessageToAI(PUSHBACK, debateHistory, undefined, [RONALDINHO, SALAH], [], { challengeCardKey: getCardKey(RONALDINHO) }),
  );
  const challengePrompt = calls.find((c) => c.structured && c.prompt.includes('active_dossier'))?.prompt ?? '';
  assert.ok(challengePrompt, 'the challenge path ran');
  assert.match(challengePrompt, /locked_dossiers[\s\S]*Name: Mohamed Salah[\s\S]*Flair 89/);
  assert.match(challengePrompt, /Prime Zenith \(2017-18\)/);
  assert.ok(challengePrompt.includes('Ronaldinho holds the higher intrinsic footballing ceiling'));
  assert.equal(typeof reply, 'string');
  assert.match(reply as string, /\(Flair 99 vs\. 89\)/);
});

await test('pushback without a challenge is answered as a question and never revises the card', async () => {
  calls = [];
  proseReply = 'Fair point: the cards have them level, and here is why.';
  const reply = await quietly(() =>
    sendMessageToAI(PUSHBACK, debateHistory, undefined, [RONALDINHO, SALAH], []),
  );
  assert.ok(!calls.some((c) => c.structured && c.prompt.includes('active_dossier')), 'no challenge ran');
  assert.equal(reply, proseReply);
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

// --- A challenge that moves the Overall is placed against the peers ------------------------

const LEVEL_RONALDINHO: PlayerProfile = {
  ...RONALDINHO,
  peerPlacement: { betterThan: [], levelWith: ['Mohamed Salah (2017-18)'], notAsGoodAs: [] },
  peerComparisons: [{ peer: 'Mohamed Salah (2017-18)', judgment: 'level', reason: 'Neither decided big matches more often from the right side.' }],
};
const challengeRoute = {
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
const runChallenge = async (
  patch: Record<string, unknown>,
  reply = 'Fair point: I am revising his card.',
): Promise<{ reply: string; updated?: PlayerProfile }> => {
  calls = [];
  route = challengeRoute;
  challengeReply = reply;
  challengePatch = patch;
  let updated: PlayerProfile | undefined;
  try {
    const answer = await quietly(() =>
      sendMessageToAI(PUSHBACK, debateHistory, undefined, [LEVEL_RONALDINHO, SALAH], [], {
        challengeCardKey: getCardKey(LEVEL_RONALDINHO),
        onDossierUpdated: (p: PlayerProfile) => {
          updated = p;
        },
      }),
    );
    return { reply: answer as string, updated };
  } finally {
    challengePatch = null;
    retryPatch = null;
    retryReply = '';
    comparisonReply = null;
  }
};
const challengeCalls = () => calls.filter((c) => c.structured && c.prompt.includes('active_dossier'));
const comparisonCalls = () => calls.filter((c) => c.structured && c.prompt.includes('<peers>') && c.prompt.includes('which was the better footballer'));
const NO_PLACEMENT = { betterThan: [], levelWith: [], notAsGoodAs: [] };

await test('a challenge prompt says the Overall is a judgment placed against peers, not a sum of attributes', async () => {
  await runChallenge({ targetPlayerName: 'Ronaldinho', attributes: { consistency: 92 }, peerPlacement: NO_PLACEMENT });
  const challengePrompt = challengeCalls()[0]?.prompt ?? '';
  assert.match(challengePrompt, /never a sum of attributes/);
  assert.match(challengePrompt, /peerPlacement.{0,4} is always filled/);
  assert.match(challengePrompt, /Availability is never footballing quality/);
  assert.match(challengePrompt, /Availability and Team Success/);
  // The card's earlier comparisons are in view, with their reasons.
  assert.match(challengePrompt, /Head to head, before any rating was set: level with Mohamed Salah \(2017-18\): Neither decided big matches/);
});

await test("the challenge schema requires the patch's placement, with empty arrays allowed", async () => {
  await runChallenge({ targetPlayerName: 'Ronaldinho', attributes: { consistency: 92 }, peerPlacement: NO_PLACEMENT });
  const raw = challengeCalls()[0]?.raw ?? '';
  assert.match(raw, /"required":\["targetPlayerName","peerPlacement"\]/);
  assert.match(raw, /"required":\["betterThan","levelWith","notAsGoodAs"\]/);
});

await test('an attribute fix leaves the Overall where it was, with no comparison', async () => {
  const { updated, reply } = await runChallenge({ targetPlayerName: 'Ronaldinho', attributes: { consistency: 92 }, peerPlacement: NO_PLACEMENT });
  assert.equal(updated?.attributes.consistency, 92);
  assert.equal(updated?.ratings.overall, 95);
  assert.equal(comparisonCalls().length, 0);
  assert.equal(challengeCalls().length, 1);
  assert.doesNotMatch(reply, /holds this version at/);
});

await test('a raised Overall the comparisons allow is kept, with the comparisons as its placement', async () => {
  comparisonReply = [{ peer: 'P1', judgment: 'better', reason: 'His dribbling took two men out of every attack the peer only finished.' }];
  const { updated, reply } = await runChallenge(
    { targetPlayerName: 'Ronaldinho', overall: 96, potential: 96, peerPlacement: { betterThan: ['Mohamed Salah'], levelWith: [], notAsGoodAs: [] } },
    'Fair point: he was the better footballer, so the card moves to **96**.',
  );
  // One comparison, with the user's argument and the earlier comparisons in view and no number.
  assert.equal(comparisonCalls().length, 1);
  const compare = comparisonCalls()[0].prompt;
  assert.match(compare, /\[P1\] Mohamed Salah \| Prime Zenith \(2017-18\)/);
  assert.match(compare, /near blasphemous/);
  assert.match(compare, /earlier comparisons:\\n- level with Mohamed Salah \(2017-18\): Neither decided/);
  assert.doesNotMatch(compare, /\b9[56]\b|Flair \d|OVR|Overall:/);
  assert.equal(challengeCalls().length, 1, 'agreed the first time: no second round');
  assert.equal(updated?.ratings.overall, 96);
  assert.equal(updated?.ratings.potential, 96);
  assert.deepEqual(updated?.peerPlacement, { betterThan: ['Mohamed Salah (2017-18)'], levelWith: [], notAsGoodAs: [] });
  assert.deepEqual(updated?.peerComparisons?.map((c) => [c.peer, c.judgment]), [['Mohamed Salah (2017-18)', 'better']]);
  assert.match(reply, /moves to \*\*96\*\*/);
});

await test("a raised Overall the comparisons don't allow takes the range's value, and the reply is written for it", async () => {
  comparisonReply = [{ peer: 'P1', judgment: 'level', reason: 'Neither decided big matches more often.' }];
  retryReply = 'Having weighed him against Salah again, they were level, so the card stays at **95**.';
  retryPatch = { targetPlayerName: 'Ronaldinho', overall: 95, potential: 95, attributes: { consistency: 92 }, peerPlacement: { betterThan: [], levelWith: ['Mohamed Salah'], notAsGoodAs: [] } };
  const { updated, reply } = await runChallenge(
    { targetPlayerName: 'Ronaldinho', overall: 96, potential: 96, peerPlacement: NO_PLACEMENT },
    'He was clearly better, so the card moves to **96**.',
  );
  assert.equal(challengeCalls().length, 2);
  const second = challengeCalls()[1].prompt;
  assert.match(second, /<peer_comparisons>/);
  assert.match(second, /- level with Mohamed Salah \(2017-18\): Neither decided big matches more often\. \(95 Overall\)/);
  assert.match(second, /allow an Overall from 95 to 95/);
  assert.match(second, /Your dossierPatch set 96; the card will show 95/);
  assert.equal(updated?.ratings.overall, 95);
  assert.equal(updated?.attributes.consistency, 92);
  assert.deepEqual(updated?.peerPlacement?.levelWith, ['Mohamed Salah (2017-18)']);
  assert.match(reply, /card stays at \*\*95\*\*/);
  assert.doesNotMatch(reply, /96|holds this version at/);
});

await test('a second round that still states another Overall has the number put right in place', async () => {
  comparisonReply = [{ peer: 'P1', judgment: 'level', reason: 'Neither decided big matches more often.' }];
  retryReply = 'Revised: the card now reads **96**, and his 96 Overall reflects it.';
  retryPatch = { targetPlayerName: 'Ronaldinho', overall: 96, potential: 96, peerPlacement: NO_PLACEMENT };
  const { updated, reply } = await runChallenge({ targetPlayerName: 'Ronaldinho', overall: 96, potential: 96, peerPlacement: NO_PLACEMENT });
  assert.equal(updated?.ratings.overall, 95);
  assert.equal(reply, 'Revised: the card now reads **95**, and his 95 Overall reflects it.');
});

await test('with no comparison to go on, the placement the challenge gave places the Overall, and the reply matches the card', async () => {
  const kept = await runChallenge(
    { targetPlayerName: 'Ronaldinho', overall: 96, potential: 96, peerPlacement: { betterThan: ['Mohamed Salah'], levelWith: [], notAsGoodAs: [] } },
    'The card moves to **96**.',
  );
  assert.equal(kept.updated?.ratings.overall, 96);
  assert.deepEqual(kept.updated?.peerPlacement?.betterThan, ['Mohamed Salah (2017-18)']);
  assert.match(kept.reply, /moves to \*\*96\*\*/);

  // No placement given: the card's own (level with Salah) holds 95, and the reply says 95, with no sentence added.
  const held = await runChallenge({ targetPlayerName: 'Ronaldinho', overall: 96, potential: 96, peerPlacement: NO_PLACEMENT }, 'The card moves to **96**.');
  assert.equal(held.updated?.ratings.overall, 95);
  assert.equal(held.reply, 'The card moves to **95**.');
  assert.doesNotMatch(held.reply, /holds this version at/);
});

await test('card trait rules say an injury record is not a weakness', async () => {
  const { CARD_TRAIT_RULES } = await import('../prompts/dossierPrompt');
  assert.match(CARD_TRAIT_RULES, /injury record, missed matches or a lack of durability is not a weakness/);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
