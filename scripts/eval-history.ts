/**
 * The parts of the eval runner (`scripts/eval-live-questions.ts`) for the historical question set
 * (docs/superpowers/evals/historical-questions.md): a read-only Supabase client so answers see the
 * shared cards, the historical grader, and the check that two answers reach the same verdict.
 * Users never see any of this.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

export interface EvalQuestion {
  n: number;
  text: string;
  tests: string;
}

/** The questions table from a set's Markdown. Questions that start with "@" need a card mention, so they're skipped. */
export function readQuestionTable(path: string): EvalQuestion[] {
  const md = readFileSync(path, 'utf8');
  return [...md.matchAll(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/gm)]
    .map((m) => ({ n: Number(m[1]), text: m[2], tests: m[3] }))
    .filter((q) => !q.text.startsWith('@'));
}

/** Pairs of questions that ask the same thing in other words, read from "Paraphrase of N" in the table. */
export const paraphrasePairs = (questions: EvalQuestion[]): [number, number][] =>
  questions.flatMap((q) => {
    const m = q.tests.match(/paraphrase of (\d+)/i);
    return m ? [[Number(m[1]), q.n] as [number, number]] : [];
  });

/**
 * A Supabase client that reads like the app's and never writes: inserts, upserts, updates and
 * deletes answer as if they'd worked, so an eval run never changes the shared tables. The app
 * reaches Supabase through `window.supabase`, so this installs a stand-in there. Call it before
 * the app's modules are imported.
 */
export function installReadOnlySupabase(): void {
  const noWrite = (): any => {
    const done = Promise.resolve({ data: null, error: null });
    const chain: any = new Proxy(() => chain, {
      get: (_t, prop) => (prop === 'then' ? done.then.bind(done) : prop === 'catch' ? done.catch.bind(done) : () => chain),
      apply: () => chain,
    });
    return chain;
  };
  const readOnly = (client: any) =>
    new Proxy(client, {
      get(target, prop) {
        if (prop !== 'from') return Reflect.get(target, prop);
        return (table: string) => {
          const builder = target.from(table);
          return new Proxy(builder, {
            get: (b, p) => (p === 'insert' || p === 'upsert' || p === 'update' || p === 'delete' ? noWrite : Reflect.get(b, p)),
          });
        };
      },
    });
  (globalThis as any).window = {
    ...(globalThis as any).window,
    supabase: { createClient: (url: string, key: string, options?: any) => readOnly(createClient(url, key, options)) },
    FUTBOLPEDIA_PERF: true,
  };
}

// --- Grading ----------------------------------------------------------------------------------

export interface HistoryGrade {
  wrongFigures: { claim: string; why: string }[];
  blendedSeasons: { claim: string; why: string }[];
  myths: { claim: string; why: string }[];
  criteria: number;
  counterCase: 'yes' | 'no' | 'not_needed';
  decisiveness: number;
  /** The verdict in a few words, or the order for a ranking. */
  verdict: string;
  notes: string;
}

export const HISTORY_GRADE_INSTRUCTIONS = `You are grading a football analyst's answer about the past: past seasons, players' primes, eras, and all-time comparisons. Use Google Search to check every precise figure and dated fact against reliable sources (Wikipedia, club and competition records, contemporary reports).

- wrongFigures: precise numbers that are false or that no source supports: goals, assists, appearances, points, trophies, records, dates, fees, positions in a table. Give the claim and why. A figure that is right for a different competition or season counts as wrong only when the answer attaches it to the wrong one; then it is also a blended season.
- blendedSeasons: facts from one season or spell presented as belonging to another: a player in a side he joined later or had left, two seasons' numbers merged into one, a coach from another year, a trophy won in a different season.
- myths: popular anecdotes or claims repeated as fact that reliable sources dispute or contradict.
- criteria: 1 to 5, where 5 names the criteria that settle the question (such as peak level, sustained level, output, influence on results, versatility) and argues each one with evidence, and 1 argues from reputation and adjectives.
- counterCase: "yes" when the answer takes on the strongest case against its own verdict, "no" when it ignores it, "not_needed" when the question has no verdict to argue.
- decisiveness: 1 to 5, where 5 commits to a clear verdict (or a clear order) and 1 sits on the fence.
- verdict: the answer's verdict in a few words, or its order for a ranking, names only.
- notes: one or two sentences on the answer's biggest strength and weakness.

Reply with one JSON object with exactly these keys and nothing else.`;

export function parseHistoryGrade(raw: string): HistoryGrade | null {
  const body = raw.match(/\{[\s\S]*\}/)?.[0];
  try {
    const g = JSON.parse(body ?? '');
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
    return {
      wrongFigures: list(g.wrongFigures),
      blendedSeasons: list(g.blendedSeasons),
      myths: list(g.myths),
      criteria: Number(g.criteria) || 0,
      counterCase: g.counterCase === 'yes' || g.counterCase === 'not_needed' ? g.counterCase : 'no',
      decisiveness: Number(g.decisiveness) || 0,
      verdict: String(g.verdict ?? ''),
      notes: String(g.notes ?? ''),
    };
  } catch {
    return null;
  }
}

export type Agreement = 'same' | 'partly' | 'different';

export const AGREEMENT_INSTRUCTIONS = `Two answers to the same football question (or to two wordings of it) follow. Do they reach the same verdict? For a head-to-head or yes-or-no question, "same" means the same side wins; for a ranking, "same" means the same players in the same order at the top, "partly" means the same players with some order changed or one swapped; "different" means a different winner or a substantially different list. Judge only the verdicts, not the wording or the arguments. Reply with one JSON object: {"agreement": "same" | "partly" | "different", "why": "<one sentence>"}.`;

export function parseAgreement(raw: string): { agreement: Agreement; why: string } | null {
  const body = raw.match(/\{[\s\S]*\}/)?.[0];
  try {
    const g = JSON.parse(body ?? '');
    return ['same', 'partly', 'different'].includes(g.agreement) ? { agreement: g.agreement, why: String(g.why ?? '') } : null;
  } catch {
    return null;
  }
}

// --- The historical run -----------------------------------------------------------------------

interface AskResult {
  answer: string;
  error?: string;
  firstTokenMs: number | null;
  totalMs: number;
  perf: string[];
}

export interface HistoricalRunDeps {
  questions: EvalQuestion[];
  /** Questions to compare as paraphrases, by number, even when only some were run. */
  pairs: [number, number][];
  repeat: number;
  ask: (question: string) => Promise<AskResult>;
  /** A grader call with Google Search; returns the model's text. */
  grade: (prompt: string, withSearch: boolean) => Promise<string>;
  today: string;
  label: string;
  model: string;
}

/**
 * Runs each question `repeat` times, grades every answer, compares repeated answers and
 * paraphrase pairs for the same verdict, and returns the report's Markdown and JSON.
 */
export async function runHistoricalSet(deps: HistoricalRunDeps): Promise<{ markdown: string; json: unknown }> {
  const runs: { q: EvalQuestion; attempt: number; run: AskResult; grade: HistoryGrade | null }[] = [];
  for (const q of deps.questions) {
    for (let attempt = 1; attempt <= deps.repeat; attempt++) {
      process.stdout.write(`Q${q.n}${deps.repeat > 1 ? ` (run ${attempt})` : ''}: ${q.text} ... `);
      const run = await deps.ask(q.text);
      const raw = run.answer
        ? await deps
            .grade(`${HISTORY_GRADE_INSTRUCTIONS}\n\nToday is ${deps.today}.\n\nQuestion: ${q.text}\n\nAnswer:\n${run.answer}`, true)
            .catch(() => '')
        : '';
      const grade = parseHistoryGrade(raw);
      runs.push({ q, attempt, run, grade });
      console.log(
        run.error
          ? `failed: ${run.error}`
          : `${((run.firstTokenMs ?? run.totalMs) / 1000).toFixed(1)}s first token, ${(run.totalMs / 1000).toFixed(1)}s total${
              grade ? `; wrong figures ${grade.wrongFigures.length}, blended ${grade.blendedSeasons.length}, criteria ${grade.criteria}/5` : '; grading failed'
            }`,
      );
    }
  }

  const agree = async (question: string, a: string, b: string) =>
    parseAgreement(await deps.grade(`${AGREEMENT_INSTRUCTIONS}\n\nQuestion: ${question}\n\nAnswer A:\n${a}\n\nAnswer B:\n${b}`, false).catch(() => ''));
  const repeats: { n: number; agreement: Agreement | null; why: string }[] = [];
  for (const q of deps.questions) {
    const [a, b] = runs.filter((r) => r.q.n === q.n && r.run.answer);
    if (!a || !b) continue;
    const r = await agree(q.text, a.run.answer, b.run.answer);
    repeats.push({ n: q.n, agreement: r?.agreement ?? null, why: r?.why ?? 'comparison failed' });
  }
  const paraphrases: { pair: [number, number]; agreement: Agreement | null; why: string }[] = [];
  for (const pair of deps.pairs) {
    const a = runs.find((r) => r.q.n === pair[0] && r.run.answer);
    const b = runs.find((r) => r.q.n === pair[1] && r.run.answer);
    if (!a || !b) continue;
    const r = await agree(`${a.q.text} / ${b.q.text}`, a.run.answer, b.run.answer);
    paraphrases.push({ pair, agreement: r?.agreement ?? null, why: r?.why ?? 'comparison failed' });
  }

  const graded = runs.filter((r) => r.grade);
  const sum = (f: (g: HistoryGrade) => number) => graded.reduce((n, r) => n + f(r.grade!), 0);
  const mean = (f: (g: HistoryGrade) => number) => (graded.length ? (sum(f) / graded.length).toFixed(1) : '–');
  const median = (xs: number[]) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] : null);
  const secs = (ms: number | null) => (ms === null ? '–' : (ms / 1000).toFixed(1));
  const count = (list: { agreement: Agreement | null }[], a: Agreement) => list.filter((x) => x.agreement === a).length;
  const cell = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');

  const markdown = `# Historical question eval: ${deps.today}, ${deps.label}

Ran ${deps.questions.length} questions ${deps.repeat} time${deps.repeat === 1 ? '' : 's'} each through the chat pipeline, each run in a new chat, with the shared cards read from Supabase; ${graded.length} of ${runs.length} answers were graded. Graded by ${deps.model} with Google Search.

The grader is the same model that writes the answers, so it can share their blind spots. Compare runs with each other rather than reading any score as absolute.

- Wrong figures: ${sum((g) => g.wrongFigures.length)} in total (${mean((g) => g.wrongFigures.length)} per answer)
- Blended seasons: ${sum((g) => g.blendedSeasons.length)} in total
- Myths repeated: ${sum((g) => g.myths.length)} in total
- Mean use of criteria: ${mean((g) => g.criteria)} / 5
- Takes on the counter-case: ${graded.filter((r) => r.grade!.counterCase === 'yes').length} of ${graded.filter((r) => r.grade!.counterCase !== 'not_needed').length} that needed it
- Mean decisiveness: ${mean((g) => g.decisiveness)} / 5
- Same verdict when asked twice: ${count(repeats, 'same')} same, ${count(repeats, 'partly')} partly, ${count(repeats, 'different')} different, of ${repeats.length}
- Same verdict across paraphrases: ${count(paraphrases, 'same')} same, ${count(paraphrases, 'partly')} partly, ${count(paraphrases, 'different')} different, of ${paraphrases.length}
- Median first token: ${secs(median(runs.map((r) => r.run.firstTokenMs).filter((x): x is number => x !== null)))} s; median total: ${secs(median(runs.map((r) => r.run.totalMs)))} s

| # | Run | Wrong figures | Blended | Myths | Criteria | Counter-case | Decisive | First token (s) | Total (s) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${runs
  .map((r) =>
    r.grade
      ? `| ${r.q.n} | ${r.attempt} | ${r.grade.wrongFigures.length} | ${r.grade.blendedSeasons.length} | ${r.grade.myths.length} | ${r.grade.criteria} | ${r.grade.counterCase} | ${r.grade.decisiveness} | ${secs(r.run.firstTokenMs)} | ${secs(r.run.totalMs)} | ${cell(r.grade.verdict)} |`
      : `| ${r.q.n} | ${r.attempt} | – | – | – | – | – | – | ${secs(r.run.firstTokenMs)} | ${secs(r.run.totalMs)} | ${r.run.error ? `Pipeline failed: ${cell(r.run.error)}` : 'Grading failed'} |`,
  )
  .join('\n')}

## Consistency

| Compared | Agreement | Why |
| --- | --- | --- |
${[
  ...repeats.map((r) => `| Q${r.n}, run 1 and run 2 | ${r.agreement ?? '–'} | ${cell(r.why)} |`),
  ...paraphrases.map((p) => `| Q${p.pair[0]} and Q${p.pair[1]} | ${p.agreement ?? '–'} | ${cell(p.why)} |`),
].join('\n')}

${runs
  .map(
    (r) => `## ${r.q.n}. ${r.q.text}${deps.repeat > 1 ? ` (run ${r.attempt})` : ''}

${r.q.tests}

${r.grade?.wrongFigures.length ? `Wrong figures:\n${r.grade.wrongFigures.map((f) => `- ${f.claim}: ${f.why}`).join('\n')}\n\n` : ''}${
      r.grade?.blendedSeasons.length ? `Blended seasons:\n${r.grade.blendedSeasons.map((f) => `- ${f.claim}: ${f.why}`).join('\n')}\n\n` : ''
    }${r.grade?.myths.length ? `Myths:\n${r.grade.myths.map((f) => `- ${f.claim}: ${f.why}`).join('\n')}\n\n` : ''}${r.grade?.notes ? `${r.grade.notes}\n\n` : ''}<details><summary>Answer</summary>

${r.run.answer || r.run.error || '(empty)'}

</details>

<details><summary>Timing</summary>

${r.run.perf.map((l) => `    ${l}`).join('\n') || '    (no perf lines)'}

</details>
`,
  )
  .join('\n')}`;
  return { markdown, json: { runs, repeats, paraphrases } };
}
