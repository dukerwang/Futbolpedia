import { ThinkingLevel } from '@google/genai';
import { outputCap, samplingFor } from '../constants/modelProfiles';
import { normalizeClub } from '../constants/ratingTiers';
import { sameCoach } from '../packages/engine/src/gates/managerMentions.ts';
import { FLASH_MODEL, getAi, getCurrentSeasonInfo } from './aiClient';
import {
  CLUB_MANAGER_REFRESH_MS,
  isClubManagerFresh,
  parseManagerLookup,
  readClubName,
  reconcileManagerSources,
  rowToClubManager,
  toClubKey,
  type ClubManagerAnswer,
  type ClubManagerRecord,
  type ClubManagerRow,
} from './clubManagers';
import { formatIsoDate } from './dossierCards';
import { fetchApiFootballTeamContext } from './groundingService';

/**
 * Coach lookups and the `club_managers` table, on the server. The table is readable by anyone but
 * writable only with the server's Supabase secret key, so a row holds only what the server's own
 * search found. A caller names a club and nothing else, and the name passes `readClubName` before
 * it reaches the search or the table.
 */

/** A lookup whose search call errored is retried this soon, and never stored for other users. */
const FAILED_RETRY_MS = 10 * 60 * 1000;

/** Fresh lookups one visitor may start in a minute and in a day, and all visitors in a day. */
export const CLUB_MANAGER_LIMITS = { perMinute: 12, perDay: 60, globalPerDay: 400 } as const;

async function searchCurrentCoach(club: string) {
  const { month, year } = getCurrentSeasonInfo();
  const res = await getAi().models.generateContent({
    model: FLASH_MODEL,
    contents: `As of ${month} ${year}, who is the current first-team head coach (manager) of ${club}? Use the most recent reliable reports. If a caretaker or interim coach is in charge, name them. Reply with exactly one line and nothing else:
COACH: <full name or UNKNOWN> | SINCE: <appointment date YYYY-MM-DD or UNKNOWN> | PREVIOUS: <the head coach immediately before them, full name, or UNKNOWN> | SOURCE_DATE: <publication date of your most recent source YYYY-MM-DD or UNKNOWN>`,
    config: {
      ...samplingFor(FLASH_MODEL, 0),
      maxOutputTokens: outputCap(FLASH_MODEL, 120),
      tools: [{ googleSearch: {} }],
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
  });
  const chunks = (res as any).candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const sourceUrl: string | null = chunks.find((c: any) => c?.web?.uri)?.web?.uri ?? null;
  return { ...parseManagerLookup(res.text ?? ''), sourceUrl };
}

export type ClubManagerLookup = (club: string) => Promise<{ record: ClubManagerRecord; searchFailed: boolean }>;

const lookUpClubManager: ClubManagerLookup = async (club) => {
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
};

export interface ClubManagerDb {
  read(key: string): Promise<ClubManagerRow | null>;
  write(row: ClubManagerRow): Promise<void>;
}

/**
 * The table through two clients: rows are read with `reader` and written with `writer`, which must
 * be made with the secret key. Without one, nothing is stored and lookups stay in memory.
 */
export function supabaseClubManagerDb(reader: any, writer: any | null): ClubManagerDb {
  return {
    async read(key) {
      const { data } = await reader.from('club_managers').select('*').eq('club_key', key).maybeSingle();
      return data ?? null;
    },
    async write(row) {
      if (!writer) return;
      const { error } = await writer.from('club_managers').upsert(row, { onConflict: 'club_key' });
      if (error) console.warn('[ClubManagers] Upsert failed:', error.message ?? error);
    },
  };
}

export interface ClubManagerServer {
  /**
   * A club's coach: from memory, then the stored row, then a new search that is stored for everyone.
   * `admit` is asked only before a new search and returns why it is refused, or null. Null means the
   * name can't be looked up.
   */
  get(club: unknown, admit?: () => string | null): Promise<ClubManagerAnswer | { refused: string } | null>;
}

export function createClubManagerServer(deps: {
  db: ClubManagerDb | null;
  lookUp?: ClubManagerLookup;
  now?: () => number;
}): ClubManagerServer {
  const { db } = deps;
  const lookUp = deps.lookUp ?? lookUpClubManager;
  const now = deps.now ?? Date.now;
  const memory = new Map<string, { record: ClubManagerRecord; expiresAtMs: number }>();
  const inFlight = new Map<string, Promise<ClubManagerAnswer>>();

  const keep = (key: string, record: ClubManagerRecord, expiresAtMs: number): ClubManagerAnswer => {
    memory.set(key, { record, expiresAtMs });
    return { record, freshForMs: expiresAtMs - now() };
  };

  return {
    async get(club, admit) {
      const name = readClubName(club);
      if (!name) return null;
      const key = toClubKey(name);

      const cached = memory.get(key);
      if (cached && now() < cached.expiresAtMs) return { record: cached.record, freshForMs: cached.expiresAtMs - now() };
      if (!inFlight.has(key) && db) {
        try {
          const row = await db.read(key);
          const atMs = row ? Date.parse(row.verified_at) : NaN;
          if (row && isClubManagerFresh(atMs, now())) return keep(key, rowToClubManager(row), atMs + CLUB_MANAGER_REFRESH_MS);
        } catch (e) {
          console.warn('[ClubManagers] Read failed:', e);
        }
      }
      // Checked after the read, so two callers who both missed the row share one search.
      const pending = inFlight.get(key);
      if (pending) return pending;
      const refused = admit?.();
      if (refused) return { refused };

      const job = (async (): Promise<ClubManagerAnswer> => {
        const { record, searchFailed } = await lookUp(normalizeClub(name));
        const answer = keep(key, record, now() + (searchFailed ? FAILED_RETRY_MS : CLUB_MANAGER_REFRESH_MS));
        if (db && !searchFailed) {
          await db
            .write({
              club_key: key,
              club_name: record.club,
              coach: record.coach,
              previous_coach: record.previousCoach,
              coach_since: record.coachSince,
              source_url: record.sourceUrl,
              source_date: record.sourceDate,
              api_coach: record.apiCoach,
              sources_agree: record.sourcesAgree,
              verified_at: new Date(now()).toISOString(),
            })
            .catch((e) => console.warn('[ClubManagers] Upsert failed:', e));
        }
        return answer;
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, job);
      return job;
    },
  };
}

/**
 * `GET /api/clubs/manager?club=`. The club name is all a caller sends. `admit` counts new searches
 * against the caller, so the public route can't spend the server's keys without limit.
 */
export function clubManagerHandler(managers: ClubManagerServer, admit: (req: any) => string | null) {
  return async (req: any, res: any) => {
    const club = readClubName(req.query.club);
    if (!club) return res.status(400).json({ error: 'Missing or unreadable club name' });
    const start = Date.now();
    try {
      const answer = await managers.get(club, () => admit(req));
      if (answer && 'refused' in answer) {
        console.warn(`[managers] "${club}" refused: ${answer.refused}`);
        return res.status(429).json({ error: answer.refused });
      }
      const coach = (answer as ClubManagerAnswer | null)?.record.coach;
      console.log(`[managers] "${club}": ${coach ?? 'nobody confirmed'} (${Date.now() - start}ms)`);
      return res.json({ manager: answer });
    } catch (e: any) {
      console.warn(`[managers] "${club}" failed:`, e?.message || e);
      return res.json({ manager: null });
    }
  };
}
