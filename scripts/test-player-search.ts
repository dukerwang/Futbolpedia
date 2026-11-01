#!/usr/bin/env npx tsx
/**
 * Offline checks for the Rate command's suggestions (`searchPlayers`): which players match what
 * was typed, in what order, and which of their cards are offered.
 *
 * Usage:
 *   npx tsx scripts/test-player-search.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';
import { CALIBRATION_EPOCH_MS, cardEdition, formatIsoDate } from '../services/dossierStore';
import { searchPlayers } from '../services/playerSearch';

const now = Date.now();
const today = formatIsoDate(now);

const card = (
  name: string,
  type: string,
  extra: Partial<PlayerProfile> & { seasonOrEra?: string; qualifier?: string; evaluationDate?: string } = {},
): PlayerProfile => {
  const evaluationDate = extra.evaluationDate ?? (type === 'current' ? today : '2005-05-15');
  return {
    basicInfo: { name, club: 'Bayer Leverkusen', position: 'Attacking Midfielder', age: 23, nationality: 'Germany' },
    ratings: { overall: 85, potential: 90 },
    createdAt: now,
    evaluationDate,
    version: {
      id: `${name}-${type}-${evaluationDate}`,
      type,
      label: type,
      evaluationDate,
      seasonOrEra: extra.seasonOrEra ?? (type === 'current' ? undefined : '2003-06'),
      qualifier: extra.qualifier,
    },
    ...extra,
  } as unknown as PlayerProfile;
};

let passes = 0;
let failures = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).stack ?? err}`);
  }
}

const shared = [
  card('Florian Wirtz', 'current'),
  card('Florian Wirtz', 'prime', { seasonOrEra: '2023-26' }),
  card('Kylian Mbappé', 'current'),
  card('Neymar Jr', 'era', { qualifier: 'PSG', seasonOrEra: '2017-20' }),
  card('Neymar Jr', 'prime', { seasonOrEra: '2014-17' }),
  card('Neymar Jr', 'season_snapshot', { seasonOrEra: '2014-15' }),
  card('Florentino Luís', 'current'),
];
const names = (query: string, local: PlayerProfile[] = []) => searchPlayers(query, local, shared).map((m) => m.name);

test('a surname finds the player', () => {
  assert.deepEqual(names('wirtz'), ['Florian Wirtz']);
});

test('accents and case are ignored', () => {
  assert.deepEqual(names('MBAPPE'), ['Kylian Mbappé']);
  assert.deepEqual(names('mbappé'), ['Kylian Mbappé']);
});

test('names starting with what was typed come first, then a later word of the name', () => {
  assert.deepEqual(names('flor'), ['Florentino Luís', 'Florian Wirtz']);
  assert.deepEqual(names('lu'), ['Florentino Luís']);
  assert.deepEqual(names('jr'), ['Neymar Jr']);
});

test('every typed word has to start a word of his name', () => {
  assert.deepEqual(names('wirtz flo'), ['Florian Wirtz']);
  assert.deepEqual(names('wirtz neymar'), []);
});

test('one letter suggests nothing', () => {
  assert.deepEqual(names('f'), []);
});

test("a player's cards come in version order: current, prime, eras, seasons", () => {
  const [neymar] = searchPlayers('neymar', [], shared);
  assert.deepEqual(neymar.cards.map(cardEdition), ['prime', 'era', 'season_snapshot']);
});

test('your own dossiers win ties and are not listed twice', () => {
  const [first] = searchPlayers('flor', [card('Florian Wirtz', 'current')], shared);
  assert.equal(first.name, 'Florian Wirtz');
  assert.equal(first.cards.filter((c) => cardEdition(c) === 'current').length, 1);
});

test('cards a request would not be served are left out', () => {
  const stale = card('Jamal Musiala', 'current', { evaluationDate: '2026-01-01' });
  const oldScale = card('Pedri', 'current', { createdAt: CALIBRATION_EPOCH_MS - 1 });
  const revision = { ...card('Cole Palmer', 'current'), revision: { basedOn: 'x' } } as unknown as PlayerProfile;
  assert.deepEqual(searchPlayers('musiala', [stale], []), []);
  assert.deepEqual(searchPlayers('pedri', [oldScale], []), []);
  assert.deepEqual(searchPlayers('palmer', [revision], []), []);
});

test('a legacy "Prime" name is shown without the marker', () => {
  const [kaka] = searchPlayers('kaka', [], [{ ...card('Prime Kaká', 'prime'), version: undefined } as PlayerProfile]);
  assert.equal(kaka.name, 'Kaká');
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
