import type { PlayerProfile } from '../types';
import { fetchCardIndex, fetchPublishedCard } from './dossierCache';
import { getCardKey, isPrimeCard, toBasePlayerSlug } from './dossierCards';
import { searchPlayers } from './playerSearch';
import { isFullCard } from './ratingCommand';

/** What chat finds when it looks a player's card up. */
export type DossierLookup =
  | { status: 'found'; card: PlayerProfile }
  /** Several rated players match the name; their names, so the reply can ask which. */
  | { status: 'ambiguous'; names: string[] }
  | { status: 'missing' };

/**
 * Finds the card chat reads for a player it was asked about, in your dossiers or the shared
 * cards: his prime when the turn is about primes, his current form otherwise, and whichever card
 * he has when he lacks that edition. Never rates anything.
 */
export const lookUpDossier = async (
  name: string,
  localCards: PlayerProfile[],
  historical: boolean,
  sharedIndex?: PlayerProfile[],
): Promise<DossierLookup> => {
  const shared = sharedIndex ?? (await fetchCardIndex());
  const matches = searchPlayers(name, localCards, shared, 3);
  if (matches.length === 0) return { status: 'missing' };
  // A surname can match several players; the whole name settles it.
  const exact = matches.find((m) => m.key === toBasePlayerSlug(name));
  const match = exact ?? (matches.length === 1 ? matches[0] : null);
  if (!match) return { status: 'ambiguous', names: matches.map((m) => m.name) };

  const card =
    match.cards.find((c) => isPrimeCard(c) === historical) ?? match.cards[0];
  if (isFullCard(card)) return { status: 'found', card };
  const local = localCards.find((c) => isFullCard(c) && getCardKey(c) === getCardKey(card));
  if (local) return { status: 'found', card: local };
  const published = await fetchPublishedCard(card);
  return published ? { status: 'found', card: published } : { status: 'missing' };
};
