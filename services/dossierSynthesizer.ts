import { Type } from '@google/genai';
import type { Attributes, GoalkeeperAttributes, PlayerProfile } from '../types';
import {
  CANONICAL_POSITIONS,
  normalizeClub,
  normalizePosition,
  TIER_BAND_IDS,
  TIER_BAND_MAP,
  TierBandId,
} from '../constants/ratingTiers';
import { DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION } from '../prompts/dossierPrompt';
import { generateStructured, getCurrentSeasonInfo } from './aiClient';
import {
  findProfileManagerGroundingIssues,
  type FutbolpediaVerifiedFacts,
} from './profileManagerGrounding';
import type { ApiFootballPlayerFactSheet } from './groundingService';

const OUTFIELD_ATTRIBUTES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    finishing: { type: Type.NUMBER },
    firstTouch: { type: Type.NUMBER },
    dribbling: { type: Type.NUMBER },
    vision: { type: Type.NUMBER },
    retention: { type: Type.NUMBER },
    combinationPlay: { type: Type.NUMBER },
    delivery: { type: Type.NUMBER },
    progressivePassing: { type: Type.NUMBER },
    footballIQ: { type: Type.NUMBER },
    offensivePositioning: { type: Type.NUMBER },
    defensivePositioning: { type: Type.NUMBER },
    tackling: { type: Type.NUMBER },
    interceptions: { type: Type.NUMBER },
    pressingIntensity: { type: Type.NUMBER },
    speed: { type: Type.NUMBER },
    acceleration: { type: Type.NUMBER },
    agility: { type: Type.NUMBER },
    strength: { type: Type.NUMBER },
    aerialProwess: { type: Type.NUMBER },
    stamina: { type: Type.NUMBER },
    composure: { type: Type.NUMBER },
    clutch: { type: Type.NUMBER },
    leadership: { type: Type.NUMBER },
    consistency: { type: Type.NUMBER },
    flair: { type: Type.NUMBER },
  },
  required: [
    'finishing',
    'firstTouch',
    'dribbling',
    'vision',
    'retention',
    'combinationPlay',
    'delivery',
    'progressivePassing',
    'footballIQ',
    'offensivePositioning',
    'defensivePositioning',
    'tackling',
    'interceptions',
    'pressingIntensity',
    'speed',
    'acceleration',
    'agility',
    'strength',
    'aerialProwess',
    'stamina',
    'composure',
    'clutch',
    'leadership',
    'consistency',
    'flair',
  ],
};

const GK_ATTRIBUTES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    reflexes: { type: Type.NUMBER },
    handling: { type: Type.NUMBER },
    distribution: { type: Type.NUMBER },
    commandOfArea: { type: Type.NUMBER },
    GKpositioning: { type: Type.NUMBER },
    sweeping: { type: Type.NUMBER },
    ballPlaying: { type: Type.NUMBER },
  },
};

export const PLAYER_PROFILE_SYNTHESIS_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    calibration: {
      type: Type.OBJECT,
      description:
        'Mandatory pre-rating calibration and grounding verification step. Anchor the tier band, peer comparison, top spike attributes, true flaws, and verified head coach BEFORE assigning numbers.',
      properties: {
        tierBand: {
          type: Type.STRING,
          enum: [...TIER_BAND_IDS],
          description: 'Exact tier band ID from Section III.',
        },
        peerBenchmark: {
          type: Type.STRING,
          description:
            '1-2 real-world positional peers (with their approximate ratings) that anchor where this player sits inside the tier.',
        },
        signatureSpikes: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '3-4 attribute keys that define the player’s elite ceiling.',
        },
        genuineFlaws: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '2-3 attribute keys that reflect genuine limitations in his toolkit.',
        },
        verifiedCurrentHeadCoach: {
          type: Type.STRING,
          nullable: true,
          description:
            'Set ONLY if <factual_foundation> explicitly confirms the current head coach of the player’s current club. Set to null if unconfirmed, historical, or if sources conflict.',
        },
        conflictingManagerReports: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List any former/sacked/conflicting manager names mentioned in search so prose avoids citing them as current.',
        },
      },
      required: [
        'tierBand',
        'peerBenchmark',
        'signatureSpikes',
        'genuineFlaws',
        'verifiedCurrentHeadCoach',
        'conflictingManagerReports',
      ],
    },
    basicInfo: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        age: { type: Type.NUMBER },
        nationality: { type: Type.STRING },
        club: { type: Type.STRING },
        primaryPosition: {
          type: Type.STRING,
          enum: [...CANONICAL_POSITIONS],
        },
        secondaryPosition: {
          type: Type.STRING,
          enum: ['None', ...CANONICAL_POSITIONS],
        },
        height: { type: Type.STRING },
        weight: { type: Type.STRING },
      },
      required: [
        'name',
        'age',
        'nationality',
        'club',
        'primaryPosition',
        'secondaryPosition',
        'height',
        'weight',
      ],
    },
    ratings: {
      type: Type.OBJECT,
      properties: {
        overall: { type: Type.NUMBER },
        potential: { type: Type.NUMBER },
      },
      required: ['overall', 'potential'],
    },
    strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
    weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
    attributes: OUTFIELD_ATTRIBUTES_SCHEMA,
    goalkeeperAttributes: GK_ATTRIBUTES_SCHEMA,
    shortBio: { type: Type.STRING },
    playstyleAndRole: {
      type: Type.OBJECT,
      properties: {
        playstyle: {
          type: Type.OBJECT,
          properties: {
            archetype: { type: Type.STRING },
            description: { type: Type.STRING },
          },
          required: ['archetype', 'description'],
        },
        bestRoles: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['playstyle', 'bestRoles'],
    },
    latestUpdate: { type: Type.STRING },
  },
  required: [
    'calibration',
    'basicInfo',
    'ratings',
    'strengths',
    'weaknesses',
    'attributes',
    'shortBio',
    'playstyleAndRole',
    'latestUpdate',
  ],
};

interface RawSynthesizedProfile {
  calibration?: {
    tierBand: TierBandId;
    peerBenchmark: string;
    signatureSpikes: string[];
    genuineFlaws: string[];
    verifiedCurrentHeadCoach?: string | null;
    conflictingManagerReports?: string[];
  };
  basicInfo?: {
    name?: string;
    age?: number;
    nationality?: string;
    club?: string;
    position?: string;
    primaryPosition?: string;
    secondaryPosition?: string;
    height?: string;
    weight?: string;
  };
  ratings?: { overall?: number; potential?: number };
  strengths?: string[];
  weaknesses?: string[];
  attributes?: Partial<Attributes>;
  goalkeeperAttributes?: Partial<GoalkeeperAttributes>;
  shortBio?: string;
  playstyleAndRole?: {
    playstyle?: { archetype?: string; description?: string };
    bestRoles?: string[];
  };
  latestUpdate?: string;
}

export const createDefaultProfile = (): PlayerProfile => {
  const defaultAttributes: Attributes = {
    finishing: 0,
    firstTouch: 0,
    dribbling: 0,
    vision: 0,
    retention: 0,
    combinationPlay: 0,
    delivery: 0,
    progressivePassing: 0,
    footballIQ: 0,
    offensivePositioning: 0,
    defensivePositioning: 0,
    tackling: 0,
    interceptions: 0,
    pressingIntensity: 0,
    speed: 0,
    acceleration: 0,
    agility: 0,
    strength: 0,
    aerialProwess: 0,
    stamina: 0,
    composure: 0,
    clutch: 0,
    leadership: 0,
    consistency: 0,
    flair: 0,
  };
  return {
    basicInfo: {
      name: 'N/A',
      age: 0,
      nationality: 'N/A',
      club: 'N/A',
      position: 'N/A',
      height: 'N/A',
      weight: 'N/A',
    },
    ratings: { overall: 0, potential: 0 },
    strengths: [],
    weaknesses: [],
    attributes: defaultAttributes,
    shortBio: 'Bio not available.',
    playstyleAndRole: {
      playstyle: { archetype: 'N/A', description: 'Playstyle not available.' },
      bestRoles: [],
    },
    latestUpdate: 'Update not available.',
  };
};

export const sanitizeProfileData = (
  raw: RawSynthesizedProfile | Partial<PlayerProfile> | null,
): PlayerProfile => {
  const defaults = createDefaultProfile();
  if (!raw) return defaults;

  const rawBasic = (raw as RawSynthesizedProfile).basicInfo ?? {};
  const primaryPos = rawBasic.primaryPosition;
  const secondaryPos = rawBasic.secondaryPosition;
  const combinedPosition =
    primaryPos && primaryPos !== 'N/A'
      ? secondaryPos && secondaryPos !== 'None' && secondaryPos !== primaryPos
        ? `${primaryPos}/${secondaryPos}`
        : primaryPos
      : rawBasic.position || 'N/A';

  const sanitized: PlayerProfile = {
    basicInfo: {
      name: rawBasic.name || defaults.basicInfo.name,
      age: typeof rawBasic.age === 'number' ? rawBasic.age : defaults.basicInfo.age,
      nationality: rawBasic.nationality || defaults.basicInfo.nationality,
      club: normalizeClub(rawBasic.club || defaults.basicInfo.club),
      position: normalizePosition(combinedPosition),
      height: rawBasic.height || 'N/A',
      weight: rawBasic.weight || 'N/A',
    },
    ratings: {
      overall: Math.round(raw.ratings?.overall ?? defaults.ratings.overall),
      potential: Math.round(raw.ratings?.potential ?? defaults.ratings.potential),
    },
    attributes: { ...defaults.attributes, ...raw.attributes },
    playstyleAndRole: {
      playstyle: {
        archetype:
          raw.playstyleAndRole?.playstyle?.archetype ||
          defaults.playstyleAndRole.playstyle.archetype,
        description:
          raw.playstyleAndRole?.playstyle?.description ||
          defaults.playstyleAndRole.playstyle.description,
      },
      bestRoles: Array.isArray(raw.playstyleAndRole?.bestRoles)
        ? raw.playstyleAndRole!.bestRoles
        : [],
    },
    strengths: Array.isArray(raw.strengths) ? raw.strengths : [],
    weaknesses: Array.isArray(raw.weaknesses) ? raw.weaknesses : [],
    shortBio: raw.shortBio || defaults.shortBio,
    latestUpdate: raw.latestUpdate || defaults.latestUpdate,
  };

  const gkAttributes = raw.goalkeeperAttributes;
  const positionLower = sanitized.basicInfo.position.toLowerCase();
  if (
    gkAttributes &&
    Object.keys(gkAttributes).length > 0 &&
    (positionLower.includes('goalkeeper') || positionLower.includes('gk'))
  ) {
    sanitized.goalkeeperAttributes = gkAttributes as GoalkeeperAttributes;
  } else {
    delete sanitized.goalkeeperAttributes;
  }

  const isZeroMeasurement = (s: string): boolean =>
    /^0['"]?0?['"]?$/.test(s.trim()) || /^0\s*(lbs|kg|cm)?$/i.test(s.trim());

  if (
    !sanitized.basicInfo.height ||
    sanitized.basicInfo.height === 'N/A' ||
    isZeroMeasurement(sanitized.basicInfo.height)
  ) {
    sanitized.basicInfo.height = 'N/A';
  }
  if (
    !sanitized.basicInfo.weight ||
    sanitized.basicInfo.weight === 'N/A' ||
    isZeroMeasurement(sanitized.basicInfo.weight)
  ) {
    sanitized.basicInfo.weight = 'N/A';
  }

  const clean = (str: string): string => (str || '').replace(/\s*\[[\d\s,]+\]\s*/g, ' ').trim();

  sanitized.shortBio = clean(sanitized.shortBio);
  sanitized.latestUpdate = clean(sanitized.latestUpdate);
  sanitized.strengths = sanitized.strengths.map(clean);
  sanitized.weaknesses = sanitized.weaknesses.map(clean);
  sanitized.playstyleAndRole.playstyle.archetype = clean(
    sanitized.playstyleAndRole.playstyle.archetype,
  );
  sanitized.playstyleAndRole.playstyle.description = clean(
    sanitized.playstyleAndRole.playstyle.description,
  );
  sanitized.playstyleAndRole.bestRoles = sanitized.playstyleAndRole.bestRoles.map(clean);

  return sanitized;
};

function resolveEffectiveVerifiedFacts(
  raw: RawSynthesizedProfile,
  profile: PlayerProfile,
  explicitVerifiedFacts: FutbolpediaVerifiedFacts | null,
  isHistorical: boolean,
): FutbolpediaVerifiedFacts | null {
  if (isHistorical) return null;
  if (explicitVerifiedFacts) return explicitVerifiedFacts;
  if (!raw.calibration) return null;
  return {
    currentClub: profile.basicInfo.club,
    currentHeadCoach: raw.calibration.verifiedCurrentHeadCoach ?? null,
    conflictingManagerReports: raw.calibration.conflictingManagerReports ?? [],
    season2526Stats: null,
    recentForm: null,
    injuryStatus: null,
    majorAwards: [],
    tacticalRole: null,
    mobilitySummary: null,
  };
}

function findSynthesisValidationIssues(
  raw: RawSynthesizedProfile,
  profile: PlayerProfile,
  verifiedFacts: FutbolpediaVerifiedFacts | null,
): string[] {
  const issues: string[] = [];

  if (verifiedFacts) {
    const managerIssues = findProfileManagerGroundingIssues(profile, verifiedFacts);
    issues.push(...managerIssues);
  }

  const tierBandId = raw.calibration?.tierBand;
  const tierDef = tierBandId ? TIER_BAND_MAP[tierBandId] : undefined;
  const overall = profile.ratings.overall;
  if (tierDef && overall > 0) {
    // Allow 1-point boundary tolerance before flagging a calibration mismatch
    if (overall < tierDef.min - 1 || overall > tierDef.max + 1) {
      issues.push(
        `Overall rating (${overall}) contradicts selected calibration.tierBand (${tierDef.id}: ${tierDef.min}-${tierDef.max}). Keep Overall inside ${tierDef.min}-${tierDef.max} or select the matching tierBand.`,
      );
    }
  }

  const isGK = profile.basicInfo.position.toLowerCase().includes('goalkeeper');
  if (!isGK && overall >= 60) {
    const vals = Object.values(profile.attributes).filter(
      (v): v is number => typeof v === 'number',
    );
    const hasZeros = vals.some((v) => v <= 0);
    if (hasZeros) {
      issues.push(
        'One or more outfield attributes were set to 0 for an identifiable professional player. Populate all 25 attributes with real values.',
      );
    } else if (vals.length > 0) {
      const spread = Math.max(...vals) - Math.min(...vals);
      if (spread < 12) {
        issues.push(
          `Outfield attributes are flattened (max-min spread is only ${spread}). Let signatureSpikes spike high and genuineFlaws stay low.`,
        );
      }
    }
  }

  return issues;
}

export interface SynthesizeDossierParams {
  rawMessage: string;
  isHistorical: boolean;
  foundationText: string;
  verifiedFacts: FutbolpediaVerifiedFacts | null;
  verifiedFactsBlock: string;
  apiPlayer?: ApiFootballPlayerFactSheet | null;
  lockedDossiersBlock: string;
  savedDossiersBlock: string;
  peerLedgerBlock?: string;
}

export async function synthesizePlayerDossier(
  params: SynthesizeDossierParams,
): Promise<PlayerProfile> {
  const { year, month, currentSeason } = getCurrentSeasonInfo();

  const temporalRules = params.isHistorical
    ? `
    - HISTORICAL / PEAK EVALUATION: Evaluate the player at their ABSOLUTE CAREER ZENITH on the exact same 1–99 scale as modern players (zero nostalgia inflation, zero conservative underselling).
    - If the player at their peak was the #1 player in the world at their position or an all-time league/Champions League benchmark (such as Prime John Terry in 2004–2009), calibrate them in \`93_95_WC_ELITE\` (94–95) — do not cap historic defenders or midfielders at 91–92.
    - Because a Prime/Peak dossier represents the player's realized peak, set \`ratings.potential\` equal to \`ratings.overall\` (unless their career was cut short before their prime).
    - Disregard their ${year} status (retired, manager, veteran) when rating attributes and Overall.`
    : `
    - CURRENT EVALUATION (${month} ${year}, Season ${currentSeason}): Ground basicInfo (club, age, height, weight) and latestUpdate strictly in <deterministic_bio_anchor> and <factual_foundation>.
    - NO REPUTATION LAG: If the player is already performing as a Top 3–5 player in the world at their position for an elite club right now (e.g., Willian Pacho at PSG), rate their current Overall in \`90_92_WORLD_CLASS\` (90–92) — do not undersell them at 87–89 Borderline World-Class and hide their current level in Potential.
    - APEX CONTINENTAL STARS: If the player is the primary talisman/focal point of a Champions League-winning or Ballon d'Or-caliber campaign (e.g., Ousmane Dembélé at PSG), rate them at 92–94 rather than scraping the 91 floor.
    - Set \`calibration.verifiedCurrentHeadCoach\` ONLY if <factual_foundation> explicitly confirms the current head coach of the player's current club as of ${month} ${year}. Never name a head coach in shortBio, playstyle, or latestUpdate when \`verifiedCurrentHeadCoach\` is null.
    - If grounding shows the player started a recent match, treat them as match fit.
    - Never write a stat-based qualifier in latestUpdate without a specific verified number from the grounding data.`;

  const basePrompt = `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
<factual_foundation>
${params.foundationText}
</factual_foundation>
${params.verifiedFactsBlock}
${params.peerLedgerBlock ?? ''}
${params.lockedDossiersBlock}
${params.savedDossiersBlock}
<synthesis_instructions>
${temporalRules}
- Complete the \`calibration\` block first: choose the exact \`tierBand\` from Section III based on where the player ranks globally at their position (Top 1–2 / historic positional benchmark = 93–95 World-Class Elite; Top 3–5 at their position = 90–92 World-Class), name 1-2 positional peers in \`peerBenchmark\`, and identify \`signatureSpikes\` and \`genuineFlaws\`.
- Ensure \`ratings.overall\` sits inside the integer range of your chosen \`calibration.tierBand\`.
- Make the 25 attributes reflect a realistic, spiky scouting profile where \`signatureSpikes\` are high and \`genuineFlaws\` stay low.
</synthesis_instructions>
<task>${params.rawMessage}</task>`;

  let lastIssues: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptPrompt =
      attempt === 0 || lastIssues.length === 0
        ? basePrompt
        : `${basePrompt}\n\n<validation_retry>\nPrevious draft failed quality verification:\n- ${lastIssues.join('\n- ')}\nFix every listed issue while preserving accurate grounding.\n</validation_retry>`;

    const raw = await generateStructured<RawSynthesizedProfile>({
      task: 'synthesis',
      prompt: attemptPrompt,
      systemInstruction: DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION,
      schema: PLAYER_PROFILE_SYNTHESIS_SCHEMA,
    });

    const profile = sanitizeProfileData(raw);

    // Deterministically backfill missing bio fields from API-Football on active players
    if (!params.isHistorical && params.apiPlayer) {
      const api = params.apiPlayer;
      if ((!profile.basicInfo.age || profile.basicInfo.age <= 0) && api.age) {
        profile.basicInfo.age = api.age;
      }
      if (profile.basicInfo.nationality === 'N/A' && api.nationality) {
        profile.basicInfo.nationality = api.nationality;
      }
      if (profile.basicInfo.height === 'N/A' && api.height) {
        profile.basicInfo.height = api.height;
      }
      if (profile.basicInfo.weight === 'N/A' && api.weight) {
        profile.basicInfo.weight = api.weight;
      }
      if (profile.basicInfo.club === 'N/A' && api.currentClub) {
        profile.basicInfo.club = normalizeClub(api.currentClub);
      }
    }

    // Enforce Potential === Overall on historical Prime/Peak cards if the model floated Potential by 1-2 pts
    if (params.isHistorical && profile.ratings.potential !== profile.ratings.overall) {
      profile.ratings.potential = profile.ratings.overall;
    }

    const effectiveVerifiedFacts = resolveEffectiveVerifiedFacts(
      raw,
      profile,
      params.verifiedFacts,
      params.isHistorical,
    );
    lastIssues = findSynthesisValidationIssues(raw, profile, effectiveVerifiedFacts);

    if (lastIssues.length === 0) {
      return profile;
    }

    console.warn(`[DossierSynthesizer] Validation attempt ${attempt + 1} issues:`, lastIssues);

    // On final attempt, return the sanitized profile if only non-fatal calibration/spread warnings remain
    // and no manager-grounding violation occurred.
    if (attempt === 1) {
      const managerIssues = effectiveVerifiedFacts
        ? findProfileManagerGroundingIssues(profile, effectiveVerifiedFacts)
        : [];
      if (managerIssues.length === 0) {
        return profile;
      }
    }
  }

  throw new Error(`Dossier synthesis validation failed after retry: ${lastIssues.join('; ')}`);
}
