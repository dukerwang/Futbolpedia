import type { ChatMessage, GaffaContextBag } from '../types';
import {
  buildGaffaSystemInstruction,
  emptyGaffaContextBag,
} from '../constants/gaffaRules';
import { SIMULATION_SEASON, SIMULATION_YEAR } from '../constants';
import { gatherSearchFoundation, sendProseChatMessage } from './geminiService';

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

function buildResearchQueries(message: string, speed: 'default' | 'fast'): string[] {
  const datePrefix = `[Date context: ${SIMULATION_SEASON} / ${SIMULATION_YEAR}]`;
  const base = [
    `${datePrefix} ${message} — current clubs, ages, positions, injury/availability, recent role and minutes.`,
    `${datePrefix} ${message} — Premier League transfer links, PL exit/arrival risk, tactical usage.`,
  ];
  if (speed === 'fast') return base.slice(0, 1);
  return [
    ...base,
    `${datePrefix} ${message} — career phase, set-piece role, competition for minutes this season.`,
  ];
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

  let factualFoundation = '';
  if (kind === 'player_trade' || (kind === 'strategy' && /\b(player|squad|minutes|form|injury|transfer)\b/i.test(message))) {
    try {
      factualFoundation = await gatherSearchFoundation(buildResearchQueries(message, speed));
    } catch (err) {
      console.warn('[Gaffa] research foundation failed:', err);
      factualFoundation =
        'Research unavailable this turn — answer carefully and hedge where evidence is thin.';
    }
  }

  const prompt = `<gaffa_turn kind="${kind}" speed="${speed}">
${factualFoundation ? `<factual_foundation>\n${factualFoundation}\n</factual_foundation>\n` : ''}
<task>
${message}
</task>
<reminders>
- Prose Markdown only. No dossier JSON.
- Prefer the rules snapshot for mechanics questions.
- If not connected to a club, do not invent roster/standings/prices; caveat unknown club context on trade takes.
- Never use fantasy points as proof of football quality.
</reminders>
</gaffa_turn>`;

  return sendProseChatMessage(prompt, history, {
    imageData: options?.imageData,
    thinkingLevel: kind === 'rules' ? 'minimal' : 'low',
    systemInstruction,
    conversationProfiles: [],
  });
}
