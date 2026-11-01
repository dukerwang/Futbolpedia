import type { PlayerProfile } from '../types';
import { getCurrentSeasonInfo, runGroundedSearch } from './aiClient';
import {
  formatLeagueTable,
  type LiveClubResult,
  type LiveMissing,
  type LivePlayerResult,
  type LiveStatus,
  type LiveTableResult,
} from './liveFootball';
import { lookUpDossier } from './dossierLookup';
import { serializeProfileForHistory } from './dossierContext';
import {
  addEvidence,
  addGap,
  logLookup,
  type EvidenceEntry,
  type EvidenceLedger,
  type LookupStatus,
  type ResearchStage,
} from './evidenceLedger';

/**
 * The lookups a chat turn's research can make. The brief picks them; `runCalls` runs a round in
 * parallel and files what each found, or didn't, in the evidence ledger, with each lookup's status.
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
  /** Facts run first; analysis searches run once the live facts are in, and are read against them. */
  stage?: ResearchStage;
}

/** How the brief and reflect prompts describe the tools. */
export const RESEARCH_TOOL_GUIDE = `- club_recent_team (subject: club name): live data for clubs in the major European leagues and several others: results in all competitions, the starting XI and formation of each of its last four competitive matches with every starter's position and the subs used, and next fixtures. For Premier League clubs it adds every player's starts, minutes, goals and assists this season and the injury and suspension list with return news. The most reliable source for who is actually playing and where.
- player_season (subject: player's full name): Premier League players only: his club, position, starts, minutes, goals, assists, expected goals and assists this season, and injury status. For players elsewhere, use web_search.
- league_table (subject: league name; country when the name is shared): the current table with points and goal difference, for the major European leagues, the Champions and Europa League phases, and several others.
- web_search (subject: the search query): web search with a digest of what the results say, each point dated by its source's publication date, with sources. Use it for tactical analysis, match reports, transfers and their dates, news, and anything the other tools don't cover. Write the query as a researcher would type it, specific and tied to the current season.
- card (subject: player's name; edition: current or prime): Futbolpedia's stored dossier card for the player, with his ratings and attributes.`;

/**
 * What no tool covers, so the planner works around it instead of asking again. Kept descriptive:
 * it names the sources' limits, not particular clubs or players.
 */
export const RESEARCH_COVERAGE_NOTE = `What the sources cover, and how to work around what they don't:
- Injury and suspension lists exist only for Premier League clubs. For any other club, search for its latest team news and recent match reports, which name who was missing and why.
- Player season records cover Premier League players only. For anyone else, read his club's live data (it shows whether he started and where) and search for his recent matches and role.
- Live club data covers the leagues listed above. For a club outside them, search for its recent results, lineups and news.
- Web search covers anything, but its sources can be from earlier seasons: ask for this season by name, and check the dates on what comes back.
- A lookup that came back not covered won't work if asked again; one that failed might.`;

export type ToolResult = Omit<EvidenceEntry, 'id'> | null;

/** What one lookup produced: its entry (or none), how it ended, and the parts it had no data for. */
export interface ToolOutcome {
  status: LookupStatus;
  result: ToolResult;
  missing: LiveMissing[];
  /** Why there's no result, in a few words. */
  note?: string;
}

/** The lookups behind each tool. Tests swap in fakes. */
export interface ResearchToolset {
  clubRecentTeam(club: string): Promise<ToolOutcome>;
  playerSeason(name: string): Promise<ToolOutcome>;
  leagueTable(league: string, country?: string): Promise<ToolOutcome>;
  /** `context` is the current facts an analysis search reads its sources against. */
  webSearch(query: string, options?: { context?: string }): Promise<ToolOutcome>;
  card(name: string, edition?: 'current' | 'prime'): Promise<ToolOutcome>;
}

export { formatLeagueTable };

/** A club lookup reads several matches on a cold cache; the others are one cached feed. */
const CLUB_TIMEOUT_MS = 12_000;

/** A live route's JSON, or why there's none: HTTP refusals and timeouts both count as failed. */
async function getLive<T>(url: string, timeoutMs = 8_000): Promise<{ data: T } | { error: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { error: res.status === 429 || res.status === 403 ? `refused (HTTP ${res.status})` : `HTTP ${res.status}` };
    return { data: (await res.json()) as T };
  } catch (e: any) {
    return { error: e?.name === 'TimeoutError' ? 'timed out' : 'unreachable' };
  }
}

const found = (result: NonNullable<ToolResult>, missing: LiveMissing[] = []): ToolOutcome => ({ status: 'found', result, missing });
const none = (status: LiveStatus | 'empty', note?: string, missing: LiveMissing[] = []): ToolOutcome => ({
  status,
  result: null,
  missing,
  ...(note ? { note } : {}),
});

/** The live toolset: ESPN match data and the FPL feed through the app's server routes, Gemini search, stored cards. */
export const liveToolset = (cardPool: PlayerProfile[]): ResearchToolset => ({
  async clubRecentTeam(club) {
    const res = await getLive<LiveClubResult>(`/api/live/club?${new URLSearchParams({ name: club })}`, CLUB_TIMEOUT_MS);
    if ('error' in res) return none('failed', res.error);
    const data = res.data;
    if (!('report' in data) || !data.found) return none(('status' in data && data.status) || 'empty', undefined, data.missing ?? []);
    return found(
      { kind: 'club_context', label: `${data.team}: recent matches, starting XIs, availability and fixtures`, content: data.text, stage: 'facts', club: data.report },
      data.missing ?? [],
    );
  },
  async playerSeason(name) {
    const res = await getLive<LivePlayerResult>(`/api/live/player?${new URLSearchParams({ name })}`);
    if ('error' in res) return none('failed', res.error);
    const data = res.data;
    return 'reason' in data
      ? none(data.status ?? 'empty', data.reason)
      : found({ kind: 'player_record', label: `${data.name} (${data.team})`, content: data.text, stage: 'facts', team: data.team });
  },
  async leagueTable(league, country) {
    const res = await getLive<LiveTableResult>(`/api/live/table?${new URLSearchParams({ league, ...(country ? { country } : {}) })}`);
    if ('error' in res) return none('failed', res.error);
    const data = res.data;
    return 'reason' in data
      ? none(data.status ?? 'empty', data.reason)
      : found({ kind: 'league_table', label: `${data.league} table${data.season ? `, ${data.season}` : ''}`, content: data.text, stage: 'facts' });
  },
  async webSearch(query, options) {
    const { month, year } = getCurrentSeasonInfo();
    const dated = query.includes(String(year)) ? query : `[Date: ${month} ${year}] ${query}`;
    const result = await runGroundedSearch(dated, { digest: 'evidence', context: options?.context });
    if (result.error) return none('failed', result.error);
    return result.text ? found({ kind: 'web', label: query, content: result.text, sources: result.sources }) : none('empty');
  },
  async card(name, edition) {
    const hit = await lookUpDossier(name, cardPool, edition === 'prime').catch(() => null);
    return hit?.status === 'found'
      ? found({ kind: 'card', label: `${hit.card.basicInfo.name} (stored card)`, content: serializeProfileForHistory(hit.card) })
      : none('empty', 'no stored card');
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
      // Only a web search can be analysis; every live feed is a fact.
      ...(tool === 'web_search' && item.stage === 'analysis' ? { stage: 'analysis' as const } : {}),
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

/** Runs one lookup, never throwing: an exception is a failed lookup. Its time goes to the console. */
export async function executeCall(call: ResearchCall, tools: ResearchToolset, context?: string): Promise<ToolOutcome> {
  const start = Date.now();
  let outcome: ToolOutcome;
  try {
    switch (call.tool) {
      case 'club_recent_team':
        outcome = await tools.clubRecentTeam(call.subject);
        break;
      case 'player_season':
        outcome = await tools.playerSeason(call.subject);
        break;
      case 'league_table':
        outcome = await tools.leagueTable(call.subject, call.country);
        break;
      case 'web_search':
        outcome = await tools.webSearch(call.subject, context ? { context } : undefined);
        break;
      case 'card':
        outcome = await tools.card(call.subject, call.edition);
        break;
    }
  } catch (e) {
    console.warn(`[Research] ${call.tool} "${call.subject}" failed:`, e);
    outcome = none('failed', 'error');
  }
  if (outcome.result && call.stage) outcome = { ...outcome, result: { ...outcome.result, stage: call.stage } };
  console.log(`[Perf] lookup ${call.tool} "${call.subject}": ${Date.now() - start}ms (${outcome.status}${outcome.note ? `: ${outcome.note}` : ''})`);
  return outcome;
}

/** Files finished lookups in the ledger, in call order: entries, gaps with their status, and the lookup log. */
export function fileOutcomes(ledger: EvidenceLedger, calls: ResearchCall[], outcomes: ToolOutcome[]): EvidenceLedger {
  let next = ledger;
  outcomes.forEach((o, i) => {
    const call = calls[i];
    // A lookup that says what it couldn't get files that instead of the generic gap.
    if (o.result) next = addEvidence(next, o.result);
    else if (o.missing.length === 0) next = addGap(next, `${GAP_LABELS[call.tool](call)}${o.note ? `: ${o.note}` : ''}`, o.status === 'found' ? 'empty' : o.status);
    for (const m of o.missing) next = addGap(next, m.item, m.status);
    next = logLookup(next, {
      tool: call.tool,
      subject: call.subject,
      status: o.status,
      ...(o.missing.length ? { note: `no data for ${o.missing.map((m) => `${m.item} [${m.status.replace('_', ' ')}]`).join(', ')}` } : o.note ? { note: o.note } : {}),
    });
  });
  return next;
}

/** Runs one round of calls in parallel and files the results. */
export async function runCalls(calls: ResearchCall[], tools: ResearchToolset, ledger: EvidenceLedger): Promise<EvidenceLedger> {
  const outcomes = await Promise.all(calls.map((c) => executeCall(c, tools)));
  return fileOutcomes(ledger, calls, outcomes);
}
