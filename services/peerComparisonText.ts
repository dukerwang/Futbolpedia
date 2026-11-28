import type { PeerComparison, PeerJudgment } from '../types';

/** How a stored head-to-head comparison reads in prompts and the card's history block. */
const JUDGMENT_WORDS: Record<PeerJudgment, string> = {
  better: 'better than',
  level: 'level with',
  not_as_good: 'not as good as',
};

/** "better than Name (2008-10): reason" lines. Kept apart from peerComparison.ts so readers of cards don't load the model client. */
export const formatComparisonLines = (comparisons: PeerComparison[]): string[] =>
  comparisons
    .filter((c) => c && JUDGMENT_WORDS[c.judgment] && c.peer && c.reason)
    .map((c) => `${JUDGMENT_WORDS[c.judgment]} ${c.peer}: ${c.reason}`);
