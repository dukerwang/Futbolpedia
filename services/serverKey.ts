/**
 * Which Gemini key the server uses. AI Studio manages the `GEMINI_API_KEY` secret itself: it is a key
 * picker, and at publish AI Studio injects its own choice, which once kept a deleted key live. So the
 * server reads `FUTBOLPEDIA_GEMINI_KEY`, an ordinary secret AI Studio leaves alone, ahead of it, and
 * copies it to `GEMINI_API_KEY` and `API_KEY`, the names the rest of the server and
 * `services/aiClient.ts` read. Never logs a key.
 */
export const OWN_KEY_VAR = 'FUTBOLPEDIA_GEMINI_KEY';

export type KeySource = typeof OWN_KEY_VAR | 'GEMINI_API_KEY' | 'API_KEY' | 'none';

export function applyServerKey(env: Record<string, string | undefined>): KeySource {
  const own = env[OWN_KEY_VAR]?.trim();
  if (own) {
    env.GEMINI_API_KEY = own;
    env.API_KEY = own;
    return OWN_KEY_VAR;
  }
  if (env.GEMINI_API_KEY) {
    if (!env.API_KEY) env.API_KEY = env.GEMINI_API_KEY;
    return 'GEMINI_API_KEY';
  }
  if (env.API_KEY) return 'API_KEY';
  return 'none';
}
