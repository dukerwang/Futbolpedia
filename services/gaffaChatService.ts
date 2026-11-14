import { Type } from '@google/genai';
import type { GaffaContextBag, GaffaRosterPlayer, GaffaTradeScorecard, GaffaTradeVerdict } from '../types';
import { generateJsonWithSchema } from './geminiService';
import { buildRosterCapacityNote, inferInvolvedGaffaSlots } from './gaffaLineupAudit';

/**
 * The Gaffa trade scorecard: four factors scored by the model, the verdict computed in code, and
 * the locked block the writer must match (`gaffaTurn.ts` adds it on a trade turn).
 */

type GaffaTradeScorecardRaw = Omit<GaffaTradeScorecard, 'verdict' | 'confidence' | 'net'>;

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

/** Highest net (inclusive) for each verdict; anything above the last band is a take. */
const VERDICT_BANDS: ReadonlyArray<readonly [number, GaffaTradeVerdict]> = [
  [5, 'hold'],
  [7, 'lean_hold'],
  [9, 'toss_up'],
  [11, 'lean_take'],
];

/** 5 = favors taking the incoming package; starter_leverage 5 = favors keeping the outgoing. */
function deriveTradeVerdict(card: Pick<GaffaTradeScorecardRaw, 'replacement' | 'coverage' | 'cash_deployable' | 'starter_leverage'>): {
  verdict: GaffaTradeVerdict;
  confidence: 'low' | 'medium';
  net: number;
} {
  const replacement = clampScore(card.replacement);
  const coverage = clampScore(card.coverage);
  const cash = clampScore(card.cash_deployable);
  const leverage = clampScore(card.starter_leverage);
  // Clamped scores are integers, so net always lands on a band edge or between two.
  const net = replacement + coverage + cash - leverage;
  const verdict = VERDICT_BANDS.find(([maxNet]) => net <= maxNet)?.[1] ?? 'take';

  // Mixed factors (quality drop vs unused cash vs starter leverage) stay uncertain.
  const spread =
    Math.max(replacement, coverage, cash, leverage) - Math.min(replacement, coverage, cash, leverage);
  const confidence: 'low' | 'medium' =
    verdict === 'toss_up' || spread >= 3 || Math.abs(net - 8.5) <= 2 ? 'low' : 'medium';

  return { verdict, confidence, net };
}

const TRADE_SCORE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    outgoing: {
      type: Type.STRING,
      description: 'Outgoing player(s) from the user club (join multiple players with " + ")',
    },
    incoming: {
      type: Type.STRING,
      description: 'Incoming player(s) to the user club (join multiple players with " + ")',
    },
    incoming_cash_eur_m: { type: Type.NUMBER },
    outgoing_cash_eur_m: { type: Type.NUMBER },
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

function isSlotPlayer(p: GaffaRosterPlayer, slot: string): boolean {
  return p.primary_position === slot || (p.secondary_positions ?? []).includes(slot);
}

function slotCoverSummary(bag: GaffaContextBag, slot: string): string {
  const named = (bag.roster ?? [])
    .filter((p) => isSlotPlayer(p, slot))
    .map((p) => `${p.display_name || p.name} [${p.status}]`);
  const xi = (bag.lineup?.starters ?? []).filter((s) => s.slot === slot).map((s) => s.name);
  const bench = (bag.lineup?.bench ?? []).map((s) => `${s.name} (${s.slot})`);
  return `XI ${slot}: ${xi.join(', ') || 'none'}. Roster ${slot}: ${named.join(', ') || 'none listed'}. Bench: ${bench.join(', ') || 'none'}.`;
}

function clipClause(s: string, maxWords: number): string {
  const trimmed = (s || '').trim();
  if (!trimmed) return trimmed;
  const words = trimmed.split(/\s+/);
  if (words.length <= maxWords) return trimmed;
  return `${words.slice(0, maxWords).join(' ').replace(/[.,;:]+$/, '')}.`;
}

function marketSpendSummary(bag: GaffaContextBag): string {
  const listings = bag.open_listings ?? [];
  const auctions = bag.open_auctions ?? [];
  const fa = bag.free_agents;
  const others = listings.filter((l) => !l.yours);
  const faCount = fa?.length ?? 0;
  if (others.length === 0 && auctions.length === 0 && faCount === 0) {
    if (fa == null) {
      return 'Market: no bid-able listings or live auctions; unowned FA list not in this bag — do not treat that as empty FA.';
    }
    return 'Market: no bid-able listings, live auctions, or unowned FA players.';
  }
  const listingBits = others
    .slice(0, 8)
    .map((l) => {
      const floor = l.min_bid_eur_m ?? l.ask_eur_m ?? l.release_clause_eur_m;
      return `${l.name} (${l.position}, ${l.seller_club_name}${floor != null ? `, €${floor}m` : ''})`;
    });
  const auctionBits = auctions
    .slice(0, 8)
    .map((a) => `${a.name} (${a.position}${a.highest_bid_eur_m != null ? `, high €${a.highest_bid_eur_m}m` : ''})`);
  const faBit =
    fa == null
      ? 'FA pool not in bag'
      : faCount
        ? `FA pool: ${faCount} unowned (nominate to open an auction)`
        : 'FA pool empty';
  return `Bid-able listings: ${listingBits.join('; ') || 'none'}. Live auctions: ${auctionBits.join('; ') || 'none'}. ${faBit}.`;
}

const NOTE_MAX_WORDS = 22;
const FLIP_MAX_WORDS = 36;

export async function buildTradeScorecard(params: {
  message: string;
  factualFoundation: string;
  bag: GaffaContextBag;
  ongoingThread: string;
}): Promise<GaffaTradeScorecard> {
  const combinedQuery = [params.message, params.ongoingThread].filter(Boolean).join(' ');
  const involvedSlots = inferInvolvedGaffaSlots(combinedQuery, params.bag);
  const rosterCapacityNote = buildRosterCapacityNote(params.bag);

  const connected = params.bag.connected
    ? [
        `Connected club: ${params.bag.club_name}. Balance €${params.bag.budget_eur_m}m. Rank ${params.bag.standings?.rank ?? '?'}.`,
        rosterCapacityNote,
        `XI: ${(params.bag.lineup?.starters ?? []).map((s) => `${s.name} (${s.slot})`).join(', ') || 'unknown'}.`,
        ...involvedSlots.map((slot) => slotCoverSummary(params.bag, slot)),
        marketSpendSummary(params.bag),
      ].join(' ')
    : 'Not connected — do not invent roster/budget.';

  const raw = await generateJsonWithSchema<GaffaTradeScorecardRaw>({
    temperature: 0.15,
    systemInstruction: `You score Gaffa dynasty trades (1-for-1 or multi-asset packages). Integers 1-5 only. Do not pick a final verdict.
CURRENT CLUB: use foundation + locked roster PL club; never last season's club.
SLOTS INVOLVED: ${involvedSlots.join(', ')}. Evaluate replacement and coverage at the actual slot(s) involved.
ROSTER CAPACITY & HELD LOCK: if a 2-for-1 incoming package is proposed into a full squad, factor the forced drop + 20% MV severance into coverage/replacement; if a held player lock is active, note that net-in multi-player trades are blocked until the held player is resolved.
cash_deployable: score 1 or 2 if the club already has a large balance AND the user named no spend target AND there is no bid-able listing, live auction, or unowned FA player in the locked market. If OTHER clubs have listings, there are live auctions, or free_agents is a non-empty list, (b) spend path exists — typically 3, not 1. Nominating an unowned FA player is a spend path. Extra cash on a pile is not automatically 4–5. Listings marked YOURS are not a spend path.
replacement: elite clinical starter vs a lower-ceiling option at ${involvedSlots[0] ?? 'the slot'} is typically 2, not 4.
coverage: academy/developmental-only backup at ${involvedSlots.join('/')} is 1–2, not 4. coverage_note MUST name the actual backups from Roster ${involvedSlots.join('/')} (name + status). Never claim there is no other option if bench/academy names are listed.
starter_leverage: locked starting difference-maker on a top-table club is 4–5.
Notes: one short clause, max 22 words.
what_would_flip: a realistic new fact that would change THIS call given the locked bag. With a large unused balance, selling the outgoing to fund some other position is NOT a flip — they can already buy that player. Good flips: a named target they cannot afford without this extra cash; outgoing long-term unavailable; incoming clearly matching outgoing quality. Start with "If".`,
    schema: TRADE_SCORE_SCHEMA,
    prompt: `${connected}

${params.ongoingThread}

<factual_foundation>
${params.factualFoundation || 'none'}
</factual_foundation>

User: ${params.message}

Score the four factors.`,
  });

  const derived = deriveTradeVerdict(raw);
  return {
    ...raw,
    involved_slots: involvedSlots,
    roster_capacity_note: rosterCapacityNote || undefined,
    replacement_note: clipClause(raw.replacement_note, NOTE_MAX_WORDS),
    coverage_note: clipClause(raw.coverage_note, NOTE_MAX_WORDS),
    cash_note: clipClause(raw.cash_note, NOTE_MAX_WORDS),
    leverage_note: clipClause(raw.leverage_note, NOTE_MAX_WORDS),
    what_would_flip: clipClause(raw.what_would_flip, FLIP_MAX_WORDS),
    ...derived,
  };
}

function cashSuffix(eurM: number | undefined): string {
  return eurM && eurM > 0 ? ` + €${eurM}m` : '';
}

export function formatScorecardBlock(card: GaffaTradeScorecard): string {
  const outCash = cashSuffix(card.outgoing_cash_eur_m);
  const inCash = cashSuffix(card.incoming_cash_eur_m);
  return `<locked_scorecard>
Verdict (computed in code, not by you): ${card.verdict}
Confidence (max allowed): ${card.confidence}
Net: ${card.net} (replacement ${card.replacement} + coverage ${card.coverage} + cash ${card.cash_deployable} − leverage ${card.starter_leverage})
Slots evaluated: ${(card.involved_slots ?? ['ST']).join(', ')}${card.roster_capacity_note ? ` | ${card.roster_capacity_note}` : ''}
Outgoing: ${card.outgoing} (${card.outgoing_club})${outCash}
Incoming: ${card.incoming} (${card.incoming_club})${inCash}
Notes: ${card.replacement_note} | ${card.coverage_note} | ${card.cash_note} | ${card.leverage_note}
What would flip: ${card.what_would_flip}

The user already sees this scorecard in the UI. Do not re-narrate every factor. Do not repeat the would-flip line.
You MUST match this verdict. You MUST NOT sound more sure than ${card.confidence}.
If toss_up or lean_* or low confidence: say it is close.
SHAPE: (1) one sentence hedged call using the verdict + confidence words (2) one sentence strongest case for the other side (3) two sentences max tying the locked numbers.
HARD CAP 110 words. Two short paragraphs. No First/Second/Finally sermons.
Banned: outstanding, do not pull the trigger, obliterates, without hesitation, the kind of move that wins leagues, sharper move, unmistakable, talismanic, textbook, years trying to acquire, dead capital.
</locked_scorecard>`;
}

export const SCORECARD_FAILED_BLOCK = `<locked_scorecard>
Scorecard failed. Treat this as toss_up with low confidence. Do not sound sure either way. Give both sides and what you would need to lock a call. Max 120 words.
</locked_scorecard>`;
