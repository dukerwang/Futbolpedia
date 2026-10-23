import { Type } from '@google/genai';
import type { ChatMessage, PlayerProfile } from '../types';
import { CLUB_CANON } from '../constants/ratingTiers';
import { generateStructured } from './aiClient';
import { isPlayerProfile, toPlayerSlug, wantsSavedDossierInventory } from './dossierStore';

export type TurnIntent =
  | 'single_dossier'
  | 'compare'
  | 'challenge_or_revise'
  | 'archive_inventory'
  | 'tactical_chat';

export type AnalyticalMode =
  | 'dossier'
  | 'head_to_head'
  | 'debate_or_verdict'
  | 'ranking_or_tierlist'
  | 'tactical_or_system'
  | 'squad_or_recruitment'
  | 'player_qa'
  | 'archive';

export interface TurnRoute {
  intent: TurnIntent;
  analyticalMode?: AnalyticalMode;
  targetPlayers: string[];
  targetClubs?: string[];
  searchQueries?: string[];
  reasoningComplexity?: 'low' | 'medium' | 'high';
  isHistorical: boolean;
  wantsRegeneration: boolean;
  needsSearch: boolean;
}

const TURN_ROUTE_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      enum: [
        'single_dossier',
        'compare',
        'challenge_or_revise',
        'archive_inventory',
        'tactical_chat',
      ],
    },
    analyticalMode: {
      type: Type.STRING,
      enum: [
        'dossier',
        'head_to_head',
        'debate_or_verdict',
        'ranking_or_tierlist',
        'tactical_or_system',
        'squad_or_recruitment',
        'player_qa',
        'archive',
      ],
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
      description: 'True if evaluating a historical/prime/peak/all-time version of a player or era.',
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

  // Club names or possessive phrases (e.g., "Arsenal's", "Barcelona", "Real Madrid")
  if (
    /\b(arsenal|chelsea|liverpool|manchester\s+city|man\s+city|manchester\s+united|man\s+utd|tottenham|spurs|newcastle|aston\s+villa|brighton|real\s+madrid|barcelona|barca|atletico\s+madrid|bayern\s+munich|bayern|dortmund|leverkusen|psg|paris\s+saint[- ]germain|inter\s+milan|ac\s+milan|juventus|napoli|benfica|porto|sporting|ajax)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  // Possessive 's on a subject (e.g. "Slot's system", "Palmer's passing") usually asks a specific question
  if (/\b\w+['\u2019]s\s+\w+/i.test(trimmed)) {
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

  const candidate = message
    .replace(/\b(give me a?n?|create|generate|can you|please|show me|pull up)\b/gi, '')
    .replace(
      /\b(rate|rating|profile|scout(?:ing)?(?: report)?|evaluate|dossier|how good is|rank(?:ing)?|tier|analyze|analysis|breakdown|report|brief(?:ing)?)\b/gi,
      '',
    )
    .replace(/\b(on|for|about|of|a|an|the|me|right now|currently)\b/gi, '')
    .replace(/[?!.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!candidate || candidate.length < 2 || candidate.split(' ').length > 5) return null;
  if (isNonSinglePlayerSubject(candidate)) return null;
  return candidate;
};

export const extractCandidateSlug = (message: string): string | null => {
  const name = extractCandidatePlayerName(message);
  return name ? toPlayerSlug(name) : null;
};

const HAS_CHALLENGE_OR_QUESTION_CUE = (msg: string): boolean =>
  /\b(why|how come|explain|justify|disagree|wrong|too (?:high|low)|overrated|underrated|make(?:s)? no sense|didn['\u2019]?t ask|don['\u2019]?t (?:rate|generate|make|want)|raw text|in prose|should be|bump|lower|raise|change his|adjust)\b/i.test(
    msg,
  ) ||
  /\byou (?:rate|rated|gave|ranked|put|said)\b/i.test(msg) ||
  /\byour (?:rating|ranking|score|take|analysis)\b/i.test(msg);

const HAS_COMPARE_CUE = (msg: string): boolean =>
  /\b(compare|versus|vs\.?|who(?:'s| is) better|between .+ and)\b/i.test(msg);

const HAS_REGEN_CUE = (msg: string): boolean =>
  /\b(update|refresh|latest|redo|re-?rate|re-?evaluate|recheck|instead|current form|as a|at (?:st|cf|rw|lw|cam|cm|cdm|lb|rb|cb|gk|striker|winger|midfielder|fullback))\b/i.test(
    msg,
  );

const HAS_HISTORICAL_CUE = (msg: string): boolean =>
  /\b(prime|peak|all[- ]time|historical|\b(?:19|20)\d{2}(?:[/-]\d{2,4})?\b)\b/i.test(msg);

const HAS_DOSSIER_TRIGGER = (msg: string): boolean =>
  /\b(rate|rating|profile|scout|evaluate|scouting|dossier|how good is|rank|tier|analyze|breakdown)\b/i.test(
    msg,
  ) || /\b(analysis on|report on|break down)\b/i.test(msg);

const IS_BARE_PLAYER_QUERY = (msg: string): boolean => {
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

export async function classifyTurn(params: {
  message: string;
  history: ChatMessage[];
  conversationDossiers: PlayerProfile[];
  hasImage: boolean;
}): Promise<TurnRoute> {
  const { message, history, conversationDossiers, hasImage } = params;
  const trimmed = message.trim();

  // 1. 0ms local fast-path for archive inventory queries
  if (!hasImage && wantsSavedDossierInventory(trimmed)) {
    return {
      intent: 'archive_inventory',
      analyticalMode: 'archive',
      targetPlayers: [],
      targetClubs: [],
      searchQueries: [],
      reasoningComplexity: 'low',
      isHistorical: false,
      wantsRegeneration: false,
      needsSearch: false,
    };
  }

  const isHistorical = HAS_HISTORICAL_CUE(trimmed);
  const wantsRegeneration = HAS_REGEN_CUE(trimmed);
  const hasChallenge = HAS_CHALLENGE_OR_QUESTION_CUE(trimmed);
  const hasCompare = HAS_COMPARE_CUE(trimmed);
  const hasDossierTrigger = HAS_DOSSIER_TRIGGER(trimmed);
  const isBarePlayerName = IS_BARE_PLAYER_QUERY(trimmed);
  const isNonPlayerSubject = isNonSinglePlayerSubject(trimmed);

  // 2. 0ms local fast-path for unambiguous single-player dossier requests
  // ("Rate Cole Palmer", "Rate Prime John Terry", or bare player names like "dembele", "willian pacho", "prime john terry")
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
      return {
        intent: 'single_dossier',
        analyticalMode: 'dossier',
        targetPlayers: [candidateName],
        targetClubs: [],
        searchQueries: [],
        reasoningComplexity: 'medium',
        isHistorical,
        wantsRegeneration: false,
        needsSearch: true,
      };
    }
  }

  // 3. Schema-enforced LLM turn classifier for nuanced/conversational/pronoun-bearing messages
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
    return {
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
      targetClubs: [],
      searchQueries: [],
      reasoningComplexity: 'medium',
      isHistorical,
      wantsRegeneration,
      needsSearch: true,
    };
  }
}
