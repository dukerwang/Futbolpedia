/**
 * The plain live-set run of `scripts/eval-live-questions.ts` (no `--repeat`): each question once,
 * graded only when the caller passes a grader (`--grade`), stopping at once when a 429 or
 * spending-cap error comes back. A function with everything injected, so
 * `scripts/test-eval-costs.ts` runs it with a faked pipeline and grader. Users never see any of this.
 */
import { isSpendLimit } from './eval-guard';
import type { RunResult as ConsistencyRun } from './eval-consistency';

export interface PlainQuestion {
  n: number;
  text: string;
  tests: string;
}

export interface PlainResult<G, R extends ConsistencyRun = ConsistencyRun> {
  q: PlainQuestion;
  run: R;
  grade: G | null;
  graderRaw: string;
}

export interface PlainDeps<G, R extends ConsistencyRun = ConsistencyRun> {
  questions: PlainQuestion[];
  /** Answer each question once first (`--warm`), so the run reuses the club snapshots it built. */
  warm?: boolean;
  ask: (question: string) => Promise<R>;
  /** The live rubric's grade of one answer. Left out (no `--grade`), nothing is graded. */
  gradeAnswer?: (question: string, answer: string) => Promise<{ grade: G | null; raw: string }>;
  /** A few words on a grade for the progress line. */
  describeGrade?: (grade: G) => string;
  /** Why the run has to stop once a 429 or spending-cap error has come back; null while it can go on. */
  stopReason?: () => string | null;
  /** Called after every question with the results so far, so a run cut short keeps what it finished. */
  onResult: (results: PlainResult<G, R>[]) => void;
  /** Waits between the warm pass and the graded one (default 20 s). */
  settle?: () => Promise<void>;
  log?: (line: string) => void;
  write?: (text: string) => void;
}

export async function runPlainSet<G, R extends ConsistencyRun = ConsistencyRun>(
  deps: PlainDeps<G, R>,
): Promise<{ results: PlainResult<G, R>[]; stoppedEarly?: string }> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const write = deps.write ?? ((text: string) => void process.stdout.write(text));
  const results: PlainResult<G, R>[] = [];
  const limit = (run?: R): string | null => (run && isSpendLimit(run.error) ? run.error! : null) ?? deps.stopReason?.() ?? null;

  if (deps.warm) {
    // Snapshots live in memory here, so a first pass stands in for the shared table's daily rows.
    for (const q of deps.questions) {
      write(`Warming Q${q.n} ... `);
      const run = await deps.ask(q.text);
      const hit = limit(run);
      if (hit) {
        log(`stopped: ${hit}`);
        return { results, stoppedEarly: `warming Q${q.n}: ${hit}` };
      }
      log(run.error ? `failed: ${run.error}` : `${(run.totalMs / 1000).toFixed(1)}s`);
    }
    await (deps.settle ?? (() => new Promise<void>((r) => setTimeout(r, 20_000))))();
  }

  for (const q of deps.questions) {
    const before = limit();
    if (before) return { results, stoppedEarly: `Q${q.n}: ${before}` };
    write(`Q${q.n}: ${q.text} ... `);
    const run = await deps.ask(q.text);
    const hit = limit(run);
    if (hit) {
      // The turn that hit the limit may still hold an answer: keep it, ungraded.
      if (run.answer) {
        results.push({ q, run, grade: null, graderRaw: '' });
        deps.onResult(results);
      }
      log(`stopped: ${hit}`);
      return { results, stoppedEarly: `Q${q.n}: ${hit}` };
    }
    const graded = run.answer && deps.gradeAnswer ? await deps.gradeAnswer(q.text, run.answer).catch((e) => ({ grade: null as G | null, raw: String(e?.message ?? e) })) : { grade: null as G | null, raw: '' };
    results.push({ q, run, grade: graded.grade, graderRaw: graded.raw });
    log(
      run.error
        ? `failed: ${run.error}`
        : `${((run.firstTokenMs ?? run.totalMs) / 1000).toFixed(1)}s first token, ${(run.totalMs / 1000).toFixed(1)}s total${
            !deps.gradeAnswer ? '; not graded' : graded.grade ? `; ${deps.describeGrade?.(graded.grade) ?? 'graded'}` : '; grading failed'
          }`,
    );
    deps.onResult(results);
    const after = deps.stopReason?.();
    if (after) return { results, stoppedEarly: `Q${q.n}: ${after}` };
  }
  return { results };
}
