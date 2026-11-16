import { Type } from '@google/genai';
import { generateStructured } from './aiClient';
import { gateUnsupportedFigures, segmentReply, type FigureFinding } from './figureGate';
import type { DossierNumberFinding } from './dossierNumberGate';
import { REFLECT_CUTOFF_MS } from './researchAgent';
import type { ManagerReplacement } from '../packages/engine/src/gates/managerMentions.ts';

/**
 * Gates as feedback. The post-write gates (the figure gate, the attribute check against cards in
 * play, and the manager scrub) hold every reply to the turn's evidence by deleting or rewriting
 * what they flag, and the model never learns which claims it couldn't support. This gives the
 * model one chance to fix them first: the flagged sentences go back to it with the reason and the
 * evidence for each, and it returns a replacement for each (or an empty one to drop the sentence).
 * Code applies the replacements to the reply, so every unflagged sentence stays byte-identical, and
 * then runs the gates again; whatever is still flagged is removed exactly as it would have been.
 * The gates' standard doesn't change: a rewrite stands only if it passes the same checks.
 */

/** How long the correction call may take before the gated reply is kept as it is. */
export const GATE_FEEDBACK_TIMEOUT_MS = 8_000;
/**
 * On the stage pipeline, the longest the writer may have taken to finish its reply for a
 * correction to follow, counted from the writer's start. It is the mark the reflect call already
 * uses: past `REFLECT_CUTOFF_MS` a stage doesn't get another optional call. Reflect measures it
 * from the turn's start because its inputs are research; here it counts from the writer's start,
 * since research alone uses most of that time before the reply begins. A reply that took longer to
 * write than the mark is a slow turn, and the user keeps the gated text rather than waiting up to
 * `GATE_FEEDBACK_TIMEOUT_MS` more.
 */
export const GATE_FEEDBACK_CUTOFF_MS = REFLECT_CUTOFF_MS;
/** Flagged sentences one round sends. The rest are left to the gates, as they were before. */
export const GATE_FEEDBACK_MAX_FLAGGED = 8;
/** The progress line while the correction runs. */
export const GATE_FEEDBACK_STAGE_LABEL = 'Checking the figures...';
/** The longest the reply, as the prompt carries it. */
const REPLY_PROMPT_CHARS = 12_000;

/** Off switch: `GATE_FEEDBACK=off` leaves every gate deleting as it did before. */
export function gateFeedbackEnabled(): boolean {
  return (typeof process === 'undefined' ? undefined : process.env?.GATE_FEEDBACK) !== 'off';
}

/** What the three gates flagged in a reply, as each gate reports it. */
export interface GateFindings {
  /** Figures no evidence supports, each with its sentence and the nearest evidence. */
  figures: FigureFinding[];
  /** Attributes quoted with a value other than the card's. */
  attributes: DossierNumberFinding[];
  /** Coach names no source verified, and who may be named instead. */
  coaches: ManagerReplacement[];
}

export const noFindings = (): GateFindings => ({ figures: [], attributes: [], coaches: [] });
export const hasFindings = (f: GateFindings): boolean => f.figures.length + f.attributes.length + f.coaches.length > 0;

/** A reply sanitized, with what the gates flagged in it. */
export interface Sanitized {
  /** The sanitized reply. */
  text: string;
  /** The reply with its markup stripped and no gate applied: the text the findings point into. */
  stripped: string;
  findings: GateFindings;
}

// ---------------------------------------------------------------------------------------------
// From findings to flagged sentences

export interface FlaggedSentence {
  /** The sentence (or table cell) exactly as the stripped reply has it, without surrounding whitespace. */
  text: string;
  /** Whether it is a table cell, which a replacement must keep to one cell. */
  cell: boolean;
  /** Why the checks flagged it, in plain words. */
  reasons: string[];
  /** The evidence the model may use for it. */
  evidence: string[];
}

interface Unit {
  text: string;
  /** Offset of the trimmed text in the reply. */
  at: number;
  cell: boolean;
}

/** The reply's sentences and table cells, trimmed, with their offsets (the figure gate's own split). */
function unitsOf(reply: string): Unit[] {
  const units: Unit[] = [];
  for (const shape of segmentReply(reply)) {
    if (shape.kind === 'fixed') continue;
    const pieces = shape.kind === 'table' ? shape.cells : shape.parts;
    for (const piece of pieces) {
      const text = piece.text.trim();
      if (!text) continue;
      units.push({ text, at: piece.at + (piece.text.length - piece.text.trimStart().length), cell: shape.kind === 'table' });
    }
  }
  return units;
}

const KIND_LABEL: Record<string, string> = {
  percent: 'a percentage',
  money: 'a fee or amount',
  decimal: 'a decimal figure',
  stat: 'a count',
  goal_difference: 'a goal difference',
  position: 'a table position',
  minute: 'the minute of an event',
  shirt: 'a shirt number',
  quote: 'a quotation',
};

const NO_FIGURE_EVIDENCE = 'The evidence holds no line with a figure of this kind about these words.';

/**
 * The sentences the checks flagged, in reply order, each with why and the evidence for it. One
 * sentence flagged by several checks appears once with every reason.
 */
export function flaggedSentences(stripped: string, findings: GateFindings): FlaggedSentence[] {
  const units = unitsOf(stripped);
  const byText = new Map<string, FlaggedSentence & { order: number }>();
  const flag = (unit: Unit | undefined, reason: string, evidence: string[]) => {
    if (!unit) return;
    const entry = byText.get(unit.text) ?? { text: unit.text, cell: unit.cell, reasons: [], evidence: [], order: unit.at };
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    for (const line of evidence) if (!entry.evidence.includes(line)) entry.evidence.push(line);
    byText.set(unit.text, entry);
  };

  for (const f of findings.figures) {
    const unit = units.find((u) => u.text === f.sentence);
    flag(unit, `No source in the evidence for the figure "${f.claim.text}" (${KIND_LABEL[f.claim.kind] ?? 'a figure'}).`, f.evidence.length ? f.evidence : [NO_FIGURE_EVIDENCE]);
  }
  for (const a of findings.attributes) {
    const unit = units.find((u) => a.at >= u.at && a.at < u.at + u.text.length);
    flag(unit, `It gives ${a.player}'s ${a.label} as ${a.from}, but his card stores ${a.to}.`, [`Card: ${a.player}, ${a.label} ${a.to}.`]);
  }
  for (const c of findings.coaches) {
    const needle = c.name.toLowerCase();
    const named = units.filter((u) => u.text.toLowerCase().includes(needle));
    const reason =
      c.kind === 'former'
        ? `${c.name} is a former coach of ${c.club ?? 'the club'}, not its current one.`
        : `${c.name} is not a coach this turn verified.`;
    const evidence = [c.verifiedCoach ? `Verified coach: ${c.verifiedCoach}.` : 'No coach is verified for the club here, so name nobody.'];
    for (const unit of named) flag(unit, reason, evidence);
  }
  return [...byText.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...rest }) => rest);
}

// ---------------------------------------------------------------------------------------------
// The call

const REPLACEMENTS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    replacements: {
      type: Type.ARRAY,
      description: 'One entry for each flagged sentence you change.',
      items: {
        type: Type.OBJECT,
        properties: {
          original: { type: Type.STRING, description: 'The flagged sentence, copied exactly as it was given.' },
          replacement: { type: Type.STRING, description: 'The sentence to put in its place, or an empty string to drop it.' },
        },
        required: ['original', 'replacement'],
      },
    },
  },
  required: ['replacements'],
};

const SYSTEM_INSTRUCTION =
  'You fix flagged sentences in a football scouting reply. You change only the sentences you are asked about, you use only the evidence given for each, and you answer in the requested JSON.';

/** The correction prompt: the reply, then each flagged sentence with its reason and evidence. Descriptive only. */
export function buildFeedbackPrompt(reply: string, flagged: FlaggedSentence[]): string {
  const sentences = flagged
    .map(
      (f, i) =>
        `${i + 1}. Sentence: ${JSON.stringify(f.text)}${f.cell ? ' (a table cell)' : ''}\n   Why it was flagged: ${f.reasons.join(' ')}\n   Evidence you may use:\n${f.evidence.map((e) => `   - ${e}`).join('\n')}`,
    )
    .join('\n\n');
  return `A scouting reply was drafted for a user. Automatic checks flagged some of its sentences. Rewrite only the flagged sentences.

<reply>
${reply.slice(0, REPLY_PROMPT_CHARS)}
</reply>

<flagged_sentences>
${sentences}
</flagged_sentences>

How to rewrite:
- Return one entry for each flagged sentence you change. "original" is the flagged sentence copied exactly as given and "replacement" is what stands in its place. An empty replacement drops the sentence.
- A precise figure (a count, fee, percentage, table position, points total, minute, shirt number or quotation) may stay only where the evidence listed for that sentence states it for the same thing: the same kind of count, competition and period. Where it does, use the evidence's figure. Where it doesn't, make the same point in words with no figure, or drop the sentence when nothing worth keeping is left.
- Where a sentence misquotes a stored attribute, give the stored value and keep the rest of the sentence.
- Where a sentence names a coach that isn't verified, name only the verified coach listed, or describe the setup without naming anyone when none is listed.
- Add no fact, figure, name or claim that the evidence for that sentence doesn't hold, and use nothing you remember about football. Keep the sentence's voice, tense and markdown (bold labels, list structure, table cells). A replacement for a table cell stays one short cell with no pipe characters.
- Leave out any flagged sentence you can't improve, and never return an entry for a sentence that wasn't flagged.`;
}

/** The correction call: the prompt in, the model's parsed JSON out. Faked in tests. */
export type CorrectionModel = (request: { prompt: string; systemInstruction: string }) => Promise<unknown>;

/** The chat model at low thinking, answering in the replacements schema. */
export const liveCorrectionModel: CorrectionModel = ({ prompt, systemInstruction }) =>
  generateStructured<unknown>({ task: 'chat', prompt, systemInstruction, schema: REPLACEMENTS_SCHEMA, thinkingLevelOverride: 'low' });

/** A replacement longer than this many times its sentence (plus a margin) is a rewrite of more than the sentence. */
const REPLACEMENT_MAX_GROWTH = 3;
const REPLACEMENT_MARGIN_CHARS = 300;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The model's answer as replacements for flagged sentences, keyed by the sentence. An entry for a
 * sentence that wasn't flagged is ignored, as is an unusable replacement (too long, or a table cell
 * with a pipe or line break); a sentence with none is left as it was. Null when the answer isn't
 * the shape the schema asks for.
 */
export function parseReplacements(raw: unknown, flagged: FlaggedSentence[], strip: (s: string) => string = (s) => s): Map<string, string> | null {
  const list = (raw as { replacements?: unknown } | null)?.replacements;
  if (!Array.isArray(list)) return null;
  const out = new Map<string, string>();
  for (const entry of list) {
    const original = (entry as { original?: unknown })?.original;
    const replacement = (entry as { replacement?: unknown })?.replacement;
    if (typeof original !== 'string' || typeof replacement !== 'string') continue;
    const target = flagged.find((f) => f.text === original.trim()) ?? flagged.find((f) => squash(f.text) === squash(original));
    if (!target || out.has(target.text)) continue;
    const text = strip(replacement).trim();
    if (text === target.text) continue;
    if (text.length > target.text.length * REPLACEMENT_MAX_GROWTH + REPLACEMENT_MARGIN_CHARS) continue;
    if (target.cell && /[|\n]/.test(text)) continue;
    out.set(target.text, target.cell ? text : text.replace(/\s*\n\s*/g, ' '));
  }
  return out;
}

/**
 * The reply with each flagged sentence's replacement in its place. A sentence that wasn't flagged
 * is never touched, and a dropped sentence (an empty replacement) is left in place and listed in
 * `dropped`, for the gate to cut with its usual fragment handling.
 */
export function applyReplacements(stripped: string, replacements: Map<string, string>): { text: string; dropped: string[] } {
  const dropped = [...replacements].filter(([, r]) => r === '').map(([k]) => k);
  const edits = unitsOf(stripped)
    .filter((u) => (replacements.get(u.text) ?? '') !== '')
    .sort((a, b) => b.at - a.at);
  let text = stripped;
  for (const u of edits) text = text.slice(0, u.at) + replacements.get(u.text)! + text.slice(u.at + u.text.length);
  return { text, dropped };
}

// ---------------------------------------------------------------------------------------------
// The round

/** What one correction did, in sentences. */
export interface GateFeedbackStats {
  /** Flagged sentences sent to the model. */
  flagged: number;
  /** Sentences the model rewrote that survived the second pass. */
  fixed: number;
  /** Sentences the model dropped. */
  dropped: number;
  /** Sentences the second pass still cut (a rewrite that was still unsupported, or a sentence the model left alone). */
  removed: number;
  /** Flagged sentences the model left alone that the gates then fixed in place (a coach or attribute). */
  left: number;
  ms: number;
}

/** `flagged 3, fixed 2, dropped 1, removed 0`: the counts as the log and the eval read them. */
export const formatGateFeedback = (s: Pick<GateFeedbackStats, 'flagged' | 'fixed' | 'dropped' | 'removed'>): string =>
  `flagged ${s.flagged}, fixed ${s.fixed}, dropped ${s.dropped}, removed ${s.removed}`;

export interface CorrectReplyResult {
  /** The reply to show: corrected, or exactly what the gates alone would have produced. */
  text: string;
  /** The round's counts; null when no round finished (nothing flagged, or the call failed). */
  stats: GateFeedbackStats | null;
  /** Whether the model was called, which counts against a turn's call budget even when the call failed. */
  called: boolean;
}

export interface CorrectReplyArgs {
  /** The model's reply as written. */
  raw: string;
  /** The turn's gates over a text, with what they flagged. */
  sanitize: (text: string) => Sanitized;
  /** The markup stripper the gates start with, so a replacement is read as the gates will read it. */
  strip: (text: string) => string;
  correct?: CorrectionModel;
  timeoutMs?: number;
  /** Called just before the model is. */
  onCorrecting?: () => void;
  now?: () => number;
}

/** The promise's value, or a timeout error once `ms` has passed. */
async function withinTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sanitizes a reply and, when the gates flag something, gives the model one chance to fix it first.
 * The result is the reply the gates alone would have produced unless the round finished and the
 * gates, run again over the corrected reply, accepted it; a failed, slow or malformed call keeps
 * the gated reply.
 */
export async function correctReply(args: CorrectReplyArgs): Promise<CorrectReplyResult> {
  const now = args.now ?? Date.now;
  const first = args.sanitize(args.raw);
  if (!hasFindings(first.findings)) return { text: first.text, stats: null, called: false };
  const flagged = flaggedSentences(first.stripped, first.findings).slice(0, GATE_FEEDBACK_MAX_FLAGGED);
  if (flagged.length === 0) return { text: first.text, stats: null, called: false };

  const start = now();
  args.onCorrecting?.();
  let replacements: Map<string, string> | null;
  try {
    const raw = await withinTimeout((args.correct ?? liveCorrectionModel)({ prompt: buildFeedbackPrompt(first.stripped, flagged), systemInstruction: SYSTEM_INSTRUCTION }), args.timeoutMs ?? GATE_FEEDBACK_TIMEOUT_MS);
    replacements = parseReplacements(raw, flagged, args.strip);
    if (!replacements) throw new Error('the answer was not a list of replacements');
  } catch (e: any) {
    console.warn(`[GateFeedback] failed after ${now() - start} ms, flagged ${flagged.length}: ${String(e?.message ?? e).slice(0, 120)}; the gated reply stands`);
    return { text: first.text, stats: null, called: true };
  }

  const applied = applyReplacements(first.stripped, replacements);
  const cut = applied.dropped.length ? gateUnsupportedFigures(applied.text, '', [], { drop: applied.dropped, dropOnly: true }).text : applied.text;
  const second = args.sanitize(cut);
  // An empty second pass never replaces a reply the gates left standing.
  if (!second.text.trim() && first.text.trim()) {
    console.warn('[GateFeedback] the corrected reply came out empty; the gated reply stands');
    return { text: first.text, stats: null, called: true };
  }

  // A sentence stays flagged by the figure gate when the second pass found a figure in it again.
  const stillUnsupported = (text: string) => second.findings.figures.some((f) => text.includes(f.sentence));
  const stats: GateFeedbackStats = { flagged: flagged.length, fixed: 0, dropped: 0, removed: 0, left: 0, ms: 0 };
  for (const f of flagged) {
    const replacement = replacements.get(f.text);
    if (replacement === '') stats.dropped++;
    else if (replacement !== undefined) stillUnsupported(replacement) ? stats.removed++ : stats.fixed++;
    else stillUnsupported(f.text) ? stats.removed++ : stats.left++;
  }
  stats.ms = now() - start;
  console.info(`[GateFeedback] ${formatGateFeedback(stats)} (${stats.ms} ms)`);
  return { text: second.text, stats, called: true };
}

/** Whether the stage pipeline lets a reply have a correction round: a researched turn whose writer finished in time. */
export function stageFeedbackAllowed(turn: { researched: boolean; figureCheck: boolean; writerMs: number }): boolean {
  return gateFeedbackEnabled() && turn.researched && turn.figureCheck && turn.writerMs <= GATE_FEEDBACK_CUTOFF_MS;
}
