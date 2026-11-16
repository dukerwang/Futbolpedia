import type { GaffaTradeScorecard, GaffaTradeVerdict } from '../types';

export const VERDICT_LABEL: Record<GaffaTradeVerdict, string> = {
  hold: 'Hold',
  lean_hold: 'Lean hold',
  toss_up: 'Toss-up',
  lean_take: 'Lean take',
  take: 'Take',
};

export function cashSuffix(eurM: number | undefined): string {
  return eurM && eurM > 0 ? ` + €${eurM}m` : '';
}

/** A trade scorecard as plain text, for Copy and Share. */
export function formatScorecardCopy(card: GaffaTradeScorecard): string {
  const outCash = cashSuffix(card.outgoing_cash_eur_m);
  const cash = cashSuffix(card.incoming_cash_eur_m);
  return [
    `${VERDICT_LABEL[card.verdict]} · ${card.confidence} confidence`,
    `Replacement ${card.replacement} · Coverage ${card.coverage} · Cash ${card.cash_deployable} · Leverage ${card.starter_leverage}`,
    `${card.outgoing} (${card.outgoing_club})${outCash} → ${card.incoming} (${card.incoming_club})${cash}`,
    card.roster_capacity_note ? `Capacity: ${card.roster_capacity_note}` : '',
    card.what_would_flip ? `Would flip: ${card.what_would_flip}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
