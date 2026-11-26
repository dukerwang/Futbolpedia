/**
 * Loads the AI pipeline (`pipeline.ts`) on demand. The first call starts the download and every
 * later call shares it; a failed load (a dropped connection, a deploy that replaced the chunk) is
 * forgotten, so the next call tries again instead of failing for the rest of the session.
 */
export type Pipeline = typeof import('./pipeline');

let loading: Promise<Pipeline> | null = null;

export const loadPipeline = (): Promise<Pipeline> => {
  if (!loading) {
    loading = import('./pipeline').catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
};
