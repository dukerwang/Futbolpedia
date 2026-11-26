#!/usr/bin/env npx tsx
/**
 * Offline checks for the share routes (services/shareServer.ts), answered by a real Express app on
 * a local port with the shared store faked: a card page's status and tags, other spellings and
 * non-canonical addresses redirecting, missing cards kept out of search, a store outage serving
 * the default page, shared chats, and preview images with their cache headers and versions.
 *
 * Usage:
 *   npx tsx scripts/test-share-server.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Conversation, PlayerProfile } from '../types';
import { getCardKey, toVersionedSlug } from '../services/dossierCards';
import { cardImagePath } from '../services/shareMeta';
import { registerShareRoutes } from '../services/shareServer';
import type { ShareReads } from '../services/sharePages';

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => Promise<void>) {
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

const NOW = Date.parse('2026-11-14T12:00:00Z');
const saka = {
  basicInfo: { name: 'Bukayo Saka', club: 'Arsenal', position: 'Right Winger', age: 25, nationality: 'England' },
  ratings: { overall: 90, potential: 93 },
  version: { id: 'v', type: 'current', label: '', evaluationDate: '2026-11-04', seasonOrEra: '2026-27' },
  playstyleAndRole: { playstyle: { archetype: 'Inverted Playmaking Inside Forward', description: '' }, bestRoles: [] },
  strengths: ['**Elite Delivery:** x'],
  shareLine: 'Decides games from the right.',
} as unknown as PlayerProfile;

const chat = {
  id: 'x',
  title: 'Saka this season',
  createdAt: NOW,
  activeProfile: null,
  allProfiles: [saka],
  messages: [
    { id: '1', sender: 'user', content: 'How good is Saka right now?', timestamp: 1 },
    { id: '2', sender: 'ai', content: 'Very.', timestamp: 2, dossierKey: getCardKey(saka) },
  ],
} as unknown as Conversation;

let storeDown = false;
const rows: Record<string, PlayerProfile> = { 'bukayo-saka': saka, [toVersionedSlug(saka)!]: saka };
const reads: ShareReads = {
  readSlug: async (slug) => {
    if (storeDown) throw new Error('store down');
    return rows[slug] ?? null;
  },
  eraCard: async () => null,
  seasonCard: async () => null,
  playerCards: async (player) => (player === 'bukayo-saka' ? [saka] : []),
  cardIndex: async () => [saka],
  sharedConversation: async (code) => {
    if (storeDown) throw new Error('store down');
    return code === 'AB12CD' ? chat : null;
  },
};

async function main() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = express();
  registerShareRoutes(app, { html: async () => html, reads, cacheDir: null, now: () => NOW });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string) => fetch(`${base}${path}`, { redirect: 'manual' });

  await test('a card page answers 200 with its own tags', async () => {
    const res = await get('/p/bukayo-saka');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<title>Bukayo Saka · 90 · Current Form<\/title>/);
    assert.match(body, /og:image" content="http:\/\/127\.0\.0\.1:\d+\/og\/p\/bukayo-saka--current--2026-11-04-[0-9a-f]{8}\.png"/);
    assert.match(body, /<link rel="canonical" href="https:\/\/futbolpedia.org\/p\/bukayo-saka">/);
    assert.equal((body.match(/<title>/g) ?? []).length, 1);
    assert.match(body, /<script type="module" src="\/index.tsx">/);
  });

  await test('other spellings and non-canonical addresses redirect permanently', async () => {
    const alias = await get('/p/saka');
    assert.equal(alias.status, 301);
    assert.equal(alias.headers.get('location'), '/p/bukayo-saka');
    const upper = await get('/p/Bukayo-Saka/');
    assert.equal(upper.status, 301);
    assert.equal(upper.headers.get('location'), '/p/bukayo-saka');
  });

  await test('a missing card answers 404 and is kept out of search', async () => {
    const res = await get('/p/nobody-at-all');
    assert.equal(res.status, 404);
    assert.match(await res.text(), /<meta name="robots" content="noindex">/);
    const junk = await get('/p/saka/not-a-thing');
    assert.equal(junk.status, 404);
  });

  await test('a shared chat answers with its question as the description', async () => {
    const res = await get('/c/AB12CD');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<title>Saka this season<\/title>/);
    assert.match(body, /content="How good is Saka right now\?"/);
    assert.equal((await get('/c/ab12cd')).status, 301);
    assert.equal((await get('/c/ZZZZZZ')).status, 404);
  });

  await test('a card image is a PNG kept for good; a stale version redirects to the current one', async () => {
    const path = cardImagePath(saka)!;
    const res = await get(path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(Buffer.from(await res.arrayBuffer()).readUInt32BE(16), 1200);
    const stale = await get(path.replace(/-[0-9a-f]{8}\.png$/, '-00000000.png'));
    assert.equal(stale.status, 302);
    assert.equal(stale.headers.get('location'), path);
    const missing = await get('/og/p/nobody--current--2026-01-01-00000000.png');
    assert.equal(missing.status, 302);
    assert.equal(missing.headers.get('location'), '/og/default.png');
    assert.equal((await get('/og/default.png')).status, 200);
  });

  await test('when the store is down, pages get the default tags rather than a 404', async () => {
    storeDown = true;
    const res = await get('/p/kaka');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /og:url" content="https:\/\/futbolpedia.org\/"/);
    const chatRes = await get('/c/QQQQQQ');
    assert.equal(chatRes.status, 200);
    storeDown = false;
  });

  server.close();
  console.log(`${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
