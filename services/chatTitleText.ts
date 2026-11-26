import type { ChatMessage, Conversation } from '../types';

/**
 * The title helpers that need no model, kept apart from `generateChatTitle` so the chat's first
 * paint doesn't load the AI client.
 */

/** Titles a conversation has before anything is said in it. */
const PLACEHOLDER_TITLES = new Set(['', 'New Chat', 'New Briefing', 'New briefing']);

const TITLE_MAX_CHARS = 48;

/** A title's first letter in capitals: titles are sentence case, however the message was typed. */
const capitalizeFirst = (text: string): string => text.replace(/^(\s*)(\p{Ll})/u, (_, space: string, letter: string) => space + letter.toUpperCase());

/** The stand-in title from the first message, shown until the generated one arrives. */
export const autoTitle = (text: string): string =>
  capitalizeFirst(text.substring(0, 30).trim()) + (text.length > 30 ? '...' : '');

/**
 * Older builds stored the placeholders in title case ("New Briefing") and stand-ins as typed
 * ("rate saka"). Shown, every title is sentence case: the first letter capitalised, the placeholders
 * lowered. Names inside a title are left exactly as written.
 */
const LEGACY_PLACEHOLDERS: Record<string, string> = {
  'New Briefing': 'New briefing',
  'New Chat': 'New briefing',
  'Archived Briefing': 'Archived briefing',
  'Shared Briefing': 'Shared briefing',
};
export const displayTitle = (title: string | undefined | null): string => {
  const trimmed = (title ?? '').trim();
  if (!trimmed) return 'New briefing';
  return LEGACY_PLACEHOLDERS[trimmed] ?? capitalizeFirst(trimmed);
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
  // Stand-ins from before titles were capitalised were stored as typed.
  return text !== null && capitalizeFirst(conv.title) === autoTitle(text);
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
