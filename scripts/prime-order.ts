/**
 * The prime order check's parts (`scripts/eval-prime-order.ts`; the plan is in
 * docs/superpowers/specs/2026-11-28-comparison-first-rating-design.md): re-rate a handful of primes
 * at one position, held and never published, and set each new card's comparisons, range and
 * Overall beside his published prime, so a person can judge the order. Everything it touches is
 * passed in, so `scripts/test-eval-bridge-check.ts` runs it with the model faked.
 */
import type { PeerComparison, PlayerProfile } from '../types';
import { CALLS, component } from './bridge-check';
import { ASSUMED_PRICES, totalOf, type EstimateComponent, type EstimateTotals, type Prices } from './eval-consistency';

export interface PrimeOrderEstimate {
  expected: { components: EstimateComponent[]; total: EstimateTotals };
  /** Every comparison sending a reason back, every card failing validation once, four searches per grounded call. */
  ceiling: { components: EstimateComponent[]; total: EstimateTotals };
  prices: Prices;
}

export function estimatePrimeOrder(players: number, prices: Prices = ASSUMED_PRICES): PrimeOrderEstimate {
  const parts = (comparisonsEach: number, synthesesEach: number, searchesPerGrounded: number): EstimateComponent[] => [
    component('Cap check', 1, { input: 10, output: 1 }),
    component('Player identity (grounded)', players, CALLS.identity, players * searchesPerGrounded),
    component('Prime web search (grounded)', players, CALLS.search, players * searchesPerGrounded),
    component('Head-to-head comparison', players * comparisonsEach, CALLS.comparison),
    component('Prime card synthesis', players * synthesesEach, CALLS.synthesis),
    component('Strengths and weaknesses rewrite', players, CALLS.traits),
  ];
  const [expected, ceiling] = [parts(1, 1, 1), parts(2, 2, 4)];
  return {
    expected: { components: expected, total: totalOf(expected, prices) },
    ceiling: { components: ceiling, total: totalOf(ceiling, prices) },
    prices,
  };
}

export function formatPrimeOrderEstimate(e: PrimeOrderEstimate, players: string[]): string {
  const row = (c: EstimateComponent) => `  ${c.name}: ${c.calls} calls, ${c.inputTokens} in, ${c.outputTokens} out, ${c.grounded} searches`;
  const total = (name: string, t: EstimateTotals) =>
    `${name}: ${t.calls} calls, ${t.inputTokens} input tokens, ${t.outputTokens} output tokens, ${t.grounded} searches, about $${t.usd.toFixed(2)}`;
  return [
    `Dry run, prime order check: ${players.length} primes re-rated and held (${players.join(', ')}). No call is made.`,
    ...e.expected.components.map(row),
    total('Expected', e.expected.total),
    total('Ceiling', e.ceiling.total),
    `Prices are placeholders: $${e.prices.inputPerMillion} per million input tokens, $${e.prices.outputPerMillion} per million output tokens, $${e.prices.perGroundedSearch} per search.`,
  ].join('\n');
}

export interface PrimeOrderRow {
  player: string;
  /** His published prime's Overall, when he has one. */
  published: number | null;
  draft: {
    overall: number;
    window: string | null;
    comparisons: PeerComparison[];
    verdict: string | null;
    placement: PlayerProfile['peerPlacement'] | null;
  } | null;
  note?: string;
}

export interface PrimeOrderDeps {
  players: string[];
  publishedOverall(player: string): Promise<number | null>;
  /** The held prime rerate (`draftPrimeRerate`): a card, or the pipeline's message. */
  draft(player: string): Promise<string | PlayerProfile>;
  stopReason(): string | null;
  onUpdate?(rows: PrimeOrderRow[], stoppedEarly?: string): void;
}

/** Re-rates the primes one at a time, stopping at the first 429 or spending-cap error. */
export async function runPrimeOrder(deps: PrimeOrderDeps): Promise<{ rows: PrimeOrderRow[]; stoppedEarly?: string }> {
  const rows: PrimeOrderRow[] = [];
  const stopped = () => deps.stopReason() ?? undefined;
  for (const player of deps.players) {
    if (stopped()) break;
    const row: PrimeOrderRow = { player, published: await deps.publishedOverall(player), draft: null };
    try {
      const card = await deps.draft(player);
      if (typeof card === 'string') row.note = `no card: ${card.slice(0, 160)}`;
      else if (card.version?.type !== 'prime') row.note = `the draft was a ${card.version?.type ?? 'unversioned'} card, not a prime`;
      else
        row.draft = {
          overall: card.ratings.overall,
          window: card.version?.seasonOrEra ?? null,
          comparisons: card.peerComparisons ?? [],
          verdict: card.confidence?.verdict ?? null,
          placement: card.peerPlacement ?? null,
        };
    } catch (e) {
      row.note = `failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
    }
    rows.push(row);
    deps.onUpdate?.(rows, stopped());
  }
  const stoppedEarly = stopped();
  return { rows, ...(stoppedEarly ? { stoppedEarly } : {}) };
}

const WORDS: Record<PeerComparison['judgment'], string> = { better: 'better than', level: 'level with', not_as_good: 'not as good as' };

export function primeOrderMarkdown(args: { rows: PrimeOrderRow[]; today: string; model: string; stoppedEarly?: string; usage?: string }): string {
  const ordered = [...args.rows].filter((r) => r.draft).sort((a, b) => b.draft!.overall - a.draft!.overall);
  return [
    `# Prime Order Check, ${args.today}`,
    '',
    `Each prime re-rated by \`${args.model}\` with his own cards out of view, held and never published. Read the reasons first: every one should be football.`,
    ...(args.stoppedEarly ? ['', `**Stopped early:** ${args.stoppedEarly}`] : []),
    '',
    '| Player | Window | Published | Re-rated |',
    '| --- | --- | --- | --- |',
    ...args.rows.map((r) => `| ${r.player} | ${r.draft?.window ?? ''} | ${r.published ?? ''} | ${r.draft?.overall ?? r.note ?? ''} |`),
    '',
    `Order of the re-rated cards: ${ordered.map((r) => `${r.player} ${r.draft!.overall}`).join(', ') || 'none'}.`,
    '',
    '## Comparisons',
    '',
    ...args.rows.flatMap((r) =>
      r.draft
        ? [
            `### ${r.player}`,
            '',
            ...(r.draft.comparisons.length ? r.draft.comparisons.map((c) => `- ${WORDS[c.judgment]} ${c.peer}: ${c.reason}`) : ['- No comparison stood.']),
            ...(r.draft.verdict ? ['', `Confidence: ${r.draft.verdict}`] : []),
            '',
          ]
        : [],
    ),
    ...(args.usage ? [args.usage, ''] : []),
  ].join('\n');
}
