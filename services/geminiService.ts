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

  // 3. Single-Player Dossier Pipeline
  if (route.intent === 'single_dossier') {
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
    if (!imageData && season) {
      const seasonCard =
        (await getCachedSeasonCard(primaryPlayer, season)) ??
        (await findUnderAnyName((name) => getCachedSeasonCard(name, season)));
      if (seasonCard) {
        perf('supabase season card hit');
        return seasonCard;
      }
    } else if (!imageData && era) {
      const eraCard =
        (await getCachedEraCard(primaryPlayer, { qualifier: era })) ??
        (await findUnderAnyName((name) => getCachedEraCard(name, { qualifier: era })));
      if (eraCard) {
        perf('supabase era card hit');
        return eraCard;
      }
    } else if (!imageData && !reratingPrime()) {
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
    const subjectName = identity.knownAs || primaryPlayer;

    options?.onStageChange?.(
      season
        ? `Researching ${subjectName || 'player'}'s ${season} season...`
        : era
          ? `Researching ${subjectName || 'player'}'s ${formatEraQualifier(era)} era...`
          : isHistorical
            ? `Researching ${subjectName || 'player'}'s career peak & honours...`
            : `Verifying ${subjectName || 'player'}'s live club, coach & stats...`,
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

    // A retired player has no current form to rate, so with no timeframe he gets his prime.
    // When the status check is inconclusive, the grounding itself can still show it.
    const retired =
      !isHistorical &&
      (careerStatus === 'retired' ||
        (careerStatus === 'unknown' &&
          !imageData &&
          !season &&
          !route.wantsCurrentForm &&
          groundingShowsRetirement(grounding.foundationText, grounding.apiPlayer)));
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
      options?.onStageChange?.(`Researching ${subjectName}'s career peak & honours...`);
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
      `Calibrating 25-attribute dossier for ${grounding.apiPlayer?.name || subjectName || 'player'}...`,
    );

    const freshReferencedDossiers = referencedDossiers
      .filter(matchesRequestedEdition)
      .filter(isFreshlyCalibrated);
    const synthesisLockedBlock = route.wantsRegeneration
      ? ''
      : buildLockedDossiersBlock(freshReferencedDossiers);
    const synthesisPeerLedgerOptions = { ...peerLedgerOptions, positionHint: grounding.apiPlayer?.position };
    // A re-rating starts from scratch: the player's own earlier cards never anchor it.
    const ownSlugs = new Set(
      [primaryPlayer, subjectName, identity.fullName, canonicalName].map((n) => toBasePlayerSlug(n ?? '')),
    );
    const synthesisPeerLedger = (
      grounding.apiPlayer?.position
        ? selectPositionalPeerLedger(savedDossiers, conversationDossiers, synthesisPeerLedgerOptions)
        : peerLedger
    ).filter((p) => !reratingPrime() || !ownSlugs.has(toBasePlayerSlug(p.basicInfo.name)));
    const synthesisPeerLedgerBlock =
      grounding.apiPlayer?.position || reratingPrime()
        ? buildPositionalPeerLedgerBlock(
            savedDossiers,
            conversationDossiers,
            synthesisPeerLedgerOptions,
            synthesisPeerLedger,
          )
        : peerLedgerBlock;

    // Challenges count only against the shared card this rating replaces: the newest prior card
    // of the requested edition (priorDossiers is oldest first).
    const replacedCard = priorDossiers.filter(matchesRequestedEdition).at(-1);
    const replacedSlug = replacedCard ? toVersionedSlug(replacedCard) : null;
    const replacedCardChallenges = challengeRows.filter((r) => r.card_slug === replacedSlug);

    const priorTrajectoryBlock = reratingPrime()
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

    let profile = synthesized;
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
    upsertCachedDossier(
      toDossierCardSlug(stampedProfile.basicInfo.name, isHistorical),
      stampedProfile,
      { supersede: supersede || reratingPrime() },
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
