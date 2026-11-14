import axios from 'axios';
import type { ChatMessage, Conversation, GaffaClubContextResponse, GaffaContextBag, GaffaTradeScorecard, PlayerProfile } from '../types';
import { isUuid, mapResponseToBag } from './gaffaContext';
import { cardLinkFor, type CardLink } from './cardLinks';
import { createTurnBudget, GAFFA_CHAT_DAILY_TURNS, type TurnBudget } from './gaffaTurnBudget';

/**
 * Gaffa's in-app Futbolpedia panel, on Futbolpedia's server. Gaffa's server checks the manager's
 * session and that the club is theirs, then calls `/api/gaffa/chat` with the read secret. The turn
 * runs the same pipeline as Futbolpedia's own chat (`sendMessageToAI`) with the club attached,
 * streamed back as events, inside a daily turn budget per manager.
 */

const MAX_MESSAGE = 4000;
const MAX_HISTORY = 20;
const MAX_SHARE_TURNS = 40;

export interface GaffaChatHistoryTurn {
  sender: 'user' | 'ai';
  content: string;
}

export interface GaffaChatTurnInput {
  message: unknown;
  history?: unknown;
  leagueId?: unknown;
  clubId?: unknown;
  /** The Gaffa manager, for the turn budget; the club stands in when it's missing. */
  userId?: unknown;
  /** Gaffa's conversation, so follow-ups keep their own research. */
  conversationId?: unknown;
}

export interface GaffaChatTurnResult {
  prose: string;
  scorecard: GaffaTradeScorecard | null;
  cards: CardLink[];
  club: { league_name?: string; club_name?: string; connected: boolean };
  /** Turns the manager has left today in Gaffa's panel. */
  turnsLeft: number;
  /** The question needs more than the panel gives (a rating); Gaffa shows Continue in Futbolpedia. */
  continueSuggested: boolean;
}

export type GaffaChatEvent =
  | { type: 'stage'; label: string }
  | { type: 'text'; text: string }
  | { type: 'scorecard'; scorecard: GaffaTradeScorecard }
  | ({ type: 'done' } & GaffaChatTurnResult)
  | { type: 'error'; message: string; status: number; turnsLeft?: number };

/** An Error carrying the HTTP status server.ts should answer with. */
export function httpError(message: string, status: number, extra: Record<string, unknown> = {}): Error & { status: number } {
  return Object.assign(new Error(message), { status, ...extra });
}

export function authorizeGaffaReadSecret(header: string | string[] | undefined): boolean {
  const expected = process.env.FUTBOLPEDIA_READ_SECRET;
  if (!expected || !expected.trim()) return false;
  const got = Array.isArray(header) ? header[0] : header;
  return !!got && got === expected;
}

export async function fetchClubContextWithSecret(
  leagueId: string,
  clubId: string,
): Promise<GaffaClubContextResponse | null> {
  const base = (process.env.GAFFA_BASE_URL || 'https://www.gaffa.live').replace(/\/$/, '');
  const secret = process.env.FUTBOLPEDIA_READ_SECRET;
  if (!secret) throw httpError('Gaffa connect is not configured', 503);

  const url = `${base}/api/integrations/futbolpedia/context?leagueId=${encodeURIComponent(leagueId)}&teamId=${encodeURIComponent(clubId)}`;
  const upstream = await axios.get(url, {
    headers: { 'x-futbolpedia-secret': secret },
    validateStatus: () => true,
    timeout: 30000,
  });
  if (upstream.status === 401) throw httpError('Gaffa rejected the read secret', 401);
  if (upstream.status === 404) return null;
  if (upstream.status >= 400) throw httpError(upstream.data?.error || `Gaffa error (${upstream.status})`, 502);
  return upstream.data as GaffaClubContextResponse;
}

export function toHistory(turns: unknown): ChatMessage[] {
  const list = Array.isArray(turns) ? (turns as GaffaChatHistoryTurn[]) : [];
  return list
    .filter((t) => (t?.sender === 'user' || t?.sender === 'ai') && typeof t.content === 'string' && t.content.trim())
    .slice(-MAX_HISTORY)
    .map((t, i) => ({ id: `hist-${i}`, sender: t.sender, content: t.content.trim(), timestamp: i }));
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export interface GaffaChatDeps {
  budget: TurnBudget;
  fetchContext: (leagueId: string, clubId: string) => Promise<GaffaClubContextResponse | null>;
  /** The pipeline; injected in tests. */
  send?: typeof import('./geminiService').sendMessageToAI;
}

const defaultBudget = createTurnBudget();

/**
 * One turn of Gaffa's panel. `emit` gets each event as it happens; the result is the `done` event.
 * Throws an Error with `status` for a refused turn (bad input, budget used up, Gaffa failing).
 */
export async function runGaffaChatTurn(
  input: GaffaChatTurnInput,
  emit: (event: GaffaChatEvent) => void = () => {},
  deps: GaffaChatDeps = { budget: defaultBudget, fetchContext: fetchClubContextWithSecret },
): Promise<GaffaChatTurnResult> {
  if (!process.env.API_KEY && process.env.GEMINI_API_KEY) process.env.API_KEY = process.env.GEMINI_API_KEY;
  if (!process.env.API_KEY) throw httpError('Gemini is not configured', 503);

  const message = str(input.message);
  if (!message) throw httpError('Missing message', 400);
  if (message.length > MAX_MESSAGE) throw httpError('Message is too long', 400);
  const leagueId = str(input.leagueId);
  const clubId = str(input.clubId);
  if (!isUuid(leagueId) || !isUuid(clubId)) throw httpError('Invalid leagueId or clubId', 400);
  const userId = str(input.userId).slice(0, 64);
  const conversationId = str(input.conversationId).slice(0, 64) || 'default';

  const who = userId ? `user:${userId}` : `club:${clubId}`;
  const spent = deps.budget.take(who);
  if (!spent.ok) {
    throw httpError(
      `You've used today's ${GAFFA_CHAT_DAILY_TURNS} Futbolpedia questions in Gaffa. Continue in Futbolpedia to keep going.`,
      429,
      { turnsLeft: 0 },
    );
  }

  const started = Date.now();
  try {
    const res = await deps.fetchContext(leagueId, clubId);
    if (!res) throw httpError('League or club not found', 404);
    const bag: GaffaContextBag = mapResponseToBag(res);

    let scorecard: GaffaTradeScorecard | null = null;
    let routeIntent = '';
    let shown: PlayerProfile[] = [];
    const send = deps.send ?? (await import('./geminiService')).sendMessageToAI;
    const reply = await send(message, toHistory(input.history), undefined, [], [], {
      gaffaBag: bag,
      conversationId: `gaffa:${who}:${conversationId}`,
      noRating: true,
      onRoute: (route) => {
        routeIntent = route.intent;
      },
      onStageChange: (label) => emit({ type: 'stage', label }),
      onStreamChunk: (text) => emit({ type: 'text', text }),
      onGaffaScorecard: (card) => {
        scorecard = card;
        emit({ type: 'scorecard', scorecard: card });
      },
      onAttachments: (a) => {
        shown = a.cards;
      },
    });
    const prose = typeof reply === 'string' ? reply : '';
    if (!prose.trim()) throw httpError('Futbolpedia returned an empty reply', 502);

    const result: GaffaChatTurnResult = {
      prose,
      scorecard,
      cards: shown.map(cardLinkFor).filter((c): c is CardLink => Boolean(c)),
      club: { connected: bag.connected, league_name: bag.league_name, club_name: bag.club_name },
      turnsLeft: spent.left,
      continueSuggested: routeIntent === 'single_dossier',
    };
    console.log(
      `[gaffa] turn ${who} (${conversationId}): ${routeIntent || 'chat'}, ${prose.length} chars, ${spent.left} left (${Date.now() - started}ms)`,
    );
    return result;
  } catch (err) {
    // A turn that never answered doesn't count against the day.
    deps.budget.refund(who);
    throw err;
  }
}

/**
 * Continue in Futbolpedia: the Gaffa thread as a shared conversation (anyone with the code can
 * open it) with the club attached, which Futbolpedia keeps only for the manager who runs it.
 */
export async function shareGaffaThread(
  input: { history?: unknown; leagueId?: unknown; clubId?: unknown; title?: unknown },
  share: (conv: Conversation) => Promise<string>,
): Promise<{ code: string; path: string }> {
  const leagueId = str(input.leagueId);
  const clubId = str(input.clubId);
  if (!isUuid(leagueId) || !isUuid(clubId)) throw httpError('Invalid leagueId or clubId', 400);
  const list = Array.isArray(input.history) ? (input.history as GaffaChatHistoryTurn[]) : [];
  const turns = list
    .filter((t) => (t?.sender === 'user' || t?.sender === 'ai') && typeof t.content === 'string' && t.content.trim())
    .slice(-MAX_SHARE_TURNS);
  if (turns.length === 0) throw httpError('Nothing to continue', 400);
  const now = Date.now();
  const firstQuestion = turns.find((t) => t.sender === 'user')?.content.trim() ?? '';
  const title = str(input.title) || (firstQuestion ? firstQuestion.slice(0, 60) : 'From Gaffa');
  const conv: Conversation = {
    id: `gaffa-${now.toString(36)}`,
    title,
    messages: turns.map((t, i) => ({
      id: `g${i}`,
      sender: t.sender,
      content: t.content.trim().slice(0, MAX_MESSAGE * 2),
      timestamp: now - (turns.length - i) * 1000,
    })),
    createdAt: now,
    activeProfile: null,
    allProfiles: [],
    gaffaClub: { leagueId, clubId },
  };
  const code = await share(conv);
  return { code, path: `/#/c/${code}` };
}
