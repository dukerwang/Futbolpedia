import {
  ATTRIBUTE_CATEGORIES,
  GK_ATTRIBUTE_CATEGORIES,
} from './constants/ratingTiers';
import {
  SIMULATION_SEASON,
  SIMULATION_YEAR,
} from './prompts/scoutCore';
import { buildConversationalScoutInstruction } from './prompts/chatPrompt';
import { DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION } from './prompts/dossierPrompt';

export {
  SIMULATION_YEAR,
  SIMULATION_SEASON,
  ATTRIBUTE_CATEGORIES,
  GK_ATTRIBUTE_CATEGORIES,
  DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION,
};

export const getMasterInstructions = (includeEAFC: boolean = true): string =>
  buildConversationalScoutInstruction(includeEAFC);

export const MASTER_INSTRUCTION_SET = getMasterInstructions(true);
