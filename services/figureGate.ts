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
  /** The number as a word, when the reply wrote it that way ("three" for 3). */
  word?: string;
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
  [/^(?:awards|ballon d'ors)$/, ['award', 'ballon', 'winner', 'won'], []],
  [/^selections$/, ['selection', 'selected', 'team of the year', 'team of the season'], []],
  [/^finals$/, ['final'], []],
];
const statWords = (noun: string): { near: string[]; suffix: string[] } => {
  const hit = STAT_NOUNS.find(([re]) => re.test(noun));
  return hit ? { near: hit[1], suffix: hit[2] } : { near: [noun.replace(/s$/, '')], suffix: [] };
};

const STAT_NOUN_SOURCE =
  "goals?|assists?|appearances|apps|starts|minutes|clean sheets?|points|pts|shots(?: on target)?|dribbles|tackles|interceptions|key passes|passes|chances(?: created)?|big chances|saves|offsides|pressures|recoveries|duels|touches|crosses|blocks|clearances|fouls|wins|victories|draws|defeats|losses|caps|hat-tricks?|titles|trophies|honours|awards|ballon d'ors|selections|finals";

/** Honours are counted with longer phrases between number and noun ("three consecutive Serie A titles"). */
const HONOUR_NOUN_SOURCE = "titles|trophies|honours|awards|ballon d'ors|selections|finals|caps";
const NUMBER_WORDS = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const NUMBER_WORD_SOURCE = NUMBER_WORDS.join('|');
const wordValue = (w: string) => String(NUMBER_WORDS.indexOf(w.toLowerCase()) + 2);

interface Pattern {
  kind: FigureKind;
  re: RegExp;
  /** The number (or quote) and the words it must sit near in the evidence. */
  read: (m: RegExpMatchArray) => { value: string; near: string[]; suffix?: string[]; word?: string } | null;
  /** Only for answers about the past (`scoped`): honour counts and numbers written as words. */
  pastOnly?: boolean;
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
    kind: 'stat',
    pastOnly: true,
    re: new RegExp(`\\b(\\d{1,3})\\s+(?:[A-Za-z'-]+\\s+){3,8}?(${HONOUR_NOUN_SOURCE})\\b`, 'gi'),
    read: (m) => (Number(m[1]) < 2 ? null : { value: m[1], ...statWords(m[2].toLowerCase()) }),
  },
  // A count written as a word: "three goals", "four consecutive Defender of the Year awards".
  {
    kind: 'stat',
    pastOnly: true,
    re: new RegExp(`\\b(${NUMBER_WORD_SOURCE})\\s+(?:[A-Za-z-]+\\s+){0,2}?(${STAT_NOUN_SOURCE})\\b`, 'gi'),
    read: (m) => ({ value: wordValue(m[1]), word: m[1].toLowerCase(), ...statWords(m[2].toLowerCase()) }),
  },
  {
    kind: 'stat',
    pastOnly: true,
    re: new RegExp(`\\b(${NUMBER_WORD_SOURCE})\\s+(?:[A-Za-z'-]+\\s+){3,8}?(${HONOUR_NOUN_SOURCE})\\b`, 'gi'),
    read: (m) => ({ value: wordValue(m[1]), word: m[1].toLowerCase(), ...statWords(m[2].toLowerCase()) }),
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
    // Line breaks stay: the scope check reads the line a number sits on.
    .replace(/[^\S\n]+/g, ' ');

/** The precise figures in one piece of text, each kept once (a decimal inside a stat isn't counted twice). */
export function findFigures(text: string, options: { past?: boolean } = {}): FigureClaim[] {
  const claims: (FigureClaim & { at: number; end: number })[] = [];
  for (const p of PATTERNS) {
    if (p.pastOnly && !options.past) continue;
    for (const m of text.matchAll(p.re)) {
      const read = p.read(m);
      if (!read?.value) continue;
      const at = m.index ?? 0;
      const end = at + m[0].length;
      if (claims.some((c) => at < c.end && end > c.at)) continue;
      claims.push({ kind: p.kind, text: m[0].trim(), value: read.value, near: read.near, ...(read.suffix ? { suffix: read.suffix } : {}), ...(read.word ? { word: read.word } : {}), at, end });
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
  const out: string[] = [];
  let header: string[] | null = null;
  let rows: string[] = [];
  // Each table's labelled rows follow the table, so they stay in the same source block.
  const flush = () => {
    if (rows.length) out.push(...rows);
    rows = [];
  };
  for (const line of text.split('\n')) {
    const cells = line.includes(' | ') ? line.split(' | ').map((c) => c.trim()) : null;
    if (!cells) {
      flush();
      header = null;
      out.push(line);
      continue;
    }
    out.push(line);
    if (!header) {
      header = cells;
      continue;
    }
    rows.push(cells.map((c, i) => (header![i] && c && c !== '–' ? `${header![i]} ${c}` : '')).filter(Boolean).join('; '));
  }
  flush();
  return out.join('\n');
}

/** How far before and after the number a word that says what it counts may sit. */
const BEFORE = 12;
const AFTER = 25;

/**
 * What a count is a count of, beyond its noun: the league, all competitions together, a domestic
 * cup, European competition, or international football. Listed in precedence order, so a phrase
 * that names both ("Champions League", "League Cup", "World Cup") reads as the narrower one.
 */
export type Qualifier = 'international' | 'europe' | 'cup' | 'all' | 'league';
const QUALIFIER_TERMS: [Qualifier, RegExp][] = [
  ['international', /\b(?:international|internationals|national team|world cups?|european championships?|copa am[eé]rica|caps)\b/g],
  ['europe', /\b(?:champions league|european cup|uefa cup|europa league|cup winners'? cup|europe|european)\b/g],
  ['cup', /\b(?:fa cup|league cup|efl cup|carabao cup|copa del rey|coppa italia|dfb-pokal|coupe de france|domestic cups?|cups?)\b/g],
  ['all', /\b(?:all competitions|all comps|in all|across all|totals?|overall)\b|\ball(?=:)/g],
  ['league', /\b(?:league|leagues|serie a|la ?liga|bundesliga|ligue 1|eredivisie|primeira liga|first division|top flight|division)\b/g],
];

/** The qualifier named closest to a position in some text, or null when it names none. */
export function qualifierNear(text: string, at: number): Qualifier | null {
  const hits: { q: Qualifier; start: number; end: number }[] = [];
  for (const [q, re] of QUALIFIER_TERMS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      // A narrower term already claimed this stretch ("champions league" isn't also "league").
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ q, start, end });
    }
  }
  let best: { q: Qualifier; d: number } | null = null;
  for (const h of hits) {
    const d = at < h.start ? h.start - at : at > h.end ? at - h.end : 0;
    if (!best || d < best.d) best = { q: h.q, d };
  }
  return best?.q ?? null;
}

/** The season start years a piece of text names ("2003-04", "2003–2004", "1999/00"). */
export function seasonsIn(text: string): number[] {
  const years: number[] = [];
  for (const m of text.matchAll(/\b((?:18|19|20)\d{2})\s*[-–/]\s*(\d{2}|\d{4})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2].slice(-2));
    if ((a + 1) % 100 === b && !years.includes(a)) years.push(a);
  }
  return years;
}

/** The span a sentence puts its figures in: one season it names, or a whole career. */
export interface FigureScope {
  qualifier: Qualifier | null;
  season: number | null;
  career: boolean;
}

const CAREER_WORDS = /\b(?:career|in total|all[- ]time|over his career|in his career)\b/i;

/** A figure's scope, read from the sentence or table cell it sits in. */
export function scopeOf(claim: FigureClaim, chunk: string): FigureScope {
  const folded = fold(chunk);
  const at = folded.indexOf(fold(claim.text));
  // The qualifier comes from the figure's own clause, so "39 goals in all competitions, 30 in the league" splits.
  const clauseStart = Math.max(
    0,
    ...[',', ';', ' and ', ' while ']
      .map((sep) => {
        const i = folded.lastIndexOf(sep, Math.max(0, at));
        return i < 0 ? 0 : i + sep.length;
      })
      .filter((i) => i <= at),
  );
  const nextStops = [',', ';', ' and ', ' while '].map((sep) => folded.indexOf(sep, at + claim.text.length)).filter((i) => i >= 0);
  const clause = folded.slice(clauseStart, nextStops.length ? Math.min(...nextStops) : undefined);
  const seasons = seasonsIn(chunk);
  return {
    qualifier: claim.kind === 'stat' && at >= 0 ? qualifierNear(clause, Math.max(0, at - clauseStart)) : null,
    season: seasons.length === 1 ? seasons[0] : null,
    career: CAREER_WORDS.test(chunk) && seasons.length === 0,
  };
}

/**
 * Whether one place the number appears in the evidence fits the figure's scope. Evidence that
 * doesn't say is given the benefit of the doubt; only a different qualifier beside the number, or a
 * different season on its line or in its source's heading, rules it out.
 */
function fitsScope(corpus: string, at: number, end: number, scope: FigureScope): boolean {
  const lineStart = corpus.lastIndexOf('\n', at) + 1;
  const lineEndRaw = corpus.indexOf('\n', end);
  const line = corpus.slice(lineStart, lineEndRaw < 0 ? undefined : lineEndRaw);
  if (scope.qualifier) {
    const segStart = Math.max(...[';', '|', ','].map((sep) => line.lastIndexOf(sep, at - lineStart) + 1));
    const segEnds = [';', '|', ','].map((sep) => line.indexOf(sep, end - lineStart)).filter((i) => i >= 0);
    const segment = line.slice(segStart, segEnds.length ? Math.min(...segEnds) : undefined);
    const near = qualifierNear(segment, at - lineStart - segStart);
    if (near && near !== scope.qualifier) return false;
  }
  if (scope.season !== null) {
    const onLine = seasonsIn(line);
    if (onLine.length && !onLine.includes(scope.season)) return false;
    if (!onLine.length) {
      const header = corpus.lastIndexOf('\n[e', at);
      const heading = header >= 0 ? corpus.slice(header + 1, corpus.indexOf('\n', header + 1)) : '';
      const named = seasonsIn(heading);
      if (named.length && !named.includes(scope.season)) return false;
    }
  }
  if (scope.career && seasonsIn(line).length && !/\b(?:total|career)\b/.test(line)) return false;
  return true;
}

/** Whether the evidence holds this figure: the quote's words, the exact decimal, or the number beside one of its words. */
export function isSupported(claim: FigureClaim, evidence: string, scope?: FigureScope): boolean {
  const corpus = fold(evidence);
  if (claim.kind === 'quote') {
    const words = fold(claim.value).replace(/[^a-z0-9' ]/g, '').split(' ').filter(Boolean);
    const opening = words.slice(0, 6).join(' ');
    return opening.length > 0 && corpus.replace(/\n/g, ' ').replace(/[^a-z0-9' ]/g, '').includes(opening);
  }
  // A decimal may be written rounded ("2.3" for 2.34); anything else must match exactly.
  const tail = claim.kind === 'decimal' ? '\\d*(?![\\d.])' : '(?![\\d]|\\.\\d)';
  // A count the reply wrote as a word may be written either way in the evidence.
  const num = new RegExp(`(?<![\\d.])${escape(claim.value)}${tail}${claim.word ? `|\\b${claim.word}\\b` : ''}`, 'g');
  for (const m of corpus.matchAll(num)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (scope && !fitsScope(corpus, at, end, scope)) continue;
    if (claim.near.length === 0 && !claim.suffix?.length) return true;
    const before = corpus.slice(Math.max(0, at - BEFORE), at);
    const after = corpus.slice(end, end + AFTER);
    if (claim.near.some((w) => new RegExp(w, 'i').test(before) || new RegExp(w, 'i').test(after))) return true;
    if (claim.suffix?.some((w) => new RegExp(`^${w}`, 'i').test(after))) return true;
  }
  return false;
}

export interface FigureGateResult {
  text: string;
  /** Figures the evidence doesn't hold. */
  removed: FigureClaim[];
  /** Supported figures cut because the reply quoted more than its budget. */
  trimmed: FigureClaim[];
}

export interface FigureGateOptions {
  /** Check each figure's qualifier and span too (`scopeOf`), as answers about past seasons need. */
  scoped?: boolean;
  /**
   * At most `max` figures in the reply. The figures a turn chose in advance (`slots`, described in
   * words) are kept first; beyond the budget, sentences with other figures go, the last first.
   */
  budget?: { max: number; slots: string[] };
}

/** A tally from one match, or one tie, rather than a season or a span. */
const MATCH_LEVEL = /\b(?:against|versus|vs\.?|in the final|in a single match|in one match|in the (?:first|second) leg|hat-?tricks?)\b/;

/**
 * Whether a figure is one a slot asked for: the slot names its noun, its competition doesn't
 * conflict with the slot's, the season it's given for is one the slot names (when the slot names
 * any), and a tally from one match only counts when the slot is about a match.
 */
export function matchesSlot(claim: FigureClaim, slots: string[], chunk: string = claim.text): boolean {
  const scope = scopeOf(claim, chunk);
  const matchLevel = MATCH_LEVEL.test(fold(chunk));
  return slots.some((slot) => {
    const f = fold(slot);
    if (!claim.near.some((w) => new RegExp(w, 'i').test(f))) return false;
    const slotQualifier = qualifierNear(f, 0);
    if (scope.qualifier && slotQualifier && slotQualifier !== scope.qualifier) return false;
    const slotSeasons = seasonsIn(slot);
    if (scope.season !== null && slotSeasons.length && !slotSeasons.includes(scope.season)) return false;
    if (matchLevel && !MATCH_LEVEL.test(f) && !/\bmatch\b/.test(f)) return false;
    return true;
  });
}

/** Sentences of a paragraph or list item: a stop followed by a space ends one, so "8.4" stays whole. */
const sentences = (line: string): string[] => line.split(/(?<=[.!?])\s+(?=\S)/);

interface Unit {
  text: string;
  /** Index of the line and, for a table, of the cell. */
  line: number;
  cell: number | null;
  kept: FigureClaim[];
  gone: boolean;
}

/**
 * Removes the unsupported figures from a reply. `grounded` is text the writer's own search
 * returned with citations; a sentence inside it stands.
 */
export function gateUnsupportedFigures(text: string, evidence: string, grounded: string[] = [], options: FigureGateOptions = {}): FigureGateResult {
  const removed: FigureClaim[] = [];
  const trimmed: FigureClaim[] = [];
  const groundedFolded = grounded.map((g) => fold(g).replace(/\n/g, ' ')).filter((g) => g.length > 20);
  const isGrounded = (sentence: string) => {
    const s = fold(sentence).trim();
    return s.length > 0 && groundedFolded.some((g) => g.includes(s) || (s.length > 40 && s.includes(g)));
  };
  const units: Unit[] = [];
  const check = (chunk: string, line: number, cell: number | null): Unit => {
    const figures = findFigures(chunk, { past: options.scoped });
    const bad = isGrounded(chunk) ? [] : figures.filter((c) => !isSupported(c, evidence, options.scoped ? scopeOf(c, chunk) : undefined));
    removed.push(...bad);
    const unit = { text: chunk, line, cell, kept: bad.length ? [] : figures, gone: bad.length > 0 };
    units.push(unit);
    return unit;
  };

  const shapes = text.split('\n').map((line, li) => {
    if (/^\s*#/.test(line) || !line.trim()) return { kind: 'fixed' as const, line };
    // A table keeps its shape: only the cell with an unsupported figure is blanked.
    if (/^\s*\|/.test(line)) return { kind: 'table' as const, cells: line.split('|').map((cell, ci) => check(cell, li, ci)) };
    const marker = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)/)?.[1] ?? '';
    return { kind: 'prose' as const, marker, parts: sentences(line.slice(marker.length)).map((s) => check(s, li, null)) };
  });

  // Over budget: the figures nobody chose go first, from the end of the reply back.
  if (options.budget) {
    let count = units.filter((u) => !u.gone).reduce((n, u) => n + u.kept.length, 0);
    const extra = (u: Unit) => u.kept.some((c) => !matchesSlot(c, options.budget!.slots, u.text));
    const order = units
      .filter((u) => !u.gone && u.kept.length > 0)
      .sort((a, b) => Number(extra(b)) - Number(extra(a)) || units.indexOf(b) - units.indexOf(a));
    for (const u of order) {
      if (count <= options.budget.max) break;
      u.gone = true;
      count -= u.kept.length;
      trimmed.push(...u.kept);
    }
  }

  const lines = shapes.map((shape) => {
    if (shape.kind === 'fixed') return shape.line;
    if (shape.kind === 'table') return shape.cells.map((c) => (c.gone ? c.text.replace(/\S.*\S|\S/, '–') : c.text)).join('|');
    const body = shape.parts
      .filter((p) => !p.gone)
      .map((p) => p.text)
      .join(' ')
      .trimEnd();
    // A list item or paragraph with nothing left goes; one that kept something keeps its marker.
    return body ? `${shape.marker}${body}` : null;
  });
  const out = lines
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { text: removed.length || trimmed.length ? out.trim() : text, removed, trimmed };
}
