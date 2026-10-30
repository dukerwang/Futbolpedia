/**
 * Career windows: the span of seasons a historical card evaluates.
 *
 * A "prime" card and an "era" card are both windows of 2–4 consecutive seasons. The prime is the
 * window that was the player's career best. An era is any other window, usually one the user
 * asked for ("Gerrard 2012–15"). Seasons are identified by the year they start, so 2008 means
 * 2008-09.
 */

export const MIN_WINDOW_SEASONS = 2;
export const MAX_WINDOW_SEASONS = 4;

/** Inclusive range of seasons, each given as its start year (2008 = 2008-09). */
export interface CareerWindow {
  start: number;
  end: number;
}

export type HistoricalKind = 'prime' | 'era';

const MIN_YEAR = 1900;

export const seasonLabel = (startYear: number): string =>
  `${startYear}-${String(startYear + 1).slice(-2)}`;

export const windowSeasonCount = (w: CareerWindow): number => w.end - w.start + 1;

/** "2005-06 to 2008-09", or "2008-09" for a one-season window. */
export const formatWindow = (w: CareerWindow): string =>
  w.start === w.end ? seasonLabel(w.start) : `${seasonLabel(w.start)} to ${seasonLabel(w.end)}`;

const isYear = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= MIN_YEAR && n < 2200;

/** Builds a window from two loosely typed values, or null when they aren't usable years. */
export const toWindow = (start: unknown, end: unknown): CareerWindow | null => {
  if (!isYear(start) || !isYear(end) || end < start) return null;
  return { start, end };
};

/** True when the window spans 2–4 seasons. */
export const isValidWindowSpan = (w: CareerWindow): boolean => {
  const n = windowSeasonCount(w);
  return n >= MIN_WINDOW_SEASONS && n <= MAX_WINDOW_SEASONS;
};

/**
 * Forces a window into 2–4 seasons. A window that is too long is trimmed around its middle. A
 * single season grows by the season after it, or the season before it when `latestStart` (the
 * current season) would be passed.
 */
export const coerceWindowSpan = (w: CareerWindow, latestStart: number): CareerWindow => {
  let { start, end } = w;
  if (end - start + 1 > MAX_WINDOW_SEASONS) {
    const mid = Math.round((start + end) / 2);
    start = mid - Math.floor((MAX_WINDOW_SEASONS - 1) / 2);
    end = start + MAX_WINDOW_SEASONS - 1;
  }
  if (end - start + 1 < MIN_WINDOW_SEASONS) {
    if (end + 1 <= latestStart) end += 1;
    else start -= 1;
  }
  return { start, end };
};

const SEASON_TOKEN =
  /\b((?:19|20)\d{2})(?:\s*(?:[-–—/]|\s(?:to|until|through|and)\s)\s*((?:19|20)?\d{2}))?\b/gi;

/**
 * Pulls the season span out of free text: "2008-09", "2005-06 to 2008-09", "2013-16",
 * "between 2012 and 2016". A bare year ("2009") reads as the two seasons around it. Several
 * mentions merge into one span. Returns null when the text names no years.
 */
export const parseSeasonSpan = (text: string): CareerWindow | null => {
  if (!text) return null;
  let start = Infinity;
  let end = -Infinity;

  for (const m of text.matchAll(SEASON_TOKEN)) {
    const y1 = Number(m[1]);
    let s: number;
    let e: number;

    if (!m[2]) {
      s = y1 - 1;
      e = y1;
    } else {
      let y2 = Number(m[2]);
      if (m[2].length === 2) {
        y2 += Math.floor(y1 / 100) * 100;
        if (y2 < y1) y2 += 100;
      }
      if (y2 <= y1) continue;
      s = y1;
      // "2008-09" is one season; "2013-16" is the seasons 2013-14 through 2015-16.
      e = y2 === y1 + 1 ? y1 : y2 - 1;
    }
    start = Math.min(start, s);
    end = Math.max(end, e);
  }

  return toWindow(start, end);
};

const ERA_CUE = /\b(era|decade|(?:19|20)\d0s|[5-9]0s)\b|'[5-9]0s\b/i;
const PRIME_CUE = /\b(prime|peak|zenith)\b/i;

/** True when the message points at a stretch of a career rather than the player right now. */
export const hasHistoricalWindowCue = (message: string): boolean =>
  PRIME_CUE.test(message) ||
  ERA_CUE.test(message) ||
  /\b(all[- ]time|historical)\b/i.test(message) ||
  parseSeasonSpan(message) !== null;

/**
 * Works out which historical card a message asks for. "Prime X" is the prime window. A named
 * span, era or decade is an era window, which the model sizes to 2–4 seasons.
 */
export const classifyHistoricalRequest = (
  message: string,
): { kind: HistoricalKind; window: CareerWindow | null } => {
  const window = parseSeasonSpan(message);
  if (PRIME_CUE.test(message)) return { kind: 'prime', window };
  if (window || ERA_CUE.test(message)) return { kind: 'era', window };
  return { kind: 'prime', window: null };
};

/** True when `outer` contains every season of `inner`. */
export const windowContains = (outer: CareerWindow, inner: CareerWindow): boolean =>
  outer.start <= inner.start && outer.end >= inner.end;

/** Start year of the decade a season belongs to (2009-10 belongs to the 2000s). */
export const decadeOf = (startYear: number): number => Math.floor(startYear / 10) * 10;

/** Every decade that holds at least one season of the window, oldest first. */
export const decadesOfWindow = (w: CareerWindow): number[] => {
  const out: number[] = [];
  for (let d = decadeOf(w.start); d <= decadeOf(w.end); d += 10) out.push(d);
  return out;
};

export const decadeLabel = (decade: number): string => `${decade}s`;
