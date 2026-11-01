/**
 * Current-season football facts from two free, keyless public feeds:
 *
 * - ESPN's site API: every club's matches in all competitions this season, with both starting XIs,
 *   formations and substitutes, upcoming fixtures, and league tables, across the leagues below.
 * - The Fantasy Premier League feed: each Premier League player's starts, minutes and output this
 *   season, and the injury and suspension list with return news.
 *
 * Neither feed is an official API, so everything here reads them defensively and reports what it
 * couldn't get rather than failing. The server owns fetching and caching (`createLiveFootball`
 * takes the fetcher); the parsers and formatters are pure, so tests feed them fixtures.
 */

export const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
export const ESPN_STANDINGS = 'https://site.api.espn.com/apis/v2/sports/soccer';
export const FPL_BOOTSTRAP = 'https://fantasy.premierleague.com/api/bootstrap-static/';

export interface LiveLeague {
  slug: string;
  name: string;
  country: string | null;
  /** Lowercase, accent-free names people use for it. */
  aliases: string[];
  /** Whether its clubs are indexed for club lookups (cup competitions aren't). */
  clubs: boolean;
}

/** The leagues looked up, in priority order for clubs whose names are shared. */
export const LIVE_LEAGUES: LiveLeague[] = [
  { slug: 'eng.1', name: 'Premier League', country: 'England', aliases: ['premier league', 'english premier league', 'epl', 'prem'], clubs: true },
  { slug: 'esp.1', name: 'LaLiga', country: 'Spain', aliases: ['laliga', 'la liga', 'primera division'], clubs: true },
  { slug: 'ita.1', name: 'Serie A', country: 'Italy', aliases: ['serie a'], clubs: true },
  { slug: 'ger.1', name: 'Bundesliga', country: 'Germany', aliases: ['bundesliga'], clubs: true },
  { slug: 'fra.1', name: 'Ligue 1', country: 'France', aliases: ['ligue 1'], clubs: true },
  { slug: 'por.1', name: 'Primeira Liga', country: 'Portugal', aliases: ['primeira liga', 'liga portugal'], clubs: true },
  { slug: 'ned.1', name: 'Eredivisie', country: 'Netherlands', aliases: ['eredivisie'], clubs: true },
  { slug: 'eng.2', name: 'Championship', country: 'England', aliases: ['championship', 'efl championship'], clubs: true },
  { slug: 'sco.1', name: 'Scottish Premiership', country: 'Scotland', aliases: ['scottish premiership', 'spfl'], clubs: true },
  { slug: 'bel.1', name: 'Belgian Pro League', country: 'Belgium', aliases: ['belgian pro league', 'jupiler pro league', 'pro league'], clubs: true },
  { slug: 'tur.1', name: 'Süper Lig', country: 'Turkey', aliases: ['super lig', 'turkish super lig'], clubs: true },
  { slug: 'usa.1', name: 'MLS', country: 'USA', aliases: ['mls', 'major league soccer'], clubs: true },
  { slug: 'ksa.1', name: 'Saudi Pro League', country: 'Saudi Arabia', aliases: ['saudi pro league', 'roshn saudi league', 'spl'], clubs: true },
  { slug: 'bra.1', name: 'Brasileirão', country: 'Brazil', aliases: ['brasileirao', 'campeonato brasileiro', 'serie a'], clubs: true },
  { slug: 'arg.1', name: 'Liga Profesional', country: 'Argentina', aliases: ['liga profesional', 'primera division'], clubs: true },
  { slug: 'mex.1', name: 'Liga MX', country: 'Mexico', aliases: ['liga mx'], clubs: true },
  { slug: 'uefa.champions', name: 'Champions League', country: null, aliases: ['champions league', 'uefa champions league', 'ucl'], clubs: false },
  { slug: 'uefa.europa', name: 'Europa League', country: null, aliases: ['europa league', 'uefa europa league', 'uel'], clubs: false },
];

/** Matches whose lineups a club lookup reads, most recent competitive ones first. */
export const RECENT_XI_MATCHES = 4;
const RECENT_RESULTS = 6;
const NEXT_FIXTURES = 3;

// ---------------------------------------------------------------------------------------------
// Names

const NAME_EXPANSIONS: Record<string, string[]> = {
  man: ['manchester'],
  utd: ['united'],
  nottm: ['nottingham'],
  spurs: ['tottenham'],
  wolves: ['wolverhampton'],
  inter: ['internazionale'],
  psg: ['paris', 'saint', 'germain'],
  barca: ['barcelona'],
  atleti: ['atletico'],
  bvb: ['borussia', 'dortmund'],
  juve: ['juventus'],
};
const NAME_FILLER = new Set(['fc', 'cf', 'afc', 'sc', 'the', 'de', 'club']);

/** A name as comparable words: no accents, case, punctuation or "FC", with common short forms expanded. */
export function nameTokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !NAME_FILLER.has(t))
    .flatMap((t) => NAME_EXPANSIONS[t] ?? [t]);
}

/** Whether `part`'s words appear, in order and together, in `whole`. */
const containsRun = (whole: string[], part: string[]): boolean => {
  if (part.length === 0 || part.length > whole.length) return false;
  for (let i = 0; i + part.length <= whole.length; i++) if (part.every((t, j) => whole[i + j] === t)) return true;
  return false;
};

const sameTokens = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((t, i) => t === b[i]);

/** Whether `part`'s words all appear in `whole` in order, gaps allowed ("Gabriel Magalhães" in "Gabriel dos Santos Magalhães"). */
const inOrder = (whole: string[], part: string[]): boolean => {
  if (part.length === 0) return false;
  let i = 0;
  for (const t of whole) if (t === part[i]) i++;
  return i === part.length;
};

/** How well a query names something with these names: 3 exact, 2 query inside a name, 1 a name inside the query, 0 no match. */
export function nameScore(query: string, names: string[]): number {
  const q = nameTokens(query);
  let best = 0;
  for (const name of names) {
    const n = nameTokens(name);
    if (sameTokens(q, n)) return 3;
    if (containsRun(n, q)) best = Math.max(best, 2);
    else if (containsRun(q, n)) best = Math.max(best, 1);
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// ESPN: clubs, matches, lineups

export interface EspnTeam {
  id: string;
  name: string;
  names: string[];
  abbreviation: string | null;
  league: string;
}

/** A league's clubs from `/{league}/teams`. */
export function parseEspnTeams(json: any, league: string): EspnTeam[] {
  const teams = json?.sports?.[0]?.leagues?.[0]?.teams;
  if (!Array.isArray(teams)) return [];
  return teams
    .map((t: any) => t?.team)
    .filter((t: any) => t?.id && t?.displayName)
    .map((t: any) => ({
      id: String(t.id),
      name: String(t.displayName),
      names: [t.displayName, t.shortDisplayName, t.name, t.location].filter((n: unknown): n is string => typeof n === 'string' && n.length > 0),
      abbreviation: typeof t.abbreviation === 'string' ? t.abbreviation : null,
      league,
    }));
}

/** The club a name means: best name match, then league priority. Null when nothing matches. */
export function findClub(query: string, teams: EspnTeam[]): EspnTeam | null {
  const order = (league: string) => LIVE_LEAGUES.findIndex((l) => l.slug === league);
  let best: { team: EspnTeam; score: number } | null = null;
  for (const team of teams) {
    let score = nameScore(query, team.names);
    if (score === 0 && team.abbreviation && query.trim().toUpperCase() === team.abbreviation) score = 1;
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && order(team.league) < order(best.team.league))) best = { team, score };
  }
  return best?.team ?? null;
}

export interface ClubMatch {
  id: string;
  date: string | null;
  competition: string;
  leagueSlug: string | null;
  home: boolean;
  opponent: string;
  completed: boolean;
  goalsFor: number | null;
  goalsAgainst: number | null;
  /** Shootout score, when a drawn cup tie went to penalties. */
  penaltiesFor: number | null;
  penaltiesAgainst: number | null;
}

const scoreValue = (score: any): number | null => {
  const v = typeof score === 'object' && score !== null ? (score.value ?? score.displayValue) : score;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const competitionName = (event: any): string => {
  const league = event?.league?.abbreviation || event?.league?.name || '';
  const stage = event?.seasonType?.name || '';
  if (!league) return stage || 'Match';
  return stage && !/^\d{4}/.test(stage) && !stage.includes(league) ? `${league} (${stage})` : league;
};

/** A club's matches from `/all/teams/{id}/schedule`, friendlies left out, oldest first. */
export function parseClubSchedule(json: any, teamId: string): ClubMatch[] {
  const events = Array.isArray(json?.events) ? json.events : [];
  const matches: ClubMatch[] = [];
  for (const e of events) {
    const slug = typeof e?.league?.slug === 'string' ? e.league.slug : null;
    if (slug && slug.includes('friendly')) continue;
    const comp = e?.competitions?.[0];
    const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
    const us = competitors.find((c: any) => String(c?.team?.id ?? c?.id) === teamId);
    const them = competitors.find((c: any) => c !== us);
    if (!us || !them) continue;
    matches.push({
      id: String(e.id),
      date: typeof e.date === 'string' ? e.date.slice(0, 10) : null,
      competition: competitionName(e),
      leagueSlug: slug,
      home: us.homeAway === 'home',
      opponent: String(them.team?.displayName ?? 'Unknown'),
      completed: Boolean(comp?.status?.type?.completed),
      goalsFor: scoreValue(us.score),
      goalsAgainst: scoreValue(them.score),
      penaltiesFor: typeof us.score?.shootoutScore === 'number' ? us.score.shootoutScore : null,
      penaltiesAgainst: typeof them.score?.shootoutScore === 'number' ? them.score.shootoutScore : null,
    });
  }
  return matches.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

/** "away at Fleetwood Town, D 1-1 (lost 3-5 on penalties)". */
export function describeMatch(m: ClubMatch): string {
  const venue = m.home ? `home to ${m.opponent}` : `away at ${m.opponent}`;
  if (!m.completed || m.goalsFor === null || m.goalsAgainst === null) return venue;
  const outcome = m.goalsFor > m.goalsAgainst ? 'W' : m.goalsFor < m.goalsAgainst ? 'L' : 'D';
  const pens =
    m.penaltiesFor !== null && m.penaltiesAgainst !== null
      ? ` (${m.penaltiesFor > m.penaltiesAgainst ? 'won' : 'lost'} ${m.penaltiesFor}-${m.penaltiesAgainst} on penalties)`
      : '';
  return `${venue}, ${outcome} ${m.goalsFor}-${m.goalsAgainst}${pens}`;
}

export interface LiveStarter {
  name: string;
  /** ESPN's formation slot: G, LB, CD-L, CD-R, RB, DM, CM, LM, RM, AM-L, AM, AM-R, LF, F, RF, … */
  role: string;
}

export interface LiveLineup {
  match: ClubMatch;
  formation: string | null;
  starters: LiveStarter[];
  subsUsed: string[];
}

/** The club's XI from `/all/summary?event={id}`; null when ESPN has no lineup for it. */
export function parseMatchLineup(json: any, teamId: string, match: ClubMatch): LiveLineup | null {
  const rosters = Array.isArray(json?.rosters) ? json.rosters : [];
  const ours = rosters.find((r: any) => String(r?.team?.id) === teamId);
  const players = Array.isArray(ours?.roster) ? ours.roster : [];
  const named = (p: any) => (typeof p?.athlete?.displayName === 'string' ? p.athlete.displayName : null);
  const starters = players
    .filter((p: any) => p?.starter && named(p))
    .map((p: any) => ({ name: named(p) as string, role: String(p?.position?.abbreviation ?? '?') }));
  if (starters.length < 11) return null;
  return {
    match,
    formation: typeof ours.formation === 'string' ? ours.formation : null,
    starters,
    subsUsed: players.filter((p: any) => p?.subbedIn && named(p)).map((p: any) => named(p) as string),
  };
}

/** Rows of a formation from the goalkeeper forward; columns left to right. */
export const roleRow = (role: string): number => {
  const r = role.toUpperCase();
  if (r === 'G' || r === 'GK') return 0;
  if (/^(CD|CB|LB|RB|LWB|RWB|SW|D)(-|$)/.test(r)) return 1;
  if (/^DM/.test(r)) return 2;
  if (/^(CM|LM|RM|M)(-|$)/.test(r)) return 3;
  if (/^AM/.test(r)) return 4;
  return 5;
};
export const roleCol = (role: string): number => {
  const r = role.toUpperCase();
  if (r.endsWith('-L')) return 1;
  if (r.endsWith('-R')) return 3;
  if (r.startsWith('L')) return 0;
  if (r.startsWith('R')) return 4;
  return 2;
};

/** "Raya (GK) | Lewis-Skelly (LB), Gabriel Magalhães (CD-L), … | … | Gyökeres (F)". */
export function formatLiveXI(starters: LiveStarter[]): string {
  const rows = new Map<number, LiveStarter[]>();
  for (const s of starters) rows.set(roleRow(s.role), [...(rows.get(roleRow(s.role)) ?? []), s]);
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, line]) =>
      line
        .sort((a, b) => roleCol(a.role) - roleCol(b.role))
        .map((s) => `${s.name} (${s.role === 'G' ? 'GK' : s.role})`)
        .join(', '),
    )
    .join(' | ');
}

// ---------------------------------------------------------------------------------------------
// FPL: Premier League usage, injuries and player seasons

export interface FplPlayer {
  id: number;
  fullName: string;
  webName: string;
  teamId: number;
  team: string;
  position: string;
  status: string;
  news: string;
  chance: number | null;
  minutes: number;
  starts: number;
  goals: number;
  assists: number;
  cleanSheets: number;
  xg: number | null;
  xa: number | null;
}

export interface FplData {
  teams: { id: number; name: string }[];
  players: FplPlayer[];
}

const FPL_POSITIONS: Record<number, string> = { 1: 'Goalkeeper', 2: 'Defender', 3: 'Midfielder', 4: 'Forward' };
const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v ?? '0'))) || 0;
const optNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
};

/** The FPL `bootstrap-static` feed, reduced to what lookups need. */
export function parseFpl(json: any): FplData | null {
  if (!Array.isArray(json?.teams) || !Array.isArray(json?.elements)) return null;
  const teams = json.teams.filter((t: any) => t?.id && t?.name).map((t: any) => ({ id: Number(t.id), name: String(t.name) }));
  const teamName = new Map(teams.map((t: { id: number; name: string }) => [t.id, t.name]));
  const players: FplPlayer[] = json.elements
    .filter((p: any) => p?.id && teamName.has(Number(p.team)))
    .map((p: any) => ({
      id: Number(p.id),
      fullName: `${p.first_name ?? ''} ${p.second_name ?? ''}`.trim() || String(p.web_name),
      webName: String(p.web_name ?? ''),
      teamId: Number(p.team),
      team: teamName.get(Number(p.team)) as string,
      position: FPL_POSITIONS[Number(p.element_type)] ?? 'Player',
      status: String(p.status ?? 'a'),
      news: String(p.news ?? '').trim(),
      chance: optNum(p.chance_of_playing_next_round),
      minutes: num(p.minutes),
      starts: num(p.starts),
      goals: num(p.goals_scored),
      assists: num(p.assists),
      cleanSheets: num(p.clean_sheets),
      xg: optNum(p.expected_goals),
      xa: optNum(p.expected_assists),
    }));
  return { teams, players };
}

/** The FPL team for an ESPN club, matched by name. */
export function findFplTeam(club: EspnTeam, fpl: FplData): { id: number; name: string } | null {
  let best: { team: { id: number; name: string }; score: number } | null = null;
  for (const team of fpl.teams) {
    const score = nameScore(team.name, club.names);
    if (score > 0 && (!best || score > best.score)) best = { team, score };
  }
  return best?.team ?? null;
}

/** "Thigh injury - Unknown return date", or the status when FPL gave no note. */
export const absenceNote = (p: FplPlayer): string => p.news || (p.status === 's' ? 'suspended' : p.status === 'i' ? 'injured' : 'doubtful');

/** Players FPL lists as injured, suspended or doubtful (not those who left the club). */
export const fplAbsences = (players: FplPlayer[]): FplPlayer[] => players.filter((p) => ['i', 's', 'd', 'n'].includes(p.status));

/** The FPL player a name means: best name match, then the one with more minutes. */
export function findFplPlayer(query: string, fpl: FplData): FplPlayer | null {
  let best: { player: FplPlayer; score: number } | null = null;
  const q = nameTokens(query);
  for (const player of fpl.players) {
    const score = nameScore(query, [player.fullName, player.webName]) || (inOrder(nameTokens(player.fullName), q) ? 2 : 0);
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && player.minutes > best.player.minutes)) best = { player, score };
  }
  return best?.player ?? null;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A player's FPL season as one line, under the name the user knows him by when it is part of his full name. */
export function formatFplPlayer(p: FplPlayer, knownAs?: string): string {
  const name = knownAs && inOrder(nameTokens(p.fullName), nameTokens(knownAs)) ? knownAs.trim() : p.fullName;
  const line = [
    count(p.starts, 'start'),
    count(p.minutes, 'minute'),
    count(p.goals, 'goal'),
    count(p.assists, 'assist'),
    ...(p.xg !== null ? [`xG ${p.xg.toFixed(2)}`] : []),
    ...(p.xa !== null ? [`xA ${p.xa.toFixed(2)}`] : []),
    ...(p.position === 'Goalkeeper' || p.position === 'Defender' ? [count(p.cleanSheets, 'clean sheet')] : []),
  ].join(', ');
  const status = p.status === 'a' ? 'available' : p.status === 'u' ? `not with the squad (${p.news || 'no note'})` : absenceNote(p);
  return `${name} — ${p.team}, ${p.position}. Premier League this season (Fantasy Premier League data): ${line}. Status: ${status}.`;
}

// ---------------------------------------------------------------------------------------------
// League tables

export interface StandingsRow {
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

/** The league a name means, using the country to split shared names ("Serie A", "Primera División"). */
export function findLeague(query: string, country?: string): LiveLeague | null {
  const q = nameTokens(query).join(' ');
  const c = country ? nameTokens(country).join(' ') : null;
  const matches = LIVE_LEAGUES.filter((l) => l.aliases.some((a) => nameTokens(a).join(' ') === q) || nameTokens(l.name).join(' ') === q);
  if (matches.length === 0) return null;
  return (c && matches.find((l) => l.country && nameTokens(l.country).join(' ') === c)) || matches[0];
}

/** ESPN `/standings` as table rows, each group labelled when there's more than one. */
export function parseEspnStandings(json: any): { season: string | null; rows: StandingsRow[] } {
  const groups = Array.isArray(json?.children) ? json.children : [];
  const rows: StandingsRow[] = [];
  for (const g of groups) {
    const entries = Array.isArray(g?.standings?.entries) ? g.standings.entries : [];
    for (const e of entries) {
      const stat = (name: string) => {
        const s = (Array.isArray(e?.stats) ? e.stats : []).find((x: any) => x?.name === name);
        return s ? optNum(s.value ?? s.displayValue) : null;
      };
      rows.push({
        rank: stat('rank'),
        team: e?.team?.displayName ?? null,
        group: groups.length > 1 ? String(g?.name ?? '') : null,
        played: stat('gamesPlayed'),
        won: stat('wins'),
        drawn: stat('ties'),
        lost: stat('losses'),
        goalDiff: stat('pointDifferential'),
        points: stat('points'),
        form: null,
      });
    }
  }
  rows.sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || (a.rank ?? 99) - (b.rank ?? 99));
  return { season: typeof json?.season?.displayName === 'string' ? json.season.displayName : groups[0]?.name ?? null, rows };
}

// ---------------------------------------------------------------------------------------------
// The club block

export interface LiveClubReport {
  team: string;
  league: string;
  lineups: LiveLineup[];
  results: ClubMatch[];
  fixtures: ClubMatch[];
  /** Premier League clubs only; null elsewhere. */
  fplPlayers: FplPlayer[] | null;
  asOf: string;
}

/**
 * FPL keeps formal full names ("Gabriel dos Santos Magalhães"); when the same player appears in an
 * ESPN lineup, use the name football coverage uses.
 */
export const commonName = (p: FplPlayer, espnNames: string[]): string => {
  const full = nameTokens(p.fullName);
  return (
    espnNames.find((n) => inOrder(full, nameTokens(n))) ??
    // A shortened first name ("Ben" for "Benjamin"): same surname, same initial.
    espnNames.find((n) => {
      const t = nameTokens(n);
      return t.length > 1 && t[t.length - 1] === full[full.length - 1] && full[0]?.startsWith(t[0]);
    }) ??
    p.fullName
  );
};

/** The text research and the writer read for a club. */
export function formatClubReport(r: LiveClubReport): string {
  const espnNames = [...new Set(r.lineups.flatMap((l) => [...l.starters.map((s) => s.name), ...l.subsUsed]))];
  const named = (p: FplPlayer) => commonName(p, espnNames);
  const lines: string[] = [
    `${r.team} (${r.league}), live data as of ${r.asOf} from ESPN match data${r.fplPlayers ? ' and the Fantasy Premier League feed' : ''}.`,
  ];
  if (r.results.length) {
    lines.push(
      `Recent results, all competitions, most recent first: ${r.results.map((m) => `${m.date} ${m.competition}, ${describeMatch(m)}`).join('; ')}.`,
    );
  }
  if (r.lineups.length) {
    lines.push('Starting XIs, most recent first (ESPN labels each starter by formation slot, listed back to front and left to right):');
    for (const l of r.lineups) {
      const meta = [l.match.date, l.match.competition, describeMatch(l.match), l.formation].filter(Boolean).join(', ');
      lines.push(`  - ${meta}: ${formatLiveXI(l.starters)}${l.subsUsed.length ? `. Subs used: ${l.subsUsed.join(', ')}` : ''}`);
    }
    if (r.lineups.length > 1) {
      const starts = new Map<string, number>();
      for (const l of r.lineups) for (const s of l.starters) starts.set(s.name, (starts.get(s.name) ?? 0) + 1);
      const ranked = [...starts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}/${r.lineups.length}`);
      lines.push(`  Starts in these ${r.lineups.length} matches: ${ranked.join(', ')}`);
    }
  }
  if (r.fplPlayers) {
    const used = r.fplPlayers.filter((p) => p.minutes > 0).sort((a, b) => b.minutes - a.minutes);
    if (used.length) {
      lines.push(
        `Premier League this season, by minutes (starts, minutes, goals, assists): ${used
          .map((p) => `${named(p)} ${p.starts}, ${p.minutes}', ${p.goals}G ${p.assists}A`)
          .join('; ')}.`,
      );
    }
    const out = fplAbsences(r.fplPlayers);
    lines.push(
      out.length
        ? `Injured, suspended or doubtful (Fantasy Premier League list): ${out.map((p) => `${named(p)} (${absenceNote(p)})`).join('; ')}.`
        : 'Injured, suspended or doubtful (Fantasy Premier League list): none listed.',
    );
  }
  if (r.fixtures.length) {
    lines.push(`Next fixtures: ${r.fixtures.map((m) => `${m.date} ${m.competition}, ${describeMatch(m)}`).join('; ')}.`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Lookups with caching (the server's side)

export type GetJson = (url: string) => Promise<any>;

/**
 * Why a lookup, or part of one, has no data: the source answered with nothing (`empty`), no free
 * source covers it (`not_covered`, so asking again won't help), or the feed failed (`failed`).
 */
export type LiveStatus = 'empty' | 'not_covered' | 'failed';

export interface LiveMissing {
  item: string;
  status: LiveStatus;
}

export type LiveClubResult =
  | { found: true; team: string; league: string; text: string; missing: LiveMissing[]; report: LiveClubReport }
  | { found: false; status: LiveStatus; missing: LiveMissing[] };
export type LivePlayerResult =
  | { found: true; name: string; team: string; text: string }
  | { found: false; status: LiveStatus; reason: string };
export type LiveTableResult =
  | { found: true; league: string; season: string | null; text: string }
  | { found: false; status: LiveStatus; reason: string };

const MINUTE = 60_000;

export function createLiveFootball(getJson: GetJson, now: () => number = Date.now) {
  const cache = new Map<string, { expiresAt: number; value: Promise<any> }>();
  /** A shared, time-limited fetch; a failed fetch is forgotten so the next call retries. */
  const cached = (url: string, ttlMs: number): Promise<any> => {
    const hit = cache.get(url);
    if (hit && hit.expiresAt > now()) return hit.value;
    const value = getJson(url);
    cache.set(url, { expiresAt: now() + ttlMs, value });
    value.catch(() => cache.delete(url));
    return value;
  };
  const settle = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

  const teamIndex = async (): Promise<EspnTeam[]> => {
    const lists = await Promise.all(
      LIVE_LEAGUES.filter((l) => l.clubs).map((l) =>
        settle(cached(`${ESPN_SITE}/${l.slug}/teams`, 24 * 60 * MINUTE)).then((json) => parseEspnTeams(json, l.slug)),
      ),
    );
    return lists.flat();
  };
  const fpl = async (): Promise<FplData | null> => parseFpl(await settle(cached(FPL_BOOTSTRAP, 30 * MINUTE)));
  const today = () => new Date(now()).toISOString().slice(0, 10);

  async function club(name: string): Promise<LiveClubResult> {
    const index = await teamIndex();
    if (index.length === 0) {
      return { found: false, status: 'failed', missing: [{ item: `Live match data for ${name} (ESPN's club lists didn't answer)`, status: 'failed' }] };
    }
    const team = findClub(name, index);
    if (!team) {
      return {
        found: false,
        status: 'not_covered',
        missing: [{ item: `Live match data for ${name} (no club by that name in the leagues ESPN covers here)`, status: 'not_covered' }],
      };
    }
    const league = LIVE_LEAGUES.find((l) => l.slug === team.league)?.name ?? team.league;
    const isPremierLeague = team.league === 'eng.1';
    const [schedule, upcoming, fplData] = await Promise.all([
      settle(cached(`${ESPN_SITE}/all/teams/${team.id}/schedule`, 20 * MINUTE)),
      settle(cached(`${ESPN_SITE}/all/teams/${team.id}/schedule?fixture=true`, 60 * MINUTE)),
      isPremierLeague ? fpl() : Promise.resolve(null),
    ]);
    const played = parseClubSchedule(schedule, team.id).filter((m) => m.completed).reverse();
    const fixtures = parseClubSchedule(upcoming, team.id).filter((m) => !m.completed).slice(0, NEXT_FIXTURES);
    const lineups = (
      await Promise.all(
        played.slice(0, RECENT_XI_MATCHES).map(async (m) => parseMatchLineup(await settle(cached(`${ESPN_SITE}/all/summary?event=${m.id}`, 24 * 60 * MINUTE)), team.id, m)),
      )
    ).filter((l): l is LiveLineup => l !== null);
    const fplTeam = fplData ? findFplTeam(team, fplData) : null;
    const missing: LiveMissing[] = [
      ...(schedule ? [] : [{ item: `Recent matches for ${team.name} (ESPN didn't answer)`, status: 'failed' as const }]),
      ...(played.length && !lineups.length ? [{ item: `Starting XIs for ${team.name} (ESPN had none for its recent matches)`, status: 'empty' as const }] : []),
      ...(isPremierLeague && !fplTeam
        ? [{ item: `Season starts and injury list for ${team.name} (Fantasy Premier League feed didn't answer)`, status: 'failed' as const }]
        : []),
      ...(!isPremierLeague ? [{ item: `Injury list for ${team.name} (no free source outside the Premier League)`, status: 'not_covered' as const }] : []),
    ];
    if (!played.length && !fixtures.length && !fplTeam) return { found: false, status: schedule ? 'empty' : 'failed', missing };
    const report: LiveClubReport = {
      team: team.name,
      league,
      lineups,
      results: played.slice(0, RECENT_RESULTS),
      fixtures,
      fplPlayers: fplTeam ? fplData!.players.filter((p) => p.teamId === fplTeam.id && p.status !== 'u') : null,
      asOf: today(),
    };
    return { found: true, team: team.name, league, text: formatClubReport(report), missing, report };
  }

  async function player(name: string): Promise<LivePlayerResult> {
    const data = await fpl();
    if (!data) return { found: false, status: 'failed', reason: "the Fantasy Premier League feed didn't answer" };
    const match = findFplPlayer(name, data);
    if (!match) return { found: false, status: 'not_covered', reason: 'not a Premier League player (only Premier League players are covered)' };
    const text = formatFplPlayer(match, name);
    return { found: true, name: text.slice(0, text.indexOf(' — ')), team: match.team, text };
  }

  async function table(leagueName: string, country?: string): Promise<LiveTableResult> {
    const league = findLeague(leagueName, country);
    if (!league) return { found: false, status: 'not_covered', reason: `no table source for "${leagueName}"` };
    const json = await settle(cached(`${ESPN_STANDINGS}/${league.slug}/standings`, 60 * MINUTE));
    const { season, rows } = parseEspnStandings(json);
    if (!rows.length) return { found: false, status: json ? 'empty' : 'failed', reason: `ESPN returned no table for ${league.name}` };
    return { found: true, league: league.name, season, text: formatLeagueTable(rows) };
  }

  return { club, player, table };
}
