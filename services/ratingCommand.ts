import type { PlayerProfile, RatingRequest } from '../types';
import { cardEdition, formatEraQualifier } from './dossierCards';
import { eraIn, extractCandidatePlayerName, hasCurrentFormCue, pastSeasonIn, type TurnRoute } from './turnRouter';

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

// Not "best": it is a surname.
const PRIME_WORD_RE = /\b(?:prime|peak)\b/gi;
const CURRENT_WORD_RE = /\b(?:current(?:ly)?(?:\s+form)?|right now|nowadays|today|this season|these days|at the moment)\b/gi;

/**
 * A name typed into the Scout panel, read the way the turn router reads a typed rating: a past
 * season ("1998-99 Paul Scholes", "Scholes 1998-1999") asks for that season's card, "prime" or
 * "peak" for his prime, "current"/"right now" for his current form, and a named version ("PSG
 * Neymar", "young Messi") for that era. Anything else takes the panel's Prime toggle.
 */
export const ratingRequestFromText = (text: string, prime: boolean): RatingRequest => {
  const raw = text.trim().replace(/\s+/g, ' ');
  const season = pastSeasonIn(raw);
  const wantsPrime = !season && new RegExp(PRIME_WORD_RE.source, 'i').test(raw);
  const wantsCurrent = !season && !wantsPrime && hasCurrentFormCue(raw);
  const bare = raw.replace(PRIME_WORD_RE, ' ').replace(CURRENT_WORD_RE, ' ').replace(/\s+/g, ' ').trim();
  const era = !season && !wantsPrime && !wantsCurrent ? eraIn(bare) : null;
  const name =
    extractCandidatePlayerName(bare) ??
    bare
      .replace(/\b(?:19|20)\d{2}(?:\s*[-/–]\s*(?:19|20)?\d{2})?\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  if (!name || name.length < 2) return { name: raw, edition: prime ? 'prime' : 'auto' };
  if (season) return { name, edition: 'season', season };
  if (wantsPrime) return { name, edition: 'prime' };
  if (wantsCurrent) return { name, edition: 'current' };
  if (era) return { name, edition: 'era', era };
  return { name, edition: prime ? 'prime' : 'auto' };
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
