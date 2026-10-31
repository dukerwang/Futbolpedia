import type { PlayerProfile } from '../types';
import {
  EDITION_NAME_RE,
  compareVersions,
  getCardKey,
  isCardInRefreshWindow,
  isPrimeCard,
  toBasePlayerSlug,
  toPlayerSlug,
} from './dossierCards';
import { isRatedOnCurrentScale } from './dossierCache';

/** A player the Rate command suggests, with the cards a request would be served today. */
export interface PlayerMatch {
  /** `toBasePlayerSlug` of his name, shared by all his cards. */
  key: string;
  name: string;
  club?: string;
  position?: string;
  /** In version order: current form, prime, eras, seasons. */
  cards: PlayerProfile[];
}

/** Cards a request would be served as they are: no personal revisions, old-scale or stale cards. */
const isServable = (p: PlayerProfile): boolean =>
  Boolean(p.basicInfo?.name) &&
  !p.revision &&
  isRatedOnCurrentScale(p) &&
  (isPrimeCard(p) || isCardInRefreshWindow(p));

/**
 * How closely a name matches what was typed, lower is closer: the whole name, the start of it,
 * every typed word starting a word of his name with the first word first, then in any order.
 * Accents and case are ignored. Null when it doesn't match.
 */
const matchScore = (queryTokens: string[], query: string, nameKey: string): number | null => {
  if (nameKey === query) return 0;
  if (nameKey.startsWith(query)) return 1;
  const nameTokens = nameKey.split('-');
  const startsAWord = (q: string) => nameTokens.some((t) => t.startsWith(q));
  if (!queryTokens.every(startsAWord)) return null;
  return nameTokens[0].startsWith(queryTokens[0]) ? 2 : 3;
};

/**
 * Players whose name matches `query`, best match first, from your own dossiers and the shared
 * card index. Your own dossiers win ties, and a card both lists hold is listed once.
 */
export const searchPlayers = (
  query: string,
  localCards: PlayerProfile[],
  sharedCards: PlayerProfile[],
  limit = 6,
): PlayerMatch[] => {
  const folded = toPlayerSlug(query.trim().replace(/\s+/g, ' '));
  const queryTokens = folded.split('-').filter(Boolean);
  if (folded.replace(/-/g, '').length < 2) return [];
  const queryKey = queryTokens.join('-');

  const groups = new Map<string, { cards: Map<string, PlayerProfile>; local: boolean }>();
  const add = (p: PlayerProfile, local: boolean) => {
    if (!isServable(p)) return;
    const key = toBasePlayerSlug(p.basicInfo.name);
    if (!key) return;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { cards: new Map(), local }));
    const cardKey = getCardKey(p);
    if (!group.cards.has(cardKey)) group.cards.set(cardKey, p);
    group.local ||= local;
  };
  for (const p of localCards) add(p, true);
  for (const p of sharedCards) add(p, false);

  const scored: { match: PlayerMatch; score: number; local: boolean }[] = [];
  for (const [key, group] of groups) {
    const score = matchScore(queryTokens, queryKey, key);
    if (score === null) continue;
    const cards = [...group.cards.values()].sort(compareVersions);
    const lead = cards[0];
    scored.push({
      score,
      local: group.local,
      match: {
        key,
        name: lead.basicInfo.name.replace(EDITION_NAME_RE, '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim(),
        club: cards.find((c) => !isPrimeCard(c))?.basicInfo.club,
        position: lead.basicInfo.position,
        cards,
      },
    });
  }
  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        Number(b.local) - Number(a.local) ||
        a.match.name.localeCompare(b.match.name),
    )
    .slice(0, limit)
    .map((s) => s.match);
};
