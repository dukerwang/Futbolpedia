/**
 * Who a club has actually been playing: starting XIs from its recent matches and the players ruled
 * out of its next one, parsed from API-Football (`fixtures/lineups`, `injuries`). The server builds
 * these; chat grounding prints them, so tactical answers start from the real team rather than the
 * squad the model remembers. Pure functions, shared by `server.ts` and the client.
 */

export interface LineupStarter {
  name: string;
  /** API-Football's line: G, D, M or F. */
  pos: string | null;
  /** "row:col" on the formation grid; rows run from the goalkeeper forward. */
  grid: string | null;
}

export interface TeamLineup {
  date: string | null;
  competition: string | null;
  opponent: string | null;
  formation: string | null;
  starters: LineupStarter[];
}

export interface TeamAbsence {
  name: string;
  /** "Missing Fixture" or "Questionable". */
  status: string | null;
  reason: string | null;
}

/** Most recent first: how many of a club's latest matches to read lineups from. */
export const LINEUP_MATCHES = 3;

/** The club's XI from one `fixtures/lineups` response, with the match it was named for. */
export function parseTeamLineup(
  response: unknown,
  teamId: number,
  match: { date: string | null; competition: string | null; opponent: string | null },
): TeamLineup | null {
  if (!Array.isArray(response)) return null;
  const entry = response.find((r: any) => r?.team?.id === teamId) as any;
  const starters: LineupStarter[] = (Array.isArray(entry?.startXI) ? entry.startXI : [])
    .map((s: any) => s?.player)
    .filter((p: any) => p?.name)
    .map((p: any) => ({ name: String(p.name), pos: p.pos ? String(p.pos) : null, grid: p.grid ? String(p.grid) : null }));
  if (starters.length === 0) return null;
  return { ...match, formation: entry.formation ? String(entry.formation) : null, starters };
}

/** The club's players listed out of or doubtful for a fixture, from an `injuries` response. */
export function parseAbsences(response: unknown, teamId: number): TeamAbsence[] {
  if (!Array.isArray(response)) return [];
  return response
    .filter((r: any) => r?.team?.id === teamId && r?.player?.name)
    .map((r: any) => ({
      name: String(r.player.name),
      status: r.player.type ? String(r.player.type) : null,
      reason: r.player.reason ? String(r.player.reason) : null,
    }));
}

/** One list of absences across fixtures, each player once, the first fixture's entry winning. */
export function mergeAbsences(...lists: TeamAbsence[][]): TeamAbsence[] {
  const seen = new Map<string, TeamAbsence>();
  for (const list of lists) for (const a of list) if (!seen.has(a.name)) seen.set(a.name, a);
  return [...seen.values()];
}

const LINE_NAMES: Record<string, string> = { G: 'GK', D: 'DEF', M: 'MID', F: 'FWD' };

const gridRow = (s: LineupStarter): number => Number(s.grid?.split(':')[0]) || 0;
const gridCol = (s: LineupStarter): number => Number(s.grid?.split(':')[1]) || 0;

/** An XI as lines from goalkeeper to attack: "GK name | DEF name, name, name, name | MID ..." */
export function formatStartingXI(lineup: TeamLineup): string {
  const rows = new Map<number, LineupStarter[]>();
  for (const s of lineup.starters) rows.set(gridRow(s), [...(rows.get(gridRow(s)) ?? []), s]);
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, players]) => {
      const line = LINE_NAMES[players[0].pos ?? ''] ?? 'Line';
      return `${line} ${players.sort((a, b) => gridCol(a) - gridCol(b)).map((p) => p.name).join(', ')}`;
    })
    .join(' | ');
}

/**
 * The grounding block for a club's recent team: each recent XI, how often each player started
 * them, and who is out. `absences` is null when the injury list couldn't be read, which is not the
 * same as nobody being injured. Empty when API-Football had neither.
 */
export function formatRecentTeamBlock(team: string, lineups: TeamLineup[], absences: TeamAbsence[] | null): string {
  if (lineups.length === 0 && !absences?.length) return '';
  const lines: string[] = [`Recent Starting XIs (API-Football, most recent first — the team ${team} has actually been fielding):`];
  for (const l of lineups) {
    const meta = [l.date, l.competition, l.opponent ? `vs ${l.opponent}` : null, l.formation].filter(Boolean).join(', ');
    lines.push(`  - ${meta}: ${formatStartingXI(l)}`);
  }
  if (lineups.length > 1) {
    const starts = new Map<string, number>();
    for (const l of lineups) for (const s of l.starters) starts.set(s.name, (starts.get(s.name) ?? 0) + 1);
    const ranked = [...starts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}/${lineups.length}`);
    lines.push(`  Starts in these matches: ${ranked.join(', ')}`);
  }
  if (absences) lines.push(
    absences.length > 0
      ? `Unavailable or doubtful (API-Football injury list): ${absences
          .map((a) => `${a.name}${a.reason ? ` (${a.reason}${a.status === 'Questionable' ? ', doubtful' : ''})` : a.status === 'Questionable' ? ' (doubtful)' : ''}`)
          .join(', ')}`
      : 'Unavailable or doubtful (API-Football injury list): none reported',
  );
  return lines.join('\n');
}
