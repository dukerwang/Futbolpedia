#!/usr/bin/env npx tsx
/**
 * Offline check for the pitch view: every slot code ESPN's lineup parser can emit has a place on
 * the pitch, an XI's eleven slots and their labels never overlap, an even split and an empty slot
 * show their labels. Which XIs a reply draws is the model's call (`show_pitch`, see test-reply-blocks.ts).
 * No network, no model.
 *
 * Usage:
 *   npx tsx scripts/test-pitch-view.ts
 */
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { PitchView } from '../components/PitchView';
import { parseMatchLineup, roleRow, type ClubMatch } from '../services/liveFootball';
import {
  PITCH,
  lineupCaption,
  lineupViewOf,
  placeXI,
  positionLabels,
  surnameOf,
  type LineupSlot,
} from '../services/lineupView';
import type { ClubSituation } from '../services/situationSnapshot';

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

const slotsOf = (roles: string[], namer = (r: string, i: number) => `Player Number${i}`): LineupSlot[] =>
  roles.map((role, i) => ({ role, name: namer(role, i), starts: 5 }));

// Formations as ESPN's slot codes give them, back to front, with surnames long enough to crowd a row.
const FORMATIONS: Record<string, string[]> = {
  '4-3-3': ['G', 'LB', 'CD-L', 'CD-R', 'RB', 'CM-L', 'CM', 'CM-R', 'LF', 'F', 'RF'],
  '4-2-3-1': ['G', 'LB', 'CD-L', 'CD-R', 'RB', 'DM-L', 'DM-R', 'AM-L', 'AM', 'AM-R', 'F'],
  '4-4-2': ['G', 'LB', 'CD-L', 'CD-R', 'RB', 'LM', 'CM-L', 'CM-R', 'RM', 'CF-L', 'CF-R'],
  '3-5-2': ['G', 'CD-L', 'CD', 'CD-R', 'LWB', 'DM', 'CM-L', 'CM-R', 'RWB', 'CF-L', 'CF-R'],
  '5-3-2': ['G', 'LWB', 'CD-L', 'CD', 'CD-R', 'RWB', 'CM-L', 'CM', 'CM-R', 'CF-L', 'CF-R'],
  '3-4-3': ['G', 'CD-L', 'CD', 'CD-R', 'LM', 'CM-L', 'CM-R', 'RM', 'LF', 'F', 'RF'],
  '4-1-4-1': ['G', 'LB', 'CD-L', 'CD-R', 'RB', 'DM', 'LM', 'CM-L', 'CM-R', 'RM', 'F'],
  '3-4-2-1': ['G', 'CD-L', 'CD', 'CD-R', 'LM', 'CM-L', 'CM-R', 'RM', 'AM-L', 'AM-R', 'F'],
  'season starts, 4-3-3 by count': ['GK', 'D', 'D', 'D', 'D', 'M', 'M', 'M', 'F', 'F', 'F'],
  'season starts, 3-5-2 by count': ['GK', 'D', 'D', 'D', 'M', 'M', 'M', 'M', 'M', 'F', 'F'],
};

// Every code the parser can emit: those its role helpers name, ESPN's wider set, and the fallback.
const SLOT_CODES = [
  'G', 'GK', 'D', 'M', 'F',
  'CD', 'CD-L', 'CD-R', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'SW',
  'DM', 'DM-L', 'DM-R',
  'CM', 'CM-L', 'CM-R', 'LM', 'RM',
  'AM', 'AM-L', 'AM-R',
  'LW', 'RW', 'LF', 'RF', 'CF', 'CF-L', 'CF-R', 'SS', 'ST',
  '?',
];

test('the parser passes every ESPN position code through as the slot role', () => {
  const match = { id: '1', date: '2026-11-01', competition: 'Premier League', leagueSlug: 'eng.1', home: true, opponent: 'X', completed: true, goalsFor: 1, goalsAgainst: 0, penaltiesFor: null, penaltiesAgainst: null } as ClubMatch;
  const roster = FORMATIONS['4-2-3-1'].map((abbreviation, i) => ({ starter: true, athlete: { displayName: `P${i}` }, position: { abbreviation } }));
  const lineup = parseMatchLineup({ rosters: [{ team: { id: '9' }, formation: '4-2-3-1', roster }] }, '9', match);
  assert.deepEqual(lineup?.starters.map((s) => s.role), FORMATIONS['4-2-3-1']);
  // A player ESPN gives no position still gets a slot, with the fallback code.
  const unknown = parseMatchLineup({ rosters: [{ team: { id: '9' }, roster: roster.map((p, i) => (i === 0 ? { ...p, position: undefined } : p)) }] }, '9', match);
  assert.equal(unknown?.starters[0].role, '?');
});

test('every slot code gets a position on the pitch', () => {
  for (const code of SLOT_CODES) {
    const [slot] = placeXI([{ role: code, name: 'Some Player', starts: 1 }]);
    assert.ok(Number.isFinite(slot.x) && Number.isFinite(slot.y), `${code} has finite coordinates`);
    assert.ok(slot.x >= PITCH.inset + PITCH.discRadius && slot.x <= PITCH.width - PITCH.inset - PITCH.discRadius, `${code} is inside the pitch sideways`);
    assert.ok(slot.y >= PITCH.inset + PITCH.discRadius && slot.y <= PITCH.height - PITCH.inset - PITCH.discRadius, `${code} is inside the pitch lengthways`);
  }
});

test('rows run from the goalkeeper up, and -L sits left of -R', () => {
  const placed = placeXI(slotsOf(FORMATIONS['4-2-3-1'], (r) => `Name ${r}`));
  const at = (role: string) => placed.find((p) => p.role === role)!;
  assert.ok(at('G').y > at('LB').y && at('LB').y > at('DM-L').y && at('DM-L').y > at('AM').y && at('AM').y > at('F').y, 'attacking upward');
  assert.ok(at('LB').x < at('CD-L').x && at('CD-L').x < at('CD-R').x && at('CD-R').x < at('RB').x, 'the back four runs left to right');
  assert.ok(at('DM-L').x < at('DM-R').x && at('AM-L').x < at('AM').x && at('AM').x < at('AM-R').x);
  assert.equal(at('G').x, PITCH.width / 2);
  // A line no slot uses takes no room: the same slots fill the pitch from keeper to forward.
  const rows = new Set(placed.map((p) => p.y));
  assert.equal(rows.size, new Set(FORMATIONS['4-2-3-1'].map(roleRow)).size);
  assert.equal(Math.max(...rows) > Math.min(...rows) + 250, true);
});

test('eleven distinct slots never overlap, discs or labels, in any formation', () => {
  for (const [name, roles] of Object.entries(FORMATIONS)) {
    const placed = placeXI(slotsOf(roles, (_r, i) => `Longnamed Alexander-Arnold${i}`).map((s, i) => (i === 3 ? { ...s, rotation: 'Another Rotation Player' } : s)));
    assert.equal(placed.length, 11, name);
    assert.equal(new Set(placed.map((p) => p.key)).size, 11, `${name}: distinct keys`);
    const box = (p: (typeof placed)[number]) => ({
      left: p.x - Math.max(PITCH.discRadius, p.labelWidth / 2),
      right: p.x + Math.max(PITCH.discRadius, p.labelWidth / 2),
      top: p.y - PITCH.discRadius,
      bottom: p.y + PITCH.discRadius + (p.alt ? 26 : 15),
    });
    for (let i = 0; i < placed.length; i++) {
      const a = box(placed[i]);
      assert.ok(a.left >= PITCH.inset && a.right <= PITCH.width - PITCH.inset && a.bottom <= PITCH.height - PITCH.inset && a.top >= PITCH.inset, `${name}: ${placed[i].role} stays on the pitch`);
      for (let j = i + 1; j < placed.length; j++) {
        const b = box(placed[j]);
        const apart = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
        assert.ok(apart, `${name}: ${placed[i].role} and ${placed[j].role} overlap`);
      }
    }
  }
});

test('long names are cut to fit and a short full name stays whole', () => {
  assert.equal(surnameOf('Bukayo Saka'), 'Saka');
  assert.equal(surnameOf('Virgil van Dijk'), 'van Dijk');
  assert.equal(surnameOf('Trent Alexander-Arnold'), 'Alexander-Arnold');
  assert.equal(surnameOf('Frenkie de Jong'), 'de Jong');
  assert.equal(surnameOf('Vinicius Junior Jr.'), 'Junior Jr.');
  assert.equal(surnameOf('Ben White'), 'Ben White');
  assert.equal(surnameOf('Rodri'), 'Rodri');
  const crowded = placeXI(slotsOf(FORMATIONS['3-5-2'], () => 'Trent Alexander-Arnold'));
  assert.ok(crowded.every((p) => p.label.length <= 14));
  assert.ok(crowded.some((p) => p.label.endsWith('…')));
});

const lineup = (over: Partial<ClubSituation> = {}): ClubSituation => ({
  club: 'Arsenal',
  league: 'Premier League',
  asOf: '2026-11-14',
  formation: '4-2-3-1',
  matchesRead: 6,
  xi: FORMATIONS['4-2-3-1'].map((role, i) => ({ role, name: `Player Number${i}`, starts: 6 })),
  xiBasis: 'lineups',
  out: [{ name: 'Gabriel Jesus', note: 'knee, back around late November' }],
  outCovered: true,
  form: [],
  record: 'WWDLW',
  nextFixture: null,
  ...over,
});

test('an even split and an empty slot show their labels', () => {
  const xi = lineup().xi.map((s, i) => (i === 5 ? { ...s, name: 'Declan Rice', rotation: 'Martin Zubimendi' } : i === 8 ? { ...s, name: null, starts: 0 } : s));
  const html = renderToStaticMarkup(React.createElement(PitchView, { lineups: [lineupViewOf(lineup({ xi }))!] }));
  assert.match(html, /Rice/);
  assert.match(html, /or Zubimendi/);
  // The empty slot names its role, with an open disc.
  assert.match(html, /<text[^>]*>CAM<\/text>/);
  assert.match(html, /<title>CAM, no first choice found<\/title>/);
  assert.match(html, /stroke-dasharray="3 3"/);
  assert.match(html, /Gabriel Jesus/);
  assert.match(html, /knee, back around late November/);
  assert.match(html, /First-choice XI · 4-2-3-1 · from 6 recent starting XIs · as of 2026-11-14/);
});

test('slots read in the positions a card uses, from their line and where they sit in it', () => {
  const labels = (roles: string[]) => positionLabels(slotsOf(roles)).join(' ');
  // ESPN names a 4-2-3-1's holding pair LM and RM: on the pitch they are two holding midfielders.
  assert.equal(labels(['G', 'LB', 'CD-L', 'CD-R', 'RB', 'LM', 'RM', 'AM-L', 'AM', 'AM-R', 'F']), 'GK LB CB CB RB CDM CDM LW CAM RW CF');
  assert.equal(labels(FORMATIONS['4-2-3-1']), 'GK LB CB CB RB CDM CDM LW CAM RW CF');
  assert.equal(labels(FORMATIONS['4-3-3']), 'GK LB CB CB RB CM CM CM LW CF RW');
  assert.equal(labels(FORMATIONS['4-4-2']), 'GK LB CB CB RB LM CM CM RM CF CF');
  assert.equal(labels(FORMATIONS['3-5-2']), 'GK CB CB CB LWB CDM CM CM RWB CF CF');
  assert.equal(labels(FORMATIONS['3-4-3']), 'GK CB CB CB LWB CM CM RWB LW CF RW');
  assert.equal(labels(FORMATIONS['4-1-4-1']), 'GK LB CB CB RB CDM LM CM CM RM CF');
  // A narrow pair behind the striker stays central.
  assert.equal(labels(FORMATIONS['3-4-2-1']), 'GK CB CB CB LWB CM CM RWB CAM CAM CF');
  assert.equal(labels(FORMATIONS['season starts, 4-3-3 by count']), 'GK DEF DEF DEF DEF MID MID MID FWD FWD FWD');
});

test('the caption follows the XI basis', () => {
  const view = (over: Partial<ClubSituation>) => lineupViewOf(lineup(over))!;
  assert.equal(lineupCaption(view({ matchesRead: 1 })), 'First-choice XI · 4-2-3-1 · from 1 recent starting XI · as of 2026-11-14');
  assert.equal(lineupCaption(view({ xiBasis: 'season_starts', formation: null, matchesRead: 0 })), 'First-choice XI · from season starts · as of 2026-11-14');
  assert.equal(lineupCaption({ ...view({}), xiBasis: 'none' }), 'First-choice XI · no recent lineups read · as of 2026-11-14');
});

test('absences from the news join the injury list without repeating a name', () => {
  const covered = lineupViewOf(lineup({ newsAbsences: [{ name: 'Someone Else', note: 'illness' }] }))!;
  assert.deepEqual(covered.out.map((o) => o.name), ['Gabriel Jesus']);
  const uncovered = lineupViewOf(lineup({ outCovered: false, out: [], newsAbsences: [{ name: 'Someone Else', note: 'illness' }, { name: 'someone else', note: 'again' }] }))!;
  assert.deepEqual(uncovered.out, [{ name: 'Someone Else', note: 'illness' }]);
  assert.equal(lineupViewOf(lineup({ xiBasis: 'none', xi: [] })), null);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
