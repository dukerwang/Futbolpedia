#!/usr/bin/env npx tsx
/**
 * Offline checks for Connect with Gaffa and a Gaffa club attached to native chat: the server's
 * grant forwarding, the browser's PKCE and return handling, Gaffa's club links, the turn's league
 * focus and blocks, and a chat turn end to end with Gemini and Gaffa faked at fetch (no network,
 * Supabase or API keys).
 *
 * Usage:
 *   npx tsx scripts/test-gaffa-connect.ts
 */
import assert from 'node:assert/strict';
import type { ChatMessage, GaffaContextBag } from '../types';

process.env.API_KEY = 'offline-test-key';

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

// A browser just big enough for the grant client: storage, events and a location.
const store = new Map<string, string>();
const listeners = new Map<string, Set<(e: any) => void>>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as any).window = {
  location: { origin: 'http://localhost:3000' },
  addEventListener: (t: string, fn: (e: any) => void) => {
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t)!.add(fn);
  },
  removeEventListener: (t: string, fn: (e: any) => void) => listeners.get(t)?.delete(fn),
  dispatchEvent: (e: { type: string }) => {
    listeners.get(e.type)?.forEach((fn) => fn(e));
    return true;
  },
};

const bag: GaffaContextBag = {
  gaffa_rules_version: 'test',
  connected: true,
  league_id: '11111111-1111-4111-8111-111111111111',
  club_id: '22222222-2222-4222-8222-222222222222',
  league_name: 'Sunday League',
  club_name: 'Hackney Wanderers',
  budget_eur_m: 45,
  standings: { rank: 3, of_teams: 10, wins: 6, draws: 2, losses: 3, points_for: 812 },
  matchup: { gameweek: 12, opponent_club_name: 'Bow Rovers', status: 'scheduled' },
  roster: [
    { player_id: 'p1', name: 'Bukayo Saka', primary_position: 'RW', status: 'active', pl_team: 'Arsenal' },
    { player_id: 'p2', name: 'Declan Rice', primary_position: 'DM', secondary_positions: ['CM'], status: 'active', pl_team: 'Arsenal' },
    { player_id: 'p3', name: 'Mamadou Sarr', primary_position: 'CB', status: 'active', pl_team: 'Chelsea' },
    { player_id: 'p4', name: 'Bench Keeper', primary_position: 'GK', status: 'active', pl_team: 'Fulham' },
  ],
  lineup: {
    formation: '4-3-3',
    gameweek: 12,
    starters: [
      { player_id: 'p1', name: 'Bukayo Saka', slot: 'RW' },
      { player_id: 'p2', name: 'Declan Rice', slot: 'DM' },
      { player_id: 'p3', name: 'Mamadou Sarr', slot: 'CB' },
    ],
    bench: [{ player_id: 'p4', name: 'Bench Keeper', slot: 'GK' }],
  },
  open_listings: [],
  open_auctions: [],
  free_agents: [{ player_id: 'f1', name: 'Free Winger', position: 'LW', pl_team: 'Brentford', market_value_eur_m: 12, age: 20 }],
  synced_at: '2026-11-13T10:00:00Z',
};

// --- Server: grant forwarding ---------------------------------------------------------------

const proxy = await import('../services/gaffaGrantProxy');
const TOKEN = `fpg_${'a'.repeat(43)}`;

await test('the server forwards only a grant token, never the shared secret', async () => {
  process.env.FUTBOLPEDIA_READ_SECRET = 'shared-secret';
  assert.equal(proxy.grantAuthorization(`Bearer ${TOKEN}`), `Bearer ${TOKEN}`);
  assert.equal(proxy.grantAuthorization('Bearer something-else'), null);
  assert.equal(proxy.grantAuthorization(undefined), null);
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fake = async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(JSON.stringify({ clubs: [] }), { status: 200 });
  };
  const out = await proxy.listGaffaClubs(`Bearer ${TOKEN}`, 'https://gaffa.test', fake);
  assert.equal(out.status, 200);
  assert.equal(seen[0].url, 'https://gaffa.test/api/integrations/futbolpedia/clubs');
  assert.equal(seen[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(seen).includes('shared-secret'));
  assert.equal((await proxy.listGaffaClubs(null, 'https://gaffa.test', fake)).status, 401);
  assert.equal(seen.length, 1, 'no call without a token');
});

await test('context reads check the ids, and Gaffa failing reads as a bad gateway', async () => {
  const fake = async () => new Response('{"error":"boom"}', { status: 500 });
  assert.equal((await proxy.readGaffaClubContext(`Bearer ${TOKEN}`, 'nope', bag.club_id, 'https://gaffa.test', fake)).status, 400);
  assert.equal((await proxy.readGaffaClubContext(`Bearer ${TOKEN}`, bag.league_id, bag.club_id, 'https://gaffa.test', fake)).status, 502);
  const forbidden = async () => new Response('{"error":"Not your club"}', { status: 403 });
  const out = await proxy.readGaffaClubContext(`Bearer ${TOKEN}`, bag.league_id, bag.club_id, 'https://gaffa.test', forbidden);
  assert.equal(out.status, 403);
  assert.deepEqual(out.body, { error: 'Not your club' });
});

await test('the code exchange posts code, verifier and origin to Gaffa', async () => {
  let posted: any = null;
  const fake = async (url: string, init?: RequestInit) => {
    posted = { url, body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ access_token: TOKEN, token_type: 'bearer' }), { status: 200 });
  };
  const out = await proxy.exchangeGaffaCode({ code: 'c1', code_verifier: 'v'.repeat(43), return_origin: 'http://localhost:3000' }, 'https://gaffa.test', fake);
  assert.equal(out.status, 200);
  assert.equal(posted.url, 'https://gaffa.test/api/integrations/futbolpedia/token');
  assert.deepEqual(posted.body, { code: 'c1', code_verifier: 'v'.repeat(43), return_origin: 'http://localhost:3000' });
  assert.equal((await proxy.exchangeGaffaCode({ code: 'c1' }, 'https://gaffa.test', fake)).status, 400);
});

// --- Browser: PKCE, the return route and the grant -------------------------------------------

const connect = await import('../services/gaffaConnect');
const { parseGaffaClubHash } = await import('../services/gaffaContext');

await test('the PKCE challenge matches RFC 7636’s example', async () => {
  assert.equal(
    await connect.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

await test('the return route is read, and only the attempt this browser started is finished', async () => {
  assert.deepEqual(connect.parseConnectedHash('#/gaffa/connected?code=abc&state=s1'), { code: 'abc', error: undefined, state: 's1' });
  assert.deepEqual(connect.parseConnectedHash('#/gaffa/connected?error=access_denied&state=s1'), { code: undefined, error: 'access_denied', state: 's1' });
  assert.equal(connect.parseConnectedHash('#/gaffa/connected?code=abc'), null);

  const realFetch = globalThis.fetch;
  const posted: any[] = [];
  globalThis.fetch = (async (_url: any, init?: any) => {
    posted.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ access_token: TOKEN }), { status: 200 });
  }) as typeof fetch;
  try {
    store.set('futbolpedia-gaffa-pending', JSON.stringify({ state: 'mine', verifier: 'v'.repeat(43), createdAt: Date.now() }));
    await assert.rejects(connect.completeGaffaConnect({ code: 'abc', state: 'someone-elses' }), /started elsewhere/);
    assert.equal(posted.length, 0);

    let heard: string | null = null;
    const stop = connect.onGrantChange((t) => (heard = t));
    assert.equal(await connect.completeGaffaConnect({ code: 'abc', state: 'mine' }), 'connected');
    stop();
    assert.equal(connect.loadGrant(), TOKEN);
    assert.equal(heard, TOKEN);
    assert.deepEqual(posted[0], { code: 'abc', code_verifier: 'v'.repeat(43), return_origin: 'http://localhost:3000' });
    assert.equal(store.has('futbolpedia-gaffa-pending'), false, 'the attempt is used up');

    store.set('futbolpedia-gaffa-pending', JSON.stringify({ state: 'again', verifier: 'v'.repeat(43), createdAt: Date.now() }));
    assert.equal(await connect.completeGaffaConnect({ error: 'access_denied', state: 'again' }), 'cancelled');
    assert.equal(posted.length, 1, 'a cancel exchanges nothing');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('a refused grant is forgotten', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"error":"Not connected"}', { status: 401 })) as typeof fetch;
  try {
    store.set('futbolpedia-gaffa-grant', TOKEN);
    await assert.rejects(connect.listMyGaffaClubs(), connect.GaffaNotConnectedError);
    assert.equal(connect.loadGrant(), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('Gaffa’s club links carry a club and an optional question', () => {
  assert.deepEqual(parseGaffaClubHash(`#/gaffa/${bag.league_id}/${bag.club_id}`), { leagueId: bag.league_id, clubId: bag.club_id });
  assert.deepEqual(parseGaffaClubHash(`#/gaffa/${bag.league_id}/${bag.club_id}?q=${encodeURIComponent('How is Saka doing?')}`), {
    leagueId: bag.league_id,
    clubId: bag.club_id,
    question: 'How is Saka doing?',
  });
  assert.equal(parseGaffaClubHash('#/gaffa/connected?code=a&state=b'), null);
  assert.equal(parseGaffaClubHash('#/gaffa/not-a-uuid/also-not'), null);
});

// --- The turn: league focus and blocks ----------------------------------------------------------

const turn = await import('../services/gaffaTurn');
const user = (content: string): ChatMessage => ({ id: content, sender: 'user', content, timestamp: 0 });

await test('a question’s league focus follows what it asks about the club', () => {
  const focus = (m: string, h: ChatMessage[] = []) => turn.leagueFocusOf(m, h, bag);
  assert.equal(focus('Who should I start this week?'), 'lineup');
  assert.equal(focus('Should I trade Saka for Free Winger and €10m?'), 'trade');
  assert.equal(focus('Which free agents are worth a bid?'), 'market');
  assert.equal(focus('How does the auto-sub order work?'), 'rules');
  assert.equal(focus('Where is my squad weakest?'), 'squad');
  assert.equal(focus('How is Declan Rice playing this season?'), 'squad', 'a squad player named');
  assert.equal(focus('Compare Pedri and Vitinha as deep playmakers'), 'none');
  assert.equal(focus('What about his backup?', [user('Who should I start this week?')]), 'lineup', 'a short follow-up keeps the focus');
  assert.equal(turn.leagueFocusOf('Who should I start?', [], { ...bag, connected: false }), 'none');
});

await test('every turn names the club; the focus decides the locked blocks', async () => {
  const build = (message: string) => turn.buildGaffaTurn({ message, history: [], bag, cards: [], ongoingThread: '' });
  const general = await build('Compare Pedri and Vitinha');
  assert.match(general.block, /<gaffa_club>[\s\S]*Hackney Wanderers in Sunday League/);
  assert.match(general.block, /may not be about their Gaffa club/);
  assert.match(general.block, /Club Balance: €45m\./);
  assert.match(general.block, /Bukayo Saka \(RW, Arsenal\)/);
  assert.doesNotMatch(general.block, /<gaffa_rules>|<locked_market>/);
  assert.deepEqual(general.squadClubs, []);

  const lineup = await build('Who should I start this week?');
  assert.match(lineup.block, /<gaffa_rules>/);
  assert.match(lineup.block, /Answer for this club/);
  assert.deepEqual(lineup.squadClubs, ['Arsenal', 'Chelsea']);

  const market = await build('Which free agents are worth a bid?');
  assert.match(market.block, /<locked_market>[\s\S]*Free Winger/);
  assert.equal(market.scorecard, null);
});

// --- A chat turn end to end -------------------------------------------------------------------

const prompts: string[] = [];
const realFetch = globalThis.fetch;
const respond = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.startsWith('/api/')) return new Response('{}', { status: 404 });
  if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
  const body = JSON.parse(init?.body ?? '{}');
  const raw = JSON.stringify(body);
  const prompt = JSON.stringify([body.contents ?? '', body.systemInstruction ?? '']);
  const structured = raw.includes('responseSchema') || raw.includes('responseJsonSchema');
  prompts.push(prompt);
  if (prompt.includes('first-team head coach')) return respond('COACH: UNKNOWN | SINCE: UNKNOWN | PREVIOUS: UNKNOWN | SOURCE_DATE: UNKNOWN');
  if (structured && prompt.includes('Classify')) {
    return respond(JSON.stringify({ intent: 'tactical_chat', analyticalMode: 'squad_or_recruitment', targetPlayers: [], targetClubs: [], searchQueries: [], reasoningComplexity: 'low', isHistorical: false, wantsRegeneration: false, needsSearch: false }));
  }
  if (structured && prompt.includes('You are planning the research')) {
    return respond(JSON.stringify({ understanding: 'Who to start', focus: 'Fitness', timeframe: 'live', outline: ['XI'], calls: [{ tool: 'web_search', subject: 'Arsenal team news', purpose: 'availability', stage: 'facts' }] }));
  }
  if (structured) return respond('{}');
  if (raw.includes('googleSearch') && !raw.includes('functionDeclarations')) return respond('[2026-11-10] Nothing new.');
  return respond('Start Mahamadou Sarr at centre-back and keep your €45m Club Balance for the window. Saka has 9 goals.');
}) as typeof fetch;

const { sendMessageToAI } = await import('../services/geminiService');
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { log, info, warn } = console;
  console.log = console.info = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, info, warn });
  }
};

await test('an attached club reaches the writer, and its names and figures survive the gates', async () => {
  const reply = await quietly(() => sendMessageToAI('Who should I start this week?', [], undefined, [], [], { gaffaBag: bag }));
  const writer = prompts.filter((p) => p.includes('<task>')).at(-1) ?? '';
  assert.match(writer, /<gaffa_club>[\s\S]*Hackney Wanderers/);
  assert.match(writer, /<gaffa_rules>/);
  // The squad's name is copied exactly; the balance stays because the club block gives it, and a
  // figure nothing gave goes with its sentence.
  assert.equal(reply, 'Start Mamadou Sarr at centre-back and keep your €45m Club Balance for the window.');
});

await test('without a club, chat is unchanged', async () => {
  prompts.length = 0;
  await quietly(() => sendMessageToAI('Who should I start this week?', [], undefined, [], []));
  const writer = prompts.filter((p) => p.includes('<task>')).at(-1) ?? '';
  assert.ok(writer, 'the writer ran');
  assert.doesNotMatch(writer, /<gaffa_club>/);
});

globalThis.fetch = realFetch;
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
