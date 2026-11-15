#!/usr/bin/env npx tsx
/**
 * Offline checks for share pages (services/sharePages.ts): what each address resolves to, with the
 * shared store faked in memory. Covers the default-card rule, other spellings of a name, re-rated
 * primes, an active player's prime, missing cards, shared chats and a store that can't be read.
 *
 * Usage:
 *   npx tsx scripts/test-share-pages.ts
 */
import assert from 'node:assert/strict';
import type { Conversation, PlayerProfile } from '../types';
import { parsePath, type CardAddress } from '../services/cardPaths';
import { getCardKey, toVersionedSlug, toDossierCardSlug, isPrimeCard } from '../services/dossierCards';
import { resolveCardPage, resolveChatPage, SharePageCache, type ShareReads } from '../services/sharePages';

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

const NOW = Date.parse('2026-11-14T12:00:00Z');

const card = (
  name: string,
  type: 'current' | 'prime' | 'era' | 'season_snapshot',
  evaluationDate: string,
  overall: number,
  extra: Partial<PlayerProfile> & { seasonOrEra?: string } = {},
): PlayerProfile => {
  const { seasonOrEra, ...rest } = extra;
  return {
    basicInfo: { name, club: 'Club', position: 'Right Winger', age: 25, nationality: 'X' },
    ratings: { overall, potential: overall },
    version: { id: 'v', type, label: '', evaluationDate, seasonOrEra: seasonOrEra ?? '2026-27' },
    ...rest,
  } as unknown as PlayerProfile;
};

/** An in-memory shared store: pointer rows, archive rows and shared chats. */
function store(cards: PlayerProfile[], chats: Record<string, Conversation> = {}) {
  const rows = new Map<string, PlayerProfile>();
  for (const c of cards) {
    const slug = toVersionedSlug(c);
    if (slug) rows.set(slug, c);
  }
  const pointers = new Map<string, PlayerProfile>();
  const setPointer = (c: PlayerProfile) => pointers.set(toDossierCardSlug(c.basicInfo.name, isPrimeCard(c) && c.version?.type === 'prime'), c);
  let fail = false;
  const reads: ShareReads = {
    readSlug: async (slug) => {
      if (fail) throw new Error('store down');
      return pointers.get(slug) ?? rows.get(slug) ?? null;
    },
    eraCard: async (player, window) =>
      cards.find((c) => c.version?.type === 'era' && c.basicInfo.name.toLowerCase().replace(/\s+/g, '-') === player && c.version.seasonOrEra.replace(/^(\d{4})-\d{2}(\d{2})$/, '$1-$2') === window) ?? null,
    seasonCard: async (player, season) =>
      cards.find((c) => c.version?.type === 'season_snapshot' && c.basicInfo.name.toLowerCase().replace(/\s+/g, '-') === player && c.version.seasonOrEra === season) ?? null,
    playerCards: async (player) => cards.filter((c) => c.basicInfo.name.toLowerCase().replace(/\s+/g, '-') === player),
    cardIndex: async () => [...pointers.values()],
    sharedConversation: async (code) => {
      if (fail) throw new Error('store down');
      return chats[code] ?? null;
    },
  };
  return { reads, setPointer, breakIt: () => (fail = true) };
}

const resolve = (path: string, reads: ShareReads) => {
  const parsed = parsePath(path);
  assert.ok(parsed && parsed.kind === 'card', path);
  return resolveCardPage(parsed.address as CardAddress, reads, NOW);
};

async function main() {
  const sakaNow = card('Bukayo Saka', 'current', '2026-11-04', 90, { shareLine: 'Sets the tone.' });
  const sakaOct = card('Bukayo Saka', 'current', '2026-10-04', 89);
  const sakaSep = card('Bukayo Saka', 'current', '2026-09-04', 89);
  const sakaPrime = card('Bukayo Saka', 'prime', '2026-06-30', 91, { seasonOrEra: '2024-27' });

  await test('a fresh current card is the default, with its earlier ratings newest first', async () => {
    const s = store([sakaNow, sakaOct, sakaSep]);
    s.setPointer(sakaNow);
    const page = await resolve('/p/bukayo-saka', s.reads);
    assert.equal(page.kind, 'card');
    if (page.kind !== 'card') return;
    assert.equal(getCardKey(page.card), getCardKey(sakaNow));
    assert.equal(page.canonical, '/p/bukayo-saka');
    assert.deepEqual(page.history.map((h) => h.path), ['/p/bukayo-saka/2026-10-04', '/p/bukayo-saka/2026-09-04']);
    assert.equal(page.banner, undefined);
  });

  await test("an active player's prime says it was rated while they're still playing", async () => {
    const s = store([sakaNow, sakaPrime]);
    s.setPointer(sakaNow);
    s.setPointer(sakaPrime);
    const page = await resolve('/p/bukayo-saka/prime', s.reads);
    assert.ok(page.kind === 'card');
    assert.equal(page.canonical, '/p/bukayo-saka/prime');
    assert.deepEqual(page.banner, { kind: 'active_prime', currentPath: '/p/bukayo-saka', ratedOn: '2026-06-30' });
    assert.deepEqual(page.versions.map((v) => [v.edition, v.path, v.current]), [
      ['current', '/p/bukayo-saka', false],
      ['prime', '/p/bukayo-saka/prime', true],
    ]);
  });

  await test("a retired player's stale current card gives way to the prime", async () => {
    const old = card('Kaká', 'current', '2017-05-01', 80);
    const prime = card('Kaká', 'prime', '2007-06-30', 93, { seasonOrEra: '2005-08' });
    const s = store([old, prime]);
    s.setPointer(old);
    s.setPointer(prime);
    const page = await resolve('/p/kaka', s.reads);
    assert.ok(page.kind === 'card');
    assert.equal(getCardKey(page.card), getCardKey(prime));
    assert.equal(page.canonical, '/p/kaka/prime');
    assert.equal(page.banner, undefined);
  });

  await test('a re-rated prime: /prime shows the new one, the old date shows the old one with a banner', async () => {
    const oldPrime = card('Kaká', 'prime', '2007-06-30', 92, { seasonOrEra: '2005-08' });
    const newPrime = card('Kaká', 'prime', '2008-06-30', 93, { seasonOrEra: '2006-09', rerateAt: NOW - 1000 });
    const s = store([oldPrime, newPrime]);
    s.setPointer(newPrime);
    const latest = await resolve('/p/kaka/prime', s.reads);
    assert.ok(latest.kind === 'card');
    assert.equal(latest.card.ratings.overall, 93);
    const pinned = await resolve('/p/kaka/2007-06-30', s.reads);
    assert.ok(pinned.kind === 'card');
    assert.equal(pinned.card.ratings.overall, 92);
    assert.deepEqual(pinned.banner, { kind: 'superseded_prime', to: '/p/kaka/prime' });
    assert.equal(pinned.canonical, '/p/kaka/2007-06-30');
  });

  await test('era and season addresses open their cards', async () => {
    const era = card('Neymar Jr', 'era', '2020-06-30', 91, { seasonOrEra: '2017-2020' });
    const season = card('Neymar Jr', 'season_snapshot', '2015-06-30', 92, { seasonOrEra: '2014-15' });
    const s = store([era, season]);
    const e = await resolve('/p/neymar-jr/era/2017-20', s.reads);
    assert.ok(e.kind === 'card');
    assert.equal(e.canonical, '/p/neymar-jr/era/2017-20');
    assert.deepEqual(e.history, []);
    const se = await resolve('/p/neymar-jr/season/2014-15', s.reads);
    assert.ok(se.kind === 'card');
    assert.equal(se.canonical, '/p/neymar-jr/season/2014-15');
  });

  await test('another spelling of a name redirects to the card; an ambiguous one is not found', async () => {
    const s = store([sakaNow]);
    s.setPointer(sakaNow);
    assert.deepEqual(await resolve('/p/saka', s.reads), { kind: 'redirect', to: '/p/bukayo-saka' });
    const silva1 = card('Bernardo Silva', 'current', '2026-11-01', 87);
    const silva2 = card('Thiago Silva', 'current', '2026-11-01', 82);
    const t = store([silva1, silva2]);
    t.setPointer(silva1);
    t.setPointer(silva2);
    assert.deepEqual(await resolve('/p/silva', t.reads), { kind: 'not_found', player: 'silva' });
  });

  await test('a player nobody has rated is not found', async () => {
    const s = store([]);
    assert.deepEqual(await resolve('/p/nobody-at-all', s.reads), { kind: 'not_found', player: 'nobody-at-all' });
  });

  await test("a store that can't be read is unavailable, never not found", async () => {
    const s = store([sakaNow]);
    s.setPointer(sakaNow);
    s.breakIt();
    assert.deepEqual(await resolve('/p/bukayo-saka', s.reads), { kind: 'unavailable' });
    assert.deepEqual(await resolveChatPage('AB12CD', s.reads), { kind: 'unavailable' });
  });

  await test('a shared chat gives its question, reply count and the cards it discusses', async () => {
    const henry = card('Thierry Henry', 'prime', '2005-06-30', 93, { seasonOrEra: '2002-05' });
    const shearer = card('Alan Shearer', 'prime', '1997-06-30', 90, { seasonOrEra: '1994-97' });
    const conv = {
      id: 'x',
      title: 'Henry vs Shearer at their peak',
      createdAt: NOW,
      activeProfile: null,
      allProfiles: [henry, shearer],
      messages: [
        { id: '1', sender: 'user', content: 'Who was better at their peak, Henry or Shearer?', timestamp: 1 },
        { id: '2', sender: 'ai', content: 'Pulled up the card.', timestamp: 2, dossierKey: getCardKey(henry) },
        { id: '3', sender: 'ai', content: 'Henry.', timestamp: 3, dossierKey: getCardKey(shearer) },
      ],
    } as unknown as Conversation;
    const s = store([], { AB12CD: conv });
    const page = await resolveChatPage('ab12cd', s.reads);
    assert.ok(page.kind === 'chat');
    assert.equal(page.code, 'AB12CD');
    assert.equal(page.question, 'Who was better at their peak, Henry or Shearer?');
    assert.equal(page.replies, 2);
    assert.deepEqual(page.cards.map((c) => c.basicInfo.name), ['Thierry Henry', 'Alan Shearer']);
    assert.deepEqual(await resolveChatPage('ZZZZZZ', s.reads), { kind: 'not_found' });
  });

  await test('the page cache reuses answers and forgets failures', async () => {
    const cache = new SharePageCache<string>(1000);
    let loads = 0;
    const load = async () => `v${++loads}`;
    assert.equal(await cache.get('a', load, () => true, 0), 'v1');
    assert.equal(await cache.get('a', load, () => true, 500), 'v1');
    assert.equal(await cache.get('a', load, () => true, 1500), 'v2');
    assert.equal(await cache.get('b', load, () => false, 1500), 'v3');
    assert.equal(await cache.get('b', load, () => false, 1600), 'v4');
  });

  console.log(`${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
