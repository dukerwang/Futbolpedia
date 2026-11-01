import type { LiveClubReport } from './liveFootball';

/**
 * What a chat turn found out before writing: one numbered entry per piece of evidence (a club's
 * recent team, a player's season record, a web search), the gaps where a lookup came back without
 * data, and a log of every lookup's status for the planner. The writer reads it as
 * <factual_foundation>; the ids let later stages trace a claim back to its source. Pure functions.
 */

export type EvidenceKind = 'club_context' | 'player_record' | 'league_table' | 'card' | 'web' | 'prior_turn';

/** Facts are the present (who plays, results, transfers, dates); analysis is read against them. */
export type ResearchStage = 'facts' | 'analysis';

export interface EvidenceEntry {
  id: string;
  kind: EvidenceKind;
  /** What the entry is about: a club, a player, or the question a search asked. */
  label: string;
  content: string;
  sources?: string[];
  stage?: ResearchStage;
  /** The structured report behind a club entry, for the situation snapshot. Never printed. */
  club?: LiveClubReport;
  /** The club a player record says he plays for, so research can look at that club too. */
  team?: string;
}

/**
 * How a lookup ended: data found, the source answered with nothing, no source covers it (asking
 * again won't help), or the call failed or was refused (a retry might work).
 */
export type LookupStatus = 'found' | 'empty' | 'not_covered' | 'failed';
export type GapStatus = Exclude<LookupStatus, 'found'>;

export interface EvidenceGap {
  label: string;
  status: GapStatus;
}

export interface LookupRecord {
  tool: string;
  subject: string;
  status: LookupStatus;
  /** What part of it had no data, when the lookup found something but not everything. */
  note?: string;
}

export interface EvidenceLedger {
  entries: EvidenceEntry[];
  /** Lookups, or parts of lookups, that returned no data, so the writer knows what it doesn't know. */
  gaps: EvidenceGap[];
  lookups: LookupRecord[];
  /** Web entries set aside because they describe an earlier season the live facts contradict. */
  discarded: { id: string; label: string; reason: string }[];
}

export const emptyLedger = (): EvidenceLedger => ({ entries: [], gaps: [], lookups: [], discarded: [] });

/** Adds an entry with the next id (E1, E2, …). Empty content is recorded as a gap instead. */
export function addEvidence(
  ledger: EvidenceLedger,
  entry: Omit<EvidenceEntry, 'id'>,
): EvidenceLedger {
  if (!entry.content.trim()) return addGap(ledger, entry.label);
  // Discarded entries keep their ids, so a new entry never reuses one.
  const id = `E${ledger.entries.length + ledger.discarded.length + 1}`;
  return { ...ledger, entries: [...ledger.entries, { ...entry, id }] };
}

export function addGap(ledger: EvidenceLedger, label: string, status: GapStatus = 'empty'): EvidenceLedger {
  return ledger.gaps.some((g) => g.label === label) ? ledger : { ...ledger, gaps: [...ledger.gaps, { label, status }] };
}

export const logLookup = (ledger: EvidenceLedger, record: LookupRecord): EvidenceLedger => ({
  ...ledger,
  lookups: [...ledger.lookups, record],
});

/** Removes web entries by id; live feed data, cards and earlier turns are never discarded. */
export function discardEntries(
  ledger: EvidenceLedger,
  items: { id: string; reason: string }[],
): EvidenceLedger {
  const drop = new Map(items.map((i) => [i.id.trim().toUpperCase(), i.reason]));
  const gone = ledger.entries.filter((e) => e.kind === 'web' && drop.has(e.id));
  if (gone.length === 0) return ledger;
  return {
    ...ledger,
    entries: ledger.entries.filter((e) => !gone.includes(e)),
    discarded: [...ledger.discarded, ...gone.map((e) => ({ id: e.id, label: e.label, reason: drop.get(e.id) ?? '' }))],
  };
}

export const hasEvidence = (ledger: EvidenceLedger | null | undefined): boolean =>
  Boolean(ledger && ledger.entries.length > 0);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * The publication dates a digest gives its points ("[2026-10-25]", "[October 2026]"), as
 * YYYY-MM-DD (a month alone counts as its first day). Undated points add nothing.
 */
export function sourceDates(text: string): string[] {
  const dates: string[] = [];
  for (const m of text.matchAll(/\[(\d{4})-(\d{2})-(\d{2})\]/g)) dates.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(/\[([A-Za-z]+)\s+(\d{4})\]/g)) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month >= 0) dates.push(`${m[2]}-${String(month + 1).padStart(2, '0')}-01`);
  }
  return dates;
}

/** The day a season's football starts, for judging which sources predate it: 1 July of its first year. */
export const seasonStartDate = (seasonStartYear: number): string => `${seasonStartYear}-07-01`;

/** Whether a web entry's sources all predate the season: it dates its points, and every date is earlier. */
export function isFromEarlierSeason(entry: Pick<EvidenceEntry, 'kind' | 'content'>, seasonStart: string): boolean {
  if (entry.kind !== 'web') return false;
  const dates = sourceDates(entry.content);
  return dates.length > 0 && dates.every((d) => d < seasonStart);
}

const KIND_NAMES: Record<EvidenceKind, string> = {
  club_context: 'Live club data (ESPN, FPL)',
  player_record: 'Live player season (FPL)',
  league_table: 'League table (ESPN)',
  card: 'Futbolpedia dossier card',
  web: 'Web search',
  prior_turn: 'Earlier in this conversation',
};

const GAP_HEADINGS: Record<GapStatus, string> = {
  not_covered: "[Not covered] No source covers these, so don't fill them from memory; say so where the answer depends on them:",
  failed: '[Lookup failed] These lookups failed or were refused; treat their subjects as unverified unless a tool call finds them:',
  empty: '[Not found] These lookups returned nothing; treat their subjects as unverified unless a tool call finds them:',
};

/**
 * The ledger as the writer reads it. Gaps are listed even when nothing was found, so an empty
 * research pass reads as "these lookups failed", never as silence the model fills from memory.
 * With `seasonStart`, a web entry whose sources all predate the season says so.
 */
export function formatLedger(ledger: EvidenceLedger, options: { seasonStart?: string } = {}): string {
  const blocks = ledger.entries.map((e) => {
    const sources = e.sources?.length ? `\nSources: ${e.sources.join(' | ')}` : '';
    const older =
      options.seasonStart && isFromEarlierSeason(e, options.seasonStart)
        ? ' (every source here predates this season, so it may describe an earlier team)'
        : '';
    return `[${e.id}] ${KIND_NAMES[e.kind]} — ${e.label}${older}\n${e.content.trim()}${sources}`;
  });
  for (const status of ['not_covered', 'failed', 'empty'] as const) {
    const gaps = ledger.gaps.filter((g) => g.status === status);
    if (gaps.length > 0) blocks.push(`${GAP_HEADINGS[status]}\n${gaps.map((g) => `- ${g.label}`).join('\n')}`);
  }
  return blocks.join('\n\n');
}

const STATUS_WORDS: Record<LookupStatus, string> = {
  found: 'found',
  empty: 'found nothing',
  not_covered: 'not covered by any source (asking again won’t help)',
  failed: 'failed (a retry might work)',
};

/** Every lookup so far and how it ended, for the reflect step. */
export const formatLookupLog = (ledger: EvidenceLedger): string =>
  ledger.lookups.map((l) => `- ${l.tool} "${l.subject}": ${STATUS_WORDS[l.status]}${l.note ? `; ${l.note}` : ''}`).join('\n');

/**
 * The ledger shortened for the quick steps (reflect, the situation snapshot): each entry's start,
 * with its stage and any earlier-season tag, then every gap.
 */
export function compactLedger(ledger: EvidenceLedger, options: { perEntry?: number; seasonStart?: string } = {}): string {
  const perEntry = options.perEntry ?? 900;
  return (
    formatLedger(
      {
        ...ledger,
        entries: ledger.entries.map((e) => ({
          ...e,
          label: e.stage === 'analysis' ? `${e.label} (analysis)` : e.label,
          content: e.content.length > perEntry ? `${e.content.slice(0, perEntry)}…` : e.content,
          sources: undefined,
        })),
      },
      { seasonStart: options.seasonStart },
    ) || 'Nothing yet.'
  );
}
