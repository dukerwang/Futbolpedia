import { createClubSnapshotStore, researchClub, summarizeClub, type ClubResearch, type SnapshotRow } from './clubSnapshots';
import { buildEraSnapshot, createEraSnapshotStore, isMissingTable, type EraKind, type EraRow, type EraSnapshot } from './eraSnapshots';
import type { createHistoryFootball } from './historyFootball';
import type { createLiveFootball } from './liveFootball';
import { liveToolset, type LiveGet } from './researchTools';
import type { ClubSnapshot } from './situationSnapshot';

/**
 * Shared snapshots are built and stored on the server. The `club_snapshots` and `era_snapshots`
 * tables are readable by anyone but writable only with the server's Supabase secret key, so a row
 * can only hold what the server's own research produced: it fetches the facts itself, runs the
 * searches with its own Gemini key and writes the result. The browser reads stored rows directly
 * and asks these routes for a research pass or a build.
 */

type LiveFootball = ReturnType<typeof createLiveFootball>;
type HistoryFootball = ReturnType<typeof createHistoryFootball>;

/** The research toolset's live and history routes, answered in-process instead of over HTTP. */
export function inProcessGet(routes: { live: LiveFootball; history: HistoryFootball }): LiveGet {
  return async <T>(url: string) => {
    const u = new URL(url, 'http://local');
    const q = (key: string) => u.searchParams.get(key) ?? '';
    try {
      switch (u.pathname) {
        case '/api/live/club':
          return { data: (await routes.live.club(q('name'))) as T };
        case '/api/live/player':
          return { data: (await routes.live.player(q('name'))) as T };
        case '/api/live/table':
          return { data: (await routes.live.table(q('league'), q('country') || undefined)) as T };
        case '/api/history/club-season':
          return { data: (await routes.history.clubSeason(q('club'), q('season'))) as T };
        case '/api/history/player':
          return { data: (await routes.history.playerCareer(q('name'))) as T };
        default:
          return { error: 'HTTP 404' };
      }
    } catch {
      return { error: 'unreachable' };
    }
  };
}

/** Where the server keeps snapshots. Without the secret key there's none, and builds stay in memory. */
export interface SnapshotDb {
  readClub(key: string): Promise<SnapshotRow | null>;
  writeClub(row: SnapshotRow): Promise<void>;
  readEra(key: string): Promise<EraRow | null>;
  writeEra(row: EraRow): Promise<void>;
  /** Whether the `era_snapshots` table exists (its migration has been applied). */
  eraReady(): Promise<boolean>;
}

/** The tables through a Supabase client made with the secret key, which bypasses RLS. */
export function supabaseSnapshotDb(client: any): SnapshotDb {
  let eraTable: Promise<boolean> | null = null;
  return {
    async readClub(key) {
      const { data } = await client.from('club_snapshots').select('*').eq('club_key', key).maybeSingle();
      return data ?? null;
    },
    async writeClub(row) {
      const { error } = await client.from('club_snapshots').upsert(row, { onConflict: 'club_key' });
      if (error) console.warn('[snapshots] club upsert failed:', error.message ?? error);
    },
    async readEra(key) {
      const { data, error } = await client.from('era_snapshots').select('*').eq('snapshot_key', key).maybeSingle();
      if (isMissingTable(error)) eraTable = Promise.resolve(false);
      return data ?? null;
    },
    async writeEra(row) {
      const { error } = await client.from('era_snapshots').upsert(row, { onConflict: 'snapshot_key' });
      if (error) console.warn('[snapshots] era upsert failed:', error.message ?? error);
    },
    eraReady() {
      eraTable ??= Promise.resolve(client.from('era_snapshots').select('snapshot_key').limit(1)).then(
        ({ error }: { error: unknown }) => !error,
        () => false,
      );
      return eraTable;
    },
  };
}

export interface SnapshotServer {
  /** A club's research pass, shared with the build that follows it. */
  clubResearch(club: string): Promise<ClubResearch | null>;
  /** A club's stored snapshot, else a new build that is stored for everyone. */
  club(club: string): Promise<ClubSnapshot | null>;
  /** A club season's or a player window's stored snapshot, else a new build. */
  era(kind: EraKind, subject: string, period: string): Promise<EraSnapshot | null>;
}

export function createSnapshotServer(deps: { get: LiveGet; db: SnapshotDb | null }): SnapshotServer {
  const { db } = deps;
  const tools = liveToolset([], deps.get);
  const clubs = createClubSnapshotStore({
    read: (key) => (db ? db.readClub(key) : Promise.resolve(null)),
    write: (row) => (db ? db.writeClub(row) : Promise.resolve()),
    research: (club, live) => researchClub(club, live, tools),
    summarize: (club, live, pass) => summarizeClub(club, live, pass),
  });
  const eras = createEraSnapshotStore({
    read: (key) => (db ? db.readEra(key) : Promise.resolve(null)),
    write: (row) => (db ? db.writeEra(row) : Promise.resolve()),
    // An era snapshot is kept for good, so it's only worth building once it can be stored.
    build: async (req, facts) => ((await db?.eraReady()) ? buildEraSnapshot(req, facts, tools) : null),
  });
  return {
    clubResearch: (club) => clubs.research(club, tools.clubRecentTeam(club)),
    club: (club) => clubs.get(club, tools.clubRecentTeam(club)),
    era: (kind, subject, period) =>
      eras.get({ kind, subject, period, facts: kind === 'club_season' ? tools.clubSeason(subject, period) : tools.playerCareer(subject) }),
  };
}
