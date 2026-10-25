import React from 'react';
import type { GaffaTradeScorecard, GaffaTradeVerdict } from '../types';

const VERDICT_LABEL: Record<GaffaTradeVerdict, string> = {
  hold: 'Hold',
  lean_hold: 'Lean hold',
  toss_up: 'Toss-up',
  lean_take: 'Lean take',
  take: 'Take',
};

const SCORE_CELLS: Array<{
  label: string;
  hint: string;
  key: 'replacement' | 'coverage' | 'cash_deployable' | 'starter_leverage';
}> = [
  { label: 'Replacement', hint: 'Higher → take', key: 'replacement' },
  { label: 'Coverage', hint: 'Higher → take', key: 'coverage' },
  { label: 'Cash', hint: 'Higher → take', key: 'cash_deployable' },
  { label: 'Leverage', hint: 'Higher → hold', key: 'starter_leverage' },
];

function cashSuffix(eurM: number | undefined): string {
  return eurM && eurM > 0 ? ` + €${eurM}m` : '';
}

function ScoreTicks({ value }: { value: number }) {
  const n = Math.max(1, Math.min(5, Math.round(value)));
  return (
    <div className="flex gap-0.5" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`h-1.5 w-2.5 ${
            i <= n
              ? 'bg-charcoal dark:bg-cream-200'
              : 'bg-charcoal/15 dark:bg-cream-400/20'
          }`}
        />
      ))}
    </div>
  );
}

function ScoreCell({
  label,
  hint,
  value,
}: {
  label: string;
  hint: string;
  value: number;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/50">
          {label}
        </span>
        <span className="font-serif text-sm text-charcoal dark:text-cream-100 tabular-nums">
          {value}/5
        </span>
      </div>
      <ScoreTicks value={value} />
      <p className="mt-1 text-[10px] font-sans uppercase tracking-wide text-charcoal/40 dark:text-cream-400/40">
        {hint}
      </p>
    </div>
  );
}

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

export const GaffaTradeScorecardView: React.FC<{ card: GaffaTradeScorecard }> = ({
  card,
}) => {
  const outCash = cashSuffix(card.outgoing_cash_eur_m);
  const cash = cashSuffix(card.incoming_cash_eur_m);

  const notes = [
    { label: 'Replacement', text: card.replacement_note },
    { label: 'Coverage', text: card.coverage_note },
    { label: 'Cash', text: card.cash_note },
    { label: 'Leverage', text: card.leverage_note },
  ].filter((n) => n.text);

  return (
    <div className="border border-cream-300 dark:border-charcoal-border bg-cream-50/60 dark:bg-charcoal-surface/60 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/50">
            Trade lock
          </span>
          {card.involved_slots && card.involved_slots.length > 0 && (
            <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 bg-charcoal/5 dark:bg-cream-400/10 text-charcoal/60 dark:text-cream-300/70">
              {card.involved_slots.join(' / ')}
            </span>
          )}
        </div>
        <span className="font-serif italic text-charcoal dark:text-cream-100">
          {VERDICT_LABEL[card.verdict]}
          <span className="not-italic font-sans text-[11px] uppercase tracking-wider text-charcoal/45 dark:text-cream-400/45 ml-2">
            {card.confidence} confidence
          </span>
        </span>
      </div>

      <p className="mt-1.5 text-sm font-serif text-charcoal dark:text-cream-100">
        {card.outgoing}
        <span className="text-charcoal/45 dark:text-cream-400/45"> ({card.outgoing_club})</span>
        {outCash}
        <span className="text-charcoal/35 dark:text-cream-400/35"> → </span>
        {card.incoming}
        <span className="text-charcoal/45 dark:text-cream-400/45"> ({card.incoming_club})</span>
        {cash}
      </p>

      {card.roster_capacity_note && (
        <p className="mt-1 text-[11px] font-sans text-charcoal/55 dark:text-cream-300/60">
          {card.roster_capacity_note}
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
        {SCORE_CELLS.map((c) => (
          <ScoreCell key={c.key} label={c.label} hint={c.hint} value={card[c.key]} />
        ))}
      </div>

      {notes.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {notes.map((n) => (
            <li
              key={n.label}
              className="text-[13px] font-sans font-light leading-relaxed text-charcoal/75 dark:text-cream-200/75"
            >
              <span className="font-sans text-[10px] font-bold uppercase tracking-widest text-charcoal/45 dark:text-cream-400/45 mr-2">
                {n.label}
              </span>
              {n.text}
            </li>
          ))}
        </ul>
      ) : null}

      {card.what_would_flip ? (
        <p className="mt-3 text-[13px] font-sans font-light leading-relaxed text-charcoal/75 dark:text-cream-200/75">
          <span className="font-sans text-[10px] font-bold uppercase tracking-widest text-charcoal/45 dark:text-cream-400/45 mr-2">
            Would flip
          </span>
          {card.what_would_flip}
        </p>
      ) : null}
    </div>
  );
};
