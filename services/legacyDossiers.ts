import type { Conversation, PlayerProfile } from '../types';
import { cardEdition, getCardKey, isRatedOnCurrentScale, toBasePlayerSlug } from './dossierStore';

/**
 * One-time cleanup of the dossiers this browser kept from before the current rating pipeline.
 * The shared store was purged at the recalibration; this does the same for local copies.
 */
export const LEGACY_PURGE_KEY = 'futbolpedia-legacy-purge-v1';

/**
 * A card the current pipeline couldn't have produced: no recorded edition, no evidence grade or
 * peer benchmark, or rated before the recalibration. Judge the card as stored, before load-time
 * dating fills in a version and a creation time.
 */
export const isLegacyShape = (p: PlayerProfile): boolean =>
  !p.version || !p.confidence || !p.peerBenchmark || !isRatedOnCurrentScale(p);

/**
 * A card whose player and edition the shared store has never held, such as a current-form card of
 * a retired player that the shared store only knows as a prime. Every rating is published, so a
 * local-only card dates from before the shared store was rebuilt.
 */
export const isOrphanCard = (p: PlayerProfile, sharedEditions: Set<string>): boolean =>
  !sharedEditions.has(`${toBasePlayerSlug(p.basicInfo.name)}:${cardEdition(p)}`);

/** Card keys of the orphaned cards in a list. */
export const orphanKeys = (cards: PlayerProfile[], sharedEditions: Set<string>): Set<string> =>
  new Set(cards.filter((p) => p.basicInfo?.name && isOrphanCard(p, sharedEditions)).map(getCardKey));

/** A conversation without the cards a predicate rejects; its messages stay as they are. */
export const withoutCards = (conv: Conversation, drop: (p: PlayerProfile) => boolean): Conversation => {
  const allProfiles = (conv.allProfiles ?? []).filter((p) => !drop(p));
  const activeProfile = conv.activeProfile && drop(conv.activeProfile) ? null : conv.activeProfile;
  return allProfiles.length === (conv.allProfiles ?? []).length && activeProfile === conv.activeProfile
    ? conv
    : { ...conv, allProfiles, activeProfile };
};
