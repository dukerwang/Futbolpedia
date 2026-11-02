import { Type } from '@google/genai';
import { generateStructured, getCurrentSeasonInfo } from './aiClient';
import {
  compactLedger,
  discardEntries,
  emptyLedger,
  formatLookupLog,
  seasonStartDate,
  type EvidenceLedger,
} from './evidenceLedger';
import {
  executeCall,
  fileOutcomes,
  RESEARCH_COVERAGE_NOTE,
  RESEARCH_TOOL_GUIDE,
  RESEARCH_TOOLS,
  runCalls,
  sanitizeCalls,
  type ResearchCall,
  type ResearchToolset,
  type ToolOutcome,
} from './researchTools';
import type { ClubResearch, SnapshotSource } from './clubSnapshots';
import {
  buildSituation,
  coresFromLedger,
  deriveClubCore,
  formatFactContext,
  liveSituationModel,
  sameClubName,
  type ClubSnapshot,
  type Situation,
  type SituationModel,
} from './situationSnapshot';

/**
 * A chat turn's research, planned by the model instead of fixed query templates, inside a time
 * budget (a grounded web search alone takes several seconds):
 *
 * 1. At once, in parallel: the live data and stored snapshot of each club the router spotted, a
 *    club's research pass when it has no fresh snapshot (shared with the build that stores one),
 *    a web search on the question itself, and the brief. The brief (one call, low thinking) works
 *    out what the user is really asking, what is distinctive or changed this season, the
 *    answer's outline, and any further lookups, as facts or analysis.
 * 2. The brief's lookups: live feeds and cards always run; a web search runs only if it can
 *    finish before `RESEARCH_DEADLINE_MS`. Analysis searches wait briefly for the live facts and
 *    read their sources against them. At the deadline research stops waiting; anything still
 *    running is filed as too slow, and a snapshot still building finishes for the next turn.
 * 3. Reflect and snapshot, in parallel: a quick call reads what came back, sets aside sources from
 *    earlier seasons that the facts contradict, and may ask for a few more fast lookups; the
 *    situation snapshot turns the evidence into a dated picture of the present for the writer.
 *
 * The writer then gets the brief, the snapshot and the evidence, so its own thinking can stay light.
 */

export interface ResearchBrief {
  /** What the user wants answered, including what a good answer has to establish first. */
  understanding: string;
  /** For a question about the present: what's distinctive or changed this season, as questions to settle. */
  focus: string;
  timeframe: 'live' | 'historical' | 'timeless';
  /** The points the answer should make, in order. */
  outline: string[];
  calls: ResearchCall[];
  /** Things the answer needs that research couldn't establish, for the writer to say plainly. */
  unresolved: string[];
}

export interface ResearchContext {
  message: string;
  /** The recent conversation, as the writer sees it. */
  thread: string;
  /** Cards already in play this turn ("Name (edition)"), so research doesn't fetch them again. */
  cardsInPlay: string[];
  /** Clubs and players the router spotted, as hints. */
  hints: { clubs: string[]; players: string[] };
  /** Whether the turn is likely about the present, so snapshots can start building with the brief. */
  present?: boolean;
  /** Clubs whose stored snapshot is already loaded, for the brief to plan around. */
  storedSnapshots?: { club: string; asOf: string }[];
  /** Research already running when the brief plans, so it doesn't repeat it. */
  running?: string[];
  /** A search on the question started before routing (`startQuestionSearch`), to use instead of a new one. */
  questionSearch?: Promise<ToolOutcome> | null;
}

const PRESENT_CUES =
  /\b(this season|right now|currently|at the moment|these days|so far|lately|recently|now|injur\w*|fit|fitness|form|line-?ups?|starting xi|best xi|table|standings|signings?|transfers?|playing|used|set up|pressing|build-up|shape)\b/i;
const NOT_CHAT = /\b(rate|rerate|rating|dossier|card|prime|peak|all[- ]time|greatest|ever|\d{4}s|\d{4}-\d{2})\b/i;

/**
 * Whether a message reads as a question about the present, so its search can start while the turn
 * is still being routed. Wrong guesses cost one search, never time.
 */
export const looksLikePresentQuestion = (message: string): boolean => PRESENT_CUES.test(message) && !NOT_CHAT.test(message);

/** The search on the question as asked, as research files it. */
export const questionCallFor = (message: string): ResearchCall => ({ tool: 'web_search', subject: message, stage: 'facts', purpose: 'the question as asked' });

/** Starts the question's search before routing, for a message that looks like a question about the present. */
export const startQuestionSearch = (message: string, tools: ResearchToolset): Promise<ToolOutcome> | null =>
  looksLikePresentQuestion(message) ? executeCall(questionCallFor(message), tools) : null;

/** Lookups in the first round, and in the reflect round. */
export const FIRST_ROUND_LIMIT = 6;
export const SECOND_ROUND_LIMIT = 3;
/** Clubs per turn that get live data through the snapshot path. */
export const MAX_SNAPSHOT_CLUBS = 3;
/** How long the brief waits for stored snapshots before planning without them. */
export const STORED_PEEK_MS = 300;
/** How long analysis searches wait for the live facts before starting without them. */
export const ANALYSIS_WAIT_MS = 2_500;
/**
 * After the first round, how much longer a snapshot still building gets. One that misses it
 * finishes in the background for the next turn and other users; this turn works it out itself.
 */
export const SNAPSHOT_GRACE_MS = 500;
/** Research stops waiting at this point in the turn; whatever is still running is left out. */
export const RESEARCH_DEADLINE_MS = 9_000;
/** How long a grounded web search usually takes; one that can't finish by the deadline isn't started. */
export const SEARCH_ESTIMATE_MS = 8_000;
/** Past this point in the turn, reflect is skipped. */
export const REFLECT_CUTOFF_MS = 11_000;
/** Past this point, the situation snapshot is what code works out, without the model's call. */
export const SITUATION_CUTOFF_MS = 12_000;

const CALL_ITEM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    tool: { type: Type.STRING, enum: [...RESEARCH_TOOLS] },
    subject: { type: Type.STRING },
    country: { type: Type.STRING },
    edition: { type: Type.STRING, enum: ['current', 'prime'] },
    purpose: { type: Type.STRING },
    stage: { type: Type.STRING, enum: ['facts', 'analysis'] },
  },
  required: ['tool', 'subject', 'purpose', 'stage'],
};

const BRIEF_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    understanding: { type: Type.STRING },
    focus: { type: Type.STRING },
    timeframe: { type: Type.STRING, enum: ['live', 'historical', 'timeless'] },
    outline: { type: Type.ARRAY, items: { type: Type.STRING } },
    calls: { type: Type.ARRAY, items: CALL_ITEM_SCHEMA },
  },
  required: ['understanding', 'focus', 'timeframe', 'outline', 'calls'],
};

const REFLECT_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    enough: { type: Type.BOOLEAN },
    discard: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, reason: { type: Type.STRING } }, required: ['id', 'reason'] },
    },
    calls: { type: Type.ARRAY, items: CALL_ITEM_SCHEMA },
    unresolved: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['enough', 'discard', 'calls', 'unresolved'],
};

export const buildBriefPrompt = (ctx: ResearchContext): string => {
  const { month, year, currentSeason } = getCurrentSeasonInfo();
  return `You are planning the research for a football analyst's answer. Today is ${month} ${year}, in the ${currentSeason} season. Your memory of current squads, roles, form, injuries, transfers and managers is at least a season out of date, so every current fact the answer depends on has to be looked up.

A strong answer about the present explains what is distinctive about this team or player this season and why, rather than how such a system works in general. Plan around change: what is different from last season (personnel, coach, shape, roles, form) and what drives it.

Work out:
1. understanding: what the user wants answered, read in the light of the conversation. Include what a good answer has to establish before it can answer: for a question about how a team plays, who has actually been playing and where; for a question about a player now, his current club, role and form; for a comparison, the same facts for each side.
2. focus: for a question about the present, what is distinctive about this team or player this season compared with last, and the likely reasons, written as the questions research has to settle. Leave it empty for a historical or timeless question.
3. timeframe: "live" when the answer depends on the present season, "historical" when it is about past seasons or players' primes, "timeless" when it is about ideas rather than current facts.
4. outline: the points a strong answer makes, in order, as short phrases. For a question about the present, lead with what has changed and why it matters.
5. calls: the lookups, at most ${FIRST_ROUND_LIMIT}, in two stages:
   - stage "facts": the present, established first. The live tools for lineups, injuries, squads, player numbers and tables, and web searches for transfers and their dates, team news and recent results.
   - stage "analysis": web searches for tactical analysis and commentary. They run once the facts are in and are read against them, so ask for this season's analysis by name, and only where the answer needs interpretation the facts can't give.
   Each call needs a purpose: the fact it is meant to establish. A historical or timeless question answered from stored cards may need no calls; don't fetch cards that are already in play. For a question about the present, live club data for the clubs named in the message is fetched without a call. A web search takes several seconds and the answer can't wait for many, so plan a search only for what the question needs beyond the research already running; the live tools are quick.

Tools:
${RESEARCH_TOOL_GUIDE}

${RESEARCH_COVERAGE_NOTE}

${ctx.storedSnapshots?.length ? `Already loaded: today's stored snapshot for ${ctx.storedSnapshots.map((s) => `${s.club} (as of ${s.asOf})`).join(', ')}, with the first-choice XI, absences, recent form, what changed since last season and what is distinctive this season. Don't plan lookups for those; plan only what the question needs beyond them.\n\n` : ''}${ctx.running?.length ? `Already running: ${ctx.running.join('; ')}.\n\n` : ''}${ctx.hints.clubs.length || ctx.hints.players.length ? `Names spotted in the message: ${[...ctx.hints.clubs, ...ctx.hints.players].join(', ')}\n` : ''}${ctx.cardsInPlay.length ? `Cards already in play: ${ctx.cardsInPlay.join(', ')}\n` : ''}
${ctx.thread ? `${ctx.thread}\n` : ''}
<user_message>${ctx.message}</user_message>`;
};

export const buildReflectPrompt = (brief: ResearchBrief, ledger: EvidenceLedger): string => {
  const { currentSeason, seasonStartYear } = getCurrentSeasonInfo();
  return `You are checking whether research is ready for a football analyst to write an answer. The current season is ${currentSeason}.

What the answer needs: ${brief.understanding}
${brief.focus ? `What it should settle about this season: ${brief.focus}\n` : ''}Planned outline:
${brief.outline.map((p) => `- ${p}`).join('\n')}

Lookups so far and how each ended:
${formatLookupLog(ledger) || '- none'}

Evidence so far (web points are dated by their source):
${compactLedger(ledger, { seasonStart: seasonStartDate(seasonStartYear) })}

Do three things:
1. discard: web entries whose sources come from an earlier season and describe a team the live feeds contradict (players who have left, another coach, another shape). Give each entry's id and the reason in a few words. Never discard live feed data, cards or earlier turns, and keep an older source that only explains what changed.
2. calls: ask for up to ${SECOND_ROUND_LIMIT} more lookups only when they would change the answer: a needed fact is missing, two sources conflict, or the evidence shows something the plan didn't expect (a player in a key role it didn't account for, a recent signing, an injury) that the answer should explain. Don't repeat a lookup, and don't ask again for something that came back not covered: work around it with a different source, such as recent team news and match reports for absences. Analysis searches come second and are read against the facts.
3. unresolved: anything the answer needs that still won't be established, in a few words each.
Set enough to true when no more lookups are needed.

Tools:
${RESEARCH_TOOL_GUIDE}

${RESEARCH_COVERAGE_NOTE}`;
};

/** A plan from the names the router spotted, for when the brief call fails. */
export const fallbackBrief = (ctx: ResearchContext): ResearchBrief => ({
  understanding: ctx.message,
  focus: '',
  timeframe: 'live',
  outline: [],
  calls: sanitizeCalls(
    [
      ...ctx.hints.clubs.map((club) => ({ tool: 'club_recent_team', subject: club })),
      ...ctx.hints.players.map((player) => ({ tool: 'player_season', subject: player })),
      { tool: 'web_search', subject: ctx.message },
    ],
    FIRST_ROUND_LIMIT,
  ),
  unresolved: [],
});

export interface ReflectVerdict {
  enough: boolean;
  calls: ResearchCall[];
  unresolved: string[];
  discard: { id: string; reason: string }[];
}

export interface ResearchModel {
  writeBrief(ctx: ResearchContext): Promise<ResearchBrief>;
  reflect(brief: ResearchBrief, ledger: EvidenceLedger): Promise<ReflectVerdict>;
}

export const liveResearchModel: ResearchModel = {
  async writeBrief(ctx) {
    const raw = await generateStructured<any>({
      task: 'routing',
      prompt: buildBriefPrompt(ctx),
      schema: BRIEF_SCHEMA,
      // Medium thinking took 12 s here and low about 5 s; the brief plans, the writer argues.
      thinkingLevelOverride: 'low',
      temperatureOverride: 0.2,
    });
    return {
      understanding: typeof raw?.understanding === 'string' ? raw.understanding : ctx.message,
      focus: typeof raw?.focus === 'string' ? raw.focus.trim() : '',
      timeframe: ['live', 'historical', 'timeless'].includes(raw?.timeframe) ? raw.timeframe : 'live',
      outline: Array.isArray(raw?.outline) ? raw.outline.filter((p: unknown) => typeof p === 'string').slice(0, 8) : [],
      calls: sanitizeCalls(raw?.calls, FIRST_ROUND_LIMIT),
      unresolved: [],
    };
  },
  async reflect(brief, ledger) {
    const raw = await generateStructured<any>({
      task: 'routing',
      prompt: buildReflectPrompt(brief, ledger),
      schema: REFLECT_SCHEMA,
      thinkingLevelOverride: 'low',
    });
    return {
      enough: raw?.enough !== false,
      calls: sanitizeCalls(raw?.calls, SECOND_ROUND_LIMIT, brief.calls),
      unresolved: Array.isArray(raw?.unresolved) ? raw.unresolved.filter((u: unknown) => typeof u === 'string').slice(0, 6) : [],
      discard: Array.isArray(raw?.discard)
        ? raw.discard
            .filter((d: any) => typeof d?.id === 'string')
            .map((d: any) => ({ id: d.id, reason: typeof d.reason === 'string' ? d.reason : '' }))
            .slice(0, 6)
        : [],
    };
  },
};

/** What the turn's progress line says while a round runs. */
export const describeRound = (calls: ResearchCall[]): string => {
  const clubs = calls.filter((c) => c.tool === 'club_recent_team').map((c) => c.subject);
  const searches = calls.filter((c) => c.tool === 'web_search').length;
  const others = calls.length - clubs.length - searches;
  const parts = [
    ...(clubs.length ? [`${clubs.join(' & ')} recent team${clubs.length > 1 ? 's' : ''}`] : []),
    ...(searches ? [`${searches} ${searches === 1 ? 'search' : 'searches'}`] : []),
    ...(others ? [`${others} more ${others === 1 ? 'lookup' : 'lookups'}`] : []),
  ];
  return `Checking ${parts.join(', ')}...`;
};

/** Resolves to the promise's value, or null if it hasn't settled within `ms`. Never rejects. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });

interface ClubJob {
  name: string;
  call: ResearchCall;
  live: Promise<ToolOutcome>;
  stored: Promise<ClubSnapshot | null>;
  /** The research pass of a club with no fresh snapshot, shared with its build. */
  research: Promise<ClubResearch | null> | null;
  snapshot: Promise<ClubSnapshot | null> | null;
}

const TOO_SLOW: ToolOutcome = { status: 'failed', result: null, missing: [], note: 'still running when the writer started' };
const SKIPPED: ToolOutcome = { status: 'failed', result: null, missing: [], note: 'not started: no time left for a web search' };

export async function runResearch(
  ctx: ResearchContext,
  tools: ResearchToolset,
  options: {
    model?: ResearchModel;
    situationModel?: SituationModel;
    /** Shared club snapshots; without one, research builds everything itself. */
    snapshots?: SnapshotSource | null;
    onStage?: (label: string) => void;
    perf?: (label: string) => void;
    now?: () => number;
  } = {},
): Promise<{ brief: ResearchBrief; ledger: EvidenceLedger; situation: Situation | null }> {
  const model = options.model ?? liveResearchModel;
  const situationModel = options.situationModel ?? liveSituationModel;
  const snapshots = options.snapshots ?? null;
  const now = options.now ?? Date.now;
  const start = now();
  const deadline = start + RESEARCH_DEADLINE_MS;
  const untilDeadline = () => deadline - now();
  const searchFits = () => now() + SEARCH_ESTIMATE_MS <= deadline;
  const { currentSeason, seasonStartYear } = getCurrentSeasonInfo();
  const seasonStart = seasonStartDate(seasonStartYear);

  // Each club is looked up once: its live data, its stored snapshot and, for a question about the
  // present with no fresh snapshot, a research pass whose build stores one for everyone.
  const clubs: ClubJob[] = [];
  const openClub = (name: string, build: boolean): ClubJob | null => {
    let job = clubs.find((j) => sameClubName(j.name, name)) ?? null;
    if (!job) {
      if (clubs.length >= MAX_SNAPSHOT_CLUBS) return null;
      const call: ResearchCall = { tool: 'club_recent_team', subject: name, stage: 'facts' };
      const live = executeCall(call, tools);
      job = { name, call, live, stored: snapshots ? snapshots.stored(name, live).catch(() => null) : Promise.resolve(null), research: null, snapshot: null };
      clubs.push(job);
    }
    if (build && snapshots && !job.snapshot) {
      const j = job;
      j.research = j.stored.then((hit) => (hit ? null : snapshots.research(j.name, j.live))).catch(() => null);
      j.snapshot = snapshots.get(j.name, j.live).catch(() => null);
    }
    return job;
  };
  if (ctx.present !== false) ctx.hints.clubs.forEach((club) => openClub(club, Boolean(ctx.present)));
  // On a question about the present, the players the router spotted get their season record at
  // once, and a record naming a club the turn hasn't opened opens it, so the snapshot covers the
  // club he actually plays for rather than one the router guessed.
  const playerJobs = ctx.present
    ? ctx.hints.players.slice(0, 3).map((name) => {
        const call: ResearchCall = { tool: 'player_season', subject: name, stage: 'facts' };
        const run = executeCall(call, tools).then((o) => {
          if (o.result?.team) openClub(o.result.team, true);
          return o;
        });
        return { call, run };
      })
    : [];
  // The situation snapshot needs only the live feeds and each club's snapshot or research pass,
  // so it starts now and runs alongside the brief instead of after it.
  const situationEarly = ctx.present
    ? (async (): Promise<Situation> => {
        await Promise.all(playerJobs.map((p) => within(p.run, untilDeadline())));
        const js = [...clubs];
        const lives = await Promise.all(js.map((j) => within(j.live, untilDeadline())));
        const stored = await Promise.all(js.map((j) => within(j.stored, untilDeadline())));
        const passes = await Promise.all(js.map((j, i) => (stored[i] || !j.research ? Promise.resolve(null) : within(j.research, untilDeadline()))));
        const built = await Promise.all(js.map((j, i) => (stored[i] ? Promise.resolve(stored[i]) : j.snapshot ? within(j.snapshot, SNAPSHOT_GRACE_MS) : Promise.resolve(null))));
        const players = await Promise.all(playerJobs.map((p) => within(p.run, 0)));
        const ledger = fileOutcomes(
          emptyLedger(),
          [...js.filter((_, i) => lives[i]).map((j) => j.call), ...passes.flatMap((p) => p?.calls ?? []), ...playerJobs.filter((_, i) => players[i]).map((p) => p.call)],
          [...lives, ...passes.flatMap((p) => p?.outcomes ?? []), ...players].filter((o): o is ToolOutcome => o !== null),
        );
        const r = await buildSituation({
          ledger,
          stored: built.filter((s): s is ClubSnapshot => s !== null),
          players: ctx.hints.players,
          question: ctx.message,
          focus: '',
          today: new Date(now()).toISOString().slice(0, 10),
          season: currentSeason,
          seasonStart,
          allowModel: now() - start < SITUATION_CUTOFF_MS,
          model: situationModel,
        });
        options.perf?.(
          `situation snapshot (${r.situation.clubs.length} clubs, ${r.situation.players.length} players, ${built.filter(Boolean).length} stored or built${r.usedModel ? '' : ', code only'})`,
        );
        return r.situation;
      })().catch((e) => {
        console.warn('[Research] Situation snapshot failed:', e);
        return null;
      })
    : null;
  options.onStage?.('Working out what the question needs...');
  const peeked = clubs.length ? await within(Promise.all(clubs.map((j) => j.stored)), STORED_PEEK_MS) : null;
  const storedSnapshots = (peeked ?? []).filter((s): s is ClubSnapshot => s !== null);
  if (clubs.length) options.perf?.(`stored snapshots (${storedSnapshots.length}/${clubs.length})`);
  // When every club already has today's snapshot, the turn answers from it and the live data
  // instead of waiting on a search.
  const allStored = clubs.length > 0 && storedSnapshots.length === clubs.length;
  // Otherwise a search on the question itself runs alongside the brief (or already started during
  // routing), so a turn about the present has web evidence by the deadline whatever the brief plans.
  const questionCall: ResearchCall | null = ctx.present ? questionCallFor(ctx.message) : null;
  const questionRun = questionCall && !allStored ? (ctx.questionSearch ?? executeCall(questionCall, tools)) : null;
  const running = [
    ...(questionRun ? ['a web search on the question as asked'] : []),
    ...clubs
      .filter((j) => j.research && !storedSnapshots.some((s) => sameClubName(s.club, j.name)))
      .map((j) => `for ${j.name}, searches on what changed since last season, a tactical analysis read against the live data, and team news where no injury list covers it`),
  ];

  let brief: ResearchBrief;
  try {
    brief = await model.writeBrief({ ...ctx, storedSnapshots: storedSnapshots.map((s) => ({ club: s.club, asOf: s.core.asOf })), running });
  } catch (e) {
    console.warn('[Research] Brief failed, planning from the names in the message:', e);
    brief = fallbackBrief(ctx);
  }
  options.perf?.(`brief (${brief.timeframe}, ${brief.calls.length} lookups)`);
  const isLive = brief.timeframe === 'live';
  if (brief.calls.length === 0 && !(isLive && (clubs.length > 0 || playerJobs.length > 0 || questionRun))) return { brief, ledger: emptyLedger(), situation: null };

  // The brief's club lookups go through the club jobs; on a question about the present, so do the
  // clubs the router spotted, each with its snapshot.
  const jobs: ClubJob[] = isLive ? [...clubs] : [];
  if (isLive) clubs.forEach((j) => openClub(j.name, true));
  const otherCalls: ResearchCall[] = [];
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const call of brief.calls) {
    if (questionCall && call.tool === 'web_search' && same(call.subject, questionCall.subject)) continue;
    if (call.tool === 'player_season' && playerJobs.some((p) => same(p.call.subject, call.subject))) continue;
    const job = call.tool === 'club_recent_team' ? openClub(call.subject, isLive) : null;
    if (job) {
      if (!jobs.includes(job)) jobs.push(job);
    } else otherCalls.push(call);
  }
  const facts = otherCalls.filter((c) => c.stage !== 'analysis');
  const analysis = otherCalls.filter((c) => c.stage === 'analysis');

  options.onStage?.(describeRound([...jobs.map((j) => j.call), ...(questionRun && isLive ? [questionCall!] : []), ...facts, ...analysis]));
  const startCall = (c: ResearchCall, context?: string): Promise<ToolOutcome> =>
    c.tool === 'web_search' && !searchFits() ? Promise.resolve(SKIPPED) : executeCall(c, tools, context);
  const factRuns = facts.map((c) => startCall(c));
  // Analysis reads its sources against the live facts, so it waits for the feeds (not the fact
  // searches) for a moment, then starts with whatever facts are in.
  const feedRuns = [...jobs.map((j) => j.live), ...factRuns.filter((_, i) => facts[i].tool !== 'web_search')];
  const settled = new Map<Promise<ToolOutcome>, ToolOutcome>();
  feedRuns.forEach((p) => p.then((o) => settled.set(p, o)).catch(() => {}));
  if (analysis.length && feedRuns.length) await within(Promise.all(feedRuns), Math.min(ANALYSIS_WAIT_MS, untilDeadline()));
  const factsSoFar = feedRuns.map((p) => settled.get(p)?.result).filter((r): r is NonNullable<ToolOutcome['result']> => Boolean(r));
  const context = analysis.length
    ? formatFactContext(
        factsSoFar.flatMap((r) => (r.club ? [deriveClubCore(r.club)] : [])),
        factsSoFar.filter((r) => r.kind === 'player_record').map((r) => r.content),
      )
    : '';
  const analysisRuns = analysis.map((c) => startCall(c, context || undefined));

  // At the deadline, research stops waiting. A lookup still running is kept aside: if it finishes
  // while reflect and the snapshot run, the writer still gets it; otherwise it's filed as too slow.
  const allCalls = [...jobs.map((j) => j.call), ...(isLive ? playerJobs.map((p) => p.call) : []), ...(questionRun && isLive ? [questionCall!] : []), ...facts, ...analysis];
  const allRuns = [...jobs.map((j) => j.live), ...(isLive ? playerJobs.map((p) => p.run) : []), ...(questionRun && isLive ? [questionRun] : []), ...factRuns, ...analysisRuns];
  const [onTime, passes] = await Promise.all([
    Promise.all(allRuns.map((p) => within(p, untilDeadline()))),
    Promise.all(jobs.map((j) => (j.research ? within(j.research, untilDeadline()) : Promise.resolve(null)))),
  ]);
  const ready = (pass: ClubResearch | null) => ({ calls: pass?.calls ?? [], outcomes: pass?.outcomes ?? [] });
  const passesNow = passes.map(ready);
  // Club data first, then each club's research pass, then the rest, as they were planned.
  let ledger = fileOutcomes(
    emptyLedger(),
    [...jobs.map((j) => j.call).filter((_, i) => onTime[i]), ...passesNow.flatMap((p) => p.calls), ...allCalls.slice(jobs.length).filter((_, i) => onTime[jobs.length + i])],
    [...onTime.slice(0, jobs.length), ...passesNow.flatMap((p) => p.outcomes), ...onTime.slice(jobs.length)].filter((o): o is ToolOutcome => o !== null),
  );
  const lateRuns = allCalls.map((call, i) => ({ call, run: allRuns[i] })).filter((_, i) => !onTime[i]);
  const latePasses = jobs.map((j, i) => (j.research && !passes[i] ? j.research : null)).filter((p): p is Promise<ClubResearch | null> => p !== null);
  options.perf?.(
    `research (${allCalls.length - analysis.length + passesNow.reduce((n, p) => n + p.calls.length, 0)} facts, ${analysis.length} analysis; ${ledger.entries.length} found, ${ledger.gaps.length} missing${
      lateRuns.length + latePasses.length ? `, ${lateRuns.length + latePasses.length} still running` : ''
    })`,
  );
  const researchedLate = lateRuns.length + latePasses.length > 0;

  // A turn not marked as about the present builds its snapshot now, alongside reflect. Snapshots
  // ready by now (or within a short grace) are used; one still building finishes for the next turn
  // while this one works it out.
  const players = [...new Set([...ctx.hints.players, ...brief.calls.filter((c) => c.tool === 'player_season').map((c) => c.subject)])];
  const situationRun = !isLive
    ? Promise.resolve(null)
    : situationEarly
      ? situationEarly
      : (async () => {
        let stored = storedSnapshots;
        if (snapshots && jobs.length) {
          const ready = await Promise.all(jobs.map((j) => within(j.snapshot ?? j.stored, SNAPSHOT_GRACE_MS)));
          stored = ready.filter((snap): snap is ClubSnapshot => snap !== null);
          options.perf?.(`club snapshots (${stored.length}/${jobs.length} ready)`);
        }
        const r = await buildSituation({
          ledger,
          stored,
          players,
          question: ctx.message,
          focus: brief.focus,
          today: new Date(now()).toISOString().slice(0, 10),
          season: currentSeason,
          seasonStart,
          allowModel: now() - start < SITUATION_CUTOFF_MS,
          model: situationModel,
        });
        options.perf?.(`situation snapshot (${r.situation.clubs.length} clubs, ${r.situation.players.length} players${r.usedModel ? '' : ', code only'})`);
        return r.situation;
      })();

  // Reflect is for a turn with time in hand; one that ran to the deadline goes straight to writing.
  if (!researchedLate && now() - start < REFLECT_CUTOFF_MS) {
    options.onStage?.('Reading the evidence...');
    const verdict = await model.reflect(brief, ledger).then(
      (v) => {
        options.perf?.(`reflect (${v.enough ? 'enough' : `${v.calls.length} more`}, ${v.discard.length} set aside)`);
        return v;
      },
      (e) => {
        console.warn('[Research] Reflect failed, writing from the first round:', e);
        return null;
      },
    );
    if (verdict) {
      brief = { ...brief, unresolved: verdict.unresolved };
      ledger = discardEntries(ledger, verdict.discard);
      // Another round only takes what is quick by now: live feeds and cards, and a search only
      // if the turn is still well inside its budget.
      const more = verdict.calls.filter((c) => c.tool !== 'web_search' || now() + SEARCH_ESTIMATE_MS <= start + REFLECT_CUTOFF_MS);
      if (!verdict.enough && more.length > 0) {
        options.onStage?.(describeRound(more));
        ledger = await runCalls(more, tools, ledger);
        brief = { ...brief, calls: [...brief.calls, ...more] };
        options.perf?.(`research round 2 (${ledger.entries.length} found, ${ledger.gaps.length} missing)`);
      }
    }
  }
  let situation = await situationRun;
  // Clubs the brief added after the snapshot started still get what code works out for them.
  if (situation) {
    const extra = coresFromLedger(ledger).filter((c) => !situation!.clubs.some((s) => sameClubName(s.club, c.club)));
    if (extra.length) situation = { ...situation, clubs: [...situation.clubs, ...extra] };
  }
  // Whatever finished while reflect and the snapshot ran still reaches the writer.
  if (researchedLate) {
    const [lateOutcomes, latePassResults] = await Promise.all([
      Promise.all(lateRuns.map((l) => within(l.run, 0))),
      Promise.all(latePasses.map((p) => within(p, 0))),
    ]);
    const lateCalls = [...latePassResults.flatMap((p) => p?.calls ?? []), ...lateRuns.map((l) => l.call)];
    const late = [...latePassResults.flatMap((p) => p?.outcomes ?? []), ...lateOutcomes.map((o) => o ?? TOO_SLOW)];
    ledger = fileOutcomes(ledger, lateCalls, late);
    options.perf?.(`late research (${lateOutcomes.filter(Boolean).length + latePassResults.filter(Boolean).length} of ${lateRuns.length + latePasses.length} arrived)`);
  }
  return { brief, ledger, situation };
}

/** The brief as the writer reads it. */
export const formatBriefForWriter = (brief: ResearchBrief): string =>
  `<research_brief>
What the user is asking: ${brief.understanding}
${brief.focus ? `What's distinctive this season, for the answer to lead with: ${brief.focus}\n` : ''}${
    brief.outline.length ? `Planned outline (adapt it to what the evidence shows):\n${brief.outline.map((p) => `- ${p}`).join('\n')}\n` : ''
  }${
    brief.unresolved.length
      ? `Research couldn't establish: ${brief.unresolved.join('; ')}. Say so where the answer depends on it, in one sentence each, rather than filling it in.\n`
      : ''
  }</research_brief>`;
