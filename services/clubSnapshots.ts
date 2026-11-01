import { getCurrentSeasonInfo } from './aiClient';
import { toClubKey } from './clubManagers';
import { supabase } from './dossierCache';
import { emptyLedger, seasonStartDate } from './evidenceLedger';
import { executeCall, fileOutcomes, getLive, type ResearchCall, type ResearchToolset, type ToolOutcome } from './researchTools';
import {
  buildSituation,
  deriveClubCore,
  formatFactContext,
  liveSituationModel,
  type ClubSnapshot,
  type SituationModel,
} from './situationSnapshot';

/**
 * Shared daily club snapshots. Each club's situation (first-choice XI, absences, form, what
 * changed since last season, what's distinctive this season) is built at most once a day across
 * all users, from the live club data plus a research pass, and kept in the Supabase
 * `club_snapshots` table. The server builds and stores them (`services/snapshotServer.ts`); the
 * browser can read the table but not write it. Chat reads the stored snapshot first and only
 * builds one when it's missing or stale, so answers are faster and every user and turn works from
 * the same facts.
 */

/** Bump when the snapshot's shape or how it's built changes, so older rows are rebuilt. */
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface SnapshotRow {
  club_key: string;
  club_name: string;
  league: string;
  snapshot: { core: ClubSnapshot['core']; story: ClubSnapshot['story']; sources: string[] };
  version: number;
  built_at: string;
}

/** Whether a stored snapshot can be reused: built under this version, less than a day ago. */
export const isSnapshotFresh = (builtAtMs: number, version: number, nowMs: number = Date.now()): boolean =>
  version === SNAPSHOT_VERSION && Number.isFinite(builtAtMs) && nowMs - builtAtMs < SNAPSHOT_REFRESH_MS;

export const snapshotToRow = (s: ClubSnapshot): SnapshotRow => ({
  club_key: toClubKey(s.club),
  club_name: s.club,
  league: s.league,
  snapshot: { core: s.core, story: s.story, sources: s.sources },
  version: s.version,
  built_at: s.builtAt,
});

export const rowToSnapshot = (row: SnapshotRow): ClubSnapshot | null =>
  row?.snapshot?.core && row.snapshot.story
    ? {
        club: row.club_name,
        league: row.league,
        core: row.snapshot.core,
        story: row.snapshot.story,
        sources: row.snapshot.sources ?? [],
        builtAt: row.built_at,
        version: row.version,
      }
    : null;

/** A build's research pass: the searches it ran and what each found. */
export interface ClubResearch {
  calls: ResearchCall[];
  outcomes: ToolOutcome[];
}

/**
 * How research reaches the snapshots: the stored one only; the research pass a build runs, which
 * the turn that started it reads as evidence instead of searching the same things again; or the
 * stored snapshot, else a new build.
 */
export interface SnapshotSource {
  stored(club: string, live: Promise<ToolOutcome>): Promise<ClubSnapshot | null>;
  research(club: string, live: Promise<ToolOutcome>): Promise<ClubResearch | null>;
  get(club: string, live: Promise<ToolOutcome>): Promise<ClubSnapshot | null>;
}

export interface SnapshotStoreDeps {
  read(key: string): Promise<SnapshotRow | null>;
  write(row: SnapshotRow): Promise<void>;
  research(club: string, live: ToolOutcome): Promise<ClubResearch | null>;
  summarize(club: string, live: ToolOutcome, research: ClubResearch): Promise<ClubSnapshot | null>;
  now?: () => number;
}

/** A failed build is retried this soon, and never stored. */
const FAILED_RETRY_MS = 10 * 60 * 1000;

/**
 * The store: memory, then the shared row, then a build. A club is keyed by the name the live data
 * resolves it to, so "Spurs" and "Tottenham Hotspur" share a snapshot. Concurrent requests for a
 * club share one read, one research pass and one build.
 */
export function createClubSnapshotStore(deps: SnapshotStoreDeps): SnapshotSource {
  const now = deps.now ?? Date.now;
  const memory = new Map<string, { snapshot: ClubSnapshot | null; expiresAt: number }>();
  const reads = new Map<string, Promise<ClubSnapshot | null>>();
  const researches = new Map<string, Promise<ClubResearch | null>>();
  const builds = new Map<string, Promise<ClubSnapshot | null>>();

  const fromMemory = (key: string): ClubSnapshot | null | undefined => {
    const hit = memory.get(key);
    return hit && hit.expiresAt > now() ? hit.snapshot : undefined;
  };
  const readKey = (key: string): Promise<ClubSnapshot | null> => {
    const cached = fromMemory(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = reads.get(key);
    if (pending) return pending;
    const job = deps
      .read(key)
      .then((row) => {
        const snapshot = row && isSnapshotFresh(Date.parse(row.built_at), row.version, now()) ? rowToSnapshot(row) : null;
        if (snapshot) memory.set(key, { snapshot, expiresAt: Date.parse(snapshot.builtAt) + SNAPSHOT_REFRESH_MS });
        return snapshot;
      })
      .catch((e) => {
        console.warn('[ClubSnapshots] Read failed:', e);
        return null;
      })
      .finally(() => reads.delete(key));
    reads.set(key, job);
    return job;
  };
  const canonicalKey = async (club: string, live: Promise<ToolOutcome>): Promise<string> => {
    const outcome = await live.catch(() => null);
    return toClubKey(outcome?.result?.club?.team ?? club);
  };

  async function stored(club: string, live: Promise<ToolOutcome>): Promise<ClubSnapshot | null> {
    // The typed name usually is the key; when it isn't, the live data's name is.
    const typedKey = toClubKey(club);
    const typed = typedKey ? await readKey(typedKey) : null;
    if (typed) return typed;
    const key = await canonicalKey(club, live);
    return key && key !== typedKey ? readKey(key) : null;
  }

  async function research(club: string, live: Promise<ToolOutcome>): Promise<ClubResearch | null> {
    const key = await canonicalKey(club, live);
    if (!key) return null;
    const pending = researches.get(key);
    if (pending) return pending;
    const job = (async () => {
      const outcome = await live.catch(() => null);
      return outcome
        ? deps.research(club, outcome).catch((e) => {
            console.warn(`[ClubSnapshots] Research failed for ${club}:`, e);
            return null;
          })
        : null;
    })();
    researches.set(key, job);
    // The build that follows reads it; after that a new research pass starts fresh.
    void job.then(() => setTimeout(() => researches.delete(key), 60_000));
    return job;
  }

  async function get(club: string, live: Promise<ToolOutcome>): Promise<ClubSnapshot | null> {
    const hit = await stored(club, live);
    if (hit) return hit;
    const key = await canonicalKey(club, live);
    if (!key) return null;
    const cached = fromMemory(key);
    if (cached !== undefined) return cached;
    const pending = builds.get(key);
    if (pending) return pending;
    const job = (async () => {
      const outcome = await live.catch(() => null);
      const pass = outcome ? await research(club, live) : null;
      const snapshot =
        outcome && pass
          ? await deps.summarize(club, outcome, pass).catch((e) => {
              console.warn(`[ClubSnapshots] Build failed for ${club}:`, e);
              return null;
            })
          : null;
      memory.set(key, { snapshot, expiresAt: now() + (snapshot ? SNAPSHOT_REFRESH_MS : FAILED_RETRY_MS) });
      if (snapshot) {
        await deps.write(snapshotToRow(snapshot)).catch((e) => console.warn('[ClubSnapshots] Write failed:', e));
      }
      return snapshot;
    })().finally(() => builds.delete(key));
    builds.set(key, job);
    return job;
  }

  return { stored, research, get };
}

/**
 * A build's research pass: what changed since last season, a tactical analysis read against the
 * live facts, and team news where no injury list covers the club, all at once.
 */
export async function researchClub(club: string, live: ToolOutcome, tools: ResearchToolset, now: () => number = Date.now): Promise<ClubResearch | null> {
  const report = live.result?.club;
  if (!report) return null;
  const core = deriveClubCore(report);
  const { currentSeason, month, year } = getCurrentSeasonInfo(new Date(now()));
  const calls: ResearchCall[] = [
    { tool: 'web_search', subject: `${report.team} transfers in and out and coaching changes since last season, ${currentSeason}`, stage: 'facts' },
    { tool: 'web_search', subject: `${report.team} tactical analysis ${currentSeason}: shape, build-up, pressing and key roles`, stage: 'analysis' },
    ...(core.outCovered ? [] : [{ tool: 'web_search' as const, subject: `${report.team} team news, injuries and suspensions, ${month} ${year}`, stage: 'facts' as const }]),
  ];
  const context = formatFactContext([core]);
  const outcomes = await Promise.all(calls.map((c) => executeCall(c, tools, c.stage === 'analysis' ? context : undefined)));
  return { calls, outcomes };
}

/** A club's snapshot from its live data and research pass, through the situation call at low thinking. */
export async function summarizeClub(
  club: string,
  live: ToolOutcome,
  pass: ClubResearch,
  model: SituationModel = liveSituationModel,
  now: () => number = Date.now,
): Promise<ClubSnapshot | null> {
  const report = live.result?.club;
  if (!report) return null;
  const start = now();
  const core = deriveClubCore(report);
  const { currentSeason, seasonStartYear } = getCurrentSeasonInfo(new Date(now()));
  const ledger = fileOutcomes(emptyLedger(), [{ tool: 'club_recent_team', subject: club }, ...pass.calls], [live, ...pass.outcomes]);
  const { situation, usedModel } = await buildSituation({
    ledger,
    stored: [],
    players: [],
    question: `What is the current state of ${report.team}?`,
    focus: `What is distinctive about ${report.team} this season compared with last, and why`,
    today: new Date(now()).toISOString().slice(0, 10),
    season: currentSeason,
    seasonStart: seasonStartDate(seasonStartYear),
    allowModel: true,
    model,
  });
  const built = situation.clubs[0];
  if (!usedModel || !built) return null;
  console.log(`[Perf] club snapshot summary "${report.team}": ${now() - start}ms`);
  return {
    club: report.team,
    league: report.league,
    core,
    story: { changes: built.changes ?? [], distinctive: built.distinctive ?? '', newsAbsences: built.newsAbsences ?? [], unknowns: built.unknowns ?? [] },
    sources: ledger.entries.flatMap((e) => e.sources ?? []).slice(0, 8),
    builtAt: new Date(now()).toISOString(),
    version: SNAPSHOT_VERSION,
  };
}

/** A whole build: the research pass, then the summary. */
export async function buildClubSnapshot(
  club: string,
  live: ToolOutcome,
  tools: ResearchToolset,
  model: SituationModel = liveSituationModel,
  now: () => number = Date.now,
): Promise<ClubSnapshot | null> {
  const pass = await researchClub(club, live, tools, now);
  return pass ? summarizeClub(club, live, pass, model, now) : null;
}

/** A build takes a research pass and a model call on the server; past this the turn stops waiting. */
const SERVER_BUILD_TIMEOUT_MS = 60_000;

/**
 * The live store: stored rows are read from Supabase, and research passes and builds run on the
 * server (`services/snapshotServer.ts`), which alone can write the table.
 */
export const liveClubSnapshots: SnapshotSource = createClubSnapshotStore({
  async read(key) {
    if (!supabase) return null;
    const { data } = await supabase.from('club_snapshots').select('*').eq('club_key', key).maybeSingle();
    return data ?? null;
  },
  // The server stored it when it built it.
  write: async () => {},
  async research(club) {
    const res = await getLive<{ research: ClubResearch | null }>(`/api/snapshots/club/research?${new URLSearchParams({ club })}`, SERVER_BUILD_TIMEOUT_MS);
    return 'data' in res ? res.data.research : null;
  },
  async summarize(club) {
    const res = await getLive<{ snapshot: ClubSnapshot | null }>(`/api/snapshots/club?${new URLSearchParams({ club })}`, SERVER_BUILD_TIMEOUT_MS);
    return 'data' in res ? res.data.snapshot : null;
  },
});
