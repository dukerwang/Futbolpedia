import { parseSeason } from '../historyFootball';
import type { EspnTeam } from '../liveFootball';
import type { ProxyLimiter } from '../geminiProxy';
import { daysBetween, readSnapshot, wantedDate, type StrengthRow, type TeamStrengthResult } from './teamStrength';
import type { SnapshotRef, TeamStrengthStore } from './teamStrengthStore';

/**
 * `GET /api/kb/team-strength?club=&date=` (or `season=`): one club's rating from the stored
 * snapshots. Public and read-only; nothing is fetched or computed beyond reading the store.
 */

/** Requests one visitor may send in a minute and in a day, and everyone together in a day. */
export const TEAM_STRENGTH_LIMITS = { perMinute: 60, perDay: 1_000, globalPerDay: 20_000 };
/** How long a snapshot, and which snapshot a date means, are kept in memory. */
const ROWS_TTL_MS = 60 * 60 * 1000;
const REF_TTL_MS = 10 * 60 * 1000;
const CACHED_SNAPSHOTS = 24;
/** Snapshots are monthly, so one older than this means the date asked for hasn't been built. */
const MAX_SNAPSHOT_AGE_DAYS = 62;

export function createTeamStrengthReader(options: {
  store: TeamStrengthStore;
  /** ESPN's current club lists, for the other names a club goes by. */
  teams?: () => Promise<EspnTeam[]>;
  now?: () => number;
}) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const refs = new Map<string, { until: number; value: Promise<SnapshotRef | null> }>();
  const snapshots = new Map<string, { until: number; value: Promise<StrengthRow[]> }>();

  const remember = <T>(map: Map<string, { until: number; value: Promise<T> }>, key: string, ttl: number, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T> => {
    const hit = map.get(key);
    if (hit && hit.until > now()) return hit.value;
    const value = load();
    map.delete(key);
    map.set(key, { until: now() + ttl, value });
    while (map.size > CACHED_SNAPSHOTS) map.delete(map.keys().next().value as string);
    // A failed read, or nothing found before the first build, is asked again next time.
    value.then((v) => keep(v) || map.delete(key)).catch(() => map.delete(key));
    return value;
  };

  const aliases = async (): Promise<Map<string, string[]>> => {
    const list = (await options.teams?.().catch(() => [])) ?? [];
    return new Map(list.map((t) => [t.id, t.names]));
  };

  return {
    async lookup(request: { club: string; date?: string; season?: string }): Promise<TeamStrengthResult> {
      const today = new Date(now()).toISOString().slice(0, 10);
      let seasonStart: number | null = null;
      if (!request.date && request.season) {
        const season = parseSeason(request.season);
        if (!season) return { found: false, status: 'empty', reason: `no season in "${request.season}" (write it as YYYY-YY)` };
        seasonStart = season.start;
      }
      const wanted = wantedDate({ date: request.date || undefined, seasonStart }, today);
      if ('refused' in wanted) return { found: false, ...wanted.refused };
      const ref = await remember<SnapshotRef | null>(refs, wanted.date, REF_TTL_MS, () => store.snapshotOn(wanted.date), (found) => found !== null);
      if (!ref || daysBetween(ref.date, wanted.date) > MAX_SNAPSHOT_AGE_DAYS) {
        return { found: false, status: 'empty', reason: `team strength ratings haven't been built for that date yet${ref ? ` (the newest before it is ${ref.date})` : ''}` };
      }
      const rows = await remember(snapshots, `${ref.date}|${ref.kind}`, ROWS_TTL_MS, () => store.rows(ref), (r) => r.length > 0);
      return readSnapshot(request.club, rows, await aliases());
    },
  };
}

export type TeamStrengthReader = ReturnType<typeof createTeamStrengthReader>;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 80) : '');

/** The Express handler. `sourceOf` names a visitor for the limits (a salted hash of the address). */
export function teamStrengthHandler(
  reader: TeamStrengthReader,
  limiter: ProxyLimiter,
  sourceOf: (req: any) => string,
  log: (line: string) => void = (line) => console.log(line),
) {
  return async (req: any, res: any): Promise<void> => {
    const club = text(req.query.club);
    const date = text(req.query.date);
    const season = text(req.query.season);
    if (!club) {
      res.status(400).json({ error: 'Missing club' });
      return;
    }
    const refused = limiter.take(sourceOf(req));
    if (refused) {
      res.status(429).json({ error: refused });
      return;
    }
    try {
      const result = await reader.lookup({ club, ...(date ? { date } : {}), ...(season ? { season } : {}) });
      const line = 'reason' in result ? result.reason : `${result.club.club} ${result.club.rating} on ${result.asOf}`;
      log(`[kb] team strength "${club}"${date ? ` ${date}` : season ? ` ${season}` : ''}: ${line}`);
      if (result.found) res.set('Cache-Control', 'public, max-age=3600');
      res.json(result);
    } catch (error: any) {
      log(`[kb] team strength "${club}" failed: ${String(error?.message ?? error).slice(0, 160)}`);
      res.json({ found: false, status: 'failed', reason: "the ratings couldn't be read" });
    }
  };
}
