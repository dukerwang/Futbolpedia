import { Type } from '@google/genai';
import type { ChatMessage, PlayerProfile } from '../types';
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
import { toBasePlayerSlug } from './dossierCards';
import { lookUpDossier } from './dossierLookup';
import { gateUnsupportedFigures, type FigureClaim } from './figureGate';

/**
 * Retains the most recent verified `<factual_foundation>` for the active conversation thread
 * so follow-up turns ("Which full-back is tucking in?", "What about their midfield?")
 * never lose the verified squad/transfer facts gathered on Turn 1.
 */
let lastThreadSignature = '';
let lastThreadGrounding = '';
/** The last situation snapshot and its thread, for a follow-up in the same thread that didn't build one. */
let lastThreadSituation = '';
let lastSituationSignature = '';

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
const threadIsHistorical = (route: TurnRoute, history: ChatMessage[], message = ''): boolean =>
  route.isHistorical ||
  (!route.wantsCurrentForm && /\b(prime|peak|all[- ]time|(?:19|20)\d0s)\b/i.test(`${recentThreadText(history)}\n${message}`));

/**
 * Strip leaked internal grounding tags or search citations from user-facing prose, enforce
 * manager fidelity, and put any misquoted attribute of a card in play back to its stored value.
 */
export function sanitizeScoutProse(
  text: string,
  managerCtx?: { verifiedFacts?: string[]; clubManagers?: VerifiedClubManager[] },
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
    .replace(/<\/?(?:situation_snapshot|research_brief|factual_foundation|locked_dossiers|calibrated_peer_ledger|saved_dossiers)>/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  const scrubbed = scrubUnverifiedManagerText(stripped, {
    currentHeadCoach: null,
    verifiedFacts: managerCtx?.verifiedFacts ?? [],
    clubManagers: managerCtx?.clubManagers ?? [],
  });
  const reconciled = reconcileDossierNumbers(scrubbed, cardsInPlay).text;
  if (!figures) return reconciled;
  const gated = gateUnsupportedFigures(reconciled, figures.evidence(), figures.grounded);
  figures.onRemoved?.(gated.removed);
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

/** Adds a card to show under the reply, once. */
export const showCard = (attachments: ReplyAttachments, card: PlayerProfile): void => {
  const key = getCardKey(card);
  if (attachments.cards.some((c) => getCardKey(c) === key)) return;
  attachments.cards.push(card);
  const slug = toBasePlayerSlug(card.basicInfo.name);
  attachments.scoutOffers = attachments.scoutOffers.filter((n) => toBasePlayerSlug(n) !== slug);
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
  onDossierUpdated?: (updatedProfile: PlayerProfile) => void;
  onStreamChunk?: (accumulatedText: string) => void;
  onStageChange?: (stageLabel: string) => void;
  /** Marks a step for the turn's timing log. */
  perf?: (label: string) => void;
  /** The question's web search, when it started during routing. */
  questionSearch?: Promise<ToolOutcome> | null;
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
  let situation: Situation | null = null;
  let researched = false;
  let effectiveLockedBlock = lockedDossiersBlock;
  let verifiedManagers: VerifiedClubManager[] = [];
  let cardsInPlay: PlayerProfile[] = [];
  const isHistoricalThread = threadIsHistorical(route, history, message);

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
    if (lockedCards.length > 0) {
      effectiveLockedBlock = buildLockedDossiersBlock(lockedCards);
    }
    cardsInPlay = lockedCards;

    const targetClubs =
      route.targetClubs && route.targetClubs.length > 0
        ? route.targetClubs
        : extractThreadClubs(message, history);

    // Verified managers for the clubs in play, looked up alongside pre-grounding.
    const managersPromise = getVerifiedClubManagers([
      ...targetClubs,
      ...lockedCards.filter((c) => !isPrimeCard(c)).map((c) => c.basicInfo.club),
    ]);

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
    const currentSig = getThreadSignature(history, message);
    const sameThread = Boolean(currentSig && currentSig === lastThreadSignature && lastThreadGrounding);
    if (hasEvidence(ledger)) {
      const thisTurn = formatLedger(ledger!);
      if (sameThread && !thisTurn.includes(lastThreadGrounding.slice(0, 120))) {
        ledger = addEvidence(ledger!, { kind: 'prior_turn', label: 'Research from the previous turn', content: lastThreadGrounding.slice(0, 1400) });
      }
      lastThreadSignature = currentSig;
      lastThreadGrounding = thisTurn;
    } else if (sameThread) {
      ledger = addEvidence(ledger ?? emptyLedger(), { kind: 'prior_turn', label: 'Research from the previous turn', content: lastThreadGrounding });
    }
  }
  const { seasonStartYear } = getCurrentSeasonInfo();
  const factualFoundation =
    ledger && (ledger.entries.length > 0 || ledger.gaps.length > 0)
      ? formatLedger(ledger, { seasonStart: seasonStartDate(seasonStartYear) })
      : '';
  let situationBlock = formatSituation(situation);
  const threadSig = getThreadSignature(history, message);
  if (situationBlock) {
    lastThreadSituation = situationBlock;
    lastSituationSignature = threadSig;
  } else if (threadSig && threadSig === lastSituationSignature && !isHistoricalThread) {
    situationBlock = lastThreadSituation;
  }

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
  if (route.intent === 'compare' || analyticalMode === 'head_to_head') {
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
    modeGuidance = `Engage the football debate with dialectical depth: (1) steelman the strongest tactical and statistical case for each side, (2) decouple intrinsic player quality from system/environment tax (how role, surrounding talent, or league tempo inflates or suppresses box-score output), (3) evaluate through the 25-attribute framework, big-game knockout translation, and Section III tiers, and (4) finish with a clear, non-fence-sitting verdict. If the user is challenging a prior factual or tactical claim, verify the facts against <factual_foundation> first, correct any prior slip concisely in one sentence without theatrical self-flagellation, and deliver the grounded analysis. Stay 100% consistent with any ratings in <locked_dossiers> and <calibrated_peer_ledger>. Never output a JSON dossier object.`;
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
  const fullPrompt = `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
${ongoingThread}
${situationBlock}
${factualFoundation ? `<factual_foundation>\n${factualFoundation}\n</factual_foundation>` : ''}
${brief && researched ? formatBriefForWriter(brief) : ''}
${formatVerifiedManagersBlock(verifiedManagers)}
${peerLedgerBlock ?? ''}
${effectiveLockedBlock}
${savedDossiersBlock}
<instructions>
1. ${modeGuidance}${shownNote}${missingNote}
2. Current-state facts (club, manager, squad membership, who starts and where, injuries, transfers, results, ${currentSeason} stats) must come from <situation_snapshot>, the numbered entries in <factual_foundation>, tool calls (\`get_club_recent_team\`, \`get_player_season\`, \`get_league_table\`, Google Search), or existing dossiers, never from memory. If the answer needs a fact that isn't there, look it up with a tool; if it still can't be verified, say so in one sentence and build the rest of the answer on what is verified. Never name an unverified head coach. A precise figure (a statistic, fee, percentage, table position, points total, the minute of an event, a shirt number, a quotation) goes in only when one of those sources gives it; for standings call \`get_league_table\`, and otherwise describe the pattern without a number.
3. CRITICAL MANAGER FIDELITY: Never cite former or sacked managers from pre-trained memory. Name a club's current head coach only as given in <verified_managers>; for any club not listed there, describe the tactical setup and intrinsic player mechanics without naming a manager.
4. ${CONTINUITY_REMINDER}
</instructions>
<task>${message}</task>`;

  const historyContents = buildHistoryContents(history, conversationDossiers);
  const dossiersPool = [...savedDossiers, ...conversationDossiers];

  // Low thinking for every prose turn: a researched turn did its planning in the brief, and on a
  // debate from stored cards medium thinking held the first token back by 15 s or more in the evals.
  const thinkingLevelOverride: ThinkingTier = 'low';

  const toolMode = proseToolMode({
    researched,
    isArchive: route.intent === 'archive_inventory',
    cardsLocked: route.targetPlayers.length > 0 && Boolean(effectiveLockedBlock),
  });

  onStageChange?.('Writing scouting analysis...');

  const scoutManagerContext = {
    verifiedFacts: factualFoundation ? [factualFoundation] : [],
    clubManagers: verifiedManagers,
  };
  // On a turn about the present, precise figures must come from what the turn found.
  const toolResults: string[] = [];
  const figureCheck: FigureCheck | undefined = researched
    ? {
        evidence: () =>
          [
            situationBlock,
            factualFoundation,
            effectiveLockedBlock,
            peerLedgerBlock ?? '',
            savedDossiersBlock,
            formatVerifiedManagersBlock(verifiedManagers),
            ongoingThread,
            message,
            ...cardsInPlay.map(serializeProfileForHistory),
            ...toolResults,
          ].join('\n'),
        grounded: [],
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
  let firstChunk = true;
  const rawReply = await generateProseTurn({
    message: fullPrompt,
    historyContents,
    systemInstruction,
    imageData,
    thinkingLevelOverride,
    toolMode,
    dossiersPool,
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
          onStreamChunk(sanitizeScoutProse(partial, scoutManagerContext, cardsInPlay, figureCheck));
        }
      : undefined,
  });

  return sanitizeScoutProse(
    rawReply,
    scoutManagerContext,
    cardsInPlay,
    figureCheck && {
      ...figureCheck,
      onRemoved: (removed) => {
        if (removed.length) console.info(`[FigureGate] Removed ${removed.length} unsupported figures: ${removed.map((r) => r.text).join('; ')}`);
      },
    },
  );
}
