import type { ProseBlock } from '../../types';

export const proseBlock = (id: string, text: string): ProseBlock => ({ kind: 'prose', id, text });

/** Prose is the one kind with no status or data: its text is what Copy, history and titles read. */
export const proseEntry = {
  kind: 'prose' as const,
  build: (args: { text: string }, ctx: { newId(): string }): { block: ProseBlock } | { error: string } =>
    args.text?.trim() ? { block: proseBlock(ctx.newId(), args.text) } : { error: 'No text.' },
  toHistory: (block: ProseBlock): string => block.text,
  toCopy: (block: ProseBlock): string => block.text,
};
