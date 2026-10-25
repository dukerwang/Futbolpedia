import type { Attributes, PlayerProfile } from '../types';
import { ATTRIBUTE_LABELS } from '../constants/ratingTiers';
import { getCardKey, isConfidentDossier, isPrimeCard, latestCardPerPlayer } from './dossierCards';
import { CALIBRATION_EPOCH_MS, getSupabaseCalibratedPool } from './dossierCache';
import { findReferencedDossiers, formatTopAttributes } from './dossierContext';

/**
 * Calibrated-pool queries: the grep_saved_dossiers tool and the positional peer ledger that
 * anchors every new rating against already-rated peers.
 */

export interface DossierGrepParams {
  query?: string;
  position?: string;
  club?: string;
  minOverall?: number;
  maxOverall?: number;
  minPotential?: number;
  attributeKey?: string;
  minAttributeValue?: number;
  sortBy?: string;
  limit?: number;
}

const matchesPositionalFilter = (playerPos: string, filterPos: string): boolean => {
  const p = playerPos.toLowerCase();
  const f = filterPos.toLowerCase().trim();
  if (!f) return true;
  if (p.includes(f)) return true;
  if ((f === 'cb' || f.includes('center back') || f.includes('centre back')) && (p.includes('centre-back') || p.includes('libero'))) return true;
  if ((f.includes('libero') || f.includes('sweeper')) && (p.includes('libero') || p.includes('centre-back'))) return true;
  if ((f === 'lb' || f === 'rb' || f.includes('fullback') || f.includes('full-back')) && p.includes('back') && !p.includes('centre-back')) return true;
  if (f.includes('defend') && (p.includes('back') || p.includes('libero') || p.includes('defensive midfielder'))) return true;
  if (f.includes('midfield') && p.includes('midfielder')) return true;
  if (f.includes('wing') && (p.includes('winger') || p.includes('wide'))) return true;
  if ((f === 'st' || f === 'cf' || f.includes('striker') || f.includes('forward') || f.includes('attack')) && (p.includes('striker') || p.includes('forward') || p.includes('winger'))) return true;
  if ((f === 'gk' || f.includes('keeper')) && p.includes('goalkeeper')) return true;
  return false;
};

/**
 * Instant (<1ms) in-memory grep and structured attribute query over all saved/active dossiers.
 * Replaces upfront regex guessing with deterministic agent-callable search.
 */
export function grepDossiers(
  dossiers: PlayerProfile[],
  params: DossierGrepParams = {},
): {
  totalMatches: number;
  results: Array<{
    name: string;
    club: string;
    position: string;
    age: number;
    overall: number;
    potential: number;
    archetype: string;
    bestRoles: string[];
    topAttributes: Record<string, number>;
    queriedAttribute?: { key: string; value: number };
    strengths: string[];
    weaknesses: string[];
  }>;
} {
  let pool = latestCardPerPlayer(
    [...getSupabaseCalibratedPool(), ...dossiers].filter(isConfidentDossier),
  );

  if (params.position) {
    pool = pool.filter((p) => matchesPositionalFilter(p.basicInfo.position, params.position!));
  }
  if (params.club) {
    const clubLower = params.club.toLowerCase().trim();
    pool = pool.filter((p) => p.basicInfo.club.toLowerCase().includes(clubLower));
  }
  if (typeof params.minOverall === 'number') {
    pool = pool.filter((p) => p.ratings.overall >= params.minOverall!);
  }
  if (typeof params.maxOverall === 'number') {
    pool = pool.filter((p) => p.ratings.overall <= params.maxOverall!);
  }
  if (typeof params.minPotential === 'number') {
    pool = pool.filter((p) => p.ratings.potential >= params.minPotential!);
  }
  if (params.attributeKey && typeof params.minAttributeValue === 'number') {
    const key = params.attributeKey as keyof Attributes;
    pool = pool.filter((p) => {
      const val = p.attributes?.[key];
      return typeof val === 'number' && val >= params.minAttributeValue!;
    });
  }
  if (params.query && params.query.trim()) {
    const tokens = params.query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    pool = pool.filter((p) => {
      const haystack = [
        p.basicInfo.name,
        p.basicInfo.club,
        p.basicInfo.nationality,
        p.basicInfo.position,
        p.playstyleAndRole?.playstyle?.archetype ?? '',
        p.playstyleAndRole?.playstyle?.description ?? '',
        ...(p.playstyleAndRole?.bestRoles ?? []),
        ...(p.strengths ?? []),
        ...(p.weaknesses ?? []),
        p.shortBio ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }

  const sortKey = params.sortBy?.trim() || 'overall';
  pool.sort((a, b) => {
    if (sortKey === 'potential') return b.ratings.potential - a.ratings.potential;
    if (sortKey === 'age') return a.basicInfo.age - b.basicInfo.age;
    if (sortKey in (a.attributes || {})) {
      const ak = a.attributes[sortKey as keyof Attributes] ?? 0;
      const bk = b.attributes[sortKey as keyof Attributes] ?? 0;
      return bk - ak;
    }
    return b.ratings.overall - a.ratings.overall;
  });

  const limit = Math.max(1, Math.min(25, params.limit ?? 10));
  const sliced = pool.slice(0, limit);

  return {
    totalMatches: pool.length,
    results: sliced.map((p) => {
      const sortedAttrs = Object.entries(p.attributes || {})
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      const topAttributes: Record<string, number> = {};
      for (const [k, v] of sortedAttrs) topAttributes[k] = v;

      const attrKey = params.attributeKey as keyof Attributes | undefined;
      const queriedVal = attrKey && p.attributes ? p.attributes[attrKey] : undefined;

      return {
        name: p.basicInfo.name,
        club: p.basicInfo.club,
        position: p.basicInfo.position,
        age: p.basicInfo.age,
        overall: p.ratings.overall,
        potential: p.ratings.potential,
        archetype: p.playstyleAndRole?.playstyle?.archetype || 'N/A',
        bestRoles: p.playstyleAndRole?.bestRoles || [],
        topAttributes,
        ...(attrKey && typeof queriedVal === 'number'
          ? { queriedAttribute: { key: attrKey, value: queriedVal } }
          : {}),
        strengths: p.strengths || [],
        weaknesses: p.weaknesses || [],
      };
    }),
  };
}

export function mergeAllCalibratedDossiers(
  savedDossiers: PlayerProfile[],
  conversationDossiers: PlayerProfile[],
): PlayerProfile[] {
  // Order from broadest (Supabase pool) to most local (savedDossiers -> conversationDossiers)
  return latestCardPerPlayer(
    [...getSupabaseCalibratedPool(), ...savedDossiers, ...conversationDossiers].filter(
      (d) => isConfidentDossier(d) && !!d.createdAt && d.createdAt >= CALIBRATION_EPOCH_MS,
    ),
  );
}

export interface PeerLedgerOptions {
  targetPlayers?: string[];
  positionHint?: string;
  message?: string;
}

const inferPositionalFilterFromText = (text: string): string | null => {
  const lower = text.toLowerCase();
  if (/\b(centre[- ]?backs?|center[- ]?backs?|\bcbs?\b)\b/.test(lower)) return 'Centre-Back';
  if (/\b(full[- ]?backs?|wing[- ]?backs?|\blbs?\b|\brbs?\b|\blwbs?\b|\brwbs?\b|left[- ]backs?|right[- ]backs?)\b/.test(lower))
    return 'Full-Back';
  if (/\b(defensive midfielders?|\bcdms?\b|\bdms?\b|holding midfielders?|#6|number 6)\b/.test(lower))
    return 'Defensive Midfielder';
  if (/\b(attacking midfielders?|\bcams?\b|\bams?\b|#10|number 10|playmakers?)\b/.test(lower))
    return 'Attacking Midfielder';
  if (/\b(midfielders?|\bcms?\b|#8|number 8)\b/.test(lower)) return 'Midfielder';
  if (/\b(wingers?|\brws?\b|\blws?\b|wide forwards?)\b/.test(lower)) return 'Winger';
  if (/\b(strikers?|centre[- ]?forwards?|center[- ]?forwards?|\bsts?\b|\bcfs?\b|#9|number 9|forwards?)\b/.test(lower))
    return 'Centre Forward';
  if (/\b(goalkeepers?|keepers?|\bgks?\b)\b/.test(lower)) return 'Goalkeeper';
  return null;
};

const inferQueriedAttributesFromText = (text: string): Array<keyof Attributes> => {
  if (!text) return [];
  const lower = text.toLowerCase();
  const out: Array<keyof Attributes> = [];
  const checks: Array<[RegExp, keyof Attributes]> = [
    [/\bfinishing\b|\bclinical\b|\bgoalscoring\b/, 'finishing'],
    [/\bfirst\s*touch\b/, 'firstTouch'],
    [/\bdribbl(?:e|ing|er)\b|\b1v1\b|\bball[- ]?carrying\b/, 'dribbling'],
    [/\bvision\b|\bcreativ(?:e|ity)\b/, 'vision'],
    [/\bretention\b|\bpress[- ]?resistan(?:ce|t)\b/, 'retention'],
    [/\bcombination\b|\blink[- ]?up\b/, 'combinationPlay'],
    [/\bdelivery\b|\bcross(?:ing|es)?\b|\bset[- ]?pieces?\b/, 'delivery'],
    [/\bprogressive\s*passing\b|\bpassing\b|\bline[- ]?breaking\b/, 'progressivePassing'],
    [/\bfootball\s*iq\b|\biq\b|\bintelligence\b/, 'footballIQ'],
    [/\boffensive\s*positioning\b|\bmovement\b/, 'offensivePositioning'],
    [/\bdefensive\s*positioning\b|\bpositioning\b/, 'defensivePositioning'],
    [/\btackl(?:e|es|ing)\b/, 'tackling'],
    [/\binterceptions?\b/, 'interceptions'],
    [/\bpressing\b|\bwork[- ]?rate\b/, 'pressingIntensity'],
    [/\bspeed\b|\bpace\b|\brecovery\s*pace\b/, 'speed'],
    [/\bacceleration\b|\bburst\b/, 'acceleration'],
    [/\bagility\b|\bbalance\b/, 'agility'],
    [/\bstrength\b|\bphysical(?:ity)?\b/, 'strength'],
    [/\baerial\b|\bheading\b|\bheaders?\b/, 'aerialProwess'],
    [/\bstamina\b|\bendurance\b/, 'stamina'],
    [/\bcomposure\b|\bcalm(?:ness)?\b/, 'composure'],
    [/\bclutch\b|\bbig[- ]?game\b/, 'clutch'],
    [/\bleadership\b|\bcaptain\b/, 'leadership'],
    [/\bconsisten(?:cy|t)\b/, 'consistency'],
    [/\bflair\b/, 'flair'],
  ];
  for (const [re, key] of checks) {
    if (re.test(lower)) out.push(key);
  }
  return out.slice(0, 3);
};

/**
 * Builds a compact, position-aware peer calibration ledger from the user's freshly calibrated dossiers
 * (across Supabase global pool, local saved archive, and active conversation)
 * so every new synthesis and debate automatically anchors against same-position peers first.
 */
export function buildPositionalPeerLedgerBlock(
  savedDossiers: PlayerProfile[],
  conversationDossiers: PlayerProfile[],
  options?: PeerLedgerOptions,
): string {
  const allCalibrated = mergeAllCalibratedDossiers(savedDossiers, conversationDossiers);
  if (allCalibrated.length === 0) return '';

  const matchedTargets = findReferencedDossiers(
    options?.message ?? '',
    allCalibrated,
    options?.targetPlayers ?? [],
  );

  const detectedPos =
    options?.positionHint ||
    matchedTargets[0]?.basicInfo.position.split('/')[0] ||
    (options?.message ? inferPositionalFilterFromText(options.message) : null);

  const queriedAttrs = options?.message ? inferQueriedAttributesFromText(options.message) : [];

  const sortedAll = [...allCalibrated].sort((a, b) => b.ratings.overall - a.ratings.overall);
  const selectedBySlug = new Map<string, PlayerProfile>();

  // 1. Prioritize direct target matches so their exact ratings are always visible
  for (const t of matchedTargets) {
    selectedBySlug.set(getCardKey(t), t);
  }

  // 2. Prioritize same-position calibrated peers across all rating tiers (up to 10)
  if (detectedPos) {
    const positionalPeers = sortedAll.filter((p) =>
      matchesPositionalFilter(p.basicInfo.position, detectedPos),
    );
    for (const p of positionalPeers.slice(0, 10)) {
      selectedBySlug.set(getCardKey(p), p);
    }
  }

  // 3. Fill remaining slots up to 18 with global top-rated anchors
  for (const p of sortedAll) {
    if (selectedBySlug.size >= 18) break;
    selectedBySlug.set(getCardKey(p), p);
  }

  const finalList = [...selectedBySlug.values()].sort(
    (a, b) => b.ratings.overall - a.ratings.overall,
  );

  const lines = finalList.map((p) => {
    const topSpikes = formatTopAttributes(p.attributes, 3);
    const queriedSlice =
      queriedAttrs.length > 0
        ? queriedAttrs
            .map((k) => {
              const val = p.attributes?.[k];
              return typeof val === 'number' && val > 0
                ? `${ATTRIBUTE_LABELS[k] || k} ${val}`
                : null;
            })
            .filter(Boolean)
            .join(', ')
        : '';
    const editionTag = isPrimeCard(p) ? ` [Prime ${p.version?.seasonOrEra ?? ''}]`.replace(' ]', ']') : '';
    return `- ${p.basicInfo.name}${editionTag} (${p.basicInfo.position}, ${p.basicInfo.club}): ${p.ratings.overall} OVR / ${p.ratings.potential} POT${topSpikes ? ` [Spikes: ${topSpikes}]` : ''}${queriedSlice ? ` [Queried: ${queriedSlice}]` : ''}`;
  });

  return `
<calibrated_peer_ledger>
Active peer benchmarks already rated on this user's calibrated Futbolpedia ledger (maintain strict relative consistency with these ratings):
${lines.join('\n')}
</calibrated_peer_ledger>`;
}
