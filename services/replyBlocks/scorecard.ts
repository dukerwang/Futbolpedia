import type { GaffaTradeScorecard, ReadyBlock } from '../../types';
import { formatScorecardCopy } from '../gaffaScorecardText';
import { readyBlock, type BlockEntry } from './entry';

export const scorecardBlock = (id: string, card: GaffaTradeScorecard): ReadyBlock<'scorecard'> => readyBlock('scorecard', id, card);

/** The Gaffa trade scorecard that heads a trade reply. */
export const scorecardEntry: BlockEntry<'scorecard'> = {
  kind: 'scorecard',
  async build(card, ctx) {
    if (!card?.verdict) return { error: 'No scorecard to show.' };
    return { block: scorecardBlock(ctx.newId(), card) };
  },
  toolResult: () => ({ shown: true }),
  toHistory: ({ data }) => `[shown: trade scorecard, ${data.outgoing} for ${data.incoming}, verdict ${data.verdict}]`,
  toCopy: ({ data }) => formatScorecardCopy(data),
};
