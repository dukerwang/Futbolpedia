import type { GoDeeper, ReadyBlock } from '../../types';
import { BLOCK_TEXT } from './blockText';
import { readyBlock, type BlockEntry } from './entry';

export const goDeeperBlock = (id: string, goDeeper: GoDeeper): ReadyBlock<'goDeeper'> => readyBlock('goDeeper', id, goDeeper);

/**
 * The Go deeper flag of replies written while deep mode was opt-in. Nothing writes one now: the
 * entry stays so stored conversations still read, and `ReplyBody` draws it as nothing, since its
 * only action reran the turn in deep mode, which every eligible turn now takes.
 */
export const goDeeperEntry: BlockEntry<'goDeeper'> = {
  kind: 'goDeeper',
  async build(goDeeper, ctx) {
    if (!goDeeper?.reason?.trim()) return { error: 'Give the reason in one sentence.' };
    return { block: goDeeperBlock(ctx.newId(), { reason: goDeeper.reason.trim() }) };
  },
  toolResult: () => ({ flagged: true }),
  ...BLOCK_TEXT.goDeeper,
};
