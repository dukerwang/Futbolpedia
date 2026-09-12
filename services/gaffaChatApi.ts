import axios from 'axios';
import type { ChatMessage, GaffaClubContextResponse, GaffaTradeScorecard } from '../types';
import { emptyGaffaContextBag } from '../constants/gaffaRules';
import { mapResponseToBag } from './gaffaContext';
import { sendGaffaMessage } from './gaffaChatService';
import { resetChat } from './geminiService';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_MESSAGE = 4000;
const MAX_HISTORY = 20;

export type GaffaChatHistoryTurn = {
  sender: 'user' | 'ai';
  content: string;
};

export type GaffaChatTurnInput = {
  message: string;
  history?: GaffaChatHistoryTurn[];
  leagueId?: string;
  clubId?: string;
  speed?: 'default' | 'fast';
};

export type GaffaChatTurnResult = {
  prose: string;
  scorecard: GaffaTradeScorecard | null;
  club: { league_name?: string; club_name?: string; connected: boolean };
};

export function isUuid(value: string): boolean {
  return UUID.test(value);
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
    throw Object.assign(new Error('Gaffa connect is not configured'), { status: 503 });
  }

  const url = `${base}/api/integrations/futbolpedia/context?leagueId=${encodeURIComponent(leagueId)}&teamId=${encodeURIComponent(clubId)}`;
  const upstream = await axios.get(url, {
    headers: { 'x-futbolpedia-secret': secret },
    validateStatus: () => true,
    timeout: 20000,
  });
  if (upstream.status === 401) {
    throw Object.assign(new Error('Gaffa rejected the read secret'), { status: 401 });
  }
  if (upstream.status === 404) {
    return null;
  }
  if (upstream.status >= 400) {
    throw Object.assign(new Error(upstream.data?.error || `Gaffa error (${upstream.status})`), {
      status: 502,
    });
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
 * Prose only — never a dossier profile.
 */
export async function runGaffaChatTurn(input: GaffaChatTurnInput): Promise<GaffaChatTurnResult> {
  if (!process.env.API_KEY && process.env.GEMINI_API_KEY) {
    process.env.API_KEY = process.env.GEMINI_API_KEY;
  }
  if (!process.env.API_KEY) {
    throw Object.assign(new Error('Gemini is not configured'), { status: 503 });
  }

  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) {
    throw Object.assign(new Error('Missing message'), { status: 400 });
  }
  if (message.length > MAX_MESSAGE) {
    throw Object.assign(new Error('Message is too long'), { status: 400 });
  }

  const leagueId = typeof input.leagueId === 'string' ? input.leagueId.trim() : '';
  const clubId = typeof input.clubId === 'string' ? input.clubId.trim() : '';
  if ((leagueId && !isUuid(leagueId)) || (clubId && !isUuid(clubId))) {
    throw Object.assign(new Error('Invalid leagueId or clubId'), { status: 400 });
  }

  let bag = emptyGaffaContextBag();
  if (leagueId && clubId) {
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
