import { GoogleGenAI, Content, ThinkingLevel, Type } from '@google/genai';
import type { PlayerProfile } from '../types';
import {
  AITask,
  DEFAULT_FAST_MODEL,
  DEFAULT_SYNTHESIS_MODEL,
  resolveTaskModelConfig,
  ThinkingTier,
} from '../constants/modelProfiles';
import { SIMULATION_SEASON, SIMULATION_YEAR } from '../prompts/scoutCore';
import { DossierGrepParams, grepDossiers } from './dossierStore';

export const FLASH_MODEL = DEFAULT_FAST_MODEL;
export const SYNTHESIS_MODEL = DEFAULT_SYNTHESIS_MODEL;

let _ai: GoogleGenAI | null = null;
export const getAi = (): GoogleGenAI =>
  (_ai ??= new GoogleGenAI({ apiKey: process.env.API_KEY as string }));

const THINKING_LEVEL_MAP: Record<ThinkingTier, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export const getCurrentSeasonInfo = () => {
  const now = new Date();
  const month = now.toLocaleString('default', { month: 'long' });
  return { year: SIMULATION_YEAR, month, currentSeason: SIMULATION_SEASON };
};

export interface GenerateStructuredParams {
  task: AITask;
  mode?: 'default' | 'fast';
  prompt: string;
  systemInstruction?: string;
  schema: Record<string, unknown>;
  temperatureOverride?: number;
  thinkingLevelOverride?: ThinkingTier;
  modelOverride?: string;
}

export async function generateStructured<T>(params: GenerateStructuredParams): Promise<T> {
  const resolved = resolveTaskModelConfig(params.task, params.mode ?? 'default', {
    model: params.modelOverride,
    thinkingLevel: params.thinkingLevelOverride,
    temperature: params.temperatureOverride,
  });

  const response = await getAi().models.generateContent({
    model: resolved.model,
    contents: params.prompt,
    config: {
      ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {}),
      temperature: resolved.temperature,
      responseMimeType: 'application/json',
      responseSchema: params.schema,
      thinkingConfig: {
        thinkingLevel: THINKING_LEVEL_MAP[resolved.thinkingLevel],
      },
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error(`Structured generation (${params.task}) returned no text`);
  }

  const u = (response as any).usageMetadata;
  if (u && params.task === 'synthesis') {
    console.log(
      `[Perf] ${params.task} (${resolved.model}, think=${resolved.thinkingLevel}) — prompt: ${u.promptTokenCount ?? '?'}, cached: ${u.cachedContentTokenCount ?? 0}, thoughts: ${u.thoughtsTokenCount ?? 0}, output: ${u.candidatesTokenCount ?? '?'}`,
    );
  }

  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned) as T;
}

export interface GroundedSearchResult {
  query: string;
  text: string;
  sources: string[];
  formattedBlock: string;
}

export async function runGroundedSearch(
  query: string,
  options?: { datePrefix?: string; attempt?: number },
): Promise<GroundedSearchResult> {
  const attempt = options?.attempt ?? 0;
  const fullQuery = options?.datePrefix ? `${options.datePrefix} ${query}` : query;
  try {
    const res = await getAi().models.generateContent({
      model: FLASH_MODEL,
      contents: fullQuery,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });
    const text = res.text?.trim() || '';
    const chunks = (res as any).candidates?.[0]?.groundingMetadata?.groundingChunks;
    const sources: string[] =
      chunks
        ?.filter((c: any) => c.web?.uri)
        ?.slice(0, 4)
        ?.map((c: any) => (c.web.title ? `${c.web.title} (${c.web.uri})` : String(c.web.uri))) ??
      [];

    const formattedBlock = `[QUERY: ${query}]\n${text || 'No results.'}${
      sources.length > 0 ? `\n[SOURCES: ${sources.join(' | ')}]` : ''
    }`;

    return {
      query,
      text,
      sources,
      formattedBlock,
    };
  } catch (e: any) {
    const is429 =
      e?.status === 429 ||
      String(e?.message).includes('429') ||
      String(e?.message).includes('RESOURCE_EXHAUSTED');
    if (is429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 2500));
      return runGroundedSearch(query, { ...options, attempt: attempt + 1 });
    }
    console.warn(`[Search] Failed for "${query}":`, e);
    return {
      query,
      text: '',
      sources: [],
      formattedBlock: `[QUERY: ${query}]\nData unavailable.`,
    };
  }
}

export interface GenerateProseTurnParams {
  message: string;
  historyContents: Content[];
  systemInstruction: string;
  mode?: 'default' | 'fast';
  imageData?: string;
  temperatureOverride?: number;
  thinkingLevelOverride?: ThinkingTier;
  modelOverride?: string;
  enableTools?: boolean;
  dossiersPool?: PlayerProfile[];
}

export async function generateProseTurn(params: GenerateProseTurnParams): Promise<string> {
  const resolved = resolveTaskModelConfig('chat', params.mode ?? 'default', {
    model: params.modelOverride,
    thinkingLevel: params.thinkingLevelOverride,
    temperature: params.temperatureOverride,
  });

  const functionDeclarations: any[] = [
    {
      name: 'grep_saved_dossiers',
      description:
        'Instant (<1ms) structured grep and attribute filter across the user’s saved and in-conversation player dossiers. Use this whenever the user asks about their scouted players, compares against saved profiles, filters by position/rating/attribute thresholds, or asks who ranks highest in a specific attribute.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description:
              'Optional keyword search across player name, club, nationality, archetype, bestRoles, strengths, weaknesses, and shortBio.',
          },
          position: {
            type: Type.STRING,
            description:
              'Optional positional filter (e.g. "Centre-Back", "CB", "Midfielder", "Winger", "Striker", "Full-Back", "Goalkeeper").',
          },
          club: {
            type: Type.STRING,
            description: 'Optional club filter (e.g. "PSG", "Chelsea", "Arsenal").',
          },
          minOverall: {
            type: Type.NUMBER,
            description: 'Minimum Overall rating filter (1-99).',
          },
          maxOverall: {
            type: Type.NUMBER,
            description: 'Maximum Overall rating filter (1-99).',
          },
          minPotential: {
            type: Type.NUMBER,
            description: 'Minimum Potential rating filter (1-99).',
          },
          attributeKey: {
            type: Type.STRING,
            description:
              'Optional specific outfield attribute key to filter or inspect (e.g. "defensivePositioning", "progressivePassing", "finishing", "speed", "dribbling", "tackling", "footballIQ", "composure").',
          },
          minAttributeValue: {
            type: Type.NUMBER,
            description: 'Minimum value (1-99) required for attributeKey.',
          },
          sortBy: {
            type: Type.STRING,
            description:
              'Field to sort descending by: "overall" (default), "potential", "age", or any of the 25 attribute keys (e.g. "progressivePassing", "speed").',
          },
          limit: {
            type: Type.NUMBER,
            description: 'Max dossiers to return (default 10, max 25).',
          },
        },
      },
    },
    {
      name: 'get_player_fact_sheet',
      description:
        'Fetches a player’s deterministic API-Football fact sheet (registered club, age, height, weight, injury flag, and current season appearances/goals/assists/tackles/key passes).',
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: {
            type: Type.STRING,
            description: 'Full name of the footballer (e.g. "Willian Pacho", "Ousmane Dembélé").',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'get_football_squad',
      description:
        'Gets the current active roster/squad of a football team using API-Football. Use this to verify current players for a club.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          team: {
            type: Type.STRING,
            description: 'The name of the football club (e.g. Real Madrid, Arsenal, PSG)',
          },
        },
        required: ['team'],
      },
    },
    {
      name: 'get_team_fixtures',
      description:
        'Gets the last 5 completed match results, next 3 upcoming fixtures, and registered head coach for a football club using API-Football.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          team: {
            type: Type.STRING,
            description: 'The name of the football club (e.g. PSG, Chelsea, Barcelona)',
          },
        },
        required: ['team'],
      },
    },
  ];

  const tools: any[] =
    params.enableTools === false
      ? []
      : [
          { googleSearch: {} },
          { functionDeclarations },
        ];

  const chatSession = getAi().chats.create({
    model: resolved.model,
    config: {
      systemInstruction: params.systemInstruction,
      ...(tools.length > 0 ? { tools } : {}),
      // @ts-ignore
      toolConfig: {
        // @ts-ignore
        includeServerSideToolInvocations: true,
      },
      temperature: resolved.temperature,
      thinkingConfig: {
        thinkingLevel: THINKING_LEVEL_MAP[resolved.thinkingLevel],
      },
    },
    history: params.historyContents,
  });

  const parts: any[] = [{ text: params.message }];
  if (params.imageData) {
    const [mimeType, base64Data] = params.imageData.split(';base64,');
    parts.push({
      inlineData: {
        data: base64Data,
        mimeType: mimeType.replace('data:', ''),
      },
    });
  }

  let response = await chatSession.sendMessage({ message: parts });

  let safetyLoopCount = 0;
  while (response.functionCalls && response.functionCalls.length > 0 && safetyLoopCount < 4) {
    safetyLoopCount++;
    const calls = response.functionCalls;

    const toolResponses = await Promise.all(
      calls.map(async (functionCall) => {
        let apiResult: any = {};
        const args = (functionCall.args as any) ?? {};
        try {
          if (functionCall.name === 'grep_saved_dossiers') {
            apiResult = grepDossiers(params.dossiersPool ?? [], args as DossierGrepParams);
          } else if (functionCall.name === 'get_player_fact_sheet') {
            if (args.name) {
              const fetchRes = await fetch(
                `/api/football/player?name=${encodeURIComponent(String(args.name))}`,
              );
              apiResult = fetchRes.ok
                ? await fetchRes.json()
                : { error: `Player lookup returned status ${fetchRes.status}` };
            } else {
              apiResult = { error: 'Missing name argument' };
            }
          } else if (functionCall.name === 'get_football_squad') {
            if (args.team) {
              const fetchRes = await fetch(
                `/api/football/squad?team=${encodeURIComponent(String(args.team))}`,
              );
              apiResult = fetchRes.ok
                ? await fetchRes.json()
                : { error: `Squad lookup returned status ${fetchRes.status}` };
            } else {
              apiResult = { error: 'Missing team argument' };
            }
          } else if (functionCall.name === 'get_team_fixtures') {
            if (args.team) {
              const fetchRes = await fetch(
                `/api/football/fixtures?team=${encodeURIComponent(String(args.team))}`,
              );
              apiResult = fetchRes.ok
                ? await fetchRes.json()
                : { error: `Fixtures lookup returned status ${fetchRes.status}` };
            } else {
              apiResult = { error: 'Missing team argument' };
            }
          } else {
            apiResult = { error: `Unknown tool: ${functionCall.name}` };
          }
        } catch (e: any) {
          apiResult = { error: e?.message || 'Tool execution failed' };
        }

        return {
          functionResponse: {
            name: functionCall.name,
            response: apiResult,
          },
        };
      }),
    );

    response = await chatSession.sendMessage({
      message: toolResponses,
    });
  }

  const text = response.text;
  if (typeof text !== 'string') {
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(
        `The model's response was blocked due to: ${finishReason}. Please modify your prompt and try again.`,
      );
    }
    throw new Error('The AI model failed to return a valid text response. Please try again.');
  }

  return text;
}
