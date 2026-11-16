import type { ReadyBlock, ReplyBlock, ReplyBlockKind } from '../../types';
import type { BlockEntry } from './entry';
import { askEntry } from './ask';
import { cardEntry } from './card';
import { goDeeperEntry } from './goDeeper';
import { pitchEntry } from './pitch';
import { proseEntry } from './prose';
import { scorecardEntry } from './scorecard';
import { scoutOfferEntry } from './scoutOffer';

/** One entry per kind. A new kind is one line in `ReplyBlockData` and one entry here. */
export const REPLY_BLOCKS: { [K in ReplyBlockKind]: BlockEntry<K> } = {
  pitch: pitchEntry,
  card: cardEntry,
  scoutOffer: scoutOfferEntry,
  ask: askEntry,
  goDeeper: goDeeperEntry,
  scorecard: scorecardEntry,
};

const entryOf = (block: ReadyBlock): BlockEntry<ReplyBlockKind> => REPLY_BLOCKS[block.kind] as BlockEntry<ReplyBlockKind>;

/** The Gemini declarations of every kind the model can call. */
export const viewToolDeclarations = () =>
  Object.values(REPLY_BLOCKS).flatMap((e) => (e.tool ? [e.tool] : []));

/** A stub of a block for the model's view of an earlier reply ('' for nothing). */
export function blockHistory(block: ReplyBlock): string {
  if (block.kind === 'prose') return proseEntry.toHistory(block);
  return block.status === 'ready' ? entryOf(block as ReadyBlock).toHistory(block as ReadyBlock) : '';
}

/** A block as plain text for Copy and Share ('' for nothing). */
export function blockCopy(block: ReplyBlock): string {
  if (block.kind === 'prose') return proseEntry.toCopy(block);
  return block.status === 'ready' ? entryOf(block as ReadyBlock).toCopy(block as ReadyBlock) : '';
}

/** The text of a reply's blocks for Copy and Share, in order. */
export const copyTextOf = (blocks: ReplyBlock[]): string =>
  blocks.map(blockCopy).filter(Boolean).join('\n\n');

export { proseEntry };
