import { LIVE_LEAGUES, nameScore, scoreValue } from '../liveFootball';

/**
 * The knowledge base's team strength: an Elo rating for clubs, computed by code from ESPN results.
 * It measures results (who was beaten, where and by how much), not squad quality or style. No model
 * call is involved, nothing is fitted to data, and every constant is in `ELO` below. This file is
 * pure: parsing a club's schedule, the rating, the stored snapshots and how a stored snapshot is
 * read. Fetching and storing are in `teamStrengthBuild.ts` and `teamStrengthStore.ts`.
 */

// ---------------------------------------------------------------------------------------------
// Constants

/**
 * The published football Elo formulas, fixed here and never fitted:
 * - The expected score, the 100-point home advantage and the goal-difference multiplier (1 for a
 *   draw or a one-goal win, 1.5 for two goals, (11 + margin) / 8 for three or more) are the World
 *   Football Elo Ratings' (eloratings.net).
 * - K is 20 for a league match, the weight ClubElo used for club football. The other two keep
 *   eloratings.net's importance steps in proportion: its "other tournaments", "qualifiers and major
 *   tournaments" and "continental finals" weights are 30, 40 and 50, so with a league match as the
 *   middle step they become 15 (domestic cup), 20 (league) and 25 (continental).
 * - Every club starts at 1500, so leagues separate only through matches between their clubs.
 */
export const ELO = {
  initial: 1500,
  homeAdvantage: 100,
  k: { league: 20, domestic_cup: 15, continental: 25 },
} as const;

/** The first season ESPN's results cover (2003-04). It is burn-in: it rates nothing. */
export const FIRST_RESULTS_SEASON = 2003;
/** The first day with a rating: the start of 2004-05. */
export const RATINGS_START = '2004-07-01';
/** Below this many counted matches a rating is rough, and the club isn't ranked. */
export const RANKED_MIN_MATCHES = 30;
/** A club that has played within this many days of a date is rated on it. The longest 2020 break fits. */
export const ACTIVE_DAYS = 200;
/** A league match this recent says which league a club is in; longer than any off-season. */
export const LEAGUE_DAYS = 150;
/** How many of the highest-rated clubs a reading shows for context. */
export const TOP_CLUBS = 5;

// ---------------------------------------------------------------------------------------------
// Dates and seasons

const DAY_MS = 24 * 60 * 60 * 1000;
export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * The last day of a season, by the year it starts in: 30 June, except 2019-20, which the pandemic
 * pushed to the Champions League final on 23 August 2020.
 */
export const seasonEndDate = (start: number): string => (start === 2019 ? '2020-08-23' : `${start + 1}-06-30`);

/** The start year of the season a date falls in. */
export function seasonOfDate(date: string): number {
  const year = Number(date.slice(0, 4));
  if (date <= seasonEndDate(year - 1)) return year - 1;
  return year;
}

export const seasonLabel = (start: number): string => `${start}-${String((start + 1) % 100).padStart(2, '0')}`;

// ---------------------------------------------------------------------------------------------
// Competitions

export type CompetitionKind = 'league' | 'domestic_cup' | 'continental';

/**
 * The club cups ESPN lists, super cups and state championships included. Anything that isn't here,
 * isn't a continental competition and isn't a league is left out, so a pre-season trophy under a
 * country's code never counts. A build logs the slugs it left out.
 */
const DOMESTIC_CUPS = new Set([
  'arg.copa', 'arg.copa_de_la_superliga', 'arg.supercopa', 'arg.supercopa.internacional', 'arg.trofeo_de_la_campeones',
  'bol.copa', 'bra.copa_do_brazil', 'bra.supercopa_do_brazil', 'bra.camp.carioca', 'bra.camp.gaucho', 'bra.camp.mineiro', 'bra.camp.paulista',
  'chi.copa_chi', 'chi.super_cup', 'col.copa', 'col.superliga',
  'eng.charity', 'eng.fa', 'eng.fa_qual', 'eng.league_cup', 'eng.trophy',
  'esp.copa_del_rey', 'esp.super_cup', 'fra.coupe_de_france', 'fra.super_cup', 'ger.dfb_pokal', 'ger.super_cup',
  'ita.coppa_italia', 'ita.super_cup', 'ksa.kings.cup', 'mex.campeon', 'ned.cup', 'ned.supercup', 'par.1.supercopa',
  'por.taca.portugal', 'sco.challenge', 'sco.cis', 'sco.tennents', 'sco.tennents_qual', 'usa.open', 'usa.usl.l1.cup',
]);

/** Club competitions between countries, in Europe and elsewhere. `uefa.uefa` is the old UEFA Cup. */
const CONTINENTAL = new Set([
  'uefa.champions', 'uefa.champions_qual', 'uefa.europa', 'uefa.europa_qual', 'uefa.europa.conf', 'uefa.europa.conf_qual',
  'uefa.uefa', 'uefa.intertoto', 'uefa.super_cup',
  'conmebol.libertadores', 'conmebol.sudamericana', 'conmebol.recopa',
  'concacaf.champions', 'concacaf.champions_cup', 'concacaf.leagues.cup', 'concacaf.central.american.cup', 'campeones.cup',
  'afc.champions', 'afc.champions_qual', 'afc.cup', 'afc.cup_qual', 'afc.cupq', 'caf.champions', 'caf.confed',
  'fifa.cwc', 'fifa.intercontinental.cup', 'fifa.intercontinental_cup',
]);

/** A numbered domestic league ("eng.1"), which is what says where a club plays. */
const NUMBERED_LEAGUE = /^[a-z]{3}\.\d$/;
/** Promotion and relegation play-offs, and the lower US leagues: leagues, but not where a club "plays". */
const OTHER_LEAGUE = /^[a-z]{3}\.(?:\d\.)?(?:promotion\.relegation|playoff\.relegation|ply\.rel)$|^usa\.usl\.(?:1|l1)$/;

export function competitionKind(slug: string): CompetitionKind | null {
  if (CONTINENTAL.has(slug)) return 'continental';
  if (DOMESTIC_CUPS.has(slug)) return 'domestic_cup';
  if (NUMBERED_LEAGUE.test(slug) || OTHER_LEAGUE.test(slug)) return 'league';
  return null;
}

/** Played on neither side's ground, whatever ESPN's flag says (it is false for most finals). */
const ALWAYS_NEUTRAL = new Set(['eng.charity', 'uefa.super_cup', 'fifa.cwc', 'fifa.intercontinental.cup', 'fifa.intercontinental_cup']);

/** The countries ESPN covers outside UEFA. Their clubs rarely meet European ones. */
const OUTSIDE_UEFA = new Set(['arg', 'aus', 'bol', 'bra', 'chi', 'chn', 'col', 'crc', 'ecu', 'gua', 'hon', 'ind', 'jpn', 'ksa', 'mex', 'par', 'per', 'rsa', 'slv', 'uru', 'usa', 'ven']);
export const isUefaLeague = (slug: string): boolean => !OUTSIDE_UEFA.has(slug.slice(0, 3));

export const leagueName = (slug: string): string => LIVE_LEAGUES.find((l) => l.slug === slug)?.name ?? slug;

// ---------------------------------------------------------------------------------------------
// Parsing ESPN

export interface Side {
  id: string;
  name: string;
}

export interface StrengthMatch {
  id: string;
  /** The kickoff day (UTC). */
  date: string;
  /** ESPN's kickoff time, to order matches played on one day. */
  kickoff: string;
  competition: string;
  kind: CompetitionKind;
  home: Side;
  away: Side;
  /** Goals in the match, extra time included. A penalty shoot-out is never part of them. */
  homeGoals: number;
  awayGoals: number;
  neutral: boolean;
}

/**
 * The completed matches in one club's `/all/teams/{id}/schedule?season=` answer, and the
 * competitions it holds that nothing counts. ESPN keeps a shoot-out apart from the score
 * (`shootoutScore`, which older seasons lack altogether, under a `STATUS_FINAL_PEN` status), so a
 * tie settled on penalties counts by the goals played: a level match is a draw.
 */
export function parseResults(json: any): { matches: StrengthMatch[]; skipped: string[] } {
  const events = Array.isArray(json?.events) ? json.events : [];
  const matches: StrengthMatch[] = [];
  const skipped = new Set<string>();
  for (const e of events) {
    const slug = typeof e?.league?.slug === 'string' ? e.league.slug : '';
    const kind = competitionKind(slug);
    if (!kind) {
      if (slug) skipped.add(slug);
      continue;
    }
    const comp = e?.competitions?.[0];
    if (!comp?.status?.type?.completed || typeof e?.date !== 'string' || Number.isNaN(Date.parse(e.date))) continue;
    const competitors: any[] = Array.isArray(comp.competitors) ? comp.competitors : [];
    const home = competitors.find((c) => c?.homeAway === 'home');
    const away = competitors.find((c) => c?.homeAway === 'away');
    const side = (c: any): Side | null => {
      const id = c?.team?.id ?? c?.id;
      const name = c?.team?.displayName;
      return id && typeof name === 'string' && name ? { id: String(id), name } : null;
    };
    const h = home && side(home);
    const a = away && side(away);
    const homeGoals = scoreValue(home?.score);
    const awayGoals = scoreValue(away?.score);
    if (!h || !a || h.id === a.id || homeGoals === null || awayGoals === null) continue;
    const kickoff = new Date(e.date).toISOString();
    const final = kind !== 'league' && /^final$/i.test(String(e?.seasonType?.name ?? '').trim());
    matches.push({
      id: String(e.id),
      date: kickoff.slice(0, 10),
      kickoff,
      competition: slug,
      kind,
      home: h,
      away: a,
      homeGoals,
      awayGoals,
      neutral: comp.neutralSite === true || ALWAYS_NEUTRAL.has(slug) || final,
    });
  }
  return { matches, skipped: [...skipped] };
}

/** The clubs in a league's table for one season, from ESPN's standings: who to fetch that season. */
export function parseSeasonClubs(json: any): Side[] {
  const groups: any[] = Array.isArray(json?.children) ? json.children : json?.standings ? [json] : [];
  const clubs = new Map<string, Side>();
  for (const g of groups) {
    for (const entry of g?.standings?.entries ?? []) {
      const id = entry?.team?.id;
      const name = entry?.team?.displayName;
      if (id && typeof name === 'string') clubs.set(String(id), { id: String(id), name });
    }
  }
  return [...clubs.values()];
}

// ---------------------------------------------------------------------------------------------
// The rating

export interface ClubState {
  id: string;
  name: string;
  rating: number;
  matches: number;
  lastMatch: string;
  /** The numbered league of its latest league match, and when that was. */
  league: string | null;
  leagueMatch: string | null;
  /** Whether it has played in a UEFA competition. */
  europe: boolean;
}

/** The home side's expected score: its chance of winning plus half its chance of drawing. */
export function expectedHome(homeRating: number, awayRating: number, neutral = false): number {
  const diff = homeRating - awayRating + (neutral ? 0 : ELO.homeAdvantage);
  return 1 / (10 ** (-diff / 400) + 1);
}

export function goalMultiplier(margin: number): number {
  const n = Math.abs(margin);
  return n <= 1 ? 1 : n === 2 ? 1.5 : (11 + n) / 8;
}

/** The points the home side gains (and the away side loses) from one match. */
export function ratingChange(homeRating: number, awayRating: number, match: Pick<StrengthMatch, 'kind' | 'homeGoals' | 'awayGoals' | 'neutral'>): number {
  const margin = match.homeGoals - match.awayGoals;
  const result = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
  return ELO.k[match.kind] * goalMultiplier(margin) * (result - expectedHome(homeRating, awayRating, match.neutral));
}

/** Applies one match to both clubs. Matches must arrive in date order. */
export function applyMatch(clubs: Map<string, ClubState>, match: StrengthMatch): void {
  const state = (side: Side): ClubState => {
    let s = clubs.get(side.id);
    if (!s) {
      s = { id: side.id, name: side.name, rating: ELO.initial, matches: 0, lastMatch: match.date, league: null, leagueMatch: null, europe: false };
      clubs.set(side.id, s);
    }
    return s;
  };
  const home = state(match.home);
  const away = state(match.away);
  const change = ratingChange(home.rating, away.rating, match);
  home.rating += change;
  away.rating -= change;
  for (const [s, side] of [[home, match.home], [away, match.away]] as const) {
    s.name = side.name;
    s.matches += 1;
    s.lastMatch = match.date;
    if (NUMBERED_LEAGUE.test(match.competition)) {
      s.league = match.competition;
      s.leagueMatch = match.date;
    }
    if (match.competition.startsWith('uefa.')) s.europe = true;
  }
}

export const byDate = (a: StrengthMatch, b: StrengthMatch): number => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id);

// ---------------------------------------------------------------------------------------------
// Stored snapshots

/** A month's opening, a season's end, or the latest state of the season in progress. */
export type SnapshotKind = 'month' | 'season_end' | 'latest';

/** One row of `kb_team_strength`: a club's rating in one snapshot. */
export interface StrengthRow {
  team_id: string;
  club: string;
  league: string | null;
  league_match: string | null;
  in_europe: boolean;
  rated_on: string;
  kind: SnapshotKind;
  rating: number;
  matches: number;
  last_match: string;
}

export interface Snapshot {
  date: string;
  kind: SnapshotKind;
  rows: StrengthRow[];
}

const toRow = (s: ClubState, date: string, kind: SnapshotKind): StrengthRow => ({
  team_id: s.id,
  club: s.name,
  league: s.league,
  league_match: s.leagueMatch,
  in_europe: s.europe,
  rated_on: date,
  kind,
  rating: Math.round(s.rating * 100) / 100,
  matches: s.matches,
  last_match: s.lastMatch,
});

const fromRow = (r: StrengthRow): ClubState => ({
  id: r.team_id,
  name: r.club,
  rating: r.rating,
  matches: r.matches,
  lastMatch: r.last_match,
  league: r.league,
  leagueMatch: r.league_match,
  europe: r.in_europe,
});

/** A season-end snapshot to carry on from: every club's state after all matches up to its date. */
export interface Checkpoint {
  date: string;
  rows: StrengthRow[];
}

/**
 * The snapshots the matches produce up to `today`: on the first of each month the ratings after
 * every earlier day's matches (the clubs that have played within `ACTIVE_DAYS`), at each finished
 * season's end every club seen so far, and the latest state, dated today. A season's end on 30 June
 * stands for 1 July too. Nothing is dated before `RATINGS_START`. With a checkpoint, only matches
 * after its date count and only later snapshots come out. `through` stops at a past day, with no
 * latest state: what a build stores part-way. `matches` may arrive in any order and repeat: each
 * id counts once.
 */
export function computeSnapshots(matches: StrengthMatch[], options: { today: string; checkpoint?: Checkpoint | null; through?: string }): Snapshot[] {
  const { today, checkpoint, through } = options;
  const after = checkpoint?.date ?? '';
  const clubs = new Map<string, ClubState>((checkpoint?.rows ?? []).map((r) => [r.team_id, fromRow(r)]));
  const unique = [...new Map(matches.map((m) => [m.id, m])).values()].filter((m) => m.date > after && m.date <= today).sort(byDate);

  /** Each snapshot with the first day whose matches it leaves out. */
  const due: { date: string; kind: SnapshotKind; cut: string }[] = [];
  const ends = new Set<string>();
  for (let s = FIRST_RESULTS_SEASON + 1; seasonEndDate(s) < today; s++) {
    ends.add(seasonEndDate(s));
    if (seasonEndDate(s) > after) due.push({ date: seasonEndDate(s), kind: 'season_end', cut: addDays(seasonEndDate(s), 1) });
  }
  for (let d = RATINGS_START; d <= today; ) {
    if (d > after && !ends.has(addDays(d, -1))) due.push({ date: d, kind: 'month', cut: d });
    const [y, m] = d.split('-').map(Number);
    d = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  due.sort((a, b) => a.cut.localeCompare(b.cut));
  const wanted = through ? due.filter((b) => b.date <= through) : due;

  let next = 0;
  const applyUntil = (cut: string) => {
    while (next < unique.length && unique[next].date < cut) applyMatch(clubs, unique[next++]);
  };
  const take = (date: string, kind: SnapshotKind): Snapshot => ({
    date,
    kind,
    rows: [...clubs.values()].filter((c) => kind !== 'month' || daysBetween(c.lastMatch, date) <= ACTIVE_DAYS).map((c) => toRow(c, date, kind)),
  });
  const out: Snapshot[] = [];
  for (const b of wanted) {
    applyUntil(b.cut);
    out.push(take(b.date, b.kind));
  }
  if (!through && today >= RATINGS_START) {
    applyUntil(addDays(today, 1));
    out.push(take(today, 'latest'));
  }
  return out.filter((s) => s.rows.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Reading a snapshot

/** The league a club is in on a row's date: its latest league match's, while that is recent. */
export const leagueOn = (row: StrengthRow): string | null =>
  row.league && row.league_match && daysBetween(row.league_match, row.rated_on) <= LEAGUE_DAYS ? row.league : null;

const activeOn = (row: StrengthRow): boolean => daysBetween(row.last_match, row.rated_on) <= ACTIVE_DAYS;

/** Whether a club's ratings are linked to European football: by its league's country, else by having played in UEFA competition. */
const inEuropePool = (row: StrengthRow): boolean => (row.league ? isUefaLeague(row.league) : row.in_europe);

export interface RatedClub {
  teamId: string;
  club: string;
  rating: number;
  matches: number;
}

export interface TeamStrengthReport {
  found: true;
  club: RatedClub;
  /** The day the stored snapshot describes. */
  asOf: string;
  kind: SnapshotKind;
  /** The season `asOf` falls in. */
  season: string;
  /** Fewer than `RANKED_MIN_MATCHES` matches counted: the figure is rough and the club isn't ranked. */
  rough: boolean;
  league: string | null;
  /** The average over the league's rated clubs on that date. */
  leagueAverage: { league: string; rating: number; clubs: number } | null;
  /** Where the club stands among rated clubs with enough matches, in `pool`. */
  rank: { position: number; of: number } | null;
  /** "Europe", or the league a club outside Europe is compared within. */
  pool: string;
  /** Set for a club outside Europe: its ratings don't compare with European ones. */
  outsideEurope: boolean;
  /** The highest-rated clubs in the same pool. */
  top: RatedClub[];
}

export type TeamStrengthResult =
  | TeamStrengthReport
  | { found: false; status: 'empty' | 'not_covered' | 'failed'; reason: string };

const asRated = (r: StrengthRow): RatedClub => ({ teamId: r.team_id, club: r.club, rating: Math.round(r.rating), matches: r.matches });

/**
 * The club a name means among a snapshot's rows, read the way the live lookups read names
 * (`nameScore`). `aliases` adds the other names ESPN's club lists give a team. Among equally good
 * names a club that is playing wins, then the one in the higher-priority league, then the one with
 * more matches.
 */
export function findRatedClub(query: string, rows: StrengthRow[], aliases: Map<string, string[]> = new Map()): StrengthRow | null {
  const priority = (r: StrengthRow) => {
    const i = LIVE_LEAGUES.findIndex((l) => l.slug === r.league);
    return i < 0 ? LIVE_LEAGUES.length : i;
  };
  const scored = rows
    .map((row) => ({ row, score: nameScore(query, [row.club, ...(aliases.get(row.team_id) ?? [])]) }))
    .filter((c) => c.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(activeOn(b.row)) - Number(activeOn(a.row)) ||
        priority(a.row) - priority(b.row) ||
        b.row.matches - a.row.matches,
    );
  return scored[0]?.row ?? null;
}

/** One club's reading from every row of one snapshot. */
export function readSnapshot(query: string, rows: StrengthRow[], aliases?: Map<string, string[]>): TeamStrengthResult {
  const date = rows[0]?.rated_on;
  if (!date) return { found: false, status: 'empty', reason: 'no ratings are stored for that date' };
  const active = rows.filter(activeOn);
  const row = findRatedClub(query, rows, aliases);
  if (!row || !activeOn(row)) {
    return {
      found: false,
      status: 'empty',
      reason: row
        ? `${row.club} has no rating on ${date}: it had played no counted match since ${row.last_match}`
        : `no rated club matches "${query}" on ${date}; ratings cover the clubs in the app's leagues and the clubs they met in them, in cups and in continental competitions`,
    };
  }
  const europe = inEuropePool(row);
  const pool = europe ? active.filter(inEuropePool) : active.filter((r) => r.league === row.league && !inEuropePool(r));
  const ranked = pool.filter((r) => r.matches >= RANKED_MIN_MATCHES).sort((a, b) => b.rating - a.rating || a.team_id.localeCompare(b.team_id));
  const position = ranked.findIndex((r) => r.team_id === row.team_id);
  const league = leagueOn(row);
  const peers = league ? active.filter((r) => leagueOn(r) === league) : [];
  return {
    found: true,
    club: asRated(row),
    asOf: date,
    kind: row.kind,
    season: seasonLabel(seasonOfDate(date)),
    rough: row.matches < RANKED_MIN_MATCHES,
    league: league ? leagueName(league) : null,
    leagueAverage:
      league && peers.length > 1
        ? { league: leagueName(league), rating: Math.round(peers.reduce((sum, r) => sum + r.rating, 0) / peers.length), clubs: peers.length }
        : null,
    rank: position >= 0 ? { position: position + 1, of: ranked.length } : null,
    pool: europe ? 'Europe' : row.league ? leagueName(row.league) : 'its own matches',
    outsideEurope: !europe,
    top: ranked.slice(0, TOP_CLUBS).map(asRated),
  };
}

// ---------------------------------------------------------------------------------------------
// What a request asks for

export type WantedDate = { date: string } | { refused: { status: 'empty' | 'not_covered'; reason: string } };

const TOO_EARLY = 'ratings start in 2004-05 (ESPN results start in 2003-04, which only warms the ratings up), so earlier dates have none';

/**
 * The day a request means: a date as given, a finished season's last day, or today for the season in
 * progress or when neither is given. `seasonStart` is the parsed season's first year.
 */
export function wantedDate(request: { date?: string; seasonStart?: number | null }, today: string): WantedDate {
  if (request.date) {
    const d = request.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || addDays(d, 0) !== d) {
      return { refused: { status: 'empty', reason: `"${d}" isn't a date; write it as YYYY-MM-DD` } };
    }
    if (d < RATINGS_START) return { refused: { status: 'not_covered', reason: TOO_EARLY } };
    return { date: d > today ? today : d };
  }
  if (request.seasonStart !== undefined && request.seasonStart !== null) {
    const s = request.seasonStart;
    if (s <= FIRST_RESULTS_SEASON) return { refused: { status: 'not_covered', reason: TOO_EARLY } };
    if (s > seasonOfDate(today)) return { refused: { status: 'empty', reason: `${seasonLabel(s)} hasn't started` } };
    return { date: seasonEndDate(s) < today ? seasonEndDate(s) : today };
  }
  return { date: today };
}
