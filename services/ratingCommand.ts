import type { PlayerProfile, RatingRequest } from '../types';
import { cardEdition, formatEraQualifier } from './dossierCards';
import type { TurnRoute } from './turnRouter';

/** The version a request asks for, for the command line in the chat; null for `auto`. */
export const ratingVersionLabel = (request: RatingRequest): string | null => {
  switch (request.edition) {
    case 'current':
      return 'Current form';
    case 'prime':
      return 'Prime';
    case 'season':
      return request.season ? request.season.replace(/^(\d{4})-(\d{2,4})$/, '$1–$2') : 'Prime';
    case 'era':
      return request.era ? `${formatEraQualifier(request.era)} era` : 'Prime';
    default:
      return null;
  }
};

/**
 * The Rate command's request as a chat line, worded the way a typed rating of the same version
 * is, so the turn router would read it the same way. It is the task the dossier pipeline grounds
 * and synthesizes from, and what the conversation shows.
 */
export const ratingTask = (request: RatingRequest): string => {
  const name = request.name.trim();
  switch (request.edition) {
    case 'current':
      return `Rate ${name} right now`;
    case 'prime':
      return `Rate prime ${name}`;
    case 'season':
      return request.season ? `Rate ${name} ${request.season}` : `Rate prime ${name}`;
    case 'era':
      return request.era ? `Rate the ${request.era} version of ${name}` : `Rate prime ${name}`;
    default:
      return `Rate ${name}`;
  }
};

/** The route the turn router gives a typed rating of the same version, built without routing. */
export const routeForRating = (request: RatingRequest): TurnRoute => {
  const season = request.edition === 'season' ? request.season?.trim() || null : null;
  const era = request.edition === 'era' ? request.era?.trim() || null : null;
  return {
    intent: 'single_dossier',
    analyticalMode: 'dossier',
    targetPlayers: [request.name.trim()],
    targetClubs: [],
    searchQueries: [],
    reasoningComplexity: 'medium',
    isHistorical: request.edition !== 'auto' && request.edition !== 'current',
    requestedSeason: season,
    requestedEra: era,
    wantsCurrentForm: request.edition === 'current',
    wantsRegeneration: false,
    needsSearch: true,
  };
};

/** The request that serves this card: its edition, and its season or era for those editions. */
export const requestForCard = (card: PlayerProfile): RatingRequest => {
  const name = card.basicInfo.name;
  switch (cardEdition(card)) {
    case 'current':
      return { name, edition: 'current' };
    case 'season_snapshot':
      return card.version?.seasonOrEra ? { name, edition: 'season', season: card.version.seasonOrEra } : { name, edition: 'prime' };
    case 'era':
      return card.version?.qualifier ? { name, edition: 'era', era: card.version.qualifier } : { name, edition: 'prime' };
    default:
      return { name, edition: 'prime' };
  }
};

/** A shared-index outline carries only what a suggestion shows; the full card has attributes. */
export const isFullCard = (card: PlayerProfile): boolean => Boolean(card.attributes && card.shortBio);
