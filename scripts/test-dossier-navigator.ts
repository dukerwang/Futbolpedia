#!/usr/bin/env npx tsx
/**
 * Offline checks for the dossier navigator's search (`filterDossiers`): what a typed query finds
 * among your dossiers and that the full-list positions the pager shows are kept.
 *
 * Usage:
 *   npx tsx scripts/test-dossier-navigator.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';
import { filterDossiers } from '../services/dossierNavigator';

const card = (name: string, club: string, position: string): PlayerProfile =>
  ({ basicInfo: { name, club, position }, ratings: { overall: 80, potential: 80 } }) as PlayerProfile;

const label = (p: PlayerProfile) => (p.basicInfo.name.includes('Prime') ? 'Prime · 2003–06' : 'Current form · Nov 2026');

const cards = [
  card('Kylian Mbappé', 'Real Madrid', 'Centre Forward'),
  card('Neymar Jr (Prime)', 'Barcelona', 'Left Winger'),
  card('Rodri', 'Manchester City', 'Defensive Midfielder'),
  card('Jude Bellingham', 'Real Madrid', 'Attacking Midfielder'),
];
const names = (query: string) => filterDossiers(cards, query, label).map((e) => e.profile.basicInfo.name);

assert.equal(filterDossiers(cards, '', label).length, 4, 'empty search lists everything');
assert.equal(filterDossiers(cards, '   ', label).length, 4, 'blank search lists everything');
assert.deepEqual(names('mbappe'), ['Kylian Mbappé'], 'accents are ignored');
assert.deepEqual(names('NEY'), ['Neymar Jr (Prime)'], 'case and word starts match');
assert.deepEqual(names('real madrid'), ['Kylian Mbappé', 'Jude Bellingham'], 'club words match, order kept');
assert.deepEqual(names('prime'), ['Neymar Jr (Prime)'], 'edition label words match');
assert.deepEqual(names('2003'), ['Neymar Jr (Prime)'], 'edition years match');
assert.deepEqual(names('midfielder man'), ['Rodri'], 'words match in any order across fields');
assert.deepEqual(names('ymar'), [], 'a word must start a word, not sit inside one');
assert.deepEqual(names('zzz'), [], 'no match');
assert.deepEqual(
  filterDossiers(cards, 'real', label).map((e) => e.index),
  [0, 3],
  'positions are those of the full list',
);

console.log('dossier navigator checks passed');
