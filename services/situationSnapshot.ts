import { Type } from '@google/genai';
import { generateStructured } from './aiClient';
import { compactLedger, type EvidenceLedger } from './evidenceLedger';
import {
  absenceNote,
  commonName,
  describeMatch,
  nameScore,
  roleCol,
  roleRow,
  type FplPlayer,
  type LiveClubReport,
  type LiveLineup,
} from './liveFootball';

/**
 * The situation snapshot: a compact, dated picture of the present that the writer argues from,
 * built between research and writing. Code works out what the feeds settle (each club's
 * first-choice XI from start counts and minutes, who's out, recent form); one quick model call
 * adds what only reading the evidence can (what changed since last season, what's distinctive
 * this season, players' current situations, and what's still unknown). Pure apart from the model.
 */

export interface XiSlot {
  /** ESPN's formation slot (GK, LB, CD-L, DM, AM-R, F, …), or a broad position on a season-starts XI. */
  role: string;
  /** Null when no available player has started there. */
  name: string | null;
  /** Starts in this slot's line across the recent XIs read. */
  starts: number;
  /** Another player who has started there just as often in league and European matches: an even split. */
  rotation?: string;
  note?: string;
}

export interface ClubCore {
  club: string;
  league: string;
  asOf: string;
  formation: string | null;
  /** How many recent starting XIs the XI was worked out from. */
  matchesRead: number;
  xi: XiSlot[];
  xiBasis: 'lineups' | 'season_starts' | 'none';
  out: { name: string; note: string }[];
  /** Whether an injury list backs `out` (Premier League clubs); elsewhere only news can. */
  outCovered: boolean;
  /** Most recent first, e.g. "2026-10-25 Premier League: home to Rivals, W 2-0". */
  form: string[];
  /** Results as letters, most recent first. */
  record: string;
  nextFixture: string | null;
}

/** What reading the evidence adds to a club's core. */
export interface ClubStory {
  changes: string[];
  distinctive: string;
  /** Absences reported in news, for clubs no injury list covers. */
  newsAbsences: { name: string; note: string }[];
  unknowns: string[];
}

export type ClubSituation = ClubCore & Partial<ClubStory>;

export interface PlayerSituation {
  name: string;
  club: string;
  role: string;
  form: string;
  status: string;
  changes: string;
}

/** A club's snapshot as stored for every user: the core it was built from and the story read from evidence. */
export interface ClubSnapshot {
  club: string;
  league: string;
  core: ClubCore;
  story: ClubStory;
  sources: string[];
  /** ISO time of the build. */
  builtAt: string;
  version: number;
}

export interface Situation {
  asOf: string;
  clubs: ClubSituation[];
  players: PlayerSituation[];
  unknowns: string[];
}

// ---------------------------------------------------------------------------------------------
// The core, from the feeds

const UNAVAILABLE = new Set(['i', 's', 'n']);
const isOut = (p: FplPlayer | undefined): boolean => Boolean(p && (UNAVAILABLE.has(p.status) || (p.status === 'd' && p.chance === 0)));
const isDoubtful = (p: FplPlayer | undefined): boolean => Boolean(p && p.status === 'd' && p.chance !== 0);

/** The FPL record for each name ESPN uses, matched the way the club report matches them. */
const fplByEspnName = (r: LiveClubReport): Map<string, FplPlayer> => {
  const espnNames = [...new Set(r.lineups.flatMap((l) => [...l.starters.map((s) => s.name), ...l.subsUsed]))];
  const map = new Map<string, FplPlayer>();
  for (const p of r.fplPlayers ?? []) map.set(commonName(p, espnNames), p);
  return map;
};

/** The formation used most in the recent XIs; ties go to the most recent. */
const mainFormation = (lineups: LiveLineup[]): string | null => {
  const counts = new Map<string, number>();
  for (const l of lineups) if (l.formation) counts.set(l.formation, (counts.get(l.formation) ?? 0) + 1);
  let best: string | null = null;
  for (const l of lineups) if (l.formation && (best === null || counts.get(l.formation)! > counts.get(best)!)) best = l.formation;
  return best;
};

const sortBackToFront = (slots: XiSlot[]): XiSlot[] =>
  [...slots].sort((a, b) => roleRow(a.role) - roleRow(b.role) || roleCol(a.role) - roleCol(b.role));

/** Domestic cups, where clubs rotate; European competitions count in full. */
export const isDomesticCup = (competition: string): boolean =>
  /\b(cup|copa|coppa|pokal|coupe|ta[cç]a|beker|trophy|shield)\b/i.test(competition) && !/champions|europa|conference/i.test(competition);

/**
 * The first-choice XI from recent lineups: the main formation's slots, each filled by the
 * available player who started there most, recent matches counting a little more and domestic
 * cup matches half, season starts breaking ties. A player who is out never fills a slot. Another
 * player who started in the same slot in league and European matches at least twice and as often
 * as the first choice is named as an even split, each such player once. Anything less is not a
 * split, so the writer commits to one name.
 */
export function firstChoiceXI(r: LiveClubReport): { xi: XiSlot[]; formation: string | null; basis: ClubCore['xiBasis'] } {
  const fpl = fplByEspnName(r);
  const lineups = r.lineups;
  if (lineups.length === 0) return seasonStartsXI(r);

  const formation = mainFormation(lineups);
  const template = lineups.find((l) => l.formation === formation) ?? lineups[0];
  // Weighted starts per player and slot: the most recent match counts 1.25, the oldest 1.
  const exact = new Map<string, Map<string, number>>();
  const raw = new Map<string, Map<string, number>>();
  // Rotation is judged on league and European matches, unless every recent match was a cup tie.
  const firstTeam = new Map<string, Map<string, number>>();
  const allCups = lineups.every((l) => isDomesticCup(l.match.competition));
  lineups.forEach((l, k) => {
    const cup = isDomesticCup(l.match.competition);
    const weight = (1 + (lineups.length > 1 ? (0.25 * (lineups.length - 1 - k)) / (lineups.length - 1) : 0)) * (cup ? 0.5 : 1);
    for (const s of l.starters) {
      const bump = (map: Map<string, Map<string, number>>, by: number) => {
        const m = map.get(s.name) ?? new Map<string, number>();
        m.set(s.role, (m.get(s.role) ?? 0) + by);
        map.set(s.name, m);
      };
      bump(exact, weight);
      bump(raw, 1);
      if (!cup || allCups) bump(firstTeam, 1);
    }
  });
  const inRow = (counts: Map<string, number> | undefined, role: string): number =>
    [...(counts ?? new Map<string, number>()).entries()].filter(([r]) => roleRow(r) === roleRow(role)).reduce((sum, [, n]) => sum + n, 0);

  const slots = template.starters.map((s) => s.role);
  const pairs: { slot: number; name: string; score: number }[] = [];
  for (const [name, counts] of exact) {
    if (isOut(fpl.get(name))) continue;
    slots.forEach((role, slot) => {
      const sameRow = inRow(counts, role);
      if (sameRow === 0) return;
      // Season starts settle near ties; a recent start in the slot outweighs about three of them.
      const score = 3 * (counts.get(role) ?? 0) + sameRow + (fpl.get(name)?.starts ?? 0) / 10;
      pairs.push({ slot, name, score });
    });
  }
  pairs.sort((a, b) => b.score - a.score);
  const chosen = new Map<number, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (chosen.has(p.slot) || used.has(p.name)) continue;
    chosen.set(p.slot, p.name);
    used.add(p.name);
  }

  const named = new Set<string>();
  const xi = slots.map((role, slot): XiSlot => {
    const name = chosen.get(slot) ?? null;
    const occupant = template.starters[slot].name;
    const notes: string[] = [];
    if (occupant !== name && isOut(fpl.get(occupant))) notes.push(`${occupant}, who started here last, is out`);
    if (name && isDoubtful(fpl.get(name))) notes.push(`doubtful: ${absenceNote(fpl.get(name)!)}`);
    const starts = name ? inRow(raw.get(name), role) : 0;
    const mine = name ? firstTeam.get(name)?.get(role) ?? 0 : 0;
    const rival = name
      ? [...firstTeam.entries()]
          .filter(([other]) => other !== name && !used.has(other) && !named.has(other) && !isOut(fpl.get(other)))
          .map(([other, counts]) => ({ other, n: counts.get(role) ?? 0 }))
          .filter(({ n }) => n >= 2 && n >= mine)
          .sort((a, b) => b.n - a.n)[0]
      : undefined;
    if (rival) named.add(rival.other);
    return {
      role,
      name,
      starts,
      ...(rival ? { rotation: rival.other } : {}),
      ...(notes.length ? { note: notes.join('; ') } : {}),
    };
  });
  return { xi: sortBackToFront(xi), formation, basis: 'lineups' };
}

/** With no lineups, a Premier League club's XI from season starts: a goalkeeper and ten outfielders. */
function seasonStartsXI(r: LiveClubReport): { xi: XiSlot[]; formation: string | null; basis: ClubCore['xiBasis'] } {
  const pool = (r.fplPlayers ?? []).filter((p) => p.starts > 0 && !isOut(p)).sort((a, b) => b.starts - a.starts || b.minutes - a.minutes);
  if (pool.length === 0) return { xi: [], formation: null, basis: 'none' };
  const keeper = pool.find((p) => p.position === 'Goalkeeper');
  const outfield = pool.filter((p) => p.position !== 'Goalkeeper').slice(0, 10);
  const broad: Record<string, string> = { Goalkeeper: 'GK', Defender: 'D', Midfielder: 'M', Forward: 'F' };
  const xi = [...(keeper ? [keeper] : []), ...outfield].map((p) => ({ role: broad[p.position] ?? 'M', name: p.fullName, starts: p.starts }));
  return { xi: sortBackToFront(xi), formation: null, basis: 'season_starts' };
}

const outcome = (goalsFor: number | null, goalsAgainst: number | null): string =>
  goalsFor === null || goalsAgainst === null ? '?' : goalsFor > goalsAgainst ? 'W' : goalsFor < goalsAgainst ? 'L' : 'D';

/** What the feeds settle about a club, with no model involved. */
export function deriveClubCore(r: LiveClubReport): ClubCore {
  const { xi, formation, basis } = firstChoiceXI(r);
  const espnNames = [...new Set(r.lineups.flatMap((l) => [...l.starters.map((s) => s.name), ...l.subsUsed]))];
  const out = (r.fplPlayers ?? [])
    .filter((p) => ['i', 's', 'd', 'n'].includes(p.status))
    .map((p) => ({ name: commonName(p, espnNames), note: absenceNote(p) }));
  const results = r.results.slice(0, 5);
  return {
    club: r.team,
    league: r.league,
    asOf: r.asOf,
    formation,
    matchesRead: basis === 'lineups' ? r.lineups.length : 0,
    xi,
    xiBasis: basis,
    out,
    outCovered: r.fplPlayers !== null,
    form: results.map((m) => `${m.date} ${m.competition}: ${describeMatch(m)}`),
    record: results.map((m) => outcome(m.goalsFor, m.goalsAgainst)).join(''),
    nextFixture: r.fixtures[0] ? `${r.fixtures[0].date} ${r.fixtures[0].competition}: ${describeMatch(r.fixtures[0])}` : null,
  };
}

/**
 * A story read from the evidence, laid over a core from the feeds. A news absence for a player the
 * XI includes goes on his slot, so the writer sees the conflict instead of two silent versions.
 */
export function applyStory(core: ClubCore, story: ClubStory | null | undefined): ClubSituation {
  if (!story) return core;
  const newsAbsences = core.outCovered ? [] : story.newsAbsences;
  const xi = core.xi.map((slot) => {
    const reported = slot.name ? newsAbsences.find((a) => nameScore(a.name, [slot.name!]) >= 2 || nameScore(slot.name!, [a.name]) >= 2) : undefined;
    return reported ? { ...slot, note: [slot.note, `news reports him out: ${reported.note}`].filter(Boolean).join('; ') } : slot;
  });
  return { ...core, xi, changes: story.changes, distinctive: story.distinctive, newsAbsences, unknowns: story.unknowns };
}

// ---------------------------------------------------------------------------------------------
// Formatting for the writer

const slotText = (s: XiSlot, matchesRead: number): string => {
  if (!s.name) return `${s.role} unknown${s.note ? ` (${s.note})` : ''}`;
  const extras = [
    matchesRead > 0 ? `${s.starts}/${matchesRead}` : `${s.starts} starts`,
    ...(s.rotation ? [`even split with ${s.rotation}`] : []),
    ...(s.note ? [s.note] : []),
  ];
  return `${s.role} ${s.name} (${extras.join(', ')})`;
};

export function formatClubSituation(c: ClubSituation): string {
  const lines = [`${c.club} (${c.league}), as of ${c.asOf}:`];
  if (c.xi.length) {
    const basis =
      c.xiBasis === 'lineups'
        ? `${c.formation ?? 'main shape'}, from the last ${c.matchesRead} starting XIs`
        : 'from Premier League season starts; no recent lineups';
    lines.push(`- First-choice XI (${basis}): ${c.xi.map((s) => slotText(s, c.matchesRead)).join(' | ')}`);
  } else {
    lines.push('- First-choice XI: unknown (no recent lineups or season starts)');
  }
  if (c.outCovered) {
    lines.push(`- Out or doubtful (injury list): ${c.out.length ? c.out.map((o) => `${o.name} (${o.note})`).join('; ') : 'nobody listed'}`);
  } else {
    lines.push(
      `- Out: no injury list covers this club${c.newsAbsences?.length ? `; news reports: ${c.newsAbsences.map((o) => `${o.name} (${o.note})`).join('; ')}` : ''}`,
    );
  }
  if (c.form.length) lines.push(`- Form, most recent first (${c.record}): ${c.form.join('; ')}`);
  if (c.nextFixture) lines.push(`- Next: ${c.nextFixture}`);
  if (c.changes?.length) lines.push(`- Changed since last season: ${c.changes.join('; ')}`);
  if (c.distinctive) lines.push(`- Distinctive this season: ${c.distinctive}`);
  if (c.unknowns?.length) lines.push(`- Still unknown: ${c.unknowns.join('; ')}`);
  return lines.join('\n');
}

/** The snapshot as the writer reads it; empty when there's nothing to say. */
export function formatSituation(s: Situation | null | undefined): string {
  if (!s || (s.clubs.length === 0 && s.players.length === 0)) return '';
  const blocks = [
    ...s.clubs.map(formatClubSituation),
    ...s.players.map(
      (p) =>
        `${p.name}: ${[p.club && `club ${p.club}`, p.role && `role ${p.role}`, p.form && `form ${p.form}`, p.status && `status ${p.status}`, p.changes && `changed since last season: ${p.changes}`]
          .filter(Boolean)
          .join('; ')}`,
    ),
    ...(s.unknowns.length ? [`Still unknown: ${s.unknowns.join('; ')}`] : []),
  ];
  return `<situation_snapshot>
The present as of ${s.asOf}, worked out from the evidence below. Argue from it: name the first-choice player for each role it lists, mention another player only where it marks an even split and then as the alternative rather than a joint holder, and treat anyone out as unavailable.
${blocks.join('\n\n')}
</situation_snapshot>`;
}

// ---------------------------------------------------------------------------------------------
// The model's part

export interface SituationInput {
  today: string;
  season: string;
  /** What the brief says is distinctive or changed this season, for research to settle. */
  focus: string;
  question: string;
  /** Clubs whose story is needed, as their cores. */
  clubs: ClubCore[];
  /** Players the answer is about. */
  players: string[];
  /** The evidence, shortened, with each web source's dates tagged. */
  evidence: string;
}

export interface SituationEnrichment {
  clubs: ({ club: string } & ClubStory)[];
  players: PlayerSituation[];
  unknowns: string[];
}

export const SITUATION_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    clubs: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          club: { type: Type.STRING },
          changes: { type: Type.ARRAY, items: { type: Type.STRING } },
          distinctive: { type: Type.STRING },
          newsAbsences: {
            type: Type.ARRAY,
            items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, note: { type: Type.STRING } }, required: ['name', 'note'] },
          },
          unknowns: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['club', 'changes', 'distinctive', 'newsAbsences', 'unknowns'],
      },
    },
    players: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          club: { type: Type.STRING },
          role: { type: Type.STRING },
          form: { type: Type.STRING },
          status: { type: Type.STRING },
          changes: { type: Type.STRING },
        },
        required: ['name', 'club', 'role', 'form', 'status', 'changes'],
      },
    },
    unknowns: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['clubs', 'players', 'unknowns'],
};

export const buildSituationPrompt = (input: SituationInput): string => `You are writing the situation snapshot a football analyst will argue from: a compact, dated picture of the present. Today is ${input.today}, in the ${input.season} season.

The live feeds (club data, player season records, tables) describe the present and win any disagreement. Web sources carry publication dates; one from before this season describes an earlier team, so ignore anything in it the feeds contradict and use it only for what has changed since. State nothing the evidence doesn't support, and don't fill gaps from memory.

${input.clubs.length ? `For each club below, the first-choice XI, absences and form are already worked out from the feeds. Add:
- changes: what is different from last season, each with its date when the evidence gives one: arrivals and departures, a new coach, a new shape, players in new roles, a change in results.
- distinctive: one or two sentences on what is distinctive about the team this season and the likely reason, as the evidence shows it.
- newsAbsences: only for a club the feeds give no injury list for, players that recent news (within the last few weeks) reports as out, each with the reason and the report's date.
- unknowns: what the question needs about this club that the evidence doesn't settle, in a few words each.

${input.clubs.map((c) => `Club: ${c.club}\nFirst-choice XI: ${c.xi.map((s) => `${s.role} ${s.name ?? 'unknown'}`).join(', ') || 'unknown'}\nRecord, most recent first: ${c.record || 'unknown'}`).join('\n\n')}
` : 'There are no clubs to describe; return an empty clubs list.\n'}
${input.players.length ? `For each of these players, give his current club, his role this season, his recent form and minutes, his fitness status, and what has changed for him since last season, each from the evidence; leave a field empty when the evidence doesn't say: ${input.players.join(', ')}\n` : 'There are no players to describe; return an empty players list.\n'}
Under unknowns, list anything else the question needs that the evidence leaves open.

What the answer should settle: ${input.focus || input.question}
The question: ${input.question}

Evidence:
${input.evidence}`;

// Bounded lengths keep a stored snapshot small and inside what a database guard on club_snapshots would accept.
const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 300)).slice(0, max) : [];
const text = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 600) : '');

/** The model's answer, cleaned: known shapes only, lists capped, blank fields dropped. */
export function sanitizeEnrichment(raw: any): SituationEnrichment {
  const clubs = (Array.isArray(raw?.clubs) ? raw.clubs : [])
    .filter((c: any) => text(c?.club))
    .map((c: any) => ({
      club: text(c.club),
      changes: strings(c.changes, 6),
      distinctive: text(c.distinctive),
      newsAbsences: (Array.isArray(c.newsAbsences) ? c.newsAbsences : [])
        .filter((a: any) => text(a?.name))
        .map((a: any) => ({ name: text(a.name), note: text(a.note) || 'reported out' }))
        .slice(0, 8),
      unknowns: strings(c.unknowns, 4),
    }));
  const players = (Array.isArray(raw?.players) ? raw.players : [])
    .filter((p: any) => text(p?.name))
    .map((p: any) => ({ name: text(p.name), club: text(p.club), role: text(p.role), form: text(p.form), status: text(p.status), changes: text(p.changes) }))
    .slice(0, 4);
  return { clubs, players, unknowns: strings(raw?.unknowns, 5) };
}

export interface SituationModel {
  enrich(input: SituationInput): Promise<SituationEnrichment>;
}

export const liveSituationModel: SituationModel = {
  async enrich(input) {
    const raw = await generateStructured<any>({
      task: 'routing',
      prompt: buildSituationPrompt(input),
      schema: SITUATION_SCHEMA,
      thinkingLevelOverride: 'low',
      temperatureOverride: 0.2,
    });
    return sanitizeEnrichment(raw);
  },
};

/** Whether two club names mean the same club, allowing short forms ("Spurs", "Tottenham Hotspur"). */
export const sameClubName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase() || nameScore(a, [b]) >= 2 || nameScore(b, [a]) >= 2;

/** Each club's core from the club entries in the ledger, one per club. */
export function coresFromLedger(ledger: EvidenceLedger): ClubCore[] {
  const cores: ClubCore[] = [];
  for (const e of ledger.entries) {
    if (!e.club || cores.some((c) => sameClubName(c.club, e.club!.team))) continue;
    cores.push(deriveClubCore(e.club));
  }
  return cores;
}

/**
 * The present as the feeds settle it, in a few lines, for analysis searches to read their sources
 * against: each club's regular starters, who's out and recent results, and players' season lines.
 */
export function formatFactContext(cores: ClubCore[], playerLines: string[] = [], maxChars = 1500): string {
  const lines = [
    ...cores.map((c) => {
      const regulars = c.xi.filter((s) => s.name).map((s) => s.name).join(', ');
      return `${c.club}, as of ${c.asOf}: ${regulars ? `regular starters ${regulars}` : 'starters unknown'}${c.formation ? ` (${c.formation})` : ''}${
        c.out.length ? `; out: ${c.out.map((o) => o.name).join(', ')}` : ''
      }${c.record ? `; last results ${c.record}` : ''}.`;
    }),
    ...playerLines,
  ];
  const joined = lines.join('\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}

/**
 * The turn's snapshot. Clubs with a stored snapshot take its story over the core the live data
 * gives now; clubs without one, and the players the answer is about, are filled in by one quick
 * model call when `allowModel` is set. Without it, or if the call fails, the snapshot is what code
 * worked out on its own.
 */
export async function buildSituation(args: {
  ledger: EvidenceLedger;
  stored: ClubSnapshot[];
  players: string[];
  question: string;
  focus: string;
  today: string;
  season: string;
  seasonStart: string;
  allowModel: boolean;
  model: SituationModel;
}): Promise<{ situation: Situation; usedModel: boolean }> {
  const cores = coresFromLedger(args.ledger);
  const storyFor = (club: string) => args.stored.find((s) => sameClubName(s.club, club))?.story;
  // A stored snapshot whose club has no live core this turn still counts, on its own core.
  const storedOnly = args.stored.filter((s) => !cores.some((c) => sameClubName(c.club, s.club)));
  const needStory = cores.filter((c) => !storyFor(c.club));
  const players = [...new Set(args.players)].slice(0, 3);

  let enrichment: SituationEnrichment | null = null;
  if (args.allowModel && (needStory.length > 0 || players.length > 0)) {
    try {
      enrichment = await args.model.enrich({
        today: args.today,
        season: args.season,
        focus: args.focus,
        question: args.question,
        clubs: needStory,
        players,
        evidence: compactLedger(args.ledger, { perEntry: 1400, seasonStart: args.seasonStart }),
      });
    } catch (e) {
      console.warn('[Situation] Snapshot call failed, using what code worked out:', e);
    }
  }
  const enrichedStory = (club: string): ClubStory | undefined => {
    const hit = enrichment?.clubs.find((c) => sameClubName(c.club, club));
    return hit ? { changes: hit.changes, distinctive: hit.distinctive, newsAbsences: hit.newsAbsences, unknowns: hit.unknowns } : undefined;
  };
  return {
    situation: {
      asOf: args.today,
      clubs: [...cores.map((c) => applyStory(c, storyFor(c.club) ?? enrichedStory(c.club))), ...storedOnly.map((s) => applyStory(s.core, s.story))],
      players: enrichment?.players ?? [],
      unknowns: enrichment?.unknowns ?? [],
    },
    usedModel: enrichment !== null,
  };
}
