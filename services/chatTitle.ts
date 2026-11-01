import { Type } from '@google/genai';
import type { ChatMessage, Conversation } from '../types';
import { generateStructured } from './aiClient';

/** Titles a conversation has before anything is said in it. */
const PLACEHOLDER_TITLES = new Set(['', 'New Chat', 'New Briefing']);

const TITLE_MAX_CHARS = 48;

/** The stand-in title from the first message, shown until the generated one arrives. */
export const autoTitle = (text: string): string =>
  text.substring(0, 30).trim() + (text.length > 30 ? '...' : '');

const firstUserText = (messages: ChatMessage[]): string | null => {
  const first = messages.find((m) => m.sender === 'user');
  return first && typeof first.content === 'string' ? first.content : null;
};

/**
 * Whether the conversation still wears a title nobody chose: a placeholder or the stand-in cut
 * from its first message. Renamed and generated titles are left alone, as are imported ones.
 */
export const hasAutoTitle = (conv: Conversation): boolean => {
  if (conv.titleSource) return false;
  if (PLACEHOLDER_TITLES.has(conv.title)) return true;
  const text = firstUserText(conv.messages);
  return text !== null && conv.title === autoTitle(text);
};

/**
 * The opening exchange a title is written from: the first message and the first reply that
 * answered it. Null until a reply has landed, or when the reply failed.
 */
export const titleBrief = (messages: ChatMessage[]): string | null => {
  const userIndex = messages.findIndex((m) => m.sender === 'user');
  const question = firstUserText(messages);
  if (userIndex < 0 || !question) return null;
  const reply = messages.slice(userIndex + 1).find((m) => m.sender === 'ai');
  if (!reply || reply.isError) return null;
  let answer: string;
  if (reply.dossier) {
    const version = reply.dossier.versionLabel ? `, ${reply.dossier.versionLabel}` : '';
    answer = `Filed a dossier card for ${reply.dossier.name}${version}.`;
  } else if (typeof reply.content === 'string') {
    answer = reply.content.replace(/[*_#>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
  } else {
    return null;
  }
  return `User: ${question.trim().slice(0, 400)}\nAnalyst: ${answer}`;
};

/** A model's title made fit for the list: one line, no quotes or closing stop, and short. */
export const cleanTitle = (raw: string): string | null => {
  const title = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return null;
  if (title.length <= TITLE_MAX_CHARS) return title;
  const cut = title.slice(0, TITLE_MAX_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : TITLE_MAX_CHARS).trim()}…`;
};

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

- Two to six words, in sentence case, naming the players, clubs or topic it is about.
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
