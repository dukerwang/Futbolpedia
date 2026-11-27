/**
 * Who a name means: association football players and clubs, resolved against Wikidata. Phase 1 of
 * the football knowledge base (docs/superpowers/specs/2026-11-27-football-knowledge-base-design.md):
 * every later layer joins on the identity found here.
 *
 * A name goes to Wikidata's `wbsearchentities`, and one SPARQL query then reads the hits that are
 * association football players or clubs. A name resolves only when one candidate clearly wins;
 * otherwise the candidates come back and the caller chooses. It never guesses: how well known a
 * candidate is orders the candidates and never picks one.
 *
 * Wikidata's appearance and goal counts are stale, so none is read, stored or returned. No model is
 * called. Pure parsing, with the fetch injected.
 */

export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
export const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
export const WIKIDATA_ENTITY_PAGE = 'https://www.wikidata.org/wiki/';
/** Wikidata asks clients to name themselves; the same agent the server sends Wikipedia. */
export const KB_USER_AGENT = 'Futbolpedia/3.6 (https://github.com/dukerwang/Futbolpedia)';

export const SEARCH_TIMEOUT_MS = 7_000;
export const SPARQL_TIMEOUT_MS = 12_000;
/** Search hits read for a name, the most `wbsearchentities` gives an anonymous client. */
export const SEARCH_LIMIT = 50;
/** Candidates returned for an ambiguous name, best named and best known first. */
export const MAX_CANDIDATES = 8;
const MAX_ALIASES = 30;
const MAX_SPELLS = 60;
/** An open-ended spell says nothing about a player older than this. */
const OLDEST_CURRENT_PLAYER = 45;

/** Wikidata items and properties, each confirmed against Wikidata by its English label. */
export const WD = {
  footballer: 'Q937857', // association football player
  footballClub: 'Q476028', // association football club
  womensClub: 'Q51481377', // women's association football club
  nationalTeam: 'Q1194951', // national sports team
  loan: 'Q2914547', // loan
  occupation: 'P106',
  instanceOf: 'P31',
  subclassOf: 'P279',
  birthDate: 'P569',
  deathDate: 'P570',
  citizenship: 'P27',
  sportCountry: 'P1532', // country for sport
  country: 'P17',
  position: 'P413', // position played on team / speciality
  memberOfTeam: 'P54',
  startTime: 'P580',
  endTime: 'P582',
  acquisition: 'P1642', // acquisition transaction
} as const;

/** The external IDs read, by the name each is returned and stored under. */
export const EXTERNAL_ID_PROPERTIES = {
  espn: 'P3681', // ESPN FC player ID
  transfermarkt: 'P2446', // Transfermarkt player ID
  fbref: 'P5750', // FBref player ID
  sofascore: 'P12302', // Sofascore player ID
  uefa: 'P2276', // UEFA player ID
} as const;

export type KbExternalIds = Partial<Record<keyof typeof EXTERNAL_ID_PROPERTIES, string>>;
export type KbKind = 'player' | 'club';

export interface KbSpell {
  teamId: string;
  club: string;
  /** The years Wikidata gives; null where it gives none. */
  start: number | null;
  end: number | null;
  loan?: boolean;
}

export interface KbEntity {
  /** The Wikidata ID. */
  id: string;
  kind: KbKind;
  label: string;
  aliases: string[];
  /** YYYY-MM-DD, or YYYY-MM or YYYY where Wikidata knows no more. */
  birthDate: string | null;
  /** A player's sporting nationality (else citizenship); a club's country. */
  nationality: string[];
  positions: string[];
  /** A player's open-ended club spell, per Wikidata, which can lag a transfer; null when it can't be told. */
  currentClub: string | null;
  /** A player's clubs, earliest first. National teams are left out. */
  spells: KbSpell[];
  /** The English Wikipedia article's title. */
  wikipediaTitle: string | null;
  externalIds: KbExternalIds;
  /** When it was read from Wikidata (ISO). */
  fetchedAt: string;
}

export interface KbHints {
  /** Each a club the player was at, or a country. */
  terms: string[];
  birthYear: number | null;
  /** Years in question, inclusive. */
  era: { from: number; to: number } | null;
}

export type KbResolution =
  | { status: 'resolved'; entity: KbEntity }
  | { status: 'ambiguous'; candidates: KbEntity[]; reason: string }
  | { status: 'not_found'; reason: string }
  | { status: 'failed'; reason: string };

export type KbGetJson = (url: string, options: { headers: Record<string, string>; timeoutMs: number }) => Promise<unknown>;

// ---------------------------------------------------------------------------------------------
// Names

/** Letters that accent stripping leaves alone. */
const LETTERS: Record<string, string> = { ø: 'o', ł: 'l', đ: 'd', ð: 'd', æ: 'ae', œ: 'oe', ß: 'ss', þ: 'th', ı: 'i' };

/** A name as comparable words: no case, accents or punctuation. */
export function foldWords(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[øłđðæœßþı]/g, (c) => LETTERS[c])
    .replace(/['’.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** How a candidate's names meet the query: one is the query, one holds all its words, or neither. */
export type NameTier = 'exact' | 'words' | 'other';

export function nameTier(query: string, entity: Pick<KbEntity, 'label' | 'aliases'>): NameTier {
  const q = foldWords(query);
  if (!q.length) return 'other';
  const names = [entity.label, ...entity.aliases].map(foldWords);
  if (names.some((n) => n.join(' ') === q.join(' '))) return 'exact';
  return names.some((n) => q.every((w) => n.includes(w))) ? 'words' : 'other';
}

// ---------------------------------------------------------------------------------------------
// Hints

const HINT_FILLER = new Set(['born', 'in', 'the', 'era', 'around', 'circa', 'season', 'seasons', 'at', 'played', 'for', 'player', 'footballer', 'club', 'from', 'of']);

/**
 * A hint as the resolver reads it: "born YYYY" or a lone year is a birth year; YYYY-YY, a span of
 * years or a decade (YYYYs) is the era in question; what's left, split on commas, is a club or a
 * country.
 */
export function parseHint(hint: string): KbHints {
  let rest = ` ${hint} `;
  let birthYear: number | null = null;
  let era: KbHints['era'] = null;
  const take = (re: RegExp, use: (m: RegExpMatchArray) => void) => {
    const m = rest.match(re);
    if (!m) return;
    use(m);
    rest = rest.replace(m[0], ' , ');
  };
  take(/\b(?:born|b\.)\s*(?:in\s+)?((?:19|20)\d{2})\b/i, (m) => (birthYear = Number(m[1])));
  take(/\b((?:19|20)\d{2})\s*(?:-|–|\/|\bto\b)\s*((?:19|20)\d{2}|\d{2})\b/i, (m) => {
    const from = Number(m[1]);
    let to = Number(m[2]);
    if (m[2].length === 2) {
      to += Math.floor(from / 100) * 100;
      if (to < from) to += 100;
    }
    era = { from: Math.min(from, to), to: Math.max(from, to) };
  });
  take(/\b((?:19|20)\d0)['’]?s\b/i, (m) => {
    const from = Number(m[1]);
    era ??= { from, to: from + 9 };
  });
  take(/\b((?:19|20)\d{2})\b/, (m) => (birthYear ??= Number(m[1])));
  const terms = rest
    .split(/[,;]|\band\b/i)
    .map((term) =>
      term
        .split(/\s+/)
        .filter((w) => w && !HINT_FILLER.has(foldWords(w).join('')))
        .join(' ')
        .trim(),
    )
    .filter((term) => foldWords(term).length > 0);
  return { terms, birthYear, era };
}

export const hasHints = (h: KbHints): boolean => h.terms.length > 0 || h.birthYear !== null || h.era !== null;

/** A hint in one canonical form, so two wordings of it share a stored lookup. */
export const hintKey = (h: KbHints): string =>
  [h.terms.map((t) => foldWords(t).join(' ')).sort().join(','), h.birthYear ?? '', h.era ? `${h.era.from}-${h.era.to}` : ''].join('|');

const CLUB_FILLER = new Set(['fc', 'cf', 'afc', 'f', 'c', 'football', 'futbol', 'club', 'the']);
const clubWords = (name: string): string[] => foldWords(name).filter((w) => !CLUB_FILLER.has(w));

/** Whether a hinted club's words run together inside one of a club's names. */
function namesClub(term: string, names: string[]): boolean {
  const want = clubWords(term);
  if (!want.length) return false;
  return names.some((name) => {
    const have = clubWords(name);
    return have.some((_, i) => want.every((w, j) => have[i + j] === w));
  });
}

/** Every name of every team in a player's spells, for matching a hinted club ("PSG" is an alias). */
export type TeamNames = Map<string, string[]>;

function meetsHints(entity: KbEntity, hints: KbHints, teams: TeamNames, thisYear: number): boolean {
  if (hints.birthYear !== null && Number(entity.birthDate?.slice(0, 4)) !== hints.birthYear) return false;
  if (hints.era) {
    const { from, to } = hints.era;
    // A spell with no end runs to now only at the current club; elsewhere only its start is known.
    const endOf = (s: KbSpell) => s.end ?? (s.club === entity.currentClub ? thisYear : s.start!);
    if (!entity.spells.some((s) => s.start !== null && s.start <= to && endOf(s) >= from)) return false;
  }
  return hints.terms.every(
    (term) =>
      entity.spells.some((s) => namesClub(term, [s.club, ...(teams.get(s.teamId) ?? [])])) ||
      // A club has no spells: a word of its own names ("London") can tell it apart. Wikidata's
      // country for a British club is the United Kingdom.
      (entity.kind === 'club' && namesClub(term, [entity.label, ...entity.aliases, entity.wikipediaTitle ?? ''])) ||
      entity.nationality.some((n) => foldWords(n).join(' ') === foldWords(term).join(' ')),
  );
}

// ---------------------------------------------------------------------------------------------
// The decision

export interface RankedEntity {
  entity: KbEntity;
  /** How many Wikipedias have an article: orders candidates, never picks one. */
  sitelinks: number;
}

const TIER_ORDER: Record<NameTier, number> = { exact: 0, words: 1, other: 2 };

/**
 * One candidate or the candidates. With a hint, a name resolves when one candidate whose name holds
 * the query meets it (the one whose name is the query, when only one of several is). Without one,
 * only when a single candidate is called exactly that. For a player, one word that is only an alias
 * or part of a name never resolves by itself: the search matches how names start, so others who
 * share a surname may not have been returned. A cut-off search resolves only exact names.
 */
export function chooseEntity(
  query: string,
  found: RankedEntity[],
  hints: KbHints,
  teams: TeamNames,
  options: { truncated?: boolean; thisYear: number },
): KbResolution {
  if (!found.length) return { status: 'not_found', reason: 'Wikidata has no association football player or club by that name' };
  const ranked = found
    .map((f) => ({ ...f, tier: nameTier(query, f.entity) }))
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.sitelinks - a.sitelinks || a.entity.id.localeCompare(b.entity.id));
  const named = ranked.filter((r) => r.tier !== 'other');
  const pool = named.length ? named : ranked;
  const ambiguous = (list: typeof ranked, reason: string): KbResolution => ({
    status: 'ambiguous',
    candidates: list.slice(0, MAX_CANDIDATES).map((r) => r.entity),
    reason,
  });
  const matching = hasHints(hints) ? pool.filter((r) => meetsHints(r.entity, hints, teams, options.thisYear)) : pool;
  if (!matching.length) return ambiguous(pool, 'no candidate fits the hint');
  const exact = matching.filter((r) => r.tier === 'exact');
  const winner = exact.length === 1 ? exact[0] : exact.length === 0 && matching.length === 1 ? matching[0] : null;
  if (!winner || !named.includes(winner)) {
    return ambiguous(matching, matching.length > 1 ? 'several people or clubs fit the name' : 'the one candidate only partly fits the name');
  }
  if (options.truncated && winner.tier !== 'exact') return ambiguous(matching, 'too many search results to be sure only one fits');
  if (!hasHints(hints) && winner.entity.kind === 'player' && foldWords(query).length === 1) {
    if (foldWords(winner.entity.label).join(' ') !== foldWords(query).join(' ')) {
      return ambiguous(matching, 'one word of a name is not enough to be sure; add the full name or a hint');
    }
  }
  return { status: 'resolved', entity: winner.entity };
}

// ---------------------------------------------------------------------------------------------
// Wikidata

const QID = /^Q[1-9]\d*$/;

/** The one query a resolution sends: which hits are players or clubs, their identity, and their teams' names. */
export function identityQuery(ids: string[]): string {
  const values = ids.filter((id) => QID.test(id)).map((id) => `wd:${id}`).join(' ');
  const idUnion = Object.entries(EXTERNAL_ID_PROPERTIES)
    .map(([field, property]) => `(wdt:${property} "${field}")`)
    .join(' ');
  return `SELECT ?item ?kind ?field ?value ?valueLabel ?start ?end ?loan ?precision WITH {
  SELECT DISTINCT ?item ?kind WHERE {
    VALUES ?item { ${values} }
    { ?item wdt:${WD.occupation} wd:${WD.footballer} . BIND("player" AS ?kind) }
    UNION { ?item wdt:${WD.instanceOf}/wdt:${WD.subclassOf}* wd:${WD.footballClub} . FILTER NOT EXISTS { ?item wdt:${WD.instanceOf} wd:${WD.womensClub} } BIND("club" AS ?kind) }
  }
} AS %found WITH {
  SELECT DISTINCT ?team WHERE { INCLUDE %found . ?item p:${WD.memberOfTeam}/ps:${WD.memberOfTeam} ?team }
} AS %teams
WHERE {
  {
    INCLUDE %found
    { BIND("label" AS ?field) ?item rdfs:label ?value . FILTER(LANG(?value) IN ("en","mul")) }
    UNION { BIND("alias" AS ?field) ?item skos:altLabel ?value . FILTER(LANG(?value) IN ("en","mul")) }
    UNION { BIND("sitelinks" AS ?field) ?item wikibase:sitelinks ?value . }
    UNION { BIND("article" AS ?field) ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?value . }
    UNION { BIND("birth" AS ?field) ?item p:${WD.birthDate} ?birth . ?birth a wikibase:BestRank ; psv:${WD.birthDate} ?node . ?node wikibase:timeValue ?value ; wikibase:timePrecision ?precision . }
    UNION { BIND("death" AS ?field) ?item wdt:${WD.deathDate} ?value . }
    UNION {
      VALUES (?property ?field) { (wdt:${WD.sportCountry} "sportCountry") (wdt:${WD.citizenship} "citizenship") (wdt:${WD.country} "country") (wdt:${WD.position} "position") }
      ?item ?property ?value .
      OPTIONAL { ?value rdfs:label ?en . FILTER(LANG(?en) = "en") }
      OPTIONAL { ?value rdfs:label ?mul . FILTER(LANG(?mul) = "mul") }
      BIND(COALESCE(?en, ?mul) AS ?valueLabel)
    }
    UNION { VALUES (?property ?field) { ${idUnion} } ?item ?property ?value . }
    UNION {
      BIND("spell" AS ?field)
      ?item p:${WD.memberOfTeam} ?statement . ?statement ps:${WD.memberOfTeam} ?value ; wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank)
      OPTIONAL { ?statement pq:${WD.startTime} ?start }
      OPTIONAL { ?statement pq:${WD.endTime} ?end }
      OPTIONAL { ?statement pq:${WD.acquisition} wd:${WD.loan} . BIND(true AS ?loan) }
    }
  }
  UNION {
    INCLUDE %teams
    BIND(?team AS ?item)
    { BIND("teamLabel" AS ?field) ?team rdfs:label ?value . FILTER(LANG(?value) IN ("en","mul")) }
    UNION { BIND("teamAlias" AS ?field) ?team skos:altLabel ?value . FILTER(LANG(?value) IN ("en","mul")) }
    UNION { BIND("teamNational" AS ?field) FILTER EXISTS { ?team wdt:${WD.instanceOf}/wdt:${WD.subclassOf}* wd:${WD.nationalTeam} } BIND(true AS ?value) }
  }
}`;
}

interface Row {
  item: string;
  kind: string;
  field: string;
  value: string;
  valueLabel: string;
  start: string;
  end: string;
  loan: string;
  precision: string;
  /** The value's language, for choosing the English label over the multilingual one. */
  lang: string;
}

const entityId = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1);

/** The query's bindings as flat rows; anything unexpected is skipped. */
function readRows(json: unknown): Row[] | null {
  const bindings = (json as { results?: { bindings?: unknown } } | null)?.results?.bindings;
  if (!Array.isArray(bindings)) return null;
  const text = (b: any, key: string): string => (typeof b?.[key]?.value === 'string' ? b[key].value : '');
  return bindings.map((b: any) => ({
    item: entityId(text(b, 'item')),
    kind: text(b, 'kind'),
    field: text(b, 'field'),
    value: text(b, 'value'),
    valueLabel: text(b, 'valueLabel'),
    start: text(b, 'start'),
    end: text(b, 'end'),
    loan: text(b, 'loan'),
    precision: text(b, 'precision'),
    lang: typeof b?.value?.['xml:lang'] === 'string' ? b.value['xml:lang'] : '',
  }));
}

const yearOf = (time: string): number | null => {
  const m = /^(\d{4})-/.exec(time);
  return m ? Number(m[1]) : null;
};

/** A birth date as precisely as Wikidata knows it (precision 11 is a day, 10 a month, 9 a year). */
function birthDateOf(time: string, precision: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(time);
  const p = Number(precision);
  if (!m || p < 9) return null;
  return p >= 11 ? m[1] : p === 10 ? m[1].slice(0, 7) : m[1].slice(0, 4);
}

const unique = (list: string[]): string[] => [...new Set(list.filter(Boolean))];

/** The English label, else the multilingual one; `rows` are one item's label rows. */
const labelOf = (rows: Row[]): string => (rows.find((r) => r.lang === 'en') ?? rows[0])?.value ?? '';

/**
 * The club a player is at, from his open-ended spells: the latest one to start. None when he has
 * died, is older than any current player, or a later permanent spell has already ended (so the open
 * one was never closed).
 */
export function currentClubOf(spells: KbSpell[], facts: { birthYear: number | null; dead: boolean; thisYear: number }): string | null {
  if (facts.dead || (facts.birthYear !== null && facts.thisYear - facts.birthYear > OLDEST_CURRENT_PLAYER)) return null;
  const open = spells.filter((s) => s.end === null && s.start !== null).sort((a, b) => b.start! - a.start!);
  const latest = open[0];
  if (!latest) return null;
  if (spells.some((s) => !s.loan && s.end !== null && s.start !== null && s.start > latest.start!)) return null;
  return latest.club;
}

/** The query's answer as entities, with every team's names for matching a hinted club. */
export function parseIdentityRows(json: unknown, now: Date): { found: RankedEntity[]; teams: TeamNames } | null {
  const rows = readRows(json);
  if (!rows) return null;
  const teamRows = new Map<string, Row[]>();
  const itemRows = new Map<string, Row[]>();
  for (const row of rows) {
    const into = row.field.startsWith('team') ? teamRows : itemRows;
    const list = into.get(row.item) ?? [];
    list.push(row);
    into.set(row.item, list);
  }
  const teams: TeamNames = new Map();
  const teamLabels = new Map<string, string>();
  const national = new Set<string>();
  for (const [id, list] of teamRows) {
    const labels = list.filter((r) => r.field === 'teamLabel');
    teamLabels.set(id, labelOf(labels));
    teams.set(id, unique(list.filter((r) => r.field !== 'teamNational').map((r) => r.value)));
    if (list.some((r) => r.field === 'teamNational')) national.add(id);
  }

  const found: RankedEntity[] = [];
  for (const [id, list] of itemRows) {
    const of = (field: string) => list.filter((r) => r.field === field);
    const label = labelOf(of('label'));
    if (!QID.test(id) || !label) continue;
    // Someone who is both (rare) is a player.
    const kind: KbKind = list.some((r) => r.kind === 'player') ? 'player' : 'club';
    const births = of('birth').map((r) => birthDateOf(r.value, r.precision)).filter((d): d is string => Boolean(d));
    const birthDate = births.sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? null;

    const spells = new Map<string, KbSpell>();
    if (kind === 'player') {
      for (const r of of('spell')) {
        const teamId = entityId(r.value);
        const club = teamLabels.get(teamId);
        if (!club || national.has(teamId)) continue;
        const spell: KbSpell = { teamId, club, start: yearOf(r.start), end: yearOf(r.end), ...(r.loan ? { loan: true } : {}) };
        spells.set(`${teamId}|${spell.start}|${spell.end}|${spell.loan ?? false}`, spell);
      }
    }
    const ordered = [...spells.values()]
      .sort((a, b) => (a.start ?? 9999) - (b.start ?? 9999) || (a.end ?? 9999) - (b.end ?? 9999) || a.club.localeCompare(b.club))
      .slice(-MAX_SPELLS);
    const countries = (field: string) => unique(of(field).map((r) => r.valueLabel)).sort();
    const nationality =
      kind === 'club' ? countries('country') : countries('sportCountry').length ? countries('sportCountry') : countries('citizenship');
    const externalIds: KbExternalIds = {};
    if (kind === 'player') {
      for (const key of Object.keys(EXTERNAL_ID_PROPERTIES) as (keyof KbExternalIds)[]) {
        const value = of(key).map((r) => r.value).sort()[0];
        if (value) externalIds[key] = value;
      }
    }
    found.push({
      sitelinks: Number(of('sitelinks')[0]?.value) || 0,
      entity: {
        id,
        kind,
        label,
        aliases: unique([...of('label'), ...of('alias')].map((r) => r.value))
          .filter((a) => a !== label)
          .sort()
          .slice(0, MAX_ALIASES),
        birthDate: kind === 'player' ? birthDate : null,
        nationality,
        positions: kind === 'player' ? unique(of('position').map((r) => r.valueLabel)).sort() : [],
        currentClub:
          kind === 'player'
            ? currentClubOf(ordered, { birthYear: birthDate ? Number(birthDate.slice(0, 4)) : null, dead: of('death').length > 0, thisYear: now.getUTCFullYear() })
            : null,
        spells: ordered,
        wikipediaTitle: of('article')[0]?.value ?? null,
        externalIds,
        fetchedAt: now.toISOString(),
      },
    });
  }
  return { found, teams };
}

const whyFailed = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 120);

/** Resolves a name against Wikidata: one search, then at most one SPARQL query. Never throws. */
export async function resolveIdentity(
  name: string,
  hints: KbHints,
  deps: { getJson: KbGetJson; now?: () => number },
): Promise<KbResolution> {
  const query = name.trim();
  if (!foldWords(query).length) return { status: 'not_found', reason: 'no name given' };
  const get = (url: string, params: Record<string, string>, timeoutMs: number, accept: string) =>
    deps.getJson(`${url}?${new URLSearchParams(params)}`, { headers: { 'User-Agent': KB_USER_AGENT, Accept: accept }, timeoutMs });

  let search: any;
  try {
    search = await get(
      WIKIDATA_API,
      { action: 'wbsearchentities', search: query, language: 'en', uselang: 'en', type: 'item', limit: String(SEARCH_LIMIT), format: 'json' },
      SEARCH_TIMEOUT_MS,
      'application/json',
    );
  } catch (e) {
    return { status: 'failed', reason: `Wikidata's search failed: ${whyFailed(e)}` };
  }
  if (!Array.isArray(search?.search)) return { status: 'failed', reason: "Wikidata's search returned no result list" };
  const ids = unique(search.search.map((hit: any) => String(hit?.id ?? ''))).filter((id) => QID.test(id)).slice(0, SEARCH_LIMIT);
  if (!ids.length) return { status: 'not_found', reason: 'Wikidata has nothing by that name' };

  let answer: unknown;
  try {
    answer = await get(WIKIDATA_SPARQL, { query: identityQuery(ids), format: 'json' }, SPARQL_TIMEOUT_MS, 'application/sparql-results+json');
  } catch (e) {
    return { status: 'failed', reason: `Wikidata's query failed: ${whyFailed(e)}` };
  }
  const now = new Date((deps.now ?? Date.now)());
  const parsed = parseIdentityRows(answer, now);
  if (!parsed) return { status: 'failed', reason: "Wikidata's query returned no results" };
  return chooseEntity(query, parsed.found, hints, parsed.teams, {
    truncated: search['search-continue'] !== undefined,
    thisYear: now.getUTCFullYear(),
  });
}

// ---------------------------------------------------------------------------------------------
// What the tool reads

/** What `/api/kb/who-is` answers. */
export type WhoIsResponse = KbResolution;

const years = (s: KbSpell): string => (s.start === null && s.end === null ? 'years not given' : `${s.start ?? '?'} to ${s.end ?? 'no end given'}`);
const spellLine = (s: KbSpell): string => `${s.club} (${years(s)}${s.loan ? ', loan' : ''})`;
/** Clubs shown for each candidate of an ambiguous name. */
const CANDIDATE_SPELLS = 5;

function describeEntity(e: KbEntity, spellLimit: number): string {
  const spells = e.spells.slice(-spellLimit);
  const ids = Object.entries(e.externalIds).map(([k, v]) => `${k} ${v}`);
  return [
    `${e.label} (${e.kind}, Wikidata ${e.id})`,
    e.aliases.length ? `Also known as: ${e.aliases.slice(0, 6).join('; ')}` : '',
    e.birthDate ? `Born: ${e.birthDate}` : '',
    e.nationality.length ? `${e.kind === 'club' ? 'Country' : 'Nationality'}: ${e.nationality.join(', ')}` : '',
    e.positions.length ? `Positions: ${e.positions.join(', ')}` : '',
    e.currentClub ? `Current club, as Wikidata lists it: ${e.currentClub}` : '',
    spells.length ? `Clubs${spells.length < e.spells.length ? ` (latest ${spells.length} of ${e.spells.length} spells)` : ''}: ${spells.map(spellLine).join('; ')}` : '',
    e.wikipediaTitle ? `English Wikipedia article: ${e.wikipediaTitle}` : '',
    ids.length ? `IDs elsewhere: ${ids.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A resolved or ambiguous name as the evidence ledger holds it. */
export function formatWhoIs(name: string, result: Extract<KbResolution, { status: 'resolved' | 'ambiguous' }>): string {
  if (result.status === 'resolved') {
    return `${describeEntity(result.entity, MAX_SPELLS)}\nWikidata identity as of ${result.entity.fetchedAt.slice(0, 10)}. It holds no appearance, goal or other statistics.`;
  }
  return `"${name}" is not settled (${result.reason}). The candidates, none of them chosen:
${result.candidates.map((c, i) => `${i + 1}. ${describeEntity(c, CANDIDATE_SPELLS)}`).join('\n')}
Wikidata identity only, with no appearance, goal or other statistics. Ask again with a fuller name or a hint to settle it.`;
}
