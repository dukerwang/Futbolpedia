/**
 * Whether this browser has seen the first-visit walkthrough. Kept apart from the walkthrough
 * itself, so the app can decide to show it without loading it.
 */

/** Bump when the walkthrough changes enough that everyone should see it once more. */
export const WELCOME_SEEN_KEY = 'futbolpedia-welcome-seen-v1';

export function hasSeenWelcome(): boolean {
  try {
    return Boolean(localStorage.getItem(WELCOME_SEEN_KEY));
  } catch {
    return true;
  }
}

export function markWelcomeSeen(): void {
  try {
    localStorage.setItem(WELCOME_SEEN_KEY, String(Date.now()));
  } catch {
    /* private mode: it shows again next time */
  }
}
