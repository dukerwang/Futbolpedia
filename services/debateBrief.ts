import { Type } from '@google/genai';
import { generateStructured, getCurrentSeasonInfo } from './aiClient';
import {
  cardsSettle,
  checkOrderAgainstCards,
  checkVerdictAgainstCards,
  DEBATE_CRITERIA,
  describeStanding,
  formatCardOrder,
  matchStanding,
  type CardStanding,
  type DebateCriterion,
} from './debateConsistency';
import {
  cardFingerprint,
  debateSignature,
  ERA_SNAPSHOT_VERSION,
  eraEntry,
  type DebateStore,
  type EraKind,
  type EraSnapshot,
  type EraSnapshotSource,
} from './eraSnapshots';
import { addEvidence, emptyLedger, type EvidenceLedger } from './evidenceLedger';
import {
  executeCall,
  fileOutcomes,
  HISTORY_COVERAGE_NOTE,
  RESEARCH_TOOL_GUIDE,
  sanitizeCalls,
  type ResearchCall,
  type ResearchToolset,
  type ToolOutcome,
} from './researchTools';

/**
 * Research for a question about the past: a past season, a prime, an era, an all-time comparison
 * or ranking. It's the counterpart of the brief in `researchAgent.ts` for the present:
 *
 * 1. Debate brief: one call works out what the question turns on (peak level, sustained level,
 *    output, influence, versatility), the criteria that settle it, the versions being compared
 *    (the windows on their cards), where the honest disagreement lies and the strongest case
 *    against the likely verdict. It proposes the verdict or order, and plans lookups only for the
 *    facts the verdict depends on.
 * 2. Card check: when the question turns on how good the players were, code holds the proposed
 *    verdict or order to the stored cards' ratings and peer placements (`debateConsistency.ts`).
 * 3. Facts: the lookups run in parallel (season and career records, cards, the odd search), with
 *    each season's or window's stored era snapshot; a missing snapshot is built in the background
 *    for the next person who asks.
 *
 * A debate's checked brief is stored (`eraSnapshots.ts`), so the same question asked again, with
 * the same cards in play, gets the same verdict without another brief call.
 */

export type DebateKind = 'head_to_head' | 'ranking' | 'single' | 'other';

export interface DebateBrief {
  /** What the user wants settled, read in the light of the conversation. */
  understanding: string;
  kind: DebateKind;
  /** What the question turns on. */
  criterion: DebateCriterion;
  /** The criteria that settle it, most important first, each with why it matters here. */
  criteria: { name: string; why: string }[];
  /** The versions being compared: a player's window, a club's season. */
  versions: { subject: string; period: string }[];
  /** Where reasonable people disagree, and why. */
  disagreement: string;
  /** The strongest case against the verdict, for the writer to answer. */
  counterCase: string;
  /** The side that wins a head-to-head, or the answer to a single question; empty for a ranking. */
  verdict: string;
  /** The order of a ranking, best first; empty otherwise. */
  ranking: string[];
  outline: string[];
  calls: ResearchCall[];
  /** What the card check changed, for the writer to state plainly. */
  cardNotes: string[];
  /** Whether this brief was reused from a settled debate. */
  settled?: boolean;
}

export interface DebateContext {
  message: string;
  /** The recent conversation, as the writer sees it; empty on a new chat. */
  thread: string;
  /** The stored cards in play, one per player, in the turn's edition. */
  cards: CardStanding[];
  hints: { clubs: string[]; players: string[] };
  /** A past season the message names, from the router. */
  season?: string | null;
  /** The brief is being written before the cards are known; code holds it to them afterwards. */
  cardsPending?: boolean;
}

/** Lookups the brief may plan, and how many era snapshots one turn may start building. */
export const DEBATE_CALL_LIMIT = 6;
export const MAX_ERA_BUILDS = 3;
/** How long a turn waits for a stored settled debate before writing its own brief. */
export const SETTLED_PEEK_MS = 600;
/** How long, once the facts are in, a turn waits for stored era snapshots. */
export const ERA_PEEK_MS = 400;

const KINDS: DebateKind[] = ['head_to_head', 'ranking', 'single', 'other'];

const BRIEF_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    understanding: { type: Type.STRING },
    kind: { type: Type.STRING, enum: KINDS },
    criterion: { type: Type.STRING, enum: [...DEBATE_CRITERIA] },
    criteria: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, why: { type: Type.STRING } }, required: ['name', 'why'] },
    },
    versions: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { subject: { type: Type.STRING }, period: { type: Type.STRING } }, required: ['subject', 'period'] },
    },
    disagreement: { type: Type.STRING },
    counterCase: { type: Type.STRING },
    verdict: { type: Type.STRING },
    ranking: { type: Type.ARRAY, items: { type: Type.STRING } },
    calls: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          tool: { type: Type.STRING, enum: ['club_season', 'player_career', 'card', 'web_search'] },
          subject: { type: Type.STRING },
          season: { type: Type.STRING },
          edition: { type: Type.STRING, enum: ['current', 'prime'] },
          purpose: { type: Type.STRING },
        },
        required: ['tool', 'subject', 'purpose'],
      },
    },
  },
  required: ['understanding', 'kind', 'criterion', 'criteria', 'versions', 'disagreement', 'counterCase', 'verdict', 'ranking', 'calls'],
};

const placementText = (s: CardStanding): string => {
  const p = s.placement;
  if (!p) return '';
  const parts = [
    p.betterThan.length ? `better than ${p.betterThan.join(', ')}` : '',
    p.levelWith.length ? `level with ${p.levelWith.join(', ')}` : '',
    p.notAsGoodAs.length ? `not as good as ${p.notAsGoodAs.join(', ')}` : '',
  ].filter(Boolean);
  return parts.length ? `; judged ${parts.join('; ')}` : '';
};

export const buildDebateBriefPrompt = (ctx: DebateContext): string => {
  const { month, year } = getCurrentSeasonInfo();
  return `You are planning a football analyst's answer to a question about the past. Today is ${month} ${year}. Your memory of football history is broad, but it fails in particular ways: precise figures (a season's goals, appearances, points, trophies), which season or spell something happened in, and anecdotes that are retold more often than they are true. Plan so that the answer never depends on one of those without a source, and so that it argues from criteria rather than reputation.

Keep every field short: a sentence or two at most. Work out:
1. understanding: what the user wants settled, read in the light of the conversation.
2. kind: "head_to_head" for two sides compared, "ranking" for an order of several, "single" for one season, player or team examined, "other" for anything else.
3. criterion: what the question turns on. "peak_level" is how good a version was at its best; "sustained_level" is how long it held a high level; "output" is goals, assists and numbers; "influence" is its effect on results and on the team; "versatility" is range of roles; "mixed" when the question is how good overall and no one of these decides it. Read it from the words the user chose.
4. criteria: two to four criteria that settle this question, most important first, each with why it matters here. They should be things evidence can speak to.
5. versions: what is being compared, each with its period: a player's window (use the window on his card when he has one) or a club's season (YYYY-YY).
6. disagreement: where reasonable people disagree about this question and why, in a sentence or two.
7. counterCase: the strongest case against the verdict you propose, stated as its best advocate would put it.
8. verdict and ranking: for a head-to-head or single question, the verdict in a few words, starting with the winning side's name as it appears in versions; for a ranking, the order best first, one name per entry, and leave verdict empty. Commit to one. When the question turns on how good the players were, the stored cards below have already rated them: agree with their order, and where cards are level, let the criteria decide.
9. calls: lookups, at most ${DEBATE_CALL_LIMIT}, only for facts the verdict depends on: a season's record and personnel, a player's numbers and honours in the window being compared. Prefer club_season and player_career, which read stored records; use web_search only for an analytical point those can't give, and ask for contemporary accounts. Don't fetch cards that are already in play. A question the cards and a season's record already answer may need one or two calls.

Tools:
${RESEARCH_TOOL_GUIDE}

${HISTORY_COVERAGE_NOTE}

${
  ctx.cardsPending
    ? 'The stored cards in play are checked against your verdict separately.\n'
    : ctx.cards.length
    ? `Stored cards in play, in the order their ratings put them (each rates one version of the player across its window):
${formatCardOrder(ctx.cards)}
${ctx.cards.map((s) => (placementText(s) ? `- ${s.name}${placementText(s)}` : '')).filter(Boolean).join('\n')}
`
    : 'No stored cards are in play.\n'
}${ctx.season ? `Season named in the message: ${ctx.season}\n` : ''}${ctx.hints.clubs.length || ctx.hints.players.length ? `Names spotted in the message: ${[...ctx.hints.clubs, ...ctx.hints.players].join(', ')}\n` : ''}
${ctx.thread ? `${ctx.thread}\n` : ''}
<user_message>${ctx.message}</user_message>`;
};

const str = (v: unknown, max = 600): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A brief from the model's JSON, or from a stored settled debate, with everything checked. */
export function readDebateBrief(raw: any, ctx: Pick<DebateContext, 'message'>): DebateBrief {
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x: string) => x.trim()).slice(0, max) : []);
  return {
    understanding: str(raw?.understanding) || ctx.message,
    kind: KINDS.includes(raw?.kind) ? raw.kind : 'other',
    criterion: (DEBATE_CRITERIA as readonly string[]).includes(raw?.criterion) ? raw.criterion : 'mixed',
    criteria: Array.isArray(raw?.criteria)
      ? raw.criteria.filter((c: any) => str(c?.name)).map((c: any) => ({ name: str(c.name, 80), why: str(c.why, 300) })).slice(0, 4)
      : [],
    versions: Array.isArray(raw?.versions)
      ? raw.versions.filter((v: any) => str(v?.subject)).map((v: any) => ({ subject: str(v.subject, 120), period: str(v.period, 40) })).slice(0, 10)
      : [],
    disagreement: str(raw?.disagreement),
    counterCase: str(raw?.counterCase),
    verdict: str(raw?.verdict, 200),
    ranking: list(raw?.ranking, 15),
    outline: list(raw?.outline, 8),
    calls: sanitizeCalls(raw?.calls, DEBATE_CALL_LIMIT),
    cardNotes: list(raw?.cardNotes, 8),
  };
}

/** The brief held to the cards: a ranking reordered, a head-to-head verdict corrected, with notes. */
export function checkBriefAgainstCards(brief: DebateBrief, cards: CardStanding[]): DebateBrief {
  if (!cards.length || !cardsSettle(brief.criterion)) return brief;
  if (brief.kind === 'ranking' && brief.ranking.length > 1) {
    const check = checkOrderAgainstCards(brief.ranking, cards);
    if (!check.moves.length) return brief;
    return { ...brief, ranking: check.order, cardNotes: [...brief.cardNotes, ...check.moves.map((m) => `Moved ${m}.`)] };
  }
  if (brief.kind === 'head_to_head') {
    const sides = brief.versions.map((v) => v.subject).slice(0, 2);
    // The verdict names the winner first; match it on its opening words.
    const winner = sides.find((s) => matchStanding(s, cards) && brief.verdict.toLowerCase().includes(s.toLowerCase().split(' ').pop()!)) ?? brief.verdict;
    const check = checkVerdictAgainstCards(winner, sides, cards, brief.criterion);
    if (check.changed) return { ...brief, verdict: check.verdict, cardNotes: [...brief.cardNotes, check.note!] };
    if (check.note) return { ...brief, cardNotes: [...brief.cardNotes, check.note] };
  }
  return brief;
}

export interface DebateModel {
  writeBrief(ctx: DebateContext): Promise<DebateBrief>;
}

export const liveDebateModel: DebateModel = {
  async writeBrief(ctx) {
    const raw = await generateStructured<any>({
      task: 'routing',
      prompt: buildDebateBriefPrompt(ctx),
      schema: BRIEF_SCHEMA,
      // Medium thinking took about 15 s here, which put the first token well behind a card debate's
      // before this brief existed; the structure of the brief does most of the thinking.
      thinkingLevelOverride: 'low',
      temperatureOverride: 0,
    });
    return readDebateBrief(raw, ctx);
  },
};

/** Words that suggest a question about the past; the router decides, this only starts the brief early. */
const PAST_CUES =
  /\b(?:prime|peak|at (?:his|their) (?:best|peak)|all[- ]time|greatest|best ever|era|treble|invincibles|(?:19|20)\d0s|(?:19|20)\d{2}\s*[-/–]\s*\d{2,4}|19\d{2}|20(?:0\d|1\d|2[0-3]))\b/i;
const PRESENT_CUES = /\b(?:this season|right now|currently|at the moment|these days|so far|now)\b/i;
/** A rating request names a prime too, but it's rated, not debated. */
const RATING_REQUEST = /^\s*(?:please\s+)?(?:re-?rate|rate|scout|dossier)\b/i;
export const looksLikePastQuestion = (message: string): boolean =>
  PAST_CUES.test(message) && !PRESENT_CUES.test(message) && !RATING_REQUEST.test(message);

/**
 * Starts the debate brief before routing, for a new chat whose message looks like it's about the
 * past, so the routing and card lookups aren't on its critical path. It's written without the
 * cards; `runDebateResearch` holds it to them. A wrong guess costs one call, never time.
 */
export const startDebateBrief = (
  message: string,
  options: { model?: DebateModel; debates?: DebateStore | null } = {},
): Promise<DebateBrief | null> | null => {
  if (!looksLikePastQuestion(message)) return null;
  const model = options.model ?? liveDebateModel;
  return (async () => {
    // A question settled before needs no brief at all.
    if (options.debates && (await within(options.debates.settledAny(debateSignature(message)), SETTLED_PEEK_MS))) return null;
    return model.writeBrief({ message, thread: '', cards: [], hints: { clubs: [], players: [] }, cardsPending: true });
  })().catch(() => null);
};

/** Resolves to the promise's value, or null if it hasn't settled within `ms`. Never rejects. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });

/** The era a lookup is about: a club season, or a player across the window being compared. */
export function eraFor(call: ResearchCall, brief: DebateBrief, cards: CardStanding[]): { kind: EraKind; period: string } | null {
  if (call.tool === 'club_season' && call.season) return { kind: 'club_season', period: call.season };
  if (call.tool !== 'player_career') return null;
  // The window comes from the call, else the brief's version of that player, else his card.
  const surname = (name: string) => name.replace(/\(.*?\)/g, '').trim().toLowerCase().split(/\s+/).pop() ?? '';
  const version = brief.versions.find((v) => surname(v.subject) && surname(v.subject) === surname(call.subject));
  // A card's window comes first, so a snapshot covers the version the card rates.
  const period = call.season || matchStanding(call.subject, cards)?.period || version?.period || '';
  return /\d{4}/.test(period) ? { kind: 'player_window', period } : null;
}

export async function runDebateResearch(
  ctx: DebateContext,
  tools: ResearchToolset,
  options: {
    model?: DebateModel;
    eras?: EraSnapshotSource | null;
    debates?: DebateStore | null;
    /** A brief started before routing (`startDebateBrief`), used unless a settled one exists. */
    early?: Promise<DebateBrief | null> | null;
    onStage?: (label: string) => void;
    perf?: (label: string) => void;
  } = {},
): Promise<{ brief: DebateBrief; ledger: EvidenceLedger }> {
  const model = options.model ?? liveDebateModel;
  const eras = options.eras ?? null;
  const debates = options.debates ?? null;

  // A new question that has been settled before, with the same cards, keeps its verdict.
  const signature = debateSignature(ctx.message);
  const fingerprint = cardFingerprint(ctx.cards);
  const settled = !ctx.thread && debates && signature ? await within(debates.read(signature, fingerprint), SETTLED_PEEK_MS) : null;

  let brief: DebateBrief;
  if (settled) {
    brief = { ...readDebateBrief(settled.brief, ctx), settled: true };
    options.perf?.(`debate brief (settled ${settled.settledAt.slice(0, 10)}, ${brief.kind}, ${brief.calls.length} lookups)`);
  } else {
    options.onStage?.('Working out what settles the question...');
    const early = options.early && !ctx.thread ? await options.early.catch(() => null) : null;
    try {
      brief = checkBriefAgainstCards(early ?? (await model.writeBrief(ctx)), ctx.cards);
    } catch (e) {
      console.warn('[Research] Debate brief failed, writing from the cards:', e);
      brief = readDebateBrief({}, ctx);
    }
    options.perf?.(
      `debate brief (${early ? 'started early, ' : ''}${brief.kind}, ${brief.criterion}, ${brief.calls.length} lookups${brief.cardNotes.length ? `, ${brief.cardNotes.length} card notes` : ''})`,
    );
    if (!ctx.thread && debates && signature && (brief.verdict || brief.ranking.length)) {
      void debates.write({
        signature,
        cards: fingerprint,
        brief: { ...brief, settled: undefined },
        settledAt: new Date().toISOString(),
        version: ERA_SNAPSHOT_VERSION,
      });
    }
  }
  if (!brief.calls.length) return { brief, ledger: emptyLedger() };

  options.onStage?.(`Checking ${brief.calls.length} ${brief.calls.length === 1 ? 'record' : 'records'}...`);
  const runs = brief.calls.map((c) => executeCall(c, tools));
  // Each season or window looked up has a permanent snapshot: read it alongside, and start
  // building the ones nobody has built yet, for the next person who asks.
  let builds = 0;
  const eraRuns: Promise<EraSnapshot | null>[] = brief.calls.map((call, i) => {
    const era = eras ? eraFor(call, brief, ctx.cards) : null;
    if (!era) return Promise.resolve(null);
    const req = { kind: era.kind, subject: call.subject, period: era.period, facts: runs[i] };
    return eras!.stored(req).then((hit) => {
      if (!hit && builds < MAX_ERA_BUILDS) {
        builds += 1;
        void eras!.get(req);
      }
      return hit;
    });
  });
  const outcomes: ToolOutcome[] = await Promise.all(runs);
  let ledger = fileOutcomes(emptyLedger(), brief.calls, outcomes);
  const snapshots = (await Promise.all(eraRuns.map((r) => within(r, ERA_PEEK_MS)))).filter((s): s is EraSnapshot => s !== null);
  for (const s of snapshots) ledger = addEvidence(ledger, eraEntry(s));
  options.perf?.(
    `debate research (${ledger.entries.length} found, ${ledger.gaps.length} missing; ${snapshots.length} era snapshots, ${builds} building)`,
  );
  return { brief, ledger };
}

/** The brief as the writer reads it. */
export const formatDebateBriefForWriter = (brief: DebateBrief, cards: CardStanding[] = []): string => {
  const lines = [`What the user wants settled: ${brief.understanding}`, `What it turns on: ${brief.criterion.replace('_', ' ')}`];
  if (brief.criteria.length) lines.push(`The criteria that settle it, in order:\n${brief.criteria.map((c, i) => `${i + 1}. ${c.name}: ${c.why}`).join('\n')}`);
  if (brief.versions.length) lines.push(`The versions compared: ${brief.versions.map((v) => `${v.subject}${v.period ? ` (${v.period})` : ''}`).join('; ')}`);
  if (brief.disagreement) lines.push(`Where the honest disagreement lies: ${brief.disagreement}`);
  if (brief.counterCase) lines.push(`The strongest case against the verdict, to answer directly: ${brief.counterCase}`);
  if (brief.ranking.length) lines.push(`The order, settled before writing (keep it): ${brief.ranking.map((r, i) => `${i + 1}. ${r}`).join(' ')}`);
  else if (brief.verdict) lines.push(`The verdict, settled before writing (keep it): ${brief.verdict}`);
  if (brief.cardNotes.length) lines.push(`Held to the stored cards: ${brief.cardNotes.join(' ')}`);
  if (cards.length) lines.push(`The stored cards' order:\n${cards.map((s) => `- ${describeStanding(s)}`).join('\n')}`);
  if (brief.outline.length) lines.push(`Planned outline:\n${brief.outline.map((p) => `- ${p}`).join('\n')}`);
  return `<debate_brief>\n${lines.join('\n')}\n</debate_brief>`;
};
