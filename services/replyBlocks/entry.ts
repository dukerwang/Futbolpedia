import type { FunctionDeclaration } from '@google/genai';
import type { DataBlock, ReadyBlock, ReplyBlock, ReplyBlockKind, ViewHint } from '../../types';
import type { DossierLookup } from '../dossierLookup';
import type { EvidenceLedger } from '../evidenceLedger';
import type { ResearchToolset } from '../researchTools';
import type { ClubSnapshot, Situation } from '../situationSnapshot';

/**
 * What a block's `build` may read. Everything a test needs to fake is here: the research toolset
 * (live feeds), the turn's evidence ledger, stored club snapshots, the blocks already placed and
 * the clock. A kind reads only the parts it needs.
 */
export interface BuildContext {
  tools: ResearchToolset;
  /** The turn's evidence ledger; a build that reads a feed files the outcome here. */
  ledger: { read(): EvidenceLedger; write(next: EvidenceLedger): void };
  stored: ClubSnapshot[];
  /** The turn's situation snapshot, which the writer argues from: a drawn XI reads the same club it does. */
  situation?: () => Situation | null;
  /** The blocks the reply holds so far, for a rule such as "already shown". */
  blocks(): ReplyBlock[];
  /**
   * Finds a player's stored card (yours or shared), never rating anyone. `edition` left out takes the
   * version the thread discusses him in, else his current form. Comparisons and rankings read it.
   */
  cards?: { lookUp(name: string, edition?: 'current' | 'prime'): Promise<DossierLookup> };
  now(): number;
  newId(): string;
}

/** A build resolves to a block, a reason the model reads as the tool result, or "nothing new". */
export type BuildResult<B> =
  | { block: B }
  | { error: string }
  /** The view already stands; nothing was added. The object is the tool result. */
  | { unchanged: Record<string, unknown> };

/** The arguments each kind's `build` takes. */
export interface BuildArgs {
  pitch: { club: string };
  table: { league: string; country?: string; season?: string; highlight?: string[] };
  comparison: { playerA: string; playerB: string; edition?: 'current' | 'prime' };
  ranking: { title: string; names: string[]; criterion: string; edition?: 'current' | 'prime' };
  card: { profile: import('../../types').PlayerProfile };
  scoutOffer: { name: string };
  ask: import('../../types').AskPrompt;
  goDeeper: import('../../types').GoDeeper;
  scorecard: import('../../types').GaffaTradeScorecard;
}

/** One kind of block, defined once. */
export interface BlockEntry<K extends ReplyBlockKind> {
  kind: K;
  /** The Gemini declaration, for kinds the model can call. Kinds code adds have none. */
  tool?: FunctionDeclaration;
  /** What the call already tells about the view, for the skeleton shown while `build` runs. */
  hint?(args: BuildArgs[K]): ViewHint;
  /** Resolves real data and returns the block, or the reason it couldn't. */
  build(args: BuildArgs[K], ctx: BuildContext): Promise<BuildResult<ReadyBlock<K>>>;
  /** What the model reads back once the block is drawn. */
  toolResult(block: ReadyBlock<K>): Record<string, unknown>;
  /** A one-line stub for later turns ('' for nothing), so the model knows what the reader saw. */
  toHistory(block: ReadyBlock<K>): string;
  /** Plain text for Copy and Share ('' for nothing). */
  toCopy(block: ReadyBlock<K>): string;
}

export const readyBlock = <K extends ReplyBlockKind>(kind: K, id: string, data: ReadyBlock<K>['data']): ReadyBlock<K> =>
  ({ kind, id, status: 'ready', data }) as ReadyBlock<K>;

export type { DataBlock };
