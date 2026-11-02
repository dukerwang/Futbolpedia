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
import { expandTables, findFigures, gateUnsupportedFigures, isSupported, matchesSlot, qualifierNear, scopeOf, seasonsIn } from '../services/figureGate';

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
  assert.deepEqual(gateUnsupportedFigures(clean, EVIDENCE), { text: clean, removed: [], trimmed: [] });
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

// --- Scope: qualifier and span, for answers about past seasons -------------------------------

const CAREER = expandTables(`[E1] Career record (Wikipedia) — Zed Player
Career (infobox):
- 1996–2001: Juve, 151 league appearances, 24 league goals
- Career total: 506 league appearances, 95 league goals
Club appearances and goals by season (Wikipedia career statistics):
Club | Season | League Apps | League Goals | Total Apps | Total Goals
Juve | 1999–2000 | 32 | 4 | 41 | 5
Juve | 2000–01 | 33 | 6 | 39 | 6

[E2] Past season record (Wikipedia, ESPN) — 2003–04 Testville F.C. season
- Top goalscorer: League: Bo Striker (30 goals), All: Bo Striker (39 goals)
No. | Name | Premier League Apps | Premier League Goals | Total Apps | Total Goals
14 | Bo Striker | 37 | 30 | 50 | 39`);

const gateScoped = (reply: string) => gateUnsupportedFigures(reply, CAREER, [], { scoped: true });

test('qualifiers and seasons are read from the text, the narrower name first', () => {
  assert.equal(qualifierNear('10 champions league goals', 0), 'europe');
  assert.equal(qualifierNear('scored in the league cup', 5), 'cup');
  assert.equal(qualifierNear('total goals 39', 12), 'all');
  assert.equal(qualifierNear('league: bo striker (30 goals), all', 20), 'league');
  assert.equal(qualifierNear('a fine season', 0), null);
  assert.deepEqual(seasonsIn('In 2003–04 and 1999/00, not 2001-03'), [2003, 1999]);
  const [claim] = findFigures('He scored 39 goals in all competitions in 2003-04.');
  assert.deepEqual(scopeOf(claim, 'He scored 39 goals in all competitions in 2003-04.'), { qualifier: 'all', season: 2003, career: false });
});

test('a total across competitions given as a league figure is cut; the league figure stands', () => {
  const reply = 'Zed Player scored 5 league goals in 1999-2000. He scored 4 league goals in 1999-2000. He set the tempo.';
  const out = gateScoped(reply);
  assert.equal(out.text, 'He scored 4 league goals in 1999-2000. He set the tempo.');
  assert.deepEqual(out.removed.map((r) => r.text), ['5 league goals']);
  // The unscoped gate can't tell them apart.
  assert.equal(gateUnsupportedFigures(reply, CAREER).removed.length, 0);
});

test('a figure from another season, or a season figure given as a career one, is cut', () => {
  assert.equal(gateScoped('He scored 6 league goals in 1999-2000.').removed.length, 1);
  assert.equal(gateScoped('He scored 6 league goals in 2000-01.').removed.length, 0);
  assert.equal(gateScoped('He scored 95 league goals in his career.').removed.length, 0);
  assert.equal(gateScoped('He scored 24 league goals in his career.').removed.length, 0, 'an undated infobox row is given the benefit of the doubt');
});

test('correct sentences keep passing: the infobox league line, the all-competitions total, a season table', () => {
  const reply = 'Bo Striker scored 30 league goals in 2003-04. He scored 39 goals in all competitions that season. He made 37 Premier League appearances.';
  assert.equal(gateScoped(reply).text, reply);
  // The season heading of the source rules out another season.
  assert.equal(gateScoped('Bo Striker scored 30 league goals in 2004-05.').removed.length, 1);
});

test('figure-light: a reply within its budget is untouched; beyond it, figures nobody chose go from the end', () => {
  const budget = { max: 2, slots: ["the striker's league goals in the season"] };
  const light = 'Bo Striker scored 30 league goals in 2003-04. He led the line with movement rather than volume.';
  assert.equal(gateUnsupportedFigures(light, CAREER, [], { scoped: true, budget }).text, light);
  const heavy =
    'Bo Striker scored 30 league goals in 2003-04. He made 37 Premier League appearances. He scored 39 goals in all competitions. He made 50 appearances in all.';
  const out = gateUnsupportedFigures(heavy, CAREER, [], { scoped: true, budget });
  // The chosen figure is league goals, so the all-competitions total isn't it either.
  assert.equal(out.text, 'Bo Striker scored 30 league goals in 2003-04. He made 37 Premier League appearances.');
  assert.deepEqual(out.trimmed.map((t) => t.text), ['50 appearances', '39 goals']);
  assert.ok(matchesSlot(findFigures('30 league goals')[0], budget.slots));
  assert.ok(!matchesSlot(findFigures('37 Premier League appearances')[0], budget.slots));
});

test('a chosen figure matches on competition, season and match level, not just its noun', () => {
  const slots = ["his league goals in 2003-04"];
  const [league] = findFigures('He scored 30 league goals in 2003-04.');
  assert.ok(matchesSlot(league, slots, 'He scored 30 league goals in 2003-04.'));
  const [cup] = findFigures('He scored 5 FA Cup goals in 2003-04.');
  assert.ok(!matchesSlot(cup, slots, 'He scored 5 FA Cup goals in 2003-04.'));
  const [other] = findFigures('He scored 24 league goals in 2004-05.');
  assert.ok(!matchesSlot(other, slots, 'He scored 24 league goals in 2004-05.'));
  const [tally] = findFigures('He scored 2 goals against Athletic Bilbao.');
  assert.ok(!matchesSlot(tally, slots, 'He scored 2 goals against Athletic Bilbao.'));
  assert.ok(matchesSlot(tally, ['his goals in the final'], 'He scored 2 goals in the final.'));
});

test('on answers about the past, honour counts and numbers written as words are figures too', () => {
  const evidence = expandTables(`Honours:
- Serie A Defender of the Year: 2000, 2001, 2002, 2003 (four awards)
Rio Ferdinand PFA Team of the Year selections: 6`);
  const past = (t: string) => findFigures(t, { past: true }).map((c) => `${c.text}=${c.value}`);
  assert.deepEqual(past('He won three consecutive Serie A Defender of the Year awards.'), ['three consecutive Serie A Defender of the Year awards=3']);
  assert.deepEqual(past('He earned 6 PFA Premier League Team of the Year selections.'), ['6 PFA Premier League Team of the Year selections=6']);
  // The live gate leaves words alone, as before.
  assert.deepEqual(findFigures('They have won two games in a row.'), []);
  const reply = 'He won three consecutive Serie A Defender of the Year awards. He won four Defender of the Year awards. He read the game early.';
  const out = gateUnsupportedFigures(reply, evidence, [], { scoped: true });
  assert.equal(out.text, 'He won four Defender of the Year awards. He read the game early.');
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
