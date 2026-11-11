import type { PlayerProfile } from '../types';

/** One dossier in the navigator, with its place in the full list the pager steps through. */
export interface NavigatorEntry {
  profile: PlayerProfile;
  /** Position in the full list, so the pager's "36/91" and the list agree. */
  index: number;
}

/** Lower-cased, accent-free words, so "mbappe" finds "Mbappé" and "psg era" or "2003" finds a labelled card. */
const words = (text: string): string[] =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * The dossiers that match what was typed, in their original order. Every typed word must start a
 * word of the player's name, club, position or edition label (in any order), so "ney prime" finds
 * a prime Neymar card. An empty search lists everything.
 */
export const filterDossiers = (
  profiles: PlayerProfile[],
  query: string,
  editionLabel: (profile: PlayerProfile) => string,
): NavigatorEntry[] => {
  const queryWords = words(query);
  const entries = profiles.map((profile, index) => ({ profile, index }));
  if (queryWords.length === 0) return entries;
  return entries.filter(({ profile }) => {
    const haystack = words(
      [profile.basicInfo?.name, profile.basicInfo?.club, profile.basicInfo?.position, editionLabel(profile)]
        .filter(Boolean)
        .join(' '),
    );
    return queryWords.every((q) => haystack.some((w) => w.startsWith(q)));
  });
};
