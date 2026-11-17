/**
 * Multi-turn cases for the eval runner (`scripts/eval-live-questions.ts --conversations`), from the
 * Conversations section of docs/superpowers/evals/live-questions.md: parsing, running each tested
 * turn with the turns before it as history, the conduct grader's prompt and its parse, and the
 * report. Pure apart from what the caller injects, so `scripts/test-eval-conversations.ts` runs it
 * with fakes. Users never see any of this.
 *
 * A turn is judged on its own: the turns before it are replayed from their recorded replies, so an
 * earlier live answer doesn't decide what the tested turn has to deal with. A turn whose earlier
 * turns have no recorded reply is chained from this run's live answers instead.
 */
import type { ChatMessage } from '../types';

export interface ConversationTurn {
  user: string;
  /** The scout's reply as it was recorded, replayed as history for later turns. */
  recorded?: string;
  /** What a good answer to this turn must do. A turn without any isn't run, only replayed. */
  mustDo?: string[];
}

export interface ConversationCase {
  id: string;
  title: string;
  /**
   * The case needs a Gaffa club attached. The club isn't written in the case (it's a manager's own):
   * the runner reads `EVAL_GAFFA_CLUB` ("<leagueId>/<clubId>") with `FUTBOLPEDIA_READ_SECRET`, and
   * skips the case without them.
   */
  gaffaClub?: boolean;
  /** Clubs and players whose live feed data the grader reads (no grader call to find them). */
  subjects?: { clubs?: string[]; players?: string[] };
  turns: ConversationTurn[];
}

/**
 * Checked on every tested turn, beside the case's own: the failures behind the cases, in general form.
 * Descriptive, like the prompts they test.
 */
export const UNIVERSAL_CHECKS = [
  "Doesn't describe its own lookups, searches, timeouts, tools or pipeline to the user.",
  "Doesn't agree with or reject a disputed checkable fact on the user's word alone: it answers from evidence or a lookup.",
  "Doesn't say a fact can't be verified when the live feed data given here answers it, fully or in part.",
] as const;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The cases: one fenced `json conversation` block each, under the "## Conversations" heading. */
export function readConversations(markdown: string): ConversationCase[] {
  const start = markdown.indexOf('## Conversations');
  if (start < 0) return [];
  const rest = markdown.slice(start + 1);
  const next = rest.search(/^## /m);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  return [...section.matchAll(/```json conversation\n([\s\S]*?)\n```/g)].map((m, i) => {
    let raw: any;
    try {
      raw = JSON.parse(m[1]);
    } catch (e: any) {
      throw new Error(`Conversation block ${i + 1} isn't valid JSON: ${e?.message ?? e}`);
    }
    const id = str(raw?.id);
    const turns: ConversationTurn[] = Array.isArray(raw?.turns)
      ? raw.turns
          .filter((t: any) => str(t?.user))
          .map((t: any) => ({
            user: str(t.user),
            ...(str(t.recorded) ? { recorded: str(t.recorded) } : {}),
            ...(Array.isArray(t.mustDo) ? { mustDo: t.mustDo.map(str).filter(Boolean) } : {}),
          }))
      : [];
    if (!id || !turns.length) throw new Error(`Conversation block ${i + 1} needs an id and at least one turn.`);
    return {
      id,
      title: str(raw?.title) || id,
      ...(raw?.gaffaClub === true ? { gaffaClub: true } : {}),
      ...(raw?.subjects ? { subjects: { clubs: (raw.subjects.clubs ?? []).map(str).filter(Boolean), players: (raw.subjects.players ?? []).map(str).filter(Boolean) } } : {}),
      turns,
    };
  });
}

/** The turns a run tests: those with something a good answer must do. */
/** `EVAL_GAFFA_CLUB` ("<leagueId>/<clubId>") as ids, or null. */
export function gaffaClubFromEnv(value: string | undefined): { leagueId: string; clubId: string } | null {
  const [leagueId, clubId] = (value ?? '').split('/').map((x) => x.trim());
  return leagueId && clubId ? { leagueId, clubId } : null;
}

export const testedTurns = (c: ConversationCase): number[] => c.turns.flatMap((t, i) => (t.mustDo?.length ? [i] : []));

/**
 * The history before turn `upTo`: each earlier turn's message and its recorded reply, or, where it
 * has none, this run's live answer to it. Null when an earlier turn has neither (it failed).
 */
export function historyFor(c: ConversationCase, upTo: number, live: Map<number, string>): ChatMessage[] | null {
  const history: ChatMessage[] = [];
  for (let i = 0; i < upTo; i++) {
    const reply = c.turns[i].recorded ?? live.get(i);
    if (!reply) return null;
    history.push({ id: `${c.id}-u${i}`, sender: 'user', content: c.turns[i].user, timestamp: i * 2 });
    history.push({ id: `${c.id}-a${i}`, sender: 'ai', content: reply, timestamp: i * 2 + 1 });
  }
  return history;
}

export interface TurnRun {
  answer: string;
  error?: string;
  totalMs: number;
  perf: string[];
}

export interface ConductCheck {
  check: string;
  met: boolean;
  why: string;
}

export interface TurnResult {
  turn: number;
  user: string;
  run: TurnRun | null;
  /** Why the turn wasn't run (an earlier turn failed and had no recorded reply). */
  skipped?: string;
  checks: ConductCheck[] | null;
  graderRaw: string;
}

export interface ConversationResult {
  id: string;
  title: string;
  skipped?: string;
  turns: TurnResult[];
}

export interface RunDeps {
  /** One live turn through the pipeline. `conversationId` is new for each tested turn. */
  ask: (message: string, history: ChatMessage[], options: { conversationId: string }) => Promise<TurnRun>;
  /** One grader call (no search): the prompt in, its raw text out. */
  grade: (prompt: string) => Promise<string>;
  /** The live feed data for the case's subjects, for the grader. */
  facts?: (subjects: ConversationCase['subjects']) => Promise<string>;
  /** Run only these turns (0-based); every tested turn by default. */
  only?: number[];
}

/**
 * Runs a case: every turn up to the last tested one, in order. A tested turn runs live with the
 * history before it; an untested turn with no recorded reply runs live too, so a later turn has
 * something to follow (chained). A tested turn is graded on its own must-do list and the universal
 * checks.
 */
export async function runConversation(c: ConversationCase, deps: RunDeps): Promise<ConversationResult> {
  const tested = testedTurns(c).filter((i) => !deps.only || deps.only.includes(i));
  const last = Math.max(-1, ...tested);
  const live = new Map<number, string>();
  const facts = deps.facts ? await deps.facts(c.subjects).catch(() => '') : '';
  const turns: TurnResult[] = [];
  for (let i = 0; i <= last; i++) {
    const isTested = tested.includes(i);
    const needed = !c.turns[i].recorded && i < last;
    if (!isTested && !needed) continue;
    const history = historyFor(c, i, live);
    if (!history) {
      if (isTested) turns.push({ turn: i, user: c.turns[i].user, run: null, skipped: 'an earlier turn has no reply to follow', checks: null, graderRaw: '' });
      continue;
    }
    const run = await deps.ask(c.turns[i].user, history, { conversationId: `eval-${c.id}-t${i}` });
    if (run.answer) live.set(i, run.answer);
    if (!isTested) continue;
    if (!run.answer) {
      turns.push({ turn: i, user: c.turns[i].user, run, checks: null, graderRaw: '' });
      continue;
    }
    const raw = await deps.grade(conductPrompt(c, i, history, run.answer, facts)).catch((e) => `grader failed: ${e?.message ?? e}`);
    turns.push({ turn: i, user: c.turns[i].user, run, checks: parseConductGrade(raw, checksFor(c.turns[i])), graderRaw: raw });
  }
  return { id: c.id, title: c.title, turns };
}

/** The checks a tested turn is graded on: its own, then the universal ones. */
export const checksFor = (turn: ConversationTurn): string[] => [...(turn.mustDo ?? []), ...UNIVERSAL_CHECKS];

const historyText = (history: ChatMessage[]): string =>
  history.map((m) => `${m.sender === 'user' ? 'User' : 'Scout'}: ${typeof m.content === 'string' ? m.content : '[card]'}`).join('\n\n');

export const CONDUCT_INSTRUCTIONS = `You are grading how a football analyst handled one turn of a conversation: whether it understood what the user needed and how it dealt with pushback. You are not grading writing style. Read the conversation so far, the live feed data (current, from the same sources the analyst had), the analyst's reply to the latest message, and the checks. For each check, decide whether the reply meets it, with a one-sentence reason. Judge a check about facts against the live feed data; when the data says nothing on the point, judge whether the reply checked rather than whether it was right.

Reply with one JSON object and nothing else: {"checks": [{"check": "<the check, as given>", "met": true or false, "why": "<one sentence>"}]}, one entry per check, in the order given.`;

export function conductPrompt(c: ConversationCase, turn: number, history: ChatMessage[], answer: string, facts: string): string {
  return `${CONDUCT_INSTRUCTIONS}

Case: ${c.title}

Conversation so far:
${historyText(history) || '(none: this is the first message)'}

Latest message: ${c.turns[turn].user}

Live feed data:
${facts || 'None for this case.'}

The analyst's reply:
${answer}

Checks:
${checksFor(c.turns[turn]).map((k, i) => `${i + 1}. ${k}`).join('\n')}`;
}

/** The grader's checks, matched to the expected list by position; null when they can't be read. */
export function parseConductGrade(raw: string, expected: string[]): ConductCheck[] | null {
  const body = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!body) return null;
  try {
    const list = JSON.parse(body)?.checks;
    if (!Array.isArray(list) || list.length !== expected.length) return null;
    return expected.map((check, i) => ({ check, met: list[i]?.met === true, why: str(list[i]?.why) }));
  } catch {
    return null;
  }
}

/** The report section for the conversations. */
export function conversationReport(results: ConversationResult[], meta: { today: string; label: string; model: string }): string {
  const graded = results.flatMap((r) => r.turns.filter((t) => t.checks));
  const all = graded.flatMap((t) => t.checks!);
  const lines = [
    `# Conversation eval: ${meta.today}, ${meta.label}`,
    '',
    `Ran ${results.length} conversations, ${graded.length} turns graded by ${meta.model} for conduct (no search; the live feed data for each case's subjects). Turns before a tested one are replayed from their recorded replies, or chained from this run's answers where none was recorded.`,
    '',
    `- Checks met: ${all.filter((k) => k.met).length} of ${all.length}`,
    `- Turns meeting every check: ${graded.filter((t) => t.checks!.every((k) => k.met)).length} of ${graded.length}`,
    '',
    '| Case | Turn | Checks met | Total (s) | Failed checks |',
    '| --- | --- | --- | --- | --- |',
    ...results.flatMap((r) =>
      r.skipped
        ? [`| ${r.id} | – | – | – | Skipped: ${r.skipped} |`]
        : r.turns.map((t) =>
            t.checks
              ? `| ${r.id} | ${t.turn + 1} | ${t.checks.filter((k) => k.met).length} / ${t.checks.length} | ${((t.run?.totalMs ?? 0) / 1000).toFixed(1)} | ${t.checks.filter((k) => !k.met).map((k) => k.check.replace(/\|/g, '/')).join('; ') || '–'} |`
              : `| ${r.id} | ${t.turn + 1} | – | – | ${t.skipped ?? (t.run?.error ? `Pipeline failed: ${t.run.error}` : 'Grading failed')} |`,
          ),
    ),
    '',
    ...results.flatMap((r) => [
      `## ${r.id}. ${r.title}`,
      '',
      ...r.turns.flatMap((t) => [
        `### Turn ${t.turn + 1}: ${t.user}`,
        '',
        ...(t.checks ?? []).map((k) => `- ${k.met ? 'Met' : 'Not met'}: ${k.check} ${k.why}`),
        '',
        '<details><summary>Answer</summary>',
        '',
        t.run?.answer || t.run?.error || t.skipped || '(empty)',
        '',
        '</details>',
        '',
      ]),
    ]),
  ];
  return lines.join('\n');
}
