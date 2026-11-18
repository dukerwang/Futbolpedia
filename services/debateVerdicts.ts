import { Type } from '@google/genai';
import type { PlayerProfile } from '../types';
import { POSITION_CANON } from '../constants/ratingTiers';
import { generateStructured } from './aiClient';
import { cardAbove, cardsSettle, toStanding, type CardStanding, type DebateCriterion } from './debateConsistency';
import { cardEdition, getCardKey, isPrimeCard, toBasePlayerSlug } from './dossierCards';
import { eraKey, isMissingTable, normalizePeriod } from './eraSnapshots';

/**
 * Settled verdicts on questions about the past: the scout's answer to who was better, or in what
 * order, on given versions and a given criterion, kept so later turns read it as a prior and depart
 * from it only with a stated reason. Design: docs/superpowers/specs/2026-11-18-past-questions-deep-design.md.
 *
 * A verdict is keyed by the versions compared and the criterion, never by what a user typed, so
 * paraphrases share a row and no user text is stored. The Supabase `debate_verdicts` table is
 * readable by anyone and written only by the server, after it checks a proposal itself:
 *
 * 1. The browser proposes a choice among subjects (`POST /api/debates/settle`): subject keys, the
 *    kind, the criterion, the winner or order, and a ranking's field. No reasons or prose.
 * 2. The server resolves every subject itself (a served card by key, a history record for a player
 *    window or club season) and refuses a card-settled verdict that goes against the cards.
 * 3. Where the cards settle it outright, the row is stored without a model call. Otherwise one
 *    call reads the cards and records and accepts or refuses, writing the criteria and the
 *    counter-case in its own words. Only an accepted proposal is stored.
 *
 * A row goes stale when a card it was settled under is re-rated, or an era snapshot of one of its
 * subjects is built after it, and it is contested once `VERDICT_REOPEN_DEPARTURES` distinct clients
 * have departed from it (`POST /api/debates/departure`). Either way the next accepted proposal
 * replaces it. Without the table, nothing is read or stored and no call is made; without the
 * secret key the server keeps verdicts in memory.
 *
 * Nothing calls this yet: the chat loop reads and proposes verdicts once `PAST_MODE` is on. Until
 * then the settle route spends nothing (`settleEnabled`), since it is public.
 */

/**
 * Whether questions about the past take the chat loop. While it is off nothing in the app proposes
 * a verdict, so the public settle route makes no call and stores nothing. Migration step 3 moves
 * this switch to `services/chatTurn.ts` with the loop it turns on, and this module reads it there.
 */
export const PAST_MODE = false;

/**
 * Whether the settle route may spend calls: only while past questions are on (`pastMode`), or when
 * `DEBATE_SETTLE=on` forces it for a local run, never when `DEBATE_SETTLE=off`, and never with a
 * budget of zero.
 */
export function settleEnabled(opts: { pastMode: boolean; setting?: string | null; calls: number }): boolean {
  const setting = (opts.setting ?? '').trim().toLowerCase();
  if (setting === 'off' || opts.calls <= 0) return false;
  return setting === 'on' || opts.pastMode;
}

/** Bump when the key, the check or the stored shape changes, so every row is settled again. */
export const DEBATE_VERDICT_VERSION = 1;
/** Settle calls a UTC day, all clients together (`DEBATE_SETTLE_CALLS`). */
export const DEBATE_SETTLE_DEFAULT_CALLS = 20;
/** Settle requests that may reach a call, per client an hour. */
export const SETTLES_PER_SOURCE_HOUR = 5;
/** A refused proposal's key isn't checked again for this long. */
export const REFUSED_COOLDOWN_MS = 10 * 60_000;
/** Distinct clients departing from a stored verdict before it is contested. */
export const VERDICT_REOPEN_DEPARTURES = 3;
/** Departures a client may count in a UTC day. */
export const DEPARTURES_PER_SOURCE_DAY = 20;
/** Most entries a stored ranking holds. */
export const MAX_RANKING_SUBJECTS = 15;
/** Most subjects the browser reads verdicts for (every pair of them). */
export const MAX_READ_SUBJECTS = 8;
/** How long a settle call may run. */
export const SETTLE_TIMEOUT_MS = 20_000;
/** Characters of each subject's record the settle call reads. */
const RECORD_CHARS = 2_500;

export const VERDICT_KINDS = ['head_to_head', 'ranking'] as const;
export type VerdictKind = (typeof VERDICT_KINDS)[number];

/** What a question turns on. `big_games` isn't card-settled. */
export const VERDICT_CRITERIA = ['peak_level', 'sustained_level', 'output', 'influence', 'big_games', 'versatility', 'mixed'] as const;
export type VerdictCriterion = (typeof VERDICT_CRITERIA)[number];

/** Whether the cards settle a criterion (`cardsSettle`, peak level and mixed). */
export const verdictCardsSettle = (criterion: VerdictCriterion): boolean => criterion !== 'big_games' && cardsSettle(criterion as DebateCriterion);

const CRITERION_TEXT: Record<VerdictCriterion, string> = {
  peak_level: 'how good each version was at its best',
  sustained_level: 'how long each held a high level',
  output: 'goals, assists and other output',
  influence: 'its effect on results and on the team',
  big_games: 'its record in the biggest matches',
  versatility: 'its range of roles',
  mixed: 'how good each was overall, with no one measure deciding',
};

// ---------------------------------------------------------------------------------------------
// Subjects

/**
 * A subject is a version compared: a stored card (`card:<card key>`), a player across a window
 * with no card (`player_window:<slug>:<YYYY-YY>`), or a club's season (`club_season:<slug>:<YYYY-YY>`).
 * The last two are era snapshot keys, so a snapshot's build time reads straight against them.
 */
export type SubjectKind = 'card' | 'player_window' | 'club_season';

export interface ParsedSubject {
  key: string;
  kind: SubjectKind;
  /** The card key, for a card subject. */
  cardKey?: string;
  slug: string;
  /** The season or window; for a card, read from the card when it is resolved. */
  period: string | null;
}

const SLUG = '[a-z0-9-]{1,80}';
const PERIOD = '(?:19|20)\\d{2}-\\d{2}';
const CARD_SUBJECT_RE = new RegExp(`^card:(${SLUG}):([a-z_]{1,24}):([A-Za-z0-9._:/–-]{1,40})$`);
const ERA_SUBJECT_RE = new RegExp(`^(player_window|club_season):(${SLUG}):(${PERIOD})$`);

export const cardSubjectKey = (card: PlayerProfile): string => `card:${getCardKey(card)}`;

/** A player's window or a club's season as a subject key, or null when the period doesn't read. */
export const eraSubjectKey = (kind: 'player_window' | 'club_season', subject: string, period: string): string | null => {
  const p = normalizePeriod(period);
  return p ? eraKey(kind, subject, p) : null;
};

export function parseSubjectKey(raw: unknown): ParsedSubject | null {
  if (typeof raw !== 'string' || raw.length > 160) return null;
  const card = CARD_SUBJECT_RE.exec(raw);
  if (card) return { key: raw, kind: 'card', cardKey: raw.slice('card:'.length), slug: card[1], period: null };
  const era = ERA_SUBJECT_RE.exec(raw);
  if (era) return { key: raw, kind: era[1] as SubjectKind, slug: era[2], period: era[3] };
  return null;
}

/** The era snapshot that covers a subject: its own key, or, for a card, his window's. */
export function eraKeyForSubject(subject: ParsedSubject, card?: PlayerProfile | null): string | null {
  if (subject.kind !== 'card') return subject.key;
  const window = card && isPrimeCard(card) ? normalizePeriod(card.version?.seasonOrEra ?? '') : null;
  return window ? eraKey('player_window', card!.basicInfo.name, window) : null;
}

const titleFromSlug = (slug: string): string =>
  slug
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

/** The name a history lookup is asked for, from a subject's slug. */
export const nameFromSubject = (s: ParsedSubject): string => titleFromSlug(s.slug);

/** How a card subject is labelled: name, version and window, from the card itself. */
export const cardLabel = (card: PlayerProfile): string => {
  const edition = cardEdition(card);
  const window = card.version?.seasonOrEra?.trim();
  return `${card.basicInfo.name} (${edition === 'current' ? 'current form' : edition}${window && edition !== 'current' ? `, ${window}` : ''})`;
};

// ---------------------------------------------------------------------------------------------
// A ranking's field

export interface RankingScope {
  /** A canonical position, or `any`. */
  position: string;
  /** A decade (`2000s`), a season span (`2003-06`), or `all-time`. */
  period: string;
  key: string;
}

const canonicalPosition = (raw: string): string | null => {
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  return POSITION_CANON[key] ?? POSITION_CANON[key.replace(/s$/, '')] ?? null;
};

const normalizeScopePeriod = (raw: string): string | null => {
  const text = raw.toLowerCase();
  const decade = /\b((?:19|20)\d0)'?s\b/.exec(text);
  if (decade) return `${decade[1]}s`;
  if (/\ball[- ]?time\b|\bever\b|\bin history\b/.test(text)) return 'all-time';
  return normalizePeriod(raw);
};

/** A ranking's field, as both the model's commitment and the message are read into it. */
export function normalizeScope(raw: { position?: unknown; period?: unknown } | null | undefined): RankingScope | null {
  const period = typeof raw?.period === 'string' ? normalizeScopePeriod(raw.period.slice(0, 60)) : null;
  if (!period) return null;
  const given = typeof raw?.position === 'string' ? raw.position.slice(0, 40).trim() : '';
  const position = given && !/^any$/i.test(given) ? canonicalPosition(given) : 'any';
  if (!position) return null;
  return { position, period, key: `${toBasePlayerSlug(position) || 'any'}|${period}` };
}

/** The field a ranking question names: the first position word and its period, or null. */
export function scopeFromMessage(message: string): RankingScope | null {
  const words = message.toLowerCase().split(/[^a-z'-]+/).filter(Boolean);
  let position = 'any';
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? canonicalPosition(`${words[i]}${words[i + 1]}`) : null;
    const one = canonicalPosition(words[i]);
    if (pair || one) {
      position = (pair ?? one)!;
      break;
    }
  }
  const period = /\b(?:19|20)\d0'?s\b/.exec(message)?.[0] ?? /\b(?:19|20)\d{2}\s*[-/–]\s*\d{2,4}\b/.exec(message)?.[0] ?? (/\ball[- ]?time\b|\bever\b/i.exec(message)?.[0] ?? '');
  return normalizeScope({ position, period });
}

// ---------------------------------------------------------------------------------------------
// Keys and fingerprints

export const subjectSet = (keys: readonly string[]): string => [...new Set(keys)].sort().join('|');

/** A row's key: kind, criterion and either the subjects or, for a ranking, its field. */
export function verdictKey(kind: VerdictKind, criterion: VerdictCriterion, subjects: readonly string[], scope?: RankingScope | null): string {
  const body = kind === 'ranking' ? `scope:${scope?.key ?? ''}` : subjectSet(subjects);
  const full = `${kind}:${criterion}:${body}`;
  if (full.length <= 200) return full;
  let h = 2166136261;
  for (const ch of full) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `${full.slice(0, 180)}#${h.toString(36)}`;
}

/** Each card subject's key, Overall and re-rate time, sorted; other subjects don't change. */
export function fingerprintOf(subjects: readonly string[], cards: ReadonlyMap<string, PlayerProfile>): string {
  return subjects
    .filter((k) => k.startsWith('card:'))
    .map((k) => {
      const card = cards.get(k.slice('card:'.length));
      return `${k.slice('card:'.length)}=${card ? Number(card.ratings?.overall) || 0 : 'gone'}@${card?.rerateAt ?? ''}`;
    })
    .sort()
    .join(',');
}

const readFingerprint = (fp: string): Map<string, string> =>
  new Map(
    fp
      .split(',')
      .filter(Boolean)
      .map((e) => {
        const at = e.lastIndexOf('=');
        return [e.slice(0, at), e.slice(at + 1)] as [string, string];
      }),
  );

// ---------------------------------------------------------------------------------------------
// Rows

export interface VerdictSubject {
  key: string;
  label: string;
}

export interface VerdictRow {
  verdict_key: string;
  kind: VerdictKind;
  criterion: VerdictCriterion;
  subject_set: string;
  scope_key: string | null;
  subjects: VerdictSubject[];
  /** The winner (one key), or the order, best first. */
  verdict: string[];
  criteria: string[];
  counter_case: string;
  fingerprint: string;
  era_mark: string | null;
  status: 'current' | 'contested';
  departures: number;
  version: number;
  settled_at: string;
}

/** A stored verdict as a turn reads it. */
export interface SettledVerdict {
  key: string;
  kind: VerdictKind;
  criterion: VerdictCriterion;
  subjects: VerdictSubject[];
  verdict: string[];
  criteria: string[];
  counterCase: string;
  settledAt: string;
  status: 'current' | 'stale' | 'contested';
  /** Why a stale row is stale: each card re-rated since, and each era snapshot built since. */
  staleBecause: string[];
}

/** Where today's cards and snapshots leave a stored row. */
export function verdictStatus(
  row: VerdictRow,
  now: { fingerprint: string; eraBuiltAt: ReadonlyMap<string, string> },
): { status: SettledVerdict['status']; because: string[] } {
  const because: string[] = [];
  const then = readFingerprint(row.fingerprint);
  const today = readFingerprint(now.fingerprint);
  for (const [key, was] of then) {
    const is = today.get(key);
    if (is !== undefined && is !== was) because.push(`card ${key} read ${was.split('@')[0]} when settled and reads ${is.split('@')[0]} now`);
  }
  const settled = Date.parse(row.settled_at);
  for (const [key, builtAt] of now.eraBuiltAt) {
    if (Date.parse(builtAt) > settled) because.push(`era snapshot ${key} was built after it was settled`);
  }
  if (row.version !== DEBATE_VERDICT_VERSION) because.push('settled under an older version');
  if (because.length) return { status: 'stale', because };
  return { status: row.status === 'contested' ? 'contested' : 'current', because };
}

const strings = (v: unknown, max: number, chars = 160): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, chars)).slice(0, max) : [];

/** A row from the table, checked; anything malformed is null. */
export function readRow(raw: any): VerdictRow | null {
  if (!raw || typeof raw.verdict_key !== 'string') return null;
  if (!(VERDICT_KINDS as readonly string[]).includes(raw.kind) || !(VERDICT_CRITERIA as readonly string[]).includes(raw.criterion)) return null;
  const subjects: VerdictSubject[] = Array.isArray(raw.subjects)
    ? raw.subjects.filter((s: any) => typeof s?.key === 'string' && typeof s?.label === 'string').map((s: any) => ({ key: s.key, label: s.label }))
    : [];
  const verdict = strings(raw.verdict, MAX_RANKING_SUBJECTS, 160);
  if (!subjects.length || !verdict.length) return null;
  return {
    verdict_key: raw.verdict_key,
    kind: raw.kind,
    criterion: raw.criterion,
    subject_set: String(raw.subject_set ?? ''),
    scope_key: typeof raw.scope_key === 'string' ? raw.scope_key : null,
    subjects,
    verdict,
    criteria: strings(raw.criteria, 4, 80),
    counter_case: String(raw.counter_case ?? '').slice(0, 600),
    fingerprint: String(raw.fingerprint ?? ''),
    era_mark: typeof raw.era_mark === 'string' ? raw.era_mark : null,
    status: raw.status === 'contested' ? 'contested' : 'current',
    departures: Number(raw.departures) || 0,
    version: Number(raw.version) || 0,
    settled_at: String(raw.settled_at ?? ''),
  };
}

// ---------------------------------------------------------------------------------------------
// The table

export interface VerdictDb {
  /** Whether the `debate_verdicts` table exists (its migration has been applied). */
  ready(): Promise<boolean>;
  read(key: string): Promise<VerdictRow | null>;
  /** Rows whose `subject_set` is one of these. */
  readBySubjectSets(sets: string[]): Promise<VerdictRow[]>;
  readByScope(scopeKey: string): Promise<VerdictRow[]>;
  write(row: VerdictRow): Promise<void>;
}

/**
 * The table through a Supabase client: the publishable one for reads, the secret one on the server
 * for writes too. A missing table reads as empty and stores nothing.
 */
export function supabaseVerdictDb(client: any): VerdictDb {
  let table: Promise<boolean> | null = null;
  const missing = (error: any) => {
    if (isMissingTable(error)) table = Promise.resolve(false);
    return Boolean(error);
  };
  const rows = (data: unknown): VerdictRow[] => (Array.isArray(data) ? data.map(readRow).filter((r): r is VerdictRow => r !== null) : []);
  return {
    ready() {
      table ??= Promise.resolve(client.from('debate_verdicts').select('verdict_key').limit(1)).then(
        ({ error }: { error: unknown }) => !error,
        () => false,
      );
      return table;
    },
    async read(key) {
      const { data, error } = await client.from('debate_verdicts').select('*').eq('verdict_key', key).maybeSingle();
      return missing(error) ? null : readRow(data);
    },
    async readBySubjectSets(sets) {
      if (!sets.length) return [];
      const { data, error } = await client.from('debate_verdicts').select('*').in('subject_set', sets);
      return missing(error) ? [] : rows(data);
    },
    async readByScope(scopeKey) {
      const { data, error } = await client.from('debate_verdicts').select('*').eq('scope_key', scopeKey);
      return missing(error) ? [] : rows(data);
    },
    async write(row) {
      if (!(await this.ready())) return;
      const { error } = await client.from('debate_verdicts').upsert(row, { onConflict: 'verdict_key' });
      if (error) console.warn('[verdicts] upsert failed:', error.message ?? error);
    },
  };
}

/**
 * The table in memory: the server without the secret key, and the tests. `ready` says whether the
 * real table exists; on the server it asks Supabase, so a missing migration means no calls and no
 * rows here too.
 */
export function memoryVerdictDb(ready: boolean | (() => Promise<boolean>) = true): VerdictDb & { rows: Map<string, VerdictRow> } {
  const rows = new Map<string, VerdictRow>();
  const isReady = typeof ready === 'function' ? () => ready().catch(() => false) : async () => ready;
  return {
    rows,
    ready: isReady,
    read: async (key) => ((await isReady()) ? rows.get(key) ?? null : null),
    readBySubjectSets: async (sets) => ((await isReady()) ? [...rows.values()].filter((r) => sets.includes(r.subject_set)) : []),
    readByScope: async (scopeKey) => ((await isReady()) ? [...rows.values()].filter((r) => r.scope_key === scopeKey) : []),
    write: async (row) => {
      if (await isReady()) rows.set(row.verdict_key, { ...row });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading, for a turn

/**
 * The stored verdicts for the versions in play: every row on a pair of them (head-to-heads) and,
 * for a ranking, the row for its field. A card-settled row that is stale is left out, since the
 * cards are the prior there; any other stale row is returned marked stale, with why. A missing
 * table, or a failed read, is no verdicts.
 */
export async function readSettledVerdicts(
  query: { cards: PlayerProfile[]; subjects?: string[]; scope?: RankingScope | null },
  deps: { db: VerdictDb; eraBuiltAt?: (eraKeys: string[]) => Promise<ReadonlyMap<string, string>> },
): Promise<SettledVerdict[]> {
  const cardMap = new Map(query.cards.map((c) => [getCardKey(c), c] as const));
  const keys = [...new Set([...query.cards.map(cardSubjectKey), ...(query.subjects ?? [])])].slice(0, MAX_READ_SUBJECTS);
  const pairs: string[] = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) pairs.push(subjectSet([keys[i], keys[j]]));
  const [byPairs, byScope] = await Promise.all([
    deps.db.readBySubjectSets(pairs).catch(() => [] as VerdictRow[]),
    query.scope ? deps.db.readByScope(query.scope.key).catch(() => [] as VerdictRow[]) : Promise.resolve([] as VerdictRow[]),
  ]);
  const rows = [...new Map([...byPairs, ...byScope].map((r) => [r.verdict_key, r])).values()];
  const out: SettledVerdict[] = [];
  for (const row of rows) {
    const subjects = row.subjects.map((s) => parseSubjectKey(s.key)).filter((s): s is ParsedSubject => s !== null);
    const eraKeys = subjects.map((s) => eraKeyForSubject(s, s.cardKey ? cardMap.get(s.cardKey) : null)).filter((k): k is string => k !== null);
    const built = deps.eraBuiltAt ? await deps.eraBuiltAt(eraKeys).catch(() => new Map<string, string>()) : new Map<string, string>();
    const { status, because } = verdictStatus(row, { fingerprint: fingerprintOf(row.subjects.map((s) => s.key), cardMap), eraBuiltAt: built });
    if (status === 'stale' && verdictCardsSettle(row.criterion)) continue;
    out.push({
      key: row.verdict_key,
      kind: row.kind,
      criterion: row.criterion,
      subjects: row.subjects,
      verdict: row.verdict,
      criteria: row.criteria,
      counterCase: row.counter_case,
      settledAt: row.settled_at,
      status,
      staleBecause: because,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Requests

export interface SettleRequest {
  kind: VerdictKind;
  criterion: VerdictCriterion;
  subjects: string[];
  /** The winner (one subject key), or the order, best first. */
  verdict: string[];
  scope: RankingScope | null;
}

/**
 * A settle request from a browser, checked: a head-to-head names two subjects and one of them as
 * the winner; a ranking names two to fifteen subjects in its order and a field that reads. Every
 * subject must be a subject key. Anything else is null. No text is read.
 */
export function readSettleRequest(body: unknown): SettleRequest | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return null;
  if (!(VERDICT_KINDS as readonly string[]).includes(b.kind as string)) return null;
  if (!(VERDICT_CRITERIA as readonly string[]).includes(b.criterion as string)) return null;
  const kind = b.kind as VerdictKind;
  const criterion = b.criterion as VerdictCriterion;
  if (!Array.isArray(b.subjects) || !Array.isArray(b.verdict)) return null;
  const subjects = b.subjects.map(parseSubjectKey);
  if (subjects.some((s) => s === null)) return null;
  const keys = subjects.map((s) => s!.key);
  if (new Set(keys).size !== keys.length) return null;
  const verdict = b.verdict.filter((v): v is string => typeof v === 'string');
  if (verdict.length !== b.verdict.length) return null;
  if (kind === 'head_to_head') {
    if (keys.length !== 2 || verdict.length !== 1 || !keys.includes(verdict[0])) return null;
    return { kind, criterion, subjects: keys, verdict, scope: null };
  }
  if (keys.length < 2 || keys.length > MAX_RANKING_SUBJECTS) return null;
  if (verdict.length !== keys.length || subjectSet(verdict) !== subjectSet(keys)) return null;
  const scope = normalizeScope(b.scope as { position?: unknown; period?: unknown } | null);
  if (!scope) return null;
  return { kind, criterion, subjects: keys, verdict, scope };
}

/** A departure report: one stored verdict's key, nothing else. */
export function readDepartureRequest(body: unknown): { key: string } | null {
  const key = (body as Record<string, unknown> | null)?.key;
  return typeof key === 'string' && key.length <= 200 && /^(?:head_to_head|ranking):[a-z_]+:/.test(key) ? { key } : null;
}

// ---------------------------------------------------------------------------------------------
// The card check

/**
 * Whether a proposal agrees with the cards on a card-settled criterion: no carded subject sits above
 * one whose card is rated above it. `decided` is true when the cards order every subject strictly,
 * so the proposal needs no model call.
 */
export function checkProposalAgainstCards(
  req: Pick<SettleRequest, 'kind' | 'criterion' | 'verdict' | 'subjects'>,
  cards: ReadonlyMap<string, PlayerProfile>,
): { agrees: boolean; decided: boolean } {
  if (!verdictCardsSettle(req.criterion)) return { agrees: true, decided: false };
  const order = req.kind === 'head_to_head' ? [req.verdict[0], ...req.subjects.filter((k) => k !== req.verdict[0])] : req.verdict;
  const standings: (CardStanding | null)[] = order.map((k) => {
    const card = k.startsWith('card:') ? cards.get(k.slice('card:'.length)) : undefined;
    return card ? toStanding(card) : null;
  });
  let decided = standings.every((s) => s !== null);
  for (let i = 0; i < standings.length; i++) {
    for (let j = i + 1; j < standings.length; j++) {
      const [a, b] = [standings[i], standings[j]];
      if (!a || !b) continue;
      if (cardAbove(b, a)) return { agrees: false, decided: false };
      if (!cardAbove(a, b)) decided = false;
    }
  }
  return { agrees: true, decided };
}

// ---------------------------------------------------------------------------------------------
// The settle call

export interface SettleJudgment {
  accept: boolean;
  criteria: string[];
  counterCase: string;
}

export type SettleModel = (prompt: string) => Promise<unknown>;

export const SETTLE_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    accept: { type: Type.BOOLEAN },
    criteria: { type: Type.ARRAY, items: { type: Type.STRING } },
    counterCase: { type: Type.STRING },
  },
  required: ['accept', 'criteria', 'counterCase'],
};

export const liveSettleModel: SettleModel = (prompt) =>
  generateStructured<unknown>({ task: 'prediction', prompt, schema: SETTLE_SCHEMA, thinkingLevelOverride: 'low' });

/** The model's answer, checked; a malformed one is a refusal. */
export function readJudgment(raw: unknown): SettleJudgment {
  const r = raw as Record<string, unknown> | null;
  const criteria = strings(r?.criteria, 4, 80);
  const counterCase = typeof r?.counterCase === 'string' ? r.counterCase.trim().slice(0, 600) : '';
  return { accept: r?.accept === true && criteria.length > 0, criteria, counterCase };
}

/** What the settle call reads about one subject. */
export interface ResolvedSubject {
  subject: ParsedSubject;
  label: string;
  card: PlayerProfile | null;
  /** The era snapshot's story, else the history record; null when neither was found. */
  record: string | null;
}

const describeCard = (card: PlayerProfile): string => {
  const p = card.peerPlacement;
  const placed = p
    ? [p.betterThan?.length ? `judged better than ${p.betterThan.join(', ')}` : '', p.levelWith?.length ? `level with ${p.levelWith.join(', ')}` : '', p.notAsGoodAs?.length ? `not as good as ${p.notAsGoodAs.join(', ')}` : '']
        .filter(Boolean)
        .join('; ')
    : '';
  return `stored card: Overall ${Number(card.ratings?.overall) || 0}${placed ? `; ${placed}` : ''}`;
};

/** The settle call's prompt. Descriptive only: no player, club or sample phrase. */
export function buildSettlePrompt(req: SettleRequest, resolved: ResolvedSubject[]): string {
  const byKey = new Map(resolved.map((r) => [r.subject.key, r]));
  const label = (k: string) => byKey.get(k)?.label ?? k;
  const proposal =
    req.kind === 'head_to_head'
      ? `${label(req.verdict[0])} over ${label(req.subjects.find((k) => k !== req.verdict[0])!)}`
      : req.verdict.map((k, i) => `${i + 1}. ${label(k)}`).join('\n');
  return `You are checking a proposed answer to a football question about the past before it is stored as the scout's settled view, which later answers will read as their starting point. It must be an answer a careful analyst could defend from the evidence below.

The question turns on ${CRITERION_TEXT[req.criterion]}${req.scope ? `, among players at ${req.scope.position === 'any' ? 'any position' : req.scope.position} over ${req.scope.period}` : ''}.

Proposed answer:
${proposal}

The versions compared, with what is known about each:
${resolved
  .map((r) => `## ${r.label}\n${r.card ? `${describeCard(r.card)}\n` : ''}${r.record ? r.record.slice(0, RECORD_CHARS) : 'No record was found.'}`)
  .join('\n\n')}

A stored card rates how good one version of a player was across its window, on one all-era standard; it says nothing about output, longevity, influence or the biggest matches.

Accept when the evidence supports the proposed answer on this criterion and nothing in it points the other way. Refuse when the evidence points the other way, or when the answer would rest on something the evidence doesn't support. Answer with:
- accept: true or false.
- criteria: two to four short names (a few words each) for the things that settle this question.
- counterCase: the strongest case against the proposed answer, in one sentence, from the evidence.`;
}

// ---------------------------------------------------------------------------------------------
// The settler, on the server

export type SettleStatus =
  | 'off'
  | 'invalid'
  | 'unavailable'
  | 'kept'
  | 'settled_otherwise'
  | 'cooling'
  | 'busy'
  | 'limited'
  | 'budget'
  | 'refused_cards'
  | 'stored'
  | 'refused'
  | 'failed';

export interface SettleOutcome {
  status: SettleStatus;
  /** Model calls this request made. */
  calls: number;
  /** For an `invalid` request whose subjects were well formed: the subject the server couldn't resolve. Never sent to a browser. */
  unresolved?: string;
}

export interface VerdictSettlerDeps {
  db: VerdictDb;
  /** The served cards, by card key. */
  cards(): Promise<ReadonlyMap<string, PlayerProfile>>;
  /** What is stored about a subject: its era snapshot's story, else its history record. */
  record(subject: ParsedSubject, card: PlayerProfile | null): Promise<{ label?: string; text: string } | null>;
  /** When each of these era snapshots was built, for those that are stored. */
  eraBuiltAt(eraKeys: string[]): Promise<ReadonlyMap<string, string>>;
  model?: SettleModel;
  /** Settle calls a UTC day. */
  budget?: number;
  enabled?: boolean;
  now?: () => number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface VerdictSettler {
  settle(body: unknown, source: string): Promise<SettleOutcome>;
  depart(body: unknown, source: string): Promise<'ignored' | 'counted' | 'contested'>;
  callsToday(): number;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const within = <T>(p: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

export function createVerdictSettler(deps: VerdictSettlerDeps): VerdictSettler {
  const now = deps.now ?? Date.now;
  const model = deps.model ?? liveSettleModel;
  const budget = deps.budget ?? DEBATE_SETTLE_DEFAULT_CALLS;
  const enabled = deps.enabled ?? true;
  const log = deps.log ?? ((line: string) => console.log(line));
  let day = dayOf(now());
  let spent = 0;
  const bySource = new Map<string, number[]>();
  const refused = new Map<string, number>();
  const inFlight = new Set<string>();
  const departed = new Map<string, Set<string>>();
  const departuresBySource = new Map<string, number>();

  const rollDay = () => {
    const today = dayOf(now());
    if (today !== day) {
      day = today;
      spent = 0;
      departuresBySource.clear();
    }
  };

  /** Whether this source may make another settle call this hour; counts it when it may. */
  const allow = (source: string): boolean => {
    const hourAgo = now() - 3_600_000;
    const recent = (bySource.get(source) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= SETTLES_PER_SOURCE_HOUR) {
      bySource.set(source, recent);
      return false;
    }
    recent.push(now());
    bySource.set(source, recent);
    return true;
  };

  const resolve = async (req: SettleRequest, cards: ReadonlyMap<string, PlayerProfile>): Promise<ResolvedSubject[] | { unresolved: string }> => {
    const out: ResolvedSubject[] = [];
    for (const key of req.subjects) {
      const subject = parseSubjectKey(key)!;
      const card = subject.cardKey ? cards.get(subject.cardKey) ?? null : null;
      if (subject.kind === 'card' && !card) return { unresolved: key };
      const record = await deps.record(subject, card).catch(() => null);
      // A version with no card must be one the records know.
      if (!card && !record) return { unresolved: key };
      out.push({
        subject,
        card,
        record: record?.text ?? null,
        label: card ? cardLabel(card) : subject.kind === 'club_season' ? `${record?.label ?? nameFromSubject(subject)} ${subject.period}` : `${record?.label ?? nameFromSubject(subject)} (${subject.period})`,
      });
    }
    return out;
  };

  return {
    callsToday: () => (rollDay(), spent),

    async settle(body, source) {
      if (!enabled) return { status: 'off', calls: 0 };
      const req = readSettleRequest(body);
      if (!req) return { status: 'invalid', calls: 0 };
      if (!(await deps.db.ready().catch(() => false))) return { status: 'unavailable', calls: 0 };
      const key = verdictKey(req.kind, req.criterion, req.subjects, req.scope);
      const cooled = refused.get(key);
      if (cooled !== undefined && now() - cooled < REFUSED_COOLDOWN_MS) return { status: 'cooling', calls: 0 };
      if (inFlight.has(key)) return { status: 'busy', calls: 0 };
      inFlight.add(key);
      try {
        const cards = await deps.cards();
        const resolution = await resolve(req, cards);
        if (!Array.isArray(resolution)) {
          log(`[verdicts] unresolved subject ${resolution.unresolved}: ${key}`);
          return { status: 'invalid', calls: 0, unresolved: resolution.unresolved };
        }
        const resolved = resolution;
        const eraKeys = resolved.map((r) => eraKeyForSubject(r.subject, r.card)).filter((k): k is string => k !== null);
        const built = await deps.eraBuiltAt(eraKeys).catch(() => new Map<string, string>());
        const fingerprint = fingerprintOf(req.subjects, cards);

        // A current row stays: the same verdict needs nothing, a different one is a departure, not a
        // replacement. A stale or contested row, or one from an older version, may be replaced.
        const existing = await deps.db.read(key).catch(() => null);
        if (existing) {
          const { status } = verdictStatus(existing, { fingerprint: fingerprintOf(existing.subjects.map((s) => s.key), cards), eraBuiltAt: built });
          if (status === 'current') return { status: existing.verdict.join('|') === req.verdict.join('|') ? 'kept' : 'settled_otherwise', calls: 0 };
        }

        const check = checkProposalAgainstCards(req, cards);
        if (!check.agrees) {
          refused.set(key, now());
          log(`[verdicts] refused by the cards: ${key}`);
          return { status: 'refused_cards', calls: 0 };
        }

        let judgment: SettleJudgment = { accept: true, criteria: [], counterCase: '' };
        let calls = 0;
        // Where the cards order every subject strictly, they are the verdict: no call.
        if (!check.decided) {
          rollDay();
          if (spent >= budget) return { status: 'budget', calls: 0 };
          if (!allow(source)) return { status: 'limited', calls: 0 };
          spent += 1;
          calls = 1;
          const raw = await within(model(buildSettlePrompt(req, resolved)).catch(() => null), deps.timeoutMs ?? SETTLE_TIMEOUT_MS);
          if (raw === null) {
            log(`[verdicts] settle call failed: ${key}`);
            return { status: 'failed', calls };
          }
          judgment = readJudgment(raw);
          if (!judgment.accept) {
            refused.set(key, now());
            log(`[verdicts] refused: ${key}`);
            return { status: 'refused', calls };
          }
        }

        const eraTimes = [...built.values()].sort();
        await deps.db.write({
          verdict_key: key,
          kind: req.kind,
          criterion: req.criterion,
          subject_set: subjectSet(req.subjects),
          scope_key: req.scope?.key ?? null,
          subjects: resolved.map((r) => ({ key: r.subject.key, label: r.label })),
          verdict: req.verdict,
          criteria: judgment.criteria,
          counter_case: judgment.counterCase,
          fingerprint,
          era_mark: eraTimes.length ? eraTimes[eraTimes.length - 1] : null,
          status: 'current',
          departures: 0,
          version: DEBATE_VERDICT_VERSION,
          settled_at: new Date(now()).toISOString(),
        });
        departed.delete(key);
        log(`[verdicts] stored ${key} (${calls} calls; ${spent} of ${budget} today)`);
        return { status: 'stored', calls };
      } finally {
        inFlight.delete(key);
      }
    },

    async depart(body, source) {
      if (!enabled) return 'ignored';
      const req = readDepartureRequest(body);
      if (!req) return 'ignored';
      rollDay();
      const count = departuresBySource.get(source) ?? 0;
      if (count >= DEPARTURES_PER_SOURCE_DAY) return 'ignored';
      const sources = departed.get(req.key) ?? new Set<string>();
      if (sources.has(source)) return 'ignored';
      const row = await deps.db.read(req.key).catch(() => null);
      if (!row) return 'ignored';
      departuresBySource.set(source, count + 1);
      sources.add(source);
      departed.set(req.key, sources);
      const contested = row.status === 'contested' || sources.size >= VERDICT_REOPEN_DEPARTURES;
      await deps.db.write({ ...row, departures: Math.min(1000, row.departures + 1), status: contested ? 'contested' : row.status });
      if (contested && row.status !== 'contested') log(`[verdicts] contested: ${req.key}`);
      return contested ? 'contested' : 'counted';
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Routes

type Req = { body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; end(): void };

/** `POST /api/debates/settle`: answers with the status only. */
export const settleHandler = (settler: VerdictSettler, sourceOf: (req: any) => string) => async (req: Req, res: Res) => {
  const outcome = await settler.settle(req.body, sourceOf(req)).catch(() => ({ status: 'failed' as const, calls: 0 }));
  res.status(outcome.status === 'invalid' ? 400 : 200).json({ status: outcome.status });
};

/** `POST /api/debates/departure`: always 204, whatever was counted. */
export const departureHandler = (settler: VerdictSettler, sourceOf: (req: any) => string) => async (req: Req, res: Res) => {
  await settler.depart(req.body, sourceOf(req)).catch(() => 'ignored');
  res.status(204).end();
};
