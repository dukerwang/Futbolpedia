/**
 * The writer's initiative: choices a turn makes about the conversation itself, not about the
 * football. The model may end a turn with a question (`ask_user`), start a club's research for
 * the next step (`prepare_club`), offer to rate a player (`offer_rating`) and flag that a question
 * deserved a longer look (`request_deeper`). This file holds the parts that are plain code: what
 * counts as a usable question, the once-per-conversation record of prepared clubs, and whether a
 * player was asked about directly. The handlers that write onto a reply are built in
 * `conversationalScout.ts`, beside the helpers they call.
 */
import type { AskPrompt } from '../types';

export const ASK_MIN_OPTIONS = 2;
export const ASK_MAX_OPTIONS = 4;
/** A chip is a few words; a longer option is cut at a word. */
export const ASK_OPTION_MAX_CHARS = 60;
export const ASK_QUESTION_MAX_CHARS = 240;
export const DEEPER_REASON_MAX_CHARS = 200;

/** Prepared clubs a conversation may have, and the most one turn may start. */
export const PREPARE_PER_CONVERSATION = 3;
export const PREPARE_PER_TURN = 2;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Cuts text at a word to at most `max` characters. */
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '');
};

/** A usable question and its options, or why the call can't end the turn. */
export function validateAsk(question: unknown, options: unknown): { ok: true; ask: AskPrompt } | { ok: false; error: string } {
  const text = typeof question === 'string' ? collapse(question) : '';
  if (!text) return { ok: false, error: 'ask_user needs a question. Write your answer instead.' };
  if (!Array.isArray(options)) return { ok: false, error: `ask_user needs ${ASK_MIN_OPTIONS} to ${ASK_MAX_OPTIONS} options.` };
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const option of options) {
    if (typeof option !== 'string') continue;
    const value = clip(collapse(option), ASK_OPTION_MAX_CHARS);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
  }
  if (cleaned.length < ASK_MIN_OPTIONS) {
    return { ok: false, error: `ask_user needs at least ${ASK_MIN_OPTIONS} distinct options. If the message has one likelier reading, take it and answer.` };
  }
  return { ok: true, ask: { question: clip(text, ASK_QUESTION_MAX_CHARS), options: cleaned.slice(0, ASK_MAX_OPTIONS) } };
}

/** The reason on a Go deeper chip: one line, or nothing when the model gave none. */
export const cleanReason = (reason: unknown): string =>
  typeof reason === 'string' ? clip(collapse(reason), DEEPER_REASON_MAX_CHARS) : '';

// ---------------------------------------------------------------------------------------------
// Prepared clubs

const tokens = (text: string): string[] =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/** A club's name with the club-type words dropped, so "Arsenal" and "Arsenal FC" share a key. */
export const clubKey = (club: string): string =>
  tokens(club)
    .filter((t) => !['fc', 'cf', 'afc', 'sc'].includes(t))
    .join(' ');

const PREPARED_LIMIT = 500;
const prepared = new Map<string, Set<string>>();

/** Forgets every prepared club. For tests. */
export const resetPrepared = (): void => prepared.clear();

/** The clubs this conversation has started, oldest conversation dropped past the limit. */
const preparedFor = (conversationId: string): Set<string> => {
  const existing = prepared.get(conversationId);
  if (existing) {
    prepared.delete(conversationId);
    prepared.set(conversationId, existing);
    return existing;
  }
  const fresh = new Set<string>();
  prepared.set(conversationId, fresh);
  while (prepared.size > PREPARED_LIMIT) {
    const oldest = prepared.keys().next().value;
    if (oldest === undefined) break;
    prepared.delete(oldest);
  }
  return fresh;
};

/** Starts the server's snapshot build for a club, through the route a turn itself uses. Never awaited. */
const startBuild = (club: string): void => {
  void fetch(`/api/snapshots/club?${new URLSearchParams({ club })}`)
    .then((res) => res.text())
    .catch(() => {});
};

/**
 * The `prepare_club` handler for one turn. A club starts at most once per conversation, at most
 * `PREPARE_PER_CONVERSATION` clubs start in a conversation and `PREPARE_PER_TURN` in a turn, and a
 * club the turn already reads (`inPlay`) is left to the turn. It returns at once; the build runs on
 * the server and a failed one only means the next turn builds it as it would have.
 */
export function createPreparer(conversationId: string, inPlay: string[], start: (club: string) => void = startBuild) {
  const thisTurn = new Set<string>();
  const turnClubs = new Set(inPlay.map(clubKey));
  return (args: { club?: unknown }): Record<string, unknown> => {
    const club = typeof args.club === 'string' ? collapse(args.club) : '';
    const key = clubKey(club);
    if (!key || club.length > 60) return { started: false, error: 'Missing or unusable club name' };
    if (turnClubs.has(key)) return { started: false, reason: 'This turn already reads that club.' };
    const done = preparedFor(conversationId);
    if (done.has(key)) return { started: false, reason: 'Already prepared in this conversation.' };
    if (thisTurn.size >= PREPARE_PER_TURN) return { started: false, reason: `At most ${PREPARE_PER_TURN} clubs per reply.` };
    if (done.size >= PREPARE_PER_CONVERSATION) return { started: false, reason: `At most ${PREPARE_PER_CONVERSATION} clubs per conversation.` };
    done.add(key);
    thisTurn.add(key);
    start(club);
    return { started: true, note: 'Running in the background. It does not change this reply.' };
  };
}

// ---------------------------------------------------------------------------------------------
// Asked about directly

/**
 * Whether the user named this player: he is one of the players the turn was routed to, or his
 * name (every word of it) is in the message. A player the model looked up on its own, such as one
 * it brought in for a comparison, isn't, and is offered through `offer_rating` instead.
 */
export function askedDirectly(name: string, targets: string[], message: string): boolean {
  const wanted = tokens(name);
  if (wanted.length === 0) return false;
  const inside = (small: string[], big: string[]) => small.every((t) => big.includes(t));
  for (const target of targets) {
    const have = tokens(target);
    if (have.length > 0 && (inside(wanted, have) || inside(have, wanted))) return true;
  }
  return inside(wanted, tokens(message));
}
