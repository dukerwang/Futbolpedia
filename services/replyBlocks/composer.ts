import type { AskPrompt, DataBlock, GaffaTradeScorecard, GoDeeper, PlayerProfile, ReadyBlock, ReplyBlock, ReplyBlockKind, ViewHint } from '../../types';
import { isPrimeCard, toBasePlayerSlug } from '../dossierCards';
import { getCardKey } from '../dossierStore';
import { askBlock } from './ask';
import { cardBlockOf } from './card';
import { goDeeperBlock } from './goDeeper';
import { proseBlock } from './prose';
import { scorecardBlock } from './scorecard';
import { scoutOfferBlock } from './scoutOffer';

/** What `onBlocks` hands over besides the blocks: the cards behind the card blocks, to file. */
export interface ComposerExtras {
  cards: PlayerProfile[];
}

export interface ComposerOptions {
  /** Called whenever the reply's blocks change. Text growth is throttled; structural changes are not. */
  onChange?: (blocks: ReplyBlock[], extras: ComposerExtras) => void;
  now?: () => number;
  /** Least time between two text-only notifications. */
  textIntervalMs?: number;
}

const PRIME_OFFER = /^prime\s+/i;

type Segment = { text: string } | { view: DataBlock };

/**
 * The conduct gates over a reply's prose segments: given the raw text of each segment, the text to
 * show for each, in the same order and count. Run on the segments together (so a figure budget
 * spans the reply) and never moves a view.
 */
export type ProseGate = (segments: string[]) => string[];

export interface ComposerSnapshot {
  text: string;
  closedLength: number;
  segments: Segment[];
  scorecard: DataBlock<'scorecard'> | null;
  endViews: DataBlock[];
  cards: { profile: PlayerProfile; block: ReadyBlock<'card'>; inline?: boolean }[];
  offers: ReadyBlock<'scoutOffer'>[];
  ask: ReadyBlock<'ask'> | null;
  goDeeper: ReadyBlock<'goDeeper'> | null;
}

/**
 * A reply as it is composed: prose segments with views between them, and the blocks code adds
 * (the scorecard first, then after the last prose the views placed at the end, cards, Scout
 * offers, the question and the Go deeper flag, in that order). It replaces the fixed attachment
 * fields: whatever a turn shows, it shows through here, and `blocks()` is what the reader sees.
 *
 * Segments rather than character offsets, so a gate that removes a sentence from one segment moves
 * no view.
 */
export class ReplyComposer {
  private text = '';
  /** How much of `text` earlier segments hold. */
  private closedLength = 0;
  private segments: Segment[] = [];
  private scorecard: DataBlock<'scorecard'> | null = null;
  /** Views placed after the last prose (what code attaches today, and a view with `inline` off). */
  private endViews: DataBlock[] = [];
  private cardList: { profile: PlayerProfile; block: ReadyBlock<'card'>; inline?: boolean }[] = [];
  private offerList: ReadyBlock<'scoutOffer'>[] = [];
  private askBlock_: ReadyBlock<'ask'> | null = null;
  private goDeeperBlock_: ReadyBlock<'goDeeper'> | null = null;
  private counter = 0;
  private gate: ProseGate | null = null;
  /** The last gate run, so a notice that changes no text doesn't run the gates again. */
  private gated: { key: string; out: string[] } | null = null;
  /** The reply's prose after the final gates (and the correction round), once the writer is done. */
  private finalProse: string[] | null = null;
  private lastTextNotice = -Infinity;
  private readonly now: () => number;
  private readonly textIntervalMs: number;

  constructor(private readonly options: ComposerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.textIntervalMs = options.textIntervalMs ?? 45;
  }

  /** A fresh id for a block of this reply. */
  newId = (): string => `b${++this.counter}`;

  // -- Reading ----------------------------------------------------------------------------------

  /** The reply as the reader sees it. Pending views are included; `finish` removes the ones left. */
  blocks(): ReplyBlock[] {
    const out: ReplyBlock[] = [];
    const prose = this.shownProse();
    let n = 0;
    if (this.scorecard) out.push(this.scorecard);
    for (const seg of this.segments) {
      if ('view' in seg) {
        out.push(seg.view);
        continue;
      }
      const text = prose[n++];
      if (text?.trim()) out.push(proseBlock(`prose-${n}`, text));
    }
    const tail = prose[n];
    if (tail?.trim()) out.push(proseBlock('prose-tail', tail));
    out.push(...this.endViews, ...this.cardList.filter((c) => !c.inline).map((c) => c.block), ...this.offerList);
    if (this.askBlock_) out.push(this.askBlock_);
    if (this.goDeeperBlock_) out.push(this.goDeeperBlock_);
    return out;
  }

  /** The prose segments as written, in order: those a view closed, then the stretch after the last. */
  rawProse(): string[] {
    const closed = this.segments.flatMap((s) => ('view' in s ? [] : [s.text]));
    const tail = this.text.slice(this.closedLength);
    return tail.trim() ? [...closed, tail] : closed;
  }

  /** The prose as the reader sees it: the final text once settled, else the gates' reading of what has streamed. */
  private shownProse(): string[] {
    const raw = this.rawProse();
    if (this.finalProse) return this.finalProse;
    if (!this.gate) return raw;
    const key = raw.join('\u0000');
    if (this.gated?.key !== key) this.gated = { key, out: this.gate(raw) };
    return this.gated.out;
  }

  /** The reply's prose as the reader sees it, joined, for the caller that streams plain text. */
  displayText(): string {
    return this.shownProse().filter((t) => t.trim()).join('\n\n');
  }

  /** Whether the writer reads the stream through this composer's gates (`setGate`). */
  get hasGate(): boolean {
    return this.gate !== null;
  }

  /** The gates the reply's prose passes through on its way to the reader. */
  setGate(gate: ProseGate | null): void {
    this.gate = gate;
    this.gated = null;
  }

  /**
   * The prose after the final gates, one text for each of `rawProse()`'s segments (empty where the
   * gates removed all of one). It replaces the streamed reading, and no view moves.
   */
  settle(parts: string[]): void {
    this.finalProse = parts;
    this.notify(true);
  }

  /** The cards the reply shows, as profiles (the card blocks hold only their references). */
  get cards(): PlayerProfile[] {
    return this.cardList.map((c) => c.profile);
  }

  /** The players the reply offers to Scout ("prime <name>" offers a prime). */
  get scoutOffers(): string[] {
    return this.offerList.map((o) => o.data.name);
  }

  get ask(): AskPrompt | null {
    return this.askBlock_?.data ?? null;
  }

  get goDeeper(): GoDeeper | null {
    return this.goDeeperBlock_?.data ?? null;
  }

  /** Whether the reply holds anything besides prose. */
  get hasBlocks(): boolean {
    return this.blocks().some((b) => b.kind !== 'prose');
  }

  // -- Prose ------------------------------------------------------------------------------------

  /** The reply's running text, as the model has written it so far. */
  setText(text: string): void {
    this.text = text;
    const at = this.now();
    if (at - this.lastTextNotice < this.textIntervalMs) return;
    this.lastTextNotice = at;
    this.notify();
  }

  /** Replaces all the reply's prose with this text (a question the writer asked is the whole reply). */
  replaceProse(text: string): void {
    this.segments = this.segments.filter((s) => 'view' in s);
    this.closedLength = 0;
    this.text = text;
    this.notify(true);
  }

  // -- Views ------------------------------------------------------------------------------------

  /**
   * Places a view. `inline` closes the prose written so far and puts the view after it, so later
   * text follows the view; otherwise the view goes after the last prose.
   */
  addView(block: DataBlock, options: { inline?: boolean } = {}): void {
    if (options.inline) this.closeProse();
    if (options.inline) this.segments.push({ view: block });
    else this.endViews.push(block);
    this.notify(true);
  }

  /** Places a `pending` block of this kind and returns its id; `resolve` or `fail` settles it. */
  beginView(kind: ReplyBlockKind, options: { inline?: boolean; hint?: ViewHint } = {}): string {
    const block = { kind, id: this.newId(), status: 'pending', ...(options.hint ? { hint: options.hint } : {}) } as DataBlock;
    this.addView(block, options);
    return block.id;
  }

  /** Fills a pending view with its data. */
  resolve(block: ReadyBlock): void {
    this.swap(block.id, block);
  }

  /** Marks a pending view failed: it draws nothing and isn't stored. */
  fail(id: string): void {
    const found = this.find(id);
    if (found) this.swap(id, { ...found, status: 'failed', data: undefined } as DataBlock);
  }

  /** The views of one kind that are drawn, in order. */
  viewsOf<K extends ReplyBlockKind>(kind: K): ReadyBlock<K>[] {
    return this.blocks().filter((b) => b.kind === kind && b.status === 'ready') as ReadyBlock<K>[];
  }

  // -- Blocks code adds -------------------------------------------------------------------------

  /** A Gaffa trade scorecard heads the reply. */
  setScorecard(card: GaffaTradeScorecard): void {
    this.scorecard = scorecardBlock(this.newId(), card);
    this.notify(true);
  }

  /** Adds a card to show under the reply, once. A current card leaves an offer of his prime in place. */
  showCard(card: PlayerProfile, options: { inline?: boolean } = {}): void {
    const key = getCardKey(card);
    if (this.cardList.some((c) => getCardKey(c.profile) === key)) return;
    const block = cardBlockOf(this.newId(), card);
    // A card the model shows inside the reply sits where it called it; the rest go under the prose.
    if (options.inline) {
      this.closeProse();
      this.segments.push({ view: block });
    }
    this.cardList.push({ profile: card, block, inline: options.inline });
    const slug = toBasePlayerSlug(card.basicInfo.name);
    this.offerList = this.offerList.filter(
      (o) => toBasePlayerSlug(o.data.name) !== slug || (PRIME_OFFER.test(o.data.name) && !isPrimeCard(card)),
    );
    this.notify(true);
  }

  /** Adds a Scout offer unless the player is already offered or carded in this reply. */
  offerScout(name: string): void {
    const slug = toBasePlayerSlug(name);
    if (!slug) return;
    const known = [...this.scoutOffers, ...this.cards.map((c) => c.basicInfo.name)].some((n) => toBasePlayerSlug(n) === slug);
    if (known) return;
    this.offerList.push(scoutOfferBlock(this.newId(), name));
    this.notify(true);
  }

  /**
   * Offers a player's prime to Scout, for a reply about his prime when only his current form is
   * rated. It sits beside his current card, so it's kept apart from his plain offer.
   */
  offerPrimeScout(name: string): void {
    const slug = toBasePlayerSlug(name);
    if (!slug) return;
    const held = this.scoutOffers.some((n) => PRIME_OFFER.test(n) && toBasePlayerSlug(n) === slug);
    const shown = this.cards.some((c) => isPrimeCard(c) && toBasePlayerSlug(c.basicInfo.name) === slug);
    if (held || shown) return;
    this.offerList.push(scoutOfferBlock(this.newId(), `prime ${name}`));
    this.notify(true);
  }

  /** The writer's question: it is the whole reply, so nothing drawn for an answer stays under it. */
  setAsk(ask: AskPrompt): void {
    this.askBlock_ = askBlock(this.newId(), ask);
    this.dropAnswerViews();
    this.goDeeperBlock_ = null;
    this.notify(true);
  }

  setGoDeeper(goDeeper: GoDeeper): void {
    this.goDeeperBlock_ = goDeeperBlock(this.newId(), goDeeper);
    this.notify(true);
  }

  /** Drops every view and card but keeps prose and the Scout offers. */
  dropAnswerViews(): void {
    this.endViews = [];
    this.cardList = [];
    this.goDeeperBlock_ = null;
    const kept: Segment[] = [];
    for (const seg of this.segments) {
      const last = kept[kept.length - 1];
      if ('view' in seg) continue;
      if (last && !('view' in last)) last.text += seg.text;
      else kept.push({ text: seg.text });
    }
    this.segments = kept;
  }

  // -- Settling ---------------------------------------------------------------------------------

  /** A copy of the composer's state, for a turn that may start over (a deep turn that falls back). */
  snapshot(): ComposerSnapshot {
    return {
      text: this.text,
      closedLength: this.closedLength,
      segments: this.segments.map((s) => ({ ...s })),
      scorecard: this.scorecard,
      endViews: [...this.endViews],
      cards: [...this.cardList],
      offers: [...this.offerList],
      ask: this.askBlock_,
      goDeeper: this.goDeeperBlock_,
    };
  }

  /** Back to a snapshot: the blocks and text of the attempt that gave up go with it. */
  restore(saved: ComposerSnapshot): void {
    this.text = saved.text;
    this.closedLength = saved.closedLength;
    this.segments = saved.segments.map((s) => ({ ...s }));
    this.scorecard = saved.scorecard;
    this.endViews = [...saved.endViews];
    this.cardList = [...saved.cards];
    this.offerList = [...saved.offers];
    this.askBlock_ = saved.ask;
    this.goDeeperBlock_ = saved.goDeeper;
    this.finalProse = null;
    this.gate = null;
    this.gated = null;
    this.notify(true);
  }

  /**
   * Ends the reply with its final text (after the gates): a view still pending is marked failed
   * and removed, and the blocks are announced one last time. Returns what is stored.
   */
  finish(finalText?: string): ReplyBlock[] {
    // A reply whose prose was gated by segments (`settle`) is already final. Otherwise the text the
    // caller gives is: it replaces what follows the prose a view closed.
    if (!this.finalProse && finalText !== undefined) {
      this.text = this.closedLength > 0 ? this.text.slice(0, this.closedLength) + finalText.slice(this.closedLength) : finalText;
      this.gate = null;
    }
    const settled = this.blocks().filter((b) => b.kind === 'prose' || b.status === 'ready');
    this.options.onChange?.(settled, { cards: this.cards });
    return settled;
  }

  // -- Internals --------------------------------------------------------------------------------

  private closeProse(): void {
    const text = this.text.slice(this.closedLength);
    if (text.trim()) this.segments.push({ text });
    this.closedLength = this.text.length;
  }

  private all(): DataBlock[] {
    return [
      ...(this.scorecard ? [this.scorecard] : []),
      ...this.segments.flatMap((s) => ('view' in s ? [s.view] : [])),
      ...this.endViews,
    ];
  }

  private find(id: string): DataBlock | undefined {
    return this.all().find((b) => b.id === id);
  }

  private swap(id: string, next: DataBlock): void {
    this.segments = this.segments.map((s) => ('view' in s && s.view.id === id ? { view: next } : s));
    this.endViews = this.endViews.map((v) => (v.id === id ? next : v));
    this.notify(true);
  }

  private notify(structural = false): void {
    if (structural) this.lastTextNotice = this.now();
    this.options.onChange?.(this.blocks(), { cards: this.cards });
  }
}
