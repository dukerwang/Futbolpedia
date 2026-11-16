import React, { useState } from 'react';
import type { TableRow, TableViewData } from './viewData';
import { CAPTION_TEXT, SkeletonBar, ViewFrame } from './ViewFrame';
import { clubKey, plain, signed } from './viewParts';

/**
 * A league table drawn from the live standings. Columns: position, club, played, goal difference,
 * points, and a five-result form strip when the feed gives one. A competition with groups shows
 * each group under its label. The clubs the reply is about are tinted.
 *
 * On a phone a long table folds to the top four, each highlighted club with a neighbour either
 * side and the bottom three, with a thin gap row where rows are left out. Tapping the table, or
 * its footer, opens the rest. From the `sm` width up the whole table shows.
 */

/** Groups of this many rows or fewer never fold: there's nothing worth hiding. */
const FOLD_MIN_ROWS = 9;
const TOP = 4;
const BOTTOM = 3;

const ROW_H = 'h-8';
const GAP_H = 'h-6';
const HEAD_H = 'h-6';
const FOOT_H = 'h-9';

type Item = { kind: 'row'; row: TableRow; folded: boolean } | { kind: 'gap'; hidden: number; key: string };

interface Section {
  label: string | null;
  items: Item[];
  /** Rows a phone leaves out until the table is opened. */
  hiddenRows: number;
}

/** Which rows of one table a folded phone view keeps, by index. */
export function keptRows(count: number, highlighted: number[]): Set<number> {
  if (count < FOLD_MIN_ROWS) return new Set(Array.from({ length: count }, (_, i) => i));
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(TOP, count); i++) keep.add(i);
  for (let i = Math.max(0, count - BOTTOM); i < count; i++) keep.add(i);
  for (const h of highlighted) for (let i = h - 1; i <= h + 1; i++) if (i >= 0 && i < count) keep.add(i);
  // A gap that would hide one row costs as much as the row: show the row.
  for (let i = 1; i < count - 1; i++) if (!keep.has(i) && keep.has(i - 1) && keep.has(i + 1)) keep.add(i);
  return keep;
}

function sectionsOf(data: TableViewData): Section[] {
  const marked = new Set(data.highlight.map(clubKey));
  const labels = data.groups?.length ? data.groups : [null];
  return labels.map((label) => {
    const rows = data.rows.filter((r) => (label === null ? true : (r.group ?? '') === label));
    const highlighted = rows.flatMap((r, i) => (marked.has(clubKey(r.team)) ? [i] : []));
    const keep = keptRows(rows.length, highlighted);
    const items: Item[] = [];
    let runs = 0;
    rows.forEach((row, i) => {
      const folded = !keep.has(i);
      // A gap row sits before the first row of each run of rows the fold leaves out.
      if (folded && (i === 0 || keep.has(i - 1))) {
        let hidden = 0;
        while (i + hidden < rows.length && !keep.has(i + hidden)) hidden += 1;
        items.push({ kind: 'gap', hidden, key: `gap-${label ?? ''}-${runs++}` });
      }
      items.push({ kind: 'row', row, folded });
    });
    return { label, items, hiddenRows: rows.length - keep.size };
  });
}

/** What a settled table holds, for a skeleton that has to be the same height. */
export function tableSkeletonProps(data: TableViewData): { rows: number; foldedRows: number; foldedGaps: number; groups: number } {
  const sections = sectionsOf(data);
  let foldedRows = 0;
  let foldedGaps = 0;
  for (const s of sections) {
    for (const item of s.items) {
      if (item.kind === 'gap') foldedGaps += 1;
      else if (!item.folded) foldedRows += 1;
    }
  }
  return {
    rows: data.rows.length,
    foldedRows,
    foldedGaps,
    groups: data.groups && data.groups.length > 1 ? data.groups.length : 0,
  };
}

const RESULT_WORD: Record<string, string> = { W: 'win', D: 'draw', L: 'loss' };

const FormStrip: React.FC<{ form: string | null }> = ({ form }) => {
  const results = (form ?? '').toUpperCase().replace(/[^WDL]/g, '').slice(-5).split('').filter(Boolean);
  if (results.length === 0) return null;
  return (
    <span
      role="img"
      aria-label={`Last ${results.length}: ${results.map((r) => RESULT_WORD[r]).join(', ')}`}
      className="inline-flex items-center gap-0.5"
    >
      {results.map((r, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={
            r === 'W'
              ? 'size-2.5 bg-charcoal dark:bg-cream-100'
              : r === 'D'
                ? 'size-2.5 bg-charcoal/30 dark:bg-cream-100/35'
                : 'size-2.5 border border-charcoal/45 dark:border-cream-100/45'
          }
        />
      ))}
    </span>
  );
};

const HEAD_CELL = `${CAPTION_TEXT} font-bold`;

export const LeagueTableView: React.FC<{ data: TableViewData }> = ({ data }) => {
  const [expanded, setExpanded] = useState(false);
  const sections = sectionsOf(data);
  const marked = new Set(data.highlight.map(clubKey));
  const showForm = data.rows.some((r) => (r.form ?? '').trim() !== '');
  const hiddenRows = sections.reduce((n, s) => n + s.hiddenRows, 0);
  const foldable = hiddenRows > 0;
  const folded = foldable && !expanded;
  const labelled = !!data.groups && data.groups.length > 1;
  const colSpan = showForm ? 6 : 5;

  return (
    <ViewFrame kind="table" caption={['Table', data.league, data.season]} label={`${data.league} table${data.season ? `, ${data.season}` : ''}`}>
      <div
        onClick={folded ? () => setExpanded(true) : undefined}
        className={folded ? 'max-sm:cursor-pointer' : undefined}
      >
        <table className="w-full table-fixed border-collapse text-[13px] font-sans text-charcoal dark:text-cream-100">
          <colgroup>
            <col className="w-9" />
            <col />
            <col className="w-8" />
            <col className="w-10" />
            <col className="w-12" />
            {showForm && <col className="w-[4.5rem]" />}
          </colgroup>
          <thead>
            <tr className={`${HEAD_H} border-b border-cream-300 dark:border-charcoal-border`}>
              <th scope="col" className={`${HEAD_CELL} pl-3 text-left font-bold`}>
                <span className="sr-only">Position</span>
                <span aria-hidden="true">#</span>
              </th>
              <th scope="col" className={`${HEAD_CELL} text-left`}>Club</th>
              <th scope="col" className={`${HEAD_CELL} text-right`}>P</th>
              <th scope="col" className={`${HEAD_CELL} text-right`}>GD</th>
              <th scope="col" className={`${HEAD_CELL} text-right ${showForm ? 'pr-2' : 'pr-3'}`}>Pts</th>
              {showForm && <th scope="col" className={`${HEAD_CELL} pr-3 text-right`}>Form</th>}
            </tr>
          </thead>
          {sections.map((section, si) => (
            <tbody key={section.label ?? si}>
              {labelled && (
                <tr className={`${GAP_H} bg-cream-200/60 dark:bg-charcoal/50 border-b border-cream-300 dark:border-charcoal-border`}>
                  <th scope="rowgroup" colSpan={colSpan} className={`${CAPTION_TEXT} px-3 text-left`}>
                    {section.label}
                  </th>
                </tr>
              )}
              {section.items.map((item) => {
                if (item.kind === 'gap') {
                  // Shown on a folded phone only; gone once the table is open and from `sm` up.
                  return (
                    <tr key={item.key} className={`${folded ? '' : 'hidden'} sm:hidden ${GAP_H} border-b border-cream-300/70 dark:border-charcoal-border/70`}>
                      <td colSpan={colSpan} className="px-3 text-center text-[11px] font-mono text-charcoal/45 dark:text-cream-400/55">
                        {`· · ·  ${item.hidden} more`}
                      </td>
                    </tr>
                  );
                }
                const { row } = item;
                const about = marked.has(clubKey(row.team));
                return (
                  <tr
                    key={`${row.group ?? ''}-${row.team}-${row.rank}`}
                    data-highlight={about || undefined}
                    className={`${folded && item.folded ? 'hidden sm:table-row' : ''} ${ROW_H} border-b border-cream-300/70 dark:border-charcoal-border/70 last:border-b-0 ${
                      about ? 'bg-emerald-500/10 dark:bg-emerald-400/10' : ''
                    }`}
                  >
                    <td
                      className={`pl-3 font-mono text-[12px] tabular-nums text-charcoal/60 dark:text-cream-300/70 ${
                        about ? 'shadow-[inset_2px_0_0_#10B981] dark:shadow-[inset_2px_0_0_#34D399]' : ''
                      }`}
                    >
                      {plain(row.rank)}
                    </td>
                    <td className={`pr-2 truncate ${about ? 'font-bold' : 'font-medium'}`}>
                      <span title={row.team}>{row.team}</span>
                    </td>
                    <td className="text-right font-mono text-[12px] tabular-nums text-charcoal/60 dark:text-cream-300/70">{plain(row.played)}</td>
                    <td className="text-right font-mono text-[12px] tabular-nums text-charcoal/60 dark:text-cream-300/70">{signed(row.goalDiff)}</td>
                    <td className={`text-right font-mono text-[13px] tabular-nums font-medium ${showForm ? 'pr-2' : 'pr-3'}`}>{plain(row.points)}</td>
                    {showForm && (
                      <td className="pr-3 text-right">
                        <FormStrip form={row.form} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
      {foldable && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={`sm:hidden ${FOOT_H} w-full flex items-center justify-center gap-1.5 border-t border-cream-300 dark:border-charcoal-border text-[11px] font-sans font-bold uppercase tracking-widest text-charcoal/60 dark:text-cream-400/70`}
        >
          {expanded ? 'Fold table' : `Show all ${data.rows.length} clubs`}
          <span aria-hidden="true" className={`material-symbols-outlined text-[16px] leading-none transition-transform duration-200 ease-out ${expanded ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </button>
      )}
    </ViewFrame>
  );
};

export interface LeagueTableSkeletonProps {
  caption?: Array<string | null | undefined>;
  /** Rows a settled table shows from `sm` up. */
  rows?: number;
  /** Rows a folded phone shows. */
  foldedRows?: number;
  /** Gap rows a folded phone shows. */
  foldedGaps?: number;
  /** Group labels a table with groups shows. */
  groups?: number;
  /** A table with no form column has no footer room to spare; one that can't fold has no footer. */
  foldable?: boolean;
}

/**
 * The table's shape while its feed answers. With the settled table's own counts (`tableSkeletonProps`)
 * it is exactly as tall as the table that replaces it; without them it assumes a 20-club league.
 */
export const LeagueTableSkeleton: React.FC<LeagueTableSkeletonProps> = ({
  caption = ['Table'],
  rows = 20,
  foldedRows = 10,
  foldedGaps = 1,
  groups = 0,
  foldable = true,
}) => (
  <ViewFrame kind="table" pending caption={caption} label="League table, loading">
    <div className={`${HEAD_H} flex items-center border-b border-cream-300 dark:border-charcoal-border px-3`}>
      <SkeletonBar className="h-2 w-24" />
    </div>
    {Array.from({ length: groups }, (_, g) => (
      <div key={`g${g}`} className={`${GAP_H} flex items-center px-3 bg-cream-200/60 dark:bg-charcoal/50 border-b border-cream-300 dark:border-charcoal-border`}>
        <SkeletonBar className="h-2 w-16" />
      </div>
    ))}
    {Array.from({ length: rows }, (_, i) => (
      <div
        key={i}
        className={`${ROW_H} items-center gap-3 px-3 border-b border-cream-300/70 dark:border-charcoal-border/70 last:border-b-0 ${
          i < foldedRows ? 'flex' : 'hidden sm:flex'
        }`}
      >
        <SkeletonBar className="h-2 w-4" />
        <SkeletonBar className="h-2.5 flex-1 max-w-[9rem]" />
        <SkeletonBar className="h-2 w-6 ml-auto" />
      </div>
    ))}
    {Array.from({ length: foldedGaps }, (_, i) => (
      <div key={`gap${i}`} className={`sm:hidden ${GAP_H} border-b border-cream-300/70 dark:border-charcoal-border/70`} />
    ))}
    {foldable && <div className={`sm:hidden ${FOOT_H} border-t border-cream-300 dark:border-charcoal-border`} />}
  </ViewFrame>
);

export default LeagueTableView;
