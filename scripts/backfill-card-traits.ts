#!/usr/bin/env npx tsx
/**
 * Rewrites the stock strengths and weaknesses on published cards (the lines that read the same as
 * lines on two or more other players' cards), and replaces or drops any other weakness that breaks
 * the card rules (services/cardTraits.ts). New cards get this check when they're rated; this
 * applies it to the cards rated before it existed.
 *
 * Two steps, so a person reads the rewrites before any card changes:
 *
 *   1. Propose (needs GEMINI_API_KEY; reads the cards with the publishable key):
 *        npx tsx scripts/backfill-card-traits.ts --out trait-backfill.json [--player "Name"] [--limit N] [--few-weaknesses]
 *      --few-weaknesses takes only the cards with fewer than MIN_WEAKNESSES weaknesses, so the
 *      rewrite adds the missing one.
 *      Writes every proposed rewrite, before and after, to the JSON report and a Markdown copy
 *      beside it. Nothing is written to Supabase.
 *
 *   2. Apply a reviewed report (needs SUPABASE_SECRET_KEY and the
 *      20261113120000_card_trait_rewrites migration):
 *        npx tsx scripts/backfill-card-traits.ts --apply trait-backfill.json
 *      Writes only strengths and weaknesses, to every row holding that card (pointer and archive),
 *      and only where the row still holds the lines the report was proposed from. Delete an entry
 *      from the report to leave that card as it is.
 *
 * Personal revisions ("--rev-" rows) are left alone: a person accepted them. Each player's card is
 * checked against the cards as they were when the run started, so the order cards are rewritten
 * in doesn't change which lines count as stock; the rewrite is also shown the lines just written
 * for other players at his position, so the run doesn't make a new stock line of its own. Cards copied into people's own dossiers (their
 * browser's storage) keep the lines they had.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import type { PlayerProfile } from '../types';
import { findTraitsToReview, MIN_WEAKNESSES, reviseCardTraits, traitTitle } from '../services/cardTraits';
import { supabasePublishableKey, supabaseUrl } from '../services/dossierCache';
import { toBasePlayerSlug } from '../services/dossierCards';

export interface CardRow {
  player_slug: string;
  player_data: PlayerProfile;
}

/** One card as it's published: every row that holds the same player with the same lines. */
export interface CardGroup {
  slugs: string[];
  card: PlayerProfile;
}

export interface BackfillEntry {
  player: string;
  edition: string;
  slugs: string[];
  before: { strengths: string[]; weaknesses: string[] };
  after: { strengths: string[]; weaknesses: string[] };
}

const traitsKey = (card: PlayerProfile): string =>
  JSON.stringify([card.strengths ?? [], card.weaknesses ?? []]);

/**
 * The published cards, one per player and set of lines: a pointer row and its archive row are the
 * same card. Personal revisions and rows without a player are skipped.
 */
export function groupCards(rows: CardRow[]): CardGroup[] {
  const groups = new Map<string, CardGroup>();
  for (const row of rows) {
    const card = row.player_data;
    if (!card?.basicInfo?.name || row.player_slug.includes('--rev-')) continue;
    const key = `${toBasePlayerSlug(card.basicInfo.name)}|${traitsKey(card)}`;
    const group = groups.get(key);
    if (group) group.slugs.push(row.player_slug);
    else groups.set(key, { slugs: [row.player_slug], card });
  }
  return [...groups.values()];
}

/** What the rewrite reads about an old card in place of the research it was rated from: its own prose. */
export function cardEvidence(card: PlayerProfile): string {
  return [
    card.version?.peakContext ? `Why this window: ${card.version.peakContext}` : '',
    card.shortBio ? `Bio: ${card.shortBio}` : '',
    card.latestUpdate ? `Latest update: ${card.latestUpdate}` : '',
    card.scoutingDebate ? `Case for higher: ${card.scoutingDebate.caseForHigher}\nCase for lower: ${card.scoutingDebate.caseForLower}` : '',
    card.archetypeAnalysis?.tacticalKryptonite ? `Tactical kryptonite: ${card.archetypeAnalysis.tacticalKryptonite}` : '',
    ...(card.definingMoments ?? []).map((m) => `Defining moment (${m.year}): ${m.title}. ${m.description}`),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Proposes the rewrite for one card; null when it has nothing to review or the rewrite changed
 * nothing. `written` holds the cards rewritten earlier in the run, so a new line doesn't repeat one
 * just written for another player at his position; a changed card is added to it.
 */
export async function proposeEntry(
  group: CardGroup,
  pool: PlayerProfile[],
  written: PlayerProfile[] = [],
): Promise<BackfillEntry | null> {
  if (findTraitsToReview(group.card, pool).length === 0) return null;
  const revised = await reviseCardTraits(group.card, pool, cardEvidence(group.card), { written });
  const before = { strengths: group.card.strengths ?? [], weaknesses: group.card.weaknesses ?? [] };
  const after = { strengths: revised.strengths ?? [], weaknesses: revised.weaknesses ?? [] };
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  written.push(revised);
  return {
    player: group.card.basicInfo.name,
    edition: group.card.version?.label ?? group.card.version?.type ?? 'card',
    slugs: group.slugs,
    before,
    after,
  };
}

/** A report as Markdown, for reading the rewrites before they're applied. */
export function reportMarkdown(entries: BackfillEntry[]): string {
  const section = (e: BackfillEntry) => {
    const lines: string[] = [`## ${e.player}: ${e.edition}`, '', `Rows: ${e.slugs.join(', ')}`, ''];
    for (const kind of ['strengths', 'weaknesses'] as const) {
      const before = e.before[kind];
      const after = e.after[kind];
      const removed = before.filter((l) => !after.includes(l));
      const added = after.filter((l) => !before.includes(l));
      if (removed.length === 0 && added.length === 0) continue;
      lines.push(`**${kind}**`, '');
      for (const l of removed) lines.push(`- ~~${l}~~`);
      for (const l of added) lines.push(`- ${l}`);
      lines.push('');
    }
    return lines.join('\n');
  };
  return `# Card trait backfill\n\n${entries.length} cards with rewritten lines.\n\n${entries.map(section).join('\n')}`;
}

/** What applying one entry to one row did. */
export type ApplyOutcome = 'updated' | 'changed_since' | 'missing' | 'blocked' | 'failed';

/** The client calls `applyEntry` makes, so a test can stand in for Supabase. */
export interface CardStore {
  read(slug: string): Promise<PlayerProfile | null>;
  /** Writes the card; returns the card the row holds afterwards, or null when no row was updated. */
  write(slug: string, card: PlayerProfile): Promise<PlayerProfile | null>;
}

/** Writes one entry's lines to each of its rows that still holds the lines it was proposed from. */
export async function applyEntry(store: CardStore, entry: BackfillEntry): Promise<Record<string, ApplyOutcome>> {
  const outcomes: Record<string, ApplyOutcome> = {};
  for (const slug of entry.slugs) {
    try {
      const current = await store.read(slug);
      if (!current) {
        outcomes[slug] = 'missing';
        continue;
      }
      if (traitsKey(current) !== JSON.stringify([entry.before.strengths, entry.before.weaknesses])) {
        outcomes[slug] = 'changed_since';
        continue;
      }
      const written = await store.write(slug, { ...current, strengths: entry.after.strengths, weaknesses: entry.after.weaknesses });
      outcomes[slug] =
        written && traitsKey(written) === JSON.stringify([entry.after.strengths, entry.after.weaknesses]) ? 'updated' : 'blocked';
    } catch (err) {
      console.warn(`[backfill] ${slug}: ${(err as Error).message}`);
      outcomes[slug] = 'failed';
    }
  }
  return outcomes;
}

// --- Command line -----------------------------------------------------------------------------

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function readAllRows(client: any): Promise<CardRow[]> {
  const rows: CardRow[] = [];
  const page = 500;
  for (let from = 0; ; from += page) {
    const { data, error } = await client
      .from('player_profiles')
      .select('player_slug, player_data')
      .order('player_slug')
      .range(from, from + page - 1);
    if (error) throw new Error(`Reading player_profiles failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < page) return rows;
  }
}

async function propose(): Promise<void> {
  const key = process.env.GEMINI_API_KEY ?? process.env.API_KEY;
  if (!key) throw new Error('Set GEMINI_API_KEY to propose rewrites.');
  process.env.API_KEY = key;
  const out = arg('--out') ?? `trait-backfill-${new Date().toISOString().slice(0, 10)}.json`;
  const only = arg('--player')?.toLowerCase();
  const limit = Number(arg('--limit') ?? Infinity);
  const fewOnly = process.argv.includes('--few-weaknesses');

  const client = createClient(supabaseUrl, process.env.SUPABASE_SECRET_KEY ?? supabasePublishableKey);
  const groups = groupCards(await readAllRows(client));
  const pool = groups.map((g) => g.card);
  const todo = groups
    .filter((g) => !only || g.card.basicInfo.name.toLowerCase().includes(only))
    .filter((g) => !fewOnly || (g.card.weaknesses ?? []).length < MIN_WEAKNESSES)
    .filter((g) => findTraitsToReview(g.card, pool).length > 0)
    .slice(0, limit);
  console.log(`${groups.length} published cards; ${todo.length} with lines to review.`);

  const entries: BackfillEntry[] = [];
  const written: PlayerProfile[] = [];
  // One card at a time, so each rewrite sees every line the run wrote before it.
  const concurrency = 1;
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < todo.length) {
        const group = todo[next++];
        const entry = await proposeEntry(group, pool, written).catch((err) => {
          console.warn(`[backfill] ${group.card.basicInfo.name}: ${(err as Error).message}`);
          return null;
        });
        if (entry) entries.push(entry);
        console.log(
          `${entry ? '✎' : '·'} ${group.card.basicInfo.name} (${group.slugs.length} row${group.slugs.length === 1 ? '' : 's'})` +
            (entry ? '' : ': unchanged'),
        );
      }
    }),
  );
  entries.sort((a, b) => a.player.localeCompare(b.player));
  writeFileSync(out, JSON.stringify(entries, null, 2));
  writeFileSync(out.replace(/\.json$/, '') + '.md', reportMarkdown(entries));
  console.log(`\nProposed rewrites for ${entries.length} cards: ${out} (and .md). Nothing was written to Supabase.`);
}

async function apply(path: string): Promise<void> {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error('Set SUPABASE_SECRET_KEY to apply a report.');
  const entries: BackfillEntry[] = JSON.parse(readFileSync(path, 'utf8'));
  const client: any = createClient(supabaseUrl, secret, { auth: { persistSession: false } });
  const store: CardStore = {
    async read(slug) {
      const { data, error } = await client.from('player_profiles').select('player_data').eq('player_slug', slug).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.player_data ?? null;
    },
    async write(slug, card) {
      const { data, error } = await client
        .from('player_profiles')
        .update({ player_data: card })
        .eq('player_slug', slug)
        .select('player_data');
      if (error) throw new Error(error.message);
      return data?.[0]?.player_data ?? null;
    },
  };

  const totals: Record<ApplyOutcome, number> = { updated: 0, changed_since: 0, missing: 0, blocked: 0, failed: 0 };
  for (const entry of entries) {
    const outcomes = await applyEntry(store, entry);
    for (const [slug, outcome] of Object.entries(outcomes)) {
      totals[outcome]++;
      if (outcome !== 'updated') console.log(`  ${slug}: ${outcome}`);
    }
    const changed = [...entry.before.strengths, ...entry.before.weaknesses]
      .filter((l) => ![...entry.after.strengths, ...entry.after.weaknesses].includes(l))
      .map((l) => `"${traitTitle(l)}"`);
    console.log(`${entry.player} (${entry.edition}): ${changed.join(', ')}`);
  }
  console.log(`\n${JSON.stringify(totals)}`);
  if (totals.blocked > 0) {
    console.log('Blocked rows were refused by the refresh-window trigger: apply the 20261113120000_card_trait_rewrites migration first.');
  }
}

if (process.argv[1]?.endsWith('backfill-card-traits.ts')) {
  const report = arg('--apply');
  (report ? apply(report) : propose()).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
