import type { PlayerProfile } from '../types';
import { cardEdition, formatEraQualifier } from './dossierCards';

/**
 * The three questions a card page offers under "Ask about <player>", written by code from the
 * card's edition and position, so opening a page never calls a model. Each one is a real
 * conversation starter for that version: a comparison with peers, what defines this version, and
 * the case for rating it higher. Only a current card asks about the present.
 */

/** Words that belong to the surname after them: "Di María", "van der Sar", "De Bruyne". */
const SURNAME_PARTICLES = new Set(['di', 'de', 'da', 'do', 'dos', 'das', 'del', 'della', 'van', 'von', 'der', 'den', 'ter', 'ten', 'le', 'la', 'du']);

/** "Bukayo Saka" -> "Saka", "Kaká" -> "Kaká", "Neymar Jr" -> "Neymar", "Ángel Di María" -> "Di María". */
export function shortName(name: string): string {
  const words = name.trim().replace(/\s+(Jr\.?|Junior|Sr\.?|II|III)$/i, '').split(/\s+/);
  if (words.length <= 1) return words[0] ?? name;
  let start = words.length - 1;
  while (start > 1 && SURNAME_PARTICLES.has(words[start - 1].toLowerCase())) start--;
  return words.slice(start).join(' ');
}

/** "Right Winger/Right Midfielder" -> "right wingers"; "Centre-Back" -> "centre-backs". */
export function positionPlural(position: string | undefined): string {
  const raw = (position ?? '').trim();
  const first = /^n\/?a$/i.test(raw) ? '' : raw.split('/')[0].trim().toLowerCase();
  if (!first) return 'players in their position';
  if (/(s|x)$/.test(first)) return first;
  return `${first}s`;
}

export function starterQuestions(card: PlayerProfile): string[] {
  const name = shortName(card.basicInfo?.name ?? '');
  const peers = positionPlural(card.basicInfo?.position);
  switch (cardEdition(card)) {
    case 'current':
      return [
        `How does ${name} compare with the best ${peers} in the world right now?`,
        `What has changed in ${name}'s game this season?`,
        `What's the case for rating ${name} higher?`,
      ];
    case 'era': {
      const qualifier = card.version?.qualifier?.trim();
      const where = qualifier ? formatEraQualifier(qualifier) : '';
      return [
        where ? `What made ${name} work at ${where}?` : `What defined this version of ${name}?`,
        `Was this ${name}'s best spell?`,
        `What's the case for rating this era higher?`,
      ];
    }
    case 'season_snapshot':
      return [
        `Who were the best ${peers} that season?`,
        `What made that season stand out for ${name}?`,
        `What's the case for rating ${name}'s season higher?`,
      ];
    default:
      return [
        `Which ${peers} of any era could match prime ${name}?`,
        `How would prime ${name} do in today's game?`,
        `What's the case for rating this prime higher?`,
      ];
  }
}
