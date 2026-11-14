import type { GaffaClubContextResponse, GaffaUserClub } from '../types';

/**
 * Connect with Gaffa, the browser side. Gaffa's approval page (/connect/futbolpedia) gives a
 * signed-in manager's consent as a one-time code; this exchanges it, with a PKCE verifier, for a
 * read-only grant token kept in localStorage. Every read goes through Futbolpedia's server, which
 * forwards the token (`services/gaffaGrantProxy.ts`).
 */

const GRANT_KEY = 'futbolpedia-gaffa-grant';
const PENDING_KEY = 'futbolpedia-gaffa-pending';
const GRANT_EVENT = 'futbolpedia-gaffa-grant';
/** A connect attempt older than this is abandoned. Gaffa's codes last five minutes. */
const PENDING_TTL_MS = 30 * 60 * 1000;

export class GaffaNotConnectedError extends Error {
  constructor() {
    super('Connect Gaffa to read your clubs.');
    this.name = 'GaffaNotConnectedError';
  }
}

interface PendingConnect {
  state: string;
  verifier: string;
  createdAt: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadGrant(): string | null {
  return storage()?.getItem(GRANT_KEY) ?? null;
}

function setGrant(token: string | null): void {
  const s = storage();
  if (!s) return;
  if (token) s.setItem(GRANT_KEY, token);
  else s.removeItem(GRANT_KEY);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(GRANT_EVENT));
}

/** Calls back when the grant appears or goes, in this tab or another (a returning popup). */
export function onGrantChange(callback: (token: string | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const local = () => callback(loadGrant());
  const cross = (e: StorageEvent) => {
    if (e.key === GRANT_KEY) callback(loadGrant());
  };
  window.addEventListener(GRANT_EVENT, local);
  window.addEventListener('storage', cross);
  return () => {
    window.removeEventListener(GRANT_EVENT, local);
    window.removeEventListener('storage', cross);
  };
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function readPending(now = Date.now()): PendingConnect | null {
  try {
    const raw = storage()?.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingConnect;
    if (!p?.state || !p?.verifier || now - p.createdAt > PENDING_TTL_MS) return null;
    return p;
  } catch {
    return null;
  }
}

let baseUrlRequest: Promise<string> | null = null;

/** Gaffa's origin, from the server's GAFFA_BASE_URL (local Gaffa in development, gaffa.live live). */
export function gaffaBaseUrl(): Promise<string> {
  baseUrlRequest ??= fetch('/api/gaffa/config')
    .then((r) => r.json())
    .then((d) => String(d?.baseUrl || 'https://www.gaffa.live').replace(/\/$/, ''))
    .catch(() => 'https://www.gaffa.live');
  return baseUrlRequest;
}

/** The approval page's answer, from `#/gaffa/connected?code|error&state` (the redirect fallback). */
export function parseConnectedHash(hash: string): { code?: string; error?: string; state: string } | null {
  const m = hash.match(/^#\/gaffa\/connected\?(.*)$/);
  if (!m) return null;
  const qs = new URLSearchParams(m[1]);
  const state = qs.get('state');
  if (!state) return null;
  return { code: qs.get('code') ?? undefined, error: qs.get('error') ?? undefined, state };
}

/**
 * Finishes a connect attempt with the approval page's answer: checks the state against the attempt
 * this browser started, then exchanges the code. Returns whether the manager allowed it.
 */
export async function completeGaffaConnect(answer: {
  code?: string;
  error?: string;
  state: string;
}): Promise<'connected' | 'cancelled'> {
  const pending = readPending();
  if (!pending || pending.state !== answer.state) {
    throw new Error('That Gaffa connection was started elsewhere or has expired. Connect again.');
  }
  storage()?.removeItem(PENDING_KEY);
  if (answer.error || !answer.code) return 'cancelled';
  const res = await fetch('/api/gaffa/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: answer.code,
      code_verifier: pending.verifier,
      return_origin: window.location.origin,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data?.access_token !== 'string') {
    throw new Error(typeof data?.error === 'string' ? data.error : `Gaffa connection failed (${res.status})`);
  }
  setGrant(data.access_token);
  return 'connected';
}

/**
 * Opens Gaffa's approval page. Call it straight from a click: the popup opens before anything is
 * awaited, or browsers block it. When no popup opens, this tab goes to Gaffa and comes back
 * through `#/gaffa/connected`. Resolves when the manager allows or cancels.
 */
export async function connectGaffa(): Promise<'connected' | 'cancelled'> {
  const popup = window.open('', 'gaffa-connect', 'popup,width=480,height=720');
  const state = randomToken(24);
  const verifier = randomToken(32);
  storage()?.setItem(PENDING_KEY, JSON.stringify({ state, verifier, createdAt: Date.now() } satisfies PendingConnect));
  const [base, challenge] = await Promise.all([gaffaBaseUrl(), pkceChallenge(verifier)]);
  const qs = new URLSearchParams({ state, code_challenge: challenge, return_origin: window.location.origin });
  const url = `${base}/connect/futbolpedia?${qs.toString()}`;

  if (!popup) {
    window.location.assign(url);
    return new Promise(() => {});
  }
  popup.location.href = url;
  const gaffaOrigin = new URL(base).origin;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      stopGrantWatch();
      window.clearInterval(closedWatch);
      fn();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== gaffaOrigin || e.data?.type !== 'gaffa-connect' || e.data?.state !== state) return;
      // Gaffa's page waits for this window to close it; still open after a moment, it falls back
      // to the redirect route (it can't tell whether its opener is Futbolpedia).
      try {
        popup.close();
      } catch {
        /* already closed */
      }
      completeGaffaConnect({ code: e.data.code, error: e.data.error, state })
        .then((outcome) => finish(() => resolve(outcome)))
        .catch((err) => finish(() => reject(err)));
    };
    // The popup may lose its link to this window (a sign-in provider in between) and finish the
    // exchange itself through the redirect route; the grant then appears in storage.
    const stopGrantWatch = onGrantChange((token) => {
      if (token) finish(() => resolve('connected'));
    });
    // Reading a window's closed flag is local, not a request.
    const closedWatch = window.setInterval(() => {
      if (popup.closed) {
        window.setTimeout(() => finish(() => resolve(loadGrant() ? 'connected' : 'cancelled')), 300);
      }
    }, 500);
    window.addEventListener('message', onMessage);
  });
}

async function gaffaGet(path: string): Promise<Response> {
  const token = loadGrant();
  if (!token) throw new GaffaNotConnectedError();
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    setGrant(null);
    throw new GaffaNotConnectedError();
  }
  return res;
}

async function errorOf(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => ({}));
  return new Error(typeof body?.error === 'string' ? body.error : `${fallback} (${res.status})`);
}

/** Every club the connected manager runs, across leagues. */
export async function listMyGaffaClubs(): Promise<GaffaUserClub[]> {
  const res = await gaffaGet('/api/gaffa/clubs');
  if (!res.ok) throw await errorOf(res, 'Could not load your Gaffa clubs');
  const data = await res.json();
  return Array.isArray(data?.clubs) ? data.clubs : [];
}

/** One of the manager's clubs, as Gaffa's context bag. */
export async function fetchGaffaClubContext(leagueId: string, clubId: string): Promise<GaffaClubContextResponse> {
  const qs = new URLSearchParams({ leagueId, teamId: clubId });
  const res = await gaffaGet(`/api/gaffa/context?${qs.toString()}`);
  if (!res.ok) throw await errorOf(res, 'Could not load this club');
  return res.json();
}

/** Revokes the grant on Gaffa and forgets it here, even if Gaffa can't be reached. */
export async function disconnectGaffa(): Promise<void> {
  const token = loadGrant();
  setGrant(null);
  if (!token) return;
  await fetch('/api/gaffa/connect/grant', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => undefined);
}
