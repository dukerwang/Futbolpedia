/**
 * Where identities are kept, on the server. Entities go in `kb_entities` (anyone may read it; only
 * the server's Supabase secret key writes it). Which name and hint found which entities goes in
 * `kb_lookups`, which only the server reads, since its keys are what people typed. A stored name is
 * never matched against stored entities: that would settle a name on whoever happened to be stored
 * first, so only a stored answer to the same name and hint is reused.
 *
 * An answer is read again from Wikidata after a week, since clubs and spells move, so an entity is
 * rewritten at most once a week. Without the secret key, or before the tables exist, everything is
 * kept in this process's memory.
 */
import { isMissingTable } from '../eraSnapshots';
import { foldWords, hintKey, parseHint, resolveIdentity, type KbEntity, type KbGetJson, type KbResolution } from './identity';

export const KB_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** A name Wikidata didn't have is asked about again after a day. Kept in memory only. */
export const KB_NOT_FOUND_MS = 24 * 60 * 60 * 1000;
/** Resolutions asking Wikidata at once; it allows a client five. */
export const KB_CONCURRENCY = 3;
const MEMORY_LOOKUPS = 2_000;
const MEMORY_ENTITIES = 5_000;

export interface KbEntityRow {
  wikidata_id: string;
  kind: string;
  label: string;
  aliases: string[];
  birth_date: string | null;
  nationality: string[];
  positions: string[];
  wikipedia_title: string | null;
  external_ids: KbEntity['externalIds'];
  spells: KbEntity['spells'];
  current_club: string | null;
  fetched_at: string;
}

export interface KbLookupRow {
  lookup_key: string;
  status: 'resolved' | 'ambiguous';
  entity_ids: string[];
  reason: string | null;
  fetched_at: string;
}

/** The tables, behind an interface so tests and a server without the key can do without them. */
export interface KbDb {
  readLookup(key: string): Promise<KbLookupRow | null>;
  readEntities(ids: string[]): Promise<KbEntityRow[]>;
  writeEntities(rows: KbEntityRow[]): Promise<void>;
  writeLookup(row: KbLookupRow): Promise<void>;
}

/** The tables through a Supabase client made with the secret key, which bypasses RLS. */
export function supabaseKbDb(client: any, warn: (message: string) => void = console.warn): KbDb {
  // A table that isn't there yet (its migration not applied) is quiet: memory covers it.
  const check = (what: string, error: { code?: string; message?: string } | null | undefined) => {
    if (error && !isMissingTable(error)) warn(`[kb] ${what} failed: ${error.message ?? error.code}`);
  };
  return {
    async readLookup(key) {
      const { data, error } = await client.from('kb_lookups').select('*').eq('lookup_key', key).maybeSingle();
      check('lookup read', error);
      return data ?? null;
    },
    async readEntities(ids) {
      const { data, error } = await client.from('kb_entities').select('*').in('wikidata_id', ids);
      check('entity read', error);
      return data ?? [];
    },
    async writeEntities(rows) {
      const { error } = await client.from('kb_entities').upsert(rows, { onConflict: 'wikidata_id' });
      check('entity write', error);
    },
    async writeLookup(row) {
      const { error } = await client.from('kb_lookups').upsert(row, { onConflict: 'lookup_key' });
      check('lookup write', error);
    },
  };
}

export const entityToRow = (e: KbEntity): KbEntityRow => ({
  wikidata_id: e.id,
  kind: e.kind,
  label: e.label,
  aliases: e.aliases,
  birth_date: e.birthDate,
  nationality: e.nationality,
  positions: e.positions,
  wikipedia_title: e.wikipediaTitle,
  external_ids: e.externalIds,
  spells: e.spells,
  current_club: e.currentClub,
  fetched_at: e.fetchedAt,
});

export const rowToEntity = (r: KbEntityRow): KbEntity => ({
  id: r.wikidata_id,
  kind: r.kind === 'club' ? 'club' : 'player',
  label: r.label,
  aliases: r.aliases ?? [],
  birthDate: r.birth_date,
  nationality: r.nationality ?? [],
  positions: r.positions ?? [],
  wikipediaTitle: r.wikipedia_title,
  externalIds: r.external_ids ?? {},
  spells: r.spells ?? [],
  currentClub: r.current_club,
  fetchedAt: new Date(r.fetched_at).toISOString(),
});

/** How a lookup was answered: from the store, from Wikidata, from an old stored answer, or not at all. */
export type KbSource = 'store' | 'wikidata' | 'stale' | 'limited';

export interface KbAnswer {
  result: KbResolution;
  source: KbSource;
}

export interface KbStore {
  /** `allow` is asked only before a call to Wikidata, and returns why it may not be made, or null. */
  whoIs(name: string, hint?: string, options?: { allow?: () => string | null }): Promise<KbAnswer>;
}

interface StoredAnswer {
  status: 'resolved' | 'ambiguous' | 'not_found';
  ids: string[];
  reason: string | null;
  at: number;
}

/** A map that forgets its oldest entry past `limit`. */
function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value as string);
}

export function createKbStore(deps: {
  getJson: KbGetJson;
  db: KbDb | null;
  now?: () => number;
  warn?: (message: string) => void;
}): KbStore {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? console.warn;
  const lookups = new Map<string, StoredAnswer>();
  const entities = new Map<string, KbEntity>();
  const running = new Map<string, Promise<KbAnswer>>();

  // At most KB_CONCURRENCY resolutions ask Wikidata at once; the rest wait their turn.
  let active = 0;
  const waiting: (() => void)[] = [];
  const takeTurn = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= KB_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };

  const quiet = async <T>(what: string, work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch (e: any) {
      warn(`[kb] ${what} failed: ${String(e?.message ?? e).slice(0, 120)}`);
      return fallback;
    }
  };

  const fresh = (at: number, status: StoredAnswer['status']) => now() - at < (status === 'not_found' ? KB_NOT_FOUND_MS : KB_REFRESH_MS);

  /** The stored answer to this name and hint, with its entities; null unless all of it is there. */
  async function read(key: string): Promise<{ answer: StoredAnswer; result: KbResolution } | null> {
    let answer = lookups.get(key) ?? null;
    if (db && (!answer || !fresh(answer.at, answer.status))) {
      const row = await quiet('lookup read', () => db.readLookup(key), null);
      const at = row ? Date.parse(row.fetched_at) : NaN;
      if (row && Number.isFinite(at) && (!answer || at > answer.at)) answer = { status: row.status, ids: row.entity_ids, reason: row.reason, at };
    }
    if (!answer) return null;
    if (answer.status === 'not_found') return { answer, result: { status: 'not_found', reason: answer.reason ?? 'nothing by that name' } };
    const missing = answer.ids.filter((id) => !entities.has(id) || now() - Date.parse(entities.get(id)!.fetchedAt) >= KB_REFRESH_MS);
    if (db && missing.length) {
      for (const row of await quiet('entity read', () => db.readEntities(missing), [] as KbEntityRow[])) {
        const entity = rowToEntity(row);
        const held = entities.get(entity.id);
        if (!held || Date.parse(entity.fetchedAt) > Date.parse(held.fetchedAt)) remember(entities, entity.id, entity, MEMORY_ENTITIES);
      }
    }
    const found = answer.ids.map((id) => entities.get(id)).filter((e): e is KbEntity => Boolean(e));
    if (!found.length || found.length !== answer.ids.length) return null;
    return {
      answer,
      result:
        answer.status === 'resolved'
          ? { status: 'resolved', entity: found[0] }
          : { status: 'ambiguous', candidates: found, reason: answer.reason ?? 'several people or clubs fit the name' },
    };
  }

  async function keep(key: string, result: Exclude<KbResolution, { status: 'failed' }>): Promise<void> {
    const found = result.status === 'resolved' ? [result.entity] : result.status === 'ambiguous' ? result.candidates : [];
    const answer: StoredAnswer = {
      status: result.status,
      ids: found.map((e) => e.id),
      reason: result.status === 'resolved' ? null : result.reason,
      at: now(),
    };
    remember(lookups, key, answer, MEMORY_LOOKUPS);
    for (const entity of found) remember(entities, entity.id, entity, MEMORY_ENTITIES);
    // A name that found nothing makes no row, so typing junk writes nothing.
    if (!db || result.status === 'not_found') return;
    await quiet('write', async () => {
      const held = await db.readEntities(answer.ids);
      const current = new Set(held.filter((r) => now() - Date.parse(r.fetched_at) < KB_REFRESH_MS).map((r) => r.wikidata_id));
      const rows = found.filter((e) => !current.has(e.id)).map(entityToRow);
      if (rows.length) await db.writeEntities(rows);
      await db.writeLookup({
        lookup_key: key,
        status: result.status as KbLookupRow['status'],
        entity_ids: answer.ids,
        reason: answer.reason,
        fetched_at: new Date(answer.at).toISOString(),
      });
    }, undefined);
  }

  return {
    async whoIs(name, hint = '', options = {}) {
      const hints = parseHint(hint);
      const key = `${foldWords(name).join(' ')}#${hintKey(hints)}`;
      const stored = await read(key);
      // An answer is only as fresh as the oldest entity in it.
      const entityAges = !stored ? [] : stored.result.status === 'resolved' ? [stored.result.entity] : stored.result.status === 'ambiguous' ? stored.result.candidates : [];
      if (stored && fresh(stored.answer.at, stored.answer.status) && entityAges.every((e) => now() - Date.parse(e.fetchedAt) < KB_REFRESH_MS)) {
        return { result: stored.result, source: 'store' };
      }
      const old = (otherwise: KbAnswer): KbAnswer => (stored && stored.result.status !== 'not_found' ? { result: stored.result, source: 'stale' } : otherwise);
      const pending = running.get(key);
      if (pending) return pending;
      const refused = options.allow?.() ?? null;
      if (refused) return old({ result: { status: 'failed', reason: refused }, source: 'limited' });
      const job = takeTurn(async (): Promise<KbAnswer> => {
        const result = await resolveIdentity(name, hints, { getJson: deps.getJson, now });
        if (result.status === 'failed') return old({ result, source: 'wikidata' });
        await keep(key, result);
        return { result, source: 'wikidata' };
      }).finally(() => running.delete(key));
      running.set(key, job);
      return job;
    },
  };
}
