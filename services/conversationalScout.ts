import { Type } from '@google/genai';
import type { ChatMessage, GaffaContextBag, GaffaTradeScorecard, PlayerProfile } from '../types';
import type { ThinkingTier } from '../constants/modelProfiles';
import { ATTRIBUTE_KEYS } from '../constants/ratingTiers';
import { buildConversationalScoutInstruction } from '../prompts/chatPrompt';
import {
  generateProseTurn,
  type ProseToolMode,
  generateStructured,
  getCurrentSeasonInfo,
  type DossierToolHandlers,
} from './aiClient';
import { buildOngoingThreadBlock, CONTINUITY_REMINDER } from './chatContinuity';
import {
  applyDossierPatch,
  buildHistoryContents,
  buildLockedDossiersBlock,
  DossierPatch,
  findReferencedDossiers,
  getCardKey,
  isPrimeCard,
  mergeAllCalibratedDossiers,
  mostRecentlyShownCard,
  pickCardPerPlayer,
  serializeProfileForHistory,
  recordDossierRevision,
} from './dossierStore';
import { gatherSearchFoundation } from './groundingService';
import { formatBriefForWriter, runResearch, type ResearchBrief } from './researchAgent';
import { liveToolset, type ToolOutcome } from './researchTools';
import { liveClubSnapshots } from './clubSnapshots';
import { formatSituation, type Situation } from './situationSnapshot';
import {
  addEvidence,
  addGap,
  emptyLedger,
  formatLedger,
  hasEvidence,
  seasonStartDate,
  type EvidenceLedger,
} from './evidenceLedger';
import { extractThreadClubs, type TurnRoute } from './turnRouter';
import {
  scrubUnverifiedManagerText,
  type VerifiedClubManager,
} from '../packages/engine/src/gates/managerMentions.ts';
import { formatVerifiedManagersBlock, getVerifiedClubManagers } from './clubManagers';
import { reconcileDossierNumbers } from './dossierNumberGate';
import { cardEdition, toBasePlayerSlug } from './dossierCards';
import { lookUpDossier } from './dossierLookup';
import { buildGaffaTurn, capGaffaTradeProse, leagueFocusOf, starterClubs, type GaffaTurn } from './gaffaTurn';
import { lockGaffaRosterNames } from './gaffaLineupAudit';
import { expandTables, gateUnsupportedFigures, type FigureClaim, type FigureGateOptions } from './figureGate';
import { figureBudget, formatDebateBriefForWriter, runDebateResearch, type DebateBrief } from './debateBrief';
import { standingsFor, type CardStanding } from './debateConsistency';
import { liveDebateRecords, liveEraSnapshots } from './eraSnapshots';

/**
 * What a conversation's last turn found, so a follow-up ("Which full-back is tucking in?") keeps
 * the verified facts and situation snapshot of the turn before. Kept per conversation: on the
 * server, Gaffa managers' conversations run side by side, and one manager's research or club XI
 * must never reach another's follow-up.
 */
export interface ThreadState {
  signature: string;
  grounding: string;
  situationSignature: string;
  situation: string;
  touchedAt: number;
}

const THREAD_STATE_TTL_MS = 60 * 60 * 1000;
const THREAD_STATE_LIMIT = 500;
const threadStates = new Map<string, ThreadState>();

/** The state for a conversation, new when it's unknown or an hour idle. Oldest dropped past the limit. */
export function threadStateFor(conversationId: string, now = Date.now()): ThreadState {
  const existing = threadStates.get(conversationId);
  if (existing && now - existing.touchedAt < THREAD_STATE_TTL_MS) {
    existing.touchedAt = now;
    // Re-inserting keeps the map in least-recently-used order.
    threadStates.delete(conversationId);
    threadStates.set(conversationId, existing);
    return existing;
  }
  const fresh: ThreadState = { signature: '', grounding: '', situationSignature: '', situation: '', touchedAt: now };
  threadStates.delete(conversationId);
  threadStates.set(conversationId, fresh);
  while (threadStates.size > THREAD_STATE_LIMIT) {
    const oldest = threadStates.keys().next().value;
    if (oldest === undefined) break;
    threadStates.delete(oldest);
  }
  return fresh;
}

/**
 * The thread's opening message, so a follow-up can tell it's in the same thread. On the opening
 * turn the history is empty and the message itself opens the thread.
 */
function getThreadSignature(history: ChatMessage[], message: string): string {
  const first = history[0];
  if (!first) return message.slice(0, 60);
  return typeof first.content === 'string' ? first.content.slice(0, 60) : 'dossier';
}

/** Recent string turns of the thread, for finding which players and edition it is about. */
const recentThreadText = (history: ChatMessage[], count = 6): string =>
  history
    .slice(-count)
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');

/**
 * Whether the thread is about players' primes. A follow-up such as "he wasn't better than him"
 * names no timeframe, but continues a prime-versus-prime debate.
 */
export const threadIsHistorical = (route: TurnRoute, history: ChatMessage[], message = ''): boolean =>
  route.isHistorical ||
  (!route.wantsCurrentForm && /\b(prime|peak|all[- ]time|(?:19|20)\d0s)\b/i.test(`${recentThreadText(history)}\n${message}`));

/**
 * Strip leaked internal grounding tags or search citations from user-facing prose, enforce
 * manager fidelity, and put any misquoted attribute of a card in play back to its stored value.
 */
export function sanitizeScoutProse(
  text: string,
  managerCtx?: { verifiedFacts?: string[]; clubManagers?: VerifiedClubManager[]; past?: boolean },
  cardsInPlay: PlayerProfile[] = [],
  figures?: FigureCheck,
): string {
  const stripped = text
    .replace(
      /\s*\[(?:Search|Source|Grounding|Query)\s*\d*(?:\s*[,&]\s*(?:Search|Source|Grounding|Query)\s*\d*)*\]/gi,
      '',
    )
    .replace(
      /\s*\((?:Search|Source|Grounding)\s*\d+(?:\s*[,&]\s*(?:Search|Source|Grounding)\s*\d+)*\)/gi,
      '',
    )
    // Evidence ledger ids ("[E3]", "[E1, E4]") are for tracing, not for the reader.
    .replace(/\s*\[E\d+(?:\s*[,&]\s*E\d+)*\]/g, '')
    .replace(/<\/?(?:situation_snapshot|research_brief|debate_brief|factual_foundation|locked_dossiers|calibrated_peer_ledger|saved_dossiers)>/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  // The manager gate guards today's coaches. An answer about past seasons names the coaches of
  // those seasons, which it would rewrite as "the current setup", so it doesn't run there.
  const scrubbed = managerCtx?.past
    ? stripped
    : scrubUnverifiedManagerText(stripped, {
        currentHeadCoach: null,
        verifiedFacts: managerCtx?.verifiedFacts ?? [],
        clubManagers: managerCtx?.clubManagers ?? [],
      });
  const reconciled = reconcileDossierNumbers(scrubbed, cardsInPlay).text;
  if (!figures) return reconciled;
  const gated = gateUnsupportedFigures(reconciled, figures.evidence(), figures.grounded, figures.options);
  figures.onRemoved?.([...gated.removed, ...gated.trimmed]);
  return gated.text;
}

/**
 * What a live answer's precise figures are checked against (`figureGate.ts`): the turn's evidence,
 * read when the check runs so tool results the writer fetched count, and the passages its own
 * search grounded.
 */
export interface FigureCheck {
  evidence: () => string;
  grounded: string[];
  /** On a turn about the past: check each figure's qualifier and span, and hold the reply to its figure budget. */
  options?: FigureGateOptions;
  onRemoved?: (removed: FigureClaim[]) => void;
}

interface ChallengeTurnResponse {
  replyProse: string;
  revisedDossier: boolean;
  dossierPatch?: DossierPatch;
}

const CHALLENGE_TURN_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    replyProse: {
      type: Type.STRING,
      description:
        'Your direct, analytical scouting response in Markdown prose addressing the user’s challenge or adjustment request. Never include raw JSON here.',
    },
    revisedDossier: {
      type: Type.BOOLEAN,
      description:
        'Set to true ONLY if you are conceding a rating/attribute/role change or fulfilling an explicit user request to adjust the dossier. Set to false if you stand by the original numbers.',
    },
    dossierPatch: {
      type: Type.OBJECT,
      nullable: true,
      description:
        'Present when revisedDossier is true. Include only the fields that are changing.',
      properties: {
        targetPlayerName: { type: Type.STRING },
        position: { type: Type.STRING, nullable: true },
        club: { type: Type.STRING, nullable: true },
        overall: { type: Type.NUMBER, nullable: true },
        potential: { type: Type.NUMBER, nullable: true },
        attributes: {
          type: Type.OBJECT,
          nullable: true,
          properties: Object.fromEntries(
            ATTRIBUTE_KEYS.map((key) => [key, { type: Type.NUMBER, nullable: true }]),
          ),
        },
        strengths: {
          type: Type.ARRAY,
          nullable: true,
          items: { type: Type.STRING },
        },
        weaknesses: {
          type: Type.ARRAY,
          nullable: true,
          items: { type: Type.STRING },
        },
        archetype: { type: Type.STRING, nullable: true },
        playstyleDescription: { type: Type.STRING, nullable: true },
        bestRoles: {
          type: Type.ARRAY,
          nullable: true,
          items: { type: Type.STRING },
        },
      },
      required: ['targetPlayerName'],
    },
  },
  required: ['replyProse', 'revisedDossier'],
};

/** What a chat reply carries besides its prose: cards to show under it, players to offer to rate. */
export interface ReplyAttachments {
  cards: PlayerProfile[];
  /** Players the reply discussed who have no card yet. */
  scoutOffers: string[];
}

/** Adds a scout offer unless the player is already offered or carded in this reply. */
export const offerScout = (attachments: ReplyAttachments, name: string): void => {
  const slug = toBasePlayerSlug(name);
  if (!slug) return;
  const known = [
    ...attachments.scoutOffers,
    ...attachments.cards.map((c) => c.basicInfo.name),
  ].some((n) => toBasePlayerSlug(n) === slug);
  if (!known) attachments.scoutOffers.push(name);
};

const PRIME_OFFER = /^prime\s+/i;

/**
 * Offers a player's prime to Scout, for a reply about his prime when only his current form is
 * rated. It sits beside his current card, so it's kept apart from his plain offer.
 */
export const offerPrimeScout = (attachments: ReplyAttachments, name: string): void => {
  const slug = toBasePlayerSlug(name);
  if (!slug) return;
  const held = attachments.scoutOffers.some((n) => PRIME_OFFER.test(n) && toBasePlayerSlug(n) === slug);
  const shown = attachments.cards.some((c) => isPrimeCard(c) && toBasePlayerSlug(c.basicInfo.name) === slug);
  if (!held && !shown) attachments.scoutOffers.push(`prime ${name}`);
};

/** Adds a card to show under the reply, once. A current card leaves an offer of his prime in place. */
export const showCard = (attachments: ReplyAttachments, card: PlayerProfile): void => {
  const key = getCardKey(card);
  if (attachments.cards.some((c) => getCardKey(c) === key)) return;
  attachments.cards.push(card);
  const slug = toBasePlayerSlug(card.basicInfo.name);
  attachments.scoutOffers = attachments.scoutOffers.filter(
    (n) => toBasePlayerSlug(n) !== slug || (PRIME_OFFER.test(n) && !isPrimeCard(card)),
  );
};

export interface ConversationalScoutParams {
  message: string;
  route: TurnRoute;
  history: ChatMessage[];
  imageData?: string;
  isEAFCRequest: boolean;
  conversationDossiers: PlayerProfile[];
  savedDossiers: PlayerProfile[];
  lockedDossiersBlock: string;
  savedDossiersBlock: string;
  peerLedgerBlock?: string;
  /** Filled with the cards the model shows and the players it found no card for. */
  attachments?: ReplyAttachments;
  /** The card the user chose to challenge; a challenge turn revises this one. */
  challengeCard?: PlayerProfile;
  onDossierUpdated?: (updatedProfile: PlayerProfile) => void;
  onStreamChunk?: (accumulatedText: string) => void;
  onStageChange?: (stageLabel: string) => void;
  /** Marks a step for the turn's timing log. */
  perf?: (label: string) => void;
  /** The question's web search, when it started during routing. */
  questionSearch?: Promise<ToolOutcome> | null;
  /** A debate brief started before routing (`startDebateBrief`), for a question about the past. */
  debateBrief?: Promise<DebateBrief | null> | null;
  /** The Gaffa club attached to the conversation (`gaffaTurn.ts`). Ignored on a thread about the past. */
  gaffaBag?: GaffaContextBag;
  /** Called with a Gaffa trade scorecard before the reply streams. */
  onGaffaScorecard?: (scorecard: GaffaTradeScorecard) => void;
  /** Whose follow-up state this turn reads and writes (`threadStateFor`). */
  conversationId?: string;
}

/**
 * Which tools the writer gets. A turn that researched live facts keeps every tool, so it can look
 * up what research missed. A turn answered entirely from stored cards or the archive gets only the
 * instant local tools, so it doesn't pause to search for facts it already has.
 */
export function proseToolMode(turn: { researched: boolean; isArchive: boolean; cardsLocked: boolean }): ProseToolMode {
  if (turn.researched) return 'full';
  return turn.isArchive || turn.cardsLocked ? 'local_only' : 'full';
}

/**
 * How tactical and squad answers use the club's recent team. The squad list says who is registered;
 * only recent lineups and the injury list say who plays, so the answer starts there.
 */
const RECENT_TEAM_RULES =
  'Build the team from the first-choice XI in <situation_snapshot>, and otherwise from the recent starting XIs and the injury list in <factual_foundation>, never from the registered squad or memory. Name one player for each role and commit to him; mention another only where the snapshot marks an even split, as the alternative, never as a joint holder of the role or a pair of names in a heading. A player listed as out is unavailable and must not be described as playing; a registered player missing from recent XIs is at most a rotation option, however prominent he once was. Recent signings and positional changes override what you remember of the club. If neither block has recent lineups, say which parts of the shape you could not verify rather than filling them from memory.';

/**
 * How the writer answers a question about the past from the debate brief. The brief is its
 * reasoning (what the question turns on, the evidence, a judgment held to the cards), not a layout:
 * the reply reads as a knowledgeable person answering, never as a formal debate. Descriptive, like
 * every prompt here: no players, ratings or sample phrases.
 */
const PAST_DEBATE_RULES =
  "First decide what the user's latest message actually asks, in the light of the conversation, and answer that. Write the way a knowledgeable person talks football with a friend: plain, warm, direct prose, never a formal debate. Use <debate_brief> as your reasoning, not as a layout. Where the user asked who was better, for an order, or how good a season or player was, give your answer early and plainly, the one the brief settled (for a ranking, its order), and explain it through the things that decide it, using the evidence from <factual_foundation> and the stored cards. Give the other side its due in a sentence or two where it matters, as part of the explanation. Don't write labelled sections for criteria, a counter-case or a verdict, and don't frame the answer as an argument to win; use headings only for a long answer that covers several players or seasons. Where the brief says the answer was held to the stored cards, say so in a sentence. Judge from evidence, never from reputation alone. Where the message questions your last answer, the cards or versions it used, or a fact, or asks something narrower, answer that point directly, admit a mistake in a sentence where you made one, and stop when it's answered. Stay consistent with the ratings in <locked_dossiers> and <calibrated_peer_ledger>. Never output a JSON dossier object.";

/** A message in a thread about the past that asks for no judgment (the brief's kind is `other`). */
const PAST_CONVERSATION_RULES =
  "The user's latest message isn't asking for a new judgment: it questions the last answer, the cards or versions it used, or a fact, or asks something narrower. Reply the way a knowledgeable person would in conversation: answer exactly what was asked, directly and at the length it needs, in plain prose. Where your last answer got something wrong, say so in a sentence and correct it. No section headings, criterion sections, counter-case or verdict. Use <debate_brief> and the evidence only as background. Stay consistent with the ratings in <locked_dossiers> and <calibrated_peer_ledger>. Never output a JSON dossier object.";

const CURRENT_CUE = "(?:current|currently|now|today(?:'s)?|this season(?:'s)?|present[- ]day)";
const PRIME_CUE = '(?:prime|peak|at (?:his|their) best)';

/** Whether the text names a version of a player beside his name ("current X", "X at his peak"). */
const namesVersionOf = (text: string, name: string, cue: string): boolean => {
  const surname = name.trim().split(/\s+/).pop()?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!surname) return false;
  return new RegExp(`\\b${cue}\\W+(?:\\w+\\W+){0,2}${surname}\\b|\\b${surname}\\b\\W+(?:\\w+\\W+){0,2}${cue}\\b`, 'i').test(text);
};

/** A message that wants a player's current form, and not his prime too ("prime Henry vs current X"). */
const asksOnlyCurrentFormOf = (text: string, name: string): boolean =>
  namesVersionOf(text, name, CURRENT_CUE) && !namesVersionOf(text, name, PRIME_CUE);

/**
 * Whether a turn is about a player's prime: a thread about primes, unless the message asks only for
 * his current form; or any message that names his prime, however the router read the turn (a
 * question setting his current form against his prime names both).
 */
export const wantsPrimeOf = (message: string, name: string, historical: boolean): boolean =>
  historical ? !asksOnlyCurrentFormOf(message, name) : namesVersionOf(message, name, PRIME_CUE);

/**
 * Players asked about in their prime whose card in play rates their current form, and who have no
 * prime card in `pool`, with that card's label. Without a note the writer reads the current card
 * as the prime it was asked about.
 */
export const editionGaps = (
  cards: PlayerProfile[],
  historical: boolean,
  message = '',
  pool: PlayerProfile[] = cards,
): { name: string; label: string }[] => {
  const hasPrime = (name: string) =>
    pool.some((p) => cardEdition(p) === 'prime' && toBasePlayerSlug(p.basicInfo.name) === toBasePlayerSlug(name));
  return cards
    .filter((c) => c?.basicInfo?.name && !isPrimeCard(c) && wantsPrimeOf(message, c.basicInfo.name, historical) && !hasPrime(c.basicInfo.name))
    .map((c) => ({ name: c.basicInfo.name, label: c.version?.label?.trim() || 'current form' }));
};

/** The writer's note for a player whose prime has no card. */
export const editionGapNote = (gap: { name: string; label: string }): string =>
  `No prime card exists for ${gap.name}. His only card, in <locked_dossiers>, rates a different version: ${gap.label}. Don't present its Overall or attributes as his prime's, and don't claim it reflects his prime. Say plainly that his prime hasn't been rated and can be scouted, and judge his prime in words from the evidence.`;

/** What a question about the past may state as fact. */
const PAST_FACT_RULES =
  "Quote a precise figure (goals, appearances, points, trophies, records, dates, fees) only where it decides a criterion, as <debate_brief> lists it, and only as <factual_foundation> or a stored card gives it; make every other point in words. A quoted figure keeps the competition and span its source gives: a league figure stays a league figure, a total across all competitions stays a total, and a count for named seasons is never a career total. Keep every fact to the season or spell it belongs to: never move a player, a coach, a trophy or a number into a season or side it wasn't part of, and name the season when a fact from outside the compared window matters. Don't repeat a claim that an era snapshot lists as often misstated, or an anecdote no source here supports. Name a past season's coach only as <factual_foundation> gives him; otherwise describe the side's setup without naming its coach.";

export async function runConversationalScout(
  params: ConversationalScoutParams,
): Promise<string> {
  const {
    message,
    route,
    history,
    imageData,
    isEAFCRequest,
    conversationDossiers,
    savedDossiers,
    lockedDossiersBlock,
    savedDossiersBlock,
    peerLedgerBlock,
    attachments,
    onDossierUpdated,
    onStreamChunk,
    onStageChange,
    perf,
  } = params;

  const { year, month, currentSeason } = getCurrentSeasonInfo();
  const systemInstruction = buildConversationalScoutInstruction(isEAFCRequest);
  const ongoingThread = buildOngoingThreadBlock(history);

  // 1. Live Dossier Challenge / Revision Path
  if (route.intent === 'challenge_or_revise' && conversationDossiers.length > 0 && !imageData) {
    // A player can have a current and a prime card in the same conversation. Revise the edition
    // the message names, otherwise the card the user was most recently shown.
    const referenced = findReferencedDossiers(
      message,
      conversationDossiers,
      route.targetPlayers,
    );
    const candidates = referenced.length > 0 ? referenced : conversationDossiers;
    const targetDossier =
      params.challengeCard ??
      (route.isHistorical ? pickCardPerPlayer(candidates, true).find(isPrimeCard) : undefined) ??
      mostRecentlyShownCard(history, candidates) ??
      referenced[0] ??
      conversationDossiers[conversationDossiers.length - 1];

    // Every other player the thread is about gets his full card too, in the target's edition,
    // so a comparison inside a challenge quotes stored numbers instead of regenerating them.
    const targetSlug = toBasePlayerSlug(targetDossier.basicInfo.name);
    const otherCards = pickCardPerPlayer(
      findReferencedDossiers(
        `${recentThreadText(history)}\n${message}`,
        mergeAllCalibratedDossiers(savedDossiers, conversationDossiers),
        route.targetPlayers,
      ),
      isPrimeCard(targetDossier),
    ).filter((p) => toBasePlayerSlug(p.basicInfo.name) !== targetSlug);
    const challengeThread = buildOngoingThreadBlock(history, { maxAiChars: 2400 });

    const challengeManagersPromise = getVerifiedClubManagers([targetDossier.basicInfo.club]);
    let groundingNotes = '';
    if (route.needsSearch) {
      onStageChange?.(`Verifying ${targetDossier.basicInfo.name}'s ${currentSeason} records...`);
      try {
        const customQueries =
          route.searchQueries && route.searchQueries.length > 0
            ? route.searchQueries.slice(0, 1)
            : [
                `[Date: ${month} ${year}] ${targetDossier.basicInfo.name}: ${message} (${currentSeason} stats and scouting verification)`,
              ];
        groundingNotes = await gatherSearchFoundation(
          customQueries,
          [targetDossier.basicInfo.name],
        );
      } catch {
        groundingNotes = '';
      }
    }

    onStageChange?.(`Evaluating ${targetDossier.basicInfo.name}'s dossier calibration...`);

    try {
      const challengeManagers = await challengeManagersPromise;
      const challengePrompt = `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
${challengeThread}
${formatVerifiedManagersBlock(challengeManagers)}
${peerLedgerBlock ?? ''}
<active_dossier>
${serializeProfileForHistory(targetDossier)}
</active_dossier>
${buildLockedDossiersBlock(otherCards)}
${groundingNotes ? `<grounding_verification>\n${groundingNotes}\n</grounding_verification>` : ''}
<instructions>
The user is challenging, questioning, or requesting an adjustment to the dossier above.
1. Evaluate their point honestly against the Scout's Code, the recalibrated Section III Rating Tier Scale (where World-Class starts strictly at 90), and any grounding verification or peer benchmarks above. Start from what the user actually argued and answer it with evidence; never attribute their view to bias or sentiment.
2. Check your own earlier replies in <ongoing_thread>. If they ranked these players differently from what the dossiers' Overall ratings show, say so in your opening paragraph before anything else.
3. If the current dossier rating/attribute is justified, set \`revisedDossier: false\` and explain why with concrete tactical/statistical reasoning in \`replyProse\`, addressing the user's specific argument.
4. If the user makes a valid evidence-backed point (or explicitly asks to adjust a rating/attribute), set \`revisedDossier: true\`, populate \`dossierPatch\` with the exact updated values so the UI card updates live, and explain the revision clearly in \`replyProse\`.
5. Ensure every number you mention in \`replyProse\` matches the dossiers above (the active one and any in <locked_dossiers>) or your \`dossierPatch\`. Quote another player's attributes only from his dossier.
</instructions>
<user_message>${message}</user_message>`;

      const result = await generateStructured<ChallengeTurnResponse>({
        task: 'chat',
        prompt: challengePrompt,
        systemInstruction,
        schema: CHALLENGE_TURN_SCHEMA,
        thinkingLevelOverride: 'low',
      });

      const revisedTarget =
        result.revisedDossier && result.dossierPatch
          ? applyDossierPatch(targetDossier, result.dossierPatch)
          : targetDossier;
      if (revisedTarget !== targetDossier) {
        // The challenger keeps this as their revision; the shared card weighs it at its next re-rating.
        void recordDossierRevision(targetDossier, revisedTarget, result.replyProse, groundingNotes);
        onDossierUpdated?.(revisedTarget);
      }

      const cleanedReply = sanitizeScoutProse(
        result.replyProse,
        {
          verifiedFacts: groundingNotes ? [groundingNotes] : [],
          clubManagers: challengeManagers,
        },
        [revisedTarget, ...otherCards],
      );
      onStreamChunk?.(cleanedReply);
      return cleanedReply;
    } catch (e) {
      console.warn('[ConversationalScout] Structured challenge path failed, falling back to prose:', e);
    }
  }

  // 2. Universal Calibrated Ledger Matching & Pre-Grounding across Comparisons, Debates, Rankings & Tactical Chat
  let ledger: EvidenceLedger | null = null;
  let brief: ResearchBrief | null = null;
  let debate: DebateBrief | null = null;
  let debateCards: CardStanding[] = [];
  let situation: Situation | null = null;
  let researched = false;
  let effectiveLockedBlock = lockedDossiersBlock;
  let verifiedManagers: VerifiedClubManager[] = [];
  let cardsInPlay: PlayerProfile[] = [];
  let gaps: { name: string; label: string }[] = [];
  const isHistoricalThread = threadIsHistorical(route, history, message);
  const thread = threadStateFor(params.conversationId ?? 'local');
  // A Gaffa club attached to the conversation. A question about its squad also researches the
  // Premier League clubs most of its starters play for.
  const gaffaBag = params.gaffaBag?.connected && !isHistoricalThread ? params.gaffaBag : undefined;
  const gaffaFocus = gaffaBag ? leagueFocusOf(message, history, gaffaBag) : 'none';
  const gaffaClubs = gaffaBag && (gaffaFocus === 'squad' || gaffaFocus === 'lineup') ? starterClubs(gaffaBag) : [];
  // Switching clubs mid-conversation starts the follow-up state afresh.
  const threadSignature = getThreadSignature(history, message) + (gaffaBag ? `|${gaffaBag.club_id}` : '');

  if (!imageData && route.intent !== 'archive_inventory') {
    const allCalibrated = mergeAllCalibratedDossiers(savedDossiers, conversationDossiers);
    const matchedCards: PlayerProfile[] = [];
    const unratedPlayers: string[] = [];

    for (const targetName of route.targetPlayers) {
      const hits = findReferencedDossiers(targetName, allCalibrated, [targetName]);
      if (hits.length > 0) matchedCards.push(...hits);
      else unratedPlayers.push(targetName);
    }

    // Also include any referenced dossiers found directly in the raw message
    matchedCards.push(...findReferencedDossiers(message, allCalibrated, route.targetPlayers));

    // One card per player, in the edition this turn is about (current form vs. peak).
    const lockedCards = pickCardPerPlayer(matchedCards, isHistoricalThread);
    // A message that names a player's prime on a turn read as about the present still gets his
    // prime card, beside the current one.
    if (!isHistoricalThread) {
      for (const card of pickCardPerPlayer(matchedCards.filter((c) => cardEdition(c) === 'prime'), true)) {
        if (namesVersionOf(message, card.basicInfo.name, PRIME_CUE) && !lockedCards.includes(card)) lockedCards.push(card);
      }
    }
    if (lockedCards.length > 0) {
      effectiveLockedBlock = buildLockedDossiersBlock(lockedCards);
    }
    cardsInPlay = lockedCards;
    gaps = editionGaps(lockedCards, isHistoricalThread, message, matchedCards);

    const routeClubs =
      route.targetClubs && route.targetClubs.length > 0
        ? route.targetClubs
        : extractThreadClubs(message, history);
    const targetClubs = [...new Set([...routeClubs, ...gaffaClubs])];

    // Verified managers for the clubs in play, looked up alongside pre-grounding. Today's coaches
    // don't matter to a question about the past.
    const managersPromise = isHistoricalThread
      ? Promise.resolve<VerifiedClubManager[]>([])
      : getVerifiedClubManagers([...targetClubs, ...lockedCards.filter((c) => !isPrimeCard(c)).map((c) => c.basicInfo.club)]);

    // Extract any capitalized 2-word player names mentioned in the message (e.g. "Marc Cucurella", "Malo Gusto")
    // so API-Football player lookup verifies their registered club even on tactical/pushback turns.
    const clubLowerSet = new Set(targetClubs.map((c) => c.toLowerCase()));
    const inlinePlayerCandidates = Array.from(
      message.matchAll(/\b([A-Z][a-zà-öø-ÿ]+(?:\s+[A-Z][a-zà-öø-ÿ'-]+)+)\b/g),
      (m) => m[1],
    ).filter(
      (name) =>
        !clubLowerSet.has(name.toLowerCase()) &&
        !/\b(Premier League|Champions League|La Liga|Serie A|Bundesliga|Ligue 1|World Cup|Real Madrid|Manchester City|Manchester United|Aston Villa|Bayern Munich|Borussia Dortmund|Inter Milan|AC Milan|Paris Saint-Germain)\b/i.test(
          name,
        ),
    );

    const playerNamesForGrounding = [
      ...new Set([...unratedPlayers, ...inlinePlayerCandidates]),
    ].slice(0, 3);

    const asksLiveSeasonUpdate =
      /\b(stats?|goals?|assists?|appearances?|minutes|form|injured|injury|lineup|starting\s+xi|fixtures?|table|standings|transfer|manager|coach|which|who\s+plays|who\s+starts|tuck(?:ing|s)?\s+in|invert(?:ing|s)?)\b/i.test(
        message,
      );

    // If all compared players are already locked in calibrated dossiers and the user isn't asking
    // for live stats/fixture updates, skip redundant web search and stream directly from locked dossiers.
    const allTargetsAlreadyCalibrated =
      route.targetPlayers.length > 0 &&
      unratedPlayers.length === 0 &&
      targetClubs.length === 0 &&
      !asksLiveSeasonUpdate;

    // Research is for the present. A thread about primes and past seasons answers from cards, and
    // the writer keeps its tools for anything it needs to check.
    const shouldPreGround =
      !isHistoricalThread &&
      !allTargetsAlreadyCalibrated &&
      (playerNamesForGrounding.length > 0 ||
        targetClubs.length > 0 ||
        asksLiveSeasonUpdate ||
        (route.needsSearch && Boolean(route.searchQueries?.length)));

    // A question about the past gets a debate brief: the criteria that settle it, the versions
    // compared, a verdict held to the cards, and the records the verdict depends on.
    if (isHistoricalThread) {
      debateCards = standingsFor(lockedCards, true);
      try {
        const research = await runDebateResearch(
          {
            message,
            thread: history.length ? ongoingThread.slice(-3000) : '',
            cards: debateCards,
            editionGaps: gaps.map((g) => `${g.name}: only his ${g.label} card exists; his prime has never been rated`),
            hints: { clubs: targetClubs, players: [...new Set([...route.targetPlayers, ...playerNamesForGrounding])] },
            season: route.requestedSeason ?? null,
          },
          liveToolset([...lockedCards, ...allCalibrated]),
          { onStage: onStageChange, perf, eras: liveEraSnapshots, debates: liveDebateRecords, early: params.debateBrief },
        );
        debate = research.brief;
        if (research.ledger.entries.length || research.ledger.gaps.length) ledger = research.ledger;
      } catch (e) {
        console.warn('[ConversationalScout] Debate research failed:', e);
      }
    }

    if (shouldPreGround) {
      try {
        const research = await runResearch(
          {
            message,
            thread: ongoingThread.slice(-3000),
            cardsInPlay: lockedCards.map((c) => `${c.basicInfo.name} (${isPrimeCard(c) ? 'prime' : 'current form'})`),
            hints: { clubs: targetClubs, players: playerNamesForGrounding },
            present: !isHistoricalThread,
            questionSearch: params.questionSearch,
          },
          liveToolset([...lockedCards, ...allCalibrated]),
          { onStage: onStageChange, perf, snapshots: liveClubSnapshots },
        );
        brief = research.brief;
        situation = research.situation;
        researched = research.brief.calls.length > 0;
        if (researched) ledger = research.ledger;
      } catch (e) {
        console.warn('[ConversationalScout] Research failed:', e);
        researched = true;
        ledger = addGap(emptyLedger(), 'All research for this turn (the lookups failed)');
      }
    }

    verifiedManagers = await managersPromise;

    // A follow-up in the same thread keeps what the last turn found, as a lower-priority entry.
    const currentSig = threadSignature;
    const sameThread = Boolean(currentSig && currentSig === thread.signature && thread.grounding);
    if (hasEvidence(ledger)) {
      const thisTurn = formatLedger(ledger!);
      if (sameThread && !thisTurn.includes(thread.grounding.slice(0, 120))) {
        ledger = addEvidence(ledger!, { kind: 'prior_turn', label: 'Research from the previous turn', content: thread.grounding.slice(0, 1400) });
      }
      thread.signature = currentSig;
      thread.grounding = thisTurn;
    } else if (sameThread) {
      ledger = addEvidence(ledger ?? emptyLedger(), { kind: 'prior_turn', label: 'Research from the previous turn', content: thread.grounding });
    }
  }
  const { seasonStartYear } = getCurrentSeasonInfo();
  const factualFoundation =
    ledger && (ledger.entries.length > 0 || ledger.gaps.length > 0)
      ? formatLedger(ledger, debate ? {} : { seasonStart: seasonStartDate(seasonStartYear) })
      : '';
  let situationBlock = formatSituation(situation);
  const threadSig = threadSignature;
  if (situationBlock) {
    thread.situation = situationBlock;
    thread.situationSignature = threadSig;
  } else if (threadSig && threadSig === thread.situationSignature && !isHistoricalThread) {
    situationBlock = thread.situation;
  }

  // The attached club's blocks: the club and squad always; the lineup audit, market lock, bid math
  // or a trade scorecard when the question is about those.
  let gaffaTurn: GaffaTurn | null = null;
  if (gaffaBag) {
    onStageChange?.(gaffaFocus === 'trade' ? 'Scoring the trade...' : 'Reading your Gaffa club...');
    gaffaTurn = await buildGaffaTurn({
      message,
      history,
      bag: gaffaBag,
      cards: mergeAllCalibratedDossiers(savedDossiers, conversationDossiers),
      ongoingThread,
      factualFoundation,
    });
    if (gaffaTurn.scorecard) params.onGaffaScorecard?.(gaffaTurn.scorecard);
    perf?.(`gaffa club (${gaffaTurn.focus})`);
  }
  const gaffaBlock = gaffaTurn?.block ?? '';

  const analyticalMode =
    route.analyticalMode ??
    (route.intent === 'compare'
      ? 'head_to_head'
      : route.intent === 'archive_inventory'
        ? 'archive'
        : route.targetPlayers.length === 1
          ? 'player_qa'
          : 'debate_or_verdict');

  let modeGuidance: string;
  if (debate && analyticalMode !== 'archive' && route.intent !== 'archive_inventory') {
    modeGuidance = debate.kind === 'other' ? PAST_CONVERSATION_RULES : PAST_DEBATE_RULES;
  } else if (route.intent === 'compare' || analyticalMode === 'head_to_head') {
    modeGuidance = `Write a detailed, scout-grade head-to-head comparison covering every player named (${route.targetPlayers.join(', ') || 'all named players'}). Contrast their footballing identity/mould directly across concrete phases of play (build-up/progression, final-third creation or box threat, out-of-possession/rest-defense, and transition) rather than writing two isolated bios. Highlight key separators across the 25-attribute framework, genuine limitations, and relative tier on the Section III scale. For any player present in <locked_dossiers>, use their exact locked Overall, Potential, and 25 attributes. Conclude with a definitive verdict on who holds the higher current standing, who has the higher ceiling, and which tactical setup favors each player. Never output a JSON dossier object.`;
  } else if (route.intent === 'archive_inventory' || analyticalMode === 'archive') {
    modeGuidance = `Summarize or query the user's saved dossier archive clearly using <saved_dossier_archive> or the \`grep_saved_dossiers\` tool.`;
  } else if (analyticalMode === 'player_qa') {
    modeGuidance = `Answer the user's specific question about ${route.targetPlayers.join(', ') || 'the player'} directly with Chief-Scout granularity. Break down the exact on-pitch mechanics involved, explain how their 25-attribute spikes and limitations interact in that role or match state, and separate intrinsic class from tactical environment/system tax. Stay 100% consistent with any ratings in <locked_dossiers> and <calibrated_peer_ledger>. Match the length and structure of your answer to the user's question without forcing unnecessary debate boilerplate. Never output a JSON dossier object.`;
  } else if (analyticalMode === 'ranking_or_tierlist') {
    modeGuidance = `Build a rigorous, scout-grade positional ranking or tier breakdown tied explicitly to the Section III Rating Tier Scale (\`93–95 World-Class Elite\`, \`90–92 World-Class\`, \`87–89 Borderline World-Class\`, \`84–86 High-End Starter\`). Honor every player rating already established in <calibrated_peer_ledger> and <locked_dossiers>. For each ranked player, cite their approximate Overall tier, signature attributes, and the exact on-pitch separator that places them ahead of or behind their peers. Never output a JSON dossier object.`;
  } else if (analyticalMode === 'tactical_or_system') {
    modeGuidance = `Deliver a concrete, player-specific tactical breakdown — NEVER write from an aerial, nameless theoretical template. ${RECENT_TEAM_RULES} Name the player in every role you describe, attackers included, and explain how their individual profiles dictate the team's actual build-up and out-of-possession geometry and the matchup trade-offs those personnel choices create. Every paragraph must pass the Swap Test. Ground all current squad, starter, and head-coach references strictly in verified ${currentSeason} facts. Never output a JSON dossier object.`;
  } else if (analyticalMode === 'squad_or_recruitment') {
    modeGuidance = `Analyze the squad structure, lineup balance, or recruitment question like a Sporting Director and Chief Scout. ${RECENT_TEAM_RULES} Name the specific current starters and rotational options, diagnose the specific functional profile the squad lacks, evaluate how candidate profiles complement existing starters, and pin player quality to the Section III tier scale and <calibrated_peer_ledger>. Never output a JSON dossier object.`;
  } else if (analyticalMode === 'debate_or_verdict') {
    modeGuidance = `Answer the question the way a knowledgeable person talks football: plain, direct prose with a clear view, never a formal debate. Give your view early, explain it through the evidence and the 25-attribute framework, separate a player's own quality from what his team and system did for his numbers where that matters, and give the other side its due in a sentence or two. If the user is questioning a fact or an earlier claim, check it against <factual_foundation>, correct a slip in one sentence, and answer what they asked. Match the length to the question. Stay 100% consistent with any ratings in <locked_dossiers> and <calibrated_peer_ledger>. Never output a JSON dossier object.`;
  } else {
    modeGuidance = `Respond conversationally in Markdown prose as the Chief Scout and Senior Tactical Columnist. Match the depth and structure of your answer to the user's question, and tie every tactical claim to specific named players and their actual traits rather than generic tactical buzzwords. Use \`grep_saved_dossiers\` to search/filter the user's scouted player library, \`get_club_recent_team\` for a club's live results, starting XIs and availability, \`get_player_season\` for a Premier League player's season, or Google Search when you need live ${currentSeason} verification. Stay 100% consistent with any dossier numbers in <locked_dossiers> and <calibrated_peer_ledger> unless you explicitly state you are revising a figure. Never output a JSON dossier object.`;
  }

  const shownNames = (attachments?.cards ?? []).map((c) => c.basicInfo.name);
  const shownNote = shownNames.length
    ? ` The user sees the dossier card of ${shownNames.join(' and ')} under your reply, so answer from it without reciting its attributes.`
    : '';
  // Cards this turn already looked for and didn't find, so the writer doesn't spend a tool round on them.
  const missingCards = attachments?.scoutOffers ?? [];
  const missingNote = missingCards.length
    ? ` No stored card exists for ${missingCards.join(' or ')}; they were already checked, so don't look them up.`
    : '';
  const gapNote = gaps.length ? ` ${gaps.map(editionGapNote).join(' ')}` : '';
  const fullPrompt = `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
${gaffaBlock}
${ongoingThread}
${situationBlock}
${factualFoundation ? `<factual_foundation>\n${factualFoundation}\n</factual_foundation>` : ''}
${brief && researched ? formatBriefForWriter(brief) : ''}
${debate ? formatDebateBriefForWriter(debate, debateCards) : ''}
${formatVerifiedManagersBlock(verifiedManagers)}
${peerLedgerBlock ?? ''}
${effectiveLockedBlock}
${savedDossiersBlock}
<instructions>
1. ${modeGuidance}${shownNote}${missingNote}${gapNote}
${debate ? `2. ${PAST_FACT_RULES}` : `2. Current-state facts (club, manager, squad membership, who starts and where, injuries, transfers, results, ${currentSeason} stats) must come from <situation_snapshot>, the numbered entries in <factual_foundation>, tool calls (\`get_club_recent_team\`, \`get_player_season\`, \`get_league_table\`, Google Search), or existing dossiers, never from memory. If the answer needs a fact that isn't there, look it up with a tool; if it still can't be verified, say so in one sentence and build the rest of the answer on what is verified. Never name an unverified head coach. A precise figure (a statistic, fee, percentage, table position, points total, the minute of an event, a shirt number, a quotation) goes in only when one of those sources gives it; for standings call \`get_league_table\`, and otherwise describe the pattern without a number.
3. CRITICAL MANAGER FIDELITY: Never cite former or sacked managers from pre-trained memory. Name a club's current head coach only as given in <verified_managers>; for any club not listed there, describe the tactical setup and intrinsic player mechanics without naming a manager.`}
4. ${CONTINUITY_REMINDER}
</instructions>
<task>${message}</task>`;

  const historyContents = buildHistoryContents(history, conversationDossiers);
  const dossiersPool = [...savedDossiers, ...conversationDossiers];

  // Low thinking for every prose turn: a researched turn did its planning in the brief, and on a
  // debate from stored cards medium thinking held the first token back by 15 s or more in the evals.
  const thinkingLevelOverride: ThinkingTier = 'low';

  // A debate turn already has its records; the writer reads cards locally and only searches when a
  // lookup failed.
  const toolMode: ProseToolMode = debate
    ? ledger?.gaps.some((g) => g.status === 'failed')
      ? 'full'
      : 'local_only'
    : proseToolMode({
        researched,
        isArchive: route.intent === 'archive_inventory',
        cardsLocked: route.targetPlayers.length > 0 && Boolean(effectiveLockedBlock),
      });

  onStageChange?.('Writing scouting analysis...');

  const scoutManagerContext = {
    verifiedFacts: factualFoundation ? [factualFoundation] : [],
    clubManagers: verifiedManagers,
    past: Boolean(debate),
  };
  // On a turn about the present, and on one about the past, precise figures must come from what
  // the turn found: its research, the cards, and what the writer's own tools returned.
  const toolResults: string[] = [];
  const figureCheck: FigureCheck | undefined = researched || debate
    ? {
        evidence: () =>
          [
            situationBlock,
            expandTables(factualFoundation),
            effectiveLockedBlock,
            peerLedgerBlock ?? '',
            savedDossiersBlock,
            formatVerifiedManagersBlock(verifiedManagers),
            gaffaBlock,
            ongoingThread,
            message,
            ...cardsInPlay.map(serializeProfileForHistory),
            ...toolResults,
          ].join('\n'),
        grounded: [],
        ...(debate ? { options: { scoped: true, budget: figureBudget(debate) } } : {}),
      }
    : undefined;
  if (cardsInPlay.length === 0) {
    cardsInPlay = pickCardPerPlayer(
      findReferencedDossiers(message, conversationDossiers, route.targetPlayers),
      isHistoricalThread,
    );
  }

  // The model reads any player's card, yours or shared, and shows the ones that answer the user.
  const localCards = mergeAllCalibratedDossiers(savedDossiers, conversationDossiers);
  const readCards = new Map<string, PlayerProfile>();
  const dossierTools: DossierToolHandlers = {
    lookUp: async ({ name, edition }) => {
      if (!name) return { error: 'Missing name' };
      const historical = edition ? edition === 'prime' : isHistoricalThread;
      const result = await lookUpDossier(name, [...cardsInPlay, ...localCards], historical);
      if (result.status === 'ambiguous') return { found: false, matchingPlayers: result.names };
      if (result.status === 'missing') {
        if (attachments) offerScout(attachments, name);
        return { found: false };
      }
      readCards.set(toBasePlayerSlug(name), result.card);
      readCards.set(toBasePlayerSlug(result.card.basicInfo.name), result.card);
      if (!cardsInPlay.some((c) => getCardKey(c) === getCardKey(result.card))) {
        cardsInPlay.push(result.card);
      }
      return { found: true, card: serializeProfileForHistory(result.card) };
    },
    show: async ({ name }) => {
      if (!name) return { error: 'Missing name' };
      const card =
        readCards.get(toBasePlayerSlug(name)) ??
        pickCardPerPlayer(findReferencedDossiers(name, cardsInPlay, [name]), isHistoricalThread)[0];
      if (!card) return { shown: false, reason: 'No card in this turn for that player; look it up first.' };
      if (attachments) showCard(attachments, card);
      return { shown: true };
    },
  };
  // Gaffa squad and market names are copied exactly, and a scorecard reply stays short.
  const finishGaffa = (text: string): string => {
    if (!gaffaBag || !gaffaTurn || gaffaTurn.focus === 'none') return text;
    const locked = lockGaffaRosterNames(text, gaffaBag);
    return gaffaTurn.scorecard ? capGaffaTradeProse(locked) : locked;
  };
  let firstChunk = true;
  const rawReply = await generateProseTurn({
    message: fullPrompt,
    historyContents,
    systemInstruction,
    imageData,
    thinkingLevelOverride,
    toolMode,
    dossiersPool,
    gaffaBag,
    dossierTools,
    onToolCalls: (names) => perf?.(`writer tool calls: ${names.join(', ')}`),
    onToolResult: (_name, result) => toolResults.push(typeof result === 'string' ? result : JSON.stringify(result)),
    onGrounded: (segment) => figureCheck?.grounded.push(segment),
    onStreamChunk: onStreamChunk
      ? (partial) => {
          if (firstChunk) {
            firstChunk = false;
            perf?.('first answer token');
          }
          onStreamChunk(finishGaffa(sanitizeScoutProse(partial, scoutManagerContext, cardsInPlay, figureCheck)));
        }
      : undefined,
  });

  return finishGaffa(sanitizeScoutProse(
    rawReply,
    scoutManagerContext,
    cardsInPlay,
    figureCheck && {
      ...figureCheck,
      onRemoved: (removed) => {
        if (removed.length) console.info(`[FigureGate] Removed ${removed.length} figures (unsupported, or over a debate's budget): ${removed.map((r) => r.text).join('; ')}`);
      },
    },
  ));
}
