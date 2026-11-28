import type { ProxyLimiter } from '../geminiProxy';
import type { KbStore } from './store';

/**
 * `GET /api/kb/who-is?name=&hint=`: who a name means (`services/kb/identity.ts`). Public and
 * read-only. A name the store already holds costs nothing; one that has to go to Wikidata counts
 * against the visitor's limit, so the route can't be used to proxy Wikidata freely.
 */

/** Wikidata lookups one visitor may cause in a minute and in a day, and every visitor together in a day. */
export const KB_PER_MINUTE = 20;
export const KB_PER_DAY = 200;
export const KB_GLOBAL_PER_DAY = 3_000;
const MAX_INPUT = 80;

interface Request {
  query: Record<string, unknown>;
}
interface Response {
  status(code: number): Response;
  json(body: unknown): unknown;
}

export function whoIsHandler<R extends Request>(deps: {
  store: KbStore;
  limiter: ProxyLimiter;
  /** Who is asking, as the limit counts them. */
  sourceOf: (req: R) => string;
  log?: (message: string) => void;
}) {
  const log = deps.log ?? console.log;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, MAX_INPUT) : '');
  return async (req: R, res: Response): Promise<void> => {
    const name = text(req.query.name);
    const hint = text(req.query.hint);
    if (!name) {
      res.status(400).json({ error: 'Missing name' });
      return;
    }
    const start = Date.now();
    const asked = `who-is ${JSON.stringify(name)}${hint ? ` (hint ${JSON.stringify(hint)})` : ''}`;
    try {
      const { result, source } = await deps.store.whoIs(name, hint, { allow: () => deps.limiter.take(deps.sourceOf(req)) });
      const outcome = result.status === 'failed' || result.status === 'ambiguous' ? result.status : source === 'wikidata' ? 'miss' : 'hit';
      const detail =
        result.status === 'resolved'
          ? `${result.entity.label} ${result.entity.id}`
          : result.status === 'ambiguous'
            ? `${result.candidates.length} candidates (${result.reason})`
            : result.reason;
      log(`[kb] ${asked}: ${outcome}, ${detail} [${source}] (${Date.now() - start}ms)`);
      res.status(source === 'limited' && result.status === 'failed' ? 429 : 200).json(result);
    } catch (error: any) {
      log(`[kb] ${asked}: failed, ${error?.message || error} (${Date.now() - start}ms)`);
      res.status(200).json({ status: 'failed', reason: 'lookup failed' });
    }
  };
}
