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
import { addEvidence, addGap, emptyLedger, formatLedger, hasEvidence } from '../services/evidenceLedger';
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
  assert.match(text, /\[E1\] API-Football club record — Club: recent team/);
  assert.match(text, /\[E2\] Web search — Club injuries\nTwo defenders out\.\nSources: Report \(https:\/\/example\.com\)/);
});

test('an empty lookup becomes a gap, not an entry', () => {
  let ledger = addEvidence(emptyLedger(), { kind: 'web', label: 'Club lineups', content: '   ' });
  ledger = addGap(ledger, 'API-Football record for Club');
  ledger = addGap(ledger, 'API-Football record for Club');
  assert.equal(hasEvidence(ledger), false);
  assert.deepEqual(ledger.gaps, ['Club lineups', 'API-Football record for Club']);
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
