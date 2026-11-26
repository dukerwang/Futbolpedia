import type { ReplyBlockKind } from '../../types';
import type { BlockEntry } from './entry';
import { askEntry } from './ask';
import { cardEntry } from './card';
import { goDeeperEntry } from './goDeeper';
import { pitchEntry } from './pitch';
import { rankingEntry } from './ranking';
import { comparisonEntry } from './comparison';
import { tableEntry } from './table';
import { proseEntry } from './prose';
import { scorecardEntry } from './scorecard';
import { scoutOfferEntry } from './scoutOffer';

/** One entry per kind. A new kind is one line in `ReplyBlockData` and one entry here. */
export const REPLY_BLOCKS: { [K in ReplyBlockKind]: BlockEntry<K> } = {
  pitch: pitchEntry,
  table: tableEntry,
  comparison: comparisonEntry,
  ranking: rankingEntry,
  card: cardEntry,
  scoutOffer: scoutOfferEntry,
  ask: askEntry,
  goDeeper: goDeeperEntry,
  scorecard: scorecardEntry,
};

/** The Gemini declarations of every kind the model can call. */
export const viewToolDeclarations = () =>
  Object.values(REPLY_BLOCKS).flatMap((e) => (e.tool ? [e.tool] : []));

// Each entry's text lives in `blockText.ts`, which the chat reads without the declarations above.
export { blockCopy, blockHistory, copyTextOf } from './blockText';

export { proseEntry };
