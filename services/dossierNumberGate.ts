import type { Attributes, PlayerProfile } from '../types';
import { ATTRIBUTE_LABELS } from '../constants/ratingTiers';
import { foldPlayerName } from './dossierCards';

/**
 * Keeps the attribute numbers in chat prose equal to the stored cards. A reply that quotes a
 * card's attribute with a value the card doesn't hold (a regenerated "Flair 88" when the card
 * says 89) gets the stored value back. Overall and Potential are left alone: a debate reply
 * proposes other ratings on purpose, and a real revision goes through a dossier patch.
 * Only corrections that can be pinned to one player are made: the number has to sit in a
 * sentence (or a table column) that names that player, and nothing is guessed when a sentence
 * leaves it open whose number it is.
 */

type RatedKey = keyof Attributes;

export interface DossierNumberCorrection {
  player: string;
  key: RatedKey;
  from: number;
  to: number;
}

const RATING_LABELS = Object.entries(ATTRIBUTE_LABELS) as Array<[RatedKey, string]>;

// Longest first, so "Offensive Positioning" wins over a shorter label it contains.
const LABEL_ALTERNATION = [...RATING_LABELS]
  .sort((a, b) => b[1].length - a[1].length)
  .map(([, label]) => label.replace(/\s+/g, '\\s+'))
  .join('|');

const keyForLabel = (label: string): RatedKey | undefined => {
  const norm = label.replace(/\s+/g, ' ').toLowerCase();
  return RATING_LABELS.find(([, l]) => l.toLowerCase() === norm)?.[0];
};

const NUM = '(\\d{1,2})(?!\\d|\\.\\d|%)';
// "Flair 99", "Flair: 99", "Flair (99)", "Flair 99 vs. 88".
const LABEL_FIRST_RE = new RegExp(
  `\\b(${LABEL_ALTERNATION})\\b\\s*[:(]?\\s*${NUM}(?:\\s*(?:vs\\.?|v\\.?|versus|/|to)\\s*${NUM})?`,
  'gi',
);
// "99 Dribbling", "a 97 First Touch".
const NUMBER_FIRST_RE = new RegExp(`(?<![\\d.])${NUM}\\s+(${LABEL_ALTERNATION})\\b`, 'gi');

const valueOf = (card: PlayerProfile, key: RatedKey): number | undefined => {
  const v = card.attributes?.[key];
  return typeof v === 'number' && v > 0 ? v : undefined;
};

/** Name tokens that identify a card's player in prose ("mohamed salah", "salah"). */
const nameTokens = (card: PlayerProfile): string[] => {
  const name = foldPlayerName(card.basicInfo.name);
  return [name, ...name.split(/\s+/).filter((t) => t.length >= 4)];
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const namesPlayer = (text: string, card: PlayerProfile): boolean => {
  const folded = foldPlayerName(text);
  return nameTokens(card).some((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`).test(folded));
};

/** Where a card's player is last named in `text` before `before`: [start, end], or undefined. */
const lastNamedBefore = (
  text: string,
  card: PlayerProfile,
  before: number,
): [number, number] | undefined => {
  const folded = foldPlayerName(text.slice(0, before));
  let best: [number, number] | undefined;
  for (const t of nameTokens(card)) {
    for (const m of folded.matchAll(new RegExp(`\\b${escapeRegExp(t)}\\b`, 'g'))) {
      if (!best || m.index! > best[0]) best = [m.index!, m.index! + t.length];
    }
  }
  return best;
};

interface Edit {
  start: number;
  length: number;
  to: number;
  correction: DossierNumberCorrection;
}

interface Mention {
  key: RatedKey;
  value: number;
  /** Absolute offset of the digits in the text. */
  start: number;
}

function findMentions(text: string, offset: number): Mention[] {
  const mentions: Mention[] = [];
  const seen = new Set<number>();
  const push = (label: string, digits: string | undefined, at: number) => {
    const key = keyForLabel(label);
    if (!key || digits === undefined || seen.has(at)) return;
    const value = Number(digits);
    if (value < 1 || value > 99) return;
    seen.add(at);
    mentions.push({ key, value, start: offset + at });
  };

  for (const m of text.matchAll(LABEL_FIRST_RE)) {
    const firstAt = m.index! + m[0].indexOf(m[2], m[1].length);
    push(m[1], m[2], firstAt);
    if (m[3] !== undefined) push(m[1], m[3], m.index! + m[0].lastIndexOf(m[3]));
  }
  for (const m of text.matchAll(NUMBER_FIRST_RE)) {
    push(m[2], m[1], m.index!);
  }
  return mentions;
}

/**
 * Resolves the mismatched mentions of one sentence against the players it names. A wrong number
 * belongs to the one named player whose value isn't already quoted correctly; when several are
 * left, to the player named closest before it ("Salah offered Stamina 90 that Ronaldinho never
 * did"), unless that name is half of a joint subject ("Ronaldinho and Salah both had ...").
 */
function resolveSpan(
  mentions: Mention[],
  named: PlayerProfile[],
  sentence: string,
  sentenceStart: number,
): Edit[] {
  const edits: Edit[] = [];
  const byKey = new Map<RatedKey, Mention[]>();
  for (const m of mentions) byKey.set(m.key, [...(byKey.get(m.key) ?? []), m]);

  for (const [key, group] of byKey) {
    const holders = named.filter((c) => valueOf(c, key) !== undefined);
    if (holders.length === 0) continue;
    const quoted = new Set<PlayerProfile>();
    const wrong: Mention[] = [];
    for (const m of group) {
      const owner = holders.find((c) => valueOf(c, key) === m.value && !quoted.has(c));
      if (owner) quoted.add(owner);
      else wrong.push(m);
    }
    const unquoted = holders.filter((c) => !quoted.has(c));
    for (const m of wrong) {
      const card = unquoted.length === 1 ? unquoted[0] : nearestNamed(unquoted, sentence, m.start - sentenceStart);
      if (!card) continue;
      unquoted.splice(unquoted.indexOf(card), 1);
      const to = valueOf(card, key)!;
      edits.push({
        start: m.start,
        length: String(m.value).length,
        to,
        correction: { player: card.basicInfo.name, key, from: m.value, to },
      });
    }
  }
  return edits;
}

function nearestNamed(
  cards: PlayerProfile[],
  sentence: string,
  at: number,
): PlayerProfile | undefined {
  const placed = cards
    .map((card) => ({ card, span: lastNamedBefore(sentence, card, at) }))
    .filter((p): p is { card: PlayerProfile; span: [number, number] } => Boolean(p.span))
    .sort((a, b) => b.span[0] - a.span[0]);
  if (placed.length === 0) return undefined;
  const [nearest, runnerUp] = placed;
  if (runnerUp) {
    const between = foldPlayerName(sentence.slice(0, at)).slice(runnerUp.span[1], nearest.span[0]);
    if (/^\s*(?:,|and|&|or|plus)\s*$/i.test(between)) return undefined;
  }
  return nearest.card;
}

// "vs.", "Jr." and initials don't end a sentence.
const NON_TERMINAL_RE = /(?:\b(?:vs|v|jr|sr|st|no|approx|e\.g|i\.e)|\b[A-Z])$/i;

function splitSentences(line: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let start = 0;
  for (const m of line.matchAll(/[.!?]+(?=\s|$)/g)) {
    if (m[0] === '.' && NON_TERMINAL_RE.test(line.slice(start, m.index!))) continue;
    const end = m.index! + m[0].length;
    out.push({ text: line.slice(start, end), start });
    start = end;
  }
  if (start < line.length) out.push({ text: line.slice(start), start });
  return out;
}

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_RULE_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const splitCells = (line: string): Array<{ text: string; start: number }> => {
  const cells: Array<{ text: string; start: number }> = [];
  let cursor = line.indexOf('|') + 1;
  while (cursor < line.length) {
    const next = line.indexOf('|', cursor);
    if (next === -1) break;
    cells.push({ text: line.slice(cursor, next), start: cursor });
    cursor = next + 1;
  }
  return cells;
};

/** Edits for a markdown table whose header names players, one column each. */
function resolveTable(
  lines: Array<{ text: string; start: number }>,
  cards: PlayerProfile[],
): Edit[] {
  const edits: Edit[] = [];
  const header = splitCells(lines[0].text);
  const columnCard = header.map((cell) => {
    const hits = cards.filter((c) => namesPlayer(cell.text, c));
    return hits.length === 1 ? hits[0] : undefined;
  });
  if (!columnCard.some(Boolean)) return edits;

  for (const row of lines.slice(1)) {
    if (TABLE_RULE_RE.test(row.text)) continue;
    const cells = splitCells(row.text);
    if (cells.length === 0) continue;
    const labels = [...cells[0].text.matchAll(new RegExp(`\\b(${LABEL_ALTERNATION})\\b`, 'gi'))]
      .map((m) => keyForLabel(m[1]))
      .filter((k): k is RatedKey => Boolean(k));
    const keys = [...new Set(labels)];
    if (keys.length !== 1) continue;
    const key = keys[0];
    cells.forEach((cell, i) => {
      const card = columnCard[i];
      if (!card || i === 0) return;
      const m = cell.text.match(/^\s*(\**)\s*(\d{1,2})\s*\**\s*$/);
      if (!m) return;
      const value = Number(m[2]);
      const to = valueOf(card, key);
      if (to === undefined || to === value) return;
      edits.push({
        start: row.start + cell.start + cell.text.indexOf(m[2], m[1].length),
        length: m[2].length,
        to,
        correction: { player: card.basicInfo.name, key, from: value, to },
      });
    });
  }
  return edits;
}

export function reconcileDossierNumbers(
  text: string,
  cards: PlayerProfile[],
): { text: string; corrections: DossierNumberCorrection[] } {
  const inPlay = cards.filter((c) => c?.basicInfo?.name && c.ratings);
  if (!text || inPlay.length === 0) return { text, corrections: [] };

  const edits: Edit[] = [];

  // Lines with their offsets; consecutive table rows are handled as one table.
  const lines: Array<{ text: string; start: number }> = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    lines.push({ text: line, start: pos });
    pos += line.length + 1;
  }

  for (let i = 0; i < lines.length; i++) {
    if (TABLE_ROW_RE.test(lines[i].text)) {
      let j = i;
      while (j < lines.length && TABLE_ROW_RE.test(lines[j].text)) j++;
      edits.push(...resolveTable(lines.slice(i, j), inPlay));
      i = j - 1;
      continue;
    }
    const line = lines[i];
    for (const s of splitSentences(line.text)) {
      const sentence = s.text;
      const mentions = findMentions(sentence, line.start + s.start);
      if (mentions.length === 0) continue;
      const named = inPlay.filter((c) => namesPlayer(sentence, c));
      if (named.length === 0) continue;
      edits.push(...resolveSpan(mentions, named, sentence, line.start + s.start));
    }
  }

  if (edits.length === 0) return { text, corrections: [] };
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + String(e.to) + out.slice(e.start + e.length);
  }
  return { text: out, corrections: edits.map((e) => e.correction) };
}
