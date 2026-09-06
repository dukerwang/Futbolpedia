import React from 'react';
import type { GaffaTradeScorecard, GaffaTradeVerdict } from '../types';

const VERDICT_LABEL: Record<GaffaTradeVerdict, string> = {
  hold: 'Hold',
  lean_hold: 'Lean hold',
  toss_up: 'Toss-up',
  lean_take: 'Lean take',
  take: 'Take',
};

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

function Factor({
  label,
  hint,
  value,
  note,
}: {
  label: string;
  hint: string;
  value: number;
  note: string;
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
      {note ? (
        <p className="mt-1 text-[12px] font-sans font-light leading-snug text-charcoal/70 dark:text-cream-200/70 line-clamp-2">
          {note}
        </p>
      ) : null}
    </div>
  );
}

export function formatScorecardCopy(card: GaffaTradeScorecard): string {
  const cash =
    card.incoming_cash_eur_m > 0 ? ` + €${card.incoming_cash_eur_m}m` : '';
  return [
    `${VERDICT_LABEL[card.verdict]} · ${card.confidence} confidence`,
    `Replacement ${card.replacement} · Coverage ${card.coverage} · Cash ${card.cash_deployable} · Leverage ${card.starter_leverage}`,
    `${card.outgoing} (${card.outgoing_club}) → ${card.incoming} (${card.incoming_club})${cash}`,
    card.what_would_flip ? `Would flip: ${card.what_would_flip}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const GaffaTradeScorecardView: React.FC<{ card: GaffaTradeScorecard }> = ({
  card,
}) => {
  const cash =
    card.incoming_cash_eur_m > 0 ? ` + €${card.incoming_cash_eur_m}m` : '';

  return (
    <div className="border border-cream-300 dark:border-charcoal-border bg-cream-50/60 dark:bg-charcoal-surface/60 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/50">
          Trade lock
        </span>
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
        <span className="text-charcoal/35 dark:text-cream-400/35"> → </span>
        {card.incoming}
        <span className="text-charcoal/45 dark:text-cream-400/45"> ({card.incoming_club})</span>
        {cash}
      </p>

      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Factor
          label="Replacement"
          hint="Higher → take"
          value={card.replacement}
          note={card.replacement_note}
        />
        <Factor
          label="Coverage"
          hint="Higher → take"
          value={card.coverage}
          note={card.coverage_note}
        />
        <Factor
          label="Cash"
          hint="Higher → take"
          value={card.cash_deployable}
          note={card.cash_note}
        />
        <Factor
          label="Leverage"
          hint="Higher → hold"
          value={card.starter_leverage}
          note={card.leverage_note}
        />
      </div>

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
