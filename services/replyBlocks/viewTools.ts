import type { FunctionDeclaration } from '@google/genai';
import type { PlayerProfile } from '../../types';
import { lookUpDossier, type DossierLookup } from '../dossierLookup';
import type { ReplyComposer } from './composer';
import type { BuildContext } from './entry';
import { REPLY_BLOCKS, viewToolDeclarations } from './registry';
import { runViewTool } from './run';

/**
 * The most views one reply holds. The only limit on the view tools: it stops a runaway loop, and no
 * rule about a kind or a subject sits under it (a model that shows the same table twice has made its
 * own choice).
 */
export const MAX_REPLY_VIEWS = 12;

/** The kinds that count toward `MAX_REPLY_VIEWS`: every view a model call draws. */
const VIEW_KINDS = new Set(['pitch', 'table', 'comparison', 'ranking', 'card']);

/** The refusal once the ceiling is reached. */
export const VIEW_LIMIT_RESULT = { shown: false, reason: 'view limit reached, nothing drawn' } as const;

/** How many views the reply holds, drawn or still loading. */
export const viewCount = (composer: ReplyComposer): number =>
  composer.blocks().filter((b) => b.kind !== 'prose' && VIEW_KINDS.has(b.kind) && b.status !== 'failed').length;

/** Whether the reply can take another view. */
export const canShowView = (composer: ReplyComposer): boolean => viewCount(composer) < MAX_REPLY_VIEWS;

/**
 * Looks cards up for comparisons and rankings: yours first, then the shared cards, in the version
 * the caller says (`edition`), else the one the turn is about (`preferPrime`). A card it finds
 * joins the cards the turn's number gate checks (`onCard`). Never rates anyone.
 */
export function makeCardLookup(args: {
  pool: PlayerProfile[];
  preferPrime: (name: string) => boolean;
  onCard?: (card: PlayerProfile) => void;
}): NonNullable<BuildContext['cards']> {
  return {
    async lookUp(name, edition): Promise<DossierLookup> {
      const result = await lookUpDossier(name, args.pool, edition ? edition === 'prime' : args.preferPrime(name));
      if (result.status === 'found') args.onCard?.(result.card);
      return result;
    },
  };
}

export interface ViewTools {
  /** The Gemini declarations of every view tool. */
  declarations: FunctionDeclaration[];
  /** Whether `name` is one of the view tools. */
  handles(name: string): boolean;
  /** Runs one call: the tool's result, which the model reads back. */
  run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * The view tools of one turn, on both paths. Each call places a skeleton where the model called it
 * (`inline`, when the text is streaming; else after the prose), builds the view from real data and
 * settles it in place. `MAX_REPLY_VIEWS` is the one limit.
 */
export function createViewTools(args: {
  composer: ReplyComposer;
  /** What a view's build may read: the live toolset, the turn's ledger and stored snapshots, the cards. */
  context: Omit<BuildContext, 'blocks' | 'newId'>;
  /** Whether the reply's text is streaming, so a view can sit inside it. */
  inline: boolean;
}): ViewTools {
  const byName = new Map(
    Object.values(REPLY_BLOCKS).flatMap((entry) => (entry.tool ? [[entry.tool.name, entry] as const] : [])),
  );
  return {
    declarations: viewToolDeclarations(),
    handles: (name) => byName.has(name),
    async run(name, callArgs) {
      const entry = byName.get(name);
      if (!entry) return { shown: false, reason: `Unknown view tool: ${name}` };
      if (!canShowView(args.composer)) return { ...VIEW_LIMIT_RESULT };
      return runViewTool(entry as never, callArgs as never, args.context, args.composer, { inline: args.inline, pending: true });
    },
  };
}
