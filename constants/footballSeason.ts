/**
 * Computes the active real-world football season and calendar year dynamically.
 * European football seasons run from July 1 of Year Y to June 30 of Year Y+1:
 * - July to December (months 7-12): season started this year (e.g. October 2026 -> 2026-27, start year 2026).
 * - January to June (months 1-6): season started previous year (e.g. May 2027 -> 2026-27, start year 2026).
 */
export function getRealWorldFootballSeason(date: Date = new Date()): {
  year: number;
  month: string;
  currentSeason: string;
  seasonStartYear: number;
} {
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth(); // 0 = Jan, 6 = Jul, 9 = Oct
  const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const seasonStartYear = monthIndex >= 6 ? year : year - 1;
  const currentSeason = `${seasonStartYear}-${String(seasonStartYear + 1).slice(-2)}`;
  return { year, month, currentSeason, seasonStartYear };
}
