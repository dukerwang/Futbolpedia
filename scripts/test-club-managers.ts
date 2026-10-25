#!/usr/bin/env npx tsx
/**
 * Offline checks for the live club-manager lookup: parsing the search answer, the API-Football
 * cross-check, cache freshness, and how a verified manager is attached to a card.
 * No network, Supabase or Gemini access needed.
 *
 * Usage:
 *   npx tsx scripts/test-club-managers.ts
 */
import assert from 'node:assert/strict';
import {
  isClubManagerFresh,
  parseManagerLookup,
  reconcileManagerSources,
  toClubKey,
  type ClubManagerRecord,
} from '../services/clubManagers';
import { sanitizeProfileData } from '../services/dossierSynthesizer';
import { attachVerifiedManager } from '../services/profileManagerGrounding';

let failures = 0;
let passes = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passes++;
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${err instanceof Error ? err.message : err}`);
  }
}

const record = (overrides: Partial<ClubManagerRecord> = {}): ClubManagerRecord => ({
  club: 'Chelsea',
  coach: 'Xabi Alonso',
  previousCoach: 'Liam Rosenior',
  coachSince: '2026-07-01',
  sourceUrl: 'https://example.com/chelsea-coach',
  sourceDate: '2026-10-20',
  apiCoach: 'Enzo Maresca',
  sourcesAgree: false,
  verifiedOn: '2026-10-25',
  ...overrides,
});

const card = (prose: { shortBio?: string; latestUpdate?: string; description?: string }) =>
  sanitizeProfileData({
    basicInfo: { name: 'Moisés Caicedo', club: 'Chelsea', position: 'Defensive Midfielder' },
    ratings: { overall: 88, potential: 89 },
    shortBio: prose.shortBio ?? 'A ball-winning pivot.',
    latestUpdate: prose.latestUpdate ?? 'Started the last five league games.',
    playstyleAndRole: {
      playstyle: { archetype: 'Pivot', description: prose.description ?? 'Screens the back line.' },
      bestRoles: [],
    },
  } as any);

test('parses a complete lookup answer', () => {
  assert.deepEqual(
    parseManagerLookup(
      'COACH: Xabi Alonso | SINCE: 2026-07-01 | PREVIOUS: Liam Rosenior | SOURCE_DATE: 2026-10-20',
    ),
    { coach: 'Xabi Alonso', coachSince: '2026-07-01', previousCoach: 'Liam Rosenior', sourceDate: '2026-10-20' },
  );
});

test('treats UNKNOWN and malformed fields as unconfirmed', () => {
  assert.deepEqual(parseManagerLookup('COACH: UNKNOWN | SINCE: last summer | PREVIOUS: n/a'), {
    coach: null,
    coachSince: null,
    previousCoach: null,
    sourceDate: null,
  });
  assert.equal(parseManagerLookup('').coach, null);
});

test('the search wins a disagreement with API-Football; no search answer names nobody', () => {
  assert.deepEqual(reconcileManagerSources('Xabi Alonso', 'Enzo Maresca'), { coach: 'Xabi Alonso', sourcesAgree: false });
  assert.deepEqual(reconcileManagerSources('Xabi Alonso', 'X. Alonso Olano'), { coach: 'Xabi Alonso', sourcesAgree: false });
  assert.deepEqual(reconcileManagerSources('Rúben Amorim', 'Ruben Amorim'), { coach: 'Rúben Amorim', sourcesAgree: true });
  assert.deepEqual(reconcileManagerSources('Xabi Alonso', null), { coach: 'Xabi Alonso', sourcesAgree: null });
  assert.deepEqual(reconcileManagerSources(null, 'Enzo Maresca'), { coach: null, sourcesAgree: null });
});

test('a stored lookup is reused for a day', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  assert.equal(isClubManagerFresh(now - 23 * 3600_000, now), true);
  assert.equal(isClubManagerFresh(now - 25 * 3600_000, now), false);
});

test('club keys ignore casing, accents and common aliases', () => {
  assert.equal(toClubKey('Chelsea'), toClubKey('chelsea '));
  assert.equal(toClubKey('Barca'), toClubKey('FC Barcelona'));
  assert.equal(toClubKey('Atlético Madrid'), 'atletico-madrid');
});

test('a card names only the verified manager, and carries it', () => {
  const out = attachVerifiedManager(
    card({ shortBio: "He anchors Maresca's system in midfield.", description: 'Under Enzo Maresca he screens the back line.' }),
    record(),
  );
  assert.deepEqual(out.clubManager, { name: 'Xabi Alonso', verifiedOn: '2026-10-25', sourceUrl: 'https://example.com/chelsea-coach' });
  assert.equal(out.shortBio, "He anchors Xabi Alonso's system in midfield.");
  assert.equal(out.playstyleAndRole.playstyle.description, 'Under Xabi Alonso he screens the back line.');
});

test('when the lookup confirmed nobody, the card names no manager', () => {
  const withOld = { ...card({ shortBio: "He anchors Maresca's system in midfield." }), clubManager: { name: 'Old', verifiedOn: '2026-01-01' } };
  const out = attachVerifiedManager(withOld, record({ coach: null }));
  assert.equal(out.clubManager, undefined);
  assert.equal(out.shortBio, "He anchors the team's system in midfield.");
  assert.equal(attachVerifiedManager(withOld, null).clubManager, undefined);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
