import { Type } from '@google/genai';
import { generateStructured } from './aiClient';
import { cleanTitle } from './chatTitleText';

export { autoTitle, cleanTitle, hasAutoTitle, titleBrief } from './chatTitleText';

const TITLE_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: { title: { type: Type.STRING } },
  required: ['title'],
};

/** A short title for a conversation from its opening exchange, or null if none could be written. */
export async function generateChatTitle(brief: string): Promise<string | null> {
  try {
    const { title } = await generateStructured<{ title: string }>({
      task: 'routing',
      prompt: `Write a title for this football conversation, for a list of past chats.

- Two to six words, naming the players, clubs or topic it is about.
- Title Case: capitalise every word except short joining words (a, an, the, and, or, of, in, on, at, to, for, by, vs) after the first; write players, clubs, competitions and countries as they are officially written, even when the user typed them in lowercase.
- Describe the subject, not the request: no leading verb such as "rate" or "analyze".
- Keep any edition the user asked about, such as a player's prime, an era or a season.
- No quotes, emoji or closing punctuation.

${brief}`,
      schema: TITLE_SCHEMA,
    });
    return cleanTitle(title ?? '');
  } catch (err) {
    console.warn('[ChatTitle] Generation failed:', err);
    return null;
  }
}
