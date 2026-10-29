#!/usr/bin/env npx tsx
/**
 * Offline checks that a published shared card is served without re-rating: sendMessageToAI runs
 * for real against an in-memory stand-in for Supabase, with Gemini answered by a fake at the
 * fetch layer (no network or API keys). The shared store holds cards the way the Global Dossier
 * Hub does: under the name the card was published with ("prime-zinedine-zidane"), which can be a
 * player's full name rather than the one he is known by ("prime-arthur-antunes-coimbra").
 *
 * Usage:
 *   npx tsx scripts/test-dossier-cache-hit.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';

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

async function main() {
  const { sanitizeProfileData } = await import('../services/dossierSynthesizer');
  const { CALIBRATION_EPOCH_MS } = await import('../services/dossierStore');
  const { sendMessageToAI } = await import('../services/geminiService');

  const publishedAt = new Date(CALIBRATION_EPOCH_MS + 86_400_000).toISOString();
  const zidanePrime: PlayerProfile = {
    ...sanitizeProfileData({
      basicInfo: { name: 'Zinedine Zidane', age: 30, nationality: 'France', club: 'Real Madrid', position: 'Attacking Midfielder' },
      ratings: { overall: 94, potential: 94 },
    }),
    evaluationDate: '2005-05-15',
    createdAt: Date.parse(publishedAt),
    version: {
      id: 'zinedine-zidane-prime-2005-05-15',
      type: 'prime',
      label: 'Prime Zenith (2002-05)',
      evaluationDate: '2005-05-15',
      seasonOrEra: '2002-05',
    },
  };
  tables.player_profiles = [
    { player_slug: 'prime-zinedine-zidane', player_data: zidanePrime, updated_at: publishedAt },
    { player_slug: 'zinedine-zidane--prime--2005-05-15', player_data: zidanePrime, updated_at: publishedAt },
  ];

  const log = console.log;
  const info = console.info;
  const warn = console.warn;
  const rate = async (message: string) => {
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    try {
      return (await sendMessageToAI(message, [], undefined, [], [])) as PlayerProfile;
    } finally {
      console.log = log;
      console.info = info;
      console.warn = warn;
    }
  };

  await test('an inconclusive status check finds the prime under his full name once grounding shows the retirement', async () => {
    // Runs first: the status check's answer is remembered per name, an inconclusive one isn't.
    scenario = {
      status: '',
      search: (q) =>
        q.includes('current club as of')
          ? '- Retired from professional football in 2006.'
          : '- Summary of the player.',
    };
    const card = await rate('rate zidane');
    assert.equal(card.ratings.overall, 94);
    assert.equal(syntheses().length, 0, 'no re-rating');
  });

  await test('"rate zidane" serves the published prime after the status check alone', async () => {
    scenario = { status: 'RETIRED', search: () => '- Summary of the player.' };
    const card = await rate('rate zidane');
    assert.equal(card.basicInfo.name, 'Zinedine Zidane');
    assert.equal(card.version?.type, 'prime');
    assert.equal(card.ratings.overall, 94);
    assert.equal(statusChecks().length, 1);
    assert.equal(geminiPrompts.length, 1, 'no grounding or synthesis');
    assert.equal(apiFootballCalls, 0, 'no API-Football grounding');
    assert.equal(writes.length, 0, 'the frozen prime is not rewritten');
  });

  await test('"rate prime zidane" serves the published prime with no Gemini call', async () => {
    const card = await rate('rate prime zidane');
    assert.equal(card.ratings.overall, 94);
    assert.equal(geminiPrompts.length, 0);
    assert.equal(apiFootballCalls, 0);
  });

  await test('"rerate zidane" still regenerates his prime', async () => {
    scenario = { status: 'RETIRED', search: () => '- Summary of the player.' };
    // Synthesis gets the fake's empty answer, so the request fails after reaching it.
    await rate('rerate zidane').catch(() => null);
    assert.ok(syntheses().length > 0);
  });

  const zicoPrime: PlayerProfile = {
    ...zidanePrime,
    basicInfo: { ...zidanePrime.basicInfo, name: 'Arthur Antunes Coimbra', club: 'Flamengo' },
    ratings: { overall: 97, potential: 97 },
    evaluationDate: '1982-07-05',
    version: {
      id: 'arthur-antunes-coimbra-prime-1982-07-05',
      type: 'prime',
      label: 'Prime Zenith (1980-82)',
      evaluationDate: '1982-07-05',
      seasonOrEra: '1980-82',
    },
  };
  const zicoSeason: PlayerProfile = {
    ...zicoPrime,
    ratings: { overall: 96, potential: 96 },
    evaluationDate: '1981-12-13',
    version: {
      id: 'arthur-antunes-coimbra-season_snapshot-1981-12-13',
      type: 'season_snapshot',
      label: 'Season (1981)',
      evaluationDate: '1981-12-13',
      seasonOrEra: '1981',
    },
  };
  tables.player_profiles.push(
    { player_slug: 'prime-arthur-antunes-coimbra', player_data: zicoPrime, updated_at: publishedAt },
    { player_slug: 'arthur-antunes-coimbra--prime--1982-07-05', player_data: zicoPrime, updated_at: publishedAt },
    { player_slug: 'arthur-antunes-coimbra--season_snapshot--1981-12-13', player_data: zicoSeason, updated_at: publishedAt },
  );
  const zicoIdentity = 'STATUS: RETIRED | KNOWN AS: Zico | FULL NAME: Arthur Antunes Coimbra';

  await test('"rate prime zico" finds the prime published under his full name', async () => {
    scenario = { status: zicoIdentity, search: () => '- Summary of the player.' };
    const card = await rate('rate prime zico');
    assert.equal(card.basicInfo.name, 'Arthur Antunes Coimbra');
    assert.equal(card.ratings.overall, 97);
    assert.equal(geminiPrompts.length, 1, 'the identity check alone');
    assert.equal(apiFootballCalls, 0);
    assert.equal(writes.length, 0, 'no second card');
  });

  await test('"rate zico" serves the same prime', async () => {
    const card = await rate('rate zico');
    assert.equal(card.ratings.overall, 97);
    assert.equal(syntheses().length, 0);
    assert.equal(writes.length, 0);
  });

  await test('"rate zico 1981" finds the season card published under his full name', async () => {
    const card = await rate('rate zico 1981');
    assert.equal(card.version?.type, 'season_snapshot');
    assert.equal(card.ratings.overall, 96);
    assert.equal(syntheses().length, 0);
  });

  await test('an active player with a published prime still gets his current form', async () => {
    scenario = { status: 'ACTIVE', search: () => '- Regular starter this season.' };
    const modricPrime = {
      ...zidanePrime,
      basicInfo: { ...zidanePrime.basicInfo, name: 'Luka Modrić' },
      version: { ...zidanePrime.version!, id: 'luka-modric-prime-2018-05-26' },
    };
    tables.player_profiles.push({ player_slug: 'prime-luka-modric', player_data: modricPrime, updated_at: publishedAt });
    // Synthesis gets the fake's empty answer, so the request fails after reaching it.
    await rate('rate modric').catch(() => null);
    assert.equal(statusChecks().length, 1);
    assert.ok(syntheses().length > 0, 'his current form is rated');
  });

  console.log(`${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
