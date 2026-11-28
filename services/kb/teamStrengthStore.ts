import type { Checkpoint, Snapshot, SnapshotKind, StrengthRow } from './teamStrength';

/**
 * Where the team-strength snapshots are kept: the `kb_team_strength` table, which the server writes
 * with the secret key and anyone may read, or this process's memory without the key. A snapshot
 * counts only once its marker is written, after all its rows, so a reader or the next build never
 * sees half of one. The marker is a row for the team `*`, whose `matches` is the row count.
 */

export interface SnapshotRef {
  date: string;
  kind: SnapshotKind;
}

export interface TeamStrengthStore {
  /** False while the table doesn't exist: a build then would have nowhere to go. */
  ready(): Promise<boolean>;
  /** The newest complete snapshot dated on or before `date`. */
  snapshotOn(date: string): Promise<SnapshotRef | null>;
  rows(ref: SnapshotRef): Promise<StrengthRow[]>;
  /** The newest finished season's complete snapshot, which a build carries on from. */
  checkpoint(): Promise<Checkpoint | null>;
  /** The date of the newest `latest` snapshot: the last day a build was stored. */
  latestDate(): Promise<string | null>;
  /** Stores the snapshots and drops `latest` snapshots older than theirs. */
  write(snapshots: Snapshot[]): Promise<void>;
}

export const MARKER_TEAM = '*';
/** Which snapshot wins when two share a date. */
const KIND_ORDER: Record<SnapshotKind, number> = { latest: 2, season_end: 1, month: 0 };
const newest = (a: SnapshotRef, b: SnapshotRef) => b.date.localeCompare(a.date) || KIND_ORDER[b.kind] - KIND_ORDER[a.kind];

export function memoryTeamStrengthStore(): TeamStrengthStore {
  const snapshots = new Map<string, Snapshot>();
  const key = (ref: SnapshotRef) => `${ref.date}|${ref.kind}`;
  const all = () => [...snapshots.values()].sort(newest);
  return {
    ready: async () => true,
    async snapshotOn(date) {
      const hit = all().find((s) => s.date <= date);
      return hit ? { date: hit.date, kind: hit.kind } : null;
    },
    rows: async (ref) => snapshots.get(key(ref))?.rows ?? [],
    async checkpoint() {
      const hit = all().find((s) => s.kind === 'season_end');
      return hit ? { date: hit.date, rows: hit.rows } : null;
    },
    latestDate: async () => all().find((s) => s.kind === 'latest')?.date ?? null,
    async write(next) {
      for (const s of next) snapshots.set(key(s), s);
      const latest = next.find((s) => s.kind === 'latest')?.date;
      if (latest) for (const s of [...snapshots.values()]) if (s.kind === 'latest' && s.date < latest) snapshots.delete(key(s));
    },
  };
}

const TABLE = 'kb_team_strength';
/** Rows per write, and per page of a read (Supabase returns at most 1,000). */
const BATCH = 1_000;
const COLUMNS = 'team_id, club, league, league_match, in_europe, rated_on, kind, rating, matches, last_match';

const markerFor = (s: Snapshot) => ({
  team_id: MARKER_TEAM,
  club: 'complete',
  league: null,
  league_match: null,
  in_europe: false,
  rated_on: s.date,
  kind: s.kind,
  rating: 0,
  matches: s.rows.length,
  last_match: s.date,
});

/** The table through a Supabase client. Writing needs the secret key's client. */
export function supabaseTeamStrengthStore(client: any): TeamStrengthStore {
  const must = <T extends { data?: any; error?: any }>(result: T, what: string): any => {
    if (result.error) throw new Error(`${TABLE} ${what} failed: ${result.error.message ?? result.error}`);
    return result.data;
  };
  const markers = (kind?: SnapshotKind, onOrBefore?: string) => {
    let q = client.from(TABLE).select('rated_on, kind, matches').eq('team_id', MARKER_TEAM);
    if (kind) q = q.eq('kind', kind);
    if (onOrBefore) q = q.lte('rated_on', onOrBefore);
    return q.order('rated_on', { ascending: false }).limit(3);
  };
  const rows = async (ref: SnapshotRef): Promise<StrengthRow[]> => {
    const out: StrengthRow[] = [];
    for (let from = 0; ; from += BATCH) {
      const page: any[] = must(
        await client.from(TABLE).select(COLUMNS).eq('rated_on', ref.date).eq('kind', ref.kind).neq('team_id', MARKER_TEAM).order('team_id').range(from, from + BATCH - 1),
        'read',
      ) ?? [];
      out.push(...page.map((r) => ({ ...r, rating: Number(r.rating) })));
      if (page.length < BATCH) return out;
    }
  };
  const upsert = async (list: unknown[]) => {
    for (let i = 0; i < list.length; i += BATCH) {
      must(await client.from(TABLE).upsert(list.slice(i, i + BATCH), { onConflict: 'team_id,rated_on,kind' }), 'write');
    }
  };
  return {
    async ready() {
      const { error } = await client.from(TABLE).select('team_id').limit(1);
      return !error;
    },
    async snapshotOn(date) {
      const found: any[] = must(await markers(undefined, date), 'read') ?? [];
      const best = found.map((m) => ({ date: String(m.rated_on), kind: m.kind as SnapshotKind })).sort(newest)[0];
      return best ?? null;
    },
    rows,
    async checkpoint() {
      const marker = (must(await markers('season_end'), 'read') ?? [])[0];
      if (!marker) return null;
      const date = String(marker.rated_on);
      const held = await rows({ date, kind: 'season_end' });
      // Fewer rows than the marker counted means the snapshot isn't whole; rebuild instead. More
      // is a stray row an earlier, unfinished write left, which a rebuild couldn't remove.
      return held.length >= marker.matches ? { date, rows: held } : null;
    },
    async latestDate() {
      const marker = (must(await markers('latest'), 'read') ?? [])[0];
      return marker ? String(marker.rated_on) : null;
    },
    async write(snapshots) {
      await upsert(snapshots.flatMap((s) => s.rows));
      await upsert(snapshots.map(markerFor));
      const latest = snapshots.find((s) => s.kind === 'latest')?.date;
      if (latest) must(await client.from(TABLE).delete().eq('kind', 'latest').lt('rated_on', latest), 'delete');
    },
  };
}
