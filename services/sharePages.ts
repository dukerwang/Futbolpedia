import type { Conversation, PlayerProfile } from '../types';
import { describeCardEdition } from '../components/pills';
import {
  cardEdition,
  getCardKey,
  getDossierEvaluationDate,
  isPrimeCard,
  toBasePlayerSlug,
  toDossierCardSlug,
} from './dossierCards';
import {
  addressPath,
  cardPath,
  datedCardPath,
  isFreshCurrent,
  pickDefaultCard,
  shortWindow,
  type CardAddress,
} from './cardPaths';
import {
  fetchCardIndex,
  fetchPriorDossiersForPlayer,
  readSharedCardRow,
  getCachedEraCard,
  getCachedSeasonCard,
  getSharedConversation,
} from './dossierCache';

/**
 * What a shareable address shows: a card with its history and the player's other versions, a
 * shared conversation, a redirect to the address's one spelling, or nothing. Used by the server
 * (page tags and preview images) and the browser (the card page), with the reads passed in.
 * Never rates anything and never calls a model.
 */

export interface ShareReads {
  /** A row by slug, undated legacy cards included. Throws when the store can't be read. */
  readSlug(slug: string): Promise<PlayerProfile | null>;
  eraCard(player: string, window: string): Promise<PlayerProfile | null>;
  seasonCard(player: string, season: string): Promise<PlayerProfile | null>;
  /** Every shared card of the player, oldest first, superseded primes dropped. */
  playerCards(player: string): Promise<PlayerProfile[]>;
  /** One outline per player and edition (`fetchCardIndex`), for other spellings of a name. */
  cardIndex(): Promise<PlayerProfile[]>;
  sharedConversation(code: string): Promise<Conversation | null>;
}

/** The reads against the shared store, through whichever Supabase client this process has. */
export const storeReads = (): ShareReads => ({
  readSlug: (slug) => readSharedCardRow(slug),
  eraCard: (player, window) => getCachedEraCard(player, { window }),
  seasonCard: (player, season) => getCachedSeasonCard(player, season),
  playerCards: (player) => fetchPriorDossiersForPlayer(player),
  cardIndex: () => fetchCardIndex(),
  sharedConversation: (code) => getSharedConversation(code),
});

export interface CardHistoryEntry {
  date: string;
  overall: number;
  path: string;
}

export interface CardVersionLink {
  edition: string;
  label: string;
  path: string;
  overall: number;
  current: boolean;
}

export type CardBanner =
  | { kind: 'superseded_prime'; to: string }
  | { kind: 'active_prime'; currentPath: string; ratedOn: string | null };

export type CardPage =
  | {
      kind: 'card';
      card: PlayerProfile;
      canonical: string;
      history: CardHistoryEntry[];
      versions: CardVersionLink[];
      banner?: CardBanner;
    }
  | { kind: 'redirect'; to: string }
  | { kind: 'not_found'; player: string }
  | { kind: 'unavailable' };

export interface ChatPage {
  kind: 'chat';
  code: string;
  conversation: Conversation;
  title: string;
  question: string;
  replies: number;
  cards: PlayerProfile[];
}

export type ChatPageResult = ChatPage | { kind: 'not_found' } | { kind: 'unavailable' };

/** The most cards a chat preview shows. */
export const CHAT_PREVIEW_CARDS = 4;

const ARCHIVE_EDITIONS = ['current', 'prime', 'season_snapshot', 'retro'] as const;

/** Each player's slug for pointer rows: the name's own slug, so `prime-<player>` is the prime. */
const pointer = (player: string, prime = false) => toDossierCardSlug(player, prime);

const sameCard = (a: PlayerProfile | null | undefined, b: PlayerProfile | null | undefined): boolean =>
  !!a && !!b && getCardKey(a) === getCardKey(b);

/** The player's versions as chips: latest current form, the prime, then each era and season. */
function versionLinks(cards: PlayerProfile[], shown: PlayerProfile, nowMs: number): CardVersionLink[] {
  const latest = new Map<string, PlayerProfile>();
  for (const card of cards) {
    const edition = cardEdition(card);
    const key =
      edition === 'current' || edition === 'prime'
        ? edition
        : `${edition}:${shortWindow(card.version?.seasonOrEra) ?? getDossierEvaluationDate(card)}`;
    const prev = latest.get(key);
    const newer =
      !prev ||
      (getDossierEvaluationDate(card) ?? '') > (getDossierEvaluationDate(prev) ?? '') ||
      (card.rerateAt ?? 0) > (prev.rerateAt ?? 0);
    if (newer) latest.set(key, card);
  }
  const order = (c: PlayerProfile): number =>
    ({ current: 0, prime: 1, era: 2, season_snapshot: 3 } as Record<string, number>)[cardEdition(c)] ?? 4;
  return [...latest.values()]
    .sort((a, b) => order(a) - order(b) || (a.version?.seasonOrEra ?? '').localeCompare(b.version?.seasonOrEra ?? ''))
    .map((card) => {
      const path = cardPath(card, { nowMs });
      return path
        ? {
            edition: cardEdition(card),
            label: describeCardEdition(card).label,
            path,
            overall: card.ratings?.overall ?? 0,
            current: sameCard(card, shown),
          }
        : null;
    })
    .filter((v): v is CardVersionLink => v !== null);
}

/** Earlier cards of the shown card's edition, newest first. Eras and seasons have none. */
function historyOf(cards: PlayerProfile[], shown: PlayerProfile): CardHistoryEntry[] {
  const edition = cardEdition(shown);
  if (edition !== 'current' && edition !== 'prime') return [];
  const shownDate = getDossierEvaluationDate(shown) ?? '';
  return cards
    .filter((c) => cardEdition(c) === edition && !sameCard(c, shown))
    .filter((c) => (getDossierEvaluationDate(c) ?? '') < shownDate || edition === 'prime')
    .map((c) => {
      const date = getDossierEvaluationDate(c);
      const path = datedCardPath(c);
      return date && path ? { date, overall: c.ratings?.overall ?? 0, path } : null;
    })
    .filter((e): e is CardHistoryEntry => e !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** A unique shared player whose name contains every word of the address's name. */
function aliasMatch(index: PlayerProfile[], player: string): PlayerProfile | null {
  const words = player.split('-').filter(Boolean);
  if (words.length === 0 || player.length < 3) return null;
  const matches = new Map<string, PlayerProfile>();
  for (const card of index) {
    const base = toBasePlayerSlug(card.basicInfo?.name ?? '');
    if (!base || base === player) continue;
    const tokens = new Set(base.split('-'));
    if (words.every((w) => tokens.has(w))) matches.set(base, card);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

async function findCard(
  a: CardAddress,
  reads: ShareReads,
  nowMs: number,
): Promise<{ card: PlayerProfile | null; current?: PlayerProfile | null; prime?: PlayerProfile | null }> {
  switch (a.edition) {
    case 'default': {
      const [current, prime] = await Promise.all([reads.readSlug(pointer(a.player)), reads.readSlug(pointer(a.player, true))]);
      const live = current && !isPrimeCard(current) ? current : null;
      const peak = prime && isPrimeCard(prime) ? prime : null;
      return { card: pickDefaultCard({ current: live, prime: peak }, nowMs), current: live, prime: peak };
    }
    case 'prime': {
      const [prime, current] = await Promise.all([reads.readSlug(pointer(a.player, true)), reads.readSlug(pointer(a.player))]);
      return { card: prime && isPrimeCard(prime) ? prime : null, current: current && !isPrimeCard(current) ? current : null };
    }
    case 'era':
      return { card: await reads.eraCard(a.player, a.window!) };
    case 'season':
      return { card: await reads.seasonCard(a.player, a.window!) };
    case 'dated': {
      const rows = await Promise.all(ARCHIVE_EDITIONS.map((e) => reads.readSlug(`${a.player}--${e}--${a.date}`)));
      return { card: rows.find(Boolean) ?? null };
    }
  }
}

/** Resolves a card address. Never throws: a failed read is `unavailable`. */
export async function resolveCardPage(
  a: CardAddress,
  reads: ShareReads,
  nowMs: number = Date.now(),
): Promise<CardPage> {
  try {
    const found = await findCard(a, reads, nowMs);
    const card = found.card;
    if (!card) {
      if (a.edition === 'default' || a.edition === 'prime') {
        const alias = aliasMatch(await reads.cardIndex(), a.player);
        if (alias) {
          const player = toBasePlayerSlug(alias.basicInfo.name);
          return { kind: 'redirect', to: addressPath({ ...a, player }) };
        }
      }
      return { kind: 'not_found', player: a.player };
    }

    const cards = await reads.playerCards(a.player);
    const all = cards.some((c) => sameCard(c, card)) ? cards : [...cards, card];
    const primePointer = found.prime ?? (a.edition === 'dated' && isPrimeCard(card) ? await reads.readSlug(pointer(a.player, true)) : null);
    const superseded = cardEdition(card) === 'prime' && !!primePointer && !sameCard(primePointer, card) && a.edition === 'dated';

    let banner: CardBanner | undefined;
    if (superseded) banner = { kind: 'superseded_prime', to: addressPath({ player: a.player, edition: 'prime' }) };
    else if (cardEdition(card) === 'prime' && found.current && isFreshCurrent(found.current, nowMs)) {
      banner = { kind: 'active_prime', currentPath: addressPath({ player: a.player, edition: 'default' }), ratedOn: getDossierEvaluationDate(card) };
    }

    return {
      kind: 'card',
      card,
      canonical: cardPath(card, { nowMs, superseded }) ?? addressPath(a),
      history: historyOf(all, card),
      versions: versionLinks(all.filter((c) => !(superseded && sameCard(c, card))), card, nowMs),
      ...(banner ? { banner } : {}),
    };
  } catch (err) {
    console.warn('[share] card read failed:', (err as Error)?.message || err);
    return { kind: 'unavailable' };
  }
}

const textOf = (content: unknown): string => (typeof content === 'string' ? content : '');

/** Resolves a shared conversation. Never throws: a failed read is `unavailable`. */
export async function resolveChatPage(code: string, reads: ShareReads): Promise<ChatPageResult> {
  try {
    const conversation = await reads.sharedConversation(code.toUpperCase());
    if (!conversation) return { kind: 'not_found' };
    const messages = conversation.messages ?? [];
    const question = textOf(messages.find((m) => m.sender === 'user' && textOf(m.content).trim())?.content).trim();
    const replies = messages.filter((m) => m.sender === 'ai').length;

    const profiles = conversation.allProfiles ?? [];
    const byKey = new Map(profiles.map((p) => [getCardKey(p), p] as const));
    const cards: PlayerProfile[] = [];
    const seen = new Set<string>();
    const add = (p: PlayerProfile | undefined) => {
      if (!p?.basicInfo?.name) return;
      const key = getCardKey(p);
      if (seen.has(key) || cards.length >= CHAT_PREVIEW_CARDS) return;
      seen.add(key);
      cards.push(p);
    };
    for (const m of messages) {
      if (m.dossierKey) add(byKey.get(m.dossierKey));
      else if (m.content && typeof m.content === 'object' && 'basicInfo' in (m.content as object)) add(m.content as PlayerProfile);
    }
    if (cards.length === 0) profiles.forEach(add);

    return {
      kind: 'chat',
      code: code.toUpperCase(),
      conversation,
      title: conversation.title?.trim() || question || 'A Futbolpedia conversation',
      question,
      replies,
      cards,
    };
  } catch (err) {
    console.warn('[share] chat read failed:', (err as Error)?.message || err);
    return { kind: 'unavailable' };
  }
}

/**
 * Keeps resolved pages for a few minutes, so a link pasted into a busy group chat (every member's
 * app fetches the preview) reads Supabase once. Failures aren't kept.
 */
export class SharePageCache<T> {
  private entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(
    private ttlMs = 5 * 60 * 1000,
    private max = 2000,
  ) {}

  get(key: string, load: () => Promise<T>, keep: (v: T) => boolean, nowMs = Date.now()): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && nowMs - hit.at < this.ttlMs) return hit.value;
    const value = load().then((v) => {
      if (!keep(v)) this.entries.delete(key);
      return v;
    });
    this.entries.delete(key);
    this.entries.set(key, { at: nowMs, value });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
}
