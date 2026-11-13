#!/usr/bin/env npx tsx
/**
 * Offline checks for model profiles: Hydrogen's thinking levels and sampling, and 3.8 Flash kept
 * available. No network or Gemini access needed.
 *
 * Usage:
 *   npx tsx scripts/test-model-profiles.ts
 */
import assert from 'node:assert/strict';
import {
  AITask,
  GEMINI_3_8_FLASH,
  GEMINI_4_HYDROGEN,
  getModelProfile,
  outputCap,
  resolveTaskModelConfig,
  samplingFor,
} from '../constants/modelProfiles';

let failures = 0;
let passes = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).message}`);
  }
}

const TASKS: AITask[] = ['routing', 'grounding', 'extraction', 'synthesis', 'chat'];

test('Hydrogen resolves to its own profile, not the high-reasoning Argon one', () => {
  assert.equal(getModelProfile(GEMINI_4_HYDROGEN).family, 'gemini-4-hydrogen');
  assert.equal(getModelProfile('gemini-4-hydrogen-001').honorsSampling, false);
});

test('every Hydrogen task names low thinking, since the API default is high', () => {
  for (const task of TASKS) {
    assert.equal(resolveTaskModelConfig(task, { model: GEMINI_4_HYDROGEN }).thinkingLevel, 'low', task);
  }
});

test('Hydrogen requests carry no temperature; 3.8 Flash requests keep theirs', () => {
  assert.deepEqual(samplingFor(GEMINI_4_HYDROGEN, 0.2), {});
  assert.deepEqual(samplingFor(GEMINI_3_8_FLASH, 0.2), { temperature: 0.2 });
  assert.deepEqual(samplingFor(GEMINI_3_8_FLASH, 0), { temperature: 0 });
  assert.deepEqual(samplingFor(GEMINI_3_8_FLASH, undefined), {});
});

test('3.8 Flash keeps its profile and tuning', () => {
  const flash = getModelProfile(GEMINI_3_8_FLASH);
  assert.equal(flash.family, 'gemini-3-flash');
  assert.equal(flash.tuning.synthesis.thinkingLevel, 'low');
  assert.equal(resolveTaskModelConfig('chat', { model: GEMINI_3_8_FLASH }).temperature, 0.55);
});

test('output caps leave Hydrogen room to think and leave 3.8 Flash caps as they were', () => {
  assert.equal(outputCap(GEMINI_3_8_FLASH, 120), 120);
  assert.ok(outputCap(GEMINI_4_HYDROGEN, 120) >= 120 + 1024);
});

test('Hydrogen expects slower searches than 3.8 Flash, so research waits longer for them', () => {
  assert.equal(getModelProfile(GEMINI_3_8_FLASH).searchLatencyMs, 8_000);
  assert.ok(getModelProfile(GEMINI_4_HYDROGEN).searchLatencyMs > getModelProfile(GEMINI_3_8_FLASH).searchLatencyMs);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
