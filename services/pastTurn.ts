import { Type, type FunctionDeclaration } from '@google/genai';
import type { PlayerProfile } from '../types';
import { disagreementsFromSwaps, reportCardDisagreements, type CardDisagreement } from './cardDisagreements';
import {
  checkCommitment,
  formatCardOrder,
  matchStanding,
  toStanding,
  type CardStanding,
  type Commitment,
  type CommitmentCheck,
} from './debateConsistency';
import {
  VERDICT_CRITERIA,
  cardSubjectKey,
  eraSubjectKey,
  memoryVerdictDb,
  normalizeScope,
  readSettledVerdicts,
  scopeFromMessage,
  subjectSet,
  supabaseVerdictDb,
  type RankingScope,
  type SettledVerdict,
  type VerdictDb,
} from './debateVerdicts';
import { getCardKey, isPrimeCard, parseRequestedSeason, toBasePlayerSlug } from './dossierCards';
import { supabase } from './dossierCache';
import { eraEntry, liveEraSnapshots, normalizePeriod, subjectFromTitle, type EraSnapshot, type EraSnapshotSource } from './eraSnapshots';
import type { EvidenceLedger } from './evidenceLedger';
import { executeCall, type ResearchCall, type ResearchToolset, type ToolOutcome } from './researchTools';
import { PRINCIPLE_SOURCES, principleInstructions } from '../prompts/chatPrompt';
import { CONTINUITY_REMINDER } from './chatContinuity';

/**
 * Questions about the past in the deep loop (`deepTurn.ts`), behind `DEEP_PAST`. The loop reads
 * what the debate brief used to settle in advance: the cards in play in their order, the stored
 * era snapshots of the versions compared, and the scout's settled verdicts on them. It decides its
 * own records, criteria, figures and verdict, and commits to the verdict with `commit_verdict`
 * before it writes, which tells it what the cards and the settled verdict say. Code changes
 * nothing it wrote: a pair it put against the cards goes to card review, and its commitment is
 * proposed to the server's settled-verdict store. Design:
 * docs/superpowers/specs/2026-11-18-past-questions-deep-design.md.
 *
 * Nothing here runs while `DEEP_PAST` is off.
 */

/** A past turn's budget: records return in about a second, and a search costs about ten. */
export const DEEP_PAST_BUDGET = { ms: 60_000, calls: 8, searches: 2, rounds: 5 };
/** Figures a commitment may name. */
export const MAX_COMMITTED_FIGURES = 4;
/** `commit_verdict` calls a turn may make. */
export const MAX_COMMITS = 2;
/** How long the first message waits for stored era snapshots and settled verdicts. */
export const PAST_CONTEXT_WAIT_MS = 1_500;
/** Era snapshots the first message reads: the cards' windows and one named season per club. */
const MAX_ERA_READS = 4;
/** Records the first message carries: the cards' players, other named players and a named season. */
export const MAX_FIRST_RECORDS = 4;

// ---------------------------------------------------------------------------------------------
// The tool

export const COMMIT_VERDICT_DECLARATION: FunctionDeclaration = {
  name: 'commit_verdict',
  description:
    'Records the judgment you are about to write (who was better, an order, or how good one version or side was) before you write it, and returns what the stored cards in play and the settled verdicts on these versions say about it. Call it once your research is done, in the same round as your last lookups or alone. It changes nothing you write. When the result says your judgment goes against the cards or a settled verdict, argue their order, or call again with departs set to the reason this turn gave you. Free: it costs no lookup or round.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      kind: { type: Type.STRING, enum: ['head_to_head', 'ranking', 'single'], description: 'Two sides compared, an order of several, or one version or side examined.' },
      criterion: {
        type: Type.STRING,
        enum: [...VERDICT_CRITERIA],
        description:
          'What the judgment turns on: level at its best, how long it held a high level, output, effect on results and the team, the biggest matches, range of roles, or a mix.',
      },
      sides: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'The versions compared, named as your answer names them, each with its window or season.' },
      verdict: { type: Type.STRING, description: 'For a head-to-head, the side that wins, named as in sides.' },
      order: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'For a ranking, the sides best first.' },
      scope: {
        type: Type.OBJECT,
        properties: {
          position: { type: Type.STRING, description: 'The position the ranking is about, or any.' },
          period: { type: Type.STRING, description: 'Its period: a decade such as 1990s, a span of seasons, or all-time.' },
        },
      },
      figures: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: `At most ${MAX_COMMITTED_FIGURES}: each precise figure that decides part of the judgment, described by what it counts, its competition and its span, without the number.`,
      },
      departs: { type: Type.STRING, description: 'Why the judgment goes against the cards or a settled verdict, from this turn\'s evidence. Leave it out otherwise.' },
    },
    required: ['kind', 'criterion', 'sides'],
  },
};

/** A commitment as the tool received it, with the parts the turn reads afterwards. */
export interface RecordedCommitment extends Commitment {
  criterion: (typeof VERDICT_CRITERIA)[number];
  scope: RankingScope | null;
  figures: string[];
  departs: string | null;
}

const str = (v: unknown, max = 160): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strs = (v: unknown, max: number, chars = 160): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, chars)).filter(Boolean).slice(0, max) : [];

/** A commitment from the model's arguments, or why it can't be one. */
export function readCommitment(args: Record<string, unknown>): RecordedCommitment | { error: string } {
  const kind = args.kind;
  if (kind !== 'head_to_head' && kind !== 'ranking' && kind !== 'single') return { error: 'kind must be head_to_head, ranking or single.' };
  const criterion = str(args.criterion).toLowerCase().replace(/[\s-]+/g, '_') as RecordedCommitment['criterion'];
  if (!(VERDICT_CRITERIA as readonly string[]).includes(criterion)) return { error: `criterion must be one of: ${VERDICT_CRITERIA.join(', ')}.` };
  const sides = strs(args.sides, 15);
  const order = strs(args.order, 15);
  const verdict = str(args.verdict);
  if (kind === 'head_to_head' && (sides.length !== 2 || !verdict)) return { error: 'A head-to-head names two sides and the one that wins.' };
  if (kind === 'ranking' && order.length < 2) return { error: 'A ranking gives at least two sides in order.' };
  if (!sides.length && !order.length) return { error: 'Name the sides.' };
  const scope = args.scope && typeof args.scope === 'object' ? normalizeScope(args.scope as { position?: unknown; period?: unknown }) : null;
  return {
    kind,
    criterion,
    sides: sides.length ? sides : order,
    ...(verdict ? { verdict } : {}),
    ...(order.length ? { order } : {}),
    scope,
    figures: strs(args.figures, MAX_COMMITTED_FIGURES, 200),
    departs: str(args.departs, 400) || null,
  };
}

// ---------------------------------------------------------------------------------------------
// Subjects: a side as the settled-verdict store keys it

/**
 * The store's key for a side: its card's, else a club season or a player's window that a record
 * read this turn resolved. Null when the side can't be resolved; nothing is proposed for it then.
 */
export function subjectKeyFor(side: string, standings: CardStanding[], ledger: EvidenceLedger | null): string | null {
  const st = matchStanding(side, standings);
  if (st?.cardKey) return `card:${st.cardKey}`;
  const season = parseRequestedSeason(side);
  const period = season && /-\d{2}$/.test(season) ? season : null;
  const words = side.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  const entries = ledger?.entries ?? [];
  if (period) {
    const record = entries.find((e) => e.kind === 'season_record' && e.label.includes(period.slice(0, 4)) && words.some((w) => e.label.toLowerCase().includes(w)));
    if (record) return eraSubjectKey('club_season', subjectFromTitle(record.label, 'club_season'), period);
  }
  const span = normalizePeriod(side);
  if (span) {
    const record = entries.find((e) => e.kind === 'career_record' && words.some((w) => e.label.toLowerCase().includes(w)));
    if (record) return eraSubjectKey('player_window', subjectFromTitle(record.label, 'player_window'), span);
  }
  return null;
}

/** The settle request a commitment proposes, or null when a side can't be keyed or a single verdict has no choice to store. */
export function proposalFor(c: RecordedCommitment, standings: CardStanding[], ledger: EvidenceLedger | null, message: string): Record<string, unknown> | null {
  if (c.kind === 'head_to_head') {
    const subjects = c.sides.map((s) => subjectKeyFor(s, standings, ledger));
    const winner = c.verdict ? subjectKeyFor(c.verdict, standings, ledger) : null;
    if (subjects.some((s) => !s) || !winner || !subjects.includes(winner) || subjects[0] === subjects[1]) return null;
    return { kind: c.kind, criterion: c.criterion, subjects, verdict: [winner] };
  }
  if (c.kind === 'ranking') {
    const order = (c.order ?? []).map((s) => subjectKeyFor(s, standings, ledger));
    const scope = c.scope ?? scopeFromMessage(message);
    if (order.some((s) => !s) || new Set(order).size !== order.length || !scope) return null;
    return { kind: c.kind, criterion: c.criterion, subjects: order, verdict: order, scope: { position: scope.position, period: scope.period } };
  }
  return null;
}

/** The settled verdict a commitment answers to: same kind, criterion and versions (or field). */
export function settledFor(c: RecordedCommitment, settled: SettledVerdict[], standings: CardStanding[], ledger: EvidenceLedger | null, message: string): SettledVerdict | null {
  const proposal = proposalFor(c, standings, ledger, message);
  if (!proposal) return null;
  const subjects = proposal.subjects as string[];
  return (
    settled.find(
      (v) =>
        v.kind === c.kind &&
        v.criterion === c.criterion &&
        (c.kind === 'ranking' ? v.key.endsWith(`scope:${(c.scope ?? scopeFromMessage(message))?.key}`) : subjectSet(v.subjects.map((s) => s.key)) === subjectSet(subjects)),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------------------------
// The tool's handler

export interface PastCommitState {
  /** The last commitment recorded. */
  commitment: RecordedCommitment | null;
  check: CommitmentCheck | null;
  /** How the commitment stood against a settled verdict on the same question. */
  settled: 'agree' | 'against' | 'none';
  settledKey: string | null;
  /** The commitment departs from the cards or a settled verdict, with or without a reason. */
  departed: boolean;
  /** It departed without giving a reason, even when asked. */
  departedSilently: boolean;
  calls: number;
}

export interface CommitToolDeps {
  /** The cards in play and any read this turn, at the time of the call. */
  standings(): CardStanding[];
  ledger(): EvidenceLedger | null;
  settled: SettledVerdict[];
  message: string;
  /** Where card pairs go; card review's channel by default. */
  report?: (pairs: CardDisagreement[]) => void;
}

export function createCommitTool(deps: CommitToolDeps) {
  const report = deps.report ?? reportCardDisagreements;
  const reported = new Set<string>();
  const state: PastCommitState = { commitment: null, check: null, settled: 'none', settledKey: null, departed: false, departedSilently: false, calls: 0 };
  const label = (keys: string[], v: SettledVerdict) => keys.map((k) => v.subjects.find((s) => s.key === k)?.label ?? k);

  return {
    state,
    handle(args: Record<string, unknown>): Record<string, unknown> {
      if (state.calls >= MAX_COMMITS) return { error: 'The judgment is already recorded: write the answer.' };
      const read = readCommitment(args);
      if ('error' in read) return { error: read.error };
      state.calls += 1;
      const standings = deps.standings();
      const check = checkCommitment(read, standings);
      const settled = settledFor(read, deps.settled, standings, deps.ledger(), deps.message);
      const proposal = proposalFor(read, standings, deps.ledger(), deps.message);
      const mine = (proposal?.verdict as string[] | undefined) ?? [];
      const settledAgainst = settled !== null && settled.status !== 'stale' && mine.join('|') !== settled.verdict.join('|');
      state.commitment = read;
      state.check = check;
      state.settled = settled ? (settledAgainst ? 'against' : 'agree') : 'none';
      state.settledKey = settled?.key ?? null;

      // Each pair the judgment put against the cards is evidence for card review, whatever the reply then argues.
      const fresh = disagreementsFromSwaps(check.swaps, 'deep').filter((p) => !reported.has(`${p.higher}>${p.lower}`));
      fresh.forEach((p) => reported.add(`${p.higher}>${p.lower}`));
      if (fresh.length) report(fresh);

      const against = check.cards === 'against' || settledAgainst;
      state.departed = against;
      const response: Record<string, unknown> = {
        recorded: true,
        cards: check.cards,
        ...(check.note ? { cardsSay: check.note } : {}),
        ...(check.cardOrder && check.cards === 'against' ? { cardsOrder: check.cardOrder } : {}),
        settledVerdict: settled ? (settledAgainst ? 'differs' : settled.status === 'stale' ? 'stale' : 'agrees') : 'none',
        ...(settled && settledAgainst
          ? { settledSays: `${settled.kind === 'ranking' ? `Order: ${label(settled.verdict, settled).join(', ')}` : `${label(settled.verdict, settled)[0]} wins`} (${settled.criterion.replace('_', ' ')}, settled ${settled.settledAt.slice(0, 10)}${settled.status === 'contested' ? ', contested' : ''}).` }
          : {}),
      };
      if (against && !read.departs) {
        if (state.calls < MAX_COMMITS) {
          response.next = 'Argue the order the cards or the settled verdict give, or call commit_verdict again with departs set to the reason this turn\'s evidence gives.';
        } else {
          state.departedSilently = true;
          response.next = 'Recorded as a departure without a reason. Write the answer.';
        }
      } else {
        response.next = 'Write the answer.';
      }
      return response;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The first message's blocks

/** What a card answers, for the block that lists them. */
const CARD_MEANING =
  'A card rates how good one version of a player was across its window, on one all-era standard. It measures nothing else: not output, longevity, influence or the biggest matches.';

const placementLine = (s: CardStanding): string => {
  const p = s.placement;
  if (!p) return '';
  const parts = [
    p.betterThan.length ? `better than ${p.betterThan.join(', ')}` : '',
    p.levelWith.length ? `level with ${p.levelWith.join(', ')}` : '',
    p.notAsGoodAs.length ? `not as good as ${p.notAsGoodAs.join(', ')}` : '',
  ].filter(Boolean);
  return parts.length ? `- ${s.name}: judged ${parts.join('; ')}` : '';
};

/** The cards in play, best first, with each one's placement. Empty with fewer than two. */
export function formatCardsInPlay(standings: CardStanding[]): string {
  if (standings.length < 2) return '';
  const placed = standings.map(placementLine).filter(Boolean);
  return `<cards_in_play>
${CARD_MEANING}
In the order their ratings put them:
${formatCardOrder(standings)}${placed.length ? `\nTheir placements against other cards:\n${placed.join('\n')}` : ''}
</cards_in_play>`;
}

/** The settled verdicts on the versions in play, for the first message. Empty when there are none. */
export function formatSettledVerdicts(settled: SettledVerdict[]): string {
  if (!settled.length) return '';
  const line = (v: SettledVerdict) => {
    const names = (keys: string[]) => keys.map((k) => v.subjects.find((s) => s.key === k)?.label ?? k);
    const what =
      v.kind === 'ranking'
        ? `order ${names(v.verdict).map((n, i) => `${i + 1}. ${n}`).join(' ')}`
        : `${names(v.verdict)[0]} over ${names(v.subjects.map((s) => s.key).filter((k) => k !== v.verdict[0])).join(', ')}`;
    const status = v.status === 'stale' ? `stale: ${v.staleBecause.join('; ')}` : v.status;
    return `- ${v.criterion.replace('_', ' ')}: ${what} (settled ${v.settledAt.slice(0, 10)}, ${status})${v.criteria.length ? `. Argued on: ${v.criteria.join('; ')}` : ''}${v.counterCase ? `. Against it: ${v.counterCase}` : ''}`;
  };
  return `<settled_verdicts>
${settled.map(line).join('\n')}
</settled_verdicts>`;
}

/** The cards in play as standings: one per card, in any edition, for the card order. */
export const standingsOf = (cards: PlayerProfile[]): CardStanding[] => {
  const seen = new Set<string>();
  const out: CardStanding[] = [];
  for (const c of cards) {
    if (!c?.basicInfo?.name) continue;
    const key = getCardKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toStanding(c));
  }
  return out;
};

/** Whether a present-day turn compares two or more carded versions, and so gets the card order and `commit_verdict`. */
export const comparesVersions = (cards: PlayerProfile[]): boolean => new Set(standingsOf(cards).map((s) => `${s.slug}:${s.edition}:${s.period ?? ''}`)).size >= 2;

// ---------------------------------------------------------------------------------------------
// Era snapshots and career records, before the first round

export interface PastContext {
  /**
   * The career and season records fetched before the first round, found ones only. They cost no
   * model call, and the first eval showed answers argued from style when the model skipped them.
   */
  records: { call: ResearchCall; outcome: ToolOutcome }[];
  snapshots: EraSnapshot[];
  /** When each era snapshot read was built, by key: for settled verdicts' staleness. */
  eraBuiltAt: Map<string, string>;
  settled: SettledVerdict[];
}

/**
 * Reads, without building, the era snapshots of the cards' windows and a named club season, and
 * the settled verdicts on the versions in play, and fetches the career and season records those
 * cover (and those of named players with no card), waiting at most `waitMs`. The records cost no
 * model call; those back in time go into the first message as evidence.
 */
export async function loadPastContext(args: {
  cards: PlayerProfile[];
  /** Players the turn names who have no card in play: their career records are fetched too. */
  players?: string[];
  clubs: string[];
  season: string | null;
  message: string;
  ranking: boolean;
  tools: ResearchToolset;
  eras?: EraSnapshotSource | null;
  verdicts?: VerdictDb | null;
  waitMs?: number;
}): Promise<PastContext> {
  const eras = args.eras === undefined ? liveEraSnapshots : args.eras;
  const wait = args.waitMs ?? PAST_CONTEXT_WAIT_MS;
  const within = <T>(p: Promise<T>, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p.catch(() => fallback), new Promise<T>((r) => (timer = setTimeout(() => r(fallback), wait)))]).finally(() => clearTimeout(timer));
  };
  const fetched: { call: ResearchCall; outcome: Promise<ToolOutcome> }[] = [];
  const fetch = (call: ResearchCall): Promise<ToolOutcome> => {
    const outcome = executeCall(call, args.tools);
    if (fetched.length < MAX_FIRST_RECORDS) fetched.push({ call, outcome });
    return outcome;
  };
  const requests: { kind: 'club_season' | 'player_window'; subject: string; period: string; facts: Promise<ToolOutcome> }[] = [];
  for (const c of args.cards.filter(isPrimeCard)) {
    const window = normalizePeriod(c.version?.seasonOrEra ?? '');
    if (window) requests.push({ kind: 'player_window', subject: c.basicInfo.name, period: window, facts: fetch({ tool: 'player_career', subject: c.basicInfo.name, stage: 'facts' }) });
  }
  const season = args.season && /-\d{2}$/.test(args.season) ? args.season : null;
  if (season) {
    for (const club of args.clubs.slice(0, 2)) {
      requests.push({ kind: 'club_season', subject: club, period: season, facts: fetch({ tool: 'club_season', subject: club, season, stage: 'facts' }) });
    }
  }
  const carded = new Set(args.cards.map((c) => toBasePlayerSlug(c.basicInfo.name)));
  for (const name of (args.players ?? []).filter((p) => !carded.has(toBasePlayerSlug(p)))) fetch({ tool: 'player_career', subject: name, stage: 'facts' });
  const reads = eras ? requests.slice(0, MAX_ERA_READS).map((r) => eras.stored(r).catch(() => null)) : [];
  const [snapshotsRead, outcomes] = await Promise.all([
    within(Promise.all(reads), [] as (EraSnapshot | null)[]),
    Promise.all(fetched.map((f) => within(f.outcome, null as ToolOutcome | null))),
  ]);
  const snapshots = snapshotsRead.filter((s): s is EraSnapshot => Boolean(s));
  const records = fetched.flatMap((f, i) => (outcomes[i]?.result ? [{ call: f.call, outcome: outcomes[i]! }] : []));
  const eraBuiltAt = new Map(snapshots.map((s) => [s.key, s.builtAt] as [string, string]));
  const db = args.verdicts === undefined ? defaultVerdictDb() : args.verdicts;
  const settled = db
    ? await within(
        readSettledVerdicts(
          { cards: args.cards, scope: args.ranking ? scopeFromMessage(args.message) : null },
          { db, eraBuiltAt: async (keys) => new Map([...eraBuiltAt].filter(([k]) => keys.includes(k))) },
        ),
        [] as SettledVerdict[],
      )
    : [];
  return { records, snapshots, eraBuiltAt, settled };
}

/** The browser's read of the settled-verdict table; nothing without a Supabase client. */
export const defaultVerdictDb = (): VerdictDb => (supabase ? supabaseVerdictDb(supabase) : memoryVerdictDb(false));

/** An era snapshot as an evidence entry, filed in the turn's ledger so the figure gate counts it. */
export const eraEvidence = eraEntry;

// ---------------------------------------------------------------------------------------------
// What is still unchecked, for the budget line

/**
 * The records a past turn hasn't read for its versions: each carded player's career record, unless
 * it was read or an era snapshot of his window is in evidence, and a named club season's record.
 */
export function pastUncheckedFor(args: { cards: PlayerProfile[]; clubs: string[]; season: string | null }, ledger: EvidenceLedger): string[] {
  const has = (kind: string, words: string[]) =>
    ledger.entries.some((e) => e.kind === kind && words.some((w) => w.length >= 4 && e.label.toLowerCase().includes(w)));
  const out: string[] = [];
  for (const c of args.cards) {
    if (!isPrimeCard(c)) continue;
    const words = toBasePlayerSlug(c.basicInfo.name).split('-');
    if (!has('career_record', words) && !has('era_snapshot', words)) out.push(`${c.basicInfo.name}'s career record`);
  }
  if (args.season) {
    for (const club of args.clubs.slice(0, 2)) {
      const words = club.toLowerCase().split(/[^a-z]+/);
      if (!has('season_record', words) && !has('era_snapshot', words)) out.push(`${club}'s ${args.season} season record`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// After the answer

export interface PastNetwork {
  /** Proposes a commitment to the settled-verdict store; the server decides. */
  settle(body: Record<string, unknown>): void;
  /** Records a departure from a stored settled verdict. */
  depart(key: string): void;
}

const post = (url: string, body: unknown) => {
  try {
    void Promise.resolve(
      globalThis.fetch?.(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }),
    ).catch(() => {});
  } catch {
    // Best effort.
  }
};

/** The app's routes: fire and forget. */
export const liveTurnNetwork: PastNetwork = {
  settle: (body) => post('/api/debates/settle', body),
  depart: (key) => post('/api/debates/departure', { key }),
};

/**
 * After a past answer: its commitment is proposed to the store, and a departure from a current
 * settled verdict is recorded. Card pairs were reported when the commitment was made.
 */
export function finishPastTurn(state: PastCommitState, standings: CardStanding[], ledger: EvidenceLedger | null, message: string, net: PastNetwork): void {
  const c = state.commitment;
  if (!c) return;
  const proposal = proposalFor(c, standings, ledger, message);
  if (proposal) net.settle(proposal);
  if (state.settled === 'against' && state.settledKey) net.depart(state.settledKey);
}

/**
 * The figure budget a past answer is held to: the figures its commitment named, with room for each
 * one's counterpart. An answer that named none (a question asking for a season's numbers, or a
 * judgment argued in words) has no budget: each figure is still held to the evidence by the scoped
 * gate, but none is cut for being one too many. The first eval capped those answers at six and cut
 * a season's numbers the question asked for.
 */
export const pastFigureBudget = (state: PastCommitState | null): { max: number; slots: string[] } | undefined => {
  const slots = state?.commitment?.figures ?? [];
  return slots.length ? { max: Math.max(2, slots.length * 2 + 1), slots } : undefined;
};

// ---------------------------------------------------------------------------------------------
// What the loop reads

/**
 * The system instruction's note for a question about the past: what to work out and which records
 * to read first. Added after the deep rules under either instruction set; it restates no chat
 * principle. Descriptive only: no players, ratings or sample phrases.
 */
export const PAST_RESEARCH_NOTE = `## A question about the past

This turn is about the past: past seasons, primes, eras or an all-time comparison. Work out what the question turns on, from the words the user chose: a version's level at its best, how long it held a high level, its output, its effect on results and the team, its record in the biggest matches, its range of roles, or a mix. Decide the two to four things that would settle it, and read first the season and career records and the stored era snapshots those things need. A web search is for an analytical point the records can't give, and asks for contemporary accounts. Before committing, know the strongest case against your answer. Today's coaches and the live feeds don't bear on the past; use them only for a comparison with today.`;

/**
 * The note for a turn the cards anchor: past mode, or a present turn comparing carded versions.
 * It says when to commit and what the cards and settled verdicts are for.
 */
export const CARD_ANCHOR_NOTE = `## Judgments the cards speak to

Before writing a judgment of who was better, an order, or how good a version or side was, call commit_verdict with it. Where the judgment is how good the versions were (their level at their best, or a mix of everything), the cards in <cards_in_play> have already rated them: their order is where you start, and holding a different one needs a reason from this turn's evidence, given in the answer. Cards that are level don't decide between those versions; the criteria do. A ranking still puts each version ahead of the next on those criteria, and a head-to-head still names the side they favour, saying the cards have them level where that helps the reader. Leave two versions tied only when the criteria can't separate them either. On any other measure the cards are background to the records. <settled_verdicts>, when present, holds the scout's earlier answers on these versions: keep one unless this turn's evidence or the question gives a reason not to, give the reason when you depart, and mention it only when the user asks why or it bears on the answer.`;

/** How a past answer is written, under the instructions from before the principle set. */
export const PAST_LOOP_RULES =
  "First decide what the user's latest message actually asks, in the light of the conversation, and answer that. Write the way a knowledgeable person talks football with a friend: plain, warm, direct prose, never a formal debate. Where the user asked who was better, for an order, or how good a season or player was, give your answer early and plainly, and explain it through the things that decide it, using your tool results, <factual_foundation> and the stored cards. Give the other side its due in a sentence or two where it matters. Don't write labelled sections for criteria, a counter-case or a verdict; use headings only for a long answer that covers several players or seasons. Judge from evidence, never from reputation alone. Where the message questions your last answer, the cards or versions it used, or a fact, answer that point directly: check a disputed fact with a tool before conceding or holding firm, admit a mistake in a sentence where you made one, and stop when it's answered. Stay consistent with the ratings in <locked_dossiers> and <calibrated_peer_ledger>. Never output a JSON dossier object.";

/** What a past answer may state as fact, under the instructions from before the principle set. */
export const PAST_LOOP_FACT_RULES =
  "Quote a precise figure (goals, appearances, points, trophies, records, dates, fees) only where it decides part of the judgment, as you named it in commit_verdict, and only as a tool result, <factual_foundation> or a stored card gives it; make every other point in words. A quoted figure keeps the competition and span its source gives: a league figure stays a league figure, a total across all competitions stays a total, and a count for named seasons is never a career total. Keep every fact to the season or spell it belongs to, and name the season when a fact from outside the compared window matters. Don't repeat a claim that an era snapshot lists as often misstated, or an anecdote no source here supports. Name a past season's coach only as the evidence gives him; otherwise describe the side's setup without naming its coach.";

/** A past turn's `<instructions>`: its data line under the principle set, else the writing and fact rules. */
export function pastInstructions(args: { principles: boolean; notes: string }): string {
  if (args.principles) return principleInstructions([PRINCIPLE_SOURCES.deepPast, args.notes]);
  return `<instructions>
1. ${PAST_LOOP_RULES}${args.notes}
2. ${PAST_LOOP_FACT_RULES}
3. ${CONTINUITY_REMINDER}
</instructions>`;
}
