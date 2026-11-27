#!/usr/bin/env npx tsx
/**
 * Offline checks for a card page's starter questions (services/starterQuestions.ts): three
 * distinct questions per edition, none with a number, and only a current card asks about now.
 *
 * Usage:
 *   npx tsx scripts/test-starter-questions.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';
import { positionPlural, shortName, starterQuestions } from '../services/starterQuestions';

let passes = 0;
let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}`);
    console.error(err);
  }
}

const card = (name: string, type: string, position: string, qualifier?: string): PlayerProfile =>
  ({
    basicInfo: { name, position },
    version: { id: 'v', type, label: '', evaluationDate: '2020-06-30', seasonOrEra: '2017-20', ...(qualifier ? { qualifier } : {}) },
  }) as unknown as PlayerProfile;

const cards = [
  card('Bukayo Saka', 'current', 'Right Winger/Right Midfielder'),
  card('Kaká', 'prime', 'Attacking Midfielder/Second Striker'),
  card('Neymar Jr', 'era', 'Left Winger', 'psg'),
  card('Kaká', 'season_snapshot', 'Attacking Midfielder'),
];

test('every edition gets three distinct questions with no numbers', () => {
  for (const c of cards) {
    const qs = starterQuestions(c);
    assert.equal(qs.length, 3);
    assert.equal(new Set(qs).size, 3);
    for (const q of qs) {
      assert.doesNotMatch(q, /\d/, q);
      assert.match(q, /\?$/, q);
    }
  }
});

test('only a current card asks about the present', () => {
  const present = /right now|this season|today's game/;
  assert.ok(starterQuestions(cards[0]).some((q) => /right now|this season/.test(q)));
  for (const c of cards.slice(1)) {
    for (const q of starterQuestions(c)) {
      if (/today's game/.test(q)) continue; // a prime imagined in today's game is about the prime
      assert.doesNotMatch(q, present, q);
    }
  }
});

test('names and positions read naturally', () => {
  assert.equal(shortName('Bukayo Saka'), 'Saka');
  assert.equal(shortName('Kaká'), 'Kaká');
  assert.equal(shortName('Neymar Jr'), 'Neymar');
  assert.equal(shortName('Ángel Di María'), 'Di María');
  assert.equal(shortName('Edwin van der Sar'), 'van der Sar');
  assert.equal(shortName('Kevin De Bruyne'), 'De Bruyne');
  assert.equal(positionPlural('Right Winger/Right Midfielder'), 'right wingers');
  assert.equal(positionPlural('Centre-Back'), 'centre-backs');
  assert.equal(positionPlural('N/A'), 'players in their position');
  assert.match(starterQuestions(cards[2])[0], /at Paris Saint-Germain\?$/);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
