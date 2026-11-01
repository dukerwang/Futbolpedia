#!/usr/bin/env npx tsx
/**
 * Offline checks for the figure gate: precise figures in a live answer stay only when the turn's
 * evidence has the same number beside the same kind of word. Unsupported ones take their
 * sentence with them, a table only loses the cell, and text the writer's own search grounded stands.
 *
 * Usage:
 *   npx tsx scripts/test-figure-gate.ts
 */
import assert from 'node:assert/strict';
import { expandTables, findFigures, gateUnsupportedFigures, isSupported } from '../services/figureGate';

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

const EVIDENCE = `Northside (Premier League), live data as of 2026-11-01.
Premier League this season, by minutes (starts, minutes, goals, assists): Main Nine 9, 810', 6G 2A; Wide Man 8, 700', 3G 4A.
Wide Man — Northside, Midfielder. Premier League this season: 8 starts, 700 minutes, 3 goals, 4 assists, xG 2.34, xA 1.10.
1. Northside — 24 pts, P10 W7 D3 L0, GD +14
2. Southside — 22 pts, P10 W7 D1 L2, GD +9
[2026-08-20] Northside signed Main Nine from abroad for £48m.
[2026-10-30] The coach said "we have to be braver with the ball in the first phase" after the draw.`;

test('it finds the kinds of precise figures the writer invents', () => {
  const kinds = findFigures(
    'They allow a PPDA of 8.4, have 64% possession, paid £75m for him, sit 3rd place with 18 points and a +19 goal difference, he went off in the 84th minute, wears the number 7 shirt, and said "this is a very special group of players for me".',
  ).map((c) => c.kind);
  assert.deepEqual(kinds, ['decimal', 'percent', 'money', 'position', 'stat', 'goal_difference', 'minute', 'shirt', 'quote']);
  // A bare small count and a year aren't precise figures worth judging.
  assert.deepEqual(findFigures('He scored 1 goal in 2026 and the team won.'), []);
});

test('a figure counts as found only beside the same kind of word in the evidence', () => {
  const [goals] = findFigures('Main Nine has 6 goals.');
  assert.equal(isSupported(goals, EVIDENCE), true);
  // 9 is in the evidence, but as starts, not goals.
  const [nine] = findFigures('Main Nine has 9 goals.');
  assert.equal(isSupported(nine, EVIDENCE), false);
  assert.equal(isSupported(findFigures('They have 24 points.')[0], EVIDENCE), true);
  assert.equal(isSupported(findFigures('a +14 goal difference')[0], EVIDENCE), true);
  assert.equal(isSupported(findFigures('They sit 1st place.')[0], EVIDENCE), true);
  assert.equal(isSupported(findFigures('He cost £48m.')[0], EVIDENCE), true);
  assert.equal(isSupported(findFigures('He cost £60m.')[0], EVIDENCE), false);
  // A rounded decimal matches the longer one.
  assert.equal(isSupported(findFigures('an xG of 2.3')[0], EVIDENCE), true);
  assert.equal(isSupported(findFigures('a PPDA of 8.4')[0], EVIDENCE), false);
  assert.equal(isSupported(findFigures('He said "we have to be braver with the ball in the first phase" again.')[0], EVIDENCE), true);
  assert.equal(isSupported(findFigures('He said "we will win the league this year for sure" again.')[0], EVIDENCE), false);
});

test('an unsupported figure takes its sentence; the rest of the paragraph and every judgment stay', () => {
  const reply = `## Build-up\nNorthside build through a back four. They allow a PPDA of 8.4 when pressing. Main Nine has 6 goals and leads the line well.\n\n- Wide Man has 3 goals.\n- He has 11 dribbles a game.\n\nThe verdict: this is the best side in the league.`;
  const { text, removed } = gateUnsupportedFigures(reply, EVIDENCE);
  assert.equal(
    text,
    `## Build-up\nNorthside build through a back four. Main Nine has 6 goals and leads the line well.\n\n- Wide Man has 3 goals.\n\nThe verdict: this is the best side in the league.`,
  );
  assert.deepEqual(removed.map((r) => r.text), ['8.4', '11 dribbles']);
});

test('a table keeps its shape and only loses the unsupported cell', () => {
  const table = '| Club | Pts | GD |\n| --- | --- | --- |\n| Northside | 24 points | +14 goal difference |\n| Westside | 19 points | +6 goal difference |';
  const { text } = gateUnsupportedFigures(table, EVIDENCE);
  assert.equal(text, '| Club | Pts | GD |\n| --- | --- | --- |\n| Northside | 24 points | +14 goal difference |\n| Westside | – | – |');
});

test("a sentence the writer's own search grounded stands, and a clean reply comes back untouched", () => {
  const reply = 'They press high. They allow a PPDA of 8.4 when pressing.';
  assert.equal(gateUnsupportedFigures(reply, EVIDENCE, ['They allow a PPDA of 8.4 when pressing.']).text, reply);
  const clean = 'Northside press high and build through a back four.';
  assert.deepEqual(gateUnsupportedFigures(clean, EVIDENCE), { text: clean, removed: [] });
});


test('historical figures from a season table stand once the table is read by its columns', () => {
  const table = `Squad appearances and goals:
No. | Pos. | Name | Premier League Apps | Premier League Goals | Total Apps | Total Goals
14 | FW | Bo Striker | 37 | 30 | 50 (1) | 39
Honours:
- Premier League: 2001–02, 2003–04`;
  const evidence = expandTables(table);
  assert.ok(evidence.includes('Premier League Goals 30'));
  const reply = "He scored 30 league goals that season. He also won 4 titles at the club. He was the side's focal point.";
  const gated = gateUnsupportedFigures(reply, evidence);
  assert.equal(gated.text, "He scored 30 league goals that season. He was the side's focal point.");
  assert.deepEqual(gated.removed.map((r) => r.text), ['4 titles']);
  // Without the expansion, the table's goals sit too far from their header.
  assert.equal(isSupported(findFigures('30 league goals')[0], table), false);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
