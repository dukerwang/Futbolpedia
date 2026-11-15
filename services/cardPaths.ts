import type { PlayerProfile } from '../types';
import { cardEdition, getDossierEvaluationDate, toBasePlayerSlug } from './dossierCards';

/**
 * Futbolpedia's shareable addresses, read the same way in the browser and on the server:
 * `/p/<player>` (the player's default card), `/p/<player>/prime`, `/p/<player>/era/<YYYY-YY>`,
 * `/p/<player>/season/<YYYY-YY>`, `/p/<player>/<YYYY-MM-DD>` (one earlier rating) and
 * `/c/<code>` (a shared conversation). Pure: no reads, no clock unless one is passed in.
 */

export type CardAddressEdition = 'default' | 'prime' | 'era' | 'season' | 'dated';

export interface CardAddress {
  /** `toBasePlayerSlug` of the player's name. */
  player: string;
  edition: CardAddressEdition;
  /** An era's window or a season, YYYY-YY. */
  window?: string;
  /** A dated address's evaluation date, YYYY-MM-DD. */
  date?: string;
}

export type ParsedAddress =
  | { kind: 'card'; address: CardAddress; canonical: boolean }
  | { kind: 'chat'; code: string; canonical: boolean }
  | null;

/** A current card stays its player's default card for this long after its evaluation date. */
export const DEFAULT_CURRENT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const PLAYER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOW_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Za-z0-9]{4,16}$/;

const isRealDate = (s: string): boolean => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * Reads an address. `canonical` is false when the address only differs from its canonical form
 * by case or a trailing slash, so the server can redirect to the one spelling.
 */
export function parsePath(pathname: string): ParsedAddress {
  let raw: string;
  try {
    raw = decodeURIComponent(pathname.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const trimmed = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  if (parts[0] === 'c' && parts.length === 2 && CODE_RE.test(parts[1])) {
    const code = parts[1].toUpperCase();
    return { kind: 'chat', code, canonical: raw === `/c/${code}` };
  }
  if (parts[0] !== 'p') return null;

  const player = parts[1].toLowerCase();
  if (!PLAYER_RE.test(player)) return null;
  const rest = parts.slice(2).map((s) => s.toLowerCase());

  let address: CardAddress | null = null;
  if (rest.length === 0) address = { player, edition: 'default' };
  else if (rest.length === 1 && rest[0] === 'prime') address = { player, edition: 'prime' };
  else if (rest.length === 1 && isRealDate(rest[0])) address = { player, edition: 'dated', date: rest[0] };
  else if (rest.length === 2 && (rest[0] === 'era' || rest[0] === 'season') && WINDOW_RE.test(rest[1])) {
    address = { player, edition: rest[0], window: rest[1] };
  }
  if (!address) return null;
  return { kind: 'card', address, canonical: raw === addressPath(address) };
}

/** The one spelling of an address. */
export function addressPath(a: CardAddress): string {
  const base = `/p/${a.player}`;
  switch (a.edition) {
    case 'default':
      return base;
    case 'prime':
      return `${base}/prime`;
    case 'dated':
      return `${base}/${a.date}`;
    default:
      return `${base}/${a.edition}/${a.window}`;
  }
}

export const chatPath = (code: string): string => `/c/${code.toUpperCase()}`;

/** A season or window as YYYY-YY ("2017-2020" and "2017-20" both become "2017-20"). */
export function shortWindow(s: string | null | undefined): string | null {
  const m = s?.trim().match(/^(\d{4})\s*[-/–]\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  return `${m[1]}-${m[2].slice(-2)}`;
}

/** True while a current card is still its player's default card. */
export function isFreshCurrent(card: PlayerProfile, nowMs: number = Date.now()): boolean {
  if (cardEdition(card) !== 'current') return false;
  const date = getDossierEvaluationDate(card);
  return !!date && nowMs - Date.parse(`${date}T00:00:00Z`) < DEFAULT_CURRENT_DAYS * DAY_MS;
}

/**
 * What `/p/<player>` opens: the current card if it was rated in the last DEFAULT_CURRENT_DAYS,
 * otherwise the prime, otherwise the current card however old. Decided without a career-status
 * lookup: a retired player's current card stops being refreshed, so the default moves to their prime.
 */
export function pickDefaultCard(
  cards: { current?: PlayerProfile | null; prime?: PlayerProfile | null },
  nowMs: number = Date.now(),
): PlayerProfile | null {
  const { current, prime } = cards;
  if (current && isFreshCurrent(current, nowMs)) return current;
  return prime ?? current ?? null;
}

/**
 * A card's own address. A current card rated in the last DEFAULT_CURRENT_DAYS is its player's
 * default card; an older one keeps its dated address. A prime is `/prime` unless it has been
 * re-rated away (`superseded`), when only its dated address still opens it.
 */
export function cardPath(
  card: PlayerProfile,
  options: { nowMs?: number; superseded?: boolean } = {},
): string | null {
  const player = toBasePlayerSlug(card.basicInfo?.name ?? '');
  if (!player) return null;
  const edition = cardEdition(card);
  const date = getDossierEvaluationDate(card);
  if (edition === 'current') {
    if (isFreshCurrent(card, options.nowMs)) return addressPath({ player, edition: 'default' });
    return date ? addressPath({ player, edition: 'dated', date }) : null;
  }
  if (edition === 'prime') {
    if (options.superseded) return date ? addressPath({ player, edition: 'dated', date }) : null;
    return addressPath({ player, edition: 'prime' });
  }
  const window = shortWindow(card.version?.seasonOrEra);
  if (!window) return date ? addressPath({ player, edition: 'dated', date }) : null;
  return addressPath({ player, edition: edition === 'era' ? 'era' : 'season', window });
}

/** A card's pinned address, for its place in a player's earlier ratings. */
export function datedCardPath(card: PlayerProfile): string | null {
  const player = toBasePlayerSlug(card.basicInfo?.name ?? '');
  const date = getDossierEvaluationDate(card);
  return player && date ? addressPath({ player, edition: 'dated', date }) : null;
}

/**
 * The new address for an old hash link: `#/p/<slug>` (a pointer slug such as `kaka` or
 * `prime-kaka`, or a versioned slug such as `kaka--prime--2007-06-30`) and `#/c/<code>`.
 */
export function legacyHashToPath(hash: string): string | null {
  const m = hash.match(/^#\/(p|c)\/([^?#]+)/);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[2]).trim();
  } catch {
    return null;
  }
  if (!slug) return null;
  if (m[1] === 'c') return CODE_RE.test(slug) ? chatPath(slug) : null;
  // A shared personal revision has no address of its own; the app opens it from the hash.
  if (/--rev-[a-z0-9]+$/.test(slug)) return null;

  const versioned = slug.match(/^(.+?)--(current|prime|era|season_snapshot|retro)--(.+)$/);
  if (versioned) {
    const [, base, edition, moment] = versioned;
    const player = toBasePlayerSlug(base);
    if (!player) return null;
    // A shared current card or prime follows its pointer, so an old link opens the latest card.
    if (edition === 'current') return addressPath({ player, edition: 'default' });
    if (edition === 'prime' || edition === 'retro') return addressPath({ player, edition: 'prime' });
    if (isRealDate(moment)) return addressPath({ player, edition: 'dated', date: moment });
    const window = shortWindow(moment);
    if (!window) return addressPath({ player, edition: 'default' });
    return addressPath({ player, edition: edition === 'era' ? 'era' : 'season', window });
  }
  const prime = slug.match(/^prime-(.+)$/);
  const player = toBasePlayerSlug(prime ? prime[1] : slug);
  if (!player) return null;
  return addressPath({ player, edition: prime ? 'prime' : 'default' });
}
