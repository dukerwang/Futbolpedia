import type { ComparisonSide, RankingEntry, TableViewData } from '../../components/views/viewData';
import { isCardedEntry, isGoalkeeperSide } from '../../components/views/viewData';
import { ATTRIBUTE_LABELS, GK_ATTRIBUTE_LABELS } from '../../constants/ratingTiers';
import type { ReadyBlock, ReplyBlock, ReplyBlockKind } from '../../types';
import { formatScorecardCopy } from '../gaffaScorecardText';
import { formatLeagueTable } from '../liveFootball';
import type { BlockEntry } from './entry';
import { proseEntry } from './prose';

/**
 * Each kind's text: the stub later turns read (`toHistory`) and what Copy and Share carry
 * (`toCopy`). It lives apart from the registry's tool declarations and builds, so the chat can
 * draw and copy a stored reply without loading the AI pipeline. Each entry spreads its own.
 */
export type BlockText<K extends ReplyBlockKind> = Pick<BlockEntry<K>, 'toHistory' | 'toCopy'>;

/** The table text the model reads back and Copy carries: the feed's own lines, under a heading. */
export const tableText = (data: TableViewData): string =>
  `${data.league} table${data.season ? `, ${data.season}` : ''}\n${formatLeagueTable(data.rows)}`;

/** A side as one line: headline numbers and, with `withAttributes`, every attribute the card holds. */
export const sideNumbers = (side: ComparisonSide, withAttributes = true): string => {
  const d = side.dossier;
  const attrs = isGoalkeeperSide(side) ? side.goalkeeperAttributes : side.attributes;
  const labels = (isGoalkeeperSide(side) ? GK_ATTRIBUTE_LABELS : ATTRIBUTE_LABELS) as Record<string, string>;
  const list = (withAttributes ? Object.entries(attrs ?? {}) : [])
    .map(([k, v]) => `${labels[k] ?? k} ${v}`)
    .join(', ');
  return `${d.name}${d.versionLabel ? ` (${d.versionLabel})` : ''}: Overall ${d.overall ?? 'n/a'}, Potential ${d.potential ?? 'n/a'}${d.archetype ? `, ${d.archetype}` : ''}${list ? `. ${list}` : ''}`;
};

export const BLOCK_TEXT: { [K in ReplyBlockKind]: BlockText<K> } = {
  pitch: {
    toHistory: ({ data: view }) => `[shown: first-choice XI, ${view.club}${view.formation ? `, ${view.formation}` : ''}]`,
    // Copy has never carried the drawing; the text version arrives with the views that have one.
    toCopy: () => '',
  },
  table: {
    toHistory: ({ data }) => `[shown: ${data.league} table${data.season ? `, ${data.season}` : ''}]`,
    toCopy: ({ data }) => tableText(data),
  },
  comparison: {
    toHistory: ({ data }) =>
      `[shown: comparison of ${data.a.dossier.name} (Overall ${data.a.dossier.overall ?? 'n/a'}) and ${data.b.dossier.name} (Overall ${data.b.dossier.overall ?? 'n/a'})]`,
    toCopy: ({ data }) => `${sideNumbers(data.a, false)}\n${sideNumbers(data.b, false)}`,
  },
  ranking: {
    toHistory: ({ data }) => `[shown: ranking "${data.title}" by ${data.criterion}: ${data.entries.map((e) => e.name).join(', ')}]`,
    toCopy: ({ data }) =>
      `${data.title} (${data.criterion})\n${data.entries
        .map((e: RankingEntry, i) => `${i + 1}. ${e.name}${isCardedEntry(e) && e.overall != null ? ` (${e.overall})` : ''}`)
        .join('\n')}`,
  },
  card: {
    toHistory: ({ data: d }) =>
      `[shown: dossier card, ${d.name}${d.versionLabel ? ` (${d.versionLabel})` : ''}${d.overall != null ? `, Overall ${d.overall}` : ''}]`,
    toCopy: () => '',
  },
  scoutOffer: {
    toHistory: ({ data }) => `[offered: Scout ${data.name}, who has no card yet]`,
    toCopy: () => '',
  },
  ask: {
    toHistory: ({ data }) => `[offered replies: ${data.options.join(' | ')}]`,
    toCopy: () => '',
  },
  goDeeper: {
    // A chip is an affordance, not something the reader read.
    toHistory: () => '',
    toCopy: () => '',
  },
  scorecard: {
    toHistory: ({ data }) => `[shown: trade scorecard, ${data.outgoing} for ${data.incoming}, verdict ${data.verdict}]`,
    toCopy: ({ data }) => formatScorecardCopy(data),
  },
};

const textOf = (block: ReadyBlock): BlockText<ReplyBlockKind> => BLOCK_TEXT[block.kind] as BlockText<ReplyBlockKind>;

/** A stub of a block for the model's view of an earlier reply ('' for nothing). */
export function blockHistory(block: ReplyBlock): string {
  if (block.kind === 'prose') return proseEntry.toHistory(block);
  return block.status === 'ready' ? textOf(block as ReadyBlock).toHistory(block as ReadyBlock) : '';
}

/** A block as plain text for Copy and Share ('' for nothing). */
export function blockCopy(block: ReplyBlock): string {
  if (block.kind === 'prose') return proseEntry.toCopy(block);
  return block.status === 'ready' ? textOf(block as ReadyBlock).toCopy(block as ReadyBlock) : '';
}

/** The text of a reply's blocks for Copy and Share, in order. */
export const copyTextOf = (blocks: ReplyBlock[]): string =>
  blocks.map(blockCopy).filter(Boolean).join('\n\n');
