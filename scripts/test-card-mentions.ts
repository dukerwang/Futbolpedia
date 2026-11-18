#!/usr/bin/env npx tsx
/**
 * Offline checks that Futbolpedia's cards stay in the background of chat prose. The shared mandate
 * carries one rule (a card, rating, tier or attribute comes up only when the user asked about
 * ratings), and no mode's guidance, tool description or locked-cards block tells the writer to
 * cite them unprompted. The prompts are read as text; no model, network or keys.
 *
 * Usage:
 *   npx tsx scripts/test-card-mentions.ts
 */
import assert from 'node:assert/strict';

process.env.API_KEY = 'offline-test-key';

const { CONVERSATIONAL_SCOUT_MANDATE } = await import('../prompts/chatPrompt');
const { proseModeGuidance } = await import('../services/conversationalScout');
const { readFileSync } = await import('node:fs');
const { formatDebateBriefForWriter } = await import('../services/debateBrief');

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).message}`);
  }
}

const MODES = ['head_to_head', 'player_qa', 'ranking_or_tierlist', 'debate_or_verdict', 'tactical_or_system', 'squad_or_recruitment', 'other'];
const route = (intent: string) => ({ intent, targetPlayers: [], targetClubs: [], searchQueries: [] }) as any;

// Wordings that told the writer to bring cards into an answer whether or not the user asked.
const PUSHY = [/explicitly cite/i, /ground every follow-up/i, /cite their approximate overall/i, /answer from the card.s numbers/i, /stay 100%/i, /through the evidence and the 25-attribute framework(?! put in football terms)/i];

await test('the mandate carries one shared rule: use cards fully, quote them with judgment, for the right version', () => {
  assert.ok(CONVERSATIONAL_SCOUT_MANDATE.includes('Used With Judgment'));
  assert.ok(/Always reason from everything on them/.test(CONVERSATIONAL_SCOUT_MANDATE));
  assert.ok(/Whether to quote a rating, tier or score is your call/.test(CONVERSATIONAL_SCOUT_MANDATE));
  assert.ok(/Quote only the version the discussion is about/.test(CONVERSATIONAL_SCOUT_MANDATE));
  assert.ok(/current-form numbers are about now/.test(CONVERSATIONAL_SCOUT_MANDATE));
});

await test('no mode forbids quoting a rating outright: the choice is left to the model', () => {
  for (const mode of MODES) {
    const text = proseModeGuidance(route(mode === 'head_to_head' ? 'compare' : 'chat'), mode, '2026-27');
    assert.ok(!/only where the user asked|unless the user asked about ratings|unless the question is about one|only if the user asked/.test(text), mode);
  }
});

await test('the rules that need a card named (a challenge, a contradicted earlier verdict) are untouched', () => {
  assert.ok(CONVERSATIONAL_SCOUT_MANDATE.includes('Questions, Pushback & Rating Challenges'));
  assert.ok(CONVERSATIONAL_SCOUT_MANDATE.includes('Own Your Earlier Verdicts'));
  assert.ok(CONVERSATIONAL_SCOUT_MANDATE.includes('Ratings Follow the Verdict'));
});

await test('no part of the mandate tells the writer to cite cards unprompted', () => {
  for (const re of PUSHY) assert.ok(!re.test(CONVERSATIONAL_SCOUT_MANDATE), String(re));
});

await test('no mode guidance tells the writer to cite cards unprompted', () => {
  for (const mode of MODES) {
    const text = proseModeGuidance(route(mode === 'head_to_head' ? 'compare' : 'chat'), mode, '2026-27');
    for (const re of PUSHY) assert.ok(!re.test(text), `${mode}: ${re}`);
  }
});

await test('the locked cards block keeps the numbers exact but leaves quoting to the model', () => {
  const source = readFileSync(new URL('../services/dossierContext.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('quote their numbers only where they help the reader, for the version under discussion'));
  assert.ok(!source.includes('are LAW'));
});

await test("the writer always sees the cards' order, whatever the question turns on", () => {
  const brief = { understanding: 'u', kind: 'head_to_head', criterion: 'influence', criteria: [], versions: [], disagreement: '', counterCase: '', verdict: 'A', ranking: [], calls: [], outline: [], cardNotes: [] } as any;
  const card = { name: 'A', slug: 'a', overall: 90, edition: 'prime', period: null, placement: null } as any;
  for (const criterion of ['influence', 'output', 'mixed'] as const) {
    assert.ok(formatDebateBriefForWriter({ ...brief, criterion }, [card]).includes("The stored cards' order:"), criterion);
  }
});

console.log(`${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
