#!/usr/bin/env npx tsx
/**
 * Runs the live question set (docs/superpowers/evals/live-questions.md) through the real chat
 * pipeline. Users never see any of this. The run writes a Markdown report and its JSON to
 * docs/superpowers/evals/reports/.
 *
 * Evals are cheap by default and can't spend the live app's Gemini budget:
 *
 *  - They read EVAL_GEMINI_API_KEY (a key from a separate Google project with a small cap) and refuse
 *    to start without it. They never fall back to GEMINI_API_KEY, the live app's key; --use-app-key
 *    is the explicit, warned way to spend it (scripts/eval-guard.ts).
 *  - Before the first real call, one request with maxOutputTokens 1. A 429 that names the spending cap
 *    ends the run with nothing else sent. A 429 or cap error during a run stops it at once, with the
 *    report so far kept and nothing retried.
 *  - Nothing is graded unless you pass --grade: without it, answers are saved for a person to read.
 *    --figure-check (historical set) lists and verifies each precise figure and implies --grade.
 *  - The historical set runs each question once (--repeat 2 for twice). Era snapshot builds are opt-in
 *    (--builds). Grounded search results are cached on disk for the day under .cache/eval-search/
 *    (--fresh-search bypasses the cache); the app never reads or writes it.
 *  - Every report and the end of every run give the real input, output and thinking tokens and the
 *    grounded searches, counted from the model's usageMetadata.
 *  - --dry-run prices any set with no key and no call, from the usage the saved reports record.
 *
 * Needs the network and EVAL_GEMINI_API_KEY (in .env.local or the environment), so it isn't part of
 * `npm test`. The smallest useful check is three targeted questions, each run once, no grader:
 *
 *   npm run eval:live -- --only 11,4,1 --shared-cards --label check
 *   npm run eval:live -- --only 11,4,1 --dry-run                      # what it would cost, no call
 *   npm run eval:live -- --only 1,3,8 --grade --label after-snapshots  # the same, scored by a grader
 *   npm run eval:live -- --warm                # answer each question once first, so the run reuses today's club snapshots
 *   npm run eval:live -- --set historical --only 2,3   # the historical set, each question once
 *   npm run eval:live -- --set historical --only 2,3 --repeat 2 --grade --figure-check   # twice, graded, figures checked
 *   npm run eval:live -- --set historical --past-mode --only 2,3   # questions about the past through the chat loop (PAST_MODE)
 *   npm run eval:live -- --stage --label stage   # the live set through the stage pipeline instead of the chat loop
 *   npm run eval:live -- --only 11 --principles --label principles   # the chat writer reads the principle set (PRINCIPLES_PROMPT)
 *   npm run eval:live -- --conversations --only C1,C2   # the multi-turn cases (--grade to score their conduct)
 *   npm run eval:live -- --repeat 2 --only 4,11,1 --grade --shared-cards --label drift   # how far the chat loop's answers vary between runs
 *
 * `--repeat N` (2 or more) on the live set asks each question N times, one run after another. With
 * --grade it measures drift (scripts/eval-consistency.ts): each run on the live rubric and the range
 * between runs, one comparison per question of the judgments the runs commit to (the verdict, who
 * starts, what changed) with the contradictions listed, and card figures quoted. Without --grade it
 * still compares what each run looked up, from the turns' own logs. `--only` keeps the order given,
 * `--max-questions K` keeps the first K, `--no-card-mentions` skips the card scoring, and
 * `--shared-cards` reads the shared cards from Supabase (read-only) so cards can come into play.
 * `--price-in`, `--price-out` and `--price-search` replace the placeholder prices in the estimate.
 *
 * `--conversations` runs the Conversations section of the live set: each tested turn with the turns
 * before it as history (their recorded replies, or this run's answers where none was recorded). With
 * --grade a conduct grader (one call a turn, no search) checks what a good answer must do. A case that
 * needs a Gaffa club reads EVAL_GAFFA_CLUB=<leagueId>/<clubId> with FUTBOLPEDIA_READ_SECRET and is
 * skipped without them.
 *
 * Without flags, a turn goes where the app would send it: a question about the present to the chat
 * loop (services/chatTurn.ts). `--stage` sends every question the loop would take to the stage
 * pipeline instead, and `--set historical --past-mode` sends questions about the past to the loop
 * (`PAST_MODE`, overridden per turn). Each report row names the path the answer took, and a chat
 * turn that gave up and ran the stage pipeline shows its fallback reason.
 *
 * The live routes run in-process, so no server is needed. Supabase isn't loaded outside the
 * browser, so club snapshots are built fresh in memory for each run rather than read from the
 * shared table. The historical set (docs/superpowers/evals/historical-questions.md) reads the shared
 * cards from Supabase through a read-only client (`scripts/eval-history.ts`), so its answers see
 * the cards a user would, and the run never writes to the shared tables.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThinkingLevel, Type } from '@google/genai';
import { finishRun, loadEnvFiles, parseEvalFlags, repeatFor, startEvalSessionOrExit, usageLine, usageSection, type EvalSession, type Usage } from './eval-guard';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Setup ------------------------------------------------------------------------------------

// KEY=value lines from the env files, without overriding the environment (EVAL_GEMINI_API_KEY goes here).
loadEnvFiles(root);
const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = argValue('--only')?.split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
const warm = args.includes('--warm');
/** `--stage`: send every question with `stage: true`, so it takes the stage pipeline even where the chat loop would take it. */
const stage = args.includes('--stage');
if (args.includes('--deep')) {
  console.error('--deep is gone: the chat loop is the default path. On the historical set, --past-mode sends questions about the past through it.');
  process.exit(1);
}
/**
 * `--principles`: send every question with `principles: true`, so the chat writer reads the principle
 * set (`PRINCIPLES_PROMPT` in prompts/chatPrompt.ts) whatever the constant says. It combines with
 * `--stage`, `--past-mode` and `--set historical`.
 */
const principlesFlag = args.includes('--principles');
/**
 * `--no-prior`: on `--set historical --past-mode`, every question starts with an empty settled-verdict
 * store, to measure the loop's own consistency. Without it, run 2 and each paraphrase read what an
 * earlier answer settled, as a later user would.
 */
const noPrior = args.includes('--no-prior');
/** `--set historical --past-mode` sends questions about the past through the chat loop (`PAST_MODE`, overridden per turn). */
const pastMode = args.includes('--past-mode') && argValue('--set') === 'historical';
if (pastMode && stage) {
  console.error('Pass --past-mode or --stage, not both.');
  process.exit(1);
}
const set = argValue('--set') === 'historical' ? 'historical' : 'live';
const flags = parseEvalFlags(args);
/** Runs of each question: one unless `--repeat N` says otherwise, on the historical set too. */
const repeat = repeatFor(args);
/** The live set's repeat flow: two or more runs of each question, or card scoring asked for on its own. */
const repeatFlow = set === 'live' && !args.includes('--conversations') && (repeat > 1 || args.includes('--card-mentions'));
const maxQuestions = Number(argValue('--max-questions')) || undefined;
/** `--shared-cards`: read the shared cards (and stored club snapshots) from Supabase through a read-only client. */
const sharedCards = args.includes('--shared-cards');
const label = (argValue('--label') ?? (pastMode ? 'past-mode' : stage ? 'stage' : warm ? 'warm' : 'run')).replace(/[^a-z0-9-]+/gi, '-');
const reportsDir = join(root, 'docs/superpowers/evals/reports');

if (flags.dryRun) {
  // Prices any set from the saved reports with no key and no call (scripts/eval-estimate.ts).
  const { formatEstimate, readLiveQuestionsFile, selectQuestions, ASSUMED_PRICES } = await import('./eval-consistency');
  const { estimateSet, readReportBaseline } = await import('./eval-estimate');
  const { researchRules, DEFAULT_RESEARCH_BUDGET, CHAT_DECLARATIONS } = await import('../services/chatTurn');
  const { buildConversationalScoutInstruction } = await import('../prompts/chatPrompt');
  const chars = buildConversationalScoutInstruction(false).length + researchRules(DEFAULT_RESEARCH_BUDGET).length + JSON.stringify(CHAT_DECLARATIONS).length;
  const price = (flag: string, fallback: number) => (Number.isFinite(Number(argValue(flag))) && argValue(flag) !== undefined ? Number(argValue(flag)) : fallback);
  const prices = { inputPerMillion: price('--price-in', ASSUMED_PRICES.inputPerMillion), outputPerMillion: price('--price-out', ASSUMED_PRICES.outputPerMillion), perGroundedSearch: price('--price-search', ASSUMED_PRICES.perGroundedSearch) };
  const common = {
    repeat,
    grade: flags.grade,
    figureCheck: flags.figureCheck,
    builds: flags.builds,
    stage,
    pastMode,
    prices,
    sizes: { chatFixedTokens: Math.round(chars / 4) },
    baseline: readReportBaseline(reportsDir),
  };
  const flagsLine = `Flags reflected: ${[flags.grade ? '--grade' : 'no --grade', flags.figureCheck ? '--figure-check' : '', `--repeat ${repeat}`, flags.builds ? '--builds' : '', stage ? '--stage' : '', pastMode ? '--past-mode' : ''].filter(Boolean).join(', ')}.`;
  const liveFile = join(root, 'docs/superpowers/evals/live-questions.md');
  if (args.includes('--conversations')) {
    const conv = await import('./eval-conversations');
    const onlyCases = argValue('--only')?.split(',').map((x) => x.trim().toUpperCase());
    const cases = conv.readConversations(readFileSync(liveFile, 'utf8')).filter((c) => !onlyCases || onlyCases.includes(c.id.toUpperCase()));
    const counts = conv.conversationTurnCounts(cases);
    const e = estimateSet({ ...common, set: 'conversations', questions: [], pairs: 0, cardMentions: false, conversationTurns: { ...counts, cases: cases.length } });
    console.log(formatEstimate(e, { questions: [], repeat: 1, path: 'the chat loop', header: `Dry run, conversations: ${cases.length} case${cases.length === 1 ? '' : 's'} (${cases.map((c) => c.id).join(', ')}), ${counts.live} turns run live, ${counts.tested} of them tested. No call is made.\n${flagsLine}`, notes: e.notes }));
  } else if (set === 'historical') {
    const hist = await import('./eval-history');
    const all = hist.readQuestionTable(join(root, 'docs/superpowers/evals/historical-questions.md'));
    const picked = all.filter((q) => !only || only.includes(q.n));
    const pairs = hist.paraphrasePairs(all).filter(([a, b]) => picked.some((q) => q.n === a) && picked.some((q) => q.n === b)).length;
    const e = estimateSet({ ...common, set: 'historical', questions: picked.map((q) => q.n), pairs, cardMentions: false });
    console.log(formatEstimate(e, { questions: picked.map((q) => q.n), repeat, path: pastMode ? 'the chat loop in past mode' : 'the stage pipeline', header: `Dry run, historical set: ${picked.length} question${picked.length === 1 ? '' : 's'} (${picked.map((q) => q.n).join(', ')}) × ${repeat} run${repeat === 1 ? '' : 's'} = ${e.turns} turns through ${pastMode ? 'the chat loop in past mode' : 'the stage pipeline'}. No call is made.\n${flagsLine}`, notes: e.notes }));
  } else {
    const picked = selectQuestions(readLiveQuestionsFile(liveFile), { only, max: maxQuestions });
    const e = estimateSet({ ...common, set: 'live', questions: picked.map((q) => q.n), pairs: 0, cardMentions: repeatFlow && !args.includes('--no-card-mentions') });
    console.log(formatEstimate(e, { questions: picked.map((q) => q.n), repeat, path: stage ? 'the stage pipeline' : 'the chat loop', header: `Dry run: ${picked.length} question${picked.length === 1 ? '' : 's'} (${picked.map((q) => q.n).join(', ')}) × ${repeat} run${repeat === 1 ? '' : 's'} = ${e.turns} turns through ${stage ? 'the stage pipeline' : 'the chat loop'}. No call is made.\n${flagsLine}`, notes: e.notes }));
  }
  process.exit(0);
}

// Everything below makes model calls: the key, the cap check and the usage count come first (scripts/eval-guard.ts).
const session: EvalSession = await startEvalSessionOrExit(flags, root);

const history = await import('./eval-history');
if (set === 'historical' || sharedCards) history.installReadOnlySupabase();

interface Question {
  n: number;
  text: string;
  tests: string;
}

const consistency = await import('./eval-consistency');
const readQuestions = (): Question[] => consistency.readLiveQuestionsFile(join(root, 'docs/superpowers/evals/live-questions.md'));

// The app's live routes, served in-process so the pipeline's relative fetches work in Node.
const { createLiveFootball } = await import('../services/liveFootball');
const realFetch = globalThis.fetch;
const live = createLiveFootball(async (url) => {
  const res = await realFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Futbolpedia-eval/3.5)', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
});
// The history routes too, kept in memory for the run (the server also keeps them on disk).
const { createHistoryFootball } = await import('../services/historyFootball');
const { getRealWorldFootballSeason } = await import('../prompts/scoutCore');
const historyStore = new Map<string, any>();
const pastSeasons = createHistoryFootball({
  getJson: async (url) => {
    const res = await realFetch(url, { headers: { 'User-Agent': 'Futbolpedia-eval/3.6 (https://github.com/dukerwang/Futbolpedia)', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  store: { get: async (k) => historyStore.get(k), set: async (k, v) => void historyStore.set(k, v) },
  currentSeasonStart: () => getRealWorldFootballSeason().seasonStartYear,
});
// Snapshot builds, which the app runs on its server; here they stay in memory for the run.
const { createSnapshotServer, inProcessGet } = await import('../services/snapshotServer');
const snapshots = createSnapshotServer({ get: inProcessGet({ live, history: pastSeasons }), db: null });
// The run's settled verdicts: an in-memory store with the server's settler in front of it, so a
// `--set historical --past-mode` run proposes and reads verdicts as the app will, and writes nothing shared.
// The settle call is a real model call (about one for each new question a run settles).
const { createVerdictSettler, memoryVerdictDb, nameFromSubject } = await import('../services/debateVerdicts');
const evalVerdicts = memoryVerdictDb();
/** What the settle route answered, in order, and the settles still running: each question reports its own. */
const settleLog: string[] = [];
const pendingSettles: Promise<void>[] = [];
/** How long a question waits for its settles before the next one starts: one check call. */
const SETTLE_WAIT_MS = 30_000;
let settlerJob: Promise<import('../services/debateVerdicts').VerdictSettler> | null = null;
const evalSettler = () =>
  (settlerJob ??= (async () => {
    const { supabase } = await import('../services/dossierCache');
    const { readCardRows, servedPool } = await import('../services/cardReview');
    const { getCardKey } = await import('../services/dossierCards');
    const { liveToolset } = await import('../services/researchTools');
    const { subjectFromTitle } = await import('../services/eraSnapshots');
    const tools = liveToolset([], inProcessGet({ live, history: pastSeasons }));
    const pool = supabase ? await readCardRows(supabase).then((rows) => servedPool(rows, Date.now())).catch(() => []) : [];
    const cards = new Map(pool.map((c) => [getCardKey(c), c] as [string, import('../types').PlayerProfile]));
    return createVerdictSettler({
      db: evalVerdicts,
      enabled: true,
      cards: async () => cards,
      async record(subject, card) {
        const outcome = subject.kind === 'club_season' ? await tools.clubSeason(nameFromSubject(subject), subject.period ?? '') : await tools.playerCareer(card?.basicInfo?.name ?? nameFromSubject(subject));
        return outcome.result ? { label: subjectFromTitle(outcome.result.label, subject.kind === 'club_season' ? 'club_season' : 'player_window'), text: outcome.result.content } : null;
      },
      async eraBuiltAt(keys) {
        if (!supabase || !keys.length) return new Map();
        const { data } = await supabase.from('era_snapshots').select('snapshot_key, built_at').in('snapshot_key', keys);
        return new Map((data ?? []).map((r: any) => [r.snapshot_key, r.built_at] as [string, string]));
      },
      log: () => {},
    });
  })());
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.startsWith('/api/live/')) {
    const u = new URL(url, 'http://local');
    const name = u.searchParams.get('name') ?? '';
    if (u.pathname === '/api/live/club') return json(await live.club(name));
    if (u.pathname === '/api/live/player') return json(await live.player(name));
    if (u.pathname === '/api/live/table') return json(await live.table(u.searchParams.get('league') ?? '', u.searchParams.get('country') ?? undefined));
  }
  if (url.startsWith('/api/history/')) {
    const u = new URL(url, 'http://local');
    if (u.pathname === '/api/history/club-season') return json(await pastSeasons.clubSeason(u.searchParams.get('club') ?? '', u.searchParams.get('season') ?? ''));
    if (u.pathname === '/api/history/player') return json(await pastSeasons.playerCareer(u.searchParams.get('name') ?? ''));
  }
  if (url.startsWith('/api/snapshots/')) {
    const u = new URL(url, 'http://local');
    const q = (k: string) => u.searchParams.get(k) ?? '';
    if (u.pathname === '/api/snapshots/club/research') return json({ research: await snapshots.clubResearch(q('club')) });
    if (u.pathname === '/api/snapshots/club') return json({ snapshot: await snapshots.club(q('club')) });
    if (u.pathname === '/api/snapshots/era') return json({ snapshot: await snapshots.era(q('kind') as 'club_season' | 'player_window', q('subject'), q('period')) });
  }
  // Settled verdicts, served in-process against the run's own in-memory store (never Supabase).
  if (url === '/api/debates/settle' || url === '/api/debates/departure') {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    if (url === '/api/debates/settle') {
      const job = evalSettler().then((s) => s.settle(body, 'eval'));
      pendingSettles.push(job.then((o) => void settleLog.push(o.unresolved ? `${o.status} (${o.unresolved})` : o.status), () => void settleLog.push('failed')));
      const outcome = await job;
      return json({ status: outcome.status });
    }
    await (await evalSettler()).depart(body, 'eval');
    return new Response(null, { status: 204 });
  }
  // API-Football's free plan can't read the current season; the app treats a refusal as no data.
  if (url.startsWith('/api/')) return json({ error: 'not available in the eval runner' }, 404);
  return realFetch(input, init);
}) as typeof fetch;

const { sendMessageToAI } = await import('../services/geminiService');
// Era snapshot builds are opt-in (`--builds`): by default a turn reads stored era snapshots and never
// builds one, so a small run doesn't pay for background builds (two searches and a call each) that
// only later turns would use. (`--no-builds` is the default now and still accepted.)
if (!flags.builds) {
  const { liveEraSnapshots } = await import('../services/eraSnapshots');
  liveEraSnapshots.get = liveEraSnapshots.stored;
}
const { FLASH_MODEL, generateStructured, getAi } = await import('../services/aiClient');

// --- Running a question -----------------------------------------------------------------------

interface RunResult {
  answer: string;
  error?: string;
  firstTokenMs: number | null;
  totalMs: number;
  perf: string[];
  /** What the turn looked up and showed, so chat loop and stage runs compare. */
  research?: Research;
  /** What the turn cost, counted from the model's usage metadata (the answer's own calls, not the grader's). */
  usage?: Usage;
}

interface Research {
  /** The path that produced the answer: the chat loop, or the stage pipeline (also after a chat turn gave up). */
  path: 'stage' | 'chat';
  /** Set when a chat turn gave up and the stage pipeline answered: why the loop gave up. */
  fallback?: import('../services/chatTurn').FallbackReason;
  /** Lookups the turn ran (live feeds, history routes, web searches, cards), snapshot builds included. */
  lookups: number;
  searches: number;
  /** Model rounds that called tools: research rounds and writer tool rounds, or the loop's rounds. */
  rounds: number;
  /** Chat loop only: every tool the model called, in order. */
  toolCalls?: string[];
  /** Chat loop only: why research ended. */
  stop?: string;
  /** The views the reply drew, by kind (pitch, table, comparison, ranking, card), in the order of `VIEW_KINDS`. */
  views: Record<string, number>;
  /** The gate feedback round's counts (`services/gateFeedback.ts`); absent when no round finished. */
  gateFeedback?: { flagged: number; fixed: number; dropped: number; removed: number };
  /** Past mode only: the turn's commitment and what it met (`TurnStats.past`). */
  past?: import('../services/chatTurn').PastStats;
  /** Past mode only: what the settle route answered for each proposal the turn made. */
  settles?: string[];
}

/** The correction round's counts from the turn's perf lines (`gate feedback: flagged 3, fixed 2, dropped 1, removed 0`). */
function gateFeedbackOf(perf: string[]): Research['gateFeedback'] {
  for (const line of perf) {
    const m = line.match(/gate feedback: flagged (\d+), fixed (\d+), dropped (\d+), removed (\d+)/);
    if (m) return { flagged: Number(m[1]), fixed: Number(m[2]), dropped: Number(m[3]), removed: Number(m[4]) };
  }
  return undefined;
}

/** The views a reply draws, which the model chooses, so the report shows what it reached for. */
const VIEW_KINDS = ['pitch', 'table', 'comparison', 'ranking', 'card'] as const;
function viewsDrawn(attached: import('../types').ReplyBlock[] | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of VIEW_KINDS) {
    const n = (attached ?? []).filter((b) => b.kind === kind && b.status === 'ready').length;
    if (n) out[kind] = n;
  }
  return out;
}

/** "1 pitch, 1 table" for the report's Views column; a dash for a reply that drew none. */
const viewsLine = (views: Record<string, number> | undefined): string =>
  Object.entries(views ?? {}).map(([kind, n]) => `${n} ${kind}`).join(', ') || '–';

/** The turn's research, from its perf lines and, in the chat loop, the loop's own count. */
function researchOf(
  perf: string[],
  stats: import('../services/chatTurn').TurnStats | null,
  attached: import('../types').ReplyBlock[] | null,
  path: import('../services/chatTurn').PathInfo | null,
): Research {
  const lookupLines = perf.filter((l) => l.startsWith('[Perf] lookup '));
  const feedback = gateFeedbackOf(perf);
  const shown = {
    views: viewsDrawn(attached),
    ...(feedback ? { gateFeedback: feedback } : {}),
  };
  if (stats && path?.path !== 'stage') {
    return {
      path: 'chat',
      lookups: lookupLines.length,
      searches: lookupLines.filter((l) => l.startsWith('[Perf] lookup web_search')).length,
      rounds: stats.rounds,
      toolCalls: stats.toolCalls,
      stop: stats.stop,
      ...shown,
      ...(stats.past ? { past: stats.past } : {}),
    };
  }
  const researched = perf.some((l) => l.includes(' brief ('));
  const rounds = (researched ? 1 : 0) + perf.filter((l) => l.includes('research round 2')).length + perf.filter((l) => l.includes('writer tool calls')).length;
  return { path: 'stage', ...(path?.fallback ? { fallback: path.fallback } : {}), lookups: lookupLines.length, searches: lookupLines.filter((l) => l.startsWith('[Perf] lookup web_search')).length, rounds, ...shown };
}

type AskContext = { history?: import('../types').ChatMessage[]; conversationId?: string; gaffaBag?: import('../types').GaffaContextBag };

/**
 * One turn through the pipeline, with what it cost. A 429 or spending-cap error that stopped the run
 * during the turn is the turn's error, so every runner's own limit check sees it.
 */
async function ask(question: string, context: AskContext = {}): Promise<RunResult> {
  const mark = session.tally.mark();
  const run = await session.tally.within('answer', () => askInner(question, context));
  const stopped = session.stopReason();
  return { ...run, usage: session.tally.since(mark), ...(stopped && !run.error ? { error: stopped } : {}) };
}

async function askInner(question: string, context: AskContext = {}): Promise<RunResult> {
  const perf: string[] = [];
  const { log, info, warn } = console;
  console.log = (...a: unknown[]) => {
    const line = a.map(String).join(' ');
    if (line.startsWith('[Perf]')) perf.push(line);
  };
  console.info = console.warn = () => {};
  const start = Date.now();
  let firstTokenMs: number | null = null;
  let stats: import('../services/chatTurn').TurnStats | null = null;
  let attached: import('../types').ReplyBlock[] | null = null;
  let path: import('../services/chatTurn').PathInfo | null = null;
  try {
    const reply = await sendMessageToAI(question, context.history ?? [], undefined, [], [], {
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context.gaffaBag ? { gaffaBag: context.gaffaBag } : {}),
      onStreamChunk: () => {
        firstTokenMs ??= Date.now() - start;
      },
      onBlocks: (blocks) => {
        attached = blocks;
      },
      onPath: (p) => {
        path = p;
      },
      ...(stage ? { stage: true } : {}),
      ...(principlesFlag ? { principles: true } : {}),
      ...(pastMode ? { pastMode: true } : {}),
      chatDeps: { onStats: (s) => (stats = s), ...(pastMode ? { verdicts: noPrior ? memoryVerdictDb() : evalVerdicts } : {}) },
    });
    const answer = typeof reply === 'string' ? reply : `[Rated a card instead of answering: ${reply.basicInfo.name}]`;
    const totalMs = Date.now() - start;
    const research = researchOf(perf, stats, attached, path);
    // A proposal is sent after the answer; wait for the store's answer (outside the timing) so the
    // next question reads what this one settled, and the report says what happened to it.
    if (pastMode) {
      const from = settleLog.length;
      await Promise.race([Promise.all(pendingSettles.splice(0)), new Promise((r) => setTimeout(r, SETTLE_WAIT_MS))]);
      research.settles = settleLog.slice(from);
    }
    return { answer, firstTokenMs, totalMs, perf, research };
  } catch (e: any) {
    return { answer: '', error: String(e?.message ?? e), firstTokenMs, totalMs: Date.now() - start, perf, research: researchOf(perf, stats, attached, path) };
  } finally {
    Object.assign(console, { log, info, warn });
  }
}

// --- Grading ----------------------------------------------------------------------------------

type Grade = import('./eval-consistency').RubricGrade;

/** The clubs and players the answer treats as current, so the grader can read their live data. */
async function subjectsOf(question: string, answer: string): Promise<{ clubs: string[]; players: string[] }> {
  try {
    const raw = await generateStructured<any>({
      task: 'routing',
      prompt: `List the football clubs (at most 3) and players (at most 4) that this question and answer discuss as they are now, by their usual names. Leave out anyone discussed only historically.\n\nQuestion: ${question}\n\nAnswer:\n${answer.slice(0, 6000)}`,
      schema: {
        type: Type.OBJECT,
        properties: { clubs: { type: Type.ARRAY, items: { type: Type.STRING } }, players: { type: Type.ARRAY, items: { type: Type.STRING } } },
        required: ['clubs', 'players'],
      },
      thinkingLevelOverride: 'low',
    });
    return { clubs: (raw?.clubs ?? []).slice(0, 3), players: (raw?.players ?? []).slice(0, 4) };
  } catch {
    return { clubs: [], players: [] };
  }
}

async function liveFacts(subjects: { clubs: string[]; players: string[] }): Promise<string> {
  const blocks = await Promise.all([
    ...subjects.clubs.map(async (c) => {
      const r = await live.club(c).catch(() => null);
      return r && 'text' in r ? r.text : `No live club data for ${c}.`;
    }),
    ...subjects.players.map(async (p) => {
      const r = await live.player(p).catch(() => null);
      return r && 'text' in r ? r.text : `No live season record for ${p} (only Premier League players are covered).`;
    }),
  ]);
  return blocks.join('\n\n');
}

const GRADE_INSTRUCTIONS = `You are grading a football analyst's answer for accuracy about the present. Use Google Search for fresh, dated sources and the live feed data given, which is current. Check every current fact in the answer: who plays for which club, who starts and where, who is injured, transfers, results, standings, managers and this season's numbers.

- staleFacts: facts that were true in an earlier season but aren't now (a departed player in the team, last season's shape, a former coach, an injured player described as playing). Give the claim and why it's stale.
- inventedFacts: facts that were never true or that no source supports. Give the claim and why.
- saysWhatChanged: "yes" when the answer explains what is different about the team or player this season and why, "no" when it describes them generically, "not_needed" for a historical or timeless question.
- decisiveness: 1 to 5, where 5 commits to clear judgments and one named player per role, and 1 hedges throughout.
- hedgedRoles: how many roles the answer fills with a list of alternatives instead of naming one player, where the evidence would have allowed one.
- gapsAdmitted: "yes" when the answer says plainly what it couldn't verify, "no" when it fills gaps with guesses, "not_needed" when it had no gaps.
- notes: one or two sentences on the answer's biggest strength and weakness.

Futbolpedia's dossier ratings (an Overall and attribute scores on a 1 to 99 scale, and rating tiers) are the app's own judgments, not facts: don't count them as stale or invented. A fact you can't confirm is invented only when your search finds nothing like it or finds it false; when sources are thin, say so in notes instead.

Reply with one JSON object with exactly these keys and nothing else.`;

const grade = (question: string, answer: string, today: string) => session.tally.within('grade', () => gradeInner(question, answer, today));

async function gradeInner(question: string, answer: string, today: string): Promise<{ grade: Grade | null; raw: string }> {
  const facts = await liveFacts(await subjectsOf(question, answer));
  const res = await getAi().models.generateContent({
    model: FLASH_MODEL,
    contents: `${GRADE_INSTRUCTIONS}\n\nToday is ${today}.\n\nLive feed data:\n${facts || 'None for this question.'}\n\nQuestion: ${question}\n\nAnswer:\n${answer}`,
    config: { temperature: 0, tools: [{ googleSearch: {} }], thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } },
  });
  const raw = res.text ?? '';
  const body = raw.match(/\{[\s\S]*\}/)?.[0];
  try {
    const g = JSON.parse(body ?? '');
    return {
      grade: {
        staleFacts: Array.isArray(g.staleFacts) ? g.staleFacts : [],
        inventedFacts: Array.isArray(g.inventedFacts) ? g.inventedFacts : [],
        saysWhatChanged: g.saysWhatChanged ?? 'no',
        decisiveness: Number(g.decisiveness) || 0,
        hedgedRoles: Number(g.hedgedRoles) || 0,
        gapsAdmitted: g.gapsAdmitted ?? 'no',
        notes: String(g.notes ?? ''),
      },
      raw,
    };
  } catch {
    return { grade: null, raw };
  }
}

// --- The run ----------------------------------------------------------------------------------

const today = new Date().toISOString().slice(0, 10);
const dir = join(root, 'docs/superpowers/evals/reports');
const stampOf = (prefix: string) => `${today}-${new Date().toISOString().slice(11, 16).replace(':', '')}-${prefix}${label}`;

const graderCall = (prompt: string, withSearch: boolean) => session.tally.within('grade', () => graderCallInner(prompt, withSearch));
const graderCallInner = async (prompt: string, withSearch: boolean) => {
  const res = await getAi().models.generateContent({
    model: FLASH_MODEL,
    contents: prompt,
    config: { temperature: 0, ...(withSearch ? { tools: [{ googleSearch: {} }] } : {}), thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } },
  });
  return res.text ?? '';
};

/** The usage section of a report, from the session's tally and each answer's own usage. */
const usageBlock = (answers: { label: string; usage?: Usage }[] = []) => usageSection(session.tally, answers);
const write = (stamp: string, markdown: string, json: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp}.md`), markdown);
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(json, null, 2));
};
const reportLine = (stamp: string) => console.log(`\nReport: docs/superpowers/evals/reports/${stamp}.md`);

// `--regrade <report.json>`: run a saved historical report's answers through the figure check again.
const regrade = argValue('--regrade');
if (set === 'historical' && regrade) {
  const saved = JSON.parse(readFileSync(regrade, 'utf8'));
  const stamp = stampOf('historical-regraded-');
  const { markdown, json } = await history.regradeFigures(saved, {
    grade: graderCall,
    stopReason: session.stopReason,
    usage: (runs: { q: { n: number }; attempt: number; run: { usage?: Usage } }[]) => usageBlock(runs.map((r) => ({ label: `Q${r.q.n}, run ${r.attempt}`, usage: r.run.usage }))),
    today,
    label: `${label}-regraded`,
    model: FLASH_MODEL,
    repeat: Math.max(...saved.runs.map((r: any) => r.attempt)),
    questions: [...new Map(saved.runs.map((r: any) => [r.q.n, r.q])).values()] as any,
  });
  write(stamp, markdown, json);
  reportLine(stamp);
  finishRun(session);
  process.exit(process.exitCode ?? 0);
}

if (args.includes('--conversations')) {
  const conv = await import('./eval-conversations');
  const cases = conv.readConversations(readFileSync(join(root, 'docs/superpowers/evals/live-questions.md'), 'utf8'));
  const onlyCases = argValue('--only')?.split(',').map((x) => x.trim().toUpperCase());
  const { fetchClubContextWithSecret } = await import('../services/gaffaChatApi');
  const { mapResponseToBag } = await import('../services/gaffaContext');
  const results: import('./eval-conversations').ConversationResult[] = [];
  const stamp = stampOf('conversations-');
  const answersOf = () => results.flatMap((r) => r.turns.map((t) => ({ label: `${r.id}, turn ${t.turn + 1}`, usage: t.run?.usage })));
  const writeConversations = () => write(stamp, conv.conversationReport(results, { today, label, model: FLASH_MODEL, graded: flags.grade, usage: usageBlock(answersOf()) }), results);
  for (const c of cases.filter((x) => !onlyCases || onlyCases.includes(x.id.toUpperCase()))) {
    if (session.stopReason()) break;
    let gaffaBag: import('../types').GaffaContextBag | undefined;
    if (c.gaffaClub) {
      const club = conv.gaffaClubFromEnv(process.env.EVAL_GAFFA_CLUB);
      const res = club && process.env.FUTBOLPEDIA_READ_SECRET ? await fetchClubContextWithSecret(club.leagueId, club.clubId).catch(() => null) : null;
      if (!res) {
        console.log(`${c.id}: skipped (it needs EVAL_GAFFA_CLUB=<leagueId>/<clubId> and FUTBOLPEDIA_READ_SECRET, for a club Gaffa can read)`);
        results.push({ id: c.id, title: c.title, skipped: 'Gaffa club not readable', turns: [] });
        continue;
      }
      gaffaBag = mapResponseToBag(res);
    }
    process.stdout.write(`${c.id}: ${c.title} ... `);
    const result = await conv.runConversation(c, {
      ask: async (message, hist, options) => {
        const r = await ask(message, { history: hist, conversationId: options.conversationId, gaffaBag });
        return { answer: r.answer, error: r.error, totalMs: r.totalMs, perf: r.perf, usage: r.usage };
      },
      ...(flags.grade
        ? {
            grade: (prompt: string) => graderCall(prompt, false),
            facts: (subjects: import('./eval-conversations').ConversationCase['subjects']) => liveFacts({ clubs: subjects?.clubs ?? [], players: subjects?.players ?? [] }),
          }
        : {}),
      stopReason: session.stopReason,
    });
    results.push(result);
    const checks = result.turns.flatMap((t) => t.checks ?? []);
    console.log(flags.grade ? `${checks.filter((k) => k.met).length} of ${checks.length} checks met` : `${result.turns.length} turns answered, not graded`);
    writeConversations();
  }
  writeConversations();
  reportLine(stamp);
  finishRun(session);
  process.exit(process.exitCode ?? 0);
}

if (set === 'historical') {
  const all = history.readQuestionTable(join(root, 'docs/superpowers/evals/historical-questions.md'));
  const picked = all.filter((q) => !only || only.includes(q.n));
  const stamp = stampOf('historical-');
  const deps = {
    questions: picked,
    pairs: history.paraphrasePairs(all).filter(([a, b]) => picked.some((q) => q.n === a) && picked.some((q) => q.n === b)),
    repeat,
    ask,
    ...(flags.grade ? { grade: graderCall } : {}),
    figureCheck: flags.figureCheck,
    stopReason: session.stopReason,
    // Rewritten after every run, so a run cut short (a crash, a spending cap) keeps what it finished.
    onUpdate: (r: { markdown: string; json: unknown }) => write(stamp, r.markdown, r.json),
    usage: (runs: { q: { n: number }; attempt: number; run: { usage?: Usage } }[]) => usageBlock(runs.map((r) => ({ label: `Q${r.q.n}, run ${r.attempt}`, usage: r.run.usage }))),
    today,
    label,
    model: FLASH_MODEL,
  };
  const { markdown, json } = await history.runHistoricalSet(deps);
  write(stamp, markdown, json);
  reportLine(stamp);
  finishRun(session);
  process.exit(process.exitCode ?? 0);
}

const questions = consistency.selectQuestions(readQuestions(), { only, max: maxQuestions });

if (repeatFlow) {
  // Each question `repeat` times, one run after another; the report is rewritten after every run.
  const stampRepeat = stampOf('consistency-');
  const cardMentions = flags.grade && !args.includes('--no-card-mentions');
  const path = stage ? 'the stage pipeline (`--stage`)' : 'the chat loop';
  const writeRepeat = (r: import('./eval-consistency').RepeatResult) =>
    write(
      stampRepeat,
      consistency.repeatReport(r, { today, label, model: FLASH_MODEL, repeat, path, cardMentions, sharedCards, graded: flags.grade, usage: usageBlock(r.runs.map((x) => ({ label: `Q${x.q.n}, run ${x.attempt}`, usage: x.run.usage }))) }),
      { ...r, totals: consistency.totalsOf(r), usage: { total: session.tally.total(), byPhase: session.tally.byPhase() } },
    );
  const outcome = await consistency.runRepeats({
    questions,
    repeat,
    ask: (text) => ask(text),
    ...(flags.grade ? { gradeRubric: async (text: string, answer: string) => (await grade(text, answer, today)).grade, grade: (prompt: string) => graderCall(prompt, false) } : {}),
    stopReason: session.stopReason,
    cardMentions,
    onUpdate: writeRepeat,
  });
  writeRepeat(outcome);
  reportLine(stampRepeat);
  finishRun(session);
  process.exit(process.exitCode ?? 0);
}

// Written after every question, so a run cut short (a crash, a spend cap) keeps what it finished.
const stamp = stampOf('');
let stoppedEarly: string | undefined;
function writeReport(results: import('./eval-plain').PlainResult<Grade, RunResult>[]): void {
  const secs = (ms: number | null) => (ms === null ? '–' : (ms / 1000).toFixed(1));
  const graded = results.filter((r) => r.grade);
  const sum = (f: (g: Grade) => number) => graded.reduce((n, r) => n + f(r.grade!), 0);
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const tokens = (u?: Usage) => (u ? `${u.inputTokens} / ${u.outputTokens + u.thinkingTokens} / ${u.searches}` : '–');
  const gateTotals = `- Gate feedback (flagged sentences the model fixed, dropped, or lost to the second pass): ${results.reduce((n, r) => n + (r.run.research?.gateFeedback?.fixed ?? 0), 0)} fixed, ${results.reduce((n, r) => n + (r.run.research?.gateFeedback?.dropped ?? 0), 0)} dropped, ${results.reduce((n, r) => n + (r.run.research?.gateFeedback?.removed ?? 0), 0)} removed, across ${results.filter((r) => r.run.research?.gateFeedback).length} turns with a correction round. A turn with no round (nothing flagged, a spent budget, a late reply or a failed call) shows 0, 0, 0.`;

  const intro = `Ran ${results.length} questions through the ${stage ? 'stage pipeline (`--stage`)' : 'chat loop'}${warm ? ', each answered once beforehand so club snapshots were already built' : stage ? ', cold: every club snapshot built during the run' : ', cold: no stored club snapshots (the chat loop reads them but never builds one)'}; ${
    flags.grade ? `${graded.length} were graded. Graded by ${FLASH_MODEL} with Google Search and the live feeds.` : 'none were graded (no `--grade`): the answers are saved below for a person to read. Pass `--grade` to have a grader model score them.'
  }${stoppedEarly ? `\n\n**Run stopped early:** ${stoppedEarly.replace(/\|/g, '/')}. Nothing was retried; the sections below cover what finished.` : ''}`;
  const stats = flags.grade
    ? `The grader is the same model that writes the answers, so it can share their blind spots and misjudge facts its own search doesn't reach. Compare runs with each other rather than reading any score as absolute.

- Stale facts: ${sum((g) => g.staleFacts.length)} in total
- Invented facts: ${sum((g) => g.inventedFacts.length)} in total
- Says what changed: ${graded.filter((r) => r.grade!.saysWhatChanged === 'yes').length} of ${graded.filter((r) => r.grade!.saysWhatChanged !== 'not_needed').length} that needed it
- Mean decisiveness: ${graded.length ? (sum((g) => g.decisiveness) / graded.length).toFixed(1) : '–'} / 5`
    : '';
  const table = `| # | Stale | Invented | What changed | Decisive | Hedged roles | Gaps admitted | Path | Lookups | Searches | Rounds | Views | Gate fixed | Gate dropped | Gate removed | First token (s) | Total (s) | Tokens in / out / searches | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${results
  .map((r) => {
    const x = r.run.research;
    // A turn with nothing flagged shows 0, 0, 0: no round ran. The counts are those of `[GateFeedback]`.
    const gate = x?.gateFeedback ? `${x.gateFeedback.fixed} | ${x.gateFeedback.dropped} | ${x.gateFeedback.removed}` : '0 | 0 | 0';
    const research = x ? `${x.fallback ? `chat, then stage (${x.fallback})` : x.path} | ${x.lookups} | ${x.searches} | ${x.rounds} | ${viewsLine(x.views)} | ${gate}` : '– | – | – | – | – | – | – | –';
    return r.grade
      ? `| ${r.q.n} | ${r.grade.staleFacts.length} | ${r.grade.inventedFacts.length} | ${r.grade.saysWhatChanged} | ${r.grade.decisiveness} | ${r.grade.hedgedRoles} | ${r.grade.gapsAdmitted} | ${research} | ${secs(r.run.firstTokenMs)} | ${secs(r.run.totalMs)} | ${tokens(r.run.usage)} | ${r.grade.notes.replace(/\|/g, '/').replace(/\n/g, ' ')} |`
      : `| ${r.q.n} | – | – | – | – | – | – | ${research} | ${secs(r.run.firstTokenMs)} | ${secs(r.run.totalMs)} | ${tokens(r.run.usage)} | ${r.run.error ? `Pipeline failed: ${r.run.error.replace(/\|/g, '/')}` : flags.grade ? 'Grading failed' : 'Not graded'} |`;
  })
  .join('\n')}`;

  const report = `# Live question eval: ${today}, ${label}

${intro}

${stats}
- Median first token: ${secs(median(results.map((r) => r.run.firstTokenMs).filter((x): x is number => x !== null)))} s
${gateTotals}

${table}

${results
  .map(
    (r) => `## ${r.q.n}. ${r.q.text}

${r.q.tests}

${r.run.usage ? `Usage: ${usageLine(r.run.usage)}.\n\n` : ''}${r.grade?.staleFacts.length ? `Stale facts:\n${r.grade.staleFacts.map((f) => `- ${f.claim}: ${f.why}`).join('\n')}\n\n` : ''}${
      r.grade?.inventedFacts.length ? `Invented facts:\n${r.grade.inventedFacts.map((f) => `- ${f.claim}: ${f.why}`).join('\n')}\n\n` : ''
    }${r.run.research?.toolCalls ? `Loop tool calls (${r.run.research.stop}): ${r.run.research.toolCalls.join(', ') || 'none'}\n\n` : ''}<details><summary>Answer</summary>

${r.run.answer || r.run.error || '(empty)'}

</details>

<details><summary>Timing</summary>

${r.run.perf.map((l) => `    ${l}`).join('\n') || '    (no perf lines)'}

</details>
`,
  )
  .join('\n')}
${usageBlock(results.map((r) => ({ label: `Q${r.q.n}`, usage: r.run.usage })))}
`;
  write(stamp, report, { results, usage: { total: session.tally.total(), byPhase: session.tally.byPhase() }, ...(stoppedEarly ? { stoppedEarly } : {}) });
}

const outcome = await (await import('./eval-plain')).runPlainSet<Grade, RunResult>({
  questions,
  warm,
  ask: (text) => ask(text),
  ...(flags.grade ? { gradeAnswer: (text: string, answer: string) => grade(text, answer, today).catch((e) => ({ grade: null, raw: String(e) })) } : {}),
  describeGrade: (g) => `stale ${g.staleFacts.length}, invented ${g.inventedFacts.length}, decisive ${g.decisiveness}/5`,
  stopReason: session.stopReason,
  onResult: writeReport,
});
stoppedEarly = outcome.stoppedEarly;
writeReport(outcome.results);
reportLine(stamp);
finishRun(session);
process.exit(process.exitCode ?? 0);
