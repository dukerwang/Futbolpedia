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
import type { SnapshotSource } from './clubSnapshots';
import {
  buildSituation,
  deriveClubCore,
  formatFactContext,
  liveSituationModel,
  sameClubName,
  type ClubSnapshot,
  type Situation,
  type SituationModel,
} from './situationSnapshot';

/**
 * A chat turn's research, planned by the model instead of fixed query templates:
 *
 * 1. Brief: one call with medium thinking works out what the user is really asking, what is
 *    distinctive or changed this season, the answer's outline, and the lookups in two stages.
 * 2. Facts: the live feeds and fact searches run in parallel, alongside each club's stored daily
 *    snapshot (or a new one being built for everyone).
 * 3. Analysis: tactical searches start once the live facts are in and read their sources against
 *    them, so a piece about last season's team can't pass for this one.
 * 4. Reflect and snapshot, in parallel: a quick call reads what came back, sets aside sources from
 *    earlier seasons that the facts contradict, and may ask for one more round; the situation
 *    snapshot turns the evidence into a dated picture of the present for the writer.
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
}

/** Lookups in the first round, and in the reflect round. */
export const FIRST_ROUND_LIMIT = 6;
export const SECOND_ROUND_LIMIT = 3;
/** Clubs per turn that get live data through the snapshot path. */
export const MAX_SNAPSHOT_CLUBS = 3;
/** How long the brief waits for stored snapshots before planning without them. */
export const STORED_PEEK_MS = 700;
/** How long analysis searches wait for the live facts before starting without them. */
export const ANALYSIS_WAIT_MS = 2_500;
/**
 * After the first round, how much longer a snapshot still building gets. One that misses it
 * finishes in the background for the next turn and other users; this turn works it out itself.
 */
export const SNAPSHOT_GRACE_MS = 500;
/** Past this point in the turn, research stops after the first round. */
export const REFLECT_CUTOFF_MS = 9_000;
/** Past this point, the situation snapshot is what code works out, without the model's call. */
export const SITUATION_CUTOFF_MS = 10_000;

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
   Each call needs a purpose: the fact it is meant to establish. A historical or timeless question answered from stored cards may need no calls; don't fetch cards that are already in play. For a question about the present, live club data for the clubs named in the message is fetched without a call.

Tools:
${RESEARCH_TOOL_GUIDE}

${RESEARCH_COVERAGE_NOTE}

${ctx.storedSnapshots?.length ? `Already loaded: today's stored snapshot for ${ctx.storedSnapshots.map((s) => `${s.club} (as of ${s.asOf})`).join(', ')}, with the first-choice XI, absences, recent form, what changed since last season and what is distinctive this season. Don't plan lookups for those; plan only what the question needs beyond them.\n\n` : ''}${ctx.hints.clubs.length || ctx.hints.players.length ? `Names spotted in the message: ${[...ctx.hints.clubs, ...ctx.hints.players].join(', ')}\n` : ''}${ctx.cardsInPlay.length ? `Cards already in play: ${ctx.cardsInPlay.join(', ')}\n` : ''}
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
      thinkingLevelOverride: 'medium',
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
  snapshot: Promise<ClubSnapshot | null> | null;
}

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
  const { currentSeason, seasonStartYear } = getCurrentSeasonInfo();
  const seasonStart = seasonStartDate(seasonStartYear);

  // Each club is looked up once: its live data, its stored snapshot and, for a question about the
  // present, a new snapshot when there's no fresh one.
  const clubs: ClubJob[] = [];
  const openClub = (name: string, build: boolean): ClubJob | null => {
    let job = clubs.find((j) => sameClubName(j.name, name)) ?? null;
    if (!job) {
      if (clubs.length >= MAX_SNAPSHOT_CLUBS) return null;
      const call: ResearchCall = { tool: 'club_recent_team', subject: name, stage: 'facts' };
      const live = executeCall(call, tools);
      job = { name, call, live, stored: snapshots ? snapshots.stored(name, live).catch(() => null) : Promise.resolve(null), snapshot: null };
      clubs.push(job);
    }
    if (build && snapshots && !job.snapshot) job.snapshot = snapshots.get(job.name, job.live).catch(() => null);
    return job;
  };
  if (ctx.present !== false) ctx.hints.clubs.forEach((club) => openClub(club, Boolean(ctx.present)));

  options.onStage?.('Working out what the question needs...');
  const peeked = clubs.length ? await within(Promise.all(clubs.map((j) => j.stored)), STORED_PEEK_MS) : null;
  const storedSnapshots = (peeked ?? []).filter((s): s is ClubSnapshot => s !== null);
  if (clubs.length) options.perf?.(`stored snapshots (${storedSnapshots.length}/${clubs.length})`);

  let brief: ResearchBrief;
  try {
    brief = await model.writeBrief({ ...ctx, storedSnapshots: storedSnapshots.map((s) => ({ club: s.club, asOf: s.core.asOf })) });
  } catch (e) {
    console.warn('[Research] Brief failed, planning from the names in the message:', e);
    brief = fallbackBrief(ctx);
  }
  options.perf?.(`brief (${brief.timeframe}, ${brief.calls.length} lookups)`);
  const isLive = brief.timeframe === 'live';
  if (brief.calls.length === 0 && !(isLive && clubs.length > 0)) return { brief, ledger: emptyLedger(), situation: null };

  // The brief's club lookups go through the club jobs; on a question about the present, so do the
  // clubs the router spotted, each with its snapshot.
  const jobs: ClubJob[] = isLive ? [...clubs] : [];
  if (isLive) clubs.forEach((j) => openClub(j.name, true));
  const otherCalls: ResearchCall[] = [];
  for (const call of brief.calls) {
    const job = call.tool === 'club_recent_team' ? openClub(call.subject, isLive) : null;
    if (job) {
      if (!jobs.includes(job)) jobs.push(job);
    } else otherCalls.push(call);
  }
  const facts = otherCalls.filter((c) => c.stage !== 'analysis');
  const analysis = otherCalls.filter((c) => c.stage === 'analysis');

  options.onStage?.(describeRound([...jobs.map((j) => j.call), ...facts, ...analysis]));
  const factRuns = facts.map((c) => executeCall(c, tools));
  // Analysis reads its sources against the live facts, so it waits for the feeds (not the fact
  // searches) for a moment, then starts with whatever facts are in.
  const feedRuns = [...jobs.map((j) => j.live), ...factRuns.filter((_, i) => facts[i].tool !== 'web_search')];
  const settled = new Map<Promise<ToolOutcome>, ToolOutcome>();
  feedRuns.forEach((p) => p.then((o) => settled.set(p, o)).catch(() => {}));
  if (analysis.length && feedRuns.length) await within(Promise.all(feedRuns), ANALYSIS_WAIT_MS);
  const factsSoFar = feedRuns.map((p) => settled.get(p)?.result).filter((r): r is NonNullable<ToolOutcome['result']> => Boolean(r));
  const context = analysis.length
    ? formatFactContext(
        factsSoFar.flatMap((r) => (r.club ? [deriveClubCore(r.club)] : [])),
        factsSoFar.filter((r) => r.kind === 'player_record').map((r) => r.content),
      )
    : '';
  const analysisRuns = analysis.map((c) => executeCall(c, tools, context || undefined));

  const [clubOutcomes, factOutcomes, analysisOutcomes] = await Promise.all([
    Promise.all(jobs.map((j) => j.live)),
    Promise.all(factRuns),
    Promise.all(analysisRuns),
  ]);
  let ledger = fileOutcomes(
    emptyLedger(),
    [...jobs.map((j) => j.call), ...facts, ...analysis],
    [...clubOutcomes, ...factOutcomes, ...analysisOutcomes],
  );
  options.perf?.(
    `research round 1 (${jobs.length + facts.length} facts, ${analysis.length} analysis; ${ledger.entries.length} found, ${ledger.gaps.length} missing)`,
  );

  // The situation snapshot runs alongside reflect. Snapshots ready by now (or within a short
  // grace) are used; one still building finishes for the next turn while this one works it out.
  const players = [...new Set([...ctx.hints.players, ...brief.calls.filter((c) => c.tool === 'player_season').map((c) => c.subject)])];
  const situationRun = isLive
    ? (async () => {
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
      })()
    : Promise.resolve(null);

  if (now() - start < REFLECT_CUTOFF_MS) {
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
      if (!verdict.enough && verdict.calls.length > 0) {
        options.onStage?.(describeRound(verdict.calls));
        ledger = await runCalls(verdict.calls, tools, ledger);
        brief = { ...brief, calls: [...brief.calls, ...verdict.calls] };
        options.perf?.(`research round 2 (${ledger.entries.length} found, ${ledger.gaps.length} missing)`);
      }
    }
  }
  return { brief, ledger, situation: await situationRun };
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
