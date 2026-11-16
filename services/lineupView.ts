import { nameScore, roleCol, roleRow } from './liveFootball';
import type { ClubCore, ClubSituation, Situation } from './situationSnapshot';

/**
 * The pitch view's data: a club's first-choice XI as the situation snapshot worked it out, cut
 * down to what a drawing needs and serializable, so a chat reply can carry it and a conversation
 * can store it. Pure: nothing here calls a model or the network, so a later piece can score the
 * same drawn XI against a real lineup.
 */

export interface LineupSlot {
  /** ESPN's formation slot (G, LB, CD-L, DM, AM-R, F, …), or a broad position on a season-starts XI. */
  role: string;
  /** Null when no available player has started there. */
  name: string | null;
  starts: number;
  /** Another player who has started there just as often: an even split. */
  rotation?: string;
  /** A doubt or a news report about the slot's player. */
  note?: string;
}

export interface LineupView {
  club: string;
  league: string;
  asOf: string;
  formation: string | null;
  xiBasis: ClubCore['xiBasis'];
  /** How many recent starting XIs the XI was read from; 0 for a season-starts XI. */
  matchesRead: number;
  xi: LineupSlot[];
  out: { name: string; note: string }[];
}

/** Most XIs a reply draws. */
export const MAX_LINEUPS = 2;

/** The drawing of a club's XI, or null when the snapshot found no XI to draw. */
export function lineupViewOf(club: ClubSituation): LineupView | null {
  if (club.xiBasis === 'none' || club.xi.length === 0) return null;
  // Absences from an injury list, then those only the news reported, without repeating a name.
  const out = [...club.out];
  for (const a of club.outCovered ? [] : club.newsAbsences ?? []) {
    if (!out.some((o) => o.name.toLowerCase() === a.name.toLowerCase())) out.push(a);
  }
  return {
    club: club.club,
    league: club.league,
    asOf: club.asOf,
    formation: club.formation,
    xiBasis: club.xiBasis,
    matchesRead: club.matchesRead,
    xi: club.xi.map((s) => ({
      role: s.role,
      name: s.name,
      starts: s.starts,
      ...(s.rotation ? { rotation: s.rotation } : {}),
      ...(s.note ? { note: s.note } : {}),
    })),
    out: out.map((o) => ({ name: o.name, note: o.note })),
  };
}

const sameClub = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase() || nameScore(a, [b]) >= 2 || nameScore(b, [a]) >= 2;

export interface LineupTurn {
  /** The turn's situation snapshot, fresh or the thread's last one. */
  situation: Situation | null;
  /** The clubs the router spotted, or the thread's current clubs for a follow-up. */
  clubs: string[];
  /** The players the router spotted. */
  players: string[];
  /** A thread about primes, past seasons or the past decade. */
  historical: boolean;
  /** A Gaffa trade scorecard heads this reply. */
  scorecard: boolean;
}

/**
 * Which clubs' XIs a reply draws: only a turn about the present, for the clubs the turn is about
 * (a question about one player counts as one about his club) that the snapshot found an XI for, at
 * most two, in the order the snapshot lists them.
 */
export function lineupsForTurn(turn: LineupTurn): LineupView[] {
  if (turn.historical || turn.scorecard || !turn.situation) return [];
  const wanted = [...turn.clubs];
  if (turn.players.length === 1) {
    const [target] = turn.players;
    for (const p of turn.situation.players) {
      if (p.club && (nameScore(p.name, [target]) >= 2 || nameScore(target, [p.name]) >= 2)) wanted.push(p.club);
    }
  }
  if (wanted.length === 0) return [];
  const views: LineupView[] = [];
  for (const club of turn.situation.clubs) {
    if (views.length >= MAX_LINEUPS) break;
    if (!wanted.some((w) => sameClub(w, club.club))) continue;
    if (views.some((v) => sameClub(v.club, club.club))) continue;
    const view = lineupViewOf(club);
    if (view) views.push(view);
  }
  return views;
}

/** "First-choice XI · 4-2-3-1 · from 6 recent starting XIs · as of 2026-11-14". */
export function lineupCaption(view: LineupView): string {
  const basis =
    view.xiBasis === 'lineups'
      ? `from ${view.matchesRead} recent starting XI${view.matchesRead === 1 ? '' : 's'}`
      : view.xiBasis === 'season_starts'
        ? 'from season starts'
        : 'no recent lineups read';
  return ['First-choice XI', view.xiBasis === 'lineups' ? view.formation : null, basis, `as of ${view.asOf}`].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Placement

/** The drawing's coordinate space; the component scales it to its container. */
export const PITCH = { width: 340, height: 460, inset: 8, discRadius: 14, nameSize: 11, altSize: 9 } as const;

const Y_TOP = 66;
const Y_BOTTOM = 398;
const MAX_STEP = 96;
/** Average glyph width as a fraction of the font size, for fitting labels to the space between discs. */
const GLYPH = 0.56;
const MIN_LABEL = 6;
const MAX_LABEL = 14;

export interface PlacedSlot {
  key: string;
  role: string;
  /** The role as shown: ESPN's goalkeeper code G reads GK. */
  roleLabel: string;
  x: number;
  y: number;
  empty: boolean;
  /** The name under the disc, or the role for an empty slot. */
  label: string;
  /** An even split's other player, "or Surname". */
  alt?: string;
  starts: number;
  note?: string;
  /** Full text for the slot's tooltip and screen readers. */
  title: string;
  /** Width the label may take, in drawing units. */
  labelWidth: number;
}

export const roleLabel = (role: string): string => (role.toUpperCase() === 'G' ? 'GK' : role.toUpperCase());

const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'di', 'da', 'dos', 'das', 'do', 'del', 'della', 'le', 'la', 'el', 'al', 'bin', 'ter', 'ten', 'du']);
const SUFFIXES = /^(jr\.?|sr\.?|ii|iii)$/i;
/** A full name this short is shown whole. */
const SHORT_NAME = 10;

/** The surname as a fan says it ("van Dijk", "Alexander-Arnold"), or the whole name when it is short. */
export function surnameOf(name: string): string {
  const full = name.trim().replace(/\s+/g, ' ');
  if (full.length <= SHORT_NAME) return full;
  const tokens = full.split(' ');
  if (tokens.length === 1) return full;
  let i = tokens.length - 1;
  if (SUFFIXES.test(tokens[i]) && i > 0) i--;
  while (i > 1 && PARTICLES.has(tokens[i - 1].toLowerCase())) i--;
  // A particle directly before a one-word surname belongs to it ("de Jong").
  if (i === 1 && PARTICLES.has(tokens[0].toLowerCase())) i = 0;
  return tokens.slice(i).join(' ');
}

const fit = (text: string, maxChars: number): string => (text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`);

/**
 * Places every slot on the pitch: rows by position line from the goalkeeper up (a line no slot
 * uses takes no room), columns spread evenly within a row in the order roleCol gives (-L before
 * -R, left on the viewer's left). A season-starts XI carries broad positions (D, M, F) and lands
 * in the same rows; a code no row names goes with the forwards.
 */
export function placeXI(xi: LineupSlot[]): PlacedSlot[] {
  const byRow = new Map<number, { slot: LineupSlot; index: number }[]>();
  xi.forEach((slot, index) => {
    const row = roleRow(slot.role);
    byRow.set(row, [...(byRow.get(row) ?? []), { slot, index }]);
  });
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  const placed: PlacedSlot[] = [];
  rows.forEach((row, r) => {
    const y = rows.length === 1 ? (Y_TOP + Y_BOTTOM) / 2 : Y_BOTTOM - (r * (Y_BOTTOM - Y_TOP)) / (rows.length - 1);
    const line = [...byRow.get(row)!].sort((a, b) => roleCol(a.slot.role) - roleCol(b.slot.role) || a.index - b.index);
    const n = line.length;
    // Wide enough that the outer labels, as wide as the gap between discs, stay on the pitch.
    const step = Math.min(MAX_STEP, (PITCH.width - 2 * PITCH.inset - 4) / n);
    const centre = (PITCH.width) / 2;
    const maxChars = Math.max(MIN_LABEL, Math.min(MAX_LABEL, Math.floor((step - 6) / (PITCH.nameSize * GLYPH))));
    line.forEach(({ slot, index }, i) => {
      const x = n === 1 ? centre : centre + (i - (n - 1) / 2) * step;
      const label = slot.name ? fit(surnameOf(slot.name), maxChars) : roleLabel(slot.role);
      const altChars = Math.max(MIN_LABEL, Math.floor((step - 6) / (PITCH.altSize * GLYPH)));
      const alt = slot.name && slot.rotation ? fit(`or ${surnameOf(slot.rotation)}`, altChars) : undefined;
      const detail = [
        slot.name ? `${slot.name}, ${roleLabel(slot.role)}` : `${roleLabel(slot.role)}, no first choice found`,
        ...(slot.name && slot.starts > 0 ? [`${slot.starts} starts`] : []),
        ...(slot.rotation ? [`even split with ${slot.rotation}`] : []),
        ...(slot.note ? [slot.note] : []),
      ];
      placed.push({
        key: `${index}-${slot.role}`,
        role: slot.role,
        roleLabel: roleLabel(slot.role),
        x,
        y,
        empty: !slot.name,
        label,
        ...(alt ? { alt } : {}),
        starts: slot.starts,
        ...(slot.note ? { note: slot.note } : {}),
        title: detail.join('; '),
        labelWidth: Math.max(label.length * PITCH.nameSize, (alt?.length ?? 0) * PITCH.altSize) * GLYPH,
      });
    });
  });
  return placed.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}
