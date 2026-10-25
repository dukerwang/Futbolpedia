import type { Content, Part } from '@google/genai';
import type { Attributes, ChatMessage, GoalkeeperAttributes, PlayerProfile } from '../types';
import { ATTRIBUTE_LABELS, GK_ATTRIBUTE_LABELS } from '../constants/ratingTiers';
import { dataUrlToInlinePart } from './aiClient';
import {
  formatIsoDate,
  getCardKey,
  getDossierEvaluationDate,
  isConfidentDossier,
  isDossierDated,
  isPlayerProfile,
  latestCardPerPlayer,
} from './dossierCards';

/**
 * Dossiers as prompt context: serializing cards into chat history, finding the cards a message
 * refers to, and the locked / saved-archive / prior-rating blocks.
 */

/** "Finishing 97, Speed 92" for a card's highest attributes (above zero, or at least `min`). */
export const formatTopAttributes = (
  attributes: Partial<Attributes> | undefined,
  limit: number,
  min?: number,
): string =>
  Object.entries(attributes || {})
    .filter(([, v]) => typeof v === 'number' && (min === undefined ? v > 0 : v >= min))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => `${ATTRIBUTE_LABELS[k as keyof Attributes] || k} ${v}`)
    .join(', ');

export const isLegacyComparisonContent = (
  content: unknown,
): content is { summary?: string; players?: PlayerProfile[] } =>
  typeof content === 'object' &&
  content !== null &&
  'summary' in content &&
  'players' in content &&
  Array.isArray((content as { players?: unknown }).players);

const AUTHORED_DOSSIER_HEADER =
  '[DOSSIER YOU (Futbolpedia) PREVIOUSLY GENERATED — this is your authored analysis; stay consistent with it unless you explicitly revise a value and say so]';
const SAVED_DOSSIER_HEADER =
  "[USER'S SAVED DOSSIER — from their archive (generated in another conversation). Treat as authoritative when they ask you to reference saved/archived profiles.]";

const serializeCard = (p: PlayerProfile, header: string): string => {
  const bi = p.basicInfo;
  const attrs = p.goalkeeperAttributes
    ? Object.entries(p.goalkeeperAttributes)
        .map(([k, v]) => `${GK_ATTRIBUTE_LABELS[k as keyof GoalkeeperAttributes] ?? k} ${v}`)
        .join(', ')
    : Object.entries(p.attributes)
        .map(([k, v]) => `${ATTRIBUTE_LABELS[k as keyof Attributes] ?? k} ${v}`)
        .join(', ');
  const roles = p.playstyleAndRole?.bestRoles?.join(', ') || 'N/A';
  return [
    header,
    `Name: ${bi?.name} | Age: ${bi?.age} | Nationality: ${bi?.nationality} | Club: ${bi?.club} | Position: ${bi?.position}`,
    p.version
      ? `Edition: ${p.version.label} | Evaluated: ${getDossierEvaluationDate(p) ?? 'undated'}`
      : '',
    `Overall: ${p.ratings?.overall} | Potential: ${p.ratings?.potential}`,
    `Archetype: ${p.playstyleAndRole?.playstyle?.archetype} | Best Roles: ${roles}`,
    `${p.goalkeeperAttributes ? 'Goalkeeper Attributes' : 'Attributes'} (0-99): ${attrs}`,
    p.strengths?.length ? `Strengths: ${p.strengths.join(' ')}` : '',
    p.weaknesses?.length ? `Weaknesses: ${p.weaknesses.join(' ')}` : '',
    p.playstyleAndRole?.playstyle?.description
      ? `Playstyle: ${p.playstyleAndRole.playstyle.description}`
      : '',
    p.shortBio ? `Bio: ${p.shortBio}` : '',
    p.latestUpdate ? `Latest Update: ${p.latestUpdate}` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

export const serializeProfileForHistory = (p: PlayerProfile): string =>
  serializeCard(p, AUTHORED_DOSSIER_HEADER);

export const serializeLegacyComparisonForHistory = (content: {
  summary?: string;
  players?: PlayerProfile[];
}): string => {
  const players = (content.players || []).map(serializeProfileForHistory).join('\n\n');
  return [
    `[COMPARISON YOU (Futbolpedia) PREVIOUSLY GENERATED — stay consistent with these ratings unless you explicitly revise them]`,
    content.summary ? `Summary: ${content.summary}` : '',
    players,
  ]
    .filter(Boolean)
    .join('\n\n');
};

/** Every card the AI posted in this history, including players inside legacy comparisons. */
const historyCards = (history: ChatMessage[]): PlayerProfile[] => {
  const out: PlayerProfile[] = [];
  for (const msg of history) {
    if (msg.sender !== 'ai') continue;
    if (isPlayerProfile(msg.content)) {
      out.push(msg.content);
    } else if (isLegacyComparisonContent(msg.content)) {
      out.push(...(msg.content.players || []));
    }
  }
  return out;
};

export const collectDossiersFromHistory = (history: ChatMessage[]): PlayerProfile[] =>
  historyCards(history).filter(isConfidentDossier);

export const mergeConversationDossiers = (
  history: ChatMessage[],
  conversationProfiles: PlayerProfile[] = [],
): PlayerProfile[] =>
  latestCardPerPlayer([
    ...collectDossiersFromHistory(history),
    ...conversationProfiles.filter(isConfidentDossier),
  ]);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const findReferencedDossiers = (
  message: string,
  dossiers: PlayerProfile[],
  explicitNames: string[] = [],
): PlayerProfile[] => {
  if (dossiers.length === 0) return [];
  const lower = message.toLowerCase();
  const matched = new Map<string, PlayerProfile>();

  const checkText = [lower, ...explicitNames.map((n) => n.toLowerCase())].join(' ');

  for (const d of dossiers) {
    const name = d.basicInfo.name.toLowerCase();
    const tokens = name.split(/\s+/).filter((t) => t.length >= 4);
    const hit =
      checkText.includes(name) ||
      tokens.some((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`).test(checkText));
    if (hit) matched.set(getCardKey(d), d);
  }

  if (matched.size === 0 && /\b(he|him|his|they|them|their)\b/i.test(message)) {
    const latest = dossiers[dossiers.length - 1];
    matched.set(getCardKey(latest), latest);
  }

  return [...matched.values()];
};

export const buildLockedDossiersBlock = (dossiers: PlayerProfile[]): string => {
  if (dossiers.length === 0) return '';
  const body = dossiers.map(serializeProfileForHistory).join('\n\n');
  return `
    <locked_dossiers>
    The player(s) below were ALREADY rated earlier in this conversation. These dossiers are LAW: reuse the EXACT Overall, Potential, and all attribute values shown — do NOT recompute or drift them. Prose may be reworded, but every number must match. Only a player NOT listed here may be rated fresh from the factual foundation.
    ${body}
    </locked_dossiers>`;
};

export const wantsSavedDossierAccess = (message: string): boolean =>
  /\b(my|saved|archived|other|previous)\s+(dossiers?|profiles?|scouts?|ratings?)\b/i.test(
    message,
  ) ||
  /\bdossiers?\s+(i|I've|I have|I've got)\b/i.test(message) ||
  /\b(from|in)\s+my\s+(saved|archive|dossiers?|library|collection)\b/i.test(message) ||
  /\b(pull up|look up|check|use|reference|show|open|view|load)\s+(my|a|the)\s+(saved|archived)\b/i.test(
    message,
  ) ||
  (/\b(what|which|list|show)\b[\s\S]{0,40}\b(dossiers?|profiles?)\b/i.test(message) &&
    /\b(have|saved|got|my|archive)\b/i.test(message)) ||
  /\blist\s+(my\s+)?(saved\s+)?dossiers\b/i.test(message);

export const wantsSavedDossierInventory = (message: string): boolean =>
  /\b(what|which|list|show)\b/i.test(message) &&
  /\b(dossiers?|profiles?)\b/i.test(message) &&
  /\b(have|saved|got|my|archive|collection)\b/i.test(message) &&
  !/\b(rate|scout|profile|evaluate|analyze|breakdown|dossier)\s+(for|on|of)\b/i.test(message);

export const buildSavedDossiersBlock = (
  dossiers: PlayerProfile[],
  inventoryOnly: boolean,
): string => {
  const confident = dossiers.filter(isConfidentDossier);
  if (confident.length === 0) return '';
  if (inventoryOnly) {
    const rows = confident
      .map(
        (p) =>
          `- ${p.basicInfo.name}: ${p.ratings.overall} OVR (Pot ${p.ratings.potential}), ${p.basicInfo.club}, ${p.basicInfo.position}`,
      )
      .join('\n');
    return `
    <saved_dossier_archive>
    The user asked about dossiers they have saved on file (${confident.length} total). Index only — summarize this list conversationally if they want an overview; if they name a player, use their full saved dossier when provided.
    ${rows}
    </saved_dossier_archive>`;
  }
  const body = confident.map((p) => serializeCard(p, SAVED_DOSSIER_HEADER)).join('\n\n');
  return `
    <saved_dossiers>
    The user explicitly asked you to reference dossier(s) from their saved archive (profiles generated in other conversations). Use these exact ratings and attributes — do NOT regenerate or contradict them unless they ask for a fresh rating.
    ${body}
    </saved_dossiers>`;
};

export const resolveSavedDossiersForRequest = (
  message: string,
  savedDossiers: PlayerProfile[],
  conversationDossiers: PlayerProfile[],
  explicitNames: string[] = [],
): { dossiers: PlayerProfile[]; inventoryOnly: boolean } => {
  const confident = latestCardPerPlayer(savedDossiers.filter(isConfidentDossier));
  if (confident.length === 0 || !wantsSavedDossierAccess(message)) {
    return { dossiers: [], inventoryOnly: false };
  }

  const referenced = findReferencedDossiers(message, confident, explicitNames);
  const inventoryOnly = wantsSavedDossierInventory(message) && referenced.length === 0;

  if (inventoryOnly || referenced.length === 0) return { dossiers: confident, inventoryOnly: true };

  const convKeys = new Set(conversationDossiers.map(getCardKey));
  const notInConversation = referenced.filter((p) => !convKeys.has(getCardKey(p)));
  return {
    dossiers: notInConversation.length > 0 ? notInConversation : referenced,
    inventoryOnly: false,
  };
};

const MAX_HISTORY_TURNS = 12;

export const buildHistoryContents = (
  history: ChatMessage[],
  conversationProfiles: PlayerProfile[] = [],
): Content[] => {
  const geminiHistory: Content[] = [];
  for (const msg of history.slice(-MAX_HISTORY_TURNS)) {
    const isUser = msg.sender === 'user';
    const parts: Part[] = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (isPlayerProfile(msg.content) && !isUser) {
      parts.push({ text: serializeProfileForHistory(msg.content) });
    } else if (isLegacyComparisonContent(msg.content) && !isUser) {
      parts.push({ text: serializeLegacyComparisonForHistory(msg.content) });
    }

    if (msg.image && isUser) parts.push(dataUrlToInlinePart(msg.image));

    if (parts.length > 0) geminiHistory.push({ role: isUser ? 'user' : 'model', parts });
  }

  // Cards the conversation holds but never posted (e.g. opened from the library) ride along too.
  const covered = new Set(historyCards(history).map(getCardKey));
  for (const p of conversationProfiles) {
    if (!isConfidentDossier(p) || covered.has(getCardKey(p))) continue;
    geminiHistory.push({ role: 'model', parts: [{ text: serializeProfileForHistory(p) }] });
  }

  return geminiHistory;
};

/**
 * Formats prior authored ratings into a structured prompt block so Futbolpedia weighs
 * previous ratings and evaluation dates when generating a new rating for this player.
 */
export function buildPriorDossierTrajectoryBlock(
  priorDossiers: PlayerProfile[],
  targetPlayer: string,
): string {
  const datedPriors = priorDossiers.filter(isDossierDated);
  if (datedPriors.length === 0) return '';

  const entries = datedPriors.map((p) => {
    const date = p.evaluationDate || formatIsoDate(p.createdAt) || 'Previous Date';
    const edition = p.version?.label || (p.version?.type === 'prime' ? 'Prime Zenith' : 'Current Form');
    const topAttrs = formatTopAttributes(p.attributes, 4, 85);

    return `- [${edition} · Evaluated ${date}]: Overall ${p.ratings.overall} / Potential ${p.ratings.potential} (${p.basicInfo.club}, ${p.basicInfo.position})
  Archetype: ${p.playstyleAndRole?.playstyle?.archetype || 'N/A'}${topAttrs ? ` | Key Spikes: ${topAttrs}` : ''}`;
  });

  return `
<prior_authored_dossiers>
Futbolpedia previously authored the following dated dossier card(s) for ${targetPlayer}:
${entries.join('\n')}

TRAJECTORY & RATING MEMORY PROTOCOL:
You are authoring a new evaluation for this player. Factor in this authored historical baseline:
1. Explain or reflect what has changed since that evaluation date (form progression, tactical role change, trophy triumph, age decline, or steady consistency) rather than making arbitrary, ungrounded rating swings.
2. Maintain thoughtful longitudinal consistency while honoring verified recent trajectory.
</prior_authored_dossiers>`;
}
