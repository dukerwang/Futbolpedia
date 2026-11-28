import { ESPN_SITE, ESPN_STANDINGS, LIVE_LEAGUES, type LiveLeague } from '../liveFootball';
import type { PermanentStore } from '../historyFootball';
import {
  FIRST_RESULTS_SEASON,
  addDays,
  computeSnapshots,
  parseResults,
  parseSeasonClubs,
  seasonEndDate,
  seasonOfDate,
  type Side,
  type Snapshot,
  type StrengthMatch,
} from './teamStrength';
import type { TeamStrengthStore } from './teamStrengthStore';

/**
 * The server's team-strength job: it reads ESPN's schedules season by season, computes the ratings
 * in date order and stores the snapshots. A first build reads every season from 2003-04 and stores
 * each finished season as soon as the next one is read, so a restart part-way loses little; every
 * later build carries on from the newest stored season-end snapshot and reads only what came after.
 * A settled season's results are kept on disk, so a restart doesn't read twenty seasons again.
 *
 * The live chat reads ESPN from this server too, so the fetching is held back. Reading settled
 * seasons (the backfill) is one request at a time, at least a second apart, and at most
 * `BACKFILL_REQUESTS_PER_DAY` a day: a first build carries on from the stored seasons each day and
 * takes about a week. The season in progress is read a few requests at a time. Either one stops for
 * an hour when ESPN stops answering (`PAUSE_AFTER` failures in a row). Nothing here calls a model.
 */

/** Requests in flight at once for a season that isn't settled yet. */
export const BUILD_CONCURRENCY = 3;
/** The pause each of those workers takes after a request. */
export const BUILD_DELAY_MS = 250;
/** The pause after each backfill request; only one is ever in flight. */
export const BACKFILL_DELAY_MS = 1_000;
/** Requests for settled seasons, retries included, in one UTC day. Reads from disk are free. */
export const BACKFILL_REQUESTS_PER_DAY = 1_500;
/** Timeouts, unanswered requests, 429s and 5xx answers in a row that pause all fetching. */
export const PAUSE_AFTER = 3;
export const PAUSE_MS = 60 * 60 * 1000;
/** Tries after the first, with a growing pause. */
const RETRIES = 2;
const RETRY_PAUSE_MS = 2_000;
/** A season's results are kept for good this long after it ends, once late matches and fixes are in. */
export const SETTLE_DAYS = 60;
/** A build with more than this share of its club schedules unread stores nothing and runs again later. */
export const MAX_FAILED_SHARE = 0.01;
const HOUR_MS = 60 * 60 * 1000;

/** Why a build stopped to carry on later: the day's backfill requests ran out, or ESPN stopped answering. */
export type Halt = 'budget' | 'paused';

export interface BuildSummary {
  /** `deferred` carries on from the stored seasons later (`halt` says why). */
  status: 'stored' | 'aborted' | 'deferred';
  halt?: Halt;
  /** Why the build ended before the latest state was stored. */
  reason?: string;
  /** The stored season end this build carried on from; null for a full build. */
  from: string | null;
  firstSeason: number;
  lastSeason: number;
  /** Club schedules read, over every season. */
  schedules: number;
  requests: number;
  cached: number;
  failed: number;
  matches: number;
  /** Clubs in the latest state. */
  clubs: number;
  snapshots: number;
  rows: number;
  seconds: number;
  /** Competitions met that no rating counts. */
  skipped: string[];
}

export interface TeamStrengthJobOptions {
  /** Fetches JSON; a 404 or 400 is read as "no data" when the error carries `response.status`. */
  getJson: (url: string) => Promise<any>;
  store: TeamStrengthStore;
  /** Settled seasons' parsed results, kept across restarts. */
  cache?: PermanentStore;
  now?: () => number;
  leagues?: LiveLeague[];
  firstSeason?: number;
  concurrency?: number;
  /** The pause after a request for a season that isn't settled. */
  delayMs?: number;
  /** `BACKFILL_REQUESTS_PER_DAY`, lowered by tests. */
  backfillPerDay?: number;
  /** Follow the clubs met in leagues and UEFA competition. Off only for a dry run. */
  expand?: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export function createTeamStrengthJob(options: TeamStrengthJobOptions) {
  const { getJson, store, cache } = options;
  const now = options.now ?? Date.now;
  const leagues = (options.leagues ?? LIVE_LEAGUES).filter((l) => l.clubs);
  const leagueSlugs = new Set(leagues.map((l) => l.slug));
  const concurrency = options.concurrency ?? BUILD_CONCURRENCY;
  const delayMs = options.delayMs ?? BUILD_DELAY_MS;
  const backfillPerDay = options.backfillPerDay ?? BACKFILL_REQUESTS_PER_DAY;
  const expand = options.expand ?? true;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string) => console.log(line));
  const today = () => new Date(now()).toISOString().slice(0, 10);

  interface Counts {
    requests: number;
    cached: number;
    failed: number;
  }

  // ESPN's health and the day's backfill allowance, shared by every build this server runs.
  let pausedUntil = 0;
  let streak: string[] = [];
  /** URLs that were failing when a pause began. Until one answers, it gets one try that can't pause again. */
  const troubled = new Set<string>();
  let allowance = { day: '', used: 0 };
  /** The day a build stopped for want of backfill requests: nothing more is due before the next. */
  let spentOn = '';
  let onPause: () => void = () => {};

  /** Counts one backfill request against today's allowance, or says there is none left. Kept with the cache, so a restart keeps the count. */
  async function takeBackfillRequest(): Promise<boolean> {
    const day = today();
    const key = `backfill-requests:v1:${day}`;
    if (allowance.day !== day) {
      const kept = cache ? await cache.get(key).catch(() => undefined) : undefined;
      allowance = { day, used: Number(kept?.value) || 0 };
    }
    if (allowance.used >= backfillPerDay) return false;
    allowance.used++;
    await cache?.set(key, { value: allowance.used }).catch(() => {});
    return true;
  }

  /** A timeout or no answer at all, a 429, or a 5xx. */
  const isTrouble = (e: any): boolean => {
    const status = Number(e?.response?.status);
    return !status || status === 429 || status >= 500;
  };

  /** Notes how a request went, and starts a pause on the `PAUSE_AFTER`th trouble in a row. */
  function note(url: string, error: any | null): void {
    if (!error || !isTrouble(error)) {
      streak = [];
      if (!error) troubled.delete(url);
      return;
    }
    if (troubled.has(url)) return;
    streak.push(url);
    if (streak.length < PAUSE_AFTER) return;
    streak.forEach((u) => troubled.add(u));
    streak = [];
    pausedUntil = now() + PAUSE_MS;
    const last = Number(error?.response?.status) ? `HTTP ${error.response.status}` : String(error?.code ?? error?.message ?? 'no answer').slice(0, 80);
    log(`[kb] team strength paused until ${new Date(pausedUntil).toISOString()}: ${PAUSE_AFTER} timeouts, 429s or 5xx answers in a row (last: ${last} from ${url})`);
    onPause();
  }

  const HALTED: unique symbol = Symbol('halted');

  interface ReadOptions {
    /** Its results no longer change: kept on disk, and fetched as backfill. */
    settled: boolean;
    /** Read from disk or not at all; a miss reads as no data. */
    diskOnly: boolean;
    counts: Counts;
    halt: (why: Halt) => void;
  }

  /**
   * A fetch parsed to what the build keeps, from the cache once the season is settled. Null when it
   * failed, `HALTED` when the build has to stop. The `v1` in each cache key goes up when what the
   * parsers keep changes.
   */
  async function read<T>(key: string, url: string, parse: (json: any) => T, { settled, diskOnly, counts, halt }: ReadOptions): Promise<T | null | typeof HALTED> {
    if (settled && cache) {
      const kept = await cache.get(key).catch(() => undefined);
      if (kept && 'value' in kept) {
        counts.cached++;
        return kept.value as T;
      }
    }
    if (diskOnly) return parse({});
    const pauseAfterRequest = settled ? BACKFILL_DELAY_MS : delayMs;
    const stop = (why: Halt): typeof HALTED => {
      halt(why);
      return HALTED;
    };
    const tries = troubled.has(url) ? 1 : 1 + RETRIES;
    for (let attempt = 1; ; attempt++) {
      if (now() < pausedUntil) return stop('paused');
      if (settled && !(await takeBackfillRequest())) return stop('budget');
      counts.requests++;
      let json: any;
      try {
        json = await getJson(url);
        note(url, null);
      } catch (e: any) {
        const status = Number(e?.response?.status);
        if (status === 404 || status === 400) {
          note(url, null);
          json = {};
        } else {
          note(url, e);
          if (now() < pausedUntil) return stop('paused');
          if (attempt < tries) {
            // Longer than either pause after a request, so backfill stays a second apart.
            await sleep(RETRY_PAUSE_MS * attempt);
            continue;
          }
          counts.failed++;
          await sleep(pauseAfterRequest);
          return null;
        }
      }
      const value = parse(json);
      if (settled && cache) await cache.set(key, { value }).catch(() => {});
      await sleep(pauseAfterRequest);
      return value;
    }
  }

  const pool = async <T>(items: T[], workers: number, stopped: () => boolean, run: (item: T) => Promise<void>): Promise<void> => {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(workers, items.length) }, async () => {
        while (!stopped() && next < items.length) await run(items[next++]);
      }),
    );
  };

  async function build(): Promise<BuildSummary> {
    const started = now();
    const day = today();
    const resumed = await store.checkpoint();
    let checkpoint = resumed;
    // Carrying on, the checkpoint's own season is read again: matches just after its date can sit in it.
    // While the backfill is still behind, that season is read from disk only. On a wiped disk,
    // fetching it again every day could use the whole allowance before a new season was stored.
    const caughtUp = Boolean(resumed) && seasonEndDate(seasonOfDate(resumed!.date) + 1) >= day;
    const firstSeason = resumed ? seasonOfDate(resumed.date) : options.firstSeason ?? FIRST_RESULTS_SEASON;
    // ESPN numbers a season by the year it starts in, and a calendar-year league's by its year.
    const lastSeason = Number(day.slice(0, 4));
    const counts: Counts = { requests: 0, cached: 0, failed: 0 };
    /** Matches not yet behind a stored season end. */
    const matches = new Map<string, StrengthMatch>();
    const seen = new Set<string>();
    const skipped = new Set<string>();
    let schedules = 0;
    let snapshotCount = 0;
    let rowCount = 0;
    let halted: Halt | null = null;
    const halt = (why: Halt) => void (halted ??= why);
    const stopped = () => halted !== null;
    /** Club schedules read, and unread, since the last store. */
    let unstored = { schedules: 0, failed: 0 };

    const summary = (status: BuildSummary['status'], extra: Partial<BuildSummary> = {}): BuildSummary => ({
      status,
      from: resumed?.date ?? null,
      firstSeason,
      lastSeason,
      schedules,
      requests: counts.requests,
      cached: counts.cached,
      failed: counts.failed,
      matches: seen.size,
      clubs: 0,
      snapshots: snapshotCount,
      rows: rowCount,
      seconds: Math.round((now() - started) / 1000),
      skipped: [...skipped].sort(),
      ...extra,
    });
    const abort = (reason: string) => {
      const out = summary('aborted', { reason });
      log(`[kb] team strength: stopped, ${reason}; ${checkpoint ? `stored through ${checkpoint.date}` : 'nothing stored'} (${out.matches} matches, ${out.requests} requests, ${out.seconds} s)`);
      return out;
    };
    const defer = (why: Halt) => {
      if (why === 'budget') spentOn = today();
      const reason = why === 'budget' ? `today's ${backfillPerDay} backfill requests are spent` : 'ESPN stopped answering';
      const out = summary('deferred', { halt: why, reason, clubs: checkpoint?.rows.length ?? 0 });
      log(
        `[kb] team strength: ${out.clubs} clubs, ${out.matches} matches read, ${out.seconds} s; ${reason}, ${checkpoint ? `stored through ${checkpoint.date}` : 'nothing stored yet'}, carrying on ${why === 'budget' ? 'tomorrow (UTC)' : 'after the pause'} (${out.requests} requests, ${out.cached} from disk)`,
      );
      return out;
    };
    const unreadable = () =>
      unstored.failed > unstored.schedules * MAX_FAILED_SHARE ? `${unstored.failed} of ${unstored.schedules} club schedules couldn't be read` : null;
    const keep = async (snapshots: Snapshot[]) => {
      await store.write(snapshots);
      snapshotCount += snapshots.length;
      rowCount += snapshots.reduce((n, s) => n + s.rows.length, 0);
    };

    for (let season = firstSeason; season <= lastSeason; season++) {
      const settled = addDays(seasonEndDate(season), SETTLE_DAYS) < day;
      const diskOnly = settled && !caughtUp && season === firstSeason && Boolean(resumed);
      const workers = settled ? 1 : concurrency;
      const options = { settled, diskOnly, counts, halt };
      const queued = new Set<string>();
      let waiting: string[] = [];
      const add = (side: Side) => {
        if (!queued.has(side.id)) {
          queued.add(side.id);
          waiting.push(side.id);
        }
      };
      let failedTables = 0;
      await pool(leagues, workers, stopped, async (league) => {
        const clubs = await read(`standings:v1:${league.slug}:${season}`, `${ESPN_STANDINGS}/${league.slug}/standings?season=${season}`, parseSeasonClubs, options);
        if (clubs === HALTED) return;
        if (clubs === null) failedTables++;
        else clubs.forEach(add);
      });
      if (halted) return defer(halted);
      // A season with a club list missing would lose a whole league, so nothing is worth reading on.
      if (failedTables) return abort(`${failedTables} league club lists for ${season} couldn't be read`);
      while (waiting.length) {
        const wave = waiting.sort();
        waiting = [];
        await pool(wave, workers, stopped, async (id) => {
          const result = await read(`schedule:v1:${id}:${season}`, `${ESPN_SITE}/all/teams/${id}/schedule?season=${season}`, parseResults, options);
          if (result === HALTED) return;
          schedules++;
          unstored.schedules++;
          if (result === null) {
            unstored.failed++;
            return;
          }
          result.skipped.forEach((s) => skipped.add(s));
          for (const m of result.matches) {
            if (m.date <= day && (!checkpoint || m.date > checkpoint.date)) {
              matches.set(m.id, m);
              seen.add(m.id);
            }
            if (expand && (m.competition.startsWith('uefa.') || leagueSlugs.has(m.competition))) {
              add(m.home);
              add(m.away);
            }
          }
        });
        if (halted) return defer(halted);
      }
      // With this season read, everything up to the end of the one before it is in: store it.
      const end = seasonEndDate(season - 1);
      if (season < lastSeason && season - 1 > FIRST_RESULTS_SEASON && end < day && end > (checkpoint?.date ?? '')) {
        const problem = unreadable();
        if (problem) return abort(problem);
        const snapshots = computeSnapshots([...matches.values()], { today: day, checkpoint, through: end });
        const seasonEnd = snapshots.find((s) => s.kind === 'season_end' && s.date === end);
        if (seasonEnd) {
          await keep(snapshots);
          checkpoint = { date: end, rows: seasonEnd.rows };
          for (const m of [...matches.values()]) if (m.date <= end) matches.delete(m.id);
          unstored = { schedules: 0, failed: 0 };
          log(`[kb] team strength: stored through ${end} (${seasonEnd.rows.length} clubs, ${seen.size} matches so far, ${Math.round((now() - started) / 1000)} s)`);
        }
      }
    }

    const problem = unreadable();
    if (problem) return abort(problem);
    if (!seen.size) return abort('ESPN returned no matches');
    const snapshots = computeSnapshots([...matches.values()], { today: day, checkpoint });
    if (!snapshots.length) return abort('no snapshot was due');
    await keep(snapshots);
    const out = summary('stored', { clubs: snapshots[snapshots.length - 1].rows.length });
    log(
      `[kb] team strength: ${out.clubs} clubs, ${out.matches} matches, ${out.seconds} s (${out.from ? `carried on from ${out.from}` : 'full build'}, seasons ${firstSeason}-${lastSeason}; ${out.requests} requests, ${out.cached} from disk, ${out.failed} failed; ${out.snapshots} snapshots, ${out.rows} rows)${out.skipped.length ? `; not counted: ${out.skipped.join(', ')}` : ''}`,
    );
    return out;
  }

  let running: Promise<void> | null = null;
  let waitingForTable = false;
  /**
   * Builds until today's latest state is stored, never two at once. A build that stored nothing, or
   * paused, runs again at a later tick; one that spent the day's backfill requests waits for the
   * next UTC day.
   */
  function tick(): Promise<void> {
    if (running) return running;
    if (now() < pausedUntil || spentOn === today()) return Promise.resolve();
    running = (async () => {
      if (!(await store.ready())) {
        if (!waitingForTable) log('[kb] team strength: the kb_team_strength table is missing (apply its migration); no build runs until it exists');
        waitingForTable = true;
        return;
      }
      waitingForTable = false;
      if ((await store.latestDate()) === today()) return;
      await build();
    })()
      .catch((e: any) => log(`[kb] team strength: build failed: ${String(e?.message ?? e).slice(0, 200)}`))
      .finally(() => {
        running = null;
      });
    return running;
  }

  /** The server's schedule: a first check shortly after start, then hourly, and once when a pause ends. */
  function start(startAfterMs = 60_000): () => void {
    let resume: ReturnType<typeof setTimeout> | undefined;
    onPause = () => {
      clearTimeout(resume);
      resume = setTimeout(() => void tick(), PAUSE_MS + 1_000);
      resume.unref?.();
    };
    const first = setTimeout(() => void tick(), startAfterMs);
    const hourly = setInterval(() => void tick(), HOUR_MS);
    first.unref?.();
    hourly.unref?.();
    return () => {
      onPause = () => {};
      clearTimeout(resume);
      clearTimeout(first);
      clearInterval(hourly);
    };
  }

  return { build, tick, start };
}
