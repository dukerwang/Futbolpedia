import type { ChatMessage, PlayerProfile } from '../types';
import { fetchCardIndex, fetchPublishedCard } from './dossierCache';
import { cardEdition, getCardKey, isPlayerProfile, isPrimeCard, toBasePlayerSlug } from './dossierCards';
import { collectDossiersFromHistory } from './dossierContext';
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

/** The cards a chat turn reads from: the thread, the conversation's profiles and your dossiers. */
export interface TurnCards {
  history: ChatMessage[];
  conversationProfiles: PlayerProfile[];
  savedDossiers: PlayerProfile[];
}

const isHeldPrime = (card: PlayerProfile): boolean => cardEdition(card) === 'prime' && !card.revision;

/**
 * Swaps every prime card a later re-rating has replaced for the shared card that replaced it, in
 * the thread, the conversation's profiles and your dossiers. A thread or a saved list keeps the
 * card it was given, so after "rerate" the old window and numbers would sit beside the new card
 * and the model would quote both. A personal revision stays as it is; so does a card whose
 * replacement can't be fetched.
 */
export const replaceSupersededPrimes = async (
  cards: TurnCards,
  sharedIndex?: PlayerProfile[],
): Promise<TurnCards> => {
  const held = [
    ...collectDossiersFromHistory(cards.history),
    ...cards.conversationProfiles,
    ...cards.savedDossiers,
  ].filter(isHeldPrime);
  if (held.length === 0) return cards;

  const shared = sharedIndex ?? (await fetchCardIndex());
  const livePrimes = new Map(
    shared
      .filter((c) => cardEdition(c) === 'prime')
      .map((c) => [toBasePlayerSlug(c.basicInfo.name), c] as const),
  );
  const isStale = (card: PlayerProfile): boolean =>
    isHeldPrime(card) &&
    (livePrimes.get(toBasePlayerSlug(card.basicInfo.name))?.rerateAt ?? 0) > (card.rerateAt ?? 0);

  const players = new Set(held.filter(isStale).map((c) => toBasePlayerSlug(c.basicInfo.name)));
  if (players.size === 0) return cards;

  const replacements = new Map<string, PlayerProfile>();
  await Promise.all(
    [...players].map(async (player) => {
      const card = await fetchPublishedCard(livePrimes.get(player)!).catch(() => null);
      if (card) replacements.set(player, card);
    }),
  );
  if (replacements.size === 0) return cards;

  const replacementFor = (card: PlayerProfile): PlayerProfile | undefined =>
    isStale(card) ? replacements.get(toBasePlayerSlug(card.basicInfo.name)) : undefined;
  const swap = (card: PlayerProfile): PlayerProfile => replacementFor(card) ?? card;
  const dedupe = (list: PlayerProfile[]): PlayerProfile[] => {
    const seen = new Set<string>();
    return list.filter((c) => !seen.has(getCardKey(c)) && !!seen.add(getCardKey(c)));
  };

  // A stub in the thread names its card by key, so it follows the card that replaced it.
  const rekeyed = new Map<string, string>();
  for (const card of held) {
    const next = replacementFor(card);
    if (next) rekeyed.set(getCardKey(card), getCardKey(next));
  }
  const history = cards.history.map((msg): ChatMessage => {
    if (msg.sender !== 'ai') return msg;
    if (isPlayerProfile(msg.content)) {
      const next = replacementFor(msg.content);
      return next ? { ...msg, content: next } : msg;
    }
    const key = msg.dossierKey && rekeyed.get(msg.dossierKey);
    return key ? { ...msg, dossierKey: key } : msg;
  });

  return {
    history,
    conversationProfiles: dedupe(cards.conversationProfiles.map(swap)),
    savedDossiers: dedupe(cards.savedDossiers.map(swap)),
  };
};
