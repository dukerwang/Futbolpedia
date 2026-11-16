import type { AskPrompt, ReadyBlock } from '../../types';
import { readyBlock, type BlockEntry } from './entry';

export const askBlock = (id: string, ask: AskPrompt): ReadyBlock<'ask'> => readyBlock('ask', id, ask);

/** The writer's question: its options are chips under the reply (validated by `initiative.ts`). */
export const askEntry: BlockEntry<'ask'> = {
  kind: 'ask',
  async build(ask, ctx) {
    if (!ask?.question || !ask.options?.length) return { error: 'A question needs its options.' };
    return { block: askBlock(ctx.newId(), ask) };
  },
  toolResult: () => ({ asked: true, note: 'Your reply is this question. Write nothing else.' }),
  toHistory: ({ data }) => `[offered replies: ${data.options.join(' | ')}]`,
  toCopy: () => '',
};
