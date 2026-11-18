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
  /** Whether the answer quotes a card's rating where the question doesn't turn on how good the players were. */
  ratingsOutOfPlace: 'yes' | 'no' | 'not_applicable';
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
- ratingsOutOfPlace: Futbolpedia rates versions of players on cards (an Overall, a tier, attribute scores). "yes" when the answer quotes such a rating although the question turns on something else (output, influence, the biggest matches, a season's facts or how a side played), "no" when it quotes none there, "not_applicable" when the question is how good the players were.

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
      ratingsOutOfPlace: g.ratingsOutOfPlace === 'yes' || g.ratingsOutOfPlace === 'not_applicable' ? g.ratingsOutOfPlace : 'no',
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

/** What a run looked up and committed to, when the runner reports it (`--deep` runs carry `past`). */
export interface HistoryResearch {
  path: 'stage' | 'deep';
  fallback?: string;
  lookups: number;
  searches: number;
  rounds: number;
  views: Record<string, number>;
  gateFeedback?: { flagged: number; fixed: number; dropped: number; removed: number };
  past?: {
    committed: boolean;
    kind: string | null;
    criterion: string | null;
    verdict: string[];
    cards: string | null;
    settled: string;
    departed: boolean;
    departedSilently: boolean;
    priors: { current: number; stale: number; contested: number };
    rankingPriorFound: boolean | null;
  };
  /** What the settle route answered for each proposal (stored, kept, refused, invalid and the rest). */
  settles?: string[];
}

interface AskResult {
  answer: string;
  error?: string;
  firstTokenMs: number | null;
  totalMs: number;
  perf: string[];
  research?: HistoryResearch;
}

/** Two runs' committed verdicts compared in code: the same winner or order, or not; null when either didn't commit. */
export function sameCommitment(a: HistoryResearch | undefined, b: HistoryResearch | undefined): 'same' | 'different' | null {
  const x = a?.past;
  const y = b?.past;
  if (!x?.committed || !y?.committed || !x.verdict.length || !y.verdict.length) return null;
  const norm = (v: string[]) => v.map((n) => n.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z ]/g, '').trim().split(/\s+/).pop()).join('|');
  return norm(x.verdict) === norm(y.verdict) ? 'same' : 'different';
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
  const runs: HistoricalRun[] = [];
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
      const figures = run.answer ? await checkFigures(run.answer, deps.grade) : null;
      runs.push({ q, attempt, run, grade, figures });
      console.log(
        run.error
          ? `failed: ${run.error}`
          : `${((run.firstTokenMs ?? run.totalMs) / 1000).toFixed(1)}s first token, ${(run.totalMs / 1000).toFixed(1)}s total${
              grade ? `; figures ${figures ? `${figures.wrong.length} wrong of ${figures.stated}` : 'unchecked'}, blended ${grade.blendedSeasons.length}, criteria ${grade.criteria}/5` : '; grading failed'
            }`,
      );
    }
  }

  const agree = async (question: string, a: string, b: string) =>
    parseAgreement(await deps.grade(`${AGREEMENT_INSTRUCTIONS}\n\nQuestion: ${question}\n\nAnswer A:\n${a}\n\nAnswer B:\n${b}`, false).catch(() => ''));
  const repeats: Compared[] = [];
  for (const q of deps.questions) {
    const [a, b] = runs.filter((r) => r.q.n === q.n && r.run.answer);
    if (!a || !b) continue;
    const r = await agree(q.text, a.run.answer, b.run.answer);
    repeats.push({ n: q.n, agreement: r?.agreement ?? null, why: r?.why ?? 'comparison failed', committed: sameCommitment(a.run.research, b.run.research) });
  }
  const paraphrases: PairCompared[] = [];
  for (const pair of deps.pairs) {
    const a = runs.find((r) => r.q.n === pair[0] && r.run.answer);
    const b = runs.find((r) => r.q.n === pair[1] && r.run.answer);
    if (!a || !b) continue;
    const r = await agree(`${a.q.text} / ${b.q.text}`, a.run.answer, b.run.answer);
    paraphrases.push({ pair, agreement: r?.agreement ?? null, why: r?.why ?? 'comparison failed', committed: sameCommitment(a.run.research, b.run.research) });
  }

  return buildHistoricalReport(runs, repeats, paraphrases, deps);
}

export interface HistoricalRun {
  q: EvalQuestion;
  attempt: number;
  run: AskResult;
  grade: HistoryGrade | null;
  figures?: FigureCheck | null;
}
type Compared = { n: number; agreement: Agreement | null; why: string; committed?: 'same' | 'different' | null };
type PairCompared = { pair: [number, number]; agreement: Agreement | null; why: string; committed?: 'same' | 'different' | null };

/** Runs a saved report's answers through the figure check again, keeping its grades and comparisons. */
export async function regradeFigures(
  saved: { runs: HistoricalRun[]; repeats: Compared[]; paraphrases: PairCompared[] },
  deps: Pick<HistoricalRunDeps, 'grade' | 'today' | 'label' | 'model' | 'repeat' | 'questions'>,
): Promise<{ markdown: string; json: unknown }> {
  for (const r of saved.runs) {
    process.stdout.write(`Q${r.q.n} (run ${r.attempt}) ... `);
    r.figures = r.run.answer ? await checkFigures(r.run.answer, deps.grade) : null;
    console.log(r.figures ? `${r.figures.wrong.length} wrong, ${r.figures.unconfirmed.length} unconfirmed of ${r.figures.stated}` : 'unchecked');
  }
  return buildHistoricalReport(saved.runs, saved.repeats, saved.paraphrases, deps);
}

function buildHistoricalReport(
  runs: HistoricalRun[],
  repeats: Compared[],
  paraphrases: PairCompared[],
  deps: Pick<HistoricalRunDeps, 'today' | 'label' | 'model' | 'repeat' | 'questions'>,
): { markdown: string; json: unknown } {
  const graded = runs.filter((r) => r.grade);
  const checked = runs.filter((r) => r.figures);
  const figureSum = (f: (c: FigureCheck) => number) => checked.reduce((n, r) => n + f(r.figures!), 0);
  const sum = (f: (g: HistoryGrade) => number) => graded.reduce((n, r) => n + f(r.grade!), 0);
  const mean = (f: (g: HistoryGrade) => number) => (graded.length ? (sum(f) / graded.length).toFixed(1) : '–');
  const median = (xs: number[]) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] : null);
  const secs = (ms: number | null) => (ms === null ? '–' : (ms / 1000).toFixed(1));
  const count = (list: { agreement: Agreement | null }[], a: Agreement) => list.filter((x) => x.agreement === a).length;
  const cell = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');

  const markdown = `# Historical question eval: ${deps.today}, ${deps.label}

Ran ${deps.questions.length} questions ${deps.repeat} time${deps.repeat === 1 ? '' : 's'} each through the chat pipeline, each run in a new chat, with the shared cards read from Supabase; ${graded.length} of ${runs.length} answers were graded. Graded by ${deps.model} with Google Search.

The grader is the same model that writes the answers, so it can share their blind spots. Compare runs with each other rather than reading any score as absolute.

- Precise figures stated: ${figureSum((c) => c.stated)} in ${checked.length} checked answers; wrong: ${figureSum((c) => c.wrong.length)}; unconfirmed: ${figureSum((c) => c.unconfirmed.length)} (listed, then each checked with search)
- Wrong figures in the one-pass grade: ${sum((g) => g.wrongFigures.length)} in total
- Blended seasons: ${sum((g) => g.blendedSeasons.length)} in total
- Myths repeated: ${sum((g) => g.myths.length)} in total
- Mean use of criteria: ${mean((g) => g.criteria)} / 5
- Takes on the counter-case: ${graded.filter((r) => r.grade!.counterCase === 'yes').length} of ${graded.filter((r) => r.grade!.counterCase !== 'not_needed').length} that needed it
- Mean decisiveness: ${mean((g) => g.decisiveness)} / 5
- Same verdict when asked twice: ${count(repeats, 'same')} same, ${count(repeats, 'partly')} partly, ${count(repeats, 'different')} different, of ${repeats.length}
- Same verdict across paraphrases: ${count(paraphrases, 'same')} same, ${count(paraphrases, 'partly')} partly, ${count(paraphrases, 'different')} different, of ${paraphrases.length}
- Median first token: ${secs(median(runs.map((r) => r.run.firstTokenMs).filter((x): x is number => x !== null)))} s; median total: ${secs(median(runs.map((r) => r.run.totalMs)))} s
- Ratings quoted out of place: ${graded.filter((r) => r.grade!.ratingsOutOfPlace === 'yes').length} of ${graded.filter((r) => r.grade!.ratingsOutOfPlace !== 'not_applicable').length} answers where the question doesn't turn on how good the players were
${researchSummary(runs)}

| # | Run | Figures | Wrong | Unconfirmed | Blended | Myths | Criteria | Counter-case | Decisive | First token (s) | Total (s) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${runs
  .map((r) =>
    r.grade
      ? `| ${r.q.n} | ${r.attempt} | ${r.figures?.stated ?? '–'} | ${r.figures?.wrong.length ?? '–'} | ${r.figures?.unconfirmed.length ?? '–'} | ${r.grade.blendedSeasons.length} | ${r.grade.myths.length} | ${r.grade.criteria} | ${r.grade.counterCase} | ${r.grade.decisiveness} | ${secs(r.run.firstTokenMs)} | ${secs(r.run.totalMs)} | ${cell(r.grade.verdict)} |`
      : `| ${r.q.n} | ${r.attempt} | – | – | – | – | – | – | – | – | ${secs(r.run.firstTokenMs)} | ${secs(r.run.totalMs)} | ${r.run.error ? `Pipeline failed: ${cell(r.run.error)}` : 'Grading failed'} |`,
  )
  .join('\n')}

${researchTable(runs)}## Consistency

| Compared | Agreement | Committed verdicts | Why |
| --- | --- | --- | --- |
${[
  ...repeats.map((r) => `| Q${r.n}, run 1 and run 2 | ${r.agreement ?? '–'} | ${r.committed ?? '–'} | ${cell(r.why)} |`),
  ...paraphrases.map((p) => `| Q${p.pair[0]} and Q${p.pair[1]} | ${p.agreement ?? '–'} | ${p.committed ?? '–'} | ${cell(p.why)} |`),
].join('\n')}

${runs
  .map(
    (r) => `## ${r.q.n}. ${r.q.text}${deps.repeat > 1 ? ` (run ${r.attempt})` : ''}

${r.q.tests}

${r.figures?.wrong.length ? `Wrong figures:\n${r.figures.wrong.map((f) => `- ${f.claim}: ${f.note}`).join('\n')}\n\n` : ''}${
      r.figures?.unconfirmed.length ? `Unconfirmed figures:\n${r.figures.unconfirmed.map((f) => `- ${f.claim}: ${f.note}`).join('\n')}\n\n` : ''
    }${r.grade?.wrongFigures.length ? `Wrong figures (one-pass grade):\n${r.grade.wrongFigures.map((f) => `- ${f.claim}: ${f.why}`).join('\n')}\n\n` : ''}${
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

// --- Research and commitments ----------------------------------------------------------------

/** Summary lines for runs that report their research; empty when none do (the stage runner before `--deep`). */
export function researchSummary(runs: HistoricalRun[]): string {
  const withResearch = runs.filter((r) => r.run.research);
  if (!withResearch.length) return '';
  const deep = withResearch.filter((r) => r.run.research!.path === 'deep');
  const past = deep.filter((r) => r.run.research!.past);
  const judged = past.filter((r) => r.run.research!.past!.committed);
  const cards = (v: string) => judged.filter((r) => r.run.research!.past!.cards === v).length;
  const rankings = past.filter((r) => r.run.research!.past!.rankingPriorFound !== null);
  return [
    `- Path: ${deep.length} of ${withResearch.length} answers through the deep loop; ${withResearch.filter((r) => r.run.research!.fallback).length} fell back to the stage pipeline`,
    past.length
      ? `- Committed a verdict: ${judged.length} of ${past.length} deep answers; against the cards ${cards('against')} (departed with a reason ${judged.filter((r) => r.run.research!.past!.departed && !r.run.research!.past!.departedSilently).length}, silently ${judged.filter((r) => r.run.research!.past!.departedSilently).length}), agreed ${cards('agree')}, level ${cards('level')}, not card-settled ${cards('unsettled')}`
      : '',
    past.length ? `- Read a settled verdict: ${past.filter((r) => r.run.research!.past!.priors.current + r.run.research!.past!.priors.stale + r.run.research!.past!.priors.contested > 0).length} of ${past.length}` : '',
    rankings.length ? `- Found a stored ranking for the question's field: ${rankings.filter((r) => r.run.research!.past!.rankingPriorFound).length} of ${rankings.length} ranking answers` : '',
    settleSummary(withResearch),
  ]
    .filter(Boolean)
    .join('\n');
}

/** What the settle route answered across the run, by status. */
function settleSummary(runs: HistoricalRun[]): string {
  const all = runs.flatMap((r) => r.run.research?.settles ?? []);
  if (!all.length) return '';
  const counts = new Map<string, number>();
  for (const s of all) counts.set(s, (counts.get(s) ?? 0) + 1);
  return `- Settled-verdict store: ${all.length} proposals; ${[...counts].map(([s, n]) => `${n} ${s}`).join(', ')}`;
}

/** A table of each run's research and commitment; empty when no run reports them. */
export function researchTable(runs: HistoricalRun[]): string {
  if (!runs.some((r) => r.run.research)) return '';
  const row = (r: HistoricalRun) => {
    const x = r.run.research;
    if (!x) return `| ${r.q.n} | ${r.attempt} | – | – | – | – | – | – | – | – | – | – | – |`;
    const p = x.past;
    const views = Object.entries(x.views ?? {}).map(([k, n]) => `${n} ${k}`).join(', ') || '–';
    const gate = x.gateFeedback ? `${x.gateFeedback.fixed}/${x.gateFeedback.dropped}/${x.gateFeedback.removed}` : '0/0/0';
    const commit = p ? (p.committed ? `${p.kind}, ${p.criterion}: ${p.verdict.join(' > ')}` : 'no') : '–';
    const cards = p ? `${p.cards ?? '–'}${p.departed ? (p.departedSilently ? ', departed silently' : ', departed') : ''}` : '–';
    const prior = p ? `${p.settled}${p.priors.current + p.priors.stale + p.priors.contested ? ` (${p.priors.current} current, ${p.priors.stale} stale)` : ''}` : '–';
    const store = x.settles ? x.settles.join(', ') || 'nothing proposed' : '–';
    return `| ${r.q.n} | ${r.attempt} | ${x.fallback ? `deep, then stage (${x.fallback})` : x.path} | ${x.lookups} | ${x.searches} | ${x.rounds} | ${views} | ${gate} | ${commit.replace(/\|/g, '/')} | ${cards} | ${prior} | ${p?.rankingPriorFound === null || !p ? '–' : p.rankingPriorFound ? 'yes' : 'no'} | ${store} |`;
  };
  return `## Research and commitments

| # | Run | Path | Lookups | Searches | Rounds | Views | Gate fixed/dropped/removed | Committed | Cards | Settled verdict | Stored ranking found | Store answered |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${runs.map(row).join('\n')}

`;
}

// --- Figure check -----------------------------------------------------------------------------

/**
 * A stricter look at precise figures than the one-pass grade: one call lists every figure the
 * answer states as fact, and a second, with Google Search, checks each one. Lenient graders pass
 * figures they don't look up, so this is what the report's figure columns count.
 */
export interface FigureCheck {
  stated: number;
  wrong: { claim: string; note: string }[];
  unconfirmed: { claim: string; note: string }[];
}

export const FIGURE_LIST_INSTRUCTIONS = `List every precise figure this football answer states as fact about the past: numbers of goals, assists, appearances, matches, points, wins, draws, defeats, trophies, titles, records, league positions, fees, and dates tied to events. Write each as one short self-contained claim naming who, the number, and the season or competition it belongs to. Leave out Futbolpedia's own ratings (an Overall, attribute scores, tiers), and figures the answer presents as estimates or ranges. Reply with one JSON object: {"claims": ["<claim>", ...]} with at most 15 claims, the most important first.`;

export const FIGURE_VERIFY_INSTRUCTIONS = `Check each numbered football claim below with Google Search against reliable sources (Wikipedia, club and competition records, contemporary reports). Judge each claim within the scope it states: a count tied to named seasons, a window or a decade is correct when it's right for that span, even if the career total is higher. For each, decide "correct" (sources agree, allowing a difference of one where reputable sources themselves disagree), "wrong" (sources give a different number, or the number belongs to another season or competition, such as a total across all competitions given as a league figure), or "unconfirmed" (you can't find it either way). Reply with one JSON object: {"results": [{"n": <number>, "verdict": "correct" | "wrong" | "unconfirmed", "note": "<a few words>"}]}.`;

const jsonIn = (raw: string): any => {
  try {
    return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '');
  } catch {
    return null;
  }
};

export async function checkFigures(answer: string, grade: (prompt: string, withSearch: boolean) => Promise<string>): Promise<FigureCheck | null> {
  const listed = jsonIn(await grade(`${FIGURE_LIST_INSTRUCTIONS}\n\nAnswer:\n${answer}`, false).catch(() => ''));
  if (!listed || !Array.isArray(listed.claims)) return null;
  const claims: string[] = listed.claims.filter((c: unknown) => typeof c === 'string' && c.trim()).slice(0, 15);
  if (!claims.length) return { stated: 0, wrong: [], unconfirmed: [] };
  const checked = jsonIn(await grade(`${FIGURE_VERIFY_INSTRUCTIONS}\n\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}`, true).catch(() => ''));
  if (!checked || !Array.isArray(checked.results)) return null;
  const pick = (verdict: string) =>
    checked.results
      .filter((r: any) => r?.verdict === verdict && claims[Number(r.n) - 1])
      .map((r: any) => ({ claim: claims[Number(r.n) - 1], note: String(r.note ?? '') }));
  return { stated: claims.length, wrong: pick('wrong'), unconfirmed: pick('unconfirmed') };
}
