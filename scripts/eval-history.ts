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
