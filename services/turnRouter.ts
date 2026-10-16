import { Type } from '@google/genai';
import type { ChatMessage, PlayerProfile } from '../types';
import { generateStructured } from './aiClient';
import { toPlayerSlug, wantsSavedDossierInventory } from './dossierStore';

export type TurnIntent =
  | 'single_dossier'
  | 'compare'
  | 'challenge_or_revise'
  | 'archive_inventory'
  | 'tactical_chat';

export interface TurnRoute {
  intent: TurnIntent;
  targetPlayers: string[];
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
    targetPlayers: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Full names of the footballer(s) referenced. Resolve pronouns (he/him/his) to the active dossier player name when applicable.',
    },
    isHistorical: {
      type: Type.BOOLEAN,
      description: 'True if evaluating a historical/prime/peak/all-time version of a player.',
    },
    wantsRegeneration: {
      type: Type.BOOLEAN,
      description:
        'True if the user asks to refresh, re-rate, redo, or generate a new dossier variant (e.g. at a different position) for an already-rated player.',
    },
    needsSearch: {
      type: Type.BOOLEAN,
      description:
        'True if answering accurately requires current-season stats, club/squad verification, manager info, or recent news.',
    },
  },
  required: ['intent', 'targetPlayers', 'isHistorical', 'wantsRegeneration', 'needsSearch'],
};

/**
 * Extracts a candidate player name from a simple single-player dossier prompt.
 * Returns null if the message contains complex clauses or no identifiable name.
 */
export const extractCandidatePlayerName = (message: string): string | null => {
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
      targetPlayers: [],
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

  // 2. 0ms local fast-path for unambiguous single-player dossier requests ("Rate Cole Palmer")
  if (
    !hasImage &&
    hasDossierTrigger &&
    !hasChallenge &&
    !hasCompare &&
    !wantsRegeneration &&
    !isHistorical &&
    !/\b(and|or)\b/i.test(trimmed)
  ) {
    const candidateName = extractCandidatePlayerName(trimmed);
    if (candidateName && !/\b(he|him|his|they|them|their|it|this|that)\b/i.test(candidateName)) {
      return {
        intent: 'single_dossier',
        targetPlayers: [candidateName],
        isHistorical: false,
        wantsRegeneration: false,
        needsSearch: true,
      };
    }
  }

  // 3. Schema-enforced LLM turn classifier for nuanced/conversational/pronoun-bearing messages
  const activeDossierNames = conversationDossiers.map(
    (d) => `${d.basicInfo.name} (${d.ratings.overall} OVR, ${d.basicInfo.position})`,
  );
  const recentTurns = history
    .slice(-2)
    .map((m) => {
      const role = m.sender === 'user' ? 'User' : 'Scout';
      const text =
        typeof m.content === 'string'
          ? m.content.slice(0, 240)
          : `[Dossier generated]`;
      return `${role}: ${text}`;
    })
    .join('\n');

  try {
    const prompt = `Classify the user's football scouting message into a structured TurnRoute.

Context:
- Dossiers already generated in this conversation: ${activeDossierNames.join(', ') || 'None'}
- Most recent dossier player (resolve "he/him/his" to this player): ${
      conversationDossiers.length > 0
        ? conversationDossiers[conversationDossiers.length - 1].basicInfo.name
        : 'None'
    }
- Image attached: ${hasImage}
${recentTurns ? `- Recent turns:\n${recentTurns}` : ''}

Intent rules:
- "single_dossier": User wants a full scouting profile/rating card for ONE specific player (e.g. "Rate Palmer", "Give me a dossier on Saka", "Re-rate him at striker"). NEVER choose single_dossier if the user is asking "Why did you rate him X?", disagreeing with a rating, asking for raw text/prose only, or comparing two or more players.
- "compare": User wants two or more players compared (e.g. "Compare Saka and Salah", "Wharton vs Baleba", "Compare them in terms of player profile").
- "challenge_or_revise": User is questioning, challenging, disagreeing with, or asking to adjust a rating or attribute on a dossier already in this conversation (e.g. "Why is his passing 78?", "84 overall is too low, he should be 87", "His dribbling should be higher").
- "archive_inventory": User is asking what saved dossiers they have in their archive.
- "tactical_chat": Any other football question, tactical discussion, lineup/squad question, or general follow-up.

User message: "${trimmed}"`;

    const route = await generateStructured<TurnRoute>({
      task: 'routing',
      mode: 'fast',
      prompt,
      schema: TURN_ROUTE_SCHEMA,
    });

    // Safety guardrails over LLM classification:
    if (hasCompare && route.intent === 'single_dossier') {
      route.intent = 'compare';
    }
    if (
      /\bdon['\u2019]?t (?:rate|generate|make|create|profile)\b|\b(raw text|in prose)\b/i.test(
        trimmed,
      ) &&
      route.intent === 'single_dossier'
    ) {
      route.intent = hasCompare ? 'compare' : 'tactical_chat';
    }
    if (route.intent === 'single_dossier' && !hasImage && route.targetPlayers.length === 0) {
      const fallbackName = extractCandidatePlayerName(trimmed);
      if (fallbackName) {
        route.targetPlayers = [fallbackName];
      } else {
        route.intent = 'tactical_chat';
      }
    }
    if (
      route.intent === 'challenge_or_revise' &&
      conversationDossiers.length === 0
    ) {
      route.intent = 'tactical_chat';
    }

    return route;
  } catch (e) {
    console.warn('[TurnRouter] Structured classifier fallback:', e);
    const candidateName = extractCandidatePlayerName(trimmed);
    const isFormalFallback =
      hasDossierTrigger && !hasChallenge && !hasCompare && (Boolean(candidateName) || hasImage);
    return {
      intent: isFormalFallback
        ? 'single_dossier'
        : hasCompare
          ? 'compare'
          : hasChallenge && conversationDossiers.length > 0
            ? 'challenge_or_revise'
            : 'tactical_chat',
      targetPlayers: candidateName ? [candidateName] : [],
      isHistorical,
      wantsRegeneration,
      needsSearch: true,
    };
  }
}
