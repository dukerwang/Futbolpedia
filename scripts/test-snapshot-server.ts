#!/usr/bin/env npx tsx
/**
 * Offline checks for the server's snapshot builds: the research toolset's routes answered
 * in-process, stored club and era snapshots served from the server's table access, and era builds
 * held back until a snapshot can be stored. Live data, history and the table are faked; no model
 * or search runs.
 *
 * Usage:
 *   npx tsx scripts/test-snapshot-server.ts
 */
import assert from 'node:assert/strict';
import { SNAPSHOT_VERSION, type SnapshotRow } from '../services/clubSnapshots';
import { ERA_SNAPSHOT_VERSION, eraKey, type EraRow } from '../services/eraSnapshots';
import { createSnapshotServer, inProcessGet, type SnapshotDb } from '../services/snapshotServer';
import { createVerdictSettler, departureHandler, memoryVerdictDb, settleHandler } from '../services/debateVerdicts';

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

const calls: string[] = [];
const routes = {
  live: {
    club: async (name: string) => (calls.push(`club:${name}`), { found: false, status: 'empty', reason: 'no such club', missing: [] }),
    player: async (name: string) => (calls.push(`player:${name}`), { found: false, status: 'not_covered', reason: 'not in the feed' }),
    table: async (league: string, country?: string) => (calls.push(`table:${league}:${country ?? ''}`), { found: false, status: 'empty', reason: 'no table' }),
  },
  history: {
    clubSeason: async (club: string, season: string) => (
      calls.push(`season:${club}:${season}`),
      { found: true, title: '2003–04 Northside F.C. season', text: 'The season record.', sources: ['Wikipedia'], missing: [] }
    ),
    playerCareer: async (name: string) => (calls.push(`career:${name}`), { found: true, title: 'A. Forward (footballer)', text: 'The career.', sources: ['Wikipedia'], missing: [] }),
  },
} as any;

const fakeDb = (rows: { clubs?: Record<string, SnapshotRow>; eras?: Record<string, EraRow> }, eraReady: boolean) => {
  const log = { clubWrites: [] as SnapshotRow[], eraWrites: [] as EraRow[], eraReadyChecks: 0 };
  const db: SnapshotDb = {
    readClub: async (key) => rows.clubs?.[key] ?? null,
    writeClub: async (row) => void log.clubWrites.push(row),
    listClubs: async () => Object.values(rows.clubs ?? {}),
    readEra: async (key) => rows.eras?.[key] ?? null,
    writeEra: async (row) => void log.eraWrites.push(row),
    eraReady: async () => (log.eraReadyChecks++, eraReady),
  };
  return { db, log };
};

const clubRow = (key: string, club: string): SnapshotRow => ({
  club_key: key,
  club_name: club,
  league: 'Premier League',
  snapshot: { core: { club } as any, story: { changes: ['x'], distinctive: 'y', newsAbsences: [], unknowns: [] }, sources: [] },
  version: SNAPSHOT_VERSION,
  built_at: new Date().toISOString(),
});

const ERA_KEY = eraKey('club_season', 'Northside F.C.', '2003-04');
const eraRow: EraRow = {
  snapshot_key: ERA_KEY,
  kind: 'club_season',
  subject: 'Northside F.C.',
  period: '2003-04',
  snapshot: { story: { summary: 'An unbeaten season.', setup: '4-4-2', people: [], record: 'Champions', figures: [], disputed: [] }, sources: ['Wikipedia'] },
  version: ERA_SNAPSHOT_VERSION,
  built_at: '2026-11-01T12:00:00Z',
};

// --- Tests ------------------------------------------------------------------------------------

await test('the research routes are answered in-process, and an unknown route is a 404', async () => {
  calls.length = 0;
  const get = inProcessGet(routes);
  assert.deepEqual(await get('/api/live/club?name=Spurs'), { data: { found: false, status: 'empty', reason: 'no such club', missing: [] } });
  await get('/api/live/player?name=A+Forward');
  await get('/api/live/table?league=Premier+League&country=England');
  await get('/api/history/club-season?club=Northside&season=2003-04');
  await get('/api/history/player?name=A+Forward');
  assert.deepEqual(calls, ['club:Spurs', 'player:A Forward', 'table:Premier League:England', 'season:Northside:2003-04', 'career:A Forward']);
  assert.deepEqual(await get('/api/football/player?name=x'), { error: 'HTTP 404' });
});

await test('a route that throws is an unreachable lookup, not a crash', async () => {
  const get = inProcessGet({ ...routes, live: { ...routes.live, club: async () => assert.fail('boom') } });
  assert.deepEqual(await get('/api/live/club?name=x'), { error: 'unreachable' });
});

await test('a fresh stored club snapshot is served from the table without a build', async () => {
  const { db, log } = fakeDb({ clubs: { northside: clubRow('northside', 'Northside') } }, true);
  const server = createSnapshotServer({ get: inProcessGet(routes), db });
  const snapshot = await server.club('Northside');
  assert.equal(snapshot?.club, 'Northside');
  assert.equal(log.clubWrites.length, 0);
});

await test('a club the live data doesn\'t know is neither researched nor built', async () => {
  const { db, log } = fakeDb({}, true);
  const server = createSnapshotServer({ get: inProcessGet(routes), db });
  assert.equal(await server.clubResearch('Nowhere Town'), null);
  assert.equal(await server.club('Nowhere Town'), null);
  assert.equal(log.clubWrites.length, 0);
});

await test('a stored era snapshot is served under the key its facts resolve to', async () => {
  const { db, log } = fakeDb({ eras: { [ERA_KEY]: eraRow } }, true);
  const server = createSnapshotServer({ get: inProcessGet(routes), db });
  const snapshot = await server.era('club_season', 'Northside', '2003–2004');
  assert.equal(snapshot?.key, ERA_KEY);
  assert.equal(snapshot?.story.summary, 'An unbeaten season.');
  assert.equal(log.eraReadyChecks, 0);
});

await test('an era snapshot isn\'t built when it can\'t be stored', async () => {
  const noTable = fakeDb({}, false);
  assert.equal(await createSnapshotServer({ get: inProcessGet(routes), db: noTable.db }).era('club_season', 'Northside', '2003-04'), null);
  assert.equal(noTable.log.eraReadyChecks, 1);
  assert.equal(noTable.log.eraWrites.length, 0);
  // Without the secret key there's no table access at all.
  assert.equal(await createSnapshotServer({ get: inProcessGet(routes), db: null }).era('player_window', 'A Forward', '2003-06'), null);
});

// --- Settled verdicts' routes ------------------------------------------------------------------

const fakeRes = () => {
  const out: { code: number; body: unknown; ended: boolean } = { code: 0, body: undefined, ended: false };
  const res = {
    status(code: number) {
      out.code = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
    },
    end() {
      out.ended = true;
    },
  };
  return { res, out };
};

const verdictServer = (ready: boolean) => {
  const db = memoryVerdictDb(ready);
  const sources: string[] = [];
  const settler = createVerdictSettler({
    db,
    cards: async () => new Map(),
    record: async (subject) => ({ text: `The record of ${subject.slug}.` }),
    eraBuiltAt: async () => new Map(),
    model: async () => ({ accept: true, criteria: ['Results'], counterCase: 'The other side.' }),
    log: () => {},
  });
  const sourceOf = (req: { ip?: string }) => (sources.push(req.ip ?? ''), req.ip ?? 'none');
  return { db, settler, sourceOf, sources };
};

const seasons = {
  kind: 'head_to_head',
  criterion: 'influence',
  subjects: ['club_season:northside-fc:2003-04', 'club_season:southside-fc:1998-99'],
  verdict: ['club_season:northside-fc:2003-04'],
};

await test('POST /api/debates/settle answers with the status only, and 400 for a malformed body', async () => {
  const { db, settler, sourceOf, sources } = verdictServer(true);
  const ok = fakeRes();
  await settleHandler(settler, sourceOf)({ body: seasons, ip: 'client-1' } as any, ok.res);
  assert.equal(ok.out.code, 200);
  assert.deepEqual(ok.out.body, { status: 'stored' });
  assert.deepEqual(sources, ['client-1']);
  assert.equal(db.rows.size, 1);
  const bad = fakeRes();
  await settleHandler(settler, sourceOf)({ body: { ...seasons, verdict: ['someone else'] } } as any, bad.res);
  assert.equal(bad.out.code, 400);
  assert.deepEqual(bad.out.body, { status: 'invalid' });
});

await test('POST /api/debates/settle without the table stores nothing and calls nothing', async () => {
  const { db, settler, sourceOf } = verdictServer(false);
  const r = fakeRes();
  await settleHandler(settler, sourceOf)({ body: seasons, ip: 'client-1' } as any, r.res);
  assert.deepEqual(r.out.body, { status: 'unavailable' });
  assert.equal(db.rows.size, 0);
});

await test('POST /api/debates/departure always answers 204', async () => {
  const { db, settler, sourceOf } = verdictServer(true);
  await settleHandler(settler, sourceOf)({ body: seasons, ip: 'client-1' } as any, fakeRes().res);
  const key = [...db.rows.keys()][0];
  for (const body of [{ key }, { key: 'nonsense' }, null]) {
    const r = fakeRes();
    await departureHandler(settler, sourceOf)({ body, ip: 'client-2' } as any, r.res);
    assert.equal(r.out.code, 204);
    assert.equal(r.out.ended, true);
  }
  assert.equal(db.rows.get(key)!.departures, 1);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
