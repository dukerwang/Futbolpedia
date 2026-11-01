import type { PlayerProfile } from '../types';
import { getCurrentSeasonInfo, runGroundedSearch } from './aiClient';
import {
  fetchApiFootballPlayer,
  fetchApiFootballTeamContext,
  formatApiFootballFactSheetBlock,
  formatApiFootballTeamContextBlock,
} from './groundingService';
import { lookUpDossier } from './dossierLookup';
import { serializeProfileForHistory } from './dossierContext';
import { addEvidence, addGap, type EvidenceEntry, type EvidenceLedger } from './evidenceLedger';

/**
 * The lookups a chat turn's research can make. The brief picks them; `runCalls` runs a round in
 * parallel and files what each found, or didn't, in the evidence ledger.
 */
export const RESEARCH_TOOLS = ['club_recent_team', 'player_season', 'league_table', 'web_search', 'card'] as const;
export type ResearchToolName = (typeof RESEARCH_TOOLS)[number];

export interface ResearchCall {
  tool: ResearchToolName;
  /** The club, player, league or search query. */
  subject: string;
  /** For a league table: the league's country, when the name is shared. */
  country?: string;
  /** For a card: which version of the player. */
  edition?: 'current' | 'prime';
  /** Why the brief wants it; shown in the turn's progress and kept for the reflect step. */
  purpose?: string;
}

/** How the brief and reflect prompts describe the tools. */
export const RESEARCH_TOOL_GUIDE = `- club_recent_team (subject: club name): the club's starting XIs from its last three matches, how often each player started, its injury list, registered squad, recent results and next fixtures. The most reliable source for who is actually playing.
- player_season (subject: player's full name): his registered club, position, age and this season's appearances, minutes and output by competition.
- league_table (subject: league name; country when the name is shared): the current table with points, goal difference and recent form.
- web_search (subject: the search query): web search with a digest of what the results say, with sources. Use it for tactical analysis, match reports, transfers and their dates, news, and anything the API tools don't cover. Write the query as a researcher would type it, specific and tied to the current season.
- card (subject: player's name; edition: current or prime): Futbolpedia's stored dossier card for the player, with his ratings and attributes.`;

export type ToolResult = Omit<EvidenceEntry, 'id'> | null;

/** The lookups behind each tool. Tests swap in fakes. */
export interface ResearchToolset {
  clubRecentTeam(club: string): Promise<{ result: ToolResult; missing: string[] }>;
  playerSeason(name: string): Promise<ToolResult>;
  leagueTable(league: string, country?: string): Promise<ToolResult>;
  webSearch(query: string): Promise<ToolResult>;
  card(name: string, edition?: 'current' | 'prime'): Promise<ToolResult>;
}

interface StandingsRow {
  rank: number | null;
  team: string | null;
  group: string | null;
  played: number | null;
  won: number | null;
  drawn: number | null;
  lost: number | null;
  goalDiff: number | null;
  points: number | null;
  form: string | null;
}

/** A league table as text: "1. Team — 30 pts, P12 W9 D3 L0, GD +20, form WWDWW". */
export const formatLeagueTable = (rows: StandingsRow[]): string =>
  rows
    .map(
      (r) =>
        `${r.group && rows.some((x) => x.group !== r.group) ? `[${r.group}] ` : ''}${r.rank}. ${r.team} — ${r.points} pts, P${r.played} W${r.won} D${r.drawn} L${r.lost}, GD ${
          (r.goalDiff ?? 0) > 0 ? '+' : ''
        }${r.goalDiff}${r.form ? `, form ${r.form}` : ''}`,
    )
    .join('\n');

/** The live toolset: API-Football through the app's server routes, Gemini search, stored cards. */
export const liveToolset = (cardPool: PlayerProfile[]): ResearchToolset => ({
  async clubRecentTeam(club) {
    const ctx = await fetchApiFootballTeamContext(club).catch(() => null);
    if (!ctx) return { result: null, missing: [] };
    const missing = [
      ...(ctx.recentLineups?.length ? [] : [`Recent lineups for ${ctx.team} (API-Football returned none)`]),
      ...(ctx.unavailable ? [] : [`Injury list for ${ctx.team} (API-Football returned none)`]),
    ];
    return {
      result: { kind: 'club_context', label: `${ctx.team}: recent team, injuries, squad and fixtures`, content: formatApiFootballTeamContextBlock(ctx) },
      missing,
    };
  },
  async playerSeason(name) {
    const player = await fetchApiFootballPlayer(name).catch(() => null);
    return player ? { kind: 'player_record', label: name, content: formatApiFootballFactSheetBlock(player) } : null;
  },
  async leagueTable(league, country) {
    try {
      const params = new URLSearchParams({ league, ...(country ? { country } : {}) });
      const res = await fetch(`/api/football/standings?${params}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.available || !Array.isArray(data.table)) return null;
      return {
        kind: 'league_table',
        label: `${data.league}${data.country ? ` (${data.country})` : ''} table, ${data.season}`,
        content: formatLeagueTable(data.table),
      };
    } catch {
      return null;
    }
  },
  async webSearch(query) {
    const { month, year } = getCurrentSeasonInfo();
    const dated = query.includes(String(year)) ? query : `[Date: ${month} ${year}] ${query}`;
    const result = await runGroundedSearch(dated, { digest: 'evidence' });
    return result.text ? { kind: 'web', label: query, content: result.text, sources: result.sources } : null;
  },
  async card(name, edition) {
    const found = await lookUpDossier(name, cardPool, edition === 'prime').catch(() => null);
    return found?.status === 'found'
      ? { kind: 'card', label: `${found.card.basicInfo.name} (stored card)`, content: serializeProfileForHistory(found.card) }
      : null;
  },
});

/** Turns a model's list of calls into valid ones: known tools, a subject, no repeats, at most `limit`. */
export function sanitizeCalls(raw: unknown, limit: number, already: ResearchCall[] = []): ResearchCall[] {
  if (!Array.isArray(raw)) return [];
  const key = (c: { tool: string; subject: string }) => `${c.tool}:${c.subject.trim().toLowerCase()}`;
  const seen = new Set(already.map(key));
  const calls: ResearchCall[] = [];
  for (const item of raw) {
    const tool = item?.tool;
    const subject = typeof item?.subject === 'string' ? item.subject.trim() : '';
    if (!RESEARCH_TOOLS.includes(tool) || subject.length < 2) continue;
    if (seen.has(key({ tool, subject }))) continue;
    seen.add(key({ tool, subject }));
    calls.push({
      tool,
      subject,
      ...(typeof item.country === 'string' && item.country.trim() ? { country: item.country.trim() } : {}),
      ...(item.edition === 'current' || item.edition === 'prime' ? { edition: item.edition } : {}),
      ...(typeof item.purpose === 'string' && item.purpose.trim() ? { purpose: item.purpose.trim() } : {}),
    });
    if (calls.length >= limit) break;
  }
  return calls;
}

const GAP_LABELS: Record<ResearchToolName, (c: ResearchCall) => string> = {
  club_recent_team: (c) => `API-Football record for ${c.subject} (recent lineups, injuries, squad)`,
  player_season: (c) => `API-Football record for ${c.subject}`,
  league_table: (c) => `League table for ${c.subject}`,
  web_search: (c) => `Web search: ${c.subject}`,
  card: (c) => `Stored card for ${c.subject}`,
};

/** Runs one round of calls in parallel and files the results; each call's time goes to the console. */
export async function runCalls(
  calls: ResearchCall[],
  tools: ResearchToolset,
  ledger: EvidenceLedger,
): Promise<EvidenceLedger> {
  const run = async (call: ResearchCall): Promise<{ result: ToolResult; missing: string[] }> => {
    const start = Date.now();
    let outcome: { result: ToolResult; missing: string[] } = { result: null, missing: [] };
    try {
      switch (call.tool) {
        case 'club_recent_team':
          outcome = await tools.clubRecentTeam(call.subject);
          break;
        case 'player_season':
          outcome = { result: await tools.playerSeason(call.subject), missing: [] };
          break;
        case 'league_table':
          outcome = { result: await tools.leagueTable(call.subject, call.country), missing: [] };
          break;
        case 'web_search':
          outcome = { result: await tools.webSearch(call.subject), missing: [] };
          break;
        case 'card':
          outcome = { result: await tools.card(call.subject, call.edition), missing: [] };
          break;
      }
    } catch (e) {
      console.warn(`[Research] ${call.tool} "${call.subject}" failed:`, e);
    }
    console.log(`[Perf] lookup ${call.tool} "${call.subject}": ${Date.now() - start}ms${outcome.result ? '' : ' (nothing found)'}`);
    return outcome;
  };

  const outcomes = await Promise.all(calls.map(run));
  let next = ledger;
  outcomes.forEach(({ result, missing }, i) => {
    next = result ? addEvidence(next, result) : addGap(next, GAP_LABELS[calls[i].tool](calls[i]));
    for (const gap of missing) next = addGap(next, gap);
  });
  return next;
}
