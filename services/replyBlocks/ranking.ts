import { Type } from '@google/genai';
import type { ReadyBlock } from '../../types';
import { RANKING_CRITERIA, type RankingCriterion, type RankingEntry, type RankingViewData, isCardedEntry } from '../../components/views/viewData';
import { toBasePlayerSlug } from '../dossierCards';
import { toChatDossierRef } from '../dossierRefs';
import { checkOrderAgainstCards, toStanding } from '../debateConsistency';
import { readyBlock, type BlockEntry } from './entry';

export const rankingBlock = (id: string, data: RankingViewData): ReadyBlock<'ranking'> => readyBlock('ranking', id, data);

/** Most players one ranking holds. */
export const MAX_RANKING_ENTRIES = 15;

/**
 * The criteria where the ranking claims who was better, so the cards' ratings settle the order. For
 * any other criterion (output, influence, versatility) the cards inform the argument but the model's
 * order stands.
 */
export const CARD_ORDERED_CRITERIA: readonly RankingCriterion[] = ['peak level', 'sustained level', 'mixed'];

/** A criterion as the model wrote it ("peak_level", "Peak level"), or null when it isn't one of the six. */
export const criterionOf = (raw: unknown): RankingCriterion | null => {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[_-]+/g, ' ') : '';
  return (RANKING_CRITERIA as readonly string[]).includes(text) ? (text as RankingCriterion) : null;
};

const rankLine = (entry: RankingEntry, n: number): string =>
  isCardedEntry(entry)
    ? `${n}. ${entry.name}${entry.versionLabel ? ` (${entry.versionLabel})` : ''}, card Overall ${entry.overall ?? 'n/a'}`
    : `${n}. ${entry.name}, no card yet`;

/** A ranked list of players, each tied to a stored card where one exists. */
export const rankingEntry: BlockEntry<'ranking'> = {
  kind: 'ranking',
  tool: {
    name: 'show_ranking',
    description: `Draws a ranked list of players in the reply: each name is tied to its stored dossier card where one exists (position, version and Overall) and opens it; a player with no card shows by name with a way to scout him. Up to ${MAX_RANKING_ENTRIES} names. Where the ranking claims who was better (criterion peak level, sustained level or mixed), the cards' ratings settle the order of the carded players and the result tells you what moved, so your prose follows the order drawn; for other criteria your order stands. Use it when the answer is an order, and call it where the reader needs the order in your argument. Free: it doesn't count against your lookups.`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'What the ranking is of, as a short title.' },
        names: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'The players, best first.' },
        criterion: {
          type: Type.STRING,
          enum: [...RANKING_CRITERIA],
          description: 'What the order turns on: how good each was at his best, how good over a career, output, influence, versatility, or a mix.',
        },
        edition: {
          type: Type.STRING,
          enum: ['current', 'prime'],
          description: 'The version of every player to read. Left out, each is read in the version this conversation discusses him in, else his current form.',
        },
      },
      required: ['title', 'names', 'criterion'],
    },
  },
  hint: ({ title, names }) => ({ title, rows: Array.isArray(names) ? Math.min(names.length, MAX_RANKING_ENTRIES) : undefined }),

  async build({ title, names, criterion, edition }, ctx) {
    const kind = criterionOf(criterion);
    if (!kind) return { error: `Unknown criterion. Use one of: ${RANKING_CRITERIA.join(', ')}.` };
    const seen = new Set<string>();
    const given = (Array.isArray(names) ? names : [])
      .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
      .map((n) => n.replace(/\s+/g, ' ').trim())
      .filter((n) => {
        const key = toBasePlayerSlug(n);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_RANKING_ENTRIES);
    if (given.length < 2) return { error: 'A ranking needs at least two players.' };
    if (!title?.trim()) return { error: 'Give the ranking a title.' };
    if (!ctx.cards) return { error: 'No card lookup is available for this reply.' };

    const looked = await Promise.all(given.map((name) => ctx.cards!.lookUp(name, edition).catch(() => ({ status: 'missing' as const }))));
    // A player with no card, or a name that matches several, is listed by name; the result says so.
    const entries: RankingEntry[] = looked.map((found, i) => (found.status === 'found' ? toChatDossierRef(found.card) : { name: given[i] }));

    // Where the claim is who was better, the cards' ratings order the carded players.
    let moves: string[] = [];
    let ordered = entries;
    if (CARD_ORDERED_CRITERIA.includes(kind)) {
      const cards = looked.flatMap((f) => (f.status === 'found' ? [f.card] : []));
      if (cards.length >= 2) {
        const proposed = entries.map((e) => e.name);
        const check = checkOrderAgainstCards(proposed, cards.map(toStanding));
        const byName = new Map(entries.map((e) => [e.name, e] as const));
        ordered = check.order.map((n) => byName.get(n)!).filter(Boolean);
        moves = check.moves;
      }
    }
    return { block: rankingBlock(ctx.newId(), { title: title.trim(), criterion: kind, entries: ordered, moves }) };
  },

  toolResult: ({ data }) => ({
    shown: true,
    title: data.title,
    criterion: data.criterion,
    order: data.entries.map((e, i) => rankLine(e, i + 1)),
    ...(data.moves.length
      ? { moves: data.moves, note: "The order follows the cards' ratings: write your prose in this order, and say so in a sentence where it differs from your first order." }
      : {}),
  }),
  toHistory: ({ data }) => `[shown: ranking "${data.title}" by ${data.criterion}: ${data.entries.map((e) => e.name).join(', ')}]`,
  toCopy: ({ data }) => `${data.title} (${data.criterion})\n${data.entries.map((e, i) => `${i + 1}. ${e.name}${isCardedEntry(e) && e.overall != null ? ` (${e.overall})` : ''}`).join('\n')}`,
};
