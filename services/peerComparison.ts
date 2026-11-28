import { Type } from '@google/genai';
import type { PeerComparison, PeerJudgment, PlayerProfile } from '../types';
import { ATTRIBUTE_LABELS, GK_ATTRIBUTE_LABELS, RATING_TIERS } from '../constants/ratingTiers';
import { generateStructured } from './aiClient';
import { getCardKey } from './dossierCards';
import { describePeer, placementRange, type ResolvedPlacement } from './ratingPlacement';
import { formatComparisonLines } from './peerComparisonText';
import { OFF_FOOTBALL_LABEL, offFootballReason, type OffFootballKind } from './reasonCheck';

/**
 * Comparison first. Before a rating sees any number, one call judges the version being rated
 * against each of his closest peers, head to head: better, level or not as good, each with one
 * sentence of football. Peers are shown with no Overall, Potential, tier or attribute value, so the
 * judgment is of the footballers and never of where their cards sit. Code checks every reason
 * (`reasonCheck.ts`), sends the ones that rest on availability, team success or fame back once, and
 * drops any still flagged; the comparisons that stand become the placement, and
 * `placementRange` turns them into the Overall range the card is written within.
 */

/** How long one comparison call may take before the rating goes on without it. */
export const COMPARISON_TIMEOUT_MS = 45_000;
/** How much of the subject's evidence the call reads. */
const EVIDENCE_CHARS = 14_000;

/** One peer compared, with the card the comparison is about. */
export interface ComparedPeer {
  peer: PlayerProfile;
  judgment: PeerJudgment;
  reason: string;
}

export interface ComparisonResult {
  /** The comparisons that stand, in the peers' order. */
  compared: ComparedPeer[];
  /** Pairs whose reason still rested on something other than football after the follow-up. */
  dropped: Array<ComparedPeer & { kind: OffFootballKind }>;
  /** Model calls made: 0 with no peers, 1, or 2 when a reason was sent back. */
  calls: number;
}

const JUDGMENTS: readonly PeerJudgment[] = ['better', 'level', 'not_as_good'];

const COMPARISON_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    comparisons: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          peer: { type: Type.STRING, description: 'The peer label exactly as given (P1, P2, ...).' },
          judgment: {
            type: Type.STRING,
            enum: [...JUDGMENTS],
            description: 'Whether the player being rated, in this version, was a better footballer than this peer in his, level with him, or not as good.',
          },
          reason: {
            type: Type.STRING,
            description:
              'One sentence on what decides it on the pitch: technique, decisions, movement, physical and mental qualities, how each shaped matches. Never availability, durability, minutes, team success, trophies or fame.',
          },
        },
        required: ['peer', 'judgment', 'reason'],
      },
    },
  },
  required: ['comparisons'],
};

const ATTRIBUTE_NAMES = [...Object.values(ATTRIBUTE_LABELS), ...Object.values(GK_ATTRIBUTE_LABELS)];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ATTRIBUTE_VALUE_RE = new RegExp(`\\b(${ATTRIBUTE_NAMES.map(escapeRe).join('|')})\\s*(?:\\(\\s*\\d{1,2}\\s*\\)|\\d{1,2}\\b)`, 'gi');
const VALUE_ATTRIBUTE_RE = new RegExp(`\\b\\d{1,2}\\s+(${ATTRIBUTE_NAMES.map(escapeRe).join('|')})\\b`, 'gi');
const RATING_AFTER_RE = /\b\d{2}\s*(?:OVR|overall)\b/gi;
const RATING_BEFORE_RE = /\b(?:OVR|overall|rating|rated(?: at)?)\s*(?:of\s*)?\d{2}\b/gi;
const OVR_RE = /\bOVR\b/g;
// Squad Depth is also an ordinary phrase about a team, so it stays.
const TIER_RE = new RegExp(`\\b(${RATING_TIERS.filter((t) => t.label !== 'Squad Depth').map((t) => escapeRe(t.label)).join('|')})\\b`, 'gi');

/**
 * A card's prose with every rating-scale number taken out: "Vision 94" keeps "Vision", "91 OVR"
 * and tier names go. Match figures (goals, seasons) stay: they are facts about his football.
 */
export function scrubRatingNumbers(text: string): string {
  return text
    .replace(ATTRIBUTE_VALUE_RE, '$1')
    .replace(VALUE_ATTRIBUTE_RE, '$1')
    .replace(RATING_AFTER_RE, '')
    .replace(RATING_BEFORE_RE, '')
    .replace(OVR_RE, '')
    .replace(TIER_RE, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:])/g, '$1')
    .trim();
}

/**
 * A peer as the comparison sees him: name, version and window, position, roles, archetype,
 * playstyle, strengths and weaknesses. No Overall, Potential, tier, placement or attribute value.
 */
export function serializePeerForComparison(p: PlayerProfile, label: string): string {
  const bi = p.basicInfo;
  const version = p.version
    ? `${p.version.label}${p.version.seasonOrEra && !p.version.label.includes(p.version.seasonOrEra) ? ` (${p.version.seasonOrEra})` : ''}`
    : 'Current Form';
  const lines = [
    `[${label}] ${bi.name} | ${version} | ${bi.position} | ${bi.club}`,
    p.version?.peakContext ? `Version: ${p.version.peakContext}` : '',
    `Archetype: ${p.playstyleAndRole?.playstyle?.archetype ?? 'N/A'} | Best roles: ${(p.playstyleAndRole?.bestRoles ?? []).join(', ') || 'N/A'}`,
    p.playstyleAndRole?.playstyle?.description ? `Playstyle: ${p.playstyleAndRole.playstyle.description}` : '',
    p.strengths?.length ? `Strengths: ${p.strengths.join(' ')}` : '',
    p.weaknesses?.length ? `Weaknesses: ${p.weaknesses.join(' ')}` : '',
  ];
  return lines.filter(Boolean).map(scrubRatingNumbers).join('\n');
}

export interface ComparisonParams {
  /** The player as the turn's evidence gives him: the foundation synthesis reads, or his card without numbers. */
  subjectName: string;
  subjectEvidence: string;
  /** What is being rated: the rating task, naming the version. */
  task: string;
  peers: PlayerProfile[];
  /** A challenge's argument, the card's earlier comparisons and any new evidence. */
  context?: string;
}

const peerLabel = (i: number) => `P${i + 1}`;

export function buildComparisonPrompt(params: ComparisonParams): string {
  return `<task>${params.task}</task>
<player>
${params.subjectName}, in the version the task names. Everything known about him:
${scrubRatingNumbers(params.subjectEvidence.slice(0, EVIDENCE_CHARS))}
</player>
${params.context ? `<context>\n${scrubRatingNumbers(params.context)}\n</context>\n` : ''}<peers>
${params.peers.map((p, i) => serializePeerForComparison(p, peerLabel(i))).join('\n\n')}
</peers>
<instructions>
Compare ${params.subjectName}, in the version the task names, with each peer in his own version, one at a time: which was the better footballer? Judge what each did on the pitch: technique, decisions, movement, physical and mental qualities, how each shaped the matches he played and how his strengths and weaknesses weigh against the other's. Positions differ in what they ask, so weigh each by how well he did what his role asked and how much that decided matches.
Give one of better (he was the better footballer), level (neither was clearly better) or not_as_good, for every peer, with one sentence saying what decides it. Matches or minutes missed, injuries, durability, appearance totals, the trophies and results his team won, and fame are not reasons: a version is judged on the football he played when he played. Judge each peer on his own, not to fit an order you already have in mind.${
    params.context ? '\nThe context gives an argument about the player and his earlier comparisons. Weigh the argument on its merits: change a comparison where it holds, and keep one where it doesn\'t.' : ''
  }
</instructions>`;
}

function followUpPrompt(base: string, flagged: Array<{ label: string; judgment: PeerJudgment; reason: string; kind: OffFootballKind }>): string {
  return `${base}
<reason_check>
These reasons rest on something other than football:
${flagged.map((f) => `- ${f.label} (${f.judgment}): "${f.reason}" rests on ${OFF_FOOTBALL_LABEL[f.kind]}.`).join('\n')}
Compare those peers again, and only those: judge which was the better footballer from the football each played, and give a reason that rests on it. The judgment may stay the same or change.
</reason_check>`;
}

interface RawComparison {
  peer?: string;
  judgment?: string;
  reason?: string;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]);
};

/** The comparisons in a reply, keyed by peer label; unknown labels, judgments and empty reasons are ignored. */
function readComparisons(raw: { comparisons?: RawComparison[] } | null, count: number): Map<number, { judgment: PeerJudgment; reason: string }> {
  const out = new Map<number, { judgment: PeerJudgment; reason: string }>();
  for (const c of raw?.comparisons ?? []) {
    const m = /^\s*P(\d+)\s*$/i.exec(c?.peer ?? '');
    const index = m ? Number(m[1]) - 1 : -1;
    const judgment = JUDGMENTS.find((j) => j === c?.judgment);
    const reason = (c?.reason ?? '').trim();
    if (index < 0 || index >= count || !judgment || !reason || out.has(index)) continue;
    out.set(index, { judgment, reason });
  }
  return out;
}

const ask = (prompt: string) =>
  withTimeout(
    generateStructured<{ comparisons?: RawComparison[] }>({ task: 'synthesis', prompt, schema: COMPARISON_SCHEMA }).catch((err) => {
      console.warn('[PeerComparison] Comparison call failed.', err);
      return null;
    }),
    COMPARISON_TIMEOUT_MS,
  );

/**
 * Compares the player with each peer, checks every reason, and sends the ones that rest on
 * something other than football back once. A failed or slow call compares nobody, and the rating
 * goes on as it would have.
 */
export async function comparePeers(params: ComparisonParams): Promise<ComparisonResult> {
  const { peers } = params;
  if (peers.length === 0) return { compared: [], dropped: [], calls: 0 };
  const started = Date.now();
  const prompt = buildComparisonPrompt(params);
  const first = readComparisons(await ask(prompt), peers.length);
  let calls = 1;

  const flaggedIn = (answers: Map<number, { judgment: PeerJudgment; reason: string }>) =>
    [...answers]
      .map(([index, a]) => ({ index, ...a, kind: offFootballReason(a.reason) }))
      .filter((f): f is { index: number; judgment: PeerJudgment; reason: string; kind: OffFootballKind } => f.kind !== null);

  const answers = new Map(first);
  const flagged = flaggedIn(first);
  if (flagged.length > 0) {
    calls++;
    const again = readComparisons(
      await ask(followUpPrompt(prompt, flagged.map((f) => ({ ...f, label: peerLabel(f.index) })))),
      peers.length,
    );
    for (const f of flagged) {
      const answer = again.get(f.index);
      if (answer) answers.set(f.index, answer);
    }
  }

  const compared: ComparedPeer[] = [];
  const dropped: ComparisonResult['dropped'] = [];
  for (const [index, a] of [...answers].sort((x, y) => x[0] - y[0])) {
    const kind = offFootballReason(a.reason);
    const entry = { peer: peers[index], judgment: a.judgment, reason: a.reason };
    if (kind) dropped.push({ ...entry, kind });
    else compared.push(entry);
  }
  console.log(
    `[PeerComparison] ${params.subjectName}: ${compared.length} of ${peers.length} compared` +
      (flagged.length ? `, ${flagged.length} sent back` : '') +
      (dropped.length ? `, ${dropped.length} dropped` : '') +
      ` (${Date.now() - started}ms)`,
  );
  return { compared, dropped, calls };
}

/** The comparisons as a placement: better is above, level is level, not_as_good is below. */
export function placementFromComparisons(compared: ComparedPeer[]): ResolvedPlacement {
  const of = (j: PeerJudgment) => compared.filter((c) => c.judgment === j).map((c) => c.peer);
  return { betterThan: of('better'), levelWith: of('level'), notAsGoodAs: of('not_as_good') };
}

/** The Overall range the comparisons allow; null with none, or when they contradict each other. */
export function comparisonRange(compared: ComparedPeer[]): { min: number; max: number } | null {
  return compared.length ? placementRange(placementFromComparisons(compared)) : null;
}

/** The comparisons as the card stores them. */
export const toStoredComparisons = (compared: ComparedPeer[]): PeerComparison[] =>
  compared.map((c) => ({ peer: describePeer(c.peer), peerKey: getCardKey(c.peer), judgment: c.judgment, reason: c.reason }));

export { formatComparisonLines } from './peerComparisonText';

/**
 * What synthesis is told: the comparisons, and the range they allow as a constraint, or, when they
 * contradict each other, that the placement was mixed.
 */
export function buildComparisonsBlock(compared: ComparedPeer[]): string {
  if (compared.length === 0) return '';
  const lines = formatComparisonLines(toStoredComparisons(compared)).map((l) => `- ${l}`).join('\n');
  const range = comparisonRange(compared);
  const rule = range
    ? `These head-to-head comparisons were made before any rating was in view. Together with the peers' Overalls they allow an Overall from ${range.min} to ${range.max}${range.min === range.max ? ' exactly' : ''}. Write the card within that range: \`ratings.overall\` inside it, the \`calibration.tierBand\` that holds it, and \`calibration.peerPlacement\` repeating these comparisons (better than in betterThan, level with in levelWith, not as good as in notAsGoodAs, names as written before the colon).`
    : 'These head-to-head comparisons were made before any rating was in view, and the peers\' Overalls leave no single range that agrees with all of them. Place him by your own judgment against <calibrated_peer_ledger>, and say in `confidence.verdict` that his placement among the closest peers was mixed.';
  return `
<peer_comparisons>
${rule}
${lines}
</peer_comparisons>`;
}

/** A sentence the confidence verdict carries when the comparisons were mixed and the model didn't say so. */
export const MIXED_PLACEMENT_NOTE = 'His head-to-head comparisons with the closest peers were mixed, so his placement among them is less certain.';

export const saysMixed = (verdict: string | undefined): boolean => /\bmixed\b|\bcontradict|\bsplit\b/i.test(verdict ?? '');
