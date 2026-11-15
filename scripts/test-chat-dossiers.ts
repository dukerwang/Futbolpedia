#!/usr/bin/env npx tsx
/**
 * Offline checks for chat reading dossiers: "how good is X" routes to chat rather than a rating,
 * "let me see @X" needs no model turn, card lookups find the right card without rating anyone,
 * and a reply's cards and Scout offers are never listed twice.
 *
 * Usage:
 *   npx tsx scripts/test-chat-dossiers.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';
import { formatIsoDate } from '../services/dossierStore';
import { classifyTurn } from '../services/turnRouter';
import { asksToSeeMentions } from '../services/chatIntent';
import { lookUpDossier } from '../services/dossierLookup';
import { editionGaps, offerPrimeScout, offerScout, showCard, type ReplyAttachments } from '../services/conversationalScout';
import { scoutOfferRequest } from '../services/ratingCommand';

const now = Date.now();
const today = formatIsoDate(now);

const card = (name: string, type: string, full = true, seasonOrEra?: string): PlayerProfile => {
  const evaluationDate = type === 'current' ? today : '2005-05-15';
  return {
    basicInfo: { name, club: 'Bayer Leverkusen', position: 'Attacking Midfielder', age: 23, nationality: 'Germany' },
    ratings: { overall: 85, potential: 90 },
    createdAt: now,
    evaluationDate,
    version: {
      id: `${name}-${type}-${evaluationDate}`,
      type,
      label: type,
      evaluationDate,
      seasonOrEra: seasonOrEra ?? (type === 'current' ? undefined : '2003-06'),
    },
    ...(full ? { attributes: { finishing: 80 }, shortBio: 'A card.' } : {}),
  } as unknown as PlayerProfile;
};

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

const route = (message: string) =>
  classifyTurn({ message, history: [], conversationDossiers: [], hasImage: false });

await test('"how good is <player>" is a question about him, not a rating', async () => {
  for (const message of ['how good is florian wirtz', 'How good is Wirtz?', 'is Wirtz any good?']) {
    const r = await route(message);
    assert.equal(r.intent, 'tactical_chat', message);
    assert.equal(r.analyticalMode, 'player_qa', message);
    assert.equal(r.targetPlayers.length, 1, message);
    assert.match(r.targetPlayers[0], /wirtz/i, message);
  }
});

await test('"how good was <player>" keeps the historical cue', async () => {
  const r = await route('how good was prime Ronaldinho');
  assert.equal(r.intent, 'tactical_chat');
  assert.equal(r.isHistorical, true);
  assert.match(r.targetPlayers[0], /ronaldinho/i);
});

await test('ratings still route as ratings', async () => {
  for (const message of ['rate florian wirtz', 'Rate prime Ronaldinho', 'Florian Wirtz']) {
    assert.equal((await route(message)).intent, 'single_dossier', message);
  }
});

await test('"let me see @X" only asks to see the cards', () => {
  for (const leftover of ['let me see', 'show me', 'pull up his card', 'and', "let's see their dossiers", 'open', '']) {
    assert.equal(asksToSeeMentions(leftover), true, leftover);
  }
  for (const leftover of ['how good is he', 'compare', 'is he better than', 'why is his passing 80?', 'show me his weaknesses']) {
    assert.equal(asksToSeeMentions(leftover), false, leftover);
  }
});

const wirtz = card('Florian Wirtz', 'current');
const wirtzPrime = card('Florian Wirtz', 'prime', true, '2023-26');
const shared = [card('Kylian Mbappé', 'current', false), card('Jamal Musiala', 'current'), card('Jamal Lewis', 'current')];

await test('a lookup finds your card in the edition the turn is about', async () => {
  const current = await lookUpDossier('wirtz', [wirtz, wirtzPrime], false, shared);
  assert.equal(current.status === 'found' && current.card, wirtz);
  const prime = await lookUpDossier('Florian Wirtz', [wirtz, wirtzPrime], true, shared);
  assert.equal(prime.status === 'found' && prime.card, wirtzPrime);
});

await test('a lookup falls back to the edition he has', async () => {
  const r = await lookUpDossier('Wirtz', [wirtzPrime], false, shared);
  assert.equal(r.status === 'found' && r.card, wirtzPrime);
});

await test('a lookup finds shared cards, and names several players when a name is ambiguous', async () => {
  const r = await lookUpDossier('Musiala', [], false, shared);
  assert.equal(r.status, 'found');
  const jamal = await lookUpDossier('Jamal', [], false, shared);
  assert.equal(jamal.status, 'ambiguous');
  assert.deepEqual(jamal.status === 'ambiguous' && [...jamal.names].sort(), ['Jamal Lewis', 'Jamal Musiala']);
});

await test('a lookup never rates: no card, or no published card behind an outline, is missing', async () => {
  assert.equal((await lookUpDossier('Pedri', [wirtz], false, shared)).status, 'missing');
  // No Supabase offline, so the outline's full card can't be served.
  assert.equal((await lookUpDossier('Mbappe', [], false, shared)).status, 'missing');
});

await test('a reply offers each player once, and never one whose card it shows', () => {
  const attachments: ReplyAttachments = { cards: [], scoutOffers: [] };
  offerScout(attachments, 'Pedri');
  offerScout(attachments, 'pedri');
  offerScout(attachments, 'Florian Wirtz');
  showCard(attachments, wirtz);
  showCard(attachments, wirtz);
  offerScout(attachments, 'Wirtz');
  assert.deepEqual(attachments.scoutOffers, ['Pedri', 'Wirtz']);
  assert.equal(attachments.cards.length, 1);
});

await test('a prime debate notes a player whose only card is his current form, unless only his current form was asked for', () => {
  const current = card('Rodri', 'current');
  const prime = card('Fernando Redondo', 'prime');
  assert.deepEqual(editionGaps([current, prime], true, 'who is better, prime rodri or prime redondo'), [{ name: 'Rodri', label: 'current' }]);
  // Naming both versions is still a question about his prime.
  assert.equal(editionGaps([current], true, 'only current rodri is rated, is prime rodri the same as current?').length, 1);
  assert.deepEqual(editionGaps([current, prime], true, 'prime Redondo or current Rodri?'), []);
  assert.deepEqual(editionGaps([current], false, 'how good is rodri'), []);
  // A message that names his prime counts however the turn was routed, unless his prime has a card.
  assert.equal(editionGaps([current], false, 'if current rodri is prime rodri, why no prime card?').length, 1);
  assert.deepEqual(editionGaps([current], false, 'if current rodri is prime rodri, why no prime card?', [current, card('Rodri', 'prime')]), []);
});

await test('a missing prime is offered beside the current card, and a prime offer queues a prime rating', () => {
  const attachments: ReplyAttachments = { cards: [], scoutOffers: [] };
  const current = card('Rodri', 'current');
  showCard(attachments, current);
  offerPrimeScout(attachments, 'Rodri');
  offerPrimeScout(attachments, 'Rodri');
  showCard(attachments, card('Pedri', 'current'));
  assert.deepEqual(attachments.scoutOffers, ['prime Rodri']);
  // His prime card shown later takes the offer's place.
  showCard(attachments, card('Rodri', 'prime'));
  assert.deepEqual(attachments.scoutOffers, []);
  assert.deepEqual(scoutOfferRequest('prime Rodri'), { name: 'Rodri', edition: 'prime' });
  assert.deepEqual(scoutOfferRequest('Florian Wirtz'), { name: 'Florian Wirtz', edition: 'auto' });
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
