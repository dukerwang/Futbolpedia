import type { Attributes, GoalkeeperAttributes, PlayerProfile } from '../types';
import { normalizeClub, normalizePosition } from '../constants/ratingTiers';

export interface DossierPatch {
  targetPlayerName: string;
  position?: string;
  club?: string;
  overall?: number;
  potential?: number;
  attributes?: Partial<Attributes>;
  goalkeeperAttributes?: Partial<GoalkeeperAttributes>;
  strengths?: string[];
  weaknesses?: string[];
  archetype?: string;
  playstyleDescription?: string;
  bestRoles?: string[];
  latestUpdate?: string;
}

export function applyDossierPatch(base: PlayerProfile, patch: DossierPatch): PlayerProfile {
  const clamp = (v: number | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0
      ? Math.max(1, Math.min(99, Math.round(v)))
      : fallback;

  const updatedAttributes: Attributes = { ...base.attributes };
  if (patch.attributes) {
    for (const [k, val] of Object.entries(patch.attributes)) {
      if (k in updatedAttributes && typeof val === 'number' && Number.isFinite(val) && val > 0) {
        updatedAttributes[k as keyof Attributes] = clamp(val, updatedAttributes[k as keyof Attributes]);
      }
    }
  }

  let updatedGkAttributes = base.goalkeeperAttributes
    ? { ...base.goalkeeperAttributes }
    : undefined;
  if (patch.goalkeeperAttributes && updatedGkAttributes) {
    for (const [k, val] of Object.entries(patch.goalkeeperAttributes)) {
      if (k in updatedGkAttributes && typeof val === 'number' && Number.isFinite(val) && val > 0) {
        updatedGkAttributes[k as keyof GoalkeeperAttributes] = clamp(
          val,
          updatedGkAttributes[k as keyof GoalkeeperAttributes],
        );
      }
    }
  }

  return {
    ...base,
    basicInfo: {
      ...base.basicInfo,
      position: patch.position ? normalizePosition(patch.position) : base.basicInfo.position,
      club: patch.club ? normalizeClub(patch.club) : base.basicInfo.club,
    },
    ratings: {
      overall: clamp(patch.overall, base.ratings.overall),
      potential: clamp(patch.potential, base.ratings.potential),
    },
    attributes: updatedAttributes,
    ...(updatedGkAttributes ? { goalkeeperAttributes: updatedGkAttributes } : {}),
    strengths:
      Array.isArray(patch.strengths) && patch.strengths.length > 0
        ? patch.strengths
        : base.strengths,
    weaknesses:
      Array.isArray(patch.weaknesses) && patch.weaknesses.length > 0
        ? patch.weaknesses
        : base.weaknesses,
    playstyleAndRole: {
      playstyle: {
        archetype: patch.archetype || base.playstyleAndRole.playstyle.archetype,
        description:
          patch.playstyleDescription || base.playstyleAndRole.playstyle.description,
      },
      bestRoles:
        Array.isArray(patch.bestRoles) && patch.bestRoles.length > 0
          ? patch.bestRoles
          : base.playstyleAndRole.bestRoles,
    },
    latestUpdate: patch.latestUpdate || base.latestUpdate,
    createdAt: Date.now(),
  };
}
