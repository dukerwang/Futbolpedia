import { normalizeClub } from '../constants/ratingTiers';
import {
  sameCoach,
  type VerifiedClubManager,
} from '../packages/engine/src/gates/managerMentions.ts';
import { toPlayerSlug } from './dossierCards';
import { supabase } from './dossierCache';
import { getLive } from './researchTools';

/**
 * Verified current head coach per club. API-Football lags managerial changes and model memory
 * is worse, so the source of truth is a focused Google-grounded search, cross-checked against
 * API-Football's record and shared through the Supabase `club_managers` table. A club is looked
 * up at most once a day across all users; nothing here is maintained by hand.
 *
 * The search and the write happen on the server (`services/clubManagerServer.ts`), which alone can
 * write the table. A browser reads stored rows and, for a missing or stale one, asks the server by
 * club name, so it never supplies a coach.
 */
export interface ClubManagerRecord {
  club: string;
  /** Null when the search could not confirm a coach; callers then name nobody. */
  coach: string | null;
  previousCoach: string | null;
  coachSince: string | null;
  sourceUrl: string | null;
  sourceDate: string | null;
  apiCoach: string | null;
  /** Whether the search and API-Football agree; null when API-Football had no record. */
  sourcesAgree: boolean | null;
  /** YYYY-MM-DD of the lookup. */
  verifiedOn: string;
}

export const CLUB_MANAGER_REFRESH_MS = 24 * 60 * 60 * 1000;
/** How far ahead of this clock a stored row's date may be before the row is ignored. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export const toClubKey = (club: string): string => toPlayerSlug(normalizeClub(club.trim()));

const CLUB_NAME_MAX_CHARS = 60;
const CLUB_NAME_MAX_WORDS = 8;

/**
 * A club name that is safe to look up and store, else null. The lookup puts the name into a search
 * prompt and files the answer under `toClubKey(name)`, which keeps only Latin letters and digits.
 * Any other letter would reach the prompt without changing the key, so a caller could add
 * instructions to a real club's name and decide what is stored on its row. Every letter and digit
 * therefore has to count toward the key, and the name has to be short, plain text.
 */
export function readClubName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw
    .normalize('NFC')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/ +/g, ' ')
    .trim();
  if (!name || name === 'N/A' || name.length > CLUB_NAME_MAX_CHARS) return null;
  if (!/^[\p{L}\p{N} .,'\u2019&()\/-]+$/u.test(name)) return null;
  if (name.split(' ').length > CLUB_NAME_MAX_WORDS) return null;
  if ((name.match(/[\p{L}\p{N}]/gu) ?? []).some((ch) => !toPlayerSlug(ch))) return null;
  return toClubKey(name) ? name : null;
}

const clubTokens = (club: string): string[] =>
  toClubKey(club)
    .split('-')
    .filter((t) => t && !/^(?:fc|cf|afc)$/.test(t));

/**
 * Whether two names refer to the same club, allowing for how sources spell it ("Al Hilal",
 * "Al-Hilal Saudi FC"): the shorter name's words appear, in order, in the longer one's.
 */
export const isSameClub = (a: string, b: string): boolean => {
  const [x, y] = [clubTokens(a), clubTokens(b)].sort((p, q) => p.length - q.length);
  if (x.length === 0) return false;
  for (let i = 0; i + x.length <= y.length; i++) {
    if (x.every((t, j) => y[i + j] === t)) return true;
  }
  return false;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v: string | undefined): string | null => (v && ISO_DATE.test(v) ? v : null);
const asName = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t && !/^(unknown|none|n\/?a|null|-)$/i.test(t) ? t : null;
};

/**
 * Parses the lookup's one-line answer:
 * `COACH: <name> | SINCE: <YYYY-MM-DD> | PREVIOUS: <name> | SOURCE_DATE: <YYYY-MM-DD>`.
 * Fields may come in any order; anything unconfirmed is null.
 */
export function parseManagerLookup(text: string): {
  coach: string | null;
  coachSince: string | null;
  previousCoach: string | null;
  sourceDate: string | null;
} {
  const field = (label: string): string | undefined =>
    text.match(new RegExp(`${label}\\s*:\\s*([^|\\n]+)`, 'i'))?.[1]?.trim();
  return {
    coach: asName(field('COACH')),
    coachSince: asDate(field('SINCE')),
    previousCoach: asName(field('PREVIOUS')),
    sourceDate: asDate(field('SOURCE_DATE')),
  };
}

/**
 * Cross-checks the search answer against API-Football. The search wins any disagreement,
 * because API-Football is the source known to lag; with no search answer, nobody is named.
 */
export function reconcileManagerSources(
  searchCoach: string | null,
  apiCoach: string | null,
): { coach: string | null; sourcesAgree: boolean | null } {
  if (!searchCoach) return { coach: null, sourcesAgree: null };
  if (!apiCoach) return { coach: searchCoach, sourcesAgree: null };
  return { coach: searchCoach, sourcesAgree: sameCoach(searchCoach, apiCoach) };
}

/** Whether a stored record is recent enough to reuse instead of searching again. */
export const isClubManagerFresh = (verifiedAtMs: number, nowMs: number = Date.now()): boolean =>
  nowMs - verifiedAtMs < CLUB_MANAGER_REFRESH_MS && verifiedAtMs - nowMs <= CLOCK_SKEW_MS;

/** A `club_managers` row. */
export interface ClubManagerRow {
  club_key: string;
  club_name: string;
  coach: string | null;
  previous_coach: string | null;
  coach_since: string | null;
  source_url: string | null;
  source_date: string | null;
  api_coach: string | null;
  sources_agree: boolean | null;
  verified_at: string;
}

export const rowToClubManager = (row: ClubManagerRow): ClubManagerRecord => ({
  club: row.club_name,
  coach: row.coach ?? null,
  previousCoach: row.previous_coach ?? null,
  coachSince: row.coach_since ?? null,
  sourceUrl: row.source_url ?? null,
  sourceDate: row.source_date ?? null,
  apiCoach: row.api_coach ?? null,
  sourcesAgree: row.sources_agree ?? null,
  verifiedOn: String(row.verified_at).slice(0, 10),
});

/** A coach record and how long it may be reused. */
export interface ClubManagerAnswer {
  record: ClubManagerRecord;
  freshForMs: number;
}

/** Where `getClubManager` gets a record its memory doesn't hold. Null means no answer this time. */
export type ClubManagerSource = (club: string) => Promise<ClubManagerAnswer | null>;

/** A lookup is a grounded search on the server; past this the turn stops waiting. */
const SERVER_LOOKUP_TIMEOUT_MS = 60_000;

/** The shared row when it's fresh, else the server's lookup (`GET /api/clubs/manager`). */
const sharedSource: ClubManagerSource = async (club) => {
  if (supabase) {
    try {
      const { data } = await supabase.from('club_managers').select('*').eq('club_key', toClubKey(club)).maybeSingle();
      const atMs = data ? Date.parse(data.verified_at) : NaN;
      if (data && isClubManagerFresh(atMs)) {
        return { record: rowToClubManager(data), freshForMs: atMs + CLUB_MANAGER_REFRESH_MS - Date.now() };
      }
    } catch (e) {
      console.warn('[ClubManagers] Read failed:', e);
    }
  }
  const res = await getLive<{ manager: ClubManagerAnswer | null }>(
    `/api/clubs/manager?${new URLSearchParams({ club })}`,
    SERVER_LOOKUP_TIMEOUT_MS,
  );
  if ('error' in res) {
    console.warn(`[ClubManagers] Lookup for ${club} ${res.error}`);
    return null;
  }
  return res.data.manager ?? null;
};

let source: ClubManagerSource = sharedSource;

/** The server's own turns ask its lookup directly instead of calling its public route. */
export function useServerClubManagers(serverSource: ClubManagerSource): void {
  if (typeof window === 'undefined') source = serverSource;
}

const memoryCache = new Map<string, { record: ClubManagerRecord; expiresAtMs: number }>();
const inFlight = new Map<string, Promise<ClubManagerRecord | null>>();

/**
 * The verified current head coach of `club`: from memory, then the shared Supabase row, then the
 * server's search when the row is missing or more than a day old. Resolves to null for an empty
 * club name or when no answer could be had; a record with `coach: null` means the lookup could not
 * confirm anyone.
 */
export async function getClubManager(club: string | null | undefined): Promise<ClubManagerRecord | null> {
  const name = club?.trim();
  if (!name || name === 'N/A') return null;
  const key = toClubKey(name);
  if (!key) return null;

  const cached = memoryCache.get(key);
  if (cached && Date.now() < cached.expiresAtMs) return cached.record;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const job = (async (): Promise<ClubManagerRecord | null> => {
    const answer = await source(name);
    if (!answer) return null;
    memoryCache.set(key, { record: answer.record, expiresAtMs: Date.now() + answer.freshForMs });
    return answer.record;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/** Verified managers for several clubs at once, as the manager-mention gates expect them. */
export async function getVerifiedClubManagers(clubs: string[]): Promise<VerifiedClubManager[]> {
  const unique = [...new Map(clubs.filter(Boolean).map((c) => [toClubKey(c), c])).values()].slice(0, 4);
  const records = await Promise.all(unique.map((c) => getClubManager(c).catch(() => null)));
  return records
    .filter((r): r is ClubManagerRecord & { coach: string } => Boolean(r?.coach))
    .map((r) => ({ club: r.club, coach: r.coach, previousCoach: r.previousCoach }));
}

/** Prompt block naming each club's verified coach, so the model doesn't fall back on memory. */
export function formatVerifiedManagersBlock(managers: VerifiedClubManager[]): string {
  if (managers.length === 0) return '';
  const lines = managers.map(
    (m) => `- ${m.club}: ${m.coach}${m.previousCoach ? ` (replaced ${m.previousCoach}, now a former coach)` : ''}`,
  );
  return `<verified_managers>
Current head coaches confirmed by a live search today. Name only these as current; any other coach of these clubs is a former coach.
${lines.join('\n')}
</verified_managers>`;
}
