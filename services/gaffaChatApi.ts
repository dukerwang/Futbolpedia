import axios from 'axios';
import type { ChatMessage, GaffaClubContextResponse, GaffaTradeScorecard } from '../types';
import { emptyGaffaContextBag } from '../constants/gaffaRules';
import { isUuid, mapResponseToBag } from './gaffaContext';
import { sendGaffaMessage } from './gaffaChatService';
import { resetChat } from './geminiService';

const MAX_MESSAGE = 4000;
const MAX_HISTORY = 20;

type GaffaChatHistoryTurn = {
  sender: 'user' | 'ai';
  content: string;
};

type GaffaChatTurnInput = {
  message: string;
  history?: GaffaChatHistoryTurn[];
  leagueId?: string;
  clubId?: string;
  speed?: 'default' | 'fast';
};

type GaffaChatTurnResult = {
  prose: string;
  scorecard: GaffaTradeScorecard | null;
  club: { league_name?: string; club_name?: string; connected: boolean };
};

/** An Error carrying the HTTP status server.ts should answer with. */
function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function authorizeGaffaReadSecret(header: string | string[] | undefined): boolean {
  const expected = process.env.FUTBOLPEDIA_READ_SECRET;
  if (!expected || !expected.trim()) return false;
  const got = Array.isArray(header) ? header[0] : header;
  return !!got && got === expected;
}

async function fetchClubContext(
  leagueId: string,
  clubId: string,
): Promise<GaffaClubContextResponse | null> {
  const base = (process.env.GAFFA_BASE_URL || '').replace(/\/$/, '');
  const secret = process.env.FUTBOLPEDIA_READ_SECRET;
  if (!base || !secret) {
    throw httpError('Gaffa connect is not configured', 503);
  }

  const url = `${base}/api/integrations/futbolpedia/context?leagueId=${encodeURIComponent(leagueId)}&teamId=${encodeURIComponent(clubId)}`;
  const upstream = await axios.get(url, {
    headers: { 'x-futbolpedia-secret': secret },
    validateStatus: () => true,
    timeout: 30000,
  });
  if (upstream.status === 401) {
    throw httpError('Gaffa rejected the read secret', 401);
  }
  if (upstream.status === 404) {
    return null;
  }
  if (upstream.status >= 400) {
    throw httpError(upstream.data?.error || `Gaffa error (${upstream.status})`, 502);
  }
  return upstream.data as GaffaClubContextResponse;
}

function toHistory(turns: GaffaChatHistoryTurn[] | undefined): ChatMessage[] {
  const slice = (turns ?? [])
    .filter(
      (t) =>
        (t.sender === 'user' || t.sender === 'ai') &&
        typeof t.content === 'string' &&
        t.content.trim(),
    )
    .slice(-MAX_HISTORY);
  return slice.map((t, i) => ({
    id: `hist-${i}`,
    sender: t.sender,
    content: t.content.trim(),
  }));
}

/**
 * Server entry for Gaffa-mode chat (in-app Gaffa, or any secret-bearing caller).
 * Fetches the live context bag (even on first turn / empty history) then
 * assembles the Gaffa-mode prompt — prose only, never a dossier profile.
 */
export async function runGaffaChatTurn(input: GaffaChatTurnInput): Promise<GaffaChatTurnResult> {
  if (!process.env.API_KEY && process.env.GEMINI_API_KEY) {
    process.env.API_KEY = process.env.GEMINI_API_KEY;
  }
  if (!process.env.API_KEY) {
    throw httpError('Gemini is not configured', 503);
  }

  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) {
    throw httpError('Missing message', 400);
  }
  if (message.length > MAX_MESSAGE) {
    throw httpError('Message is too long', 400);
  }

  const leagueId = typeof input.leagueId === 'string' ? input.leagueId.trim() : '';
  const clubId = typeof input.clubId === 'string' ? input.clubId.trim() : '';
  if ((leagueId && !isUuid(leagueId)) || (clubId && !isUuid(clubId))) {
    throw httpError('Invalid leagueId or clubId', 400);
  }

  const connectAttempted = Boolean(leagueId && clubId);
  let bag = emptyGaffaContextBag();
  if (connectAttempted) {
    try {
      const res = await fetchClubContext(leagueId, clubId);
      if (res) bag = mapResponseToBag(res);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status && status !== 502) throw err;
      console.warn('[gaffa/chat] context fetch failed; answering disconnected', err);
    }
  }

  resetChat();
  const { prose, scorecard } = await sendGaffaMessage(message, toHistory(input.history), {
    speed: input.speed === 'fast' ? 'fast' : 'default',
    contextBag: bag,
    connectAttempted,
  });

  return {
    prose,
    scorecard,
    club: {
      connected: !!bag.connected,
      league_name: bag.league_name,
      club_name: bag.club_name,
    },
  };
}
