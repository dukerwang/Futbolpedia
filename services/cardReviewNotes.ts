import { supabase } from './dossierCache';
import { toBasePlayerSlug } from './dossierCards';
import { addEvidence, type EvidenceLedger } from './evidenceLedger';

/**
 * Card reviews as chat evidence. When the scout re-rates a card (services/cardReview.ts), the
 * review is a row in `card_reviews`, which browsers can read but not write. A turn that files a
 * card's evidence also files the latest published review of that card (or of a player the turn is
 * about) from the last 90 days as a dated `card_review` entry, so chat can say why a rating
 * changed from the record rather than from memory.
 */

/** A published review is filed for this many days after it published. */
export const REVIEW_EVIDENCE_DAYS = 90;
/** Reviews filed for one turn, newest first. */
const MAX_REVIEWS_PER_TURN = 3;
/** A turn waits this long for the table before it goes without reviews. */
const REVIEWS_TIMEOUT_MS = 1_500;
const CACHE_MS = 5 * 60 * 1000;

export interface PublishedReview {
  day: string;
  action: 'rerate_current' | 'review_prime';
  player: string;
  player_slug: string;
  edition: string;
  card_key: string;
  published_card_key: string | null;
  published_at: string;
  reason: string;
  verdict: 'accept' | 'rerated';
  reasons: string[];
  old_overall: number | null;
  new_overall: number | null;
}

export interface CardReviewSource {
  /** Published reviews since `sinceIso` for any of these players (by base slug), newest first. */
  published(playerSlugs: string[], sinceIso: string): Promise<PublishedReview[]>;
}

/** The table through the app's Supabase client (the publishable key in a browser, the server's read client there). */
export function liveCardReviews(now: () => number = Date.now): CardReviewSource {
  const cache = new Map<string, { expiresAt: number; rows: PublishedReview[] }>();
  return {
    async published(playerSlugs, sinceIso) {
      const client = supabase;
      const slugs = [...new Set(playerSlugs.filter(Boolean))].slice(0, 12);
      if (!client || slugs.length === 0) return [];
      const key = `${sinceIso.slice(0, 10)}|${[...slugs].sort().join(',')}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.rows;
      const { data, error } = await client
        .from('card_reviews')
        .select('day, action, player, player_slug, edition, card_key, published_card_key, published_at, reason, verdict, reasons, old_overall, new_overall')
        .eq('published', true)
        .in('player_slug', slugs)
        .gte('published_at', sinceIso)
        .order('published_at', { ascending: false })
        .limit(12);
      // A table that isn't there yet (its migration isn't applied) reads as no reviews.
      const rows: PublishedReview[] = error || !Array.isArray(data) ? [] : (data as PublishedReview[]);
      cache.set(key, { expiresAt: now() + CACHE_MS, rows });
      return rows;
    },
  };
}

const editionWords = (edition: string): string =>
  edition === 'current' ? 'current-form' : edition === 'season_snapshot' ? 'season' : edition;

/** A published review as an evidence entry: dated, with why it was opened and the Overall before and after. */
export function cardReviewEntry(r: PublishedReview): Parameters<typeof addEvidence>[1] {
  const day = r.published_at.slice(0, 10);
  const move =
    r.old_overall != null && r.new_overall != null
      ? `from Overall ${r.old_overall} to Overall ${r.new_overall}`
      : 'to a new card';
  const how =
    r.action === 'review_prime'
      ? `The scout drafted the new rating and a separate reviewer accepted it before it was published. The reviewer's reasons: ${r.reasons.join(' ')}`
      : 'The previous card had reached the end of its rating window, so it was rated again through the same pipeline as any request.';
  return {
    kind: 'card_review',
    label: `${r.player}, ${editionWords(r.edition)} card: re-rated ${day}`,
    content: `On ${day} the scout re-rated ${r.player}'s ${editionWords(r.edition)} card ${move}. Why it was reviewed: ${r.reason}\n${how}`,
    stage: 'facts',
  };
}

/**
 * The ledger with the latest published review of each card it names (by card key) and each player
 * the turn is about, from the last `REVIEW_EVIDENCE_DAYS` days: one per player and edition, newest
 * first, an exact card match before a player match. A table that is slow or down leaves the ledger
 * as it was.
 */
export async function fileCardReviews(
  ledger: EvidenceLedger,
  wanted: { cardKeys: string[]; players: string[] },
  source: CardReviewSource,
  nowMs: number = Date.now(),
): Promise<EvidenceLedger> {
  const keys = new Set(wanted.cardKeys.filter(Boolean));
  const slugs = [
    ...new Set([...[...keys].map((k) => k.split(':')[0]), ...wanted.players.map((p) => toBasePlayerSlug(p))].filter(Boolean)),
  ];
  if (slugs.length === 0) return ledger;
  const since = new Date(nowMs - REVIEW_EVIDENCE_DAYS * 86_400_000).toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rows = await Promise.race([
    source.published(slugs, since).catch(() => [] as PublishedReview[]),
    new Promise<PublishedReview[]>((resolve) => {
      timer = setTimeout(() => resolve([]), REVIEWS_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  const players = new Set(wanted.players.map((p) => toBasePlayerSlug(p)));
  const exact = (r: PublishedReview) => !!r.published_card_key && keys.has(r.published_card_key);
  const picked = new Map<string, PublishedReview>();
  for (const r of rows
    .filter((r) => r.published_at >= since && (exact(r) || players.has(r.player_slug)))
    .sort((a, b) => Number(exact(b)) - Number(exact(a)) || b.published_at.localeCompare(a.published_at))) {
    const id = `${r.player_slug}|${r.edition}`;
    if (!picked.has(id)) picked.set(id, r);
  }
  return [...picked.values()].slice(0, MAX_REVIEWS_PER_TURN).reduce((acc, r) => addEvidence(acc, cardReviewEntry(r)), ledger);
}
