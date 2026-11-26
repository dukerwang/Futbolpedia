import type { PlayerProfile } from '../types';
import { describeCardEdition } from '../components/pills';
import { getShortTierLabel } from '../constants/ratingTiers';
import { getCardKey, toVersionedSlug } from './dossierCards';
import type { CardPage, ChatPage } from './sharePages';

/**
 * The tags that make a pasted link show a preview: title, description, canonical address, Open
 * Graph and Twitter card tags. The server writes them into index.html between the share-meta
 * markers. Every value is escaped: names and questions are typed by people.
 */

/** Where canonical addresses point, whichever host served the page. */
export const CANONICAL_ORIGIN = 'https://futbolpedia.org';
export const IMAGE_WIDTH = 1200;
export const IMAGE_HEIGHT = 630;

const DEFAULT_DESCRIPTION =
  "Your AI football analyst: a scouting report on any player from any era, and a real opinion on anything you ask.";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A short, stable hash (FNV-1a, 8 hex characters). */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Changes whenever the card's preview would: a re-rate (even one that keeps the evaluation date),
 * a new card, a refreshed Latest Update, or a changed share line or strengths.
 */
export function cardImageVersion(card: PlayerProfile): string {
  return shortHash(
    JSON.stringify([
      getCardKey(card),
      card.rerateAt ?? null,
      card.createdAt ?? null,
      card.latestUpdateAsOf ?? null,
      card.ratings?.overall ?? null,
      card.shareLine ?? null,
      (card.strengths ?? []).slice(0, 3),
    ]),
  );
}

export function chatImageVersion(page: Pick<ChatPage, 'title' | 'question' | 'replies' | 'cards'>): string {
  return shortHash(
    JSON.stringify([page.title, page.question, page.replies, page.cards.map((c) => [getCardKey(c), c.ratings?.overall])]),
  );
}

/** `/og/p/<archive slug>-<version>.png`, or null for an undated legacy card. */
export function cardImagePath(card: PlayerProfile): string | null {
  const slug = toVersionedSlug(card);
  return slug ? `/og/p/${encodeURIComponent(slug)}-${cardImageVersion(card)}.png` : null;
}

export function chatImagePath(page: ChatPage): string {
  return `/og/c/${page.code}-${chatImageVersion(page)}.png`;
}

/** Splits an image file name into its key and version, or null when it isn't one. */
export function parseImageFile(file: string): { key: string; version: string } | null {
  const m = file.match(/^(.+)-([0-9a-f]{8})\.png$/);
  if (!m) return null;
  try {
    return { key: decodeURIComponent(m[1]), version: m[2] };
  } catch {
    return null;
  }
}

/** "Bukayo Saka · 90 · Current Form": the name, the Overall and the edition without its date. */
export function cardTitle(card: PlayerProfile): string {
  const edition = describeCardEdition(card).label.split(' · ')[0];
  const overall = card.ratings?.overall;
  return [card.basicInfo?.name, overall ? String(overall) : null, edition].filter(Boolean).join(' · ');
}

function cardDescription(card: PlayerProfile): string {
  if (card.shareLine) return card.shareLine;
  const archetype = card.playstyleAndRole?.playstyle?.archetype?.trim();
  const overall = card.ratings?.overall;
  const tier = overall ? getShortTierLabel(overall) : '';
  const parts = [archetype, [card.basicInfo?.position, card.basicInfo?.club].filter(Boolean).join(', '), tier].filter(Boolean);
  return parts.length ? `${parts.join(' · ')}. Rated on Futbolpedia.` : DEFAULT_DESCRIPTION;
}

interface TagValues {
  title: string;
  description: string;
  canonical: string;
  image: string;
  robots?: string;
}

function tagBlock(v: TagValues): string {
  const e = escapeHtml;
  return [
    `<title>${e(v.title)}</title>`,
    `<meta name="description" content="${e(v.description)}">`,
    v.robots ? `<meta name="robots" content="${e(v.robots)}">` : '',
    `<link rel="canonical" href="${e(v.canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${e(v.canonical)}">`,
    `<meta property="og:title" content="${e(v.title)}">`,
    `<meta property="og:description" content="${e(v.description)}">`,
    `<meta property="og:image" content="${e(v.image)}">`,
    `<meta property="og:image:width" content="${IMAGE_WIDTH}">`,
    `<meta property="og:image:height" content="${IMAGE_HEIGHT}">`,
    `<meta property="og:site_name" content="Futbolpedia">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(v.title)}">`,
    `<meta name="twitter:description" content="${e(v.description)}">`,
    `<meta name="twitter:image" content="${e(v.image)}">`,
  ]
    .filter(Boolean)
    .join('\n    ');
}

/**
 * The fallback preview. The version changes with its picture, since messaging apps keep an image
 * they've fetched under its address.
 */
export const DEFAULT_IMAGE_PATH = '/og/default.png?v=2';

const absolute = (origin: string, path: string): string => `${origin.replace(/\/$/, '')}${path}`;

/**
 * `origin` is the host that served the page, so images load from the same server that drew them;
 * the canonical address is always futbolpedia.org.
 */
export function cardMeta(page: Extract<CardPage, { kind: 'card' }>, origin: string): string {
  const image = cardImagePath(page.card);
  return tagBlock({
    title: cardTitle(page.card),
    description: cardDescription(page.card),
    canonical: absolute(CANONICAL_ORIGIN, page.canonical),
    image: absolute(origin, image ?? DEFAULT_IMAGE_PATH),
  });
}

export function chatMeta(page: ChatPage, origin: string): string {
  return tagBlock({
    title: page.title,
    description: page.question || DEFAULT_DESCRIPTION,
    canonical: absolute(CANONICAL_ORIGIN, `/c/${page.code}`),
    image: absolute(origin, chatImagePath(page)),
  });
}

/** A missing card or chat: the default tags, kept out of search results. */
export function notFoundMeta(path: string, origin: string, player?: string): string {
  const name = player ? player.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : '';
  return tagBlock({
    title: name ? `${name} · Not rated yet · Futbolpedia` : 'Not found · Futbolpedia',
    description: name ? `Nobody has rated ${name} on Futbolpedia yet. Scout them and they join the shared library.` : DEFAULT_DESCRIPTION,
    canonical: absolute(CANONICAL_ORIGIN, path),
    image: absolute(origin, DEFAULT_IMAGE_PATH),
    robots: 'noindex',
  });
}

const START = /<!-- share-meta:start[^>]*-->/;
const END = '<!-- share-meta:end -->';
let warnedMissingMarkers = false;

/** Replaces the default tags between the share-meta markers. */
export function injectMeta(html: string, block: string): string {
  const start = html.match(START);
  const end = html.indexOf(END);
  if (!start || start.index === undefined || end < start.index) {
    if (!warnedMissingMarkers) {
      warnedMissingMarkers = true;
      console.warn('[share] index.html has no share-meta markers; serving default tags');
    }
    return html;
  }
  return `${html.slice(0, start.index)}${start[0]}\n    ${block}\n    ${html.slice(end)}`;
}
