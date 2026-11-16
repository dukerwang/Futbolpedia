import { Type } from '@google/genai';
import { generateStructured, getCurrentSeasonInfo } from './aiClient';
import { SNAPSHOT_VERSION } from './clubSnapshots';
import { toClubKey } from './clubManagers';
import { isMissingTable } from './eraSnapshots';
import { seasonStartDate } from './evidenceLedger';
import {
  commonName,
  fplAbsences,
  samePlayerName,
  type ClubMatch,
  type LiveClubReport,
  type LiveClubResult,
  type LiveMatchResult,
} from './liveFootball';
import type { LiveGet } from './researchTools';
import { deriveClubCore, type ClubCore, type ClubSnapshot, type ClubStory } from './situationSnapshot';
import { isLatePrediction, scoreXi, totalsOf, type ActualXi, type KindTotals, type PredictedSlot, type XiScore } from './xiScoring';

/**
 * The scout's XI track record. Before each match of a club people ask about, the server stores two
 * predictions of its starting XI, and after the match it scores both against the lineup ESPN
 * published:
 *   code      the first-choice XI code works out from recent lineups and season starts, as the
 *             writer reads it (`firstChoiceXI`)
 *   adjusted  the same XI after one low-thinking model call that reads what lineups can't show: the
 *             club's story (arrivals, departures, a new shape), its injuries and news, the fixture
 *             and how many lineups this season there are to learn from
 * Both are kept side by side in the `xi_predictions` table (written only with the server's secret
 * key, else kept in memory), so the record can show whether context beats the code XI. Nothing
 * here changes what the writer reads. Scoring rules are in `xiScoring.ts`.
 */

/** Fixtures kicking off within this long get a prediction. */
export const XI_PREDICTION_WINDOW_MS = 48 * 60 * 60 * 1000;
export const XI_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** A match is read for its lineup this long after kickoff, once it can have finished. */
const MATCH_LENGTH_MS = 2 * 60 * 60 * 1000;
/** A match whose lineup ESPN still hasn't published this long after kickoff is given up on. */
const SCORE_GIVE_UP_MS = 14 * 24 * 60 * 60 * 1000;
/** Only clubs whose snapshot was built this recently are swept, so a club nobody asks about stops costing calls. */
export const XI_SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Model calls one sweep may make; fixtures beyond it wait for the next hourly sweep. */
export const MAX_ADJUSTED_PER_SWEEP = 25;
/** Model calls a lazy run for one club may make. */
const MAX_ADJUSTED_PER_LAZY = 3;
/** A club asked about again within this long isn't re-checked by the lazy path. */
const LAZY_COOLDOWN_MS = 30 * 60 * 1000;
const ADJUST_TIMEOUT_MS = 30_000;
const RECORD_CACHE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Rows

export interface PredictedXi {
  slots: PredictedSlot[];
  /** Adjusted predictions only: one line for each slot that differs from the code XI. */
  reasons?: string[];
}

/** One club and match, as stored in `xi_predictions`. */
export interface XiPredictionRow {
  club_key: string;
  match_id: string;
  club_name: string;
  league: string;
  kickoff_at: string;
  opponent: string;
  competition: string;
  home: boolean;
  predicted_code: PredictedXi;
  /** Null when the adjusted call failed or timed out. */
  predicted_adjusted: PredictedXi | null;
  adjusted_status: 'ok' | 'failed';
  formation_code: string | null;
  formation_adjusted: string | null;
  basis: 'lineups' | 'season_starts';
  matches_read: number;
  snapshot_built_at: string;
  snapshot_version: number;
  predicted_at: string;
  // Filled after the match.
  actual: (ActualXi & { subsUsed?: string[] }) | null;
  actual_formation: string | null;
  scored_at: string | null;
  /** Predicted at or after kickoff: scored but left out of the record. */
  late: boolean;
  names_right_code: number | null;
  slots_right_code: number | null;
  formation_right_code: boolean | null;
  names_right_adjusted: number | null;
  slots_right_adjusted: number | null;
  formation_right_adjusted: boolean | null;
}

export interface XiPredictionStore {
  forClub(clubKey: string): Promise<XiPredictionRow[]>;
  /** Inserts or replaces the row for its club and match. */
  put(row: XiPredictionRow): Promise<void>;
}

/** Rows kept in the server's memory, for a server without the secret key. */
export function memoryXiStore(): XiPredictionStore {
  const rows = new Map<string, XiPredictionRow>();
  return {
    async forClub(clubKey) {
      return [...rows.values()].filter((r) => r.club_key === clubKey);
    },
    async put(row) {
      rows.set(`${row.club_key}|${row.match_id}`, row);
    },
  };
}

/**
 * The table through a Supabase client made with the secret key. When the table doesn't exist yet
 * (its migration isn't applied), the store keeps rows in memory instead and says so once.
 */
export function supabaseXiStore(client: any): XiPredictionStore {
  const fallback = memoryXiStore();
  let missing = false;
  const noteMissing = (error: { code?: string; message?: string } | null) => {
    if (!missing && isMissingTable(error)) {
      missing = true;
      console.warn('[predictions] xi_predictions table is missing; keeping rows in memory until its migration is applied');
    }
    return missing;
  };
  return {
    async forClub(clubKey) {
      if (missing) return fallback.forClub(clubKey);
      const { data, error } = await client.from('xi_predictions').select('*').eq('club_key', clubKey);
      if (error) {
        if (noteMissing(error)) return fallback.forClub(clubKey);
        console.warn('[predictions] read failed:', error.message ?? error);
        return [];
      }
      return (data ?? []) as XiPredictionRow[];
    },
    async put(row) {
      if (missing) return fallback.put(row);
      const { error } = await client.from('xi_predictions').upsert(row, { onConflict: 'club_key,match_id' });
      if (error) {
        if (noteMissing(error)) return fallback.put(row);
        console.warn('[predictions] write failed:', error.message ?? error);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The adjusted prediction

export interface AdjustedXiInput {
  today: string;
  season: string;
  club: string;
  league: string;
  fixture: { opponent: string; competition: string; home: boolean; kickoff: string };
  code: { formation: string | null; basis: ClubCore['xiBasis']; matchesRead: number; slots: PredictedSlot[] };
  /** Lineups from this season among those read; few means last season's picture is stale. */
  lineupsThisSeason: number;
  story: ClubStory & { builtAt: string };
  out: { name: string; note: string }[];
  outCovered: boolean;
  form: string[];
  record: string;
  /** Players the feeds name for the club, with what they say about each. */
  squad: string[];
}

export const ADJUSTED_XI_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    slots: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { role: { type: Type.STRING }, name: { type: Type.STRING }, reason: { type: Type.STRING } },
        required: ['role', 'name', 'reason'],
      },
    },
  },
  required: ['slots'],
};

const slotLine = (s: PredictedSlot): string =>
  `${s.role}: ${s.name ?? 'nobody'}${s.rotation ? ` (even split with ${s.rotation})` : ''}`;

export const buildAdjustedPrompt = (i: AdjustedXiInput): string => `You are predicting the starting eleven ${i.club} (${i.league}) will name for its next match. Today is ${i.today}, in the ${i.season} season.

The code XI below was worked out from the club's recent starting lineups${i.code.basis === 'season_starts' ? ' (none were available, so it comes from season starts and is only a rough guide)' : ''}. Lineups can't show everything: a player who joined recently has few starts, a player who left still has some, a coach's change of shape or of a player's role shows only slowly, and a player who is out or doubtful, or a fixture that invites rotation, changes who plays. Use the club's story, its absences and the fixture to adjust the code XI where the evidence gives a concrete reason, and keep the code XI's player everywhere else.

How much to trust the code XI: it was read from ${i.code.matchesRead} lineup${i.code.matchesRead === 1 ? '' : 's'}, ${i.lineupsThisSeason} of them from this season. The fewer lineups from this season there are, the more the story should count; with several, the code XI is a strong base and needs a clear reason to change.

The next match: ${i.fixture.competition}, ${i.fixture.home ? 'at home to' : 'away at'} ${i.fixture.opponent}, kickoff ${i.fixture.kickoff}. Take the competition and venue into account: domestic cup ties and crowded schedules invite rotation, while a league match against a strong side usually brings the regular team.

Code XI (${i.code.formation ?? 'shape unknown'}):
${i.code.slots.map(slotLine).join('\n')}

Absences: ${
  i.out.length
    ? i.out.map((o) => `${o.name} (${o.note})`).join('; ')
    : i.outCovered
      ? 'nobody is listed as injured or suspended'
      : 'no injury list covers this club; read the news below'
}. A player who is out cannot start.
${i.story.newsAbsences.length ? `News absences: ${i.story.newsAbsences.map((o) => `${o.name} (${o.note})`).join('; ')}.\n` : ''}Recent results, most recent first (${i.record || 'none'}): ${i.form.join('; ') || 'none'}

The club's story, written ${i.story.builtAt.slice(0, 10)}:
- Changed since last season: ${i.story.changes.join('; ') || 'nothing recorded'}
- Distinctive this season: ${i.story.distinctive || 'nothing recorded'}
- Still unknown: ${i.story.unknowns.join('; ') || 'nothing recorded'}

Players the feeds name for this club:
${i.squad.join('\n') || 'none'}

Rules:
- Return one entry for every role in the code XI, in the same order, using the same role codes.
- Name each player the way football coverage names him, taken from the lists above. Name only players the evidence above mentions. Name each player at most once.
- For each slot whose player differs from the code XI's, give a reason: one short sentence that names the evidence it rests on. Leave the reason empty for a slot you keep.
- Where the evidence is thin, keep the code XI's player. Don't change a slot because of a guess.`;

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * The model's answer as an adjusted prediction, or null when it isn't usable: every role of the
 * code XI answered once with a name, and no player named twice. A slot the model keeps keeps the
 * code XI's spelling and rotation.
 */
export function sanitizeAdjustedXi(raw: any, code: PredictedSlot[]): PredictedXi | null {
  const answered = (Array.isArray(raw?.slots) ? raw.slots : []).map((s: any) => ({ role: text(s?.role, 20), name: text(s?.name, 80), reason: text(s?.reason, 240) }));
  const used = new Set<number>();
  const slots: PredictedSlot[] = [];
  const reasons: string[] = [];
  for (const base of code) {
    const at = answered.findIndex((a: { role: string }, k: number) => !used.has(k) && a.role.toUpperCase() === base.role.toUpperCase());
    if (at < 0 || !answered[at].name) return null;
    used.add(at);
    const { name, reason } = answered[at];
    const kept = base.name !== null && samePlayerName(name, base.name);
    if (kept) {
      slots.push({ role: base.role, name: base.name, ...(base.rotation ? { rotation: base.rotation } : {}) });
    } else {
      const why = reason || 'adjusted for context';
      slots.push({ role: base.role, name, reason: why });
      reasons.push(`${base.role}: ${name} for ${base.name ?? 'nobody'}. ${why}`);
    }
  }
  const names = slots.map((s) => s.name as string);
  const repeated = names.some((n, i) => names.some((m, j) => i !== j && samePlayerName(n, m)));
  return repeated ? null : { slots, reasons };
}

export interface AdjustedXiModel {
  adjust(input: AdjustedXiInput): Promise<unknown>;
}

/** One schema-enforced call on the app's fast model at low thinking (the `prediction` profile). */
export const liveAdjustedXiModel: AdjustedXiModel = {
  adjust: (input) =>
    generateStructured<unknown>({ task: 'prediction', prompt: buildAdjustedPrompt(input), schema: ADJUSTED_XI_SCHEMA, thinkingLevelOverride: 'low' }),
};

// ---------------------------------------------------------------------------------------------
// Building a prediction from the live report

const codeSlots = (core: ClubCore): PredictedSlot[] => core.xi.map((s) => ({ role: s.role, name: s.name, ...(s.rotation ? { rotation: s.rotation } : {}) }));

/** The players the feeds name for the club, most used first, with what they say about each. */
function squadPool(report: LiveClubReport, limit = 36): string[] {
  const espnNames = [...new Set(report.lineups.flatMap((l) => [...l.starters.map((s) => s.name), ...l.subsUsed]))];
  const lines: string[] = [];
  const seen: string[] = [];
  const add = (name: string, note: string) => {
    if (seen.some((n) => samePlayerName(n, name)) || lines.length >= limit) return;
    seen.push(name);
    lines.push(`${name} (${note})`);
  };
  const out = new Set(fplAbsences(report.fplPlayers ?? []).map((p) => p.id));
  for (const p of [...(report.fplPlayers ?? [])].sort((a, b) => b.minutes - a.minutes)) {
    add(commonName(p, espnNames), `${p.position}, ${p.starts} league starts${out.has(p.id) ? ', on the injury list' : ''}`);
  }
  const starts = new Map<string, number>();
  for (const l of report.lineups) for (const s of l.starters) starts.set(s.name, (starts.get(s.name) ?? 0) + 1);
  for (const [name, n] of [...starts.entries()].sort((a, b) => b[1] - a[1])) add(name, `started ${n} of the last ${report.lineups.length}`);
  for (const name of espnNames) add(name, 'came on in a recent match');
  return lines;
}

function adjustedInput(snapshot: ClubSnapshot, report: LiveClubReport, core: ClubCore, fixture: ClubMatch, now: Date): AdjustedXiInput {
  const { currentSeason, seasonStartYear } = getCurrentSeasonInfo(now);
  const seasonStart = seasonStartDate(seasonStartYear);
  return {
    today: now.toISOString().slice(0, 10),
    season: currentSeason,
    club: report.team,
    league: report.league,
    fixture: { opponent: fixture.opponent, competition: fixture.competition, home: fixture.home, kickoff: fixture.kickoff ?? fixture.date ?? 'unknown' },
    code: { formation: core.formation, basis: core.xiBasis, matchesRead: core.matchesRead, slots: codeSlots(core) },
    lineupsThisSeason: report.lineups.filter((l) => (l.match.date ?? '') >= seasonStart).length,
    story: { ...snapshot.story, builtAt: snapshot.builtAt },
    out: core.out,
    outCovered: core.outCovered,
    form: core.form,
    record: core.record,
    squad: squadPool(report),
  };
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });

// ---------------------------------------------------------------------------------------------
// The record

export interface RecordedMatch {
  matchId: string;
  kickoff: string;
  opponent: string;
  competition: string;
  home: boolean;
  predictedAt: string;
  basis: XiPredictionRow['basis'];
  matchesRead: number;
  snapshotBuiltAt: string;
  predictedCode: PredictedXi;
  predictedAdjusted: PredictedXi | null;
  adjustedStatus: XiPredictionRow['adjusted_status'];
  formationCode: string | null;
  formationAdjusted: string | null;
  actual: XiPredictionRow['actual'];
  actualFormation: string | null;
  scoredAt: string | null;
  /** Null until the match is scored, and for an adjusted prediction that failed. */
  scores: { code: XiScore | null; adjusted: XiScore | null };
}

export interface ClubRecord {
  club: string;
  clubKey: string;
  /** Most recent first; predictions made after kickoff are left out. */
  scored: RecordedMatch[];
  totals: {
    code: KindTotals;
    adjusted: KindTotals;
    /** Both kinds over only the matches that have both, the fair comparison. */
    paired: { matches: number; code: KindTotals; adjusted: KindTotals };
  };
  /** The earliest prediction still waiting for its match or its lineup. */
  pending: RecordedMatch | null;
  lateExcluded: number;
}

const scoreOf = (row: XiPredictionRow, kind: 'code' | 'adjusted'): XiScore | null => {
  const names = kind === 'code' ? row.names_right_code : row.names_right_adjusted;
  const slots = kind === 'code' ? row.slots_right_code : row.slots_right_adjusted;
  const formation = kind === 'code' ? row.formation_right_code : row.formation_right_adjusted;
  return names === null || slots === null ? null : { namesRight: names, slotsRight: slots, formationRight: formation };
};

const recorded = (row: XiPredictionRow): RecordedMatch => ({
  matchId: row.match_id,
  kickoff: row.kickoff_at,
  opponent: row.opponent,
  competition: row.competition,
  home: row.home,
  predictedAt: row.predicted_at,
  basis: row.basis,
  matchesRead: row.matches_read,
  snapshotBuiltAt: row.snapshot_built_at,
  predictedCode: row.predicted_code,
  predictedAdjusted: row.predicted_adjusted,
  adjustedStatus: row.adjusted_status,
  formationCode: row.formation_code,
  formationAdjusted: row.formation_adjusted,
  actual: row.actual,
  actualFormation: row.actual_formation,
  scoredAt: row.scored_at,
  scores: { code: scoreOf(row, 'code'), adjusted: scoreOf(row, 'adjusted') },
});

/** A club's record from its rows: the scored matches, totals per kind and the next prediction. */
export function buildClubRecord(club: string, clubKey: string, rows: XiPredictionRow[], nowMs: number): ClubRecord {
  const byKickoff = (a: XiPredictionRow, b: XiPredictionRow) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at);
  const scoredRows = rows.filter((r) => r.scored_at && !r.late).sort((a, b) => byKickoff(b, a));
  const codeScores = scoredRows.map((r) => scoreOf(r, 'code')).filter((s): s is XiScore => s !== null);
  const adjustedScores = scoredRows.map((r) => scoreOf(r, 'adjusted')).filter((s): s is XiScore => s !== null);
  const both = scoredRows.filter((r) => scoreOf(r, 'code') && scoreOf(r, 'adjusted'));
  const pending = rows
    .filter((r) => !r.scored_at && Date.parse(r.kickoff_at) > nowMs - SCORE_GIVE_UP_MS)
    .sort(byKickoff)[0];
  return {
    club,
    clubKey,
    scored: scoredRows.map(recorded),
    totals: {
      code: totalsOf(codeScores),
      adjusted: totalsOf(adjustedScores),
      paired: {
        matches: both.length,
        code: totalsOf(both.map((r) => scoreOf(r, 'code')!)),
        adjusted: totalsOf(both.map((r) => scoreOf(r, 'adjusted')!)),
      },
    },
    pending: pending ? recorded(pending) : null,
    lateExcluded: rows.filter((r) => r.scored_at && r.late).length,
  };
}

// ---------------------------------------------------------------------------------------------
// Sweeping

export interface PredictionCounts {
  clubs: number;
  predicted: number;
  adjusted: number;
  adjustedFailed: number;
  scored: number;
  late: number;
  /** Fixtures left for the next run because the run's model budget was spent. */
  deferred: number;
  /** Fixtures with no XI to predict from, or clubs the live data couldn't read. */
  skipped: number;
}

const emptyCounts = (): PredictionCounts => ({ clubs: 0, predicted: 0, adjusted: 0, adjustedFailed: 0, scored: 0, late: 0, deferred: 0, skipped: 0 });
const addCounts = (a: PredictionCounts, b: PredictionCounts): PredictionCounts =>
  Object.fromEntries(Object.keys(a).map((k) => [k, a[k as keyof PredictionCounts] + b[k as keyof PredictionCounts]])) as unknown as PredictionCounts;
const describeCounts = (c: PredictionCounts): string =>
  `${c.clubs} club${c.clubs === 1 ? '' : 's'}, ${c.predicted} predicted (${c.adjusted} adjusted, ${c.adjustedFailed} adjusted failed), ${c.scored} scored (${c.late} late), ${c.deferred} deferred, ${c.skipped} skipped`;

export interface XiPredictionDeps {
  /** The live feeds, answered in-process (`inProcessGet`). */
  get: LiveGet;
  store: XiPredictionStore;
  /** Every stored snapshot built within `maxAgeMs`: the table's rows, or in memory mode the built ones. */
  listSnapshots(maxAgeMs: number): Promise<ClubSnapshot[]>;
  /** The stored snapshot for a club by any name the live data knows it by. */
  snapshotFor(club: string): Promise<ClubSnapshot | null>;
  model?: AdjustedXiModel;
  now?: () => number;
  windowMs?: number;
  maxAdjustedPerSweep?: number;
  adjustTimeoutMs?: number;
}

export function createXiPredictions(deps: XiPredictionDeps) {
  const { get, store } = deps;
  const model = deps.model ?? liveAdjustedXiModel;
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? XI_PREDICTION_WINDOW_MS;
  const adjustTimeoutMs = deps.adjustTimeoutMs ?? ADJUST_TIMEOUT_MS;
  const running = new Map<string, Promise<PredictionCounts>>();
  const lazyChecked = new Map<string, number>();
  const records = new Map<string, { expiresAt: number; value: ClubRecord }>();
  let sweeping = false;

  /** The adjusted prediction for one fixture, or null (and a warning) when the call fails, is slow or answers badly. */
  async function adjust(input: AdjustedXiInput, code: PredictedSlot[]): Promise<PredictedXi | null> {
    try {
      const adjusted = sanitizeAdjustedXi(await withTimeout(model.adjust(input), adjustTimeoutMs), code);
      if (!adjusted) console.warn(`[predictions] adjusted XI for ${input.club} was not usable`);
      return adjusted;
    } catch (e) {
      console.warn(`[predictions] adjusted XI for ${input.club} failed:`, (e as Error)?.message ?? e);
      return null;
    }
  }

  /** Scores every finished, unscored match of the club. */
  async function scoreClub(report: LiveClubReport, rows: XiPredictionRow[], counts: PredictionCounts): Promise<void> {
    const t = now();
    const due = rows.filter((r) => {
      const kickoff = Date.parse(r.kickoff_at);
      return !r.scored_at && kickoff + MATCH_LENGTH_MS <= t && kickoff + SCORE_GIVE_UP_MS > t;
    });
    for (const row of due) {
      const res = await get<LiveMatchResult>(`/api/live/match?${new URLSearchParams({ name: report.team, match: row.match_id })}`);
      if ('error' in res || !res.data.found) continue;
      const { lineup } = res.data;
      const actual = { starters: lineup.starters, formation: lineup.formation };
      const code = scoreXi(row.predicted_code.slots, row.formation_code, actual);
      const adjusted = row.predicted_adjusted ? scoreXi(row.predicted_adjusted.slots, row.formation_adjusted, actual) : null;
      const late = isLatePrediction(Date.parse(row.predicted_at), Date.parse(row.kickoff_at));
      const scored: XiPredictionRow = {
        ...row,
        actual: { starters: lineup.starters, subsUsed: lineup.subsUsed },
        actual_formation: lineup.formation,
        scored_at: new Date(t).toISOString(),
        late,
        names_right_code: code.namesRight,
        slots_right_code: code.slotsRight,
        formation_right_code: code.formationRight,
        names_right_adjusted: adjusted?.namesRight ?? null,
        slots_right_adjusted: adjusted?.slotsRight ?? null,
        formation_right_adjusted: adjusted?.formationRight ?? null,
      };
      await store.put(scored);
      rows.splice(rows.indexOf(row), 1, scored);
      counts.scored++;
      if (late) counts.late++;
    }
  }

  /** Stores both predictions for each fixture inside the window that has no row. */
  async function predictClub(
    snapshot: ClubSnapshot,
    report: LiveClubReport,
    clubKey: string,
    rows: XiPredictionRow[],
    budget: { left: number },
    counts: PredictionCounts,
  ): Promise<void> {
    const t = now();
    const known = new Set(rows.map((r) => r.match_id));
    const fixtures = report.fixtures.filter((f) => {
      const kickoff = f.kickoff ? Date.parse(f.kickoff) : NaN;
      return !f.completed && !known.has(f.id) && kickoff > t && kickoff <= t + windowMs;
    });
    if (fixtures.length === 0) return;
    const core = deriveClubCore(report);
    if (core.xiBasis === 'none' || core.xi.length === 0) {
      counts.skipped += fixtures.length;
      return;
    }
    const code: PredictedXi = { slots: codeSlots(core) };
    for (const fixture of fixtures) {
      if (budget.left <= 0) {
        counts.deferred++;
        continue;
      }
      budget.left--;
      const adjusted = await adjust(adjustedInput(snapshot, report, core, fixture, new Date(t)), code.slots);
      const row: XiPredictionRow = {
        club_key: clubKey,
        match_id: fixture.id,
        club_name: report.team,
        league: report.league,
        kickoff_at: fixture.kickoff!,
        opponent: fixture.opponent,
        competition: fixture.competition,
        home: fixture.home,
        predicted_code: code,
        predicted_adjusted: adjusted,
        adjusted_status: adjusted ? 'ok' : 'failed',
        formation_code: core.formation,
        // The adjusted XI keeps the code XI's role codes, so it plays the code XI's shape.
        formation_adjusted: adjusted ? core.formation : null,
        basis: core.xiBasis,
        matches_read: core.matchesRead,
        snapshot_built_at: snapshot.builtAt,
        snapshot_version: snapshot.version,
        predicted_at: new Date(now()).toISOString(),
        actual: null,
        actual_formation: null,
        scored_at: null,
        late: false,
        names_right_code: null,
        slots_right_code: null,
        formation_right_code: null,
        names_right_adjusted: null,
        slots_right_adjusted: null,
        formation_right_adjusted: null,
      };
      await store.put(row);
      rows.push(row);
      counts.predicted++;
      if (adjusted) counts.adjusted++;
      else counts.adjustedFailed++;
    }
  }

  async function runClub(snapshot: ClubSnapshot, budget: { left: number }): Promise<PredictionCounts> {
    const counts = emptyCounts();
    counts.clubs = 1;
    const live = await get<LiveClubResult>(`/api/live/club?${new URLSearchParams({ name: snapshot.club })}`);
    if ('error' in live || !live.data.found) {
      counts.skipped++;
      return counts;
    }
    const { report } = live.data;
    const clubKey = toClubKey(report.team);
    const rows = await store.forClub(clubKey);
    await scoreClub(report, rows, counts);
    await predictClub(snapshot, report, clubKey, rows, budget, counts);
    return counts;
  }

  /** One run per club at a time, so a lazy run and the sweep never predict the same match twice. */
  function runOnce(snapshot: ClubSnapshot, budget: { left: number }): Promise<PredictionCounts> {
    const key = toClubKey(snapshot.club);
    const pending = running.get(key);
    if (pending) return pending.then(() => ({ ...emptyCounts(), clubs: 1 }));
    const job = runClub(snapshot, budget)
      .catch((e) => {
        console.warn(`[predictions] ${snapshot.club} failed:`, (e as Error)?.message ?? e);
        return { ...emptyCounts(), clubs: 1, skipped: 1 };
      })
      .finally(() => running.delete(key));
    running.set(key, job);
    return job;
  }

  /** Every club with a stored snapshot: score what has finished, predict what kicks off soon. */
  async function sweep(): Promise<PredictionCounts | null> {
    if (sweeping) {
      console.log('[predictions] sweep skipped: the last one is still running');
      return null;
    }
    sweeping = true;
    const start = now();
    try {
      const snapshots = await deps.listSnapshots(XI_SNAPSHOT_MAX_AGE_MS);
      const budget = { left: deps.maxAdjustedPerSweep ?? MAX_ADJUSTED_PER_SWEEP };
      let total = emptyCounts();
      for (const snapshot of snapshots) total = addCounts(total, await runOnce(snapshot, budget));
      console.log(`[predictions] sweep: ${describeCounts(total)} (${now() - start}ms)`);
      return total;
    } catch (e) {
      console.warn('[predictions] sweep failed:', (e as Error)?.message ?? e);
      return null;
    } finally {
      sweeping = false;
    }
  }

  /**
   * The same two steps for one club somebody just asked about, so it has a prediction before the
   * weekend even when the sweep is down. A club is checked at most every half hour. Callers
   * don't wait for it: it never throws and logs its own result.
   */
  async function lazy(club: string): Promise<PredictionCounts | null> {
    const typedKey = toClubKey(club);
    const last = lazyChecked.get(typedKey);
    if (last !== undefined && now() - last < LAZY_COOLDOWN_MS) return null;
    lazyChecked.set(typedKey, now());
    const start = now();
    try {
      const snapshot = await deps.snapshotFor(club);
      if (!snapshot) return null;
      const counts = await runOnce(snapshot, { left: MAX_ADJUSTED_PER_LAZY });
      console.log(`[predictions] lazy "${club}": ${describeCounts(counts)} (${now() - start}ms)`);
      return counts;
    } catch (e) {
      console.warn(`[predictions] lazy "${club}" failed:`, (e as Error)?.message ?? e);
      return null;
    }
  }

  /** Sweeps now, then hourly. The timer doesn't keep the process alive. */
  function start(): { stop(): void } {
    void sweep();
    const timer = setInterval(() => void sweep(), XI_SWEEP_INTERVAL_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  }

  /** A club's record, by any name the live data knows it by. Cached for a few minutes. */
  async function record(name: string): Promise<ClubRecord | null> {
    const live = await get<LiveClubResult>(`/api/live/club?${new URLSearchParams({ name })}`);
    const found = !('error' in live) && live.data.found ? live.data : null;
    const club = found ? found.team : name;
    const clubKey = toClubKey(club);
    if (!clubKey) return null;
    const hit = records.get(clubKey);
    if (hit && hit.expiresAt > now()) return hit.value;
    const value = buildClubRecord(club, clubKey, await store.forClub(clubKey), now());
    records.set(clubKey, { expiresAt: now() + RECORD_CACHE_MS, value });
    return value;
  }

  return { sweep, lazy, start, record };
}

export type XiPredictions = ReturnType<typeof createXiPredictions>;

/** Whether a snapshot can feed predictions: built under the current version. */
export const isPredictableSnapshot = (version: number): boolean => version === SNAPSHOT_VERSION;
