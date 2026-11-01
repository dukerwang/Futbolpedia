import type { PlayerProfile } from '../types';
import { getCurrentSeasonInfo, runGroundedSearch } from './aiClient';
import { formatLeagueTable, type LiveClubResult, type LivePlayerResult, type LiveTableResult } from './liveFootball';
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
export const RESEARCH_TOOL_GUIDE = `- club_recent_team (subject: club name): live data for clubs in the major European leagues and several others: results in all competitions, the starting XI and formation of each of its last four competitive matches with every starter's position and the subs used, and next fixtures. For Premier League clubs it adds every player's starts, minutes, goals and assists this season and the injury and suspension list with return news. The most reliable source for who is actually playing and where.
- player_season (subject: player's full name): Premier League players only: his club, position, starts, minutes, goals, assists, expected goals and assists this season, and injury status. For players elsewhere, use web_search.
- league_table (subject: league name; country when the name is shared): the current table with points and goal difference, for the major European leagues, the Champions and Europa League phases, and several others.
- web_search (subject: the search query): web search with a digest of what the results say, with sources. Use it for tactical analysis, match reports, transfers and their dates, news, and anything the other tools don't cover. Write the query as a researcher would type it, specific and tied to the current season.
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

export { formatLeagueTable };

/** A club lookup reads several matches on a cold cache; the others are one cached feed. */
const CLUB_TIMEOUT_MS = 12_000;

/** A live route's JSON, or null when it failed or ran out of time. */
async function getLive<T>(url: string, timeoutMs = 8_000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** The live toolset: ESPN match data and the FPL feed through the app's server routes, Gemini search, stored cards. */
export const liveToolset = (cardPool: PlayerProfile[]): ResearchToolset => ({
  async clubRecentTeam(club) {
    const data = await getLive<LiveClubResult>(`/api/live/club?${new URLSearchParams({ name: club })}`, CLUB_TIMEOUT_MS);
    if (!data) return { result: null, missing: [] };
    return {
      result: data.found ? { kind: 'club_context', label: `${data.team}: recent matches, starting XIs, availability and fixtures`, content: data.text } : null,
      missing: data.missing ?? [],
    };
  },
  async playerSeason(name) {
    const data = await getLive<LivePlayerResult>(`/api/live/player?${new URLSearchParams({ name })}`);
    return data?.found ? { kind: 'player_record', label: `${data.name} (${data.team})`, content: data.text } : null;
  },
  async leagueTable(league, country) {
    const data = await getLive<LiveTableResult>(`/api/live/table?${new URLSearchParams({ league, ...(country ? { country } : {}) })}`);
    return data?.found ? { kind: 'league_table', label: `${data.league} table${data.season ? `, ${data.season}` : ''}`, content: data.text } : null;
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
  club_recent_team: (c) => `Live match data for ${c.subject} (recent XIs, availability, fixtures)`,
  player_season: (c) => `Season record for ${c.subject} (covered for Premier League players only)`,
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
    // A lookup that says what it couldn't get files that instead of the generic gap.
    next = result ? addEvidence(next, result) : missing.length ? next : addGap(next, GAP_LABELS[calls[i].tool](calls[i]));
    for (const gap of missing) next = addGap(next, gap);
  });
  return next;
}
