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
  createdAt?: number;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  content: string | PlayerProfile | ReactNode;
  image?: string; // base64 encoded image string
  timestamp?: number;
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
  roster?: GaffaRosterPlayer[];
  budget_eur_m?: number;
  standings?: GaffaStandings;
  matchup?: GaffaMatchup | null;
  lineup?: GaffaLineup | null;
  open_listings?: unknown;
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
  synced_at: string;
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