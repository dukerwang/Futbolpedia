import { Type } from '@google/genai';
import type { PlayerProfile, ReadyBlock } from '../../types';
import { isGoalkeeperSide, type ComparisonSide, type ComparisonViewData } from '../../components/views/viewData';
import { getCardKey } from '../dossierCards';
import { toChatDossierRef } from '../dossierRefs';
import type { DossierLookup } from '../dossierLookup';
import { BLOCK_TEXT, sideNumbers } from './blockText';
import { readyBlock, type BlockEntry } from './entry';

export const comparisonBlock = (id: string, data: ComparisonViewData): ReadyBlock<'comparison'> => readyBlock('comparison', id, data);

/** One card as a comparison side. A goalkeeper's card carries his goalkeeper attributes. */
export const sideOf = (card: PlayerProfile): ComparisonSide => {
  const gk = card.goalkeeperAttributes && Object.keys(card.goalkeeperAttributes).length > 0;
  return {
    dossier: toChatDossierRef(card),
    ...(gk ? { goalkeeperAttributes: card.goalkeeperAttributes } : { attributes: card.attributes }),
  };
};

/** The reason a lookup gave no card, in words the model can act on. */
export function lookupFailure(name: string, found: DossierLookup, toolHint: string): string | null {
  if (found.status === 'found') return null;
  if (found.status === 'ambiguous') return `"${name}" matches several rated players (${found.names.join(', ')}); name the one you mean.`;
  return `No stored card for ${name}, so nothing is drawn. ${toolHint}`;
}

/** Two stored cards side by side. Never rates anyone: a player with no card is an error the model can offer a rating for. */
export const comparisonEntry: BlockEntry<'comparison'> = {
  kind: 'comparison',
  tool: {
    name: 'show_comparison',
    description:
      "Draws two players' stored dossier cards side by side in the reply: Overall and Potential, then their attributes in the card's own groups, from the cards and never from your memory. Use it when a point sets two carded players against each other, and call it where the reader needs the comparison in your argument. A player with no card can't be drawn; the result says so. Free: it doesn't count against your lookups.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        playerA: { type: Type.STRING, description: "The first player's name." },
        playerB: { type: Type.STRING, description: "The second player's name." },
        edition: {
          type: Type.STRING,
          enum: ['current', 'prime'],
          description: 'The version of both players to draw. Left out, each player is drawn in the version this conversation discusses him in, else his current form.',
        },
      },
      required: ['playerA', 'playerB'],
    },
  },
  hint: () => ({}),

  async build({ playerA, playerB, edition }, ctx) {
    if (!playerA?.trim() || !playerB?.trim()) return { error: 'Name both players.' };
    if (!ctx.cards) return { error: 'No card lookup is available for this reply.' };
    const [a, b] = await Promise.all([ctx.cards.lookUp(playerA.trim(), edition), ctx.cards.lookUp(playerB.trim(), edition)]);
    const hint = 'Say so in your answer, or call offer_rating for him where that tool is on.';
    const failure = lookupFailure(playerA.trim(), a, hint) ?? lookupFailure(playerB.trim(), b, hint);
    if (failure || a.status !== 'found' || b.status !== 'found') return { error: failure ?? 'No cards to compare.' };
    if (getCardKey(a.card) === getCardKey(b.card)) return { error: 'Both names are the same card; name two different cards.' };
    return { block: comparisonBlock(ctx.newId(), { a: sideOf(a.card), b: sideOf(b.card) }) };
  },

  toolResult: ({ data }) => {
    const mixed = isGoalkeeperSide(data.a) !== isGoalkeeperSide(data.b);
    return {
      shown: true,
      ...(mixed ? { note: "One is a goalkeeper and one isn't: the view shows their headline numbers and archetypes only, since their attributes don't share a scale." } : {}),
      a: sideNumbers(data.a, !mixed),
      b: sideNumbers(data.b, !mixed),
    };
  },
  ...BLOCK_TEXT.comparison,
};
