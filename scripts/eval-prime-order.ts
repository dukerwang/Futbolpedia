#!/usr/bin/env npx tsx
/**
 * The prime order check: re-rate a handful of primes at one position, held and never published, and
 * report each one's head-to-head comparisons, range and Overall. Read
 * docs/superpowers/specs/2026-11-28-comparison-first-rating-design.md first: it spends the eval
 * project's Gemini budget and needs the user's approval. It reads the shared cards through a
 * read-only client, publishes nothing, and refuses to start without EVAL_GEMINI_API_KEY
 * (scripts/eval-guard.ts).
 *
 * Usage:
 *   npx tsx scripts/eval-prime-order.ts --dry-run --players "Name One,Name Two"
 *   npx tsx scripts/eval-prime-order.ts --players "Name One,Name Two" [--label x] [--use-app-key] [--fresh-search]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlayers } from './bridge-check';
import { estimatePrimeOrder, formatPrimeOrderEstimate, primeOrderMarkdown, runPrimeOrder, type PrimeOrderRow } from './prime-order';
import { EvalKeyError, finishRun, loadEnvFiles, parseEvalFlags, resolveEvalKey, startEvalSessionOrExit, usageSection } from './eval-guard';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag: string) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
const players = parsePlayers(argValue('--players'));
const label = (argValue('--label') ?? 'primes').replace(/[^a-z0-9-]+/gi, '-');
const flags = parseEvalFlags(args);

if (!players.length) {
  console.error('Pass --players "Name One,Name Two": the primes to re-rate.');
  process.exit(1);
}
if (flags.dryRun) {
  console.log(formatPrimeOrderEstimate(estimatePrimeOrder(players.length), players));
  process.exit(0);
}

// No key, no run: said before anything is read or sent.
loadEnvFiles(root);
try {
  resolveEvalKey(process.env, flags);
} catch (e) {
  if (!(e instanceof EvalKeyError)) throw e;
  console.error(e.message);
  process.exit(1);
}

// The read-only Supabase client goes in before any app module loads (see eval-live-questions.ts):
// the cards are read, and nothing the run does can write them.
const history = await import('./eval-history');
history.installReadOnlySupabase();
if (!(await history.sharedCardsLoaded())) {
  console.error('The shared cards did not load. Nothing was asked.');
  process.exit(1);
}
const { supabase } = await import('../services/dossierCache');
const { readCardRows, servedHistorical } = await import('../services/cardReview');
const { toBasePlayerSlug } = await import('../services/dossierCards');
const primes = new Map(
  servedHistorical(await readCardRows(supabase))
    .filter((r) => r.card.version?.type === 'prime')
    .map((r) => [toBasePlayerSlug(r.card.basicInfo.name), r.card]),
);

// Everything below makes model calls: the key, the cap check and the usage count come first.
const session = await startEvalSessionOrExit(flags, root);

// The history route a prime's research reads, served in-process; the other app routes answer as
// unavailable, as in the bridge check.
const { createHistoryFootball } = await import('../services/historyFootball');
const { getRealWorldFootballSeason } = await import('../prompts/scoutCore');
const realFetch = globalThis.fetch;
const kept = new Map<string, any>();
const pastSeasons = createHistoryFootball({
  getJson: async (url) => {
    const res = await realFetch(url, { headers: { 'User-Agent': 'Futbolpedia-eval/3.6 (https://github.com/dukerwang/Futbolpedia)', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  store: { get: async (k) => kept.get(k), set: async (k, v) => void kept.set(k, v) },
  currentSeasonStart: () => getRealWorldFootballSeason().seasonStartYear,
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.startsWith('/api/history/player')) return json(await pastSeasons.playerCareer(new URL(url, 'http://local').searchParams.get('name') ?? ''));
  if (url.startsWith('/api/')) return json({ error: 'not available in the eval runner' }, 404);
  return realFetch(input, init);
}) as typeof fetch;

const { draftPrimeRerate } = await import('../services/geminiService');
const { FLASH_MODEL } = await import('../services/aiClient');

const reportsDir = join(root, 'docs/superpowers/evals/reports');
mkdirSync(reportsDir, { recursive: true });
const now = new Date();
const today = now.toISOString().slice(0, 10);
const base = join(reportsDir, `${today}-${now.toISOString().slice(11, 16).replace(':', '')}-prime-order-${label}`);
const write = (rows: PrimeOrderRow[], stoppedEarly?: string) => {
  const usage = usageSection(session.tally, []);
  writeFileSync(`${base}.md`, primeOrderMarkdown({ rows, today, model: FLASH_MODEL, stoppedEarly, usage }));
  writeFileSync(`${base}.json`, JSON.stringify({ model: FLASH_MODEL, rows, usage: session.tally.total(), stoppedEarly }, null, 2));
};

const { rows, stoppedEarly } = await runPrimeOrder({
  players,
  publishedOverall: async (player) => primes.get(toBasePlayerSlug(player))?.ratings.overall ?? null,
  draft: (player) => draftPrimeRerate(primes.get(toBasePlayerSlug(player))?.basicInfo.name ?? player, ''),
  stopReason: session.stopReason,
  onUpdate: write,
});
write(rows, stoppedEarly);
console.log(`Report: ${base}.md`);
finishRun(session);
process.exit(process.exitCode ?? 0);
