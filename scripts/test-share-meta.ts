#!/usr/bin/env npx tsx
/**
 * Offline checks for share page tags (services/shareMeta.ts): a card's and a chat's tags, escaping
 * of names and questions people typed, the image addresses and versions, and replacing the default
 * block in index.html.
 *
 * Usage:
 *   npx tsx scripts/test-share-meta.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Conversation, PlayerProfile } from '../types';
import {
  cardImagePath,
  cardImageVersion,
  cardMeta,
  chatMeta,
  injectMeta,
  notFoundMeta,
  parseImageFile,
} from '../services/shareMeta';
import type { CardPage, ChatPage } from '../services/sharePages';

let passes = 0;
let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}`);
    console.error(err);
  }
}

const saka = {
  basicInfo: { name: 'Bukayo Saka', club: 'Arsenal', position: 'Right Winger', age: 25, nationality: 'England' },
  ratings: { overall: 90, potential: 93 },
  version: { id: 'v', type: 'current', label: '', evaluationDate: '2026-11-04', seasonOrEra: '2026-27' },
  playstyleAndRole: { playstyle: { archetype: 'Inverted Playmaking Inside Forward', description: '' }, bestRoles: [] },
  strengths: ['**Elite Delivery:** x'],
  shareLine: 'Decides games from the right with delivery and timing.',
} as unknown as PlayerProfile;

const cardPage = (card: PlayerProfile): Extract<CardPage, { kind: 'card' }> => ({
  kind: 'card',
  card,
  canonical: '/p/bukayo-saka',
  history: [],
  versions: [],
});

test("a card's tags name the player, rating and edition and point at its image", () => {
  const tags = cardMeta(cardPage(saka), 'https://futbolpedia.ai.studio');
  assert.match(tags, /<title>Bukayo Saka · 90 · Current Form<\/title>/);
  assert.match(tags, /<meta name="description" content="Decides games from the right with delivery and timing.">/);
  assert.match(tags, /<link rel="canonical" href="https:\/\/futbolpedia.org\/p\/bukayo-saka">/);
  assert.match(tags, /og:image" content="https:\/\/futbolpedia.ai.studio\/og\/p\/bukayo-saka--current--2026-11-04-[0-9a-f]{8}\.png"/);
  assert.match(tags, /twitter:card" content="summary_large_image"/);
  assert.doesNotMatch(tags, /robots/);
});

test('a card without a share line is described by its archetype, role and tier', () => {
  const { shareLine: _drop, ...rest } = saka;
  const tags = cardMeta(cardPage(rest as PlayerProfile), 'https://futbolpedia.org');
  assert.match(tags, /content="Inverted Playmaking Inside Forward · Right Winger, Arsenal · World-Class. Rated on Futbolpedia."/);
});

test('names and questions with markup are escaped', () => {
  const evil = { ...saka, basicInfo: { ...saka.basicInfo, name: `<script>alert("x")</script>` }, shareLine: `It's "fine" & <b>bold</b>` };
  const tags = cardMeta(cardPage(evil as PlayerProfile), 'https://futbolpedia.org');
  assert.doesNotMatch(tags, /<script>|<b>/);
  assert.match(tags, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(tags, /It&#39;s &quot;fine&quot; &amp; &lt;b&gt;bold&lt;\/b&gt;/);

  const chat: ChatPage = {
    kind: 'chat',
    code: 'AB12CD',
    conversation: {} as Conversation,
    title: 'Henry <vs> Shearer',
    question: 'Who was "better"?',
    replies: 3,
    cards: [],
  };
  const ct = chatMeta(chat, 'https://futbolpedia.org');
  assert.match(ct, /<title>Henry &lt;vs&gt; Shearer<\/title>/);
  assert.match(ct, /content="Who was &quot;better&quot;\?"/);
  assert.match(ct, /href="https:\/\/futbolpedia.org\/c\/AB12CD"/);
  assert.match(ct, /og\/c\/AB12CD-[0-9a-f]{8}\.png/);
});

test("a re-rate that keeps the evaluation date changes the image's version", () => {
  const rerated = { ...saka, rerateAt: 123, ratings: { overall: 91, potential: 93 } } as PlayerProfile;
  assert.notEqual(cardImageVersion(saka), cardImageVersion(rerated));
  assert.equal(cardImageVersion(saka), cardImageVersion({ ...saka } as PlayerProfile));
  const file = cardImagePath(saka)!.split('/').pop()!;
  assert.deepEqual(parseImageFile(file), { key: 'bukayo-saka--current--2026-11-04', version: cardImageVersion(saka) });
  assert.equal(parseImageFile('nope.png'), null);
});

test('a missing card is kept out of search results', () => {
  const tags = notFoundMeta('/p/nobody-at-all', 'https://futbolpedia.org', 'nobody-at-all');
  assert.match(tags, /<meta name="robots" content="noindex">/);
  assert.match(tags, /Nobody At All · Not rated yet/);
});

test('the default block in index.html is replaced, and HTML without markers is left alone', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const out = injectMeta(html, '<title>Replaced</title>');
  assert.match(out, /<title>Replaced<\/title>/);
  assert.equal((out.match(/<title>/g) ?? []).length, 1);
  assert.doesNotMatch(out, /og:url" content="https:\/\/futbolpedia.org\/"/);
  assert.match(out, /<!-- share-meta:end -->/);
  assert.equal(injectMeta('<html><title>x</title></html>', '<title>y</title>'), '<html><title>x</title></html>');
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
