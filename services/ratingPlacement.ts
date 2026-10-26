import type { PeerPlacement, PlayerProfile } from '../types';
import { foldPlayerName, isPrimeCard, toBasePlayerSlug } from './dossierCards';

/**
 * Keeps a new card's Overall consistent with the model's own peer judgment. While rating, the
 * model says which calibrated peers this version was a better footballer than, level with, or
 * not as good as. The Overall stays the model's holistic number; this only makes sure it agrees
 * with that stated order, so "better than a 95" can never come out as 95.
 */

export interface ResolvedPlacement {
  betterThan: PlayerProfile[];
  levelWith: PlayerProfile[];
  notAsGoodAs: PlayerProfile[];
}

const nameTokens = (name: string): string[] =>
  foldPlayerName(name)
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);

/**
 * The ledger card a placement name refers to: an exact name match first, otherwise the one card
 * whose name shares the given tokens. Of a player's current and prime cards, the one in the
 * edition being rated wins. Ambiguous or unknown names resolve to nothing.
 */
function resolveName(
  rawName: string,
  ledger: PlayerProfile[],
  wantPrime: boolean,
): PlayerProfile | undefined {
  const name = rawName.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').trim();
  if (!name) return undefined;
  const folded = foldPlayerName(name).replace(/\s+/g, ' ');
  const tokens = nameTokens(name);
  let hits = ledger.filter((p) => foldPlayerName(p.basicInfo.name) === folded);
  if (hits.length === 0) {
    hits = ledger.filter((p) => {
      const cardTokens = nameTokens(p.basicInfo.name);
      return tokens.length > 0 && tokens.every((t) => cardTokens.includes(t));
    });
  }
  const players = new Set(hits.map((p) => toBasePlayerSlug(p.basicInfo.name)));
  if (players.size !== 1) return undefined;
  return hits.find((p) => isPrimeCard(p) === wantPrime) ?? hits[0];
}

export function resolvePlacement(
  placement: PeerPlacement | undefined,
  ledger: PlayerProfile[],
  subject: PlayerProfile,
): ResolvedPlacement {
  const self = toBasePlayerSlug(subject.basicInfo.name);
  const peers = ledger.filter((p) => toBasePlayerSlug(p.basicInfo.name) !== self);
  const wantPrime = isPrimeCard(subject);
  const resolve = (names?: string[]): PlayerProfile[] => [
    ...new Set(
      (names ?? [])
        .map((n) => resolveName(n, peers, wantPrime))
        .filter((p): p is PlayerProfile => Boolean(p)),
    ),
  ];
  return {
    betterThan: resolve(placement?.betterThan),
    levelWith: resolve(placement?.levelWith),
    notAsGoodAs: resolve(placement?.notAsGoodAs),
  };
}

/**
 * The Overall range the placement allows: above everyone he was better than, below everyone he
 * wasn't as good as, equal to anyone he was level with. Integer ratings can leave no room
 * strictly between two peers, so a tie is allowed then. Null when the placement contradicts
 * itself.
 */
export function placementRange(resolved: ResolvedPlacement): { min: number; max: number } | null {
  const ovr = (p: PlayerProfile) => p.ratings.overall;
  const range = (strict: boolean) => {
    let min = 1;
    let max = 99;
    for (const p of resolved.betterThan) min = Math.max(min, ovr(p) + (strict ? 1 : 0));
    for (const p of resolved.notAsGoodAs) max = Math.min(max, ovr(p) - (strict ? 1 : 0));
    for (const p of resolved.levelWith) {
      min = Math.max(min, ovr(p));
      max = Math.min(max, ovr(p));
    }
    return min <= max ? { min, max } : null;
  };
  return range(true) ?? range(false);
}

const describe = (cards: PlayerProfile[]): string[] =>
  cards.map((p) => `${p.basicInfo.name}${isPrimeCard(p) ? ` (${p.version?.seasonOrEra || 'prime'})` : ''}`);

/**
 * Moves the Overall into the range the model's own placement allows and records the placement on
 * the card. A historical card keeps Potential equal to Overall; a current card never has
 * Potential below it. A self-contradictory placement is not recorded and changes nothing.
 */
export function applyPeerPlacement(
  profile: PlayerProfile,
  placement: PeerPlacement | undefined,
  ledger: PlayerProfile[],
  isHistorical: boolean,
): PlayerProfile {
  const resolved = resolvePlacement(placement, ledger, profile);
  if (resolved.betterThan.length + resolved.levelWith.length + resolved.notAsGoodAs.length === 0) {
    return profile;
  }
  const range = placementRange(resolved);
  if (!range) {
    console.warn('[RatingPlacement] Placement contradicts itself; Overall left as rated.', placement);
    return profile;
  }
  const overall = Math.min(range.max, Math.max(range.min, profile.ratings.overall));
  return {
    ...profile,
    ratings: {
      overall,
      potential: isHistorical ? overall : Math.max(overall, profile.ratings.potential),
    },
    peerPlacement: {
      betterThan: describe(resolved.betterThan),
      levelWith: describe(resolved.levelWith),
      notAsGoodAs: describe(resolved.notAsGoodAs),
    },
  };
}
