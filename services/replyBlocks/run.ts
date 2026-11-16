import type { BlockEntry, BuildArgs, BuildContext } from './entry';
import type { DataBlock, ReadyBlock, ReplyBlockKind } from '../../types';
import type { ReplyComposer } from './composer';

/**
 * Runs a view tool: builds the block from real data, places it in the reply and returns what the
 * model reads back. A failure is the tool result, never a thrown error, so the model writes around it.
 *
 * `pending` places a skeleton while the data loads and settles it in place; `inline` puts the view
 * where the model called it rather than after the prose. Both are off by default, so a view appears
 * once it is ready, after the prose.
 */
export async function runViewTool<K extends ReplyBlockKind>(
  entry: BlockEntry<K>,
  args: BuildArgs[K],
  ctx: Omit<BuildContext, 'blocks' | 'newId'>,
  composer: ReplyComposer,
  options: { inline?: boolean; pending?: boolean } = {},
): Promise<Record<string, unknown>> {
  const full: BuildContext = { ...ctx, blocks: () => composer.blocks(), newId: composer.newId };
  const hint = options.pending ? entry.hint?.(args) : undefined;
  const pendingId = options.pending ? composer.beginView(entry.kind, { inline: options.inline, hint }) : null;
  let outcome: Awaited<ReturnType<typeof entry.build>>;
  try {
    outcome = await entry.build(args, full);
  } catch (e) {
    if (pendingId) composer.fail(pendingId);
    return { shown: false, reason: e instanceof Error ? e.message : 'The view could not be built.' };
  }
  if ('error' in outcome) {
    if (pendingId) composer.fail(pendingId);
    return { shown: false, reason: outcome.error };
  }
  if ('unchanged' in outcome) {
    if (pendingId) composer.fail(pendingId);
    return outcome.unchanged;
  }
  if (pendingId) composer.resolve({ ...outcome.block, id: pendingId } as unknown as ReadyBlock);
  else composer.addView(outcome.block as unknown as DataBlock, { inline: options.inline });
  return entry.toolResult(outcome.block);
}
