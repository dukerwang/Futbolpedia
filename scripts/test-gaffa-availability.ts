#!/usr/bin/env npx tsx
/**
 * Offline checks for a Gaffa club's real availability and the reasoning around it: the squad block
 * puts each non-active or unavailable player's FPL status beside his name (one request, cached),
 * says Gaffa's IR is a designation, leaves the block alone when the lookup fails, the bid
 * calculator runs for cost wordings and prices likely free agents for a market question that
 * names none, a long follow-up keeps the thread's focus, and the manager's reasoning block joins
 * every turn about the club. No model calls: the availability route is faked.
 *
 * Usage:
 *   npx tsx scripts/test-gaffa-availability.ts
 */
import assert from 'node:assert/strict';
import type { ChatMessage, GaffaContextBag } from '../types';
import { GAFFA_MANAGER_REASONING } from '../constants/gaffaRules';
import { buildGaffaBidValuationBlock } from '../services/gaffaLineupAudit';
import {
  fetchSquadAvailability,
  resetAvailabilityCache,
  type SquadAvailability,
} from '../services/gaffaAvailability';
import { buildGaffaTurn, formatGaffaClubBlock, leagueFocusOf } from '../services/gaffaTurn';
import type { LiveAvailability } from '../services/liveFootball';

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

const bag: GaffaContextBag = {
  gaffa_rules_version: 'test',
  connected: true,
  club_name: 'Hackney Wanderers',
  league_name: 'Sunday League',
  budget_eur_m: 45,
  settings: { roster_size: 22, free_agent_bid_floor: 0.6 } as GaffaContextBag['settings'],
  roster: [
    { player_id: 'r1', name: 'Emiliano Martínez', primary_position: 'GK', status: 'ir', pl_team: 'Aston Villa' },
    { player_id: 'r2', name: 'Robert Sánchez', primary_position: 'GK', status: 'active', pl_team: 'Chelsea' },
    { player_id: 'r3', name: 'Bukayo Saka', primary_position: 'RW', status: 'active', pl_team: 'Arsenal' },
    { player_id: 'r4', name: 'Lisandro Martínez', primary_position: 'CB', status: 'active', pl_team: 'Manchester United' },
    { player_id: 'r5', name: 'Reserve Forward', primary_position: 'ST', status: 'bench', pl_team: 'Arsenal' },
    { player_id: 'r6', name: 'Hurt Winger', primary_position: 'LW', status: 'active', pl_team: 'Chelsea' },
  ],
  lineup: {
    formation: '4-3-3',
    starters: [
      { slot: 'GK', player_id: 'r2', name: 'Robert Sánchez' },
      { slot: 'RW', player_id: 'r3', name: 'Bukayo Saka' },
    ],
    bench: [],
  } as GaffaContextBag['lineup'],
  free_agents: [
    { player_id: 'f1', name: 'Keeper Alpha', position: 'GK', pl_team: 'Fulham', market_value_eur_m: 12 },
    { player_id: 'f2', name: 'Keeper Beta', position: 'GK', pl_team: 'Wolves', market_value_eur_m: 8 },
    { player_id: 'f3', name: 'Winger Gamma', position: 'LW', pl_team: 'Brentford', market_value_eur_m: 30 },
    { player_id: 'f4', name: 'Striker Delta', position: 'ST', pl_team: 'Leeds', market_value_eur_m: 40 },
    { player_id: 'f5', name: 'Striker Epsilon', position: 'ST', pl_team: 'Burnley', market_value_eur_m: 25 },
    { player_id: 'f6', name: 'Mid Zeta', position: 'CM', pl_team: 'Everton', market_value_eur_m: 20 },
    { player_id: 'f7', name: 'Back Eta', position: 'CB', pl_team: 'Spurs', market_value_eur_m: 15 },
  ],
  open_auctions: [],
  open_listings: [],
};

const fpl = (name: string, status: string, line: string): LiveAvailability => ({
  name,
  fplName: name,
  team: 'X',
  status,
  available: status === 'a',
  line,
});
const DOUBTFUL = 'doubtful: 75% chance of playing in the next Premier League gameweek (Head injury; FPL note dated 2026-10-17)';
const availability: SquadAvailability = new Map([
  ['r1', fpl('Emiliano Martínez', 'd', DOUBTFUL)],
  ['r2', fpl('Robert Sánchez', 'a', 'available: FPL lists no injury or suspension')],
  ['r4', fpl('Lisandro Martínez', 'a', 'available: FPL lists no injury or suspension')],
  ['r5', fpl('Reserve Forward', 'a', 'available: FPL lists no injury or suspension')],
  ['r6', fpl('Hurt Winger', 'i', 'injured: not expected to play in the next Premier League gameweek (Hamstring injury; FPL note dated 2026-11-09)')],
]);

const user = (content: string): ChatMessage => ({ id: content, sender: 'user', content, timestamp: 0 });

// --- The squad block ----------------------------------------------------------------------------

await test('the squad block shows FPL status for non-active players and for anyone FPL lists as out', () => {
  const block = formatGaffaClubBlock(bag, 'market', availability);
  assert.match(block, new RegExp(`Emiliano Martínez \\(GK, Aston Villa, ir; FPL: ${DOUBTFUL.replace(/[()]/g, '\\$&')}\\)`));
  // Active and available: nothing added. Non-active and available: the line says so. Active and out: shown.
  assert.match(block, /Robert Sánchez \(GK, Chelsea\)/);
  assert.match(block, /Lisandro Martínez \(CB, Manchester United\)/);
  assert.match(block, /Reserve Forward \(ST, Arsenal, bench; FPL: available: FPL lists no injury or suspension\)/);
  assert.match(block, /Hurt Winger \(LW, Chelsea; FPL: injured: not expected to play/);
  assert.match(block, /IR, and every other status except active, is a roster designation the manager chose, not a medical fact/);
  assert.match(block, /FPL line beside a player is his real availability/);
});

await test('a failed or empty lookup leaves the block as it was', () => {
  const plain = formatGaffaClubBlock(bag, 'market');
  assert.equal(formatGaffaClubBlock(bag, 'market', null), plain);
  assert.doesNotMatch(plain, /FPL|designation/);
});

// --- One request for the squad -------------------------------------------------------------------

await test('the squad is read in one cached request, resolved by full name and club', async () => {
  resetAvailabilityCache();
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    urls.push(url);
    const names = new URL(url, 'http://local').searchParams.get('names') ?? '';
    const asked = names.split(';').map((e) => e.split('|')[0]);
    return new Response(
      JSON.stringify({ found: true, players: asked.filter((n) => n === 'Emiliano Martínez').map((n) => ({ name: n, fplName: n, team: 'Aston Villa', status: 'd', available: false, line: DOUBTFUL })) }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const first = await fetchSquadAvailability(bag.roster!);
    assert.equal(first?.get('r1')?.line, DOUBTFUL);
    assert.equal(first?.has('r2'), false);
    assert.equal(urls.length, 1, 'one request for six players');
    const names = new URL(urls[0], 'http://local').searchParams.get('names')!;
    assert.match(names, /Emiliano Martínez\|Aston Villa;Robert Sánchez\|Chelsea/);
    await fetchSquadAvailability(bag.roster!);
    assert.equal(urls.length, 1, 'the second turn reuses it');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('a failed read gives null, is not kept, and the turn goes on without it', async () => {
  resetAvailabilityCache();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{}', { status: 502 });
  }) as typeof fetch;
  try {
    assert.equal(await fetchSquadAvailability(bag.roster!), null);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(await fetchSquadAvailability(bag.roster!), null);
    assert.equal(calls, 2, 'a failure is asked again');
    const turn = await buildGaffaTurn({ message: 'Which free agent would most improve my weakest starting slot?', history: [], bag, cards: [], ongoingThread: '' });
    assert.match(turn.block, /Emiliano Martínez \(GK, Aston Villa, ir\)/);
    const thrown = await buildGaffaTurn({
      message: 'Where is my squad weakest?',
      history: [],
      bag,
      cards: [],
      ongoingThread: '',
      fetchAvailability: async () => {
        throw new Error('boom');
      },
    });
    assert.doesNotMatch(thrown.block, /FPL:/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- Turns: availability and the reasoning block --------------------------------------------------

await test('a turn about the club reads availability and gets the manager’s reasoning; one that is not about it gets neither', async () => {
  let fetched = 0;
  const fetchAvailability = async () => {
    fetched++;
    return availability;
  };
  const market = await buildGaffaTurn({ message: 'Which free agent would most improve my weakest starting slot, and what would he cost?', history: [], bag, cards: [], ongoingThread: '', fetchAvailability });
  assert.equal(fetched, 1);
  assert.match(market.block, /FPL: doubtful: 75% chance of playing/);
  assert.match(market.block, /<gaffa_manager_reasoning>[\s\S]*Only one goalkeeper starts[\s\S]*<\/gaffa_manager_reasoning>/);
  assert.match(market.block, /<locked_bid_calculator>/);

  const none = await buildGaffaTurn({ message: 'Compare Pedri and Vitinha', history: [], bag, cards: [], ongoingThread: '', fetchAvailability });
  assert.equal(fetched, 1, 'no read when the question is not about the club');
  assert.doesNotMatch(none.block, /gaffa_manager_reasoning|FPL:/);

  const rules = await buildGaffaTurn({ message: 'How does the auto-sub order work?', history: [], bag, cards: [], ongoingThread: '', fetchAvailability });
  assert.match(rules.block, /<gaffa_manager_reasoning>/);
  assert.equal(fetched, 1, 'a rules question does not read availability');
});

await test('the reasoning block is descriptive: no names, no sample numbers, and it covers each point', () => {
  assert.doesNotMatch(GAFFA_MANAGER_REASONING, /\d/);
  assert.doesNotMatch(GAFFA_MANAGER_REASONING, /\b(Martínez|Saka|Arsenal|Chelsea|Aston Villa)\b/);
  for (const point of [
    /Club Balance are scarce/,
    /Only one goalkeeper starts/,
    /player on IR is a roster designation[\s\S]*real availability/,
    /healthy player on IR blocks bids/,
    /next few gameweeks' points against the long view/,
    /weakest starting slot is the starter who adds the fewest points/,
    /contradicts the manager's own roster constraints/,
    /checked[\s\S]*check it before advising/,
  ]) {
    assert.match(GAFFA_MANAGER_REASONING, point);
  }
});

// --- Bid calculator --------------------------------------------------------------------------------

const priced = (message: string, marketQuestion = false): string[] =>
  [...buildGaffaBidValuationBlock(message, bag, [], { marketQuestion }).matchAll(/FA Target (.+?) \(/g)].map((m) => m[1]);

await test('cost, price, pay and afford wordings run the calculator for a named free agent', () => {
  for (const message of ['what would Keeper Alpha cost?', 'what is the price on Keeper Alpha', 'would I pay much for Keeper Alpha', 'can I afford Keeper Alpha']) {
    assert.deepEqual(priced(message), ['Keeper Alpha'], message);
  }
  assert.deepEqual(priced('tell me about Keeper Alpha'), []);
});

await test('a market question that names no player prices the top free agents at the positions it asks about, four at most', () => {
  // A position named: only those slots, richest first.
  assert.deepEqual(priced('which free agent keeper would help, and what would he cost?', true), ['Keeper Alpha', 'Keeper Beta']);
  assert.deepEqual(priced('which free agent striker or winger would help?', true), ['Striker Delta', 'Winger Gamma', 'Striker Epsilon']);
  // No position and no rated starters: the top four by market value, labelled as such.
  const block = buildGaffaBidValuationBlock('Which free agent would most improve my weakest starting slot, and what would he cost?', bag, [], { marketQuestion: true });
  assert.deepEqual(priced('Which free agent would most improve my weakest starting slot, and what would he cost?', true), ['Striker Delta', 'Winger Gamma', 'Striker Epsilon', 'Mid Zeta']);
  assert.match(block, /names no player, so these are the top unowned players by market value at any position/);
  assert.match(block, /Opening FA floor €24m/);
  // A question that is not about free agents is untouched.
  assert.deepEqual(priced("what's the price to sign a winger worth the money?"), []);
  // A named player wins over the fallback.
  assert.deepEqual(priced('which free agent is better, Keeper Beta or someone else, and what would he cost?', true), ['Keeper Beta']);
});

// --- Follow-up focus ---------------------------------------------------------------------------------

await test('the shared conversation never drops the club from its follow-ups', () => {
  const a = 'Which free agent would most improve my weakest starting slot, and what would he cost?';
  const b = 'well martinez will be back relatively soon, and it makes no sense to have 3 keepers on my roster. why would you suggest that?';
  const c = "shouldn't you know if martinez is back soon rather than taking my word?? you're supposed to be the footblal expert here";
  const d = "?? well why can't you fuckin confirm it yourself, the fuck?";
  assert.equal(leagueFocusOf(a, [], bag), 'market');
  // "my roster" is a squad cue of its own; the follow-ups below carry it forward.
  assert.equal(leagueFocusOf(b, [user(a)], bag), 'squad');
  assert.equal(leagueFocusOf(c, [user(a), user(b)], bag), 'squad', 'a long follow-up naming a roster player by surname, no accent');
  assert.equal(leagueFocusOf(d, [user(a), user(b), user(c)], bag), 'squad');
  // Without the cue in the second message, the market focus is what carries through.
  const quiet = 'well martinez will be back relatively soon, so why would you suggest signing another keeper at all given how little it adds?';
  assert.equal(leagueFocusOf(quiet, [user(a)], bag), 'market');
  assert.equal(leagueFocusOf(c, [user(a), user(quiet)], bag), 'market');
  assert.equal(leagueFocusOf(d, [user(a), user(quiet), user(c)], bag), 'market');
});

await test('a long follow-up with no other subject keeps the focus; one about something else does not', () => {
  const lineup = [user('Who should I start this week?')];
  const long = 'I do not really follow your reasoning there, so could you walk me through it step by step and be a bit more careful this time please';
  assert.equal(leagueFocusOf(long, lineup, bag), 'lineup');
  const other = 'Separately from all of that, I have been wondering how Pedri compares with Vitinha as a deep playmaker over a full season now';
  assert.equal(leagueFocusOf(other, lineup, bag), 'none');
  // The same long message, with a roster player named by surname, stays on the club.
  assert.equal(leagueFocusOf(`${other} and also how Saka fits in`, lineup, bag), 'lineup');
  // With no thread behind it, nothing is kept.
  assert.equal(leagueFocusOf(long, [], bag), 'none');
  assert.equal(leagueFocusOf('Who should I start?', [], { ...bag, connected: false }), 'none');
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
