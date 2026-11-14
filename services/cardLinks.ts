import type { PlayerProfile } from '../types';
import { describeCardEdition } from '../components/pills';
import { cardEdition, ensureDossierDated, fetchCardIndex, isPrimeCard, toBasePlayerSlug, toVersionedSlug } from './dossierStore';

/**
 * A shared card as a link into Futbolpedia (`#/p/<slug>`), for Gaffa: the player, which version
 * the card rates, and where it opens. No rating: Futbolpedia's numbers stay on Futbolpedia for now.
 */
export interface CardLink {
  name: string;
  edition: string;
  label: string;
  slug: string;
}

export function cardLinkFor(card: PlayerProfile): CardLink | null {
  const dated = ensureDossierDated(card, Date.now()) ?? card;
  const slug = toVersionedSlug(dated);
  if (!slug || !card.basicInfo?.name) return null;
  return { name: card.basicInfo.name, edition: cardEdition(card), label: describeCardEdition(card).label, slug };
}

export const CARD_LOOKUP_LIMIT = 25;

/**
 * The shared card for each name, preferring current form (Gaffa's players are active) over a
 * prime. A name with no card maps to null, so Gaffa can offer Scout instead.
 */
export async function lookUpCardLinks(
  names: string[],
  index: () => Promise<PlayerProfile[]> = fetchCardIndex,
): Promise<Record<string, CardLink | null>> {
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, CARD_LOOKUP_LIMIT);
  const cards = wanted.length ? await index() : [];
  const byPlayer = new Map<string, PlayerProfile[]>();
  for (const card of cards) {
    const key = toBasePlayerSlug(card.basicInfo?.name ?? '');
    if (!key) continue;
    byPlayer.set(key, [...(byPlayer.get(key) ?? []), card]);
  }
  const out: Record<string, CardLink | null> = {};
  for (const name of wanted) {
    const found = byPlayer.get(toBasePlayerSlug(name)) ?? [];
    const best = found.find((c) => !isPrimeCard(c)) ?? found.find((c) => cardEdition(c) === 'prime') ?? found[0];
    out[name] = best ? cardLinkFor(best) : null;
  }
  return out;
}
