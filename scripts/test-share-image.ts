#!/usr/bin/env npx tsx
/**
 * Offline checks for link preview images (services/shareImage.ts): a card, a card with nothing
 * optional, a very long name, a chat with and without cards, and the default image all render as
 * 1200×630 PNGs with the bundled fonts; strength chips fit on one row.
 *
 * Usage:
 *   npx tsx scripts/test-share-image.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';
import { clip, renderCardImage, renderChatImage, renderDefaultImage, strengthChips } from '../services/shareImage';

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}`);
    console.error(err);
  }
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: Buffer): [number, number] {
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', 'not a PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const card = (overrides: Record<string, unknown> = {}): PlayerProfile =>
  ({
    basicInfo: { name: 'Kaká', club: 'AC Milan', position: 'Attacking Midfielder', age: 25, nationality: 'Brazil' },
    ratings: { overall: 93, potential: 93 },
    version: { id: 'v', type: 'prime', label: '', evaluationDate: '2007-06-30', seasonOrEra: '2005-08' },
    playstyleAndRole: { playstyle: { archetype: 'Vertical Gliding Playmaker', description: '' }, bestRoles: [] },
    strengths: ['**Ball-Carrying Acceleration:** x', '**Final Pass:** y', '**Big-Game Output:** z'],
    shareLine: 'Turned a counter into a goal faster than anyone of that era.',
    ...overrides,
  }) as unknown as PlayerProfile;

async function main() {
  await test('a card renders as a 1200×630 PNG', async () => {
    const started = Date.now();
    const png = await renderCardImage(card());
    assert.deepEqual(pngSize(png), [1200, 630]);
    console.log(`  first render ${Date.now() - started} ms`);
  });

  await test('a card with no share line, strengths or archetype still renders', async () => {
    const png = await renderCardImage(card({ shareLine: undefined, strengths: [], playstyleAndRole: undefined }));
    assert.deepEqual(pngSize(png), [1200, 630]);
  });

  await test('a very long name renders', async () => {
    const png = await renderCardImage(card({ basicInfo: { name: 'Edson Arantes do Nascimento Wolfeschlegelsteinhausen', club: 'Santos', position: 'Forward' } }));
    assert.deepEqual(pngSize(png), [1200, 630]);
  });

  await test('a chat renders with its cards, and without any', async () => {
    const withCards = await renderChatImage({ title: 'Kaká vs Ronaldinho', question: 'Who was better at their peak?', replies: 4, cards: [card(), card()] });
    assert.deepEqual(pngSize(withCards), [1200, 630]);
    const without = await renderChatImage({ title: 'Arsenal this season', question: '', replies: 1, cards: [] });
    assert.deepEqual(pngSize(without), [1200, 630]);
  });

  await test('the default image renders', async () => {
    assert.deepEqual(pngSize(await renderDefaultImage()), [1200, 630]);
  });

  await test('strength chips: three short titles, two long ones, cut only when one title is too long', () => {
    assert.deepEqual(strengthChips(card()), ['Ball-Carrying Acceleration', 'Final Pass', 'Big-Game Output']);
    const long = card({
      strengths: [
        '**Elite Delivery & Dead-Ball Mastery:** x',
        '**High-Leverage Decision-Making:** y',
        '**Contact Absorption & Low Center of Gravity:** z',
      ],
    });
    assert.deepEqual(strengthChips(long), ['Elite Delivery & Dead-Ball Mastery', 'High-Leverage Decision-Making']);
    const huge = card({ strengths: [`**${'Very Long Title '.repeat(4).trim()}:** x`, `**${'Another Long Heading '.repeat(3).trim()}:** y`] });
    for (const chip of strengthChips(huge)) assert.ok(chip.length <= 40 && chip.endsWith('…'), chip);
  });

  await test('clip cuts at a word and leaves short text alone', () => {
    assert.equal(clip('Short text', 40), 'Short text');
    assert.equal(clip('One two three four five six', 15), 'One two three…');
  });

  console.log(`${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
