/**
 * The eval runner's search cache: grounded search results (the research digest behind `web_search`
 * and `runGroundedSearch`) kept on disk under `.cache/eval-search/<day>/`, keyed by the query, the
 * kind of digest and the day, so a rerun the same day reuses them and pays for no search. Only the
 * eval scripts install it (`startEvalSession` in `scripts/eval-guard.ts`, through `setSearchCache`
 * in `services/aiClient.ts`); the app never imports this file, so it never reads or writes the cache.
 * A search that failed, or found nothing, is never stored. `--fresh-search` installs no cache.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GroundedSearchResult, SearchCache } from '../services/aiClient';

export interface FileSearchCacheOptions {
  dir: string;
  /** The clock, in milliseconds; the day is its UTC date. */
  now?: () => number;
  onHit?: () => void;
  onMiss?: () => void;
}

export interface FileSearchCache extends SearchCache {
  hits: number;
  misses: number;
  /** The file a query's entry lives in, for tests and for clearing a bad entry by hand. */
  pathFor(query: string, kind: string): string;
}

export function createFileSearchCache(options: FileSearchCacheOptions): FileSearchCache {
  const now = options.now ?? Date.now;
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const pathFor = (query: string, kind: string) =>
    join(options.dir, day(), `${createHash('sha1').update(`${kind}\n${query.trim().toLowerCase()}`).digest('hex')}.json`);
  const cache: FileSearchCache = {
    hits: 0,
    misses: 0,
    pathFor,
    async get(query, kind) {
      try {
        const saved = JSON.parse(readFileSync(pathFor(query, kind), 'utf8'));
        if (saved?.query === query.trim().toLowerCase() && saved?.kind === kind && typeof saved?.result?.text === 'string' && saved.result.text) {
          cache.hits++;
          options.onHit?.();
          return saved.result as GroundedSearchResult;
        }
      } catch {
        // No entry for today, or one that can't be read: a miss.
      }
      cache.misses++;
      options.onMiss?.();
      return null;
    },
    async set(query, kind, result) {
      if (!result.text || result.error) return;
      const file = pathFor(query, kind);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({ query: query.trim().toLowerCase(), kind, day: day(), result }, null, 2));
    },
  };
  return cache;
}
