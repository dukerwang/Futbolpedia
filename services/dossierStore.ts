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
    return {
      ...profile,
      createdAt: profile.createdAt || updatedAtMs,
    };
  } catch {
    return null;
  }
};

export const upsertCachedDossier = async (slug: string, profile: PlayerProfile): Promise<void> => {
  if (!slug) return;
  const stamped: PlayerProfile = {
    ...profile,
    createdAt: profile.createdAt || Date.now(),
  };
  // Update in-memory Supabase calibrated pool immediately
  const existingIdx = supabaseCalibratedPool.findIndex(
    (p) => toPlayerSlug(p.basicInfo.name) === slug,
  );
  if (existingIdx >= 0) {
    supabaseCalibratedPool[existingIdx] = stamped;
  } else {
    supabaseCalibratedPool = [stamped, ...supabaseCalibratedPool];
  }

  if (!supabase) return;
  try {
    await supabase.from('player_profiles').upsert(
      { player_slug: slug, player_data: stamped, updated_at: new Date().toISOString() },
      { onConflict: 'player_slug' },
    );
  } catch (e) {
    console.warn('[Cache] Upsert failed:', e);
  }
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
          loaded.push({
            ...p,
            createdAt: p.createdAt || new Date(row.updated_at).getTime(),
          });
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
  const bySlug = new Map<string, PlayerProfile>();
  for (const p of collectDossiersFromHistory(history)) {
    bySlug.set(toPlayerSlug(p.basicInfo.name), p);
  }
  for (const p of conversationProfiles) {
    if (isConfidentDossier(p)) bySlug.set(toPlayerSlug(p.basicInfo.name), p);
  }
  return [...bySlug.values()];
};

const dossierSlugsCoveredInHistory = (history: ChatMessage[]): Set<string> => {
  const slugs = new Set<string>();
  for (const msg of history) {
    if (msg.sender !== 'ai') continue;
    if (isPlayerProfile(msg.content)) {
      slugs.add(toPlayerSlug(msg.content.basicInfo.name));
    } else if (isLegacyComparisonContent(msg.content)) {
      for (const p of msg.content.players || []) {
        slugs.add(toPlayerSlug(p.basicInfo.name));
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
    if (hit) matched.set(toPlayerSlug(d.basicInfo.name), d);
  }

  if (matched.size === 0 && /\b(he|him|his|they|them|their)\b/i.test(message)) {
    const latest = dossiers[dossiers.length - 1];
    matched.set(toPlayerSlug(latest.basicInfo.name), latest);
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
  const confident = savedDossiers.filter(isConfidentDossier);
  if (confident.length === 0 || !wantsSavedDossierAccess(message)) {
    return { dossiers: [], inventoryOnly: false };
  }

  const convSlugs = new Set(conversationDossiers.map((p) => toPlayerSlug(p.basicInfo.name)));
  const referenced = findReferencedDossiers(message, confident, explicitNames);
  const inventoryOnly = wantsSavedDossierInventory(message) && referenced.length === 0;

  if (inventoryOnly) return { dossiers: confident, inventoryOnly: true };

  if (referenced.length > 0) {
    const notInConversation = referenced.filter(
      (p) => !convSlugs.has(toPlayerSlug(p.basicInfo.name)),
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
    if (covered.has(toPlayerSlug(p.basicInfo.name))) continue;
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
  const bySlug = new Map<string, PlayerProfile>();
  for (const d of [...supabaseCalibratedPool, ...dossiers]) {
    if (isConfidentDossier(d)) {
      bySlug.set(toPlayerSlug(d.basicInfo.name), d);
    }
  }
  let pool = [...bySlug.values()];

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
  const bySlug = new Map<string, PlayerProfile>();
  // Order from broadest (Supabase pool) to most local (savedDossiers -> conversationDossiers)
  for (const d of [...supabaseCalibratedPool, ...savedDossiers, ...conversationDossiers]) {
    if (!isConfidentDossier(d)) continue;
    if (!d.createdAt || d.createdAt < CALIBRATION_EPOCH_MS) continue;
    bySlug.set(toPlayerSlug(d.basicInfo.name), d);
  }
  return [...bySlug.values()];
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
    selectedBySlug.set(toPlayerSlug(t.basicInfo.name), t);
  }

  // 2. Prioritize same-position calibrated peers across all rating tiers (up to 10)
  if (detectedPos) {
    const positionalPeers = sortedAll.filter((p) =>
      matchesPositionalFilter(p.basicInfo.position, detectedPos),
    );
    for (const p of positionalPeers.slice(0, 10)) {
      selectedBySlug.set(toPlayerSlug(p.basicInfo.name), p);
    }
  }

  // 3. Fill remaining slots up to 18 with global top-rated anchors
  for (const p of sortedAll) {
    if (selectedBySlug.size >= 18) break;
    selectedBySlug.set(toPlayerSlug(p.basicInfo.name), p);
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
    return `- ${p.basicInfo.name} (${p.basicInfo.position}, ${p.basicInfo.club}): ${p.ratings.overall} OVR / ${p.ratings.potential} POT${topSpikes ? ` [Spikes: ${topSpikes}]` : ''}${queriedSlice ? ` [Queried: ${queriedSlice}]` : ''}`;
  });

  return `
<calibrated_peer_ledger>
Active peer benchmarks already rated on this user's calibrated Futbolpedia ledger (maintain strict relative consistency with these ratings):
${lines.join('\n')}
</calibrated_peer_ledger>`;
}
