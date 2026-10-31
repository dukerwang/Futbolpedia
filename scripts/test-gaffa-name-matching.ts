#!/usr/bin/env npx tsx
/**
 * Offline checks for how Gaffa bid math and slot inference find players named in a message.
 * No network, Supabase or Gemini access needed.
 *
 * Usage:
 *   npx tsx scripts/test-gaffa-name-matching.ts
 */
import assert from 'node:assert/strict';
import type { GaffaContextBag, GaffaFreeAgent } from '../types';
import { buildGaffaBidValuationBlock, inferInvolvedGaffaSlots } from '../services/gaffaLineupAudit';

let failures = 0;
let passes = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passes++;
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${err instanceof Error ? err.message : err}`);
  }
}

const fa = (name: string, position: string, extra: Partial<GaffaFreeAgent> = {}): GaffaFreeAgent => ({
  player_id: name,
  name,
  position,
  pl_team: 'Test FC',
  market_value_eur_m: 20,
  ...extra,
});

const bag: GaffaContextBag = {
  gaffa_rules_version: 'test',
  connected: true,
  budget_eur_m: 100,
  free_agents: [
    fa('Declan Rice', 'DM'),
    fa('Reece James', 'RB'),
    fa('Daniel James', 'LW'),
    fa('Martin Ødegaard', 'AM'),
    fa('Joe Hall', 'LB', { display_name: 'Hall' }),
  ],
  open_auctions: [],
  open_listings: [],
};

/** Free agents the bid calculator priced for a message. */
const pricedTargets = (message: string): string[] =>
  [...buildGaffaBidValuationBlock(message, bag).matchAll(/FA Target (.+?) \(/g)].map((m) => m[1]);

test('a surname inside another word is not a match', () => {
  assert.deepEqual(pricedTargets("what's the price to sign a winger worth the money?"), []);
  assert.deepEqual(pricedTargets("how much to sign a player with that hallmark finish?"), []);
});

test('full names and standalone surnames still match', () => {
  assert.deepEqual(pricedTargets('how much to bid on Declan Rice?'), ['Declan Rice']);
  assert.deepEqual(pricedTargets('what floor would Rice open at?'), ['Declan Rice']);
});

test('names match across accents', () => {
  assert.deepEqual(pricedTargets('how much to bid on odegaard?'), ['Martin Ødegaard']);
});

test('a full-name hit drops surname-only hits on other players', () => {
  assert.deepEqual(pricedTargets('how much to bid on Reece James?'), ['Reece James']);
  assert.deepEqual(pricedTargets('should I bid on James?').sort(), ['Daniel James', 'Reece James']);
});

test('slot inference uses the same matching', () => {
  assert.deepEqual(inferInvolvedGaffaSlots("what's the price for a winger?", bag).includes('DM'), false);
  assert.deepEqual(inferInvolvedGaffaSlots('trade for odegaard', bag).includes('AM'), true);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
