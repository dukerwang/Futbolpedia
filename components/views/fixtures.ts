import type { Attributes, ChatDossierRef, GoalkeeperAttributes } from '../../types';
import type { LineupView } from '../../services/lineupView';
import type { ComparisonViewData, RankingViewData, TableRow, TableViewData } from './viewData';

/**
 * Fixtures for the `/dev/blocks` gallery and for any test that draws a view. The shapes are real
 * (a feed's standings rows, a card's `ChatDossierRef` and attributes, a snapshot's XI); the
 * numbers are invented.
 */

// ---------------------------------------------------------------------------------------------
// League tables

const row = (
  rank: number,
  team: string,
  played: number,
  won: number,
  drawn: number,
  goalDiff: number,
  form: string | null,
  group: string | null = null,
): TableRow => ({ rank, team, group, played, won, drawn, lost: played - won - drawn, goalDiff, points: won * 3 + drawn, form });

const PREMIER_LEAGUE_ROWS: TableRow[] = [
  row(1, 'Arsenal', 12, 9, 2, 16, 'WWDWW'),
  row(2, 'Manchester City', 12, 8, 2, 14, 'WWWLW'),
  row(3, 'Liverpool', 12, 8, 1, 9, 'LWWWD'),
  row(4, 'Chelsea', 12, 7, 3, 11, 'WDWWL'),
  row(5, 'Tottenham Hotspur', 12, 7, 2, 7, 'WLWDW'),
  row(6, 'Aston Villa', 12, 7, 1, 5, 'DWWLW'),
  row(7, 'Newcastle United', 12, 6, 3, 6, 'WDLWD'),
  row(8, 'Brighton & Hove Albion', 12, 5, 4, 3, 'DDWDL'),
  row(9, 'Manchester United', 12, 5, 3, 1, 'LWDWL'),
  row(10, 'Brentford', 12, 5, 2, 0, 'WLLWW'),
  row(11, 'Fulham', 12, 4, 4, -1, 'DLDWD'),
  row(12, 'AFC Bournemouth', 12, 4, 3, -2, 'LDWLW'),
  row(13, 'West Ham United', 12, 4, 2, -5, 'LLWDL'),
  row(14, 'Crystal Palace', 12, 3, 5, -3, 'DDLDD'),
  row(15, 'Everton', 12, 3, 4, -6, 'LDDLW'),
  row(16, 'Nottingham Forest', 12, 3, 3, -7, 'LWLLD'),
  row(17, 'Wolverhampton Wanderers', 12, 2, 4, -9, 'DLLDL'),
  row(18, 'Leeds United', 12, 2, 3, -12, 'LLDLL'),
  row(19, 'Burnley', 12, 1, 3, -14, 'LLLDL'),
  row(20, 'Sunderland', 12, 1, 2, -15, 'LLLLD'),
];

/** A plain league, with the clubs the reply is about near both ends of the table. */
export const tableLeague: TableViewData = {
  league: 'Premier League',
  season: '2026-27',
  rows: PREMIER_LEAGUE_ROWS,
  highlight: ['Arsenal', 'Leeds United'],
};

/** Highlights in mid-table: each shows one neighbour either side on a phone. */
export const tableMidTable: TableViewData = {
  ...tableLeague,
  highlight: ['Brighton & Hove Albion', 'Fulham'],
};

/** The feed gave no form and left some numbers out: a column without a strip and dashes for gaps. */
export const tableNoForm: TableViewData = {
  league: 'Eredivisie',
  season: '2026-27',
  highlight: ['PSV Eindhoven'],
  rows: [
    row(1, 'PSV Eindhoven', 11, 9, 1, 21, null),
    row(2, 'Feyenoord', 11, 8, 2, 14, null),
    row(3, 'Ajax', 11, 7, 3, 10, null),
    row(4, 'AZ Alkmaar', 11, 7, 1, 8, null),
    row(5, 'FC Twente', 11, 6, 3, 5, null),
    row(6, 'FC Utrecht', 11, 5, 4, 3, null),
    row(7, 'Sparta Rotterdam', 11, 5, 2, 0, null),
    row(8, 'SC Heerenveen', 11, 4, 3, -1, null),
    row(9, 'NEC Nijmegen', 11, 4, 2, -2, null),
    row(10, 'Go Ahead Eagles', 11, 3, 4, -2, null),
    { ...row(11, 'Fortuna Sittard', 11, 3, 2, -6, null), goalDiff: null },
    { ...row(12, 'Willem II', 11, 2, 3, -8, null), played: null, points: null },
  ],
};

const conference = (group: string, clubs: string[], seed: number): TableRow[] =>
  clubs.map((team, i) => {
    const played = 30;
    const won = Math.max(4, 19 - i + (seed % 3));
    const drawn = 6 + ((i + seed) % 4);
    return row(i + 1, team, played, won, drawn, 24 - i * 4 + seed, ['WWDWL', 'LWWDW', 'DLWWD', 'WLLDW'][(i + seed) % 4], group);
  });

const EASTERN = ['Inter Miami CF', 'FC Cincinnati', 'Philadelphia Union', 'Columbus Crew', 'New York City FC', 'Orlando City', 'Charlotte FC', 'Nashville SC', 'Atlanta United', 'CF Montréal', 'New York Red Bulls', 'Toronto FC'];
const WESTERN = ['Los Angeles FC', 'Seattle Sounders FC', 'Vancouver Whitecaps', 'LA Galaxy', 'Real Salt Lake', 'Minnesota United', 'Austin FC', 'Portland Timbers', 'San Diego FC', 'Houston Dynamo', 'Colorado Rapids', 'Sporting Kansas City'];

/** A competition with two tables. Each group folds on its own on a phone. */
export const tableGrouped: TableViewData = {
  league: 'MLS',
  season: '2026',
  groups: ['Eastern Conference', 'Western Conference'],
  highlight: ['Inter Miami CF', 'Seattle Sounders FC', 'Toronto FC'],
  rows: [...conference('Eastern Conference', EASTERN, 1), ...conference('Western Conference', WESTERN, 2)],
};

/** Small groups never fold: nothing to save. */
export const tableSmallGroups: TableViewData = {
  league: 'Champions League',
  season: '2026-27',
  groups: ['Group A', 'Group B'],
  highlight: ['Barcelona'],
  rows: [
    row(1, 'Barcelona', 4, 3, 1, 6, 'WDWW', 'Group A'),
    row(2, 'Atalanta', 4, 2, 2, 2, 'DWDW', 'Group A'),
    row(3, 'Benfica', 4, 1, 1, -3, 'LDLW', 'Group A'),
    row(4, 'Olympiacos', 4, 0, 1, -5, 'LLDL', 'Group A'),
    row(1, 'Bayern Munich', 4, 4, 0, 9, 'WWWW', 'Group B'),
    row(2, 'Paris Saint-Germain', 4, 2, 1, 3, 'WLDW', 'Group B'),
    row(3, 'PSV Eindhoven', 4, 1, 1, -4, 'LWDL', 'Group B'),
    row(4, 'Galatasaray', 4, 0, 0, -8, 'LLLL', 'Group B'),
  ],
};

// ---------------------------------------------------------------------------------------------
// Cards

const ref = (over: Partial<ChatDossierRef> & Pick<ChatDossierRef, 'name' | 'cardKey'>): ChatDossierRef => over;

export const cards = {
  wirtz: ref({ cardKey: 'florian-wirtz--current', name: 'Florian Wirtz', club: 'Liverpool', position: 'Attacking Midfielder', nationality: 'Germany', age: 23, overall: 88, potential: 92, archetype: 'Free-Roaming Creator', versionLabel: 'Current Form (Nov 2026)' }),
  pedri: ref({ cardKey: 'pedri--current', name: 'Pedri', club: 'Barcelona', position: 'Central Midfielder', nationality: 'Spain', age: 23, overall: 88, potential: 91, archetype: 'Deep-Lying Conductor', versionLabel: 'Current Form (Nov 2026)' }),
  xaviPrime: ref({ cardKey: 'xavi--prime--2008-11', name: 'Xavi Hernández', club: 'Barcelona', position: 'Central Midfielder', nationality: 'Spain', age: 30, overall: 94, potential: 94, archetype: 'Metronome Playmaker', versionLabel: 'Prime Zenith (2008-11)' }),
  zidane: ref({ cardKey: 'zinedine-zidane--era--2000-02', name: 'Zinedine Zidane', club: 'Real Madrid', position: 'Attacking Midfielder', nationality: 'France', age: 29, overall: 95, potential: 95, archetype: 'Elegant Playmaker', versionLabel: 'Real Madrid era (2001-03)' }),
  messi: ref({ cardKey: 'lionel-messi--prime--2009-12', name: 'Lionel Messi', club: 'Barcelona', position: 'Right Winger', nationality: 'Argentina', age: 24, overall: 98, potential: 98, archetype: 'Inside Forward Creator', versionLabel: 'Prime Zenith (2009-12)' }),
  ronaldo: ref({ cardKey: 'cristiano-ronaldo--prime--2013-16', name: 'Cristiano Ronaldo', club: 'Real Madrid', position: 'Left Winger', nationality: 'Portugal', age: 29, overall: 96, potential: 96, archetype: 'Goal-Scoring Winger', versionLabel: 'Prime Zenith (2013-16)' }),
  henry: ref({ cardKey: 'thierry-henry--season--2003-04', name: 'Thierry Henry', club: 'Arsenal', position: 'Centre Forward', nationality: 'France', age: 26, overall: 95, potential: 95, archetype: 'Channel-Running Finisher', versionLabel: 'Season (2003-04)' }),
  cruyff: ref({ cardKey: 'johan-cruyff--prime--1971-74', name: 'Johan Cruyff', club: 'Ajax', position: 'Second Striker', nationality: 'Netherlands', age: 26, overall: 96, potential: 96, archetype: 'Total Football Orchestrator', versionLabel: 'Prime Zenith (1971-74)' }),
  alisson: ref({ cardKey: 'alisson--current', name: 'Alisson', club: 'Liverpool', position: 'Goalkeeper', nationality: 'Brazil', age: 34, overall: 89, potential: 89, archetype: 'Sweeper Keeper', versionLabel: 'Current Form (Nov 2026)' }),
  maignan: ref({ cardKey: 'mike-maignan--current', name: 'Mike Maignan', club: 'AC Milan', position: 'Goalkeeper', nationality: 'France', age: 31, overall: 87, potential: 87, archetype: 'Commanding Shot-Stopper', versionLabel: 'Current Form (Nov 2026)' }),
  rodri: ref({ cardKey: 'rodri--current', name: 'Rodri', club: 'Manchester City', position: 'Defensive Midfielder', nationality: 'Spain', age: 30, overall: 90, potential: 90, archetype: 'Anchor Controller', versionLabel: 'Current Form (Nov 2026)' }),
  longName: ref({ cardKey: 'long--current', name: 'Trent Alexander-Arnold Alexandre', club: 'Brighton & Hove Albion', position: 'Right-Back', nationality: 'England', age: 28, overall: 85, potential: 86, archetype: 'Progressive Wide Passer', versionLabel: 'Current Form (Nov 2026)' }),
};

/** Builds a card's 25 attributes around a level, with the ones that define the player set by hand. */
const outfield = (level: number, over: Partial<Attributes> = {}): Attributes => ({
  finishing: level, firstTouch: level, dribbling: level, vision: level, retention: level, combinationPlay: level, delivery: level,
  progressivePassing: level, footballIQ: level, offensivePositioning: level, defensivePositioning: level, tackling: level,
  interceptions: level, pressingIntensity: level, speed: level, acceleration: level, agility: level, strength: level,
  aerialProwess: level, stamina: level, composure: level, clutch: level, leadership: level, consistency: level, flair: level,
  ...over,
});

const goalkeeper = (level: number, over: Partial<GoalkeeperAttributes> = {}): GoalkeeperAttributes => ({
  reflexes: level, handling: level, distribution: level, commandOfArea: level, GKpositioning: level, sweeping: level, ballPlaying: level,
  ...over,
});

const WIRTZ_ATTRS = outfield(66, {
  finishing: 82, firstTouch: 91, dribbling: 90, vision: 92, retention: 86, combinationPlay: 91, delivery: 84, progressivePassing: 88,
  footballIQ: 89, offensivePositioning: 90, pressingIntensity: 78, speed: 78, acceleration: 84, agility: 90, strength: 58,
  aerialProwess: 52, stamina: 80, composure: 87, clutch: 83, leadership: 62, consistency: 84, flair: 93, tackling: 58, interceptions: 56,
  defensivePositioning: 54,
});
const PEDRI_ATTRS = outfield(66, {
  finishing: 68, firstTouch: 93, dribbling: 87, vision: 91, retention: 94, combinationPlay: 93, delivery: 80, progressivePassing: 89,
  footballIQ: 93, offensivePositioning: 82, defensivePositioning: 72, tackling: 70, interceptions: 76, pressingIntensity: 83,
  speed: 70, acceleration: 78, agility: 88, strength: 55, aerialProwess: 50, stamina: 85, composure: 90, clutch: 79, leadership: 66,
  consistency: 86, flair: 84,
});
const XAVI_ATTRS = outfield(70, {
  finishing: 66, firstTouch: 95, dribbling: 84, vision: 97, retention: 98, combinationPlay: 97, delivery: 90, progressivePassing: 96,
  footballIQ: 98, offensivePositioning: 84, defensivePositioning: 76, tackling: 70, interceptions: 80, pressingIntensity: 80,
  speed: 62, acceleration: 70, agility: 86, strength: 56, aerialProwess: 44, stamina: 88, composure: 94, clutch: 88, leadership: 85,
  consistency: 95, flair: 80,
});
const RODRI_ATTRS = outfield(70, {
  finishing: 70, firstTouch: 88, dribbling: 76, vision: 86, retention: 93, combinationPlay: 88, delivery: 78, progressivePassing: 88,
  footballIQ: 94, offensivePositioning: 72, defensivePositioning: 92, tackling: 90, interceptions: 91, pressingIntensity: 84,
  speed: 66, acceleration: 66, agility: 72, strength: 86, aerialProwess: 82, stamina: 90, composure: 93, clutch: 90, leadership: 84,
  consistency: 94, flair: 62,
});
const ALISSON_ATTRS = goalkeeper(80, { reflexes: 90, handling: 88, distribution: 92, commandOfArea: 90, GKpositioning: 91, sweeping: 90, ballPlaying: 91 });
const MAIGNAN_ATTRS = goalkeeper(80, { reflexes: 92, handling: 86, distribution: 82, commandOfArea: 88, GKpositioning: 87, sweeping: 83, ballPlaying: 80 });

// ---------------------------------------------------------------------------------------------
// Comparisons

/** Two outfield players on the same version, every group drawn. */
export const comparisonOutfield: ComparisonViewData = {
  a: { dossier: cards.wirtz, attributes: WIRTZ_ATTRS },
  b: { dossier: cards.pedri, attributes: PEDRI_ATTRS },
};

/** Different versions: each side wears its own pill, and the caption names neither. */
export const comparisonVersions: ComparisonViewData = {
  a: { dossier: cards.xaviPrime, attributes: XAVI_ATTRS },
  b: { dossier: cards.pedri, attributes: PEDRI_ATTRS },
};

/** Two goalkeepers: one Goalkeeper group. */
export const comparisonGoalkeepers: ComparisonViewData = {
  a: { dossier: cards.alisson, attributes: outfield(0), goalkeeperAttributes: ALISSON_ATTRS },
  b: { dossier: cards.maignan, attributes: outfield(0), goalkeeperAttributes: MAIGNAN_ATTRS },
};

/** A goalkeeper against an outfield player: headline numbers and archetypes only. */
export const comparisonMixed: ComparisonViewData = {
  a: { dossier: cards.alisson, attributes: outfield(0), goalkeeperAttributes: ALISSON_ATTRS },
  b: { dossier: cards.rodri, attributes: RODRI_ATTRS },
};

/** A long name and club, a tie on Overall: nothing overflows, and a tie takes no colour. */
export const comparisonEdge: ComparisonViewData = {
  a: { dossier: cards.longName, attributes: outfield(78) },
  b: { dossier: { ...cards.rodri, overall: 85, potential: 86, cardKey: 'rodri--edge' }, attributes: outfield(78, { tackling: 88 }) },
};

// ---------------------------------------------------------------------------------------------
// Rankings

/** A peak-level ranking with uncarded rows and the moves the cards forced. */
export const rankingPeak: RankingViewData = {
  title: 'Best attacking players of the last twenty years at their peak',
  criterion: 'peak level',
  entries: [cards.messi, cards.ronaldo, cards.henry, { name: 'Ronaldinho' }, cards.zidane, { name: 'Neymar' }, cards.cruyff, { name: 'Kylian Mbappé' }],
  moves: [
    'Lionel Messi above Cristiano Ronaldo: Lionel Messi’s prime card, 98 against Cristiano Ronaldo’s prime card, 96',
    'Thierry Henry above Zinedine Zidane: Thierry Henry’s season card, 95 against Zinedine Zidane’s era card, 95, with the better peer placement',
  ],
};

/** A criterion the model's order stands for: no moves, no footer. */
export const rankingOutput: RankingViewData = {
  title: 'Most goals in a season',
  criterion: 'output',
  entries: [cards.messi, cards.ronaldo, cards.henry, cards.cruyff],
  moves: [],
};

/** Every row uncarded: only names and Scout actions. */
export const rankingUncarded: RankingViewData = {
  title: 'Best young midfielders of the decade',
  criterion: 'mixed',
  entries: [{ name: 'Jude Bellingham' }, { name: 'Jamal Musiala' }, { name: 'Warren Zaïre-Emery' }],
  moves: [],
};

/** The ceiling: fifteen entries, long names, and a title that wraps on a phone. */
export const rankingLong: RankingViewData = {
  title: 'The most complete midfielders across every era, ranked by how well they did everything at once',
  criterion: 'versatility',
  entries: [
    cards.xaviPrime, cards.zidane, cards.rodri, cards.pedri, cards.wirtz, cards.longName, cards.messi, cards.cruyff,
    { name: 'Andrés Iniesta' }, { name: 'Steven Gerrard' }, { name: 'Lothar Matthäus' }, { name: 'Michel Platini' },
    { name: 'Paul Scholes' }, { name: 'Johan Neeskens' }, { name: 'Roy Keane' },
  ],
  moves: [],
};

// ---------------------------------------------------------------------------------------------
// Pitch

const FOUR_THREE_THREE = ['G', 'LB', 'CD-L', 'CD-R', 'RB', 'CM-L', 'CM', 'CM-R', 'LF', 'F', 'RF'];
const NAMES = ['David Raya', 'Riccardo Calafiori', 'William Saliba', 'Gabriel Magalhães', 'Ben White', 'Martin Zubimendi', 'Declan Rice', 'Martin Ødegaard', 'Gabriel Martinelli', 'Viktor Gyökeres', 'Bukayo Saka'];

export const pitchLineup: LineupView = {
  club: 'Arsenal',
  league: 'Premier League',
  asOf: '2026-11-14',
  formation: '4-3-3',
  xiBasis: 'lineups',
  matchesRead: 4,
  xi: FOUR_THREE_THREE.map((role, i) => ({
    role,
    name: NAMES[i],
    starts: 4,
    ...(role === 'CM' ? { rotation: 'Mikel Merino' } : {}),
    ...(role === 'LF' ? { note: 'a knock in training, back for Saturday' } : {}),
  })),
  out: [
    { name: 'Kai Havertz', note: 'hamstring, back around late November' },
    { name: 'Leandro Trossard', note: 'illness' },
  ],
};

/** A season-starts XI (no recent lineups), one slot nobody holds, and nobody out. */
export const pitchSeasonStarts: LineupView = {
  club: 'Nottingham Forest',
  league: 'Premier League',
  asOf: '2026-11-14',
  formation: null,
  xiBasis: 'season_starts',
  matchesRead: 0,
  xi: ['GK', 'D', 'D', 'D', 'D', 'M', 'M', 'M', 'F', 'F', 'F'].map((role, i) => ({
    role,
    name: i === 8 ? null : `Player ${i + 1}`,
    starts: i === 8 ? 0 : 9,
  })),
  out: [],
};
