import type { ChatMessage } from '../types';

/** Unwrap prior Gaffa prompt shells if a raw task ever landed in history. */
function unwrapStoredUserText(text: string): string {
  const taskMatch = text.match(/<task>\s*([\s\S]*?)\s*<\/task>/i);
  if (taskMatch?.[1]) return taskMatch[1].trim();
  return text.trim();
}

/** Keeps the opening and the end of a long reply, where its verdict usually sits. */
function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = Math.ceil(max * 0.4);
  return `${t.slice(0, head).trimEnd()} … ${t.slice(t.length - (max - head)).trimStart()}`;
}

/**
 * Recent chat turns for follow-up continuity. Inject into prompts so the model
 * treats roster/context messages as ammo for the open question, not a new topic.
 */
export function buildOngoingThreadBlock(
  history: ChatMessage[],
  options?: { maxMessages?: number; maxAiChars?: number },
): string {
  const maxMessages = options?.maxMessages ?? 6;
  const maxAiChars = options?.maxAiChars ?? 700;

  const turns = history
    .filter((m) => typeof m.content === 'string' && (m.content as string).trim().length > 0)
    .slice(-maxMessages);

  if (turns.length === 0) return '';

  const lines = turns.map((m) => {
    const role = m.sender === 'user' ? 'User' : 'Futbolpedia';
    let text = unwrapStoredUserText(m.content as string);
    if (m.sender === 'ai') text = truncate(text, maxAiChars);
    return `${role}: ${text}`;
  });

  return `<ongoing_thread>
The latest user message continues this conversation. Treat it as context, clarification, or a constraint on the open question/decision unless they clearly change topics.
If they supply roster, budget, standings, or backup options after a trade/player question, re-evaluate that open question with the new context — do not answer the context message as a standalone topic.
${lines.join('\n\n')}
</ongoing_thread>`;
}

/** One-liner reminder to append into instruction blocks. */
export const CONTINUITY_REMINDER =
  'THREAD CONTINUITY: When <ongoing_thread> is present, continue that thread. Context-only follow-ups (backups, budget, standings, “we’re contenders”) update the open decision — they are not a new briefing topic.';
