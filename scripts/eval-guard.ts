/**
 * What every live eval script shares so an eval can't touch the live app's Gemini budget and says
 * what it spent (`eval-live-questions.ts`, `eval-history.ts`, `eval-consistency.ts`,
 * `eval-conversations.ts`, `smoke-model.ts`). Users never see any of this.
 *
 *  - **Its own key.** An eval reads `EVAL_GEMINI_API_KEY` and refuses to start without it. It never
 *    falls back to `GEMINI_API_KEY`, the live app's key. `--use-app-key` is the explicit way to spend
 *    the app's budget, with a warning. The key is set for the eval process only (`API_KEY` and
 *    `GEMINI_API_KEY` both, so nothing in the process can reach the app's key).
 *  - **A cap check.** Before the first real call, one request with `maxOutputTokens: 1`. A 429 ends the
 *    run before anything else is sent. During a run, the first 429 or spending-cap error stops every
 *    later model call (it throws, with nothing sent and nothing retried), and the runner keeps the
 *    report written so far.
 *  - **Real usage.** Every model call is counted from `usageMetadata`: input, output and thinking
 *    tokens, and grounded searches, per answer and in total.
 *  - **A search cache** for the run (`eval-search-cache.ts`), installed here, never by the app.
 *
 * The pure parts (flags, key, tally, instrumentation) take everything they touch as arguments, so
 * `scripts/test-eval-costs.ts` runs them with a faked model, fetch and clock.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const EVAL_KEY_VAR = 'EVAL_GEMINI_API_KEY';

/** Reads KEY=value lines from `.env.local` and `.env` under `root` into `env`, without overriding what is already set. */
export function loadEnvFiles(root: string, env: Record<string, string | undefined> = process.env): void {
  for (const file of ['.env.local', '.env']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      // `undefined`, not falsy: a name set empty in the environment stays empty, so a file can't fill it in.
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  }
}

// --- Flags ------------------------------------------------------------------------------------

export interface EvalFlags {
  /** `--use-app-key`: spend the live app's budget on purpose. */
  useAppKey: boolean;
  /** `--grade` (or `--figure-check`): call the grader models. Off, answers are saved for a person to read. */
  grade: boolean;
  /** `--figure-check`: list and verify each precise figure of a historical answer. Implies `--grade`. */
  figureCheck: boolean;
  /** `--builds`: let era snapshot builds run. Off, a turn reads stored ones and never builds. */
  builds: boolean;
  /** `--fresh-search`: neither read nor write the eval search cache. */
  freshSearch: boolean;
  /** `--dry-run`: print the estimate and exit before any key check or call. */
  dryRun: boolean;
}

export function parseEvalFlags(args: string[]): EvalFlags {
  const has = (flag: string) => args.includes(flag);
  const figureCheck = has('--figure-check') || has('--regrade');
  return {
    useAppKey: has('--use-app-key'),
    grade: has('--grade') || figureCheck,
    figureCheck,
    builds: has('--builds'),
    freshSearch: has('--fresh-search'),
    dryRun: has('--dry-run'),
  };
}

/** Runs of each question: the live set once, the historical set once too (`--repeat 2` asks twice). */
export function repeatFor(args: string[]): number {
  const i = args.indexOf('--repeat');
  const n = i >= 0 ? Number(args[i + 1]) : 1;
  return Math.max(1, Number.isFinite(n) ? Math.floor(n) || 1 : 1);
}

// --- The key ----------------------------------------------------------------------------------

export class EvalKeyError extends Error {}

export interface EvalKey {
  key: string;
  usingAppKey: boolean;
  /** Set when the app's key is used: the line to print. */
  warning?: string;
}

/**
 * The key an eval spends. `EVAL_GEMINI_API_KEY` only, unless `--use-app-key` asks for the live app's
 * `GEMINI_API_KEY` (or `API_KEY`) by name. Throws, naming the variable, when there's none.
 */
export function resolveEvalKey(env: Record<string, string | undefined>, flags: Pick<EvalFlags, 'useAppKey'>): EvalKey {
  if (flags.useAppKey) {
    const app = env.GEMINI_API_KEY?.trim() || env.API_KEY?.trim();
    if (!app) throw new EvalKeyError('--use-app-key was passed but GEMINI_API_KEY is not set either, so there is no key to use.');
    return {
      key: app,
      usingAppKey: true,
      warning: `WARNING: --use-app-key spends the live app's Gemini budget (GEMINI_API_KEY). A cap hit takes futbolpedia.org's chat down. Set ${EVAL_KEY_VAR} to a key from a separate project instead.`,
    };
  }
  const key = env[EVAL_KEY_VAR]?.trim();
  if (!key) {
    throw new EvalKeyError(
      `${EVAL_KEY_VAR} is not set. Evals never use GEMINI_API_KEY, the live app's key and budget. Create a Gemini key in a separate Google project with a small spending cap, put ${EVAL_KEY_VAR}=... in .env.local (or export it), and run again. To spend the live app's budget on purpose, pass --use-app-key.`,
    );
  }
  return { key, usingAppKey: false };
}

// --- Spending limits --------------------------------------------------------------------------

/** A spending cap or a rate limit ends the run at once: nothing further is sent or retried. */
export const isSpendLimit = (message: string | undefined): boolean =>
  !!message && /\b429\b|spending cap|rate-limited|RESOURCE_EXHAUSTED|quota/i.test(message);

/** The refusal names the spending cap, as against a plain rate limit. */
export const mentionsSpendingCap = (message: string | undefined): boolean => !!message && /spending cap|spend cap|monthly spend/i.test(message);

const messageOf = (e: unknown): string => String((e as any)?.message ?? e);
const isLimitError = (e: unknown): boolean => (e as any)?.status === 429 || isSpendLimit(messageOf(e));

// --- Usage ------------------------------------------------------------------------------------

/** What a run spent, from `usageMetadata`. Output is the answer's tokens and thinking is counted apart; both bill as output. */
export interface Usage {
  /** Model calls that reached the network, failures included. */
  calls: number;
  /** Prompt tokens, plus the tokens a search tool fed back to the model. */
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Prompt tokens served from the implicit cache (already inside `inputTokens`). */
  cachedTokens: number;
  /** Grounded searches: the queries the model ran, or one for a call made only to search. */
  searches: number;
  /** Searches answered from the eval search cache: no call, no cost. */
  cacheHits: number;
}

export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, searches: 0, cacheHits: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    searches: a.searches + b.searches,
    cacheHits: a.cacheHits + b.cacheHits,
  };
}

export type UsagePhase = 'answer' | 'grade' | 'check';

export interface UsageTally {
  /** The phase new calls are filed under: the pipeline's answers, the grader models, or the cap check. */
  phase: UsagePhase;
  record(usage: Partial<Usage>): void;
  /** The usage so far, to take a difference against with `since`. */
  mark(): Usage;
  since(mark: Usage): Usage;
  /** Runs `fn` with calls filed under `phase`. */
  within<T>(phase: UsagePhase, fn: () => Promise<T>): Promise<T>;
  total(): Usage;
  byPhase(): Record<UsagePhase, Usage>;
}

export function createUsageTally(): UsageTally {
  const phases: Record<UsagePhase, Usage> = { answer: emptyUsage(), grade: emptyUsage(), check: emptyUsage() };
  const tally: UsageTally = {
    phase: 'answer',
    record(usage) {
      phases[tally.phase] = addUsage(phases[tally.phase], { ...emptyUsage(), ...usage });
    },
    mark: () => tally.total(),
    since(mark) {
      const now = tally.total();
      return {
        calls: now.calls - mark.calls,
        inputTokens: now.inputTokens - mark.inputTokens,
        outputTokens: now.outputTokens - mark.outputTokens,
        thinkingTokens: now.thinkingTokens - mark.thinkingTokens,
        cachedTokens: now.cachedTokens - mark.cachedTokens,
        searches: now.searches - mark.searches,
        cacheHits: now.cacheHits - mark.cacheHits,
      };
    },
    async within(phase, fn) {
      const before = tally.phase;
      tally.phase = phase;
      try {
        return await fn();
      } finally {
        tally.phase = before;
      }
    },
    total: () => addUsage(addUsage(phases.answer, phases.grade), phases.check),
    byPhase: () => ({ ...phases }),
  };
  return tally;
}

/** The tokens and searches of one response (or the last chunk of a stream). */
export function usageOf(res: any): Pick<Usage, 'inputTokens' | 'outputTokens' | 'thinkingTokens' | 'cachedTokens'> {
  const u = res?.usageMetadata ?? {};
  return {
    inputTokens: (Number(u.promptTokenCount) || 0) + (Number(u.toolUsePromptTokenCount) || 0),
    outputTokens: Number(u.candidatesTokenCount) || 0,
    thinkingTokens: Number(u.thoughtsTokenCount) || 0,
    cachedTokens: Number(u.cachedContentTokenCount) || 0,
  };
}

const requestTools = (req: any): any[] => (Array.isArray(req?.config?.tools) ? req.config.tools : []);
const usesSearch = (req: any): boolean => requestTools(req).some((t) => t?.googleSearch);
/** A call made only to search (a digest, a grader with search), against a chat turn whose model may or may not search. */
const searchOnly = (req: any): boolean => usesSearch(req) && !requestTools(req).some((t) => t?.functionDeclarations?.length);

function searchesIn(req: any, queries: Set<string>): number {
  if (!usesSearch(req)) return 0;
  return queries.size || (searchOnly(req) ? 1 : 0);
}

const queriesOf = (res: any, into: Set<string>) => {
  for (const q of res?.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? []) into.add(String(q));
};

// --- Instrumenting the model ------------------------------------------------------------------

export interface ModelsLike {
  generateContent: (req: any) => Promise<any>;
  generateContentStream?: (req: any) => Promise<AsyncIterable<any>>;
}

export interface StopState {
  /** Why the run stopped, once a 429 or spending-cap error came back; null while it runs. */
  reason: string | null;
}

/** The error every call throws once the run has stopped: the message holds "429", so the callers' own checks read it as a limit. */
export function stoppedError(reason: string): Error {
  const e: any = new Error(`Eval stopped, nothing sent: ${reason}`);
  e.status = 429;
  e.evalStopped = true;
  return e;
}

/**
 * Wraps the model's two request methods (the chat session's requests go through them too). Each
 * call is counted from its usage metadata. The first 429 or spending-cap error stops the run: it is
 * marked `evalStopped` (so the pipeline's own retry skips it), and every later call throws at once,
 * without reaching the network.
 */
export function instrumentModels(models: ModelsLike, tally: UsageTally, state: StopState): void {
  const generate = models.generateContent.bind(models);
  const stream = models.generateContentStream?.bind(models);

  const stop = (e: unknown) => {
    state.reason ??= `a 429 came back (${messageOf(e).slice(0, 200)})`;
    if (e && typeof e === 'object') (e as any).evalStopped = true;
  };
  const guardOpen = () => {
    if (state.reason) throw stoppedError(state.reason);
  };

  models.generateContent = async (req: any) => {
    guardOpen();
    try {
      const res = await generate(req);
      const queries = new Set<string>();
      queriesOf(res, queries);
      tally.record({ calls: 1, ...usageOf(res), searches: searchesIn(req, queries) });
      return res;
    } catch (e) {
      tally.record({ calls: 1 });
      if (isLimitError(e)) stop(e);
      throw e;
    }
  };

  if (stream) {
    models.generateContentStream = async (req: any) => {
      guardOpen();
      let inner: AsyncIterable<any>;
      try {
        inner = await stream(req);
      } catch (e) {
        tally.record({ calls: 1 });
        if (isLimitError(e)) stop(e);
        throw e;
      }
      return (async function* () {
        let last: any;
        const queries = new Set<string>();
        let failed = false;
        try {
          for await (const chunk of inner) {
            if (chunk?.usageMetadata) last = chunk;
            queriesOf(chunk, queries);
            yield chunk;
          }
        } catch (e) {
          failed = true;
          if (isLimitError(e)) stop(e);
          throw e;
        } finally {
          tally.record({ calls: 1, ...(failed ? {} : usageOf(last)), searches: searchesIn(req, queries) });
        }
      })();
    };
  }
}

// --- The cap check ----------------------------------------------------------------------------

export class EvalCapError extends Error {
  constructor(
    message: string,
    readonly kind: 'cap' | 'rate' | 'other',
  ) {
    super(message);
  }
}

/**
 * One request with `maxOutputTokens: 1`, before anything real. A spending cap or a rate limit ends
 * the run here, with that one call the only one made.
 */
export async function runCapCheck(models: Pick<ModelsLike, 'generateContent'>, model: string): Promise<void> {
  try {
    await models.generateContent({ model, contents: 'Reply with one word.', config: { maxOutputTokens: 1 } });
  } catch (e) {
    const message = messageOf(e);
    if (mentionsSpendingCap(message)) {
      throw new EvalCapError(
        `The eval project's spending cap is reached (${message.slice(0, 240)}). Nothing else was sent. Raise the cap on the eval project, or wait for it to reset, and run again.`,
        'cap',
      );
    }
    if (isLimitError(e)) {
      throw new EvalCapError(`The cap check was refused with a 429 (${message.slice(0, 240)}): a rate limit or quota is reached. Nothing else was sent. Wait, then run again.`, 'rate');
    }
    throw new EvalCapError(`The cap check failed (${message.slice(0, 240)}). Nothing else was sent. Check ${EVAL_KEY_VAR} and the network, then run again.`, 'other');
  }
}

// --- The session ------------------------------------------------------------------------------

export interface EvalSession {
  key: EvalKey;
  tally: UsageTally;
  /** Why the run stopped, when a 429 or spending-cap error did; null otherwise. */
  stopReason(): string | null;
}

export interface SessionDeps {
  env?: Record<string, string | undefined>;
  /** The model's request methods; the app's own client by default. */
  models?: ModelsLike;
  /** The model the cap check names; the app's fast model by default. */
  model?: string;
  /** The eval search cache, installed unless `--fresh-search`; the default is on disk under `.cache/eval-search/`. */
  searchCacheDir?: string;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Starts an eval: resolves the key and sets it for this process, wraps the model, installs the
 * search cache and runs the cap check. Throws `EvalKeyError` or `EvalCapError` with the message to
 * print; the caller exits on it. Call it before anything else makes a model call.
 */
export async function startEvalSession(flags: EvalFlags, root: string, deps: SessionDeps = {}): Promise<EvalSession> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.error(line));
  const key = resolveEvalKey(env, flags);
  if (key.warning) log(key.warning);
  // For this process only. Both names, so a read of either can't reach the live app's key.
  env.API_KEY = key.key;
  env.GEMINI_API_KEY = key.key;

  const ai = await import('../services/aiClient');
  const models = deps.models ?? (ai.getAi().models as unknown as ModelsLike);
  const tally = createUsageTally();
  const state: StopState = { reason: null };
  instrumentModels(models, tally, state);

  if (!flags.freshSearch) {
    const { createFileSearchCache } = await import('./eval-search-cache');
    ai.setSearchCache(
      createFileSearchCache({
        dir: deps.searchCacheDir ?? join(root, '.cache', 'eval-search'),
        now: deps.now,
        onHit: () => tally.record({ cacheHits: 1 }),
      }),
    );
  } else {
    ai.setSearchCache(null);
  }

  await tally.within('check', () => runCapCheck(models, deps.model ?? ai.FLASH_MODEL));
  return { key, tally, stopReason: () => state.reason };
}

/** Starts a session, or prints why it can't and exits: what a script does at its top. */
export async function startEvalSessionOrExit(flags: EvalFlags, root: string, deps?: SessionDeps): Promise<EvalSession> {
  try {
    return await startEvalSession(flags, root, deps);
  } catch (e) {
    if (e instanceof EvalKeyError || e instanceof EvalCapError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

// --- Reporting --------------------------------------------------------------------------------

const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** One line of usage: `12 calls, 41.3k in, 5.2k out, 3.1k thinking, 2 searches`. */
export function usageLine(u: Usage): string {
  return `${u.calls} calls, ${k(u.inputTokens)} in, ${k(u.outputTokens)} out, ${k(u.thinkingTokens)} thinking, ${u.searches} searches${u.cacheHits ? `, ${u.cacheHits} searches reused from the cache` : ''}`;
}

/** The totals every run prints at its end and writes to its report. */
export function usageTotalsText(tally: UsageTally): string {
  const p = tally.byPhase();
  return [
    `Usage (from the model's usageMetadata): ${usageLine(tally.total())}`,
    `  answers: ${usageLine(p.answer)}`,
    `  grading and checks: ${usageLine(p.grade)}`,
    `  cap check: ${usageLine(p.check)}`,
  ].join('\n');
}

/** The Markdown section for a report: totals by phase, then each answer's usage. */
export function usageSection(tally: UsageTally, answers: { label: string; usage?: Usage }[]): string {
  const p = tally.byPhase();
  const row = (name: string, u: Usage) => `| ${name} | ${u.calls} | ${u.inputTokens} | ${u.outputTokens} | ${u.thinkingTokens} | ${u.searches} | ${u.cacheHits} |`;
  const lines = [
    '## Usage',
    '',
    "Counted from each response's `usageMetadata`, not estimated. Input includes the tokens a search tool fed back to the model; thinking tokens bill as output. A reused search costs nothing.",
    '',
    '| | Calls | Input tokens | Output tokens | Thinking tokens | Searches | Searches reused |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    row('Answers', p.answer),
    row('Grading and checks', p.grade),
    row('Cap check', p.check),
    row('Total', tally.total()),
  ];
  const per = answers.filter((a) => a.usage);
  if (per.length) {
    lines.push('', '| Answer | Calls | Input tokens | Output tokens | Thinking tokens | Searches | Searches reused |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const a of per) lines.push(row(a.label, a.usage!));
  }
  return lines.join('\n');
}

/** Prints the totals and, when a limit stopped the run, says so and sets a failing exit code. */
export function finishRun(session: EvalSession): void {
  console.log(`\n${usageTotalsText(session.tally)}`);
  const stopped = session.stopReason();
  if (stopped) {
    console.error(`\nStopped early: ${stopped}. Nothing was retried. The report holds what finished.`);
    process.exitCode = 1;
  }
}
