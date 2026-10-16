import { Type } from '@google/genai';
import {
  generateStructured,
  getCurrentSeasonInfo,
  runGroundedSearch,
} from './aiClient';
import type { FutbolpediaVerifiedFacts } from './profileManagerGrounding';

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

const VERIFIED_FACTS_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    playerName: { type: Type.STRING, nullable: true },
    currentClub: { type: Type.STRING, nullable: true },
    age: { type: Type.NUMBER, nullable: true },
    position: { type: Type.STRING, nullable: true },
    nationality: { type: Type.STRING, nullable: true },
    height: { type: Type.STRING, nullable: true },
    weight: { type: Type.STRING, nullable: true },
    season2526Stats: { type: Type.STRING, nullable: true },
    recentForm: { type: Type.STRING, nullable: true },
    injuryStatus: { type: Type.STRING, nullable: true },
    recentMatchDate: { type: Type.STRING, nullable: true },
    majorAwards: { type: Type.ARRAY, items: { type: Type.STRING } },
    tacticalRole: { type: Type.STRING, nullable: true },
    currentHeadCoach: { type: Type.STRING, nullable: true },
    conflictingManagerReports: { type: Type.ARRAY, items: { type: Type.STRING } },
    premierLeagueMobility: {
      type: Type.STRING,
      enum: [
        'stable',
        'recent_arrival',
        'linked_exit',
        'confirmed_exit',
        'linked_move',
        'unknown',
      ],
    },
    mobilitySummary: { type: Type.STRING, nullable: true },
    verifiedSources: { type: Type.ARRAY, items: { type: Type.STRING } },
    dataGaps: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: [
    'playerName',
    'currentClub',
    'age',
    'position',
    'nationality',
    'height',
    'weight',
    'season2526Stats',
    'recentForm',
    'injuryStatus',
    'recentMatchDate',
    'majorAwards',
    'tacticalRole',
    'currentHeadCoach',
    'conflictingManagerReports',
    'premierLeagueMobility',
    'mobilitySummary',
    'verifiedSources',
    'dataGaps',
  ],
};

export async function fetchApiFootballPlayer(
  playerName: string,
): Promise<ApiFootballPlayerFactSheet | null> {
  if (typeof fetch === 'undefined' || !playerName.trim()) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
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

  return [
    `[API-FOOTBALL DETERMINISTIC RECORD — ${player.name}]`,
    `Age: ${player.age ?? 'N/A'} | Nationality: ${player.nationality ?? 'N/A'} | Height: ${player.height ?? 'N/A'} | Weight: ${player.weight ?? 'N/A'}`,
    `Position: ${player.position ?? 'N/A'} | Registered Club: ${player.currentClub ?? 'N/A'}${player.league ? ` (${player.league})` : ''} | Injured flag: ${player.injured ?? 'unknown'}`,
    statsLine,
  ].join('\n');
}

export interface PlayerGroundingBundle {
  foundationText: string;
  verifiedFacts: ExtendedVerifiedFacts | null;
  verifiedFactsBlock: string;
  apiPlayer: ApiFootballPlayerFactSheet | null;
}

export async function gatherPlayerGrounding(params: {
  playerName: string;
  rawMessage: string;
  mode: 'default' | 'fast';
  isHistorical: boolean;
}): Promise<PlayerGroundingBundle> {
  const { year, month, currentSeason } = getCurrentSeasonInfo();
  const datePrefix = `[Date: ${month} ${year}]`;
  const subject = params.playerName || params.rawMessage;

  let searchQueries: string[];
  if (params.isHistorical) {
    searchQueries = [
      `${subject} peak prime season major awards Ballon d'Or rankings and honours`,
      `${subject} prime years best season stats goals assists per 90 and advanced metrics`,
      `${subject} prime tactical role scouting report playing style strengths weaknesses and defining matches`,
    ];
  } else if (params.mode === 'fast') {
    searchQueries = [
      `${subject} current club ${year}, current head coach and manager appointment, injury status, transfer news, and ${currentSeason} stats`,
      `${subject} scouting profile: playing style, technical/physical/mental strengths and weaknesses, tactical role, and recent form`,
    ];
  } else {
    searchQueries = [
      `${subject} — current club as of ${month} ${year}, confirmed current head coach, recent match appearances, injury status, and ${year} transfer or loan news`,
      `${subject} — scouting report: playing style, tactical role, technical/physical/mental strengths and weaknesses, and analyst breakdowns of how he plays`,
      `${subject} — ${currentSeason} season stats (goals, assists, minutes, key metrics), major awards, and peer reputation`,
    ];
  }

  const [apiPlayer, ...searchResults] = await Promise.all([
    params.isHistorical ? Promise.resolve(null) : fetchApiFootballPlayer(subject),
    ...searchQueries.map((q) => runGroundedSearch(q, { datePrefix })),
  ]);

  const apiBlock = formatApiFootballFactSheetBlock(apiPlayer);
  const searchBlock = searchResults.map((r) => r.formattedBlock).join('\n\n---\n\n');
  const foundationText = [apiBlock, searchBlock].filter(Boolean).join('\n\n===\n\n');

  if (params.isHistorical) {
    return {
      foundationText,
      verifiedFacts: null,
      verifiedFactsBlock: '',
      apiPlayer: null,
    };
  }

  let verifiedFacts: ExtendedVerifiedFacts | null = null;
  let verifiedFactsBlock = '';

  try {
    const extractionPrompt = `Extract verified player facts from the API-Football record and web search grounding below.
Rules:
- Use API-Football as the primary anchor for age, nationality, height, and weight when present.
- For currentClub, use the most recent ${year} club confirmed in web search if a transfer or loan occurred; otherwise use API-Football.
- Set currentHeadCoach ONLY if web search explicitly confirms who manages the player's CURRENT club as of ${month} ${year}. If only a sacked or former manager is mentioned, or if sources conflict, set currentHeadCoach to null and list the conflict in conflictingManagerReports.
- Never guess or invent unstated facts; use null for missing fields.

GROUNDING DATA:
${foundationText.substring(0, 9500)}

USER REQUEST: "${params.rawMessage}"`;

    verifiedFacts = await generateStructured<ExtendedVerifiedFacts>({
      task: 'extraction',
      mode: params.mode,
      prompt: extractionPrompt,
      schema: VERIFIED_FACTS_SCHEMA,
    });

    if (apiPlayer) {
      verifiedFacts.age = verifiedFacts.age ?? apiPlayer.age;
      verifiedFacts.nationality = verifiedFacts.nationality ?? apiPlayer.nationality;
      verifiedFacts.height = verifiedFacts.height ?? apiPlayer.height;
      verifiedFacts.weight = verifiedFacts.weight ?? apiPlayer.weight;
      verifiedFacts.currentClub = verifiedFacts.currentClub ?? apiPlayer.currentClub;
    }

    verifiedFactsBlock = `
    <verified_facts>
    Authoritative facts merged from API-Football and live search grounding:
    - Use these exact values for basicInfo (name, age, nationality, club, height, weight) and latestUpdate.
    - Missing current-season stats in dataGaps lower confidence — NEVER zero out any of the 25 ability attributes for a recognizable footballer.
    - Only name a head coach in prose if currentHeadCoach is non-null.
    ${JSON.stringify(verifiedFacts, null, 2)}
    </verified_facts>`;
  } catch (e) {
    console.warn('[Grounding] Schema fact extraction failed, using raw foundation:', e);
  }

  return {
    foundationText,
    verifiedFacts,
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
