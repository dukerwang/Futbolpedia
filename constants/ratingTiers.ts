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
 * - Every tier measures intrinsic footballing quality on an absolute historical standard,
 *   never who happens to rank #1 in a single calendar year ("Best in World" is not a tier).
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
    description: 'Once-in-history footballing peak that defines the sport itself.',
  },
  {
    id: '96_98_ICON',
    min: 96,
    max: 98,
    label: 'Generational Icon',
    shortLabel: 'Generational Icon',
    description:
      'Historic, era-defining peak that redefines the position across decades. Requires a defined Generational Weapon.',
  },
  {
    id: '93_95_WC_ELITE',
    min: 93,
    max: 95,
    label: 'World-Class Elite',
    shortLabel: 'World-Class Elite',
    description:
      'The absolute apex of a position in a given era or an all-time league/continental benchmark (e.g., the #1 player in the world at their position at their peak, an all-time Premier League/UCL positional standard-bearer like peak John Terry at 94–95, or a Ballon d\'Or-caliber superstar dominating European football). Applies equally to defenders, midfielders, goalkeepers, and attackers.',
  },
  {
    id: '90_92_WORLD_CLASS',
    min: 90,
    max: 92,
    label: 'World-Class',
    shortLabel: 'World-Class',
    description:
      'Undisputed World-Class players at their position globally (typically Top 3–5 in the world in their role). Any player who is already performing as a top-3 to top-5 player in the world at their position for an elite club (such as Willian Pacho at PSG) belongs here at 90–92, never down in Borderline World-Class.',
  },
  {
    id: '87_89_BORDERLINE_WC',
    min: 87,
    max: 89,
    label: 'Borderline World-Class',
    shortLabel: 'Borderline World-Class',
    description:
      'Standout Champions League stars who sit just outside the top 5 at their position globally, or high-level starters who have not yet established top-of-the-position dominance.',
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
  'Striker',
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
  st: 'Striker',
  striker: 'Striker',
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

export const GK_ATTRIBUTE_LABELS: Record<keyof GoalkeeperAttributes, string> = {
  reflexes: 'Reflexes',
  handling: 'Handling',
  distribution: 'Distribution',
  commandOfArea: 'Command of Area',
  GKpositioning: 'GK Positioning',
  sweeping: 'Sweeping',
  ballPlaying: 'Ball Playing',
};

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
