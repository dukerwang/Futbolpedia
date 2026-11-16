import { nameTokens, samePlayerName, type LiveStarter } from './liveFootball';

/**
 * Scoring rules for XI predictions, pure so the record can be checked without a feed or a model.
 * A prediction is eleven slots, each an ESPN formation slot code with the player expected there.
 * Against the lineup ESPN published for the match it scores:
 *   names right    how many of the eleven slots hold a player who started, in any slot; a slot's
 *                  rotation alternative counts as a name hit when the first choice didn't start
 *   slots right    how many slots hold the player who started in that same slot code; a rotation
 *                  alternative never counts here, since a prediction names one player per slot
 *   formation      whether the predicted shape is the one played (null when either is unknown)
 * A slot with no name never scores. A started player counts once, so a name can't be a hit twice.
 */

export interface PredictedSlot {
  /** ESPN's formation slot (GK, LB, CD-L, DM, AM-R, F, …), or a broad position on a season-starts XI. */
  role: string;
  /** Null when no available player has started there. */
  name: string | null;
  /** Another player level with the first choice, from the code XI's even splits. */
  rotation?: string;
  /** Why the adjusted XI differs from the code XI in this slot. */
  reason?: string;
}

export interface ActualXi {
  starters: LiveStarter[];
}

export interface XiScore {
  namesRight: number;
  slotsRight: number;
  formationRight: boolean | null;
}

const sameRole = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();
const sameFormation = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

/** The started player each name means, one player per name: exact spellings first, then looser ones. */
function claim(names: (string | null)[], starters: LiveStarter[], claimed: Set<number>): (number | null)[] {
  const result: (number | null)[] = names.map(() => null);
  const exact = (a: string, b: string) => {
    const ta = nameTokens(a);
    const tb = nameTokens(b);
    return ta.length > 0 && ta.length === tb.length && ta.every((t, i) => t === tb[i]);
  };
  for (const matches of [exact, samePlayerName]) {
    names.forEach((name, i) => {
      if (!name || result[i] !== null) return;
      const at = starters.findIndex((s, k) => !claimed.has(k) && matches(name, s.name));
      if (at >= 0) {
        claimed.add(at);
        result[i] = at;
      }
    });
  }
  return result;
}

export function scoreXi(
  slots: PredictedSlot[],
  predictedFormation: string | null,
  actual: ActualXi & { formation: string | null },
): XiScore {
  const claimed = new Set<number>();
  const first = claim(slots.map((s) => s.name), actual.starters, claimed);
  // A rotation alternative stands in only where the first choice missed, and only for a player no
  // other slot has already claimed.
  const second = claim(slots.map((s, i) => (s.name !== null && first[i] === null ? s.rotation ?? null : null)), actual.starters, claimed);
  let slotsRight = 0;
  first.forEach((at, i) => {
    if (at !== null && sameRole(slots[i].role, actual.starters[at].role)) slotsRight++;
  });
  return {
    namesRight: first.filter((a) => a !== null).length + second.filter((a) => a !== null).length,
    slotsRight,
    formationRight: predictedFormation && actual.formation ? sameFormation(predictedFormation, actual.formation) : null,
  };
}

/** A prediction made at or after kickoff isn't a prediction: it's scored but kept out of the record. */
export const isLatePrediction = (predictedAtMs: number, kickoffMs: number): boolean => !(predictedAtMs < kickoffMs);

export interface KindTotals {
  /** Matches scored for this kind of prediction. */
  matches: number;
  meanNamesRight: number | null;
  meanSlotsRight: number | null;
  /** Share of matches with a known formation on both sides that the formation was right. */
  formationHitRate: number | null;
}

const mean = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

export function totalsOf(scores: XiScore[]): KindTotals {
  const formations = scores.filter((s) => s.formationRight !== null);
  return {
    matches: scores.length,
    meanNamesRight: mean(scores.map((s) => s.namesRight)),
    meanSlotsRight: mean(scores.map((s) => s.slotsRight)),
    formationHitRate: formations.length ? mean([formations.filter((s) => s.formationRight).length / formations.length]) : null,
  };
}
