/**
 * Keeps precise figures in live chat answers to the ones the turn actually found. The writer tends
 * to add exact-sounding details nobody looked up: a pressing metric to one decimal place, a
 * transfer fee, a goal tally, points and goal difference, the minute of an injury, a shirt number,
 * a press-conference quote. Each precise figure in the reply is checked against the turn's
 * evidence (the situation snapshot, the research ledger, cards in play, tool results, the
 * conversation, and text the writer's own search grounded). A figure is supported only when the
 * same number appears in the evidence next to the same kind of word, so a common number elsewhere
 * in the evidence doesn't vouch for it. An unsupported figure takes its sentence with it; in a
 * table, only its cell is blanked. Judgment sentences without figures are never touched. Pure.
 */

export type FigureKind = 'percent' | 'money' | 'decimal' | 'stat' | 'goal_difference' | 'position' | 'minute' | 'shirt' | 'quote';

export interface FigureClaim {
  kind: FigureKind;
  /** The figure as written, e.g. "£75m" or "12 goals". */
  text: string;
  /** The number to look for, or the quote's opening words. */
  value: string;
  /** Words that must sit just before or after the number in the evidence (pattern sources). */
  near: string[];
  /** Compact forms that must follow the number directly ("6g" for goals), as pattern sources. */
  suffix?: string[];
}

/** Stat nouns and how each one appears in evidence (FPL lines, ESPN tables, digests). */
const STAT_NOUNS: [RegExp, string[], string[]][] = [
  [/^goals?$/, ['goal', 'scored', 'scorer'], ['g\\b']],
  [/^assists?$/, ['assist'], ['a\\b']],
  [/^(?:appearances|apps|games|matches)$/, ['appearance', 'apps', 'game', 'match', 'played'], []],
  [/^starts?$/, ['start'], []],
  [/^minutes$/, ['minute'], ["'"]],
  [/^clean sheets?$/, ['clean sheet'], []],
  [/^(?:points|pts)$/, ['point', 'pts'], []],
  [/^(?:wins|victories)$/, ['win', 'victor', '\\bw$'], []],
  [/^(?:draws)$/, ['draw', '\\bd$'], []],
  [/^(?:defeats|losses)$/, ['defeat', 'loss', 'lost', '\\bl$'], []],
  [/^caps$/, ['cap'], []],
  [/^(?:titles|trophies|honours)$/, ['title', 'trophies', 'trophy', 'honour', 'winner', 'won'], []],
];
const statWords = (noun: string): { near: string[]; suffix: string[] } => {
  const hit = STAT_NOUNS.find(([re]) => re.test(noun));
  return hit ? { near: hit[1], suffix: hit[2] } : { near: [noun.replace(/s$/, '')], suffix: [] };
};

const STAT_NOUN_SOURCE =
  "goals?|assists?|appearances|apps|starts|minutes|clean sheets?|points|pts|shots(?: on target)?|dribbles|tackles|interceptions|key passes|passes|chances(?: created)?|big chances|saves|offsides|pressures|recoveries|duels|touches|crosses|blocks|clearances|fouls|wins|victories|draws|defeats|losses|caps|hat-tricks?|titles|trophies|honours";

interface Pattern {
  kind: FigureKind;
  re: RegExp;
  /** The number (or quote) and the words it must sit near in the evidence. */
  read: (m: RegExpMatchArray) => { value: string; near: string[]; suffix?: string[] } | null;
}

const PATTERNS: Pattern[] = [
  { kind: 'percent', re: /\b(\d{1,3}(?:\.\d+)?)\s?(?:%|per ?cent\b)/gi, read: (m) => ({ value: m[1], near: ['%', 'per ?cent'] }) },
  {
    kind: 'money',
    re: /[£€$]\s?(\d+(?:[.,]\d+)?)\s?(?:m\b|bn\b|k\b|million\b|billion\b)?|\b(\d+(?:\.\d+)?)\s?(?:million|billion)\s(?:pounds|euros|dollars)\b/gi,
    read: (m) => ({ value: (m[1] ?? m[2]).replace(',', '.'), near: ['£', '€', '\\$', 'million', 'fee', 'bn'], suffix: ['m\\b', 'bn\\b'] }),
  },
  {
    kind: 'goal_difference',
    re: /([+−-]\d{1,2})\s?goal difference|goal difference of\s([+−-]?\d{1,2})/gi,
    read: (m) => ({ value: (m[1] ?? m[2]).replace(/^[+−-]/, ''), near: ['gd', 'goal difference'] }),
  },
  {
    kind: 'stat',
    re: new RegExp(`\\b(\\d{1,3})\\s+(?:[A-Za-z-]+\\s+){0,2}?(${STAT_NOUN_SOURCE})\\b`, 'gi'),
    read: (m) => {
      const n = Number(m[1]);
      // "the 2 goals" and "1 assist" are too common to judge; a bare small count is left alone.
      if (n < 2) return null;
      return { value: m[1], ...statWords(m[2].toLowerCase()) };
    },
  },
  {
    kind: 'position',
    re: /\b(\d{1,2})(?:st|nd|rd|th)\s+(?:place|position|in the (?:table|league|standings))\b/gi,
    // A table row in the evidence reads "3. Club — 18 pts".
    read: (m) => ({ value: m[1], near: ['place', 'position'], suffix: ['\\. ', '(?:st|nd|rd|th)\\b'] }),
  },
  {
    kind: 'minute',
    re: /\b(\d{1,3})(?:st|nd|rd|th)?[-\s]minute\b|\bminute\s(\d{1,3})\b|\b(\d{1,3})'(?=[\s,.;)])/gi,
    read: (m) => ({ value: m[1] ?? m[2] ?? m[3], near: ['minute'], suffix: ["'", '(?:st|nd|rd|th)? minute'] }),
  },
  {
    kind: 'shirt',
    re: /\b(?:number|no\.?)\s?(\d{1,2})\s(?:shirt|jersey)\b|\bthe\s(\d{1,2})\s(?:shirt|jersey)\b|\bwears?\s(?:the\s)?(?:number\s)?(\d{1,2})\b/gi,
    read: (m) => ({ value: m[1] ?? m[2] ?? m[3], near: ['shirt', 'jersey', 'number', 'no\\.'] }),
  },
  // A decimal is precise wherever it is (an expected-goals figure, a per-match average).
  { kind: 'decimal', re: /(?<![\d.])(\d{1,3}\.\d{1,2})(?![\d.%])/g, read: (m) => ({ value: m[1], near: [] }) },
  {
    kind: 'quote',
    re: /[“"]([^”"\n]{25,})[”"]/g,
    read: (m) => (m[1].trim().split(/\s+/).length >= 5 ? { value: m[1], near: [] } : null),
  },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[“”"‘’]/g, "'")
    .replace(/\s+/g, ' ');

/** The precise figures in one piece of text, each kept once (a decimal inside a stat isn't counted twice). */
export function findFigures(text: string): FigureClaim[] {
  const claims: (FigureClaim & { at: number; end: number })[] = [];
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const read = p.read(m);
      if (!read?.value) continue;
      const at = m.index ?? 0;
      const end = at + m[0].length;
      if (claims.some((c) => at < c.end && end > c.at)) continue;
      claims.push({ kind: p.kind, text: m[0].trim(), value: read.value, near: read.near, ...(read.suffix ? { suffix: read.suffix } : {}), at, end });
    }
  }
  return claims.sort((a, b) => a.at - b.at).map(({ at: _a, end: _e, ...c }) => c);
}

/**
 * Tables in the evidence (Wikipedia's appearance and career tables) as labelled cells, so a
 * figure taken from one sits next to its column's name: a row "Thierry Henry | 37 | 30" under the
 * header "Name | League Apps | League Goals" adds "League Apps 37; League Goals 30". The header
 * line is the first line of a run of lines split by " | ".
 */
export function expandTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let header: string[] | null = null;
  for (const line of lines) {
    const cells = line.includes(' | ') ? line.split(' | ').map((c) => c.trim()) : null;
    if (!cells) {
      header = null;
      continue;
    }
    if (!header) {
      header = cells;
      continue;
    }
    out.push(cells.map((c, i) => (header![i] && c && c !== '–' ? `${header![i]} ${c}` : '')).filter(Boolean).join('; '));
  }
  return out.length ? `${text}\n${out.join('\n')}` : text;
}

/** How far before and after the number a word that says what it counts may sit. */
const BEFORE = 12;
const AFTER = 25;

/** Whether the evidence holds this figure: the quote's words, the exact decimal, or the number beside one of its words. */
export function isSupported(claim: FigureClaim, evidence: string): boolean {
  const corpus = fold(evidence);
  if (claim.kind === 'quote') {
    const words = fold(claim.value).replace(/[^a-z0-9' ]/g, '').split(' ').filter(Boolean);
    const opening = words.slice(0, 6).join(' ');
    return opening.length > 0 && corpus.replace(/[^a-z0-9' ]/g, '').includes(opening);
  }
  // A decimal may be written rounded ("2.3" for 2.34); anything else must match exactly.
  const tail = claim.kind === 'decimal' ? '\\d*(?![\\d.])' : '(?![\\d]|\\.\\d)';
  const num = new RegExp(`(?<![\\d.])${escape(claim.value)}${tail}`, 'g');
  for (const m of corpus.matchAll(num)) {
    if (claim.near.length === 0 && !claim.suffix?.length) return true;
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const before = corpus.slice(Math.max(0, at - BEFORE), at);
    const after = corpus.slice(end, end + AFTER);
    if (claim.near.some((w) => new RegExp(w, 'i').test(before) || new RegExp(w, 'i').test(after))) return true;
    if (claim.suffix?.some((w) => new RegExp(`^${w}`, 'i').test(after))) return true;
  }
  return false;
}

export interface FigureGateResult {
  text: string;
  removed: FigureClaim[];
}

/** Sentences of a paragraph or list item: a stop followed by a space ends one, so "8.4" stays whole. */
const sentences = (line: string): string[] => line.split(/(?<=[.!?])\s+(?=\S)/);

/**
 * Removes the unsupported figures from a reply. `grounded` is text the writer's own search
 * returned with citations; a sentence inside it stands.
 */
export function gateUnsupportedFigures(text: string, evidence: string, grounded: string[] = []): FigureGateResult {
  const removed: FigureClaim[] = [];
  const groundedFolded = grounded.map(fold).filter((g) => g.length > 20);
  const isGrounded = (sentence: string) => {
    const s = fold(sentence).trim();
    return s.length > 0 && groundedFolded.some((g) => g.includes(s) || (s.length > 40 && s.includes(g)));
  };
  const unsupported = (chunk: string) => (isGrounded(chunk) ? [] : findFigures(chunk).filter((c) => !isSupported(c, evidence)));

  const lines = text.split('\n').map((line) => {
    if (/^\s*#/.test(line) || !line.trim()) return line;
    // A table keeps its shape: only the cell with an unsupported figure is blanked.
    if (/^\s*\|/.test(line)) {
      return line
        .split('|')
        .map((cell) => {
          const bad = unsupported(cell);
          if (bad.length === 0) return cell;
          removed.push(...bad);
          return cell.replace(/\S.*\S|\S/, '–');
        })
        .join('|');
    }
    const marker = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)/)?.[1] ?? '';
    const kept = sentences(line.slice(marker.length)).filter((s) => {
      const bad = unsupported(s);
      removed.push(...bad);
      return bad.length === 0;
    });
    const body = kept.join(' ').trimEnd();
    // A list item or paragraph with nothing left goes; one that kept something keeps its marker.
    return body ? `${marker}${body}` : null;
  });
  const out = lines
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { text: removed.length ? out.trim() : text, removed };
}
