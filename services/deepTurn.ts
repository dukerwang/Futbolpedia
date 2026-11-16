import { FunctionCallingConfigMode, Type, type Content, type FunctionDeclaration } from '@google/genai';
import type { ChatMessage, PlayerProfile } from '../types';
import { resolveTaskModelConfig, samplingFor, type ThinkingTier } from '../constants/modelProfiles';
import { buildConversationalScoutInstruction } from '../prompts/chatPrompt';
import {
  blockedOrEmptyResponseError,
  getAi,
  getCurrentSeasonInfo,
  GREP_SAVED_DOSSIERS_DECLARATION,
  LOOK_UP_DOSSIER_DECLARATION,
  NETWORK_FUNCTION_DECLARATIONS,
  SHOW_DOSSIER_DECLARATION,
  THINKING_LEVEL_MAP,
} from './aiClient';
import { buildOngoingThreadBlock, CONTINUITY_REMINDER } from './chatContinuity';
import { formatVerifiedManagersBlock, getVerifiedClubManagers } from './clubManagers';
import { liveClubSnapshots, type SnapshotSource } from './clubSnapshots';
import {
  cardsForTurn,
  createDossierTools,
  editionGapNote,
  editionGaps,
  getThreadSignature,
  MANAGER_FIDELITY_RULE,
  presentFactRules,
  proseModeGuidance,
  sanitizeScoutProse,
  sanitizeScoutProseDetailed,
  stripScoutMarkup,
  threadStateFor,
  type FigureCheck,
} from './conversationalScout';
import { buildHistoryContents, grepDossiers, mergeAllCalibratedDossiers, serializeProfileForHistory, type DossierGrepParams } from './dossierStore';
import {
  addEvidence,
  emptyLedger,
  formatLedger,
  hasEvidence,
  seasonStartDate,
  type EvidenceLedger,
} from './evidenceLedger';
import { expandTables, type FigureClaim } from './figureGate';
import { correctReply, formatGateFeedback, gateFeedbackEnabled, GATE_FEEDBACK_STAGE_LABEL, type CorrectionModel, type GateFeedbackStats } from './gateFeedback';
import { REPLY_BLOCKS, ReplyComposer, runViewTool, viewToolDeclarations } from './replyBlocks';
import {
  executeCall,
  fileOutcomes,
  liveToolset,
  RESEARCH_COVERAGE_NOTE,
  RESEARCH_TOOL_GUIDE,
  type ResearchCall,
  type ResearchToolset,
  type ToolOutcome,
} from './researchTools';
import {
  applyStory,
  coresFromLedger,
  deriveClubCore,
  formatClubSituation,
  formatFactContext,
  sameClubName,
  type ClubSnapshot,
} from './situationSnapshot';
import { extractThreadClubs, type TurnRoute } from './turnRouter';
import type { VerifiedClubManager } from '../packages/engine/src/gates/managerMentions.ts';

/**
 * Deep mode: a chat path where one model loop decides every lookup (opt-in with the Deep toggle, or
 * the default for present-day questions once `DEEP_BY_DEFAULT` is on, with the stage pipeline as its
 * fallback). Instead of the brief,
 * reflect and situation calls the default path runs in an order code sets, the chat model gets the
 * conversation, the cards in play, each spotted club's stored snapshot and today's date, plus every
 * tool the writer and research have, and is told its budget. It calls what it wants, in the order
 * it wants; calls in one round run in parallel; each result ends with what's left of the budget.
 * Code enforces only the hard stops: once any budget is spent, the next round goes out with tools
 * off and a note that research is over, so the model must write.
 *
 * What the model may claim doesn't change: every tool result is filed in the evidence ledger, and
 * the figure gate, the manager lookup and scrub, and the number gate run on the reply exactly as
 * on a researched turn.
 */

/** Research time for the whole turn, from its start; the answer is written after it. */
export const DEEP_BUDGET_MS = 120_000;
/** Lookups per turn (live feeds, history routes, web searches, cards). The local grep and the show tools are free. */
export const DEEP_MAX_CALLS = 12;
/** Web searches per turn, counted inside `DEEP_MAX_CALLS`. */
export const DEEP_MAX_SEARCHES = 4;
/** Rounds of tool calls per turn. */
export const DEEP_MAX_ROUNDS = 10;
/** How long the turn waits for stored snapshots and today's coaches before the first round. */
export const DEEP_CONTEXT_WAIT_MS = 1_500;
/** A round's text this long, with no tool call yet, starts streaming as the answer. */
const STREAM_HOLD_CHARS = 200;
/** Clubs whose stored snapshot comes free with the first round. */
const MAX_CONTEXT_CLUBS = 3;

export interface DeepBudget {
  ms: number;
  calls: number;
  searches: number;
  rounds: number;
}

export const DEFAULT_DEEP_BUDGET: DeepBudget = {
  ms: DEEP_BUDGET_MS,
  calls: DEEP_MAX_CALLS,
  searches: DEEP_MAX_SEARCHES,
  rounds: DEEP_MAX_ROUNDS,
};

// ---------------------------------------------------------------------------------------------
// Entry

/**
 * Whether deep mode is the default for a turn that carries no flag. It ships off: a turn takes the
 * deep loop only when the user sent Deep (`deep: true`). Turned on, every turn `takesDeepPath`
 * accepts runs the loop, the composer's toggle reads Fast and sends `fast: true`, and Fast sends
 * the turn to the stage pipeline. The `deep` and `fast` flags still force either path whatever this
 * says, which is how the eval runs both. Flip it only on the strength of the eval in PR 77.
 */
export const DEEP_BY_DEFAULT = true;

/**
 * Whether a turn asked for the deep loop: `fast` always says no, `deep` says yes, and a turn with
 * neither follows the default. `fast` wins when both arrive, since it is the cheaper path.
 */
export function wantsDeep(turn: { deep?: boolean; fast?: boolean }, byDefault: boolean = DEEP_BY_DEFAULT): boolean {
  if (turn.fast) return false;
  return Boolean(turn.deep) || byDefault;
}

/** What the composer's one toggle says and sends, by `DEEP_BY_DEFAULT`: Deep when off, Fast when on. */
export function speedToggle(byDefault: boolean = DEEP_BY_DEFAULT): { text: string; tooltip: string; options: { deep: true } | { fast: true } } {
  return byDefault
    ? { text: 'Fast', tooltip: 'Fast: the scout answers quickly from a fixed research pass', options: { fast: true } }
    : { text: 'Deep', tooltip: 'Deep: the scout takes longer and decides its own research', options: { deep: true } };
}

/**
 * Whether a turn takes the deep path. It must have asked for it (`wantsDeep`), and questions about
 * the past keep the debate brief, ratings and challenges keep their pipelines, and Gaffa turns (the
 * panel, or a club attached in the app) keep the club blocks only the stage pipeline builds. Images
 * and archive questions stay on the stage pipeline too. Every other turn that asked takes the loop.
 */
export function takesDeepPath(turn: {
  deep?: boolean;
  fast?: boolean;
  /** Overrides `DEEP_BY_DEFAULT`, for tests and the eval. */
  byDefault?: boolean;
  route: Pick<TurnRoute, 'intent'>;
  historical: boolean;
  noRating?: boolean;
  gaffa?: boolean;
  image?: boolean;
}): boolean {
  if (!wantsDeep(turn, turn.byDefault) || turn.historical || turn.noRating || turn.gaffa || turn.image) return false;
  return !['single_dossier', 'challenge_or_revise', 'archive_inventory'].includes(turn.route.intent);
}

// ---------------------------------------------------------------------------------------------
// Fallback

/** Why a deep turn fell back: the loop threw, ended with no text, or spent its budget with no answer. */
export type DeepFallbackReason = 'error' | 'empty' | 'budget';

/** The loop gave up with nothing to show. Slowness alone is never one: a late answer is an answer. */
export class DeepFailure extends Error {
  constructor(
    readonly reason: Exclude<DeepFallbackReason, 'error'>,
    message: string,
  ) {
    super(message);
    this.name = 'DeepFailure';
  }
}

/** The progress line for a turn that gave up on deep mode. */
export const FALLBACK_STAGE_LABEL = 'Taking the standard route...';

export interface PathInfo {
  path: 'deep' | 'stage';
  /** Set on the stage run that followed a deep turn's failure. */
  fallback?: DeepFallbackReason;
}

/**
 * Runs a deep turn and, if the loop gives up, the stage pipeline once in its place. It falls back
 * only after the loop has thrown or ended with no answer, never on slowness, so a turn doesn't
 * pay twice for research that succeeded; the stage run starts after the loop has stopped.
 */
export async function runDeepWithFallback(
  deep: () => Promise<string>,
  stage: () => Promise<string>,
  hooks: { onStageChange?: (label: string) => void; onPath?: (info: PathInfo) => void } = {},
): Promise<string> {
  hooks.onPath?.({ path: 'deep' });
  try {
    return await deep();
  } catch (e: any) {
    const reason: DeepFallbackReason = e instanceof DeepFailure ? e.reason : 'error';
    console.warn(`[deep] fallback (${reason}): ${String(e?.message ?? e).slice(0, 160)}`);
    hooks.onStageChange?.(FALLBACK_STAGE_LABEL);
    hooks.onPath?.({ path: 'stage', fallback: reason });
    return stage();
  }
}

// ---------------------------------------------------------------------------------------------
// The model, behind an interface so tests can fake it

export interface DeepFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface DeepReply {
  /** The reply's text; empty when it only called tools. */
  text: string;
  calls: DeepFunctionCall[];
  finishReason?: string;
}

export interface DeepToolResponse {
  name: string;
  response: Record<string, unknown>;
}

export interface DeepConversation {
  /** Sends the next user turn (the prompt, or a round's tool results). `tools: false` sends it with function calling off. */
  send(message: string | DeepToolResponse[], options: { tools: boolean; onText?: (roundText: string) => void }): Promise<DeepReply>;
}

export interface DeepModel {
  open(args: { systemInstruction: string; history: Content[]; declarations: FunctionDeclaration[]; thinkingLevel?: ThinkingTier }): DeepConversation;
}

/** The chat model through `@google/genai`, streaming each round. */
export const liveDeepModel: DeepModel = {
  open({ systemInstruction, history, declarations, thinkingLevel }) {
    const resolved = resolveTaskModelConfig('deep', { thinkingLevel });
    const config = {
      systemInstruction,
      tools: [{ functionDeclarations: declarations }],
      ...samplingFor(resolved.model, resolved.temperature),
      thinkingConfig: { thinkingLevel: THINKING_LEVEL_MAP[resolved.thinkingLevel] },
    };
    const chat = getAi().chats.create({ model: resolved.model, config, history });
    return {
      async send(message, { tools, onText }) {
        const parts =
          typeof message === 'string'
            ? [{ text: message }]
            : message.map((r) => ({ functionResponse: { name: r.name, response: r.response } }));
        // Declarations stay so the history's calls still read; function calling is what turns off.
        const stream = await chat.sendMessageStream({
          message: parts,
          ...(tools ? {} : { config: { ...config, toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } } } }),
        });
        let text = '';
        let finishReason: string | undefined;
        const calls: DeepFunctionCall[] = [];
        for await (const chunk of stream) {
          for (const c of chunk.functionCalls ?? []) calls.push({ name: String(c.name), args: (c.args as Record<string, unknown>) ?? {} });
          const finish = chunk.candidates?.[0]?.finishReason;
          if (finish) finishReason = finish;
          // Text parts read directly: chunk.text warns on every chunk that also carries a call.
          const piece = (chunk.candidates?.[0]?.content?.parts ?? [])
            .filter((p) => typeof p.text === 'string' && !p.thought)
            .map((p) => p.text)
            .join('');
          if (piece && calls.length === 0) {
            text += piece;
            onText?.(text);
          }
        }
        return { text: calls.length ? '' : text, calls, finishReason };
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Tools

/** A tool's description as the research guide gives it. */
const guideText = (tool: string): string => {
  const line = RESEARCH_TOOL_GUIDE.split('\n').find((l) => l.startsWith(`- ${tool} (`)) ?? '';
  return line.slice(line.indexOf('): ') + 3).trim();
};

const DEEP_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'web_search',
    description: `${guideText('web_search')} Costs one of your web searches.`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'The search query, naming the season or dates you mean.' },
        kind: {
          type: Type.STRING,
          enum: ['facts', 'analysis'],
          description:
            '"analysis" for tactical or opinion pieces: the digest then reads each source against the live club data you already have and flags sources that describe an earlier team. Defaults to "facts".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'club_season',
    description: guideText('club_season'),
    parameters: {
      type: Type.OBJECT,
      properties: {
        club: { type: Type.STRING, description: 'The club name.' },
        season: { type: Type.STRING, description: 'The season, as YYYY-YY.' },
      },
      required: ['club', 'season'],
    },
  },
  {
    name: 'player_career',
    description: guideText('player_career'),
    parameters: {
      type: Type.OBJECT,
      properties: { name: { type: Type.STRING, description: "The player's full name." } },
      required: ['name'],
    },
  },
  ...viewToolDeclarations(),
];

/** Every tool the deep loop offers, the writer's and research's together. */
export const DEEP_DECLARATIONS: FunctionDeclaration[] = [
  GREP_SAVED_DOSSIERS_DECLARATION,
  LOOK_UP_DOSSIER_DECLARATION,
  SHOW_DOSSIER_DECLARATION,
  ...NETWORK_FUNCTION_DECLARATIONS,
  ...DEEP_FUNCTION_DECLARATIONS,
] as FunctionDeclaration[];

/** The research call behind each function that reads a source, so its result lands in the ledger. */
const RESEARCH_FUNCTIONS: Record<string, (args: Record<string, unknown>) => ResearchCall | null> = {
  get_club_recent_team: (a) => (str(a.team) ? { tool: 'club_recent_team', subject: str(a.team), stage: 'facts' } : null),
  get_player_season: (a) => (str(a.name) ? { tool: 'player_season', subject: str(a.name), stage: 'facts' } : null),
  get_league_table: (a) =>
    str(a.league) ? { tool: 'league_table', subject: str(a.league), ...(str(a.country) ? { country: str(a.country) } : {}), stage: 'facts' } : null,
  web_search: (a) => (str(a.query) ? { tool: 'web_search', subject: str(a.query), stage: a.kind === 'analysis' ? 'analysis' : 'facts' } : null),
  club_season: (a) => (str(a.club) && str(a.season) ? { tool: 'club_season', subject: str(a.club), season: str(a.season), stage: 'facts' } : null),
  player_career: (a) => (str(a.name) ? { tool: 'player_career', subject: str(a.name), stage: 'facts' } : null),
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Tools that cost a lookup. The local grep and the presentation tools are free. */
const COUNTED = new Set([...Object.keys(RESEARCH_FUNCTIONS), 'look_up_dossier']);

/** The progress line for one tool call. */
export function stageLabel(call: DeepFunctionCall): string {
  const a = call.args ?? {};
  switch (call.name) {
    case 'get_club_recent_team':
      return `Reading ${str(a.team) || 'the club'}'s recent lineups`;
    case 'get_player_season':
      return `Reading ${str(a.name) || 'the player'}'s season`;
    case 'get_league_table':
      return `Reading the ${str(a.league) || 'league'} table`;
    case 'web_search':
      return `Searching: ${str(a.query).slice(0, 80)}`;
    case 'club_season':
      return `Reading ${str(a.club) || 'the club'}'s ${str(a.season) ? `${str(a.season)} ` : ''}season`;
    case 'player_career':
      return `Reading ${str(a.name) || 'the player'}'s career`;
    case 'look_up_dossier':
      return str(a.name) ? `Reading ${str(a.name)}'s card` : 'Reading a card';
    case 'show_dossier':
      return str(a.name) ? `Showing ${str(a.name)}'s card` : 'Showing a card';
    case 'show_pitch':
      return `Drawing ${str(a.club) || 'the club'}'s XI`;
    case 'grep_saved_dossiers':
      return 'Searching your dossiers';
    default:
      return 'Researching';
  }
}

// ---------------------------------------------------------------------------------------------
// Prompts

/** Deep mode's part of the system instruction: the budget and how to spend it. Descriptive only. */
export const deepModeRules = (budget: DeepBudget): string => `## Deep mode

In this conversation you decide your own research. Your tools read live club data, Premier League player seasons, league tables, past club seasons, player careers, the web, the stored dossier cards and the user's saved dossiers; two more show things under your reply: show_pitch draws a club's first-choice XI and show_dossier shows a player's card.

Budget for this turn: ${Math.round(budget.ms / 1000)} seconds of research, ${budget.calls} lookups (at most ${budget.searches} of them web searches) and ${budget.rounds} rounds of tool calls. The local dossier search and the two show tools are free. Every tool result ends with what's left. When any part of the budget runs out, research is over and your next reply must be the answer.

How to research:
- First work out what the answer has to establish, then look up only that. Stop researching as soon as you have what the answer needs; a question the conversation or the cards already answer needs no lookup.
- Call independent lookups together in one round: they run in parallel. Follow up only on what a result left open.
- For who plays, results, availability and standings, use the live feeds. Use web search for what the feeds don't cover (tactical analysis, transfers and their dates, news, clubs or players outside the feeds), naming the season. A web search is the slowest and scarcest lookup: don't search for what a feed already gave you.
- A lookup that came back not covered won't work if asked again.
- An answer about the present says what is different this season for the club or player it is about (the people, the coach, the shape, the role or the form) and why. Find that out unless the conversation, a stored snapshot or a result already says it.
- An answer about who is missing or doubtful reads team news as well as the injury list: no free source records knocks between list updates, and news reports them first.
- Each result also lists what is still unchecked for the clubs and players in the question. Spend on those only where the answer needs them.
- Draw a club's XI with show_pitch when the answer is about who plays for it or how it lines up; show a card with show_dossier when the card itself answers the user.
- Write nothing to the user while you research. When research is done, write the whole answer in one reply.

${RESEARCH_COVERAGE_NOTE}`;

/** How deep mode builds a team: from the lineups its own lookups returned. */
const DEEP_TEAM_RULES =
  'Build the team from the recent starting XIs and the injury list your club lookups returned, or from <stored_snapshots>, never from the registered squad or memory. Name one player for each role and commit to him; mention another only where the recent XIs show an even split, as the alternative, never as a joint holder of the role or a pair of names in a heading. A player listed as out is unavailable and must not be described as playing; a registered player missing from recent XIs is at most a rotation option, however prominent he once was. Recent signings and positional changes override what you remember of the club. If no lookup gave recent lineups, say which parts of the shape you could not verify rather than filling them from memory.';

const DEEP_FACT_SOURCES =
  'your tool results this turn, <stored_snapshots>, the numbered entries in <factual_foundation>, or existing dossiers';

const RESEARCH_OVER =
  'Research is over: the budget is spent. Write the whole answer now from what you have, and say plainly what you could not verify.';

const formatBudget = (left: DeepBudget): string =>
  `Budget left: ${Math.max(0, Math.round(left.ms / 1000))} s, ${Math.max(0, left.calls)} lookups, ${Math.max(0, left.searches)} web searches, ${Math.max(0, left.rounds)} rounds.`;

/** A stored club snapshot as deep mode's first round reads it. */
const formatStoredSnapshots = (snapshots: ClubSnapshot[]): string =>
  snapshots.length
    ? `<stored_snapshots>
Each club's stored snapshot, built at the time shown from its live data and a research pass. Its first-choice XI and absences are as of then; call get_club_recent_team for today's.
${snapshots.map((s) => `${formatClubSituation(applyStory(s.core, s.story))}\n(built ${s.builtAt.slice(0, 16).replace('T', ' ')})`).join('\n\n')}
</stored_snapshots>`
    : '';

// ---------------------------------------------------------------------------------------------
// Coverage

/** Words in a search query that show it asked what changed this season. */
const CHANGE_CUES = /\b(?:chang\w*|transfers?|signings?|signed|arriv\w*|depart\w*|new|since last season|summer|differen\w*|evolv\w*)\b/i;
/** Words in a search query that show it asked for team news on absences. */
const NEWS_CUES = /\b(?:injur\w*|team news|news|absen\w*|fitness|doubts?|suspen\w*|knocks?|ruled out)\b/i;
/** Club-name words too common to identify a club in a query. */
const GENERIC_NAME = new Set(['football', 'club', 'city', 'united', 'real', 'athletic', 'sporting', 'town', 'rovers', 'hotspur']);

/** Whether a query names a club or player: the whole name, or its most telling word. */
const queryNames = (query: string, name: string): boolean => {
  const q = query.toLowerCase();
  if (q.includes(name.toLowerCase())) return true;
  const words = name.toLowerCase().split(/[\s-]+/).filter((w) => w.length >= 4 && !GENERIC_NAME.has(w));
  return words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q));
};

/**
 * What a question about the present usually needs for each club and player it names, that this
 * turn hasn't checked yet: a club's recent lineups, its injury list (or, where no list covers it,
 * team news), a dated search on what changed this season (a fresh stored snapshot already says),
 * and a player's season record. The items follow what the sources cover (`RESEARCH_COVERAGE_NOTE`).
 * Code only lists them; the model decides whether to spend on them. Pure.
 */
export function uncheckedFor(
  subjects: { clubs: string[]; players: string[] },
  ledger: EvidenceLedger,
  stored: ClubSnapshot[] = [],
): string[] {
  const looked = (tool: string, name: string) => ledger.lookups.some((l) => l.tool === tool && (sameClubName(l.subject, name) || queryNames(l.subject, name)));
  const searched = (name: string, cues: RegExp) => ledger.lookups.some((l) => l.tool === 'web_search' && queryNames(l.subject, name) && cues.test(l.subject));
  const items: string[] = [];
  for (const club of subjects.clubs) {
    const entry = ledger.entries.find((e) => e.club && sameClubName(e.club.team, club));
    const read = Boolean(entry) || looked('club_recent_team', club);
    if (!read) items.push(`${club}'s recent lineups and injury list (get_club_recent_team)`);
    // Only Premier League clubs have an injury list; elsewhere, news is the only source.
    else if (entry?.club && entry.club.fplPlayers === null && !searched(club, NEWS_CUES)) items.push(`team news on ${club}'s absences (no injury list covers it)`);
    const snapshot = stored.some((s) => sameClubName(s.club, club) && s.story.changes.length > 0);
    if (!snapshot && !searched(club, CHANGE_CUES)) items.push(`a dated search on what changed at ${club} this season`);
  }
  for (const player of subjects.players) {
    if (!looked('player_season', player)) items.push(`${player}'s season record (get_player_season; Premier League players only)`);
    if (!searched(player, CHANGE_CUES)) items.push(`a dated search on what changed for ${player} this season`);
  }
  return items;
}

/** The unchecked items as one line for a tool result. */
export const formatUnchecked = (items: string[]): string =>
  items.length ? `Not yet checked: ${items.join('; ')}.` : 'Nothing on the usual checklist for this question is unchecked.';

// ---------------------------------------------------------------------------------------------
// The loop

export interface DeepTurnParams {
  message: string;
  route: TurnRoute;
  history: ChatMessage[];
  isEAFCRequest: boolean;
  conversationDossiers: PlayerProfile[];
  savedDossiers: PlayerProfile[];
  lockedDossiersBlock: string;
  savedDossiersBlock: string;
  peerLedgerBlock?: string;
  /** What the reply shows besides its prose; a turn run without one keeps its views to itself. */
  composer?: ReplyComposer;
  onStreamChunk?: (accumulatedText: string) => void;
  onStageChange?: (stageLabel: string) => void;
  perf?: (label: string) => void;
  conversationId?: string;
}

export interface DeepTurnDeps {
  model?: DeepModel;
  tools?: ResearchToolset;
  snapshots?: SnapshotSource | null;
  managers?: (clubs: string[]) => Promise<VerifiedClubManager[]>;
  budget?: Partial<DeepBudget>;
  thinkingLevel?: ThinkingTier;
  now?: () => number;
  /** Called once with what the loop did, for tests and the eval. */
  onStats?: (stats: DeepStats) => void;
  /** The gate feedback round's model, for tests. */
  gateFeedback?: CorrectionModel;
}

export interface DeepStats {
  rounds: number;
  /** Lookups that ran (counted against the budget). */
  calls: number;
  searches: number;
  /** Every tool call the model made, in order, by name. */
  toolCalls: string[];
  /** Why research ended. */
  stop: 'answered' | 'time' | 'calls' | 'searches' | 'rounds';
  /** The gate feedback round's counts (`gateFeedback.ts`); null when no round finished. A round that ran is also counted in `calls`. */
  gateFeedback: GateFeedbackStats | null;
}

/** The promise's value, or null once `ms` has passed. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
  });
  // The timer goes once the promise settles, so a finished lookup leaves nothing running.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

const noLive: Promise<ToolOutcome> = Promise.resolve({ status: 'empty', result: null, missing: [] });

export async function runDeepTurn(params: DeepTurnParams, deps: DeepTurnDeps = {}): Promise<string> {
  const { message, route, history, perf } = params;
  const composer = params.composer ?? new ReplyComposer();
  const model = deps.model ?? liveDeepModel;
  const now = deps.now ?? Date.now;
  const budget: DeepBudget = { ...DEFAULT_DEEP_BUDGET, ...deps.budget };
  const snapshots = deps.snapshots === undefined ? liveClubSnapshots : deps.snapshots;
  const lookUpManagers = deps.managers ?? getVerifiedClubManagers;
  const start = now();
  const { year, month, currentSeason, seasonStartYear } = getCurrentSeasonInfo();

  // The cards in play, as the default path picks them.
  const allCalibrated = mergeAllCalibratedDossiers(params.savedDossiers, params.conversationDossiers);
  const { matchedCards, lockedCards } = cardsForTurn(message, route.targetPlayers, allCalibrated, false);
  const cardsInPlay: PlayerProfile[] = [...lockedCards];
  const tools = deps.tools ?? liveToolset([...lockedCards, ...allCalibrated]);
  const gaps = editionGaps(lockedCards, false, message, matchedCards);

  // Free context: each spotted club's stored snapshot and today's coaches, waited for briefly.
  const spottedClubs = (route.targetClubs?.length ? route.targetClubs : extractThreadClubs(message, history)).slice(0, MAX_CONTEXT_CLUBS);
  const managerJobs: Promise<VerifiedClubManager[]>[] = [];
  const startManagers = (clubs: string[]): Promise<VerifiedClubManager[]> => {
    const job = clubs.filter(Boolean).length ? lookUpManagers(clubs).catch(() => []) : Promise.resolve([]);
    managerJobs.push(job);
    return job;
  };
  const firstManagers = startManagers([...spottedClubs, ...lockedCards.map((c) => c.basicInfo.club)]);
  const storedJobs = snapshots ? spottedClubs.map((c) => snapshots.stored(c, noLive).catch(() => null)) : [];
  const [storedRaw, managersAtStart] = await Promise.all([
    Promise.all(storedJobs.map((j) => within(j, DEEP_CONTEXT_WAIT_MS))),
    within(firstManagers, DEEP_CONTEXT_WAIT_MS),
  ]);
  const stored = storedRaw.filter((s): s is ClubSnapshot => Boolean(s));
  const storedBlock = formatStoredSnapshots(stored);
  perf?.(`deep context (${stored.length} stored snapshots, ${managersAtStart?.length ?? 0} coaches)`);

  // A follow-up in the same thread starts from what the last turn found.
  const thread = threadStateFor(params.conversationId ?? 'local');
  const signature = getThreadSignature(history, message);
  let ledger: EvidenceLedger = emptyLedger();
  if (signature === thread.signature && thread.grounding) {
    ledger = addEvidence(ledger, { kind: 'prior_turn', label: 'Research from the previous turn', content: thread.grounding.slice(0, 1400) });
  }
  const priorFoundation = hasEvidence(ledger) ? `<factual_foundation>\n${formatLedger(ledger)}\n</factual_foundation>` : '';

  const ongoingThread = buildOngoingThreadBlock(history);
  const analyticalMode = route.analyticalMode ?? (route.intent === 'compare' ? 'head_to_head' : route.targetPlayers.length === 1 ? 'player_qa' : 'debate_or_verdict');
  const shownNames = composer.cards.map((c) => c.basicInfo.name);
  const shownNote = shownNames.length
    ? ` The user sees the dossier card of ${shownNames.join(' and ')} under your reply, so answer from it without reciting its attributes.`
    : '';
  const missingCards = composer.scoutOffers;
  const missingNote = missingCards.length
    ? ` No stored card exists for ${missingCards.join(' or ')}; they were already checked, so don't look them up.`
    : '';
  const gapNote = gaps.length ? ` ${gaps.map(editionGapNote).join(' ')}` : '';
  const prompt = `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
${ongoingThread}
${storedBlock}
${priorFoundation}
${formatVerifiedManagersBlock(managersAtStart ?? [])}
${params.peerLedgerBlock ?? ''}
${params.lockedDossiersBlock}
${params.savedDossiersBlock}
<instructions>
1. ${proseModeGuidance(route, analyticalMode, currentSeason, null, DEEP_TEAM_RULES)}${shownNote}${missingNote}${gapNote}
2. ${presentFactRules(currentSeason, DEEP_FACT_SOURCES)}
3. ${MANAGER_FIDELITY_RULE} A <verified_managers> block in a tool result counts too.
4. ${CONTINUITY_REMINDER}
</instructions>
<task>${message}</task>`;

  const conversation = model.open({
    systemInstruction: `${buildConversationalScoutInstruction(params.isEAFCRequest)}\n\n${deepModeRules(budget)}`,
    history: buildHistoryContents(history, params.conversationDossiers),
    declarations: DEEP_DECLARATIONS,
    thinkingLevel: deps.thinkingLevel,
  });

  // Budget.
  let calls = 0;
  let searches = 0;
  let rounds = 0;
  const left = (): DeepBudget => ({
    ms: start + budget.ms - now(),
    calls: budget.calls - calls,
    searches: budget.searches - searches,
    rounds: budget.rounds - rounds,
  });
  const spentOn = (): DeepStats['stop'] | null => {
    const l = left();
    return l.ms <= 0 ? 'time' : l.calls <= 0 ? 'calls' : l.searches <= 0 ? 'searches' : l.rounds <= 0 ? 'rounds' : null;
  };

  // Conduct: what the figure gate checks the reply against, and every coach verified this turn.
  const toolResults: string[] = [];
  const managers = (): Promise<VerifiedClubManager[]> =>
    Promise.all(managerJobs).then((lists) => [...new Map(lists.flat().map((m) => [m.club.toLowerCase(), m])).values()]);
  let verified: VerifiedClubManager[] = managersAtStart ?? [];
  const figureCheck: FigureCheck = {
    evidence: () =>
      [
        storedBlock,
        expandTables(formatLedger(ledger)),
        params.lockedDossiersBlock,
        params.peerLedgerBlock ?? '',
        params.savedDossiersBlock,
        formatVerifiedManagersBlock(verified),
        ongoingThread,
        message,
        ...cardsInPlay.map(serializeProfileForHistory),
        ...toolResults,
      ].join('\n'),
    grounded: [],
  };
  const managerContext = () => ({ verifiedFacts: [formatLedger(ledger)].filter(Boolean), clubManagers: verified });
  const clean = (text: string) => sanitizeScoutProse(text, managerContext(), cardsInPlay, figureCheck);

  const dossierTools = createDossierTools({ cardsInPlay, localCards: allCalibrated, historical: false, composer });
  const dossiersPool = [...params.savedDossiers, ...params.conversationDossiers];

  /** Draws a club's XI through the registry's `pitch` entry, which reads the feed when this turn hasn't. */
  const showPitch = (club: string): Promise<Record<string, unknown>> =>
    runViewTool(
      REPLY_BLOCKS.pitch,
      { club },
      {
        tools,
        ledger: { read: () => ledger, write: (next) => { ledger = next; } },
        stored,
        now,
      },
      composer,
    );

  /** The model's view of a lookup's outcome. */
  const describe = (outcome: ToolOutcome): Record<string, unknown> => ({
    status: outcome.status,
    ...(outcome.result ? { source: outcome.result.label, data: outcome.result.content } : {}),
    ...(outcome.result?.sources?.length ? { sources: outcome.result.sources } : {}),
    ...(outcome.missing.length ? { noDataFor: outcome.missing.map((m) => `${m.item} (${m.status.replace('_', ' ')})`) } : {}),
    ...(outcome.note ? { note: outcome.note } : {}),
  });

  /** Runs one round: refuses what the budget can't cover, runs the rest in parallel, files the results. */
  const runRound = async (round: DeepFunctionCall[]): Promise<DeepToolResponse[]> => {
    const jobs = round.map(async (call): Promise<{ response: Record<string, unknown>; filed?: { call: ResearchCall; outcome: ToolOutcome } }> => {
      const args = call.args ?? {};
      const research = RESEARCH_FUNCTIONS[call.name];
      if (COUNTED.has(call.name)) {
        if (calls >= budget.calls) return { response: { status: 'not_run', reason: 'The lookup budget is spent.' } };
        if (call.name === 'web_search' && searches >= budget.searches) return { response: { status: 'not_run', reason: 'The web search budget is spent.' } };
      }
      const researchCall = research ? research(args) : null;
      if (research && !researchCall) return { response: { status: 'not_run', reason: 'Missing argument.' } };
      if (COUNTED.has(call.name)) {
        calls++;
        if (call.name === 'web_search') searches++;
      }
      params.onStageChange?.(stageLabel(call));
      const timeLeft = Math.max(1_000, left().ms);
      try {
        if (researchCall) {
          // An analysis search reads its sources against the live club data already in.
          const context = researchCall.stage === 'analysis' ? formatFactContext(coresFromLedger(ledger)) : undefined;
          const coach = researchCall.tool === 'club_recent_team' ? startManagers([researchCall.subject]) : null;
          const outcome =
            (await within(executeCall(researchCall, tools, context || undefined), timeLeft)) ??
            ({ status: 'failed', result: null, missing: [], note: 'too slow: the time budget ran out' } as ToolOutcome);
          const response = describe(outcome);
          if (coach) {
            const found = (await within(coach, Math.min(timeLeft, 10_000))) ?? [];
            const block = formatVerifiedManagersBlock(found);
            response.verifiedCoach = block || 'No current coach could be verified for this club; name none.';
          }
          return { response, filed: { call: researchCall, outcome } };
        }
        switch (call.name) {
          case 'look_up_dossier': {
            const result = (await dossierTools.lookUp(args as { name?: string; edition?: string })) as Record<string, unknown>;
            return { response: result };
          }
          case 'show_dossier':
            return { response: (await dossierTools.show(args as { name?: string })) as Record<string, unknown> };
          case 'show_pitch':
            return { response: await showPitch(str(args.club)) };
          case 'grep_saved_dossiers':
            return { response: grepDossiers(dossiersPool, args as DossierGrepParams) as unknown as Record<string, unknown> };
          default:
            return { response: { error: `Unknown tool: ${call.name}` } };
        }
      } catch (e: any) {
        return { response: { status: 'failed', error: String(e?.message ?? e).slice(0, 120) } };
      }
    });
    const done = await Promise.all(jobs);
    // Filed in call order, so ledger ids follow the round.
    const filed = done.flatMap((d) => (d.filed ? [d.filed] : []));
    ledger = fileOutcomes(ledger, filed.map((f) => f.call), filed.map((f) => f.outcome));
    // A card the model read is evidence too.
    round.forEach((call, i) => {
      const card = done[i].response.card;
      if (call.name === 'look_up_dossier' && typeof card === 'string') {
        ledger = addEvidence(ledger, { kind: 'card', label: `${str(call.args?.name)} (stored card)`, content: card });
      }
    });
    return round.map((call, i) => ({ name: call.name, response: done[i].response }));
  };

  // Streaming: a round's text streams once it is clearly the answer, never a preamble to tool calls.
  let streamed = false;
  let firstToken = true;
  const onText = (roundText: string, final: boolean) => {
    if (!params.onStreamChunk || (!final && !streamed && roundText.length < STREAM_HOLD_CHARS)) return;
    streamed = true;
    if (firstToken) {
      firstToken = false;
      perf?.('first answer token');
    }
    params.onStreamChunk(clean(roundText));
  };

  const toolCalls: string[] = [];
  let stop: DeepStats['stop'] = 'answered';
  params.onStageChange?.('Planning the research...');
  let reply = await conversation.send(prompt, { tools: true, onText: (t) => onText(t, false) });
  while (reply.calls.length > 0) {
    rounds++;
    toolCalls.push(...reply.calls.map((c) => c.name));
    perf?.(`deep round ${rounds}: ${reply.calls.map((c) => c.name).join(', ')}`);
    const responses = await runRound(reply.calls);
    const over = spentOn();
    const budgetLine = formatBudget(left());
    const uncheckedLine = formatUnchecked(uncheckedFor({ clubs: spottedClubs, players: route.targetPlayers }, ledger, stored));
    const results = responses.map((r) => ({
      name: r.name,
      response: { ...r.response, ...(over ? { researchOver: RESEARCH_OVER } : {}), unchecked: uncheckedLine, budget: budgetLine },
    }));
    for (const r of results) toolResults.push(JSON.stringify(r.response));
    params.onStageChange?.(over ? 'Writing scouting analysis...' : 'Weighing what came back...');
    reply = await conversation.send(results, { tools: !over, onText: (t) => onText(t, Boolean(over)) });
    if (over) {
      stop = over;
      break;
    }
  }
  // A reply with no text (or calls the model was told it couldn't make) gets one plain request to write.
  if (!reply.text.trim()) {
    reply = await conversation.send(RESEARCH_OVER, { tools: false, onText: (t) => onText(t, true) });
  }
  if (!reply.text.trim()) {
    const why = blockedOrEmptyResponseError(reply.finishReason).message;
    throw new DeepFailure(stop === 'answered' ? 'empty' : 'budget', stop === 'answered' ? why : `the ${stop} budget was spent and no answer followed: ${why}`);
  }

  verified = await within(managers(), 5_000).then((m) => m ?? verified);
  // A short answer held back while it might have been a preamble streams now.
  if (!streamed) onText(reply.text, true);

  // The gates check the reply against the turn's evidence. When they flag something and the budget
  // isn't spent, the model gets one call to fix it first; a round that runs counts as a lookup.
  const finalFigures: FigureCheck = {
    ...figureCheck,
    onRemoved: (removed: FigureClaim[]) => {
      if (removed.length) console.info(`[FigureGate] Removed ${removed.length} figures from a deep reply: ${removed.map((r) => r.text).join('; ')}`);
    },
  };
  let finalText: string;
  let feedback: GateFeedbackStats | null = null;
  const spent = left();
  if (gateFeedbackEnabled() && spent.calls > 0 && spent.ms > 0) {
    const corrected = await correctReply({
      raw: reply.text,
      sanitize: (text) => sanitizeScoutProseDetailed(text, managerContext(), cardsInPlay, finalFigures),
      strip: stripScoutMarkup,
      correct: deps.gateFeedback,
      onCorrecting: () => params.onStageChange?.(GATE_FEEDBACK_STAGE_LABEL),
      now,
    });
    if (corrected.called) calls++;
    feedback = corrected.stats;
    finalText = corrected.text;
    if (feedback) perf?.(`gate feedback: ${formatGateFeedback(feedback)}`);
  } else {
    finalText = sanitizeScoutProse(reply.text, managerContext(), cardsInPlay, finalFigures);
  }

  const stats: DeepStats = { rounds, calls, searches, toolCalls, stop, gateFeedback: feedback };
  deps.onStats?.(stats);
  perf?.(`deep turn: ${rounds} rounds, ${calls} lookups (${searches} searches), stop ${stop}, tools ${toolCalls.join(', ') || 'none'}, gate feedback ${feedback ? formatGateFeedback(feedback) : 'none'}`);

  // A normal follow-up reads this turn's research the way it reads research's.
  const thisTurn = formatLedger({ ...ledger, entries: ledger.entries.filter((e) => e.kind !== 'prior_turn') }, { seasonStart: seasonStartDate(seasonStartYear) });
  if (ledger.entries.some((e) => e.kind !== 'prior_turn')) {
    thread.signature = signature;
    thread.grounding = thisTurn;
  }

  return finalText;
}
