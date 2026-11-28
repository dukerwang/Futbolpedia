import { FunctionCallingConfigMode, Type, type Content, type FunctionDeclaration } from '@google/genai';
import type { ChatMessage, GaffaContextBag, PlayerProfile } from '../types';
import { grepGaffaBag, type GaffaMarketGrepParams } from '../constants/gaffaRules';
import { resolveTaskModelConfig, samplingFor, type ThinkingTier } from '../constants/modelProfiles';
import { buildConversationalScoutInstruction, viewRules } from '../prompts/chatPrompt';
import {
  blockedOrEmptyResponseError,
  getAi,
  getCurrentSeasonInfo,
  GREP_GAFFA_MARKET_DECLARATION,
  GREP_SAVED_DOSSIERS_DECLARATION,
  LOOK_UP_DOSSIER_DECLARATION,
  NETWORK_FUNCTION_DECLARATIONS,
  SHOW_DOSSIER_DECLARATION,
  textBeforeCalls,
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
  wantsPrimeOf,
  type FigureCheck,
} from './conversationalScout';
import { buildHistoryContents, getCardKey, grepDossiers, mergeAllCalibratedDossiers, serializeProfileForHistory, type DossierGrepParams } from './dossierStore';
import {
  addEvidence,
  emptyLedger,
  formatLedger,
  hasEvidence,
  seasonStartDate,
  type EvidenceEntry,
  type EvidenceLedger,
} from './evidenceLedger';
import { expandTables, type FigureClaim } from './figureGate';
import type { AvailabilityFetcher } from './gaffaAvailability';
import { buildGaffaTurn, finishGaffaReply, type GaffaTurn } from './gaffaTurn';
import { correctReply, formatGateFeedback, gateFeedbackEnabled, GATE_FEEDBACK_STAGE_LABEL, type CorrectionModel, type GateFeedbackStats } from './gateFeedback';
import { createViewTools, gateSegments, joinSegments, makeCardLookup, MAX_REPLY_VIEWS, ReplyComposer, splitSegments, viewToolDeclarations } from './replyBlocks';
import { PAST_MODE, type VerdictDb } from './debateVerdicts';
import type { CardDisagreement } from './cardDisagreements';
import { liveEraSnapshots, normalizePeriod, type EraSnapshotSource } from './eraSnapshots';
import { matchStanding } from './debateConsistency';
import { MAX_ERA_BUILDS } from './debateBrief';
import {
  CARD_ANCHOR_NOTE,
  MAX_COMMITS,
  COMMIT_VERDICT_DECLARATION,
  comparesVersions,
  createCommitTool,
  PAST_BUDGET,
  eraEvidence,
  finishPastTurn,
  formatCardsInPlay,
  formatSettledVerdicts,
  liveTurnNetwork,
  loadPastContext,
  PAST_RESEARCH_NOTE,
  pastFigureBudget,
  pastInstructions,
  pastUncheckedFor,
  standingsOf,
  type PastContext,
  type PastNetwork,
} from './pastTurn';
import {
  executeCall,
  fileOutcomes,
  getLive,
  liveToolset,
  RESEARCH_COVERAGE_NOTE,
  RESEARCH_TOOL_GUIDE,
  type ResearchCall,
  type ResearchToolset,
  type ToolOutcome,
} from './researchTools';
import { lookUpTeamStrength, runTeamStrength, TEAM_STRENGTH_DECLARATION } from './kb/teamStrengthTool';
import type { TeamStrengthResult } from './kb/teamStrength';
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
 * The chat turn: one model loop decides every lookup, for every present-day question, with the
 * stage pipeline as its fallback. Instead of the brief, reflect and situation calls the stage
 * pipeline runs in an order code sets, the chat model gets the
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
export const CHAT_BUDGET_MS = 120_000;
/** Lookups per turn (live feeds, history routes, web searches, cards). The local grep and the show tools are free. */
export const CHAT_MAX_CALLS = 12;
/** Web searches per turn, counted inside `CHAT_MAX_CALLS`. */
export const CHAT_MAX_SEARCHES = 4;
/** Rounds of tool calls per turn. */
export const CHAT_MAX_ROUNDS = 10;
/** How long the turn waits for stored snapshots and today's coaches before the first round. */
export const CHAT_CONTEXT_WAIT_MS = 1_500;
/** A round's text this long, with no tool call yet, starts streaming as the answer. */
const STREAM_HOLD_CHARS = 200;
/**
 * Card reads (`look_up_dossier`) a turn may make. They read your dossiers and the shared cards, no
 * model or search, so they cost no lookup; this ceiling only stops a loop that reads cards forever.
 * A ranking reads one card per player, and before this a ten-name ranking spent a past turn's whole
 * lookup budget on cards and never committed its order.
 */
export const MAX_CARD_READS = 15;
/** Clubs whose stored snapshot comes free with the first round. */
const MAX_CONTEXT_CLUBS = 3;

export interface ResearchBudget {
  ms: number;
  calls: number;
  searches: number;
  rounds: number;
}

export const DEFAULT_RESEARCH_BUDGET: ResearchBudget = {
  ms: CHAT_BUDGET_MS,
  calls: CHAT_MAX_CALLS,
  searches: CHAT_MAX_SEARCHES,
  rounds: CHAT_MAX_ROUNDS,
};

// ---------------------------------------------------------------------------------------------
// Entry

/**
 * Whether a turn takes the chat loop. Questions about the past keep the debate brief (until
 * `PAST_MODE`), ratings and challenges keep their pipelines, and Gaffa's own panel (`noRating`, on a
 * daily turn budget) and a Gaffa trade (whose scorecard is shown above a capped reply) keep the stage
 * pipeline. Images and archive questions stay on the stage pipeline too. Every other turn takes the
 * loop, a club attached in the app included. `stage` sends a turn the loop would take to the stage
 * pipeline instead: only the eval's `--stage` and the tests send it.
 */
export function takesChatLoop(turn: {
  /** Forces the stage pipeline, for the eval's `--stage` and the tests. */
  stage?: boolean;
  route: Pick<TurnRoute, 'intent'>;
  historical: boolean;
  noRating?: boolean;
  /** A Gaffa club is attached and the turn is a trade (`isGaffaTrade`). */
  gaffaTrade?: boolean;
  image?: boolean;
  /** Overrides `PAST_MODE`: whether a question about the past takes the loop. */
  pastMode?: boolean;
}): boolean {
  const pastOff = turn.historical && !(turn.pastMode ?? PAST_MODE);
  if (turn.stage || pastOff || turn.noRating || turn.gaffaTrade || turn.image) return false;
  return !['single_dossier', 'challenge_or_revise', 'archive_inventory'].includes(turn.route.intent);
}

// ---------------------------------------------------------------------------------------------
// Fallback

/** Why a chat turn fell back: the loop threw, ended with no text, or spent its budget with no answer. */
export type FallbackReason = 'error' | 'empty' | 'budget';

/** The loop gave up with nothing to show. Slowness alone is never one: a late answer is an answer. */
export class ChatTurnFailure extends Error {
  constructor(
    readonly reason: Exclude<FallbackReason, 'error'>,
    message: string,
  ) {
    super(message);
    this.name = 'ChatTurnFailure';
  }
}

/** The progress line for a turn whose loop gave up. */
export const FALLBACK_STAGE_LABEL = 'Taking the standard route...';

export interface PathInfo {
  path: 'chat' | 'stage';
  /** Set on the stage run that followed a chat turn's failure. */
  fallback?: FallbackReason;
}

/**
 * Runs a chat turn and, if the loop gives up, the stage pipeline once in its place. It falls back
 * only after the loop has thrown or ended with no answer, never on slowness, so a turn doesn't
 * pay twice for research that succeeded; the stage run starts after the loop has stopped.
 */
export async function runChatWithFallback(
  loop: () => Promise<string>,
  stage: () => Promise<string>,
  hooks: { onStageChange?: (label: string) => void; onPath?: (info: PathInfo) => void } = {},
): Promise<string> {
  hooks.onPath?.({ path: 'chat' });
  try {
    return await loop();
  } catch (e: any) {
    const reason: FallbackReason = e instanceof ChatTurnFailure ? e.reason : 'error';
    console.warn(`[chat] fallback (${reason}): ${String(e?.message ?? e).slice(0, 160)}`);
    hooks.onStageChange?.(FALLBACK_STAGE_LABEL);
    hooks.onPath?.({ path: 'stage', fallback: reason });
    return stage();
  }
}

// ---------------------------------------------------------------------------------------------
// The model, behind an interface so tests can fake it

export interface ChatFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ChatRoundReply {
  /**
   * The round's text, with or without calls. In a round of lookups it is a preamble and is dropped;
   * in a round that only draws views it is the answer so far, and each view sits after it.
   */
  text: string;
  calls: ChatFunctionCall[];
  finishReason?: string;
}

export interface ChatToolResponse {
  name: string;
  response: Record<string, unknown>;
}

export interface ChatConversation {
  /** Sends the next user turn (the prompt, or a round's tool results). `tools: false` sends it with function calling off. */
  send(
    message: string | ChatToolResponse[],
    options: {
      tools: boolean;
      /**
       * With `tools`, the only functions the model may call this round; it may still write instead.
       * Off, any declared function.
       */
      only?: string[];
      onText?: (roundText: string) => void;
    },
  ): Promise<ChatRoundReply>;
}

export interface ChatModel {
  open(args: { systemInstruction: string; history: Content[]; declarations: FunctionDeclaration[]; thinkingLevel?: ThinkingTier }): ChatConversation;
}

/** The chat model through `@google/genai`, streaming each round. */
export const liveChatModel: ChatModel = {
  open({ systemInstruction, history, declarations, thinkingLevel }) {
    const resolved = resolveTaskModelConfig('chatTurn', { thinkingLevel });
    const config = {
      systemInstruction,
      tools: [{ functionDeclarations: declarations }],
      ...samplingFor(resolved.model, resolved.temperature),
      thinkingConfig: { thinkingLevel: THINKING_LEVEL_MAP[resolved.thinkingLevel] },
    };
    const chat = getAi().chats.create({ model: resolved.model, config, history });
    return {
      async send(message, { tools, only, onText }) {
        const parts =
          typeof message === 'string'
            ? [{ text: message }]
            : message.map((r) => ({ functionResponse: { name: r.name, response: r.response } }));
        // Declarations stay so the history's calls still read; function calling is what turns off.
        const stream = await chat.sendMessageStream({
          message: parts,
          ...(!tools
            ? { config: { ...config, toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } } } }
            : only?.length
              ? // The model may call one of these, or write: never any other function.
                { config: { ...config, toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.VALIDATED, allowedFunctionNames: only } } } }
              : {}),
        });
        let text = '';
        let finishReason: string | undefined;
        const calls: ChatFunctionCall[] = [];
        for await (const chunk of stream) {
          // Calls from earlier chunks end the text; text ahead of a call in this chunk is kept.
          const callsBefore = calls.length > 0;
          for (const c of chunk.functionCalls ?? []) calls.push({ name: String(c.name), args: (c.args as Record<string, unknown>) ?? {} });
          const finish = chunk.candidates?.[0]?.finishReason;
          if (finish) finishReason = finish;
          const piece = textBeforeCalls(chunk, callsBefore);
          if (piece) {
            text += piece;
            onText?.(text);
          }
        }
        return { text, calls, finishReason };
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

const CHAT_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
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

/** Every tool the chat loop offers, the writer's and research's together. A Gaffa turn adds `grep_gaffa_market`. */
export const CHAT_DECLARATIONS: FunctionDeclaration[] = [
  GREP_SAVED_DOSSIERS_DECLARATION,
  LOOK_UP_DOSSIER_DECLARATION,
  SHOW_DOSSIER_DECLARATION,
  ...NETWORK_FUNCTION_DECLARATIONS,
  ...CHAT_FUNCTION_DECLARATIONS,
  TEAM_STRENGTH_DECLARATION,
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

/** The tools a turn offers: a club attached adds the market filter, and a turn the cards anchor adds `commit_verdict`. */
export const chatDeclarations = (gaffa: boolean, commit = false): FunctionDeclaration[] => {
  const base = gaffa ? [...CHAT_DECLARATIONS, GREP_GAFFA_MARKET_DECLARATION as FunctionDeclaration] : CHAT_DECLARATIONS;
  return commit ? [...base, COMMIT_VERDICT_DECLARATION] : base;
};

/**
 * Whether questions about the past take the loop. Off, every path behaves as it did before past
 * mode existed: past turns take the debate pipeline, and no present turn gets the card order or
 * `commit_verdict`. Defined beside the settled-verdict store (`debateVerdicts.ts`), whose public
 * route it also gates.
 */
export { PAST_MODE };

/** Tools that draw something in the reply. They are free, and a round that only calls them keeps its text. */
const PRESENTATION = new Set(['show_pitch', 'show_table', 'show_comparison', 'show_ranking', 'show_dossier']);

/**
 * Tools that cost a lookup: the ones that fetch a feed, a record or a search. The local greps
 * (dossiers, the Gaffa market), card reads (up to `MAX_CARD_READS`), the stored team-strength
 * ratings and the presentation tools are free.
 */
const COUNTED = new Set(Object.keys(RESEARCH_FUNCTIONS));

/** The progress line for one tool call. */
export function stageLabel(call: ChatFunctionCall): string {
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
    case 'show_table':
      return `Drawing the ${str(a.league) || 'league'} table`;
    case 'show_comparison':
      return `Comparing ${str(a.playerA) || 'the players'} and ${str(a.playerB) || 'the other'}`;
    case 'show_ranking':
      return `Drawing the ranking${str(a.title) ? `: ${str(a.title).slice(0, 60)}` : ''}`;
    case 'grep_saved_dossiers':
      return 'Searching your dossiers';
    case 'grep_gaffa_market':
      return "Searching your league's market";
    case 'team_strength':
      return `Reading ${str(a.club) || 'the club'}'s team strength`;
    case 'commit_verdict':
      return 'Weighing the verdict';
    default:
      return 'Researching';
  }
}

// ---------------------------------------------------------------------------------------------
// Prompts

/** The loop's part of the system instruction: the budget and how to spend it. Descriptive only. */
export const researchRules = (budget: ResearchBudget): string => `## Research

In this conversation you decide your own research. Your tools read live club data, Premier League player seasons, league tables, past club seasons, player careers, the web, the stored dossier cards and the user's saved dossiers; the show tools draw views in your reply.

Budget for this turn: ${Math.round(budget.ms / 1000)} seconds of research, ${budget.calls} lookups (at most ${budget.searches} of them web searches) and ${budget.rounds} rounds of tool calls. The local dossier search and the show tools are free: drawing views costs no lookup, search or round. Every tool result ends with what's left. When any part of the budget runs out, research is over and your next reply must be the answer.

How to research:
- First work out what the user is trying to decide or do, read from the whole conversation, and what a useful answer has to settle for that; then look up only that.
- When the latest message pushes back on your last reply over a fact that can be checked, or asks why you didn't know something, look that fact up this turn and answer with it. The user's word neither settles it nor is dismissed, and a fact already in the conversation's evidence counts as looked up. Stop researching as soon as you have what the answer needs; a question the conversation or the cards already answer needs no lookup.
- Call independent lookups together in one round: they run in parallel. Follow up only on what a result left open.
- For who plays, results, availability and standings, use the live feeds. Use web search for what the feeds don't cover (tactical analysis, transfers and their dates, news, clubs or players outside the feeds), naming the season. A web search is the slowest and scarcest lookup: don't search for what a feed already gave you.
- A lookup that came back not covered won't work if asked again.
- An answer about the present says what is different this season for the club or player it is about (the people, the coach, the shape, the role or the form) and why. Find that out unless the conversation, a stored snapshot or a result already says it.
- An answer about who is missing or doubtful reads team news as well as the injury list: no free source records knocks between list updates, and news reports them first.
- Each result also lists what is still unchecked for the clubs and players in the question. Spend on those only where the answer needs them.
- ${viewRules()}
- team_strength reads a stored Elo rating that code computed from match results, free of the budget: it says how strong a club's results were on a date or at a season's end, not how good its squad was; ratings start in 2004-05, and one from few counted matches is rough.
- Write nothing to the user while you look things up: text you write in a round that also calls a lookup is discarded. When research is done, write the answer. To place a view inside it, write the part that leads into the view, call the view tool in that same turn, and carry on with the rest after its result; a turn that only draws views keeps its text.

${RESEARCH_COVERAGE_NOTE}`;

/** How the loop builds a team: from the lineups its own lookups returned. */
const CHAT_TEAM_RULES =
  'Build the team from the recent starting XIs and the injury list your club lookups returned, or from <stored_snapshots>, never from the registered squad or memory. Name one player for each role and commit to him; mention another only where the recent XIs show an even split, as the alternative, never as a joint holder of the role or a pair of names in a heading. A player listed as out is unavailable and must not be described as playing; a registered player missing from recent XIs is at most a rotation option, however prominent he once was. Recent signings and positional changes override what you remember of the club. If no lookup gave recent lineups, say which parts of the shape you could not verify rather than filling them from memory.';

const CHAT_FACT_SOURCES =
  'your tool results this turn, <stored_snapshots>, the numbered entries in <factual_foundation>, or existing dossiers';

/** The turn's rule when a Gaffa club is attached: where its facts are and which tools read the rest. */
export const CHAT_GAFFA_RULE =
  "The user's Gaffa club is in <gaffa_club> and the blocks after it: they are the source for its squad, saved lineup, Club Balance, league market and rules. grep_gaffa_market filters the league's free agents, squad, listings and auctions at no cost; get_player_season gives any Premier League player's FPL status, including a player who isn't in the squad.";

/**
 * The loop's `<instructions>`: the answer guidance for the turn's mode with the loop's team rules,
 * the fact, manager and continuity rules, and the Gaffa line. Pinned in `scripts/test-chat-prompt.ts`.
 */
export function chatInstructions(args: {
  route: TurnRoute;
  analyticalMode: string;
  currentSeason: string;
  notes: string;
  gaffa: boolean;
}): string {
  const { route, analyticalMode, currentSeason, notes, gaffa } = args;
  return `<instructions>
1. ${proseModeGuidance(route, analyticalMode, currentSeason, null, CHAT_TEAM_RULES)}${notes}
2. ${presentFactRules(currentSeason, CHAT_FACT_SOURCES)}
3. ${MANAGER_FIDELITY_RULE} A <verified_managers> block in a tool result counts too.
4. ${CONTINUITY_REMINDER}${gaffa ? `\n5. ${CHAT_GAFFA_RULE}` : ''}
</instructions>`;
}

const RESEARCH_OVER =
  'Research is over: the budget is spent. Write the whole answer now from what you have, and say plainly what you could not verify.';

/** The note on a past turn whose budget ran out before it committed: it may still commit, then writes. */
const COMMIT_STILL_OPEN = 'If the answer is a judgment you have not yet recorded with commit_verdict, call it now, before you write; no other tool is available.';

const formatBudget = (left: ResearchBudget): string =>
  `Budget left: ${Math.max(0, Math.round(left.ms / 1000))} s, ${Math.max(0, left.calls)} lookups, ${Math.max(0, left.searches)} web searches, ${Math.max(0, left.rounds)} rounds.`;

/** A stored club snapshot as the loop's first round reads it. */
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

export interface ChatTurnParams {
  message: string;
  route: TurnRoute;
  history: ChatMessage[];
  isEAFCRequest: boolean;
  conversationDossiers: PlayerProfile[];
  savedDossiers: PlayerProfile[];
  lockedDossiersBlock: string;
  savedDossiersBlock: string;
  peerLedgerBlock?: string;
  /** The Gaffa club attached in the app. Never a trade or Gaffa's panel: those take the stage pipeline. */
  gaffaBag?: GaffaContextBag;
  /** What the reply shows besides its prose; a turn run without one keeps its views to itself. */
  composer?: ReplyComposer;
  onStreamChunk?: (accumulatedText: string) => void;
  onStageChange?: (stageLabel: string) => void;
  perf?: (label: string) => void;
  conversationId?: string;
  /** The thread is about the past (`threadIsHistorical`). Read only when past mode is on. */
  historical?: boolean;
  /** Overrides `PAST_MODE` for this turn, for tests and the eval. */
  pastMode?: boolean;
}

export interface ChatTurnDeps {
  model?: ChatModel;
  tools?: ResearchToolset;
  snapshots?: SnapshotSource | null;
  managers?: (clubs: string[]) => Promise<VerifiedClubManager[]>;
  budget?: Partial<ResearchBudget>;
  thinkingLevel?: ThinkingTier;
  now?: () => number;
  /** Called once with what the loop did, for tests and the eval. */
  onStats?: (stats: TurnStats) => void;
  /** The gate feedback round's model, for tests. */
  gateFeedback?: CorrectionModel;
  /** Reads a stored team-strength rating, for tests. Defaults to the app's route. */
  teamStrength?: (args: { club: string; date?: string; season?: string }) => Promise<TeamStrengthResult>;
  /** Reads a Gaffa squad's FPL availability, for tests. */
  gaffaAvailability?: AvailabilityFetcher;
  /** Called with the Gaffa turn the loop built, for tests. */
  onGaffaTurn?: (turn: GaffaTurn) => void;
  /** Past mode: stored era snapshots, the settled-verdict table, and where proposals, departures and card pairs go. */
  eras?: EraSnapshotSource | null;
  verdicts?: VerdictDb | null;
  pastNetwork?: PastNetwork;
  reportDisagreements?: (pairs: CardDisagreement[]) => void;
}

export interface TurnStats {
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
  /** Set only on a turn the cards anchor (past mode, or versions compared): its commitment and what it met. */
  past?: PastStats;
}

/** What a past turn, or a present one comparing carded versions, committed to and met. */
export interface PastStats {
  /** The thread is about the past (false: a present turn comparing carded versions). */
  historical: boolean;
  committed: boolean;
  kind: string | null;
  criterion: string | null;
  /** The committed winner or order, as the model named them. */
  verdict: string[];
  /** How the commitment stood against the cards. */
  cards: string | null;
  /** How it stood against a settled verdict: `agree`, `against` or `none`. */
  settled: 'agree' | 'against' | 'none';
  departed: boolean;
  departedSilently: boolean;
  /** The settled verdicts the first message carried, by status. */
  priors: { current: number; stale: number; contested: number };
  /** For a ranking question: whether a stored ranking for its field was found. */
  rankingPriorFound: boolean | null;
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

export async function runChatTurn(params: ChatTurnParams, deps: ChatTurnDeps = {}): Promise<string> {
  const { message, route, history, perf } = params;
  const researchOver = RESEARCH_OVER;
  const composer = params.composer ?? new ReplyComposer();
  const model = deps.model ?? liveChatModel;
  const now = deps.now ?? Date.now;
  // Past mode (`PAST_MODE`): a question about the past, read with its cards, era snapshots and settled verdicts.
  const pastMode = params.pastMode ?? PAST_MODE;
  const past = pastMode && Boolean(params.historical);
  const budget: ResearchBudget = { ...DEFAULT_RESEARCH_BUDGET, ...(past ? PAST_BUDGET : {}), ...deps.budget };
  const snapshots = deps.snapshots === undefined ? liveClubSnapshots : deps.snapshots;
  const lookUpManagers = deps.managers ?? getVerifiedClubManagers;
  const start = now();
  const { year, month, currentSeason, seasonStartYear } = getCurrentSeasonInfo();

  // The cards in play, as the default path picks them.
  const allCalibrated = mergeAllCalibratedDossiers(params.savedDossiers, params.conversationDossiers);
  const { matchedCards, lockedCards } = cardsForTurn(message, route.targetPlayers, allCalibrated, past);
  const cardsInPlay: PlayerProfile[] = [...lockedCards];
  const tools = deps.tools ?? liveToolset([...lockedCards, ...allCalibrated]);
  const gaps = editionGaps(lockedCards, past, message, matchedCards);
  // The cards anchor a judgment on a past turn, and on a present one comparing two or more carded versions.
  const anchored = pastMode && (past || comparesVersions(lockedCards));

  // A Gaffa club attached in the app: its blocks, as the focus decides, before the first round. A
  // trade never reaches the loop, and no scorecard call is made here whatever the focus says.
  const ongoingThread = buildOngoingThreadBlock(history);
  const gaffaBag = params.gaffaBag?.connected ? params.gaffaBag : undefined;
  let gaffaTurn: GaffaTurn | null = null;
  if (gaffaBag) {
    params.onStageChange?.('Reading your Gaffa club...');
    gaffaTurn = await buildGaffaTurn({ message, history, bag: gaffaBag, cards: allCalibrated, ongoingThread, fetchAvailability: deps.gaffaAvailability, scorecard: false });
    deps.onGaffaTurn?.(gaffaTurn);
    perf?.(`gaffa club (${gaffaTurn.focus})`);
  }
  const gaffaBlock = gaffaTurn?.block ?? '';

  // Free context: each spotted club's stored snapshot and today's coaches, waited for briefly. A
  // question about the Gaffa squad adds the Premier League clubs most of its starters play for.
  const routeClubs = route.targetClubs?.length ? route.targetClubs : extractThreadClubs(message, history);
  const spottedClubs = [...new Set([...routeClubs, ...(gaffaTurn?.squadClubs ?? [])])].slice(0, MAX_CONTEXT_CLUBS);
  const managerJobs: Promise<VerifiedClubManager[]>[] = [];
  const startManagers = (clubs: string[]): Promise<VerifiedClubManager[]> => {
    const job = clubs.filter(Boolean).length ? lookUpManagers(clubs).catch(() => []) : Promise.resolve([]);
    managerJobs.push(job);
    return job;
  };
  // A past turn names past coaches only from its evidence, and today's club snapshots don't bear on it.
  const firstManagers = startManagers(past ? [] : [...spottedClubs, ...lockedCards.map((c) => c.basicInfo.club)]);
  const storedJobs = snapshots && !past ? spottedClubs.map((c) => snapshots.stored(c, noLive).catch(() => null)) : [];
  const analyticalModeEarly = route.analyticalMode ?? '';
  const eras = deps.eras === undefined ? liveEraSnapshots : deps.eras;
  const pastJob: Promise<PastContext | null> = anchored
    ? loadPastContext({
        cards: lockedCards,
        players: past ? route.targetPlayers : [],
        clubs: routeClubs,
        season: route.requestedSeason ?? null,
        message,
        ranking: analyticalModeEarly === 'ranking_or_tierlist',
        tools,
        eras,
        verdicts: deps.verdicts,
        waitMs: CHAT_CONTEXT_WAIT_MS,
      }).catch(() => null)
    : Promise.resolve(null);
  const [storedRaw, managersAtStart, pastContext] = await Promise.all([
    Promise.all(storedJobs.map((j) => within(j, CHAT_CONTEXT_WAIT_MS))),
    within(firstManagers, CHAT_CONTEXT_WAIT_MS),
    pastJob,
  ]);
  const stored = storedRaw.filter((s): s is ClubSnapshot => Boolean(s));
  const storedBlock = formatStoredSnapshots(stored);
  perf?.(`chat context (${stored.length} stored snapshots, ${managersAtStart?.length ?? 0} coaches)`);

  // A follow-up in the same thread starts from what the last turn found.
  const thread = threadStateFor(params.conversationId ?? 'local');
  // Switching clubs mid-conversation starts the follow-up state afresh, as on the stage pipeline.
  const signature = getThreadSignature(history, message) + (gaffaBag ? `|${gaffaBag.club_id}` : '');
  let ledger: EvidenceLedger = emptyLedger();
  if (signature === thread.signature && thread.grounding) {
    ledger = addEvidence(ledger, { kind: 'prior_turn', label: 'Research from the previous turn', content: thread.grounding.slice(0, 1400) });
  }
  // The records fetched before the first round, and the stored era snapshots, are evidence like any
  // lookup: the model reads them and the figure gate counts them. A past turn's records only: on a
  // present turn comparing versions the model reads what it needs.
  if (past) for (const r of pastContext?.records ?? []) if (r.outcome.result) ledger = addEvidence(ledger, r.outcome.result);
  for (const s of pastContext?.snapshots ?? []) ledger = addEvidence(ledger, eraEvidence(s));
  if (pastContext) perf?.(`past context (${past ? pastContext.records.length : 0} records, ${pastContext.snapshots.length} era snapshots, ${pastContext.settled.length} settled verdicts)`);
  const priorFoundation = hasEvidence(ledger) ? `<factual_foundation>\n${formatLedger(ledger)}\n</factual_foundation>` : '';

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
  const anchoredBlocks = anchored ? [formatCardsInPlay(standingsOf(lockedCards)), formatSettledVerdicts(pastContext?.settled ?? [])].filter(Boolean).join('\n') : '';
  const prompt = `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
${gaffaBlock}
${ongoingThread}
${storedBlock}
${priorFoundation}
${formatVerifiedManagersBlock(managersAtStart ?? [])}
${params.peerLedgerBlock ?? ''}
${params.lockedDossiersBlock}
${params.savedDossiersBlock}${anchoredBlocks ? `\n${anchoredBlocks}` : ''}
${
  past
    ? pastInstructions({ notes: `${shownNote}${missingNote}${gapNote}` })
    : chatInstructions({ route, analyticalMode, currentSeason, notes: `${shownNote}${missingNote}${gapNote}`, gaffa: Boolean(gaffaBag) })
}
<task>${message}</task>`;

  const pastNotes = `${past ? `\n\n${PAST_RESEARCH_NOTE}` : ''}${anchored ? `\n\n${CARD_ANCHOR_NOTE}` : ''}`;
  const conversation = model.open({
    systemInstruction: `${buildConversationalScoutInstruction(params.isEAFCRequest)}\n\n${researchRules(budget)}${pastNotes}`,
    history: buildHistoryContents(history, params.conversationDossiers),
    declarations: chatDeclarations(Boolean(gaffaBag), anchored),
    thinkingLevel: deps.thinkingLevel,
  });

  // Budget.
  let calls = 0;
  let searches = 0;
  let rounds = 0;
  const left = (): ResearchBudget => ({
    ms: start + budget.ms - now(),
    calls: budget.calls - calls,
    searches: budget.searches - searches,
    rounds: budget.rounds - rounds,
  });
  const spentOn = (): TurnStats['stop'] | null => {
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
        gaffaBlock,
        ongoingThread,
        message,
        ...cardsInPlay.map(serializeProfileForHistory),
        ...toolResults,
      ].join('\n'),
    grounded: [],
  };
  // The commitment a turn the cards anchor makes before it writes (`commit_verdict`).
  const commitTool = anchored
    ? createCommitTool({
        standings: () => standingsOf([...lockedCards, ...cardsInPlay]),
        ledger: () => ledger,
        settled: pastContext?.settled ?? [],
        message,
        ...(deps.reportDisagreements ? { report: deps.reportDisagreements } : {}),
      })
    : null;
  // A record the model read on a past turn whose era snapshot nobody has built starts one build, for the next person who asks.
  let eraBuilds = 0;
  const startEraBuild = (filed: { call: ResearchCall; outcome: ToolOutcome }[]) => {
    if (!eras) return;
    for (const { call, outcome } of filed) {
      if (eraBuilds >= MAX_ERA_BUILDS || !outcome.result) continue;
      const window = call.tool === 'player_career' ? normalizePeriod(matchStanding(call.subject, standingsOf(lockedCards))?.period ?? '') : null;
      const req =
        call.tool === 'club_season' && call.season
          ? { kind: 'club_season' as const, subject: call.subject, period: call.season, facts: Promise.resolve(outcome) }
          : window
          ? { kind: 'player_window' as const, subject: call.subject, period: window, facts: Promise.resolve(outcome) }
          : null;
      if (!req) continue;
      eraBuilds += 1;
      void eras.stored(req).then((hit) => (hit ? null : eras.get(req))).catch(() => null);
    }
  };
  // A past answer's figures are held to their season, competition and span, and to the figures it committed to.
  if (past) {
    Object.defineProperty(figureCheck, 'options', {
      enumerable: true,
      get: () => {
        const budget = pastFigureBudget(commitTool?.state ?? null);
        return budget ? { scoped: true, budget } : { scoped: true };
      },
    });
  }
  // A past answer names past coaches only from its evidence: today's coach scrub would rewrite them.
  const managerContext = () => ({ verifiedFacts: [formatLedger(ledger)].filter(Boolean), clubManagers: verified, ...(past ? { past: true } : {}) });
  const clean = (text: string) => sanitizeScoutProse(text, managerContext(), cardsInPlay, figureCheck);

  // The reply's prose passes the gates a segment at a time, together, so a view stays where the model
  // called it however much a segment loses.
  // A reply about the Gaffa club then passes the market rule and the roster name lock.
  const finishGaffa = (text: string, log = false) => finishGaffaReply(text, gaffaBag, gaffaTurn, log);
  composer.setGate((segments) => gateSegments(segments, clean).map((t) => finishGaffa(t)));

  // The loop's text always streams from the model, so views and cards sit inside the reply.
  const dossierTools = createDossierTools({ cardsInPlay, localCards: allCalibrated, historical: past, composer, inline: true });
  const dossiersPool = [...params.savedDossiers, ...params.conversationDossiers];
  // The turn's card lookup: your dossiers, then the shared cards. A card it finds joins the cards in play.
  const cardLookup = makeCardLookup({
    pool: [...cardsInPlay, ...allCalibrated],
    preferPrime: (name) => wantsPrimeOf(message, name, past),
    onCard: (card) => {
      if (!cardsInPlay.some((c) => getCardKey(c) === getCardKey(card))) cardsInPlay.push(card);
    },
  });
  const viewTools = createViewTools({
    composer,
    inline: true,
    context: {
      tools,
      ledger: { read: () => ledger, write: (next) => { ledger = next; } },
      stored,
      cards: cardLookup,
      now,
    },
  });

  /**
   * Before a commitment is checked, the versions it names that no card in play matches yet are read
   * through the turn's card lookup, so a ranking the model committed without looking each player up
   * is still held to the cards. The reads cost no lookup: they are the same shared-card reads a view makes.
   */
  const resolveCommitCards = async (args: Record<string, unknown>): Promise<void> => {
    const named = [...(Array.isArray(args.sides) ? args.sides : []), ...(Array.isArray(args.order) ? args.order : []), args.verdict];
    const names = [...new Set(named.filter((n): n is string => typeof n === 'string' && n.trim() !== ''))].slice(0, 15);
    const known = standingsOf([...lockedCards, ...cardsInPlay]);
    const bare = (n: string) => n.replace(/\(.*?\)/g, '').replace(/\b(prime|peak)\b/gi, '').replace(/\s+/g, ' ').trim();
    await Promise.all(names.filter((n) => !matchStanding(n, known)).map((n) => cardLookup.lookUp(bare(n)).catch(() => null)));
  };

  /** The model's view of a lookup's outcome. */
  const describe = (outcome: ToolOutcome): Record<string, unknown> => ({
    status: outcome.status,
    ...(outcome.result ? { source: outcome.result.label, data: outcome.result.content } : {}),
    ...(outcome.result?.sources?.length ? { sources: outcome.result.sources } : {}),
    ...(outcome.missing.length ? { noDataFor: outcome.missing.map((m) => `${m.item} (${m.status.replace('_', ' ')})`) } : {}),
    ...(outcome.note ? { note: outcome.note } : {}),
  });

  /** Runs one round: refuses what the budget can't cover, runs the rest in parallel, files the results. */
  const runRound = async (round: ChatFunctionCall[]): Promise<ChatToolResponse[]> => {
    const jobs = round.map(async (call): Promise<{ response: Record<string, unknown>; filed?: { call: ResearchCall; outcome: ToolOutcome }; evidence?: Omit<EvidenceEntry, 'id'> | null }> => {
      const args = call.args ?? {};
      const research = RESEARCH_FUNCTIONS[call.name];
      if (call.name === 'look_up_dossier' && ++cardReads > MAX_CARD_READS) {
        return { response: { status: 'not_run', reason: `The card-read ceiling (${MAX_CARD_READS} a turn) is reached.` } };
      }
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
            ({ status: 'failed', result: null, missing: [], note: 'too slow: the time budget ran out', slow: true } as ToolOutcome);
          const response = describe(outcome);
          if (coach) {
            const found = (await within(coach, Math.min(timeLeft, 10_000))) ?? [];
            const block = formatVerifiedManagersBlock(found);
            response.verifiedCoach = block || 'No current coach could be verified for this club; name none.';
          }
          return { response, filed: { call: researchCall, outcome } };
        }
        if (viewTools.handles(call.name)) return { response: await viewTools.run(call.name, args) };
        switch (call.name) {
          case 'look_up_dossier': {
            const result = (await dossierTools.lookUp(args as { name?: string; edition?: string })) as Record<string, unknown>;
            return { response: result };
          }
          case 'show_dossier':
            return { response: (await dossierTools.show(args as { name?: string })) as Record<string, unknown> };
          case 'grep_saved_dossiers':
            return { response: grepDossiers(dossiersPool, args as DossierGrepParams) as unknown as Record<string, unknown> };
          case 'grep_gaffa_market':
            if (!gaffaBag) return { response: { error: 'No Gaffa club is attached to this conversation.' } };
            return { response: grepGaffaBag(gaffaBag, args as GaffaMarketGrepParams, dossiersPool) as unknown as Record<string, unknown> };
          case 'team_strength': {
            const read = await within(runTeamStrength(args, deps.teamStrength ?? ((a) => lookUpTeamStrength(a, getLive))), timeLeft);
            return read ?? { response: { status: 'failed', reason: 'too slow: the time budget ran out' } };
          }
          case 'commit_verdict':
            if (!commitTool) return { response: { error: `Unknown tool: ${call.name}` } };
            await resolveCommitCards(args);
            return { response: commitTool.handle(args) };
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
    if (past) startEraBuild(filed);
    for (const d of done) if (d.evidence) ledger = addEvidence(ledger, d.evidence);
    // A card the model read is evidence too.
    round.forEach((call, i) => {
      const card = done[i].response.card;
      if (call.name === 'look_up_dossier' && typeof card === 'string') {
        ledger = addEvidence(ledger, { kind: 'card', label: `${str(call.args?.name)} (stored card)`, content: card });
      }
    });
    return round.map((call, i) => ({ name: call.name, response: done[i].response }));
  };

  // The answer's text so far: what earlier rounds that only drew views wrote. A round of lookups
  // writes a preamble, which is dropped; a round that only draws keeps its text, and its views sit after it.
  let kept = '';
  const answerSoFar = (roundText: string): string => (kept && roundText.trim() ? `${kept}\n\n${roundText}` : kept || roundText);
  // Streaming: a round's text streams once it is clearly the answer, never a preamble to tool calls.
  let streamed = false;
  let firstToken = true;
  const publish = (text: string) => {
    composer.setText(text);
    params.onStreamChunk?.(composer.displayText());
  };
  const onText = (roundText: string, final: boolean) => {
    if (!params.onStreamChunk || (!final && !streamed && roundText.length < STREAM_HOLD_CHARS)) return;
    streamed = true;
    if (firstToken) {
      firstToken = false;
      perf?.('first answer token');
    }
    publish(answerSoFar(roundText));
  };

  /**
   * The round after a past turn's budget ran out, allowing only `commit_verdict`. A model that
   * refuses that mode gets the round again with function calling off, as before, so the turn never
   * fails over it.
   */
  const sendCommitOnly = async (results: ChatToolResponse[]): Promise<ChatRoundReply> => {
    try {
      // Its text may be a preamble to the commit, so it streams only once it is clearly the answer.
      return await conversation.send(results, { tools: true, only: ['commit_verdict'], onText: (t) => onText(t, false) });
    } catch (e: any) {
      console.warn(`[chat] commit-only round refused, writing without it: ${String(e?.message ?? e).slice(0, 120)}`);
      perf?.('commit-only round refused');
      return conversation.send(results, { tools: false, onText: (t) => onText(t, true) });
    }
  };

  const toolCalls: string[] = [];
  let cardReads = 0;
  let stop: TurnStats['stop'] = 'answered';
  let viewRounds = 0;
  let commitRounds = 0;
  params.onStageChange?.('Planning the research...');
  let reply = await conversation.send(prompt, { tools: true, onText: (t) => onText(t, false) });
  while (reply.calls.length > 0) {
    // Drawing is free: a round that only draws costs no round, and keeps its text as part of the answer.
    const drawsOnly = reply.calls.every((c) => PRESENTATION.has(c.name));
    // A model that only draws, forever, runs into the views ceiling and then the round budget.
    // Committing is free too, but its round's text is a preamble like any other.
    const commitsOnly = Boolean(commitTool) && reply.calls.every((c) => c.name === 'commit_verdict' || PRESENTATION.has(c.name)) && !drawsOnly;
    if (drawsOnly && ++viewRounds <= MAX_REPLY_VIEWS) {
      if (reply.text.trim()) kept = answerSoFar(reply.text);
    } else if (!(commitsOnly && ++commitRounds <= MAX_COMMITS)) rounds++;
    // The composer holds exactly the kept text, so a view lands after it and a dropped preamble is gone.
    composer.setText(kept);
    if (drawsOnly && kept && params.onStreamChunk) {
      streamed = true;
      params.onStreamChunk(composer.displayText());
    }
    toolCalls.push(...reply.calls.map((c) => c.name));
    perf?.(`chat round ${rounds}: ${reply.calls.map((c) => c.name).join(', ')}`);
    const responses = await runRound(reply.calls);
    const over = spentOn();
    const budgetLine = formatBudget(left());
    const uncheckedLine = formatUnchecked(
      past
        ? pastUncheckedFor({ cards: lockedCards, clubs: routeClubs, season: route.requestedSeason ?? null }, ledger)
        : uncheckedFor({ clubs: spottedClubs, players: route.targetPlayers }, ledger, stored),
    );
    // A past turn whose budget ran out before it committed may still commit: that round allows
    // `commit_verdict` and nothing else, and the model may write instead.
    const commitOpen = Boolean(over && past && commitTool && !commitTool.state.commitment && commitTool.state.calls < MAX_COMMITS);
    const results = responses.map((r) => ({
      name: r.name,
      response: {
        ...r.response,
        ...(over ? { researchOver: commitOpen ? `${researchOver} ${COMMIT_STILL_OPEN}` : researchOver } : {}),
        unchecked: uncheckedLine,
        budget: budgetLine,
      },
    }));
    for (const r of results) toolResults.push(JSON.stringify(r.response));
    params.onStageChange?.(over ? 'Writing scouting analysis...' : 'Weighing what came back...');
    if (commitOpen) {
      reply = await sendCommitOnly(results);
      const commits = reply.calls.filter((c) => c.name === 'commit_verdict');
      if (commits.length) {
        toolCalls.push(...commits.map((c) => c.name));
        perf?.(`chat round ${rounds}: commit_verdict (after the budget)`);
        const committed = (await runRound(commits)).map((r) => ({ name: r.name, response: { ...r.response, researchOver, budget: formatBudget(left()) } }));
        for (const r of committed) toolResults.push(JSON.stringify(r.response));
        reply = await conversation.send(committed, { tools: false, onText: (t) => onText(t, true) });
      }
    } else {
      reply = await conversation.send(results, { tools: !over, onText: (t) => onText(t, Boolean(over)) });
    }
    if (over) {
      stop = over;
      break;
    }
  }
  // A reply with no text (or calls the model was told it couldn't make) gets one plain request to write,
  // unless views came with their own text.
  if (!reply.text.trim() && !kept.trim()) {
    reply = await conversation.send(researchOver, { tools: false, onText: (t) => onText(t, true) });
  }
  if (!reply.text.trim() && !kept.trim()) {
    const why = blockedOrEmptyResponseError(reply.finishReason).message;
    throw new ChatTurnFailure(stop === 'answered' ? 'empty' : 'budget', stop === 'answered' ? why : `the ${stop} budget was spent and no answer followed: ${why}`);
  }
  const answer = answerSoFar(reply.text);

  verified = await within(managers(), 5_000).then((m) => m ?? verified);
  // A short answer held back while it might have been a preamble streams now.
  if (!streamed) onText(reply.text, true);
  composer.setText(answer);

  // The gates check the reply against the turn's evidence, a segment at a time and together. When they
  // flag something and the budget isn't spent, the model gets one call to fix it first; a round that
  // runs counts as a lookup.
  const finalFigures: FigureCheck = {
    ...figureCheck,
    onRemoved: (removed: FigureClaim[]) => {
      if (removed.length) console.info(`[FigureGate] Removed ${removed.length} figures from a chat reply: ${removed.map((r) => r.text).join('; ')}`);
    },
  };
  const segments = composer.rawProse();
  let finalJoined: string;
  let feedback: GateFeedbackStats | null = null;
  const spent = left();
  if (gateFeedbackEnabled() && spent.calls > 0 && spent.ms > 0) {
    const corrected = await correctReply({
      raw: joinSegments(segments),
      sanitize: (text) => sanitizeScoutProseDetailed(text, managerContext(), cardsInPlay, finalFigures),
      strip: stripScoutMarkup,
      correct: deps.gateFeedback,
      onCorrecting: () => params.onStageChange?.(GATE_FEEDBACK_STAGE_LABEL),
      now,
    });
    if (corrected.called) calls++;
    feedback = corrected.stats;
    finalJoined = corrected.text;
    if (feedback) perf?.(`gate feedback: ${formatGateFeedback(feedback)}`);
  } else {
    finalJoined = sanitizeScoutProse(joinSegments(segments), managerContext(), cardsInPlay, finalFigures);
  }
  const parts = (splitSegments(finalJoined, segments.length) ?? segments.map((seg) => sanitizeScoutProse(seg, managerContext(), cardsInPlay, finalFigures))).map((part) =>
    finishGaffa(part, true),
  );
  composer.settle(parts);
  const finalText = parts.filter((p) => p.trim()).join('\n\n');

  const stats: TurnStats = { rounds, calls, searches, toolCalls, stop, gateFeedback: feedback };
  if (commitTool) {
    const c = commitTool.state;
    const priors = pastContext?.settled ?? [];
    stats.past = {
      historical: past,
      committed: c.commitment !== null,
      kind: c.commitment?.kind ?? null,
      criterion: c.commitment?.criterion ?? null,
      verdict: c.commitment ? (c.commitment.kind === 'ranking' ? c.commitment.order ?? [] : c.commitment.verdict ? [c.commitment.verdict] : []) : [],
      cards: c.check?.cards ?? null,
      settled: c.settled,
      departed: c.departed,
      departedSilently: c.departedSilently,
      priors: {
        current: priors.filter((v) => v.status === 'current').length,
        stale: priors.filter((v) => v.status === 'stale').length,
        contested: priors.filter((v) => v.status === 'contested').length,
      },
      rankingPriorFound: analyticalMode === 'ranking_or_tierlist' ? priors.some((v) => v.kind === 'ranking') : null,
    };
    // The commitment is proposed to the settled-verdict store, and a departure from a current one recorded.
    finishPastTurn(c, standingsOf([...lockedCards, ...cardsInPlay]), ledger, message, deps.pastNetwork ?? liveTurnNetwork);
  }
  deps.onStats?.(stats);
  perf?.(`chat turn: ${rounds} rounds, ${calls} lookups (${searches} searches), stop ${stop}, tools ${toolCalls.join(', ') || 'none'}, gate feedback ${feedback ? formatGateFeedback(feedback) : 'none'}`);

  // A normal follow-up reads this turn's research the way it reads research's.
  const thisTurn = formatLedger({ ...ledger, entries: ledger.entries.filter((e) => e.kind !== 'prior_turn') }, past ? {} : { seasonStart: seasonStartDate(seasonStartYear) });
  if (ledger.entries.some((e) => e.kind !== 'prior_turn')) {
    thread.signature = signature;
    thread.grounding = thisTurn;
  }

  return finalText;
}
