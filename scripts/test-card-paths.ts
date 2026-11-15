#!/usr/bin/env npx tsx
/**
 * Offline checks for shareable addresses (services/cardPaths.ts): every address form, old hash
 * links, a card's own address and the rule that picks a player's default card.
 *
 * Usage:
 *   npx tsx scripts/test-card-paths.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';
import {
  addressPath,
  cardPath,
  datedCardPath,
  legacyHashToPath,
  parsePath,
  pickDefaultCard,
} from '../services/cardPaths';

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

const NOW = Date.parse('2026-11-14T12:00:00Z');

const card = (
  name: string,
  type: 'current' | 'prime' | 'era' | 'season_snapshot',
  evaluationDate: string,
  seasonOrEra = '2026-27',
): PlayerProfile =>
  ({
    basicInfo: { name },
    version: { id: 'v', type, label: '', evaluationDate, seasonOrEra },
  }) as unknown as PlayerProfile;

test('every address form round-trips', () => {
  for (const path of [
    '/p/bukayo-saka',
    '/p/bukayo-saka/prime',
    '/p/neymar-jr/era/2017-20',
    '/p/kaka/season/2006-07',
    '/p/bukayo-saka/2026-10-04',
  ]) {
    const parsed = parsePath(path);
    assert.ok(parsed && parsed.kind === 'card', path);
    assert.equal(parsed.canonical, true, path);
    assert.equal(addressPath(parsed.address), path);
  }
  const chat = parsePath('/c/AB12CD');
  assert.deepEqual(chat, { kind: 'chat', code: 'AB12CD', canonical: true });
});

test('case and trailing slashes parse but are not canonical', () => {
  const p = parsePath('/p/Bukayo-Saka/Prime/');
  assert.ok(p && p.kind === 'card');
  assert.equal(p.canonical, false);
  assert.equal(addressPath(p.address), '/p/bukayo-saka/prime');
  const c = parsePath('/c/ab12cd');
  assert.ok(c && c.kind === 'chat');
  assert.equal(c.code, 'AB12CD');
  assert.equal(c.canonical, false);
});

test('malformed addresses are not addresses', () => {
  for (const path of [
    '/',
    '/p',
    '/p/',
    '/p/saka/2026-13-40',
    '/p/saka/era',
    '/p/saka/era/2017',
    '/p/saka/current',
    '/p/sa_ka',
    '/p/saka/prime/extra',
    '/c/x',
    '/x/saka',
    '/p/%E0%A4%A',
  ]) {
    assert.equal(parsePath(path), null, path);
  }
});

test('old hash links map to the new addresses', () => {
  assert.equal(legacyHashToPath('#/p/bukayo-saka--current--2026-11-04'), '/p/bukayo-saka');
  assert.equal(legacyHashToPath('#/p/kaka--prime--2007-06-30'), '/p/kaka/prime');
  assert.equal(legacyHashToPath('#/p/neymar-jr--era--2017-20'), '/p/neymar-jr/era/2017-20');
  assert.equal(legacyHashToPath('#/p/kaka--season_snapshot--2007-05-30'), '/p/kaka/2007-05-30');
  assert.equal(legacyHashToPath('#/p/bukayo-saka'), '/p/bukayo-saka');
  assert.equal(legacyHashToPath('#/p/prime-zinedine-zidane'), '/p/zinedine-zidane/prime');
  assert.equal(legacyHashToPath('#/c/ab12cd'), '/c/AB12CD');
  assert.equal(legacyHashToPath('#/scout?name=Saka'), null);
  assert.equal(legacyHashToPath('#/p/'), null);
});

test("a card's own address follows its edition and age", () => {
  const fresh = card('Bukayo Saka', 'current', '2026-11-04');
  assert.equal(cardPath(fresh, { nowMs: NOW }), '/p/bukayo-saka');
  const stale = card('Bukayo Saka', 'current', '2026-05-01');
  assert.equal(cardPath(stale, { nowMs: NOW }), '/p/bukayo-saka/2026-05-01');
  const prime = card('Kaká', 'prime', '2007-06-30', '2005-08');
  assert.equal(cardPath(prime, { nowMs: NOW }), '/p/kaka/prime');
  assert.equal(cardPath(prime, { nowMs: NOW, superseded: true }), '/p/kaka/2007-06-30');
  const era = card('Neymar Jr', 'era', '2020-06-30', '2017-2020');
  assert.equal(cardPath(era), '/p/neymar-jr/era/2017-20');
  const season = card('Kaká', 'season_snapshot', '2007-05-30', '2006-07');
  assert.equal(cardPath(season), '/p/kaka/season/2006-07');
  assert.equal(datedCardPath(fresh), '/p/bukayo-saka/2026-11-04');
});

test('the default card: a fresh current card, else the prime, else any current card', () => {
  const fresh = card('A', 'current', '2026-10-01');
  const stale = card('A', 'current', '2026-07-01');
  const prime = card('A', 'prime', '2015-06-30', '2012-15');
  assert.equal(pickDefaultCard({ current: fresh, prime }, NOW), fresh);
  assert.equal(pickDefaultCard({ current: stale, prime }, NOW), prime);
  assert.equal(pickDefaultCard({ current: stale }, NOW), stale);
  assert.equal(pickDefaultCard({ prime }, NOW), prime);
  assert.equal(pickDefaultCard({}, NOW), null);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
