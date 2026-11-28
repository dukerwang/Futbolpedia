#!/usr/bin/env npx tsx
/**
 * Offline checks for comparison-first rating (services/peerComparison.ts, services/reasonCheck.ts):
 * peers shown with no number, reasons that rest on availability, team success or fame sent back
 * once and dropped if still flagged, and the comparisons turned into a range. Gemini is faked at
 * the fetch layer.
 *
 * Usage:
 *   npx tsx scripts/test-peer-comparison.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';

process.env.API_KEY = 'offline-test-key';

/** What each comparison call answers, in order; a call past the end fails. */
let replies: unknown[] = [];
let prompts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
  prompts.push(JSON.stringify(JSON.parse(init?.body ?? '{}').contents ?? ''));
  const reply = replies.shift();
  if (reply === undefined) return new Response('{"error":{"message":"boom"}}', { status: 500 });
  return new Response(
    JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(reply) }] }, finishReason: 'STOP' }], usageMetadata: {} }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}) as typeof fetch;

const { offFootballReason } = await import('../services/reasonCheck');
const {
  buildComparisonsBlock,
  comparePeers,
  comparisonRange,
  placementFromComparisons,
  scrubRatingNumbers,
  serializePeerForComparison,
  toStoredComparisons,
} = await import('../services/peerComparison');
const { CALIBRATION_EPOCH_MS } = await import('../services/dossierCache');

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  replies = [];
  prompts = [];
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    await fn();
    console.log = log;
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.log = log;
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).stack ?? err}`);
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const prime = (name: string, overall: number, window: string, extra: Partial<PlayerProfile> = {}): PlayerProfile =>
  ({
    basicInfo: { name, age: 27, nationality: 'N/A', club: 'Club', position: 'Central Midfielder' },
    ratings: { overall, potential: overall },
    attributes: { vision: 94, passing: 93, aerialProwess: 61 },
    strengths: [`**Tempo Setter:** ${name} dictated the rhythm. Vision 94 in every phase.`],
    weaknesses: [`**Slow Turn:** ${name} was caught on the turn.`],
    playstyleAndRole: { playstyle: { archetype: 'Deep Conductor', description: 'Dictates from deep.' }, bestRoles: ['Regista'] },
    shortBio: 'Bio.',
    latestUpdate: 'Update.',
    evaluationDate: '2010-05-27',
    createdAt: CALIBRATION_EPOCH_MS + 1,
    peerPlacement: { betterThan: ['Someone Else (2001-03)'], levelWith: [], notAsGoodAs: [] },
    version: { id: `${name}-prime`, type: 'prime', label: `Prime Zenith (${window})`, evaluationDate: '2010-05-27', seasonOrEra: window, peakContext: 'The years he ran the midfield.' },
    ...extra,
  }) as PlayerProfile;

const A = prime('Peer Alpha', 91, '2008-10');
const B = prime('Peer Bravo', 91, '2011-13');
const C = prime('Peer Charlie', 89, '2004-06');

await test('a peer is shown to the comparison with no Overall, tier, placement or attribute value', () => {
  const text = serializePeerForComparison({ ...A, shortBio: 'A World-Class Elite 91 OVR midfielder.' }, 'P1');
  assert.match(text, /\[P1\] Peer Alpha \| Prime Zenith \(2008-10\) \| Central Midfielder/);
  assert.match(text, /Tempo Setter/);
  assert.match(text, /Slow Turn/);
  assert.match(text, /Deep Conductor/);
  assert.doesNotMatch(text, /\b9[0-9]\b|\b8[0-9]\b|\b6[0-9]\b/, 'no rating-scale number');
  assert.doesNotMatch(text, /Overall|Potential|OVR|World-Class|Someone Else/);
  assert.match(text, /Vision in every phase/, 'the attribute stays, its value goes');
  assert.equal(scrubRatingNumbers('A World-Class finisher rated 91, Finishing 95 and 92 Vision, with 31 league goals in 2009-10.'), 'A finisher, Finishing and Vision, with 31 league goals in 2009-10.');
});

await test('reasons that rest on availability, team success or fame are flagged; football that mentions a match is not', () => {
  for (const [reason, kind] of [
    ['He missed half a season with a hamstring injury.', 'availability'],
    ['A 12-week muscle injury cost him a third of the window.', 'availability'],
    ['He played far more matches across the three seasons.', 'availability'],
    ['His durability kept him on the pitch when the other faded.', 'availability'],
    ['Fewer minutes in the league than the peer.', 'availability'],
    ['He won three league titles in the window.', 'team_success'],
    ['Won the Champions League twice as the key man.', 'team_success'],
    ['His trophies outweigh the peer\'s.', 'team_success'],
    ['His reputation was bigger across Europe.', 'fame'],
  ] as const) {
    assert.equal(offFootballReason(reason), kind, reason);
  }
  for (const reason of [
    'He scored in the final, but the peer read the game a beat quicker in every phase.',
    'In the final minutes of tight matches he still found the pass that broke the press.',
    'He won the ball back more often and broke lines with his first pass.',
    'Better in the big matches, the semi-final included, because his decisions under pressure were sharper.',
    'His movement between the lines gave his side an outlet the peer never could.',
    'Played as the deepest midfielder, he controlled the match from there.',
  ]) {
    assert.equal(offFootballReason(reason), null, reason);
  }
});

await test('the comparison prompt shows no number for anyone and asks which was the better footballer', async () => {
  replies = [{ comparisons: [{ peer: 'P1', judgment: 'better', reason: 'He saw the pass earlier.' }] }];
  const result = await comparePeers({
    subjectName: 'Subject Player',
    subjectEvidence: 'Career record: 2009-10 34 apps 5 goals. Rated 93 OVR on an old card.',
    task: 'rate prime Subject Player',
    peers: [A],
  });
  assert.equal(result.calls, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /which was the better footballer/);
  assert.match(prompts[0], /Matches or minutes missed, injuries, durability, appearance totals, the trophies and results his team won, and fame are not reasons/);
  assert.doesNotMatch(prompts[0], /\b91\b|\b93\b|OVR|Overall/);
  assert.match(prompts[0], /34 apps 5 goals/, 'his record stays');
  assert.equal(result.compared.length, 1);
  assert.equal(result.compared[0].peer, A);
});

await test('a flagged reason is sent back once, covering only the flagged pairs; a pair still flagged is dropped', async () => {
  replies = [
    {
      comparisons: [
        { peer: 'P1', judgment: 'not_as_good', reason: 'A 12-week muscle injury cost him a third of the window.' },
        { peer: 'P2', judgment: 'level', reason: 'Neither controlled games better from deep.' },
        { peer: 'P3', judgment: 'better', reason: 'He won three league titles in the window.' },
      ],
    },
    {
      comparisons: [
        { peer: 'P1', judgment: 'better', reason: 'His passing broke lines the peer only recycled.' },
        { peer: 'P3', judgment: 'better', reason: 'His side won more trophies.' },
        // Never asked about: ignored, the first answer stands.
        { peer: 'P2', judgment: 'better', reason: 'Changed his mind.' },
      ],
    },
  ];
  const result = await comparePeers({ subjectName: 'Subject Player', subjectEvidence: 'Evidence.', task: 'rate prime Subject Player', peers: [A, B, C] });
  assert.equal(result.calls, 2);
  const followUp = prompts[1];
  assert.match(followUp, /<reason_check>/);
  assert.match(followUp, /- P1 \(not_as_good\): \\"A 12-week muscle injury[^"]*" rests on availability/);
  assert.match(followUp, /- P3 \(better\): \\"He won three league titles[^"]*" rests on team success/);
  assert.doesNotMatch(followUp.slice(followUp.indexOf('<reason_check>')), /P2 \(/);
  assert.deepEqual(
    result.compared.map((c) => [c.peer.basicInfo.name, c.judgment]),
    [['Peer Alpha', 'better'], ['Peer Bravo', 'level']],
  );
  assert.deepEqual(result.dropped.map((d) => [d.peer.basicInfo.name, d.kind]), [['Peer Charlie', 'team_success']]);
});

await test('a failed comparison call compares nobody, and no peers means no call', async () => {
  const failed = await comparePeers({ subjectName: 'S', subjectEvidence: 'E', task: 'T', peers: [A] });
  assert.deepEqual(failed.compared, []);
  assert.equal((await comparePeers({ subjectName: 'S', subjectEvidence: 'E', task: 'T', peers: [] })).calls, 0);
  assert.equal(prompts.length, 1);
});

await test('the comparisons become the placement and the range; a contradictory set allows none', () => {
  const better91 = { peer: A, judgment: 'better' as const, reason: 'r' };
  const level91 = { peer: B, judgment: 'level' as const, reason: 'r' };
  const notAsGood89 = { peer: C, judgment: 'not_as_good' as const, reason: 'r' };
  assert.deepEqual(comparisonRange([better91]), { min: 92, max: 99 });
  assert.deepEqual(comparisonRange([level91]), { min: 91, max: 91 });
  // Better than one 91 and level with another: integers leave no room, so the tie is allowed.
  assert.deepEqual(comparisonRange([better91, level91]), { min: 91, max: 91 });
  // Better than a 91 and not as good as an 89 contradicts itself.
  assert.equal(comparisonRange([better91, notAsGood89]), null);
  assert.equal(comparisonRange([]), null);
  const placement = placementFromComparisons([better91, notAsGood89]);
  assert.deepEqual([placement.betterThan, placement.notAsGoodAs], [[A], [C]]);
  assert.deepEqual(toStoredComparisons([better91]), [{ peer: 'Peer Alpha (2008-10)', peerKey: toStoredComparisons([better91])[0].peerKey, judgment: 'better', reason: 'r' }]);

  const constraint = buildComparisonsBlock([better91]);
  assert.match(constraint, /<peer_comparisons>/);
  assert.match(constraint, /allow an Overall from 92 to 99/);
  assert.match(constraint, /- better than Peer Alpha \(2008-10\): r/);
  const mixed = buildComparisonsBlock([better91, notAsGood89]);
  assert.match(mixed, /leave no single range/);
  assert.match(mixed, /confidence\.verdict/);
  assert.doesNotMatch(mixed, /allow an Overall from/);
  assert.equal(buildComparisonsBlock([]), '');
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
