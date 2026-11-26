import type { PlayerProfile } from '../../types';
import { cardEdition } from '../../services/dossierCards';
import { describeCardEdition, shortEditionLabel } from '../pills';

/**
 * A card's version as ink rather than a pill: a small mark and a coloured word. Current form is
 * emerald, a prime gold, a named era blue, a single season copper, and a card from before
 * editions existed stays neutral.
 */
export type EditionInk = 'current' | 'prime' | 'era' | 'season' | 'older';

export const editionInkOf = (profile: PlayerProfile): EditionInk => {
  const edition = cardEdition(profile);
  if (edition === 'current') return profile.version ? 'current' : 'older';
  if (edition === 'era') return 'era';
  if (edition === 'season_snapshot') return 'season';
  return 'prime';
};

/** Text colour for each ink, in both themes. Whole class names, so Tailwind's build sees them. */
export const INK_TEXT: Record<EditionInk, string> = {
  current: 'text-emerald-600 dark:text-emerald-400',
  prime: 'text-gold-600 dark:text-gold-400',
  era: 'text-era-600 dark:text-era-400',
  season: 'text-copper-600 dark:text-copper-400',
  older: 'text-charcoal/55 dark:text-cream-400/80',
};

/** The mark's fill. */
export const INK_DOT: Record<EditionInk, string> = {
  current: 'bg-emerald-500',
  prime: 'bg-gold-500',
  era: 'bg-era-500',
  season: 'bg-copper-500',
  older: 'bg-charcoal/30 dark:bg-cream-400/40',
};

/** "Prime" and "2010–12" apart, so the name can carry the ink and the window stay quiet. */
export function editionParts(profile: PlayerProfile, earlierRating = false): { name: string; when: string; title?: string } {
  const { label, title } = describeCardEdition(profile);
  const [name, when = ''] = label.split(' · ');
  return { name: earlierRating ? name.replace('Current form', 'Earlier rating') : name, when, title };
}

export { shortEditionLabel };

/**
 * The Overall's colour everywhere a card shows it (hub, Scout, card page, side panel). Below the
 * World-Class line it's ink; from 90 it climbs by tier band: a muted sage for World-Class,
 * emerald for World-Class Elite, violet from Generational Icon up. Gold and periwinkle blue
 * stay out, because they already name a card's edition.
 */
export const overallText = (overall: number): string => {
  if (overall >= 96) return 'text-tier-icon dark:text-tier-icon-dark';
  if (overall >= 93) return 'text-tier-elite dark:text-tier-elite-dark';
  if (overall >= 90) return 'text-tier-wc dark:text-tier-wc-dark';
  return 'text-charcoal dark:text-cream-50';
};

/** An attribute bar's fill by value, as on the card page: emerald from 90, sage from 80. */
export const attributeBarFill = (value: number): string =>
  value >= 90 ? 'bg-emerald-500' : value >= 80 ? 'bg-emerald-400/80' : 'bg-charcoal/40 dark:bg-cream-300/45';

