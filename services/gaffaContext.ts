import type { GaffaClubContextResponse, GaffaContextBag } from '../types';
import { GAFFA_RULES_VERSION, emptyGaffaContextBag } from '../constants/gaffaRules';
import { fetchGaffaClubContext } from './gaffaConnect';

/** A conversation's attached Gaffa club. */
export interface GaffaClubRef {
  leagueId: string;
  clubId: string;
}

const BAG_CACHE_KEY = 'futbolpedia-gaffa-bags';
const FRESH_MS = 10 * 60 * 1000;
const STALE_MAX_MS = 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export const clubRefKey = (club: GaffaClubRef): string => `${club.leagueId}:${club.clubId}`;

export function mapResponseToBag(res: GaffaClubContextResponse): GaffaContextBag {
  return {
    gaffa_rules_version: GAFFA_RULES_VERSION,
    connected: true,
    stale: false,
    league_id: res.league_id,
    club_id: res.club_id,
    league_name: res.league_name,
    club_name: res.club_name,
    budget_eur_m: res.budget_eur_m,
    roster: res.roster,
    standings: res.standings,
    matchup: res.matchup,
    lineup: res.lineup,
    settings: res.settings,
    open_listings: res.open_listings ?? [],
    open_auctions: res.open_auctions ?? [],
    // Preserve missing vs [] — a legacy Gaffa payload has no unowned pool;
    // coercing that to [] would wrongly claim FA is empty.
    free_agents: Array.isArray(res.free_agents) ? res.free_agents : undefined,
    synced_at: res.synced_at,
  };
}

function readCache(): Record<string, GaffaContextBag> {
  try {
    const raw = localStorage.getItem(BAG_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, GaffaContextBag>): void {
  try {
    localStorage.setItem(BAG_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage full or unavailable: the bag is refetched next time */
  }
}

/** The last bag read for a club, however old. */
export function cachedClubBag(club: GaffaClubRef): GaffaContextBag | null {
  return readCache()[clubRefKey(club)] ?? null;
}

/** Forgets every cached bag (on disconnect, so another manager's squad never lingers). */
export function clearClubBags(): void {
  try {
    localStorage.removeItem(BAG_CACHE_KEY);
  } catch {
    /* unavailable */
  }
}

function ageMs(iso?: string): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Date.now() - t;
}

/**
 * A club's bag for a turn: the cached one while it's under ten minutes old (unless `force`),
 * otherwise a new read. When the read fails, a bag under a day old is used and marked
 * stale; older than that, the turn goes without the club.
 */
export async function loadClubBag(club: GaffaClubRef, opts: { force?: boolean } = {}): Promise<GaffaContextBag> {
  const cached = cachedClubBag(club);
  if (!opts.force && cached?.connected && ageMs(cached.synced_at) < FRESH_MS) {
    return { ...cached, stale: false };
  }
  try {
    const bag = mapResponseToBag(await fetchGaffaClubContext(club.leagueId, club.clubId));
    writeCache({ ...readCache(), [clubRefKey(club)]: bag });
    return bag;
  } catch (err) {
    console.warn('[Gaffa] club context read failed:', err);
    if (cached?.connected && ageMs(cached.synced_at) < STALE_MAX_MS) return { ...cached, stale: true };
    return emptyGaffaContextBag();
  }
}

/**
 * `#/gaffa/<leagueId>/<clubId>`, optionally with `?q=<question>`, from Gaffa's Open in Futbolpedia
 * and Ask links. The club is only attached if it's one of the connected manager's.
 */
export function parseGaffaClubHash(hash: string): (GaffaClubRef & { question?: string }) | null {
  const m = hash.match(/^#\/gaffa\/([^/?#]+)\/([^/?#]+)(?:\?(.*))?$/i);
  if (!m) return null;
  const leagueId = decodeURIComponent(m[1]).trim();
  const clubId = decodeURIComponent(m[2]).trim();
  if (!isUuid(leagueId) || !isUuid(clubId)) return null;
  const question = m[3] ? new URLSearchParams(m[3]).get('q')?.trim() : undefined;
  return { leagueId, clubId, ...(question ? { question: question.slice(0, 1000) } : {}) };
}
