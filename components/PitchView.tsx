import React from 'react';
import { PITCH, lineupCaption, placeXI, type LineupView, type PlacedSlot } from '../services/lineupView';

/**
 * A club's first-choice XI drawn on a vertical pitch, attacking upward. Pure and fed by data
 * (`LineupView`): no model calls and no state, so any surface can draw the same XI.
 */

const MAX_OUT_SHOWN = 6;

const { width: W, height: H, inset, discRadius: R } = PITCH;

const PitchMarkings: React.FC = () => {
  const x0 = inset;
  const x1 = W - inset;
  const y0 = inset;
  const y1 = H - inset;
  const mid = W / 2;
  const boxW = 176;
  const boxH = 64;
  const smallW = 80;
  const smallH = 24;
  const line = 'fill-none stroke-emerald-700/45 dark:stroke-emerald-300/30';
  return (
    <g strokeWidth={1.25}>
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={3} className={`${line} fill-emerald-600/[0.14] dark:fill-emerald-400/[0.09]`} />
      <line x1={x0} x2={x1} y1={H / 2} y2={H / 2} className={line} />
      <circle cx={mid} cy={H / 2} r={34} className={line} />
      <rect x={mid - boxW / 2} y={y0} width={boxW} height={boxH} className={line} />
      <rect x={mid - smallW / 2} y={y0} width={smallW} height={smallH} className={line} />
      <rect x={mid - boxW / 2} y={y1 - boxH} width={boxW} height={boxH} className={line} />
      <rect x={mid - smallW / 2} y={y1 - smallH} width={smallW} height={smallH} className={line} />
    </g>
  );
};

const Slot: React.FC<{ slot: PlacedSlot }> = ({ slot }) => (
  <g transform={`translate(${slot.x} ${slot.y})`} data-slot={slot.role}>
    <title>{slot.title}</title>
    {slot.empty ? (
      <circle r={R} strokeWidth={1.5} strokeDasharray="3 3" className="fill-transparent stroke-charcoal/45 dark:stroke-cream-400/60" />
    ) : (
      <circle
        r={R}
        strokeWidth={slot.note ? 2.5 : 0}
        className={`fill-charcoal dark:fill-cream-100 ${slot.note ? 'stroke-amber-500' : 'stroke-transparent'}`}
      />
    )}
    <text
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={slot.empty ? 11 : 7.5}
      className={`font-mono font-medium ${slot.empty ? 'fill-charcoal/60 dark:fill-cream-300/70' : 'fill-cream-50 dark:fill-charcoal'}`}
    >
      {slot.empty ? '?' : slot.roleLabel}
    </text>
    <text
      y={R + 12}
      textAnchor="middle"
      fontSize={PITCH.nameSize}
      className={`font-sans ${slot.empty ? 'fill-charcoal/60 dark:fill-cream-300/70 font-medium' : 'fill-charcoal dark:fill-cream-100 font-semibold'}`}
    >
      {slot.label}
    </text>
    {slot.alt && (
      <text y={R + 23} textAnchor="middle" fontSize={PITCH.altSize} className="font-sans fill-charcoal/60 dark:fill-cream-300/70">
        {slot.alt}
      </text>
    )}
  </g>
);

const OutList: React.FC<{ out: LineupView['out'] }> = ({ out }) => {
  if (out.length === 0) return null;
  const shown = out.slice(0, MAX_OUT_SHOWN);
  return (
    <div className="px-1">
      <p className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/60">Out</p>
      <ul className="mt-1 space-y-0.5">
        {shown.map(o => (
          <li key={o.name} className="text-xs font-sans leading-snug text-charcoal/75 dark:text-cream-200/80 break-words">
            <span className="font-semibold text-charcoal dark:text-cream-100">{o.name}</span>
            {o.note ? <span>{`, ${o.note}`}</span> : null}
          </li>
        ))}
      </ul>
      {out.length > shown.length && (
        <p className="mt-1 text-xs font-sans text-charcoal/50 dark:text-cream-400/60">{`and ${out.length - shown.length} more`}</p>
      )}
    </div>
  );
};

export const PitchFigure: React.FC<{ lineup: LineupView }> = ({ lineup }) => {
  const placed = placeXI(lineup.xi);
  const caption = lineupCaption(lineup);
  return (
    <figure className="min-w-0 flex flex-col gap-2 m-0 border border-cream-300 dark:border-charcoal-border bg-cream-50/70 dark:bg-charcoal-surface/70 p-3">
      <div className="flex items-baseline justify-between gap-3 min-w-0">
        <p className="font-serif font-bold text-base leading-tight text-charcoal dark:text-cream-50 truncate">{lineup.club}</p>
        <p className="shrink-0 text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/60 truncate">{lineup.league}</p>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${lineup.club}: ${caption}`}
        className="w-full h-auto block"
      >
        <PitchMarkings />
        {placed.map(slot => (
          <Slot key={slot.key} slot={slot} />
        ))}
      </svg>
      <figcaption className="text-[11px] font-sans leading-snug text-charcoal/60 dark:text-cream-400/70">{caption}</figcaption>
      <OutList out={lineup.out} />
    </figure>
  );
};

/** One pitch per club: side by side from the small-tablet width up, stacked on a phone. */
export const PitchView: React.FC<{ lineups: LineupView[] }> = ({ lineups }) => {
  if (lineups.length === 0) return null;
  return (
    <div
      data-testid="pitch-view"
      className={`grid gap-3 grid-cols-1 ${lineups.length > 1 ? 'sm:grid-cols-2' : 'max-w-md'}`}
    >
      {lineups.map(lineup => (
        <PitchFigure key={`${lineup.club}-${lineup.asOf}`} lineup={lineup} />
      ))}
    </div>
  );
};

export default PitchView;
