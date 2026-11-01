import { Type } from '@google/genai';
import { generateStructured, getCurrentSeasonInfo } from './aiClient';
import { emptyLedger, formatLedger, type EvidenceLedger } from './evidenceLedger';
import {
  RESEARCH_TOOL_GUIDE,
  RESEARCH_TOOLS,
  runCalls,
  sanitizeCalls,
  type ResearchCall,
  type ResearchToolset,
} from './researchTools';

/**
 * A chat turn's research, planned by the model instead of fixed query templates:
 *
 * 1. Brief: one call with medium thinking works out what the user is really asking, what a good
 *    answer must establish, its outline, and the first round of lookups.
 * 2. Research: code runs that round in parallel.
 * 3. Reflect: a quick call reads what came back and may ask for one more round to fill a gap,
 *    settle a conflict, or follow up something unexpected.
 *
 * The writer then gets the brief and the evidence, so its own thinking can stay light.
 */

export interface ResearchBrief {
  /** What the user wants answered, including what a good answer has to establish first. */
  understanding: string;
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
}

/** Lookups in the first round, and in the reflect round. */
export const FIRST_ROUND_LIMIT = 6;
export const SECOND_ROUND_LIMIT = 3;
/** Past this point in the turn, research stops after the first round. */
export const REFLECT_CUTOFF_MS = 12_000;

const CALL_ITEM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    tool: { type: Type.STRING, enum: [...RESEARCH_TOOLS] },
    subject: { type: Type.STRING },
    country: { type: Type.STRING },
    edition: { type: Type.STRING, enum: ['current', 'prime'] },
    purpose: { type: Type.STRING },
  },
  required: ['tool', 'subject', 'purpose'],
};

const BRIEF_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    understanding: { type: Type.STRING },
    timeframe: { type: Type.STRING, enum: ['live', 'historical', 'timeless'] },
    outline: { type: Type.ARRAY, items: { type: Type.STRING } },
    calls: { type: Type.ARRAY, items: CALL_ITEM_SCHEMA },
  },
  required: ['understanding', 'timeframe', 'outline', 'calls'],
};

const REFLECT_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    enough: { type: Type.BOOLEAN },
    calls: { type: Type.ARRAY, items: CALL_ITEM_SCHEMA },
    unresolved: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['enough', 'calls', 'unresolved'],
};

export const buildBriefPrompt = (ctx: ResearchContext): string => {
  const { month, year, currentSeason } = getCurrentSeasonInfo();
  return `You are planning the research for a football analyst's answer. Today is ${month} ${year}, in the ${currentSeason} season. Your memory of current squads, roles, form, injuries, transfers and managers is at least a season out of date, so every current fact the answer depends on has to be looked up.

Work out:
1. understanding: what the user wants answered, read in the light of the conversation. Include what a good answer has to establish before it can answer: for a question about how a team plays, who has actually been playing and where; for a question about a player now, his current club, role and form; for a comparison, the same facts for each side.
2. timeframe: "live" when the answer depends on the present season, "historical" when it is about past seasons or players' primes, "timeless" when it is about ideas rather than current facts.
3. outline: the points a strong answer makes, in order, as short phrases.
4. calls: the lookups for the first round, at most ${FIRST_ROUND_LIMIT}, run in parallel. Cover every current fact in the outline. Prefer the API tools for lineups, injuries, squads, player numbers and tables, and use web search for tactical analysis, transfers, news and context they don't cover. Each call needs a purpose: the fact it is meant to establish. A historical or timeless question answered from stored cards may need no calls; don't fetch cards that are already in play.

Tools:
${RESEARCH_TOOL_GUIDE}

${ctx.hints.clubs.length || ctx.hints.players.length ? `Names spotted in the message: ${[...ctx.hints.clubs, ...ctx.hints.players].join(', ')}\n` : ''}${ctx.cardsInPlay.length ? `Cards already in play: ${ctx.cardsInPlay.join(', ')}\n` : ''}
${ctx.thread ? `${ctx.thread}\n` : ''}
<user_message>${ctx.message}</user_message>`;
};

export const buildReflectPrompt = (brief: ResearchBrief, ledger: EvidenceLedger): string => `You are checking whether research is ready for a football analyst to write an answer.

What the answer needs: ${brief.understanding}
Planned outline:
${brief.outline.map((p) => `- ${p}`).join('\n')}

Evidence so far:
${compactLedger(ledger)}

Decide whether this evidence supports every current fact the outline needs. Ask for up to ${SECOND_ROUND_LIMIT} more lookups only when they would change the answer: a needed fact is missing, two sources conflict, or the evidence shows something the plan didn't expect (a player in a key role it didn't account for, a recent signing, an injury) that the answer should explain. Don't repeat a lookup that already came back empty for the same subject. List under unresolved anything the answer needs that still won't be established, in a few words each. Set enough to true when no more lookups are needed.

Tools:
${RESEARCH_TOOL_GUIDE}`;

/** The ledger shortened for the reflect step: each entry's start, and every gap. */
export const compactLedger = (ledger: EvidenceLedger, perEntry = 900): string =>
  formatLedger({
    entries: ledger.entries.map((e) => ({
      ...e,
      content: e.content.length > perEntry ? `${e.content.slice(0, perEntry)}…` : e.content,
      sources: undefined,
    })),
    gaps: ledger.gaps,
  }) || 'Nothing yet.';

/** A plan from the names the router spotted, for when the brief call fails. */
export const fallbackBrief = (ctx: ResearchContext): ResearchBrief => ({
  understanding: ctx.message,
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

export interface ResearchModel {
  writeBrief(ctx: ResearchContext): Promise<ResearchBrief>;
  reflect(brief: ResearchBrief, ledger: EvidenceLedger): Promise<{ enough: boolean; calls: ResearchCall[]; unresolved: string[] }>;
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

export async function runResearch(
  ctx: ResearchContext,
  tools: ResearchToolset,
  options: {
    model?: ResearchModel;
    onStage?: (label: string) => void;
    perf?: (label: string) => void;
    now?: () => number;
  } = {},
): Promise<{ brief: ResearchBrief; ledger: EvidenceLedger }> {
  const model = options.model ?? liveResearchModel;
  const now = options.now ?? Date.now;
  const start = now();

  options.onStage?.('Working out what the question needs...');
  let brief: ResearchBrief;
  try {
    brief = await model.writeBrief(ctx);
  } catch (e) {
    console.warn('[Research] Brief failed, planning from the names in the message:', e);
    brief = fallbackBrief(ctx);
  }
  options.perf?.(`brief (${brief.timeframe}, ${brief.calls.length} lookups)`);
  if (brief.calls.length === 0) return { brief, ledger: emptyLedger() };

  options.onStage?.(describeRound(brief.calls));
  let ledger = await runCalls(brief.calls, tools, emptyLedger());
  options.perf?.(`research round 1 (${ledger.entries.length} found, ${ledger.gaps.length} missing)`);

  if (now() - start < REFLECT_CUTOFF_MS) {
    options.onStage?.('Reading the evidence...');
    try {
      const verdict = await model.reflect(brief, ledger);
      brief = { ...brief, unresolved: verdict.unresolved };
      options.perf?.(`reflect (${verdict.enough ? 'enough' : `${verdict.calls.length} more`})`);
      if (!verdict.enough && verdict.calls.length > 0) {
        options.onStage?.(describeRound(verdict.calls));
        ledger = await runCalls(verdict.calls, tools, ledger);
        brief = { ...brief, calls: [...brief.calls, ...verdict.calls] };
        options.perf?.(`research round 2 (${ledger.entries.length} found, ${ledger.gaps.length} missing)`);
      }
    } catch (e) {
      console.warn('[Research] Reflect failed, writing from the first round:', e);
    }
  }
  return { brief, ledger };
}

/** The brief as the writer reads it. */
export const formatBriefForWriter = (brief: ResearchBrief): string =>
  `<research_brief>
What the user is asking: ${brief.understanding}
${brief.outline.length ? `Planned outline (adapt it to what the evidence shows):\n${brief.outline.map((p) => `- ${p}`).join('\n')}\n` : ''}${
    brief.unresolved.length
      ? `Research couldn't establish: ${brief.unresolved.join('; ')}. Say so where the answer depends on it, in one sentence each, rather than filling it in.\n`
      : ''
  }</research_brief>`;
