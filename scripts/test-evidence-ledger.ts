#!/usr/bin/env npx tsx
/**
 * Offline checks for chat research: the evidence ledger numbers what was found and lists what
 * wasn't, an empty research pass never reads as silence, the writer keeps its tools whenever the
 * turn researched live facts, and ledger ids never reach the reader.
 *
 * Usage:
 *   npx tsx scripts/test-evidence-ledger.ts
 */
import assert from 'node:assert/strict';
import {
  addEvidence,
  addGap,
  compactLedger,
  discardEntries,
  emptyLedger,
  formatLedger,
  formatLookupLog,
  hasEvidence,
  isFromEarlierSeason,
  logLookup,
  seasonStartDate,
  sourceDates,
} from '../services/evidenceLedger';
import { proseToolMode, sanitizeScoutProse } from '../services/conversationalScout';

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

test('entries are numbered in order and keep their sources', () => {
  let ledger = emptyLedger();
  ledger = addEvidence(ledger, { kind: 'club_context', label: 'Club: recent team', content: 'Recent Starting XIs …' });
  ledger = addEvidence(ledger, { kind: 'web', label: 'Club injuries', content: 'Two defenders out.', sources: ['Report (https://example.com)'] });
  assert.deepEqual(ledger.entries.map((e) => e.id), ['E1', 'E2']);
  const text = formatLedger(ledger);
  assert.match(text, /\[E1\] Live club data \(ESPN, FPL\) — Club: recent team/);
  assert.match(text, /\[E2\] Web search — Club injuries\nTwo defenders out\.\nSources: Report \(https:\/\/example\.com\)/);
});

test('an empty lookup becomes a gap, not an entry', () => {
  let ledger = addEvidence(emptyLedger(), { kind: 'web', label: 'Club lineups', content: '   ' });
  ledger = addGap(ledger, 'API-Football record for Club');
  ledger = addGap(ledger, 'API-Football record for Club');
  assert.equal(hasEvidence(ledger), false);
  assert.deepEqual(ledger.gaps, [
    { label: 'Club lineups', status: 'empty' },
    { label: 'API-Football record for Club', status: 'empty' },
  ]);
});

test('gaps are grouped by why there is no data, so the writer can tell a hole no source fills from a failed call', () => {
  let ledger = addGap(emptyLedger(), 'Injury list for Club', 'not_covered');
  ledger = addGap(ledger, 'Web search: Club news', 'failed');
  ledger = addGap(ledger, 'Stored card for Someone');
  const text = formatLedger(ledger);
  assert.match(text, /\[Not covered\][^\n]*\n- Injury list for Club/);
  assert.match(text, /\[Lookup failed\][^\n]*\n- Web search: Club news/);
  assert.match(text, /\[Not found\][^\n]*\n- Stored card for Someone/);
  assert.ok(text.indexOf('[Not covered]') < text.indexOf('[Lookup failed]'));
});

test('the lookup log says how each lookup ended, for the reflect step', () => {
  let ledger = logLookup(emptyLedger(), { tool: 'club_recent_team', subject: 'Club', status: 'found', note: 'no data for Injury list for Club [not covered]' });
  ledger = logLookup(ledger, { tool: 'player_season', subject: 'Someone', status: 'not_covered' });
  ledger = logLookup(ledger, { tool: 'web_search', subject: 'Club news', status: 'failed' });
  assert.equal(
    formatLookupLog(ledger),
    [
      '- club_recent_team "Club": found; no data for Injury list for Club [not covered]',
      '- player_season "Someone": not covered by any source (asking again won’t help)',
      '- web_search "Club news": failed (a retry might work)',
    ].join('\n'),
  );
});

test('digests date their points, and a web entry whose sources all predate the season is tagged', () => {
  assert.deepEqual(sourceDates('[2026-10-25] Won 2-0. [March 2025] Older piece. [undated] Something.'), ['2026-10-25', '2025-03-01']);
  const start = seasonStartDate(2026);
  assert.equal(start, '2026-07-01');
  const old = { kind: 'web' as const, content: '[2025-04-02] Shape was a back three. [May 2025] Same again.' };
  const mixed = { kind: 'web' as const, content: '[2025-04-02] Back three. [2026-10-01] Now a back four.' };
  const undated = { kind: 'web' as const, content: 'No dates at all.' };
  assert.equal(isFromEarlierSeason(old, start), true);
  assert.equal(isFromEarlierSeason(mixed, start), false);
  assert.equal(isFromEarlierSeason(undated, start), false);
  assert.equal(isFromEarlierSeason({ kind: 'club_context', content: '[2025-04-02] x' }, start), false);
  const ledger = addEvidence(emptyLedger(), { kind: 'web', label: 'Club tactics', content: old.content });
  assert.match(formatLedger(ledger, { seasonStart: start }), /Club tactics \(every source here predates this season/);
  assert.doesNotMatch(formatLedger(ledger), /predates/);
});

test('discarding drops only web entries, and new entries never reuse a discarded id', () => {
  let ledger = addEvidence(emptyLedger(), { kind: 'club_context', label: 'Club', content: 'XIs' });
  ledger = addEvidence(ledger, { kind: 'web', label: 'Old tactics', content: '[2025-03-01] Back three.' });
  ledger = discardEntries(ledger, [
    { id: 'E1', reason: 'feed data is never dropped' },
    { id: 'e2', reason: 'describes last season' },
  ]);
  assert.deepEqual(ledger.entries.map((e) => e.id), ['E1']);
  assert.deepEqual(ledger.discarded, [{ id: 'E2', label: 'Old tactics', reason: 'describes last season' }]);
  ledger = addEvidence(ledger, { kind: 'web', label: 'News', content: '[2026-10-30] News.' });
  assert.deepEqual(ledger.entries.map((e) => e.id), ['E1', 'E3']);
});

test('the compact ledger marks analysis entries and trims long ones', () => {
  let ledger = addEvidence(emptyLedger(), { kind: 'web', label: 'Club analysis', content: 'x'.repeat(50), stage: 'analysis' });
  ledger = addEvidence(ledger, { kind: 'web', label: 'Club news', content: 'News.', sources: ['S (https://example.com)'] });
  const text = compactLedger(ledger, { perEntry: 10 });
  assert.match(text, /Club analysis \(analysis\)\nx{10}…/);
  assert.doesNotMatch(text, /Sources:/);
  assert.equal(compactLedger(emptyLedger()), 'Nothing yet.');
});

test('a research pass that found nothing still tells the writer what failed', () => {
  const text = formatLedger(addGap(emptyLedger(), 'Club lineups'));
  assert.match(text, /\[Not found\]/);
  assert.match(text, /- Club lineups/);
  assert.equal(formatLedger(emptyLedger()), '');
});

test('the writer keeps every tool whenever the turn researched live facts', () => {
  assert.equal(proseToolMode({ researched: true, isArchive: false, cardsLocked: true }), 'full');
  assert.equal(proseToolMode({ researched: true, isArchive: false, cardsLocked: false }), 'full');
  // Answered from stored cards or the archive: only the instant local tools.
  assert.equal(proseToolMode({ researched: false, isArchive: false, cardsLocked: true }), 'local_only');
  assert.equal(proseToolMode({ researched: false, isArchive: true, cardsLocked: false }), 'local_only');
  assert.equal(proseToolMode({ researched: false, isArchive: false, cardsLocked: false }), 'full');
});

test('ledger ids never reach the reader', () => {
  const reply = 'He has started every league match [E1]. Two centre-backs are out [E2, E4].';
  assert.equal(sanitizeScoutProse(reply), 'He has started every league match. Two centre-backs are out.');
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
