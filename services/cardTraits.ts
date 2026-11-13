import { Type } from '@google/genai';
import type { PlayerProfile } from '../types';
import { ATTRIBUTE_LABELS } from '../constants/ratingTiers';
import { CARD_TRAIT_RULES } from '../prompts/dossierPrompt';
import { generateStructured } from './aiClient';
import { toBasePlayerSlug } from './dossierCards';

/**
 * A card's strengths and weaknesses are written about one player. The model drifts back to the
 * same stock lines across cards (the position's default trade-offs, the attribute restated), so
 * after synthesis each item is checked against the lines already on other players' cards, and the
 * ones that read the same are rewritten in one small call. That call also checks every other
 * weakness against the rules, since a weakness can be his alone and still not be one.
 */

export type TraitKind = 'strength' | 'weakness';

/** How the synthesis schema returns a strength: its name, how he does it, what it changes. */
export interface RawStrength {
  title?: string;
  method?: string;
  impact?: string;
}

/** How the synthesis schema returns a weakness: its name, where it shows, what it costs. */
export interface RawWeakness {
  title?: string;
  whereItShows?: string;
  cost?: string;
}

export const STRENGTH_ITEM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description:
        'Two to four plain words a football fan would use, in title case, naming his particular way of doing it, not the attribute or skill category it falls under.',
    },
    method: {
      type: Type.STRING,
      description:
        'One or two sentences: how he does it, in which situations, and what sets his way of doing it apart from other players strong in the same area.',
    },
    impact: {
      type: Type.STRING,
      description: 'One sentence: what it changes in matches for his team, with the evidence for it.',
    },
  },
  required: ['title', 'method', 'impact'],
};

export const WEAKNESS_ITEM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description:
        'Two to four plain words a football fan would use, in title case, naming this specific limitation of his, not the attribute or skill category it falls under.',
    },
    whereItShows: {
      type: Type.STRING,
      description:
        'One or two sentences: the match situations, phases or opponents where it shows in the role this card rates, and what it looks like when it does.',
    },
    cost: {
      type: Type.STRING,
      description:
        'One sentence: what it cost his team, how opponents played on it or what his team had to build around, with the evidence for it.',
    },
  },
  required: ['title', 'whereItShows', 'cost'],
};

const endSentence = (s: string): string => {
  const t = s.trim();
  return !t || /[.!?…]["')\]]?$/.test(t) ? t : `${t}.`;
};

const cleanTitle = (title: string): string => title.replace(/\*+/g, '').trim().replace(/[:.\s]+$/, '');

/** One card line, `**Title:** explanation.`, from a title and its sentences. */
export function formatTrait(title: string | undefined, ...parts: Array<string | undefined>): string {
  const body = parts
    .map((p) => endSentence(p ?? ''))
    .filter(Boolean)
    .join(' ');
  const name = cleanTitle(title ?? '');
  if (!name) return body;
  return body ? `**${name}:** ${body}` : `**${name}.**`;
}

/**
 * The card lines for a strengths or weaknesses array as the model returned it: structured items
 * are joined into one line each; a plain string (older drafts, patches) passes through.
 */
export function toTraitLines(raw: unknown, kind: TraitKind): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      if (kind === 'strength') {
        const s = item as RawStrength;
        return formatTrait(s.title, s.method, s.impact);
      }
      const w = item as RawWeakness;
      return formatTrait(w.title, w.whereItShows, w.cost);
    })
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The bold title of a card line, or the text before its first colon. */
export function traitTitle(line: string): string {
  const bold = line.match(/^\s*\*\*(.+?)\*\*/);
  const raw = bold ? bold[1] : line.split(':')[0];
  return cleanTitle(raw);
}

const TITLE_STOPWORDS = new Set(
  'a an the of and or in on to with for at under against from by his its into off out vs versus'.split(' '),
);

const STEM_SUFFIXES: string[] = ['ities', 'ity', 'ness', 'ions', 'ion', 'ies', 'ing', 'ed', 'es', 's', 'al', 'ic', 'y'];

const stem = (word: string): string => {
  for (const suffix of STEM_SUFFIXES) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
};

/** A title's content words, lightly stemmed; a hyphenated compound stays one word. */
export function titleWords(title: string): Set<string> {
  const words: string[] = title.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  return new Set(words.filter((w) => w.length > 2 && !TITLE_STOPWORDS.has(w)).map(stem));
}

const traitId = (t: { kind: TraitKind; index: number }) => `${t.kind === 'strength' ? 'S' : 'W'}${t.index + 1}`;

/** Share of the two titles' words they have in common (Jaccard). */
export function titleSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Titles this close read as the same line. Tuned on the shared cards: rewordings of one stock line meet it, two traits in the same area of the game don't. */
export const STOCK_TITLE_SIMILARITY = 0.6;
/** A line on this many other players' cards is a stock line rather than a description of him. */
export const STOCK_MIN_PLAYERS = 2;

export interface StockTrait {
  kind: TraitKind;
  index: number;
  line: string;
  /** The other players whose cards carry the same line. */
  sharedWith: string[];
}

/**
 * The strengths and weaknesses on a card that read the same as lines on at least
 * `STOCK_MIN_PLAYERS` other players' cards in `pool`. The player's own other cards don't count.
 */
export function findStockTraits(profile: PlayerProfile, pool: PlayerProfile[]): StockTrait[] {
  const self = toBasePlayerSlug(profile.basicInfo.name);
  const index: Record<TraitKind, Array<{ player: string; words: Set<string> }>> = { strength: [], weakness: [] };
  for (const card of pool) {
    const player = card.basicInfo?.name;
    if (!player || toBasePlayerSlug(player) === self) continue;
    for (const line of card.strengths ?? []) index.strength.push({ player, words: titleWords(traitTitle(line)) });
    for (const line of card.weaknesses ?? []) index.weakness.push({ player, words: titleWords(traitTitle(line)) });
  }

  const stock: StockTrait[] = [];
  const check = (lines: string[], kind: TraitKind) =>
    lines.forEach((line, i) => {
      const words = titleWords(traitTitle(line));
      if (words.size === 0) return;
      const players = new Set<string>();
      for (const other of index[kind]) {
        if (titleSimilarity(words, other.words) >= STOCK_TITLE_SIMILARITY) players.add(other.player);
      }
      if (players.size >= STOCK_MIN_PLAYERS) stock.push({ kind, index: i, line, sharedWith: [...players] });
    });
  check(profile.strengths ?? [], 'strength');
  check(profile.weaknesses ?? [], 'weakness');
  return stock;
}

/** A line the rewrite call looks at: a stock line to rewrite, or another weakness to check against the rules. */
export interface ReviewTrait extends StockTrait {
  review: 'rewrite' | 'check';
}

/**
 * Every line the rewrite call looks at: the stock lines (`findStockTraits`), to rewrite, and each
 * of his other weaknesses, to check against the rules and replace or drop only when one breaks
 * them. A card with no stock lines and no weaknesses needs no call.
 */
export function findTraitsToReview(profile: PlayerProfile, pool: PlayerProfile[]): ReviewTrait[] {
  const stock = findStockTraits(profile, pool);
  const flagged = new Set(stock.map(traitId));
  const items: ReviewTrait[] = stock.map((s) => ({ ...s, review: 'rewrite' }));
  (profile.weaknesses ?? []).forEach((line, index) => {
    const item = { kind: 'weakness' as const, index, line, sharedWith: [] };
    if (!flagged.has(traitId(item)) && line.trim()) items.push({ ...item, review: 'check' });
  });
  return items;
}

/** A title line on this many other players' cards is listed as common, so the rewrite doesn't land on it. */
export const COMMON_MIN_PLAYERS = 3;
/** How many common titles of each kind the rewrite is shown. */
export const COMMON_TITLE_LIMIT = 12;
/** How many titles of each kind from other cards at his position the rewrite is shown. */
export const NEARBY_TITLE_LIMIT = 20;

interface TitleCluster {
  title: string;
  words: Set<string>;
  players: Set<string>;
}

/** The positions a card names ("Centre Forward/Attacking Midfielder" is two); cards that share one are at his position. */
const positionParts = (position: string | undefined): string[] =>
  (position ?? '')
    .split('/')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

const clusterCache = new WeakMap<PlayerProfile[], Record<TraitKind, TitleCluster[]>>();

/** Every title in the pool with the players whose cards carry a line that reads the same, most shared first. */
function titleClusters(pool: PlayerProfile[]): Record<TraitKind, TitleCluster[]> {
  const cached = clusterCache.get(pool);
  if (cached) return cached;
  const build = (kind: TraitKind): TitleCluster[] => {
    const titles: Array<{ player: string; title: string; words: Set<string> }> = [];
    for (const card of pool) {
      const name = card.basicInfo?.name;
      if (!name) continue;
      for (const line of (kind === 'strength' ? card.strengths : card.weaknesses) ?? []) {
        const title = traitTitle(line);
        const words = titleWords(title);
        if (words.size) titles.push({ player: toBasePlayerSlug(name), title, words });
      }
    }
    return titles
      .map((t) => ({
        title: t.title,
        words: t.words,
        players: new Set(titles.filter((o) => titleSimilarity(t.words, o.words) >= STOCK_TITLE_SIMILARITY).map((o) => o.player)),
      }))
      .sort((a, b) => b.players.size - a.players.size);
  };
  const clusters = { strength: build('strength'), weakness: build('weakness') };
  clusterCache.set(pool, clusters);
  return clusters;
}

export interface TakenTitles {
  /** Titles that read the same as lines on `COMMON_MIN_PLAYERS` or more other players' cards, with how many. */
  common: Record<TraitKind, Array<{ title: string; players: number }>>;
  /** Lines on other players' cards that share a position with his, as title and opening words: the cards rewritten just before this one first. */
  nearby: Record<TraitKind, string[]>;
}

/**
 * The titles a rewrite must not land on: the lines already common across other players' cards,
 * and the lines on other cards at his position, so a new line doesn't become the next stock one
 * in other words. `written` holds cards rewritten earlier in the same run, newest last; they come
 * first among the nearby titles. His own cards never count.
 */
export function takenTraitTitles(profile: PlayerProfile, pool: PlayerProfile[], written: PlayerProfile[] = []): TakenTitles {
  const self = toBasePlayerSlug(profile.basicInfo.name);
  const clusters = titleClusters(pool);
  const common = (kind: TraitKind) => {
    const picked: TitleCluster[] = [];
    const counts: number[] = [];
    for (const c of clusters[kind]) {
      const players = c.players.size - (c.players.has(self) ? 1 : 0);
      if (players < COMMON_MIN_PLAYERS || picked.length >= COMMON_TITLE_LIMIT) continue;
      if (picked.some((p) => titleSimilarity(p.words, c.words) >= STOCK_TITLE_SIMILARITY)) continue;
      picked.push(c);
      counts.push(players);
    }
    return picked.map((c, i) => ({ title: c.title, players: counts[i] }));
  };
  const positions = positionParts(profile.basicInfo.position);
  const others = [...written].reverse().concat(pool).filter((card) => {
    const name = card.basicInfo?.name;
    return name && toBasePlayerSlug(name) !== self && positionParts(card.basicInfo.position).some((p) => positions.includes(p));
  });
  const nearby = (kind: TraitKind) => {
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const card of others) {
      for (const line of (kind === 'strength' ? card.strengths : card.weaknesses) ?? []) {
        const title = traitTitle(line);
        const key = title.toLowerCase();
        if (!title || seen.has(key) || titles.length >= NEARBY_TITLE_LIMIT) continue;
        seen.add(key);
        titles.push(`${title} (${lineGist(line)})`);
      }
    }
    return titles;
  };
  return {
    common: { strength: common('strength'), weakness: common('weakness') },
    nearby: { strength: nearby('strength'), weakness: nearby('weakness') },
  };
}

/** How much of a line's text follows its title in the taken list: enough to show the point it makes. */
const GIST_CHARS = 90;

const lineGist = (line: string): string => {
  const body = line.replace(/^\s*\*\*.+?\*\*\s*/, '').trim();
  return body.length > GIST_CHARS ? `${body.slice(0, GIST_CHARS).replace(/\s+\S*$/, '')}…` : body;
};

const takenBlock = (taken: TakenTitles): string => {
  const commonLine = (kind: TraitKind) =>
    taken.common[kind].map((c) => `${c.title} (${c.players} players)`).join('; ') || 'none';
  return [
    'Common on other players\' cards:',
    `Strengths: ${commonLine('strength')}`,
    `Weaknesses: ${commonLine('weakness')}`,
    'On other cards at his position:',
    'Strengths:',
    ...(taken.nearby.strength.length ? taken.nearby.strength.map((t) => `- ${t}`) : ['none']),
    'Weaknesses:',
    ...(taken.nearby.weakness.length ? taken.nearby.weakness.map((t) => `- ${t}`) : ['none']),
  ].join('\n');
};

/** How long the rewrite may take before the card keeps the lines it has. */
export const TRAIT_REWRITE_TIMEOUT_MS = 15_000;
/** How much of the card's evidence the rewrite reads. */
const EVIDENCE_CHARS = 6_000;

interface TraitRevision {
  id: string;
  drop?: boolean;
  title?: string;
  detail?: string;
  consequence?: string;
}

const REVISION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    revisions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'The id of the line being rewritten, exactly as given.' },
          drop: {
            type: Type.BOOLEAN,
            description:
              'True only for a weakness that breaks the rules and has no real replacement in the evidence, and only when the card keeps another weakness that meets the rules.',
          },
          title: { type: Type.STRING, description: 'Two to four plain words a football fan would use, in title case; the sentences carry the detail.' },
          detail: {
            type: Type.STRING,
            description:
              'For a strength: how he does it and what sets his way apart. For a weakness: where it shows and what it looks like.',
          },
          consequence: {
            type: Type.STRING,
            description:
              'For a strength: what it changes in matches, with the evidence. For a weakness: what it cost his team or how opponents played on it, with the evidence.',
          },
        },
        required: ['id', 'drop', 'title', 'detail', 'consequence'],
      },
    },
  },
  required: ['revisions'],
};

const attributeSummary = (profile: PlayerProfile): string => {
  const entries = Object.entries(profile.attributes ?? {})
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .sort((a, b) => (b[1] as number) - (a[1] as number));
  const fmt = (list: typeof entries) =>
    list.map(([k, v]) => `${ATTRIBUTE_LABELS[k as keyof typeof ATTRIBUTE_LABELS] ?? k} ${v}`).join(', ');
  return entries.length ? `Highest: ${fmt(entries.slice(0, 5))}. Lowest: ${fmt(entries.slice(-5))}.` : '';
};

export function buildTraitRewritePrompt(
  profile: PlayerProfile,
  items: ReviewTrait[],
  evidence: string,
  taken: TakenTitles,
): string {
  const marks = new Map(items.map((t) => [traitId(t), t.review === 'rewrite' ? ' [REWRITE]' : ' [CHECK]']));
  const list = (lines: string[], kind: TraitKind) =>
    lines
      .map((line, index) => {
        const id = traitId({ kind, index });
        return `${id}${marks.get(id) ?? ''}: ${line}`;
      })
      .join('\n');
  return `<card>
Player: ${profile.basicInfo.name} | ${profile.version?.label ?? 'Current Form'} | ${profile.basicInfo.position} | ${profile.basicInfo.club}
Overall: ${profile.ratings.overall}
Archetype: ${profile.playstyleAndRole?.playstyle?.archetype ?? ''} | Best roles: ${(profile.playstyleAndRole?.bestRoles ?? []).join(', ')}
Attributes: ${attributeSummary(profile)}
Playstyle: ${profile.playstyleAndRole?.playstyle?.description ?? ''}
Strengths:
${list(profile.strengths ?? [], 'strength')}
Weaknesses:
${list(profile.weaknesses ?? [], 'weakness')}
</card>
<evidence>
${evidence.slice(0, EVIDENCE_CHARS)}
</evidence>
<rules>
${CARD_TRAIT_RULES}
</rules>
<taken_lines>
${takenBlock(taken)}
</taken_lines>
<task>
The lines marked [REWRITE] read the same as lines already on several other players' cards, so they describe the position or the attribute rather than this player. For each one, return a revision with its id: either the same trait written about him specifically (a new title in his own terms, and both sentences), or, when that trait doesn't hold up for him, a different trait of the same kind that does. A weakness written again in other words is still the stock line: keep its trait only when the evidence says what it cost him; otherwise give a different limitation of his, or drop it.
The lines marked [CHECK] are his other weaknesses. Test each against the rules: leave one that meets them out of your reply. One that breaks them (a skill his role never asked of him, a quality worded as a flaw, a line just as true of most players at his position, a limitation that never cost him, or the same point as a common line in <taken_lines>) gets a revision with its id: a different, real limitation of his from the card and the evidence.
<taken_lines> lists the lines already on other players' cards: the most common ones, and those at his position. No new line may make the same point as one of them, even in other words or about a different part of the pitch, unless the evidence shows it is distinctively his; then name what is his alone. A team sitting deep, crowding him or marking him tightly happens to most good players: it is his only when the evidence says how it beat him in particular.
Set drop to true only for a weakness that breaks the rules when the evidence gives no real limitation to put in its place. The card must keep at least one weakness that meets the rules, so when every weakness breaks them, replace rather than drop. Never replace a weakness with one another line already names.
Each title is two to four plain words a football fan would use, in title case; the sentences carry the detail. Keep each new line about as long as the one it replaces. Don't repeat anything the card's other lines already say, and keep every claim consistent with the card and the evidence: no figures, results or events the evidence doesn't give. Return revisions only for marked ids.
</task>`;
}

/**
 * Rewrites a card's stock strengths and weaknesses, and replaces or drops any other weakness that
 * breaks the rules. The card keeps its lines when there's nothing to review, the call fails or it
 * takes longer than `TRAIT_REWRITE_TIMEOUT_MS`; a weakness is dropped only when another remains.
 */
export interface TraitRewriteOptions {
  /** Cards rewritten earlier in the same run, newest last (`takenTraitTitles`). */
  written?: PlayerProfile[];
}

export async function reviseCardTraits(
  profile: PlayerProfile,
  pool: PlayerProfile[],
  evidence: string,
  { written = [] }: TraitRewriteOptions = {},
): Promise<PlayerProfile> {
  const items = findTraitsToReview(profile, pool);
  if (items.length === 0) return profile;
  const stock = items.filter((t) => t.review === 'rewrite');
  console.log(
    `[CardTraits] ${profile.basicInfo.name}: ` +
      (stock.length ? `rewriting ${stock.map((s) => `"${traitTitle(s.line)}"`).join(', ')}; ` : '') +
      `checking ${items.length - stock.length} other weakness${items.length - stock.length === 1 ? '' : 'es'}`,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    generateStructured<{ revisions?: TraitRevision[] }>({
      task: 'synthesis',
      prompt: buildTraitRewritePrompt(profile, items, evidence, takenTraitTitles(profile, pool, written)),
      schema: REVISION_SCHEMA,
    }).catch((err) => {
      console.warn('[CardTraits] Rewrite failed; keeping the card as written.', err);
      return null;
    }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        console.warn('[CardTraits] Rewrite timed out; keeping the card as written.');
        resolve(null);
      }, TRAIT_REWRITE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  return applyTraitRevisions(profile, items, result?.revisions ?? []);
}

/** Puts revised lines in place of the reviewed ones they answer; anything else in the reply is ignored. */
export function applyTraitRevisions(
  profile: PlayerProfile,
  stock: StockTrait[],
  revisions: TraitRevision[],
): PlayerProfile {
  const byId = new Map(revisions.filter((r) => r && typeof r.id === 'string').map((r) => [r.id.trim(), r]));
  const strengths = [...(profile.strengths ?? [])];
  const weaknesses: Array<string | null> = [...(profile.weaknesses ?? [])];
  for (const item of stock) {
    const revision = byId.get(traitId(item));
    if (!revision) continue;
    const line = formatTrait(revision.title, revision.detail, revision.consequence);
    if (item.kind === 'weakness' && revision.drop) {
      if (weaknesses.filter((w) => w !== null).length > 1) weaknesses[item.index] = null;
      continue;
    }
    if (!traitTitle(line) || !revision.detail) continue;
    if (item.kind === 'strength') strengths[item.index] = line;
    else weaknesses[item.index] = line;
  }
  return { ...profile, strengths, weaknesses: weaknesses.filter((w): w is string => w !== null) };
}
