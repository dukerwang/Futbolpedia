import { Type } from '@google/genai';
import type { ChatMessage, PlayerProfile } from '../types';
import { CLUB_CANON } from '../constants/ratingTiers';
import { generateStructured, getCurrentSeasonInfo } from './aiClient';
import {
  findReferencedDossiers,
  isPlayerProfile,
  isPrimeCard,
  parseRequestedSeason,
  seasonStartYear,
  toPlayerSlug,
  wantsSavedDossierInventory,
} from './dossierStore';
import { buildSquadTurnoverQuery } from './groundingService';

const TURN_INTENTS = [
  'single_dossier',
  'compare',
  'challenge_or_revise',
  'archive_inventory',
  'tactical_chat',
] as const;
export type TurnIntent = (typeof TURN_INTENTS)[number];

const ANALYTICAL_MODES = [
  'dossier',
  'head_to_head',
  'debate_or_verdict',
  'ranking_or_tierlist',
  'tactical_or_system',
  'squad_or_recruitment',
  'player_qa',
  'archive',
] as const;
export type AnalyticalMode = (typeof ANALYTICAL_MODES)[number];

export interface TurnRoute {
  intent: TurnIntent;
  analyticalMode?: AnalyticalMode;
  targetPlayers: string[];
  targetClubs?: string[];
  searchQueries?: string[];
  reasoningComplexity?: 'low' | 'medium' | 'high';
  isHistorical: boolean;
  /**
   * A past season the message names ("2005-06", or a bare "2006"). A dossier then rates the
   * player as he was that season instead of at his prime.
   */
  requestedSeason?: string | null;
  /** The message explicitly asks about the player now ("current", "right now", "this season"). */
  wantsCurrentForm?: boolean;
  wantsRegeneration: boolean;
  needsSearch: boolean;
  /** An explicit "rerate": a prime card is regenerated from scratch instead of served. */
  rerate?: boolean;
}

/** Fills the defaults shared by the local fast-path routes. */
const buildRoute = (
  route: Pick<TurnRoute, 'intent' | 'analyticalMode'> & Partial<TurnRoute>,
): TurnRoute => ({
  targetPlayers: [],
  targetClubs: [],
  searchQueries: [],
  reasoningComplexity: 'medium',
  isHistorical: false,
  wantsRegeneration: false,
  needsSearch: true,
  ...route,
});

const TURN_ROUTE_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      enum: [...TURN_INTENTS],
    },
    analyticalMode: {
      type: Type.STRING,
      enum: [...ANALYTICAL_MODES],
      description:
        'Fine-grained analytical mode: "dossier" for single player card; "head_to_head" for comparing 2+ specific players; "debate_or_verdict" for football debates, hot takes, or settling an argument; "ranking_or_tierlist" for top-N lists, positional rankings, or tier lists; "tactical_or_system" for manager systems, formations, or phase-of-play breakdowns; "squad_or_recruitment" for club squad building, transfers, or lineup fit; "player_qa" for specific questions about a player in prose; "archive" for saved dossier queries.',
    },
    targetPlayers: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Full names of the footballer(s) referenced. Resolve pronouns (he/him/his/they/both) to the active dossier or recently discussed players when applicable. Never put club names, managers, or tactical terms here.',
    },
    targetClubs: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Standard names of any football clubs central to the query (e.g. ["Arsenal"], ["Real Madrid", "FC Barcelona"]). Empty array if none.',
    },
    searchQueries: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'When needsSearch is true, provide 1-2 targeted web search queries to verify current-season stats, club/manager facts, tactical usage, or recent results for this exact question. Empty array when needsSearch is false.',
    },
    reasoningComplexity: {
      type: Type.STRING,
      enum: ['low', 'medium', 'high'],
      description:
        '"high" for multi-player debates, rankings, tactical system breakdowns, or contested rating challenges; "medium" for standard comparisons or player analysis; "low" for simple factual lookups or archive checks.',
    },
    isHistorical: {
      type: Type.BOOLEAN,
      description:
        'True if evaluating a historical version of a player (prime, peak, a past season, or a retired player) or a past era. A dossier always rates one version of a player, never a whole career.',
    },
    wantsRegeneration: {
      type: Type.BOOLEAN,
      description:
        'True if the user asks to refresh, re-rate, redo, or generate a new dossier variant (e.g. at a different position) for an already-rated player.',
    },
    needsSearch: {
      type: Type.BOOLEAN,
      description:
        'True if answering accurately requires current-season stats, club/squad verification, manager info, transfer news, or recent match context.',
    },
  },
  required: [
    'intent',
    'analyticalMode',
    'targetPlayers',
    'targetClubs',
    'searchQueries',
    'reasoningComplexity',
    'isHistorical',
    'wantsRegeneration',
    'needsSearch',
  ],
};

/** Alternation of club names the router recognizes in free text (shared by every club regex). */
const CLUB_NAME_ALTERNATION = [
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

const KNOWN_CLUB_REGEX = new RegExp(`\\b(${CLUB_NAME_ALTERNATION})\\b`, 'gi');
// "Chelsea's Cole Palmer" / "PSG's Willian Pacho"
const POSSESSIVE_CLUB_PREFIX_REGEX = new RegExp(`\\b(${CLUB_NAME_ALTERNATION})['\\u2019]s\\s+`, 'gi');
// "Cole Palmer at Chelsea" / "Pacho for PSG"
const TRAILING_CLUB_QUALIFIER_REGEX = new RegExp(
  `\\b(?:at|for|from|of|in)\\s+(${CLUB_NAME_ALTERNATION})\\b`,
  'gi',
);

export const extractReferencedClubs = (message: string): string[] => {
  const matches = message.match(KNOWN_CLUB_REGEX) ?? [];
  const normalized = new Set<string>();
  for (const raw of matches) {
    const key = raw.toLowerCase().replace(/[^a-z]/g, '');
    normalized.add(CLUB_CANON[key] || raw.trim());
  }
  return [...normalized];
};

/**
 * Resolves clubs referenced directly in `message`, or carries forward the active club(s)
 * from recent conversation turns when the user asks an implicit follow-up
 * (e.g. "Which full-back is tucking in?", "Why did you mention Cucurella?", "What about their midfield?").
 */
export const extractThreadClubs = (message: string, history: ChatMessage[]): string[] => {
  const direct = extractReferencedClubs(message);
  if (direct.length > 0) return direct;
  if (history.length === 0) return [];

  for (let i = history.length - 1; i >= Math.max(0, history.length - 4); i--) {
    const msg = history[i];
    if (typeof msg.content === 'string') {
      const clubs = extractReferencedClubs(msg.content);
      if (clubs.length > 0) return clubs.slice(0, 2);
    }
  }
  return [];
};

const stripClubAndDossierQualifiers = (message: string): string =>
  message
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

export const extractCandidateSlug = (message: string): string | null => {
  const name = extractCandidatePlayerName(message);
  return name ? toPlayerSlug(name) : null;
};

const hasChallengeOrQuestionCue = (msg: string): boolean =>
  /\b(why|how come|explain|justify|disagree|wrong|too (?:high|low)|overrated|underrated|make(?:s)? no sense|didn['\u2019]?t ask|don['\u2019]?t (?:rate|generate|make|want)|raw text|in prose|should be|bump|lower|raise|change his|adjust)\b/i.test(
    msg,
  ) ||
  /\byou (?:rate|rated|gave|ranked|put|said)\b/i.test(msg) ||
  /\byour (?:rating|ranking|score|take|analysis)\b/i.test(msg);

const hasCompareCue = (msg: string): boolean =>
  /\b(compare|versus|vs\.?|who(?:'s| is) better|between .+ and)\b/i.test(msg);

const hasRegenCue = (msg: string): boolean =>
  /\b(update|refresh|latest|redo|re-?rate|re-?evaluate|recheck|instead|current form|as a|at (?:st|cf|rw|lw|cam|cm|cdm|lb|rb|cb|gk|striker|winger|midfielder|fullback))\b/i.test(
    msg,
  );

const RERATE_RE = /\bre-?rate\b/i;

const hasHistoricalWordCue = (msg: string): boolean =>
  /\b(prime|peak|all[- ]time|historical)\b/i.test(msg);

/** The season a message names, when it is earlier than the current one. */
const pastSeasonIn = (msg: string): string | null => {
  const season = parseRequestedSeason(msg);
  if (!season) return null;
  const start = seasonStartYear(season);
  const currentStart = seasonStartYear(getCurrentSeasonInfo().currentSeason);
  return start != null && currentStart != null && start < currentStart ? season : null;
};

const hasHistoricalCue = (msg: string): boolean =>
  hasHistoricalWordCue(msg) || pastSeasonIn(msg) !== null;

const hasCurrentFormCue = (msg: string): boolean =>
  /\b(current(?:ly)?|right now|nowadays|today|this season|these days|at the moment)\b/i.test(msg);

const hasDossierTriggerCue = (msg: string): boolean =>
  /\b(rate|rating|profile|scout|evaluate|scouting|dossier|how good is|rank|tier|analyze|breakdown)\b/i.test(
    msg,
  ) || /\b(analysis on|report on|break down)\b/i.test(msg);

const isBarePlayerQuery = (msg: string): boolean => {
  if (/[?!]/.test(msg)) return false;
  const words = msg.trim().split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;
  if (
    /\b(what|why|who|how|when|where|which|is|are|was|were|can|could|should|would|do|does|did|will|tell|list|show|explain|thoughts|think|hello|hi|hey|thanks|thank|help|best|top|squad|team|lineup|table|standings|fixtures)\b/i.test(
      msg,
    )
  ) {
    return false;
  }
  return true;
};

/** Checks whether a challenge turn explicitly cites external/live facts requiring web verification. */
const challengeNeedsWebSearch = (msg: string): boolean =>
  /\b(stats?|goals?|assists?|appearances?|apps|minutes|mins|clean\s+sheets?|xg|xa|season|202\d|club|team|transfer|loan|signed|manager|coach|injured|injury|fit|fitness|started|match|fixture|trophy|trophies|award|ballon\s+d['\u2019]?or|champions\s+league|ucl|premier\s+league|la\s+liga|serie\s+a|bundesliga|ligue\s+1)\b/i.test(
    msg,
  );

/**
 * Extracts 2-4 player names from unambiguous head-to-head comparison prompts
 * ("Compare Saka and Salah", "Wharton vs Baleba", "Who is better between Caicedo and Rice?", "Compare him to Salah").
 */
const extractComparedPlayersFast = (
  message: string,
  conversationDossiers: PlayerProfile[],
): string[] | null => {
  const cleaned = message
    .replace(
      /^(?:can you\s+|please\s+|could you\s+)?(?:compare|give me a comparison (?:of|between)|who(?:'s| is) better(?:\s+between)?|between)\s+/i,
      '',
    )
    .replace(
      /\b(?:in terms of (?:player )?profile|in raw text|in prose|right now|currently|this season|overall|as a player|for me)\b/gi,
      '',
    )
    .replace(/[?!.:]/g, ' ')
    .trim();

  if (!/\b(?:vs\.?|versus|and|or|with|to)\b|,/i.test(cleaned)) return null;

  const rawParts = cleaned
    .split(/\s*(?:\b(?:vs\.?|versus|and|or|with|to)\b|,)\s*/i)
    .map((p) => stripClubAndDossierQualifiers(p))
    .filter(Boolean);

  if (rawParts.length < 2 || rawParts.length > 4) return null;

  const activeDossierName =
    conversationDossiers.length > 0
      ? conversationDossiers[conversationDossiers.length - 1].basicInfo.name
      : null;

  const resolved: string[] = [];
  for (const part of rawParts) {
    if (/^(?:he|him|his)$/i.test(part)) {
      if (!activeDossierName) return null;
      resolved.push(activeDossierName);
      continue;
    }
    const words = part.split(/\s+/);
    if (words.length < 1 || words.length > 4) return null;
    if (isNonSinglePlayerSubject(part)) return null;
    if (
      /\b(what|why|who|how|when|where|which|should|would|could|better|worse|think)\b/i.test(
        part,
      )
    ) {
      return null;
    }
    resolved.push(part);
  }

  return resolved.length >= 2 ? [...new Set(resolved)] : null;
};

export async function classifyTurn(params: {
  message: string;
  history: ChatMessage[];
  conversationDossiers: PlayerProfile[];
  hasImage: boolean;
}): Promise<TurnRoute> {
  const route = await classifyTurnBase(params);
  // Timeframes are read deterministically, whichever path classified the turn: a named past
  // season is a historical version of the player; a current-season year alone is not.
  const message = params.message.trim();
  const requestedSeason = pastSeasonIn(message);
  const wantsCurrentForm = hasCurrentFormCue(message);
  return {
    ...route,
    requestedSeason,
    wantsCurrentForm,
    isHistorical:
      requestedSeason !== null ||
      (route.isHistorical && (hasHistoricalWordCue(message) || !parseRequestedSeason(message))),
  };
}

async function classifyTurnBase(params: {
  message: string;
  history: ChatMessage[];
  conversationDossiers: PlayerProfile[];
  hasImage: boolean;
}): Promise<TurnRoute> {
  const { message, history, conversationDossiers, hasImage } = params;
  const trimmed = message.trim();

  // 1. 0ms local fast-path for archive inventory queries
  if (!hasImage && wantsSavedDossierInventory(trimmed)) {
    return buildRoute({
      intent: 'archive_inventory',
      analyticalMode: 'archive',
      reasoningComplexity: 'low',
      needsSearch: false,
    });
  }

  const isHistorical = hasHistoricalCue(trimmed);

  // "Rerate <player>" (or "rerate him") regenerates the card from scratch. Only a bare command
  // takes this path; anything longer goes through the usual routing.
  if (!hasImage && RERATE_RE.test(trimmed) && !hasCompareCue(trimmed)) {
    const named = extractCandidatePlayerName(trimmed.replace(RERATE_RE, ' '));
    const last = conversationDossiers.at(-1);
    const pronoun = Boolean(named && /^(?:he|him|his)$/i.test(named));
    const name = pronoun ? last?.basicInfo.name : named;
    if (name && !/\b(?:he|him|his|they|them|their|it|this|that)\b/i.test(name)) {
      return buildRoute({
        intent: 'single_dossier',
        analyticalMode: 'dossier',
        targetPlayers: [name],
        targetClubs: extractReferencedClubs(trimmed),
        // "Rerate him" re-rates the card he was just shown in.
        isHistorical: isHistorical || Boolean(pronoun && last && isPrimeCard(last)),
        wantsRegeneration: true,
        rerate: true,
      });
    }
  }

  const wantsRegeneration = hasRegenCue(trimmed);
  const hasChallenge = hasChallengeOrQuestionCue(trimmed);
  const hasCompare = hasCompareCue(trimmed);
  const hasDossierTrigger = hasDossierTriggerCue(trimmed);
  const isBarePlayerName = isBarePlayerQuery(trimmed);
  const isNonPlayerSubject = isNonSinglePlayerSubject(trimmed);
  const referencedClubs = extractReferencedClubs(trimmed);

  // 2. 0ms local fast-path for unambiguous single-player dossier requests
  // ("Rate Cole Palmer", "Rate Chelsea's Cole Palmer", "Rate Prime John Terry", or bare player names)
  if (
    !hasImage &&
    !isNonPlayerSubject &&
    (hasDossierTrigger || isBarePlayerName) &&
    !hasChallenge &&
    !hasCompare &&
    !wantsRegeneration &&
    !/\b(and|or|vs|versus)\b/i.test(trimmed)
  ) {
    const candidateName = extractCandidatePlayerName(trimmed);
    if (candidateName && !/\b(he|him|his|they|them|their|it|this|that)\b/i.test(candidateName)) {
      return buildRoute({
        intent: 'single_dossier',
        analyticalMode: 'dossier',
        targetPlayers: [candidateName],
        targetClubs: referencedClubs,
        isHistorical,
      });
    }
  }

  // 3. 0ms local fast-path for head-to-head player comparisons ("Wharton vs Baleba", "Compare Saka and Salah")
  if (!hasImage && hasCompare && !hasChallenge) {
    const comparedPlayers = extractComparedPlayersFast(trimmed, conversationDossiers);
    if (comparedPlayers && comparedPlayers.length >= 2) {
      return buildRoute({
        intent: 'compare',
        analyticalMode: 'head_to_head',
        targetPlayers: comparedPlayers,
        targetClubs: referencedClubs,
        isHistorical,
      });
    }
  }

  // 4. 0ms local fast-path for dossier rating/attribute challenges & live revisions
  if (
    !hasImage &&
    conversationDossiers.length > 0 &&
    hasChallenge &&
    !hasCompare &&
    !/\b(don['\u2019]?t (?:rate|generate|make)|raw text|in prose)\b/i.test(trimmed)
  ) {
    const referenced = findReferencedDossiers(trimmed, conversationDossiers);
    const targetDossier =
      referenced[0] || conversationDossiers[conversationDossiers.length - 1];
    if (targetDossier) {
      const needsSearch = challengeNeedsWebSearch(trimmed);
      return buildRoute({
        intent: 'challenge_or_revise',
        analyticalMode: 'debate_or_verdict',
        targetPlayers: [targetDossier.basicInfo.name],
        targetClubs: referencedClubs,
        searchQueries: needsSearch
          ? [`${targetDossier.basicInfo.name} ${trimmed} current season stats verification`]
          : [],
        isHistorical,
        needsSearch,
      });
    }
  }

  // 5. 0ms local fast-path for explicit positional rankings / tier lists ("Rank the top 5 CBs", "Best strikers right now")
  if (
    !hasImage &&
    !hasChallenge &&
    !hasCompare &&
    /\b(top\s+\d+|rank\s+the|tier\s*list|best\s+(?:strikers|midfielders|defenders|wingers|full[- ]?backs|centre[- ]?backs|center[- ]?backs|goalkeepers|keepers|forwards|players|cdms|dms|cms|cams|ams|cbs|lbs|rbs|rws|lws))\b/i.test(
      trimmed,
    )
  ) {
    return buildRoute({
      intent: 'tactical_chat',
      analyticalMode: 'ranking_or_tierlist',
      targetClubs: referencedClubs,
      searchQueries: [`${trimmed} world football rankings performance stats`],
      reasoningComplexity: 'high',
      isHistorical,
    });
  }

  // 6. 0ms local fast-path for explicit club tactical / squad breakdowns ("Analyze Arsenal's midfield", "Break down Barcelona's high line")
  if (
    !hasImage &&
    !hasChallenge &&
    !hasCompare &&
    referencedClubs.length > 0 &&
    isNonPlayerSubject &&
    /\b(tactics|tactical|system|formation|high\s+line|low\s+block|build[- ]?up|pressing|rest[- ]?defen[cs]e|midfield|attack|defen[cs]e|squad|lineup|starting\s+xi|signings|targets|transfer|recruitment)\b/i.test(
      trimmed,
    )
  ) {
    const isSquadMode = /\b(squad|lineup|starting\s+xi|signings|targets|transfer|recruitment)\b/i.test(
      trimmed,
    );
    const clubLabel = referencedClubs.join(' ');
    const { year: currentYear } = getCurrentSeasonInfo();
    return buildRoute({
      intent: 'tactical_chat',
      analyticalMode: isSquadMode ? 'squad_or_recruitment' : 'tactical_or_system',
      targetClubs: referencedClubs,
      searchQueries: [
        buildSquadTurnoverQuery(clubLabel, currentYear),
        `${clubLabel} current head coach tactical system starting XI by position and player roles: ${trimmed}`,
      ],
      reasoningComplexity: 'high',
      isHistorical,
    });
  }

  // 7. Schema-enforced LLM turn classifier for nuanced/conversational/pronoun-bearing messages
  const activeDossierNames = conversationDossiers.map(
    (d) => `${d.basicInfo.name} (${d.ratings.overall} OVR, ${d.basicInfo.position}, ${d.basicInfo.club})`,
  );
  const recentTurns = history
    .slice(-5)
    .map((m) => {
      const role = m.sender === 'user' ? 'User' : 'Scout';
      const text =
        typeof m.content === 'string'
          ? m.content.slice(0, 320)
          : isPlayerProfile(m.content)
            ? `[Generated Dossier: ${m.content.basicInfo.name} (${m.content.ratings.overall} OVR / ${m.content.ratings.potential} POT, ${m.content.basicInfo.position}, ${m.content.basicInfo.club})]`
            : `[Dossier generated]`;
      return `${role}: ${text}`;
    })
    .join('\n');

  try {
    const prompt = `Classify the user's football scouting message into a structured TurnRoute.

Context:
- Dossiers already generated in this conversation: ${activeDossierNames.join(', ') || 'None'}
- Most recent dossier player (resolve "he/him/his" to this player when applicable): ${
      conversationDossiers.length > 0
        ? conversationDossiers[conversationDossiers.length - 1].basicInfo.name
        : 'None'
    }
- Image attached: ${hasImage}
${recentTurns ? `- Recent conversation turns:\n${recentTurns}` : ''}

Intent rules:
- "single_dossier": User wants a full scouting profile/rating card for ONE specific footballer (e.g. "Rate Palmer", "Give me a dossier on Saka", "Re-rate him at striker"). NEVER choose single_dossier if:
  * the user is asking about a club, manager, tactical system, transfer window, or group/ranking ("Rank the top 5 strikers", "Analyze Arsenal's midfield", "Break down Barcelona's high line"),
  * the user is asking "Why did you rate him X?" or disagreeing with a rating,
  * the user asks a specific prose question about a player ("How does Pedri evade pressure?", "Is Yamal the best RW in the world?"),
  * the user is comparing two or more players.
- "compare": User wants two or more specific players compared head-to-head (e.g. "Compare Saka and Salah", "Wharton vs Baleba", "Who is better between Caicedo and Rice?").
- "challenge_or_revise": User is questioning, challenging, disagreeing with, or asking to adjust a rating or attribute on a dossier already in this conversation (e.g. "Why is his passing 78?", "84 overall is too low, he should be 87", "His dribbling should be higher").
- "archive_inventory": User is asking what saved dossiers they have in their archive.
- "tactical_chat": Any football debate, ranking/tier list ("Rank the top 5 CBs"), tactical system analysis, club squad/transfer discussion, or specific prose question about a player.

Analytical mode rules:
- Choose the exact \`analyticalMode\` matching the user's intent ("dossier", "head_to_head", "debate_or_verdict", "ranking_or_tierlist", "tactical_or_system", "squad_or_recruitment", "player_qa", "archive").
- When \`needsSearch\` is true, generate 1-2 sharp \`searchQueries\` tailored to verify current-season stats, club/coach facts, tactical usage, or peer benchmarks for this specific prompt.

User message: "${trimmed}"`;

    const route = await generateStructured<TurnRoute>({
      task: 'routing',
      prompt,
      schema: TURN_ROUTE_SCHEMA,
    });

    // Safety guardrails over LLM classification:
    if (hasCompare && route.intent === 'single_dossier') {
      route.intent = 'compare';
      route.analyticalMode = 'head_to_head';
    }
    if (route.intent === 'single_dossier' && route.targetPlayers.length > 1) {
      route.intent = 'compare';
      route.analyticalMode = 'head_to_head';
    }
    if (route.intent === 'single_dossier' && isNonPlayerSubject) {
      route.intent = 'tactical_chat';
      if (!route.analyticalMode || route.analyticalMode === 'dossier') {
        route.analyticalMode = /\b(top\s+\d+|rank|tier\s*list|best)\b/i.test(trimmed)
          ? 'ranking_or_tierlist'
          : 'tactical_or_system';
      }
    }
    if (
      /\bdon['\u2019]?t (?:rate|generate|make|create|profile)\b|\b(raw text|in prose)\b/i.test(
        trimmed,
      ) &&
      route.intent === 'single_dossier'
    ) {
      route.intent = hasCompare ? 'compare' : 'tactical_chat';
      route.analyticalMode = hasCompare ? 'head_to_head' : 'player_qa';
    }
    if (route.intent === 'single_dossier' && !hasImage && route.targetPlayers.length === 0) {
      const fallbackName = extractCandidatePlayerName(trimmed);
      if (fallbackName) {
        route.targetPlayers = [fallbackName];
      } else {
        route.intent = 'tactical_chat';
        route.analyticalMode = 'tactical_or_system';
      }
    }
    if (
      route.intent === 'challenge_or_revise' &&
      conversationDossiers.length === 0
    ) {
      route.intent = 'tactical_chat';
      route.analyticalMode = 'debate_or_verdict';
    }

    return route;
  } catch (e) {
    console.warn('[TurnRouter] Structured classifier fallback:', e);
    const candidateName = extractCandidatePlayerName(trimmed);
    const isFormalFallback =
      !isNonPlayerSubject &&
      hasDossierTrigger &&
      !hasChallenge &&
      !hasCompare &&
      (Boolean(candidateName) || hasImage);
    return buildRoute({
      intent: isFormalFallback
        ? 'single_dossier'
        : hasCompare
          ? 'compare'
          : hasChallenge && conversationDossiers.length > 0
            ? 'challenge_or_revise'
            : 'tactical_chat',
      analyticalMode: isFormalFallback
        ? 'dossier'
        : hasCompare
          ? 'head_to_head'
          : 'debate_or_verdict',
      targetPlayers: candidateName ? [candidateName] : [],
      isHistorical,
      wantsRegeneration,
    });
  }
}
