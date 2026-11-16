import type { ReadyBlock, ReplyBlock, ReplyBlockKind } from '../../types';

export { blocksOf, proseTextOf, withDossierBlock, LEGACY_ERROR_PREFIX } from './blocksOf';
export { ReplyComposer, type ComposerExtras, type ComposerOptions, type ComposerSnapshot } from './composer';
export type { BlockEntry, BuildArgs, BuildContext, BuildResult } from './entry';
export { copyTextOf, blockCopy, blockHistory, REPLY_BLOCKS, viewToolDeclarations } from './registry';
export { runViewTool } from './run';
export { createViewTools, makeCardLookup, canShowView, viewCount, MAX_REPLY_VIEWS, VIEW_LIMIT_RESULT, type ViewTools } from './viewTools';
export { gateSegments, joinSegments, splitSegments, SEGMENT_MARK } from './segmentGate';
export type { ProseGate } from './composer';
export { pitchEntry } from './pitch';

/** The drawn blocks of one kind, in order. */
export const readyOf = <K extends ReplyBlockKind>(blocks: ReplyBlock[] | null | undefined, kind: K): ReadyBlock<K>[] =>
  (blocks ?? []).filter((b) => b.kind === kind && b.status === 'ready') as ReadyBlock<K>[];
