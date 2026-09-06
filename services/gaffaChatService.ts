import type { ChatMessage, GaffaContextBag } from '../types';
import {
  buildGaffaSystemInstruction,
  emptyGaffaContextBag,
} from '../constants/gaffaRules';
import { SIMULATION_SEASON, SIMULATION_YEAR } from '../constants';
import { gatherSearchFoundation, sendProseChatMessage } from './geminiService';
import { buildOngoingThreadBlock, CONTINUITY_REMINDER } from './chatContinuity';

export type GaffaTurnKind = 'rules' | 'strategy' | 'player_trade';

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

  const prompt = `<gaffa_turn kind="${kind}" speed="${speed}">
${ongoingThread ? `${ongoingThread}\n` : ''}
${factualFoundation ? `<factual_foundation>\n${factualFoundation}\n</factual_foundation>\n` : ''}
<task>
${message}
</task>
<reminders>
- Prose Markdown only. No dossier JSON.
- Prefer the rules snapshot for mechanics questions.
- If not connected to a club, do not invent roster/standings/prices; caveat unknown club context on trade takes.
- Never use fantasy points as proof of football quality.
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
    thinkingLevel: kind === 'rules' ? 'minimal' : 'low',
    systemInstruction,
    conversationProfiles: [],
  });
  return sanitizeGaffaProse(prose);
}
