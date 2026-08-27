import type { PlayerProfile } from '../types';
import {
  findUnverifiedManagerMentions,
  type ManagerVerificationContext,
} from '../packages/engine/src/gates/managerMentions.ts';

/** Verified facts block from the Futbolpedia extraction step (geminiService). */
export interface FutbolpediaVerifiedFacts {
  currentHeadCoach?: string | null;
  tacticalRole?: string | null;
  season2526Stats?: string | null;
  recentForm?: string | null;
  majorAwards?: string[];
  mobilitySummary?: string | null;
  currentClub?: string | null;
  injuryStatus?: string | null;
  conflictingManagerReports?: string[];
}

export function buildManagerVerificationContext(
  facts: FutbolpediaVerifiedFacts,
): ManagerVerificationContext {
  return {
    verifiedFacts: [
      facts.currentClub,
      facts.tacticalRole,
      facts.season2526Stats,
      facts.recentForm,
      facts.injuryStatus,
      facts.mobilitySummary,
      ...(facts.majorAwards ?? []),
    ].filter((v): v is string => Boolean(v)),
    currentHeadCoach: facts.currentHeadCoach ?? null,
  };
}

/** Scan profile prose fields for stale / unverified head-coach names. */
export function findProfileManagerGroundingIssues(
  profile: PlayerProfile,
  facts: FutbolpediaVerifiedFacts,
): string[] {
  const prose = [
    profile.shortBio,
    profile.latestUpdate,
    profile.playstyleAndRole?.playstyle?.description,
  ]
    .filter(Boolean)
    .join('\n');

  return findUnverifiedManagerMentions(prose, buildManagerVerificationContext(facts));
}
