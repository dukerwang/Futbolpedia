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
 * ones that read the same are rewritten in one small call.
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
      description: 'A short name for his particular way of doing it, not the attribute or skill category it falls under.',
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
      description: 'A short name for this specific limitation of his, not the attribute or skill category it falls under.',
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
              'True only for a weakness that, judged honestly, did not cost him in the role this card rates and has no specific replacement.',
          },
          title: { type: Type.STRING },
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

const traitId = (t: { kind: TraitKind; index: number }) => `${t.kind === 'strength' ? 'S' : 'W'}${t.index + 1}`;

const attributeSummary = (profile: PlayerProfile): string => {
  const entries = Object.entries(profile.attributes ?? {})
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .sort((a, b) => (b[1] as number) - (a[1] as number));
  const fmt = (list: typeof entries) =>
    list.map(([k, v]) => `${ATTRIBUTE_LABELS[k as keyof typeof ATTRIBUTE_LABELS] ?? k} ${v}`).join(', ');
  return entries.length ? `Highest: ${fmt(entries.slice(0, 5))}. Lowest: ${fmt(entries.slice(-5))}.` : '';
};

export function buildTraitRewritePrompt(profile: PlayerProfile, stock: StockTrait[], evidence: string): string {
  const flagged = new Set(stock.map(traitId));
  const list = (lines: string[], kind: TraitKind) =>
    lines
      .map((line, index) => {
        const id = traitId({ kind, index });
        return `${id}${flagged.has(id) ? ' [REWRITE]' : ''}: ${line}`;
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
<task>
The lines marked [REWRITE] read the same as lines already on several other players' cards, so they describe the position or the attribute rather than this player. For each one, return a revision with its id: either the same trait written about him specifically (a new title in his own terms, and both sentences), or, when that trait doesn't hold up for him, a different trait of the same kind that does. For a weakness that did not cost him in the role this card rates and has no specific replacement, set drop to true. Don't repeat anything the card's other lines already say, and keep every claim consistent with the card and the evidence: no figures, results or events the evidence doesn't give. Return revisions only for the marked ids.
</task>`;
}

/**
 * Rewrites a card's stock strengths and weaknesses. The card keeps its lines when nothing is
 * stock, the call fails or it takes longer than `TRAIT_REWRITE_TIMEOUT_MS`; a weakness is dropped
 * only when another remains.
 */
export async function reviseStockTraits(
  profile: PlayerProfile,
  pool: PlayerProfile[],
  evidence: string,
): Promise<PlayerProfile> {
  const stock = findStockTraits(profile, pool);
  if (stock.length === 0) return profile;
  console.log(`[CardTraits] ${profile.basicInfo.name}: rewriting ${stock.map((s) => `"${traitTitle(s.line)}"`).join(', ')}`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    generateStructured<{ revisions?: TraitRevision[] }>({
      task: 'synthesis',
      prompt: buildTraitRewritePrompt(profile, stock, evidence),
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
  return applyTraitRevisions(profile, stock, result?.revisions ?? []);
}

/** Puts revised lines in place of the stock ones they answer; anything else in the reply is ignored. */
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
