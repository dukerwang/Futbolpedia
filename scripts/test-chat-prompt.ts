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
import { buildConversationalScoutInstruction } from '../prompts/chatPrompt';

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

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
