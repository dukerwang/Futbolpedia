#!/usr/bin/env npx tsx
/**
 * Offline checks for the Futbolpedia 3 cleanup: legacy local dossiers are recognised (old shapes,
 * pre-recalibration ratings, cards the shared store never held), positions read as the dossier
 * writes them, and chat titles are written once from the opening exchange and never over a rename.
 *
 * Usage:
 *   npx tsx scripts/test-library-cleanup.ts
 */
import assert from 'node:assert/strict';
import type { ChatMessage, Conversation, PlayerProfile } from '../types';
import { CALIBRATION_EPOCH_MS, getCardKey } from '../services/dossierStore';
import { isLegacyShape, isOrphanCard, orphanKeys, withoutCards } from '../services/legacyDossiers';
import { positionCodes } from '../constants/ratingTiers';
import { autoTitle, cleanTitle, hasAutoTitle, titleBrief } from '../services/chatTitle';

const card = (name: string, type: string, extra: Partial<PlayerProfile> = {}): PlayerProfile =>
  ({
    basicInfo: { name, club: 'Chelsea', position: 'Centre-Back', age: 30, nationality: 'England' },
    ratings: { overall: 90, potential: 90 },
    createdAt: CALIBRATION_EPOCH_MS + 1000,
    evaluationDate: '2026-10-20',
    version: { id: `${name}-${type}`, type, label: type, evaluationDate: '2026-10-20', seasonOrEra: '2005-07' },
    confidence: { grade: 'A', sampleSize: '', dataGaps: [], verdict: '' },
    peerBenchmark: 'Peers',
    ...extra,
  }) as unknown as PlayerProfile;

let passes = 0;
let failures = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).stack ?? err}`);
  }
}

test('a card from the current pipeline is not legacy', () => {
  assert.equal(isLegacyShape(card('John Terry', 'prime')), false);
});

test('cards without an edition, evidence grade or benchmark, or rated before the recalibration, are legacy', () => {
  assert.equal(isLegacyShape(card('A', 'current', { version: undefined })), true);
  assert.equal(isLegacyShape(card('A', 'current', { confidence: undefined })), true);
  assert.equal(isLegacyShape(card('A', 'current', { peerBenchmark: undefined })), true);
  assert.equal(isLegacyShape(card('A', 'current', { createdAt: CALIBRATION_EPOCH_MS - 1 })), true);
  assert.equal(isLegacyShape(card('A', 'current', { createdAt: undefined })), true);
});

test('a current card of a player the shared store only holds as a prime is an orphan', () => {
  const shared = new Set(['john-terry:prime', 'lionel-messi:prime']);
  assert.equal(isOrphanCard(card('John Terry', 'current'), shared), true);
  assert.equal(isOrphanCard(card('John Terry', 'prime'), shared), false);
  // An edition word in a legacy card's name doesn't hide a match.
  assert.equal(isOrphanCard(card('Prime John Terry', 'prime'), shared), false);
  assert.equal(isOrphanCard(card('Willian Pacho', 'current'), shared), true);
});

test('orphan keys name only the orphans, and conversations drop just those cards', () => {
  const terry = card('John Terry', 'current');
  const prime = card('John Terry', 'prime');
  const keys = orphanKeys([terry, prime], new Set(['john-terry:prime']));
  assert.deepEqual([...keys], [getCardKey(terry)]);
  const conv = { id: 'c', title: 't', messages: [], createdAt: 0, activeProfile: terry, allProfiles: [terry, prime] } as Conversation;
  const kept = withoutCards(conv, (p) => keys.has(getCardKey(p)));
  assert.equal(kept.activeProfile, null);
  assert.deepEqual(kept.allProfiles, [prime]);
  // Nothing to drop returns the same conversation.
  assert.equal(withoutCards(kept, () => false), kept);
});

test('positions read as short codes, as on the dossier', () => {
  assert.equal(positionCodes('Centre-Back'), 'CB');
  assert.equal(positionCodes('Second Striker/Centre Forward'), 'SS/CF');
  assert.equal(positionCodes('Centre Forward/Right Winger'), 'CF/RW');
  assert.equal(positionCodes('Libero/Centre-Back'), 'LIB/CB');
  assert.equal(positionCodes('Sweeper'), 'Sweeper');
  assert.equal(positionCodes(''), '');
});

const msg = (sender: 'user' | 'ai', content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `${sender}-${content}`, sender, content, timestamp: 0, ...extra }) as ChatMessage;

test('a title is written from the first question and its reply, never from a failed reply', () => {
  assert.equal(titleBrief([msg('user', 'rate prime john terry')]), null);
  assert.equal(titleBrief([msg('user', 'q'), msg('ai', 'Failed', { isError: true })]), null);
  const brief = titleBrief([
    msg('user', 'rate prime john terry'),
    msg('ai', 'Dossier generated', { dossier: { cardKey: 'k', name: 'John Terry', versionLabel: 'Prime 2004–07' } }),
  ]);
  assert.match(brief ?? '', /User: rate prime john terry/);
  assert.match(brief ?? '', /dossier card for John Terry, Prime 2004–07/);
});

test('only stand-in titles are replaced; renamed, generated and shared titles stay', () => {
  const messages = [msg('user', 'how does chelsea recover from a bad start to the season')];
  const base = { id: 'c', messages, createdAt: 0, activeProfile: null, allProfiles: [] };
  assert.equal(hasAutoTitle({ ...base, title: 'New Briefing' }), true);
  assert.equal(hasAutoTitle({ ...base, title: autoTitle(messages[0].content as string) }), true);
  assert.equal(hasAutoTitle({ ...base, title: 'how does chelsea recover from...' }), true);
  assert.equal(hasAutoTitle({ ...base, title: 'My Chelsea notes' }), false);
  assert.equal(hasAutoTitle({ ...base, title: 'New Briefing', titleSource: 'user' }), false);
  assert.equal(hasAutoTitle({ ...base, title: 'Chelsea recovery plan', titleSource: 'generated' }), false);
});

test('model titles are trimmed to one short line', () => {
  assert.equal(cleanTitle('"Prime John Terry."\n'), 'Prime John Terry');
  assert.equal(cleanTitle('   '), null);
  const long = cleanTitle('A very long title about the north-west London derby and every tactical wrinkle in it');
  assert.ok(long && long.length <= 49 && long.endsWith('…'));
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
