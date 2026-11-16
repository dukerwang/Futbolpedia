#!/usr/bin/env npx tsx
/**
 * Offline check for the reply views (components/views): the table folds the way a phone needs
 * (top four, bottom three, a neighbour either side of a highlighted club, no gap that hides a
 * single row, small groups left whole), a highlighted club is marked, the comparison draws the
 * card's own attribute groups and takes the goalkeeper cases apart, a ranking offers Scout only
 * for a player with no card and only when the surface can queue one, version pills take the
 * card's tone, and every skeleton says it is pending. Drawn from the gallery's fixtures with
 * static markup. No network, no model.
 *
 * Usage:
 *   npx tsx scripts/test-reply-views.ts
 */
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { LeagueTableSkeleton, LeagueTableView, keptRows, tableSkeletonProps } from '../components/views/LeagueTableView';
import { ComparisonSkeleton, ComparisonView } from '../components/views/ComparisonView';
import { RankingSkeleton, RankingView } from '../components/views/RankingView';
import { PitchBlockView, PitchSkeleton } from '../components/views/PitchBlockView';
import { clubKey, signed, versionPillOf } from '../components/views/viewParts';
import { isCardedEntry } from '../components/views/viewData';
import * as fx from '../components/views/fixtures';

let passes = 0;
let failures = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    console.log(`  ok   ${name}`);
  } catch (error: any) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const count = (haystack: string, needle: RegExp) => (haystack.match(needle) ?? []).length;

// ---------------------------------------------------------------------------------------------
// Table

test('a long table keeps the top four, the bottom three and a neighbour either side of a highlight', () => {
  const kept = [...keptRows(20, [9])].sort((a, b) => a - b);
  assert.deepEqual(kept, [0, 1, 2, 3, 8, 9, 10, 17, 18, 19]);
});

test('a gap that would hide one row shows the row instead', () => {
  // Rows 0-3 and a highlight at 6 (keeps 5-7): row 4 would be a gap of one.
  assert.ok(keptRows(20, [6]).has(4));
  assert.ok(!keptRows(20, [6]).has(8));
});

test('a table of eight or fewer rows never folds', () => {
  assert.equal(keptRows(8, []).size, 8);
  assert.equal(keptRows(4, [2]).size, 4);
});

test('highlighted clubs are marked, and a name matches however the feed spells it', () => {
  const out = html(React.createElement(LeagueTableView, { data: fx.tableLeague }));
  assert.equal(count(out, /data-highlight="true"/g), 2);
  assert.equal(clubKey('Brighton & Hove Albion FC'), clubKey('brighton and hove albion'));
  assert.equal(clubKey('AFC Bournemouth'), clubKey('Bournemouth'));
});

test('a folded phone table says how many rows each gap hides and offers the full table', () => {
  const out = html(React.createElement(LeagueTableView, { data: fx.tableLeague }));
  assert.match(out, /· · ·\s+12 more/);
  assert.match(out, /Show all 20 clubs/);
  // Every row is in the markup (folded ones are `hidden sm:table-row`), so desktop shows the whole table.
  assert.equal(count(out, /\bh-8\b/g), 20);
  assert.equal(count(out, /hidden sm:table-row/g), 12);
});

test('small groups and a feed with no form: no footer, no form column, dashes for gaps', () => {
  const small = html(React.createElement(LeagueTableView, { data: fx.tableSmallGroups }));
  assert.doesNotMatch(small, /Show all/);
  assert.match(small, /Group A/);
  assert.match(small, /Group B/);
  const bare = html(React.createElement(LeagueTableView, { data: fx.tableNoForm }));
  assert.doesNotMatch(bare, />Form</);
  assert.doesNotMatch(bare, /aria-label="Last \d/);
  assert.match(bare, />–</);
  assert.equal(signed(-3), '−3');
  assert.equal(signed(0), '0');
  assert.equal(signed(null), '–');
});

test('each group of a grouped table folds on its own', () => {
  const props = tableSkeletonProps(fx.tableGrouped);
  assert.equal(props.groups, 2);
  assert.equal(props.rows, 24);
  assert.ok(props.foldedRows < props.rows);
  assert.equal(props.foldedGaps, 2);
});

test('a form strip names the last five results for a screen reader', () => {
  const out = html(React.createElement(LeagueTableView, { data: fx.tableLeague }));
  assert.match(out, /aria-label="Last 5: win, win, draw, win, win"/);
});

// ---------------------------------------------------------------------------------------------
// Comparison

test('outfield players: all 25 attributes in four groups, the higher value emerald, a tie neither', () => {
  const out = html(React.createElement(ComparisonView, { data: fx.comparisonOutfield }));
  assert.equal(count(out, /role="row"/g), 25);
  for (const group of ['Technical', 'Tactical', 'Physical', 'Mental']) assert.match(out, new RegExp(`>${group}<`));
  // Overall is a tie (88 v 88): no headline number is emerald, while Potential 92 v 91 colours one.
  assert.match(out, /aria-label="Finishing: 82 against 68"/);
  const tie = html(React.createElement(ComparisonView, { data: fx.comparisonEdge }));
  assert.doesNotMatch(tie.slice(0, tie.indexOf('Technical')), /text-4xl[^"]*text-emerald/);
});

test('a goalkeeper against an outfield player compares headlines only, with one line saying why', () => {
  const out = html(React.createElement(ComparisonView, { data: fx.comparisonMixed }));
  assert.equal(count(out, /role="row"/g), 0);
  assert.match(out, /don(&#x27;|')t share a scale/);
  assert.match(out, /Alisson is a goalkeeper/);
  assert.match(out, /Sweeper Keeper/i);
});

test('two goalkeepers share one Goalkeeper group of seven attributes', () => {
  const out = html(React.createElement(ComparisonView, { data: fx.comparisonGoalkeepers }));
  assert.equal(count(out, /role="row"/g), 7);
  assert.match(out, />Goalkeeper</);
  assert.doesNotMatch(out, />Technical</);
});

test('names open their cards only when the surface can open one', () => {
  const withOpen = html(React.createElement(ComparisonView, { data: fx.comparisonOutfield, onOpenDossier: () => {} }));
  assert.match(withOpen, /aria-label="Open Pedri&#x27;s card"/);
  const without = html(React.createElement(ComparisonView, { data: fx.comparisonOutfield }));
  assert.doesNotMatch(without, /Open Pedri/);
});

test('different versions each wear a pill; the same version is named once in the caption', () => {
  const same = html(React.createElement(ComparisonView, { data: fx.comparisonOutfield }));
  assert.match(same, /Comparison · Current Form/);
  const mixed = html(React.createElement(ComparisonView, { data: fx.comparisonVersions }));
  assert.match(mixed, /Prime · 2008–11/);
  assert.match(mixed, /Current · Nov 2026/);
});

// ---------------------------------------------------------------------------------------------
// Ranking

test('an uncarded row offers Scout, a carded row opens its card', () => {
  const out = html(React.createElement(RankingView, { data: fx.rankingPeak, onOpenDossier: () => {}, onScoutName: () => {} }));
  const uncarded = fx.rankingPeak.entries.filter((e) => !isCardedEntry(e));
  assert.equal(uncarded.length, 3);
  assert.equal(count(out, /aria-label="Scout /g), 3);
  assert.equal(count(out, /Open card/g), 5);
  assert.match(out, /No card yet/);
});

test('a surface that can neither open cards nor queue Scout gets plain rows', () => {
  const out = html(React.createElement(RankingView, { data: fx.rankingPeak }));
  assert.doesNotMatch(out, /<button/);
  assert.match(out, /No card/);
});

test('moves are listed under the order only when there are some', () => {
  const moved = html(React.createElement(RankingView, { data: fx.rankingPeak }));
  assert.match(moved, /Order follows the cards/);
  assert.equal(count(moved, /above (Cristiano|Zinedine)/g), 2);
  const kept = html(React.createElement(RankingView, { data: fx.rankingOutput }));
  assert.doesNotMatch(kept, /Order follows the cards/);
});

test('the ceiling of fifteen entries draws fifteen rows in order', () => {
  assert.equal(fx.rankingLong.entries.length, 15);
  const out = html(React.createElement(RankingView, { data: fx.rankingLong }));
  assert.equal(count(out, /<li>/g), 15);
});

// ---------------------------------------------------------------------------------------------
// Pitch, pills, skeletons

test('the pitch keeps the figure inside the frame, with one caption', () => {
  const out = html(React.createElement(PitchBlockView, { lineup: fx.pitchLineup }));
  assert.match(out, /data-view="pitch"/);
  assert.match(out, /First-choice XI/);
  assert.match(out, /Martinelli/);
  assert.match(out, /or Merino/);
});

test('version pills take the tone of the card header', () => {
  assert.deepEqual(versionPillOf('Current Form (Nov 2026)'), { tone: 'emerald', text: 'Current · Nov 2026' });
  assert.deepEqual(versionPillOf('Prime Zenith (2003-06)'), { tone: 'amber', text: 'Prime · 2003–06' });
  assert.deepEqual(versionPillOf('Season (2015-16)'), { tone: 'amber', text: 'Season · 2015–16' });
  assert.equal(versionPillOf('Paris Saint-Germain era (2017-20)')?.tone, 'blue');
  assert.equal(versionPillOf(''), null);
  assert.equal(versionPillOf(undefined), null);
});

test('every skeleton says it is pending, and draws no figures', () => {
  const skeletons = [
    React.createElement(LeagueTableSkeleton),
    React.createElement(ComparisonSkeleton),
    React.createElement(RankingSkeleton, { title: 'A title', rows: 3 }),
    React.createElement(PitchSkeleton),
  ];
  for (const s of skeletons) {
    const out = html(s);
    assert.match(out, /data-state="pending"/);
    assert.match(out, /aria-busy="true"/);
    assert.doesNotMatch(out, /\d{2}<\/span>/);
  }
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
