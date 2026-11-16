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
import { ReplyComposer, REPLY_BLOCKS, blocksOf, copyTextOf, readyOf, runViewTool, viewToolDeclarations, withDossierBlock } from '../services/replyBlocks';
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

await test('only the pitch has a tool here, and deep mode reads it from the registry', () => {
  assert.deepEqual(viewToolDeclarations().map((d) => d.name), ['show_pitch']);
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
  const shown = [pitchBlock('p1', view('Southside'))];
  const again = await REPLY_BLOCKS.pitch.build({ club: 'Southside FC' }, ctxFor(toolsFor(['Southside']), () => shown));
  assert.deepEqual(again, { unchanged: { shown: true, note: 'Already shown.' } });
  const two = [pitchBlock('p1', view('Alpha')), pitchBlock('p2', view('Beta'))];
  const over = await REPLY_BLOCKS.pitch.build({ club: 'Southside' }, ctxFor(toolsFor(['Southside']), () => two));
  assert.deepEqual(over, { error: 'At most 2 XIs per reply.' });
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
  composer.setLineups([view('Southside')]);
  composer.showCard(card('Florian Wirtz'));
  composer.offerScout('Pedri');
  composer.setGoDeeper({ reason: 'x' });
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
  composer.setGoDeeper({ reason: 'More to read.' });
  composer.offerScout('Pedri');
  composer.showCard(card('Florian Wirtz'));
  composer.setLineups([view('Southside')]);
  composer.setScorecard(scorecard);
  composer.setText('The reply.');
  assert.deepEqual(kinds(composer.finish('The reply.')), ['scorecard', 'prose', 'pitch', 'card', 'scoutOffer', 'goDeeper']);
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

await test('a question is the whole reply: it drops cards, XIs and the Go deeper flag, and keeps offers', () => {
  const composer = new ReplyComposer();
  composer.offerScout('Pedri');
  composer.showCard(card('Florian Wirtz'));
  composer.setLineups([view('Southside')]);
  composer.setGoDeeper({ reason: 'x' });
  composer.addView(pitchBlock(composer.newId(), view('Beta')), { inline: true });
  composer.setAsk({ question: 'Which season?', options: ['This one', 'Last one'] });
  assert.deepEqual(kinds(composer.blocks()), ['scoutOffer', 'ask']);
  composer.setGoDeeper({ reason: 'later' });
  assert.equal(composer.goDeeper?.reason, 'later', 'the writer, not the composer, stops a flag after a question');
});

await test('snapshot and restore drop what a failed attempt added, text included', () => {
  const composer = new ReplyComposer();
  composer.offerScout('Pedri');
  composer.setText('Earlier.');
  const saved = composer.snapshot();
  composer.showCard(card('Florian Wirtz'));
  composer.setLineups([view('Southside')]);
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
  assert.deepEqual(dup, { shown: true, note: 'Already shown.' });

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
  composer.setGoDeeper({ reason: 'x' });
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
