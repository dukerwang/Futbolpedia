#!/usr/bin/env npx tsx
/**
 * Offline checks for the knowledge base's identity layer (`services/kb/`) and the chat loop's
 * `who_is`. Wikidata is faked at the injected fetch with responses recorded from it on 2026-11-27
 * (`scripts/fixtures/kb/`); the store's tables, the clock and the chat model are faked. No network,
 * Supabase or API keys.
 *
 * Usage:
 *   npx tsx scripts/test-kb-identity.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KB_USER_AGENT,
  chooseEntity,
  currentClubOf,
  parseHint,
  resolveIdentity,
  type KbEntity,
  type KbGetJson,
  type KbResolution,
  type KbSpell,
} from '../services/kb/identity';
import { KB_CONCURRENCY, KB_NOT_FOUND_MS, KB_REFRESH_MS, createKbStore, supabaseKbDb, type KbDb, type KbEntityRow, type KbLookupRow } from '../services/kb/store';
import { whoIsHandler } from '../services/kb/route';
import { createProxyLimiter } from '../services/geminiProxy';
import { liveToolset, type LiveGet, type ResearchToolset } from '../services/researchTools';
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

// Nothing here may reach the network.
globalThis.fetch = (async () => new Response('offline test', { status: 400 })) as typeof fetch;

// --- Recorded Wikidata ------------------------------------------------------------------------

interface Recording {
  search: any;
  sparql: any;
}
const recording = (file: string): Recording => JSON.parse(readFileSync(new URL(`./fixtures/kb/${file}.json`, import.meta.url), 'utf8'));
const nuno = recording('nuno-mendes');
const psg = recording('psg');
const YOUNG = 'Q96396963';
const OLD = 'Q3346419';
const NOW = Date.parse('2026-11-27T12:00:00Z');

/** Wikidata playing back one recording, with every request kept. */
function fakeWikidata(answer: Recording) {
  const requests: { url: URL; headers: Record<string, string>; timeoutMs: number }[] = [];
  const state = { down: false };
  const getJson: KbGetJson = async (url, { headers, timeoutMs }) => {
    requests.push({ url: new URL(url), headers, timeoutMs });
    if (state.down) throw new Error('timeout of 7000ms exceeded');
    return url.includes('wbsearchentities') ? answer.search : answer.sparql;
  };
  return { getJson, requests, state };
}

const resolve = (name: string, hint: string, answer = nuno) => resolveIdentity(name, parseHint(hint), { getJson: fakeWikidata(answer).getJson, now: () => NOW });
const resolved = (r: KbResolution): KbEntity => {
  assert.equal(r.status, 'resolved', JSON.stringify(r).slice(0, 300));
  return (r as Extract<KbResolution, { status: 'resolved' }>).entity;
};
const candidates = (r: KbResolution): KbEntity[] => {
  assert.equal(r.status, 'ambiguous', JSON.stringify(r).slice(0, 300));
  return (r as Extract<KbResolution, { status: 'ambiguous' }>).candidates;
};

// --- The resolver -----------------------------------------------------------------------------

await test('a name two players share returns both and picks neither, however well known one is', async () => {
  const found = candidates(await resolve('Nuno Mendes', ''));
  assert.deepEqual(found.map((c) => [c.id, c.birthDate]), [[YOUNG, '2002-06-19'], [OLD, '1978-04-07']]);
});

await test('a club hint picks the player who was there, by any name Wikidata gives the club', async () => {
  for (const hint of ['PSG', 'Paris Saint-Germain', 'sporting cp', 'PSG, born 2002']) {
    assert.equal(resolved(await resolve('Nuno Mendes', hint)).id, YOUNG, hint);
  }
});

await test('a birth year or the years in question pick the player too', async () => {
  assert.equal(resolved(await resolve('Nuno Mendes', 'born 1978')).id, OLD);
  assert.equal(resolved(await resolve('Nuno Mendes', '1978')).id, OLD);
  assert.equal(resolved(await resolve('Nuno Mendes', '2007-09')).id, OLD);
  assert.equal(resolved(await resolve('Nuno Mendes', '2020s')).id, YOUNG);
});

await test('a hint nobody fits, or both fit, settles nothing', async () => {
  const none = await resolve('Nuno Mendes', 'Chelsea');
  assert.equal(candidates(none).length, 2);
  assert.match((none as any).reason, /no candidate fits the hint/);
  assert.equal(candidates(await resolve('Nuno Mendes', 'Portugal')).length, 2);
});

await test('the identity carries what the knowledge base joins on, and no statistics', async () => {
  const p = resolved(await resolve('Nuno Mendes', 'PSG'));
  assert.equal(p.kind, 'player');
  assert.equal(p.label, 'Nuno Mendes');
  assert.ok(p.aliases.includes('Nuno Alexandre Tavares Mendes'));
  assert.deepEqual(p.nationality, ['Portugal']);
  assert.deepEqual(p.positions, ['full-back']);
  assert.equal(p.currentClub, 'Paris Saint-Germain FC');
  assert.equal(p.wikipediaTitle, 'Nuno Mendes (footballer, born 2002)');
  assert.deepEqual(p.externalIds, { espn: '290591', transfermarkt: '616341', fbref: 'f20e4cc9', sofascore: '989768', uefa: '250136465' });
  assert.deepEqual(p.spells.map((s) => [s.club, s.start, s.end, Boolean(s.loan)]), [
    ['Sporting CP', 2020, 2022, false],
    ['Paris Saint-Germain FC', 2021, 2022, true],
    ['Paris Saint-Germain FC', 2022, null, false],
  ]);
  assert.ok(!p.spells.some((s) => /national/i.test(s.club)), 'national teams are not clubs');
  assert.equal(p.fetchedAt, new Date(NOW).toISOString());
  assert.deepEqual(Object.keys(p).sort(), ['aliases', 'birthDate', 'currentClub', 'externalIds', 'fetchedAt', 'id', 'kind', 'label', 'nationality', 'positions', 'spells', 'wikipediaTitle'].sort());
});

await test('a club resolves from its short name', async () => {
  const club = resolved(await resolve('PSG', '', psg));
  assert.deepEqual([club.id, club.kind, club.label, club.wikipediaTitle], ['Q483020', 'club', 'Paris Saint-Germain FC', 'Paris Saint-Germain FC']);
  assert.deepEqual(club.nationality, ['France']);
  assert.deepEqual([club.birthDate, club.spells, club.externalIds], [null, [], {}]);
});

await test('a resolution is one search and one query, named, timed, with only item IDs in the query', async () => {
  const wikidata = fakeWikidata(nuno);
  const name = 'Nuno Mendes" } ?x ?y ?z . {';
  await resolveIdentity(name, parseHint(''), { getJson: wikidata.getJson, now: () => NOW });
  assert.equal(wikidata.requests.length, 2);
  const [search, query] = wikidata.requests;
  assert.equal(search.url.origin + search.url.pathname, 'https://www.wikidata.org/w/api.php');
  assert.equal(search.url.searchParams.get('action'), 'wbsearchentities');
  assert.equal(search.url.searchParams.get('search'), name);
  assert.equal(query.url.origin + query.url.pathname, 'https://query.wikidata.org/sparql');
  const sparql = query.url.searchParams.get('query')!;
  assert.ok(!sparql.includes('Nuno'), 'the typed name never enters the query');
  assert.match(sparql, /VALUES \?item \{ wd:Q96396963 wd:Q3346419( wd:Q\d+)* \}/);
  assert.match(sparql, /wdt:P106 wd:Q937857/);
  assert.match(sparql, /wdt:P31\/wdt:P279\* wd:Q476028/);
  assert.doesNotMatch(sparql, /P1350|P1351/, 'appearance and goal counts are never read');
  for (const r of wikidata.requests) {
    assert.equal(r.headers['User-Agent'], KB_USER_AGENT);
    assert.ok(r.timeoutMs > 0 && r.timeoutMs <= 15_000);
  }
  assert.ok(readFileSync(new URL('../server.ts', import.meta.url), 'utf8').includes(`"User-Agent": "${KB_USER_AGENT}"`), 'the agent the server sends Wikipedia');
});

await test('a failing or odd source is a failed lookup, and an empty search asks no query', async () => {
  const down = fakeWikidata(nuno);
  down.state.down = true;
  assert.equal((await resolveIdentity('Nuno Mendes', parseHint(''), { getJson: down.getJson })).status, 'failed');
  const nothing = fakeWikidata({ search: { search: [] }, sparql: {} });
  assert.equal((await resolveIdentity('Nobody At All', parseHint(''), { getJson: nothing.getJson })).status, 'not_found');
  assert.equal(nothing.requests.length, 1);
  assert.equal((await resolve('Nuno Mendes', '', { search: nuno.search, sparql: { error: 'x' } })).status, 'failed');
  assert.equal((await resolve('Nuno Mendes', '', { search: {}, sparql: {} })).status, 'failed');
  assert.equal((await resolve('Nuno Mendes', '', { search: nuno.search, sparql: { results: { bindings: [] } } })).status, 'not_found');
});

const made = (id: string, label: string, extra: Partial<KbEntity> = {}) => ({
  sitelinks: 1,
  entity: { id, kind: 'player', label, aliases: [], birthDate: null, nationality: [], positions: [], currentClub: null, spells: [], wikipediaTitle: null, externalIds: {}, fetchedAt: '', ...extra } as KbEntity,
});
const choose = (query: string, found: ReturnType<typeof made>[], hint = '', truncated = false) =>
  chooseEntity(query, found, parseHint(hint), new Map(), { truncated, thisYear: 2026 });

await test('accents and case do not matter', () => {
  assert.equal(resolved(choose('martin odegaard', [made('Q1', 'Martin Ødegaard')])).id, 'Q1');
});

await test('an exact name beats a longer one that only contains it, and two exact names beat nobody', () => {
  assert.equal(resolved(choose('Sam Reed', [made('Q1', 'Sam Reed'), made('Q2', 'Sam John Reed')])).id, 'Q1');
  assert.equal(candidates(choose('Sam Reed', [made('Q1', 'Sam Reed'), made('Q2', 'Samuel Reed', { aliases: ['Sam Reed'] })])).length, 2);
});

await test('one word that is only an alias or part of a name never settles a player on its own', () => {
  const only = made('Q1', 'Carl Vance', { aliases: ['Vance'] });
  assert.equal(candidates(choose('Vance', [only])).length, 1);
  assert.equal(candidates(choose('Vance', [made('Q1', 'Carl Vance')])).length, 1);
  assert.equal(resolved(choose('Vance', [made('Q1', 'Vance')])).id, 'Q1', 'a one-word name that is the label');
  assert.equal(resolved(choose('Vance', [made('Q1', 'Carl Vance', { aliases: ['Vance'], birthDate: '1990-01-01' })], 'born 1990')).id, 'Q1');
  assert.equal(resolved(choose('VFC', [made('Q2', 'Vance Football Club', { kind: 'club', aliases: ['VFC'] })])).id, 'Q2', 'clubs go by short names');
});

await test('a hint the only candidate does not fit, a loose match or a cut-off search settles nothing', () => {
  assert.equal(candidates(choose('Sam Reed', [made('Q1', 'Sam Reed', { birthDate: '1990-01-01' })], 'born 1991')).length, 1);
  assert.equal(candidates(choose('Sam Reed', [made('Q1', 'Samson Reedman')])).length, 1);
  assert.equal(candidates(choose('Sam Reed', [made('Q1', 'Sam John Reed')], '', true)).length, 1);
  assert.equal(resolved(choose('Sam Reed', [made('Q1', 'Sam John Reed')])).id, 'Q1');
});

await test('a hint is read as clubs or countries, a birth year, or the years in question', () => {
  assert.deepEqual(parseHint('born 1978'), { terms: [], birthYear: 1978, era: null });
  assert.deepEqual(parseHint('played for Santos in the 1960s'), { terms: ['Santos'], birthYear: null, era: { from: 1960, to: 1969 } });
  assert.deepEqual(parseHint('Brighton and Hove Albion, 2019-21').era, { from: 2019, to: 2021 });
  assert.deepEqual(parseHint('1999/00').era, { from: 1999, to: 2000 });
  assert.deepEqual(parseHint('Schalke 04').terms, ['Schalke 04']);
  assert.deepEqual(parseHint(''), { terms: [], birthYear: null, era: null });
});

await test('a current club comes only from a spell that can still be open', () => {
  const spell = (club: string, start: number | null, end: number | null, loan = false): KbSpell => ({ teamId: club, club, start, end, ...(loan ? { loan } : {}) });
  const facts = { birthYear: 2000, dead: false, thisYear: 2026 };
  assert.equal(currentClubOf([spell('A', 2019, 2022), spell('B', 2022, null)], facts), 'B');
  assert.equal(currentClubOf([spell('Parent', 2022, null), spell('Loan', 2024, null, true)], facts), 'Loan');
  assert.equal(currentClubOf([spell('Parent', 2022, null), spell('Loan', 2024, 2025, true)], facts), 'Parent');
  assert.equal(currentClubOf([spell('Never closed', 2018, null), spell('Later', 2020, 2023)], facts), null);
  assert.equal(currentClubOf([spell('Unknown years', null, null)], facts), null);
  assert.equal(currentClubOf([spell('B', 2022, null)], { ...facts, dead: true }), null);
  assert.equal(currentClubOf([spell('B', 1980, null)], { ...facts, birthYear: 1960 }), null);
});

// --- The store --------------------------------------------------------------------------------

function memoryDb() {
  const entities = new Map<string, KbEntityRow>();
  const lookups = new Map<string, KbLookupRow>();
  const writes: string[] = [];
  const db: KbDb = {
    readLookup: async (key) => lookups.get(key) ?? null,
    readEntities: async (ids) => ids.flatMap((id) => (entities.has(id) ? [entities.get(id)!] : [])),
    writeEntities: async (rows) => rows.forEach((r) => (writes.push(`entity ${r.wikidata_id}`), entities.set(r.wikidata_id, r))),
    writeLookup: async (row) => void (writes.push(`lookup ${row.lookup_key}`), lookups.set(row.lookup_key, row)),
  };
  return { db, entities, lookups, writes };
}

const quiet = () => {};

await test('the store answers a repeat itself, whatever order the hint is written in', async () => {
  const wikidata = fakeWikidata(nuno);
  const store = createKbStore({ getJson: wikidata.getJson, db: null, now: () => NOW });
  const first = await store.whoIs('Nuno Mendes', 'PSG, born 2002');
  assert.equal(first.source, 'wikidata');
  const again = await store.whoIs('  nuno MENDES ', 'born 2002, psg');
  assert.equal(again.source, 'store');
  assert.deepEqual(again.result, first.result);
  assert.equal(wikidata.requests.length, 2);
});

await test('a stored player never settles the name asked without the hint that found him', async () => {
  const wikidata = fakeWikidata(nuno);
  const { db } = memoryDb();
  const store = createKbStore({ getJson: wikidata.getJson, db, now: () => NOW });
  await store.whoIs('Nuno Mendes', 'PSG');
  const bare = await store.whoIs('Nuno Mendes');
  assert.equal(bare.source, 'wikidata');
  assert.equal(candidates(bare.result).length, 2);
});

await test('rows go to the tables, and another server process answers from them without asking Wikidata', async () => {
  const { db, entities, writes } = memoryDb();
  const first = fakeWikidata(nuno);
  const written = await createKbStore({ getJson: first.getJson, db, now: () => NOW }).whoIs('Nuno Mendes', 'PSG');
  assert.deepEqual(writes, [`entity ${YOUNG}`, 'lookup nuno mendes#psg||']);
  const row = entities.get(YOUNG)!;
  assert.deepEqual([row.kind, row.birth_date, row.wikipedia_title, row.external_ids.transfermarkt, row.spells.length], ['player', '2002-06-19', 'Nuno Mendes (footballer, born 2002)', '616341', 3]);
  const second = fakeWikidata(nuno);
  const read = await createKbStore({ getJson: second.getJson, db, now: () => NOW + 1000 }).whoIs('Nuno Mendes', 'PSG');
  assert.equal(read.source, 'store');
  assert.equal(second.requests.length, 0);
  assert.deepEqual(read.result, written.result);
});

await test('an answer is read again after a week, and an entity is rewritten no sooner', async () => {
  const { db, writes } = memoryDb();
  const wikidata = fakeWikidata(nuno);
  let now = NOW;
  const store = createKbStore({ getJson: wikidata.getJson, db, now: () => now });
  await store.whoIs('Nuno Mendes', 'PSG');
  now += KB_REFRESH_MS - 1000;
  assert.equal((await store.whoIs('Nuno Mendes', 'PSG')).source, 'store');
  // A second wording within the week finds the same player and leaves his row alone.
  writes.length = 0;
  await store.whoIs('Nuno Mendes', 'born 2002');
  assert.ok(writes.every((w) => w.startsWith('lookup ')), writes.join());
  now += 2000;
  writes.length = 0;
  assert.equal((await store.whoIs('Nuno Mendes', 'PSG')).source, 'wikidata');
  assert.deepEqual(writes, [`entity ${YOUNG}`, 'lookup nuno mendes#psg||']);
});

await test('an old answer stands when Wikidata fails, and a failure is never stored', async () => {
  const { db, writes } = memoryDb();
  const wikidata = fakeWikidata(nuno);
  let now = NOW;
  const store = createKbStore({ getJson: wikidata.getJson, db, now: () => now });
  await store.whoIs('Nuno Mendes', 'PSG');
  now += KB_REFRESH_MS + 1;
  wikidata.state.down = true;
  writes.length = 0;
  const stale = await store.whoIs('Nuno Mendes', 'PSG');
  assert.deepEqual([stale.source, resolved(stale.result).id], ['stale', YOUNG]);
  assert.equal((await store.whoIs('Someone New')).result.status, 'failed');
  assert.deepEqual(writes, []);
  wikidata.state.down = false;
  assert.equal((await store.whoIs('Someone New')).source, 'wikidata', 'a failure is asked again');
});

await test('a name Wikidata does not have writes no row and is asked about again after a day', async () => {
  const { db, writes } = memoryDb();
  const wikidata = fakeWikidata({ search: { search: [] }, sparql: {} });
  let now = NOW;
  const store = createKbStore({ getJson: wikidata.getJson, db, now: () => now });
  await store.whoIs('Zzyzx Qwv');
  assert.equal((await store.whoIs('Zzyzx Qwv')).source, 'store');
  assert.deepEqual(writes, []);
  now += KB_NOT_FOUND_MS + 1;
  assert.equal((await store.whoIs('Zzyzx Qwv')).source, 'wikidata');
});

await test('before the migration is applied, or when the database throws, memory keeps the answers', async () => {
  const missing = { code: 'PGRST205', message: "Could not find the table 'public.kb_lookups' in the schema cache" };
  const chain: any = { select: () => chain, eq: () => chain, in: async () => ({ data: null, error: missing }), maybeSingle: async () => ({ data: null, error: missing }), upsert: async () => ({ error: missing }) };
  const warnings: string[] = [];
  const throwing: KbDb = { readLookup: async () => Promise.reject(new Error('down')), readEntities: async () => Promise.reject(new Error('down')), writeEntities: async () => {}, writeLookup: async () => {} };
  for (const db of [supabaseKbDb({ from: () => chain }, (m) => warnings.push(m)), throwing]) {
    const wikidata = fakeWikidata(nuno);
    const store = createKbStore({ getJson: wikidata.getJson, db, now: () => NOW, warn: quiet });
    assert.equal((await store.whoIs('Nuno Mendes', 'PSG')).result.status, 'resolved');
    assert.equal((await store.whoIs('Nuno Mendes', 'PSG')).source, 'store');
    assert.equal(wikidata.requests.length, 2);
  }
  assert.deepEqual(warnings, [], 'a missing table is not worth a warning');
});

await test('lookups of one name share a resolution, and only a few ask Wikidata at once', async () => {
  let active = 0;
  let most = 0;
  let searches = 0;
  const store = createKbStore({
    db: null,
    now: () => NOW,
    getJson: async (url) => {
      if (url.includes('wbsearchentities')) searches++;
      most = Math.max(most, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return url.includes('wbsearchentities') ? nuno.search : nuno.sparql;
    },
  });
  await Promise.all(['a', 'a', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => store.whoIs(n)));
  assert.equal(searches, 7);
  assert.equal(most, KB_CONCURRENCY);
});

await test('the migration lets anyone read identities, nobody but the server write them, and only the server read what was asked', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261127140000_kb_entities.sql', import.meta.url), 'utf8');
  for (const column of ['wikidata_id text primary key', 'kind', 'label', 'aliases', 'birth_date', 'nationality', 'positions', 'wikipedia_title', 'external_ids jsonb', 'spells jsonb', 'fetched_at']) {
    assert.ok(sql.includes(column), column);
  }
  assert.equal(sql.match(/enable row level security/g)?.length, 2);
  assert.deepEqual(sql.match(/create policy .*/g), ['create policy "Public read" on public.kb_entities for select using (true);']);
});

// --- The route --------------------------------------------------------------------------------

function fakeResponse() {
  const out = { code: 200, body: null as any };
  const res = {
    status(code: number) {
      out.code = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
    },
  };
  return { res, out };
}

await test('the route logs each lookup and counts only those that go to Wikidata against a visitor', async () => {
  const wikidata = fakeWikidata(nuno);
  const logs: string[] = [];
  const handler = whoIsHandler<{ query: Record<string, unknown>; who: string }>({
    store: createKbStore({ getJson: wikidata.getJson, db: null, now: () => NOW }),
    limiter: createProxyLimiter({ perMinute: 3, now: () => NOW }),
    sourceOf: (req) => req.who,
    log: (m) => logs.push(m),
  });
  const ask = async (name: unknown, hint = '', who = 'one') => {
    const { res, out } = fakeResponse();
    await handler({ query: { name, hint }, who }, res);
    return out;
  };
  assert.equal((await ask('')).code, 400);
  assert.equal((await ask(['a', 'b'])).code, 400);
  assert.equal((await ask('Nuno Mendes', 'PSG')).body.entity.id, YOUNG);
  assert.equal((await ask('Nuno Mendes', 'PSG')).body.status, 'resolved');
  assert.equal((await ask('Nuno Mendes')).body.status, 'ambiguous');
  wikidata.state.down = true;
  assert.equal((await ask('Somebody Else')).body.status, 'failed');
  // Three lookups went to Wikidata, so the fourth is refused, while a stored answer still comes.
  const refused = await ask('A Fourth Name');
  assert.deepEqual([refused.code, refused.body.status], [429, 'failed']);
  assert.equal((await ask('Nuno Mendes', 'PSG')).code, 200);
  assert.equal((await ask('A Fifth Name', '', 'two')).code, 200, 'another visitor has their own count');
  assert.match(logs[0], /^\[kb\] who-is "Nuno Mendes" \(hint "PSG"\): miss, Nuno Mendes Q96396963 \[wikidata\]/);
  assert.match(logs[1], /: hit, .*\[store\]/);
  assert.match(logs[2], /: ambiguous, 2 candidates/);
  assert.match(logs[3], /: failed, Wikidata's search failed/);
  assert.ok(logs.every((l) => l.startsWith('[kb] ')));
  const long = fakeResponse();
  wikidata.state.down = false;
  await handler({ query: { name: 'x'.repeat(500) }, who: 'three' }, long.res);
  assert.equal(wikidata.requests.at(-2)!.url.searchParams.get('search')!.length, 80);
});

// --- The tool ---------------------------------------------------------------------------------

const { runChatTurn, CHAT_DECLARATIONS, MAX_IDENTITY_READS, chatDeclarations } = await import('../services/chatTurn');
const { threadStateFor } = await import('../services/conversationalScout');
type ChatModel = import('../services/chatTurn').ChatModel;
type ChatRoundReply = import('../services/chatTurn').ChatRoundReply;
type ChatToolResponse = import('../services/chatTurn').ChatToolResponse;

/** The live toolset with the route answered by a store over the recording. */
function kbTools() {
  const asked: string[] = [];
  const store = createKbStore({ getJson: fakeWikidata(nuno).getJson, db: null, now: () => NOW });
  const get: LiveGet = async <T>(url: string) => {
    asked.push(url);
    const u = new URL(url, 'http://local');
    if (u.pathname !== '/api/kb/who-is') return { error: 'HTTP 404' };
    return { data: (await store.whoIs(u.searchParams.get('name') ?? '', u.searchParams.get('hint') ?? '')).result as T };
  };
  return { tools: liveToolset([], get), asked };
}

await test("who_is reads the route and returns an identity or the candidates, as evidence", async () => {
  const { tools, asked } = kbTools();
  const one = await tools.whoIs!('Nuno Mendes', 'PSG');
  assert.equal(asked[0], '/api/kb/who-is?name=Nuno+Mendes&hint=PSG');
  assert.equal(one.status, 'found');
  assert.equal(one.result!.kind, 'identity');
  assert.match(one.result!.content, /Born: 2002-06-19/);
  assert.match(one.result!.content, /Paris Saint-Germain FC \(2022 to no end given\)/);
  assert.match(one.result!.content, /no appearance, goal or other statistics/);
  assert.deepEqual(one.result!.sources, ['https://www.wikidata.org/wiki/Q96396963']);
  const both = await tools.whoIs!('Nuno Mendes');
  assert.match(both.result!.content, /is not settled[\s\S]*none of them chosen[\s\S]*2002-06-19[\s\S]*1978-04-07/);
  assert.equal(asked[1], '/api/kb/who-is?name=Nuno+Mendes');
  const failing = liveToolset([], (async () => ({ error: 'refused (HTTP 429)' })) as LiveGet);
  assert.deepEqual([(await failing.whoIs!('x')).status, (await failing.whoIs!('x')).note], ['failed', 'refused (HTTP 429)']);
});

await test('the declaration says what it returns and that it carries no statistics, on every turn the loop takes', () => {
  const declaration = CHAT_DECLARATIONS.find((d) => d.name === 'who_is')!;
  assert.match(declaration.description!, /birth date[\s\S]*clubs played for[\s\S]*candidates and chooses none[\s\S]*no statistics/i);
  assert.deepEqual(declaration.parameters!.required, ['name']);
  for (const [gaffa, commit] of [[false, false], [true, false], [false, true]]) assert.ok(chatDeclarations(gaffa, commit).some((d) => d.name === 'who_is'));
});

/** A model that plays back `script`, keeping what it was sent. */
function fakeModel(script: ChatRoundReply[]) {
  const sent: (string | ChatToolResponse[])[] = [];
  let opened: { systemInstruction: string; declarations: string[] } | null = null;
  const model: ChatModel = {
    open(args) {
      opened = { systemInstruction: args.systemInstruction, declarations: args.declarations.map((d) => String(d.name)) };
      return {
        async send(message) {
          sent.push(message);
          return script[Math.min(sent.length - 1, script.length - 1)];
        },
      };
    },
  };
  return { model, sent, opened: () => opened! };
}
const params = (conversationId: string, extra: Record<string, unknown> = {}) => ({
  message: 'Which Nuno Mendes plays for PSG?',
  route: { intent: 'tactical_chat', analyticalMode: 'player_qa', targetPlayers: [], targetClubs: [], searchQueries: [], isHistorical: false, wantsRegeneration: false, needsSearch: true } as any,
  history: [],
  isEAFCRequest: false,
  conversationDossiers: [],
  savedDossiers: [],
  lockedDossiersBlock: '',
  savedDossiersBlock: '',
  conversationId,
  ...extra,
});
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { log, info, warn } = console;
  console.log = console.info = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, info, warn });
  }
};
const reply = (text: string): ChatRoundReply => ({ text, calls: [] });
const calls = (...list: { name: string; args: Record<string, unknown> }[]): ChatRoundReply => ({ text: '', calls: list });
const deps = (model: ChatModel, tools: ResearchToolset) => ({ model, tools, snapshots: null, managers: async () => [], eras: null, verdicts: null });

await test('in the chat loop who_is costs no lookup, and its record is filed as evidence', async () => {
  const fake = fakeModel([
    calls({ name: 'who_is', args: { name: 'Nuno Mendes', hint: 'PSG' } }),
    reply('The PSG one was born on 19 June 2002 and joined in 2021.'),
  ]);
  let stats: import('../services/chatTurn').TurnStats | null = null;
  const text = await quietly(() => runChatTurn(params('kb-free'), { ...deps(fake.model, kbTools().tools), onStats: (s) => (stats = s) }));
  assert.equal(text, 'The PSG one was born on 19 June 2002 and joined in 2021.', 'the figure gate leaves its dates and years');
  assert.deepEqual([stats!.calls, stats!.searches, stats!.rounds], [0, 0, 1]);
  const [result] = fake.sent[1] as ChatToolResponse[];
  assert.equal(result.response.status, 'found');
  assert.match(String(result.response.data), /Born: 2002-06-19/);
  assert.match(String(result.response.budget), /12 lookups, 4 web searches/);
  assert.match(threadStateFor('kb-free').grounding, /\[E1\] Identity record \(Wikidata\) — Nuno Mendes\n[\s\S]*Born: 2002-06-19/);
  assert.match(fake.opened().systemInstruction, /- who_is says which player or club a name means.*free and carries no statistics/);
});

await test('a name that finds nothing is filed as a gap, and a missing argument is refused', async () => {
  const tools = { ...kbTools().tools, whoIs: async () => ({ status: 'empty' as const, result: null, missing: [], note: 'Wikidata has nothing by that name' }) };
  const fake = fakeModel([calls({ name: 'who_is', args: { name: 'Zzyzx' } }, { name: 'who_is', args: {} }), calls({ name: 'who_is', args: { name: 'Zzyzx' } }), reply('Nobody by that name.')]);
  await quietly(() => runChatTurn({ ...params('kb-gap'), message: 'Who is Zzyzx?' }, deps(fake.model, tools)));
  assert.equal((fake.sent[1] as ChatToolResponse[])[1].response.status, 'not_run');
  // A thread keeps research only when something was found.
  assert.equal(threadStateFor('kb-gap').grounding ?? '', '');
});

await test('a turn may ask only so many names', async () => {
  const many = Array.from({ length: MAX_IDENTITY_READS + 1 }, (_, i) => ({ name: 'who_is', args: { name: `Name ${i}` } }));
  const fake = fakeModel([calls(...many), reply('Done.')]);
  const tools = kbTools();
  await quietly(() => runChatTurn(params('kb-ceiling'), deps(fake.model, tools.tools)));
  const results = fake.sent[1] as ChatToolResponse[];
  assert.equal(results.filter((r) => r.response.status === 'not_run').length, 1);
  assert.equal(tools.asked.length, MAX_IDENTITY_READS);
});

await test('a question about the past has who_is too', async () => {
  const fake = fakeModel([calls({ name: 'who_is', args: { name: 'Nuno Mendes', hint: 'born 1978' } }), reply('The older one was born in 1978.')]);
  await quietly(() => runChatTurn(params('kb-past', { historical: true, pastMode: true }), { ...deps(fake.model, kbTools().tools), pastNetwork: { settle: async () => {}, depart: async () => {} } as any }));
  assert.ok(fake.opened().declarations.includes('who_is'));
  assert.match(fake.opened().systemInstruction, /- who_is says/);
  assert.match(String((fake.sent[1] as ChatToolResponse[])[0].response.data), /Born: 1978-04-07/);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
