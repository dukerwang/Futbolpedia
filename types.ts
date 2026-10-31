import type { ReactNode } from 'react';

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

export type ChatDomain = 'default' | 'gaffa';

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

export interface GaffaAuthUser {
  id: string;
  email?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  activeProfile: PlayerProfile | null;
  allProfiles: PlayerProfile[];
  /** Chat domain for this conversation. Missing on legacy rows → treat as 'default'. */
  domain?: ChatDomain;
}