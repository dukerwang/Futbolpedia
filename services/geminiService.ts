import type { ChatMessage, GaffaContextBag, GaffaTradeScorecard, PlayerProfile, RatingRequest, ReplyBlock } from '../types';
import { ThinkingTier } from '../constants/modelProfiles';
import { buildConversationalScoutInstruction } from '../prompts/chatPrompt';
import {
  FLASH_MODEL,
  generateProseTurn,
  generateStructured,
  type ProseToolMode,
} from './aiClient';
import {
  editionGaps,
  offerPrimeScout,
  offerScout,
  runConversationalScout,
  threadIsHistorical,
  wantsPrimeOf,
} from './conversationalScout';
import { lookUpDossier, replaceSupersededPrimes } from './dossierLookup';
import { ReplyComposer, type ComposerExtras } from './replyBlocks';
import { PAST_MODE, runChatTurn, runChatWithFallback, takesChatLoop, type ChatTurnDeps, type PathInfo } from './chatTurn';
import {
  CALIBRATION_EPOCH_MS,
  buildHistoryContents,
  buildLockedDossiersBlock,
  buildPositionalPeerLedgerBlock,
  buildClosestPeersBlock,
  selectClosestPeers,
  selectPositionalPeerLedger,
  buildPriorDossierTrajectoryBlock,
  buildRevisionProposalsBlock,
  buildSavedDossiersBlock,
  cardEdition,
  ensureDossierDated,
  fetchGlobalHubDossiers,
  type GlobalHubDossierItem,
  fetchPriorDossiersForPlayer,
  fetchRevisionsForCard,
  fetchRevisionsForPlayer,
  fetchSupabaseCalibratedPool,
  findEraCard,
  findReferencedDossiers,
  formatEraQualifier,
  getCachedDossier,
  getCachedEraCard,
  getCachedSeasonCard,
  getCardKey,
  renameDossierCard,
  getDossierEvaluationDate,
  getSharedConversation,
  getSupabaseCalibratedPool,
  hasRevisionConsensus,
  isCardInRefreshWindow,
  isDossierDated,
  isPrimeCard,
  isSupabaseReady,
  mergeAllCalibratedDossiers,
  mergeConversationDossiers,
  pickCardPerPlayer,
  resolveSavedDossiersForRequest,
  seasonMatches,
  shareConversation,
  shareDossierCard,
  stampDossier,
  supabase,
  toBasePlayerSlug,
  toDossierCardSlug,
  toEraKey,
  toPlayerSlug,
  toVersionedSlug,
  upsertCachedDossier,
  wantsSavedDossierAccess,
} from './dossierStore';
import { synthesizePlayerDossier } from './dossierSynthesizer';
import { getClubManager, isSameClub } from './clubManagers';
import { attachVerifiedManager } from './profileManagerGrounding';
import { reviseCardTraits } from './cardTraits';
import {
  type CareerStatus,
  fetchApiFootballPlayer,
  gatherPlayerGrounding,
  gatherSearchFoundation,
  getCareerStatus,
  getPlayerIdentity,
  groundingShowsRetirement,
  type PlayerIdentity,
} from './groundingService';
import { withFreshLatestUpdate } from './latestUpdateRefresh';
import { ratingTask, routeForRating } from './ratingCommand';
import { classifyTurn, extractCandidateSlug, type TurnRoute } from './turnRouter';
import { startQuestionSearch } from './researchAgent';
import { startDebateBrief } from './debateBrief';
import { isGaffaTrade } from './gaffaTurn';
import { liveDebateRecords } from './eraSnapshots';
import { liveToolset } from './researchTools';

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
  renameDossierCard,
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

export type { ComposerExtras } from './replyBlocks';

export interface SendMessageOptions {
  onDossierUpdated?: (updatedProfile: PlayerProfile) => void;
  /**
   * Called whenever a chat reply's blocks change (its prose growing, a view or card placed) and
   * once more with the final blocks. `extras.cards` are the profiles behind the card blocks.
   */
  onBlocks?: (blocks: ReplyBlock[], extras: ComposerExtras) => void;
  onStreamChunk?: (accumulatedText: string) => void;
  onStageChange?: (stageLabel: string) => void;
  /** The conversation's attached Gaffa club. Chat turns read it; ratings ignore it. */
  gaffaBag?: GaffaContextBag;
  /** Called with a Gaffa trade scorecard before the reply streams. */
  onGaffaScorecard?: (scorecard: GaffaTradeScorecard) => void;
  /** Keys the turn's follow-up state, so conversations never share each other's research. */
  conversationId?: string;
  /** Answer a rating request in prose instead of rating (Gaffa's panel, which can't show or pay for a card). */
  noRating?: boolean;
  /** Called with the route, so a caller can tell a rating request was answered in prose. */
  onRoute?: (route: { intent: string; targetPlayers: string[] }) => void;
  /**
   * The card the user chose to challenge (Challenge on the card), by card key. Only then can a turn
   * revise a rating; without it, pushback on a card is answered as a question.
   */
  challengeCardKey?: string;
  /**
   * Sends a turn the chat loop (`chatTurn.ts`) would take to the stage pipeline instead: the eval's
   * `--stage` and the tests send it. The app never does.
   */
  stage?: boolean;
  /**
   * Overrides `PAST_MODE` (`chatTurn.ts`) for one turn: true sends a question about the past to the
   * chat loop, and lets a present turn comparing carded versions commit its verdict. The eval's
   * `--set historical --past-mode` and the tests set it.
   */
  pastMode?: boolean;
  /** Called as each path starts: once for the path chosen, and again on the stage run that follows a chat turn's failure. */
  onPath?: (info: PathInfo) => void;
  /** Fakes and overrides for the chat loop's model, tools and budget, for tests and the eval. */
  chatDeps?: ChatTurnDeps;
}

/**
 * The card a challenge is about, by its key; else the same player's card in the same edition, since
 * a re-rated prime comes back under a new key.
 */
const findCard = (key: string, cards: PlayerProfile[]): PlayerProfile | undefined => {
  const exact = cards.find((c) => getCardKey(c) === key);
  if (exact) return exact;
  const [player, edition] = key.split(':');
  return cards.find((c) => toBasePlayerSlug(c.basicInfo.name) === player && cardEdition(c) === edition);
};

/** Logs each pipeline step's time to the console, unless `window.FUTBOLPEDIA_PERF` is false. */
const createPerfLogger = (): ((label: string) => void) => {
  const perfEnabled =
    typeof window === 'undefined' || (window as any).FUTBOLPEDIA_PERF !== false;
  const perfStart = (typeof performance !== 'undefined' ? performance : Date).now();
  let perfPrev = perfStart;
  return (label: string) => {
    if (!perfEnabled) return;
    const now = (typeof performance !== 'undefined' ? performance : Date).now();
    console.log(
      `[Perf] ${label}: +${Math.round(now - perfPrev)}ms (total ${Math.round(now - perfStart)}ms)`,
    );
    perfPrev = now;
  };
};

/** The cards and prompt blocks a turn works from, whichever pipeline answers it. */
interface TurnContext {
  conversationDossiers: PlayerProfile[];
  savedResult: ReturnType<typeof resolveSavedDossiersForRequest>;
  savedDossiersBlock: string;
  referencedDossiers: PlayerProfile[];
  lockedDossiersBlock: string;
  peerLedgerOptions: { targetPlayers: string[]; message: string };
  peerLedger: PlayerProfile[];
  peerLedgerBlock: string;
}

/** Resolves conversation-locked and saved-archive dossiers and the peer ledger for a turn. */
const buildTurnContext = (
  message: string,
  route: TurnRoute,
  conversationDossiers: PlayerProfile[],
  savedDossiers: PlayerProfile[],
): TurnContext => {
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
  // Saved cards first so a card already in this conversation wins over its archived copy.
  const lockedDossiersBlock = buildLockedDossiersBlock(
    pickCardPerPlayer(
      [
        ...referencedDossiers.filter((p) => !conversationDossiers.includes(p)),
        ...referencedDossiers.filter((p) => conversationDossiers.includes(p)),
      ],
      route.isHistorical,
    ),
  );
  const peerLedgerOptions = { targetPlayers: route.targetPlayers, message };
  const peerLedger = selectPositionalPeerLedger(savedDossiers, conversationDossiers, peerLedgerOptions);
  const peerLedgerBlock = buildPositionalPeerLedgerBlock(
    savedDossiers,
    conversationDossiers,
    peerLedgerOptions,
    peerLedger,
  );
  return {
    conversationDossiers,
    savedResult,
    savedDossiersBlock,
    referencedDossiers,
    lockedDossiersBlock,
    peerLedgerOptions,
    peerLedger,
    peerLedgerBlock,
  };
};

/**
 * The single-player dossier pipeline: serves a published card for the requested version when one
 * answers it, and rates the player otherwise. Typed ratings reach it through the turn router and
 * the Rate command through `ratePlayer`.
 */
const rateDossier = async (params: {
  message: string;
  route: TurnRoute;
  context: TurnContext;
  savedDossiers: PlayerProfile[];
  imageData?: string;
  options?: SendMessageOptions;
  perf: (label: string) => void;
  /** Card review's prime draft: rated, returned, never published here. */
  hold?: boolean;
  /**
   * The bridge check's draft: rated afresh even when a published card answers the request, with
   * none of the player's own cards in view, so no earlier rating of his anchors it. Set with `hold`.
   */
  blind?: boolean;
}): Promise<string | PlayerProfile> => {
  const { message, route, context, savedDossiers, imageData, options, perf, blind } = params;
  const {
    conversationDossiers,
    savedResult,
    savedDossiersBlock,
    referencedDossiers,
    peerLedgerOptions,
    peerLedger,
    peerLedgerBlock,
  } = context;

  const primaryPlayer =
    route.targetPlayers[0] ||
    referencedDossiers[0]?.basicInfo.name ||
    extractCandidateSlug(message) ||
    '';

  // A dossier rates one version of a player: today's form, his prime, a named past season, or
  // a named era ("PSG Neymar"). A retired player asked about with no timeframe gets his prime
  // (see below).
  let isHistorical = route.isHistorical;
  const season = route.requestedSeason ?? null;
  let era = season ? null : route.requestedEra ?? null;
  // An era named after the club he plays for now is his current form, unless he has retired.
  if (era && primaryPlayer && !imageData) {
    const apiPlayer = await fetchApiFootballPlayer(primaryPlayer);
    if (
      apiPlayer?.currentClub &&
      isSameClub(apiPlayer.currentClub, era) &&
      (await getCareerStatus(primaryPlayer)) !== 'retired'
    ) {
      perf('era at his current club: rating current form');
      era = null;
      isHistorical = false;
    }
  }
  // An explicit "rerate" of a prime card regenerates it from scratch and replaces the frozen
  // shared card. Read after the retirement check too, since that can turn a request historical.
  const reratingPrime = (): boolean => Boolean(route.rerate) && isHistorical && !season && !era;
  // Who the typed name refers to: the name he is commonly known by, his full name and his
  // career status. With no timeframe it is asked right away, since his status picks the edition;
  // otherwise only once no published card answers the request under the typed name.
  let identityPromise: Promise<PlayerIdentity> | null = null;
  const loadIdentity = (): Promise<PlayerIdentity> =>
    (identityPromise ??=
      imageData || !primaryPlayer
        ? Promise.resolve({ status: 'unknown', knownAs: null, fullName: null })
        : getPlayerIdentity(primaryPlayer));
  const identityNames = async (): Promise<(string | null)[]> => {
    const { knownAs, fullName } = await loadIdentity();
    return [knownAs, fullName];
  };
  const careerStatusPromise =
    !isHistorical && !season && !route.wantsCurrentForm && !imageData && primaryPlayer
      ? loadIdentity().then((identity) => identity.status)
      : Promise.resolve<CareerStatus>('unknown');

  // A player can hold several cards (current, prime, past seasons, eras). Shortcuts and locks
  // only consider cards of the version this request is asking for.
  const matchesRequestedEdition = (p: PlayerProfile): boolean =>
    season
      ? isPrimeCard(p) && seasonMatches(p.version?.seasonOrEra, season)
      : era
        ? cardEdition(p) === 'era' && toEraKey(p.version?.qualifier) === toEraKey(era)
        : isPrimeCard(p) === isHistorical &&
          cardEdition(p) !== 'season_snapshot' &&
          cardEdition(p) !== 'era';
  const currentReferenced = referencedDossiers.filter((p) => !isPrimeCard(p));
  const currentSaved = savedResult.dossiers.filter((p) => !isPrimeCard(p));

  if (!imageData && !route.wantsRegeneration) {
    // Return locked in-conversation dossier if re-requested without regeneration flag
    if (
      !isHistorical &&
      currentReferenced.length === 1 &&
      isFreshlyCalibrated(currentReferenced[0])
    ) {
      return currentReferenced[0];
    }

    // Return saved archive dossier if explicitly requested
    if (
      !isHistorical &&
      wantsSavedDossierAccess(message) &&
      currentSaved.length === 1 &&
      isFreshlyCalibrated(currentSaved[0])
    ) {
      return currentSaved[0];
    }

    // Check in-memory calibrated pool first (0ms hit for last-name or full-name matches)
    if (!isHistorical && primaryPlayer) {
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
        return withFreshLatestUpdate(poolHits[0], options?.onStageChange);
      }
    }
  }

  // Prior authored cards (longitudinal memory) only need the name. Fetched once per name.
  const priorDossiersByName = new Map<string, Promise<PlayerProfile[]>>();
  const priorDossiersFor = (name: string | null | undefined): Promise<PlayerProfile[]> => {
    const base = name ? toBasePlayerSlug(name) : '';
    if (!name || !base) return Promise.resolve([]);
    if (!priorDossiersByName.has(base)) {
      priorDossiersByName.set(
        base,
        fetchPriorDossiersForPlayer(name, [...savedDossiers, ...conversationDossiers]),
      );
    }
    return priorDossiersByName.get(base)!;
  };
  // His cards under every name he goes by, oldest first.
  const loadAllPriorDossiers = async (): Promise<PlayerProfile[]> => {
    const names = [primaryPlayer, ...(await identityNames())];
    const byKey = new Map<string, PlayerProfile>();
    for (const p of (await Promise.all(names.map(priorDossiersFor))).flat()) {
      byKey.set(getCardKey(p), p);
    }
    return [...byKey.values()].sort((x, y) =>
      (x.evaluationDate || '').localeCompare(y.evaluationDate || ''),
    );
  };

  const sharedCardBySlug = new Map<string, Promise<PlayerProfile | null>>();
  const sharedCardAt = (slug: string): Promise<PlayerProfile | null> => {
    if (!sharedCardBySlug.has(slug)) sharedCardBySlug.set(slug, getCachedDossier(slug));
    return sharedCardBySlug.get(slug)!;
  };

  // The shared card of one edition. The typed name may not be the card's ("zidane" for
  // "Zinedine Zidane"), so the names on the player's other cards are tried too.
  const findSharedCard = async (
    historical: boolean,
    ...names: (string | null | undefined)[]
  ): Promise<PlayerProfile | null> => {
    const priorCards = priorDossiersFor(primaryPlayer);
    const lookUp = async (candidates: (string | null | undefined)[]) => {
      for (const name of candidates) {
        if (!name || !toBasePlayerSlug(name)) continue;
        const card = await sharedCardAt(toDossierCardSlug(name, historical));
        if (card) return card;
      }
      return null;
    };
    return (
      (await lookUp(names)) ??
      (await lookUp((await priorCards).map((p) => p.basicInfo.name)))
    );
  };

  // A published card under the typed name, else under the names the identity check gives him
  // ("zico" for a card published as "Arthur Antunes Coimbra").
  const findUnderAnyName = async (
    find: (name: string) => Promise<PlayerProfile | null>,
  ): Promise<PlayerProfile | null> => {
    const tried = new Set<string>();
    for (const name of [primaryPlayer, ...(await identityNames())]) {
      const base = name ? toBasePlayerSlug(name) : '';
      if (!name || !base || tried.has(base)) continue;
      tried.add(base);
      const card = await find(name);
      if (card) return card;
    }
    return null;
  };

  // Shared cards: one current card per player per month, and prime cards are frozen, so even a
  // regeneration request gets the published card while it's in its refresh window. The one
  // exception is consensus: enough people independently challenging it the same way.
  let supersede = false;
  if (!imageData && !blind && season) {
    const seasonCard =
      (await getCachedSeasonCard(primaryPlayer, season)) ??
      (await findUnderAnyName((name) => getCachedSeasonCard(name, season)));
    if (seasonCard) {
      perf('supabase season card hit');
      return seasonCard;
    }
  } else if (!imageData && !blind && era) {
    const eraCard =
      (await getCachedEraCard(primaryPlayer, { qualifier: era })) ??
      (await findUnderAnyName((name) => getCachedEraCard(name, { qualifier: era })));
    if (eraCard) {
      perf('supabase era card hit');
      return eraCard;
    }
  } else if (!imageData && !blind && !reratingPrime()) {
    const rawSlug = toPlayerSlug(primaryPlayer) || extractCandidateSlug(message);
    if (rawSlug) {
      let cached =
        (await findSharedCard(isHistorical, rawSlug)) ??
        (await findSharedCard(isHistorical, ...(await identityNames())));
      // With no timeframe, a retired player's answer is his prime card. When one is published,
      // the status check alone decides, so a retired player's prime needs no grounding.
      if (!cached && !isHistorical && !route.wantsCurrentForm && !route.rerate) {
        const primeCard = await findSharedCard(true, rawSlug, ...(await identityNames()));
        if (primeCard && (await careerStatusPromise) === 'retired') {
          perf('retired player: his published prime');
          isHistorical = true;
          cached = primeCard;
        }
      }
      if (cached) {
        supersede = hasRevisionConsensus(await fetchRevisionsForCard(cached));
        if (!supersede) {
          perf('supabase cache hit');
          return withFreshLatestUpdate(cached, options?.onStageChange);
        }
        perf('challenge consensus: re-rating early');
      }
    }
  }

  // No published card answers the request, so this one is rated, under the name he is commonly
  // known by: one player gets one name, whatever the user called him.
  const identity = await loadIdentity();
  // Never rate somebody else when the name isn't a footballer's.
  if (identity.noSuchPlayer) {
    perf('no such footballer');
    return `I couldn't find a footballer called "${primaryPlayer}". Which player did you mean?`;
  }
  // Futbolpedia rates footballers, never a coach or anyone else who never played.
  if (identity.neverPlayed) {
    perf('never played professionally');
    const who = identity.knownAs || primaryPlayer;
    return `${who} never played professionally, so there's no footballer to rate. Futbolpedia rates players' footballing ability, not coaching.`;
  }
  const subjectName = identity.knownAs || primaryPlayer;

  options?.onStageChange?.(
    season
      ? `Studying ${subjectName || 'player'}'s ${season} season...`
      : era
        ? `Studying ${subjectName || 'player'}'s ${formatEraQualifier(era)} era...`
        : isHistorical
          ? `Studying ${subjectName || 'player'}'s peak years...`
          : `Studying ${subjectName || 'player'}...`,
  );

  // Prior cards and the career status check run alongside grounding, so active players wait
  // for nothing.
  let [grounding, priorDossiers, challengeRows, careerStatus] = await Promise.all([
    gatherPlayerGrounding({
      playerName: subjectName,
      rawMessage: message,
      isHistorical,
      season,
      era,
    }),
    loadAllPriorDossiers(),
    fetchRevisionsForPlayer(subjectName),
    careerStatusPromise,
  ]);
  perf('hybrid grounding');

  // The typed name may not be the card's ("neymar" for "Neymar Jr"), so the archive lookup
  // above can miss an era card the player's other cards hold.
  const knownEraCard = era && !imageData ? findEraCard(priorDossiers, { qualifier: era }) : null;
  if (knownEraCard) {
    perf('era card hit');
    return knownEraCard;
  }

  // A retired player has no current form to rate, so he gets his prime, even when current form
  // was asked for: a coach or pundit who once played is rated as the player he was.
  // When the status check is inconclusive, the grounding itself can still show it.
  // A request for current form skips the early status check, so read the identity's.
  const status = careerStatus === 'unknown' ? identity.status : careerStatus;
  const retired =
    !isHistorical &&
    !season &&
    !era &&
    (status === 'retired' ||
      (status === 'unknown' &&
        !imageData &&
        groundingShowsRetirement(grounding.statusText ?? grounding.foundationText, grounding.apiPlayer)));
  if (retired) {
    isHistorical = true;
    perf('retired player: rating his prime');
    const rawSlug = toPlayerSlug(primaryPlayer) || extractCandidateSlug(message);
    const primeCard = reratingPrime()
      ? null
      : await findSharedCard(
          true,
          rawSlug,
          identity.knownAs,
          identity.fullName,
          grounding.apiPlayer?.name,
        );
    if (primeCard && !hasRevisionConsensus(await fetchRevisionsForCard(primeCard))) {
      return primeCard;
    }
    options?.onStageChange?.(`Studying ${subjectName}'s peak years...`);
    grounding = await gatherPlayerGrounding({ playerName: subjectName, rawMessage: message, isHistorical });
  }

  // The typed name may not match the shared card's ("pedro", a nickname, a fuller name).
  // Grounding has resolved the registered name, so look for this month's shared card under it
  // before synthesizing a duplicate.
  const canonicalName = grounding.apiPlayer?.name;
  if (
    !imageData &&
    !supersede &&
    !season &&
    !era &&
    !reratingPrime() &&
    canonicalName &&
    toPlayerSlug(canonicalName) !== toPlayerSlug(primaryPlayer)
  ) {
    const cached = await getCachedDossier(toDossierCardSlug(canonicalName, isHistorical));
    if (cached) {
      supersede = hasRevisionConsensus(await fetchRevisionsForCard(cached));
      if (!supersede) {
        perf('supabase cache hit (registered name)');
        return withFreshLatestUpdate(cached, options?.onStageChange);
      }
    }
  }

  options?.onStageChange?.(
    `Writing ${grounding.apiPlayer?.name || subjectName || 'player'}'s dossier...`,
  );

  const freshReferencedDossiers = referencedDossiers
    .filter(matchesRequestedEdition)
    .filter(isFreshlyCalibrated);
  const synthesisLockedBlock = route.wantsRegeneration
    ? ''
    : buildLockedDossiersBlock(freshReferencedDossiers);
  // A re-rating starts from scratch: the player's own earlier cards never anchor it.
  const ownSlugs = new Set(
    [primaryPlayer, subjectName, identity.fullName, canonicalName].map((n) => toBasePlayerSlug(n ?? '')),
  );
  const synthesisPeerLedgerOptions = {
    ...peerLedgerOptions,
    positionHint: grounding.apiPlayer?.position,
    wholeLibrary: true,
    exclude: blind || reratingPrime() ? (p: PlayerProfile) => ownSlugs.has(toBasePlayerSlug(p.basicInfo.name)) : undefined,
  };
  // The peers are chosen now, from the whole served library: the turn's context was built before
  // the shared pool had loaded, and a rating with no peers of his level has nothing to place
  // him against.
  await fetchSupabaseCalibratedPool();
  const synthesisPeerLedger = selectPositionalPeerLedger(
    savedDossiers,
    conversationDossiers,
    synthesisPeerLedgerOptions,
  );
  // The card this rating replaces centres the closest peers, read in full beside the one-line ledger.
  const replacedForPeers = priorDossiers.filter(matchesRequestedEdition).at(-1);
  const closestPeers = selectClosestPeers(synthesisPeerLedger, {
    position: replacedForPeers?.basicInfo.position ?? priorDossiers.at(-1)?.basicInfo.position ?? grounding.apiPlayer?.position,
    centre: blind ? null : replacedForPeers?.ratings.overall ?? null,
    exclude: (p) => ownSlugs.has(toBasePlayerSlug(p.basicInfo.name)),
  });
  const synthesisPeerLedgerBlock =
    buildPositionalPeerLedgerBlock(
      savedDossiers,
      conversationDossiers,
      synthesisPeerLedgerOptions,
      synthesisPeerLedger,
    ) + buildClosestPeersBlock(closestPeers);

  // Challenges count only against the shared card this rating replaces: the newest prior card
  // of the requested edition (priorDossiers is oldest first).
  const replacedCard = priorDossiers.filter(matchesRequestedEdition).at(-1);
  const replacedSlug = replacedCard ? toVersionedSlug(replacedCard) : null;
  const replacedCardChallenges = challengeRows.filter((r) => r.card_slug === replacedSlug);

  const priorTrajectoryBlock = blind || reratingPrime()
    ? ''
    : buildPriorDossierTrajectoryBlock(
        priorDossiers,
        grounding.apiPlayer?.name || subjectName || 'player',
      ) + buildRevisionProposalsBlock(replacedCardChallenges);

  // Look up the club's verified manager while the card is synthesized; prime cards skip it.
  const managerPromise = isHistorical
    ? Promise.resolve(null)
    : getClubManager(grounding.apiPlayer?.currentClub).catch(() => null);

  const synthesized = await synthesizePlayerDossier({
    rawMessage: message,
    isHistorical: isHistorical,
    foundationText: grounding.foundationText,
    verifiedFacts: grounding.verifiedFacts,
    verifiedFactsBlock: grounding.verifiedFactsBlock,
    apiPlayer: grounding.apiPlayer,
    lockedDossiersBlock: synthesisLockedBlock,
    savedDossiersBlock,
    peerLedgerBlock: synthesisPeerLedgerBlock,
    peerLedgerCards: synthesisPeerLedger,
    priorTrajectoryBlock,
    requestedSeason: season,
    requestedEra: era,
    cardName: identity.knownAs,
  });
  perf('calibrated synthesis');

  // An era is defined by its years: when a card already rates these seasons (another era's,
  // the prime's, or the season's), that card is the answer, whatever this era is called.
  if (era && !imageData) {
    const window = synthesized.version?.seasonOrEra;
    const published =
      findEraCard(priorDossiers, { window }) ??
      (await getCachedEraCard(synthesized.basicInfo.name, { window }));
    if (published) {
      perf('era already rated under another name');
      return published;
    }
  }

  // Strengths and weaknesses that read the same as lines on other players' cards are rewritten
  // about this player, and any other weakness that breaks the rules is replaced
  // (services/cardTraits.ts).
  let profile = await reviseCardTraits(
    synthesized,
    [...getSupabaseCalibratedPool(), ...savedDossiers, ...conversationDossiers],
    grounding.foundationText,
  );
  perf('card traits');
  if (!isHistorical) {
    // API-Football's registered club decides whose manager is shown. The card's club stands in
    // only when API-Football has no record; when they disagree, nobody can say which club is
    // current, so no manager is named.
    const apiClub = grounding.apiPlayer?.currentClub;
    const manager =
      apiClub || profile.basicInfo.club === 'N/A'
        ? await managerPromise
        : await getClubManager(profile.basicInfo.club).catch(() => null);
    const sameClub =
      !manager || profile.basicInfo.club === 'N/A' || isSameClub(manager.club, profile.basicInfo.club);
    profile = attachVerifiedManager(profile, sameClub ? manager : null);
    perf('verified manager');
  }

  const now = Date.now();
  const stampedProfile = stampDossier(reratingPrime() ? { ...profile, rerateAt: now } : profile, now);
  if (!params.hold) {
    upsertCachedDossier(
      toDossierCardSlug(stampedProfile.basicInfo.name, isHistorical),
      stampedProfile,
      { supersede: supersede || reratingPrime() },
    );
  }
  return stampedProfile;
};

export const sendMessageToAI = async (
  message: string,
  history: ChatMessage[],
  imageData?: string,
  conversationProfiles: PlayerProfile[] = [],
  savedDossiers: PlayerProfile[] = [],
  options?: SendMessageOptions,
): Promise<string | PlayerProfile> => {
  const perf = createPerfLogger();
  const isEAFCRequest = /\b(playstyle\+?|fc\s*card|eafc|ea\s*fc)\b/i.test(message);
  let conversationDossiers = mergeConversationDossiers(history, conversationProfiles);

  // 1. Classify turn via Structured Turn Router (warm Supabase pool in background without blocking routing).
  // A question that looks like it's about the present starts its web search now, while routing runs.
  void fetchSupabaseCalibratedPool();
  // A chat loop turn decides its own searches, so nothing is started for it. Gaffa's panel and a
  // Gaffa trade take the stage pipeline, so they keep their search: the stage pipeline reads it.
  const gaffaTrade = isGaffaTrade(message, history, options?.gaffaBag);
  // A conversation with a club attached is about the present unless the user's own words say otherwise.
  const gaffaThread = { userOnly: Boolean(options?.gaffaBag?.connected) };
  const loopFirst = !options?.stage && !options?.noRating && !gaffaTrade;
  const questionSearch = imageData || loopFirst ? null : startQuestionSearch(message, liveToolset([]));
  // One that looks like it's about the past, in a new chat, starts its debate brief, unless past
  // questions take the loop (`PAST_MODE`), which writes no brief.
  const pastMode = options?.pastMode ?? PAST_MODE;
  const debateBrief = imageData || history.length || (pastMode && loopFirst) ? null : startDebateBrief(message, { debates: liveDebateRecords });
  let route = await classifyTurn({
    message,
    history,
    conversationDossiers,
    hasImage: Boolean(imageData),
  });
  perf(`turn router (${route.intent})`);
  options?.onRoute?.(route);
  // Where a card can't be shown (Gaffa's panel), a rating request is answered as a question about
  // the player, from his card when one exists.
  if (route.intent === 'single_dossier' && options?.noRating) {
    route = { ...route, intent: 'tactical_chat', analyticalMode: 'player_qa' };
  }

  // A prime re-rated since this thread or your dossiers got it is read from its new card. A
  // "rerate" starts from scratch and strips its own cards itself.
  if (!route.rerate) {
    const live = await replaceSupersededPrimes({ history, conversationProfiles, savedDossiers }).catch(
      () => null,
    );
    if (live) {
      ({ history, savedDossiers } = live);
      conversationDossiers = mergeConversationDossiers(history, live.conversationProfiles);
      perf('superseded primes');
    }
  }

  // A rating is revised only when the user chose to challenge it. Without that, pushback on a card
  // is a question to answer, never an argument the card is put on trial for.
  const challengeCard = options?.challengeCardKey
    ? findCard(options.challengeCardKey, [...conversationDossiers, ...savedDossiers])
    : undefined;
  if (challengeCard && route.intent !== 'single_dossier') {
    route = {
      ...route,
      intent: 'challenge_or_revise',
      analyticalMode: 'debate_or_verdict',
      targetPlayers: [challengeCard.basicInfo.name],
      isHistorical: isPrimeCard(challengeCard),
    };
    if (!conversationDossiers.some((c) => getCardKey(c) === getCardKey(challengeCard))) {
      conversationDossiers = [...conversationDossiers, challengeCard];
    }
  } else if (route.intent === 'challenge_or_revise') {
    route = { ...route, intent: 'tactical_chat', analyticalMode: route.targetPlayers.length === 1 ? 'player_qa' : 'debate_or_verdict' };
  }

  // 2. Single-Player Dossier Pipeline
  if (route.intent === 'single_dossier') {
    const context = buildTurnContext(message, route, conversationDossiers, savedDossiers);
    return rateDossier({ message, route, context, savedDossiers, imageData, options, perf });
  }

  // 3. Chat reads the cards of the players it is asked about, yours or shared. A question about
  // one player shows his card; a player nobody has rated is offered to Scout.
  const composer = new ReplyComposer({ onChange: options?.onBlocks });
  // The running text and a Gaffa scorecard reach the composer on their way to the caller.
  // A turn whose caller doesn't stream stays non-streaming: passing a handler would change how the model is called.
  const onStreamChunk = options?.onStreamChunk
    ? (text: string) => {
        // A turn that gates by segment (the conversational scout) feeds the composer the raw text itself.
        if (!composer.hasGate) composer.setText(text);
        options.onStreamChunk!(text);
      }
    : undefined;
  const onGaffaScorecard = (card: GaffaTradeScorecard) => {
    composer.setScorecard(card);
    options?.onGaffaScorecard?.(card);
  };
  let turnDossiers = savedDossiers;
  if (
    !imageData &&
    route.targetPlayers.length > 0 &&
    (route.intent === 'tactical_chat' || route.intent === 'compare')
  ) {
    const localCards = mergeAllCalibratedDossiers(savedDossiers, conversationDossiers);
    // The edition the conversation is about, as the writer reads it: a follow-up in a prime debate
    // that names no timeframe is still about primes.
    const historical = threadIsHistorical(route, history, message, gaffaThread);
    const lookups = await Promise.all(
      route.targetPlayers
        .slice(0, 4)
        // A player whose prime the message names is looked up in his prime, however the turn routed.
        .map((name) => lookUpDossier(name, localCards, wantsPrimeOf(message, name, historical)).catch(() => null)),
    );
    lookups.forEach((lookup, i) => {
      if (lookup?.status === 'found') {
        if (!localCards.includes(lookup.card)) turnDossiers = [...turnDossiers, lookup.card];
        // His prime was asked about but only his current form is rated: offer to scout the prime.
        if (editionGaps([lookup.card], historical, message).length) {
          offerPrimeScout(composer, lookup.card.basicInfo.name);
        }
      } else if (lookup?.status === 'missing') {
        offerScout(composer, route.targetPlayers[i]);
      }
    });
    perf('dossier lookup');
  }

  // 4. Resolve conversation-locked and saved-archive dossiers
  const context = buildTurnContext(message, route, conversationDossiers, turnDossiers);
  const { lockedDossiersBlock, savedDossiersBlock, peerLedgerBlock } = context;

  // 5. The chat loop: one model loop decides the research, for a question about the present, a Gaffa
  // club attached in the app included. Every other turn takes the conversational scout, and so does
  // a turn whose loop gives up.
  const historicalThread = threadIsHistorical(route, history, message, gaffaThread);
  const loop = takesChatLoop({
    stage: options?.stage,
    route,
    historical: historicalThread,
    noRating: options?.noRating,
    gaffaTrade,
    image: Boolean(imageData),
    pastMode,
  });
  // The writer's initiative (ask, prepare, offer) belongs to the app's own chat: Gaffa's panel
  // (`noRating`) can't draw chips or offers.
  const initiative = !options?.noRating;
  // 6. Conversational Scout Pipeline (Comparisons, Live Dossier Revisions, Tactical Q&A, Archive)
  const runStage = () =>
    runConversationalScout({
      message,
      route,
      history,
      questionSearch,
      debateBrief,
      imageData,
      isEAFCRequest,
      conversationDossiers,
      savedDossiers: turnDossiers,
      lockedDossiersBlock,
      savedDossiersBlock,
      peerLedgerBlock,
      composer,
      challengeCard,
      onDossierUpdated: options?.onDossierUpdated,
      onStreamChunk,
      onStageChange: options?.onStageChange,
      gaffaBag: options?.gaffaBag,
      onGaffaScorecard,
      conversationId: options?.conversationId,
      initiative,
      // Gaffa's panel draws its replies as text, so it is offered no views.
      views: !options?.noRating,
      perf,
    });
  let fellBack = false;
  let reply: string;
  if (loop) {
    // What the loop attached before it gave up goes with it; the stage run builds its own.
    const before = composer.snapshot();
    reply = await runChatWithFallback(
      () =>
        runChatTurn(
          {
            message,
            route,
            history,
            isEAFCRequest,
            conversationDossiers,
            savedDossiers: turnDossiers,
            lockedDossiersBlock,
            savedDossiersBlock,
            peerLedgerBlock,
            // A thread about the past runs without the club, as the stage pipeline does.
            gaffaBag: pastMode && historicalThread ? undefined : options?.gaffaBag,
            composer,
            onStreamChunk,
            onStageChange: options?.onStageChange,
            conversationId: options?.conversationId,
            perf,
            // Past mode reads these only while it is on; off, they change nothing.
            ...(pastMode ? { pastMode, historical: historicalThread } : {}),
          },
          options?.chatDeps,
        ),
      () => {
        fellBack = true;
        composer.restore(before);
        return runStage();
      },
      { onStageChange: options?.onStageChange, onPath: options?.onPath },
    );
  } else {
    options?.onPath?.({ path: 'stage' });
    reply = await runStage();
  }
  perf(loop && !fellBack ? 'chat turn' : 'conversational scout');
  // The reply's blocks, with its final text: what the app stores.
  composer.finish(reply);
  return reply;
};

/**
 * The Rate command: rates one version of a player without routing a chat turn. It runs the same
 * pipeline as a typed rating, so a published card is served the same way.
 */
export const ratePlayer = async (
  request: RatingRequest,
  history: ChatMessage[],
  conversationProfiles: PlayerProfile[] = [],
  savedDossiers: PlayerProfile[] = [],
  options?: SendMessageOptions,
): Promise<string | PlayerProfile> => {
  const perf = createPerfLogger();
  const message = ratingTask(request);
  const route = routeForRating(request);
  const live = await replaceSupersededPrimes({ history, conversationProfiles, savedDossiers }).catch(
    () => null,
  );
  if (live) ({ history, conversationProfiles, savedDossiers } = live);
  const conversationDossiers = mergeConversationDossiers(history, conversationProfiles);
  void fetchSupabaseCalibratedPool();
  const context = buildTurnContext(message, route, conversationDossiers, savedDossiers);
  return rateDossier({ message, route, context, savedDossiers, options, perf });
};

/**
 * Card review's prime draft (services/cardReview.ts, on the server): a "rerate" of his prime with
 * the reason the review was opened, and its evidence, in the task. The draft is returned without
 * being published; the scout's reviewer judges it first and the caller publishes an accepted one.
 */
export const draftPrimeRerate = async (name: string, reviewNote: string): Promise<string | PlayerProfile> => {
  const request: RatingRequest = { name, edition: 'prime' };
  const message = `${ratingTask(request)}\n\n${reviewNote}`;
  const route: TurnRoute = { ...routeForRating(request), rerate: true };
  await fetchSupabaseCalibratedPool();
  const context = buildTurnContext(message, route, [], []);
  return rateDossier({ message, route, context, savedDossiers: [], perf: createPerfLogger(), hold: true });
};

/**
 * The bridge check's season draft (scripts/eval-bridge-check.ts; the app never calls it): a past
 * season rated by the historical pipeline with none of the player's own cards in view, so his
 * current card can't anchor the comparison with it. Never published. `savedDossiers` joins the
 * peer ledger, minus his own cards.
 */
export const draftBlindSeason = async (name: string, season: string, savedDossiers: PlayerProfile[] = []): Promise<string | PlayerProfile> => {
  const request: RatingRequest = { name, edition: 'season', season };
  const message = ratingTask(request);
  const route = routeForRating(request);
  await fetchSupabaseCalibratedPool();
  const context = buildTurnContext(message, route, [], []);
  return rateDossier({ message, route, context, savedDossiers, perf: createPerfLogger(), hold: true, blind: true });
};
