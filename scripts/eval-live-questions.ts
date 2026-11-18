#!/usr/bin/env npx tsx
/**
 * Runs the live question set (docs/superpowers/evals/live-questions.md) through the real chat
 * pipeline and has a grader model score each answer. Users never see any of this.
 *
 * The grader reads the answer with fresh Google Search and the same live feeds the app uses (ESPN
 * match data and the Fantasy Premier League feed), and scores stale facts, invented facts, whether
 * the answer says what changed this season, and how decisive it is. The run writes a Markdown
 * report and its JSON to docs/superpowers/evals/reports/.
 *
 * It needs the network and a Gemini key, so it isn't part of `npm test`. Put GEMINI_API_KEY in
 * .env.local (or the environment), then:
 *
 *   npm run eval:live
 *   npm run eval:live -- --only 1,3,8 --label after-snapshots
 *   npm run eval:live -- --warm      # answer each question once first, so the graded run reuses today's club snapshots
 *   npm run eval:live -- --set historical   # the historical set, each question twice (--repeat 1 to run once)
 *   npm run eval:live -- --set historical --only 2,3 --repeat 1 --no-builds   # a small, cheap subset
 *   npm run eval:live -- --deep --only 1,3 --label deep   # the live set through deep mode (services/deepTurn.ts)
 *   npm run eval:live -- --stage --label stage   # the same set through the stage pipeline, whatever DEEP_BY_DEFAULT says
 *   npm run eval:live -- --conversations --only C1,C2   # the multi-turn cases, graded for conduct (scripts/eval-conversations.ts)
 *   npm run eval:live -- --deep --repeat 2 --only 4,11,1 --dry-run   # price a repeat run: calls, tokens and cost, with no call made
 *   npm run eval:live -- --deep --repeat 2 --only 4,11,1 --shared-cards --label drift   # how far deep-mode answers vary between runs
 *
 * `--repeat N` (2 or more) on the live set asks each question N times, one run after another, and
 * measures drift (scripts/eval-consistency.ts): each run on the live rubric and the range between
 * runs, one comparison per question of the judgments the runs commit to (the verdict, who starts,
 * what changed) with the contradictions listed, whether the runs looked up different things, and
 * card figures quoted (a rating, a tier or an attribute score: whether it helped the answer, and
 * whether it belonged to another version than the one discussed). `--only` keeps the order given,
 * `--max-questions K` keeps the first K, `--no-card-mentions` skips the card scoring,
 * `--shared-cards` reads the shared cards from Supabase (read-only) so cards can come into play,
 * and `--dry-run` prints the estimate (`--price-in`, `--price-out` and `--price-search` replace the
 * placeholder prices) and exits before any call or key check. A spending cap or rate limit stops the
 * run at once. The report goes to docs/superpowers/evals/reports/ with a `consistency-` prefix.
 *
 * `--conversations` runs the Conversations section of the live set: each tested turn with the turns
 * before it as history (their recorded replies, or this run's answers where none was recorded), and
 * a conduct grader (one call a turn, no search) checks what a good answer must do. A case that needs
 * a Gaffa club reads EVAL_GAFFA_CLUB=<leagueId>/<clubId> with FUTBOLPEDIA_READ_SECRET and is skipped
 * without them.
 *
 * `--deep` and `--stage` each force their path for every question the path accepts (questions
 * about the past, ratings and the like take the stage pipeline either way); with neither, a turn
 * goes where the app would send it. Each report row names the path the answer took, and a deep
 * turn that gave up and ran the stage pipeline shows its fallback reason.
 *
 * The live routes run in-process, so no server is needed. Supabase isn't loaded outside the
 * browser, so club snapshots are built fresh in memory for each run rather than read from the
 * shared table. The historical set (docs/superpowers/evals/historical-questions.md) reads the shared
 * cards from Supabase through a read-only client (`scripts/eval-history.ts`), so its answers see
 * the cards a user would, and the run never writes to the shared tables.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThinkingLevel, Type } from '@google/genai';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Setup ------------------------------------------------------------------------------------

/** Reads KEY=value lines from the env files, without overriding the environment. */
for (const file of ['.env.local', '.env']) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = argValue('--only')?.split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
const warm = args.includes('--warm');
/** `--deep`: send every question with `deep: true`, so questions about the present go through deep mode whatever DEEP_BY_DEFAULT says. */
const deep = args.includes('--deep');
/** `--stage`: send every question with `fast: true`, so it takes the stage pipeline even where deep mode would take it. */
const stage = args.includes('--stage');
if (deep && stage) {
  console.error('Pass --deep or --stage, not both.');
  process.exit(1);
}
const set = argValue('--set') === 'historical' ? 'historical' : 'live';
const repeat = Math.max(1, Number(argValue('--repeat') ?? (set === 'historical' ? 2 : 1)) || 1);
/** The live set's repeat flow: two or more runs of each question, or card scoring asked for on its own. */
const repeatFlow = set === 'live' && !args.includes('--conversations') && (repeat > 1 || args.includes('--card-mentions'));
const maxQuestions = Number(argValue('--max-questions')) || undefined;
/** `--dry-run`: print the estimate for the flags given and exit, before the key is read or anything is called. */
const dryRun = args.includes('--dry-run');
/** `--shared-cards`: read the shared cards (and stored club snapshots) from Supabase through a read-only client. */
const sharedCards = args.includes('--shared-cards');
const label = (argValue('--label') ?? (deep ? 'deep' : stage ? 'stage' : warm ? 'warm' : 'run')).replace(/[^a-z0-9-]+/gi, '-');

if (dryRun) {
  const { estimateRun, formatEstimate, readLiveQuestionsFile, selectQuestions, ASSUMED_PRICES } = await import('./eval-consistency');
  if (set === 'historical' || args.includes('--conversations') || stage) {
    console.error('--dry-run estimates the live set on the deep path (the default, or --deep). The historical set, --conversations and --stage aren\'t modelled.');
    process.exit(1);
  }
  const { deepModeRules, DEFAULT_DEEP_BUDGET, DEEP_DECLARATIONS } = await import('../services/deepTurn');
  const { buildConversationalScoutInstruction } = await import('../prompts/chatPrompt');
  const chars = buildConversationalScoutInstruction(false).length + deepModeRules(DEFAULT_DEEP_BUDGET).length + JSON.stringify(DEEP_DECLARATIONS).length;
  const picked = selectQuestions(readLiveQuestionsFile(join(root, 'docs/superpowers/evals/live-questions.md')), { only, max: maxQuestions });
  const price = (flag: string, fallback: number) => (Number.isFinite(Number(argValue(flag))) && argValue(flag) !== undefined ? Number(argValue(flag)) : fallback);
  const estimate = estimateRun({
    questions: picked.map((q) => q.n),
    repeat,
    consistency: repeat > 1,
    cardMentions: repeatFlow && !args.includes('--no-card-mentions'),
    prices: { inputPerMillion: price('--price-in', ASSUMED_PRICES.inputPerMillion), outputPerMillion: price('--price-out', ASSUMED_PRICES.outputPerMillion), perGroundedSearch: price('--price-search', ASSUMED_PRICES.perGroundedSearch) },
    sizes: { deepFixedTokens: Math.round(chars / 4) },
  });
  console.log(formatEstimate(estimate, { questions: picked.map((q) => q.n), repeat, path: 'deep mode' }));
  process.exit(0);
}

const key = process.env.GEMINI_API_KEY || process.env.API_KEY;
if (!key) {
  console.error('No Gemini key. Add GEMINI_API_KEY=... to .env.local (or export it), then run `npm run eval:live` again.');
  process.exit(1);
}
process.env.API_KEY = key;

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
  // API-Football's free plan can't read the current season; the app treats a refusal as no data.
  if (url.startsWith('/api/')) return json({ error: 'not available in the eval runner' }, 404);
  return realFetch(input, init);
}) as typeof fetch;

const { sendMessageToAI } = await import('../services/geminiService');
// `--no-builds`: read era snapshots but never build one, so a small run doesn't pay for background
// builds (two searches and a call each) that only later turns would use.
if (args.includes('--no-builds')) {
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
  /** What the turn looked up and showed, so default and deep runs compare. */
  research?: Research;
}

interface Research {
  /** The path that produced the answer: the deep loop, or the stage pipeline (also after a deep turn gave up). */
  path: 'stage' | 'deep';
  /** Set when a deep turn gave up and the stage pipeline answered: why the loop gave up. */
  fallback?: import('../services/deepTurn').DeepFallbackReason;
  /** Lookups the turn ran (live feeds, history routes, web searches, cards), snapshot builds included. */
  lookups: number;
  searches: number;
  /** Model rounds that called tools: research rounds and writer tool rounds, or deep rounds. */
  rounds: number;
  /** Deep mode only: every tool the model called, in order. */
  toolCalls?: string[];
  /** Deep mode only: why research ended. */
  stop?: string;
  /** The views the reply drew, by kind (pitch, table, comparison, ranking, card), in the order of `VIEW_KINDS`. */
  views: Record<string, number>;
  /** The gate feedback round's counts (`services/gateFeedback.ts`); absent when no round finished. */
  gateFeedback?: { flagged: number; fixed: number; dropped: number; removed: number };
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

/** The turn's research, from its perf lines and, in deep mode, the loop's own count. */
function researchOf(
  perf: string[],
  stats: import('../services/deepTurn').DeepStats | null,
  attached: import('../types').ReplyBlock[] | null,
  path: import('../services/deepTurn').PathInfo | null,
): Research {
  const lookupLines = perf.filter((l) => l.startsWith('[Perf] lookup '));
  const feedback = gateFeedbackOf(perf);
  const shown = {
    views: viewsDrawn(attached),
    ...(feedback ? { gateFeedback: feedback } : {}),
  };
  if (stats && path?.path !== 'stage') {
    return { path: 'deep', lookups: lookupLines.length, searches: lookupLines.filter((l) => l.startsWith('[Perf] lookup web_search')).length, rounds: stats.rounds, toolCalls: stats.toolCalls, stop: stats.stop, ...shown };
  }
  const researched = perf.some((l) => l.includes(' brief ('));
  const rounds = (researched ? 1 : 0) + perf.filter((l) => l.includes('research round 2')).length + perf.filter((l) => l.includes('writer tool calls')).length;
  return { path: 'stage', ...(path?.fallback ? { fallback: path.fallback } : {}), lookups: lookupLines.length, searches: lookupLines.filter((l) => l.startsWith('[Perf] lookup web_search')).length, rounds, ...shown };
}

async function ask(
  question: string,
  context: { history?: import('../types').ChatMessage[]; conversationId?: string; gaffaBag?: import('../types').GaffaContextBag } = {},
): Promise<RunResult> {
  const perf: string[] = [];
  const { log, info, warn } = console;
  console.log = (...a: unknown[]) => {
    const line = a.map(String).join(' ');
    if (line.startsWith('[Perf]')) perf.push(line);
  };
  console.info = console.warn = () => {};
  const start = Date.now();
  let firstTokenMs: number | null = null;
  let stats: import('../services/deepTurn').DeepStats | null = null;
  let attached: import('../types').ReplyBlock[] | null = null;
  let path: import('../services/deepTurn').PathInfo | null = null;
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
      ...(deep ? { deep: true } : stage ? { fast: true } : {}),
      deepDeps: { onStats: (s) => (stats = s) },
    });
    const answer = typeof reply === 'string' ? reply : `[Rated a card instead of answering: ${reply.basicInfo.name}]`;
    return { answer, firstTokenMs, totalMs: Date.now() - start, perf, research: researchOf(perf, stats, attached, path) };
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

async function grade(question: string, answer: string, today: string): Promise<{ grade: Grade | null; raw: string }> {
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

const graderCall = async (prompt: string, withSearch: boolean) => {
  const res = await getAi().models.generateContent({
    model: FLASH_MODEL,
    contents: prompt,
    config: { temperature: 0, ...(withSearch ? { tools: [{ googleSearch: {} }] } : {}), thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } },
  });
  return res.text ?? '';
};

// `--regrade <report.json>`: run a saved historical report's answers through the figure check again.
const regrade = argValue('--regrade');
if (set === 'historical' && regrade) {
  const saved = JSON.parse(readFileSync(regrade, 'utf8'));
  const { markdown, json } = await history.regradeFigures(saved, {
    grade: graderCall,
    today,
    label: `${label}-regraded`,
    model: FLASH_MODEL,
    repeat: Math.max(...saved.runs.map((r: any) => r.attempt)),
    questions: [...new Map(saved.runs.map((r: any) => [r.q.n, r.q])).values()] as any,
  });
  mkdirSync(dir, { recursive: true });
  const stamp = stampOf('historical-regraded-');
  writeFileSync(join(dir, `${stamp}.md`), markdown);
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(json, null, 2));
  console.log(`\nReport: docs/superpowers/evals/reports/${stamp}.md`);
  process.exit(0);
}

if (args.includes('--conversations')) {
  const conv = await import('./eval-conversations');
  const cases = conv.readConversations(readFileSync(join(root, 'docs/superpowers/evals/live-questions.md'), 'utf8'));
  const onlyCases = argValue('--only')?.split(',').map((x) => x.trim().toUpperCase());
  const { fetchClubContextWithSecret } = await import('../services/gaffaChatApi');
  const { mapResponseToBag } = await import('../services/gaffaContext');
  const results: import('./eval-conversations').ConversationResult[] = [];
  for (const c of cases.filter((x) => !onlyCases || onlyCases.includes(x.id.toUpperCase()))) {
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
        return { answer: r.answer, error: r.error, totalMs: r.totalMs, perf: r.perf };
      },
      grade: (prompt) => graderCall(prompt, false),
      facts: (subjects) => liveFacts({ clubs: subjects?.clubs ?? [], players: subjects?.players ?? [] }),
    });
    results.push(result);
    const checks = result.turns.flatMap((t) => t.checks ?? []);
    console.log(`${checks.filter((k) => k.met).length} of ${checks.length} checks met`);
  }
  mkdirSync(dir, { recursive: true });
  const stamp = stampOf('conversations-');
  writeFileSync(join(dir, `${stamp}.md`), conv.conversationReport(results, { today, label, model: FLASH_MODEL }));
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(results, null, 2));
  console.log(`\nReport: docs/superpowers/evals/reports/${stamp}.md`);
  process.exit(0);
}

if (set === 'historical') {
  const all = history.readQuestionTable(join(root, 'docs/superpowers/evals/historical-questions.md'));
  const picked = all.filter((q) => !only || only.includes(q.n));
  const { markdown, json } = await history.runHistoricalSet({
    questions: picked,
    pairs: history.paraphrasePairs(all).filter(([a, b]) => picked.some((q) => q.n === a) && picked.some((q) => q.n === b)),
    repeat,
    ask,
    grade: graderCall,
    today,
    label,
    model: FLASH_MODEL,
  });
  mkdirSync(dir, { recursive: true });
  const stamp = stampOf('historical-');
  writeFileSync(join(dir, `${stamp}.md`), markdown);
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(json, null, 2));
  console.log(`\nReport: docs/superpowers/evals/reports/${stamp}.md`);
  process.exit(0);
}

const questions = consistency.selectQuestions(readQuestions(), { only, max: maxQuestions });

if (repeatFlow) {
  // Each question `repeat` times, one run after another; the report is rewritten after every run.
  const stampRepeat = stampOf('consistency-');
  const cardMentions = !args.includes('--no-card-mentions');
  const path = deep ? 'the deep mode loop (`--deep`)' : stage ? 'the stage pipeline (`--stage`)' : 'the chat pipeline';
  const write = (r: import('./eval-consistency').RepeatResult) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${stampRepeat}.md`), consistency.repeatReport(r, { today, label, model: FLASH_MODEL, repeat, path, cardMentions, sharedCards }));
    writeFileSync(join(dir, `${stampRepeat}.json`), JSON.stringify({ ...r, totals: consistency.totalsOf(r) }, null, 2));
  };
  const outcome = await consistency.runRepeats({
    questions,
    repeat,
    ask: (text) => ask(text),
    gradeRubric: async (text, answer) => (await grade(text, answer, today)).grade,
    grade: (prompt) => graderCall(prompt, false),
    cardMentions,
    onUpdate: write,
  });
  write(outcome);
  console.log(`\nReport: docs/superpowers/evals/reports/${stampRepeat}.md`);
  process.exit(0);
}

const results: { q: Question; run: RunResult; grade: Grade | null; graderRaw: string }[] = [];

if (warm) {
  // Snapshots live in memory here, so a first pass stands in for the shared table's daily rows.
  for (const q of questions) {
    process.stdout.write(`Warming Q${q.n} ... `);
    const run = await ask(q.text);
    console.log(run.error ? `failed: ${run.error}` : `${(run.totalMs / 1000).toFixed(1)}s`);
  }
  await new Promise((r) => setTimeout(r, 20_000));
}

// Written after every question, so a run cut short (a crash, a spend cap) keeps what it finished.
const stamp = stampOf('');
function writeReport(): void {
const secs = (ms: number | null) => (ms === null ? '–' : (ms / 1000).toFixed(1));
const graded = results.filter((r) => r.grade);
const sum = (f: (g: Grade) => number) => graded.reduce((n, r) => n + f(r.grade!), 0);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

const report = `# Live question eval: ${today}, ${label}

Ran ${results.length} questions through the ${deep ? 'deep mode loop (`--deep`)' : stage ? 'stage pipeline (`--stage`)' : 'chat pipeline'}${warm ? ', each answered once beforehand so club snapshots were already built' : deep ? ', cold: no stored club snapshots (deep mode reads them but never builds one)' : ', cold: every club snapshot built during the run'}; ${graded.length} were graded. Graded by ${FLASH_MODEL} with Google Search and the live feeds.

The grader is the same model that writes the answers, so it can share their blind spots and misjudge facts its own search doesn't reach. Compare runs with each other rather than reading any score as absolute.

- Stale facts: ${sum((g) => g.staleFacts.length)} in total
- Invented facts: ${sum((g) => g.inventedFacts.length)} in total
- Says what changed: ${graded.filter((r) => r.grade!.saysWhatChanged === 'yes').length} of ${graded.filter((r) => r.grade!.saysWhatChanged !== 'not_needed').length} that needed it
- Mean decisiveness: ${graded.length ? (sum((g) => g.decisiveness) / graded.length).toFixed(1) : '–'} / 5
- Median first token: ${secs(median(results.map((r) => r.run.firstTokenMs).filter((x): x is number => x !== null)))} s
- Gate feedback (flagged sentences the model fixed, dropped, or lost to the second pass): ${results.reduce((n, r) => n + (r.run.research?.gateFeedback?.fixed ?? 0), 0)} fixed, ${results.reduce((n, r) => n + (r.run.research?.gateFeedback?.dropped ?? 0), 0)} dropped, ${results.reduce((n, r) => n + (r.run.research?.gateFeedback?.removed ?? 0), 0)} removed, across ${results.filter((r) => r.run.research?.gateFeedback).length} turns with a correction round. A turn with no round (nothing flagged, a spent budget, a late reply or a failed call) shows 0, 0, 0.

| # | Stale | Invented | What changed | Decisive | Hedged roles | Gaps admitted | Path | Lookups | Searches | Rounds | Views | Gate fixed | Gate dropped | Gate removed | First token (s) | Total (s) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${results
  .map((r) => {
    const x = r.run.research;
    // A turn with nothing flagged shows 0, 0, 0: no round ran. The counts are those of `[GateFeedback]`.
    const gate = x?.gateFeedback ? `${x.gateFeedback.fixed} | ${x.gateFeedback.dropped} | ${x.gateFeedback.removed}` : '0 | 0 | 0';
    const research = x ? `${x.fallback ? `deep, then stage (${x.fallback})` : x.path} | ${x.lookups} | ${x.searches} | ${x.rounds} | ${viewsLine(x.views)} | ${gate}` : '– | – | – | – | – | – | – | –';
    return r.grade
      ? `| ${r.q.n} | ${r.grade.staleFacts.length} | ${r.grade.inventedFacts.length} | ${r.grade.saysWhatChanged} | ${r.grade.decisiveness} | ${r.grade.hedgedRoles} | ${r.grade.gapsAdmitted} | ${research} | ${secs(r.run.firstTokenMs)} | ${secs(r.run.totalMs)} | ${r.grade.notes.replace(/\|/g, '/').replace(/\n/g, ' ')} |`
      : `| ${r.q.n} | – | – | – | – | – | – | ${research} | ${secs(r.run.firstTokenMs)} | ${secs(r.run.totalMs)} | ${r.run.error ? `Pipeline failed: ${r.run.error}` : 'Grading failed'} |`;
  })
  .join('\n')}

${results
  .map(
    (r) => `## ${r.q.n}. ${r.q.text}

${r.q.tests}

${r.grade?.staleFacts.length ? `Stale facts:\n${r.grade.staleFacts.map((f) => `- ${f.claim}: ${f.why}`).join('\n')}\n\n` : ''}${
      r.grade?.inventedFacts.length ? `Invented facts:\n${r.grade.inventedFacts.map((f) => `- ${f.claim}: ${f.why}`).join('\n')}\n\n` : ''
    }${r.run.research?.toolCalls ? `Deep tool calls (${r.run.research.stop}): ${r.run.research.toolCalls.join(', ') || 'none'}\n\n` : ''}<details><summary>Answer</summary>

${r.run.answer || r.run.error || '(empty)'}

</details>

<details><summary>Timing</summary>

${r.run.perf.map((l) => `    ${l}`).join('\n') || '    (no perf lines)'}

</details>
`,
  )
  .join('\n')}`;

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp}.md`), report);
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(results, null, 2));
}

for (const q of questions) {
  process.stdout.write(`Q${q.n}: ${q.text} ... `);
  const run = await ask(q.text);
  const graded = run.answer ? await grade(q.text, run.answer, today).catch((e) => ({ grade: null, raw: String(e) })) : { grade: null, raw: '' };
  results.push({ q, run, grade: graded.grade, graderRaw: graded.raw });
  console.log(
    run.error
      ? `failed: ${run.error}`
      : `${((run.firstTokenMs ?? run.totalMs) / 1000).toFixed(1)}s first token, ${(run.totalMs / 1000).toFixed(1)}s total${
          graded.grade ? `; stale ${graded.grade.staleFacts.length}, invented ${graded.grade.inventedFacts.length}, decisive ${graded.grade.decisiveness}/5` : '; grading failed'
        }`,
  );
  writeReport();
}

console.log(`\nReport: docs/superpowers/evals/reports/${stamp}.md`);
