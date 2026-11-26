/**
 * The browser's entry into the AI pipeline. App never imports it statically: `loadPipeline`
 * (`pipelineLoader.ts`) loads it the first time a turn, a rating or a title needs it, so the
 * chat's first paint carries neither the pipeline nor `@google/genai`.
 */
export { ratePlayer, sendMessageToAI } from './geminiService';
export { generateChatTitle } from './chatTitle';
