import type { ReadyBlock } from '../../types';
import type { ChatDossierRef, PlayerProfile } from '../../types';
import { toChatDossierRef } from '../dossierRefs';
import { BLOCK_TEXT } from './blockText';
import { readyBlock, type BlockEntry } from './entry';

export const cardBlock = (id: string, dossier: ChatDossierRef): ReadyBlock<'card'> => readyBlock('card', id, dossier);
export const cardBlockOf = (id: string, profile: PlayerProfile): ReadyBlock<'card'> => cardBlock(id, toChatDossierRef(profile));

/** A dossier card under the reply. Code and the model's `show_dossier` add it; it has no tool of its own here. */
export const cardEntry: BlockEntry<'card'> = {
  kind: 'card',
  async build({ profile }, ctx) {
    if (!profile?.basicInfo?.name) return { error: 'No card to show.' };
    return { block: cardBlockOf(ctx.newId(), profile) };
  },
  toolResult: () => ({ shown: true }),
  ...BLOCK_TEXT.card,
};
