import { ThinkingLevel } from '@google/genai';
import {
  FLASH_MODEL,
  getAi,
  getCurrentSeasonInfo,
  runGroundedSearch,
} from './aiClient';
import type { FutbolpediaVerifiedFacts } from './profileManagerGrounding';
import { formatRecentTeamBlock, type TeamAbsence, type TeamLineup } from './teamLineups';

export interface ApiFootballFixtureItem {
  date: string | null;
  competition: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  score: string;
}

export interface ApiFootballPlayerFactSheet {
  id: number;
  name: string;
  firstname?: string;
  lastname?: string;
  age: number | null;
  nationality: string | null;
  height: string | null;
  weight: string | null;
  position: string | null;
  currentClub: string | null;
  league: string | null;
  coach?: string | null;
  /** Start date of the coach's current stint, from API-Football. */
  coachSince?: string | null;
  injured: boolean | null;
  seasonStats: {
    season: number;
    appearances: number | null;
    lineups: number | null;
    minutes: number | null;
    goals: number | null;
    assists: number | null;
    keyPasses: number | null;
    tackles: number | null;
    interceptions: number | null;
    duelsWon: number | null;
    rating: string | null;
  } | null;
  recentFixtures?: ApiFootballFixtureItem[];
}

export interface ExtendedVerifiedFacts extends FutbolpediaVerifiedFacts {
  playerName: string | null;
  age: number | null;
  position: string | null;
  nationality: string | null;
  height: string | null;
  weight: string | null;
  recentMatchDate: string | null;
  premierLeagueMobility:
    | 'stable'
    | 'recent_arrival'
    | 'linked_exit'
    | 'confirmed_exit'
    | 'linked_move'
    | 'unknown';
  verifiedSources: string[];
  dataGaps: string[];
}

/** GETs a JSON route, resolving to null on timeout, network failure, or a non-2xx status. */
async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<any | null> {
  if (typeof fetch === 'undefined') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const formatFixtureEntry = (f: ApiFootballFixtureItem, separator: string): string =>
  `${f.date ?? '?'} [${f.competition ?? 'Match'}] ${f.homeTeam} ${separator} ${f.awayTeam}`;

export async function fetchApiFootballPlayer(
  playerName: string,
  timeoutMs = 3500,
): Promise<ApiFootballPlayerFactSheet | null> {
  if (!playerName.trim()) return null;
  const data = await fetchJsonWithTimeout(
    `/api/football/player?name=${encodeURIComponent(playerName.trim())}`,
    timeoutMs,
  );
  return (data?.player as ApiFootballPlayerFactSheet) ?? null;
}

export function formatApiFootballFactSheetBlock(player: ApiFootballPlayerFactSheet | null): string {
  if (!player) return '';
  const stats = player.seasonStats;
  const statsLine = stats
    ? `Season ${stats.season} (API-Football): ${stats.appearances ?? 0} apps (${stats.lineups ?? 0} starts, ${stats.minutes ?? 0} mins), ${stats.goals ?? 0} goals, ${stats.assists ?? 0} assists${stats.keyPasses != null ? `, ${stats.keyPasses} key passes` : ''}${stats.tackles != null ? `, ${stats.tackles} tackles` : ''}${stats.interceptions != null ? `, ${stats.interceptions} interceptions` : ''}.`
    : 'Season stats: not available in API-Football.';

  const fixturesLine =
    Array.isArray(player.recentFixtures) && player.recentFixtures.length > 0
      ? `Recent Club Match Log: ${player.recentFixtures
          .slice(0, 5)
          .map((f) => formatFixtureEntry(f, f.score))
          .join(' | ')}`
      : '';

  return [
    `[API-FOOTBALL DETERMINISTIC RECORD — ${player.name}]`,
    `Age: ${player.age ?? 'N/A'} | Nationality: ${player.nationality ?? 'N/A'} | Height: ${player.height ?? 'N/A'} | Weight: ${player.weight ?? 'N/A'}`,
    `Position: ${player.position ?? 'N/A'} | Registered Club: ${player.currentClub ?? 'N/A'}${player.league ? ` (${player.league})` : ''} | Injured flag: ${player.injured ?? 'unknown'}`,
    statsLine,
    fixturesLine,
  ]
    .filter(Boolean)
    .join('\n');
}

export interface PlayerGroundingBundle {
  foundationText: string;
  verifiedFacts: ExtendedVerifiedFacts | null;
  verifiedFactsBlock: string;
  apiPlayer: ApiFootballPlayerFactSheet | null;
}

/** Search query that surfaces a club's summer departures and signings, so squad talk skips sold players. */
export const buildSquadTurnoverQuery = (clubLabel: string, year: number): string =>
  `${clubLabel} ${year} transfers out departed players sold loaned out Summer ${year} and new signings current active roster`;

const ANTI_GAME_FILTER ='-site:futbin.com -site:sofifa.com -site:fifaindex.com -site:futwiz.com';

/**
 * Direct, parallel grounding gatherer.
 * Runs API-Football lookup concurrently with focused web search grounding so API-Football
 * adds 0ms of sequential wait time on top of search.
 */
export async function gatherPlayerGrounding(params: {
  playerName: string;
  rawMessage: string;
  isHistorical: boolean;
  /** A past season to rate instead of the player's prime ("2005-06" or a bare "2006"). */
  season?: string | null;
  /** A named version of the player to rate instead of his prime (see TurnRoute.requestedEra). */
  era?: string | null;
}): Promise<PlayerGroundingBundle> {
  const { year, month, currentSeason } = getCurrentSeasonInfo();
  const datePrefix = `[Date: ${month} ${year}]`;
  const subject = params.playerName || params.rawMessage;

  if (params.isHistorical) {
    const searchResult = await runGroundedSearch(
      params.season
        ? `${subject} in the ${params.season} season: club, age, position and role, appearances, goals, assists, honours, form and tactical profile that season ${ANTI_GAME_FILTER}`
        : params.era
          ? `${subject} ${params.era} era: which seasons it covers, club, age, position and role, appearances, goals, assists, honours, form and tactical profile season by season ${ANTI_GAME_FILTER}`
          : `${subject} career peak prime seasons major honours Ballon d'Or FIFPro World XI best season stats tactical profile ${ANTI_GAME_FILTER}`,
    );
    return {
      foundationText: searchResult.formattedBlock,
      verifiedFacts: null,
      verifiedFactsBlock: '',
      apiPlayer: null,
    };
  }

  const searchQueries = [
    `${subject} — current club as of ${month} ${year}, recent match appearances, injury status, ${currentSeason} season stats, and major honours ${ANTI_GAME_FILTER}`,
    `${subject} — tactical scouting report: playing style, positional standing in world football, technical/physical/mental strengths and weaknesses ${ANTI_GAME_FILTER}`,
  ];

  const [apiPlayer, ...searchResults] = await Promise.all([
    fetchApiFootballPlayer(subject, 2800),
    ...searchQueries.map((q) => runGroundedSearch(q, { datePrefix })),
  ]);

  const apiBlock = formatApiFootballFactSheetBlock(apiPlayer);
  const searchBlock = searchResults.map((r) => r.formattedBlock).join('\n\n---\n\n');
  const foundationText = [apiBlock, searchBlock].filter(Boolean).join('\n\n===\n\n');

  const verifiedFactsBlock = apiPlayer
    ? `<deterministic_bio_record>
Authoritative API-Football record for ${apiPlayer.name}:
- Age: ${apiPlayer.age ?? 'verify from search'}
- Nationality: ${apiPlayer.nationality ?? 'verify from search'}
- Height: ${apiPlayer.height ?? 'verify from search'}
- Weight: ${apiPlayer.weight ?? 'verify from search'}
- Registered Club: ${apiPlayer.currentClub ?? 'verify from search'} (update only if search confirms a more recent ${year} transfer/loan)
</deterministic_bio_record>`
    : '';

  return {
    foundationText,
    verifiedFacts: null,
    verifiedFactsBlock,
    apiPlayer,
  };
}

export interface ApiFootballSquadMember {
  name: string;
  position: string | null;
  age: number | null;
}

export interface ApiFootballTeamContext {
  team: string;
  coach: string | null;
  coachSince?: string | null;
  recentFixtures: ApiFootballFixtureItem[];
  upcomingFixtures: ApiFootballFixtureItem[];
  squad?: ApiFootballSquadMember[];
  recentLineups?: TeamLineup[];
  /** Null when API-Football's injury list couldn't be read. */
  unavailable?: TeamAbsence[] | null;
}

// A cold lookup reads fixtures first, then their lineups; it runs alongside web search, so the
// longer wait rarely adds to the turn.
export async function fetchApiFootballTeamContext(
  teamName: string,
  timeoutMs = 7000,
): Promise<ApiFootballTeamContext | null> {
  if (!teamName.trim()) return null;
  const data = await fetchJsonWithTimeout(
    `/api/football/fixtures?team=${encodeURIComponent(teamName.trim())}`,
    timeoutMs,
  );
  if (!data?.available) return null;
  return {
    team: data.team || teamName,
    coach: data.coach ?? null,
    coachSince: data.coachSince ?? null,
    recentFixtures: Array.isArray(data.recentFixtures) ? data.recentFixtures : [],
    upcomingFixtures: Array.isArray(data.upcomingFixtures) ? data.upcomingFixtures : [],
    squad: Array.isArray(data.squad) ? data.squad : [],
    recentLineups: Array.isArray(data.recentLineups) ? data.recentLineups : [],
    unavailable: Array.isArray(data.unavailable) ? data.unavailable : null,
  };
}

export function formatApiFootballTeamContextBlock(ctx: ApiFootballTeamContext | null): string {
  if (!ctx) return '';
  const recentLine =
    ctx.recentFixtures.length > 0
      ? `Recent Matches: ${ctx.recentFixtures
          .slice(0, 5)
          .map((f) => formatFixtureEntry(f, f.score))
          .join(' | ')}`
      : '';
  const upcomingLine =
    ctx.upcomingFixtures.length > 0
      ? `Upcoming Fixtures: ${ctx.upcomingFixtures
          .slice(0, 3)
          .map((f) => formatFixtureEntry(f, 'vs'))
          .join(' | ')}`
      : '';

  let squadBlock = '';
  if (Array.isArray(ctx.squad) && ctx.squad.length > 0) {
    const byGroup: Record<string, string[]> = {
      Goalkeepers: [],
      Defenders: [],
      Midfielders: [],
      Attackers: [],
    };
    for (const member of ctx.squad) {
      const pos = (member.position || '').toLowerCase();
      const label = member.age ? `${member.name} (${member.age})` : member.name;
      if (pos.includes('goal') || pos === 'gk') byGroup.Goalkeepers.push(label);
      else if (pos.includes('defend')) byGroup.Defenders.push(label);
      else if (pos.includes('midfield')) byGroup.Midfielders.push(label);
      else byGroup.Attackers.push(label);
    }
    const groupLines = Object.entries(byGroup)
      .filter(([, list]) => list.length > 0)
      .map(([group, list]) => `  - ${group}: ${list.join(', ')}`);
    if (groupLines.length > 0) {
      squadBlock = `Registered Active Squad (API-Football — use only these verified squad members plus confirmed current-season signings; never cite departed players):\n${groupLines.join('\n')}`;
    }
  }

  return [
    `[API-FOOTBALL CLUB CONTEXT — ${ctx.team}]`,
    formatRecentTeamBlock(ctx.team, ctx.recentLineups ?? [], ctx.unavailable ?? null),
    squadBlock,
    recentLine,
    upcomingLine,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Parallel Google Search + optional API-Football player/club enrichment for Gaffa mode,
 * multi-player comparisons, and conversational tactical analysis.
 */
export async function gatherSearchFoundation(
  queries: string[],
  playerNames: string[] = [],
  clubNames: string[] = [],
): Promise<string> {
  const uniquePlayers = [...new Set(playerNames.map((n) => n.trim()).filter(Boolean))].slice(0, 3);
  const uniqueClubs = [...new Set(clubNames.map((c) => c.trim()).filter(Boolean))].slice(0, 2);

  const [apiPlayers, apiClubs, searchSettled] = await Promise.all([
    Promise.all(uniquePlayers.map((name) => fetchApiFootballPlayer(name))),
    Promise.all(uniqueClubs.map((club) => fetchApiFootballTeamContext(club))),
    Promise.allSettled(queries.map((q) => runGroundedSearch(q))),
  ]);

  const chunks: string[] = [];

  for (const p of apiPlayers) {
    if (p) {
      chunks.push(formatApiFootballFactSheetBlock(p));
    }
  }

  for (const c of apiClubs) {
    if (c) {
      chunks.push(formatApiFootballTeamContextBlock(c));
    }
  }

  searchSettled.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.text) {
      chunks.push(
        `### Grounding notes (internal — never cite as Search ${i + 1})\n${result.value.text}`,
      );
    }
  });

  return chunks.join('\n\n') || 'No grounded search results available for this turn.';
}

export type CareerStatus = 'active' | 'retired' | 'unknown';

/** Who a typed name refers to: the name he is commonly known by, his full name, and his status. */
export interface PlayerIdentity {
  status: CareerStatus;
  knownAs: string | null;
  fullName: string | null;
  /** The check found that no footballer goes by this name. */
  noSuchPlayer?: boolean;
}

const identityCache = new Map<string, Promise<PlayerIdentity>>();

/** Reads the status check's answer; anything without a clear ACTIVE or RETIRED is 'unknown'. */
export function parseCareerStatus(text: string): CareerStatus {
  const m = text.toUpperCase().match(/\b(RETIRED|ACTIVE)\b/);
  return m ? (m[1] === 'RETIRED' ? 'retired' : 'active') : 'unknown';
}

/**
 * Reads "STATUS: … | KNOWN AS: … | FULL NAME: …"; a bare status word still reads as the status, and
 * "STATUS: NONE" means no footballer goes by the name.
 */
export function parsePlayerIdentity(text: string): PlayerIdentity {
  const field = (label: string): string | null =>
    text.match(new RegExp(`${label}\\s*:\\s*([^|\\n]+)`, 'i'))?.[1].replace(/[*"]/g, '').trim() || null;
  const name = (value: string | null): string | null =>
    value && value.length <= 60 && !/^(unknown|n\/a|none)$/i.test(value) ? value : null;
  if (/^none\b/i.test(field('STATUS') ?? '')) {
    return { status: 'unknown', knownAs: null, fullName: null, noSuchPlayer: true };
  }
  return {
    status: parseCareerStatus(field('STATUS') ?? text),
    knownAs: name(field('KNOWN AS')),
    fullName: name(field('FULL NAME')),
  };
}

/**
 * Backup for an inconclusive status check: the current-player grounding itself reports the
 * retirement and API-Football has no current-season appearances for him.
 */
export function groundingShowsRetirement(
  foundationText: string,
  apiPlayer: ApiFootballPlayerFactSheet | null,
): boolean {
  const playingNow = (apiPlayer?.seasonStats?.appearances ?? 0) > 0;
  if (playingNow) return false;
  // Retiring from international football says nothing about club football.
  const text = foundationText.replace(
    /[^.\n]*\b(international|national team|national side)\b[^.\n]*/gi,
    ' ',
  );
  return /\b(retired|retirement|hung up (?:his|her|their) boots)\b/i.test(text) &&
    !/\bcame out of retirement|un-?retire/i.test(text);
}

/**
 * Who the footballer behind a typed name is, from one focused grounded search: the name he is
 * commonly known by and his full name, so every way of naming him finds the same card, and
 * whether he still plays professionally. A dossier on a retired player with no timeframe rates his
 * prime, since he has no current form to rate. Anything short of a clear status is 'unknown',
 * which callers treat as active.
 */
export function getPlayerIdentity(playerName: string): Promise<PlayerIdentity> {
  const key = playerName.trim().toLowerCase();
  const unknown: PlayerIdentity = { status: 'unknown', knownAs: null, fullName: null };
  if (!key) return Promise.resolve(unknown);
  const cached = identityCache.get(key);
  if (cached) return cached;
  const { month, year } = getCurrentSeasonInfo();
  const job = getAi()
    .models.generateContent({
      model: FLASH_MODEL,
      contents: `As of ${month} ${year}, is the footballer ${playerName} still playing professionally, or has he retired from playing? Also give the name football coverage commonly calls him by and his full name. Reply on one line, exactly: STATUS: <ACTIVE, RETIRED or UNKNOWN> | KNOWN AS: <name> | FULL NAME: <name>. Write UNKNOWN for anything you cannot tell. If no footballer goes by that name or anything close to it, reply exactly: STATUS: NONE. Never answer with a different footballer.`,
      config: {
        temperature: 0,
        // Thinking tokens count against this budget, so leave room beyond the one-line answer.
        maxOutputTokens: 512,
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    })
    .then((res): PlayerIdentity => {
      const identity = parsePlayerIdentity(res.text ?? '');
      if (identity.status === 'unknown') identityCache.delete(key);
      console.info(
        identity.noSuchPlayer
          ? `[PlayerIdentity] ${playerName}: no such footballer`
          : `[PlayerIdentity] ${playerName}: ${identity.status}, known as ${identity.knownAs ?? '?'} (${identity.fullName ?? '?'})`,
      );
      return identity;
    })
    .catch((e): PlayerIdentity => {
      console.warn(`[PlayerIdentity] Check failed for ${playerName}:`, e);
      identityCache.delete(key);
      return unknown;
    });
  identityCache.set(key, job);
  return job;
}

/** Whether a player still plays professionally (see getPlayerIdentity). */
export const getCareerStatus = (playerName: string): Promise<CareerStatus> =>
  getPlayerIdentity(playerName).then((identity) => identity.status);
