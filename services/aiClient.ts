import { GoogleGenAI, Content, ThinkingLevel, Type } from '@google/genai';
import type { GaffaContextBag, PlayerProfile } from '../types';
import {
  AITask,
  DEFAULT_FAST_MODEL,
  resolveTaskModelConfig,
  ThinkingTier,
} from '../constants/modelProfiles';
import { GaffaMarketGrepParams, grepGaffaBag } from '../constants/gaffaRules';
import { getRealWorldFootballSeason } from '../prompts/scoutCore';
import { DossierGrepParams, grepDossiers } from './dossierStore';

export const FLASH_MODEL = DEFAULT_FAST_MODEL;

let _ai: GoogleGenAI | null = null;
export const getAi = (): GoogleGenAI =>
  (_ai ??= new GoogleGenAI({ apiKey: process.env.API_KEY as string }));

// gemini-3.8-flash rejects ThinkingLevel.MINIMAL with HTTP 400; map 'minimal' to LOW.
const THINKING_LEVEL_MAP: Record<ThinkingTier, ThinkingLevel> = {
  minimal: ThinkingLevel.LOW,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export const getCurrentSeasonInfo = getRealWorldFootballSeason;

/** Splits a `data:<mime>;base64,<data>` URL into a Gemini inline-data part. */
export const dataUrlToInlinePart = (dataUrl: string) => {
  const [mimeType, base64Data] = dataUrl.split(';base64,');
  return { inlineData: { data: base64Data, mimeType: mimeType.replace('data:', '') } };
};

const blockedOrEmptyResponseError = (finishReason: string | undefined): Error =>
  finishReason && finishReason !== 'STOP'
    ? new Error(
        `The model's response was blocked due to: ${finishReason}. Please modify your prompt and try again.`,
      )
    : new Error('The AI model failed to return a valid text response. Please try again.');

/** Max tool-call round trips per prose turn before the model must answer in text. */
const MAX_TOOL_ROUNDS = 3;

export interface GenerateStructuredParams {
  task: AITask;
  prompt: string;
  systemInstruction?: string;
  schema: Record<string, unknown>;
  temperatureOverride?: number;
  thinkingLevelOverride?: ThinkingTier;
  modelOverride?: string;
}

export async function generateStructured<T>(params: GenerateStructuredParams): Promise<T> {
  const resolved = resolveTaskModelConfig(params.task, {
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
  /** Set when the search call failed or was refused, as opposed to finding nothing. */
  error?: string;
}

const SEARCH_DIGEST_SYSTEM_INSTRUCTION =
  'You are a high-precision football scouting and tactical fact extractor. Summarize verified search results into a dense, factual bullet digest (max 190 words). For player queries, state exact figures (age, appearances, starts, minutes, goals, assists, or key defensive/passing metrics across competitions), confirmed current club, confirmed current head coach, most recent match date/score/fitness, major honours (UCL, Ballon d\'Or, FIFPro, league titles), and concrete on-pitch traits/limitations. For club, tactical, or ranking queries, state confirmed current head coach, primary formation and phase-of-play mechanics (build-up, pressing, rest-defense), current starting XI and key transfers/loans in or out, recent match results/standings, and statistical standouts. Omit filler, introductions, and speculation.';

/**
 * The longer digest chat research uses. It keeps the names, dates and numbers a writer needs to
 * state current facts, and marks what's old, instead of compressing everything into a summary.
 */
const SEARCH_EVIDENCE_SYSTEM_INSTRUCTION =
  'You are a football research assistant collecting evidence for an analyst. From the search results, write a factual digest of up to 350 words that answers the query, as short points. Start each point with the publication date of the report it comes from in square brackets: [YYYY-MM-DD] when the result shows the day, otherwise [Month YYYY], or [undated]. Keep every specific the results give: player names, the positions and roles they played, dates, opponents, scores, lineups, injuries with expected return dates, transfers with their window, and statistics with the competition and season they cover. Mark anything from before the current season as older. When results disagree, give both versions and their dates. Do not add anything the results do not say, and do not fill gaps from general knowledge; when the results do not answer part of the query, say which part.';

/**
 * For analysis searches, the query comes with current facts from the live feeds. Sources that
 * describe a different team (players who have left, another coach, another shape) are flagged, so
 * a tactical piece from an earlier season can't pass for this one.
 */
const SEARCH_ANALYSIS_ADDENDUM =
  ' The query may come with current facts from live match data. Read every source against them: when a source describes players, a coach or a shape those facts contradict, say in its point that it describes an earlier team, and keep only what it says about the present or about what changed.';

export type SearchDigest = 'brief' | 'evidence';

export async function runGroundedSearch(
  query: string,
  options?: { datePrefix?: string; attempt?: number; digest?: SearchDigest; context?: string },
): Promise<GroundedSearchResult> {
  const attempt = options?.attempt ?? 0;
  const searchQuery = options?.datePrefix ? `${options.datePrefix} ${query}` : query;
  const fullQuery = options?.context
    ? `${searchQuery}\n\nCurrent facts from live match data, to read the sources against:\n${options.context}`
    : searchQuery;
  try {
    const res = await getAi().models.generateContent({
      model: FLASH_MODEL,
      contents: fullQuery,
      config: {
        systemInstruction:
          options?.digest === 'evidence'
            ? SEARCH_EVIDENCE_SYSTEM_INSTRUCTION + (options.context ? SEARCH_ANALYSIS_ADDENDUM : '')
            : SEARCH_DIGEST_SYSTEM_INSTRUCTION,
        temperature: 0.1,
        maxOutputTokens: options?.digest === 'evidence' ? 800 : 420,
        tools: [{ googleSearch: {} }],
        // Cap thinkingLevel to LOW during search grounding so Flash does not run
        // multi-second dynamic thinking just to summarize search results.
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.LOW,
        },
      },
    });
    const text = res.text?.trim() || '';
    const chunks = (res as any).candidates?.[0]?.groundingMetadata?.groundingChunks;
    const sources: string[] =
      chunks
        ?.filter((c: any) => c.web?.uri)
        ?.slice(0, options?.digest === 'evidence' ? 6 : 4)
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
      error: is429 ? 'refused (rate limited)' : String(e?.message ?? e).slice(0, 120),
    };
  }
}

const GREP_SAVED_DOSSIERS_DECLARATION = {
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
          'Optional positional filter (e.g. "Centre-Back", "CB", "Midfielder", "Winger", "Centre Forward", "Full-Back", "Goalkeeper").',
      },
      club: {
        type: Type.STRING,
        description: 'Optional club filter: a club name or common short name.',
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
};

const GREP_GAFFA_MARKET_DECLARATION = {
  name: 'grep_gaffa_market',
  description:
    'Instant (<1ms) structured grep and filter over the connected Gaffa league bag (unowned FA pool, club roster, open listings, and live auctions), cross-linked with calibrated Futbolpedia dossiers (scout_ovr, scout_pot, scout_archetype). Use this to find free agents or roster players by position, age (e.g. maxAge: 21 for Academy), market value, calibrated Scout OVR/POT, PL club, or name.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      pool: {
        type: Type.STRING,
        enum: ['free_agents', 'roster', 'listings', 'auctions', 'all'],
        description: 'Which pool to filter (default "all").',
      },
      position: {
        type: Type.STRING,
        description: 'Exact Gaffa slot filter (GK, CB, LB, RB, LWB, RWB, DM, CM, AM, LW, RW, ST).',
      },
      plTeam: {
        type: Type.STRING,
        description: 'Optional Premier League club filter.',
      },
      maxAge: {
        type: Type.NUMBER,
        description: 'Maximum age (e.g. 21 for U21 Academy prospects).',
      },
      minAge: {
        type: Type.NUMBER,
        description: 'Minimum age.',
      },
      minMarketValue: {
        type: Type.NUMBER,
        description: 'Minimum market value in €m.',
      },
      maxMarketValue: {
        type: Type.NUMBER,
        description: 'Maximum market value in €m.',
      },
      minOverall: {
        type: Type.NUMBER,
        description: 'Minimum calibrated Futbolpedia Overall rating (1-99).',
      },
      minPotential: {
        type: Type.NUMBER,
        description: 'Minimum calibrated Futbolpedia Potential rating (1-99).',
      },
      query: {
        type: Type.STRING,
        description: 'Optional name, archetype, or keyword search.',
      },
      sortBy: {
        type: Type.STRING,
        enum: ['market_value', 'age', 'overall', 'potential'],
        description: 'Sort order (default "market_value").',
      },
      limit: {
        type: Type.NUMBER,
        description: 'Maximum results to return (default 25, max 50).',
      },
    },
  },
};

const LOOK_UP_DOSSIER_DECLARATION = {
  name: 'look_up_dossier',
  description:
    'Reads the published Futbolpedia dossier card for one player from the user’s dossiers and every shared card: Overall, Potential, all attributes, archetype, strengths and weaknesses. Call it before judging, ranking or describing a player who is not already in <locked_dossiers>, and answer from the card’s numbers. Returns found: false when nobody has rated him yet; then answer from grounding without inventing card numbers, and Futbolpedia offers the user a rating.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: 'The player’s name.',
      },
      edition: {
        type: Type.STRING,
        enum: ['current', 'prime'],
        description:
          'Which version of him: "prime" for his best seasons, "current" for his form now. Defaults to the version the conversation is about.',
      },
    },
    required: ['name'],
  },
};

const SHOW_DOSSIER_DECLARATION = {
  name: 'show_dossier',
  description:
    'Shows a player’s dossier card to the user under your reply. Use it when the user asks to see a player or his card, or when the card itself answers what they asked. Only for players whose card you have, in <locked_dossiers> or from look_up_dossier. Never repeat the whole card in prose after showing it.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: 'The player’s name, as it appears on his card.',
      },
    },
    required: ['name'],
  },
};

/** Handlers for the dossier tools; a turn that passes them lets the model read and show cards. */
export interface DossierToolHandlers {
  lookUp: (args: { name?: string; edition?: string }) => Promise<unknown>;
  show: (args: { name?: string }) => Promise<unknown>;
}

const NETWORK_FUNCTION_DECLARATIONS = [
  {
    name: 'get_club_recent_team',
    description:
      "Gets a club's live current-season data from ESPN match records: results in all competitions, the starting XI and formation of each of its last four competitive matches with every starter's position and the subs used, and next fixtures. For Premier League clubs it adds each player's starts, minutes, goals and assists this season and the injury and suspension list. Use it to establish who is actually playing and where.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        team: {
          type: Type.STRING,
          description: 'The name of the football club.',
        },
      },
      required: ['team'],
    },
  },
  {
    name: 'get_player_season',
    description:
      "Gets a Premier League player's current season from the Fantasy Premier League feed: club, position, starts, minutes, goals, assists, expected goals and assists, and injury status. Covers Premier League players only.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: {
          type: Type.STRING,
          description: 'Full name of the footballer.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_league_table',
    description:
      "Gets a league's current table from ESPN: every club's position, points, games played, wins, draws, losses and goal difference. Covers the major European leagues, the Champions and Europa League phases, and several others. Use it for any position, points or goal-difference figure.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        league: { type: Type.STRING, description: "The league's usual English name." },
        country: { type: Type.STRING, description: "The league's country, when its name is shared." },
      },
      required: ['league'],
    },
  },
];

/** Server routes behind the live data tools, keyed by tool name: each argument and the query parameter it fills. */
const NETWORK_TOOL_ROUTES: Record<string, { args: Record<string, string>; required: string; path: string; label: string }> = {
  get_club_recent_team: { args: { team: 'name' }, required: 'team', path: '/api/live/club', label: 'Club' },
  get_player_season: { args: { name: 'name' }, required: 'name', path: '/api/live/player', label: 'Player' },
  get_league_table: { args: { league: 'league', country: 'country' }, required: 'league', path: '/api/live/table', label: 'Table' },
};

async function callNetworkTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const route = NETWORK_TOOL_ROUTES[name];
  if (!args[route.required]) return { error: `Missing ${route.required} argument` };
  const query = new URLSearchParams(
    Object.entries(route.args).flatMap(([arg, param]) => (args[arg] ? [[param, String(args[arg])]] : [])),
  );
  const res = await fetch(`${route.path}?${query}`);
  if (!res.ok) return { error: `${route.label} lookup returned status ${res.status}` };
  // The structured club report is for research code; the model reads its text.
  const { report: _report, ...rest } = await res.json();
  return rest;
}

export type ProseToolMode = 'full' | 'local_only' | 'none';

export interface GenerateProseTurnParams {
  message: string;
  historyContents: Content[];
  systemInstruction: string;
  imageData?: string;
  temperatureOverride?: number;
  thinkingLevelOverride?: ThinkingTier;
  modelOverride?: string;
  enableTools?: boolean;
  toolMode?: ProseToolMode;
  dossiersPool?: PlayerProfile[];
  gaffaBag?: GaffaContextBag;
  dossierTools?: DossierToolHandlers;
  onStreamChunk?: (accumulatedText: string) => void;
  /** Called with the tool names each time the model calls tools, for the turn's timing log. */
  onToolCalls?: (names: string[]) => void;
  /** Called with each tool's result, so checks on the reply know what the tools returned. */
  onToolResult?: (name: string, result: unknown) => void;
  /** Called with each passage of the reply that the model's own search grounded. */
  onGrounded?: (segment: string) => void;
}

/** Hands each grounded passage of a response to `onGrounded`. */
const reportGrounding = (candidate: any, onGrounded?: (segment: string) => void) => {
  if (!onGrounded) return;
  for (const support of candidate?.groundingMetadata?.groundingSupports ?? []) {
    if (typeof support?.segment?.text === 'string') onGrounded(support.segment.text);
  }
};

export async function generateProseTurn(params: GenerateProseTurnParams): Promise<string> {
  const resolved = resolveTaskModelConfig('chat', {
    model: params.modelOverride,
    thinkingLevel: params.thinkingLevelOverride,
    temperature: params.temperatureOverride,
  });

  const effectiveToolMode: ProseToolMode =
    params.toolMode ?? (params.enableTools === false ? 'none' : 'full');

  const localFunctionDeclarations: any[] = [
    GREP_SAVED_DOSSIERS_DECLARATION,
    ...(params.gaffaBag?.connected ? [GREP_GAFFA_MARKET_DECLARATION] : []),
    ...(params.dossierTools ? [LOOK_UP_DOSSIER_DECLARATION, SHOW_DOSSIER_DECLARATION] : []),
  ];

  const tools: any[] =
    effectiveToolMode === 'none'
      ? []
      : effectiveToolMode === 'local_only'
        ? [{ functionDeclarations: localFunctionDeclarations }]
        : [
            { googleSearch: {} },
            { functionDeclarations: [...localFunctionDeclarations, ...NETWORK_FUNCTION_DECLARATIONS] },
          ];

  const chatSession = getAi().chats.create({
    model: resolved.model,
    config: {
      systemInstruction: params.systemInstruction,
      ...(tools.length > 0 ? { tools } : {}),
      ...(effectiveToolMode === 'full'
        ? {
            // @ts-ignore
            toolConfig: {
              // @ts-ignore
              includeServerSideToolInvocations: true,
            },
          }
        : {}),
      temperature: resolved.temperature,
      thinkingConfig: {
        thinkingLevel: THINKING_LEVEL_MAP[resolved.thinkingLevel],
      },
    },
    history: params.historyContents,
  });

  const parts: any[] = [{ text: params.message }];
  if (params.imageData) parts.push(dataUrlToInlinePart(params.imageData));

  const executeToolCalls = async (calls: any[]) => {
    params.onToolCalls?.(calls.map((c) => String(c.name)));
    return Promise.all(
      calls.map(async (functionCall) => {
        let apiResult: any = {};
        const args = (functionCall.args as any) ?? {};
        try {
          if (functionCall.name === 'grep_saved_dossiers') {
            apiResult = grepDossiers(params.dossiersPool ?? [], args as DossierGrepParams);
          } else if (functionCall.name === 'grep_gaffa_market' && params.gaffaBag) {
            apiResult = grepGaffaBag(
              params.gaffaBag,
              args as GaffaMarketGrepParams,
              params.dossiersPool ?? [],
            );
          } else if (functionCall.name === 'look_up_dossier' && params.dossierTools) {
            apiResult = await params.dossierTools.lookUp(args);
          } else if (functionCall.name === 'show_dossier' && params.dossierTools) {
            apiResult = await params.dossierTools.show(args);
          } else if (Object.hasOwn(NETWORK_TOOL_ROUTES, functionCall.name)) {
            apiResult = await callNetworkTool(functionCall.name, args);
          } else {
            apiResult = { error: `Unknown tool: ${functionCall.name}` };
          }
        } catch (e: any) {
          apiResult = { error: e?.message || 'Tool execution failed' };
        }

        params.onToolResult?.(String(functionCall.name), apiResult);
        return {
          functionResponse: {
            name: functionCall.name,
            response: apiResult,
          },
        };
      }),
    );
  };

  // Use live token streaming when an onStreamChunk callback is provided
  if (params.onStreamChunk && typeof (chatSession as any).sendMessageStream === 'function') {
    let accumulatedText = '';
    let pendingCalls: any[] = [];
    let lastFinishReason: string | undefined;

    const consumeStream = async (messagePayload: any) => {
      pendingCalls = [];
      const stream = await chatSession.sendMessageStream({ message: messagePayload });
      for await (const chunk of stream) {
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          pendingCalls.push(...chunk.functionCalls);
        }
        const finish = chunk.candidates?.[0]?.finishReason;
        if (finish) lastFinishReason = finish;
        reportGrounding(chunk.candidates?.[0], params.onGrounded);

        const chunkText = chunk.text;
        if (typeof chunkText === 'string' && chunkText.length > 0 && pendingCalls.length === 0) {
          accumulatedText += chunkText;
          params.onStreamChunk?.(accumulatedText);
        }
      }
    };

    await consumeStream(parts);

    for (let round = 0; pendingCalls.length > 0 && round < MAX_TOOL_ROUNDS; round++) {
      await consumeStream(await executeToolCalls(pendingCalls));
    }

    if (!accumulatedText.trim()) throw blockedOrEmptyResponseError(lastFinishReason);

    return accumulatedText;
  }

  let response = await chatSession.sendMessage({ message: parts });

  for (let round = 0; response.functionCalls?.length && round < MAX_TOOL_ROUNDS; round++) {
    response = await chatSession.sendMessage({
      message: await executeToolCalls(response.functionCalls),
    });
  }

  reportGrounding(response.candidates?.[0], params.onGrounded);
  const text = response.text;
  if (typeof text !== 'string') {
    throw blockedOrEmptyResponseError(response.candidates?.[0]?.finishReason);
  }
  return text;
}
