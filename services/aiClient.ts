import { GoogleGenAI, Content, ThinkingLevel, Type, type FunctionDeclaration } from '@google/genai';
import type { GaffaContextBag, PlayerProfile } from '../types';
import {
  AITask,
  DEFAULT_FAST_MODEL,
  resolveTaskModelConfig,
  outputCap,
  samplingFor,
  ThinkingTier,
} from '../constants/modelProfiles';
import { GaffaMarketGrepParams, grepGaffaBag } from '../constants/gaffaRules';
import { getRealWorldFootballSeason } from '../prompts/scoutCore';
import { DossierGrepParams, grepDossiers } from './dossierStore';

export const FLASH_MODEL = DEFAULT_FAST_MODEL;

/**
 * The browser never holds a Gemini key. There, the SDK sends every call to this site's
 * `/gemini-api-proxy`, which adds the server's key and forwards only the app's own models and
 * methods (`services/geminiProxy.ts`); the placeholder below is ignored by the proxy. On the server
 * (Gaffa's panel, snapshot builds, the scout's day) and in scripts, the SDK uses the real key from
 * the environment directly.
 */
const PROXY_PLACEHOLDER_KEY = 'browser-uses-server-proxy';
const inBrowser = (): boolean => typeof window !== 'undefined' && typeof window.location?.origin === 'string';

let _ai: GoogleGenAI | null = null;
export const getAi = (): GoogleGenAI =>
  (_ai ??= inBrowser()
    ? new GoogleGenAI({ apiKey: PROXY_PLACEHOLDER_KEY, httpOptions: { baseUrl: `${window.location.origin}/gemini-api-proxy` } })
    : new GoogleGenAI({ apiKey: process.env.API_KEY as string }));

// gemini-3.8-flash and gemini-4-hydrogen both reject ThinkingLevel.MINIMAL with HTTP 400; map
// 'minimal' to LOW.
export const THINKING_LEVEL_MAP: Record<ThinkingTier, ThinkingLevel> = {
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

export const blockedOrEmptyResponseError = (finishReason: string | undefined): Error =>
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
      ...samplingFor(resolved.model, resolved.temperature),
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

/**
 * A place the eval runner keeps grounded search results between runs (`scripts/eval-search-cache.ts`).
 * Nothing in the app ever installs one, so `searchCache` stays null and `runGroundedSearch` behaves
 * exactly as it did: the app neither reads nor writes any cache. The kind says which digest the
 * result is (`brief`, `evidence` or `analysis`, an evidence digest read against live facts).
 */
export interface SearchCache {
  get(query: string, kind: string): Promise<GroundedSearchResult | null>;
  set(query: string, kind: string, result: GroundedSearchResult): Promise<void>;
}

let searchCache: SearchCache | null = null;

/** Installs (or, with null, removes) the eval runner's search cache. Only the eval scripts call this. */
export const setSearchCache = (cache: SearchCache | null): void => {
  searchCache = cache;
};

export async function runGroundedSearch(
  query: string,
  options?: { datePrefix?: string; attempt?: number; digest?: SearchDigest; context?: string },
): Promise<GroundedSearchResult> {
  const attempt = options?.attempt ?? 0;
  const searchQuery = options?.datePrefix ? `${options.datePrefix} ${query}` : query;
  const fullQuery = options?.context
    ? `${searchQuery}\n\nCurrent facts from live match data, to read the sources against:\n${options.context}`
    : searchQuery;
  const cacheKind = options?.digest === 'evidence' ? (options.context ? 'analysis' : 'evidence') : 'brief';
  if (searchCache && attempt === 0) {
    const hit = await searchCache.get(searchQuery, cacheKind).catch(() => null);
    if (hit) return hit;
  }
  try {
    const res = await getAi().models.generateContent({
      model: FLASH_MODEL,
      contents: fullQuery,
      config: {
        systemInstruction:
          options?.digest === 'evidence'
            ? SEARCH_EVIDENCE_SYSTEM_INSTRUCTION + (options.context ? SEARCH_ANALYSIS_ADDENDUM : '')
            : SEARCH_DIGEST_SYSTEM_INSTRUCTION,
        ...samplingFor(FLASH_MODEL, 0.1),
        maxOutputTokens: outputCap(FLASH_MODEL, options?.digest === 'evidence' ? 800 : 420),
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

    const result = {
      query,
      text,
      sources,
      formattedBlock,
    };
    if (searchCache && text) await searchCache.set(searchQuery, cacheKind, result).catch(() => {});
    return result;
  } catch (e: any) {
    const is429 =
      e?.status === 429 ||
      String(e?.message).includes('429') ||
      String(e?.message).includes('RESOURCE_EXHAUSTED');
    // `evalStopped` is set only by the eval runner's guard (scripts/eval-guard.ts) on a refusal that ends a run: never retried.
    if (is429 && attempt < 2 && !e?.evalStopped) {
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

export const GREP_SAVED_DOSSIERS_DECLARATION = {
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

export const GREP_GAFFA_MARKET_DECLARATION = {
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

export const LOOK_UP_DOSSIER_DECLARATION = {
  name: 'look_up_dossier',
  description:
    'Reads the published Futbolpedia dossier card for one player from the user’s dossiers and every shared card: Overall, Potential, all attributes, archetype, strengths and weaknesses. Call it before judging, ranking or describing a player who is not already in <locked_dossiers>, and judge from everything on it, consistent with its numbers; quote numbers only where they help the reader, for the version under discussion. Returns found: false when nobody has rated him yet; then answer from grounding without inventing card numbers, and Futbolpedia offers the user a rating.',
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

export const SHOW_DOSSIER_DECLARATION = {
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

/** The writer's initiative tools: choices about the conversation itself, not about the football. */
export const ASK_USER_DECLARATION = {
  name: 'ask_user',
  description:
    'Ends your turn with a question for the user instead of an answer. Use it only when the message reads two ways that would change the answer and nothing in the conversation or the cards in play settles which one is meant: which version of a player when several cards are in play, which club, which season. Your reply is then only this question, so do not write an answer as well. When one reading is clearly likelier, take it and say in a sentence which you took; never ask out of caution or to avoid a judgment. Each option is a short, complete reply to the question that the user can send as their next message.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      question: {
        type: Type.STRING,
        description: 'The question, one short sentence that names what is unclear.',
      },
      options: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Two to four distinct readings, each a few words, each one a complete answer to the question.',
      },
    },
    required: ['question', 'options'],
  },
};

export const PREPARE_CLUB_DECLARATION = {
  name: 'prepare_club',
  description:
    'Starts the shared research on a club in the background and returns at once. It is for the next step of this conversation, not the current answer: use it for a club you expect the user to ask about next. It never changes this reply, and each club is prepared at most once per conversation.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      club: { type: Type.STRING, description: 'The club’s usual English name.' },
    },
    required: ['club'],
  },
};

export const OFFER_RATING_DECLARATION = {
  name: 'offer_rating',
  description:
    'Offers the user a rating of one player in Scout, shown under your reply. Use it when a player your answer leans on has no card for the version you discussed. It only offers: the user decides, and nothing is rated until they accept. It does nothing for a player who already has a card for that version.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: 'The player’s name.' },
      edition: {
        type: Type.STRING,
        enum: ['current', 'prime'],
        description: '"prime" for his best seasons, "current" for his form now.',
      },
    },
    required: ['name', 'edition'],
  },
};

/**
 * Handlers for the initiative tools. Each is optional: a turn passes only the tools it allows,
 * and the model is shown only those declarations.
 */
export interface InitiativeToolHandlers {
  ask?: (args: { question?: unknown; options?: unknown }) => unknown;
  prepare?: (args: { club?: unknown }) => unknown;
  offer?: (args: { name?: unknown; edition?: unknown }) => Promise<unknown> | unknown;
}

const initiativeDeclarations = (tools?: InitiativeToolHandlers): any[] => [
  ...(tools?.ask ? [ASK_USER_DECLARATION] : []),
  ...(tools?.prepare ? [PREPARE_CLUB_DECLARATION] : []),
  ...(tools?.offer ? [OFFER_RATING_DECLARATION] : []),
];

export const NETWORK_FUNCTION_DECLARATIONS = [
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
  // The structured club report and a table's rows are for research code and views; the model reads the text.
  const { report: _report, rows: _rows, ...rest } = await res.json();
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
  /** The writer's initiative tools (ask, prepare, offer); the default chat path only. */
  initiativeTools?: InitiativeToolHandlers;
  /**
   * The view tools (pitch, table, comparison, ranking): each call draws a view in the reply where the
   * model called it. Offered on every prose turn that can draw them, including those answered from cards.
   */
  viewTools?: { declarations: FunctionDeclaration[]; handles(name: string): boolean; run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> };
  /**
   * Checked after each round of tool calls: a string ends the turn, and is the reply (a question
   * the writer asked instead of answering).
   */
  endTurn?: () => string | null;
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

/**
 * The text of a streamed chunk that comes before any function call: text the model wrote just ahead
 * of a call in the same chunk is part of the reply (a view lands after it). Text after a call, or in
 * a chunk once calls are pending, is dropped as it always was. A chunk with no parts to read falls
 * back to its text.
 */
export function textBeforeCalls(chunk: any, callsPending: boolean): string {
  if (callsPending) return '';
  const parts: any[] | undefined = chunk?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    const text = chunk?.text;
    return typeof text === 'string' ? text : '';
  }
  let out = '';
  for (const part of parts) {
    if (part?.functionCall) break;
    if (typeof part?.text === 'string' && !part.thought) out += part.text;
  }
  return out;
}

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
    ...initiativeDeclarations(params.initiativeTools),
    ...(params.viewTools?.declarations ?? []),
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
      ...samplingFor(resolved.model, resolved.temperature),
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
          } else if (params.viewTools?.handles(String(functionCall.name))) {
            apiResult = await params.viewTools.run(String(functionCall.name), args);
          } else if (functionCall.name === 'ask_user' && params.initiativeTools?.ask) {
            apiResult = params.initiativeTools.ask(args);
          } else if (functionCall.name === 'prepare_club' && params.initiativeTools?.prepare) {
            apiResult = params.initiativeTools.prepare(args);
          } else if (functionCall.name === 'offer_rating' && params.initiativeTools?.offer) {
            apiResult = await params.initiativeTools.offer(args);
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
        // Calls from earlier chunks end the text; a call in this chunk ends it from the call on.
        const callsBefore = pendingCalls.length > 0;
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          pendingCalls.push(...chunk.functionCalls);
        }
        const finish = chunk.candidates?.[0]?.finishReason;
        if (finish) lastFinishReason = finish;
        reportGrounding(chunk.candidates?.[0], params.onGrounded);

        const chunkText = textBeforeCalls(chunk, callsBefore);
        if (chunkText.length > 0) {
          accumulatedText += chunkText;
          params.onStreamChunk?.(accumulatedText);
        }
      }
    };

    await consumeStream(parts);

    for (let round = 0; pendingCalls.length > 0 && round < MAX_TOOL_ROUNDS; round++) {
      const results = await executeToolCalls(pendingCalls);
      const ended = params.endTurn?.();
      if (ended) {
        params.onStreamChunk?.(ended);
        return ended;
      }
      await consumeStream(results);
    }

    if (!accumulatedText.trim()) throw blockedOrEmptyResponseError(lastFinishReason);

    return accumulatedText;
  }

  let response = await chatSession.sendMessage({ message: parts });

  for (let round = 0; response.functionCalls?.length && round < MAX_TOOL_ROUNDS; round++) {
    const results = await executeToolCalls(response.functionCalls);
    const ended = params.endTurn?.();
    if (ended) return ended;
    response = await chatSession.sendMessage({ message: results });
  }

  reportGrounding(response.candidates?.[0], params.onGrounded);
  const text = response.text;
  if (typeof text !== 'string') {
    throw blockedOrEmptyResponseError(response.candidates?.[0]?.finishReason);
  }
  return text;
}
