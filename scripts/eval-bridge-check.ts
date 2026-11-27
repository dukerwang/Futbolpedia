#!/usr/bin/env npx tsx
/**
 * The bridge check: last season as a season card against each player's current card. Read
 * docs/superpowers/evals/current-vs-season-bridge.md first: it spends the eval project's Gemini
 * budget and needs the user's approval. It reads the shared cards through a read-only client,
 * publishes nothing, and refuses to start without EVAL_GEMINI_API_KEY (scripts/eval-guard.ts).
 *
 * Usage:
 *   npx tsx scripts/eval-bridge-check.ts --dry-run --players "Name One,Name Two"
 *   npx tsx scripts/eval-bridge-check.ts --players "Name One,Name Two" [--season 2025-26] [--label x]
 *     [--use-app-key] [--fresh-search]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_SEASON, bridgeMarkdown, estimateBridge, formatBridgeEstimate, parsePlayers, runBridge, summarizeBridge, type BridgeRow } from './bridge-check';
import { EvalKeyError, finishRun, loadEnvFiles, parseEvalFlags, resolveEvalKey, startEvalSessionOrExit, usageSection } from './eval-guard';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag: string) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
const players = parsePlayers(argValue('--players'));
const season = argValue('--season') ?? BRIDGE_SEASON;
const label = (argValue('--label') ?? 'bridge').replace(/[^a-z0-9-]+/gi, '-');
const flags = parseEvalFlags(args);

if (!players.length) {
  console.error('Pass --players "Name One,Name Two": the players to bridge (see docs/superpowers/evals/current-vs-season-bridge.md).');
  process.exit(1);
}
if (flags.dryRun) {
  console.log(formatBridgeEstimate(estimateBridge(players.length), players, season));
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
const { readCardRows, currentPointers } = await import('../services/cardReview');
const { toBasePlayerSlug, getDossierEvaluationDate } = await import('../services/dossierCards');
const current = new Map(currentPointers(await readCardRows(supabase)).map((r) => [toBasePlayerSlug(r.card.basicInfo.name), r.card]));

// Everything below makes model calls: the key, the cap check and the usage count come first.
const session = await startEvalSessionOrExit(flags, root);

// The history route the season research reads, served in-process; the other app routes answer as
// unavailable, as in the live eval.
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

const { draftBlindSeason } = await import('../services/geminiService');
const { FLASH_MODEL } = await import('../services/aiClient');

const reportsDir = join(root, 'docs/superpowers/evals/reports');
mkdirSync(reportsDir, { recursive: true });
const now = new Date();
const today = now.toISOString().slice(0, 10);
const base = join(reportsDir, `${today}-${now.toISOString().slice(11, 16).replace(':', '')}-bridge-${label}`);
const write = (rows: BridgeRow[], stoppedEarly?: string) => {
  const usage = usageSection(session.tally, []);
  writeFileSync(`${base}.md`, bridgeMarkdown({ rows, season, today, model: FLASH_MODEL, stoppedEarly, usage }));
  writeFileSync(`${base}.json`, JSON.stringify({ season, model: FLASH_MODEL, rows, summary: summarizeBridge(rows), usage: session.tally.total(), stoppedEarly }, null, 2));
};

const { rows, stoppedEarly } = await runBridge({
  players,
  season,
  async currentCard(player) {
    const card = current.get(toBasePlayerSlug(player));
    return card
      ? { name: card.basicInfo.name, overall: card.ratings.overall, evaluated: getDossierEvaluationDate(card), formWindow: card.version?.formWindow ?? null }
      : null;
  },
  draft: (player, wanted) => draftBlindSeason(player, wanted),
  stopReason: session.stopReason,
  onUpdate: write,
});
write(rows, stoppedEarly);
console.log(`Report: ${base}.md`);
finishRun(session);
process.exit(process.exitCode ?? 0);
