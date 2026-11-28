/**
 * The bridge check's parts (`scripts/eval-bridge-check.ts`; the plan is
 * docs/superpowers/evals/current-vs-season-bridge.md): rate each active player's last season as a
 * season card through the historical pipeline and compare it with his published current card. A
 * gap in the same direction across players is the pipeline's bias between current and historical
 * cards, measured. Everything it touches is passed in, so `scripts/test-eval-bridge-check.ts` runs
 * it with the model faked. Users never see any of this.
 */
import type { PlayerProfile } from '../types';
import { ASSUMED_PRICES, totalOf, type EstimateComponent, type EstimateTotals, type Prices } from './eval-consistency';

export const BRIDGE_SEASON = '2025-26';

/** `--players "A,B"`: the players to bridge, in order, once each. */
export const parsePlayers = (value: string | undefined): string[] => [
  ...new Set((value ?? '').split(',').map((p) => p.trim()).filter(Boolean)),
];

/**
 * Per-call token counts, thinking included. The synthesis input was sized on 2026-11-27 from the
 * real prompt: system instruction 38k characters, schema 13k, the whole-library ledger 31k (209
 * served cards) and the closest peers 17k, plus the season's career record, search digest and card
 * instructions, at about four characters a token. The rest is modelled.
 */
const CALLS = {
  identity: { input: 300, output: 600 },
  search: { input: 1_500, output: 1_500 },
  synthesis: { input: 29_000, output: 6_000 },
  traits: { input: 5_000, output: 1_800 },
};

const component = (name: string, calls: number, per: { input: number; output: number }, grounded = 0): EstimateComponent => ({
  name,
  calls,
  inputTokens: calls * per.input,
  outputTokens: calls * per.output,
  grounded,
});

export interface BridgeEstimate {
  expected: { components: EstimateComponent[]; total: EstimateTotals };
  /** Every card failing validation once and every grounded call running four searches. */
  ceiling: { components: EstimateComponent[]; total: EstimateTotals };
  prices: Prices;
}

export function estimateBridge(players: number, prices: Prices = ASSUMED_PRICES): BridgeEstimate {
  const parts = (synthesesEach: number, searchesPerGrounded: number): EstimateComponent[] => [
    component('Cap check', 1, { input: 10, output: 1 }),
    component('Player identity (grounded)', players, CALLS.identity, players * searchesPerGrounded),
    component('Season web search (grounded)', players, CALLS.search, players * searchesPerGrounded),
    component('Season card synthesis', players * synthesesEach, CALLS.synthesis),
    component('Strengths and weaknesses rewrite', players, CALLS.traits),
  ];
  const [expected, ceiling] = [parts(1, 1), parts(2, 4)];
  return {
    expected: { components: expected, total: totalOf(expected, prices) },
    ceiling: { components: ceiling, total: totalOf(ceiling, prices) },
    prices,
  };
}

export function formatBridgeEstimate(e: BridgeEstimate, players: string[], season: string): string {
  const row = (c: EstimateComponent) => `  ${c.name}: ${c.calls} calls, ${c.inputTokens} in, ${c.outputTokens} out, ${c.grounded} searches`;
  const total = (name: string, t: EstimateTotals) =>
    `${name}: ${t.calls} calls, ${t.inputTokens} input tokens, ${t.outputTokens} output tokens, ${t.grounded} searches, about $${t.usd.toFixed(2)}`;
  return [
    `Dry run, bridge check: ${players.length} players (${players.join(', ')}), ${season} as a season card each. No call is made.`,
    ...e.expected.components.map(row),
    total('Expected', e.expected.total),
    total('Ceiling', e.ceiling.total),
    `Prices are placeholders: $${e.prices.inputPerMillion} per million input tokens, $${e.prices.outputPerMillion} per million output tokens, $${e.prices.perGroundedSearch} per search.`,
  ].join('\n');
}

/** A player's published current card, as the comparison reads it. */
export interface BridgeCurrentCard {
  name: string;
  overall: number;
  evaluated: string | null;
  formWindow: { from: string; to: string } | null;
}

export interface BridgeRow {
  player: string;
  current: BridgeCurrentCard | null;
  season: { overall: number; position: string; peerPlacement: PlayerProfile['peerPlacement'] | null } | null;
  /** Season Overall minus current Overall: positive means the historical pipeline rated him higher. */
  gap: number | null;
  /** Why there's no comparison. */
  note?: string;
}

export interface BridgeSummary {
  compared: number;
  seasonHigher: number;
  level: number;
  seasonLower: number;
  meanGap: number | null;
  medianGap: number | null;
}

export function summarizeBridge(rows: BridgeRow[]): BridgeSummary {
  const gaps = rows.flatMap((r) => (r.gap === null ? [] : [r.gap])).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return {
    compared: gaps.length,
    seasonHigher: gaps.filter((g) => g > 0).length,
    level: gaps.filter((g) => g === 0).length,
    seasonLower: gaps.filter((g) => g < 0).length,
    meanGap: gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 100) / 100 : null,
    medianGap: gaps.length ? (gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2) : null,
  };
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export function bridgeMarkdown(args: { rows: BridgeRow[]; season: string; today: string; model: string; stoppedEarly?: string; usage?: string }): string {
  const s = summarizeBridge(args.rows);
  const placement = (p: PlayerProfile['peerPlacement'] | null | undefined) =>
    p ? `above ${p.betterThan.join(', ') || 'nobody'}; level with ${p.levelWith.join(', ') || 'nobody'}; below ${p.notAsGoodAs.join(', ') || 'nobody'}` : 'none';
  return [
    `# Bridge Check, ${args.today}`,
    '',
    `Each player's ${args.season} season, rated by \`${args.model}\` through the historical pipeline with none of his own cards in view and nothing published, beside his published current card. The gap is the season Overall minus the current Overall.`,
    ...(args.stoppedEarly ? ['', `**Stopped early:** ${args.stoppedEarly}`] : []),
    '',
    '| Player | Current | Rated | Form window | Season | Gap |',
    '| --- | --- | --- | --- | --- | --- |',
    ...args.rows.map((r) =>
      `| ${r.player} | ${r.current?.overall ?? ''} | ${r.current?.evaluated ?? ''} | ${r.current ? (r.current.formWindow ? `${r.current.formWindow.from} to ${r.current.formWindow.to}` : 'not recorded') : ''} | ${r.season?.overall ?? r.note ?? ''} | ${r.gap === null ? '' : signed(r.gap)} |`,
    ),
    '',
    `Compared: ${s.compared}. Season higher: ${s.seasonHigher}, level: ${s.level}, season lower: ${s.seasonLower}. Mean gap: ${s.meanGap === null ? 'none' : signed(s.meanGap)}. Median gap: ${s.medianGap === null ? 'none' : signed(s.medianGap)}.`,
    '',
    '## Placements',
    '',
    ...args.rows.filter((r) => r.season).map((r) => `- ${r.player} (${args.season}): ${placement(r.season!.peerPlacement)}`),
    ...(args.usage ? ['', args.usage] : []),
    '',
  ].join('\n');
}

export interface BridgeDeps {
  players: string[];
  season: string;
  /** His published current card, whether or not its window is still open; null when he has none. */
  currentCard(player: string): Promise<BridgeCurrentCard | null>;
  /** The blind season draft (`draftBlindSeason`): a card, or the pipeline's message. */
  draft(player: string, season: string): Promise<string | PlayerProfile>;
  /** Why the run has to stop once a 429 or spending-cap error has come back; null while it can go on. */
  stopReason(): string | null;
  /** Called after each player, so a run cut short keeps what it finished. */
  onUpdate?(rows: BridgeRow[], stoppedEarly?: string): void;
}

/** Runs the players one at a time. A player with no current card costs no model call. */
export async function runBridge(deps: BridgeDeps): Promise<{ rows: BridgeRow[]; stoppedEarly?: string }> {
  const rows: BridgeRow[] = [];
  const stopped = () => deps.stopReason() ?? undefined;
  for (const player of deps.players) {
    if (stopped()) break;
    const current = await deps.currentCard(player);
    let row: BridgeRow = { player, current, season: null, gap: null };
    if (!current) {
      row.note = 'no published current card, so nothing was rated';
    } else {
      try {
        const card = await deps.draft(current.name, deps.season);
        if (typeof card === 'string') row.note = `no card: ${card.slice(0, 160)}`;
        else if (card.version?.type !== 'season_snapshot') row.note = `the draft was a ${card.version?.type ?? 'unversioned'} card, not a season card`;
        else {
          row = {
            ...row,
            season: { overall: card.ratings.overall, position: card.basicInfo.position, peerPlacement: card.peerPlacement ?? null },
            gap: card.ratings.overall - current.overall,
          };
        }
      } catch (e) {
        row.note = `failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
      }
    }
    rows.push(row);
    deps.onUpdate?.(rows, stopped());
  }
  const stoppedEarly = stopped();
  return { rows, ...(stoppedEarly ? { stoppedEarly } : {}) };
}
