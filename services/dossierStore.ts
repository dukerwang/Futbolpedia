import type { Content } from '@google/genai';
import type {
  Attributes,
  ChatMessage,
  Conversation,
  GoalkeeperAttributes,
  PlayerProfile,
} from '../types';
import {
  ATTRIBUTE_LABELS,
  GK_ATTRIBUTE_LABELS,
  normalizeClub,
  normalizePosition,
} from '../constants/ratingTiers';

const supabaseUrl = 'https://hrocnbcavstmjysptjdk.supabase.co';
const supabaseKey = 'sb_publishable_NKyG9miYqS8JgdpgWuXm9A_tc3vaVCL';

export const supabase =
  typeof window !== 'undefined' && (window as any).supabase
    ? (window as any).supabase.createClient(supabaseUrl, supabaseKey)
    : null;

export const isSupabaseReady = () => !!supabase;

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
// Invalidate cached dossiers created before the v4.1 rating calibration update
// so previously under-calibrated dossiers regenerate fresh when requested.
export const CALIBRATION_EPOCH_MS = Date.parse('2026-10-20T21:15:00Z');

let supabaseCalibratedPool: PlayerProfile[] = [];
let supabasePoolFetchedAt = 0;
const SUPABASE_POOL_TTL_MS = 60 * 1000; // 60 seconds

export const toPlayerSlug = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

/** Name slug with edition markers removed, so "Joshua Kimmich (Prime)" becomes "joshua-kimmich". */
export const toBasePlayerSlug = (name: string): string =>
  toPlayerSlug(name)
    .replace(/^(prime|peak)-/, '')
    .replace(/-(prime|peak)$/, '');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const todayIso = (): string => new Date().toISOString().split('T')[0];

/** True for a well-formed YYYY-MM-DD that isn't in the future. */
const isValidEvaluationDate = (s?: string | null): s is string =>
  typeof s === 'string' && ISO_DATE_RE.test(s) && s <= todayIso();

/**
 * Resolves or formats a date to standard YYYY-MM-DD.
 */
export const formatIsoDate = (input?: string | number | Date | null): string | null => {
  if (!input) return null;
  try {
    const d =
      typeof input === 'string' && ISO_DATE_RE.test(input)
        ? new Date(`${input}T12:00:00Z`)
        : new Date(input);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
};

/** European season label for a calendar date (Jul–Dec starts the season, Jan–Jun ends it). */
const seasonForDate = (dateStr: string): string => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
};

/**
 * True for any non-"current" card (prime, season snapshot, retro). Legacy cards with no
 * version fall back to an edition marker in the name.
 */
export const isPrimeCard = (p: PlayerProfile): boolean => {
  const t = p.version?.type;
  if (t) return t !== 'current';
  return /\b(prime|peak)\b/i.test(p.basicInfo?.name ?? '');
};

/**
 * Returns the verified evaluation date of a dossier, or null if it can't be dated.
 * A current card may fall back to the day it was created, because that is the day it was
 * rated. A historical card never falls back: its date must be the verified peak date.
 */
export const getDossierEvaluationDate = (p: PlayerProfile): string | null => {
  if (isValidEvaluationDate(p.version?.evaluationDate)) return p.version!.evaluationDate;
  if (isValidEvaluationDate(p.evaluationDate)) return p.evaluationDate!;
  if (isPrimeCard(p)) return null;
  if (p.createdAt && p.createdAt > 0) return formatIsoDate(p.createdAt);
  return null;
};

/**
 * Check whether a dossier has a valid, verifiable evaluation date.
 */
export const isDossierDated = (p: PlayerProfile): boolean => {
  return Boolean(getDossierEvaluationDate(p));
};

/**
 * Strictly ensures a dossier is dated. If it cannot be dated, returns null.
 * When dateable, guarantees p.evaluationDate and p.version are fully populated.
 */
export const ensureDossierDated = (
  p: PlayerProfile,
  fallbackMs?: number,
): PlayerProfile | null => {
  if (!p || !p.basicInfo?.name) return null;
  const prime = isPrimeCard(p);
  const dateStr =
    getDossierEvaluationDate(p) || (!prime && fallbackMs ? formatIsoDate(fallbackMs) : null);
  if (!dateStr) {
    return null; // Enforce rule: undated dossiers cannot be used in the shared database
  }

  const versionType = p.version?.type || (prime ? 'prime' : 'current');
  const d = new Date(`${dateStr}T12:00:00Z`);
  const monthName = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const season = seasonForDate(dateStr);

  const version = p.version || {
    id: `${toBasePlayerSlug(p.basicInfo.name)}-${versionType}-${dateStr}`,
    type: versionType,
    label: prime
      ? `Prime Zenith (${season})`
      : `Current Form (${monthName} ${d.getUTCFullYear()})`,
    evaluationDate: dateStr,
    seasonOrEra: season,
    peakContext: null,
  };

  return {
    ...p,
    evaluationDate: dateStr,
    // createdAt is when the card was generated. For a prime card that is not its peak date.
    createdAt: p.createdAt || fallbackMs || d.getTime(),
    version: {
      ...version,
      evaluationDate: dateStr,
    },
  };
};

/**
 * Stable identity for one card version of one player. Two cards of the same player share a
 * key only when edition and evaluation date both match.
 */
export const getCardKey = (p: PlayerProfile): string =>
  `${toBasePlayerSlug(p.basicInfo.name)}:${
    isPrimeCard(p) ? p.version?.type ?? 'prime' : 'current'
  }:${getDossierEvaluationDate(p) ?? p.createdAt ?? 'undated'}`;

/**
 * Keeps each player's newest current card, so an archived re-rating never sits next to the
 * live one in locks, peer ledgers or grep results. On equal dates the later entry wins, so list
 * sources from broadest to most local. Prime cards keep their own key.
 */
const latestCardPerPlayer = (cards: PlayerProfile[]): PlayerProfile[] => {
  const byPlayer = new Map<string, PlayerProfile>();
  for (const p of cards) {
    const key = isPrimeCard(p) ? getCardKey(p) : `${toBasePlayerSlug(p.basicInfo.name)}:current`;
    const existing = byPlayer.get(key);
    if (existing && (getDossierEvaluationDate(existing) ?? '') > (getDossierEvaluationDate(p) ?? '')) {
      continue;
    }
    byPlayer.set(key, p);
  }
  return [...byPlayer.values()];
};

/** Immutable archive slug for a dated card, e.g. "joshua-kimmich--current--2026-10-25". */
export const toVersionedSlug = (p: PlayerProfile): string | null => {
  const date = getDossierEvaluationDate(p);
  if (!date) return null;
  const type = isPrimeCard(p) ? p.version?.type ?? 'prime' : 'current';
  return `${toBasePlayerSlug(p.basicInfo.name)}--${type}--${date}`;
};

/** Mutable "latest card" pointer slug. Share links and cache lookups use this one. */
export const toDossierCardSlug = (name: string, isHistorical = false): string => {
  const base = toBasePlayerSlug(name);
  return isHistorical ? `prime-${base}` : base;
};

export const getCachedDossier = async (
  slug: string,
  checkTTL = true,
): Promise<PlayerProfile | null> => {
  if (!supabase || !slug) return null;
  try {
    const { data, error } = await supabase
      .from('player_profiles')
      .select('player_data, updated_at')
      .eq('player_slug', slug)
      .single();
    if (error || !data) return null;
    const updatedAtMs = new Date(data.updated_at).getTime();
    if (
      checkTTL &&
      (Date.now() - updatedAtMs > CACHE_TTL_MS || updatedAtMs < CALIBRATION_EPOCH_MS)
    ) {
      return null;
    }
    const profile = data.player_data as PlayerProfile;
    const dated = ensureDossierDated(profile, updatedAtMs);
    if (!dated) {
      // Undated legacy cards stay viewable through a direct share link, but never serve as cache hits.
      return checkTTL ? null : { ...profile, createdAt: profile.createdAt || updatedAtMs };
    }
    return {
      ...dated,
      createdAt: dated.createdAt || updatedAtMs,
    };
  } catch {
    return null;
  }
};

/**
 * Persists a dated card. Writes the mutable "latest" pointer slug and an immutable versioned
 * slug, and archives whatever card previously occupied the pointer so a re-rating never
 * erases history. The `_slug` argument is kept for call-site compatibility; the pointer slug
 * is derived from the card's own edition.
 */
export const upsertCachedDossier = async (
  _slug: string,
  profile: PlayerProfile,
): Promise<void> => {
  const dated = ensureDossierDated(profile, Date.now());
  if (!dated) return; // Enforce: undated dossiers cannot be used in the shared database

  const stamped: PlayerProfile = {
    ...dated,
    createdAt: dated.createdAt || Date.now(),
  };
  const key = getCardKey(stamped);
  const alias = toDossierCardSlug(stamped.basicInfo.name, isPrimeCard(stamped));
  const versioned = toVersionedSlug(stamped);

  // Update in-memory Supabase calibrated pool immediately
  const existingIdx = supabaseCalibratedPool.findIndex((p) => getCardKey(p) === key);
  if (existingIdx >= 0) {
    supabaseCalibratedPool[existingIdx] = stamped;
  } else {
    supabaseCalibratedPool = [stamped, ...supabaseCalibratedPool];
  }

  if (!supabase) return;
  try {
    const nowIso = new Date().toISOString();
    const rows: Array<{ player_slug: string; player_data: PlayerProfile; updated_at: string }> = [];

    const { data: existing } = await supabase
      .from('player_profiles')
      .select('player_data, updated_at')
      .eq('player_slug', alias)
      .maybeSingle();
    if (existing?.player_data) {
      const prev = ensureDossierDated(
        existing.player_data as PlayerProfile,
        new Date(existing.updated_at).getTime(),
      );
      const prevSlug = prev ? toVersionedSlug(prev) : null;
      if (prev && prevSlug && getCardKey(prev) !== key) {
        rows.push({ player_slug: prevSlug, player_data: prev, updated_at: existing.updated_at });
      }
    }

    rows.push({ player_slug: alias, player_data: stamped, updated_at: nowIso });
    if (versioned) {
      rows.push({ player_slug: versioned, player_data: stamped, updated_at: nowIso });
    }
    await supabase.from('player_profiles').upsert(rows, { onConflict: 'player_slug' });
  } catch (e) {
    console.warn('[Cache] Upsert failed:', e);
  }
};

/**
 * Publishes one card under its immutable versioned slug and returns the slug for a share link.
 * It never touches the "latest" pointer, so sharing an old card can't clobber a newer one.
 */
export const shareDossierCard = async (profile: PlayerProfile): Promise<string> => {
  if (!supabase) throw new Error('Database not available.');
  const dated = ensureDossierDated(profile, Date.now());
  const slug = dated ? toVersionedSlug(dated) : null;
  if (!dated || !slug) {
    throw new Error(
      'This dossier has no verified evaluation date, so it can’t be shared yet. Re-rate the player to generate a dated card.',
    );
  }
  const { error } = await supabase
    .from('player_profiles')
    .upsert(
      { player_slug: slug, player_data: dated, updated_at: new Date().toISOString() },
      { onConflict: 'player_slug' },
    );
  if (error) throw error;
  return slug;
};

/**
 * Fetches post-calibration dossiers from the global Supabase `player_profiles` JSONB table
 * and caches them in memory for 60s so grepDossiers and peer calibration work across devices.
 */
export const fetchSupabaseCalibratedPool = async (): Promise<PlayerProfile[]> => {
  if (!supabase) return supabaseCalibratedPool;
  if (Date.now() - supabasePoolFetchedAt < SUPABASE_POOL_TTL_MS && supabaseCalibratedPool.length > 0) {
    return supabaseCalibratedPool;
  }
  try {
    const epochIso = new Date(CALIBRATION_EPOCH_MS).toISOString();
    const { data, error } = await supabase
      .from('player_profiles')
      .select('player_data, updated_at')
      .gte('updated_at', epochIso)
      .order('updated_at', { ascending: false })
      .limit(60);
    if (!error && Array.isArray(data)) {
      const loaded: PlayerProfile[] = [];
      for (const row of data) {
        const p = row?.player_data as PlayerProfile | undefined;
        if (p && p.basicInfo?.name && p.ratings?.overall >= 60) {
          const dated = ensureDossierDated(p, new Date(row.updated_at).getTime());
          if (dated) {
            loaded.push({
              ...dated,
              createdAt: dated.createdAt || new Date(row.updated_at).getTime(),
            });
          }
        }
      }
      supabaseCalibratedPool = loaded;
      supabasePoolFetchedAt = Date.now();
    }
  } catch {
    // Non-fatal: fall back to current in-memory pool
  }
  return supabaseCalibratedPool;
};

/**
 * Looks up all prior authored dossiers for a given player name across local and Supabase stores.
 * Sorts them chronologically (oldest to newest) so rating progression/trajectory can be weighed.
 */
export async function fetchPriorDossiersForPlayer(
  playerName: string,
  extraPool: PlayerProfile[] = [],
): Promise<PlayerProfile[]> {
  const targetSlug = toBasePlayerSlug(playerName);
  if (!targetSlug) return [];

  // Cards per matching player, so a surname-only request ("Kimmich") can resolve to one player.
  const matchedByPlayer = new Map<string, Map<string, PlayerProfile>>();

  // Exact name match, or a whole-token match for surname-only requests.
  const isSamePlayer = (base: string): boolean =>
    base === targetSlug || (targetSlug.length >= 4 && base.split('-').includes(targetSlug));

  const checkAndAdd = (p: PlayerProfile, fallbackMs?: number) => {
    const dated = ensureDossierDated(p, fallbackMs);
    if (!dated) return;
    const base = toBasePlayerSlug(dated.basicInfo.name);
    if (!isSamePlayer(base)) return;
    if (!matchedByPlayer.has(base)) matchedByPlayer.set(base, new Map());
    matchedByPlayer.get(base)!.set(getCardKey(dated), dated);
  };

  for (const p of extraPool) checkAndAdd(p);
  for (const p of supabaseCalibratedPool) checkAndAdd(p);

  if (supabase && targetSlug.length >= 4) {
    try {
      // Matches the pointer slugs, prime pointer slugs, and every versioned archive slug.
      const { data } = await supabase
        .from('player_profiles')
        .select('player_data, updated_at')
        .ilike('player_slug', `%${targetSlug}%`);
      if (Array.isArray(data)) {
        for (const row of data) {
          if (row?.player_data) {
            checkAndAdd(row.player_data, new Date(row.updated_at).getTime());
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // A surname shared by several rated players ("Silva") is ambiguous: their ratings aren't this
  // player's history, so attach none rather than another player's cards.
  const matched =
    matchedByPlayer.get(targetSlug) ??
    (matchedByPlayer.size === 1 ? [...matchedByPlayer.values()][0] : undefined);
  if (!matched) return [];
  const list = [...matched.values()];
  list.sort((a, b) => (a.evaluationDate || '').localeCompare(b.evaluationDate || ''));
  return list;
}

/**
 * Formats prior authored ratings into a structured prompt block so Futbolpedia weighs
 * previous ratings and evaluation dates when generating a new rating for this player.
 */
export function buildPriorDossierTrajectoryBlock(
  priorDossiers: PlayerProfile[],
  targetPlayer: string,
): string {
  const datedPriors = priorDossiers.filter(isDossierDated);
  if (datedPriors.length === 0) return '';

  const entries = datedPriors.map((p) => {
    const date = p.evaluationDate || formatIsoDate(p.createdAt) || 'Previous Date';
    const edition = p.version?.label || (p.version?.type === 'prime' ? 'Prime Zenith' : 'Current Form');
    const topAttrs = Object.entries(p.attributes || {})
      .filter(([, v]) => typeof v === 'number' && v >= 85)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${ATTRIBUTE_LABELS[k as keyof Attributes] || k} ${v}`)
      .join(', ');

    return `- [${edition} · Evaluated ${date}]: Overall ${p.ratings.overall} / Potential ${p.ratings.potential} (${p.basicInfo.club}, ${p.basicInfo.position})
  Archetype: ${p.playstyleAndRole?.playstyle?.archetype || 'N/A'}${topAttrs ? ` | Key Spikes: ${topAttrs}` : ''}`;
  });

  return `
<prior_authored_dossiers>
Futbolpedia previously authored the following dated dossier card(s) for ${targetPlayer}:
${entries.join('\n')}

TRAJECTORY & RATING MEMORY PROTOCOL:
You are authoring a new evaluation for this player. Factor in this authored historical baseline:
1. Explain or reflect what has changed since that evaluation date (form progression, tactical role change, trophy triumph, age decline, or steady consistency) rather than making arbitrary, ungrounded rating swings.
2. Maintain thoughtful longitudinal consistency while honoring verified recent trajectory.
</prior_authored_dossiers>`;
}

export interface GlobalHubDossierItem {
  profile: PlayerProfile;
  isCurrentRating: boolean;
  trajectoryDiff?: number;
  previousRatingDate?: string;
}

/**
 * Fetches all public dated dossiers from Supabase and local archives for the Global Dossier Hub.
 * Enforces the rule: any dossier that cannot be dated is excluded from this database.
 * Identifies the latest 'current' dated dossier for each player as their official current rating.
 */
export async function fetchGlobalHubDossiers(
  localSaved: PlayerProfile[] = [],
): Promise<GlobalHubDossierItem[]> {
  const mapByCardKey = new Map<string, PlayerProfile>();

  const ingest = (raw: any, fallbackDateMs?: number) => {
    if (!raw || typeof raw !== 'object') return;
    const dated = ensureDossierDated(raw as PlayerProfile, fallbackDateMs);
    if (!dated || !dated.basicInfo?.name || (dated.ratings?.overall ?? 0) < 60) return;
    mapByCardKey.set(getCardKey(dated), dated);
  };

  // 1. Local profiles only stand in when the shared database is unreachable.
  if (!supabase) {
    for (const p of localSaved) ingest(p);
  }

  // 2. Ingest Supabase public player_profiles. Pointer and archive rows for the same card
  // share a card key, so they collapse into one entry.
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('player_profiles')
        .select('player_slug, player_data, updated_at, created_at')
        .order('updated_at', { ascending: false })
        .limit(1000);

      if (!error && Array.isArray(data)) {
        for (const row of data) {
          const fallback = row.updated_at
            ? new Date(row.updated_at).getTime()
            : row.created_at
            ? new Date(row.created_at).getTime()
            : undefined;
          ingest(row.player_data, fallback);
        }
      }
    } catch (e) {
      console.warn('[GlobalHub] Fetch failed:', e);
    }
  }

  const allDossiers = [...mapByCardKey.values()];

  // Group by player normalized name to determine each player's official "Current" rating and trajectory
  const byPlayer = new Map<string, PlayerProfile[]>();
  for (const p of allDossiers) {
    const base = toBasePlayerSlug(p.basicInfo.name);
    if (!byPlayer.has(base)) byPlayer.set(base, []);
    byPlayer.get(base)!.push(p);
  }

  const results: GlobalHubDossierItem[] = [];

  for (const [, cards] of byPlayer.entries()) {
    // Separate current cards from prime cards
    const currentCards = cards
      .filter((c) => c.version?.type === 'current')
      .sort((a, b) => (b.evaluationDate || '').localeCompare(a.evaluationDate || ''));

    const primeCards = cards.filter((c) => c.version?.type !== 'current');

    // Newest current card is the player's official Current rating
    const newestCurrent = currentCards[0];
    const previousCurrent = currentCards[1];

    for (const card of currentCards) {
      const isLatest = card === newestCurrent;
      let trajectoryDiff: number | undefined;
      let previousRatingDate: string | undefined;

      if (isLatest && previousCurrent) {
        trajectoryDiff = card.ratings.overall - previousCurrent.ratings.overall;
        previousRatingDate = previousCurrent.evaluationDate;
      }

      results.push({
        profile: card,
        isCurrentRating: isLatest,
        trajectoryDiff,
        previousRatingDate,
      });
    }

    for (const card of primeCards) {
      results.push({
        profile: card,
        isCurrentRating: false,
      });
    }
  }

  // Sort: current official ratings first, then by Overall descending
  results.sort((a, b) => {
    if (a.isCurrentRating && !b.isCurrentRating) return -1;
    if (!a.isCurrentRating && b.isCurrentRating) return 1;
    return b.profile.ratings.overall - a.profile.ratings.overall;
  });

  return results;
}

const SHARE_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const generateShareCode = (): string =>
  Array.from(
    { length: 6 },
    () => SHARE_CODE_CHARS[Math.floor(Math.random() * SHARE_CODE_CHARS.length)],
  ).join('');

export const shareConversation = async (conv: Conversation): Promise<string> => {
  if (!supabase) throw new Error('Database not available.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateShareCode();
    const { error } = await supabase
      .from('shared_conversations')
      .insert({ share_code: code, conversation_data: conv });
    if (!error) return code;
    if (!error.message?.includes('unique') && !error.message?.includes('duplicate')) throw error;
  }
  throw new Error('Failed to generate a unique share code after 3 attempts.');
};

export const getSharedConversation = async (code: string): Promise<Conversation | null> => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('shared_conversations')
      .select('conversation_data')
      .eq('share_code', code.toUpperCase())
      .single();
    if (error || !data) return null;
    return data.conversation_data as Conversation;
  } catch {
    return null;
  }
};

export const isPlayerProfile = (content: any): content is PlayerProfile =>
  typeof content === 'object' &&
  content !== null &&
  !('players' in content) &&
  'basicInfo' in content &&
  'ratings' in content;

export const isConfidentDossier = (p: PlayerProfile): boolean =>
  !!p?.basicInfo?.name && p.basicInfo.name !== 'N/A' && (p.ratings?.overall ?? 0) > 0;

export const isLegacyComparisonContent = (
  content: unknown,
): content is { summary?: string; players?: PlayerProfile[] } =>
  typeof content === 'object' &&
  content !== null &&
  'summary' in content &&
  'players' in content &&
  Array.isArray((content as { players?: unknown }).players);

export const serializeProfileForHistory = (p: PlayerProfile): string => {
  const bi = p.basicInfo;
  const attrs = p.goalkeeperAttributes
    ? Object.entries(p.goalkeeperAttributes)
        .map(([k, v]) => `${GK_ATTRIBUTE_LABELS[k as keyof GoalkeeperAttributes] ?? k} ${v}`)
        .join(', ')
    : Object.entries(p.attributes)
        .map(([k, v]) => `${ATTRIBUTE_LABELS[k as keyof Attributes] ?? k} ${v}`)
        .join(', ');
  const roles = p.playstyleAndRole?.bestRoles?.join(', ') || 'N/A';
  return [
    `[DOSSIER YOU (Futbolpedia) PREVIOUSLY GENERATED — this is your authored analysis; stay consistent with it unless you explicitly revise a value and say so]`,
    `Name: ${bi?.name} | Age: ${bi?.age} | Nationality: ${bi?.nationality} | Club: ${bi?.club} | Position: ${bi?.position}`,
    p.version
      ? `Edition: ${p.version.label} | Evaluated: ${getDossierEvaluationDate(p) ?? 'undated'}`
      : '',
    `Overall: ${p.ratings?.overall} | Potential: ${p.ratings?.potential}`,
    `Archetype: ${p.playstyleAndRole?.playstyle?.archetype} | Best Roles: ${roles}`,
    `${p.goalkeeperAttributes ? 'Goalkeeper Attributes' : 'Attributes'} (0-99): ${attrs}`,
    p.strengths?.length ? `Strengths: ${p.strengths.join(' ')}` : '',
    p.weaknesses?.length ? `Weaknesses: ${p.weaknesses.join(' ')}` : '',
    p.playstyleAndRole?.playstyle?.description
      ? `Playstyle: ${p.playstyleAndRole.playstyle.description}`
      : '',
    p.shortBio ? `Bio: ${p.shortBio}` : '',
    p.latestUpdate ? `Latest Update: ${p.latestUpdate}` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

export const serializeLegacyComparisonForHistory = (content: {
  summary?: string;
  players?: PlayerProfile[];
}): string => {
  const players = (content.players || []).map(serializeProfileForHistory).join('\n\n');
  return [
    `[COMPARISON YOU (Futbolpedia) PREVIOUSLY GENERATED — stay consistent with these ratings unless you explicitly revise them]`,
    content.summary ? `Summary: ${content.summary}` : '',
    players,
  ]
    .filter(Boolean)
    .join('\n\n');
};

export const collectDossiersFromHistory = (history: ChatMessage[]): PlayerProfile[] => {
  const out: PlayerProfile[] = [];
  for (const msg of history) {
    if (msg.sender !== 'ai') continue;
    if (isPlayerProfile(msg.content)) {
      if (isConfidentDossier(msg.content)) out.push(msg.content);
    } else if (isLegacyComparisonContent(msg.content)) {
      for (const p of msg.content.players || []) {
        if (isConfidentDossier(p)) out.push(p);
      }
    }
  }
  return out;
};

export const mergeConversationDossiers = (
  history: ChatMessage[],
  conversationProfiles: PlayerProfile[] = [],
): PlayerProfile[] => {
  return latestCardPerPlayer([
    ...collectDossiersFromHistory(history),
    ...conversationProfiles.filter(isConfidentDossier),
  ]);
};

const dossierSlugsCoveredInHistory = (history: ChatMessage[]): Set<string> => {
  const slugs = new Set<string>();
  for (const msg of history) {
    if (msg.sender !== 'ai') continue;
    if (isPlayerProfile(msg.content)) {
      slugs.add(getCardKey(msg.content));
    } else if (isLegacyComparisonContent(msg.content)) {
      for (const p of msg.content.players || []) {
        slugs.add(getCardKey(p));
      }
    }
  }
  return slugs;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const findReferencedDossiers = (
  message: string,
  dossiers: PlayerProfile[],
  explicitNames: string[] = [],
): PlayerProfile[] => {
  if (dossiers.length === 0) return [];
  const lower = message.toLowerCase();
  const matched = new Map<string, PlayerProfile>();

  const checkText = [lower, ...explicitNames.map((n) => n.toLowerCase())].join(' ');

  for (const d of dossiers) {
    const name = d.basicInfo.name.toLowerCase();
    const tokens = name.split(/\s+/).filter((t) => t.length >= 4);
    const hit =
      checkText.includes(name) ||
      tokens.some((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`).test(checkText));
    if (hit) matched.set(getCardKey(d), d);
  }

  if (matched.size === 0 && /\b(he|him|his|they|them|their)\b/i.test(message)) {
    const latest = dossiers[dossiers.length - 1];
    matched.set(getCardKey(latest), latest);
  }

  return [...matched.values()];
};

export const buildLockedDossiersBlock = (dossiers: PlayerProfile[]): string => {
  if (dossiers.length === 0) return '';
  const body = dossiers.map(serializeProfileForHistory).join('\n\n');
  return `
    <locked_dossiers>
    The player(s) below were ALREADY rated earlier in this conversation. These dossiers are LAW: reuse the EXACT Overall, Potential, and all attribute values shown — do NOT recompute or drift them. Prose may be reworded, but every number must match. Only a player NOT listed here may be rated fresh from the factual foundation.
    ${body}
    </locked_dossiers>`;
};

export const wantsSavedDossierAccess = (message: string): boolean =>
  /\b(my|saved|archived|other|previous)\s+(dossiers?|profiles?|scouts?|ratings?)\b/i.test(
    message,
  ) ||
  /\bdossiers?\s+(i|I've|I have|I've got)\b/i.test(message) ||
  /\b(from|in)\s+my\s+(saved|archive|dossiers?|library|collection)\b/i.test(message) ||
  /\b(pull up|look up|check|use|reference|show|open|view|load)\s+(my|a|the)\s+(saved|archived)\b/i.test(
    message,
  ) ||
  (/\b(what|which|list|show)\b[\s\S]{0,40}\b(dossiers?|profiles?)\b/i.test(message) &&
    /\b(have|saved|got|my|archive)\b/i.test(message)) ||
  /\blist\s+(my\s+)?(saved\s+)?dossiers\b/i.test(message);

export const wantsSavedDossierInventory = (message: string): boolean =>
  /\b(what|which|list|show)\b/i.test(message) &&
  /\b(dossiers?|profiles?)\b/i.test(message) &&
  /\b(have|saved|got|my|archive|collection)\b/i.test(message) &&
  !/\b(rate|scout|profile|evaluate|analyze|breakdown|dossier)\s+(for|on|of)\b/i.test(message);

const serializeSavedProfileForContext = (p: PlayerProfile): string =>
  serializeProfileForHistory(p).replace(
    '[DOSSIER YOU (Futbolpedia) PREVIOUSLY GENERATED — this is your authored analysis; stay consistent with it unless you explicitly revise a value and say so]',
    "[USER'S SAVED DOSSIER — from their archive (generated in another conversation). Treat as authoritative when they ask you to reference saved/archived profiles.]",
  );

export const buildSavedDossiersBlock = (
  dossiers: PlayerProfile[],
  inventoryOnly: boolean,
): string => {
  const confident = dossiers.filter(isConfidentDossier);
  if (confident.length === 0) return '';
  if (inventoryOnly) {
    const rows = confident
      .map(
        (p) =>
          `- ${p.basicInfo.name}: ${p.ratings.overall} OVR (Pot ${p.ratings.potential}), ${p.basicInfo.club}, ${p.basicInfo.position}`,
      )
      .join('\n');
    return `
    <saved_dossier_archive>
    The user asked about dossiers they have saved on file (${confident.length} total). Index only — summarize this list conversationally if they want an overview; if they name a player, use their full saved dossier when provided.
    ${rows}
    </saved_dossier_archive>`;
  }
  const body = confident.map(serializeSavedProfileForContext).join('\n\n');
  return `
    <saved_dossiers>
    The user explicitly asked you to reference dossier(s) from their saved archive (profiles generated in other conversations). Use these exact ratings and attributes — do NOT regenerate or contradict them unless they ask for a fresh rating.
    ${body}
    </saved_dossiers>`;
};

export const resolveSavedDossiersForRequest = (
  message: string,
  savedDossiers: PlayerProfile[],
  conversationDossiers: PlayerProfile[],
  explicitNames: string[] = [],
): { dossiers: PlayerProfile[]; inventoryOnly: boolean } => {
  const confident = latestCardPerPlayer(savedDossiers.filter(isConfidentDossier));
  if (confident.length === 0 || !wantsSavedDossierAccess(message)) {
    return { dossiers: [], inventoryOnly: false };
  }

  const convSlugs = new Set(conversationDossiers.map((p) => getCardKey(p)));
  const referenced = findReferencedDossiers(message, confident, explicitNames);
  const inventoryOnly = wantsSavedDossierInventory(message) && referenced.length === 0;

  if (inventoryOnly) return { dossiers: confident, inventoryOnly: true };

  if (referenced.length > 0) {
    const notInConversation = referenced.filter(
      (p) => !convSlugs.has(getCardKey(p)),
    );
    return {
      dossiers: notInConversation.length > 0 ? notInConversation : referenced,
      inventoryOnly: false,
    };
  }

  return { dossiers: confident, inventoryOnly: true };
};

const MAX_HISTORY_TURNS = 12;

export const buildHistoryContents = (
  history: ChatMessage[],
  conversationProfiles: PlayerProfile[] = [],
): Content[] => {
  const recentHistory = history.slice(-MAX_HISTORY_TURNS);
  const geminiHistory: Content[] = recentHistory
    .map((msg): Content | null => {
      const isUser = msg.sender === 'user';
      const parts: any[] = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (isPlayerProfile(msg.content) && !isUser) {
        parts.push({ text: serializeProfileForHistory(msg.content) });
      } else if (isLegacyComparisonContent(msg.content) && !isUser) {
        parts.push({ text: serializeLegacyComparisonForHistory(msg.content) });
      }

      if (msg.image && isUser) {
        const [mimeType, base64Data] = msg.image.split(';base64,');
        parts.push({
          inlineData: {
            data: base64Data,
            mimeType: mimeType.replace('data:', ''),
          },
        });
      }

      if (parts.length > 0) {
        return {
          role: isUser ? 'user' : 'model',
          parts,
        };
      }
      return null;
    })
    .filter((item): item is Content => item !== null);

  const covered = dossierSlugsCoveredInHistory(history);
  for (const p of conversationProfiles) {
    if (!isConfidentDossier(p)) continue;
    if (covered.has(getCardKey(p))) continue;
    geminiHistory.push({
      role: 'model',
      parts: [{ text: serializeProfileForHistory(p) }],
    });
  }

  return geminiHistory;
};

export interface DossierPatch {
  targetPlayerName: string;
  position?: string;
  club?: string;
  overall?: number;
  potential?: number;
  attributes?: Partial<Attributes>;
  goalkeeperAttributes?: Partial<GoalkeeperAttributes>;
  strengths?: string[];
  weaknesses?: string[];
  archetype?: string;
  playstyleDescription?: string;
  bestRoles?: string[];
  latestUpdate?: string;
}

export function applyDossierPatch(base: PlayerProfile, patch: DossierPatch): PlayerProfile {
  const clamp = (v: number | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0
      ? Math.max(1, Math.min(99, Math.round(v)))
      : fallback;

  const updatedAttributes: Attributes = { ...base.attributes };
  if (patch.attributes) {
    for (const [k, val] of Object.entries(patch.attributes)) {
      if (k in updatedAttributes && typeof val === 'number' && Number.isFinite(val) && val > 0) {
        updatedAttributes[k as keyof Attributes] = clamp(val, updatedAttributes[k as keyof Attributes]);
      }
    }
  }

  let updatedGkAttributes = base.goalkeeperAttributes
    ? { ...base.goalkeeperAttributes }
    : undefined;
  if (patch.goalkeeperAttributes && updatedGkAttributes) {
    for (const [k, val] of Object.entries(patch.goalkeeperAttributes)) {
      if (k in updatedGkAttributes && typeof val === 'number' && Number.isFinite(val) && val > 0) {
        updatedGkAttributes[k as keyof GoalkeeperAttributes] = clamp(
          val,
          updatedGkAttributes[k as keyof GoalkeeperAttributes],
        );
      }
    }
  }

  return {
    ...base,
    basicInfo: {
      ...base.basicInfo,
      position: patch.position ? normalizePosition(patch.position) : base.basicInfo.position,
      club: patch.club ? normalizeClub(patch.club) : base.basicInfo.club,
    },
    ratings: {
      overall: clamp(patch.overall, base.ratings.overall),
      potential: clamp(patch.potential, base.ratings.potential),
    },
    attributes: updatedAttributes,
    ...(updatedGkAttributes ? { goalkeeperAttributes: updatedGkAttributes } : {}),
    strengths:
      Array.isArray(patch.strengths) && patch.strengths.length > 0
        ? patch.strengths
        : base.strengths,
    weaknesses:
      Array.isArray(patch.weaknesses) && patch.weaknesses.length > 0
        ? patch.weaknesses
        : base.weaknesses,
    playstyleAndRole: {
      playstyle: {
        archetype: patch.archetype || base.playstyleAndRole.playstyle.archetype,
        description:
          patch.playstyleDescription || base.playstyleAndRole.playstyle.description,
      },
      bestRoles:
        Array.isArray(patch.bestRoles) && patch.bestRoles.length > 0
          ? patch.bestRoles
          : base.playstyleAndRole.bestRoles,
    },
    latestUpdate: patch.latestUpdate || base.latestUpdate,
    createdAt: Date.now(),
  };
}

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
  if ((f === 'cb' || f.includes('center back') || f.includes('centre back')) && p.includes('centre-back')) return true;
  if ((f === 'lb' || f === 'rb' || f.includes('fullback') || f.includes('full-back')) && p.includes('back') && !p.includes('centre-back')) return true;
  if (f.includes('defend') && (p.includes('back') || p.includes('defensive midfielder'))) return true;
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
    [...supabaseCalibratedPool, ...dossiers].filter(isConfidentDossier),
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
    [...supabaseCalibratedPool, ...savedDossiers, ...conversationDossiers].filter(
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
    return 'Striker';
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
    const topSpikes = Object.entries(p.attributes || {})
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${ATTRIBUTE_LABELS[k as keyof Attributes] || k} ${v}`)
      .join(', ');
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
