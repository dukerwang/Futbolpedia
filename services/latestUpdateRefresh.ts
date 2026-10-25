import { Type } from '@google/genai';
import type { PlayerProfile } from '../types';
import { generateStructured, getCurrentSeasonInfo, runGroundedSearch } from './aiClient';
import { getClubManager } from './clubManagers';
import {
  getCachedDossier,
  getCardKey,
  getLatestUpdateDate,
  needsLatestUpdateRefresh,
  publishLatestUpdate,
  toDossierCardSlug,
  todayIso,
} from './dossierStore';
import { fetchApiFootballPlayer, formatApiFootballFactSheetBlock } from './groundingService';
import { attachVerifiedManager } from './profileManagerGrounding';
import { scrubUnverifiedManagerText } from '../packages/engine/src/gates/managerMentions.ts';

/**
 * A shared current card holds its ratings for a month (CARD_REFRESH_DAYS), but its Latest
 * Update is rewritten weekly from fresh facts. Only that line changes; the ratings, attributes
 * and the rest of the card stay as rated.
 */

const LATEST_UPDATE_SCHEMA = {
  type: Type.OBJECT,
  properties: { latestUpdate: { type: Type.STRING } },
  required: ['latestUpdate'],
};

async function rewriteLatestUpdate(card: PlayerProfile): Promise<PlayerProfile> {
  const { year, month, currentSeason } = getCurrentSeasonInfo();
  const name = card.basicInfo.name;
  const [search, apiPlayer, manager] = await Promise.all([
    runGroundedSearch(
      `${name} (${card.basicInfo.club}) latest news as of ${month} ${year}: recent match appearances and performances, ${currentSeason} season stats, injury or fitness status, transfer or loan news`,
    ),
    fetchApiFootballPlayer(name).catch(() => null),
    getClubManager(card.basicInfo.club).catch(() => null),
  ]);

  const { latestUpdate } = await generateStructured<{ latestUpdate: string }>({
    task: 'grounding',
    schema: LATEST_UPDATE_SCHEMA,
    prompt: `<context>System Date: ${month} ${year} (${todayIso()}). Season: ${currentSeason}</context>
<factual_foundation>
${search.formattedBlock}
${formatApiFootballFactSheetBlock(apiPlayer)}
</factual_foundation>
<previous_latest_update as_of="${getLatestUpdateDate(card) ?? 'unknown'}">
${card.latestUpdate}
</previous_latest_update>
Rewrite the Latest Update for ${name}'s scouting card (${card.basicInfo.position}, ${card.basicInfo.club}): 2–4 sentences on where the player stands now, covering recent appearances and output, fitness or injury status, and any transfer or loan news.
- Use only facts in <factual_foundation>. Never cite a statistic without its verified number, and never invent a match event.
- Never name a head coach or manager.
- Don't rate the player or restate the scouting profile; this line is news, not evaluation.
- If the foundation has nothing newer than the previous update, keep its facts and say so plainly.`,
  });

  const text = latestUpdate?.trim();
  if (!text) return card;
  const updated = { ...card, latestUpdate: text, latestUpdateAsOf: todayIso() };
  if (manager?.coach) return attachVerifiedManager(updated, manager);
  // No confirmed coach today (often a failed search): keep the card's verified manager and
  // hold the new line to it.
  return {
    ...updated,
    latestUpdate: scrubUnverifiedManagerText(text, {
      verifiedFacts: [],
      currentHeadCoach: card.clubManager?.name ?? null,
      currentClub: card.basicInfo.club,
      strictCurrentCoach: true,
    }),
  };
}

const inFlight = new Map<string, Promise<PlayerProfile>>();

/**
 * The card to serve, with its Latest Update brought up to date when it's a week old. Another
 * user may already have refreshed the shared card, so that copy is checked first. Any failure
 * serves the card as it was.
 */
export async function withFreshLatestUpdate(
  card: PlayerProfile,
  onStageChange?: (stage: string) => void,
): Promise<PlayerProfile> {
  if (!needsLatestUpdateRefresh(card)) return card;
  const key = getCardKey(card);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const job = (async () => {
    const shared = await getCachedDossier(toDossierCardSlug(card.basicInfo.name)).catch(() => null);
    if (shared && getCardKey(shared) === key && !needsLatestUpdateRefresh(shared)) return shared;

    onStageChange?.(`Refreshing ${card.basicInfo.name}'s latest update...`);
    try {
      const refreshed = await rewriteLatestUpdate(shared && getCardKey(shared) === key ? shared : card);
      if (refreshed.latestUpdateAsOf) void publishLatestUpdate(refreshed);
      return refreshed;
    } catch (e) {
      console.warn('[LatestUpdate] Refresh failed:', e);
      return card;
    }
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}
