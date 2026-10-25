import type { Conversation, PlayerProfile } from '../types';
import {
  ensureDossierDated,
  getCardKey,
  isCardInRefreshWindow,
  isPrimeCard,
  toBasePlayerSlug,
  toDossierCardSlug,
  toVersionedSlug,
} from './dossierCards';

/**
 * Supabase-backed storage: the shared dossier cache with its versioned archive, the shared
 * calibrated pool, card and conversation sharing, and the Global Dossier Hub feed.
 */

const supabaseUrl = 'https://hrocnbcavstmjysptjdk.supabase.co';
const supabaseKey = 'sb_publishable_NKyG9miYqS8JgdpgWuXm9A_tc3vaVCL';

export const supabase =
  typeof window !== 'undefined' && (window as any).supabase
    ? (window as any).supabase.createClient(supabaseUrl, supabaseKey)
    : null;

export const isSupabaseReady = () => !!supabase;

// Invalidate cached dossiers created before the v4.1 rating calibration update
// so previously under-calibrated dossiers regenerate fresh when requested.
export const CALIBRATION_EPOCH_MS = Date.parse('2026-10-20T21:15:00Z');

/**
 * Whether a card was rated on the current scale. Uses the card's own creation stamp, falling back
 * to its row time, because re-sharing an old card gives its row a fresh timestamp. Cards rated
 * before the recalibration must never feed trajectory memory, the Hub, or the shared store: their
 * numbers would pull new ratings back toward the old scale.
 */
export const isRatedOnCurrentScale = (p: PlayerProfile, rowTimeMsFallback?: number): boolean => {
  const ratedAtMs = p.createdAt || rowTimeMsFallback;
  return !!ratedAtMs && ratedAtMs >= CALIBRATION_EPOCH_MS;
};

let supabaseCalibratedPool: PlayerProfile[] = [];
let supabasePoolFetchedAt = 0;
const SUPABASE_POOL_TTL_MS = 60 * 1000; // 60 seconds

/** Cards last loaded from (or written to) Supabase, without triggering a fetch. */
export const getSupabaseCalibratedPool = (): PlayerProfile[] => supabaseCalibratedPool;

interface PlayerProfileRow {
  player_slug?: string;
  player_data: PlayerProfile;
  updated_at: string;
  created_at?: string;
}

const rowTimeMs = (iso: string): number => new Date(iso).getTime();

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
    const updatedAtMs = rowTimeMs(data.updated_at);
    const profile = data.player_data as PlayerProfile;
    const dated = ensureDossierDated(profile, updatedAtMs);
    // Direct share links show any card, including undated legacy ones.
    if (!checkTTL) return dated ?? { ...profile, createdAt: profile.createdAt || updatedAtMs };
    // A cache hit must be dated, post-recalibration, and (for current form) this month's card.
    if (!dated || updatedAtMs < CALIBRATION_EPOCH_MS || !isCardInRefreshWindow(dated)) return null;
    return dated;
  } catch {
    return null;
  }
};

/**
 * Persists a dated card. Writes the mutable "latest" pointer slug and an immutable versioned
 * slug, and archives whatever card previously occupied the pointer so a re-rating never
 * erases history. The `_slug` argument is kept for call-site compatibility; the pointer slug
 * is derived from the card's own edition. A user's revision is never written here, and
 * `supersede` (consensus from several challengers) lets a re-rating replace this month's card.
 */
export const upsertCachedDossier = async (
  _slug: string,
  profile: PlayerProfile,
  options: { supersede?: boolean } = {},
): Promise<void> => {
  if (profile.revision) return; // Personal revisions never replace the shared card
  const stamped = ensureDossierDated(profile, Date.now());
  if (!stamped) return; // Enforce: undated dossiers cannot be used in the shared database

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
    const rows: PlayerProfileRow[] = [];

    const { data: existing } = await supabase
      .from('player_profiles')
      .select('player_data, updated_at')
      .eq('player_slug', alias)
      .maybeSingle();
    if (existing?.player_data) {
      const prev = ensureDossierDated(
        existing.player_data as PlayerProfile,
        rowTimeMs(existing.updated_at),
      );
      // One current card per player per month: if another session already published this
      // month's card while this one was being synthesized, that card stays the shared one.
      if (
        !options.supersede &&
        prev &&
        !isPrimeCard(prev) &&
        !isPrimeCard(stamped) &&
        getCardKey(prev) !== key &&
        rowTimeMs(existing.updated_at) >= CALIBRATION_EPOCH_MS &&
        isCardInRefreshWindow(prev)
      ) {
        return;
      }
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
 * Writes a refreshed Latest Update onto the shared current card. Only the "latest" pointer row
 * changes (archive rows are immutable), and only while it still holds the same dated card, so a
 * re-rating published in the meantime is never overwritten. The refresh window trigger allows
 * this write because the evaluation date doesn't change.
 */
export const publishLatestUpdate = async (profile: PlayerProfile): Promise<void> => {
  if (profile.revision || isPrimeCard(profile)) return;
  const key = getCardKey(profile);
  const idx = supabaseCalibratedPool.findIndex((p) => getCardKey(p) === key);
  if (idx >= 0) supabaseCalibratedPool[idx] = profile;

  if (!supabase) return;
  try {
    const alias = toDossierCardSlug(profile.basicInfo.name);
    const { data: existing } = await supabase
      .from('player_profiles')
      .select('player_data, updated_at')
      .eq('player_slug', alias)
      .maybeSingle();
    const current = existing?.player_data
      ? ensureDossierDated(existing.player_data as PlayerProfile, rowTimeMs(existing.updated_at))
      : null;
    if (!current || getCardKey(current) !== key) return;
    await supabase
      .from('player_profiles')
      .update({ player_data: profile, updated_at: new Date().toISOString() })
      .eq('player_slug', alias);
  } catch (e) {
    console.warn('[Cache] Latest Update write failed:', e);
  }
};

/**
 * Publishes one card under its immutable versioned slug and returns the slug for a share link.
 * It never touches the "latest" pointer, so sharing an old card can't clobber a newer one.
 */
export const shareDossierCard = async (profile: PlayerProfile): Promise<string> => {
  if (!supabase) throw new Error('Database not available.');
  if (!isRatedOnCurrentScale(profile)) {
    throw new Error(
      'This dossier was rated on Futbolpedia’s previous rating scale, so it can’t be shared. Re-rate the player to share a current card.',
    );
  }
  const dated = ensureDossierDated(profile, Date.now());
  const versioned = dated ? toVersionedSlug(dated) : null;
  // A revision gets its own slug so sharing it never overwrites the shared card's archive row.
  const slug =
    versioned && profile.revision
      ? `${versioned}--rev-${profile.revision.revisedAt.toString(36)}`
      : versioned;
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
      for (const row of data as PlayerProfileRow[]) {
        const p = row?.player_data;
        if (p && p.basicInfo?.name && p.ratings?.overall >= 60) {
          const dated = ensureDossierDated(p, rowTimeMs(row.updated_at));
          if (dated && !dated.revision) loaded.push(dated);
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
    if (!isRatedOnCurrentScale(p, fallbackMs)) return;
    const dated = ensureDossierDated(p, fallbackMs);
    if (!dated || dated.revision) return;
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
        for (const row of data as PlayerProfileRow[]) {
          if (row?.player_data) {
            checkAndAdd(row.player_data, rowTimeMs(row.updated_at));
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

  const ingest = (raw: unknown, fallbackDateMs?: number) => {
    if (!raw || typeof raw !== 'object') return;
    if (!isRatedOnCurrentScale(raw as PlayerProfile, fallbackDateMs)) return;
    const dated = ensureDossierDated(raw as PlayerProfile, fallbackDateMs);
    if (!dated || dated.revision || !dated.basicInfo?.name || (dated.ratings?.overall ?? 0) < 60) {
      return;
    }
    mapByCardKey.set(getCardKey(dated), dated);
  };

  if (supabase) {
    // Pointer and archive rows for the same card share a card key, so they collapse into one entry.
    try {
      const { data, error } = await supabase
        .from('player_profiles')
        .select('player_slug, player_data, updated_at, created_at')
        .order('updated_at', { ascending: false })
        .limit(1000);

      if (!error && Array.isArray(data)) {
        for (const row of data as PlayerProfileRow[]) {
          const fallback = row.updated_at
            ? rowTimeMs(row.updated_at)
            : row.created_at
              ? rowTimeMs(row.created_at)
              : undefined;
          ingest(row.player_data, fallback);
        }
      }
    } catch (e) {
      console.warn('[GlobalHub] Fetch failed:', e);
    }
  } else {
    // Local profiles only stand in when the shared database is unreachable.
    for (const p of localSaved) ingest(p);
  }

  // Group by player to pick each player's official "Current" rating and trajectory.
  const byPlayer = new Map<string, PlayerProfile[]>();
  for (const p of mapByCardKey.values()) {
    const base = toBasePlayerSlug(p.basicInfo.name);
    if (!byPlayer.has(base)) byPlayer.set(base, []);
    byPlayer.get(base)!.push(p);
  }

  const results: GlobalHubDossierItem[] = [];

  for (const cards of byPlayer.values()) {
    // Newest current card is the player's official Current rating.
    const currentCards = cards
      .filter((c) => c.version?.type === 'current')
      .sort((a, b) => (b.evaluationDate || '').localeCompare(a.evaluationDate || ''));
    const [newestCurrent, previousCurrent] = currentCards;

    for (const card of currentCards) {
      const isLatest = card === newestCurrent;
      const previous = isLatest ? previousCurrent : undefined;
      results.push({
        profile: card,
        isCurrentRating: isLatest,
        trajectoryDiff: previous && card.ratings.overall - previous.ratings.overall,
        previousRatingDate: previous?.evaluationDate,
      });
    }

    for (const card of cards) {
      if (card.version?.type !== 'current') results.push({ profile: card, isCurrentRating: false });
    }
  }

  // Sort: current official ratings first, then by Overall descending
  results.sort((a, b) => {
    if (a.isCurrentRating !== b.isCurrentRating) return a.isCurrentRating ? -1 : 1;
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
