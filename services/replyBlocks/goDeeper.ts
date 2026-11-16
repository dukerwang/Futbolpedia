import type { GoDeeper, ReadyBlock } from '../../types';
import { readyBlock, type BlockEntry } from './entry';

export const goDeeperBlock = (id: string, goDeeper: GoDeeper): ReadyBlock<'goDeeper'> => readyBlock('goDeeper', id, goDeeper);

/** The chip that reruns the question in deep mode. */
export const goDeeperEntry: BlockEntry<'goDeeper'> = {
  kind: 'goDeeper',
  async build(goDeeper, ctx) {
    if (!goDeeper?.reason?.trim()) return { error: 'Give the reason in one sentence.' };
    return { block: goDeeperBlock(ctx.newId(), { reason: goDeeper.reason.trim() }) };
  },
  toolResult: () => ({ flagged: true }),
  // A chip is an affordance, not something the reader read.
  toHistory: () => '',
  toCopy: () => '',
};
