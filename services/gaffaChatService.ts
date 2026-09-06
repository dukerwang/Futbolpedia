import { Type } from '@google/genai';
import type { ChatMessage, GaffaContextBag } from '../types';
import {
  buildGaffaSystemInstruction,
  emptyGaffaContextBag,
} from '../constants/gaffaRules';
import { SIMULATION_SEASON, SIMULATION_YEAR } from '../constants';
import { gatherSearchFoundation, generateJsonWithSchema, sendProseChatMessage } from './geminiService';
import { buildOngoingThreadBlock, CONTINUITY_REMINDER } from './chatContinuity';

export type GaffaTurnKind = 'rules' | 'strategy' | 'player_trade';

export type GaffaTradeVerdict = 'hold' | 'lean_hold' | 'toss_up' | 'lean_take' | 'take';

interface GaffaTradeScorecardRaw {
  outgoing: string;
  incoming: string;
  incoming_cash_eur_m: number;
  outgoing_club: string;
  incoming_club: string;
  replacement: number;
  coverage: number;
  cash_deployable: number;
  starter_leverage: number;
  replacement_note: string;
  coverage_note: string;
  cash_note: string;
  leverage_note: string;
  what_would_flip: string;
}

export interface GaffaTradeScorecard extends GaffaTradeScorecardRaw {
  verdict: GaffaTradeVerdict;
  confidence: 'low' | 'medium';
  net: number;
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

/** 5 = favors taking the incoming package; starter_leverage 5 = favors keeping the outgoing. */
export function deriveTradeVerdict(card: Pick<GaffaTradeScorecardRaw, 'replacement' | 'coverage' | 'cash_deployable' | 'starter_leverage'>): {
  verdict: GaffaTradeVerdict;
  confidence: 'low' | 'medium';
  net: number;
} {
  const replacement = clampScore(card.replacement);
  const coverage = clampScore(card.coverage);
  const cash = clampScore(card.cash_deployable);
  const leverage = clampScore(card.starter_leverage);
  const net = replacement + coverage + cash - leverage;

  let verdict: GaffaTradeVerdict;
  if (net <= 5) verdict = 'hold';
  else if (net === 6 || net === 7) verdict = 'lean_hold';
  else if (net === 8 || net === 9) verdict = 'toss_up';
  else if (net === 10 || net === 11) verdict = 'lean_take';
  else verdict = 'take';

  // Mixed factors (e.g. quality drop + huge cash) stay uncertain.
  const spread = Math.max(replacement, coverage, cash) - Math.min(replacement, coverage, cash);
  const confidence: 'low' | 'medium' =
    verdict === 'toss_up' || spread >= 3 || Math.abs(net - 8.5) <= 2 ? 'low' : 'medium';

  return { verdict, confidence, net };
}

const TRADE_SCORE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    outgoing: { type: Type.STRING },
    incoming: { type: Type.STRING },
    incoming_cash_eur_m: { type: Type.NUMBER },
    outgoing_club: { type: Type.STRING },
    incoming_club: { type: Type.STRING },
    replacement: { type: Type.INTEGER, description: '1 incoming is a big quality drop at the slot; 5 incoming matches or beats outgoing' },
    coverage: { type: Type.INTEGER, description: '1 roster cannot absorb losing outgoing; 5 easily absorbs' },
    cash_deployable: { type: Type.INTEGER, description: '1 no named spend path / surplus already huge; 5 named hole AND near-term way to spend' },
    starter_leverage: { type: Type.INTEGER, description: '1 outgoing is not a locked starter in a title window; 5 contending AND outgoing is the XI spearhead' },
    replacement_note: { type: Type.STRING },
    coverage_note: { type: Type.STRING },
    cash_note: { type: Type.STRING },
    leverage_note: { type: Type.STRING },
    what_would_flip: { type: Type.STRING },
  },
  required: [
    'outgoing',
    'incoming',
    'incoming_cash_eur_m',
    'outgoing_club',
    'incoming_club',
    'replacement',
    'coverage',
    'cash_deployable',
    'starter_leverage',
    'replacement_note',
    'coverage_note',
    'cash_note',
    'leverage_note',
    'what_would_flip',
  ],
};

function looksLikeAssetTrade(message: string): boolean {
  return (
    /\b(trade|swap|package)\b/i.test(message) ||
    (/€|\b\d+(\.\d+)?\s*m\b/i.test(message) && /\b(for|and|vs|versus)\b/i.test(message))
  );
}

async function buildTradeScorecard(params: {
  message: string;
  factualFoundation: string;
  bag: GaffaContextBag;
  ongoingThread: string;
}): Promise<GaffaTradeScorecard> {
  const connected = params.bag.connected
    ? `Connected club: ${params.bag.club_name}. Balance €${params.bag.budget_eur_m}m. Rank ${params.bag.standings?.rank ?? '?'}. XI: ${(params.bag.lineup?.starters ?? []).map((s) => s.name).join(', ') || 'unknown'}.`
    : 'Not connected — do not invent roster/budget.';

  const raw = await generateJsonWithSchema<GaffaTradeScorecardRaw>({
    temperature: 0.15,
    systemInstruction: `You score Gaffa dynasty trades. Integers 1-5 only. Do not pick a final verdict.
CURRENT CLUB: use foundation + locked roster PL club; never last season's club.
cash_deployable: score 1 or 2 if the club already has a large balance AND the user named no spend target AND there is no open-window/auction path in the message. Extra cash on a pile is not automatically 4–5.
replacement: elite clinical #9 vs a high-work lower-ceiling striker is typically 2, not 4.
coverage: academy/developmental-only ST backup is 1–2, not 4.
starter_leverage: locked starting ST on a top-table club is 4–5.`,
    schema: TRADE_SCORE_SCHEMA,
    prompt: `${connected}

${params.ongoingThread}

<factual_foundation>
${params.factualFoundation || 'none'}
</factual_foundation>

User: ${params.message}

Score the four factors. Notes must be one sentence each. what_would_flip: the smallest real-world change that would move the call.`,
  });

  const derived = deriveTradeVerdict(raw);
  return { ...raw, ...derived };
}

function formatScorecardBlock(card: GaffaTradeScorecard): string {
  return `<locked_scorecard>
Verdict (computed in code, not by you): ${card.verdict}
Confidence (max allowed): ${card.confidence}
Net: ${card.net} (replacement ${card.replacement} + coverage ${card.coverage} + cash ${card.cash_deployable} − leverage ${card.starter_leverage})
Outgoing: ${card.outgoing} (${card.outgoing_club})
Incoming: ${card.incoming} (${card.incoming_club}) + €${card.incoming_cash_eur_m}m
Notes: ${card.replacement_note} | ${card.coverage_note} | ${card.cash_note} | ${card.leverage_note}
What would flip: ${card.what_would_flip}

You MUST match this verdict. You MUST NOT sound more sure than ${card.confidence}.
If toss_up or lean_*: say it is close. Do not write "outstanding", "do not pull the trigger" as gospel, "obliterates", "without hesitation", or "the kind of move that wins leagues".
Lead with a hedged call, give the strongest case for the other side in one breath, then the locked call and what would flip it.
</locked_scorecard>`;
}

export function classifyGaffaTurn(message: string): GaffaTurnKind {
  const hasNamedPlayerish = /\b[A-Z][a-zà-öø-ÿ]+(?:\s+[A-Z][a-zà-öø-ÿ]+)+\b/.test(message);
  const hasTradeMoney =
    /\b(trade|swap|package)\b/i.test(message) ||
    (/€|\b\d+(\.\d+)?\s*m\b/i.test(message) && /\b(for|and|vs|versus)\b/i.test(message));
  const hasPlayerEval =
    /\b(rate|rating|scout|profile|evaluate|how good|nailed|minutes|role|compare|versus|\bvs\.?\b)\b/i.test(
      message,
    );
  const hasRulesCue =
    /\b(oop|out[-\s]?of[-\s]?position|auto[-\s]?sub|eligibility|formation lock|player lock|draw band|bench depth|injured reserve|\bir\b|club balance|release clause|severance|solidarity|loan cap|how does|what(?:'s| is) the rule)\b/i.test(
      message,
    ) ||
    /\bcan a (?:cb|lb|rb|lwb|rwb|gk|dm|cm|am|lw|rw|st)\b/i.test(message) ||
    (/\bbench\b/i.test(message) && /\b(cover|def|mid|att|flex)\b/i.test(message));

  if (hasTradeMoney || ((hasNamedPlayerish || hasPlayerEval) && !hasRulesCue)) {
    return 'player_trade';
  }
  if (hasRulesCue && !hasNamedPlayerish) return 'rules';
  if (hasRulesCue) return 'rules';
  return 'strategy';
}

/** If the open thread was a trade/player eval, keep researching those assets on context follow-ups. */
function threadNeedsPlayerResearch(history: ChatMessage[]): boolean {
  const recentUser = [...history]
    .reverse()
    .find((m) => m.sender === 'user' && typeof m.content === 'string');
  if (!recentUser || typeof recentUser.content !== 'string') return false;
  return classifyGaffaTurn(recentUser.content) === 'player_trade';
}

function buildResearchQueries(message: string, speed: 'default' | 'fast', threadHint?: string): string[] {
  const datePrefix = `[Date context: ${SIMULATION_SEASON} / ${SIMULATION_YEAR}]`;
  const focus = threadHint
    ? `${message}\n(Open thread context: ${threadHint.slice(0, 280)})`
    : message;
  const clubLock = `${datePrefix} CURRENT CLUB CHECK for every player named in: ${focus}. For each, state the club they play for NOW (${SIMULATION_YEAR} / ${SIMULATION_SEASON}), not last season. Call out summer transfers.`;
  const rest = [
    `${datePrefix} ${focus} — ages, positions, injury/availability, recent role and minutes at their CURRENT club.`,
    `${datePrefix} ${focus} — Premier League transfer links, PL exit/arrival risk, tactical usage this season.`,
  ];
  if (speed === 'fast') return [clubLock, rest[0]];
  return [clubLock, ...rest];
}

/** Strip leaked grounding citations from user-facing Gaffa prose. */
export function sanitizeGaffaProse(text: string): string {
  return text
    .replace(/\s*\[(?:Search|Source|Grounding)\s*\d+(?:\s*[,&]\s*(?:Search|Source|Grounding)\s*\d+)*\]/gi, '')
    .replace(/\s*\((?:Search|Source)\s*\d+(?:\s*[,&]\s*(?:Search|Source)\s*\d+)*\)/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export async function sendGaffaMessage(
  message: string,
  history: ChatMessage[],
  options?: {
    speed?: 'default' | 'fast';
    imageData?: string;
    contextBag?: GaffaContextBag;
  },
): Promise<string> {
  const speed = options?.speed ?? 'default';
  const bag = options?.contextBag ?? emptyGaffaContextBag();
  const kind = classifyGaffaTurn(message);
  const systemInstruction = buildGaffaSystemInstruction(bag);
  const ongoingThread = buildOngoingThreadBlock(history);
  const continuePriorTrade = Boolean(ongoingThread) && threadNeedsPlayerResearch(history);

  let factualFoundation = '';
  const shouldResearch =
    kind === 'player_trade' ||
    continuePriorTrade ||
    (kind === 'strategy' &&
      /\b(player|squad|minutes|form|injury|transfer|striker|backup)\b/i.test(message));

  if (shouldResearch) {
    try {
      const priorUser = [...history]
        .reverse()
        .find((m) => m.sender === 'user' && typeof m.content === 'string');
      const threadHint =
        continuePriorTrade && priorUser && typeof priorUser.content === 'string'
          ? priorUser.content
          : undefined;
      factualFoundation = await gatherSearchFoundation(
        buildResearchQueries(message, speed, threadHint),
      );
    } catch (err) {
      console.warn('[Gaffa] research foundation failed:', err);
      factualFoundation =
        'Research unavailable this turn — answer carefully and hedge where evidence is thin.';
    }
  }

  let scorecardBlock = '';
  const runScorecard =
    looksLikeAssetTrade(message) ||
    (continuePriorTrade &&
      history.some((m) => m.sender === 'user' && typeof m.content === 'string' && looksLikeAssetTrade(m.content)));

  if (runScorecard) {
    try {
      const card = await buildTradeScorecard({
        message,
        factualFoundation,
        bag,
        ongoingThread,
      });
      scorecardBlock = formatScorecardBlock(card);
    } catch (err) {
      console.warn('[Gaffa] trade scorecard failed:', err);
      scorecardBlock = `<locked_scorecard>
Scorecard failed. Treat this as toss_up with low confidence. Do not sound sure either way. Give both sides and what you would need to lock a call.
</locked_scorecard>`;
    }
  }

  const prompt = `<gaffa_turn kind="${kind}" speed="${speed}">
${ongoingThread ? `${ongoingThread}\n` : ''}
${factualFoundation ? `<factual_foundation>\n${factualFoundation}\n</factual_foundation>\n` : ''}
${scorecardBlock ? `${scorecardBlock}\n` : ''}
<task>
${message}
</task>
<reminders>
- Prose Markdown only. No dossier JSON. Never print the scorecard XML.
- Prefer the rules snapshot for mechanics questions.
- If not connected to a club, do not invent roster/standings/prices; caveat unknown club context on trade takes.
- Never use fantasy points as proof of football quality.
- If a locked_scorecard is present: match its verdict and confidence. Do not out-confident it. Close calls stay close.
- Surplus cash without a named near-term spend is not a reason to sell a locked starter.
- Confirm each named player's CURRENT club from the foundation or locked roster before describing their role. Do not default to last season's club.
- Never write [Search 1], [Search 2], or similar citations.
- Once you have a verdict in this thread, do not reverse it without naming a new material fact.
- A user fact-correction updates the fact; it does not automatically strengthen your prior take.
- ${CONTINUITY_REMINDER}
- Prefer a flowing scout take over checklist labels like "DO IT IF" / "HOLD IF" unless the user asks for a decision framework.
- Do not lecture on scoring-curve math unless asked how points work.
</reminders>
</gaffa_turn>`;

  const prose = await sendProseChatMessage(prompt, history, {
    imageData: options?.imageData,
    thinkingLevel: runScorecard || kind === 'player_trade' ? 'medium' : kind === 'rules' ? 'minimal' : 'low',
    temperature: runScorecard ? 0.4 : kind === 'player_trade' ? 0.35 : kind === 'strategy' ? 0.5 : undefined,
    systemInstruction,
    conversationProfiles: [],
  });
  return sanitizeGaffaProse(prose);
}
