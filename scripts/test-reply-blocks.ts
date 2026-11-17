#!/usr/bin/env npx tsx
/**
 * Offline check for reply blocks: each registry entry (build, its failures, toolResult, toHistory,
 * toCopy), the composer (prose split at inline views, views placed at the end, pending blocks
 * resolving and failing, blocks code adds in today's order, the question dropping answer views,
 * snapshot and restore, throttled text), `blocksOf` on every legacy field, and the history stubs a
 * block reply writes. Feeds, cards and the clock are faked. No network, no model.
 *
 * Usage:
 *   npx tsx scripts/test-reply-blocks.ts
 */
import assert from 'node:assert/strict';
import type { AskPrompt, ChatMessage, GaffaTradeScorecard, PlayerProfile, ReplyBlock } from '../types';
import { formatClubReport, type ClubMatch, type LiveClubReport } from '../services/liveFootball';
import type { ResearchToolset, ToolOutcome } from '../services/researchTools';
import { emptyLedger, type EvidenceLedger } from '../services/evidenceLedger';
import type { LineupView } from '../services/lineupView';
import { ReplyComposer, REPLY_BLOCKS, blocksOf, copyTextOf, createViewTools, gateSegments, joinSegments, MAX_REPLY_VIEWS, readyOf, runViewTool, splitSegments, viewToolDeclarations, withDossierBlock } from '../services/replyBlocks';
import { gateUnsupportedFigures } from '../services/figureGate';
import { getCardKey } from '../services/dossierCards';
import type { DossierLookup } from '../services/dossierLookup';
import type { StandingsRow } from '../services/liveFootball';
import type { BuildContext } from '../services/replyBlocks';
import { pitchBlock } from '../services/replyBlocks/pitch';
import { buildHistoryContents } from '../services/dossierContext';
import { toChatDossierRef } from '../services/dossierRefs';

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).stack ?? err}`);
  }
}

// --- Fakes ------------------------------------------------------------------------------------

const match = (id: string, date: string): ClubMatch => ({
  id,
  date,
  competition: 'LaLiga',
  leagueSlug: 'esp.1',
  home: true,
  opponent: `Opponent ${id}`,
  completed: true,
  goalsFor: 2,
  goalsAgainst: 1,
  penaltiesFor: null,
  penaltiesAgainst: null,
});
const roles = ['G', 'LB', 'CD-L', 'CD-R', 'RB', 'DM', 'CM-L', 'CM-R', 'LF', 'F', 'RF'];
const names = ['Keeper', 'New Fullback', 'Centre Left', 'Centre Right', 'Right Back', 'Anchor', 'Eight One', 'Eight Two', 'Left Wing', 'Main Nine', 'Right Wing'];
const reportOf = (team: string): LiveClubReport => ({
  team,
  league: 'LaLiga',
  lineups: ['m3', 'm2', 'm1'].map((id, i) => ({
    match: match(id, `2026-10-${25 - i * 7}`),
    formation: '4-3-3',
    starters: roles.map((role, j) => ({ name: names[j], role })),
    subsUsed: [],
  })),
  results: ['m3', 'm2', 'm1'].map((id, i) => match(id, `2026-10-${25 - i * 7}`)),
  fixtures: [],
  fplPlayers: null,
  asOf: '2026-11-01',
});

const nothing = async (): Promise<ToolOutcome> => ({ status: 'empty', result: null, missing: [] });
const toolsFor = (known: string[], calls: string[] = []): ResearchToolset => ({
  clubRecentTeam: async (club) => {
    calls.push(club);
    if (!known.includes(club)) return { status: 'empty', result: null, missing: [{ item: `Live data for ${club}`, status: 'empty' }] };
    const report = reportOf(club);
    return {
      status: 'found',
      result: { kind: 'club_context', label: `${club}: recent matches`, content: formatClubReport(report), stage: 'facts', club: report },
      missing: [],
    };
  },
  playerSeason: nothing,
  leagueTable: nothing,
  webSearch: nothing,
  card: nothing,
  clubSeason: nothing,
  playerCareer: nothing,
});

let ledger: EvidenceLedger = emptyLedger();
let counter = 0;
const ctxFor = (tools: ResearchToolset, blocks: () => ReplyBlock[] = () => []): BuildContext => ({
  tools,
  ledger: { read: () => ledger, write: (next) => { ledger = next; } },
  stored: [],
  blocks,
  now: () => 1_000,
  newId: () => `t${++counter}`,
});

const card = (name: string, overall = 85, label = 'current form'): PlayerProfile =>
  ({
    basicInfo: { name, club: 'Bayer Leverkusen', position: 'Attacking Midfielder', age: 23, nationality: 'Germany' },
    ratings: { overall, potential: 90 },
    createdAt: 1,
    evaluationDate: '2026-11-01',
    version: { id: `${name}-current`, type: 'current', label, evaluationDate: '2026-11-01' },
    attributes: { finishing: 80 },
    shortBio: 'A card.',
  }) as unknown as PlayerProfile;

const scorecard = {
  verdict: 'take',
  confidence: 'high',
  outgoing: 'Out Player',
  outgoing_club: 'Club A',
  incoming: 'In Player',
  incoming_club: 'Club B',
  replacement: 4,
  coverage: 3,
  cash_deployable: 5,
  starter_leverage: 2,
} as unknown as GaffaTradeScorecard;

const view = (club: string): LineupView => ({
  club,
  league: 'LaLiga',
  asOf: '2026-11-01',
  formation: '4-3-3',
  xiBasis: 'lineups',
  matchesRead: 3,
  xi: roles.map((role, j) => ({ role, name: names[j], starts: 3 })),
  out: [{ name: 'Hurt Winger', note: 'knee' }],
});

const kinds = (blocks: ReplyBlock[]): string[] => blocks.map((b) => b.kind);

// --- Registry ---------------------------------------------------------------------------------

await test('the four views have a tool, and both paths read the declarations from the registry', () => {
  assert.deepEqual(viewToolDeclarations().map((d) => d.name), ['show_pitch', 'show_table', 'show_comparison', 'show_ranking']);
  assert.match(REPLY_BLOCKS.pitch.tool!.description!, /first-choice XI/);
  for (const kind of ['card', 'scoutOffer', 'ask', 'goDeeper', 'scorecard'] as const) assert.equal(REPLY_BLOCKS[kind].tool, undefined, kind);
});

await test('pitch: builds the XI from the live report, files the lookup, and reads it back', async () => {
  ledger = emptyLedger();
  const calls: string[] = [];
  const out = await REPLY_BLOCKS.pitch.build({ club: 'Southside' }, ctxFor(toolsFor(['Southside'], calls)));
  assert.ok('block' in out);
  if (!('block' in out)) return;
  assert.deepEqual(calls, ['Southside']);
  assert.equal(ledger.lookups.length, 1, 'the lookup is in the ledger');
  const { data } = out.block;
  assert.equal(data.club, 'Southside');
  assert.equal(data.formation, '4-3-3');
  assert.equal(data.xi.length, 11);
  const result = REPLY_BLOCKS.pitch.toolResult(out.block);
  assert.equal(result.shown, true);
  assert.match(String(result.xi), /LB New Fullback/);
  assert.equal(REPLY_BLOCKS.pitch.toHistory(out.block), '[shown: first-choice XI, Southside, 4-3-3]');
  assert.equal(REPLY_BLOCKS.pitch.toCopy(out.block), '');
  // A second club's build reads the ledger first: a lookup already filed isn't repeated.
  await REPLY_BLOCKS.pitch.build({ club: 'Southside' }, ctxFor(toolsFor(['Southside'], calls)));
  assert.deepEqual(calls, ['Southside']);
});

await test('pitch: each failure is a reason the model reads', async () => {
  ledger = emptyLedger();
  const none = await REPLY_BLOCKS.pitch.build({ club: '' }, ctxFor(toolsFor([])));
  assert.deepEqual(none, { error: 'Missing club' });
  const unknown = await REPLY_BLOCKS.pitch.build({ club: 'Nowhere' }, ctxFor(toolsFor([])));
  assert.deepEqual(unknown, { error: 'No live data for that club, so no XI to draw.' });
  // No rule about a subject or a count: the same club twice, and a third XI, are the model's own choice.
  const shown = [pitchBlock('p1', view('Southside')), pitchBlock('p2', view('Alpha')), pitchBlock('p3', view('Beta'))];
  const again = await REPLY_BLOCKS.pitch.build({ club: 'Southside' }, ctxFor(toolsFor(['Southside']), () => shown));
  assert.ok('block' in again);
});

await test('pitch: the XI the writer argues from is the one drawn', async () => {
  ledger = emptyLedger();
  const calls: string[] = [];
  const situation = { asOf: '2026-11-14', clubs: [{ ...view('Southside'), out: [], outCovered: true, newsAbsences: [], form: '', changes: [], distinctive: '', unknowns: [] }], players: [], unknowns: [] } as any;
  const out = await REPLY_BLOCKS.pitch.build({ club: 'southside fc' }, { ...ctxFor(toolsFor(['Southside'], calls)), situation: () => situation });
  assert.ok('block' in out);
  assert.deepEqual(calls, [], 'no lookup: the snapshot already holds the club');
});

await test('card, scoutOffer, ask, goDeeper and scorecard: build, failure, result, history and copy', async () => {
  const ctx = ctxFor(toolsFor([]));
  const c = await REPLY_BLOCKS.card.build({ profile: card('Florian Wirtz') }, ctx);
  assert.ok('block' in c);
  if ('block' in c) {
    assert.equal(c.block.data.name, 'Florian Wirtz');
    assert.equal(REPLY_BLOCKS.card.toHistory(c.block), '[shown: dossier card, Florian Wirtz (current form), Overall 85]');
    assert.equal(REPLY_BLOCKS.card.toCopy(c.block), '');
    assert.deepEqual(REPLY_BLOCKS.card.toolResult(c.block), { shown: true });
  }
  assert.ok('error' in (await REPLY_BLOCKS.card.build({ profile: {} as PlayerProfile }, ctx)));

  const o = await REPLY_BLOCKS.scoutOffer.build({ name: '  prime   Pedri ' }, ctx);
  assert.ok('block' in o);
  if ('block' in o) {
    assert.equal(o.block.data.name, 'prime Pedri');
    assert.equal(REPLY_BLOCKS.scoutOffer.toHistory(o.block), '[offered: Scout prime Pedri, who has no card yet]');
    assert.equal(REPLY_BLOCKS.scoutOffer.toCopy(o.block), '');
  }
  assert.deepEqual(await REPLY_BLOCKS.scoutOffer.build({ name: ' ' }, ctx), { error: 'Missing player name' });

  const ask: AskPrompt = { question: 'Which version?', options: ['Current', 'Prime'] };
  const a = await REPLY_BLOCKS.ask.build(ask, ctx);
  assert.ok('block' in a);
  if ('block' in a) {
    assert.match(String(REPLY_BLOCKS.ask.toolResult(a.block).note), /Write nothing else/);
    assert.equal(REPLY_BLOCKS.ask.toHistory(a.block), '[offered replies: Current | Prime]');
    assert.equal(REPLY_BLOCKS.ask.toCopy(a.block), '');
  }
  assert.ok('error' in (await REPLY_BLOCKS.ask.build({ question: 'Q', options: [] }, ctx)));

  const g = await REPLY_BLOCKS.goDeeper.build({ reason: '  Lineups not read. ' }, ctx);
  assert.ok('block' in g);
  if ('block' in g) {
    assert.equal(g.block.data.reason, 'Lineups not read.');
    assert.equal(REPLY_BLOCKS.goDeeper.toHistory(g.block), '', 'a chip is not something the reader read');
  }
  assert.ok('error' in (await REPLY_BLOCKS.goDeeper.build({ reason: ' ' }, ctx)));

  const s = await REPLY_BLOCKS.scorecard.build(scorecard, ctx);
  assert.ok('block' in s);
  if ('block' in s) {
    assert.match(REPLY_BLOCKS.scorecard.toHistory(s.block), /trade scorecard, Out Player for In Player/);
    assert.match(REPLY_BLOCKS.scorecard.toCopy(s.block), /Take · high confidence/);
  }
  assert.ok('error' in (await REPLY_BLOCKS.scorecard.build({} as GaffaTradeScorecard, ctx)));
});

await test('copyTextOf joins the scorecard and the prose, and leaves views and chips out', () => {
  const composer = new ReplyComposer();
  composer.setScorecard(scorecard);
  composer.setText('The prose.');
  composer.addView(pitchBlock(composer.newId(), view('Southside')));
  composer.showCard(card('Florian Wirtz'));
  composer.offerScout('Pedri');
  const text = copyTextOf(composer.finish('The prose.'));
  assert.match(text, /^Take · high confidence/);
  assert.ok(text.endsWith('The prose.'));
  assert.ok(!/Southside|Wirtz|Pedri/.test(text));
});

// --- Composer ---------------------------------------------------------------------------------

await test('prose splits at an inline view, and the text after it follows the view', () => {
  const composer = new ReplyComposer();
  composer.setText('Before the table. ');
  composer.addView(pitchBlock(composer.newId(), view('Southside')), { inline: true });
  composer.setText('Before the table. After it.');
  const blocks = composer.finish('Before the table. After it.');
  assert.deepEqual(kinds(blocks), ['prose', 'pitch', 'prose']);
  assert.equal((blocks[0] as { text: string }).text, 'Before the table. ');
  assert.equal((blocks[2] as { text: string }).text, 'After it.');
});

await test('a view placed at the end stays after the prose however the text grows', () => {
  const composer = new ReplyComposer();
  composer.addView(pitchBlock(composer.newId(), view('Southside')));
  composer.setText('An answer.');
  assert.deepEqual(kinds(composer.finish('An answer.')), ['prose', 'pitch']);
});

await test('a pending view holds its place, then resolves or fails; one left pending is dropped at the end', () => {
  const composer = new ReplyComposer();
  composer.setText('Text. ');
  const a = composer.beginView('pitch', { inline: true });
  const b = composer.beginView('pitch');
  assert.deepEqual(composer.blocks().map((x) => (x.kind === 'prose' ? 'prose' : x.status)), ['prose', 'pending', 'pending']);
  composer.resolve({ ...pitchBlock(a, view('Alpha')) });
  composer.fail(b);
  assert.deepEqual(composer.blocks().map((x) => (x.kind === 'prose' ? 'prose' : x.status)), ['prose', 'ready', 'failed']);
  composer.beginView('pitch');
  const done = composer.finish('Text. ');
  assert.deepEqual(kinds(done), ['prose', 'pitch'], 'failed and pending views are not stored');
  assert.ok(done.every((x) => x.kind === 'prose' || x.status === 'ready'));
});

await test('code-added blocks go where their feature puts them today', () => {
  const composer = new ReplyComposer();
  composer.offerScout('Pedri');
  composer.showCard(card('Florian Wirtz'));
  composer.addView(pitchBlock(composer.newId(), view('Southside')));
  composer.setScorecard(scorecard);
  composer.setText('The reply.');
  assert.deepEqual(kinds(composer.finish('The reply.')), ['scorecard', 'prose', 'pitch', 'card', 'scoutOffer']);
});

await test('a card replaces a plain offer for the same player, and a player is offered once', () => {
  const composer = new ReplyComposer();
  composer.offerScout('Pedri');
  composer.offerScout('pedri');
  composer.offerScout('Florian Wirtz');
  composer.showCard(card('Florian Wirtz'));
  composer.showCard(card('Florian Wirtz'));
  composer.offerScout('Wirtz');
  assert.deepEqual(composer.scoutOffers, ['Pedri', 'Wirtz']);
  assert.equal(composer.cards.length, 1);
  assert.equal(composer.viewsOf('card').length, 1);
});

await test('a question is the whole reply: it drops cards and XIs, and keeps offers', () => {
  const composer = new ReplyComposer();
  composer.offerScout('Pedri');
  composer.showCard(card('Florian Wirtz'));
  composer.addView(pitchBlock(composer.newId(), view('Southside')));
  composer.addView(pitchBlock(composer.newId(), view('Beta')), { inline: true });
  composer.setAsk({ question: 'Which season?', options: ['This one', 'Last one'] });
  assert.deepEqual(kinds(composer.blocks()), ['scoutOffer', 'ask']);
});

await test('snapshot and restore drop what a failed attempt added, text included', () => {
  const composer = new ReplyComposer();
  composer.offerScout('Pedri');
  composer.setText('Earlier.');
  const saved = composer.snapshot();
  composer.showCard(card('Florian Wirtz'));
  composer.addView(pitchBlock(composer.newId(), view('Southside')));
  composer.setText('Earlier. Lots more from the attempt that gave up.');
  composer.restore(saved);
  assert.deepEqual(kinds(composer.blocks()), ['prose', 'scoutOffer']);
  assert.equal(composer.cards.length, 0);
});

await test('text notices are throttled; structural changes always announce', () => {
  let clock = 0;
  const seen: number[] = [];
  const composer = new ReplyComposer({ now: () => clock, onChange: (blocks) => seen.push(blocks.length) });
  composer.setText('a');
  clock = 10;
  composer.setText('ab');
  assert.equal(seen.length, 1, 'inside the interval: no notice');
  composer.offerScout('Pedri');
  assert.equal(seen.length, 2, 'a block is announced at once');
  clock = 100;
  composer.setText('abc');
  assert.equal(seen.length, 3);
  composer.finish('abc');
  assert.equal(seen.length, 4, 'the final blocks are announced once more');
});

await test('onChange hands over the cards behind the card blocks', () => {
  let cards: PlayerProfile[] = [];
  const composer = new ReplyComposer({ onChange: (_b, extras) => (cards = extras.cards) });
  const wirtz = card('Florian Wirtz');
  composer.showCard(wirtz);
  assert.deepEqual(cards, [wirtz]);
});

await test('runViewTool: places a ready view, reports a failure as the result, and a pending view settles in place', async () => {
  ledger = emptyLedger();
  const composer = new ReplyComposer();
  const base = { tools: toolsFor(['Southside']), ledger: ctxFor(toolsFor([])).ledger, stored: [], now: () => 0 };
  const ok = await runViewTool(REPLY_BLOCKS.pitch, { club: 'Southside' }, base, composer);
  assert.equal(ok.shown, true);
  assert.equal(composer.viewsOf('pitch').length, 1);
  const bad = await runViewTool(REPLY_BLOCKS.pitch, { club: 'Nowhere' }, { ...base, tools: toolsFor([]) }, composer);
  assert.deepEqual(bad, { shown: false, reason: 'No live data for that club, so no XI to draw.' });
  const dup = await runViewTool(REPLY_BLOCKS.pitch, { club: 'Southside' }, base, composer);
  assert.equal(dup.shown, true, 'the same club twice is allowed');

  const second = new ReplyComposer();
  let inFlight: string[] = [];
  const slow = { ...base, tools: { ...toolsFor(['Beta']), clubRecentTeam: async (club: string) => { inFlight = second.blocks().map((b) => (b.kind === 'prose' ? 'prose' : b.status)); return toolsFor(['Beta']).clubRecentTeam(club); } } };
  await runViewTool(REPLY_BLOCKS.pitch, { club: 'Beta' }, slow, second, { pending: true, inline: true });
  assert.deepEqual(inFlight, ['pending']);
  assert.deepEqual(second.blocks().map((b) => (b.kind === 'prose' ? 'prose' : b.status)), ['ready']);
  const failed = new ReplyComposer();
  await runViewTool(REPLY_BLOCKS.pitch, { club: 'Nowhere' }, { ...base, tools: toolsFor([]) }, failed, { pending: true });
  assert.deepEqual(failed.blocks().map((b) => (b.kind === 'prose' ? 'prose' : b.status)), ['failed']);
});


// --- Table, comparison and ranking ------------------------------------------------------------

const standing = (rank: number, team: string, points: number, group: string | null = null): StandingsRow => ({
  rank, team, group, played: 12, won: 8, drawn: 2, lost: 2, goalDiff: 10 - rank, points, form: null,
});
const tableTools = (rows: StandingsRow[] | null, calls: string[] = []): ResearchToolset => ({
  ...toolsFor([]),
  leagueTable: async (league) => {
    calls.push(league);
    if (!rows) return { status: 'not_covered', result: null, missing: [], note: 'no table source' };
    return {
      status: 'found',
      result: { kind: 'league_table', label: `Premier League table, 2026-27`, content: 'text', stage: 'facts', table: { league: 'Premier League', season: '2026-27', rows } },
      missing: [],
    };
  },
});
const PL_ROWS = [standing(1, 'Arsenal', 29), standing(2, 'Chelsea', 26), standing(3, 'Liverpool', 24)];

await test('table: builds the rows from the live feed, marks the clubs, files the lookup and reads back the table', async () => {
  ledger = emptyLedger();
  const calls: string[] = [];
  const out = await REPLY_BLOCKS.table.build({ league: 'Premier League', highlight: ['Arsenal', 'Spurs'] }, ctxFor(tableTools(PL_ROWS, calls)));
  assert.ok('block' in out);
  if (!('block' in out)) return;
  assert.deepEqual(calls, ['Premier League']);
  assert.equal(ledger.lookups.length, 1);
  const { data } = out.block;
  assert.equal(data.league, 'Premier League');
  assert.equal(data.season, '2026-27');
  assert.equal(data.rows.length, 3);
  assert.equal(data.groups, undefined, 'a plain league has no groups');
  assert.deepEqual(data.highlight, ['Arsenal', 'Spurs']);
  const result = REPLY_BLOCKS.table.toolResult(out.block);
  assert.equal(result.shown, true);
  assert.deepEqual(result.notInTheTable, ['Spurs']);
  assert.match(String(result.table), /1\. Arsenal — 29 pts, P12 W8 D2 L2, GD \+9/);
  assert.equal(REPLY_BLOCKS.table.toHistory(out.block), '[shown: Premier League table, 2026-27]');
  assert.match(REPLY_BLOCKS.table.toCopy(out.block), /^Premier League table, 2026-27\n1\. Arsenal/);
  assert.deepEqual(REPLY_BLOCKS.table.hint!({ league: 'Premier League' }), { league: 'Premier League' });
});

await test('table: groups come from the rows, and each failure is a reason the model reads', async () => {
  ledger = emptyLedger();
  const grouped = await REPLY_BLOCKS.table.build({ league: 'Champions League' }, ctxFor(tableTools([standing(1, 'Arsenal', 9, 'Group A'), standing(1, 'Chelsea', 7, 'Group B'), standing(2, 'Spurs', 4, 'Group A')])));
  assert.ok('block' in grouped);
  if ('block' in grouped) assert.deepEqual(grouped.block.data.groups, ['Group A', 'Group B']);
  assert.deepEqual(await REPLY_BLOCKS.table.build({ league: ' ' }, ctxFor(tableTools(PL_ROWS))), { error: 'Missing league' });
  const none = await REPLY_BLOCKS.table.build({ league: 'Nowhere League' }, ctxFor(tableTools(null)));
  assert.ok('error' in none && /No live table for Nowhere League/.test(none.error));
  // Only today's table exists; a past season is refused without a lookup.
  const calls: string[] = [];
  const past = await REPLY_BLOCKS.table.build({ league: 'Premier League', season: '2003-04' }, ctxFor(tableTools(PL_ROWS, calls)));
  assert.ok('error' in past && /No past tables yet/.test(past.error));
  assert.deepEqual(calls, []);
});

const pool = new Map<string, PlayerProfile>();
const withCard = (name: string, overall: number, over: Record<string, unknown> = {}): PlayerProfile => {
  const c = { ...card(name, overall), ...over } as PlayerProfile;
  pool.set(name.toLowerCase(), c);
  return c;
};
const cardsFake = (asked: string[] = []): NonNullable<BuildContext['cards']> => ({
  async lookUp(name, edition): Promise<DossierLookup> {
    asked.push(`${name}${edition ? `:${edition}` : ''}`);
    const hit = [...pool.entries()].find(([k]) => k.includes(name.toLowerCase()) || name.toLowerCase().includes(k.split(' ').pop()!));
    return hit ? { status: 'found', card: hit[1] } : { status: 'missing' };
  },
});
const ctxWithCards = (asked: string[] = []): BuildContext => ({ ...ctxFor(toolsFor([])), cards: cardsFake(asked) });

await test('comparison: two stored cards, never a rating; a missing card is an error naming the player', async () => {
  pool.clear();
  withCard('Florian Wirtz', 86);
  withCard('Jamal Musiala', 88);
  const asked: string[] = [];
  const out = await REPLY_BLOCKS.comparison.build({ playerA: 'Florian Wirtz', playerB: 'Jamal Musiala', edition: 'prime' }, ctxWithCards(asked));
  assert.ok('block' in out);
  if (!('block' in out)) return;
  assert.deepEqual(asked, ['Florian Wirtz:prime', 'Jamal Musiala:prime']);
  assert.equal(out.block.data.a.dossier.overall, 86);
  assert.equal(out.block.data.b.dossier.name, 'Jamal Musiala');
  const result = REPLY_BLOCKS.comparison.toolResult(out.block);
  assert.match(String(result.a), /Florian Wirtz.*Overall 86, Potential 90.*Finishing 80/);
  assert.equal(REPLY_BLOCKS.comparison.toHistory(out.block), '[shown: comparison of Florian Wirtz (Overall 86) and Jamal Musiala (Overall 88)]');
  assert.match(REPLY_BLOCKS.comparison.toCopy(out.block), /Florian Wirtz.*Overall 86/);

  const missing = await REPLY_BLOCKS.comparison.build({ playerA: 'Florian Wirtz', playerB: 'Pedri' }, ctxWithCards());
  assert.ok('error' in missing && /No stored card for Pedri/.test(missing.error) && /offer_rating/.test(missing.error));
  assert.ok('error' in (await REPLY_BLOCKS.comparison.build({ playerA: 'Florian Wirtz', playerB: ' ' }, ctxWithCards())));
  assert.ok('error' in (await REPLY_BLOCKS.comparison.build({ playerA: 'Florian Wirtz', playerB: 'Wirtz' }, ctxWithCards())), 'one card twice');
  const noLookup = await REPLY_BLOCKS.comparison.build({ playerA: 'a', playerB: 'b' }, ctxFor(toolsFor([])));
  assert.ok('error' in noLookup);
  const ambiguous = await REPLY_BLOCKS.comparison.build({ playerA: 'Silva', playerB: 'Wirtz' }, { ...ctxFor(toolsFor([])), cards: { lookUp: async (n) => (n === 'Silva' ? { status: 'ambiguous', names: ['David Silva', 'Bernardo Silva'] } : { status: 'missing' }) } });
  assert.ok('error' in ambiguous && /David Silva, Bernardo Silva/.test(ambiguous.error));
});

await test('comparison: a goalkeeper against an outfielder reads headline numbers only', async () => {
  pool.clear();
  withCard('Gianluigi Donnarumma', 87, { goalkeeperAttributes: { reflexes: 90 }, attributes: undefined });
  withCard('Jamal Musiala', 88);
  const out = await REPLY_BLOCKS.comparison.build({ playerA: 'Gianluigi Donnarumma', playerB: 'Jamal Musiala' }, ctxWithCards());
  assert.ok('block' in out);
  if (!('block' in out)) return;
  const result = REPLY_BLOCKS.comparison.toolResult(out.block);
  assert.match(String(result.note), /don't share a scale/);
  assert.ok(!/Reflexes|Finishing/.test(`${result.a} ${result.b}`));
});

await test('ranking: peak level follows the cards and reports the moves; output keeps the model order', async () => {
  pool.clear();
  withCard('Zinedine Zidane', 94);
  withCard('Ronaldinho', 92);
  withCard('Xavi Hernandez', 90);
  const names = ['Xavi Hernandez', 'Zinedine Zidane', 'Ronaldinho'];
  const peak = await REPLY_BLOCKS.ranking.build({ title: 'Best midfielders', names, criterion: 'peak level' }, ctxWithCards());
  assert.ok('block' in peak);
  if (!('block' in peak)) return;
  assert.deepEqual(peak.block.data.entries.map((e) => e.name), ['Zinedine Zidane', 'Ronaldinho', 'Xavi Hernandez']);
  assert.ok(peak.block.data.moves.length > 0);
  const result = REPLY_BLOCKS.ranking.toolResult(peak.block);
  assert.equal((result.order as string[])[0], '1. Zinedine Zidane (current form), card Overall 94');
  assert.match(String(result.note), /follows the cards/);
  assert.equal(REPLY_BLOCKS.ranking.toHistory(peak.block), '[shown: ranking "Best midfielders" by peak level: Zinedine Zidane, Ronaldinho, Xavi Hernandez]');
  assert.match(REPLY_BLOCKS.ranking.toCopy(peak.block), /^Best midfielders \(peak level\)\n1\. Zinedine Zidane \(94\)/);
  for (const criterion of ['sustained_level', 'mixed']) {
    const out = await REPLY_BLOCKS.ranking.build({ title: 'T', names, criterion }, ctxWithCards());
    assert.ok('block' in out && out.block.data.entries[0].name === 'Zinedine Zidane', criterion);
  }
  const output = await REPLY_BLOCKS.ranking.build({ title: 'Most productive', names, criterion: 'output' }, ctxWithCards());
  assert.ok('block' in output);
  if ('block' in output) {
    assert.deepEqual(output.block.data.entries.map((e) => e.name), names, "the model's order stands");
    assert.deepEqual(output.block.data.moves, []);
    assert.equal(REPLY_BLOCKS.ranking.toolResult(output.block).moves, undefined);
  }
});

await test('ranking: an uncarded player keeps his place, and each failure is a reason', async () => {
  pool.clear();
  withCard('Zinedine Zidane', 94);
  withCard('Xavi Hernandez', 90);
  const out = await REPLY_BLOCKS.ranking.build({ title: 'Order', names: ['Xavi Hernandez', 'Unrated Legend', 'Zinedine Zidane'], criterion: 'peak level' }, ctxWithCards());
  assert.ok('block' in out);
  if (!('block' in out)) return;
  assert.deepEqual(out.block.data.entries.map((e) => e.name), ['Zinedine Zidane', 'Unrated Legend', 'Xavi Hernandez']);
  assert.deepEqual(out.block.data.entries[1], { name: 'Unrated Legend' });
  assert.match(String((REPLY_BLOCKS.ranking.toolResult(out.block).order as string[])[1]), /no card yet/);
  assert.ok('error' in (await REPLY_BLOCKS.ranking.build({ title: 'T', names: ['One'], criterion: 'peak level' }, ctxWithCards())));
  const unknown = await REPLY_BLOCKS.ranking.build({ title: 'T', names: ['A', 'B'], criterion: 'vibes' }, ctxWithCards());
  assert.ok('error' in unknown && /peak level/.test(unknown.error));
  assert.ok('error' in (await REPLY_BLOCKS.ranking.build({ title: ' ', names: ['A', 'B'], criterion: 'output' }, ctxWithCards())));
  const many = Array.from({ length: 20 }, (_, i) => `Player ${i}`);
  const capped = await REPLY_BLOCKS.ranking.build({ title: 'Long', names: [...many, 'player 0'], criterion: 'output' }, ctxWithCards());
  assert.ok('block' in capped && capped.block.data.entries.length === 15, 'fifteen at most, duplicates dropped');
  assert.deepEqual(REPLY_BLOCKS.ranking.hint!({ title: 'Long', names: many, criterion: 'output' }), { title: 'Long', rows: 15 });
});

// --- Segments: the gates run per prose segment and no view moves -------------------------------

await test('the figure gate cuts a sentence from one segment, and every view stays where it was called', () => {
  const composer = new ReplyComposer();
  const evidence = '1. Arsenal — 29 pts, P12 W8 D2 L2, GD +9';
  const gate = (text: string) => gateUnsupportedFigures(text, evidence).text;
  composer.setGate((segments) => gateSegments(segments, gate));
  const one = 'Arsenal lead with 29 points. Their title odds are 71 percent. ';
  const two = 'The chasing pack is close. They keep 55 percent of the ball. ';
  composer.setText(one);
  composer.addView(pitchBlock(composer.newId(), view('Southside')), { inline: true });
  composer.setText(one + two);
  composer.addView(pitchBlock(composer.newId(), view('Northside')), { inline: true });
  composer.setText(`${one}${two}Nothing is settled.`);
  const shown = composer.blocks();
  assert.deepEqual(kinds(shown), ['prose', 'pitch', 'prose', 'pitch', 'prose']);
  assert.equal((shown[0] as { text: string }).text, 'Arsenal lead with 29 points.');
  assert.equal((shown[2] as { text: string }).text, 'The chasing pack is close.');
  assert.equal((shown[4] as { text: string }).text, 'Nothing is settled.');
  assert.equal(composer.displayText(), 'Arsenal lead with 29 points.\n\nThe chasing pack is close.\n\nNothing is settled.');
  assert.deepEqual(shown.filter((b) => b.kind === 'pitch').map((b) => (b as { data: { club: string } }).data.club), ['Southside', 'Northside']);
  // The final gates settle the same segments. One that loses all its prose draws none, and the views stay.
  composer.settle(gateSegments(composer.rawProse(), (t) => gateUnsupportedFigures(t, '').text));
  const done = composer.finish();
  assert.deepEqual(kinds(done), ['pitch', 'prose', 'pitch', 'prose']);
});

await test('segments are gated together under one mark, and a lost mark falls back to gating each on its own', () => {
  assert.deepEqual(splitSegments(joinSegments(['one.', 'two.', 'three.']), 3), ['one.', 'two.', 'three.']);
  assert.deepEqual(splitSegments('whole', 1), ['whole']);
  assert.equal(splitSegments('no marks here', 3), null);
  // A budget of one figure across the reply spans the segments: the later sentence goes.
  const budget = (text: string) => gateUnsupportedFigures(text, '29 pts, 24 pts', [], { budget: { max: 1, slots: [] } }).text;
  assert.deepEqual(gateSegments(['Arsenal have 29 pts.', 'Liverpool have 24 pts.'], budget), ['Arsenal have 29 pts.', '']);
  // A gate that eats the marks: each segment is gated alone.
  assert.deepEqual(gateSegments(['a. 12 goals.', 'b.'], (t) => t.replace(/\n*# ⟦view⟧\n*/g, ' ').replace('12 goals.', '').trim()), ['a.', 'b.']);
});

// --- The tools: one limit, views where the model called them ----------------------------------

await test('view tools: placed where called with a skeleton, settled in place, and MAX_REPLY_VIEWS refuses the next call', async () => {
  pool.clear();
  withCard('Zinedine Zidane', 94);
  withCard('Xavi Hernandez', 90);
  ledger = emptyLedger();
  const composer = new ReplyComposer();
  const tools = createViewTools({
    composer,
    inline: true,
    context: { ...ctxFor(tableTools(PL_ROWS)), cards: cardsFake() },
  });
  assert.deepEqual(tools.declarations.map((d) => d.name), ['show_pitch', 'show_table', 'show_comparison', 'show_ranking']);
  assert.ok(tools.handles('show_table') && !tools.handles('show_dossier'));
  assert.deepEqual(await tools.run('show_nothing', {}), { shown: false, reason: 'Unknown view tool: show_nothing' });

  composer.setText('Here is the table. ');
  const running = tools.run('show_table', { league: 'Premier League', highlight: ['Arsenal'] });
  assert.deepEqual(composer.blocks().map((b) => (b.kind === 'prose' ? 'prose' : b.status)), ['prose', 'pending'], 'a skeleton while it loads');
  assert.equal((await running).shown, true);
  composer.setText('Here is the table. Arsenal lead.');
  assert.deepEqual(kinds(composer.blocks()), ['prose', 'table', 'prose']);

  // Eleven more fit; the same table twice is the model's own choice; the thirteenth is refused.
  for (let i = 0; i < MAX_REPLY_VIEWS - 1; i++) assert.equal((await tools.run('show_table', { league: 'Premier League' })).shown, true);
  const refused = await tools.run('show_table', { league: 'Premier League' });
  assert.deepEqual(refused, { shown: false, reason: 'view limit reached, nothing drawn' });
  assert.equal(composer.blocks().filter((b) => b.kind === 'table').length, MAX_REPLY_VIEWS);
  // A failed view leaves a failed block, which draws nothing and frees no limit it never held.
  const failing = new ReplyComposer();
  const t2 = createViewTools({ composer: failing, inline: false, context: ctxFor(tableTools(null)) });
  const bad = await t2.run('show_table', { league: 'Nowhere League' });
  assert.equal(bad.shown, false);
  failing.setText('x');
  assert.deepEqual(kinds(failing.finish()), ['prose']);
});

await test('view tools: a ranking tool call carries its title and row count to the skeleton', async () => {
  pool.clear();
  withCard('Zinedine Zidane', 94);
  const composer = new ReplyComposer();
  let hinted: unknown;
  const slow: BuildContext['cards'] = { lookUp: async (n) => { hinted = composer.blocks().find((b) => b.kind === 'ranking'); return cardsFake().lookUp(n); } };
  const tools = createViewTools({ composer, inline: false, context: { ...ctxFor(toolsFor([])), cards: slow } });
  await tools.run('show_ranking', { title: 'Best midfielders', names: ['Zinedine Zidane', 'Xavi Hernandez'], criterion: 'output' });
  assert.deepEqual((hinted as { hint?: unknown }).hint, { title: 'Best midfielders', rows: 2 });
  assert.equal((hinted as { status: string }).status, 'pending');
});

await test('a shown card sits where show_dossier was called, and still files with the reply', () => {
  const composer = new ReplyComposer();
  composer.setText('First point. ');
  const wirtz = card('Florian Wirtz');
  composer.showCard(wirtz, { inline: true });
  composer.setText('First point. Second point.');
  assert.deepEqual(kinds(composer.blocks()), ['prose', 'card', 'prose']);
  assert.deepEqual(composer.cards, [wirtz]);
  assert.equal(getCardKey(composer.cards[0]), getCardKey(wirtz));
  composer.showCard(wirtz, { inline: true });
  assert.equal(composer.blocks().filter((b) => b.kind === 'card').length, 1, 'once');
});

await test('a question replaces all the prose, and a settled reply ignores later text', () => {
  const composer = new ReplyComposer();
  composer.setText('Looking. ');
  composer.addView(pitchBlock(composer.newId(), view('Southside')), { inline: true });
  composer.setAsk({ question: 'Which club?', options: ['A', 'B'] });
  composer.replaceProse('Which club?');
  assert.deepEqual(kinds(composer.blocks()), ['prose', 'ask']);
  assert.equal(composer.displayText(), 'Which club?');
});

// --- blocksOf ---------------------------------------------------------------------------------

const ai = (extra: Partial<ChatMessage>): ChatMessage => ({ id: 'm', sender: 'ai', content: 'The reply.', timestamp: 1, ...extra });

await test('blocksOf: a plain legacy reply is its prose', () => {
  assert.deepEqual(kinds(blocksOf(ai({}))), ['prose']);
});

await test('blocksOf: each legacy field becomes its block, in the order the page drew them', () => {
  const ref = toChatDossierRef(card('Florian Wirtz'));
  const message = ai({
    goDeeper: { reason: 'More to read.' },
    ask: { question: 'Which?', options: ['A', 'B'] },
    scoutOffers: ['Pedri'],
    cards: [ref],
    lineups: [view('Southside'), view('Northside')],
    dossier: ref,
    gaffaScorecard: scorecard,
  });
  const blocks = blocksOf(message);
  assert.deepEqual(kinds(blocks), ['scorecard', 'card', 'prose', 'pitch', 'pitch', 'card', 'scoutOffer', 'ask', 'goDeeper']);
  assert.ok(blocks.every((b) => b.kind === 'prose' || b.status === 'ready'));
  assert.equal(new Set(blocks.map((b) => b.id)).size, blocks.length, 'ids are unique');
  assert.deepEqual(readyOf(blocks, 'scoutOffer').map((b) => b.data.name), ['Pedri']);
});

await test('blocksOf: an old dossier notice, an empty reply, a stored profile and an old comparison', () => {
  const notice = ai({ content: 'Dossier generated for **Florian Wirtz**. See the side panel.' });
  assert.deepEqual(kinds(blocksOf(notice)), ['card', 'prose'], 'the card comes from the notice, the notice stays prose');
  assert.deepEqual(kinds(blocksOf(ai({ content: '', dossier: toChatDossierRef(card('Pedri')) }))), ['card']);
  assert.deepEqual(kinds(blocksOf(ai({ content: card('Pedri') as any }))), ['prose']);
  assert.equal((blocksOf(ai({ content: { players: [], summary: 'An old comparison.' } as any }))[0] as { text: string }).text, 'An old comparison.');
  const error = ai({ content: "Editor's Note: I encountered an issue. Timed out.", isError: true });
  assert.equal((blocksOf(error)[0] as { text: string }).text, 'Timed out.');
});

await test('blocksOf: a message with blocks returns them untouched, and a revised card goes ahead of the prose', () => {
  const composer = new ReplyComposer();
  composer.setScorecard(scorecard);
  composer.setText('Revised.');
  const blocks = composer.finish('Revised.');
  const message = ai({ blocks, lineups: [view('Ignored')] });
  assert.equal(blocksOf(message), blocks);
  const revised = withDossierBlock(blocks, toChatDossierRef(card('Pedri')));
  assert.deepEqual(kinds(revised), ['scorecard', 'card', 'prose']);
});

// --- History ----------------------------------------------------------------------------------

await test('history reads a block reply in order, with each view as its stub', () => {
  const composer = new ReplyComposer();
  composer.setText('Before. ');
  composer.addView(pitchBlock(composer.newId(), view('Southside')), { inline: true });
  composer.setText('Before. After.');
  composer.showCard(card('Florian Wirtz'));
  const blocks = composer.finish('Before. After.');
  const history = buildHistoryContents([
    { id: 'u', sender: 'user', content: 'Who plays?', timestamp: 0 },
    ai({ content: 'Before. After.', blocks }),
  ]);
  assert.deepEqual(history.map((c) => c.role), ['user', 'model']);
  assert.deepEqual(
    history[1].parts!.map((p) => p.text),
    ['Before. ', '[shown: first-choice XI, Southside, 4-3-3]', 'After.', '[shown: dossier card, Florian Wirtz (current form), Overall 85]'],
  );
});

await test('history of a legacy reply is unchanged: its content, nothing about its views', () => {
  const history = buildHistoryContents([ai({ content: 'Old reply.', lineups: [view('Southside')], scoutOffers: ['Pedri'] })]);
  assert.deepEqual(history[0].parts!.map((p) => p.text), ['Old reply.']);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
