#!/usr/bin/env npx tsx
/**
 * Offline checks that a prime re-rated after a thread or a saved list got it is read from its new
 * card: the old window and numbers are swapped out of the thread, the conversation's profiles and
 * your dossiers, while a personal revision and a prime that was never re-rated stay. Supabase is a
 * one-table stand-in holding the shared prime pointer.
 *
 * Usage:
 *   npx tsx scripts/test-superseded-primes.ts
 */
import assert from 'node:assert/strict';
import type { ChatMessage, PlayerProfile } from '../types';

type Row = Record<string, any>;
const rows: Row[] = [];
(globalThis as any).window = {
  supabase: {
    createClient: () => ({
      from: () => {
        let slug = '';
        const q: any = {
          select: () => q,
          eq: (_col: string, val: string) => ((slug = val), q),
          single: () => q,
          then: (resolve: (v: any) => void) => {
            const row = rows.find((r) => r.player_slug === slug);
            resolve(row ? { data: row, error: null } : { data: null, error: { message: 'no rows' } });
          },
        };
        return q;
      },
    }),
  },
};

const { CALIBRATION_EPOCH_MS, getCardKey } = await import('../services/dossierStore');
const { replaceSupersededPrimes } = await import('../services/dossierLookup');

const RERATED_AT = CALIBRATION_EPOCH_MS + 5000;
const prime = (
  name: string,
  overall: number,
  window: string,
  date: string,
  extra: Partial<PlayerProfile> = {},
): PlayerProfile =>
  ({
    basicInfo: { name, age: 25, nationality: 'N/A', club: 'Ajax', position: 'Attacking Midfielder' },
    ratings: { overall, potential: overall },
    attributes: { finishing: 80 },
    strengths: [],
    weaknesses: [],
    shortBio: 'Bio.',
    latestUpdate: 'Update.',
    evaluationDate: date,
    createdAt: CALIBRATION_EPOCH_MS + 1000,
    version: { id: `${name}-${date}`, type: 'prime', label: 'Prime', evaluationDate: date, seasonOrEra: window },
    ...extra,
  }) as unknown as PlayerProfile;

const oldCard = prime('Johan Cruyff', 97, '1971-72', '1972-05-31');
const newCard = prime('Johan Cruyff', 98, '1971-74', '1974-06-30', { rerateAt: RERATED_AT, createdAt: RERATED_AT });
const outline = { ...newCard, attributes: undefined, shortBio: undefined } as unknown as PlayerProfile;
rows.push({ player_slug: 'prime-johan-cruyff', player_data: newCard, updated_at: new Date(RERATED_AT).toISOString() });

const posted = (content: PlayerProfile | string, dossierKey?: string): ChatMessage =>
  ({ id: `m${Math.random()}`, sender: 'ai', content, ...(dossierKey ? { dossierKey } : {}) }) as unknown as ChatMessage;

let failures = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).stack ?? err}`);
  }
}

await test('a posted card, a stub, the conversation profiles and your dossiers all move to the new card', async () => {
  const out = await replaceSupersededPrimes(
    {
      history: [posted(oldCard), posted('Rated Johan Cruyff.', getCardKey(oldCard))],
      conversationProfiles: [oldCard],
      savedDossiers: [oldCard],
    },
    [outline],
  );
  assert.equal((out.history[0].content as PlayerProfile).ratings.overall, 98);
  assert.equal(out.history[1].dossierKey, getCardKey(newCard));
  assert.deepEqual(out.conversationProfiles.map((c) => c.ratings.overall), [98]);
  assert.deepEqual(out.savedDossiers.map((c) => c.version?.seasonOrEra), ['1971-74']);
});

await test('a re-rating that keeps the evaluation date still replaces the old numbers', async () => {
  const sameDate = prime('Johan Cruyff', 97, '1971-74', '1974-06-30');
  const out = await replaceSupersededPrimes(
    { history: [], conversationProfiles: [sameDate], savedDossiers: [] },
    [outline],
  );
  assert.equal(out.conversationProfiles[0].ratings.overall, 98);
});

await test('a personal revision stays as it is', async () => {
  const revised = prime('Johan Cruyff', 96, '1971-72', '1972-05-31', {
    revision: { revisedAt: CALIBRATION_EPOCH_MS + 2000 } as PlayerProfile['revision'],
  });
  const input = { history: [], conversationProfiles: [revised], savedDossiers: [revised] };
  assert.equal(await replaceSupersededPrimes(input, [outline]), input);
});

await test('a prime that was never re-rated, or another player, stays as it is', async () => {
  const other = prime('Michel Platini', 97, '1983-85', '1985-05-31');
  const never = { ...outline, rerateAt: undefined } as PlayerProfile;
  const input = { history: [], conversationProfiles: [oldCard, other], savedDossiers: [] };
  assert.equal(await replaceSupersededPrimes(input, [never]), input);
  const out = await replaceSupersededPrimes(input, [outline]);
  assert.deepEqual(out.conversationProfiles.map((c) => c.ratings.overall), [98, 97]);
});

await test('a card whose replacement is no longer served stays as it is', async () => {
  rows.length = 0;
  const input = { history: [], conversationProfiles: [oldCard], savedDossiers: [] };
  assert.equal(await replaceSupersededPrimes(input, [outline]), input);
});

if (failures > 0) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nAll superseded-prime checks passed');
