import type { ReadyBlock } from '../../types';
import { readyBlock, type BlockEntry } from './entry';

export const scoutOfferBlock = (id: string, name: string): ReadyBlock<'scoutOffer'> => readyBlock('scoutOffer', id, { name });

/** "No dossier on <player>": one tap queues him in Scout. A name starting "prime " offers his prime. */
export const scoutOfferEntry: BlockEntry<'scoutOffer'> = {
  kind: 'scoutOffer',
  async build({ name }, ctx) {
    const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    if (!clean) return { error: 'Missing player name' };
    return { block: scoutOfferBlock(ctx.newId(), clean) };
  },
  toolResult: () => ({ offered: true }),
  toHistory: ({ data }) => `[offered: Scout ${data.name}, who has no card yet]`,
  toCopy: () => '',
};
