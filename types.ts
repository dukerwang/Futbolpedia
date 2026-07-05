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

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  activeProfile: PlayerProfile | null;
  allProfiles: PlayerProfile[];
}