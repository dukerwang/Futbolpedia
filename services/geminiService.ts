import type { ChatMessage, GaffaContextBag, PlayerProfile } from '../types';
import { ThinkingTier } from '../constants/modelProfiles';
import { buildConversationalScoutInstruction } from '../prompts/chatPrompt';
import {
  FLASH_MODEL,
  generateProseTurn,
  generateStructured,
} from './aiClient';
import { runConversationalScout } from './conversationalScout';
import {
  CALIBRATION_EPOCH_MS,
  buildHistoryContents,
  buildLockedDossiersBlock,
  buildPositionalPeerLedgerBlock,
  buildSavedDossiersBlock,
  fetchSupabaseCalibratedPool,
  findReferencedDossiers,
  getCachedDossier,
  getSharedConversation,
  grepDossiers,
  isSupabaseReady,
  mergeConversationDossiers,
  resolveSavedDossiersForRequest,
  shareConversation,
  supabase,
  toPlayerSlug,
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
  getCachedDossier,
  upsertCachedDossier,
  shareConversation,
  getSharedConversation,
  gatherSearchFoundation,
};

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
    dossiersPool: options?.dossiersPool,
    gaffaBag: options?.gaffaBag,
  });
};

export interface SendMessageOptions {
  onDossierUpdated?: (updatedProfile: PlayerProfile) => void;
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
      const slug = toPlayerSlug(p.basicInfo.name);
      if (!referencedDossiers.some((x) => toPlayerSlug(x.basicInfo.name) === slug)) {
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

    const isFreshlyCalibrated = (p?: PlayerProfile): boolean =>
      Boolean(p?.createdAt && p.createdAt >= CALIBRATION_EPOCH_MS);

    if (!imageData) {
      // Return locked in-conversation dossier if re-requested without regeneration/historical flag
      if (
        !route.isHistorical &&
        !route.wantsRegeneration &&
        referencedDossiers.length === 1 &&
        isFreshlyCalibrated(referencedDossiers[0])
      ) {
        return referencedDossiers[0];
      }

      // Return saved archive dossier if explicitly requested
      if (
        !route.isHistorical &&
        !route.wantsRegeneration &&
        wantsSavedDossierAccess(message) &&
        savedResult.dossiers.length === 1 &&
        isFreshlyCalibrated(savedResult.dossiers[0])
      ) {
        return savedResult.dossiers[0];
      }

      // Check Supabase 14-day TTL cache
      const candidateSlug = toPlayerSlug(primaryPlayer) || extractCandidateSlug(message);
      if (candidateSlug && !route.isHistorical && !route.wantsRegeneration) {
        const cached = await getCachedDossier(candidateSlug);
        if (cached) {
          perf('supabase cache hit');
          return cached;
        }
      }
    }

    const grounding = await gatherPlayerGrounding({
      playerName: primaryPlayer,
      rawMessage: message,
      isHistorical: route.isHistorical,
    });
    perf('hybrid grounding');

    const freshReferencedDossiers = referencedDossiers.filter(isFreshlyCalibrated);
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
    });
    perf('calibrated synthesis');

    const stampedProfile: PlayerProfile = {
      ...profile,
      createdAt: Date.now(),
    };

    const baseSlug = toPlayerSlug(stampedProfile.basicInfo.name);
    const cacheSlug =
      route.isHistorical && !baseSlug.startsWith('prime-') && !baseSlug.startsWith('peak-')
        ? `prime-${baseSlug}`
        : baseSlug;
    upsertCachedDossier(cacheSlug, stampedProfile);
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
  });
  perf('conversational scout');
  return reply;
};
