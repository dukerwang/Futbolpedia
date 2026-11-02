import { Type } from '@google/genai';
import { generateStructured } from './aiClient';
import { supabase } from './dossierCache';
import { seasonSpan, toPlayerSlug } from './dossierCards';
import { compactLedger, emptyLedger, type EvidenceEntry } from './evidenceLedger';
import { executeCall, fileOutcomes, getLive, type ResearchCall, type ResearchToolset, type ToolOutcome } from './researchTools';

/**
 * Permanent era snapshots, shared by every user like the daily club snapshots but kept for good,
 * since the past doesn't change. Two kinds:
 *
 * - A club season: its usual XI and shape, coach, record, and what defined it.
 * - A player's window: his role and clubs across the seasons a card rates, his numbers and
 *   honours in them, and what defined him then.
 *
 * Each is built once, the first time research looks the season or window up, with a thorough
 * pass: the season or career record, two searches for analysis and contemporary accounts, and one
 * model call that writes the story from that evidence only. The server builds it and stores it
 * in the Supabase `era_snapshots` table, which browsers can read but not write. A row is replaced
 * only by a build under a newer `ERA_SNAPSHOT_VERSION`.
 */

/** Bump when a snapshot's shape or how it's built changes, so older rows are rebuilt. */
export const ERA_SNAPSHOT_VERSION = 1;

export type EraKind = 'club_season' | 'player_window';

export interface EraStory {
  /** What defined the season or the window, in two or three sentences. */
  summary: string;
  /** A club's shape and how it played; a player's role and how he played it. */
  setup: string;
  /** A club's usual XI by position and its coach; a player's clubs, coaches and key teammates. */
  people: string[];
  /** A club's league finish, points and cup runs; a player's honours and output in the window. */
  record: string;
  /** Precise figures exactly as the sources give them, each with where it comes from. */
  figures: string[];
  /** Claims often made about it that the sources don't support, and facts commonly put in the wrong season. */
  disputed: string[];
}

export interface EraSnapshot {
  key: string;
  kind: EraKind;
  /** The club or player, as the source article names them. */
  subject: string;
  /** The season ("2003-04") or window ("1998-01"). */
  period: string;
  story: EraStory;
  sources: string[];
  builtAt: string;
  version: number;
}

export interface EraRow {
  snapshot_key: string;
  kind: string;
  subject: string;
  period: string;
  snapshot: Record<string, unknown>;
  version: number;
  built_at: string;
}

/** A season or window written one way, so "2003-2006" and "2003-06" share a snapshot. */
export function normalizePeriod(period: string): string | null {
  const span = seasonSpan(period.replace(/[–—]/g, '-').replace(/\s+/g, ''));
  if (span) return `${span[0]}-${String((span[1] + 1) % 100).padStart(2, '0')}`;
  // A span written as its first and last season ("1998-99 to 2000-01").
  const seasons = [...period.matchAll(/\b((?:19|20)\d{2})(?:\s*[-/–]\s*\d{2,4})?\b/g)].map((m) => Number(m[1]));
  if (seasons.length >= 2 && seasons[seasons.length - 1] > seasons[0]) {
    return `${seasons[0]}-${String((seasons[seasons.length - 1] + 1) % 100).padStart(2, '0')}`;
  }
  return null;
}

/** The subject an article title names: "2003–04 Arsenal F.C. season" is Arsenal F.C.; "(footballer)" is dropped. */
export const subjectFromTitle = (title: string, kind: EraKind): string =>
  kind === 'club_season'
    ? title.replace(/^\d{4}[–-]\d{2,4}\s+/, '').replace(/\s+season$/i, '').trim()
    : title.replace(/\s*\(.*?\)\s*$/, '').trim();

export const eraKey = (kind: EraKind, subject: string, period: string): string => `${kind}:${toPlayerSlug(subject)}:${period}`;

export const snapshotToRow = (s: EraSnapshot): EraRow => ({
  snapshot_key: s.key,
  kind: s.kind,
  subject: s.subject,
  period: s.period,
  snapshot: { story: s.story, sources: s.sources },
  version: s.version,
  built_at: s.builtAt,
});

const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, max) : []);

export function rowToSnapshot(row: EraRow | null): EraSnapshot | null {
  const story = row?.snapshot?.story as Partial<EraStory> | undefined;
  if (!row || (row.kind !== 'club_season' && row.kind !== 'player_window') || !story?.summary) return null;
  return {
    key: row.snapshot_key,
    kind: row.kind,
    subject: row.subject,
    period: row.period,
    story: {
      summary: String(story.summary),
      setup: String(story.setup ?? ''),
      people: strings(story.people, 16),
      record: String(story.record ?? ''),
      figures: strings(story.figures, 16),
      disputed: strings(story.disputed, 8),
    },
    sources: strings(row.snapshot.sources, 10),
    builtAt: row.built_at,
    version: row.version,
  };
}

/** What a turn asks for: a club season or a player's window, and the lookup that fetched its facts. */
export interface EraRequest {
  kind: EraKind;
  subject: string;
  period: string;
  facts: Promise<ToolOutcome>;
}

export interface EraSnapshotSource {
  /** The stored snapshot, without building one. */
  stored(req: EraRequest): Promise<EraSnapshot | null>;
  /** The stored snapshot, else a new build that is stored for everyone. */
  get(req: EraRequest): Promise<EraSnapshot | null>;
}

export interface EraStoreDeps {
  read(key: string): Promise<EraRow | null>;
  write(row: EraRow): Promise<void>;
  build(req: { kind: EraKind; subject: string; period: string; key: string }, facts: ToolOutcome): Promise<EraSnapshot | null>;
  now?: () => number;
}

/** A failed build is retried this soon, and never stored. */
const FAILED_RETRY_MS = 10 * 60 * 1000;

/**
 * The store: memory, then the shared row, then a build. A request is keyed by the article its
 * facts came from, so "Arsenal" and "Arsenal FC" share a season. Concurrent requests share one
 * read and one build.
 */
export function createEraSnapshotStore(deps: EraStoreDeps): EraSnapshotSource {
  const now = deps.now ?? Date.now;
  const memory = new Map<string, { snapshot: EraSnapshot | null; expiresAt: number }>();
  const reads = new Map<string, Promise<EraSnapshot | null>>();
  const builds = new Map<string, Promise<EraSnapshot | null>>();

  const resolve = async (req: EraRequest): Promise<{ key: string; subject: string; period: string; facts: ToolOutcome } | null> => {
    const facts = await req.facts.catch(() => null);
    const period = normalizePeriod(req.period);
    if (!facts?.result || !period) return null;
    const subject = subjectFromTitle(facts.result.label, req.kind) || req.subject;
    return { key: eraKey(req.kind, subject, period), subject, period, facts };
  };
  const readKey = (key: string): Promise<EraSnapshot | null> => {
    const hit = memory.get(key);
    if (hit && hit.expiresAt > now()) return Promise.resolve(hit.snapshot);
    const pending = reads.get(key);
    if (pending) return pending;
    const job = deps
      .read(key)
      .then((row) => {
        const snapshot = row && row.version === ERA_SNAPSHOT_VERSION ? rowToSnapshot(row) : null;
        if (snapshot) memory.set(key, { snapshot, expiresAt: Infinity });
        return snapshot;
      })
      .catch((e) => {
        console.warn('[EraSnapshots] Read failed:', e);
        return null;
      })
      .finally(() => reads.delete(key));
    reads.set(key, job);
    return job;
  };

  async function stored(req: EraRequest): Promise<EraSnapshot | null> {
    const r = await resolve(req);
    return r ? readKey(r.key) : null;
  }

  async function get(req: EraRequest): Promise<EraSnapshot | null> {
    const r = await resolve(req);
    if (!r) return null;
    const hit = await readKey(r.key);
    if (hit) return hit;
    const cached = memory.get(r.key);
    if (cached && cached.expiresAt > now()) return cached.snapshot;
    const pending = builds.get(r.key);
    if (pending) return pending;
    const job = (async () => {
      const snapshot = await deps.build({ kind: req.kind, subject: r.subject, period: r.period, key: r.key }, r.facts).catch((e) => {
        console.warn(`[EraSnapshots] Build failed for ${r.key}:`, e);
        return null;
      });
      memory.set(r.key, { snapshot, expiresAt: snapshot ? Infinity : now() + FAILED_RETRY_MS });
      if (snapshot) await deps.write(snapshotToRow(snapshot)).catch((e) => console.warn('[EraSnapshots] Write failed:', e));
      return snapshot;
    })().finally(() => builds.delete(r.key));
    builds.set(r.key, job);
    return job;
  }

  return { stored, get };
}

// ---------------------------------------------------------------------------------------------
// Building one

const STORY_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    setup: { type: Type.STRING },
    people: { type: Type.ARRAY, items: { type: Type.STRING } },
    record: { type: Type.STRING },
    figures: { type: Type.ARRAY, items: { type: Type.STRING } },
    disputed: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['summary', 'setup', 'people', 'record', 'figures', 'disputed'],
};

export const buildEraPrompt = (req: { kind: EraKind; subject: string; period: string }, evidence: string): string => {
  const what = req.kind === 'club_season' ? `${req.subject}'s ${req.period} season` : `${req.subject} across ${req.period}`;
  return `You are writing a permanent reference note on ${what}, for a football analyst who will rely on it in debates. Use only the evidence below. Where the evidence doesn't establish something, leave it out rather than filling it from memory.

${
  req.kind === 'club_season'
    ? `1. summary: what defined the season, in two or three sentences.
2. setup: the shape the side usually played and how it played, in and out of possession.
3. people: the coach, then the usual XI as "position: player", from who started most often; name a second player only where two genuinely shared a role.
4. record: the league finish with points, and how far each cup run went.`
    : `1. summary: what defined him across these seasons, in two or three sentences.
2. setup: his role and position, and how he played it.
3. people: his club or clubs in these seasons, his coaches, and the teammates he played with most.
4. record: what he won in these seasons and his output in them.`
}
5. figures: precise figures for these seasons only (goals, appearances, points, records, dates), each copied exactly as a source gives it and followed by the source in brackets. Never total or average figures yourself, and never take one from another season.
6. disputed: claims often made about ${what} that the evidence contradicts or doesn't support, and facts the evidence places in a different season or spell than people often put them. Leave it empty when there are none.

<evidence>
${evidence}
</evidence>`;
};

export interface EraModel {
  write(req: { kind: EraKind; subject: string; period: string }, evidence: string): Promise<EraStory | null>;
}

export const liveEraModel: EraModel = {
  async write(req, evidence) {
    const raw = await generateStructured<any>({
      task: 'routing',
      prompt: buildEraPrompt(req, evidence),
      schema: STORY_SCHEMA,
      thinkingLevelOverride: 'medium',
      temperatureOverride: 0.2,
    });
    if (typeof raw?.summary !== 'string' || !raw.summary.trim()) return null;
    return {
      summary: raw.summary.trim(),
      setup: typeof raw.setup === 'string' ? raw.setup.trim() : '',
      people: strings(raw.people, 16),
      record: typeof raw.record === 'string' ? raw.record.trim() : '',
      figures: strings(raw.figures, 16),
      disputed: strings(raw.disputed, 8),
    };
  },
};

/** The searches a build adds to the season or career record. */
export function eraSearches(req: { kind: EraKind; subject: string; period: string }): ResearchCall[] {
  return req.kind === 'club_season'
    ? [
        { tool: 'web_search', subject: `${req.subject} ${req.period} season tactical analysis: formation, how the team played, key players and their roles`, stage: 'analysis' },
        { tool: 'web_search', subject: `${req.subject} ${req.period} season review: what defined it, key matches, and common misconceptions about it`, stage: 'analysis' },
      ]
    : [
        { tool: 'web_search', subject: `${req.subject} ${req.period}: his role, form and influence in those seasons, contemporary match reports and analysis`, stage: 'analysis' },
        { tool: 'web_search', subject: `${req.subject} ${req.period} season by season: goals, assists, honours and what defined him then`, stage: 'facts' },
      ];
}

/**
 * A snapshot from the facts already fetched plus two searches and one call at medium thinking.
 * It runs in the background of the turn that first asks, so its time is the next turn's gain.
 */
export async function buildEraSnapshot(
  req: { kind: EraKind; subject: string; period: string; key: string },
  facts: ToolOutcome,
  tools: ResearchToolset,
  model: EraModel = liveEraModel,
  now: () => number = Date.now,
): Promise<EraSnapshot | null> {
  if (!facts.result) return null;
  const start = now();
  const searches = eraSearches(req);
  const outcomes = await Promise.all(searches.map((c) => executeCall(c, tools, c.stage === 'analysis' ? facts.result!.content.slice(0, 2500) : undefined)));
  const ledger = fileOutcomes(emptyLedger(), [{ tool: req.kind === 'club_season' ? 'club_season' : 'player_career', subject: req.subject, season: req.period }, ...searches], [facts, ...outcomes]);
  const story = await model.write(req, compactLedger(ledger, { perEntry: 6_000 }));
  if (!story) return null;
  console.log(`[Perf] era snapshot build "${req.key}": ${now() - start}ms`);
  return {
    key: req.key,
    kind: req.kind,
    subject: req.subject,
    period: req.period,
    story,
    sources: ledger.entries.flatMap((e) => e.sources ?? []).slice(0, 10),
    builtAt: new Date(now()).toISOString(),
    version: ERA_SNAPSHOT_VERSION,
  };
}

/** A snapshot as an evidence entry for the writer. */
export function eraEntry(s: EraSnapshot): Omit<EvidenceEntry, 'id'> {
  const lines = [
    `What defined it: ${s.story.summary}`,
    s.story.setup && `${s.kind === 'club_season' ? 'Shape and style' : 'Role'}: ${s.story.setup}`,
    s.story.people.length && `${s.kind === 'club_season' ? 'Coach and usual XI' : 'Clubs, coaches and teammates'}: ${s.story.people.join('; ')}`,
    s.story.record && `Record: ${s.story.record}`,
    s.story.figures.length && `Figures from the sources:\n${s.story.figures.map((f) => `- ${f}`).join('\n')}`,
    s.story.disputed.length && `Often misstated:\n${s.story.disputed.map((d) => `- ${d}`).join('\n')}`,
  ].filter(Boolean);
  return {
    kind: 'era_snapshot',
    label: `${s.subject}, ${s.period}${s.kind === 'player_window' ? ' (the window his card rates)' : ''}`,
    content: lines.join('\n'),
    sources: s.sources,
    stage: 'facts',
  };
}

// ---------------------------------------------------------------------------------------------
// Settled debates

/**
 * A debate's settled brief, so the same question gets the same verdict. Keyed by the question's
 * words (order and case don't matter) and the cards in play, so a re-rated card reopens it.
 */
export interface DebateRecord {
  signature: string;
  cards: string;
  brief: Record<string, unknown>;
  settledAt: string;
  version: number;
}

const SIGNATURE_FILLER = new Set(
  'a an and are as at be best better by did do does for from good great greatest has have he his how i in is it me of on or rank ranking the their them they this to top was were what which who whom whose why with would you your'.split(' '),
);

/**
 * A question's words without filler, accents or order, so "Prime Zidane or prime Kaká?" and
 * "prime kaka or prime zidane" settle the same debate. Numbers stay, so "top five" and "top ten"
 * don't.
 */
export function debateSignature(message: string): string {
  const words = message
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !SIGNATURE_FILLER.has(w));
  return [...new Set(words)].sort().join(' ');
}

/** The cards in play as a short fingerprint: each card's player, edition and Overall. */
export const cardFingerprint = (cards: { slug: string; edition: string; overall: number }[]): string =>
  cards
    .map((c) => `${c.slug}:${c.edition}:${c.overall}`)
    .sort()
    .join(',') || 'none';

export const debateKey = (signature: string, cards: string): string => {
  // A short stable hash keeps the key under the column's length limit.
  let h = 2166136261;
  for (const ch of `${signature}|${cards}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `debate:${h.toString(36)}:${signature.slice(0, 120)}`;
};

export interface DebateStore {
  read(signature: string, cards: string): Promise<DebateRecord | null>;
  /** Whether the question has been settled under any cards, so an early brief can be skipped. */
  settledAny(signature: string): Promise<boolean>;
  write(record: DebateRecord): Promise<void>;
}

export function createDebateStore(deps: {
  read(key: string): Promise<EraRow | null>;
  write(row: EraRow): Promise<void>;
  /** Whether any debate row has this signature. */
  anyWithSubject?(subject: string): Promise<boolean>;
}): DebateStore {
  const memory = new Map<string, DebateRecord>();
  return {
    async settledAny(signature) {
      if ([...memory.values()].some((r) => r.signature === signature)) return true;
      return deps.anyWithSubject ? deps.anyWithSubject(signature.slice(0, 200)).catch(() => false) : false;
    },
    async read(signature, cards) {
      const key = debateKey(signature, cards);
      const hit = memory.get(key);
      if (hit) return hit;
      const row = await deps.read(key).catch(() => null);
      const brief = row?.snapshot?.brief;
      if (!row || row.version !== ERA_SNAPSHOT_VERSION || !brief || typeof brief !== 'object') return null;
      const record: DebateRecord = { signature, cards, brief: brief as Record<string, unknown>, settledAt: row.built_at, version: row.version };
      memory.set(key, record);
      return record;
    },
    async write(record) {
      const key = debateKey(record.signature, record.cards);
      memory.set(key, record);
      await deps
        .write({ snapshot_key: key, kind: 'debate', subject: record.signature.slice(0, 200), period: record.cards.slice(0, 40), snapshot: { brief: record.brief }, version: record.version, built_at: record.settledAt })
        .catch((e) => console.warn('[EraSnapshots] Debate write failed:', e));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The live stores

/** Whether a Supabase error says the table doesn't exist (the migration hasn't been applied). */
export const isMissingTable = (error: { code?: string; message?: string } | null | undefined): boolean =>
  Boolean(error && (error.code === 'PGRST205' || error.code === '42P01' || /does not exist|could not find the table/i.test(error.message ?? '')));

/** A build takes two searches and a model call on the server; past this the turn stops waiting. */
const SERVER_BUILD_TIMEOUT_MS = 60_000;

/**
 * Era snapshots: stored rows are read from Supabase, and builds run on the server
 * (`services/snapshotServer.ts`), which alone can write the table. The server only builds once
 * the `era_snapshots` migration is applied, since a snapshot it can't store would be paid for
 * again by every later question.
 */
export const liveEraSnapshots: EraSnapshotSource = createEraSnapshotStore({
  async read(key) {
    if (!supabase) return null;
    const { data } = await supabase.from('era_snapshots').select('*').eq('snapshot_key', key).maybeSingle();
    return data ?? null;
  },
  // The server stored it when it built it.
  write: async () => {},
  async build(req) {
    const res = await getLive<{ snapshot: EraSnapshot | null }>(
      `/api/snapshots/era?${new URLSearchParams({ kind: req.kind, subject: req.subject, period: req.period })}`,
      SERVER_BUILD_TIMEOUT_MS,
    );
    return 'data' in res ? res.data.snapshot : null;
  },
});

/**
 * Settled debates, kept for the browser session. A debate's brief is written in the browser from
 * the cards and the question, so the server can't vouch for it, and a stored one would let anyone
 * write the verdict every user gets. Across sessions, consistency comes from the card ratings.
 */
export const liveDebateRecords: DebateStore = createDebateStore({ read: async () => null, write: async () => {} });
