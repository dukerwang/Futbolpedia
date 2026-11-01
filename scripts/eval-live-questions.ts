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
const key = process.env.GEMINI_API_KEY || process.env.API_KEY;
if (!key) {
  console.error('No Gemini key. Add GEMINI_API_KEY=... to .env.local (or export it), then run `npm run eval:live` again.');
  process.exit(1);
}
process.env.API_KEY = key;

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = argValue('--only')?.split(',').map((n) => Number(n.trim()));
const warm = args.includes('--warm');
const set = argValue('--set') === 'historical' ? 'historical' : 'live';
const repeat = Math.max(1, Number(argValue('--repeat') ?? (set === 'historical' ? 2 : 1)) || 1);
const label = (argValue('--label') ?? (warm ? 'warm' : 'run')).replace(/[^a-z0-9-]+/gi, '-');
const history = await import('./eval-history');
if (set === 'historical') history.installReadOnlySupabase();

interface Question {
  n: number;
  text: string;
  tests: string;
}

/** The questions table from the set's Markdown. Question 15 needs a card mention, so it's skipped. */
function readQuestions(): Question[] {
  const full = readFileSync(join(root, 'docs/superpowers/evals/live-questions.md'), 'utf8');
  // Only the questions table: the results tables further down have numbered rows too.
  const md = full.slice(full.indexOf('## Questions'), full.indexOf('## Scoring'));
  return [...md.matchAll(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/gm)]
    .map((m) => ({ n: Number(m[1]), text: m[2], tests: m[3] }))
    .filter((q) => !q.text.startsWith('@'));
}

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
  // API-Football's free plan can't read the current season; the app treats a refusal as no data.
  if (url.startsWith('/api/')) return json({ error: 'not available in the eval runner' }, 404);
  return realFetch(input, init);
}) as typeof fetch;

const { sendMessageToAI } = await import('../services/geminiService');
const { FLASH_MODEL, generateStructured, getAi } = await import('../services/aiClient');

// --- Running a question -----------------------------------------------------------------------

interface RunResult {
  answer: string;
  error?: string;
  firstTokenMs: number | null;
  totalMs: number;
  perf: string[];
}

async function ask(question: string): Promise<RunResult> {
  const perf: string[] = [];
  const { log, info, warn } = console;
  console.log = (...a: unknown[]) => {
    const line = a.map(String).join(' ');
    if (line.startsWith('[Perf]')) perf.push(line);
  };
  console.info = console.warn = () => {};
  const start = Date.now();
  let firstTokenMs: number | null = null;
  try {
    const reply = await sendMessageToAI(question, [], undefined, [], [], {
      onStreamChunk: () => {
        firstTokenMs ??= Date.now() - start;
      },
    });
    const answer = typeof reply === 'string' ? reply : `[Rated a card instead of answering: ${reply.basicInfo.name}]`;
    return { answer, firstTokenMs, totalMs: Date.now() - start, perf };
  } catch (e: any) {
    return { answer: '', error: String(e?.message ?? e), firstTokenMs, totalMs: Date.now() - start, perf };
  } finally {
    Object.assign(console, { log, info, warn });
  }
}

// --- Grading ----------------------------------------------------------------------------------

interface Grade {
  staleFacts: { claim: string; why: string }[];
  inventedFacts: { claim: string; why: string }[];
  saysWhatChanged: 'yes' | 'no' | 'not_needed';
  decisiveness: number;
  hedgedRoles: number;
  gapsAdmitted: 'yes' | 'no' | 'not_needed';
  notes: string;
}

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

if (set === 'historical') {
  const all = history.readQuestionTable(join(root, 'docs/superpowers/evals/historical-questions.md'));
  const picked = all.filter((q) => !only || only.includes(q.n));
  const { markdown, json } = await history.runHistoricalSet({
    questions: picked,
    pairs: history.paraphrasePairs(all).filter(([a, b]) => picked.some((q) => q.n === a) && picked.some((q) => q.n === b)),
    repeat,
    ask,
    grade: async (prompt, withSearch) => {
      const res = await getAi().models.generateContent({
        model: FLASH_MODEL,
        contents: prompt,
        config: { temperature: 0, ...(withSearch ? { tools: [{ googleSearch: {} }] } : {}), thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } },
      });
      return res.text ?? '';
    },
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

const questions = readQuestions().filter((q) => !only || only.includes(q.n));
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
}

const secs = (ms: number | null) => (ms === null ? '–' : (ms / 1000).toFixed(1));
const graded = results.filter((r) => r.grade);
const sum = (f: (g: Grade) => number) => graded.reduce((n, r) => n + f(r.grade!), 0);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

const report = `# Live question eval: ${today}, ${label}

Ran ${results.length} questions through the chat pipeline${warm ? ', each answered once beforehand so club snapshots were already built' : ', cold: every club snapshot built during the run'}; ${graded.length} were graded. Graded by ${FLASH_MODEL} with Google Search and the live feeds.

The grader is the same model that writes the answers, so it can share their blind spots and misjudge facts its own search doesn't reach. Compare runs with each other rather than reading any score as absolute.

- Stale facts: ${sum((g) => g.staleFacts.length)} in total
- Invented facts: ${sum((g) => g.inventedFacts.length)} in total
- Says what changed: ${graded.filter((r) => r.grade!.saysWhatChanged === 'yes').length} of ${graded.filter((r) => r.grade!.saysWhatChanged !== 'not_needed').length} that needed it
- Mean decisiveness: ${graded.length ? (sum((g) => g.decisiveness) / graded.length).toFixed(1) : '–'} / 5
- Median first token: ${secs(median(results.map((r) => r.run.firstTokenMs).filter((x): x is number => x !== null)))} s

| # | Stale | Invented | What changed | Decisive | Hedged roles | Gaps admitted | First token (s) | Total (s) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${results
  .map((r) =>
    r.grade
      ? `| ${r.q.n} | ${r.grade.staleFacts.length} | ${r.grade.inventedFacts.length} | ${r.grade.saysWhatChanged} | ${r.grade.decisiveness} | ${r.grade.hedgedRoles} | ${r.grade.gapsAdmitted} | ${secs(r.run.firstTokenMs)} | ${secs(r.run.totalMs)} | ${r.grade.notes.replace(/\|/g, '/').replace(/\n/g, ' ')} |`
      : `| ${r.q.n} | – | – | – | – | – | – | ${secs(r.run.firstTokenMs)} | ${secs(r.run.totalMs)} | ${r.run.error ? `Pipeline failed: ${r.run.error}` : 'Grading failed'} |`,
  )
  .join('\n')}

${results
  .map(
    (r) => `## ${r.q.n}. ${r.q.text}

${r.q.tests}

${r.grade?.staleFacts.length ? `Stale facts:\n${r.grade.staleFacts.map((f) => `- ${f.claim}: ${f.why}`).join('\n')}\n\n` : ''}${
      r.grade?.inventedFacts.length ? `Invented facts:\n${r.grade.inventedFacts.map((f) => `- ${f.claim}: ${f.why}`).join('\n')}\n\n` : ''
    }<details><summary>Answer</summary>

${r.run.answer || r.run.error || '(empty)'}

</details>

<details><summary>Timing</summary>

${r.run.perf.map((l) => `    ${l}`).join('\n') || '    (no perf lines)'}

</details>
`,
  )
  .join('\n')}`;

mkdirSync(dir, { recursive: true });
const stamp = stampOf('');
writeFileSync(join(dir, `${stamp}.md`), report);
writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(results, null, 2));
console.log(`\nReport: docs/superpowers/evals/reports/${stamp}.md`);
