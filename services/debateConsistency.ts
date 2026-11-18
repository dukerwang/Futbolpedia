import type { PlayerProfile } from '../types';
import { cardEdition, getCardKey, isPrimeCard, toBasePlayerSlug } from './dossierCards';

/**
 * Keeps a debate's verdict and a ranking's order consistent with the stored cards, before the
 * writer starts. A card rates how good one version of a player was across its window, and its
 * peer placement records which peers it was judged better than, level with, or below. So when a
 * question turns on how good the players were, the cards have already answered part of it: the
 * brief's proposed order is checked against them and corrected in code, and the writer argues the
 * corrected order. Questions that turn on something else (output, influence, versatility) are
 * informed by the cards but not settled by them. Pure functions.
 */

/** What a historical question turns on, as the debate brief reads it. */
export const DEBATE_CRITERIA = ['peak_level', 'sustained_level', 'output', 'influence', 'versatility', 'mixed'] as const;
export type DebateCriterion = (typeof DEBATE_CRITERIA)[number];

/**
 * The criteria a card's Overall settles: how good a footballer the version was. A card rates the
 * level one version held across a window of at most three seasons, never his career or longevity,
 * so it answers peak and overall-level questions. Sustained level (how long he held a high level)
 * is longevity, which the rating rules leave out of the card, so there the cards inform the
 * argument and the model's order stands, as for output, influence and versatility. The debate
 * check and `show_ranking` both read this one list.
 */
export const CARD_SETTLED_CRITERIA = ['peak_level', 'mixed'] as const satisfies readonly DebateCriterion[];

/** A criterion in either spelling ("peak_level" from the debate brief, "peak level" from the ranking view) as a debate criterion key. */
export const criterionKey = (criterion: string): string => criterion.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Whether the cards settle an order on this criterion. */
export const cardsSettle = (criterion: string): boolean => (CARD_SETTLED_CRITERIA as readonly string[]).includes(criterionKey(criterion));

export interface CardStanding {
  name: string;
  slug: string;
  overall: number;
  edition: string;
  period: string | null;
  placement: { betterThan: string[]; levelWith: string[]; notAsGoodAs: string[] } | null;
  /** The card's key, so its latest published review can be filed as evidence. */
  cardKey?: string;
}

export const toStanding = (card: PlayerProfile): CardStanding => ({
  name: card.basicInfo.name,
  slug: toBasePlayerSlug(card.basicInfo.name),
  overall: Number(card.ratings?.overall) || 0,
  edition: cardEdition(card),
  period: card.version?.seasonOrEra ?? null,
  placement: card.peerPlacement ?? null,
  cardKey: getCardKey(card),
});

/**
 * The card a name in a brief means: the same player by slug, or a unique surname match ("Nesta"
 * for "Alessandro Nesta"). Parenthesised context ("Nesta (AC Milan)") is ignored. When a player
 * has more than one card in play, the name is ambiguous and matches none.
 */
export function matchStanding(name: string, standings: CardStanding[]): CardStanding | null {
  const bare = name.replace(/\(.*?\)/g, '').replace(/\b(prime|peak)\b/gi, '').trim();
  const slug = toBasePlayerSlug(bare);
  if (!slug) return null;
  let hits = standings.filter((s) => s.slug === slug);
  if (hits.length === 0) {
    const last = slug.split('-').pop()!;
    hits = standings.filter((s) => s.slug.split('-').pop() === last || s.slug.split('-').includes(slug));
  }
  return hits.length === 1 ? hits[0] : null;
}

/** Whether a's card puts it strictly above b's: a higher Overall, else its peer placement. */
export function cardAbove(a: CardStanding, b: CardStanding): boolean {
  if (a.overall !== b.overall) return a.overall > b.overall;
  const names = (list: string[] | undefined) => (list ?? []).map((n) => toBasePlayerSlug(n));
  return names(a.placement?.betterThan).includes(b.slug) || names(b.placement?.notAsGoodAs).includes(a.slug);
}

/**
 * One pair the cards ordered against a proposal: the proposal put `lower` above `higher`, and the
 * cards put `higher` above `lower`.
 */
export interface CardSwap {
  higher: CardStanding;
  lower: CardStanding;
}

export interface OrderCheck {
  /** The order to argue: carded entries follow their cards, the others keep their places. */
  order: string[];
  /** Entries moved to agree with the cards, each with why. */
  moves: string[];
  /** Each carded entry that moved up, with each carded entry it passed. */
  swaps: CardSwap[];
  /** The entries that have a card, with it. */
  carded: { name: string; standing: CardStanding }[];
}

/**
 * A proposed order checked against the cards: the slots held by carded entries are refilled in
 * card order (higher Overall first, then peer placement, then the proposed order), so an entry
 * without a card keeps its place and a carded entry never sits above one its card ranks higher.
 */
export function checkOrderAgainstCards(proposed: string[], standings: CardStanding[]): OrderCheck {
  const entries = proposed.map((name) => ({ name, standing: matchStanding(name, standings) }));
  const carded = entries.filter((e): e is { name: string; standing: CardStanding } => e.standing !== null);
  // Stable insertion sort, so equal cards keep the brief's order.
  const sorted: typeof carded = [];
  for (const e of carded) {
    let i = sorted.length;
    while (i > 0 && cardAbove(e.standing, sorted[i - 1].standing)) i -= 1;
    sorted.splice(i, 0, e);
  }
  const order: string[] = [];
  let next = 0;
  for (const e of entries) order.push(e.standing ? sorted[next++].name : e.name);
  const moves: string[] = [];
  const swaps: CardSwap[] = [];
  carded.forEach((e, i) => {
    const now = sorted.indexOf(e);
    if (now < i) {
      const passedEntries = carded.filter((x, j) => j < i && sorted.indexOf(x) > now);
      const passed = passedEntries.map((x) => x.name);
      moves.push(`${e.name} above ${passed.join(', ')}: ${describeStanding(e.standing)} against ${passed.map((p) => describeStanding(matchStanding(p, standings)!)).join(', ')}`);
      for (const x of passedEntries) swaps.push({ higher: e.standing, lower: x.standing });
    }
  });
  return { order, moves, swaps, carded };
}

export const describeStanding = (s: CardStanding): string =>
  `${s.name}'s ${s.edition === 'current' ? 'current' : s.edition}${s.period ? ` (${s.period})` : ''} card, ${s.overall}`;

export interface VerdictCheck {
  verdict: string;
  changed: boolean;
  note: string | null;
  /** When the verdict changed from the other side: the card it went to, above the card the brief had picked. */
  swap?: CardSwap;
}

/**
 * A head-to-head verdict checked against the cards. When the question turns on how good the
 * players were and both sides have a card, the verdict goes to the side whose card is above;
 * level cards leave the brief's verdict standing.
 */
export function checkVerdictAgainstCards(
  verdict: string,
  sides: string[],
  standings: CardStanding[],
  criterion: string,
): VerdictCheck {
  if (!cardsSettle(criterion) || sides.length !== 2) return { verdict, changed: false, note: null };
  const [a, b] = sides.map((s) => matchStanding(s, standings));
  if (!a || !b || a.slug === b.slug) return { verdict, changed: false, note: null };
  const top = cardAbove(a, b) ? { side: sides[0], s: a, other: b } : cardAbove(b, a) ? { side: sides[1], s: b, other: a } : null;
  if (!top) return { verdict, changed: false, note: `${describeStanding(a)} and ${describeStanding(b)} are level, so the criteria decide.` };
  const picked = matchStanding(verdict, standings);
  if (picked?.slug === top.s.slug) return { verdict, changed: false, note: null };
  return {
    verdict: top.side,
    changed: true,
    note: `The verdict follows the cards: ${describeStanding(top.s)} is rated above ${describeStanding(top.other)}.`,
    // Only a verdict that named the other side disagreed with the cards; one that named neither just gained a winner.
    ...(picked?.slug === top.other.slug ? { swap: { higher: top.s, lower: top.other } } : {}),
  };
}

/** The cards in play, best first: by Overall, then peer placement. */
export const cardOrder = (standings: CardStanding[]): CardStanding[] =>
  [...standings].sort((x, y) => (cardAbove(x, y) ? -1 : cardAbove(y, x) ? 1 : 0));

/** The stored cards' order of the players in play, for the writer and the brief. */
export function formatCardOrder(standings: CardStanding[]): string {
  return cardOrder(standings)
    .map((s, i) => `${i + 1}. ${describeStanding(s)}`)
    .join('\n');
}

/**
 * Cards to check against: one per player, in the edition the turn is about. For the past, a prime
 * card is preferred over an era or season card, since it rates the player at his best.
 */
export const standingsFor = (cards: PlayerProfile[], historical: boolean): CardStanding[] => {
  const rank = (c: PlayerProfile) => (cardEdition(c) === 'prime' ? 0 : 1);
  const best = new Map<string, PlayerProfile>();
  for (const c of cards) {
    if (!c?.basicInfo?.name || isPrimeCard(c) !== historical) continue;
    const slug = toBasePlayerSlug(c.basicInfo.name);
    const held = best.get(slug);
    if (!held || rank(c) < rank(held)) best.set(slug, c);
  }
  return [...best.values()].map(toStanding);
};
