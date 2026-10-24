import {
  ATTRIBUTE_CATEGORIES,
  GK_ATTRIBUTE_CATEGORIES,
} from './constants/ratingTiers';
import {
  FC_PLAYSTYLES_DIRECTORY,
  SCOUT_CORE_INSTRUCTION,
  SIMULATION_SEASON,
  SIMULATION_YEAR,
  TRAIT_SYSTEMS_INSTRUCTION,
} from './prompts/scoutCore';
import {
  CONVERSATIONAL_SCOUT_MANDATE,
  buildConversationalScoutInstruction,
} from './prompts/chatPrompt';
import { DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION } from './prompts/dossierPrompt';

/**
 * Central export barrel for Futbolpedia's v5.0 Scouting & Cognitive Instruction Set.
 *
 * Architecture:
 * - `prompts/scoutCore.ts` — Shared core scouting philosophy, evaluation logic, Section III
 *   Rating Tier Scale, Section IV 25+7 Attribute Framework & Disambiguation Matrix,
 *   Contextual Triangulation (Protocol Q), and Writer's Code (Protocols E, G, H, I, L, M, O, S).
 *   Kept byte-stable at the prompt prefix to maximize Gemini implicit prompt caching.
 * - `prompts/chatPrompt.ts` — Conversational scouting, adaptive register, player deep-dives,
 *   head-to-head comparisons, dialectical debates, positional rankings, and tactical analysis.
 * - `prompts/dossierPrompt.ts` — Schema-aligned 4-step calibration & dossier synthesis workflow.
 */
export {
  SIMULATION_YEAR,
  SIMULATION_SEASON,
  ATTRIBUTE_CATEGORIES,
  GK_ATTRIBUTE_CATEGORIES,
  SCOUT_CORE_INSTRUCTION,
  TRAIT_SYSTEMS_INSTRUCTION,
  FC_PLAYSTYLES_DIRECTORY,
  CONVERSATIONAL_SCOUT_MANDATE,
  DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION,
  buildConversationalScoutInstruction,
};

export const getMasterInstructions = (includeEAFC: boolean = true): string =>
  buildConversationalScoutInstruction(includeEAFC);

export const MASTER_INSTRUCTION_SET = getMasterInstructions(true);
