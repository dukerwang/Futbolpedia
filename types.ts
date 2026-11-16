import type { ReactNode } from 'react';
import type { LineupView } from './services/lineupView';

export interface BasicInfo {
  name: string;
  age: number;
  nationality: string;
  club: string;
  position: string;
  height?: string;
  weight?: string;
}

export interface Ratings {
  overall: number;
  potential: number;
}

export interface Attributes {
  finishing: number;
  firstTouch: number;
  dribbling: number;
  vision: number;
  retention: number;
  combinationPlay: number;
  delivery: number;
  progressivePassing: number;
  footballIQ: number;
  offensivePositioning: number;
  defensivePositioning: number;
  tackling: number;
  interceptions: number;
  pressingIntensity: number;
  speed: number;
  acceleration: number;
  agility: number;
  strength: number;
  aerialProwess: number;
  stamina: number;
  composure: number;
  clutch: number;
  leadership: number;
  consistency: number;
  flair: number;
}

export interface GoalkeeperAttributes {
  reflexes: number;
  handling: number;
  distribution: number;
  commandOfArea: number;
  GKpositioning: number;
  sweeping: number;
  ballPlaying: number;
}

export interface PlaystyleAndRole {
  playstyle: {
    archetype: string;
    description: string;
  };
  bestRoles: string[];
}

export type DossierVersionType = 'current' | 'prime' | 'season_snapshot' | 'era' | 'retro';

export interface DossierVersion {
  id: string;
  type: DossierVersionType;
  label: string;
  evaluationDate: string; // ISO YYYY-MM-DD (e.g. "2026-10-25" or peak snapshot date)
  seasonOrEra: string; // e.g. "2026-27", "2008-09", or a prime or era window "2003-06"
  peakContext?: string | null;
  /**
   * A prime or era card's window: its first and last season (YYYY-YY). For a prime, the player's
   * best stretch; for an era, the seasons that define the version the user named.
   */
  primeWindow?: { startSeason: string; endSeason: string } | null;
  /** An era card's name for its version, as the user put it (a club, role or career phase). */
  qualifier?: string | null;
}

export type EvidenceGrade = 'A' | 'B' | 'C';

export interface DossierConfidence {
  grade: EvidenceGrade;
  sampleSize: string;
  dataGaps: string[];
  verdict: string;
}

export interface ScoutingDebate {
  caseForHigher: string;
  caseForLower: string;
}

export interface ArchetypeAnalysis {
  playsLikeBlend: string;
  holisticProjection: string;
  playstyleTags: string[];
  tacticalSynergy: string;
  tacticalKryptonite: string;
}

export type AgeCurvePhase =
  | 'Emergent Runway'
  | 'Prime Ascent'
  | 'Apex Window'
  | 'Post-Peak Adaptation'
  | 'Late Career Mastery';

export interface AgeCurveOutlook {
  phase: AgeCurvePhase;
  trajectoryNote: string;
}

export interface DefiningMoment {
  year: string;
  title: string;
  description: string;
}

/**
 * Marks a user's accepted challenge of a shared card. A revision lives only in that user's
 * library and conversations; the shared card changes only at its next monthly re-rating.
 */
export interface DossierRevision {
  /** Card key of the shared card this revision patches. */
  baseCardKey: string;
  revisedAt: number;
}

export interface PeerPlacement {
  betterThan: string[];
  levelWith: string[];
  notAsGoodAs: string[];
}

export interface PlayerProfile {
  basicInfo: BasicInfo;
  ratings: Ratings;
  strengths: string[];
  weaknesses: string[];
  attributes: Attributes;
  goalkeeperAttributes?: GoalkeeperAttributes;
  shortBio: string;
  /**
   * One sentence (at most SHARE_LINE_MAX_CHARS) saying what the card concludes about the player,
   * read on its own as a link preview. Optional: cards rated before it existed have none.
   */
  shareLine?: string;
  playstyleAndRole: PlaystyleAndRole;
  latestUpdate: string;
  /** YYYY-MM-DD of the last Latest Update refresh; absent means it dates from the card itself. */
  latestUpdateAsOf?: string;
  createdAt?: number;
  /** When a prime card was re-rated from scratch (ms); the newest re-rating replaces the shared card. */
  rerateAt?: number;
  /** Set when this is the user's revision of a shared card rather than the shared card itself */
  revision?: DossierRevision;
  /** Formal card versioning metadata */
  version?: DossierVersion;
  /** ISO date string (YYYY-MM-DD) representing the exact date of this evaluation snapshot */
  evaluationDate?: string;
  /** Key attribute ceiling spikes persisted for card-level prominence */
  signatureSpikes?: string[];
  /** Key attribute flaws persisted for card-level prominence */
  genuineFlaws?: string[];
  /** Real-world positional peer benchmarks recorded at calibration */
  peerBenchmark?: string;
  /** Calibrated peers this version was judged better than, level with, or below */
  peerPlacement?: PeerPlacement;
  /** Evidence grade and sample size evaluation */
  confidence?: DossierConfidence;
  /**
   * Data gaps a stored record filled after the card was rated (card review's fill_facts,
   * services/cardReview.ts): the gap as the card listed it, the fact, its source and the day.
   * The rating doesn't change.
   */
  filledGaps?: { gap: string; fact: string; source: string; filledOn: string }[];
  /** Dialectical arguments for higher or lower rating */
  scoutingDebate?: ScoutingDebate;
  /** Holistic archetype projection and tactical synergies */
  archetypeAnalysis?: ArchetypeAnalysis;
  /** Career development phase and trajectory projection */
  ageCurve?: AgeCurveOutlook;
  /** Defining career moments (optional for veterans/legends) */
  definingMoments?: DefiningMoment[];
  /**
   * The player's club manager from the live manager lookup (services/clubManagers.ts), attached
   * after synthesis. The model never writes it; card prose doesn't name managers.
   */
  clubManager?: ClubManagerSnapshot;
}

export interface ClubManagerSnapshot {
  name: string;
  /** YYYY-MM-DD the lookup confirmed it. */
  verifiedOn: string;
  sourceUrl?: string | null;
}

export type GaffaTradeVerdict = 'hold' | 'lean_hold' | 'toss_up' | 'lean_take' | 'take';

/** Code-derived trade lock shown in Gaffa chat. Scores 1–5. */
export interface GaffaTradeScorecard {
  outgoing: string;
  incoming: string;
  incoming_cash_eur_m: number;
  outgoing_cash_eur_m?: number;
  outgoing_club: string;
  incoming_club: string;
  involved_slots?: string[];
  roster_capacity_note?: string;
  replacement: number;
  coverage: number;
  cash_deployable: number;
  starter_leverage: number;
  replacement_note: string;
  coverage_note: string;
  cash_note: string;
  leverage_note: string;
  what_would_flip: string;
  verdict: GaffaTradeVerdict;
  confidence: 'low' | 'medium';
  net: number;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  content: string | PlayerProfile | ReactNode;
  image?: string; // base64 encoded image string
  timestamp?: number;
  /** Card key of the dossier this AI message announced, so history can carry the card itself. */
  dossierKey?: string;
  /** Present on Gaffa asset-trade replies after the scorecard path runs. */
  gaffaScorecard?: GaffaTradeScorecard;
  /** Compact snapshot of the dossier this reply produced, rendered as an in-chat card. */
  dossier?: ChatDossierRef;
  /** Marks a failed reply so the UI renders it as an error with a retry action. */
  isError?: boolean;
  /** Present on a user message sent with the Rate command: the rating it asked for. */
  rating?: RatingRequest;
  /** The @ mentions in a user message ("@Florian Wirtz"), each naming a card in the conversation. */
  mentions?: string[];
  /** Cards a chat reply shows under its prose. */
  cards?: ChatDossierRef[];
  /** Players a chat reply discussed who have no card yet, offered to Scout. */
  scoutOffers?: string[];
  /** First-choice XIs a reply about the present draws under its prose (`PitchView`). */
  lineups?: LineupView[];
  /** A reply that asks which reading the user meant: its question is the prose, its options are chips. */
  ask?: AskPrompt;
  /** A reply whose question deserved a longer look: a chip reruns the message in deep mode. */
  goDeeper?: GoDeeper;
  /**
   * A new reply as an ordered list of blocks (`services/replyBlocks`). The legacy fields above
   * (`gaffaScorecard`, `cards`, `scoutOffers`, `lineups`, `ask`, `goDeeper`) stay for conversations
   * stored before blocks; `blocksOf` reads either. `content` stays the reply's full prose.
   */
  blocks?: ReplyBlock[];
}

/** What each kind of reply block carries. Adding a kind is one line here plus its registry entry. */
export interface ReplyBlockData {
  pitch: LineupView;
  card: ChatDossierRef;
  scoutOffer: { name: string };
  ask: AskPrompt;
  goDeeper: GoDeeper;
  scorecard: GaffaTradeScorecard;
}

export type ReplyBlockKind = keyof ReplyBlockData;

/** `pending` while a view's data loads, then `ready`, or `failed` (drawn as nothing, never stored). */
export type ReplyBlockStatus = 'pending' | 'ready' | 'failed';

/** A stretch of the reply's prose (markdown). */
export interface ProseBlock {
  kind: 'prose';
  id: string;
  text: string;
}

/**
 * A block of kind `K` other than prose. A `pending` or `failed` block carries no data; only a
 * `ready` one does.
 */
export type DataBlock<K extends ReplyBlockKind = ReplyBlockKind> = {
  [P in K]:
    | { kind: P; id: string; status: 'ready'; data: ReplyBlockData[P] }
    | { kind: P; id: string; status: 'pending' | 'failed'; data?: undefined };
}[K];

/** A block whose data has arrived. */
export type ReadyBlock<K extends ReplyBlockKind = ReplyBlockKind> = Extract<DataBlock<K>, { status: 'ready' }>;

/** One piece of a reply, in the order the reader sees it. */
export type ReplyBlock = ProseBlock | DataBlock;

/** What the writer asks when a message reads two ways that would change the answer. */
export interface AskPrompt {
  question: string;
  /** Two to four short replies, each one a complete answer to the question, sent as the next message. */
  options: string[];
}

/** The writer's note that the fast path's budget left something a deep run would settle. */
export interface GoDeeper {
  /** What stayed unverified or unexplored; the chip's tooltip. */
  reason: string;
}

/**
 * A rating asked for with the Rate command rather than typed as a chat turn. `auto` rates his
 * current form, or his prime when he has retired; `current` is his current form either way (a
 * current card picked from the suggestions). Season and era requests name the version.
 */
export interface RatingRequest {
  name: string;
  edition: 'auto' | 'current' | 'prime' | 'season' | 'era';
  /** YYYY-YY, for `season`. */
  season?: string;
  /** The era's name as the card stores it (`version.qualifier`), for `era`. */
  era?: string;
}

/** Lightweight dossier pointer stored on chat messages (the full profile lives in the dossier store). */
export interface ChatDossierRef {
  /** `getCardKey` of the saved card; empty for legacy messages that only know the name. */
  cardKey: string;
  name: string;
  club?: string;
  position?: string;
  nationality?: string;
  age?: number;
  overall?: number;
  potential?: number;
  archetype?: string;
  versionLabel?: string;
}


export interface GaffaRosterPlayer {
  player_id: string;
  name: string;
  display_name?: string;
  primary_position: string;
  secondary_positions?: string[];
  status: string;
  pl_team?: string | null;
}

export interface GaffaStandings {
  rank: number | null;
  of_teams?: number;
  played?: number;
  wins: number;
  draws: number;
  losses: number;
  points_for: number;
  points_against?: number;
}

export interface GaffaMatchup {
  gameweek: number;
  opponent_club_name: string | null;
  status: string;
  your_score?: number | null;
  opponent_score?: number | null;
}

export interface GaffaLineupSlot {
  player_id: string;
  name: string;
  slot: string;
}

export interface GaffaLineup {
  formation?: string | null;
  gameweek?: number;
  starters: GaffaLineupSlot[];
  bench: GaffaLineupSlot[];
}

export interface GaffaLeagueSettings {
  roster_size: number;
  bench_size: number;
  ir_size: number;
  taxi_size: number | null;
  taxi_age_limit: number | null;
  max_teams: number;
  is_dynasty: boolean;
  starting_faab_eur_m: number | null;
  free_agent_bid_floor: number | null;
  max_loan_outs: number | null;
  max_loan_ins: number | null;
  league_status: string | null;
}

export interface GaffaOpenListing {
  player_id: string;
  name: string;
  position: string;
  seller_club_id: string;
  seller_club_name: string;
  yours: boolean;
  status: string;
  min_bid_eur_m: number | null;
  ask_eur_m: number | null;
  release_clause_eur_m: number | null;
  open_to_trade: boolean;
  open_to_sale: boolean;
  open_to_loan: boolean;
  expires_at: string | null;
}

export interface GaffaOpenAuction {
  player_id: string;
  name: string;
  position: string;
  kind: string;
  highest_bid_eur_m: number | null;
  expires_at: string | null;
}

/** Unowned player in this league — Gaffa free agency, not a listing. */
export interface GaffaFreeAgent {
  player_id: string;
  name: string;
  display_name?: string;
  position: string;
  pl_team?: string | null;
  market_value_eur_m?: number | null;
  age?: number | null;
  live_auction?: boolean;
}

/** Locked / live context for Gaffa-mode answers. */
export interface GaffaContextBag {
  gaffa_rules_version: string;
  connected: boolean;
  /** True when using a cached bag after a failed refresh (&lt; 24h). */
  stale?: boolean;
  league_id?: string;
  club_id?: string;
  league_name?: string;
  club_name?: string;
  settings_overrides?: Record<string, unknown>;
  settings?: GaffaLeagueSettings;
  roster?: GaffaRosterPlayer[];
  budget_eur_m?: number;
  standings?: GaffaStandings;
  matchup?: GaffaMatchup | null;
  lineup?: GaffaLineup | null;
  open_listings?: GaffaOpenListing[];
  open_auctions?: GaffaOpenAuction[];
  /** Unowned active PL players. This is free agency. Missing on legacy bags. */
  free_agents?: GaffaFreeAgent[];
  synced_at?: string;
}

/** API payload from Gaffa / Futbolpedia proxy (before local bag fields). */
export interface GaffaClubContextResponse {
  league_id: string;
  club_id: string;
  league_name: string;
  club_name: string;
  budget_eur_m: number;
  roster: GaffaRosterPlayer[];
  standings: GaffaStandings;
  matchup: GaffaMatchup | null;
  lineup: GaffaLineup | null;
  settings?: GaffaLeagueSettings;
  open_listings?: GaffaOpenListing[];
  open_auctions?: GaffaOpenAuction[];
  free_agents?: GaffaFreeAgent[];
  synced_at: string;
}

export interface GaffaUserClub {
  club_id: string;
  club_name: string;
  abbreviation?: string | null;
  budget_eur_m: number;
  league_id: string;
  league_name: string;
  season?: string | null;
  league_status?: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  activeProfile: PlayerProfile | null;
  allProfiles: PlayerProfile[];
  /** The Gaffa club attached to this conversation (Connect with Gaffa); chat answers with it in mind. */
  gaffaClub?: { leagueId: string; clubId: string };
  /** Who set the title: the model from the opening exchange, or the user. Missing means a stand-in. */
  titleSource?: 'generated' | 'user';
}