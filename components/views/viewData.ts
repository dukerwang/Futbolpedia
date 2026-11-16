import type { Attributes, ChatDossierRef, GoalkeeperAttributes } from '../../types';

/**
 * The data each view draws. Plain, serializable and free of imports that reach the network, so a
 * reply can carry it in a block and a conversation can store it. The views are pure functions of
 * these types: building them from feeds and cards is the registry's job (`services/replyBlocks/`).
 */

// ---------------------------------------------------------------------------------------------
// League table

/**
 * One club's line in a league table. Mirrors `StandingsRow` in `services/liveFootball.ts`
 * (ESPN's standings, parsed): every number is null when the feed left it out, and `form` is a
 * string of the last results, newest last, such as "WWDLW", or null when the feed gives none.
 */
export interface TableRow {
  rank: number | null;
  team: string;
  /** The group's label when the competition has more than one table; null for a plain league. */
  group: string | null;
  played: number | null;
  won: number | null;
  drawn: number | null;
  lost: number | null;
  goalDiff: number | null;
  points: number | null;
  form: string | null;
}

export interface TableViewData {
  /** The league's name as the live data resolves it, such as "Premier League". */
  league: string;
  /** The season's display name from the feed, such as "2026-27"; null when the feed gives none. */
  season: string | null;
  /** In table order: by group label, then rank. */
  rows: TableRow[];
  /** The group labels in the order they are drawn; absent for a competition with one table. */
  groups?: string[];
  /** Club names the reply is about. Matched with the rows by name, ignoring case and "FC". */
  highlight: string[];
}

// ---------------------------------------------------------------------------------------------
// Comparison

/** One player in a comparison: his card's headline and the attributes behind it. */
export interface ComparisonSide {
  dossier: ChatDossierRef;
  /** The card's 25 outfield attributes; absent on a goalkeeper's card. */
  attributes?: Attributes;
  /** Present, and not empty, only on a goalkeeper's card. */
  goalkeeperAttributes?: GoalkeeperAttributes;
}

export interface ComparisonViewData {
  a: ComparisonSide;
  b: ComparisonSide;
}

/** A card with goalkeeper attributes is a goalkeeper's, the way `AttributeTable` reads it. */
export const isGoalkeeperSide = (side: ComparisonSide): boolean =>
  !!side.goalkeeperAttributes && Object.keys(side.goalkeeperAttributes).length > 0;

// ---------------------------------------------------------------------------------------------
// Ranking

/** The debate brief's criteria (`debateBrief.ts`): what a ranking is ordered by. */
export const RANKING_CRITERIA = ['peak level', 'sustained level', 'output', 'influence', 'versatility', 'mixed'] as const;
export type RankingCriterion = (typeof RANKING_CRITERIA)[number];

/** A ranked player with a card, or just a name when nobody has rated him. */
export type RankingEntry = ChatDossierRef | { name: string };

export const isCardedEntry = (entry: RankingEntry): entry is ChatDossierRef => 'cardKey' in entry;

export interface RankingViewData {
  title: string;
  criterion: RankingCriterion;
  /** In the order shown, best first. */
  entries: RankingEntry[];
  /**
   * What moved when the order was checked against the cards, one sentence each (empty when the
   * model's order stood).
   */
  moves: string[];
}

// ---------------------------------------------------------------------------------------------
// Names

/** "Brighton & Hove Albion FC" and "brighton & hove albion" are one club. */
export const clubKey = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !['fc', 'afc', 'cf', 'sc'].includes(t))
    .join(' ');
