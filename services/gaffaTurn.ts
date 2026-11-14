import type { ChatMessage, GaffaContextBag, GaffaTradeScorecard, PlayerProfile } from '../types';
import { GAFFA_RULES_SNAPSHOT, buildLockedMarketTurnBlock } from '../constants/gaffaRules';
import {
  buildGaffaBidValuationBlock,
  escapeRegExp,
  formatLineupAuditPromptBlock,
} from './gaffaLineupAudit';

/**
 * A Gaffa club attached to a native Futbolpedia conversation. Every turn gets a short block naming
 * the club and its squad; what the question is about (its league focus) decides which of the
 * locked blocks join it: the lineup audit, the market and bid math, or a trade scorecard.
 */

export type LeagueFocus = 'none' | 'squad' | 'lineup' | 'market' | 'trade' | 'rules';

export function looksLikeAssetTrade(message: string): boolean {
  return (
    /\b(trade|swap|package)\b/i.test(message) ||
    (/€|\b\d+(\.\d+)?\s*m\b/i.test(message) && /\b(for|and|vs|versus)\b/i.test(message))
  );
}

/** FA / unowned / auction-board questions — Gaffa pool, never real-world free agency. */
export function looksLikeGaffaMarketQuery(message: string): boolean {
  // "FA floor" is a league setting, not the auction board.
  if (/\bfa\s+floor\b/i.test(message) && !/\b(unowned|waiver|auction|listings?)\b/i.test(message)) {
    return false;
  }
  if (
    /\b(free[-\s]?agenc(?:y|ies)|free[-\s]?agents?|unowned|un-owned|waiver(?:s| wire)?)\b/i.test(
      message,
    )
  ) {
    return true;
  }
  if (/\b(?:FA|FAs)\b/i.test(message)) return true;
  if (/\b(auction board|live auctions?|on auction|open listings?)\b/i.test(message)) {
    return true;
  }
  return (
    /\b(highest|best|top)\b/i.test(message) &&
    /\b(potential|upside|prospects?)\b/i.test(message) &&
    /\b(available|unowned|market|sign|bid|buy|claim)\b/i.test(message)
  );
}

function bagMarketNames(bag: GaffaContextBag): string[] {
  const names: string[] = [];
  for (const p of bag.free_agents ?? []) {
    if (p.name) names.push(p.name);
    if (p.display_name) names.push(p.display_name);
  }
  for (const l of bag.open_listings ?? []) {
    if (l.name) names.push(l.name);
  }
  for (const a of bag.open_auctions ?? []) {
    if (a.name) names.push(a.name);
  }
  return names;
}

function messageMentionsBagName(message: string, names: string[]): boolean {
  for (const raw of names) {
    const n = (raw || '').trim();
    if (n.length < 4) continue;
    const re = new RegExp(`(?<!\\p{L})${escapeRegExp(n)}(?!\\p{L})`, 'iu');
    if (re.test(message)) return true;
  }
  return false;
}

/** Availability / buy-from-FA questions, including named unowned players. */
export function looksLikeGaffaAvailabilityQuery(message: string, bag: GaffaContextBag): boolean {
  if (looksLikeGaffaMarketQuery(message)) return true;
  if (!bag.connected) return false;
  if (
    !/\b(buy|sign|claim|bid|available|pickup|pick\s*up|nominate|acquire)\b/i.test(
      message,
    )
  ) {
    return false;
  }
  return messageMentionsBagName(message, bagMarketNames(bag));
}

const LINEUP_CUES = [
  /\b(audit|check|optimi[sz]e|review|set)\b[\s\S]{0,30}\b(lineup|xi|starting|bench|formation|auto-?subs?)\b/i,
  /\b(my|our)\s+(saved\s+)?(xi|lineup|starting\s+(xi|eleven)|bench(\s+order)?|auto-?sub\s+cover|formation)\b/i,
  /\b(who\s+should\s+i\s+(start|bench|play|captain)|who\s+to\s+start|which\s+formation\s+should\s+i)\b/i,
];

const RULES_CUES = [
  /\b(oop|out[-\s]?of[-\s]?position|auto[-\s]?subs?|eligibility|formation lock|player lock|draw band|bench depth|injured reserve|club balance|release clause|severance|solidarity|loan cap|scout'?s fee|fa floor|free[-\s]?agent floor|academy slots?|held player)\b/i,
  /\bhow\s+(does|do)\b[\s\S]{0,40}\b(gaffa|league|auction|bid|loan|trade|transfer day|scoring|points)\b/i,
  /\bwhat(?:'s| is) the rule\b/i,
];

const MARKET_CUES =
  /\b(bid|bids|bidding|auction|auctions|listing|listings|nominate|club balance|budget|sign|buy|claim|transfer day|who should i (?:get|sign|buy|target))\b/i;

const SQUAD_CUES = [
  /\b(my|our)\s+(squad|team|club|roster|side|players?|defen[cs]e|backline|attack|midfield|keepers?|goalkeepers?|strikers?|wingers?|full-?backs?|centre-?backs?|depth)\b/i,
  /\bshould\s+i\s+(sell|keep|drop|release|loan|bench|start|hold)\b/i,
  /\b(weakest|strongest)\s+(slot|position|link|starter)\b/i,
];

function mentionsRosterPlayer(message: string, bag: GaffaContextBag): boolean {
  for (const p of bag.roster ?? []) {
    for (const raw of [p.name, p.display_name]) {
      const n = (raw || '').trim();
      if (n.length < 4) continue;
      if (new RegExp(`(?<!\\p{L})${escapeRegExp(n)}(?!\\p{L})`, 'iu').test(message)) return true;
    }
  }
  return false;
}

/** What one message asks about the attached club, by its wording alone. */
function focusOfMessage(message: string, bag: GaffaContextBag): LeagueFocus {
  if (looksLikeAssetTrade(message)) return 'trade';
  if (LINEUP_CUES.some((re) => re.test(message))) return 'lineup';
  if (looksLikeGaffaAvailabilityQuery(message, bag) || MARKET_CUES.test(message)) return 'market';
  if (RULES_CUES.some((re) => re.test(message))) return 'rules';
  if (SQUAD_CUES.some((re) => re.test(message)) || mentionsRosterPlayer(message, bag)) return 'squad';
  return 'none';
}

/**
 * The turn's league focus. A short follow-up with no cue of its own ("what about his backup?")
 * keeps the focus of the thread's last question.
 */
export function leagueFocusOf(message: string, history: ChatMessage[], bag: GaffaContextBag): LeagueFocus {
  if (!bag.connected) return 'none';
  const own = focusOfMessage(message, bag);
  if (own !== 'none') return own;
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  if (words > 14) return 'none';
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.sender === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return focusOfMessage(m.content, bag);
    }
  }
  return 'none';
}

const SQUAD_LIMIT = 40;

/** The short block every turn with a club attached gets. */
export function formatGaffaClubBlock(bag: GaffaContextBag, focus: LeagueFocus): string {
  const s = bag.standings;
  const lines: string[] = [];
  lines.push(
    `The user manages ${bag.club_name ?? 'a club'} in ${bag.league_name ?? 'a league'} on Gaffa, a Premier League dynasty fantasy game. The club details below come from Gaffa${bag.stale ? ' as of its last sync, which may be out of date' : ''}${bag.synced_at ? ` (${bag.synced_at.slice(0, 16).replace('T', ' ')} UTC)` : ''}.`,
  );
  lines.push(
    focus === 'none'
      ? 'This question may not be about their Gaffa club. Answer it as you normally would, and bring the club in only where it genuinely helps.'
      : 'Answer for this club: its squad, saved lineup, Club Balance and league market as given here.',
  );
  if (s && s.rank != null) {
    lines.push(
      `Table: ${s.rank}${s.of_teams ? ` of ${s.of_teams}` : ''}, ${s.wins}-${s.draws}-${s.losses}, ${s.points_for} fantasy points for.`,
    );
  }
  if (bag.matchup) {
    const score =
      bag.matchup.your_score != null || bag.matchup.opponent_score != null
        ? ` (${bag.matchup.your_score ?? 0}-${bag.matchup.opponent_score ?? 0}, ${bag.matchup.status})`
        : '';
    lines.push(`Gameweek ${bag.matchup.gameweek}: against ${bag.matchup.opponent_club_name ?? 'an opponent to be decided'}${score}.`);
  }
  if (bag.budget_eur_m != null) lines.push(`Club Balance: €${bag.budget_eur_m}m.`);
  const roster = bag.roster ?? [];
  if (roster.length) {
    const squad = roster.slice(0, SQUAD_LIMIT).map((p) => {
      const pos = [p.primary_position, ...(p.secondary_positions ?? [])].join('/');
      const bits = [pos, p.pl_team || 'no PL club', p.status !== 'active' ? p.status : null].filter(Boolean);
      return `${p.display_name || p.name} (${bits.join(', ')})`;
    });
    lines.push(`Squad (${roster.length}): ${squad.join('; ')}${roster.length > SQUAD_LIMIT ? '; …' : ''}.`);
  }
  lines.push(
    'Fantasy points are never evidence of how good a footballer is. A squad player\'s Premier League club is the one listed here. Treat a player as available in this league only when the market list for this turn names him, never from memory or the web.',
  );
  return `<gaffa_club>\n${lines.join('\n')}\n</gaffa_club>`;
}

export interface GaffaTurn {
  focus: LeagueFocus;
  /** Prompt blocks for the writer, in order. */
  block: string;
  /** The trade scorecard shown above the reply, when the turn is a trade. */
  scorecard: GaffaTradeScorecard | null;
  /** Premier League clubs of the starters, for the turn's research when it's about the squad. */
  squadClubs: string[];
}

/** The starters' Premier League clubs, most represented first. */
export function starterClubs(bag: GaffaContextBag, limit = 2): string[] {
  const starters = bag.lineup?.starters ?? [];
  const counts = new Map<string, number>();
  for (const p of bag.roster ?? []) {
    if (!p.pl_team) continue;
    if (!starters.some((s) => s.player_id === p.player_id || s.name === p.name)) continue;
    counts.set(p.pl_team, (counts.get(p.pl_team) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([club]) => club).slice(0, limit);
}

/**
 * Everything a turn needs from the attached club. The trade scorecard is a model call, so it runs
 * only on a trade turn; the module is loaded then, keeping the chat pipeline free of its imports.
 */
export async function buildGaffaTurn(params: {
  message: string;
  history: ChatMessage[];
  bag: GaffaContextBag;
  cards: PlayerProfile[];
  ongoingThread: string;
  factualFoundation?: string;
}): Promise<GaffaTurn> {
  const { message, history, bag, cards } = params;
  const focus = leagueFocusOf(message, history, bag);
  const blocks = [formatGaffaClubBlock(bag, focus)];
  if (focus === 'rules' || focus === 'lineup' || focus === 'market' || focus === 'trade') {
    blocks.push(`<gaffa_rules>\nPrefer these over memory for how Gaffa works.\n${GAFFA_RULES_SNAPSHOT}\n</gaffa_rules>`);
  }
  if (focus === 'lineup' || focus === 'squad') {
    const audit = formatLineupAuditPromptBlock(bag, cards);
    if (audit) blocks.push(audit);
  }
  if (focus === 'market' || focus === 'trade') {
    blocks.push(buildLockedMarketTurnBlock(bag, cards));
    const bid = buildGaffaBidValuationBlock(message, bag, cards);
    if (bid) blocks.push(bid);
  }
  let scorecard: GaffaTradeScorecard | null = null;
  if (focus === 'trade') {
    const { buildTradeScorecard, formatScorecardBlock, SCORECARD_FAILED_BLOCK } = await import('./gaffaChatService');
    try {
      scorecard = await buildTradeScorecard({
        message,
        factualFoundation: params.factualFoundation ?? '',
        bag,
        ongoingThread: params.ongoingThread,
      });
      blocks.push(formatScorecardBlock(scorecard));
    } catch (err) {
      console.warn('[Gaffa] trade scorecard failed:', err);
      blocks.push(SCORECARD_FAILED_BLOCK);
    }
  }
  return {
    focus,
    block: blocks.join('\n'),
    scorecard,
    squadClubs: focus === 'squad' || focus === 'lineup' ? starterClubs(bag) : [],
  };
}

const TRADE_PROSE_MAX_WORDS = 120;
const TRADE_PROSE_MAX_PARAS = 2;

/** Keep scorecard replies short so prose cannot out-talk the lock. */
export function capGaffaTradeProse(text: string): string {
  const paras = text
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, TRADE_PROSE_MAX_PARAS);
  let limited = paras.join('\n\n');
  const wordCount = limited.split(/\s+/).filter(Boolean).length;
  if (wordCount <= TRADE_PROSE_MAX_WORDS) return limited;

  const sentences = limited.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) ?? [limited];
  const kept: string[] = [];
  let count = 0;
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const w = sentence.split(/\s+/).filter(Boolean).length;
    if (count + w > TRADE_PROSE_MAX_WORDS && kept.length > 0) break;
    kept.push(sentence);
    count += w;
  }
  return kept.join(' ').trim();
}
