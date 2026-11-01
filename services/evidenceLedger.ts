/**
 * What a chat turn found out before writing: one numbered entry per piece of evidence (a club's
 * recent team, a player's season record, a web search) and the gaps where a lookup came back
 * empty. The writer reads it as <factual_foundation>; the ids let later stages trace a claim back
 * to its source. Pure functions.
 */

export type EvidenceKind = 'club_context' | 'player_record' | 'league_table' | 'card' | 'web' | 'prior_turn';

export interface EvidenceEntry {
  id: string;
  kind: EvidenceKind;
  /** What the entry is about: a club, a player, or the question a search asked. */
  label: string;
  content: string;
  sources?: string[];
}

export interface EvidenceLedger {
  entries: EvidenceEntry[];
  /** Lookups that returned nothing, so the writer knows what it doesn't know. */
  gaps: string[];
}

export const emptyLedger = (): EvidenceLedger => ({ entries: [], gaps: [] });

/** Adds an entry with the next id (E1, E2, …). Empty content is recorded as a gap instead. */
export function addEvidence(
  ledger: EvidenceLedger,
  entry: Omit<EvidenceEntry, 'id'>,
): EvidenceLedger {
  if (!entry.content.trim()) return addGap(ledger, entry.label);
  return { ...ledger, entries: [...ledger.entries, { ...entry, id: `E${ledger.entries.length + 1}` }] };
}

export function addGap(ledger: EvidenceLedger, label: string): EvidenceLedger {
  return ledger.gaps.includes(label) ? ledger : { ...ledger, gaps: [...ledger.gaps, label] };
}

export const hasEvidence = (ledger: EvidenceLedger | null | undefined): boolean =>
  Boolean(ledger && ledger.entries.length > 0);

const KIND_NAMES: Record<EvidenceKind, string> = {
  club_context: 'Live club data (ESPN, FPL)',
  player_record: 'Live player season (FPL)',
  league_table: 'League table (ESPN)',
  card: 'Futbolpedia dossier card',
  web: 'Web search',
  prior_turn: 'Earlier in this conversation',
};

/**
 * The ledger as the writer reads it. Gaps are listed even when nothing was found, so an empty
 * research pass reads as "these lookups failed", never as silence the model fills from memory.
 */
export function formatLedger(ledger: EvidenceLedger): string {
  const blocks = ledger.entries.map((e) => {
    const sources = e.sources?.length ? `\nSources: ${e.sources.join(' | ')}` : '';
    return `[${e.id}] ${KIND_NAMES[e.kind]} — ${e.label}\n${e.content.trim()}${sources}`;
  });
  if (ledger.gaps.length > 0) {
    blocks.push(
      `[Not found] These lookups returned nothing; treat their subjects as unverified unless a tool call finds them:\n${ledger.gaps
        .map((g) => `- ${g}`)
        .join('\n')}`,
    );
  }
  return blocks.join('\n\n');
}
