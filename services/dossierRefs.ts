import type { ChatDossierRef, PlayerProfile } from '../types';
import { getCardKey } from './dossierCards';

export const toChatDossierRef = (p: PlayerProfile): ChatDossierRef => ({
  cardKey: getCardKey(p),
  name: p.basicInfo.name,
  club: p.basicInfo.club,
  position: p.basicInfo.position,
  nationality: p.basicInfo.nationality,
  age: p.basicInfo.age,
  overall: p.ratings?.overall,
  potential: p.ratings?.potential,
  archetype: p.playstyleAndRole?.playstyle?.archetype,
  versionLabel: p.version?.label,
});

const LEGACY_DOSSIER_PATTERN = /^Dossier generated for \*\*(.+?)\*\*/;

/** Older chats only stored the prose notice; recover the player name so the card can still open. */
export const getLegacyDossierRef = (content: unknown): ChatDossierRef | null => {
  if (typeof content !== 'string') return null;
  const match = content.match(LEGACY_DOSSIER_PATTERN);
  return match ? { cardKey: '', name: match[1] } : null;
};
