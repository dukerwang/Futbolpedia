import { getRealWorldFootballSeason } from '../constants/footballSeason';
import { CLUB_CANON } from '../constants/ratingTiers';
import { parseRequestedSeason, seasonStartYear } from './dossierCards';

/**
 * The cues the router reads from a message with regexes alone: the club names it knows, the
 * version of a player a message names, a candidate player name and a past season. Nothing here
 * calls a model, so the rating command and the chat's first paint can read them without loading
 * the AI client; `turnRouter.ts` re-exports them.
 */

/** Alternation of club names the router recognizes in free text (shared by every club regex). */
export const CLUB_NAME_ALTERNATION = [
  'arsenal',
  'chelsea',
  'liverpool',
  'manchester\\s+city',
  'man\\s+city',
  'manchester\\s+united',
  'man\\s+utd',
  'tottenham(?:\\s+hotspur)?',
  'spurs',
  'newcastle(?:\\s+united)?',
  'aston\\s+villa',
  'brighton',
  'real\\s+madrid',
  'fc\\s+barcelona',
  'barcelona',
  'barca',
  'atl[eé]tico\\s+madrid',
  'atletico',
  'bayern\\s+munich',
  'bayern',
  'borussia\\s+dortmund',
  'dortmund',
  'bayer\\s+leverkusen',
  'leverkusen',
  'paris\\s+saint[- ]germain',
  'psg',
  'inter\\s+milan',
  'ac\\s+milan',
  'juventus',
  'napoli',
  'benfica',
  'porto',
  'sporting(?:\\s+cp)?',
  'ajax',
].join('|');

export const KNOWN_CLUB_REGEX = new RegExp(`\\b(${CLUB_NAME_ALTERNATION})\\b`, 'gi');
// "Chelsea's Cole Palmer" / "PSG's Willian Pacho"
export const POSSESSIVE_CLUB_PREFIX_REGEX = new RegExp(`\\b(${CLUB_NAME_ALTERNATION})['\\u2019]s\\s+`, 'gi');
// "Cole Palmer at Chelsea" / "Pacho for PSG"
export const TRAILING_CLUB_QUALIFIER_REGEX = new RegExp(
  `\\b(?:at|for|from|of|in)\\s+(${CLUB_NAME_ALTERNATION})\\b`,
  'gi',
);
const ERA_NOUN = '(?:version|era|days|years|spell|stint|iteration|edition|incarnation)';
const ERA_WORD = "\\p{L}[\\p{L}'\\u2019.]*";
const ERA_NAME = `${ERA_WORD}(?:[\\s-]+${ERA_WORD}){0,2}`;
const ERA_PHASE = 'young|teenage|early|late[- ]career|veteran|old|pre-\\p{L}[\\p{L}-]*|post-\\p{L}[\\p{L}-]*';
const ERA_LEAD = '(?:^|\\b(?:rate|profile|scout|evaluate|dossier|on|of|about)\\s+)(?:the\\s+|a\\s+)?';

/**
 * Phrasings that name a version of a player. Each captures the version's name; the whole match is
 * what names it, and is stripped from the player name.
 */
const ERA_PATTERNS: RegExp[] = [
  // "the PSG version of Neymar"
  new RegExp(`\\b(?:the|his)\\s+(${ERA_NAME})\\s+${ERA_NOUN}\\s+of\\b`, 'iu'),
  // "Neymar's PSG era"
  new RegExp(`['\\u2019]s\\s+(${ERA_NAME})\\s+${ERA_NOUN}\\b`, 'iu'),
  // "Neymar from his PSG days"
  new RegExp(`\\b(?:from|in|during)\\s+his\\s+(${ERA_NAME})\\s+${ERA_NOUN}\\b`, 'iu'),
  // "PSG-era Neymar", "Barca era Neymar"
  new RegExp(`\\b(${CLUB_NAME_ALTERNATION}|\\p{L}+)-${ERA_NOUN}\\b`, 'iu'),
  new RegExp(`\\b(${CLUB_NAME_ALTERNATION})\\s+${ERA_NOUN}\\b`, 'iu'),
  // "Neymar at PSG"
  new RegExp(`\\b(?:at|with)\\s+(${CLUB_NAME_ALTERNATION})\\b`, 'iu'),
  // "Barca Neymar"
  new RegExp(`${ERA_LEAD}(${CLUB_NAME_ALTERNATION})\\s+(?=\\p{L})`, 'iu'),
  // "young Messi", "pre-injury Neymar"
  new RegExp(`${ERA_LEAD}(${ERA_PHASE})\\s+(?=\\p{L})`, 'iu'),
];

/** Names that aren't an era: his prime, his current form, or a season. */
const NOT_AN_ERA_RE =
  /^(?:(?:his|the)\s+)?(?:best|peak|prime|golden|greatest|finest|current|latest|recent|present|today'?s?|this\s+season'?s?)$|\d/i;

/** An era name from the classifier or a pattern, or null when it names no era. */
export const cleanEraName = (raw: string | null | undefined): string | null => {
  const name = raw?.trim().replace(/\s+/g, ' ') ?? '';
  return name && name.length <= 40 && !NOT_AN_ERA_RE.test(name) ? name : null;
};

/** The version of a player the message names ("PSG Neymar", "young Messi"), if any. */
export const eraIn = (message: string): string | null => {
  for (const re of ERA_PATTERNS) {
    const name = cleanEraName(message.match(re)?.[1]);
    if (name) return name;
  }
  return null;
};

/** Removes the phrase naming an era, keeping what precedes and follows it. */
export const stripEraPhrase = (message: string): string => {
  for (const re of ERA_PATTERNS) {
    const m = message.match(re);
    if (m && cleanEraName(m[1])) {
      return `${message.slice(0, m.index)} ${message.slice(m.index! + m[0].length)}`.trim();
    }
  }
  return message;
};

/**
 * Words a chat message wraps a request in, which are never part of a name: a lead-in ("okay",
 * "alright then", "go ahead and"), a trailing "then" or "please", and the version words a route
 * reads separately ("prime", "peak").
 */
const CHAT_LEAD_IN = /^(?:(?:ok(?:ay)?|alright|aight|right|so|well|yeah|yes|yep|sure|cool|fine|great|nice|hey|now|then|just|go ahead and|let['\u2019]?s|lets|could you|would you|can u|pls|plz)\b[\s,!.]*)+/i;
const CHAT_TAIL = /(?:[\s,]+(?:then|too|as well|pls|plz|please|thanks|thx))+[\s?!.]*$/i;
const VERSION_WORDS = /\b(?:prime|peak|at (?:his|their) (?:best|peak))\b/gi;

export const stripClubAndDossierQualifiers = (message: string): string =>
  stripEraPhrase(message.trim().replace(CHAT_LEAD_IN, '').replace(CHAT_TAIL, ''))
    .replace(VERSION_WORDS, '')
    .replace(/\b(give me a?n?|create|generate|can you|please|show me|pull up|what is|what's)\b/gi, '')
    .replace(
      /\b(rate|rating|profile|scout(?:ing)?(?: report)?|evaluate|dossier|how good is|rank(?:ing)?|tier|analyze|analysis|breakdown|report|brief(?:ing)?)\b/gi,
      '',
    )
    .replace(POSSESSIVE_CLUB_PREFIX_REGEX, '')
    .replace(TRAILING_CLUB_QUALIFIER_REGEX, '')
    // Strip trailing "'s" left over after dossier keywords were removed (e.g. "Cole Palmer's [dossier]")
    .replace(/['\u2019]s(?:\s*$)/gi, '')
    .replace(/\b(on|for|about|of|a|an|the|me|right now|currently)\b/gi, '')
    // Timeframes ("Henry 2006", "Kaká in the 2006-07 season") are read separately.
    .replace(/\b(?:19|20)\d{2}(?:\s*[-/–]\s*(?:19|20)?\d{2})?\b/g, '')
    .replace(/\b(in|during|season|campaign|version)\b/gi, '')
    .replace(/[?!.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Detects whether a prompt is about a club, tactical system, group/ranking, or multi-clause question
 * rather than a single footballer's name. Prevents fast-path misrouting into single_dossier.
 */
export const isNonSinglePlayerSubject = (message: string): boolean => {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const normalizedKey = lower.replace(/[^a-z]/g, '');

  if (normalizedKey in CLUB_CANON) return true;

  // Plural group nouns, ranking quantifiers, tactical/system subjects, or club/league terms
  if (
    /\b(top\s+\d+|best|worst|rank\s+the|tier\s*list|strikers|midfielders|defenders|wingers|full[- ]?backs|centre[- ]?backs|center[- ]?backs|goalkeepers|keepers|forwards|players|signings|targets|prospects|teams|clubs|managers|coaches)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  if (
    /\b(tactics|tactical|system|formation|high\s+line|low\s+block|build[- ]?up|pressing|press|rest[- ]?defen[cs]e|half[- ]?spaces?|midfield|attack|defen[cs]e|squad|lineup|starting\s+xi|title|chances|season|transfer|window|recruitment|market|champions\s+league|premier\s+league|la\s+liga|serie\s+a|bundesliga|ligue\s+1|world\s+cup|euros|ballon\s+d['\u2019]?or)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  // Check if stripping dossier/club qualifiers leaves a pure club name or a specific possessive question (e.g. "Palmer's passing")
  const stripped = stripClubAndDossierQualifiers(trimmed);
  const strippedKey = stripped.toLowerCase().replace(/[^a-z]/g, '');
  if (!stripped || strippedKey in CLUB_CANON) {
    return true;
  }

  // Possessive 's remaining on a non-dossier noun (e.g. "Slot's system", "Palmer's passing") asks a specific question
  if (/\b\w+['\u2019]s\s+\w+/i.test(stripped)) {
    return true;
  }

  return false;
};

/**
 * Extracts a candidate player name from a simple single-player dossier prompt.
 * Returns null if the message contains complex clauses, team/tactical nouns, or no identifiable name.
 */
export const extractCandidatePlayerName = (message: string): string | null => {
  if (isNonSinglePlayerSubject(message)) return null;

  const candidate = stripClubAndDossierQualifiers(message);
  if (!candidate || candidate.length < 2 || candidate.split(' ').length > 5) return null;
  if (isNonSinglePlayerSubject(candidate)) return null;
  return candidate;
};
/** The season a message names, when it is earlier than the current one. */
export const pastSeasonIn = (msg: string): string | null => {
  const season = parseRequestedSeason(msg);
  if (!season) return null;
  const start = seasonStartYear(season);
  const currentStart = seasonStartYear(getRealWorldFootballSeason().currentSeason);
  return start != null && currentStart != null && start < currentStart ? season : null;
};

export const hasCurrentFormCue = (msg: string): boolean =>
  /\b(current(?:ly)?|right now|nowadays|today|this season|these days|at the moment)\b/i.test(msg);
