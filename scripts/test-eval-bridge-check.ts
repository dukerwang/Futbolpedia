#!/usr/bin/env npx tsx
/**
 * Offline checks for the bridge check (`scripts/bridge-check.ts` and its runner), with the model
 * faked and nothing sent: each player's season draft compared with his current card, a player with
 * no current card costing no call, a spending limit ending the run, the estimate, and the runner
 * refusing to start without EVAL_GEMINI_API_KEY; and the prime order check's re-rates, report,
 * estimate and runner the same way. The blind season draft itself is checked end to
 * end, with Gemini faked at fetch, in scripts/test-dossier-pipeline.ts.
 *
 * Usage:
 *   npx tsx scripts/test-eval-bridge-check.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlayerProfile } from '../types';
import { bridgeMarkdown, estimateBridge, parsePlayers, runBridge, summarizeBridge, type BridgeCurrentCard, type BridgeRow } from './bridge-check';
import { estimatePrimeOrder, primeOrderMarkdown, runPrimeOrder } from './prime-order';

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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const currentCard = (name: string, overall: number): BridgeCurrentCard => ({ name, overall, evaluated: '2026-11-04', formWindow: null });
const seasonCard = (name: string, overall: number): PlayerProfile =>
  ({
    basicInfo: { name, position: 'Left-Back' },
    ratings: { overall, potential: overall },
    version: { type: 'season_snapshot', seasonOrEra: '2025-26' },
    peerPlacement: { betterThan: ['Peer A'], levelWith: [], notAsGoodAs: [] },
  }) as unknown as PlayerProfile;

const CURRENT: Record<string, number> = { 'Ana One': 90, 'Ben Two': 91, 'Cal Three': 88 };
const SEASON: Record<string, number> = { 'Ana One': 92, 'Ben Two': 91, 'Cal Three': 87 };

await test('each player with a current card is drafted once and compared; one without costs no call', async () => {
  const drafted: string[] = [];
  const updates: number[] = [];
  const { rows, stoppedEarly } = await runBridge({
    players: ['Ana One', 'Nobody', 'Ben Two', 'Cal Three'],
    season: '2025-26',
    currentCard: async (p) => (CURRENT[p] ? currentCard(p, CURRENT[p]) : null),
    draft: async (p, season) => {
      drafted.push(`${p} ${season}`);
      return seasonCard(p, SEASON[p]);
    },
    stopReason: () => null,
    onUpdate: (r) => updates.push(r.length),
  });
  assert.equal(stoppedEarly, undefined);
  assert.deepEqual(drafted, ['Ana One 2025-26', 'Ben Two 2025-26', 'Cal Three 2025-26']);
  assert.deepEqual(rows.map((r) => r.gap), [2, null, 0, -1]);
  assert.deepEqual(updates, [1, 2, 3, 4]);
  assert.deepEqual(summarizeBridge(rows), { compared: 3, seasonHigher: 1, level: 1, seasonLower: 1, meanGap: 0.33, medianGap: 0 });
  const md = bridgeMarkdown({ rows, season: '2025-26', today: '2026-12-05', model: 'fake' });
  assert.match(md, /\| Ana One \| 90 \| 2026-11-04 \| not recorded \| 92 \| \+2 \|/);
  assert.match(md, /\| Nobody \|[^\n]*nothing was rated/);
  assert.match(md, /Median gap: 0\./);
});

await test('a pipeline message or a card of another version is no comparison', async () => {
  const { rows } = await runBridge({
    players: ['Ana One', 'Ben Two'],
    season: '2025-26',
    currentCard: async (p) => currentCard(p, CURRENT[p]),
    draft: async (p) => (p === 'Ana One' ? "I couldn't find him." : ({ ...seasonCard(p, 90), version: { type: 'current' } } as unknown as PlayerProfile)),
    stopReason: () => null,
  });
  assert.deepEqual(rows.map((r) => r.gap), [null, null]);
  assert.match(rows[1].note!, /not a season card/);
});

await test('a spending limit ends the run with what finished', async () => {
  let reason: string | null = null;
  const seen: BridgeRow[][] = [];
  const { rows, stoppedEarly } = await runBridge({
    players: ['Ana One', 'Ben Two', 'Cal Three'],
    season: '2025-26',
    currentCard: async (p) => currentCard(p, CURRENT[p]),
    draft: async (p) => {
      if (p === 'Ben Two') {
        reason = 'a 429 came back';
        throw new Error('429');
      }
      return seasonCard(p, SEASON[p]);
    },
    stopReason: () => reason,
    onUpdate: (r) => seen.push([...r]),
  });
  assert.equal(stoppedEarly, 'a 429 came back');
  assert.deepEqual(rows.map((r) => r.player), ['Ana One', 'Ben Two']);
  assert.equal(seen.at(-1)!.length, 2);
});

await test('the estimate counts a comparison, a synthesis, a trait rewrite and two grounded calls a player, with a higher ceiling', () => {
  const e = estimateBridge(8);
  assert.equal(e.expected.total.calls, 1 + 8 * 5);
  assert.equal(e.expected.total.grounded, 16);
  assert.equal(e.expected.components.find((c) => c.name === 'Season card synthesis')!.calls, 8);
  assert.ok(e.ceiling.total.calls > e.expected.total.calls && e.ceiling.total.usd > e.expected.total.usd);
  assert.deepEqual(parsePlayers(' Ana One, Ben Two ,,Ana One'), ['Ana One', 'Ben Two']);
});

const runner = (args: string[]) =>
  spawnSync('npx', ['tsx', join(root, 'scripts/eval-bridge-check.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    // Set empty, so no .env file can fill either key in (see loadEnvFiles).
    env: { ...process.env, EVAL_GEMINI_API_KEY: '', GEMINI_API_KEY: '', API_KEY: '' },
    timeout: 60_000,
  });

await test('the runner refuses to start without the eval key', () => {
  const out = runner(['--players', 'Ana One']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /EVAL_GEMINI_API_KEY is not set/);
  assert.doesNotMatch(out.stdout, /Report:/);
});

await test('the dry run prices the players with no key, and no players is refused', () => {
  const dry = runner(['--dry-run', '--players', 'Ana One,Ben Two']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry run, bridge check: 2 players/);
  assert.match(dry.stdout, /Ceiling: /);
  assert.equal(runner(['--dry-run']).status, 1);
});

// --- The prime order check -----------------------------------------------------------------

await test('the prime order check reports each held prime with its comparisons, and stops at a spending limit', async () => {
  let stop: string | null = null;
  const drafted: string[] = [];
  const { rows, stoppedEarly } = await runPrimeOrder({
    players: ['Ana One', 'Ben Two', 'Cy Three'],
    publishedOverall: async (p) => (p === 'Ana One' ? 90 : null),
    async draft(p) {
      drafted.push(p);
      if (p === 'Ben Two') stop = 'a 429 came back';
      return {
        basicInfo: { name: p, age: 27, nationality: 'N/A', club: 'Club', position: 'Central Midfielder' },
        ratings: { overall: p === 'Ana One' ? 92 : 93, potential: 92 },
        version: { id: p, type: 'prime', label: 'Prime Zenith (2008-10)', evaluationDate: '2010-05-01', seasonOrEra: '2008-10' },
        peerComparisons: [{ peer: 'Peer Maestro (2011-13)', judgment: 'better', reason: 'He found the pass a beat earlier.' }],
        confidence: { grade: 'A', sampleSize: 's', dataGaps: [], verdict: 'Solid.' },
      } as unknown as PlayerProfile;
    },
    stopReason: () => stop,
  });
  assert.deepEqual(drafted, ['Ana One', 'Ben Two']);
  assert.equal(stoppedEarly, 'a 429 came back');
  assert.deepEqual(rows.map((r) => [r.player, r.published, r.draft?.overall]), [['Ana One', 90, 92], ['Ben Two', null, 93]]);
  const md = primeOrderMarkdown({ rows, today: '2026-11-28', model: 'm', stoppedEarly });
  assert.match(md, /Order of the re-rated cards: Ben Two 93, Ana One 92\./);
  assert.match(md, /- better than Peer Maestro \(2011-13\): He found the pass a beat earlier\./);
  assert.match(md, /\*\*Stopped early:\*\* a 429 came back/);
});

await test('the prime order estimate counts a comparison, a synthesis, a trait rewrite and two grounded calls a prime', () => {
  const e = estimatePrimeOrder(5);
  assert.equal(e.expected.total.calls, 1 + 5 * 5);
  assert.equal(e.ceiling.total.calls, 1 + 5 * 7);
  assert.equal(e.expected.total.grounded, 10);
});

const primeRunner = (args: string[]) =>
  spawnSync('npx', ['tsx', join(root, 'scripts/eval-prime-order.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, EVAL_GEMINI_API_KEY: '', GEMINI_API_KEY: '', API_KEY: '' },
    timeout: 60_000,
  });

await test('the prime order runner refuses to start without the eval key, and its dry run needs none', () => {
  const out = primeRunner(['--players', 'Ana One']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /EVAL_GEMINI_API_KEY is not set/);
  const dry = primeRunner(['--dry-run', '--players', 'Ana One,Ben Two']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry run, prime order check: 2 primes/);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
