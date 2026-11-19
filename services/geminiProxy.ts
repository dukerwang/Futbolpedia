import { GEMINI_3_8_FLASH, GEMINI_4_HYDROGEN } from '../constants/modelProfiles';

/**
 * The browser's only way to Gemini. The browser never holds a key: `services/aiClient.ts` points the
 * SDK at `/gemini-api-proxy` on this server, and this handler adds the server's key. Because the route
 * is public, it forwards only what Futbolpedia itself sends: a POST to one of the app's models and one
 * of the content methods, from a page on this site, within per-visitor and daily limits. Anything else
 * is refused without reaching Google, so the route can't be used as a free Gemini endpoint.
 */

/** The models the app calls. A request for any other model is refused. */
export const PROXY_MODELS: readonly string[] = [GEMINI_4_HYDROGEN, GEMINI_3_8_FLASH];

/** The methods the app's SDK calls use. */
export const PROXY_METHODS: readonly string[] = ['generateContent', 'streamGenerateContent', 'countTokens'];

/** Requests one visitor may send in a minute, and in a day. A chat turn makes about fifteen. */
export const PROXY_PER_MINUTE = 60;
export const PROXY_PER_DAY = 600;
/** Requests every visitor together may send in a day. Normal traffic is a few hundred. */
export const PROXY_GLOBAL_PER_DAY = 8_000;
/** Largest request body forwarded, in bytes. */
export const PROXY_MAX_BODY_BYTES = 2_000_000;

export type PathCheck = { ok: true; model: string; method: string } | { ok: false; reason: string };

/** Accepts only `v1beta/models/<model>:<method>` (or `v1`) for an allowed model and method. */
export function checkProxyPath(path: string): PathCheck {
  const m = /^(v1beta|v1)\/models\/([a-z0-9.\-]+):([A-Za-z]+)$/.exec(path.replace(/^\/+/, ''));
  if (!m) return { ok: false, reason: 'path not allowed' };
  const [, , model, method] = m;
  if (!PROXY_MODELS.includes(model)) return { ok: false, reason: `model not allowed: ${model}` };
  if (!PROXY_METHODS.includes(method)) return { ok: false, reason: `method not allowed: ${method}` };
  return { ok: true, model, method };
}

/**
 * Whether a request comes from a page on this site. Browsers send `Origin` on every POST, so a
 * request without one, or from another site, is refused. A script can forge the header, which is why
 * the limits below are the real control; this only stops other web pages from using the route.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, extra: readonly string[] = []): boolean {
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (host && originHost === host) return true;
  return extra.includes(originHost);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** In-memory counts per visitor and in total. A restart clears them. */
export function createProxyLimiter(
  options: { perMinute?: number; perDay?: number; globalPerDay?: number; now?: () => number } = {},
) {
  const perMinute = options.perMinute ?? PROXY_PER_MINUTE;
  const perDay = options.perDay ?? PROXY_PER_DAY;
  const globalPerDay = options.globalPerDay ?? PROXY_GLOBAL_PER_DAY;
  const now = options.now ?? Date.now;
  const minutes = new Map<string, number[]>();
  const days = new Map<string, number>();
  let day = Math.floor(now() / DAY_MS);
  let total = 0;
  return {
    /** Counts a request; returns why it was refused, or null when it may go. */
    take(source: string): string | null {
      const t = now();
      const today = Math.floor(t / DAY_MS);
      if (today !== day) {
        day = today;
        total = 0;
        days.clear();
        minutes.clear();
      }
      if (total >= globalPerDay) return 'daily limit reached';
      if ((days.get(source) ?? 0) >= perDay) return 'daily limit for this visitor reached';
      const recent = (minutes.get(source) ?? []).filter((x) => t - x < MINUTE_MS);
      if (recent.length >= perMinute) {
        minutes.set(source, recent);
        return 'too many requests, slow down';
      }
      recent.push(t);
      minutes.set(source, recent);
      days.set(source, (days.get(source) ?? 0) + 1);
      total += 1;
      return null;
    },
  };
}

export type ProxyLimiter = ReturnType<typeof createProxyLimiter>;

/** What the proxy needs from the request, kept framework-free so it can be tested. */
export interface ProxyRequest {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  origin?: string;
  host?: string;
  source: string;
}

export type ProxyDecision =
  | { forward: true; url: string; params: Record<string, string>; model: string }
  | { forward: false; status: number; error: string };

/** Decides whether a request may go to Google, and where. Never looks at any incoming key. */
export function decideProxy(
  req: ProxyRequest,
  deps: { key: string | undefined; limiter: ProxyLimiter; extraOrigins?: readonly string[] },
): ProxyDecision {
  if (!deps.key) return { forward: false, status: 503, error: 'Gemini is not configured' };
  if (req.method !== 'POST') return { forward: false, status: 405, error: 'method not allowed' };
  if (!originAllowed(req.origin, req.host, deps.extraOrigins)) return { forward: false, status: 403, error: 'origin not allowed' };
  const check = checkProxyPath(req.path);
  if (check.ok === false) return { forward: false, status: 403, error: (check as { reason: string }).reason };
  const size = req.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(req.body));
  if (size > PROXY_MAX_BODY_BYTES) return { forward: false, status: 413, error: 'request too large' };
  const refused = deps.limiter.take(req.source);
  if (refused) return { forward: false, status: 429, error: refused };
  // Only the SDK's `alt` parameter passes; AI Studio's internal ones and any `key` are dropped.
  const params: Record<string, string> = {};
  if (req.query.alt === 'sse') params.alt = 'sse';
  return { forward: true, url: `https://generativelanguage.googleapis.com/${req.path.replace(/^\/+/, '')}`, params, model: check.model };
}
