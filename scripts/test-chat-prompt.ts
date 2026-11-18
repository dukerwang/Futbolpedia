/**
 * The chat writer's prompts, offline. The scouting core is composed from section constants
 * (`prompts/scoutCore.ts`); these checks pin what card synthesis and chat read, byte for byte, so
 * splitting or moving a section never changes a prompt by accident. A deliberate prompt change
 * updates the hash here in the same commit, with the reason in the commit message.
 *
 * Design: docs/superpowers/specs/2026-11-18-chat-principles-design.md.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CORE_ATTRIBUTES,
  CORE_HEADER,
  CORE_RATING_SCALE,
  CORE_SCOUTS_CODE,
  CORE_SECTION_I,
  CORE_SECTION_V,
  CORE_VERSIONS,
  CORE_EAFC_INDEPENDENCE,
  SCOUT_CORE_INSTRUCTION,
} from '../prompts/scoutCore';
import { DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION } from '../prompts/dossierPrompt';
import {
  buildConversationalScoutInstruction,
  CHAT_PRINCIPLES,
  GAFFA_CLUB_SOURCES,
  HOW_CARDS_WORK,
  INITIATIVE_RULES,
  PRINCIPLE_NAMES,
  PRINCIPLE_SOURCES,
  RATING_CODE,
  viewRules,
} from '../prompts/chatPrompt';
import {
  CORE_BANNED_WORDS,
  CORE_CANONICAL_POSITIONS,
  CORE_NICKNAMES,
  CORE_POSITIVE_RELEVANCE,
  CORE_STRAWMAN_BAN,
} from '../prompts/scoutCore';
import type { PlayerProfile } from '../types';
import { CALIBRATION_EPOCH_MS } from '../services/dossierCache';
import { buildLockedDossiersBlock, buildSavedDossiersBlock } from '../services/dossierContext';
import { challengeInstructions, initiativeRules, stageInstructions } from '../services/conversationalScout';
import { DEEP_DECLARATIONS, DEFAULT_DEEP_BUDGET, deepInstructions, deepModeRules, deepResearchRules } from '../services/deepTurn';
import { readDebateBrief } from '../services/debateBrief';
import { CARD_ANCHOR_NOTE, COMMIT_VERDICT_DECLARATION, PAST_RESEARCH_NOTE } from '../services/pastTurn';
import { formatSituation } from '../services/situationSnapshot';
import { formatBriefForWriter, type ResearchBrief } from '../services/researchAgent';
import { formatNeedForWriter } from '../services/userNeed';
import {
  ASK_USER_DECLARATION,
  LOOK_UP_DOSSIER_DECLARATION,
  OFFER_RATING_DECLARATION,
  OFFER_RATING_DECLARATION_PRINCIPLES,
  PREPARE_CLUB_DECLARATION,
  PREPARE_CLUB_DECLARATION_PRINCIPLES,
  SHOW_DOSSIER_DECLARATION,
} from '../services/aiClient';
import { GAFFA_MANAGER_REASONING } from '../constants/gaffaRules';
import { REPLY_BLOCKS } from '../services/replyBlocks/registry';
import type { TurnRoute } from '../services/turnRouter';

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).stack ?? err}`);
  }
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The hashes of the prompts as they stood before the core was split into sections. */
const PINNED = {
  core: '9f753a3a76a7c8579b23904b54d301f885715335709d82cbf48f2c81b07aa648',
  synthesis: 'e4f46aaf4dbb161ca1dcb1f07a8512349ae7f90ac44cbad7d8f85e62a6028e31',
  chat: '123657caa5ed656fd33fee918362eccf4f3121a9e8760a6956e9f8c414e25491',
  chatWithEafc: '8fcdcb5aa15d4b954e14fa749bc80aa28826df9a5a7ffd86917866dbbc72985c',
};

await test('the scouting core is byte-identical to the single string it was', () => {
  assert.equal(sha(SCOUT_CORE_INSTRUCTION), PINNED.core);
});

await test('card synthesis reads the same system instruction as before', () => {
  assert.equal(sha(DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION), PINNED.synthesis);
});

await test("chat's system instruction is unchanged, with and without the EAFC directory", () => {
  assert.equal(sha(buildConversationalScoutInstruction(false)), PINNED.chat);
  assert.equal(sha(buildConversationalScoutInstruction(true)), PINNED.chatWithEafc);
});

await test('the sections compose the core in order, each starting with its heading', () => {
  assert.equal(SCOUT_CORE_INSTRUCTION, [CORE_HEADER, CORE_SECTION_I, CORE_SCOUTS_CODE, CORE_RATING_SCALE, CORE_ATTRIBUTES, CORE_SECTION_V].join(''));
  assert.match(CORE_SECTION_I, /^I\. IDENTITY/);
  assert.match(CORE_SCOUTS_CODE, /^II\. THE SCOUT'S CODE/);
  assert.match(CORE_RATING_SCALE, /^III\. OVERALL RATING SCALE/);
  assert.match(CORE_ATTRIBUTES, /^IV\. ATTRIBUTE FRAMEWORK/);
  assert.match(CORE_SECTION_V, /^V\. WRITER'S CODE/);
  assert.match(CORE_VERSIONS, /^- \*\*Versions, Not Legacies:\*\*/);
  assert.match(CORE_EAFC_INDEPENDENCE, /^- \*\*EAFC \/ FM Independence:\*\*/);
});

await test('the system instructions are byte-stable: the same on every call', () => {
  assert.equal(buildConversationalScoutInstruction(false), buildConversationalScoutInstruction(false));
  assert.ok(!SCOUT_CORE_INSTRUCTION.includes('${'), 'no unfilled interpolation');
});

// ---------------------------------------------------------------------------------------------
// With PRINCIPLES_PROMPT off: every path's instructions as they were, byte for byte

const SEASON = '2026-27';
const route = (analyticalMode: string, intent = 'tactical_chat'): TurnRoute =>
  ({
    intent,
    analyticalMode,
    targetPlayers: ['Player One', 'Player Two'],
    targetClubs: ['Southside'],
    searchQueries: [],
    reasoningComplexity: 'medium',
    isHistorical: false,
    wantsRegeneration: false,
    needsSearch: true,
  }) as TurnRoute;
const NOTES = ' The user sees the dossier card of Player One under your reply, so answer from it without reciting its attributes.';
const card = (name: string): PlayerProfile =>
  ({
    basicInfo: { name, age: 28, nationality: 'N/A', club: 'Club', position: 'Attacking Midfielder' },
    ratings: { overall: 90, potential: 90 },
    attributes: {},
    strengths: [],
    weaknesses: [],
    playstyleAndRole: { playstyle: { archetype: 'Archetype', description: 'Prose.' }, bestRoles: [] },
    shortBio: 'Bio.',
    latestUpdate: 'Update.',
    evaluationDate: '2026-10-25',
    createdAt: CALIBRATION_EPOCH_MS + 1000,
  }) as unknown as PlayerProfile;
const situation = {
  asOf: '2026-11-18',
  clubs: [],
  players: [{ name: 'Player One', club: 'Southside', role: 'left-back', form: 'starting', status: 'fit', changes: 'signed in August' }],
  unknowns: ['who starts in goal'],
} as any;
const brief: ResearchBrief = {
  understanding: 'How Southside build up',
  focus: 'A back four this season',
  timeframe: 'live',
  outline: ['The back four', 'The press'],
  calls: [],
  unresolved: ['who starts in goal'],
  need: null,
};
const need = { goal: 'Decide a lineup', settle: ['Who starts'], objection: 'The last reply named the wrong left-back', objectionFact: 'Who started at left-back?' };
const MODES = ['head_to_head', 'archive', 'player_qa', 'ranking_or_tierlist', 'tactical_or_system', 'squad_or_recruitment', 'debate_or_verdict', 'dossier'];
const extraRules = [initiativeRules(), viewRules()];

/** Every instruction builder's output with fixed inputs, as the writer reads it with the switch off. */
const legacyOutputs = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const mode of MODES) {
    out[`stage ${mode}`] = stageInstructions({ principles: false, route: route(mode), analyticalMode: mode, currentSeason: SEASON, debate: null, notes: NOTES, gaffa: false, extraRules });
    out[`deep ${mode}`] = deepInstructions({ principles: false, route: route(mode), analyticalMode: mode, currentSeason: SEASON, notes: NOTES, gaffa: false });
  }
  out['stage compare'] = stageInstructions({ principles: false, route: route('debate_or_verdict', 'compare'), analyticalMode: 'debate_or_verdict', currentSeason: SEASON, debate: null, notes: '', gaffa: true, extraRules: [] });
  out['deep gaffa'] = deepInstructions({ principles: false, route: route('squad_or_recruitment'), analyticalMode: 'squad_or_recruitment', currentSeason: SEASON, notes: '', gaffa: true });
  for (const kind of ['head_to_head', 'ranking', 'single', 'other'] as const) {
    out[`stage past ${kind}`] = stageInstructions({
      principles: false,
      route: route('debate_or_verdict'),
      analyticalMode: 'debate_or_verdict',
      currentSeason: SEASON,
      debate: readDebateBrief({ kind }, { message: 'm' }),
      notes: NOTES,
      gaffa: false,
      extraRules,
    });
  }
  out.challenge = challengeInstructions(false);
  out.deepModeRules = deepModeRules(DEFAULT_DEEP_BUDGET);
  out.lockedDossiers = buildLockedDossiersBlock([card('Player One')]);
  out.savedDossiers = buildSavedDossiersBlock([card('Player One')], false);
  out.savedArchive = buildSavedDossiersBlock([card('Player One')], true);
  out.situation = formatSituation(situation);
  out.researchBrief = formatBriefForWriter(brief);
  out.need = formatNeedForWriter(need);
  out.gaffaReasoning = GAFFA_MANAGER_REASONING;
  out.initiativeTools = JSON.stringify([ASK_USER_DECLARATION, PREPARE_CLUB_DECLARATION, OFFER_RATING_DECLARATION]);
  out.deepTools = JSON.stringify(DEEP_DECLARATIONS);
  return out;
};

/**
 * Their hashes, taken when the switch was added and checked against `main` before it: a full
 * `npm test` run captured every writer prompt (stage, deep and challenge) on `main` and on the
 * branch with the switch off, and the two were identical. A deliberate change to an old builder
 * updates its hash here; with the switch flipped, these go with the old builders.
 */
const LEGACY_PINS: Record<string, string> = {
  "stage head_to_head": 'cc41eaedf609c94f0a785c8242a98d275da0bdda508eed08546e8c00f1a476b5',
  "deep head_to_head": 'f26470877551af744a93df5edc98ed289f5119bec2c065685ba95d3ecdf2cbc0',
  "stage archive": '6f725a70705cf9edbf6e5df25c977021b8d2f1d1744fa64471c06b50d332c35c',
  "deep archive": 'd73b7880f0eacce29f9d1156716d30ddc02b8ec627a527770962ee7a6df6f5cd',
  "stage player_qa": '576fa6b8254cd4fb21503757e33dcb17ec13ba2490f6c74f549d858b7911e704',
  "deep player_qa": '32145f50eb5203c47b8feb8ff38e910a09e01fcdd1b8554802338bf300692852',
  "stage ranking_or_tierlist": 'ceb65d5961580b2074812bdc1eaa807049ebc77f6fb425b43696eee4e2065a8c',
  "deep ranking_or_tierlist": '2050814cbaa7b3ff347729572334da256122829bd59ce059a80e42f2a797ab13',
  "stage tactical_or_system": 'ae98336b3b00b6514d2838148c9610337d5c146543b4adc43b2de4d867d8774c',
  "deep tactical_or_system": 'dd828f986166b9b7677c46b63f15865923c7ee150a1d87662cf30fbb3558954f',
  "stage squad_or_recruitment": '9a17e31554d6d762122ef2e62849c6ece131124cdad1a16885e8eb1ff2dd6d73',
  "deep squad_or_recruitment": '0e55f3211a44ec7e1c44b87ee3c459510a4dd4d9c091f04685942d8270efda11',
  "stage debate_or_verdict": '33ba56cc824d3f74e571d3b05f677d167f32689820e274f13fcb8113940efed3',
  "deep debate_or_verdict": 'bfb7d737d756393656eb4bf1ac51291daa331588f85b6334d104c37b7f398371',
  "stage dossier": '01f3ec4f0ad592c7fde7ffd0a1df7cfcc7c3b217af00bf21afc714d536f57437',
  "deep dossier": 'b793cf5f4dd78ce357ee255f680832bb6c9ee53935d09ab1b5dd0e9fc0448ff0',
  "stage compare": '4486d9877f68466da3a8a4fc6111f290458804ebe03f1addea9f67d5f2da24b9',
  "deep gaffa": '02e3cbb3b085a37c522b1128596582d03e6843fe0864121fc726b69ebb47daac',
  "stage past head_to_head": 'a6d6afd823cd8b5ab7477dd3f43ea65a9bfb968b8fb9a84dc52be8b485bde74b',
  "stage past ranking": 'a6d6afd823cd8b5ab7477dd3f43ea65a9bfb968b8fb9a84dc52be8b485bde74b',
  "stage past single": 'a6d6afd823cd8b5ab7477dd3f43ea65a9bfb968b8fb9a84dc52be8b485bde74b',
  "stage past other": '89c071de1fdcec6cd7395db1ea77dbb2dc44e15e9e3a3133e864cd4abc3c0849',
  "challenge": '46453d235b9a38a3632ee2a4ff16dabf9383b78ab5b12fd01e3646bb780dcad5',
  "deepModeRules": '6f3e58fcd9156037a75dacc87335532e9c7cab03e8026bc5e03dc49870a7a3bb',
  "lockedDossiers": '3ffe99ef18557cdb462c8ba157a36603189bd3f41db0476f8a20db8cbe37992f',
  "savedDossiers": '97c351563c4a3e9f56e9f25df0be73f1876c69dab353401289bc837383d491ee',
  "savedArchive": '5a8a8e5a33893fd8c4ccd22894c0c1a2fd2d8e34abe71f7372c62445aabc2177',
  "situation": '0a16f39cc2cd5c6afd7922721b5611c26fc96110ccce354387303a6ff9547d22',
  "researchBrief": '9fe37f597ccf08c9aa75c2343f1cb17bec7bce29adfd51d9d3cfcb018987d56c',
  "need": 'bfcc163544f552921dc2f6bc26d47395d640d53326a93625400fe469ec06a718',
  "gaffaReasoning": '328d7195266c84a6668fe3c348e8d46a7259b4021de9f17ed849d45c466db63f',
  "initiativeTools": '1773e9ace68a304ee5d48177ea35393c9d5b7acd446ea92b81b98a6817820612',
  "deepTools": '59c3c2600cd96552a2c0a9e33503177f35f7118da0ac72c8378217a4a9fcf2ad',
};

await test('with the switch off, every path builds the instructions it always did', () => {
  const outputs = legacyOutputs();
  const changed = Object.entries(outputs).filter(([key, text]) => sha(text) !== LEGACY_PINS[key]);
  if (process.env.PRINT_PINS) console.log(JSON.stringify(Object.fromEntries(Object.entries(outputs).map(([k, t]) => [k, sha(t)])), null, 2));
  assert.deepEqual(changed.map(([key]) => key), []);
  assert.deepEqual(Object.keys(LEGACY_PINS).sort(), Object.keys(outputs).sort());
});

// ---------------------------------------------------------------------------------------------
// With PRINCIPLES_PROMPT on: one principle set, and turn data only

const principled = (eafc = false) => buildConversationalScoutInstruction(eafc, true);

await test('the principle set is byte-stable and differs from the old system instruction', () => {
  assert.equal(principled(), principled());
  assert.notEqual(principled(), buildConversationalScoutInstruction(false, false));
  assert.equal(buildConversationalScoutInstruction(false), buildConversationalScoutInstruction(false, false), 'the switch ships off');
  assert.ok(principled().startsWith(RATING_CODE));
  assert.ok(principled(true).includes('VII. FC PLAYSTYLES REFERENCE DIRECTORY'));
  assert.ok(!principled().includes('${'), 'no unfilled interpolation');
});

await test('each principle appears once, in order, and How cards work once', () => {
  const system = principled();
  let at = -1;
  for (const [i, name] of PRINCIPLE_NAMES.entries()) {
    const heading = `${i + 1}. **${name}:**`;
    assert.equal(system.split(heading).length - 1, 1, heading);
    assert.ok(system.indexOf(heading) > at, `${heading} in order`);
    at = system.indexOf(heading);
  }
  assert.equal(system.split('**How cards work:**').length - 1, 1);
});

/** The principle set's own words: the text with the core's word rules and How cards work taken out. */
const ownPrinciples = [CORE_BANNED_WORDS, CORE_STRAWMAN_BAN, CORE_POSITIVE_RELEVANCE, CORE_NICKNAMES, CORE_CANONICAL_POSITIONS, HOW_CARDS_WORK].reduce(
  (text, part) => text.replace(part, ''),
  CHAT_PRINCIPLES,
);

/** Everything the writer reads under the principle set besides the principles, by name. */
const principleParts = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(PRINCIPLE_SOURCES).map(([k, v]) => [`sources ${k}`, v])),
  gaffaSources: GAFFA_CLUB_SOURCES,
  ratingCode: RATING_CODE,
  deepResearchRules: deepResearchRules(DEFAULT_DEEP_BUDGET),
  challenge: challengeInstructions(true),
  lockedHeader: buildLockedDossiersBlock([card('Player One')], true).split('\n')[2],
  savedHeader: buildSavedDossiersBlock([card('Player One')], false, true).split('\n')[2],
  situation: formatSituation(situation, { principles: true }),
  researchBrief: formatBriefForWriter(brief, { principles: true }),
  need: formatNeedForWriter(need, { principles: true }),
  gaffaReasoning: GAFFA_MANAGER_REASONING.split('\n').slice(0, -1).join('\n'),
  ask: ASK_USER_DECLARATION.description,
  prepare: PREPARE_CLUB_DECLARATION_PRINCIPLES.description,
  offer: OFFER_RATING_DECLARATION_PRINCIPLES.description,
  lookUp: LOOK_UP_DOSSIER_DECLARATION.description,
  pastResearchNote: PAST_RESEARCH_NOTE,
  cardAnchorNote: CARD_ANCHOR_NOTE,
  commitVerdict: String(COMMIT_VERDICT_DECLARATION.description),
  showDossier: SHOW_DOSSIER_DECLARATION.description,
  ...Object.fromEntries(
    Object.values(REPLY_BLOCKS)
      .filter((e: any) => e.tool)
      .map((e: any) => [`tool ${e.tool.name}`, String(e.tool.description)]),
  ),
});

const words = (text: string): string[] => text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
/** The first run of `n` consecutive words two texts share, or null. */
const sharedRun = (a: string, b: string, n = 12): string | null => {
  const wa = words(a);
  const runs = new Set<string>();
  for (let i = 0; i + n <= wa.length; i++) runs.add(wa.slice(i, i + n).join(' '));
  const wb = words(b);
  for (let i = 0; i + n <= wb.length; i++) {
    const run = wb.slice(i, i + n).join(' ');
    if (runs.has(run)) return run;
  }
  return null;
};

await test('the duplication guard: nothing the writer reads restates the principles, or another part, in 12 words or more', () => {
  const parts = principleParts();
  const found: string[] = [];
  for (const [name, text] of Object.entries(parts)) {
    const withPrinciples = sharedRun(ownPrinciples, text);
    if (withPrinciples) found.push(`${name} restates the principles: "${withPrinciples}"`);
  }
  const names = Object.keys(parts);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const run = sharedRun(parts[names[i]], parts[names[j]]);
      if (run) found.push(`${names[i]} and ${names[j]} share: "${run}"`);
    }
  }
  assert.deepEqual(found, []);
});

await test('the principle set retires the old personas, templates and rating offers', () => {
  const read = [principled(), ...Object.values(principleParts())].join('\n');
  for (const retired of [
    'Chief Football Scout',
    'Senior Tactical Columnist',
    'Chief-Scout',
    'Sporting Director',
    'These dossiers are LAW',
    'rated fresh',
    'fresh rating',
    'concrete phases of play',
    'final-third creation',
    'rest-defense',
    'CRITICAL MANAGER FIDELITY',
    'THREAD CONTINUITY',
    'My analysis is strictly limited to football',
    'for the answer to lead with',
    'in your opening paragraph',
    'in your first paragraph',
  ]) {
    assert.ok(!read.includes(retired), retired);
  }
  // The tier bands live in Section III only.
  assert.ok(!ownPrinciples.includes('World-Class Elite'));
});

await test('the principle set is descriptive: no players, clubs or quoted sample phrases', () => {
  assert.doesNotMatch(ownPrinciples, /["“”]/);
  assert.doesNotMatch(ownPrinciples, /\b(Arsenal|Chelsea|Madrid|Barcelona|Liverpool|Messi|Saka|Zidane|Gaffa|\d{2} Overall)\b/);
  for (const line of Object.values(PRINCIPLE_SOURCES)) assert.doesNotMatch(line, /["“”]|\b(Arsenal|Messi|Gaffa)\b/);
});

await test('under the principle set, the turn instructions carry data only: no answer template, whatever the router said', () => {
  for (const mode of MODES) {
    const stage = stageInstructions({ principles: true, route: route(mode), analyticalMode: mode, currentSeason: SEASON, debate: null, notes: NOTES, gaffa: false, extraRules });
    const deep = deepInstructions({ principles: true, route: route(mode), analyticalMode: mode, currentSeason: SEASON, notes: NOTES, gaffa: false });
    if (mode === 'archive') assert.equal(stage, `<instructions>\n1. ${PRINCIPLE_SOURCES.archive}\n2. ${NOTES.trim()}\n</instructions>`);
    else assert.equal(stage, `<instructions>\n1. ${PRINCIPLE_SOURCES.present}\n2. ${NOTES.trim()}\n</instructions>`, mode);
    assert.equal(deep, `<instructions>\n1. ${PRINCIPLE_SOURCES.deep}\n2. ${NOTES.trim()}\n</instructions>`, mode);
  }
  const other = stageInstructions({ principles: true, route: route('debate_or_verdict'), analyticalMode: 'debate_or_verdict', currentSeason: SEASON, debate: readDebateBrief({ kind: 'other' }, { message: 'm' }), notes: '', gaffa: true, extraRules });
  assert.equal(other, `<instructions>\n1. ${PRINCIPLE_SOURCES.past} ${PRINCIPLE_SOURCES.pastOther}\n2. ${GAFFA_CLUB_SOURCES}\n</instructions>`);
  // The initiative and view rules live in the tools' descriptions, offered with the tools.
  for (const rule of [...Object.values(INITIATIVE_RULES), viewRules()]) assert.ok(!other.includes(rule));
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
