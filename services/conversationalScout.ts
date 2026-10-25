import { Type } from '@google/genai';
import type { ChatMessage, PlayerProfile } from '../types';
import type { ThinkingTier } from '../constants/modelProfiles';
import { ATTRIBUTE_KEYS } from '../constants/ratingTiers';
import { buildConversationalScoutInstruction } from '../prompts/chatPrompt';
import { generateProseTurn, generateStructured, getCurrentSeasonInfo } from './aiClient';
import { buildOngoingThreadBlock, CONTINUITY_REMINDER } from './chatContinuity';
import {
  applyDossierPatch,
  buildHistoryContents,
  buildLockedDossiersBlock,
  DossierPatch,
  findReferencedDossiers,
  mergeAllCalibratedDossiers,
  serializeProfileForHistory,
  toPlayerSlug,
  upsertCachedDossier,
} from './dossierStore';
import { buildSquadTurnoverQuery, gatherSearchFoundation } from './groundingService';
import { extractThreadClubs, type TurnRoute } from './turnRouter';
import {
  formatKnownClubManagersForPrompt,
  scrubUnverifiedManagerText,
} from '../packages/engine/src/gates/managerMentions.ts';

/**
 * Retains the most recent verified `<factual_foundation>` for the active conversation thread
 * so follow-up turns ("Which full-back is tucking in?", "What about their midfield?")
 * never lose the verified squad/transfer facts gathered on Turn 1.
 */
let lastThreadSignature = '';
let lastThreadGrounding = '';

function getThreadSignature(history: ChatMessage[]): string {
  if (history.length === 0) return '';
  const first = history[0];
  return `${first.id ?? ''}:${typeof first.content === 'string' ? first.content.slice(0, 60) : 'dossier'}`;
}

/** Strip leaked internal grounding tags or search citations from user-facing prose and enforce manager fidelity. */
function sanitizeScoutProse(
  text: string,
  managerCtx?: { currentHeadCoach?: string | null; verifiedFacts?: string[] },
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
    .replace(/<\/?(?:factual_foundation|locked_dossiers|calibrated_peer_ledger|saved_dossiers)>/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return scrubUnverifiedManagerText(stripped, {
    currentHeadCoach: managerCtx?.currentHeadCoach ?? null,
    verifiedFacts: managerCtx?.verifiedFacts ?? [],
  });
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
  onDossierUpdated?: (updatedProfile: PlayerProfile) => void;
  onStreamChunk?: (accumulatedText: string) => void;
  onStageChange?: (stageLabel: string) => void;
}

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
    onDossierUpdated,
    onStreamChunk,
    onStageChange,
  } = params;

  const { year, month, currentSeason } = getCurrentSeasonInfo();
  const systemInstruction = buildConversationalScoutInstruction(isEAFCRequest);
  const ongoingThread = buildOngoingThreadBlock(history);

  // 1. Live Dossier Challenge / Revision Path
  if (route.intent === 'challenge_or_revise' && conversationDossiers.length > 0 && !imageData) {
    const referenced = findReferencedDossiers(
      message,
      conversationDossiers,
      route.targetPlayers,
    );
    const targetDossier =
      referenced[0] || conversationDossiers[conversationDossiers.length - 1];

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
      const challengePrompt = `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
${ongoingThread}
${peerLedgerBlock ?? ''}
<active_dossier>
${serializeProfileForHistory(targetDossier)}
</active_dossier>
${groundingNotes ? `<grounding_verification>\n${groundingNotes}\n</grounding_verification>` : ''}
<instructions>
The user is challenging, questioning, or requesting an adjustment to the dossier above.
1. Evaluate their point honestly against the Scout's Code, the recalibrated Section III Rating Tier Scale (where World-Class starts strictly at 90), and any grounding verification or peer benchmarks above.
2. If the current dossier rating/attribute is justified, set \`revisedDossier: false\` and defend the rating directly with concrete tactical/statistical reasoning in \`replyProse\`.
3. If the user makes a valid evidence-backed point (or explicitly asks to adjust a rating/attribute), set \`revisedDossier: true\`, populate \`dossierPatch\` with the exact updated values so the UI card updates live, and explain the revision clearly in \`replyProse\`.
4. Ensure every number you mention in \`replyProse\` matches either the existing dossier or your \`dossierPatch\`.
</instructions>
<user_message>${message}</user_message>`;

      const result = await generateStructured<ChallengeTurnResponse>({
        task: 'chat',
        prompt: challengePrompt,
        systemInstruction,
        schema: CHALLENGE_TURN_SCHEMA,
        thinkingLevelOverride: 'low',
      });

      if (result.revisedDossier && result.dossierPatch) {
        const updatedProfile = applyDossierPatch(targetDossier, result.dossierPatch);
        upsertCachedDossier(toPlayerSlug(updatedProfile.basicInfo.name), updatedProfile);
        onDossierUpdated?.(updatedProfile);
      }

      const cleanedReply = sanitizeScoutProse(result.replyProse);
      onStreamChunk?.(cleanedReply);
      return cleanedReply;
    } catch (e) {
      console.warn('[ConversationalScout] Structured challenge path failed, falling back to prose:', e);
    }
  }

  // 2. Universal Calibrated Ledger Matching & Pre-Grounding across Comparisons, Debates, Rankings & Tactical Chat
  let factualFoundation = '';
  let effectiveLockedBlock = lockedDossiersBlock;

  if (!imageData && route.intent !== 'archive_inventory') {
    const allCalibrated = mergeAllCalibratedDossiers(savedDossiers, conversationDossiers);
    const matchedDossiersBySlug = new Map<string, PlayerProfile>();
    const unratedPlayers: string[] = [];

    for (const targetName of route.targetPlayers) {
      const hits = findReferencedDossiers(targetName, allCalibrated, [targetName]);
      if (hits.length > 0) {
        for (const h of hits) {
          matchedDossiersBySlug.set(toPlayerSlug(h.basicInfo.name), h);
        }
      } else {
        unratedPlayers.push(targetName);
      }
    }

    // Also include any referenced dossiers found directly in the raw message
    for (const d of findReferencedDossiers(message, allCalibrated, route.targetPlayers)) {
      matchedDossiersBySlug.set(toPlayerSlug(d.basicInfo.name), d);
    }

    if (matchedDossiersBySlug.size > 0) {
      effectiveLockedBlock = buildLockedDossiersBlock([...matchedDossiersBySlug.values()]);
    }

    const targetClubs =
      route.targetClubs && route.targetClubs.length > 0
        ? route.targetClubs
        : extractThreadClubs(message, history);

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

    const shouldPreGround =
      !allTargetsAlreadyCalibrated &&
      (playerNamesForGrounding.length > 0 ||
        targetClubs.length > 0 ||
        asksLiveSeasonUpdate ||
        (route.needsSearch && Boolean(route.searchQueries?.length)));

    if (shouldPreGround) {
      onStageChange?.(
        unratedPlayers.length > 0
          ? `Scouting ${unratedPlayers.slice(0, 2).join(' & ')} (${currentSeason} data)...`
          : targetClubs.length > 0
            ? `Verifying ${targetClubs.join(' & ')} active squad & tactical setup...`
            : `Gathering ${currentSeason} grounding data...`,
      );
      try {
        const datePrefix = `[Date: ${month} ${year}]`;
        let queries: string[] = [];

        if (route.searchQueries && route.searchQueries.length > 0) {
          queries = route.searchQueries
            .slice(0, 2)
            .map((q) => (q.includes(String(year)) ? q : `${datePrefix} ${q}`));
          if (queries.length === 1 && targetClubs.length > 0) {
            queries.push(`${datePrefix} ${buildSquadTurnoverQuery(targetClubs.join(' '), year)}`);
          }
        } else if (unratedPlayers.length === 2) {
          queries = unratedPlayers.map(
            (player) =>
              `${datePrefix} ${player} — current club (${year}), confirmed head coach, age, position, ${currentSeason} season stats across competitions, tactical role, on-pitch strengths/weaknesses, and global positional peer standing`,
          );
        } else if (playerNamesForGrounding.length > 0) {
          const subjectLabel = playerNamesForGrounding.join(' vs ');
          queries = [
            `${datePrefix} ${subjectLabel}${targetClubs.length > 0 ? ` (${targetClubs.join(', ')})` : ''} — confirmed current clubs (${year}), confirmed head coaches, ages, positions, ${currentSeason} season stats, and specific tactical roles`,
          ];
        } else if (targetClubs.length > 0) {
          const clubLabel = targetClubs.join(' vs ');
          queries = [
            `${datePrefix} ${buildSquadTurnoverQuery(clubLabel, year)}`,
            `${datePrefix} ${clubLabel} — confirmed current head coach (${year}), starting XI by position, and specific player roles in build-up and out of possession (${message})`,
          ];
        }

        factualFoundation = await gatherSearchFoundation(
          queries,
          playerNamesForGrounding,
          targetClubs,
        );
      } catch (e) {
        console.warn('[ConversationalScout] Pre-grounding search failed:', e);
      }
    }

    const currentSig = getThreadSignature(history);
    if (factualFoundation) {
      if (currentSig && currentSig === lastThreadSignature && lastThreadGrounding && !factualFoundation.includes(lastThreadGrounding.slice(0, 120))) {
        factualFoundation = `${factualFoundation}\n\n[PRIOR TURN VERIFIED THREAD GROUNDING]\n${lastThreadGrounding.slice(0, 1400)}`;
      }
      lastThreadSignature = currentSig || `turn:${message.slice(0, 60)}`;
      lastThreadGrounding = factualFoundation;
    } else if (currentSig && currentSig === lastThreadSignature && lastThreadGrounding) {
      factualFoundation = lastThreadGrounding;
    }
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
    modeGuidance = `Answer the user's specific question about ${route.targetPlayers.join(', ') || 'the player'} directly with Chief-Scout granularity. Break down the exact on-pitch mechanics involved (receiving orientation, scanning frequency, deceleration/stride cadence, passing or defensive execution), explain how their 25-attribute spikes and limitations interact in that role or match state, and separate intrinsic class from tactical environment/system tax. Stay 100% consistent with any ratings in <locked_dossiers> and <calibrated_peer_ledger>. Match the length and structure of your answer to the user's question without forcing unnecessary debate boilerplate. Never output a JSON dossier object.`;
  } else if (analyticalMode === 'ranking_or_tierlist') {
    modeGuidance = `Build a rigorous, scout-grade positional ranking or tier breakdown anchored explicitly to the Section III Rating Tier Scale (\`93–95 World-Class Elite\`, \`90–92 World-Class\`, \`87–89 Borderline World-Class\`, \`84–86 High-End Starter\`). Honor every player rating already established in <calibrated_peer_ledger> and <locked_dossiers>. For each ranked player, cite their approximate Overall tier, signature attributes, and the exact on-pitch separator (e.g., half-turn press resistance, 40-yard recovery pace, final-third creation) that places them ahead of or behind their peers. Never output a JSON dossier object.`;
  } else if (analyticalMode === 'tactical_or_system') {
    modeGuidance = `Deliver a concrete, player-anchored tactical breakdown — NEVER write from an aerial, nameless theoretical template (do not write generic "team inverts a full-back into a 3-2 rest-defense to overload the half-space" boilerplate). Start from the verified active squad and starting XI in <factual_foundation>: name the exact players at each relevant position, explain how their individual profiles (dominant foot, ball-carrying vs. tempo-passing tendency, turning radius, recovery pace) dictate the team's actual build-up and out-of-possession geometry, and identify the specific matchup trade-offs those personnel choices create. Every paragraph must pass the Swap Test. Ground all current squad, starter, and head-coach references strictly in verified ${currentSeason} facts. Never output a JSON dossier object.`;
  } else if (analyticalMode === 'squad_or_recruitment') {
    modeGuidance = `Analyze the squad structure, lineup balance, or recruitment question like a Sporting Director and Chief Scout. Anchor your analysis in the verified active squad in <factual_foundation>: name the specific current starters and rotational options, diagnose specific functional profile bottlenecks (e.g., progressive ball-carrying volume, rest-defense recovery pace, left-footed build-up angles, box-pinning presence), evaluate how candidate profiles complement existing starters, and anchor player quality to the Section III tier scale and <calibrated_peer_ledger>. Never output a JSON dossier object.`;
  } else if (analyticalMode === 'debate_or_verdict') {
    modeGuidance = `Engage the football debate with dialectical depth: (1) steelman the strongest tactical and statistical case for each side, (2) decouple intrinsic player quality from system/environment tax (how role, surrounding talent, or league tempo inflates or suppresses box-score output), (3) evaluate through the 25-attribute framework, big-game knockout translation, and Section III tiers, and (4) finish with a clear, non-fence-sitting verdict. If the user is challenging a prior factual or tactical claim, verify the facts against <factual_foundation> first, correct any prior slip concisely in one sentence without theatrical self-flagellation, and deliver the grounded analysis. Stay 100% consistent with any ratings in <locked_dossiers> and <calibrated_peer_ledger>. Never output a JSON dossier object.`;
  } else {
    modeGuidance = `Respond conversationally in Markdown prose as the Chief Scout and Senior Tactical Columnist. Match the depth and structure of your answer to the user's question, and anchor every tactical claim to specific named players and their actual traits rather than generic tactical buzzwords. Use \`grep_saved_dossiers\` to search/filter the user's scouted player library, \`get_player_fact_sheet\` / \`get_football_squad\` / \`get_team_fixtures\` for deterministic API-Football records, or Google Search when you need live ${currentSeason} verification. Stay 100% consistent with any dossier numbers in <locked_dossiers> and <calibrated_peer_ledger> unless you explicitly state you are revising a figure. Never output a JSON dossier object.`;
  }

  const fullPrompt = `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
${ongoingThread}
${factualFoundation ? `<factual_foundation>\n${factualFoundation}\n</factual_foundation>` : ''}
${peerLedgerBlock ?? ''}
${effectiveLockedBlock}
${savedDossiersBlock}
<instructions>
1. ${modeGuidance}
2. Current-state facts (club, manager, squad membership, injuries, ${currentSeason} stats) must come from <factual_foundation>, tool calls (\`get_player_fact_sheet\`, \`get_football_squad\`, \`get_team_fixtures\`, Google Search), or existing dossiers — never stale training memory. Never name an unverified head coach.
3. CRITICAL MANAGER FIDELITY: Never cite former or sacked managers from pre-trained memory. ${formatKnownClubManagersForPrompt()} Ground tactical roles in verified current managers or describe intrinsic player mechanics without naming a manager.
4. ${CONTINUITY_REMINDER}
</instructions>
<task>${message}</task>`;

  const historyContents = buildHistoryContents(history, conversationDossiers);
  const dossiersPool = [...savedDossiers, ...conversationDossiers];

  // Adapt thinking depth to the complexity of the turn: 'medium' for high-complexity rankings,
  // tactical system breakdowns, and multi-player debates; 'low' (~0.8s TTFT) for standard Q&A and comparisons.
  const thinkingLevelOverride: ThinkingTier =
    route.reasoningComplexity === 'high' ? 'medium' : 'low';

  // When pre-grounding has already populated <factual_foundation> (or all compared players are locked),
  // restrict tools to instant (<1ms) in-memory dossier grep so the model does not pause the stream
  // to run a duplicate wave of web searches or API-Football HTTP requests.
  const hasCompleteContext =
    Boolean(factualFoundation) ||
    route.intent === 'archive_inventory' ||
    (route.targetPlayers.length > 0 && Boolean(effectiveLockedBlock));

  onStageChange?.('Writing scouting analysis...');

  const scoutManagerContext = {
    verifiedFacts: factualFoundation ? [factualFoundation] : [],
  };

  const rawReply = await generateProseTurn({
    message: fullPrompt,
    historyContents,
    systemInstruction,
    imageData,
    thinkingLevelOverride,
    toolMode: hasCompleteContext ? 'local_only' : 'full',
    dossiersPool,
    onStreamChunk: onStreamChunk
      ? (partial) => onStreamChunk(sanitizeScoutProse(partial, scoutManagerContext))
      : undefined,
  });

  return sanitizeScoutProse(rawReply, scoutManagerContext);
}
