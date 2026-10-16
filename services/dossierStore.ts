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
    if (checkTTL && Date.now() - new Date(data.updated_at).getTime() > CACHE_TTL_MS) return null;
    return data.player_data as PlayerProfile;
  } catch {
    return null;
  }
};

export const upsertCachedDossier = async (slug: string, profile: PlayerProfile): Promise<void> => {
  if (!supabase || !slug) return;
  try {
    await supabase.from('player_profiles').upsert(
      { player_slug: slug, player_data: profile, updated_at: new Date().toISOString() },
      { onConflict: 'player_slug' },
    );
  } catch (e) {
    console.warn('[Cache] Upsert failed:', e);
  }
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

export const buildHistoryContents = (
  history: ChatMessage[],
  conversationProfiles: PlayerProfile[] = [],
): Content[] => {
  const geminiHistory: Content[] = history
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
  };
}
