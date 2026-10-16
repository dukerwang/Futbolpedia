import { GoogleGenAI, Content, ThinkingLevel, Type } from '@google/genai';
import {
  AITask,
  DEFAULT_FAST_MODEL,
  DEFAULT_SYNTHESIS_MODEL,
  resolveTaskModelConfig,
  ThinkingTier,
} from '../constants/modelProfiles';
import { SIMULATION_SEASON, SIMULATION_YEAR } from '../prompts/scoutCore';

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
}

export async function generateProseTurn(params: GenerateProseTurnParams): Promise<string> {
  const resolved = resolveTaskModelConfig('chat', params.mode ?? 'default', {
    model: params.modelOverride,
    thinkingLevel: params.thinkingLevelOverride,
    temperature: params.temperatureOverride,
  });

  const tools: any[] =
    params.enableTools === false
      ? []
      : [
          { googleSearch: {} },
          {
            functionDeclarations: [
              {
                name: 'get_football_squad',
                description:
                  'Gets the current active roster/squad of a football team using API-Football. Use this to verify current players for a club.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    team: {
                      type: Type.STRING,
                      description: 'The name of the football club (e.g. Real Madrid, Arsenal)',
                    },
                  },
                  required: ['team'],
                },
              },
            ],
          },
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

  while (response.functionCalls && response.functionCalls.length > 0) {
    const functionCall = response.functionCalls[0];
    let apiResult: any = {};

    try {
      if (functionCall.name === 'get_football_squad') {
        const args = functionCall.args as any;
        if (args?.team) {
          const fetchRes = await fetch(`/api/football/squad?team=${encodeURIComponent(args.team)}`);
          if (!fetchRes.ok) throw new Error('API responded with an error.');
          apiResult = await fetchRes.json();
        } else {
          apiResult = { error: 'Missing team argument' };
        }
      } else {
        apiResult = { error: 'Unknown function' };
      }
    } catch (e: any) {
      apiResult = { error: e?.message || 'Tool execution failed' };
    }

    response = await chatSession.sendMessage({
      message: [
        {
          functionResponse: {
            name: functionCall.name,
            response: apiResult,
          },
        },
      ],
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
