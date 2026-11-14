/**
 * How many Futbolpedia turns each Gaffa manager gets a day in Gaffa's own panel. Futbolpedia's
 * Gemini key pays for them, and the live app shares that budget, so past the limit the panel hands
 * the conversation over to Futbolpedia instead. Counted in the server's memory per UTC day; a
 * restart forgets the count, which errs toward the manager.
 */

export const GAFFA_CHAT_DAILY_TURNS = Number(process.env.GAFFA_CHAT_DAILY_TURNS) || 10;

export interface TurnBudget {
  /** Spends one turn. `ok` is false, with nothing spent, when the day's turns are used up. */
  take(key: string): { ok: boolean; left: number };
  /** Gives back a turn that failed before answering. */
  refund(key: string): void;
  left(key: string): number;
}

export function createTurnBudget(limit = GAFFA_CHAT_DAILY_TURNS, now: () => number = Date.now): TurnBudget {
  const used = new Map<string, { day: string; count: number }>();
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const countFor = (key: string) => {
    const row = used.get(key);
    return row && row.day === today() ? row.count : 0;
  };
  return {
    take(key) {
      const count = countFor(key);
      if (count >= limit) return { ok: false, left: 0 };
      used.set(key, { day: today(), count: count + 1 });
      return { ok: true, left: limit - count - 1 };
    },
    refund(key) {
      const count = countFor(key);
      if (count > 0) used.set(key, { day: today(), count: count - 1 });
    },
    left(key) {
      return Math.max(0, limit - countFor(key));
    },
  };
}
