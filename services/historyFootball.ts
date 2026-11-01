import {
  ESPN_SITE,
  ESPN_STANDINGS,
  LIVE_LEAGUES,
  describeMatch,
  findClub,
  nameScore,
  nameTokens,
  parseClubSchedule,
  parseEspnStandings,
  parseEspnTeams,
  parseMatchLineup,
  roleCol,
  roleRow,
  type ClubMatch,
  type EspnTeam,
  type LiveLineup,
  type LiveMissing,
  type LiveStatus,
} from './liveFootball';

/**
 * Facts about past seasons from two free, keyless sources:
 *
 * - Wikipedia's API: a club season's article (manager, league finish, cup runs, top scorers, the
 *   squad's appearances and goals, the league table) and a player's article (senior career,
 *   season-by-season appearances and goals, international caps, honours).
 * - ESPN's site API with a `season` parameter: a club's results in every competition for seasons
 *   from 2003-04 on, and the starting XIs of a sample of its league matches.
 *
 * Past seasons don't change, so a lookup's result is kept for good: in memory, and in the server's
 * permanent store. A player's article changes while he is still playing, so it's kept a week. The
 * parsers and formatters are pure, so tests feed them fixtures.
 */

export const WIKI_API = 'https://en.wikipedia.org/w/api.php';
export const WIKI_PAGE = 'https://en.wikipedia.org/wiki/';
/** ESPN's archive of results and lineups starts with this season. */
export const ESPN_FIRST_SEASON = 2003;
/** League matches whose lineups a season lookup samples. */
export const SAMPLED_LINEUPS = 8;
/** How much of each part a digest keeps, so a lookup stays a readable evidence entry. */
const MAX_TABLE_ROWS = 34;
const MAX_DIGEST_CHARS = 7_000;
export const PLAYER_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Seasons

export interface SeasonRef {
  /** The year the season starts in. */
  start: number;
  /** "2003-04", as cards and the brief write it. */
  label: string;
  /** "2003–04", as Wikipedia titles write it. */
  wikiLabel: string;
}

/**
 * A season from how people write it: "2003-04", "2003/04", "2003–2004", "03-04", or one year,
 * which means the season that ends in it ("2004" is 2003-04), the way a final or a title is
 * remembered. Null when there's no season in it.
 */
export function parseSeason(input: string): SeasonRef | null {
  const s = input.trim();
  const pair = s.match(/\b((?:18|19|20)?\d{2})\s*[-–—/]\s*((?:18|19|20)?\d{2})\b/);
  const single = s.match(/\b((?:18|19|20)\d{2})\b/);
  let start: number | null = null;
  if (pair) {
    const a = pair[1].length === 2 ? Number(pair[1]) + (Number(pair[1]) > 40 ? 1900 : 2000) : Number(pair[1]);
    const b = Number(pair[2].slice(-2));
    if ((a + 1) % 100 === b) start = a;
  }
  if (start === null && single) start = Number(single[1]) - 1;
  if (start === null || start < 1870 || start > 2100) return null;
  const end = String((start + 1) % 100).padStart(2, '0');
  return { start, label: `${start}-${end}`, wikiLabel: `${start}–${end}` };
}

// ---------------------------------------------------------------------------------------------
// HTML

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', minus: '−' };

export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });

/** An HTML fragment as one line of text: no footnotes, styles, hidden spans or tags. */
export function cellText(html: string): string {
  return decodeEntities(
    html
      .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '')
      .replace(/\(\s*<span class="bday">[^<]*<\/span>\s*\)/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, '')
      .replace(/<br\s*\/?>/gi, ', ')
      .replace(/<\/(li|p|div)>/gi, ', ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\[(?:\d+|[a-z]|note \d+|citation needed)\]/gi, '')
    // A table's navigation links ("view, talk, edit") sit in its header cell.
    .replace(/v,? ?t,? ?e$/, '')
    .replace(/\s+/g, ' ')
    .replace(/(?:,\s*)+$/, '')
    .replace(/^(?:,\s*)+/, '')
    .trim();
}

/** The index just past the element that opens at `from`, counting nested elements of the same tag. */
export function elementEnd(html: string, from: number, tag: string): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return html.length;
}

/** Top-level elements of a tag whose opening tag matches `attr` (a class, say), in order. */
function elements(html: string, tag: string, attr: RegExp): { start: number; html: string }[] {
  const found: { start: number; html: string }[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (!attr.test(m[0])) continue;
    const end = elementEnd(html, m.index, tag);
    found.push({ start: m.index, html: html.slice(m.index, end) });
    re.lastIndex = end;
  }
  return found;
}

export interface TableCell {
  text: string;
  header: boolean;
}

/**
 * A table as a grid, with rowspans and colspans filled in so every row lines up with the header.
 * Nested tables are left out.
 */
export function parseTableGrid(tableHtml: string): TableCell[][] {
  // Drop nested tables so their rows don't mix into this one.
  let body = tableHtml.replace(/^<table\b[^>]*>/i, '');
  for (let i = body.search(/<table\b/i); i >= 0; i = body.search(/<table\b/i)) {
    body = body.slice(0, i) + body.slice(elementEnd(body, i, 'table'));
  }
  const grid: TableCell[][] = [];
  const pending: { cell: TableCell; rows: number }[] = [];
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/tbody>|<\/table>|$)/gi)) {
    const line: TableCell[] = [];
    let col = 0;
    const fillPending = () => {
      while (pending[col] && pending[col].rows > 0) {
        line.push(pending[col].cell);
        pending[col].rows -= 1;
        col += 1;
      }
    };
    for (const cell of row[1].matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)(?=<t[hd]\b|<\/tr>|$)/gi)) {
      fillPending();
      const attrs = cell[2];
      const span = (name: string) => Math.max(1, Math.min(20, parseInt(attrs.match(new RegExp(`${name}\\s*=\\s*"?(\\d+)`, 'i'))?.[1] ?? '1', 10) || 1));
      const value: TableCell = { text: cellText(cell[3]), header: cell[1].toLowerCase() === 'th' };
      const rowspan = span('rowspan');
      for (let k = 0; k < span('colspan'); k++) {
        line.push(value);
        if (rowspan > 1) pending[col] = { cell: value, rows: rowspan - 1 };
        col += 1;
      }
    }
    fillPending();
    if (line.some((c) => c.text)) grid.push(line);
  }
  return grid;
}

/**
 * A grid as text: the header rows merged into one line of column names ("League Apps"), then one
 * line per row. Repeated header rows inside the body (a "Totals" line) are kept, since they're data.
 */
export function formatTable(grid: TableCell[][], maxRows = MAX_TABLE_ROWS): string {
  let headerRows = 0;
  while (headerRows < grid.length && headerRows < 3 && grid[headerRows].every((c) => c.header)) headerRows += 1;
  const width = Math.max(0, ...grid.map((r) => r.length));
  const columns = Array.from({ length: width }, (_, i) => {
    const parts: string[] = [];
    for (let r = 0; r < headerRows; r++) {
      const t = grid[r][i]?.text ?? '';
      if (t && !parts.includes(t)) parts.push(t);
    }
    return parts.join(' ');
  });
  const lines: string[] = [];
  if (headerRows > 0) lines.push(columns.join(' | '));
  const rows = grid.slice(headerRows);
  for (const r of rows.slice(0, maxRows)) lines.push(r.map((c) => c.text || '–').join(' | '));
  if (rows.length > maxRows) lines.push(`(${rows.length - maxRows} more rows)`);
  return lines.join('\n');
}

export interface PageSection {
  title: string;
  level: number;
  html: string;
}

/** The article split at its h2 to h4 headings; the part before the first heading is titled "". */
export function pageSections(html: string): PageSection[] {
  const heads = [...html.matchAll(/<h([234])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  const sections: PageSection[] = [{ title: '', level: 1, html: html.slice(0, heads[0]?.index ?? html.length) }];
  heads.forEach((h, i) => {
    const end = heads[i + 1]?.index ?? html.length;
    sections.push({ title: cellText(h[2]), level: Number(h[1]), html: html.slice(h.index! + h[0].length, end) });
  });
  return sections;
}

/** The article's opening paragraphs, up to `maxChars`. */
export function leadText(html: string, maxChars = 900): string {
  const intro = pageSections(html)[0].html;
  const paragraphs = [...intro.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => cellText(m[1])).filter((p) => p.length > 40);
  let text = '';
  for (const p of paragraphs) {
    if (text.length + p.length > maxChars) {
      if (!text) text = `${p.slice(0, maxChars)}…`;
      break;
    }
    text = text ? `${text} ${p}` : p;
  }
  return text;
}

/**
 * The infobox as lines: "Manager: Arsène Wenger", and the career rows as "1996–2001: Juventus,
 * 151 (24)". Images and kit diagrams are left out.
 */
export function infoboxLines(html: string): string[] {
  const box = elements(html, 'table', /class="[^"]*\binfobox\b/i)[0];
  if (!box) return [];
  const lines: string[] = [];
  for (const row of parseTableGrid(box.html)) {
    const texts = row.map((c) => c.text).filter((t, i, all) => t && all.indexOf(t) === i);
    if (texts.length === 0) continue;
    if (texts.length === 1) {
      // A section heading ("Senior career*") or a lone caption.
      if (row[0].header && texts[0].length < 60) lines.push(`${texts[0].replace(/\*$/, '')}:`);
      continue;
    }
    lines.push(`${texts[0]}: ${texts.slice(1).join(', ')}`);
  }
  return lines.filter((l) => !/^(Home colours|Away colours|Third colours|Kit|Website|Signature)\b/i.test(l));
}

/** List items in an HTML fragment, as text. */
export const listItems = (html: string, max: number): string[] =>
  [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => cellText(m[1])).filter(Boolean).slice(0, max);

/** The page's data tables (`wikitable`), each with the heading it sits under. */
export function pageTables(html: string): { section: string; grid: TableCell[][] }[] {
  const out: { section: string; grid: TableCell[][] }[] = [];
  for (const s of pageSections(html)) {
    for (const t of elements(s.html, 'table', /class="[^"]*\bwikitable\b/i)) out.push({ section: s.title, grid: parseTableGrid(t.html) });
  }
  return out;
}

const headerText = (grid: TableCell[][]): string =>
  grid
    .slice(0, 3)
    .flat()
    .filter((c) => c.header)
    .map((c) => c.text.toLowerCase())
    .join(' ');
const dataRows = (grid: TableCell[][]) => grid.filter((r) => !r.every((c) => c.header));

/** A squad's appearances and goals: a table with player names and both columns. */
export const isSquadStatsTable = (grid: TableCell[][]): boolean => {
  const h = headerText(grid);
  return /\b(apps|appearances|app)\b/.test(h) && /\b(goals|gls)\b/.test(h) && /\b(player|name|nat|pos|no\.?)\b/.test(h);
};
/** A league table: positions, teams and points. */
export const isLeagueTable = (grid: TableCell[][]): boolean => {
  const h = headerText(grid);
  return /\bpts\b/.test(h) && /\b(pos|team)\b/.test(h) && /\b(pld|p|gp)\b/.test(h);
};

/** The league table's top four and the club's own row, labelled by position. */
export function leagueTableExcerpt(grid: TableCell[][], club: string): string {
  const header = grid.find((r) => r.every((c) => c.header));
  const rows = dataRows(grid);
  const ours = rows.filter((r) => r.some((c) => nameScore(club, [c.text.replace(/\((C|R|Q|O|P)\)/g, '')]) > 0));
  const keep = [...new Set([...rows.slice(0, 4), ...ours])];
  return formatTable([...(header ? [header] : []), ...keep], 10);
}

// ---------------------------------------------------------------------------------------------
// Digests

export interface WikiPage {
  title: string;
  html: string;
}

export const pageUrl = (title: string): string => `${WIKI_PAGE}${encodeURIComponent(title.replace(/ /g, '_'))}`;

const clip = (text: string, max = MAX_DIGEST_CHARS): string => (text.length > max ? `${text.slice(0, max)}\n(cut for length)` : text);

/** A club season article as an evidence digest. */
export function formatClubSeasonPage(page: WikiPage, club: string): string {
  const parts = [`Wikipedia, "${page.title}" (${pageUrl(page.title)}).`];
  const lead = leadText(page.html, 900);
  if (lead) parts.push(`Summary: ${lead}`);
  const box = infoboxLines(page.html).filter((l) => !/^(Chairman|Owner|Stadium|Highest|Lowest|Average|.*attendance)\b/i.test(l));
  if (box.length) parts.push(`Season facts:\n${box.map((l) => `- ${l}`).join('\n')}`);
  const tables = pageTables(page.html);
  const squad = tables.filter((t) => isSquadStatsTable(t.grid)).sort((a, b) => dataRows(b.grid).length - dataRows(a.grid).length)[0];
  if (squad) parts.push(`Squad appearances and goals${squad.section ? ` (${squad.section})` : ''}:\n${formatTable(squad.grid)}`);
  const league = tables.find((t) => isLeagueTable(t.grid));
  if (league) parts.push(`League table (top four and ${club}):\n${leagueTableExcerpt(league.grid, club)}`);
  return clip(parts.join('\n\n'));
}

/** Infobox lines worth keeping for a player: identity, position, and the career rows. */
const PLAYER_BOX_SKIP = /^(Current team|Number|Height|Place of birth|Medal record|Signature)\b/i;

/** A player article as an evidence digest: his career in numbers, then his honours. */
export function formatPlayerPage(page: WikiPage): string {
  const parts = [`Wikipedia, "${page.title}" (${pageUrl(page.title)}).`];
  const lead = leadText(page.html, 700);
  if (lead) parts.push(`Summary: ${lead}`);
  const box = infoboxLines(page.html).filter((l) => !PLAYER_BOX_SKIP.test(l));
  if (box.length) parts.push(`Career (infobox; league appearances and goals in brackets):\n${box.map((l) => `- ${l}`).join('\n')}`);
  const sections = pageSections(page.html);
  const statsAt = sections.findIndex((s) => /career statistics|statistics/i.test(s.title) && s.level === 2);
  if (statsAt >= 0) {
    // The statistics section's own tables and those under its h3 subsections, up to the next h2.
    const next = sections.findIndex((s, i) => i > statsAt && s.level === 2);
    const block = sections.slice(statsAt, next < 0 ? undefined : next);
    const grids = block.flatMap((s) => elements(s.html, 'table', /class="[^"]*\bwikitable\b/i).map((t) => ({ section: s.title, grid: parseTableGrid(t.html) })));
    const club = grids.find((g) => /\bseason\b/.test(headerText(g.grid)) && /\bapps\b/.test(headerText(g.grid)));
    if (club) parts.push(`Club appearances and goals by season (Wikipedia career statistics):\n${formatTable(club.grid, 40)}`);
    const country = grids.find((g) => g !== club && /\b(national team|year)\b/.test(headerText(g.grid)) && /\bapps\b/.test(headerText(g.grid)));
    if (country) parts.push(`International appearances and goals:\n${formatTable(country.grid, 25)}`);
  }
  const honoursAt = sections.findIndex((s) => /^honours?$/i.test(s.title) && s.level === 2);
  if (honoursAt >= 0) {
    const next = sections.findIndex((s, i) => i > honoursAt && s.level === 2);
    const block = sections.slice(honoursAt, next < 0 ? undefined : next);
    // Honours sit under headings for the club or country they were won with; "Player" adds nothing.
    const items = block.flatMap((s) => listItems(s.html, 40).map((li) => (s.level > 2 && s.title && !/^player$/i.test(s.title) ? `${s.title}: ${li}` : li)));
    if (items.length) parts.push(`Honours:\n${items.slice(0, 45).map((i) => `- ${i}`).join('\n')}`);
  }
  return clip(parts.join('\n\n'));
}

// ---------------------------------------------------------------------------------------------
// Finding the article

const TITLE_FILLER = /\b(?:a\.?f\.?c\.?|f\.?c\.?|c\.?f\.?|s\.?c\.?|s\.?s\.?c\.?|a\.?c\.?)(?=\s|$)/gi;

/** The search hit that is this club's article for this season: "2003–04 Arsenal F.C. season". */
export function pickSeasonTitle(titles: string[], club: string, season: SeasonRef): string | null {
  const prefix = new RegExp(`^${season.wikiLabel.replace('–', '[–-]')}\\s+(.+?)\\s+season$`, 'i');
  let best: { title: string; score: number } | null = null;
  for (const title of titles) {
    const m = title.match(prefix);
    if (!m || /\b(women|ladies|l\.f\.c\.|reserves|u\d{2})\b/i.test(m[1])) continue;
    const name = m[1].replace(TITLE_FILLER, ' ').trim();
    const score = Math.max(nameScore(club, [name]), nameScore(name, [club]));
    if (score > 0 && (!best || score > best.score)) best = { title, score };
  }
  return best?.title ?? null;
}

/** The search hit that is this player's article, preferring one marked as a footballer's. */
export function pickPlayerTitle(hits: { title: string; snippet: string }[], name: string): string | null {
  const wanted = nameTokens(name);
  const candidates = hits.filter((h) => {
    if (/^(list of|\d{4})/i.test(h.title)) return false;
    const t = nameTokens(h.title.replace(/\(.*?\)/g, ''));
    return wanted.every((w) => t.includes(w)) || t.every((w) => wanted.includes(w)) || nameScore(name, [h.title.replace(/\(.*?\)/g, '')]) > 0;
  });
  const footballer = candidates.find((h) => /footballer|football|soccer/i.test(h.title) || /football|soccer|midfielder|forward|striker|defender|goalkeeper|winger/i.test(h.snippet));
  return (footballer ?? candidates[0])?.title ?? null;
}

// ---------------------------------------------------------------------------------------------
// ESPN past seasons

export interface CompetitionRecord {
  competition: string;
  leagueSlug: string | null;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  /** The last match, which shows how far a cup run went. */
  last: ClubMatch | null;
}

export function competitionRecords(matches: ClubMatch[]): CompetitionRecord[] {
  const byComp = new Map<string, ClubMatch[]>();
  for (const m of matches) {
    if (!m.completed || m.goalsFor === null || m.goalsAgainst === null) continue;
    const key = m.competition.replace(/\s*\(.*\)$/, '');
    byComp.set(key, [...(byComp.get(key) ?? []), m]);
  }
  return [...byComp.entries()]
    .map(([competition, ms]) => ({
      competition,
      leagueSlug: ms[0].leagueSlug,
      played: ms.length,
      won: ms.filter((m) => m.goalsFor! > m.goalsAgainst!).length,
      drawn: ms.filter((m) => m.goalsFor === m.goalsAgainst).length,
      lost: ms.filter((m) => m.goalsFor! < m.goalsAgainst!).length,
      goalsFor: ms.reduce((n, m) => n + m.goalsFor!, 0),
      goalsAgainst: ms.reduce((n, m) => n + m.goalsAgainst!, 0),
      last: ms[ms.length - 1] ?? null,
    }))
    .sort((a, b) => b.played - a.played);
}

/** Up to `count` matches spread evenly across the list, first and last included. */
export function spreadSample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]);
}

/** Who started most often in the sampled lineups, each with the slot he filled most. */
export function usualStarters(lineups: LiveLineup[]): { name: string; starts: number; role: string }[] {
  const tally = new Map<string, { starts: number; roles: Map<string, number> }>();
  for (const l of lineups) {
    for (const s of l.starters) {
      const t = tally.get(s.name) ?? { starts: 0, roles: new Map() };
      t.starts += 1;
      t.roles.set(s.role, (t.roles.get(s.role) ?? 0) + 1);
      tally.set(s.name, t);
    }
  }
  return [...tally.entries()]
    .map(([name, t]) => ({ name, starts: t.starts, role: [...t.roles.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.starts - a.starts || roleRow(a.role) - roleRow(b.role) || roleCol(a.role) - roleCol(b.role));
}

export interface EspnSeasonReport {
  team: string;
  season: SeasonRef;
  league: string | null;
  leagueSlug: string | null;
  records: CompetitionRecord[];
  standing: { rank: number | null; points: number | null; of: number; champion: string | null } | null;
  lineups: LiveLineup[];
  leagueMatches: number;
}

/** A club's season from ESPN, as the text research reads. */
export function formatEspnSeason(r: EspnSeasonReport): string {
  const lines = [`ESPN match data for ${r.team}, ${r.season.label}.`];
  if (r.standing && r.league) {
    lines.push(
      `${r.league}: finished ${r.standing.rank ?? '?'} of ${r.standing.of}${r.standing.points !== null ? ` with ${r.standing.points} points` : ''}${
        r.standing.champion && r.standing.rank !== 1 ? `; champions ${r.standing.champion}` : ''
      }.`,
    );
  }
  for (const c of r.records) {
    lines.push(
      `${c.competition}: P${c.played} W${c.won} D${c.drawn} L${c.lost}, goals ${c.goalsFor}-${c.goalsAgainst}${
        c.last && c.leagueSlug !== r.leagueSlug ? `; last match ${c.last.date} ${c.last.competition}, ${describeMatch(c.last)}` : ''
      }.`,
    );
  }
  if (r.lineups.length) {
    const shapes = new Map<string, number>();
    for (const l of r.lineups) if (l.formation) shapes.set(l.formation, (shapes.get(l.formation) ?? 0) + 1);
    if (shapes.size) {
      lines.push(
        `Formations in ${r.lineups.length} sampled league matches: ${[...shapes.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} (${n})`).join(', ')}.`,
      );
    }
    const starters = usualStarters(r.lineups).filter((s) => s.starts >= 2);
    lines.push(
      `Starts in ${r.lineups.length} sampled league matches, spread across the season (ESPN slot most often filled): ${starters
        .map((s) => `${s.name} (${s.role === 'G' ? 'GK' : s.role}) ${s.starts}/${r.lineups.length}`)
        .join(', ')}.`,
    );
    if (r.season.start < 2008) lines.push('ESPN labels lineups before 2008-09 by line (D, M, F) only, and not always correctly, so read the slots loosely.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Lookups with caching (the server's side)

/** Fetches JSON. The factory keeps what it needs; the fetcher needn't cache. */
export type HistoryGetJson = (url: string) => Promise<any>;

/** Where finished lookups are kept for good (the server's disk, a test's map). */
export interface PermanentStore {
  get(key: string): Promise<any | undefined>;
  set(key: string, value: any): Promise<void>;
}

export type HistoryResult =
  | { found: true; title: string; text: string; sources: string[]; missing: LiveMissing[] }
  | { found: false; status: LiveStatus; reason: string; missing: LiveMissing[] };

export const historyKey = (kind: 'club-season' | 'player', name: string, season?: SeasonRef): string =>
  [kind, nameTokens(name).join('-'), season?.label].filter(Boolean).join(':');

export function createHistoryFootball(options: {
  getJson: HistoryGetJson;
  store?: PermanentStore;
  now?: () => number;
  /** The first year of the season in progress; seasons from it on are left to the live tools. */
  currentSeasonStart: () => number;
}) {
  const { getJson, store } = options;
  const now = options.now ?? Date.now;
  const memory = new Map<string, { value: HistoryResult; expiresAt: number }>();
  const inflight = new Map<string, Promise<HistoryResult>>();
  const responses = new Map<string, { value: Promise<any>; expiresAt: number }>();
  /** One fetch per URL at a time, reused for an hour; a failed fetch is forgotten. */
  const fetchOnce = (url: string): Promise<any> => {
    const hit = responses.get(url);
    if (hit && hit.expiresAt > now()) return hit.value;
    const value = getJson(url);
    responses.set(url, { value, expiresAt: now() + 60 * 60 * 1000 });
    value.catch(() => responses.delete(url));
    return value;
  };
  const settle = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

  /** Memory, then the permanent store, then the lookup. Only found results are kept. */
  async function remembered(key: string, ttlMs: number, run: () => Promise<HistoryResult>): Promise<HistoryResult> {
    const hit = memory.get(key);
    if (hit && hit.expiresAt > now()) return hit.value;
    const pending = inflight.get(key);
    if (pending) return pending;
    const job = (async () => {
      const kept = store ? await store.get(key).catch(() => undefined) : undefined;
      if (kept?.value?.found && (kept.expiresAt === null || kept.expiresAt > now())) {
        memory.set(key, { value: kept.value, expiresAt: kept.expiresAt ?? Infinity });
        return kept.value as HistoryResult;
      }
      const value = await run();
      if (value.found) {
        const expiresAt = Number.isFinite(ttlMs) ? now() + ttlMs : Infinity;
        memory.set(key, { value, expiresAt });
        await store?.set(key, { value, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null }).catch(() => {});
      }
      return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  const wikiSearch = async (query: string): Promise<{ title: string; snippet: string }[] | null> => {
    const json = await settle(fetchOnce(`${WIKI_API}?${new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: '8', format: 'json', formatversion: '2' })}`));
    if (!json) return null;
    return (json?.query?.search ?? []).map((h: any) => ({ title: String(h?.title ?? ''), snippet: cellText(String(h?.snippet ?? '')) }));
  };
  const wikiPage = async (title: string): Promise<WikiPage | null> => {
    const json = await settle(
      fetchOnce(
        `${WIKI_API}?${new URLSearchParams({ action: 'parse', page: title, prop: 'text', format: 'json', formatversion: '2', redirects: '1', disablelimitreport: '1', disableeditsection: '1' })}`,
      ),
    );
    const html = json?.parse?.text;
    return typeof html === 'string' ? { title: String(json.parse.title ?? title), html } : null;
  };

  const teamIndex = async (): Promise<EspnTeam[]> => {
    const lists = await Promise.all(
      LIVE_LEAGUES.filter((l) => l.clubs).map((l) => settle(fetchOnce(`${ESPN_SITE}/${l.slug}/teams`)).then((json) => parseEspnTeams(json, l.slug))),
    );
    return lists.flat();
  };

  async function espnSeason(club: string, season: SeasonRef): Promise<{ text: string | null; missing: LiveMissing[] }> {
    if (season.start < ESPN_FIRST_SEASON) {
      return { text: null, missing: [{ item: `Match-by-match results and lineups for ${club} in ${season.label} (ESPN's archive starts in ${ESPN_FIRST_SEASON}-04)`, status: 'not_covered' }] };
    }
    const team = findClub(club, await teamIndex());
    if (!team) {
      return { text: null, missing: [{ item: `ESPN results and lineups for ${club} in ${season.label} (ESPN lists only clubs in its covered leagues today)`, status: 'not_covered' }] };
    }
    const schedule = await settle(fetchOnce(`${ESPN_SITE}/all/teams/${team.id}/schedule?season=${season.start}`));
    const matches = parseClubSchedule(schedule, team.id).filter((m) => m.completed && !/charity|community shield|super ?cup|supercopa|supercoppa|trophée/i.test(m.competition));
    if (!matches.length) {
      return { text: null, missing: [{ item: `ESPN results for ${team.name} in ${season.label}`, status: schedule ? 'empty' : 'failed' }] };
    }
    // The league is the competition with the most matches among the covered leagues.
    const leagueCounts = new Map<string, number>();
    for (const m of matches) if (m.leagueSlug && LIVE_LEAGUES.some((l) => l.clubs && l.slug === m.leagueSlug)) leagueCounts.set(m.leagueSlug, (leagueCounts.get(m.leagueSlug) ?? 0) + 1);
    const leagueSlug = [...leagueCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const leagueMatches = matches.filter((m) => m.leagueSlug === leagueSlug);
    const [standings, lineups] = await Promise.all([
      leagueSlug ? settle(fetchOnce(`${ESPN_STANDINGS}/${leagueSlug}/standings?season=${season.start}`)) : Promise.resolve(null),
      Promise.all(
        spreadSample(leagueMatches, SAMPLED_LINEUPS).map(async (m) => parseMatchLineup(await settle(fetchOnce(`${ESPN_SITE}/all/summary?event=${m.id}`)), team.id, m)),
      ).then((ls) => ls.filter((l): l is LiveLineup => l !== null)),
    ]);
    const table = parseEspnStandings(standings).rows;
    const row = table.find((r) => r.team && (r.team === team.name || nameScore(team.name, [r.team]) > 0));
    const report: EspnSeasonReport = {
      team: team.name,
      season,
      league: LIVE_LEAGUES.find((l) => l.slug === leagueSlug)?.name ?? null,
      leagueSlug,
      records: competitionRecords(matches),
      standing: row ? { rank: row.rank, points: row.points, of: table.length, champion: table.find((r) => r.rank === 1)?.team ?? null } : null,
      lineups,
      leagueMatches: leagueMatches.length,
    };
    return {
      text: formatEspnSeason(report),
      missing: leagueMatches.length && !lineups.length ? [{ item: `Starting XIs for ${team.name} in ${season.label} (ESPN had none)`, status: 'empty' }] : [],
    };
  }

  /** A club's season: ESPN's results and sampled lineups (2003-04 on), and the Wikipedia article. */
  async function clubSeason(club: string, seasonText: string): Promise<HistoryResult> {
    const season = parseSeason(seasonText);
    if (!season) return { found: false, status: 'empty', reason: `no season in "${seasonText}" (write it as YYYY-YY)`, missing: [] };
    if (season.start >= options.currentSeasonStart()) {
      return { found: false, status: 'not_covered', reason: 'that season is in progress; use the live club tool', missing: [] };
    }
    return remembered(historyKey('club-season', club, season), Infinity, async () => {
      const [espn, title] = await Promise.all([
        espnSeason(club, season),
        wikiSearch(`${season.wikiLabel} ${club} season`).then((hits) => (hits ? pickSeasonTitle(hits.map((h) => h.title), club, season) : null)),
      ]);
      const page = title ? await wikiPage(title) : null;
      const missing = [...espn.missing, ...(page ? [] : [{ item: `Wikipedia's article on ${club}'s ${season.label} season`, status: 'empty' as const }])];
      const parts = [page ? formatClubSeasonPage(page, club) : null, espn.text].filter((p): p is string => Boolean(p));
      if (!parts.length) return { found: false, status: missing.some((m) => m.status === 'failed') ? 'failed' : 'empty', reason: 'no source had this season', missing };
      return {
        found: true,
        title: page?.title ?? `${club} ${season.label}`,
        text: parts.join('\n\n'),
        sources: [...(page ? [pageUrl(page.title)] : []), ...(espn.text ? ['ESPN match data'] : [])],
        missing,
      };
    });
  }

  /** A player's career from his Wikipedia article: clubs, appearances and goals by season, caps, honours. */
  async function playerCareer(name: string): Promise<HistoryResult> {
    return remembered(historyKey('player', name), PLAYER_REFRESH_MS, async () => {
      const hits = await wikiSearch(`${name} footballer`);
      if (!hits) return { found: false, status: 'failed', reason: "Wikipedia didn't answer", missing: [] };
      const title = pickPlayerTitle(hits, name);
      const page = title ? await wikiPage(title) : null;
      if (!page) return { found: false, status: title ? 'failed' : 'empty', reason: title ? "Wikipedia didn't return the article" : 'no Wikipedia article found', missing: [] };
      if (!/class="[^"]*\binfobox\b/i.test(page.html) || !/senior career|position/i.test(page.html.slice(0, 200_000))) {
        return { found: false, status: 'empty', reason: `"${page.title}" isn't a footballer's article`, missing: [] };
      }
      return { found: true, title: page.title, text: formatPlayerPage(page), sources: [pageUrl(page.title)], missing: [] };
    });
  }

  return { clubSeason, playerCareer };
}
