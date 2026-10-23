import { Type } from '@google/genai';
import type { ChatMessage, PlayerProfile } from '../types';
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
import { gatherSearchFoundation } from './groundingService';
import type { TurnRoute } from './turnRouter';

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
          properties: {
            finishing: { type: Type.NUMBER, nullable: true },
            firstTouch: { type: Type.NUMBER, nullable: true },
            dribbling: { type: Type.NUMBER, nullable: true },
            vision: { type: Type.NUMBER, nullable: true },
            retention: { type: Type.NUMBER, nullable: true },
            combinationPlay: { type: Type.NUMBER, nullable: true },
            delivery: { type: Type.NUMBER, nullable: true },
            progressivePassing: { type: Type.NUMBER, nullable: true },
            footballIQ: { type: Type.NUMBER, nullable: true },
            offensivePositioning: { type: Type.NUMBER, nullable: true },
            defensivePositioning: { type: Type.NUMBER, nullable: true },
            tackling: { type: Type.NUMBER, nullable: true },
            interceptions: { type: Type.NUMBER, nullable: true },
            pressingIntensity: { type: Type.NUMBER, nullable: true },
            speed: { type: Type.NUMBER, nullable: true },
            acceleration: { type: Type.NUMBER, nullable: true },
            agility: { type: Type.NUMBER, nullable: true },
            strength: { type: Type.NUMBER, nullable: true },
            aerialProwess: { type: Type.NUMBER, nullable: true },
            stamina: { type: Type.NUMBER, nullable: true },
            composure: { type: Type.NUMBER, nullable: true },
            clutch: { type: Type.NUMBER, nullable: true },
            leadership: { type: Type.NUMBER, nullable: true },
            consistency: { type: Type.NUMBER, nullable: true },
            flair: { type: Type.NUMBER, nullable: true },
          },
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
      try {
        groundingNotes = await gatherSearchFoundation(
          [
            `[Date: ${month} ${year}] ${targetDossier.basicInfo.name}: ${message} (${currentSeason} stats and scouting verification)`,
          ],
          [targetDossier.basicInfo.name],
        );
      } catch {
        groundingNotes = '';
      }
    }

    try {
      const challengePrompt = `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
${ongoingThread}
<active_dossier>
${serializeProfileForHistory(targetDossier)}
</active_dossier>
${groundingNotes ? `<grounding_verification>\n${groundingNotes}\n</grounding_verification>` : ''}
<instructions>
The user is challenging, questioning, or requesting an adjustment to the dossier above.
1. Evaluate their point honestly against the Scout's Code, the recalibrated Section III Rating Tier Scale (where World-Class starts strictly at 90), and any grounding verification above.
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
      });

      if (result.revisedDossier && result.dossierPatch) {
        const updatedProfile = applyDossierPatch(targetDossier, result.dossierPatch);
        upsertCachedDossier(toPlayerSlug(updatedProfile.basicInfo.name), updatedProfile);
        onDossierUpdated?.(updatedProfile);
      }

      return result.replyProse;
    } catch (e) {
      console.warn('[ConversationalScout] Structured challenge path failed, falling back to prose:', e);
    }
  }

  // 2. Multi-Player Comparison & Agentic Tactical Chat Path
  let factualFoundation = '';
  let effectiveLockedBlock = lockedDossiersBlock;

  if (!imageData && route.intent === 'compare' && route.targetPlayers.length >= 2) {
    // Check which compared players are already in our calibrated ledger (0ms local + Supabase pool lookup)
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

    if (matchedDossiersBySlug.size > 0) {
      effectiveLockedBlock = buildLockedDossiersBlock([...matchedDossiersBySlug.values()]);
    }

    // Only fire external search/API-Football for players NOT already in our calibrated ledger
    if (unratedPlayers.length > 0) {
      try {
        const datePrefix = `[Date: ${month} ${year}]`;
        const subjectLabel = unratedPlayers.join(' vs ');
        const queries = [
          `${datePrefix} ${subjectLabel} — current clubs (${year}), ages, positions, ${currentSeason} season stats, and tactical roles`,
          `${datePrefix} ${subjectLabel} — scouting profile: technical, physical, and mental strengths, weaknesses, and peer standing`,
        ];

        factualFoundation = await gatherSearchFoundation(queries, unratedPlayers);
      } catch (e) {
        console.warn('[ConversationalScout] Comparison grounding search failed:', e);
      }
    }
  }

  const modeGuidance =
    route.intent === 'compare'
      ? `Write a detailed, scout-grade prose comparison covering every player named (${route.targetPlayers.join(', ') || 'all named players'}). Compare their footballing identity/mould, tactical fit, strengths and limitations, and relative tier on the Section III scale. For any player present in <locked_dossiers>, use their exact locked Overall, Potential, and 25 attributes. Never output a JSON dossier object.`
      : route.intent === 'archive_inventory'
        ? `Summarize or query the user's saved dossier archive clearly using <saved_dossier_archive> or the \`grep_saved_dossiers\` tool.`
        : `Respond conversationally in Markdown prose as the Senior Tactical Columnist. Use \`grep_saved_dossiers\` to search/filter the user's scouted player library, \`get_player_fact_sheet\` / \`get_football_squad\` / \`get_team_fixtures\` for deterministic API-Football records, or Google Search when you need live ${currentSeason} verification. Stay 100% consistent with any dossier numbers already generated in this conversation unless you explicitly state you are revising a figure. Never output a JSON dossier object.`;

  const fullPrompt = `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
${ongoingThread}
${factualFoundation ? `<factual_foundation>\n${factualFoundation}\n</factual_foundation>` : ''}
${peerLedgerBlock ?? ''}
${effectiveLockedBlock}
${savedDossiersBlock}
<instructions>
1. ${modeGuidance}
2. Current-state facts (club, manager, injuries, ${currentSeason} stats) must come from <factual_foundation>, tool calls (\`get_player_fact_sheet\`, \`get_football_squad\`, Google Search), or existing dossiers — never stale training memory.
3. ${CONTINUITY_REMINDER}
</instructions>
<task>${message}</task>`;

  const historyContents = buildHistoryContents(history, conversationDossiers);
  const dossiersPool = [...savedDossiers, ...conversationDossiers];

  return generateProseTurn({
    message: fullPrompt,
    historyContents,
    systemInstruction,
    imageData,
    enableTools: true,
    dossiersPool,
  });
}
