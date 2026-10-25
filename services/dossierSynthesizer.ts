import { Type } from '@google/genai';
import type {
  AgeCurveOutlook,
  AgeCurvePhase,
  ArchetypeAnalysis,
  Attributes,
  DefiningMoment,
  DossierConfidence,
  DossierVersion,
  DossierVersionType,
  GoalkeeperAttributes,
  PlayerProfile,
  ScoutingDebate,
} from '../types';
import {
  ATTRIBUTE_KEYS,
  CANONICAL_POSITIONS,
  GK_ATTRIBUTE_LABELS,
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
  scrubProfileManagerMentions,
  type FutbolpediaVerifiedFacts,
} from './profileManagerGrounding';
import type { ApiFootballPlayerFactSheet } from './groundingService';
import { EDITION_NAME_RE, isValidEvaluationDate, todayIso, toBasePlayerSlug } from './dossierCards';

const OUTFIELD_ATTRIBUTES_SCHEMA = {
  type: Type.OBJECT,
  properties: Object.fromEntries(ATTRIBUTE_KEYS.map((key) => [key, { type: Type.NUMBER }])),
  required: [...ATTRIBUTE_KEYS],
};

const GK_ATTRIBUTES_SCHEMA = {
  type: Type.OBJECT,
  properties: Object.fromEntries(
    Object.keys(GK_ATTRIBUTE_LABELS).map((key) => [key, { type: Type.NUMBER }]),
  ),
};

const DOSSIER_VERSION_TYPES: DossierVersionType[] = ['current', 'prime', 'season_snapshot', 'retro'];

/** Career phases in age order, with the oldest age each one covers when the model's is unusable. */
const AGE_CURVE_PHASES: Array<[AgeCurvePhase, number]> = [
  ['Emergent Runway', 21],
  ['Prime Ascent', 25],
  ['Apex Window', 30],
  ['Post-Peak Adaptation', 34],
  ['Late Career Mastery', Infinity],
];

export const PLAYER_PROFILE_SYNTHESIS_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    version: {
      type: Type.OBJECT,
      description:
        'Mandatory card edition and temporal dating object. Identifies whether this card represents current form or a historical career peak, along with the exact snapshot date.',
      properties: {
        type: {
          type: Type.STRING,
          enum: DOSSIER_VERSION_TYPES,
          description: 'Card edition type.',
        },
        label: {
          type: Type.STRING,
          description:
            "Card title label, e.g. 'Current Form (Oct 2026)' or 'Prime Zenith (2008–09 Season)'.",
        },
        evaluationDate: {
          type: Type.STRING,
          description:
            'Exact ISO date (YYYY-MM-DD) of this evaluation snapshot (current system date for active players, or verified career peak date for prime players).',
        },
        seasonOrEra: {
          type: Type.STRING,
          description: "Season or era string (e.g. '2026-27', '2019-20', '2008-09').",
        },
        peakContext: {
          type: Type.STRING,
          nullable: true,
          description:
            'For prime/peak dossiers: concise analytical explanation of why this was their career zenith (honors, trophies, role). Null for current players.',
        },
      },
      required: ['type', 'label', 'evaluationDate', 'seasonOrEra'],
    },
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
    confidence: {
      type: Type.OBJECT,
      description: 'Scouting confidence, evidence grading, and sample reliability.',
      properties: {
        grade: {
          type: Type.STRING,
          enum: ['A', 'B', 'C'],
          description:
            'A = Elite sample (>80 senior starts, multi-season stability), B = Moderate sample (20-80 starts, league transition), C = Limited sample (<20 starts, youth prospect, injury quarantine).',
        },
        sampleSize: {
          type: Type.STRING,
          description: 'Explicit competitive senior sample evaluated (e.g. "Over 120 senior appearances across UCL and domestic league").',
        },
        dataGaps: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Specific data gaps, small sample anomalies, or unproven competition translations (Protocol P).',
        },
        verdict: {
          type: Type.STRING,
          description: '1 concise sentence evaluating data confidence and rating stability.',
        },
      },
      required: ['grade', 'sampleSize', 'dataGaps', 'verdict'],
    },
    scoutingDebate: {
      type: Type.OBJECT,
      description: 'Dialectical arguments for +2 OVR higher rating vs -2 OVR lower rating.',
      properties: {
        caseForHigher: {
          type: Type.STRING,
          description: 'Sharpest analytical and metric argument for a +2 OVR bump.',
        },
        caseForLower: {
          type: Type.STRING,
          description: 'Sharpest analytical and metric counter-argument for a -2 OVR discount.',
        },
      },
      required: ['caseForHigher', 'caseForLower'],
    },
    archetypeAnalysis: {
      type: Type.OBJECT,
      description: 'Holistic player archetyping, archetype fusion, and tactical fit analysis.',
      properties: {
        playsLikeBlend: {
          type: Type.STRING,
          description:
            "One composite blend of two (at most three) real players, each lending one specific trait that matches this player's own spikes: \"<Player A>'s <trait> with <Player B>'s <trait>\". Choose players by profile, not club, nationality, era or fame.",
        },
        holisticProjection: {
          type: Type.STRING,
          description:
            'Holistic analysis of the player native physical, athletic, and technical profile as a complete footballer independently of the role currently assigned by their manager (e.g. traits profiling better at alternative positions or higher-ceiling systemic roles).',
        },
        playstyleTags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description:
            '4 to 6 short trait chips (2–3 words) naming observable on-pitch behaviours specific to this player and supported by the card; no generic praise or bare position names.',
        },
        tacticalSynergy: {
          type: Type.STRING,
          description: 'The optimal tactical system, formation, and partner dynamic that unlocks this player absolute ceiling.',
        },
        tacticalKryptonite: {
          type: Type.STRING,
          description: 'The tactical setup, press scheme, or matchup dynamic that isolates and exploits their weaknesses.',
        },
      },
      required: [
        'playsLikeBlend',
        'holisticProjection',
        'playstyleTags',
        'tacticalSynergy',
        'tacticalKryptonite',
      ],
    },
    ageCurve: {
      type: Type.OBJECT,
      description: 'Player development curve phase and developmental/longevity trajectory.',
      properties: {
        phase: {
          type: Type.STRING,
          enum: AGE_CURVE_PHASES.map(([phase]) => phase),
          description: 'Current phase on the career trajectory arc.',
        },
        trajectoryNote: {
          type: Type.STRING,
          description: '1-2 sentence projection of their development runway or veteran adaptation.',
        },
      },
      required: ['phase', 'trajectoryNote'],
    },
    definingMoments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          year: { type: Type.STRING },
          title: { type: Type.STRING },
          description: { type: Type.STRING },
        },
        required: ['year', 'title', 'description'],
      },
      description:
        '1 to 3 career-defining historic moments for established or prime players. Must be empty [] for young prospects (<2 full senior seasons).',
    },
  },
  required: [
    'version',
    'calibration',
    'basicInfo',
    'ratings',
    'strengths',
    'weaknesses',
    'attributes',
    'shortBio',
    'playstyleAndRole',
    'latestUpdate',
    'confidence',
    'scoutingDebate',
    'archetypeAnalysis',
    'ageCurve',
    'definingMoments',
  ],
};

interface RawSynthesizedProfile {
  version?: Partial<Omit<DossierVersion, 'id'>>;
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
  confidence?: Partial<DossierConfidence>;
  scoutingDebate?: Partial<ScoutingDebate>;
  archetypeAnalysis?: Partial<ArchetypeAnalysis>;
  ageCurve?: Partial<AgeCurveOutlook>;
  definingMoments?: Array<Partial<DefiningMoment>>;
}

export const createDefaultProfile = (): PlayerProfile => {
  const defaultAttributes = Object.fromEntries(
    ATTRIBUTE_KEYS.map((key) => [key, 0]),
  ) as Record<keyof Attributes, number>;
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
  const r = raw as RawSynthesizedProfile;

  const rawBasic = r.basicInfo ?? {};
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
      potential: Math.max(
        Math.round(raw.ratings?.overall ?? defaults.ratings.overall),
        Math.round(raw.ratings?.potential ?? defaults.ratings.potential),
      ),
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

  // Card versioning & temporal dating. Dates are never invented here: a historical card
  // without a valid peak date stays undated and is excluded from the shared database.
  const { year, month, currentSeason } = getCurrentSeasonInfo();

  const rawVersion = r.version;
  const inferredType =
    rawVersion?.type || (EDITION_NAME_RE.test(sanitized.basicInfo.name) ? 'prime' : 'current');
  const rawDate = rawVersion?.evaluationDate;
  const evaluationDate = isValidEvaluationDate(rawDate)
    ? rawDate
    : inferredType === 'current'
      ? todayIso()
      : '';

  const seasonOrEra = rawVersion?.seasonOrEra?.trim() || (inferredType === 'current' ? currentSeason : '');
  const versionLabel =
    rawVersion?.label?.trim() ||
    (inferredType === 'current'
      ? `Current Form (${month} ${year})`
      : seasonOrEra
        ? `Prime Zenith (${seasonOrEra})`
        : 'Prime Zenith');
  const peakContext = rawVersion?.peakContext?.trim() || null;

  sanitized.version = {
    id: `${toBasePlayerSlug(sanitized.basicInfo.name)}-${inferredType}-${evaluationDate || 'undated'}`,
    type: inferredType,
    label: clean(versionLabel),
    evaluationDate,
    seasonOrEra: clean(seasonOrEra),
    peakContext: peakContext ? clean(peakContext) : null,
  };
  if (evaluationDate) sanitized.evaluationDate = evaluationDate;

  const rawCalib = r.calibration;
  if (Array.isArray(rawCalib?.signatureSpikes) && rawCalib.signatureSpikes.length > 0) {
    sanitized.signatureSpikes = rawCalib.signatureSpikes.map(clean);
  }
  if (Array.isArray(rawCalib?.genuineFlaws) && rawCalib.genuineFlaws.length > 0) {
    sanitized.genuineFlaws = rawCalib.genuineFlaws.map(clean);
  }
  if (rawCalib?.peerBenchmark) {
    sanitized.peerBenchmark = clean(rawCalib.peerBenchmark);
  }

  // Enhanced dossier fields: Confidence & Evidence Grade
  const rawConf = r.confidence;
  if (rawConf) {
    sanitized.confidence = {
      grade: rawConf.grade === 'A' || rawConf.grade === 'C' ? rawConf.grade : 'B',
      sampleSize: clean(rawConf.sampleSize || 'Top-flight competitive sample'),
      dataGaps: Array.isArray(rawConf.dataGaps) ? rawConf.dataGaps.map(clean) : [],
      verdict: clean(rawConf.verdict || 'Evaluation calibrated against position peer baselines.'),
    };
  }

  // Scouting Debate (+2 / -2 OVR)
  const rawDebate = r.scoutingDebate;
  if (rawDebate && (rawDebate.caseForHigher || rawDebate.caseForLower)) {
    sanitized.scoutingDebate = {
      caseForHigher: clean(
        rawDebate.caseForHigher ||
          'Elite underlying metrics and game-breaking gravity point to a higher ceiling.',
      ),
      caseForLower: clean(
        rawDebate.caseForLower ||
          'Defensive exposure or systemic dependencies introduce variance against top opposition.',
      ),
    };
  }

  // Archetype Analysis & Holistic Projection
  const rawArch = r.archetypeAnalysis;
  if (rawArch) {
    sanitized.archetypeAnalysis = {
      playsLikeBlend: clean(rawArch.playsLikeBlend || ''),
      holisticProjection: clean(rawArch.holisticProjection || ''),
      playstyleTags: Array.isArray(rawArch.playstyleTags)
        ? rawArch.playstyleTags.map(clean).filter(Boolean).slice(0, 6)
        : [],
      tacticalSynergy: clean(rawArch.tacticalSynergy || ''),
      tacticalKryptonite: clean(rawArch.tacticalKryptonite || ''),
    };
  }

  // Career Curve
  const rawAge = r.ageCurve;
  if (rawAge) {
    const byAge =
      AGE_CURVE_PHASES.find(([, maxAge]) => sanitized.basicInfo.age <= maxAge) ??
      AGE_CURVE_PHASES[AGE_CURVE_PHASES.length - 1];
    sanitized.ageCurve = {
      phase: AGE_CURVE_PHASES.find(([phase]) => phase === rawAge.phase)?.[0] ?? byAge[0],
      trajectoryNote: clean(rawAge.trajectoryNote || ''),
    };
  }

  // Defining Moments
  const rawMoments = r.definingMoments;
  if (Array.isArray(rawMoments) && rawMoments.length > 0) {
    sanitized.definingMoments = rawMoments
      .filter((m) => m && (m.title || m.year))
      .map((m) => ({
        year: clean(m.year || ''),
        title: clean(m.title || ''),
        description: clean(m.description || ''),
      }));
  }

  return sanitized;
};

function resolveEffectiveVerifiedFacts(
  raw: RawSynthesizedProfile,
  profile: PlayerProfile,
  explicitVerifiedFacts: FutbolpediaVerifiedFacts | null,
  isHistorical: boolean,
  foundationText?: string,
  apiPlayer?: ApiFootballPlayerFactSheet | null,
): FutbolpediaVerifiedFacts | null {
  if (isHistorical) return null;
  const supplementalCorpus = [
    foundationText,
    apiPlayer?.currentClub ?? undefined,
    profile.basicInfo.name,
    profile.basicInfo.club,
  ].filter((v): v is string => Boolean(v));

  if (explicitVerifiedFacts) {
    return {
      ...explicitVerifiedFacts,
      supplementalCorpus: [
        ...(explicitVerifiedFacts.supplementalCorpus ?? []),
        ...supplementalCorpus,
      ],
    };
  }
  if (!raw.calibration) return null;
  return {
    currentClub: profile.basicInfo.club,
    // API-Football's coach record lags managerial changes, so it is never a fallback here.
    currentHeadCoach: raw.calibration.verifiedCurrentHeadCoach ?? null,
    conflictingManagerReports: raw.calibration.conflictingManagerReports ?? [],
    season2526Stats: null,
    recentForm: null,
    injuryStatus: null,
    majorAwards: [],
    tacticalRole: null,
    mobilitySummary: null,
    supplementalCorpus,
  };
}

/**
 * Deterministically enforces numerical calibration invariants in 0ms so minor model
 * boundary slips (tierBand vs Overall, spike floor, flaw ceiling, or attribute spread)
 * never trigger a 4-second retry LLM call.
 */
function enforceCalibrationInvariants(
  raw: RawSynthesizedProfile,
  profile: PlayerProfile,
  isHistorical: boolean,
): PlayerProfile {
  const tierBandId = raw.calibration?.tierBand;
  const tierDef = tierBandId ? TIER_BAND_MAP[tierBandId] : undefined;

  if (tierDef && profile.ratings.overall > 0) {
    if (profile.ratings.overall < tierDef.min - 1) {
      profile.ratings.overall = tierDef.min;
    } else if (profile.ratings.overall > tierDef.max + 1) {
      profile.ratings.overall = tierDef.max;
    }
    profile.ratings.potential = isHistorical
      ? profile.ratings.overall
      : Math.max(profile.ratings.overall, profile.ratings.potential);
  }

  const overall = profile.ratings.overall;
  const isGK = profile.basicInfo.position.toLowerCase().includes('goalkeeper');

  if (!isGK && overall >= 60) {
    const attrs = profile.attributes;
    const vals = Object.values(attrs).filter((v): v is number => typeof v === 'number');
    const hasZeros = vals.some((v) => v <= 0);

    if (!hasZeros && vals.length > 0) {
      const spikes = (raw.calibration?.signatureSpikes ?? []).filter(
        (k): k is keyof Attributes => k in attrs,
      );
      const spikeSet = new Set<keyof Attributes>(spikes);
      const flaws = (raw.calibration?.genuineFlaws ?? []).filter(
        (k): k is keyof Attributes => k in attrs && !spikeSet.has(k as keyof Attributes),
      );

      // 1. Ensure every declared signature spike reaches at least overall - 2
      for (const spikeKey of spikes) {
        const val = attrs[spikeKey];
        if (typeof val === 'number' && val < overall - 2) {
          attrs[spikeKey] = Math.min(99, Math.max(overall - 1, val));
        }
      }

      // 2. For elite cards (overall >= 88), ensure at least one attribute reaches overall
      const currentMax = Math.max(...Object.values(attrs));
      if (overall >= 88 && currentMax < overall - 1) {
        const primarySpike =
          spikes[0] ??
          (Object.entries(attrs).sort((a, b) => b[1] - a[1])[0]?.[0] as keyof Attributes);
        if (primarySpike) {
          attrs[primarySpike] = Math.min(99, overall);
        }
      }

      // 3. Ensure every declared genuine flaw stays below max(82, overall - 2)
      const flawCeiling = Math.max(82, overall - 2) - 2;
      for (const flawKey of flaws) {
        const val = attrs[flawKey];
        if (typeof val === 'number' && val >= Math.max(82, overall - 2)) {
          attrs[flawKey] = Math.max(45, Math.min(78, flawCeiling));
        }
      }

      // 4. Guarantee a spiky attribute spread (max - min >= 12)
      const updatedVals = Object.values(attrs);
      const maxAttr = Math.max(...updatedVals);
      const minAttr = Math.min(...updatedVals);
      if (maxAttr - minAttr < 12) {
        const targetFlawKey =
          flaws[0] ??
          (Object.entries(attrs)
            .filter(([k]) => !spikeSet.has(k as keyof Attributes))
            .sort((a, b) => a[1] - b[1])[0]?.[0] as keyof Attributes);
        if (targetFlawKey) {
          attrs[targetFlawKey] = Math.max(40, maxAttr - 14);
        }
      }
    }
  }

  return profile;
}

/**
 * Pins the card edition to what the route asked for, regardless of what the model returned.
 * Current cards always carry today's date. Historical cards keep the model's verified peak date
 * and are never relabelled "current".
 */
export function applyVersionRules(profile: PlayerProfile, isHistorical: boolean): PlayerProfile {
  const v = profile.version;
  if (!v) return profile;
  const { month, year, currentSeason } = getCurrentSeasonInfo();
  const base = toBasePlayerSlug(profile.basicInfo.name);

  if (!isHistorical) {
    const today = todayIso();
    return {
      ...profile,
      evaluationDate: today,
      version: {
        ...v,
        id: `${base}-current-${today}`,
        type: 'current',
        evaluationDate: today,
        seasonOrEra: currentSeason,
        label: `Current Form (${month} ${year})`,
        peakContext: null,
      },
    };
  }

  if (v.type === 'current') {
    // The model labelled a peak request as current form, so sanitize dated, seasoned and
    // labelled it as today's card. None of that describes a peak: leave it undated so
    // validation asks for the real peak date.
    const { evaluationDate: _today, ...rest } = profile;
    return {
      ...rest,
      version: {
        ...v,
        id: `${base}-prime-undated`,
        type: 'prime',
        label: 'Prime Zenith',
        evaluationDate: '',
        seasonOrEra: '',
      },
    };
  }

  return {
    ...profile,
    version: {
      ...v,
      id: `${base}-${v.type}-${v.evaluationDate || 'undated'}`,
    },
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

  if (profile.version && profile.version.type !== 'current' && !profile.version.evaluationDate) {
    issues.push(
      'The historical card has no valid peak date. Set version.evaluationDate to the real YYYY-MM-DD date of the player’s career peak and version.seasonOrEra to that season.',
    );
  }

  const isGK = profile.basicInfo.position.toLowerCase().includes('goalkeeper');
  const overall = profile.ratings.overall;
  if (!isGK && overall >= 60) {
    const vals = Object.values(profile.attributes).filter(
      (v): v is number => typeof v === 'number',
    );
    if (vals.some((v) => v <= 0)) {
      issues.push(
        'One or more outfield attributes were set to 0 for an identifiable professional player. Populate all 25 attributes with real values.',
      );
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
  priorTrajectoryBlock?: string;
}

export async function synthesizePlayerDossier(
  params: SynthesizeDossierParams,
): Promise<PlayerProfile> {
  const { year, month, currentSeason } = getCurrentSeasonInfo();
  const currentDateIso = todayIso();

  const temporalRules = params.isHistorical
    ? `
    - HISTORICAL / PEAK DATED CARD EVALUATION: Evaluate the player at their ABSOLUTE CAREER ZENITH on the exact same 1–99 scale as modern players (zero nostalgia inflation, zero conservative underselling).
    - PEAK DATING REQUIREMENT: You MUST research and pinpoint the exact peak season (e.g. 2008–09 for Gerrard, 2019–20 for Kimmich) and the specific pinnacle date. Set \`version.type\` = "prime", \`version.evaluationDate\` = verified peak date (YYYY-MM-DD), \`version.seasonOrEra\` = peak season (e.g. "2008-09"), \`version.label\` = "Prime Zenith (<Season>)", and \`version.peakContext\` = concise 1–2 sentence note explaining the trophies, role, and dominance that defined this zenith.
    - If the player at their peak was the #1 player in the world at their position or an all-time league/Champions League benchmark (such as Prime John Terry in 2004–2009 or Steven Gerrard in 2008–09), calibrate them in \`93_95_WC_ELITE\` (94–95) — do not cap historic defenders or midfielders at 91–92.
    - Because a Prime/Peak dossier represents the player's realized peak, set \`ratings.potential\` equal to \`ratings.overall\` (unless their career was cut short before their prime).
    - Disregard their ${year} status (retired, manager, veteran) when rating attributes and Overall.`
    : `
    - CURRENT FORM DATED CARD EVALUATION (${month} ${year}, Season ${currentSeason}, Date: ${currentDateIso}): Ground basicInfo (club, age, height, weight) and latestUpdate strictly in <deterministic_bio_anchor> and <factual_foundation>.
    - DATING REQUIREMENT: Set \`version.type\` = "current", \`version.evaluationDate\` = "${currentDateIso}", \`version.seasonOrEra\` = "${currentSeason}", \`version.label\` = "Current Form (${month} ${year})", and \`version.peakContext\` = null.
    - NO REPUTATION LAG: If the player is already performing as a Top 3–5 player in the world at their position for an elite club right now (e.g., Willian Pacho at PSG), rate their current Overall in \`90_92_WORLD_CLASS\` (90–92) — do not undersell them at 87–89 Borderline World-Class and hide their current level in Potential.
    - APEX CONTINENTAL STARS: If the player is the primary talisman/focal point of a Champions League-winning or Ballon d'Or-caliber campaign (e.g., Ousmane Dembélé at PSG), rate them at 92–94 rather than scraping the 91 floor.
    - Set \`calibration.verifiedCurrentHeadCoach\` ONLY if <factual_foundation> explicitly confirms the current head coach of the player's current club as of ${month} ${year}. Never name a head coach or manager anywhere in the card's prose; the app attaches the verified manager separately.
    - If grounding shows the player started a recent match, treat them as match fit.
    - Never write a stat-based qualifier in latestUpdate without a specific verified number from the grounding data.`;

  const basePrompt = `<context>System Date: ${month} ${year} (${currentDateIso}). Season: ${currentSeason}</context>
<factual_foundation>
${params.foundationText}
</factual_foundation>
${params.verifiedFactsBlock}
${params.priorTrajectoryBlock ?? ''}
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

    let profile = applyVersionRules(sanitizeProfileData(raw), params.isHistorical);

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

    // Enforce calibration invariants deterministically in 0ms
    profile = enforceCalibrationInvariants(raw, profile, params.isHistorical);

    const effectiveVerifiedFacts = resolveEffectiveVerifiedFacts(
      raw,
      profile,
      params.verifiedFacts,
      params.isHistorical,
      params.foundationText,
      params.apiPlayer,
    );

    // Surgically scrub any unverified manager mention in 0ms rather than firing a second 4s LLM call
    if (effectiveVerifiedFacts) {
      const managerIssues = findProfileManagerGroundingIssues(profile, effectiveVerifiedFacts);
      if (managerIssues.length > 0) {
        profile = scrubProfileManagerMentions(profile, effectiveVerifiedFacts);
      }
    }

    lastIssues = findSynthesisValidationIssues(raw, profile, effectiveVerifiedFacts);

    if (lastIssues.length === 0) {
      return profile;
    }

    console.warn(`[DossierSynthesizer] Validation attempt ${attempt + 1} issues:`, lastIssues);

    if (attempt === 1) {
      return profile;
    }
  }

  throw new Error(`Dossier synthesis validation failed after retry: ${lastIssues.join('; ')}`);
}
