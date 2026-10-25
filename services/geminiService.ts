import type { ChatMessage, GaffaContextBag, PlayerProfile } from '../types';
import { ThinkingTier } from '../constants/modelProfiles';
import { buildConversationalScoutInstruction } from '../prompts/chatPrompt';
import {
  FLASH_MODEL,
  generateProseTurn,
  generateStructured,
  type ProseToolMode,
} from './aiClient';
import { runConversationalScout } from './conversationalScout';
import {
  CALIBRATION_EPOCH_MS,
  buildHistoryContents,
  buildLockedDossiersBlock,
  buildPositionalPeerLedgerBlock,
  buildPriorDossierTrajectoryBlock,
  buildRevisionProposalsBlock,
  buildSavedDossiersBlock,
  ensureDossierDated,
  fetchGlobalHubDossiers,
  type GlobalHubDossierItem,
  fetchPriorDossiersForPlayer,
  fetchRevisionsForCard,
  fetchRevisionsForPlayer,
  fetchSupabaseCalibratedPool,
  findReferencedDossiers,
  getCachedDossier,
  getCardKey,
  getDossierEvaluationDate,
  getSharedConversation,
  hasRevisionConsensus,
  isCardInRefreshWindow,
  isDossierDated,
  isPrimeCard,
  isSupabaseReady,
  mergeAllCalibratedDossiers,
  mergeConversationDossiers,
  resolveSavedDossiersForRequest,
  shareConversation,
  shareDossierCard,
  stampDossier,
  supabase,
  toDossierCardSlug,
  toPlayerSlug,
  toVersionedSlug,
  upsertCachedDossier,
  wantsSavedDossierAccess,
} from './dossierStore';
import { synthesizePlayerDossier } from './dossierSynthesizer';
import { gatherPlayerGrounding, gatherSearchFoundation } from './groundingService';
import { classifyTurn, extractCandidateSlug } from './turnRouter';

export {
  supabase,
  isSupabaseReady,
  toPlayerSlug,
  toDossierCardSlug,
  getCachedDossier,
  upsertCachedDossier,
  shareConversation,
  getSharedConversation,
  gatherSearchFoundation,
  fetchGlobalHubDossiers,
  type GlobalHubDossierItem,
  fetchPriorDossiersForPlayer,
  ensureDossierDated,
  isDossierDated,
  getDossierEvaluationDate,
  getCardKey,
  shareDossierCard,
  isPrimeCard,
  stampDossier,
};

const isFreshlyCalibrated = (p?: PlayerProfile): boolean =>
  Boolean(p?.createdAt && p.createdAt >= CALIBRATION_EPOCH_MS);

/**
 * Retained for backward compatibility with App.tsx conversation switching.
 * Chat sessions are now created per turn without module-global mutable state.
 */
export const resetChat = (): void => {
  // No-op: stateless per-turn sessions in services/aiClient.ts
};

/** Schema-enforced JSON helper used by Gaffa trade scorecards. */
export async function generateJsonWithSchema<T>(params: {
  prompt: string;
  systemInstruction: string;
  schema: Record<string, unknown>;
  temperature?: number;
}): Promise<T> {
  return generateStructured<T>({
    task: 'extraction',
    prompt: params.prompt,
    systemInstruction: params.systemInstruction,
    schema: params.schema,
    temperatureOverride: params.temperature ?? 0.2,
    modelOverride: FLASH_MODEL,
  });
}

/** Prose-only chat send used by Gaffa mode. */
export const sendProseChatMessage = async (
  message: string,
  history: ChatMessage[],
  options?: {
    imageData?: string;
    thinkingLevel?: ThinkingTier;
    systemInstruction?: string;
    conversationProfiles?: PlayerProfile[];
    dossiersPool?: PlayerProfile[];
    gaffaBag?: GaffaContextBag;
    temperature?: number;
    toolMode?: ProseToolMode;
    onStreamChunk?: (accumulatedText: string) => void;
  },
): Promise<string> => {
  const historyContents = buildHistoryContents(
    history,
    options?.conversationProfiles ?? [],
  );
  return generateProseTurn({
    message,
    historyContents,
    systemInstruction:
      options?.systemInstruction ?? buildConversationalScoutInstruction(false),
    imageData: options?.imageData,
    thinkingLevelOverride: options?.thinkingLevel ?? 'low',
    temperatureOverride: options?.temperature,
    modelOverride: FLASH_MODEL,
    toolMode: options?.toolMode,
    dossiersPool: options?.dossiersPool,
    gaffaBag: options?.gaffaBag,
    onStreamChunk: options?.onStreamChunk,
  });
};

export interface SendMessageOptions {
  onDossierUpdated?: (updatedProfile: PlayerProfile) => void;
  onStreamChunk?: (accumulatedText: string) => void;
  onStageChange?: (stageLabel: string) => void;
}

export const sendMessageToAI = async (
  message: string,
  history: ChatMessage[],
  imageData?: string,
  conversationProfiles: PlayerProfile[] = [],
  savedDossiers: PlayerProfile[] = [],
  options?: SendMessageOptions,
): Promise<string | PlayerProfile> => {
  const perfEnabled =
    typeof window === 'undefined' || (window as any).FUTBOLPEDIA_PERF !== false;
  const perfStart = (typeof performance !== 'undefined' ? performance : Date).now();
  let perfPrev = perfStart;
  const perf = (label: string) => {
    if (!perfEnabled) return;
    const now = (typeof performance !== 'undefined' ? performance : Date).now();
    console.log(
      `[Perf] ${label}: +${Math.round(now - perfPrev)}ms (total ${Math.round(now - perfStart)}ms)`,
    );
    perfPrev = now;
  };

  const isEAFCRequest = /\b(playstyle\+?|fc\s*card|eafc|ea\s*fc)\b/i.test(message);
  const conversationDossiers = mergeConversationDossiers(history, conversationProfiles);

  // 1. Classify turn via Structured Turn Router (warm Supabase pool in background without blocking routing)
  void fetchSupabaseCalibratedPool();
  const route = await classifyTurn({
    message,
    history,
    conversationDossiers,
    hasImage: Boolean(imageData),
  });
  perf(`turn router (${route.intent})`);

  // 2. Resolve conversation-locked and saved-archive dossiers
  const savedResult = resolveSavedDossiersForRequest(
    message,
    savedDossiers,
    conversationDossiers,
    route.targetPlayers,
  );
  const savedDossiersBlock = buildSavedDossiersBlock(
    savedResult.dossiers,
    savedResult.inventoryOnly,
  );

  const referencedDossiers = findReferencedDossiers(
    message,
    conversationDossiers,
    route.targetPlayers,
  );
  if (!savedResult.inventoryOnly) {
    for (const p of savedResult.dossiers) {
      const key = getCardKey(p);
      if (!referencedDossiers.some((x) => getCardKey(x) === key)) {
        referencedDossiers.push(p);
      }
    }
  }
  const lockedDossiersBlock = buildLockedDossiersBlock(referencedDossiers);
  const peerLedgerBlock = buildPositionalPeerLedgerBlock(savedDossiers, conversationDossiers, {
    targetPlayers: route.targetPlayers,
    message,
  });

  // 3. Single-Player Dossier Pipeline
  if (route.intent === 'single_dossier') {
    const primaryPlayer =
      route.targetPlayers[0] ||
      referencedDossiers[0]?.basicInfo.name ||
      extractCandidateSlug(message) ||
      '';

    // A player can hold several cards (current plus prime). Shortcuts and locks only consider
    // cards of the edition this request is asking for.
    const matchesRequestedEdition = (p: PlayerProfile): boolean =>
      isPrimeCard(p) === route.isHistorical;
    const currentReferenced = referencedDossiers.filter((p) => !isPrimeCard(p));
    const currentSaved = savedResult.dossiers.filter((p) => !isPrimeCard(p));

    if (!imageData && !route.wantsRegeneration) {
      // Return locked in-conversation dossier if re-requested without regeneration flag
      if (
        !route.isHistorical &&
        currentReferenced.length === 1 &&
        isFreshlyCalibrated(currentReferenced[0])
      ) {
        return currentReferenced[0];
      }

      // Return saved archive dossier if explicitly requested
      if (
        !route.isHistorical &&
        wantsSavedDossierAccess(message) &&
        currentSaved.length === 1 &&
        isFreshlyCalibrated(currentSaved[0])
      ) {
        return currentSaved[0];
      }

      // Check in-memory calibrated pool first (0ms hit for last-name or full-name matches)
      if (!route.isHistorical && primaryPlayer) {
        const allCalibrated = mergeAllCalibratedDossiers(savedDossiers, conversationDossiers).filter(
          (p) => !isPrimeCard(p),
        );
        const poolHits = findReferencedDossiers(primaryPlayer, allCalibrated, [primaryPlayer]);
        if (
          poolHits.length === 1 &&
          isFreshlyCalibrated(poolHits[0]) &&
          isCardInRefreshWindow(poolHits[0])
        ) {
          perf('in-memory calibrated pool hit');
          return poolHits[0];
        }
      }
    }

    // Shared cards: one current card per player per week, and prime cards are frozen, so even a
    // regeneration request gets the published card while it's in its refresh window. The one
    // exception is consensus: enough people independently challenging it the same way.
    let supersede = false;
    if (!imageData) {
      const rawSlug = toPlayerSlug(primaryPlayer) || extractCandidateSlug(message);
      if (rawSlug) {
        const cached = await getCachedDossier(toDossierCardSlug(rawSlug, route.isHistorical));
        if (cached) {
          supersede = hasRevisionConsensus(await fetchRevisionsForCard(cached));
          if (!supersede) {
            perf('supabase cache hit');
            return cached;
          }
          perf('challenge consensus: re-rating early');
        }
      }
    }

    options?.onStageChange?.(
      route.isHistorical
        ? `Researching ${primaryPlayer || 'player'}'s career peak & honours...`
        : `Verifying ${primaryPlayer || 'player'}'s live club, coach & stats...`,
    );

    // Prior authored cards (longitudinal memory) only need the name, so fetch them alongside grounding.
    const [grounding, priorDossiers, challengeRows] = await Promise.all([
      gatherPlayerGrounding({
        playerName: primaryPlayer,
        rawMessage: message,
        isHistorical: route.isHistorical,
      }),
      fetchPriorDossiersForPlayer(primaryPlayer, [...savedDossiers, ...conversationDossiers]),
      fetchRevisionsForPlayer(primaryPlayer),
    ]);
    perf('hybrid grounding');

    options?.onStageChange?.(
      `Calibrating 25-attribute dossier for ${grounding.apiPlayer?.name || primaryPlayer || 'player'}...`,
    );

    const freshReferencedDossiers = referencedDossiers
      .filter(matchesRequestedEdition)
      .filter(isFreshlyCalibrated);
    const synthesisLockedBlock = route.wantsRegeneration
      ? ''
      : buildLockedDossiersBlock(freshReferencedDossiers);
    const synthesisPeerLedgerBlock = grounding.apiPlayer?.position
      ? buildPositionalPeerLedgerBlock(savedDossiers, conversationDossiers, {
          targetPlayers: route.targetPlayers,
          positionHint: grounding.apiPlayer.position,
          message,
        })
      : peerLedgerBlock;

    // Challenges count only against the shared card this rating replaces: the newest prior card
    // of the requested edition (priorDossiers is oldest first).
    const replacedCard = priorDossiers.filter(matchesRequestedEdition).at(-1);
    const replacedSlug = replacedCard ? toVersionedSlug(replacedCard) : null;
    const replacedCardChallenges = challengeRows.filter((r) => r.card_slug === replacedSlug);

    const priorTrajectoryBlock =
      buildPriorDossierTrajectoryBlock(
        priorDossiers,
        grounding.apiPlayer?.name || primaryPlayer || 'player',
      ) + buildRevisionProposalsBlock(replacedCardChallenges);

    const profile = await synthesizePlayerDossier({
      rawMessage: message,
      isHistorical: route.isHistorical,
      foundationText: grounding.foundationText,
      verifiedFacts: grounding.verifiedFacts,
      verifiedFactsBlock: grounding.verifiedFactsBlock,
      apiPlayer: grounding.apiPlayer,
      lockedDossiersBlock: synthesisLockedBlock,
      savedDossiersBlock,
      peerLedgerBlock: synthesisPeerLedgerBlock,
      priorTrajectoryBlock,
    });
    perf('calibrated synthesis');

    const stampedProfile = stampDossier(profile, Date.now());
    upsertCachedDossier(
      toDossierCardSlug(stampedProfile.basicInfo.name, route.isHistorical),
      stampedProfile,
      { supersede },
    );
    return stampedProfile;
  }

  // 4. Conversational Scout Pipeline (Comparisons, Live Dossier Revisions, Tactical Q&A, Archive)
  const reply = await runConversationalScout({
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
    onDossierUpdated: options?.onDossierUpdated,
    onStreamChunk: options?.onStreamChunk,
    onStageChange: options?.onStageChange,
  });
  perf('conversational scout');
  return reply;
};
