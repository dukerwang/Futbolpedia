#!/usr/bin/env npx tsx
/**
 * Offline checks for the Rate command (`ratePlayer`): it serves the same published cards a typed
 * rating does, without routing a chat turn, and its task line routes the way the command does.
 * Runs against the same in-memory Supabase and fetch-level Gemini fakes as
 * test-dossier-cache-hit.ts (no network or API keys).
 *
 * Usage:
 *   npx tsx scripts/test-rating-command.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile, RatingRequest } from '../types';

process.env.API_KEY = 'offline-test-key';

type Row = Record<string, any>;
const tables: Record<string, Row[]> = { player_profiles: [], dossier_revisions: [], club_managers: [] };

const likeToRegExp = (pattern: string, flags = ''): RegExp =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, flags);

/** Just enough of the supabase-js query builder for the dossier pipeline. */
class FakeQuery {
  private filters: ((r: Row) => boolean)[] = [];
  private mode: 'many' | 'single' | 'maybeSingle' = 'many';
  private max = Infinity;
  private writes: Row[] | null = null;

  constructor(private table: string) {}

  select() { return this; }
  order() { return this; }
  limit(n: number) { this.max = n; return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  gte(col: string, val: string) { this.filters.push((r) => r[col] >= val); return this; }
  ilike(col: string, pattern: string) {
    const re = likeToRegExp(pattern, 'i');
    this.filters.push((r) => re.test(r[col] ?? ''));
    return this;
  }
  or(expr: string) {
    const parts = expr.split(',').map((p) => {
      const [col, pattern] = p.split('.like.');
      const re = likeToRegExp(pattern);
      return (r: Row) => re.test(r[col] ?? '');
    });
    this.filters.push((r) => parts.some((f) => f(r)));
    return this;
  }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybeSingle'; return this; }
  upsert(rows: Row | Row[]) { this.writes = Array.isArray(rows) ? rows : [rows]; return this; }
  insert(rows: Row | Row[]) { return this.upsert(rows); }
  update() { this.writes = []; return this; }

  then(resolve: (v: { data: any; error: any }) => void) {
    if (this.writes) {
      writes.push(...this.writes.map((r) => ({ table: this.table, ...r })));
      return resolve({ data: null, error: null });
    }
    const rows = (tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r))).slice(0, this.max);
    if (this.mode === 'many') return resolve({ data: rows, error: null });
    if (rows.length === 1) return resolve({ data: rows[0], error: null });
    return resolve({ data: null, error: this.mode === 'single' ? { message: 'no rows' } : null });
  }
}

let writes: Row[] = [];
(globalThis as any).window = {
  supabase: { createClient: () => ({ from: (table: string) => new FakeQuery(table) }) },
};

interface Scenario {
  /** Reply text for the identity check ("still playing professionally?", known-as and full name). */
  status: string;
  /** Digest text returned by grounded searches. */
  search: (query: string) => string;
}

let scenario: Scenario = { status: 'RETIRED', search: () => '' };
let geminiPrompts: string[] = [];
let apiFootballCalls = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.includes('generativelanguage.googleapis.com')) {
    const body = JSON.parse(init?.body ?? '{}');
    const prompt = JSON.stringify([body.contents ?? '', body.systemInstruction ?? '']);
    geminiPrompts.push(prompt);
    const structured = JSON.stringify(body).includes('responseSchema') || JSON.stringify(body).includes('responseJsonSchema');
    // Synthesis is answered with nothing usable: these tests must never get that far.
    const text = prompt.includes('still playing professionally')
      ? scenario.status
      : structured
        ? '{}'
        : scenario.search(prompt);
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: text ? [{ text }] : [] }, finishReason: 'STOP' }],
        usageMetadata: {},
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (url.startsWith('/api/')) {
    apiFootballCalls++;
    return new Response('{}', { status: 404 });
  }
  return realFetch(input, init);
}) as typeof fetch;

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  geminiPrompts = [];
  apiFootballCalls = 0;
  writes = [];
  try {
    await fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).stack ?? err}`);
  }
}

const statusChecks = () => geminiPrompts.filter((p) => p.includes('still playing professionally'));
const syntheses = () => geminiPrompts.filter((p) => p.includes('synthesis_instructions'));

const routerCalls = () => geminiPrompts.filter((p) => p.includes("Classify the user's football scouting message"));

async function main() {
  const { sanitizeProfileData } = await import('../services/dossierSynthesizer');
  const { CALIBRATION_EPOCH_MS, getCardKey } = await import('../services/dossierStore');
  const { ratePlayer, sendMessageToAI } = await import('../services/geminiService');
  const { ratingTask, routeForRating } = await import('../services/ratingCommand');
  const { classifyTurn } = await import('../services/turnRouter');
  const { toBasePlayerSlug } = await import('../services/dossierCards');

  const publishedAt = new Date(CALIBRATION_EPOCH_MS + 86_400_000).toISOString();
  const card = (
    name: string,
    overall: number,
    version: NonNullable<PlayerProfile['version']>,
  ): PlayerProfile => ({
    ...sanitizeProfileData({
      basicInfo: { name, age: 30, nationality: 'France', club: 'Real Madrid', position: 'Attacking Midfielder' },
      ratings: { overall, potential: overall },
    }),
    evaluationDate: version.evaluationDate,
    createdAt: Date.parse(publishedAt),
    version,
  });
  const zidanePrime = card('Zinedine Zidane', 94, {
    id: 'zinedine-zidane-prime-2005-05-15',
    type: 'prime',
    label: 'Prime Zenith (2002-05)',
    evaluationDate: '2005-05-15',
    seasonOrEra: '2002-05',
  });
  const zidaneSeason = card('Zinedine Zidane', 92, {
    id: 'zinedine-zidane-season_snapshot-1998-07-12',
    type: 'season_snapshot',
    label: 'Season (1997-98)',
    evaluationDate: '1998-07-12',
    seasonOrEra: '1997-98',
  });
  const zidaneEra = card('Zinedine Zidane', 93, {
    id: 'zinedine-zidane-era-1999-05-20',
    type: 'era',
    label: 'Juventus era (1996-99)',
    evaluationDate: '1999-05-20',
    seasonOrEra: '1996-99',
    qualifier: 'Juventus',
  });
  tables.player_profiles = [
    { player_slug: 'prime-zinedine-zidane', player_data: zidanePrime, updated_at: publishedAt },
    { player_slug: 'zinedine-zidane--prime--2005-05-15', player_data: zidanePrime, updated_at: publishedAt },
    { player_slug: 'zinedine-zidane--season_snapshot--1998-07-12', player_data: zidaneSeason, updated_at: publishedAt },
    { player_slug: 'zinedine-zidane--era--1996-99', player_data: zidaneEra, updated_at: publishedAt },
  ];

  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const { log, info, warn } = console;
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    try {
      return await fn();
    } finally {
      Object.assign(console, { log, info, warn });
    }
  };
  const rate = async (request: RatingRequest) =>
    (await quietly(() => ratePlayer(request, [], [], []))) as PlayerProfile;

  const requests: RatingRequest[] = [
    { name: 'Florian Wirtz', edition: 'auto' },
    { name: 'Florian Wirtz', edition: 'current' },
    { name: 'Zinedine Zidane', edition: 'prime' },
    { name: 'Thierry Henry', edition: 'season', season: '2003-04' },
    { name: 'Neymar Jr', edition: 'era', era: 'PSG' },
  ];
  for (const request of requests) {
    await test(`"${ratingTask(request)}" routes the way the command does`, async () => {
      const typed = await quietly(() =>
        classifyTurn({ message: ratingTask(request), history: [], conversationDossiers: [], hasImage: false }),
      );
      const command = routeForRating(request);
      assert.equal(routerCalls().length, 0, 'a fast path, not the classifier');
      assert.equal(typed.intent, 'single_dossier');
      assert.equal(typed.isHistorical, command.isHistorical);
      assert.equal(typed.requestedSeason ?? null, command.requestedSeason ?? null);
      assert.equal((typed.requestedEra ?? '').toLowerCase(), (command.requestedEra ?? '').toLowerCase());
      assert.equal(Boolean(typed.wantsCurrentForm), Boolean(command.wantsCurrentForm));
      assert.equal(toBasePlayerSlug(typed.targetPlayers[0] ?? ''), toBasePlayerSlug(request.name));
    });
  }

  await test('a prime pick serves the published prime with no Gemini call', async () => {
    const served = await rate({ name: 'Zinedine Zidane', edition: 'prime' });
    assert.equal(served.ratings.overall, 94);
    assert.equal(geminiPrompts.length, 0);
    assert.equal(apiFootballCalls, 0);
    assert.equal(writes.length, 0);
  });

  await test('the command and typed "rate prime zidane" serve the same card', async () => {
    const command = await rate({ name: 'zidane', edition: 'prime' });
    const typed = (await quietly(() => sendMessageToAI('rate prime zidane', [], undefined, [], []))) as PlayerProfile;
    assert.equal(getCardKey(command), getCardKey(typed));
  });

  await test('Auto on a retired player serves his prime after the status check, without routing', async () => {
    scenario = { status: 'RETIRED', search: () => '- Summary of the player.' };
    const served = await rate({ name: 'zidane', edition: 'auto' });
    assert.equal(served.version?.type, 'prime');
    assert.equal(routerCalls().length, 0);
    assert.equal(syntheses().length, 0, 'no re-rating');
  });

  await test('a season pick serves the published season card', async () => {
    const served = await rate({ name: 'Zinedine Zidane', edition: 'season', season: '1997-98' });
    assert.equal(served.version?.type, 'season_snapshot');
    assert.equal(served.ratings.overall, 92);
    assert.equal(syntheses().length, 0);
  });

  await test('an era pick serves the published era card', async () => {
    const served = await rate({ name: 'Zinedine Zidane', edition: 'era', era: 'Juventus' });
    assert.equal(served.version?.type, 'era');
    assert.equal(served.ratings.overall, 93);
    assert.equal(syntheses().length, 0);
  });

  await test('a player with no card is rated once, without routing', async () => {
    scenario = { status: 'ACTIVE', search: () => '- Regular starter this season.' };
    // Synthesis gets the fake's empty answer, so the request fails after reaching it.
    await rate({ name: 'Florian Wirtz', edition: 'auto' }).catch(() => null);
    assert.equal(routerCalls().length, 0);
    assert.equal(syntheses().length, 1);
  });

  console.log(`${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
