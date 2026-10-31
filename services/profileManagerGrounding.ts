import type { PlayerProfile } from '../types';
import type { ClubManagerRecord } from './clubManagers';
import {
  findUnverifiedManagerMentions,
  scrubUnverifiedManagerText,
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
  supplementalCorpus?: string[];
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
    supplementalCorpus: facts.supplementalCorpus,
    currentHeadCoach: facts.currentHeadCoach ?? null,
    currentClub: facts.currentClub ?? null,
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

const scrubProfileProse = (profile: PlayerProfile, ctx: ManagerVerificationContext): PlayerProfile => ({
  ...profile,
  shortBio: scrubUnverifiedManagerText(profile.shortBio, ctx),
  latestUpdate: scrubUnverifiedManagerText(profile.latestUpdate, ctx),
  playstyleAndRole: {
    ...profile.playstyleAndRole,
    playstyle: {
      ...profile.playstyleAndRole.playstyle,
      description: scrubUnverifiedManagerText(profile.playstyleAndRole.playstyle.description, ctx),
    },
  },
});

/** Deterministically scrub any unverified manager mentions from profile prose in 0ms. */
export function scrubProfileManagerMentions(
  profile: PlayerProfile,
  facts: FutbolpediaVerifiedFacts,
): PlayerProfile {
  return scrubProfileProse(profile, buildManagerVerificationContext(facts));
}

/**
 * Attaches the live manager lookup's answer to a current card and makes the prose agree with it:
 * only the verified coach may be named, and when the lookup confirmed nobody, no coach is named
 * at all. The model never decides who the manager is.
 */
export function attachVerifiedManager(
  profile: PlayerProfile,
  manager: ClubManagerRecord | null,
): PlayerProfile {
  const coach = manager?.coach ?? null;
  const scrubbed = scrubProfileProse(profile, {
    verifiedFacts: [],
    currentHeadCoach: coach,
    currentClub: manager?.club ?? profile.basicInfo.club,
    strictCurrentCoach: true,
    clubManagers:
      manager && coach ? [{ club: manager.club, coach, previousCoach: manager.previousCoach }] : [],
  });
  if (!manager || !coach) {
    const { clubManager: _stale, ...rest } = scrubbed;
    return rest;
  }
  return {
    ...scrubbed,
    clubManager: { name: coach, verifiedOn: manager.verifiedOn, sourceUrl: manager.sourceUrl },
  };
}
