import type { GaffaContextBag, GaffaRosterPlayer } from '../types';
import type { LiveAvailability, LiveAvailabilityResult } from './liveFootball';
import { getLive } from './researchTools';

/**
 * Real availability for a Gaffa squad. Gaffa's roster statuses (IR and the rest) are designations
 * the manager chose, not medical facts, so a turn about the squad reads each player's Fantasy
 * Premier League status too. One request covers the whole squad: the server answers it from its
 * cached FPL feed, with no model call.
 */

/** FPL status by roster player id. */
export type SquadAvailability = Map<string, LiveAvailability>;

/** The most squad entries one availability request carries. */
export const AVAILABILITY_MAX_PLAYERS = 40;

const AVAILABILITY_TIMEOUT_MS = 6_000;
const CACHE_MS = 5 * 60_000;

const cache = new Map<string, { at: number; value: Promise<SquadAvailability | null> }>();

/** "Full Name|Club" for the request; the separators can't be typed into either part. */
const entryOf = (p: GaffaRosterPlayer): string => {
  const clean = (s: string) => s.replace(/[|;]/g, ' ').trim();
  return `${clean(p.name || p.display_name || '')}|${clean(p.pl_team ?? '')}`;
};

export type AvailabilityFetcher = (roster: GaffaRosterPlayer[]) => Promise<SquadAvailability | null>;

/** The FPL status of each roster player FPL can place, or null when the lookup failed. */
export const fetchSquadAvailability: AvailabilityFetcher = (roster) => {
  const players = roster.filter((p) => (p.name || p.display_name)?.trim()).slice(0, AVAILABILITY_MAX_PLAYERS);
  if (players.length === 0) return Promise.resolve(null);
  const names = players.map(entryOf).join(';');
  const hit = cache.get(names);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = (async (): Promise<SquadAvailability | null> => {
    const res = await getLive<LiveAvailabilityResult>(`/api/live/availability?${new URLSearchParams({ names })}`, AVAILABILITY_TIMEOUT_MS);
    if ('error' in res || !res.data?.found) return null;
    const byName = new Map(res.data.players.map((a) => [a.name, a]));
    const map: SquadAvailability = new Map();
    for (const p of players) {
      const found = byName.get((p.name || p.display_name || '').replace(/[|;]/g, ' ').trim());
      if (found) map.set(p.player_id, found);
    }
    return map;
  })();
  cache.set(names, { at: Date.now(), value });
  // A failed read is not kept: the next turn asks again.
  void value.then((v) => {
    if (v === null) cache.delete(names);
  });
  return value;
};

/** Clears the in-memory cache (tests). */
export const resetAvailabilityCache = (): void => cache.clear();

/** Whether Gaffa lists a player as anything but active. */
export const isNonActive = (p: GaffaRosterPlayer): boolean => p.status !== 'active';

/** The squad players whose line the club block shows: Gaffa non-active, or FPL not available. */
export function playersWithAvailability(bag: GaffaContextBag, availability: SquadAvailability | null): Map<string, LiveAvailability> {
  const shown = new Map<string, LiveAvailability>();
  if (!availability) return shown;
  for (const p of bag.roster ?? []) {
    const fpl = availability.get(p.player_id);
    if (fpl && (isNonActive(p) || !fpl.available)) shown.set(p.player_id, fpl);
  }
  return shown;
}
