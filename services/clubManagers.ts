import { ThinkingLevel } from '@google/genai';
import { normalizeClub } from '../constants/ratingTiers';
import {
  sameCoach,
  type VerifiedClubManager,
} from '../packages/engine/src/gates/managerMentions.ts';
import { FLASH_MODEL, getAi, getCurrentSeasonInfo } from './aiClient';
import { formatIsoDate, toPlayerSlug } from './dossierCards';
import { supabase } from './dossierCache';
import { fetchApiFootballTeamContext } from './groundingService';

/**
 * Verified current head coach per club. API-Football lags managerial changes and model memory
 * is worse, so the source of truth is a focused Google-grounded search, cross-checked against
 * API-Football's record and shared through the Supabase `club_managers` table. A club is looked
 * up at most once a day across all users; nothing here is maintained by hand.
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

const REFRESH_MS = 24 * 60 * 60 * 1000;
/** A lookup whose search call errored is retried this soon, and never stored for other users. */
const FAILED_RETRY_MS = 10 * 60 * 1000;

export const toClubKey = (club: string): string => toPlayerSlug(normalizeClub(club.trim()));

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
  nowMs - verifiedAtMs < REFRESH_MS;

async function searchCurrentCoach(club: string) {
  const { month, year } = getCurrentSeasonInfo();
  const res = await getAi().models.generateContent({
    model: FLASH_MODEL,
    contents: `As of ${month} ${year}, who is the current first-team head coach (manager) of ${club}? Use the most recent reliable reports. If a caretaker or interim coach is in charge, name them. Reply with exactly one line and nothing else:
COACH: <full name or UNKNOWN> | SINCE: <appointment date YYYY-MM-DD or UNKNOWN> | PREVIOUS: <the head coach immediately before them, full name, or UNKNOWN> | SOURCE_DATE: <publication date of your most recent source YYYY-MM-DD or UNKNOWN>`,
    config: {
      temperature: 0,
      maxOutputTokens: 120,
      tools: [{ googleSearch: {} }],
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
  });
  const chunks = (res as any).candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const sourceUrl: string | null = chunks.find((c: any) => c?.web?.uri)?.web?.uri ?? null;
  return { ...parseManagerLookup(res.text ?? ''), sourceUrl };
}

async function lookUpClubManager(
  club: string,
): Promise<{ record: ClubManagerRecord; searchFailed: boolean }> {
  const [search, apiContext] = await Promise.all([
    searchCurrentCoach(club).catch((e) => {
      console.warn(`[ClubManagers] Search failed for ${club}:`, e);
      return null;
    }),
    fetchApiFootballTeamContext(club),
  ]);
  const apiCoach = apiContext?.coach ?? null;
  const { coach, sourcesAgree } = reconcileManagerSources(search?.coach ?? null, apiCoach);
  if (sourcesAgree === false) {
    console.info(`[ClubManagers] ${club}: search says ${coach}, API-Football says ${apiCoach}; using search.`);
  }
  const record: ClubManagerRecord = {
    club,
    coach,
    previousCoach: coach && !sameCoach(search?.previousCoach, coach) ? search?.previousCoach ?? null : null,
    coachSince: search?.coachSince ?? null,
    sourceUrl: search?.sourceUrl ?? null,
    sourceDate: search?.sourceDate ?? null,
    apiCoach,
    sourcesAgree,
    verifiedOn: formatIsoDate(Date.now()),
  };
  return { record, searchFailed: search === null };
}

const rowToRecord = (row: any): ClubManagerRecord => ({
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

const memoryCache = new Map<string, { record: ClubManagerRecord; expiresAtMs: number }>();
const inFlight = new Map<string, Promise<ClubManagerRecord | null>>();

/**
 * The verified current head coach of `club`: from memory, then the shared Supabase row, then a
 * fresh search when the row is missing or more than a day old. Resolves to null only for an
 * empty club name; a record with `coach: null` means the lookup could not confirm anyone.
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
    if (supabase) {
      try {
        const { data } = await supabase.from('club_managers').select('*').eq('club_key', key).maybeSingle();
        const atMs = data ? Date.parse(data.verified_at) : NaN;
        if (data && isClubManagerFresh(atMs)) {
          const record = rowToRecord(data);
          memoryCache.set(key, { record, expiresAtMs: atMs + REFRESH_MS });
          return record;
        }
      } catch (e) {
        console.warn('[ClubManagers] Read failed:', e);
      }
    }

    const { record, searchFailed } = await lookUpClubManager(normalizeClub(name));
    memoryCache.set(key, {
      record,
      expiresAtMs: Date.now() + (searchFailed ? FAILED_RETRY_MS : REFRESH_MS),
    });
    if (supabase && !searchFailed) {
      void supabase
        .from('club_managers')
        .upsert(
          {
            club_key: key,
            club_name: record.club,
            coach: record.coach,
            previous_coach: record.previousCoach,
            coach_since: record.coachSince,
            source_url: record.sourceUrl,
            source_date: record.sourceDate,
            api_coach: record.apiCoach,
            sources_agree: record.sourcesAgree,
            verified_at: new Date().toISOString(),
          },
          { onConflict: 'club_key' },
        )
        .then(({ error }: { error: unknown }) => {
          if (error) console.warn('[ClubManagers] Upsert failed:', error);
        });
    }
    return record;
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
