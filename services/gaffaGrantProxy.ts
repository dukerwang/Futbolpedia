/**
 * Server-side forwarding for Connect with Gaffa. The browser holds a read-only grant token Gaffa
 * issued to the manager; these calls carry it to Gaffa unchanged. The shared read secret is never
 * attached here, so a browser can only read what its own grant allows: the manager's own clubs.
 */

export const DEFAULT_GAFFA_BASE_URL = 'https://www.gaffa.live';

export function gaffaBaseUrl(raw = process.env.GAFFA_BASE_URL): string {
  return (raw || DEFAULT_GAFFA_BASE_URL).replace(/\/$/, '');
}

export interface ProxyResult {
  status: number;
  body: unknown;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT_HEADER = /^Bearer\s+fpg_[A-Za-z0-9_-]{20,}$/;

/** The Authorization header to forward, only when it carries a grant token. */
export function grantAuthorization(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return value && GRANT_HEADER.test(value.trim()) ? value.trim() : null;
}

async function forward(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<ProxyResult> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => ({}));
    // Gaffa's 4xx answers (expired code, not connected, not your club) pass through; anything else
    // is Gaffa failing, which the browser sees as a bad gateway.
    const status = res.status >= 500 ? 502 : res.status;
    return { status, body };
  } catch (err) {
    console.error('[gaffa/grant]', err instanceof Error ? err.message : err);
    return { status: 502, body: { error: 'Could not reach Gaffa' } };
  }
}

/** Exchanges a one-time code from the approval page for a grant token. */
export function exchangeGaffaCode(
  input: { code?: unknown; code_verifier?: unknown; return_origin?: unknown },
  base = gaffaBaseUrl(),
  fetchImpl: FetchLike = fetch,
): Promise<ProxyResult> {
  if (typeof input.code !== 'string' || typeof input.code_verifier !== 'string' || typeof input.return_origin !== 'string') {
    return Promise.resolve({ status: 400, body: { error: 'Missing code, code_verifier or return_origin' } });
  }
  return forward(fetchImpl, `${base}/api/integrations/futbolpedia/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: input.code, code_verifier: input.code_verifier, return_origin: input.return_origin }),
  });
}

export function listGaffaClubs(
  authorization: string | null,
  base = gaffaBaseUrl(),
  fetchImpl: FetchLike = fetch,
): Promise<ProxyResult> {
  if (!authorization) return Promise.resolve({ status: 401, body: { error: 'Not connected' } });
  return forward(fetchImpl, `${base}/api/integrations/futbolpedia/clubs`, {
    headers: { Authorization: authorization },
  });
}

export function readGaffaClubContext(
  authorization: string | null,
  leagueId: unknown,
  teamId: unknown,
  base = gaffaBaseUrl(),
  fetchImpl: FetchLike = fetch,
): Promise<ProxyResult> {
  if (!authorization) return Promise.resolve({ status: 401, body: { error: 'Not connected' } });
  if (typeof leagueId !== 'string' || typeof teamId !== 'string' || !UUID.test(leagueId) || !UUID.test(teamId)) {
    return Promise.resolve({ status: 400, body: { error: 'Invalid league or club' } });
  }
  const qs = new URLSearchParams({ leagueId, teamId });
  return forward(fetchImpl, `${base}/api/integrations/futbolpedia/context?${qs.toString()}`, {
    headers: { Authorization: authorization },
  });
}

export function revokeGaffaGrant(
  authorization: string | null,
  base = gaffaBaseUrl(),
  fetchImpl: FetchLike = fetch,
): Promise<ProxyResult> {
  if (!authorization) return Promise.resolve({ status: 401, body: { error: 'Not connected' } });
  return forward(fetchImpl, `${base}/api/integrations/futbolpedia/grant`, {
    method: 'DELETE',
    headers: { Authorization: authorization },
  });
}
