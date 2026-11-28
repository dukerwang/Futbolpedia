import { Type, type FunctionDeclaration } from '@google/genai';
import type { EvidenceEntry } from '../evidenceLedger';
import type { LiveGet } from '../researchTools';
import { RANKED_MIN_MATCHES, type TeamStrengthReport, type TeamStrengthResult } from './teamStrength';

/**
 * `team_strength`, the chat loop's tool over the stored ratings. It reads the app's own route, so
 * it costs no lookup, and what it returns is filed in the evidence ledger like any other result.
 */

export const TEAM_STRENGTH_DECLARATION: FunctionDeclaration = {
  name: 'team_strength',
  description:
    "A club's strength by its results: an Elo rating computed by code from match results in the covered leagues, domestic cups and continental competitions, with its rank, its league's average and the highest-rated clubs on that date. It measures results (who was beaten, where and by how much), not squad quality, players or style. Ratings start in 2004-05; earlier dates have none. A rating from few counted matches is rough. Leagues compare only as far as their clubs have met, so clubs outside Europe don't compare with European ones. Stored monthly and at each season's end, and daily for the season in progress. Free.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      club: { type: Type.STRING, description: 'The club name.' },
      date: { type: Type.STRING, description: 'A day, as YYYY-MM-DD. Leave out with season for the latest rating.' },
      season: { type: Type.STRING, description: "A season, as YYYY-YY, read at its end (the latest rating for the season in progress). It runs July to June, so for a league that plays in calendar years give a date." },
    },
    required: ['club'],
  },
};

const ordinal = (n: number): string => {
  const tail = n % 100;
  if (tail >= 11 && tail <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/** The reading as the model and the figure gate see it: whole ratings, each beside what it counts. */
export function formatTeamStrength(r: TeamStrengthReport): string {
  const when =
    r.kind === 'season_end' ? `at the end of ${r.season} (${r.asOf})` : r.kind === 'latest' ? `latest, ${r.asOf}, ${r.season} in progress` : `going into ${r.asOf} (${r.season})`;
  const lines = [
    `${r.club.club}: Elo rating ${r.club.rating}, ${when}. ${r.club.matches} matches counted since 2003-04.`,
    r.rough
      ? `Rough figure: fewer than ${RANKED_MIN_MATCHES} matches counted, so the club isn't ranked.`
      : r.rank
        ? `Rank: ${ordinal(r.rank.position)} place of ${r.rank.of} rated clubs in ${r.pool} (clubs with ${RANKED_MIN_MATCHES} or more matches counted).`
        : '',
    r.leagueAverage ? `${r.leagueAverage.league} average rating ${r.leagueAverage.rating} over ${r.leagueAverage.clubs} clubs.` : r.league ? `League: ${r.league}.` : '',
    r.top.length ? `Highest rated in ${r.pool} then: ${r.top.map((t, i) => `${i + 1}. ${t.club} rating ${t.rating} (${t.matches} matches)`).join('; ')}.` : '',
    r.outsideEurope
      ? "This club's league is outside Europe: its ratings come almost wholly from matches within its own league and continent, so don't compare them with European clubs'."
      : '',
    'The rating measures results (opponents, venue and margin), not squad quality or style.',
  ];
  return lines.filter(Boolean).join('\n');
}

/** The route's answer for a call, read through the app's own server. */
export async function lookUpTeamStrength(args: { club: string; date?: string; season?: string }, get: LiveGet): Promise<TeamStrengthResult> {
  const query = new URLSearchParams({ club: args.club, ...(args.date ? { date: args.date } : {}), ...(args.season ? { season: args.season } : {}) });
  const res = await get<TeamStrengthResult>(`/api/kb/team-strength?${query}`, 8_000);
  if ('error' in res) return { found: false, status: 'failed', reason: `the ratings couldn't be read (${res.error})` };
  return res.data;
}

export interface TeamStrengthToolOutcome {
  /** What the model reads as the call's result. */
  response: Record<string, unknown>;
  /** What the ledger keeps; none when there's no rating. */
  evidence: Omit<EvidenceEntry, 'id'> | null;
}

export async function runTeamStrength(
  args: Record<string, unknown>,
  lookUp: (args: { club: string; date?: string; season?: string }) => Promise<TeamStrengthResult>,
): Promise<TeamStrengthToolOutcome> {
  const word = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const club = word(args.club);
  if (!club) return { response: { status: 'not_run', reason: 'Missing argument.' }, evidence: null };
  const date = word(args.date);
  const season = word(args.season);
  const result = await lookUp({ club, ...(date ? { date } : {}), ...(season ? { season } : {}) });
  if (!result || typeof result !== 'object' || !('found' in result)) return { response: { status: 'failed', reason: "the ratings couldn't be read" }, evidence: null };
  if ('reason' in result) return { response: { status: result.status, reason: result.reason }, evidence: null };
  const content = formatTeamStrength(result);
  const label = `${result.club.club}, ${result.kind === 'season_end' ? `end of ${result.season}` : result.asOf}`;
  return { response: { status: 'found', data: content }, evidence: { kind: 'team_strength', label, content } };
}
