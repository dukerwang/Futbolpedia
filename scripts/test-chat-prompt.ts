/**
 * The chat writer's prompts, offline. The scouting core is composed from section constants
 * (`prompts/scoutCore.ts`); these checks pin what card synthesis and chat read, byte for byte, so
 * splitting or moving a section never changes a prompt by accident. A deliberate prompt change
 * updates the hash here in the same commit, with the reason in the commit message.
 *
 * They also pin every chat path's turn instructions, block headers and tool declarations, built
 * with fixed inputs, so a change to what the writer reads is always a deliberate one.
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
import { buildConversationalScoutInstruction, viewRules } from '../prompts/chatPrompt';
import type { PlayerProfile } from '../types';
import { CALIBRATION_EPOCH_MS } from '../services/dossierCache';
import { buildLockedDossiersBlock, buildSavedDossiersBlock } from '../services/dossierContext';
import { challengeInstructions, initiativeRules, stageInstructions } from '../services/conversationalScout';
import { CHAT_DECLARATIONS, DEFAULT_RESEARCH_BUDGET, chatInstructions, researchRules } from '../services/chatTurn';
import { readDebateBrief } from '../services/debateBrief';
import { formatSituation } from '../services/situationSnapshot';
import { formatBriefForWriter, type ResearchBrief } from '../services/researchAgent';
import { formatNeedForWriter } from '../services/userNeed';
import { ASK_USER_DECLARATION, OFFER_RATING_DECLARATION, PREPARE_CLUB_DECLARATION } from '../services/aiClient';
import { GAFFA_MANAGER_REASONING } from '../constants/gaffaRules';
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
  core: '7f1e030e3dc2ada8e55ec302121b1cde7d588e3b3bd5ae9ed4d56348cab22846',
  synthesis: '23b7c84a0bf7d9fc26a1b22cd123daeb31e053a78c531e405d960f654c26a9f2',
  chat: 'b3d05e4be56d4138504de106dc53bff9f3dd435b05ac2d0fdb1f98656ed05ea1',
  chatWithEafc: '029ff9623763d0a89a569af404b6c3680d1d73a2962e9ca2736a80885af01d72',
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
// Every path's instructions, byte for byte

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

/** Every instruction builder's output with fixed inputs, as the writer reads it. */
const pathOutputs = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const mode of MODES) {
    out[`stage ${mode}`] = stageInstructions({ route: route(mode), analyticalMode: mode, currentSeason: SEASON, debate: null, notes: NOTES, extraRules });
    out[`chat ${mode}`] = chatInstructions({ route: route(mode), analyticalMode: mode, currentSeason: SEASON, notes: NOTES, gaffa: false });
  }
  out['stage compare'] = stageInstructions({ route: route('debate_or_verdict', 'compare'), analyticalMode: 'debate_or_verdict', currentSeason: SEASON, debate: null, notes: '', extraRules: [] });
  out['chat gaffa'] = chatInstructions({ route: route('squad_or_recruitment'), analyticalMode: 'squad_or_recruitment', currentSeason: SEASON, notes: '', gaffa: true });
  for (const kind of ['head_to_head', 'ranking', 'single', 'other'] as const) {
    out[`stage past ${kind}`] = stageInstructions({
      route: route('debate_or_verdict'),
      analyticalMode: 'debate_or_verdict',
      currentSeason: SEASON,
      debate: readDebateBrief({ kind }, { message: 'm' }),
      notes: NOTES,
      extraRules,
    });
  }
  out.challenge = challengeInstructions();
  out.researchRules = researchRules(DEFAULT_RESEARCH_BUDGET);
  out.lockedDossiers = buildLockedDossiersBlock([card('Player One')]);
  out.savedDossiers = buildSavedDossiersBlock([card('Player One')], false);
  out.savedArchive = buildSavedDossiersBlock([card('Player One')], true);
  out.situation = formatSituation(situation);
  out.researchBrief = formatBriefForWriter(brief);
  out.need = formatNeedForWriter(need);
  out.gaffaReasoning = GAFFA_MANAGER_REASONING;
  out.initiativeTools = JSON.stringify([ASK_USER_DECLARATION, PREPARE_CLUB_DECLARATION, OFFER_RATING_DECLARATION]);
  out.chatTools = JSON.stringify(CHAT_DECLARATIONS);
  return out;
};

/**
 * Their hashes. They were checked against `main` when the builders became pure functions: a full
 * `npm test` run captured every writer prompt (stage, chat loop and challenge) before and after, and
 * the two were identical. A deliberate change to a builder updates its hash here.
 */
const PINS: Record<string, string> = {
  "stage head_to_head": 'cc41eaedf609c94f0a785c8242a98d275da0bdda508eed08546e8c00f1a476b5',
  "chat head_to_head": 'f26470877551af744a93df5edc98ed289f5119bec2c065685ba95d3ecdf2cbc0',
  "stage archive": '6f725a70705cf9edbf6e5df25c977021b8d2f1d1744fa64471c06b50d332c35c',
  "chat archive": 'd73b7880f0eacce29f9d1156716d30ddc02b8ec627a527770962ee7a6df6f5cd',
  "stage player_qa": '576fa6b8254cd4fb21503757e33dcb17ec13ba2490f6c74f549d858b7911e704',
  "chat player_qa": '32145f50eb5203c47b8feb8ff38e910a09e01fcdd1b8554802338bf300692852',
  "stage ranking_or_tierlist": 'ceb65d5961580b2074812bdc1eaa807049ebc77f6fb425b43696eee4e2065a8c',
  "chat ranking_or_tierlist": '2050814cbaa7b3ff347729572334da256122829bd59ce059a80e42f2a797ab13',
  "stage tactical_or_system": 'ae98336b3b00b6514d2838148c9610337d5c146543b4adc43b2de4d867d8774c',
  "chat tactical_or_system": 'dd828f986166b9b7677c46b63f15865923c7ee150a1d87662cf30fbb3558954f',
  "stage squad_or_recruitment": '9a17e31554d6d762122ef2e62849c6ece131124cdad1a16885e8eb1ff2dd6d73',
  "chat squad_or_recruitment": '0e55f3211a44ec7e1c44b87ee3c459510a4dd4d9c091f04685942d8270efda11',
  "stage debate_or_verdict": '33ba56cc824d3f74e571d3b05f677d167f32689820e274f13fcb8113940efed3',
  "chat debate_or_verdict": 'bfb7d737d756393656eb4bf1ac51291daa331588f85b6334d104c37b7f398371',
  "stage dossier": '01f3ec4f0ad592c7fde7ffd0a1df7cfcc7c3b217af00bf21afc714d536f57437',
  "chat dossier": 'b793cf5f4dd78ce357ee255f680832bb6c9ee53935d09ab1b5dd0e9fc0448ff0',
  "stage compare": '4486d9877f68466da3a8a4fc6111f290458804ebe03f1addea9f67d5f2da24b9',
  "chat gaffa": '02e3cbb3b085a37c522b1128596582d03e6843fe0864121fc726b69ebb47daac',
  "stage past head_to_head": 'a6d6afd823cd8b5ab7477dd3f43ea65a9bfb968b8fb9a84dc52be8b485bde74b',
  "stage past ranking": 'a6d6afd823cd8b5ab7477dd3f43ea65a9bfb968b8fb9a84dc52be8b485bde74b',
  "stage past single": 'a6d6afd823cd8b5ab7477dd3f43ea65a9bfb968b8fb9a84dc52be8b485bde74b',
  "stage past other": '89c071de1fdcec6cd7395db1ea77dbb2dc44e15e9e3a3133e864cd4abc3c0849',
  "challenge": 'd3b2ca787c9f683300e84d96dc35684d871b9da2e7920a33f467ec71d5e44485',
  "researchRules": '082a993217144fc0f60f80b5217963e7c1f9d7802b767136e3404180caa1047f', // added the who_is line (2026-11-27-football-knowledge-base-design.md)
  "lockedDossiers": '3ffe99ef18557cdb462c8ba157a36603189bd3f41db0476f8a20db8cbe37992f',
  "savedDossiers": '97c351563c4a3e9f56e9f25df0be73f1876c69dab353401289bc837383d491ee',
  "savedArchive": '5a8a8e5a33893fd8c4ccd22894c0c1a2fd2d8e34abe71f7372c62445aabc2177',
  "situation": '0a16f39cc2cd5c6afd7922721b5611c26fc96110ccce354387303a6ff9547d22',
  "researchBrief": '9fe37f597ccf08c9aa75c2343f1cb17bec7bce29adfd51d9d3cfcb018987d56c',
  "need": 'bfcc163544f552921dc2f6bc26d47395d640d53326a93625400fe469ec06a718',
  "gaffaReasoning": '328d7195266c84a6668fe3c348e8d46a7259b4021de9f17ed849d45c466db63f',
  "initiativeTools": '1773e9ace68a304ee5d48177ea35393c9d5b7acd446ea92b81b98a6817820612',
  "chatTools": 'bbe3fde1dc56cd785f1f7bf1ad132c98fa533ded4f902b85d5941f7bdb53159f', // added the who_is declaration (2026-11-27-football-knowledge-base-design.md)
};

await test('every path builds the instructions it always did', () => {
  const outputs = pathOutputs();
  const changed = Object.entries(outputs).filter(([key, text]) => sha(text) !== PINS[key]);
  if (process.env.PRINT_PINS) console.log(JSON.stringify(Object.fromEntries(Object.entries(outputs).map(([k, t]) => [k, sha(t)])), null, 2));
  assert.deepEqual(changed.map(([key]) => key), []);
  assert.deepEqual(Object.keys(PINS).sort(), Object.keys(outputs).sort());
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
