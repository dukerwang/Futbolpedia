import type { Attributes, GoalkeeperAttributes } from '../types';

export type TierBandId =
  | '99_GOAT'
  | '96_98_ICON'
  | '93_95_WC_ELITE'
  | '90_92_WORLD_CLASS'
  | '87_89_BORDERLINE_WC'
  | '84_86_HIGH_END_STARTER'
  | '80_83_QUALITY_STARTER'
  | '75_79_ROTATIONAL'
  | '70_74_SQUAD_DEPTH'
  | '60_69_DEVELOPING';

export interface RatingTierDefinition {
  id: TierBandId;
  min: number;
  max: number;
  label: string;
  shortLabel: string;
  description: string;
}

/**
 * Single source of truth for Futbolpedia's Rating Tier Scale (1-99).
 *
 * Key principles:
 * - Every tier measures how good a footballer the player is (or was, for a past version) on one
 *   absolute, all-era standard. Positional rank, honours and dominance of an era are evidence of
 *   that level, never the definition of a tier: being the best at a position in a given season
 *   does not by itself place a player in any band.
 * - The "World-Class" label begins strictly at 90.
 * - Starters below 90 range from Borderline World-Class (87-89) and High-End Starter (84-86)
 *   to Quality Top-Flight Starter (80-83) and Rotational / Average Top-Flight (75-79).
 */
export const RATING_TIERS: readonly RatingTierDefinition[] = [
  {
    id: '99_GOAT',
    min: 99,
    max: 99,
    label: 'GOAT Status',
    shortLabel: 'GOAT',
    description: 'A footballer with no equal in the history of the game: the most complete and decisive player the sport has produced.',
  },
  {
    id: '96_98_ICON',
    min: 96,
    max: 98,
    label: 'Generational Icon',
    shortLabel: 'Generational Icon',
    description:
      'One of the greatest footballers the game has produced: a level of ability only a handful of players in history have reached, in any position. Higher in the band means a more complete and more decisive footballer.',
  },
  {
    id: '93_95_WC_ELITE',
    min: 93,
    max: 95,
    label: 'World-Class Elite',
    shortLabel: 'World-Class Elite',
    description:
      'Elite footballers of exceptional, all-time-relevant ability: among the very best players of their generation. Applies equally to defenders, midfielders, goalkeepers, and attackers. Not a ceiling for the best player of an era: a footballer better than the players rated 95 belongs above them.',
  },
  {
    id: '90_92_WORLD_CLASS',
    min: 90,
    max: 92,
    label: 'World-Class',
    shortLabel: 'World-Class',
    description:
      'Undisputed World-Class footballers: at any one time only a small group of players in the world are this good. A player already performing at this level for an elite club belongs here, never down in Borderline World-Class.',
  },
  {
    id: '87_89_BORDERLINE_WC',
    min: 87,
    max: 89,
    label: 'Borderline World-Class',
    shortLabel: 'Borderline World-Class',
    description:
      'Standout Champions League stars just short of world-class ability, or high-level starters who have not yet reached it.',
  },
  {
    id: '84_86_HIGH_END_STARTER',
    min: 84,
    max: 86,
    label: 'High-End Starter',
    shortLabel: 'High-End Starter',
    description:
      'Proven, high-caliber Champions League starters and standout Top 5 league performers, clearly above a standard starter.',
  },
  {
    id: '80_83_QUALITY_STARTER',
    min: 80,
    max: 83,
    label: 'Quality Top-Flight Starter',
    shortLabel: 'Quality Starter',
    description:
      'Dependable everyday first-choice starters in a Top 5 league or European-competition club who execute their role well without being star players.',
  },
  {
    id: '75_79_ROTATIONAL',
    min: 75,
    max: 79,
    label: 'Rotational / Average Top-Flight',
    shortLabel: 'Top-Flight Rotational',
    description:
      'Functional starters for mid-to-lower-table Top 5 league sides or trusted squad rotation options at elite clubs.',
  },
  {
    id: '70_74_SQUAD_DEPTH',
    min: 70,
    max: 74,
    label: 'Squad Depth',
    shortLabel: 'Squad Depth',
    description:
      'Backup, specialist, or fringe squad professionals in a Top 5 league.',
  },
  {
    id: '60_69_DEVELOPING',
    min: 60,
    max: 69,
    label: 'Developing / Raw Prospect',
    shortLabel: 'Developing',
    description:
      'Youth prospects or lower-tier professionals not yet proven as reliable top-flight contributors.',
  },
] as const;

export const TIER_BAND_IDS: readonly TierBandId[] = RATING_TIERS.map((t) => t.id);

export const TIER_BAND_MAP: Record<TierBandId, RatingTierDefinition> = Object.fromEntries(
  RATING_TIERS.map((t) => [t.id, t]),
) as Record<TierBandId, RatingTierDefinition>;

export function getTierDefinition(rating: number): RatingTierDefinition {
  for (const tier of RATING_TIERS) {
    if (rating >= tier.min && rating <= tier.max) return tier;
  }
  if (rating > 99) return RATING_TIERS[0];
  return RATING_TIERS[RATING_TIERS.length - 1];
}

export function getTierForRating(rating: number): string {
  if (!Number.isFinite(rating) || rating <= 0) return 'Unrated';
  return getTierDefinition(Math.round(rating)).label;
}

export function getShortTierLabel(rating: number): string {
  if (!Number.isFinite(rating) || rating <= 0) return 'Unrated';
  return getTierDefinition(Math.round(rating)).shortLabel;
}

export function formatRatingScaleForPrompt(): string {
  return RATING_TIERS.map((tier) => {
    const range = tier.min === tier.max ? `${tier.min}` : `${tier.min}–${tier.max}`;
    return `- **${range} (${tier.label} | ID: \`${tier.id}\`):** ${tier.description}`;
  }).join('\n');
}

export const CANONICAL_POSITIONS = [
  'Goalkeeper',
  'Libero',
  'Centre-Back',
  'Left Back',
  'Right Back',
  'Left Wing-Back',
  'Right Wing-Back',
  'Defensive Midfielder',
  'Central Midfielder',
  'Attacking Midfielder',
  'Left Midfielder',
  'Right Midfielder',
  'Left Winger',
  'Right Winger',
  'Centre Forward',
  'Second Striker',
] as const;

export type CanonicalPosition = (typeof CANONICAL_POSITIONS)[number];

export const POSITION_CANON: Record<string, CanonicalPosition> = {
  gk: 'Goalkeeper',
  goalkeeper: 'Goalkeeper',
  keeper: 'Goalkeeper',
  rb: 'Right Back',
  rightback: 'Right Back',
  lb: 'Left Back',
  leftback: 'Left Back',
  libero: 'Libero',
  sweeper: 'Libero',
  cb: 'Centre-Back',
  centreback: 'Centre-Back',
  centerback: 'Centre-Back',
  centraldefender: 'Centre-Back',
  rwb: 'Right Wing-Back',
  rightwingback: 'Right Wing-Back',
  lwb: 'Left Wing-Back',
  leftwingback: 'Left Wing-Back',
  cdm: 'Defensive Midfielder',
  dm: 'Defensive Midfielder',
  defensivemidfielder: 'Defensive Midfielder',
  holdingmidfielder: 'Defensive Midfielder',
  cm: 'Central Midfielder',
  centralmidfielder: 'Central Midfielder',
  centremidfielder: 'Central Midfielder',
  cam: 'Attacking Midfielder',
  am: 'Attacking Midfielder',
  attackingmidfielder: 'Attacking Midfielder',
  rm: 'Right Midfielder',
  rightmidfielder: 'Right Midfielder',
  lm: 'Left Midfielder',
  leftmidfielder: 'Left Midfielder',
  rw: 'Right Winger',
  rightwinger: 'Right Winger',
  rightwing: 'Right Winger',
  lw: 'Left Winger',
  leftwinger: 'Left Winger',
  leftwing: 'Left Winger',
  cf: 'Centre Forward',
  centreforward: 'Centre Forward',
  centerforward: 'Centre Forward',
  st: 'Centre Forward',
  striker: 'Centre Forward',
  ss: 'Second Striker',
  secondstriker: 'Second Striker',
  attacker: 'Centre Forward',
  forward: 'Centre Forward',
  midfielder: 'Central Midfielder',
  defender: 'Centre-Back',
};

export const CLUB_CANON: Record<string, string> = {
  barca: 'FC Barcelona',
  fcbarcelona: 'FC Barcelona',
  barcelona: 'FC Barcelona',
  realmadrid: 'Real Madrid',
  madrid: 'Real Madrid',
  losblancos: 'Real Madrid',
  atleti: 'Atlético Madrid',
  atleticomadrid: 'Atlético Madrid',
  atletico: 'Atlético Madrid',
  manu: 'Manchester United',
  manutd: 'Manchester United',
  manunited: 'Manchester United',
  mufc: 'Manchester United',
  manchesterunited: 'Manchester United',
  mancity: 'Manchester City',
  mcfc: 'Manchester City',
  manchestercity: 'Manchester City',
  spurs: 'Tottenham Hotspur',
  tottenham: 'Tottenham Hotspur',
  tottenhamhotspur: 'Tottenham Hotspur',
  chelsea: 'Chelsea',
  chelseafc: 'Chelsea',
  cfc: 'Chelsea',
  liverpool: 'Liverpool',
  lfc: 'Liverpool',
  arsenal: 'Arsenal',
  gunners: 'Arsenal',
  arsenalfc: 'Arsenal',
  bayern: 'Bayern Munich',
  bayernmunich: 'Bayern Munich',
  fcbayern: 'Bayern Munich',
  fcbayernmunich: 'Bayern Munich',
  dortmund: 'Borussia Dortmund',
  bvb: 'Borussia Dortmund',
  borussiadortmund: 'Borussia Dortmund',
  psg: 'Paris Saint-Germain',
  parissaintgermain: 'Paris Saint-Germain',
  juve: 'Juventus',
  juventus: 'Juventus',
  inter: 'Inter Milan',
  internazionale: 'Inter Milan',
  intermilan: 'Inter Milan',
  acmilan: 'AC Milan',
};

export function normalizePosition(raw: string): string {
  if (!raw || raw === 'N/A') return raw || 'N/A';
  const parts = raw
    .split(/\s*(?:\/|,|\bor\b|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const mapped = parts.map((part) => {
    const withoutParens = part.replace(/\([^)]*\)/g, '').trim();
    const key = withoutParens.toLowerCase().replace(/[^a-z]/g, '');
    return POSITION_CANON[key] || withoutParens || part;
  });
  const seen = new Set<string>();
  const unique = mapped
    .filter((m) => {
      const k = m.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 2);
  return unique.join('/') || raw;
}

/**
 * The libero is a sweeper-era position. A card of that era keeps it, paired with the modern
 * position the player would hold today ("Libero/Centre-Back" when the model gave none). A
 * current card files the role under Centre-Back, so roles stay out of the position list.
 */
export function resolveLiberoPosition(position: string, isHistorical: boolean): string {
  const parts = position.split('/').map((p) => p.trim()).filter(Boolean);
  if (!parts.includes('Libero')) return position;
  if (!isHistorical) {
    return [...new Set(parts.map((p) => (p === 'Libero' ? 'Centre-Back' : p)))].join('/');
  }
  const modern = parts.find((p) => p !== 'Libero') ?? 'Centre-Back';
  return `Libero/${modern}`;
}

export function normalizeClub(raw: string): string {
  if (!raw || raw === 'N/A') return raw || 'N/A';
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  return CLUB_CANON[key] || raw.trim();
}

export const ATTRIBUTE_LABELS: Record<keyof Attributes, string> = {
  finishing: 'Finishing',
  firstTouch: 'First Touch',
  dribbling: 'Dribbling',
  vision: 'Vision',
  retention: 'Retention',
  combinationPlay: 'Combination Play',
  delivery: 'Delivery',
  progressivePassing: 'Progressive Passing',
  footballIQ: 'Football IQ',
  offensivePositioning: 'Offensive Positioning',
  defensivePositioning: 'Defensive Positioning',
  tackling: 'Tackling',
  interceptions: 'Interceptions',
  pressingIntensity: 'Pressing Intensity',
  speed: 'Speed',
  acceleration: 'Acceleration',
  agility: 'Agility',
  strength: 'Strength',
  aerialProwess: 'Aerial Prowess',
  stamina: 'Stamina',
  composure: 'Composure',
  clutch: 'Clutch',
  leadership: 'Leadership',
  consistency: 'Consistency',
  flair: 'Flair',
};

/** The 25 outfield attribute keys, in canonical display order. */
export const ATTRIBUTE_KEYS = Object.keys(ATTRIBUTE_LABELS) as Array<keyof Attributes>;

export const GK_ATTRIBUTE_LABELS: Record<keyof GoalkeeperAttributes, string> = {
  reflexes: 'Reflexes',
  handling: 'Handling',
  distribution: 'Distribution',
  commandOfArea: 'Command of Area',
  GKpositioning: 'GK Positioning',
  sweeping: 'Sweeping',
  ballPlaying: 'Ball Playing',
};

/** Display label for an attribute key ("progressivePassing" → "Progressive Passing"). */
export const getAttributeLabel = (key: string): string =>
  ATTRIBUTE_LABELS[key as keyof Attributes] ??
  GK_ATTRIBUTE_LABELS[key as keyof GoalkeeperAttributes] ??
  key;

export const ATTRIBUTE_CATEGORIES: Record<string, Array<{ key: string; label: string }>> = {
  Technical: [
    { key: 'finishing', label: 'Finishing' },
    { key: 'firstTouch', label: 'First Touch' },
    { key: 'dribbling', label: 'Dribbling' },
    { key: 'vision', label: 'Vision' },
    { key: 'retention', label: 'Retention' },
    { key: 'combinationPlay', label: 'Combination Play' },
    { key: 'delivery', label: 'Delivery' },
    { key: 'progressivePassing', label: 'Progressive Passing' },
  ],
  Tactical: [
    { key: 'footballIQ', label: 'Football IQ' },
    { key: 'offensivePositioning', label: 'Offensive Positioning' },
    { key: 'defensivePositioning', label: 'Defensive Positioning' },
    { key: 'tackling', label: 'Tackling' },
    { key: 'interceptions', label: 'Interceptions' },
    { key: 'pressingIntensity', label: 'Pressing Intensity' },
  ],
  Physical: [
    { key: 'speed', label: 'Speed' },
    { key: 'acceleration', label: 'Acceleration' },
    { key: 'agility', label: 'Agility' },
    { key: 'strength', label: 'Strength' },
    { key: 'aerialProwess', label: 'Aerial Prowess' },
    { key: 'stamina', label: 'Stamina' },
  ],
  Mental: [
    { key: 'composure', label: 'Composure' },
    { key: 'clutch', label: 'Clutch' },
    { key: 'leadership', label: 'Leadership' },
    { key: 'consistency', label: 'Consistency' },
    { key: 'flair', label: 'Flair' },
  ],
};

export const GK_ATTRIBUTE_CATEGORIES: Record<string, Array<{ key: string; label: string }>> = {
  Goalkeeper: [
    { key: 'reflexes', label: 'Reflexes' },
    { key: 'handling', label: 'Handling' },
    { key: 'distribution', label: 'Distribution' },
    { key: 'commandOfArea', label: 'Command of Area' },
    { key: 'GKpositioning', label: 'GK Positioning' },
    { key: 'sweeping', label: 'Sweeping' },
    { key: 'ballPlaying', label: 'Ball Playing' },
  ],
};
