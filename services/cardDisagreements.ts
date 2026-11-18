import type { CardSwap } from './debateConsistency';

/**
 * Card order disagreements: where a model's order of players was turned round by the cards. The
 * debate check and `show_ranking` still put carded players in card order, so answers stay
 * consistent; each pair they turn round is reported here, counted on the server, and read by the
 * daily card review as a signal that the two cards may be out of place (services/cardReview.ts).
 *
 * Only card keys and the path cross to the server, never a name, reason or anything a user wrote.
 * The server resolves the keys against the shared cards when the day's pass reads the tally, so a
 * report naming a card that doesn't exist, or a pair the cards don't order that way, never reaches
 * the planner. Design: docs/superpowers/specs/2026-11-18-card-order-disagreement-design.md.
 */

/**
 * Where the cards turned the order round: the debate check, a drawn ranking, or a deep loop's
 * commitment (`commit_verdict`) that put a pair the other way, whether it then argued the cards'
 * order or said why it departed.
 */
export type DisagreementPath = 'debate' | 'ranking' | 'deep';
export const DISAGREEMENT_PATHS: readonly DisagreementPath[] = ['debate', 'ranking', 'deep'];

/** One pair: the model put `lower` above `higher`; the cards put `higher` above `lower`. Card keys. */
export interface CardDisagreement {
  higher: string;
  lower: string;
  via: DisagreementPath;
}

export const DISAGREEMENT_ROUTE = '/api/cards/disagreements';
/** Most pairs one report carries; the rest are dropped. */
export const MAX_PAIRS_PER_REPORT = 8;
/** Most pairs a source has counted in a day. */
export const MAX_PAIRS_PER_SOURCE_DAY = 12;
/** Days of reports the tally keeps, as the scout's day demand tallies do. */
export const DISAGREEMENT_DAYS = 7;
/** Most pairs the tally holds; the oldest goes first. */
export const DISAGREEMENT_TALLY_CAP = 2_000;

/** The shape `getCardKey` produces: base slug, edition, evaluation date or window. */
const CARD_KEY_RE = /^[a-z0-9-]{1,80}:[a-z_]{1,24}:[A-Za-z0-9._:/–-]{1,40}$/;
export const isCardKey = (v: unknown): v is string => typeof v === 'string' && CARD_KEY_RE.test(v);

export const pairKey = (p: { higher: string; lower: string }): string => `${p.higher}>${p.lower}`;

/** A check's swaps as pairs of card keys; a swap missing a key, or of one card, is left out. */
export function disagreementsFromSwaps(swaps: readonly CardSwap[], via: DisagreementPath): CardDisagreement[] {
  const out = new Map<string, CardDisagreement>();
  for (const s of swaps) {
    const [higher, lower] = [s.higher.cardKey, s.lower.cardKey];
    if (!isCardKey(higher) || !isCardKey(lower) || higher === lower) continue;
    out.set(pairKey({ higher, lower }), { higher, lower, via });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------
// The sink: where a turn's pairs go

export type DisagreementSink = (pairs: CardDisagreement[]) => void;

/**
 * The browser's sink: posts each pair once per page load, fire-and-forget. `fetchImpl` is for
 * tests; the default reads the global fetch when called.
 */
export function createBrowserSink(fetchImpl?: typeof fetch): DisagreementSink {
  const posted = new Set<string>();
  return (pairs) => {
    const fresh = pairs.filter((p) => !posted.has(pairKey(p))).slice(0, MAX_PAIRS_PER_REPORT);
    if (!fresh.length) return;
    fresh.forEach((p) => posted.add(pairKey(p)));
    const send = fetchImpl ?? globalThis.fetch;
    void Promise.resolve()
      .then(() =>
        send(DISAGREEMENT_ROUTE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairs: fresh }),
          keepalive: true,
        }),
      )
      .catch(() => {});
  };
}

let sink: DisagreementSink | null | undefined;
const defaultSink = (): DisagreementSink | null =>
  typeof window !== 'undefined' && typeof globalThis.fetch === 'function' ? createBrowserSink() : null;

/**
 * Sets where pairs go: the server records into its tally, tests collect. `null` drops them;
 * `undefined` restores the default (the browser posts; anywhere else drops).
 */
export function setDisagreementSink(next: DisagreementSink | null | undefined): void {
  sink = next;
}

/** Hands a turn's pairs to the sink. Never throws: a report must never cost an answer. */
export function reportCardDisagreements(pairs: CardDisagreement[]): void {
  if (!pairs.length) return;
  if (sink === undefined) sink = defaultSink();
  try {
    sink?.(pairs);
  } catch {
    // Recording is best effort.
  }
}

// ---------------------------------------------------------------------------------------------
// The server: the route's body and the tally

/** A report's body as pairs: at most `MAX_PAIRS_PER_REPORT`, each two distinct card keys and a known path. */
export function readDisagreementReport(body: unknown): CardDisagreement[] {
  const given = (body as { pairs?: unknown })?.pairs;
  if (!Array.isArray(given)) return [];
  const out = new Map<string, CardDisagreement>();
  for (const raw of given.slice(0, MAX_PAIRS_PER_REPORT)) {
    const { higher, lower, via } = (raw ?? {}) as Record<string, unknown>;
    if (!isCardKey(higher) || !isCardKey(lower) || higher === lower) continue;
    if (!DISAGREEMENT_PATHS.includes(via as DisagreementPath)) continue;
    out.set(pairKey({ higher, lower }), { higher, lower, via: via as DisagreementPath });
  }
  return [...out.values()];
}

/** A pair as the tally holds it over the window. `reports` counts each source once a day. */
export interface DisagreementHit {
  higher: string;
  lower: string;
  reports: number;
  days: number;
  firstDay: string;
  lastDay: string;
  /** Reports by path; `deep` appears only once a deep answer has reported the pair. */
  via: Record<Exclude<DisagreementPath, 'deep'>, number> & { deep?: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * In-memory counts of disagreement pairs over the last week. A pair counts once per source per day,
 * a source counts at most `MAX_PAIRS_PER_SOURCE_DAY` pairs a day, and the tally holds at most
 * `DISAGREEMENT_TALLY_CAP` pairs. A source is whatever the caller passes (the server passes a
 * salted hash of the request's address); a restart loses the counts.
 */
export function createDisagreementTally(now: () => number = Date.now) {
  type Entry = { higher: string; lower: string; days: Map<string, Map<string, DisagreementPath>> };
  const pairs = new Map<string, Entry>();
  const perSource = new Map<string, Map<string, number>>();
  const cutoff = () => dayOf(now() - (DISAGREEMENT_DAYS - 1) * DAY_MS);
  const prune = (from: string) => {
    for (const d of perSource.keys()) if (d < from) perSource.delete(d);
  };

  return {
    /** Counts a pair from a source; false when it was already counted today or the source is at its cap. */
    record(pair: CardDisagreement, source: string): boolean {
      if (!isCardKey(pair.higher) || !isCardKey(pair.lower) || pair.higher === pair.lower || !source) return false;
      const day = dayOf(now());
      const from = cutoff();
      prune(from);
      const key = pairKey(pair);
      const existing = pairs.get(key);
      if (existing?.days.get(day)?.has(source)) return false;
      const today = perSource.get(day) ?? new Map<string, number>();
      if ((today.get(source) ?? 0) >= MAX_PAIRS_PER_SOURCE_DAY) return false;
      let entry = existing;
      if (!entry) {
        if (pairs.size >= DISAGREEMENT_TALLY_CAP) pairs.delete(pairs.keys().next().value as string);
        entry = { higher: pair.higher, lower: pair.lower, days: new Map() };
        pairs.set(key, entry);
      }
      const sources = entry.days.get(day) ?? new Map<string, DisagreementPath>();
      sources.set(source, pair.via);
      entry.days.set(day, sources);
      for (const d of entry.days.keys()) if (d < from) entry.days.delete(d);
      today.set(source, (today.get(source) ?? 0) + 1);
      perSource.set(day, today);
      return true;
    },
    /** The pairs reported in the window, most reported first. */
    list(): DisagreementHit[] {
      const from = cutoff();
      const out: DisagreementHit[] = [];
      for (const e of pairs.values()) {
        const days = [...e.days.entries()].filter(([d]) => d >= from).sort(([a], [b]) => a.localeCompare(b));
        if (!days.length) continue;
        const via: DisagreementHit['via'] = { debate: 0, ranking: 0 };
        let reports = 0;
        for (const [, sources] of days) {
          for (const path of sources.values()) {
            via[path] = (via[path] ?? 0) + 1;
            reports += 1;
          }
        }
        out.push({ higher: e.higher, lower: e.lower, reports, days: days.length, firstDay: days[0][0], lastDay: days[days.length - 1][0], via });
      }
      return out.sort((a, b) => b.reports - a.reports || b.lastDay.localeCompare(a.lastDay));
    },
  };
}

export type DisagreementTally = ReturnType<typeof createDisagreementTally>;
