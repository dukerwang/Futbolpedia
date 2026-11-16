/**
 * Runs the conduct gates over a reply's prose segments together without letting a removal move a
 * view. The segments are joined with a fixed line the gates leave alone (a heading is never a
 * sentence to them, and a fragment's carried label never crosses it), gated as one text so a
 * figure budget spans the reply, and split at the same lines. A view sits between two segments
 * however much each loses; a segment the gates empty is just empty.
 */

/** A heading line: the gates skip headings, and no reply of the writer's contains this one. */
export const SEGMENT_MARK = '# ⟦view⟧';

/** The segments as one text. */
export const joinSegments = (segments: string[]): string => segments.join(`\n\n${SEGMENT_MARK}\n\n`);

const MARK_LINES = new RegExp(`\\s*^${SEGMENT_MARK}$\\s*`, 'gm');

/** The text as its segments, or null when the marks didn't survive and the count is wrong. */
export function splitSegments(text: string, count: number): string[] | null {
  if (count <= 1) return [text.trim()];
  const parts = text.split(MARK_LINES).map((p) => p.trim());
  return parts.length === count ? parts : null;
}

/**
 * The gate over the segments. `gate` reads one text; the result has one text for each segment. If
 * the gate somehow ate a mark, each segment is gated on its own, which only loses the shared budget.
 */
export function gateSegments(segments: string[], gate: (text: string) => string): string[] {
  if (segments.length <= 1) return segments.map((s) => gate(s));
  const split = splitSegments(gate(joinSegments(segments)), segments.length);
  return split ?? segments.map((s) => gate(s));
}
