import { Type } from '@google/genai';

/**
 * What the user is trying to do, read by the research brief and the debate brief in the same call
 * that plans their lookups (no extra call): the goal behind the words, what a useful answer has to
 * settle, and, on a follow-up that pushes back, what they object to and the checkable fact it rests
 * on. The writer reads it first, as `<user_need>`. Descriptive prompts only: no players, clubs or
 * sample phrases. Pure, apart from the schema constant.
 */
export interface NeedRead {
  /** What the user is trying to decide or do. */
  goal: string;
  /** What a useful answer has to settle, most important first. */
  settle: string[];
  /** On a follow-up that pushes back on the last reply: what in it they object to. Empty otherwise. */
  objection: string;
  /** The checkable fact the objection rests on, as a question research can answer. Empty when it's judgment. */
  objectionFact: string;
}

export const MAX_SETTLE = 4;

export const NEED_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    goal: { type: Type.STRING },
    settle: { type: Type.ARRAY, items: { type: Type.STRING } },
    objection: { type: Type.STRING },
    objectionFact: { type: Type.STRING },
  },
  required: ['goal', 'settle', 'objection', 'objectionFact'],
};

/** The brief prompts' instruction for the `need` field, numbered by the caller. */
export const NEED_PROMPT = `need: what the user needs, read from the whole conversation and not only the latest words. Keep each part to a sentence.
   - goal: what the user is trying to decide or do. Use the ordinary sense a knowledgeable friend would bring to their situation: what they own or control, what they can do next, and what they have already told you.
   - settle: up to ${MAX_SETTLE} things a useful answer has to settle for that goal, most important first.
   - objection: when the latest message pushes back on the last reply (disputes a fact, questions a recommendation, or asks why something wasn't known), what in that reply they object to. Leave it empty otherwise.
   - objectionFact: when the objection rests on a fact that can be checked (a status, a date, a result, who plays, a record), that fact, written as a question the lookups can answer. Leave it empty when the objection is about judgment. This fact is checked this turn: the user's word neither settles it nor is dismissed, so plan the lookup that settles it.`;

const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A need read from the model's JSON, or null when it says nothing. */
export function readNeed(raw: unknown): NeedRead | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const need: NeedRead = {
    goal: str(r.goal),
    settle: Array.isArray(r.settle) ? r.settle.map((s) => str(s, 200)).filter(Boolean).slice(0, MAX_SETTLE) : [],
    objection: str(r.objection),
    objectionFact: str(r.objectionFact),
  };
  // An objection fact with no objection is still a fact the user disputes.
  return need.goal || need.settle.length || need.objection || need.objectionFact ? need : null;
}

/** Whether the need records a disputed fact that must be checked this turn. */
export const hasCheckableObjection = (need: NeedRead | null | undefined): boolean => Boolean(need?.objectionFact);

/** The need as the writer reads it, ahead of the other blocks. Empty when there is none. */
export function formatNeedForWriter(need: NeedRead | null | undefined): string {
  if (!need) return '';
  const lines: string[] = [];
  if (need.goal) lines.push(`What the user is trying to do: ${need.goal}`);
  if (need.settle.length) lines.push(`What a useful answer has to settle:\n${need.settle.map((s) => `- ${s}`).join('\n')}`);
  if (need.objection) lines.push(`What they object to in the last reply: ${need.objection}`);
  if (need.objectionFact) {
    lines.push(
      `The fact the objection turns on: ${need.objectionFact}\nSettle it from the evidence this turn, or with a tool if the evidence doesn't answer it, and answer with what you found, partial evidence included. Don't accept or reject it on the user's word, and if your last reply was wrong, correct it in one sentence.`,
    );
  }
  return lines.length ? `<user_need>\n${lines.join('\n')}\n</user_need>` : '';
}
