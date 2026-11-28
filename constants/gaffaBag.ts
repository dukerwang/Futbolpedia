/**
 * What the browser needs to hold a Gaffa club bag. It lives apart from `gaffaRules.ts` so the
 * app's first-load bundle doesn't carry the rules snapshot or the advice prompts written there:
 * only the AI pipeline imports that file. Keep prompt text out of this one.
 */

import type { GaffaContextBag } from '../types';

/** Bump when the rules snapshot in `gaffaRules.ts` is refreshed from Gaffa's USER_GUIDE. */
export const GAFFA_RULES_VERSION = '2026-09-15';

export function emptyGaffaContextBag(): GaffaContextBag {
  return {
    gaffa_rules_version: GAFFA_RULES_VERSION,
    connected: false,
  };
}
