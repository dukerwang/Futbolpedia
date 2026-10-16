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
  family: 'gemini-3-flash' | 'gemini-4-argon' | 'gemini-future';
  /**
   * Older Flash models (2.5 / early 3.x) could leak thinking tokens when
   * ThinkingLevel.MEDIUM/HIGH was paired with responseSchema. 3.8+ and 4.x handle
   * deeper thinking with structured schemas cleanly.
   */
  supportsDeepSchemaThinking: boolean;
  /** Default tuning per pipeline stage in Default mode */
  defaultTuning: Record<AITask, TaskTuning>;
  /** Default tuning per pipeline stage in Fast mode */
  fastTuning: Record<AITask, TaskTuning>;
}

/**
 * Default fast/workhorse model for routing, search grounding, and fast turns.
 * Update this constant directly when switching across Gemini releases.
 */
export const DEFAULT_FAST_MODEL = 'gemini-3.8-flash';

/**
 * Primary model for deep dossier synthesis and nuanced scouting evaluations.
 * Change to 'gemini-4-argon' (or any future release) here when ready.
 */
export const DEFAULT_SYNTHESIS_MODEL = DEFAULT_FAST_MODEL;

const GEMINI_3_8_FLASH_PROFILE: ModelCapabilityProfile = {
  id: 'gemini-3.8-flash',
  family: 'gemini-3-flash',
  supportsDeepSchemaThinking: true,
  defaultTuning: {
    routing: { thinkingLevel: 'minimal', temperature: 0.1 },
    grounding: { thinkingLevel: 'low', temperature: 0.2 },
    extraction: { thinkingLevel: 'minimal', temperature: 0.1 },
    synthesis: { thinkingLevel: 'medium', temperature: 0.35 },
    chat: { thinkingLevel: 'medium', temperature: 0.55 },
  },
  fastTuning: {
    routing: { thinkingLevel: 'minimal', temperature: 0.1 },
    grounding: { thinkingLevel: 'minimal', temperature: 0.2 },
    extraction: { thinkingLevel: 'minimal', temperature: 0.1 },
    synthesis: { thinkingLevel: 'low', temperature: 0.35 },
    chat: { thinkingLevel: 'low', temperature: 0.6 },
  },
};

const GEMINI_4_ARGON_PROFILE: ModelCapabilityProfile = {
  id: 'gemini-4-argon',
  family: 'gemini-4-argon',
  supportsDeepSchemaThinking: true,
  defaultTuning: {
    routing: { thinkingLevel: 'minimal', temperature: 0.1 },
    grounding: { thinkingLevel: 'low', temperature: 0.2 },
    extraction: { thinkingLevel: 'minimal', temperature: 0.1 },
    synthesis: { thinkingLevel: 'high', temperature: 0.3 },
    chat: { thinkingLevel: 'medium', temperature: 0.5 },
  },
  fastTuning: {
    routing: { thinkingLevel: 'minimal', temperature: 0.1 },
    grounding: { thinkingLevel: 'minimal', temperature: 0.2 },
    extraction: { thinkingLevel: 'minimal', temperature: 0.1 },
    synthesis: { thinkingLevel: 'medium', temperature: 0.3 },
    chat: { thinkingLevel: 'low', temperature: 0.55 },
  },
};

const KNOWN_PROFILES: Record<string, ModelCapabilityProfile> = {
  'gemini-3.8-flash': GEMINI_3_8_FLASH_PROFILE,
  'gemini-4-argon': GEMINI_4_ARGON_PROFILE,
};

/**
 * Resolves the capability profile for any current or future Gemini model string.
 * Future gemini-4* / gemini-5* models inherit the high-reasoning Argon profile;
 * Flash variants inherit the low-latency Flash profile.
 */
export function getModelProfile(modelId: string): ModelCapabilityProfile {
  if (KNOWN_PROFILES[modelId]) {
    return KNOWN_PROFILES[modelId];
  }
  const lower = modelId.toLowerCase();
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
  mode: 'default' | 'fast' = 'default',
  overrides?: {
    model?: string;
    thinkingLevel?: ThinkingTier;
    temperature?: number;
  },
): ResolvedTaskConfig {
  const defaultModelForTask =
    task === 'synthesis' || (task === 'chat' && mode === 'default')
      ? DEFAULT_SYNTHESIS_MODEL
      : DEFAULT_FAST_MODEL;

  const model = overrides?.model || defaultModelForTask;
  const profile = getModelProfile(model);
  const baseTuning = mode === 'fast' ? profile.fastTuning[task] : profile.defaultTuning[task];

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
