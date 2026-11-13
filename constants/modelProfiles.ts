export type ThinkingTier = 'minimal' | 'low' | 'medium' | 'high';

export type AITask =
  | 'routing'
  | 'grounding'
  | 'extraction'
  | 'synthesis'
  | 'chat';

export interface TaskTuning {
  thinkingLevel: ThinkingTier;
  temperature: number;
}

export interface ModelCapabilityProfile {
  /** Model identifier passed to @google/genai */
  id: string;
  /** Generation family used to adapt reasoning depth and schema behavior */
  family: 'gemini-3-flash' | 'gemini-4-hydrogen' | 'gemini-4-argon' | 'gemini-future';
  /**
   * Older Flash models (2.5 / early 3.x) could leak thinking tokens when
   * ThinkingLevel.MEDIUM/HIGH was paired with responseSchema. 3.8+ and 4.x handle
   * deeper thinking with structured schemas cleanly.
   */
  supportsDeepSchemaThinking: boolean;
  /**
   * Whether the model honors `temperature` (and top_p/top_k). Gemini 4 Hydrogen ignores them and
   * answers an out-of-range value with HTTP 400, so requests to it leave them out (`samplingFor`).
   */
  honorsSampling: boolean;
  /**
   * Tokens added to every `maxOutputTokens` cap for the model's thinking. Both models count
   * thinking against the cap, but 3.8 Flash reports no thinking at LOW while Hydrogen spends up to
   * about a thousand tokens on a search digest, which left the capped calls empty (MAX_TOKENS).
   */
  thinkingHeadroomTokens: number;
  /**
   * How long a grounded web search usually takes on this model. Chat research sets its deadline
   * from it (`researchAgent.ts`), so a model whose searches are slower gets the time to finish them.
   * Measured 2026-11-13 over five evidence searches: 3.8 Flash 7.9-10.4 s, Hydrogen 10.8-18.2 s
   * (average 14.4 s; it runs more queries per search).
   */
  searchLatencyMs: number;
  /** Unified per-stage tuning across the pipeline */
  tuning: Record<AITask, TaskTuning>;
}

export const GEMINI_3_8_FLASH = 'gemini-3.8-flash';
export const GEMINI_4_HYDROGEN = 'gemini-4-hydrogen';

/**
 * Default fast/workhorse model for routing, search grounding, and scouting turns.
 * This one constant picks the model for the whole app pipeline: set it to GEMINI_3_8_FLASH to
 * switch back. (The Gaffa outlook engine in packages/engine pins its own model.)
 */
export const DEFAULT_FAST_MODEL: string = GEMINI_4_HYDROGEN;

/**
 * Primary model for dossier synthesis and nuanced scouting evaluations.
 * Change to 'gemini-4-argon' (or any future release) here when ready.
 */
export const DEFAULT_SYNTHESIS_MODEL = DEFAULT_FAST_MODEL;

const GEMINI_3_8_FLASH_PROFILE: ModelCapabilityProfile = {
  id: GEMINI_3_8_FLASH,
  family: 'gemini-3-flash',
  supportsDeepSchemaThinking: true,
  honorsSampling: true,
  thinkingHeadroomTokens: 0,
  searchLatencyMs: 8_000,
  tuning: {
    routing: { thinkingLevel: 'minimal', temperature: 0.1 },
    grounding: { thinkingLevel: 'minimal', temperature: 0.2 },
    extraction: { thinkingLevel: 'minimal', temperature: 0.1 },
    // LOW thinking caps hidden thinking tokens (~400 vs ~2900 on MEDIUM/dynamic)
    // while the explicit schema `calibration` block handles tier & peer reasoning in output tokens.
    synthesis: { thinkingLevel: 'low', temperature: 0.35 },
    chat: { thinkingLevel: 'low', temperature: 0.55 },
  },
};

/**
 * Gemini 4 Hydrogen, the successor to 3.8 Flash. It accepts low, medium, high and xhigh thinking
 * (not minimal) and defaults to high, so every task names its level: the chat and research budgets
 * assume low-thinking latency. Temperatures are listed for parity but never sent (`honorsSampling`).
 */
const GEMINI_4_HYDROGEN_PROFILE: ModelCapabilityProfile = {
  id: GEMINI_4_HYDROGEN,
  family: 'gemini-4-hydrogen',
  supportsDeepSchemaThinking: true,
  honorsSampling: false,
  thinkingHeadroomTokens: 4096,
  searchLatencyMs: 14_000,
  tuning: {
    routing: { thinkingLevel: 'low', temperature: 0.1 },
    grounding: { thinkingLevel: 'low', temperature: 0.2 },
    extraction: { thinkingLevel: 'low', temperature: 0.1 },
    synthesis: { thinkingLevel: 'low', temperature: 0.35 },
    chat: { thinkingLevel: 'low', temperature: 0.55 },
  },
};

const GEMINI_4_ARGON_PROFILE: ModelCapabilityProfile = {
  id: 'gemini-4-argon',
  family: 'gemini-4-argon',
  supportsDeepSchemaThinking: true,
  honorsSampling: true,
  thinkingHeadroomTokens: 0,
  searchLatencyMs: 8_000,
  tuning: {
    routing: { thinkingLevel: 'minimal', temperature: 0.1 },
    grounding: { thinkingLevel: 'minimal', temperature: 0.2 },
    extraction: { thinkingLevel: 'minimal', temperature: 0.1 },
    synthesis: { thinkingLevel: 'medium', temperature: 0.3 },
    chat: { thinkingLevel: 'medium', temperature: 0.5 },
  },
};

const KNOWN_PROFILES: Record<string, ModelCapabilityProfile> = {
  [GEMINI_3_8_FLASH]: GEMINI_3_8_FLASH_PROFILE,
  [GEMINI_4_HYDROGEN]: GEMINI_4_HYDROGEN_PROFILE,
  'gemini-4-argon': GEMINI_4_ARGON_PROFILE,
};

/**
 * Resolves the capability profile for any current or future Gemini model string.
 * Hydrogen variants inherit the Hydrogen profile; other future gemini-4* / gemini-5* models
 * inherit the high-reasoning Argon profile; Flash variants inherit the low-latency Flash profile.
 */
export function getModelProfile(modelId: string): ModelCapabilityProfile {
  if (KNOWN_PROFILES[modelId]) {
    return KNOWN_PROFILES[modelId];
  }
  const lower = modelId.toLowerCase();
  if (lower.includes('hydrogen')) {
    return { ...GEMINI_4_HYDROGEN_PROFILE, id: modelId, family: 'gemini-future' };
  }
  if (lower.includes('argon') || lower.includes('pro') || /^gemini-[456789]/.test(lower) && !lower.includes('flash')) {
    return {
      ...GEMINI_4_ARGON_PROFILE,
      id: modelId,
      family: 'gemini-future',
    };
  }
  return {
    ...GEMINI_3_8_FLASH_PROFILE,
    id: modelId,
    family: 'gemini-future',
  };
}

export interface ResolvedTaskConfig {
  model: string;
  thinkingLevel: ThinkingTier;
  temperature: number;
  profile: ModelCapabilityProfile;
}

/**
 * Selects the target model, thinking level, and temperature for a specific pipeline task.
 * Routing, search grounding, and fact extraction always use the fast workhorse model
 * to keep latency low, while synthesis and deep scouting chat use DEFAULT_SYNTHESIS_MODEL.
 */
export function resolveTaskModelConfig(
  task: AITask,
  overrides?: {
    model?: string;
    thinkingLevel?: ThinkingTier;
    temperature?: number;
  },
): ResolvedTaskConfig {
  const defaultModelForTask =
    task === 'synthesis' || task === 'chat' ? DEFAULT_SYNTHESIS_MODEL : DEFAULT_FAST_MODEL;

  const model = overrides?.model || defaultModelForTask;
  const profile = getModelProfile(model);
  const baseTuning = profile.tuning[task];

  let thinkingLevel = overrides?.thinkingLevel ?? baseTuning.thinkingLevel;
  if (!profile.supportsDeepSchemaThinking && task === 'synthesis' && thinkingLevel === 'high') {
    thinkingLevel = 'low';
  }

  return {
    model,
    thinkingLevel,
    temperature: overrides?.temperature ?? baseTuning.temperature,
    profile,
  };
}

/**
 * The sampling fields to send with a request: `{ temperature }` for models that honor it, nothing
 * for models that ignore it (Gemini 4 Hydrogen).
 */
export function samplingFor(model: string, temperature: number | undefined): { temperature?: number } {
  return temperature !== undefined && getModelProfile(model).honorsSampling ? { temperature } : {};
}

/** A `maxOutputTokens` cap sized for the answer, plus the model's room for thinking. */
export function outputCap(model: string, answerTokens: number): number {
  return answerTokens + getModelProfile(model).thinkingHeadroomTokens;
}
