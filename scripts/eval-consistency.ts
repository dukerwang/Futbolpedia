/**
 * The repeat-run part of the eval runner (`scripts/eval-live-questions.ts --repeat N`): ask each
 * live question several times, one run at a time, and measure how much the answers drift in
 * judgment and in quality. Pure apart from what the caller injects (the pipeline, the graders, the
 * clock), so `scripts/test-eval-consistency.ts` runs it with fakes and never calls a model. Users
 * never see any of this.
 *
 * Four measures, each in its own report section:
 *  - Spread: each run scored on the live rubric (stale and invented facts, what changed, decisive,
 *    hedged roles), then the range per question.
 *  - Consistency: one grader call per question compares the runs on the judgments they commit to
 *    (the verdict, who starts in each role, the main claim about what changed) and lists
 *    contradictions.
 *  - Lookups: whether the runs looked up different things. The tool sets come from the chat loop's
 *    tool calls and the `[Perf] lookup` lines; this is where agentic variance starts.
 *  - Card mentions: whether a reply quoted a rating, a tier or an attribute score, whether the
 *    figure helped the answer or only decorated it, and whether it quoted a version other than the
 *    one under discussion.
 *
 * `estimateRun` prices a run before it happens (`--dry-run`), so the spend is known without a call.
 */
import { readFileSync } from 'node:fs';
import { ATTRIBUTE_LABELS, RATING_TIERS } from '../constants/ratingTiers';

// --- Questions --------------------------------------------------------------------------------

export interface EvalQuestion {
  n: number;
  text: string;
  tests: string;
}

/** The questions table of the live set's Markdown. A question that starts with "@" needs a card mention, so it's skipped. */
export function readLiveQuestions(markdown: string): EvalQuestion[] {
  const start = markdown.indexOf('## Questions');
  const end = markdown.indexOf('## Scoring');
  // Only the questions table: the results tables further down have numbered rows too.
  const md = start >= 0 ? markdown.slice(start, end > start ? end : undefined) : markdown;
  return [...md.matchAll(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/gm)]
    .map((m) => ({ n: Number(m[1]), text: m[2], tests: m[3] }))
    .filter((q) => !q.text.startsWith('@'));
}

export const readLiveQuestionsFile = (path: string): EvalQuestion[] => readLiveQuestions(readFileSync(path, 'utf8'));

/**
 * The questions a run covers. `only` keeps the order it was given in, so the questions that matter
 * most run first and a run cut short still holds them; `max` then keeps the first few.
 */
export function selectQuestions(all: EvalQuestion[], options: { only?: number[]; max?: number }): EvalQuestion[] {
  const picked = options.only ? options.only.flatMap((n) => all.filter((q) => q.n === n)) : all;
  const unique = picked.filter((q, i) => picked.findIndex((p) => p.n === q.n) === i);
  return options.max && options.max > 0 ? unique.slice(0, options.max) : unique;
}

// --- Shapes -----------------------------------------------------------------------------------

/** The live rubric's grade of one answer (`scripts/eval-live-questions.ts`). */
export interface RubricGrade {
  staleFacts: { claim: string; why: string }[];
  inventedFacts: { claim: string; why: string }[];
  saysWhatChanged: 'yes' | 'no' | 'not_needed';
  decisiveness: number;
  hedgedRoles: number;
  gapsAdmitted: 'yes' | 'no' | 'not_needed';
  notes: string;
}

/** What a turn looked up, as the runner records it. */
export interface RunResearch {
  path: 'stage' | 'chat';
  fallback?: string;
  lookups: number;
  searches: number;
  rounds: number;
  /** Chat loop only: every tool the model called, in order. */
  toolCalls?: string[];
  stop?: string;
  views: Record<string, number>;
}

export interface RunResult {
  answer: string;
  error?: string;
  firstTokenMs: number | null;
  totalMs: number;
  perf: string[];
  research?: RunResearch;
}

export interface RepeatRun {
  q: EvalQuestion;
  attempt: number;
  run: RunResult;
  grade: RubricGrade | null;
  /** Null when the answer was empty or the scorer failed. */
  mentions: CardMentionScore | null;
}

// --- Lookups ----------------------------------------------------------------------------------

/** A tool the model calls to draw something, not to look something up: it costs nothing and isn't research. */
const isViewTool = (name: string) => name.startsWith('show_');

/**
 * What a run looked up: the lookup tools it called (by name, with counts) and what each looked up
 * (`tool "subject"`, from the turn's `[Perf] lookup` lines). A web search's subject is its query
 * wording, which differs between runs without the lookup being different, so searches count by
 * tool only.
 */
export interface LookupProfile {
  /** Tool name to the number of times it was called, view tools left out. */
  tools: Record<string, number>;
  /** `tool "subject"` for every lookup other than a web search, lowercased and sorted. */
  subjects: string[];
}

export function lookupProfile(run: RunResult): LookupProfile {
  const tools: Record<string, number> = {};
  for (const name of run.research?.toolCalls ?? []) {
    if (!isViewTool(name)) tools[name] = (tools[name] ?? 0) + 1;
  }
  const subjects = run.perf
    .map((l) => l.match(/^\[Perf\] lookup (\S+) "(.*)":/))
    .filter((m): m is RegExpMatchArray => !!m && m[1] !== 'web_search')
    .map((m) => `${m[1]} "${m[2].trim().toLowerCase()}"`)
    .sort();
  return { tools, subjects };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sortedKeys = (o: Record<string, number>) => Object.keys(o).sort();
const countsKey = (o: Record<string, number>) =>
  sortedKeys(o)
    .map((k) => `${k}×${o[k]}`)
    .join(', ');

export interface LookupVariance {
  n: number;
  runs: number;
  /** Every run called the same set of lookup tools. */
  sameToolSet: boolean;
  /** Same tools called the same number of times. */
  sameToolCounts: boolean;
  /** Every run looked up the same subjects (searches aside). */
  sameSubjects: boolean;
  /** Mean overlap of the runs' tool sets, 1 when they are identical. */
  toolOverlap: number;
  /** Largest gap between runs in lookups, searches and rounds. */
  lookupsRange: number;
  searchesRange: number;
  roundsRange: number;
  /** Runs that answered on another path than the first run (a chat turn that fell back to the stage pipeline). */
  pathChanges: number;
  perRun: { attempt: number; path: string; lookups: number; searches: number; rounds: number; tools: string; subjects: string[] }[];
}

const range = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

/** Whether the runs of one question looked up different things. Needs at least two runs with research. */
export function lookupVariance(n: number, runs: RepeatRun[]): LookupVariance | null {
  const withResearch = runs.filter((r) => r.run.research);
  if (withResearch.length < 2) return null;
  const profiles = withResearch.map((r) => lookupProfile(r.run));
  const sets = profiles.map((p) => sortedKeys(p.tools));
  const overlaps: number[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const union = new Set([...sets[i], ...sets[j]]).size;
      const both = sets[i].filter((x) => sets[j].includes(x)).length;
      overlaps.push(union ? both / union : 1);
    }
  }
  const pathOf = (r: RepeatRun) => (r.run.research!.fallback ? `chat, then stage (${r.run.research!.fallback})` : r.run.research!.path);
  return {
    n,
    runs: withResearch.length,
    sameToolSet: sets.every((s) => sameSet(s, sets[0])),
    sameToolCounts: profiles.every((p) => countsKey(p.tools) === countsKey(profiles[0].tools)),
    sameSubjects: profiles.every((p) => sameSet(p.subjects, profiles[0].subjects)),
    toolOverlap: overlaps.length ? overlaps.reduce((a, b) => a + b, 0) / overlaps.length : 1,
    lookupsRange: range(withResearch.map((r) => r.run.research!.lookups)),
    searchesRange: range(withResearch.map((r) => r.run.research!.searches)),
    roundsRange: range(withResearch.map((r) => r.run.research!.rounds)),
    pathChanges: withResearch.filter((r) => pathOf(r) !== pathOf(withResearch[0])).length,
    perRun: withResearch.map((r, i) => ({
      attempt: r.attempt,
      path: pathOf(r),
      lookups: r.run.research!.lookups,
      searches: r.run.research!.searches,
      rounds: r.run.research!.rounds,
      tools: countsKey(profiles[i].tools) || 'none',
      subjects: profiles[i].subjects,
    })),
  };
}

// --- Spread -----------------------------------------------------------------------------------

export interface MetricSpread {
  min: number;
  max: number;
  range: number;
  mean: number;
}

export interface QuestionSpread {
  n: number;
  graded: number;
  stale: MetricSpread;
  invented: MetricSpread;
  decisiveness: MetricSpread;
  hedgedRoles: MetricSpread;
  /** The values `saysWhatChanged` took across the runs; more than one means the runs disagree on whether the answer says what changed. */
  saysWhatChanged: string[];
}

const spreadOf = (xs: number[]): MetricSpread => ({
  min: Math.min(...xs),
  max: Math.max(...xs),
  range: range(xs),
  mean: xs.reduce((a, b) => a + b, 0) / xs.length,
});

/** The rubric's spread over one question's graded runs; null with fewer than two. */
export function questionSpread(n: number, runs: RepeatRun[]): QuestionSpread | null {
  const graded = runs.filter((r) => r.grade).map((r) => r.grade!);
  if (graded.length < 2) return null;
  return {
    n,
    graded: graded.length,
    stale: spreadOf(graded.map((g) => g.staleFacts.length)),
    invented: spreadOf(graded.map((g) => g.inventedFacts.length)),
    decisiveness: spreadOf(graded.map((g) => g.decisiveness)),
    hedgedRoles: spreadOf(graded.map((g) => g.hedgedRoles)),
    saysWhatChanged: [...new Set(graded.map((g) => g.saysWhatChanged))],
  };
}

// --- Consistency ------------------------------------------------------------------------------

export type JudgmentKind = 'verdict' | 'starter' | 'change' | 'other';
export type Agreement = 'same' | 'partly' | 'different';

export interface Contradiction {
  kind: JudgmentKind;
  about: string;
  /** What each of the runs involved said, by run number (1-based, as the prompt numbered them). */
  claims: { run: number; claim: string }[];
}

export interface ConsistencyCheck {
  agreement: Agreement;
  /** Committed judgments the grader found in the answers and compared. */
  compared: number;
  contradictions: Contradiction[];
  summary: string;
}

export const CONSISTENCY_INSTRUCTIONS = `Several answers to the same football question follow, each from a separate run. Compare the judgments they commit to, and nothing else: the verdict (who or what the answer picks, or the order of a ranking), who starts in each role, and the main claim about what changed this season. Ignore wording, length, detail, formatting and the supporting evidence.

For each judgment that at least two answers commit to, say whether the answers that commit to it agree. A judgment only one answer makes isn't a contradiction. An answer that names an alternative for a role, while naming the same first choice, agrees on who starts. Two answers contradict when they pick different players or sides, order a ranking differently at the top, give a different formation or shape as the base, or explain what changed in ways that can't both hold.

Reply with one JSON object and nothing else:
{"agreement": "same" | "partly" | "different", "compared": <number of judgments compared>, "contradictions": [{"kind": "verdict" | "starter" | "change", "about": "<the judgment, a few words>", "claims": [{"run": <number>, "claim": "<what that run said, a few words>"}]}], "summary": "<one sentence>"}
"same" means no contradiction, "partly" means contradictions on secondary judgments only, "different" means the runs disagree on the main verdict.`;

export function consistencyPrompt(question: string, answers: { run: number; answer: string }[]): string {
  return `${CONSISTENCY_INSTRUCTIONS}\n\nQuestion: ${question}\n\n${answers.map((a) => `Run ${a.run}:\n${a.answer}`).join('\n\n')}`;
}

const KINDS: JudgmentKind[] = ['verdict', 'starter', 'change', 'other'];

/**
 * The grader's comparison, checked: a contradiction needs two claims from different runs among the
 * runs that were compared, and an agreement of "same" beside a listed contradiction is "partly".
 * Null when the reply can't be read.
 */
export function parseConsistency(raw: string, runCount: number): ConsistencyCheck | null {
  const body = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!body) return null;
  let g: any;
  try {
    g = JSON.parse(body);
  } catch {
    return null;
  }
  if (!['same', 'partly', 'different'].includes(g?.agreement)) return null;
  const contradictions: Contradiction[] = (Array.isArray(g.contradictions) ? g.contradictions : [])
    .map((c: any): Contradiction => {
      const claims = (Array.isArray(c?.claims) ? c.claims : [])
        .map((x: any) => ({ run: Number(x?.run), claim: String(x?.claim ?? '').trim() }))
        .filter((x: { run: number; claim: string }) => Number.isInteger(x.run) && x.run >= 1 && x.run <= runCount && x.claim);
      return { kind: KINDS.includes(c?.kind) ? c.kind : 'other', about: String(c?.about ?? '').trim(), claims };
    })
    .filter((c: Contradiction) => new Set(c.claims.map((x) => x.run)).size >= 2);
  let agreement: Agreement = g.agreement;
  if (contradictions.length && agreement === 'same') agreement = 'partly';
  const compared = Math.max(contradictions.length, Math.max(0, Math.floor(Number(g.compared) || 0)));
  return { agreement, compared, contradictions, summary: String(g.summary ?? '').trim() };
}

// --- Card mentions ----------------------------------------------------------------------------

export type MentionKind = 'rating' | 'tier' | 'attribute';
export type MentionVersion = 'current' | 'prime' | 'era' | 'season' | 'unstated';
export type DiscussedVersion = 'current' | 'prime' | 'era' | 'season' | 'all-time' | 'none';

export interface CardMention {
  quote: string;
  kind: MentionKind;
  /** The version of the player the figure belongs to, as the reply or its context makes clear. */
  version: MentionVersion;
  /** The version the reply is discussing when it quotes the figure. */
  discussed: DiscussedVersion;
  /** The figure carries part of the argument, against decoration that restates a point or ornaments a name. */
  helped: boolean;
  /** Version quoted is not the version discussed (set by code, `versionMismatch`). */
  wrongVersion: boolean;
  why: string;
}

export interface CardMentionScore {
  /** Sentences the cheap scan found that might quote a card; no grader call happens without one. */
  candidates: number;
  mentions: CardMention[];
  helped: number;
  decoration: number;
  wrongVersion: number;
  byKind: Record<MentionKind, number>;
}

/**
 * Whether a figure belongs to a version other than the one the reply discusses. A figure with no
 * stated version, or a reply with no version in view, can't be wrong. An all-time discussion
 * accepts a prime, era or season figure and rejects current form, the version most prone to
 * drifting into a debate about careers.
 */
export function versionMismatch(version: MentionVersion, discussed: DiscussedVersion): boolean {
  if (version === 'unstated' || discussed === 'none') return false;
  if (discussed === 'all-time') return version === 'current';
  return version !== discussed;
}

const tierWords = [...new Set(RATING_TIERS.flatMap((t) => [t.label, t.shortLabel]))].filter((w) => w.length >= 6);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CARD_PATTERNS: RegExp[] = [
  /\b(overall|potential|rating|rated|ovr)\b[^.\n]{0,40}\b(?:[4-9]\d)\b/i,
  /\b(?:[4-9]\d)\s*(?:\/\s*99|ovr|overall|rating)\b/i,
  /\bfutbolpedia\b[^.\n]{0,60}\b(?:[4-9]\d)\b/i,
  new RegExp(`\\b(?:${tierWords.map(escapeRe).join('|')})\\b[^.\\n]{0,20}\\b(?:tier|band|bracket|status)\\b|\\b(?:tier|band|bracket)\\b[^.\\n]{0,30}\\b(?:${tierWords.map(escapeRe).join('|')})\\b`, 'i'),
  new RegExp(`\\b(?:${Object.values(ATTRIBUTE_LABELS).map(escapeRe).join('|')})\\b[^.\\n]{0,24}\\b(?:[4-9]\\d)\\b(?!\\s*(?:%|minutes|mins|goals|games|matches|appearances))`, 'i'),
];

/** Sentences of an answer that might quote a card's rating, tier or attribute. A cheap scan: the grader decides what they are. */
export function findCardCandidates(answer: string): string[] {
  return answer
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s && CARD_PATTERNS.some((re) => re.test(s)));
}

export const CARD_MENTION_INSTRUCTIONS = `You are reading a football analyst's answer for places where it quotes one of Futbolpedia's own player cards: an Overall or Potential rating, a rating tier (a band name such as World-Class or Quality Starter), or an attribute score (a number out of 99 for a skill such as passing or finishing). Statistics, fees, minutes, table positions and results are not card figures. A card belongs to one version of a player: current form, prime, a named era, or a named season.

For every card figure in the answer, give:
- quote: the words that quote it, as written.
- kind: "rating", "tier" or "attribute".
- version: which version of the player the figure belongs to, judged from the answer's wording around it: "current", "prime", "era", "season", or "unstated" when the answer doesn't say.
- discussed: which version of the player the answer is discussing at that point: "current" (this season or now), "prime", "era", "season", "all-time" (a comparison across careers or eras, or who was best ever), or "none" when it isn't about any version.
- helped: true when the figure carries part of the argument (it separates two players, supports a verdict or a ranking, or the point depends on it); false when it is decoration (a rating in brackets after a name, a figure that restates a point already made in words, attribute scores listed without being used).
- why: one short sentence.

If the answer quotes no card figure, return an empty list. Reply with one JSON object and nothing else: {"mentions": [{"quote": "...", "kind": "...", "version": "...", "discussed": "...", "helped": true or false, "why": "..."}]}`;

export const cardMentionPrompt = (question: string, answer: string, candidates: string[]): string =>
  `${CARD_MENTION_INSTRUCTIONS}\n\nQuestion: ${question}\n\nSentences a scan flagged as possible card figures (there may be others, or none):\n${candidates.map((c) => `- ${c}`).join('\n')}\n\nAnswer:\n${answer}`;

const MENTION_KINDS: MentionKind[] = ['rating', 'tier', 'attribute'];
const VERSIONS: MentionVersion[] = ['current', 'prime', 'era', 'season', 'unstated'];
const DISCUSSED: DiscussedVersion[] = ['current', 'prime', 'era', 'season', 'all-time', 'none'];

const emptyScore = (candidates: number): CardMentionScore => ({
  candidates,
  mentions: [],
  helped: 0,
  decoration: 0,
  wrongVersion: 0,
  byKind: { rating: 0, tier: 0, attribute: 0 },
});

/** The grader's mentions, checked and scored; null when the reply can't be read. */
export function parseCardMentions(raw: string, candidates: number): CardMentionScore | null {
  const body = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!body) return null;
  let g: any;
  try {
    g = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(g?.mentions)) return null;
  const score = emptyScore(candidates);
  for (const m of g.mentions) {
    const quote = String(m?.quote ?? '').trim();
    if (!quote || !MENTION_KINDS.includes(m?.kind)) continue;
    const version: MentionVersion = VERSIONS.includes(m?.version) ? m.version : 'unstated';
    const discussed: DiscussedVersion = DISCUSSED.includes(m?.discussed) ? m.discussed : 'none';
    const mention: CardMention = {
      quote,
      kind: m.kind,
      version,
      discussed,
      helped: m?.helped === true,
      wrongVersion: versionMismatch(version, discussed),
      why: String(m?.why ?? '').trim(),
    };
    score.mentions.push(mention);
    score.byKind[mention.kind]++;
    if (mention.helped) score.helped++;
    else score.decoration++;
    if (mention.wrongVersion) score.wrongVersion++;
  }
  return score;
}

/**
 * Scores one answer. The scan runs first and a grader call follows only when it found a candidate,
 * so answers that never touch a card cost nothing here. Null when the grader's reply can't be read.
 */
export async function scoreCardMentions(
  question: string,
  answer: string,
  grade: (prompt: string) => Promise<string>,
): Promise<CardMentionScore | null> {
  const candidates = findCardCandidates(answer);
  if (!candidates.length) return emptyScore(0);
  const raw = await grade(cardMentionPrompt(question, answer, candidates)).catch(() => '');
  return parseCardMentions(raw, candidates.length);
}

// --- The run ----------------------------------------------------------------------------------

/** A spending cap or a rate limit ends the run at once: nothing further is retried. */
export const isSpendLimit = (message: string | undefined): boolean =>
  !!message && /\b429\b|spending cap|rate-limited|RESOURCE_EXHAUSTED|quota/i.test(message);

export interface QuestionConsistency {
  n: number;
  /** Null when fewer than two runs had an answer, or the grader's reply couldn't be read. */
  check: ConsistencyCheck | null;
  note?: string;
}

export interface RepeatResult {
  runs: RepeatRun[];
  consistency: QuestionConsistency[];
  /** Why the run stopped before covering every question and run, when it did. */
  stoppedEarly?: string;
}

export interface RepeatDeps {
  questions: EvalQuestion[];
  repeat: number;
  /** One turn through the pipeline, in a new conversation. Called one at a time, never in parallel. */
  ask: (question: string) => Promise<RunResult>;
  /** The live rubric's grade of one answer. */
  gradeRubric: (question: string, answer: string) => Promise<RubricGrade | null>;
  /** One grader call without search: the prompt in, the model's text out. */
  grade: (prompt: string) => Promise<string>;
  /** Score card mentions (default on). */
  cardMentions?: boolean;
  /** Called after every run and every comparison, so a caller can write the report as the run goes. */
  onUpdate?: (result: RepeatResult) => void;
  log?: (line: string) => void;
}

/**
 * Asks each question `repeat` times, one run after another, and question by question, so a run cut
 * short leaves whole sets of runs for the first questions rather than one run of all of them. Each
 * answer is graded on the rubric and scored for card mentions; once a question's runs are in, one
 * grader call compares them. A spending cap or rate limit stops everything and keeps what finished.
 */
export async function runRepeats(deps: RepeatDeps): Promise<RepeatResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const result: RepeatResult = { runs: [], consistency: [] };
  const update = () => deps.onUpdate?.(result);
  outer: for (const q of deps.questions) {
    for (let attempt = 1; attempt <= deps.repeat; attempt++) {
      const run = await deps.ask(q.text);
      if (isSpendLimit(run.error)) {
        result.stoppedEarly = `Q${q.n}, run ${attempt}: ${run.error}`;
        log(`Q${q.n} (run ${attempt}): stopped, ${run.error}`);
        break outer;
      }
      let grade: RubricGrade | null = null;
      let mentions: CardMentionScore | null = null;
      if (run.answer) {
        try {
          grade = await deps.gradeRubric(q.text, run.answer);
        } catch (e: any) {
          if (isSpendLimit(String(e?.message ?? e))) {
            result.runs.push({ q, attempt, run, grade: null, mentions: null });
            result.stoppedEarly = `Q${q.n}, run ${attempt}: grader ${e?.message ?? e}`;
            update();
            break outer;
          }
        }
        if (deps.cardMentions !== false) mentions = await scoreCardMentions(q.text, run.answer, deps.grade).catch(() => null);
      }
      result.runs.push({ q, attempt, run, grade, mentions });
      const x = run.research;
      log(
        `Q${q.n} (run ${attempt} of ${deps.repeat}): ${
          run.error
            ? `failed: ${run.error}`
            : `${((run.totalMs) / 1000).toFixed(1)}s${x ? `, ${x.lookups} lookups, ${x.searches} searches, ${x.rounds} rounds` : ''}${
                grade ? `; stale ${grade.staleFacts.length}, invented ${grade.inventedFacts.length}, decisive ${grade.decisiveness}/5` : '; grading failed'
              }${mentions ? `; card figures ${mentions.mentions.length}` : ''}`
        }`,
      );
      update();
    }
    const answered = result.runs.filter((r) => r.q.n === q.n && r.run.answer);
    if (answered.length >= 2) {
      const raw = await deps
        .grade(consistencyPrompt(q.text, answered.map((r, i) => ({ run: i + 1, answer: r.run.answer }))))
        .catch((e) => `grader failed: ${e?.message ?? e}`);
      const check = parseConsistency(raw, answered.length);
      result.consistency.push({ n: q.n, check, ...(check ? {} : { note: 'comparison failed' }) });
      log(`Q${q.n}: ${check ? `${check.agreement}, ${check.contradictions.length} contradictions in ${check.compared} judgments` : 'comparison failed'}`);
    } else {
      result.consistency.push({ n: q.n, check: null, note: 'fewer than two answers' });
    }
    update();
  }
  return result;
}

// --- Report -----------------------------------------------------------------------------------

const cell = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
const secs = (ms: number | null) => (ms === null ? '–' : (ms / 1000).toFixed(1));
const spanOf = (m: MetricSpread) => (m.min === m.max ? `${m.min}` : `${m.min}–${m.max}`);
const viewsLine = (views: Record<string, number> | undefined) => Object.entries(views ?? {}).map(([k, n]) => `${n} ${k}`).join(', ') || '–';

export interface RepeatTotals {
  questions: number;
  /** Questions with a consistency check. */
  compared: number;
  same: number;
  partly: number;
  different: number;
  contradictions: number;
  judgments: number;
  toolSetsDiffer: number;
  toolCountsDiffer: number;
  subjectsDiffer: number;
  withLookups: number;
  meanStaleRange: number;
  meanInventedRange: number;
  meanDecisiveRange: number;
  maxDecisiveRange: number;
  /** Questions where the runs disagreed on whether the answer says what changed. */
  whatChangedDiffers: number;
  runsWithCardFigures: number;
  runsScored: number;
  cardFigures: number;
  helped: number;
  decoration: number;
  wrongVersion: number;
  /** Questions where some runs quoted a card figure and others none. */
  mentionBehaviourDiffers: number;
}

export function totalsOf(result: RepeatResult): RepeatTotals {
  const numbers = [...new Set(result.runs.map((r) => r.q.n))];
  const byQ = (n: number) => result.runs.filter((r) => r.q.n === n);
  const spreads = numbers.map((n) => questionSpread(n, byQ(n))).filter((s): s is QuestionSpread => !!s);
  const variances = numbers.map((n) => lookupVariance(n, byQ(n))).filter((v): v is LookupVariance => !!v);
  const checks = result.consistency.filter((c) => c.check);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const scored = result.runs.filter((r) => r.mentions);
  const sum = (f: (m: CardMentionScore) => number) => scored.reduce((n, r) => n + f(r.mentions!), 0);
  const mentionBehaviour = numbers.filter((n) => {
    const s = byQ(n).filter((r) => r.mentions);
    return s.length >= 2 && s.some((r) => r.mentions!.mentions.length > 0) && s.some((r) => r.mentions!.mentions.length === 0);
  });
  return {
    questions: numbers.length,
    compared: checks.length,
    same: checks.filter((c) => c.check!.agreement === 'same').length,
    partly: checks.filter((c) => c.check!.agreement === 'partly').length,
    different: checks.filter((c) => c.check!.agreement === 'different').length,
    contradictions: checks.reduce((n, c) => n + c.check!.contradictions.length, 0),
    judgments: checks.reduce((n, c) => n + c.check!.compared, 0),
    toolSetsDiffer: variances.filter((v) => !v.sameToolSet).length,
    toolCountsDiffer: variances.filter((v) => !v.sameToolCounts).length,
    subjectsDiffer: variances.filter((v) => !v.sameSubjects).length,
    withLookups: variances.length,
    meanStaleRange: mean(spreads.map((s) => s.stale.range)),
    meanInventedRange: mean(spreads.map((s) => s.invented.range)),
    meanDecisiveRange: mean(spreads.map((s) => s.decisiveness.range)),
    maxDecisiveRange: Math.max(0, ...spreads.map((s) => s.decisiveness.range)),
    whatChangedDiffers: spreads.filter((s) => s.saysWhatChanged.length > 1).length,
    runsWithCardFigures: scored.filter((r) => r.mentions!.mentions.length > 0).length,
    runsScored: scored.length,
    cardFigures: sum((m) => m.mentions.length),
    helped: sum((m) => m.helped),
    decoration: sum((m) => m.decoration),
    wrongVersion: sum((m) => m.wrongVersion),
    mentionBehaviourDiffers: mentionBehaviour.length,
  };
}

/** The report's Markdown for a repeat run, written after every run so a run cut short keeps what it finished. */
export function repeatReport(result: RepeatResult, meta: { today: string; label: string; model: string; repeat: number; path: string; cardMentions: boolean; sharedCards: boolean }): string {
  const t = totalsOf(result);
  const numbers = [...new Set(result.runs.map((r) => r.q.n))];
  const byQ = (n: number) => result.runs.filter((r) => r.q.n === n);
  const q = (n: number) => byQ(n)[0].q;
  const f1 = (x: number) => x.toFixed(1);
  const lines: string[] = [
    `# Consistency eval: ${meta.today}, ${meta.label}`,
    '',
    `Asked ${t.questions} question${t.questions === 1 ? '' : 's'} up to ${meta.repeat} times each through ${meta.path}, one run at a time, each in a new chat${meta.sharedCards ? ', with the shared cards read from Supabase' : ', with no shared cards (the live set reads none unless `--shared-cards` is passed)'}. Each answer was graded on the live rubric by ${meta.model} with Google Search and the live feeds; the runs of each question were then compared by one call without search${meta.cardMentions ? ', and each answer was scored for card figures' : ''}.`,
    '',
    'The grader is the same model that writes the answers, so it can share their blind spots. Compare runs with each other rather than reading any score as absolute. A repeat shows how far the model varies when nothing else changes: the process keeps its live-feed caches between runs, so the feeds hold still.',
    '',
  ];
  if (result.stoppedEarly) lines.push(`**Run stopped early:** ${cell(result.stoppedEarly)}. Nothing was retried; the sections below cover what finished.`, '');
  lines.push(
    '## Summary',
    '',
    `- Same judgments across runs: ${t.same} same, ${t.partly} partly, ${t.different} different, of ${t.compared} questions compared`,
    `- Contradictions: ${t.contradictions} in ${t.judgments} judgments compared`,
    `- Different lookup tools between runs: ${t.toolSetsDiffer} of ${t.withLookups} questions (different call counts: ${t.toolCountsDiffer}; different subjects: ${t.subjectsDiffer})`,
    `- Mean range between runs: stale facts ${f1(t.meanStaleRange)}, invented facts ${f1(t.meanInventedRange)}, decisiveness ${f1(t.meanDecisiveRange)} (largest ${t.maxDecisiveRange})`,
    `- Runs that disagree on whether the answer says what changed: ${t.whatChangedDiffers} questions`,
  );
  if (meta.cardMentions) {
    lines.push(
      `- Card figures: ${t.cardFigures} in ${t.runsWithCardFigures} of ${t.runsScored} answers; ${t.helped} helped the answer, ${t.decoration} decorated it, ${t.wrongVersion} quoted a version other than the one discussed`,
      `- Questions where one run quoted a card and another didn't: ${t.mentionBehaviourDiffers}`,
    );
  }
  lines.push('', '## Spread', '', 'Each run graded on the live rubric; a cell shows the lowest and highest value across the runs, with the range in brackets.', '', '| # | Runs graded | Stale | Invented | Decisive | Hedged roles | What changed |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const n of numbers) {
    const s = questionSpread(n, byQ(n));
    lines.push(
      s
        ? `| ${n} | ${s.graded} | ${spanOf(s.stale)} (${s.stale.range}) | ${spanOf(s.invented)} (${s.invented.range}) | ${spanOf(s.decisiveness)} (${s.decisiveness.range}) | ${spanOf(s.hedgedRoles)} (${s.hedgedRoles.range}) | ${s.saysWhatChanged.join(' / ')} |`
        : `| ${n} | ${byQ(n).filter((r) => r.grade).length} | – | – | – | – | – |`,
    );
  }
  lines.push('', '## Consistency', '', '| # | Agreement | Judgments compared | Contradictions | Summary |', '| --- | --- | --- | --- | --- |');
  for (const c of result.consistency) {
    lines.push(c.check ? `| ${c.n} | ${c.check.agreement} | ${c.check.compared} | ${c.check.contradictions.length} | ${cell(c.check.summary)} |` : `| ${c.n} | – | – | – | ${c.note ?? 'not compared'} |`);
  }
  const listed = result.consistency.filter((c) => c.check?.contradictions.length);
  if (listed.length) {
    lines.push('', '### Contradictions', '');
    for (const c of listed) {
      for (const x of c.check!.contradictions) {
        lines.push(`- Q${c.n}, ${x.kind}, ${cell(x.about)}: ${x.claims.map((k) => `run ${k.run} said ${cell(k.claim)}`).join('; ')}`);
      }
    }
  }
  lines.push('', '## Lookups', '', 'Tools the model called in each run (views left out), from the chat loop; the subject column lists what non-search lookups were about.', '', '| # | Run | Path | Lookups | Searches | Rounds | Tools | Subjects |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const n of numbers) {
    const v = lookupVariance(n, byQ(n));
    if (v) {
      for (const r of v.perRun) lines.push(`| ${n} | ${r.attempt} | ${r.path} | ${r.lookups} | ${r.searches} | ${r.rounds} | ${cell(r.tools)} | ${cell(r.subjects.join('; ')) || '–'} |`);
      lines.push(`| ${n} | | ${v.sameToolSet ? 'same tools' : 'different tools'}${v.sameToolSet && !v.sameToolCounts ? ', different counts' : ''}${v.sameSubjects ? '' : ', different subjects'} | ${v.lookupsRange} | ${v.searchesRange} | ${v.roundsRange} | overlap ${f1(v.toolOverlap)} | ${v.pathChanges ? `${v.pathChanges} changed path` : ''} |`);
    } else {
      for (const r of byQ(n)) lines.push(`| ${n} | ${r.attempt} | ${r.run.research?.path ?? '–'} | ${r.run.research?.lookups ?? '–'} | ${r.run.research?.searches ?? '–'} | ${r.run.research?.rounds ?? '–'} | – | – |`);
    }
  }
  if (meta.cardMentions) {
    lines.push('', '## Card Mentions', '', 'A card figure is a rating, a tier or an attribute score from Futbolpedia\'s own cards. Helped means the figure carried part of the argument; wrong version means it belonged to another version of the player than the one under discussion.', '', '| # | Run | Figures | Ratings | Tiers | Attributes | Helped | Decoration | Wrong version | Views |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of result.runs) {
      const m = r.mentions;
      lines.push(m ? `| ${r.q.n} | ${r.attempt} | ${m.mentions.length} | ${m.byKind.rating} | ${m.byKind.tier} | ${m.byKind.attribute} | ${m.helped} | ${m.decoration} | ${m.wrongVersion} | ${viewsLine(r.run.research?.views)} |` : `| ${r.q.n} | ${r.attempt} | – | – | – | – | – | – | – | ${viewsLine(r.run.research?.views)} |`);
    }
    const quoted = result.runs.filter((r) => r.mentions?.mentions.length);
    if (quoted.length) {
      lines.push('', '### Figures Quoted', '');
      for (const r of quoted) {
        for (const m of r.mentions!.mentions) {
          lines.push(`- Q${r.q.n}, run ${r.attempt}, ${m.kind} (${m.version}, discussing ${m.discussed}), ${m.helped ? 'helped' : 'decoration'}${m.wrongVersion ? ', wrong version' : ''}: "${cell(m.quote)}". ${cell(m.why)}`);
        }
      }
    }
  }
  lines.push('', '## Answers', '');
  for (const n of numbers) {
    lines.push(`### ${n}. ${q(n).text}`, '', q(n).tests, '');
    for (const r of byQ(n)) {
      lines.push(
        `#### Run ${r.attempt}${r.run.research?.toolCalls ? `, tools: ${r.run.research.toolCalls.join(', ') || 'none'}` : ''}`,
        '',
        r.grade ? `Stale ${r.grade.staleFacts.length}, invented ${r.grade.inventedFacts.length}, decisive ${r.grade.decisiveness}/5, hedged roles ${r.grade.hedgedRoles}, what changed ${r.grade.saysWhatChanged}, first token ${secs(r.run.firstTokenMs)} s, total ${secs(r.run.totalMs)} s. ${cell(r.grade.notes)}` : `${r.run.error ? `Pipeline failed: ${cell(r.run.error)}` : 'Grading failed'}`,
        '',
        '<details><summary>Answer</summary>',
        '',
        r.run.answer || r.run.error || '(empty)',
        '',
        '</details>',
        '',
      );
    }
  }
  return lines.join('\n');
}

// --- Estimate ---------------------------------------------------------------------------------

/**
 * Prices in US dollars per million tokens, and per grounded search. The model profiles carry no
 * prices, so these are placeholders to be confirmed against the project's billing page: pass
 * `--price-in`, `--price-out` and `--price-search` (or edit this table) before relying on the
 * dollar figure. The token counts don't depend on them.
 */
export interface Prices {
  inputPerMillion: number;
  outputPerMillion: number;
  /** One grounded search call, on top of its tokens. */
  perGroundedSearch: number;
}

export const ASSUMED_PRICES: Prices = { inputPerMillion: 0.5, outputPerMillion: 3, perGroundedSearch: 0.014 };

export interface EstimateComponent {
  name: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls that use Google Search grounding. */
  grounded: number;
}

export interface EstimateTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  grounded: number;
  usd: number;
}

export interface Estimate {
  expected: { components: EstimateComponent[]; total: EstimateTotals };
  /** Every chat turn spending its whole budget: the most the run can cost on the chat loop. */
  ceiling: { components: EstimateComponent[]; total: EstimateTotals };
  turns: number;
  controlTurns: number;
  prices: Prices;
}

/** Sizes that come from the repo's real prompts (`promptSizes` in the runner) so the estimate follows them. */
export interface PromptSizes {
  /** System instruction, research rules and tool declarations, in tokens: sent on every round of a chat turn. */
  chatFixedTokens: number;
}

/**
 * What a chat turn does, from the twelve-question chat loop run of 2026-11-16 (2.4 lookups, 1.1
 * searches and 2 research rounds on average; a ceiling run uses the whole budget). Every
 * figure is a token count including the model's thinking.
 */
export interface TurnShape {
  rounds: number;
  lookups: number;
  searches: number;
  /** Gate feedback rounds called. */
  gateRounds: number;
}

export const EXPECTED_TURN: TurnShape = { rounds: 2, lookups: 2.4, searches: 1.1, gateRounds: 0.3 };
/** `CHAT_MAX_ROUNDS`, `CHAT_MAX_CALLS`, `CHAT_MAX_SEARCHES` and one correction round. */
export const CEILING_TURN: TurnShape = { rounds: 10, lookups: 12, searches: 4, gateRounds: 1 };

const TOKENS = {
  /** First user message of a chat turn: the conversation, cards in play, stored snapshots, coaches, the date. */
  firstMessage: 3_000,
  /** The route call for a turn the fast paths don't settle. */
  route: { input: 1_500, output: 200 },
  /** A lookup's result as the loop reads it. */
  toolResult: 3_000,
  /** A tool-calling round's own output: the calls, with thinking. */
  toolRoundOutput: 500,
  /** The final answer, with thinking. */
  answerOutput: 1_700,
  /** One grounded search for the loop's `web_search`: its prompt and the digest with thinking. */
  search: { input: 1_500, output: 1_500 },
  /** One gate feedback round. */
  gate: { input: 3_000, output: 1_200 },
  /** The rubric grade: the live feed data (3k), the answer (1k) and instructions; output includes medium thinking. */
  rubric: { input: 5_500, output: 3_000 },
  /** The rubric's subject call. */
  subjects: { input: 1_500, output: 150 },
  /** A consistency comparison: instructions, plus each run's answer. */
  consistencyBase: 1_000,
  answer: 1_000,
  consistencyOutput: 2_200,
  /** A card-mention call, for an answer the scan flagged. */
  mention: { input: 1_800, output: 1_200 },
  /** A stage-path control question (the past-debate path): brief, lookups, one search, writer. */
  control: { calls: 5, input: 40_000, output: 8_000, grounded: 1 },
};

/** The calls, input and output of one chat turn of this shape. Each round re-sends everything before it. */
export function chatTurnComponent(shape: TurnShape, sizes: PromptSizes): EstimateComponent {
  const modelCalls = shape.rounds + 1;
  const perRoundResults = (shape.lookups * TOKENS.toolResult) / Math.max(1, shape.rounds);
  let input = 0;
  let output = 0;
  for (let i = 0; i < modelCalls; i++) {
    input += sizes.chatFixedTokens + TOKENS.firstMessage + i * (perRoundResults + TOKENS.toolRoundOutput);
    output += i < shape.rounds ? TOKENS.toolRoundOutput : TOKENS.answerOutput;
  }
  input += shape.searches * TOKENS.search.input + shape.gateRounds * TOKENS.gate.input + TOKENS.route.input;
  output += shape.searches * TOKENS.search.output + shape.gateRounds * TOKENS.gate.output + TOKENS.route.output;
  return {
    name: 'Chat turn (route, loop rounds, searches, gate feedback)',
    calls: modelCalls + shape.searches + shape.gateRounds + 1,
    inputTokens: Math.round(input),
    outputTokens: Math.round(output),
    grounded: shape.searches,
  };
}

const scale = (c: EstimateComponent, by: number, name: string): EstimateComponent => ({
  name,
  calls: c.calls * by,
  inputTokens: Math.round(c.inputTokens * by),
  outputTokens: Math.round(c.outputTokens * by),
  grounded: c.grounded * by,
});

export interface EstimateInput {
  /** Question numbers the run covers. */
  questions: number[];
  repeat: number;
  /** Compare the runs of each question (needs repeat of 2 or more). */
  consistency: boolean;
  cardMentions: boolean;
  /** Score the rubric (the live set's grader; always on in a run, off to price the pipeline alone). */
  rubric?: boolean;
  prices?: Prices;
  sizes: PromptSizes;
}

/** Live-set questions that take the stage pipeline whatever the path flag says: the historical controls. */
export const CONTROL_QUESTIONS = new Set([13, 14]);

const totalOf = (components: EstimateComponent[], prices: Prices): EstimateTotals => {
  const t = components.reduce((a, c) => ({ calls: a.calls + c.calls, inputTokens: a.inputTokens + c.inputTokens, outputTokens: a.outputTokens + c.outputTokens, grounded: a.grounded + c.grounded }), { calls: 0, inputTokens: 0, outputTokens: 0, grounded: 0 });
  return { ...t, usd: (t.inputTokens * prices.inputPerMillion + t.outputTokens * prices.outputPerMillion) / 1e6 + t.grounded * prices.perGroundedSearch };
};

/** The calls, tokens and cost a run would spend, without making any. */
export function estimateRun(input: EstimateInput): Estimate {
  const prices = input.prices ?? ASSUMED_PRICES;
  const controls = input.questions.filter((n) => CONTROL_QUESTIONS.has(n)).length;
  const chatTurns = input.questions.length - controls;
  const turnsOf = (n: number) => n * input.repeat;
  const build = (shape: TurnShape): EstimateComponent[] => {
    const answers = input.questions.length * input.repeat;
    const out: EstimateComponent[] = [];
    if (chatTurns) out.push(scale(chatTurnComponent(shape, input.sizes), turnsOf(chatTurns), `Chat turns, ${turnsOf(chatTurns)}`));
    if (controls) out.push({ name: `Stage-path controls, ${turnsOf(controls)}`, calls: TOKENS.control.calls * turnsOf(controls), inputTokens: TOKENS.control.input * turnsOf(controls), outputTokens: TOKENS.control.output * turnsOf(controls), grounded: TOKENS.control.grounded * turnsOf(controls) });
    if (input.rubric !== false) {
      out.push({ name: `Rubric grade, ${answers} (a subject call and a grounded call each)`, calls: 2 * answers, inputTokens: (TOKENS.rubric.input + TOKENS.subjects.input) * answers, outputTokens: (TOKENS.rubric.output + TOKENS.subjects.output) * answers, grounded: answers });
    }
    if (input.consistency && input.repeat >= 2) {
      const per = TOKENS.consistencyBase + input.repeat * TOKENS.answer;
      out.push({ name: `Consistency comparison, ${input.questions.length}`, calls: input.questions.length, inputTokens: per * input.questions.length, outputTokens: TOKENS.consistencyOutput * input.questions.length, grounded: 0 });
    }
    if (input.cardMentions) {
      // The scan skips the call for an answer with no candidate, so this is the most it can cost.
      out.push({ name: `Card-mention scoring, at most ${answers}`, calls: answers, inputTokens: TOKENS.mention.input * answers, outputTokens: TOKENS.mention.output * answers, grounded: 0 });
    }
    return out;
  };
  const expected = build(EXPECTED_TURN);
  const ceiling = build(CEILING_TURN);
  return {
    expected: { components: expected, total: totalOf(expected, prices) },
    ceiling: { components: ceiling, total: totalOf(ceiling, prices) },
    turns: input.questions.length * input.repeat,
    controlTurns: turnsOf(controls),
    prices,
  };
}

const k = (n: number) => `${(n / 1000).toFixed(0)}k`;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** The dry run's output. */
export function formatEstimate(e: Estimate, meta: { questions: number[]; repeat: number; path: string }): string {
  const rows = (cs: EstimateComponent[]) => cs.map((c) => `  ${c.name}: ${c.calls.toFixed(0)} calls, ${k(c.inputTokens)} in, ${k(c.outputTokens)} out${c.grounded ? `, ${c.grounded.toFixed(0)} grounded` : ''}`);
  const line = (label: string, t: EstimateTotals) => `${label}: ${t.calls.toFixed(0)} calls, ${(t.inputTokens / 1e6).toFixed(2)}M input tokens, ${(t.outputTokens / 1e6).toFixed(2)}M output tokens, ${t.grounded.toFixed(0)} grounded searches, ${usd(t.usd)}`;
  return [
    `Dry run: ${meta.questions.length} question${meta.questions.length === 1 ? '' : 's'} (${meta.questions.join(', ')}) × ${meta.repeat} run${meta.repeat === 1 ? '' : 's'} = ${e.turns} turns through ${meta.path}. No call is made.`,
    '',
    ...rows(e.expected.components),
    '',
    line('Expected', e.expected.total),
    line('Ceiling (every chat turn spends its whole budget)', e.ceiling.total),
    '',
    `Prices used: ${usd(e.prices.inputPerMillion)}/M input, ${usd(e.prices.outputPerMillion)}/M output, $${e.prices.perGroundedSearch.toFixed(3)} per grounded search. The model profiles carry no prices; these are placeholders, so confirm them or pass --price-in, --price-out and --price-search. Implicit caching of the repeated prompt prefix is ignored, which makes the figure higher than a billed one.`,
    'Token counts are modelled from the 2026-11-16 chat loop run (2.4 lookups, 1.1 searches and 2 research rounds a turn) and the real prompt sizes. Thinking tokens count as output.',
  ].join('\n');
}
