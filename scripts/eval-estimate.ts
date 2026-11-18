/**
 * The dry run for every eval set (`--dry-run`): calls, tokens, grounded searches and cost for the
 * live set, the historical set and the conversations, with `--grade`, `--figure-check`, `--repeat`
 * and the rest reflected. It makes no call and needs no key. Users never see any of this.
 *
 * The shape of an answer (lookups, searches and rounds) is read from the saved reports under
 * `docs/superpowers/evals/reports/`. A report written by the current runner also carries the tokens
 * each answer used (`usage`, counted from the model's usage metadata), and the estimate then uses
 * those in place of its modelled ones, so each run makes the next estimate better. Graders and
 * checks are always modelled: a report records their total, not each call.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSUMED_PRICES,
  CEILING_TURN,
  chatTurnComponent,
  estimateRun,
  EXPECTED_TURN,
  scale,
  TOKENS,
  totalOf,
  type Estimate,
  type EstimateComponent,
  type Prices,
  type PromptSizes,
  type TurnShape,
} from './eval-consistency';
import type { Usage } from './eval-guard';

// --- Saved reports ----------------------------------------------------------------------------

/** One answer as a saved report holds it: what it looked up, and what it cost when the report says. */
interface SavedAnswer {
  kind: 'live' | 'historical' | 'conversation';
  path?: string;
  lookups?: number;
  searches?: number;
  rounds?: number;
  gateRounds?: number;
  past?: boolean;
  usage?: Usage;
}

/** One answer's cost in a saved report, averaged. */
export interface MeasuredTurn {
  answers: number;
  calls: number;
  inputTokens: number;
  /** Output and thinking tokens together: both bill as output. */
  outputTokens: number;
  searches: number;
}

export interface ReportBaseline {
  /** An average chat loop turn on the live set. */
  chat: TurnShape;
  /** An average past-mode turn on the historical set (the chat loop with `--past-mode`). */
  past: TurnShape;
  measured: { chat: MeasuredTurn | null; past: MeasuredTurn | null; stage: MeasuredTurn | null };
  /** Answers the shapes were averaged over, and the reports they came from. */
  basis: { chat: number; past: number; reports: number; measuredAnswers: number };
}

/** Past mode's own budget (`PAST_BUDGET` in `services/pastTurn.ts`): 8 lookups, 2 searches, 5 rounds. */
export const PAST_CEILING_TURN: TurnShape = { rounds: 5, lookups: 8, searches: 2, gateRounds: 1 };
/** What a past-mode turn looks like when no report says: the 2026-11-18 run's mean. */
export const DEFAULT_PAST_TURN: TurnShape = { rounds: 1, lookups: 1.8, searches: 0.2, gateRounds: 0.3 };

const isChatPath = (p: string | undefined) => p === 'chat' || p === 'deep';

/** Every answer in a saved report's JSON, whichever runner wrote it. */
export function answersIn(json: any): SavedAnswer[] {
  const one = (kind: SavedAnswer['kind'], run: any): SavedAnswer | null => {
    if (!run || typeof run !== 'object') return null;
    const r = run.research;
    return {
      kind,
      ...(r ? { path: r.path, lookups: r.lookups, searches: r.searches, rounds: r.rounds, past: !!r.past, ...(r.gateFeedback ? { gateRounds: r.gateFeedback.flagged > 0 ? 1 : 0 } : {}) } : {}),
      ...(run.usage ? { usage: run.usage } : {}),
    };
  };
  const out: (SavedAnswer | null)[] = [];
  const list: any[] | null = Array.isArray(json) ? json : Array.isArray(json?.results) ? json.results : Array.isArray(json?.runs) ? json.runs : null;
  if (!list) return [];
  const historical = !!json && !Array.isArray(json) && Array.isArray(json.repeats);
  for (const entry of list) {
    if (Array.isArray(entry?.turns)) {
      for (const t of entry.turns) out.push(one('conversation', t?.run));
    } else {
      out.push(one(historical ? 'historical' : 'live', entry?.run));
    }
  }
  return out.filter((x): x is SavedAnswer => !!x);
}

const mean = (xs: number[], fallback: number) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback);

function measuredOf(answers: SavedAnswer[]): MeasuredTurn | null {
  const withUsage = answers.filter((a) => a.usage && a.usage.calls > 0);
  if (!withUsage.length) return null;
  const avg = (f: (u: Usage) => number) => mean(withUsage.map((a) => f(a.usage!)), 0);
  return {
    answers: withUsage.length,
    calls: avg((u) => u.calls),
    inputTokens: avg((u) => u.inputTokens),
    outputTokens: avg((u) => u.outputTokens + u.thinkingTokens),
    searches: avg((u) => u.searches),
  };
}

/** The shapes and measured costs the saved reports in `dir` give; the modelled defaults for what they don't hold. */
export function readReportBaseline(dir: string): ReportBaseline {
  const answers: SavedAnswer[] = [];
  let reports = 0;
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        answers.push(...answersIn(JSON.parse(readFileSync(join(dir, file), 'utf8'))));
        reports++;
      } catch {
        // A report that doesn't parse is left out.
      }
    }
  }
  const shapeOf = (rows: SavedAnswer[], fallback: TurnShape): TurnShape =>
    rows.length
      ? {
          rounds: mean(rows.map((a) => a.rounds ?? 0), fallback.rounds),
          lookups: mean(rows.map((a) => a.lookups ?? 0), fallback.lookups),
          searches: mean(rows.map((a) => a.searches ?? 0), fallback.searches),
          // No report counts the correction rounds: the modelled rate stands.
          gateRounds: fallback.gateRounds,
        }
      : fallback;
  const chat = answers.filter((a) => a.kind === 'live' && isChatPath(a.path) && a.lookups !== undefined);
  const past = answers.filter((a) => a.kind === 'historical' && isChatPath(a.path) && a.past && a.lookups !== undefined);
  const stage = answers.filter((a) => a.path === 'stage');
  return {
    chat: shapeOf(chat, EXPECTED_TURN),
    past: shapeOf(past, DEFAULT_PAST_TURN),
    measured: { chat: measuredOf(chat), past: measuredOf(past), stage: measuredOf(stage) },
    basis: { chat: chat.length, past: past.length, reports, measuredAnswers: answers.filter((a) => a.usage).length },
  };
}

// --- Estimates --------------------------------------------------------------------------------

export interface SetEstimateInput {
  set: 'live' | 'historical' | 'conversations';
  /** Question numbers (live and historical). */
  questions: number[];
  repeat: number;
  grade: boolean;
  figureCheck: boolean;
  builds: boolean;
  stage: boolean;
  /** Historical set through the chat loop in past mode. */
  pastMode: boolean;
  /** The live set's repeat flow scores card figures (only with `--grade`). */
  cardMentions: boolean;
  /** Paraphrase pairs inside the selection (historical). */
  pairs: number;
  /** Conversations: turns that run live (tested ones and the chained turns before them), and tested turns graded. */
  conversationTurns?: { live: number; tested: number; cases: number; needGaffa: number };
  prices?: Prices;
  sizes: PromptSizes;
  baseline: ReportBaseline;
}

export interface SetEstimate extends Estimate {
  notes: string[];
}

const measuredComponent = (m: MeasuredTurn, name: string): EstimateComponent => ({ name, calls: m.calls, inputTokens: Math.round(m.inputTokens), outputTokens: Math.round(m.outputTokens), grounded: m.searches });

/** What each historical answer costs when graded: a grounded rubric call, and with `--figure-check` a figure list and a search-backed verification. */
const HISTORY = {
  grade: { input: 6_000, output: 3_000 },
  figureList: { input: 2_500, output: 800 },
  figureVerify: { input: 1_800, output: 2_500, searches: 5, searchesCeiling: 15 },
  compare: { input: 3_500, output: 300 },
  settle: { input: 4_000, output: 1_000 },
};
/** A conversation turn's conduct grade: the history so far, the live feed data, the answer and the checks; medium thinking. */
const CONDUCT = { input: 4_500, output: 2_000 };

export function estimateSet(input: SetEstimateInput): SetEstimate {
  const prices = input.prices ?? ASSUMED_PRICES;
  const b = input.baseline;
  const notes: string[] = [];
  if (b.basis.measuredAnswers) notes.push(`Answer tokens come from ${b.basis.measuredAnswers} answers whose reports recorded their usage; graders and checks are modelled.`);
  else notes.push(`The saved reports record no tokens yet, so answer tokens are modelled from their lookups, searches and rounds (${b.basis.chat} chat loop answers on the live set, ${b.basis.past} past mode answers). A report written by this runner records them.`);
  if (!input.grade) notes.push('No `--grade`: no grader and no figure check is called, so the estimate is the pipeline alone.');

  if (input.set === 'live') {
    const base = estimateRun({
      questions: input.questions,
      repeat: input.repeat,
      consistency: input.grade && input.repeat >= 2,
      cardMentions: input.grade && input.cardMentions,
      rubric: input.grade,
      stage: input.stage,
      expectedTurn: b.chat,
      ...(b.measured.chat && !input.stage ? { measuredTurn: measuredComponent(b.measured.chat, 'Chat turn (measured)') } : {}),
      prices,
      sizes: input.sizes,
    });
    return { ...base, notes };
  }

  const turns = input.set === 'historical' ? input.questions.length * input.repeat : (input.conversationTurns?.live ?? 0);
  const answerOf = (ceiling: boolean): EstimateComponent[] => {
    if (input.set === 'historical' && !input.pastMode) {
      // The debate pipeline on the stage path: a brief, lookups, a search and the writer.
      return [{ name: `Stage pipeline answers, ${turns}`, calls: TOKENS.control.calls * turns, inputTokens: TOKENS.control.input * turns, outputTokens: TOKENS.control.output * turns, grounded: TOKENS.control.grounded * turns }];
    }
    if (input.set === 'historical') {
      const shape = ceiling ? PAST_CEILING_TURN : b.past;
      const perTurn = !ceiling && b.measured.past ? measuredComponent(b.measured.past, 'Past mode turn (measured)') : chatTurnComponent(shape, input.sizes);
      return [
        scale(perTurn, turns, `Past mode answers, ${turns}${perTurn.name.includes('measured') ? ' (as measured in saved reports)' : ''}`),
        { name: `Settled-verdict proposals, at most ${turns}`, calls: turns, inputTokens: HISTORY.settle.input * turns, outputTokens: HISTORY.settle.output * turns, grounded: 0 },
      ];
    }
    const shape = ceiling ? CEILING_TURN : b.chat;
    const perTurn = !ceiling && b.measured.chat ? measuredComponent(b.measured.chat, 'Chat turn (measured)') : chatTurnComponent(shape, input.sizes);
    return [scale(perTurn, turns, `Conversation turns, ${turns}${perTurn.name.includes('measured') ? ' (as measured in saved reports)' : ''}`)];
  };

  const graders = (ceiling: boolean): EstimateComponent[] => {
    const out: EstimateComponent[] = [];
    if (!input.grade) return out;
    if (input.set === 'conversations') {
      const tested = input.conversationTurns?.tested ?? 0;
      out.push({ name: `Conduct grade, ${tested} tested turns (no search)`, calls: tested, inputTokens: CONDUCT.input * tested, outputTokens: CONDUCT.output * tested, grounded: 0 });
      return out;
    }
    out.push({ name: `Historical grade, ${turns} (one call each, with search)`, calls: turns, inputTokens: HISTORY.grade.input * turns, outputTokens: HISTORY.grade.output * turns, grounded: turns });
    if (input.figureCheck) {
      const searches = ceiling ? HISTORY.figureVerify.searchesCeiling : HISTORY.figureVerify.searches;
      out.push({ name: `Figure check, ${turns} (a list call, then a verification call with search)`, calls: 2 * turns, inputTokens: (HISTORY.figureList.input + HISTORY.figureVerify.input) * turns, outputTokens: (HISTORY.figureList.output + HISTORY.figureVerify.output) * turns, grounded: searches * turns });
    }
    const comparisons = (input.repeat >= 2 ? input.questions.length : 0) + input.pairs;
    if (comparisons) out.push({ name: `Verdict comparisons, ${comparisons}`, calls: comparisons, inputTokens: HISTORY.compare.input * comparisons, outputTokens: HISTORY.compare.output * comparisons, grounded: 0 });
    return out;
  };

  if (input.builds && input.set === 'historical') {
    notes.push('`--builds`: the runner has no store for era snapshots, so a build never completes and none is priced. The flag only stops the runner from skipping the stored-snapshot read-through.');
  }
  if (input.set === 'conversations' && input.conversationTurns?.needGaffa) {
    notes.push(`${input.conversationTurns.needGaffa} of ${input.conversationTurns.cases} cases need a Gaffa club (EVAL_GAFFA_CLUB with FUTBOLPEDIA_READ_SECRET) and are skipped without one; they are counted here.`);
  }
  if (input.set === 'conversations') notes.push('Every conversation turn is priced as a chat loop turn; a turn about the past may cost less.');
  if (input.set === 'historical' && input.pastMode && input.repeat < 2) notes.push('Each question runs once. `--repeat 2` runs it twice and adds one verdict comparison per question (with `--grade`).');

  const expected = [...answerOf(false), ...graders(false)];
  const ceiling = [...answerOf(true), ...graders(true)];
  return { expected: { components: expected, total: totalOf(expected, prices) }, ceiling: { components: ceiling, total: totalOf(ceiling, prices) }, turns, controlTurns: 0, prices, notes };
}
