#!/usr/bin/env npx tsx
/**
 * Offline checks for club grounding: API-Football lineups and injury lists parse into the club's
 * recent XIs and absences, and the grounding block lists who started, how often, and who is out
 * (without claiming nobody is injured when the injury list couldn't be read).
 *
 * Usage:
 *   npx tsx scripts/test-team-lineups.ts
 */
import assert from 'node:assert/strict';
import {
  formatRecentTeamBlock,
  formatStartingXI,
  mergeAbsences,
  parseAbsences,
  parseTeamLineup,
} from '../services/teamLineups';
import { formatApiFootballTeamContextBlock } from '../services/groundingService';

const TEAM = 42;
const OTHER = 7;

const xi = (names: string[]) => {
  // 4-3-3: keeper on row 1, then four, three and three across.
  const shape = [1, 4, 3, 3];
  let i = 0;
  return shape.flatMap((count, row) =>
    Array.from({ length: count }, (_, col) => ({
      player: { name: names[i++], pos: ['G', 'D', 'M', 'F'][row], grid: `${row + 1}:${col + 1}` },
    })),
  );
};

const players = (prefix: string) => Array.from({ length: 11 }, (_, i) => `${prefix}${i + 1}`);

const lineupsResponse = (names: string[]) => [
  { team: { id: OTHER }, formation: '4-4-2', startXI: xi(players('Opp')) },
  { team: { id: TEAM }, formation: '4-3-3', startXI: xi(names) },
];

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

const match = { date: '2026-10-25', competition: 'Premier League', opponent: 'Rivals FC' };

test("a lineup response gives the club's own XI, not the opponent's", () => {
  const lineup = parseTeamLineup(lineupsResponse(players('P')), TEAM, match);
  assert.ok(lineup);
  assert.equal(lineup.formation, '4-3-3');
  assert.equal(lineup.starters.length, 11);
  assert.equal(lineup.starters[0].name, 'P1');
  assert.equal(parseTeamLineup([], TEAM, match), null);
  assert.equal(parseTeamLineup(null, TEAM, match), null);
});

test('an XI prints line by line from the goalkeeper forward', () => {
  const lineup = parseTeamLineup(lineupsResponse(players('P')), TEAM, match)!;
  assert.equal(
    formatStartingXI(lineup),
    'GK P1 | DEF P2, P3, P4, P5 | MID P6, P7, P8 | FWD P9, P10, P11',
  );
});

test("injury lists keep only the club's players, once each", () => {
  const next = parseAbsences(
    [
      { team: { id: TEAM }, player: { name: 'P4', type: 'Missing Fixture', reason: 'Back Injury' } },
      { team: { id: OTHER }, player: { name: 'Opp2', type: 'Missing Fixture', reason: 'Suspended' } },
    ],
    TEAM,
  );
  const last = parseAbsences(
    [
      { team: { id: TEAM }, player: { name: 'P4', type: 'Missing Fixture', reason: 'Injury' } },
      { team: { id: TEAM }, player: { name: 'P8', type: 'Questionable', reason: 'Knock' } },
    ],
    TEAM,
  );
  const merged = mergeAbsences(next, last);
  assert.deepEqual(merged.map((a) => a.name), ['P4', 'P8']);
  // The next fixture's entry wins.
  assert.equal(merged[0].reason, 'Back Injury');
});

test('the grounding block names starters, their starts and who is out', () => {
  const recent = parseTeamLineup(lineupsResponse(players('P')), TEAM, match)!;
  const earlier = parseTeamLineup(
    lineupsResponse(['P1', 'P2', 'P3', 'New4', 'P5', 'P6', 'P7', 'New8', 'P9', 'P10', 'P11']),
    TEAM,
    { ...match, date: '2026-10-18' },
  )!;
  const block = formatRecentTeamBlock('Club', [recent, earlier], [
    { name: 'P4', status: 'Missing Fixture', reason: 'Back Injury' },
    { name: 'P8', status: 'Questionable', reason: 'Knock' },
  ]);
  assert.match(block, /2026-10-25, Premier League, vs Rivals FC, 4-3-3: GK P1/);
  assert.match(block, /P1 2\/2/);
  assert.match(block, /New4 1\/2/);
  assert.match(block, /P4 \(Back Injury\)/);
  assert.match(block, /P8 \(Knock, doubtful\)/);
});

test("an unread injury list is never reported as 'none'", () => {
  const recent = parseTeamLineup(lineupsResponse(players('P')), TEAM, match)!;
  assert.doesNotMatch(formatRecentTeamBlock('Club', [recent], null), /injury list/);
  assert.match(formatRecentTeamBlock('Club', [recent], []), /none reported/);
  assert.equal(formatRecentTeamBlock('Club', [], null), '');
});

test('club grounding puts the recent team ahead of the registered squad', () => {
  const recent = parseTeamLineup(lineupsResponse(players('P')), TEAM, match)!;
  const block = formatApiFootballTeamContextBlock({
    team: 'Club',
    coach: null,
    recentFixtures: [],
    upcomingFixtures: [],
    squad: [{ name: 'P1', position: 'Goalkeeper', age: 30 }],
    recentLineups: [recent],
    unavailable: [],
  });
  assert.ok(block.indexOf('Recent Starting XIs') < block.indexOf('Registered Active Squad'));
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
