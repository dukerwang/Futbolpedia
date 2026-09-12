import type { GaffaClubContextResponse, GaffaContextBag } from '../types';
import { GAFFA_RULES_VERSION, emptyGaffaContextBag } from '../constants/gaffaRules';

export const GAFFA_LINK_KEY = 'futbolpedia-gaffa-link';

const FRESH_MS = 10 * 60 * 1000;
const STALE_MAX_MS = 24 * 60 * 60 * 1000;

export interface GaffaLinkState {
  league_id: string;
  club_id: string;
  league_name?: string;
  club_name?: string;
  last_synced_at?: string;
  bag?: GaffaContextBag;
}

export function loadGaffaLink(): GaffaLinkState | null {
  try {
    const raw = localStorage.getItem(GAFFA_LINK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GaffaLinkState;
    if (!parsed?.league_id || !parsed?.club_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveGaffaLink(link: GaffaLinkState): void {
  localStorage.setItem(GAFFA_LINK_KEY, JSON.stringify(link));
}

export function clearGaffaLink(): void {
  localStorage.removeItem(GAFFA_LINK_KEY);
}

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
    synced_at: res.synced_at,
  };
}

export async function fetchGaffaContext(
  leagueId: string,
  teamId: string,
): Promise<GaffaClubContextResponse> {
  const qs = new URLSearchParams({ leagueId, teamId });
  const res = await fetch(`/api/gaffa/context?${qs.toString()}`);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Sync failed (${res.status})`);
  }
  return res.json();
}

function ageMs(iso?: string): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Date.now() - t;
}

/**
 * Resolve bag for a Gaffa send: refresh if older than 10m; on failure use
 * cache if &lt; 24h (stale); else disconnected.
 */
export async function resolveContextBagForSend(
  link: GaffaLinkState | null,
): Promise<GaffaContextBag> {
  if (!link) return emptyGaffaContextBag();

  const cached = link.bag;
  const syncedAt = cached?.synced_at ?? link.last_synced_at;
  if (cached?.connected && ageMs(syncedAt) < FRESH_MS) {
    return { ...cached, stale: false };
  }

  try {
    const res = await fetchGaffaContext(link.league_id, link.club_id);
    const bag = mapResponseToBag(res);
    const next: GaffaLinkState = {
      league_id: bag.league_id!,
      club_id: bag.club_id!,
      league_name: bag.league_name,
      club_name: bag.club_name,
      last_synced_at: bag.synced_at,
      bag,
    };
    saveGaffaLink(next);
    return bag;
  } catch (err) {
    console.warn('[Gaffa] context refresh failed:', err);
    if (cached?.connected && ageMs(syncedAt) < STALE_MAX_MS) {
      return { ...cached, stale: true };
    }
    return emptyGaffaContextBag();
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const GAFFA_PENDING_CONNECT_KEY = 'futbolpedia-gaffa-pending-connect';

/** Parse `#/gaffa/<leagueId>/<clubId>` from Futbolpedia's hash router. */
export function parseGaffaConnectHash(
  hash: string,
): { leagueId: string; clubId: string } | null {
  const m = hash.match(/^#\/gaffa\/([^/]+)\/([^/?#]+)/i);
  if (!m) return null;
  const leagueId = m[1].trim();
  const clubId = m[2].trim();
  if (!UUID.test(leagueId) || !UUID.test(clubId)) return null;
  return { leagueId, clubId };
}

/**
 * Ask Futbolpedia lands on `#/gaffa/...`. React Strict Mode remounts and the
 * first effect used to `replaceState` the hash away, so the remount opened
 * default chat. Stash ids in sessionStorage and read them back if the hash
 * is already gone. Do not clear the hash here.
 */
export function consumeGaffaConnectIds(): { leagueId: string; clubId: string } | null {
  if (typeof window === 'undefined') return null;
  const fromHash = parseGaffaConnectHash(window.location.hash);
  if (fromHash) {
    try {
      sessionStorage.setItem(GAFFA_PENDING_CONNECT_KEY, JSON.stringify(fromHash));
    } catch {
      /* private mode / quota */
    }
    return fromHash;
  }
  try {
    const raw = sessionStorage.getItem(GAFFA_PENDING_CONNECT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { leagueId?: string; clubId?: string };
    if (
      typeof parsed?.leagueId === 'string' &&
      typeof parsed?.clubId === 'string' &&
      UUID.test(parsed.leagueId) &&
      UUID.test(parsed.clubId)
    ) {
      return { leagueId: parsed.leagueId, clubId: parsed.clubId };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function clearGaffaConnectPending(): void {
  try {
    sessionStorage.removeItem(GAFFA_PENDING_CONNECT_KEY);
  } catch {
    /* ignore */
  }
}
