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
  scrubProfileManagerMentions,
  type FutbolpediaVerifiedFacts,
} from './profileManagerGrounding';
import type { ApiFootballPlayerFactSheet } from './groundingService';
import { toBasePlayerSlug } from './dossierStore';
import {
  coerceWindowSpan,
  formatWindow,
  isValidWindowSpan,
  parseSeasonSpan,
  toWindow,
  windowSeasonCount,
  type CareerWindow,
  type HistoricalKind,
} from './careerWindow';

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
    version: {
      type: Type.OBJECT,
      description:
        'Mandatory card edition and temporal dating object. Identifies whether this card rates current form or a 2–4 season window of the past (prime or era), along with the exact snapshot date.',
      properties: {
        type: {
          type: Type.STRING,
          enum: ['current', 'prime', 'era'],
          description:
            'Card edition type: "current" for today, "prime" for the best 2–4 season window of the career, "era" for any other 2–4 season window.',
        },
        label: {
          type: Type.STRING,
          description:
            "Card title label, e.g. 'Current Form (Oct 2026)', 'Prime Zenith (2005-06 to 2008-09)' or 'Era (2012-13 to 2014-15)'.",
        },
        evaluationDate: {
          type: Type.STRING,
          description:
            'Exact ISO date (YYYY-MM-DD) of this evaluation snapshot: the current system date for current cards, or the date the window ended for prime and era cards.',
        },
        seasonOrEra: {
          type: Type.STRING,
          description:
            "Season for current cards (e.g. '2026-27'), or the full window for prime and era cards (e.g. '2005-06 to 2008-09').",
        },
        windowStart: {
          type: Type.INTEGER,
          nullable: true,
          description:
            'Prime and era cards: first season of the window as the year it starts (2005 for 2005-06). Null for current cards.',
        },
        windowEnd: {
          type: Type.INTEGER,
          nullable: true,
          description:
            'Prime and era cards: last season of the window as the year it starts (2008 for 2008-09). Must be 1 to 3 more than windowStart. Null for current cards.',
        },
        peakContext: {
          type: Type.STRING,
          nullable: true,
          description:
            'For prime and era cards: concise explanation of what defined this window (honors, trophies, role). Null for current cards.',
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
          description: '1 composite player blend, e.g. "Joshua Kimmich central vision crossed with Kyle Walker recovery pace".',
        },
        holisticProjection: {
          type: Type.STRING,
          description:
            'Holistic analysis of the player native physical, athletic, and technical profile as a complete footballer independently of the role currently assigned by their manager (e.g. traits profiling better at alternative positions or higher-ceiling systemic roles).',
        },
        playstyleTags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '4 to 6 concise, highly accurate trait chips (e.g. ["Deep-Lying Dictator", "Press-Resistant Pivot", "Laser Diagonal Switch"]).',
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
          enum: [
            'Emergent Runway',
            'Prime Ascent',
            'Apex Window',
            'Post-Peak Adaptation',
            'Late Career Mastery',
          ],
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
  version?: {
    type?: 'current' | 'prime' | 'era';
    label?: string;
    evaluationDate?: string;
    seasonOrEra?: string;
    windowStart?: number | null;
    windowEnd?: number | null;
    peakContext?: string | null;
  };
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
  confidence?: {
    grade?: 'A' | 'B' | 'C';
    sampleSize?: string;
    dataGaps?: string[];
    verdict?: string;
  };
  scoutingDebate?: {
    caseForHigher?: string;
    caseForLower?: string;
  };
  archetypeAnalysis?: {
    playsLikeBlend?: string;
    holisticProjection?: string;
    playstyleTags?: string[];
    tacticalSynergy?: string;
    tacticalKryptonite?: string;
  };
  ageCurve?: {
    phase?: 'Emergent Runway' | 'Prime Ascent' | 'Apex Window' | 'Post-Peak Adaptation' | 'Late Career Mastery';
    trajectoryNote?: string;
  };
  definingMoments?: Array<{
    year?: string;
    title?: string;
    description?: string;
  }>;
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
  const todayIso = new Date().toISOString().split('T')[0];

  const rawVersion = (raw as RawSynthesizedProfile).version;
  const inferredType =
    rawVersion?.type ||
    (/\b(prime|peak)\b/i.test(sanitized.basicInfo.name) ? 'prime' : 'current');
  const rawDate = rawVersion?.evaluationDate;
  const validRawDate = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && rawDate <= todayIso;
  const evaluationDate = validRawDate ? (rawDate as string) : inferredType === 'current' ? todayIso : '';

  // A past card's window comes from the explicit season years, falling back to the text.
  const window =
    inferredType === 'current' && rawVersion?.windowStart == null
      ? null
      : toWindow(rawVersion?.windowStart, rawVersion?.windowEnd) ??
        parseSeasonSpan(rawVersion?.seasonOrEra ?? '');
  const seasonOrEra =
    (window ? formatWindow(window) : rawVersion?.seasonOrEra?.trim()) ||
    (inferredType === 'current' ? currentSeason : '');
  const historicalName = inferredType === 'era' ? 'Era' : 'Prime Zenith';
  const versionLabel =
    rawVersion?.label?.trim() ||
    (inferredType === 'current'
      ? `Current Form (${month} ${year})`
      : seasonOrEra
        ? `${historicalName} (${seasonOrEra})`
        : historicalName);
  const peakContext = rawVersion?.peakContext?.trim() || null;

  sanitized.version = {
    id: `${toBasePlayerSlug(sanitized.basicInfo.name)}-${inferredType}-${evaluationDate || 'undated'}`,
    type: inferredType,
    label: clean(versionLabel),
    evaluationDate,
    seasonOrEra: clean(seasonOrEra),
    ...(window ? { windowStart: window.start, windowEnd: window.end } : {}),
    peakContext: peakContext ? clean(peakContext) : null,
  };
  if (evaluationDate) sanitized.evaluationDate = evaluationDate;

  const rawCalib = (raw as RawSynthesizedProfile).calibration;
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
  const rawConf = (raw as RawSynthesizedProfile).confidence;
  if (rawConf) {
    const rawGrade = rawConf.grade as string;
    const grade: 'A' | 'B' | 'C' =
      rawGrade === 'A' || rawGrade === 'B' || rawGrade === 'C' ? rawGrade : 'B';
    sanitized.confidence = {
      grade,
      sampleSize: clean(rawConf.sampleSize || 'Top-flight competitive sample'),
      dataGaps: Array.isArray(rawConf.dataGaps) ? rawConf.dataGaps.map(clean) : [],
      verdict: clean(rawConf.verdict || 'Evaluation calibrated against position peer baselines.'),
    };
  }

  // Scouting Debate (+2 / -2 OVR)
  const rawDebate = (raw as RawSynthesizedProfile).scoutingDebate;
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
  const rawArch = (raw as RawSynthesizedProfile).archetypeAnalysis;
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
  const rawAge = (raw as RawSynthesizedProfile).ageCurve;
  if (rawAge) {
    const phases = [
      'Emergent Runway',
      'Prime Ascent',
      'Apex Window',
      'Post-Peak Adaptation',
      'Late Career Mastery',
    ];
    const inferredPhase =
      sanitized.basicInfo.age <= 21
        ? 'Emergent Runway'
        : sanitized.basicInfo.age <= 25
          ? 'Prime Ascent'
          : sanitized.basicInfo.age <= 30
            ? 'Apex Window'
            : sanitized.basicInfo.age <= 34
              ? 'Post-Peak Adaptation'
              : 'Late Career Mastery';
    const phase = phases.includes(rawAge.phase as string)
      ? (rawAge.phase as any)
      : inferredPhase;
    sanitized.ageCurve = {
      phase,
      trajectoryNote: clean(rawAge.trajectoryNote || ''),
    };
  }

  // Defining Moments
  const rawMoments = (raw as RawSynthesizedProfile).definingMoments;
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
    apiPlayer?.coach ?? undefined,
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
    currentHeadCoach:
      raw.calibration.verifiedCurrentHeadCoach ?? apiPlayer?.coach ?? null,
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
function applyVersionRules(
  profile: PlayerProfile,
  isHistorical: boolean,
  kind: HistoricalKind = 'prime',
): PlayerProfile {
  const v = profile.version;
  if (!v) return profile;
  const { month, year, currentSeason } = getCurrentSeasonInfo();
  const base = toBasePlayerSlug(profile.basicInfo.name);

  if (!isHistorical) {
    const today = new Date().toISOString().split('T')[0];
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

  // The route decides prime versus era, whatever the model returned. The label is rebuilt from
  // the window so it always matches the season years.
  const window = toWindow(v.windowStart, v.windowEnd) ?? parseSeasonSpan(v.seasonOrEra ?? '');
  const seasonOrEra = window ? formatWindow(window) : v.seasonOrEra;
  const label = window ? `${kind === 'era' ? 'Era' : 'Prime Zenith'} (${seasonOrEra})` : v.label;
  return {
    ...profile,
    version: {
      ...v,
      id: `${base}-${kind}-${v.evaluationDate || 'undated'}`,
      type: kind,
      seasonOrEra,
      label,
      ...(window ? { windowStart: window.start, windowEnd: window.end } : {}),
    },
  };
}

/** Last resort once the retry also missed: forces a past card's window into 2–4 seasons. */
function coerceHistoricalWindow(profile: PlayerProfile): PlayerProfile {
  const v = profile.version;
  const window = v && toWindow(v.windowStart, v.windowEnd);
  if (!v || !window || isValidWindowSpan(window)) return profile;
  const latestStart = Number(getCurrentSeasonInfo().currentSeason.slice(0, 4));
  const fixed = coerceWindowSpan(window, latestStart);
  const seasonOrEra = formatWindow(fixed);
  return {
    ...profile,
    version: {
      ...v,
      windowStart: fixed.start,
      windowEnd: fixed.end,
      seasonOrEra,
      label: `${v.type === 'era' ? 'Era' : 'Prime Zenith'} (${seasonOrEra})`,
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

  const version = profile.version;
  if (version && version.type !== 'current') {
    if (!version.evaluationDate) {
      issues.push(
        'The historical card has no valid date. Set version.evaluationDate to the real YYYY-MM-DD date the window ended (not in the future).',
      );
    }
    const window = toWindow(version.windowStart, version.windowEnd);
    if (!window) {
      issues.push(
        'The historical card has no season window. Set version.windowStart and version.windowEnd to the first and last season of the window, each as the year the season starts (2005 for 2005-06).',
      );
    } else if (!isValidWindowSpan(window)) {
      issues.push(
        `The window ${formatWindow(window)} spans ${windowSeasonCount(window)} season(s). A historical card must rate 2–4 consecutive seasons, never a whole career or club stint. Choose the best-fitting 2–4 season window.`,
      );
    } else if (window.end > Number(getCurrentSeasonInfo().currentSeason.slice(0, 4))) {
      issues.push(
        `The window ${formatWindow(window)} ends after the current season. Choose a window that has already been played.`,
      );
    }
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
  /** Which past card to build when `isHistorical` is true. Defaults to the prime window. */
  historicalKind?: HistoricalKind;
  /** The seasons the user named, if any. */
  requestedWindow?: CareerWindow | null;
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
  const currentDateIso = new Date().toISOString().split('T')[0];

  const kind: HistoricalKind = params.historicalKind ?? 'prime';
  const requested = params.requestedWindow ?? null;
  const windowRule =
    kind === 'prime'
      ? `PRIME WINDOW: pick the player's best 2–4 consecutive seasons and set \`version.type\` = "prime"${requested ? `. The user mentioned ${formatWindow(requested)}; treat it as a hint, not a limit` : ''}.`
      : requested
        ? `ERA WINDOW: the user asked for ${formatWindow(requested)}. If that spans 2–4 seasons use exactly those seasons; if it is longer pick the strongest 2–4 seasons inside it; if it is a single season widen it to 2–3 seasons that contain it. Set \`version.type\` = "era".`
        : `ERA WINDOW: the user named an era or decade. Pick the strongest 2–4 consecutive seasons inside it. Set \`version.type\` = "era".`;
  const temporalRules = params.isHistorical
    ? `
    - HISTORICAL WINDOW CARD EVALUATION: Rate the player over ONE window of 2–4 consecutive seasons, never a whole career and never a whole club stint. Judge the level, role and attributes shown across those seasons only, on the exact same 1–99 scale as modern players (zero nostalgia inflation, zero conservative underselling). Ignore what came before and after, including their ${year} status (retired, manager, veteran).
    - ${windowRule}
    - DATING REQUIREMENT: Set \`version.windowStart\` and \`version.windowEnd\` to the first and last season of the window as the year each starts (2005 for 2005-06; windowEnd - windowStart must be 1 to 3). Set \`version.seasonOrEra\` = the window text (e.g. "2005-06 to 2008-09"), \`version.label\` = "${kind === 'era' ? 'Era' : 'Prime Zenith'} (<window>)", \`version.evaluationDate\` = the date the window ended (YYYY-MM-DD, not in the future), and \`version.peakContext\` = concise 1–2 sentence note on the trophies, role and dominance that defined the window.
    - If the player across this window was the #1 player in the world at their position or an all-time league/Champions League benchmark (such as John Terry across 2004-05 to 2007-08), calibrate them in \`93_95_WC_ELITE\` (94–95). Do not cap historic defenders or midfielders at 91–92. Rate a weaker window on its own merit, not at the player's career-best tier.
    - Set \`ratings.potential\` equal to \`ratings.overall\`: the card rates the window as played.`
    : `
    - CURRENT FORM DATED CARD EVALUATION (${month} ${year}, Season ${currentSeason}, Date: ${currentDateIso}): Ground basicInfo (club, age, height, weight) and latestUpdate strictly in <deterministic_bio_anchor> and <factual_foundation>.
    - DATING REQUIREMENT: Set \`version.type\` = "current", \`version.evaluationDate\` = "${currentDateIso}", \`version.seasonOrEra\` = "${currentSeason}", \`version.label\` = "Current Form (${month} ${year})", and \`version.peakContext\` = null.
    - NO REPUTATION LAG: If the player is already performing as a Top 3–5 player in the world at their position for an elite club right now (e.g., Willian Pacho at PSG), rate their current Overall in \`90_92_WORLD_CLASS\` (90–92) — do not undersell them at 87–89 Borderline World-Class and hide their current level in Potential.
    - APEX CONTINENTAL STARS: If the player is the primary talisman/focal point of a Champions League-winning or Ballon d'Or-caliber campaign (e.g., Ousmane Dembélé at PSG), rate them at 92–94 rather than scraping the 91 floor.
    - Set \`calibration.verifiedCurrentHeadCoach\` ONLY if <factual_foundation> explicitly confirms the current head coach of the player's current club as of ${month} ${year}. Never name a head coach in shortBio, playstyle, or latestUpdate when \`verifiedCurrentHeadCoach\` is null.
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

    let profile = applyVersionRules(sanitizeProfileData(raw), params.isHistorical, kind);

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
      return params.isHistorical ? coerceHistoricalWindow(profile) : profile;
    }
  }

  throw new Error(`Dossier synthesis validation failed after retry: ${lastIssues.join('; ')}`);
}
