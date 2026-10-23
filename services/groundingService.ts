import {
  getCurrentSeasonInfo,
  runGroundedSearch,
} from './aiClient';
import type { FutbolpediaVerifiedFacts } from './profileManagerGrounding';

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

export async function fetchApiFootballPlayer(
  playerName: string,
  timeoutMs = 3500,
): Promise<ApiFootballPlayerFactSheet | null> {
  if (typeof fetch === 'undefined' || !playerName.trim()) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(
      `/api/football/player?name=${encodeURIComponent(playerName.trim())}`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.player as ApiFootballPlayerFactSheet) ?? null;
  } catch {
    return null;
  }
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
          .map(
            (f) =>
              `${f.date ?? '?'} [${f.competition ?? 'Match'}] ${f.homeTeam} ${f.score} ${f.awayTeam}`,
          )
          .join(' | ')}`
      : '';

  return [
    `[API-FOOTBALL DETERMINISTIC RECORD — ${player.name}]`,
    `Age: ${player.age ?? 'N/A'} | Nationality: ${player.nationality ?? 'N/A'} | Height: ${player.height ?? 'N/A'} | Weight: ${player.weight ?? 'N/A'}`,
    `Position: ${player.position ?? 'N/A'} | Registered Club: ${player.currentClub ?? 'N/A'}${player.league ? ` (${player.league})` : ''}${player.coach ? ` | Registered Head Coach: ${player.coach}` : ''} | Injured flag: ${player.injured ?? 'unknown'}`,
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

const ANTI_GAME_FILTER = '-site:futbin.com -site:sofifa.com -site:fifaindex.com -site:futwiz.com';

/**
 * Direct, parallel grounding gatherer.
 * Runs API-Football lookup concurrently with focused web search grounding so API-Football
 * adds 0ms of sequential wait time on top of search.
 */
export async function gatherPlayerGrounding(params: {
  playerName: string;
  rawMessage: string;
  isHistorical: boolean;
}): Promise<PlayerGroundingBundle> {
  const { year, month, currentSeason } = getCurrentSeasonInfo();
  const datePrefix = `[Date: ${month} ${year}]`;
  const subject = params.playerName || params.rawMessage;

  if (params.isHistorical) {
    const searchResult = await runGroundedSearch(
      `${subject} career peak prime seasons major honours Ballon d'Or FIFPro World XI best season stats tactical profile ${ANTI_GAME_FILTER}`,
    );
    return {
      foundationText: searchResult.formattedBlock,
      verifiedFacts: null,
      verifiedFactsBlock: '',
      apiPlayer: null,
    };
  }

  const searchQueries = [
    `${subject} — current club as of ${month} ${year}, confirmed current head coach, recent match appearances, injury status, ${currentSeason} season stats, and major honours ${ANTI_GAME_FILTER}`,
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
    ? `<deterministic_bio_anchor>
Authoritative API-Football record for ${apiPlayer.name}:
- Age: ${apiPlayer.age ?? 'verify from search'}
- Nationality: ${apiPlayer.nationality ?? 'verify from search'}
- Height: ${apiPlayer.height ?? 'verify from search'}
- Weight: ${apiPlayer.weight ?? 'verify from search'}
- Registered Club: ${apiPlayer.currentClub ?? 'verify from search'} (update only if search confirms a more recent ${year} transfer/loan)
${apiPlayer.coach ? `- Registered Head Coach: ${apiPlayer.coach} (update only if search confirms a more recent coaching change)` : ''}
</deterministic_bio_anchor>`
    : '';

  return {
    foundationText,
    verifiedFacts: null,
    verifiedFactsBlock,
    apiPlayer,
  };
}

/**
 * Parallel Google Search + optional API-Football player enrichment for Gaffa mode
 * and multi-player comparisons.
 */
export async function gatherSearchFoundation(
  queries: string[],
  playerNames: string[] = [],
): Promise<string> {
  const uniquePlayers = [...new Set(playerNames.map((n) => n.trim()).filter(Boolean))].slice(0, 2);

  const [apiPlayers, searchSettled] = await Promise.all([
    Promise.all(uniquePlayers.map((name) => fetchApiFootballPlayer(name))),
    Promise.allSettled(queries.map((q) => runGroundedSearch(q))),
  ]);

  const chunks: string[] = [];

  for (const p of apiPlayers) {
    if (p) {
      chunks.push(formatApiFootballFactSheetBlock(p));
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
