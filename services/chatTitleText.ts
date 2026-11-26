import type { ChatMessage, Conversation } from '../types';

/**
 * The title helpers that need no model, kept apart from `generateChatTitle` so the chat's first
 * paint doesn't load the AI client.
 */

/** Titles a conversation has before anything is said in it. */
const PLACEHOLDER_TITLES = new Set(['', 'New Chat', 'New Briefing', 'New briefing']);

/** Short joining words a title leaves lowercase after its first word. */
const MINOR_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'vs', 'vs.', 'with']);

const TITLE_MAX_CHARS = 48;

/** A title's first letter in capitals, however the message was typed. */
const capitalizeFirst = (text: string): string => text.replace(/^(\s*)(\p{Ll})/u, (_, space: string, letter: string) => space + letter.toUpperCase());

/**
 * Title Case for a title cut from a message: each word's first letter in capitals except the short
 * joining words after the first. Letters already in capitals stay ("PSG", "McTominay").
 */
const titleCase = (text: string): string =>
  text
    .split(/(\s+)/)
    .map((word, i) => (i > 0 && MINOR_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : capitalizeFirst(word)))
    .join('');

/** The stand-in title from the first message, shown until the generated one arrives. */
export const autoTitle = (text: string): string =>
  titleCase(text.substring(0, 30).trim()) + (text.length > 30 ? '...' : '');

/**
 * Titles as the list shows them. Placeholders read "New Briefing" however an older build stored
 * them, and a title starts with a capital however it was typed; otherwise a title is left exactly
 * as written, so a rename or a name inside it is never changed.
 */
const PLACEHOLDERS: Record<string, string> = {
  'new briefing': 'New Briefing',
  'new chat': 'New Briefing',
  'archived briefing': 'Archived Briefing',
  'shared briefing': 'Shared Briefing',
};
export const displayTitle = (title: string | undefined | null): string => {
  const trimmed = (title ?? '').trim();
  if (!trimmed) return 'New Briefing';
  return PLACEHOLDERS[trimmed.toLowerCase()] ?? capitalizeFirst(trimmed);
};

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
  // Stand-ins were stored as typed, then in sentence case, before they were Title Case.
  return text !== null && [conv.title, capitalizeFirst(conv.title), titleCase(conv.title)].some((t) => titleCase(t) === autoTitle(text));
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
  if (title.length <= TITLE_MAX_CHARS) return capitalizeFirst(title);
  const cut = title.slice(0, TITLE_MAX_CHARS);
  return `${capitalizeFirst(cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : TITLE_MAX_CHARS).trim())}…`;
};
