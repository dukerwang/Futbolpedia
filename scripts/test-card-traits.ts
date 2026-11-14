#!/usr/bin/env npx tsx
/**
 * Offline checks for a card's strengths and weaknesses (services/cardTraits.ts): structured items
 * become card lines, stock lines shared with other players' cards are found and rewritten, and
 * every other weakness is checked against the rules (Gemini faked at the fetch layer).
 *
 * Usage:
 *   npx tsx scripts/test-card-traits.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';
import {
  applyTraitRevisions,
  findStockTraits,
  findTraitsToReview,
  formatTrait,
  reviseCardTraits,
  takenTraitTitles,
  titleSimilarity,
  titleWords,
  toTraitLines,
  traitTitle,
} from '../services/cardTraits';
import { sanitizeProfileData } from '../services/dossierSynthesizer';
import { DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION } from '../prompts/dossierPrompt';
import {
  applyEntry,
  cardEvidence,
  groupCards,
  proposeEntry,
  reportMarkdown,
  type BackfillEntry,
  type CardStore,
} from './backfill-card-traits';

process.env.API_KEY = 'offline-test-key';

let geminiReplyText: string | null = null;
let geminiPrompts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.includes('generativelanguage.googleapis.com')) {
    geminiPrompts.push(JSON.stringify(JSON.parse(init?.body ?? '{}').contents ?? ''));
    if (geminiReplyText === null) return new Response('{"error":{"message":"boom"}}', { status: 500 });
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: geminiReplyText }] }, finishReason: 'STOP' }],
        usageMetadata: {},
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  geminiPrompts = [];
  geminiReplyText = null;
  try {
    await fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).stack ?? err}`);
  }
}

const card = (name: string, strengths: string[], weaknesses: string[]): PlayerProfile =>
  ({
    basicInfo: { name, age: 27, nationality: 'N/A', club: 'Club', position: 'Attacking Midfielder', height: 'N/A', weight: 'N/A' },
    ratings: { overall: 88, potential: 88 },
    attributes: { vision: 92, aerialProwess: 40 },
    strengths,
    weaknesses,
    shortBio: 'Bio.',
    playstyleAndRole: { playstyle: { archetype: 'Mould', description: 'Prose.' }, bestRoles: ['Role'] },
    latestUpdate: 'Update.',
  }) as unknown as PlayerProfile;

const pool = [
  card('Player One', ['**Anticipatory Interceptions:** reads it.'], ['**Aerial Limitations:** small.', '**Minimal Defensive Contribution:** stays high.']),
  card('Player Two', ['**Anticipatory Interceptions:** reads it too.'], ['**Aerial Limitations:** also small.', '**Minimal Defensive Contribution:** rests.']),
  card('Player Three', ['**Press-Resistant Composure:** calm.'], ['**Left-Foot Dependency:** one-footed.']),
];

await test('structured items become one bold-titled line each', () => {
  assert.deepEqual(
    toTraitLines(
      [
        { title: 'Delayed Release', method: 'Holds the pass a beat longer than defenders expect', impact: 'Pulls the line out of shape.' },
        '**Already A Line:** kept.',
        { title: '', method: '', impact: '' },
      ],
      'strength',
    ),
    ['**Delayed Release:** Holds the pass a beat longer than defenders expect. Pulls the line out of shape.', '**Already A Line:** kept.'],
  );
  assert.deepEqual(
    toTraitLines([{ title: '**Slow Turn:**', whereItShows: 'When pressed from behind', cost: 'Teams press his first touch' }], 'weakness'),
    ['**Slow Turn:** When pressed from behind. Teams press his first touch.'],
  );
  assert.equal(formatTrait('Title', 'Ends with a question?'), '**Title:** Ends with a question?');
  assert.deepEqual(toTraitLines('not an array', 'weakness'), []);
});

await test('the synthesis sanitizer stores structured traits as card lines', () => {
  const profile = sanitizeProfileData({
    strengths: [{ title: 'Late Arrival', method: 'Times his run to the far post', impact: 'Finishes moves others start' }],
    weaknesses: [{ title: 'Narrow Passing Range', whereItShows: 'Against a low block', cost: 'Possession goes sideways' }],
  } as any);
  assert.deepEqual(profile.strengths, ['**Late Arrival:** Times his run to the far post. Finishes moves others start.']);
  assert.deepEqual(profile.weaknesses, ['**Narrow Passing Range:** Against a low block. Possession goes sideways.']);
});

await test('the synthesis prompt says a skill his role never asked of him is not a weakness', () => {
  assert.match(DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION, /A skill his role never asked of him is not a weakness/);
  assert.match(DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION, /if it would read just as true on most players at his position/);
  assert.match(DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION, /A quality worded as a flaw is not a weakness/);
  assert.match(DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION, /two to four plain words a football fan would use/);
  assert.match(DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION, /never his only weakness/);
  assert.doesNotMatch(DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION, /\$\{/);
});

await test('rewordings of one stock title match; different traits in the same area do not', () => {
  const sim = (a: string, b: string) => titleSimilarity(titleWords(a), titleWords(b));
  assert.equal(traitTitle('**Aerial Limitations:** text'), 'Aerial Limitations');
  assert.equal(traitTitle('Plain Title: text'), 'Plain Title');
  assert.ok(sim('Aerial Limitations', 'Aerial Limitation') >= 0.6);
  assert.ok(sim('Top-End Recovery Velocity', 'Top-End Sprint Velocity') >= 0.5);
  assert.ok(sim('Minimal Defensive Contribution', 'Minimal Defensive Contributions') >= 0.6);
  assert.ok(sim('Surgical Ball-Striking & Crossing', 'Thunderous Distance Ball-Striking') < 0.6);
  assert.ok(sim('Left-Foot Dependency', 'Left-Back Recovery Pace') < 0.6);
});

await test('a line on two other players\' cards is stock; one other player, or his own cards, are not', () => {
  const subject = card(
    'Subject',
    ['**Anticipatory Interceptions:** reads it.', '**Press-Resistant Composure:** calm.'],
    ['**Aerial Limitation:** small.', '**Hesitates On The Weaker Side:** detail.'],
  );
  const stock = findStockTraits(subject, pool);
  assert.deepEqual(
    stock.map((s) => [s.kind, s.index]),
    [
      ['strength', 0],
      ['weakness', 0],
    ],
  );
  assert.deepEqual(stock[1].sharedWith.sort(), ['Player One', 'Player Two']);
  // His own other cards never count against him.
  const own = [card('Subject', [], ['**Aerial Limitations:** a.']), card('Subject', [], ['**Aerial Limitations:** b.']), pool[0]];
  assert.deepEqual(findStockTraits(card('Subject', [], ['**Aerial Limitations:** c.']), own), []);
});

await test('revisions replace only the stock lines; a weakness drops only when two others remain', () => {
  const subject = card('Subject', ['**Anticipatory Interceptions:** reads it.', '**Own Strength:** kept.'], ['**Aerial Limitations:** small.']);
  const stock = findStockTraits(subject, pool);
  const revised = applyTraitRevisions(subject, stock, [
    { id: 'S1', drop: false, title: 'Steps In Early', detail: 'Leaves his man to cut the pass before it is played', consequence: 'Starts counters high up' },
    { id: 'W1', drop: true, title: '', detail: '', consequence: '' },
    { id: 'S2', drop: false, title: 'Not Flagged', detail: 'Should be ignored', consequence: 'x' },
  ]);
  assert.deepEqual(revised.strengths, ['**Steps In Early:** Leaves his man to cut the pass before it is played. Starts counters high up.', '**Own Strength:** kept.']);
  // The only weakness is never dropped.
  assert.deepEqual(revised.weaknesses, ['**Aerial Limitations:** small.']);

  const two = card('Subject', [], ['**Aerial Limitations:** small.', '**Own Weakness:** kept.']);
  // Two weaknesses is the floor, so neither is dropped.
  assert.deepEqual(applyTraitRevisions(two, findStockTraits(two, pool), [{ id: 'W1', drop: true }]).weaknesses, two.weaknesses);
  const three = card('Subject', [], ['**Aerial Limitations:** small.', '**Own Weakness:** kept.', '**Second Own:** kept.']);
  const dropped = applyTraitRevisions(three, findStockTraits(three, pool), [{ id: 'W1', drop: true }]);
  assert.deepEqual(dropped.weaknesses, ['**Own Weakness:** kept.', '**Second Own:** kept.']);
  // An empty rewrite keeps the line.
  const empty = applyTraitRevisions(two, findStockTraits(two, pool), [{ id: 'W1', drop: false, title: 'X', detail: '' }]);
  assert.deepEqual(empty.weaknesses, two.weaknesses);
});

await test('every weakness that isn\'t stock is marked to check; strengths only when stock', () => {
  const subject = card(
    'Subject',
    ['**Anticipatory Interceptions:** reads it.', '**Own Strength:** kept.'],
    ['**Aerial Limitations:** small.', '**Own Weakness:** kept.'],
  );
  assert.deepEqual(
    findTraitsToReview(subject, pool).map((t) => [t.kind, t.index, t.review]),
    [
      ['strength', 0, 'rewrite'],
      ['weakness', 0, 'rewrite'],
      ['weakness', 1, 'check'],
    ],
  );
  assert.deepEqual(findTraitsToReview(card('Subject', ['**Own Strength:** kept.'], []), pool), []);
});

await test('reviseCardTraits marks stock lines to rewrite and other weaknesses to check, and applies the reply', async () => {
  const subject = card('Subject', ['**Own Strength:** kept.'], ['**Minimal Defensive Contribution:** stays high.', '**Own Weakness:** kept.']);
  geminiReplyText = JSON.stringify({
    revisions: [{ id: 'W1', drop: false, title: 'Switches Off', detail: 'Walks back when a move he started breaks down', consequence: 'His side defends the counter a man short' }],
  });
  const revised = await reviseCardTraits(subject, pool, 'EVIDENCE TEXT');
  assert.equal(geminiPrompts.length, 1);
  assert.match(geminiPrompts[0], /W1 \[REWRITE\]: \*\*Minimal Defensive Contribution/);
  assert.match(geminiPrompts[0], /W2 \[CHECK\]: \*\*Own Weakness/);
  assert.match(geminiPrompts[0], /S1: \*\*Own Strength/);
  assert.match(geminiPrompts[0], /two to four plain words/);
  assert.match(geminiPrompts[0], /<taken_lines>/);
  assert.match(geminiPrompts[0], /On other cards at his position/);
  assert.match(geminiPrompts[0], /EVIDENCE TEXT/);
  assert.deepEqual(revised.weaknesses, [
    '**Switches Off:** Walks back when a move he started breaks down. His side defends the counter a man short.',
    '**Own Weakness:** kept.',
  ]);
  assert.deepEqual(revised.strengths, subject.strengths);
});

await test('a checked weakness that breaks the rules is replaced, even when the stock one beside it is dropped', async () => {
  const subject = card('Subject', [], ['**Aerial Limitations:** small.', '**Too Economical:** never tries a trick.']);
  geminiReplyText = JSON.stringify({
    revisions: [
      { id: 'W1', drop: true },
      { id: 'W2', drop: false, title: 'Fades Late', detail: 'His pressing drops off in the last twenty minutes', consequence: 'Opponents finish games on top' },
    ],
  });
  const revised = await reviseCardTraits(subject, pool, '');
  // The stock line can't be dropped below two weaknesses, so it stays beside the replacement.
  assert.deepEqual(revised.weaknesses, [
    '**Aerial Limitations:** small.',
    '**Fades Late:** His pressing drops off in the last twenty minutes. Opponents finish games on top.',
  ]);

  // A weakness most players share may stay, with one particular to him added beside it.
  geminiReplyText = JSON.stringify({
    revisions: [{ id: 'NEW', drop: false, title: 'Drifts Out Of Games', detail: 'Goes missing for long spells when his side has to defend', consequence: 'Opponents play through his zone' }],
  });
  const one = card('Subject', [], ['**Slow Over Distance:** loses races.']);
  assert.deepEqual((await reviseCardTraits(one, pool, '')).weaknesses, [
    '**Slow Over Distance:** loses races.',
    '**Drifts Out Of Games:** Goes missing for long spells when his side has to defend. Opponents play through his zone.',
  ]);

  // A card with one weakness of his own also gets a second.
  const single = card('Subject', [], ['**Own Weakness:** kept.']);
  assert.equal((await reviseCardTraits(single, pool, '')).weaknesses.length, 2);
  assert.match(geminiPrompts[geminiPrompts.length - 1], /at least two weaknesses/);

  // A NEW line isn't added to a card that already has two.
  assert.deepEqual((await reviseCardTraits(subject, pool, '')).weaknesses, subject.weaknesses);

  // When every weakness is dropped, two are still kept.
  geminiReplyText = JSON.stringify({ revisions: [{ id: 'W1', drop: true }, { id: 'W2', drop: true }] });
  assert.equal((await reviseCardTraits(subject, pool, '')).weaknesses.length, 2);
});

await test('taken titles: lines common across other players, and lines at his position with the newest rewrites first', () => {
  const at = (name: string, position: string, weaknesses: string[]) => {
    const c = card(name, [], weaknesses);
    c.basicInfo.position = position;
    return c;
  };
  const many = [
    at('A', 'Centre-Back', ['**Aerial Limitations:** a.']),
    at('B', 'Centre-Back', ['**Aerial Limitation:** b.']),
    at('C', 'Centre-Back', ['**Aerial Limitations:** c.', '**Slow Turn:** c.']),
    at('Subject', 'Centre-Back', ['**Aerial Limitations:** his own.']),
    at('D', 'Centre Forward', ['**Wasteful Finishing:** d.']),
    at('G', 'Defensive Midfielder/Centre-Back', ['**Slow Over Ten Yards:** g.']),
  ];
  const subject = at('Subject', 'Centre-Back', ['**Own:** x.']);
  const written = [at('E', 'Centre-Back', ['**Stretched Wide:** Pulled into the channels.']), at('F', 'Centre Forward', ['**Low Block Struggles:** f.'])];
  const taken = takenTraitTitles(subject, many, written);
  // On three other players' cards; his own card doesn't add a fourth.
  assert.deepEqual(taken.common.weakness, [{ title: 'Aerial Limitations', players: 3 }]);
  assert.deepEqual(taken.common.strength, []);
  // Cards sharing a position only, the run's rewrites first, each title once, never his own.
  assert.deepEqual(taken.nearby.weakness, [
    'Stretched Wide (Pulled into the channels.)',
    'Aerial Limitations (a.)',
    'Aerial Limitation (b.)',
    'Slow Turn (c.)',
    'Slow Over Ten Yards (g.)',
  ]);
  // A second call on the same pool reads the counted clusters again.
  assert.equal(takenTraitTitles(subject, many).common.weakness[0].players, 3);
});

await test('no stock lines and no weaknesses means no call; a failed call keeps the card as written', async () => {
  const clean = card('Subject', ['**Own Strength:** kept.'], []);
  assert.equal(await reviseCardTraits(clean, pool, ''), clean);
  assert.equal(geminiPrompts.length, 0);

  // A card whose weaknesses all meet the rules comes back unchanged.
  const fine = card('Subject', ['**Own Strength:** kept.'], ['**Own Weakness:** kept.']);
  geminiReplyText = JSON.stringify({ revisions: [] });
  assert.deepEqual(await reviseCardTraits(fine, pool, ''), fine);
  assert.equal(geminiPrompts.length, 1);

  const stocky = card('Subject', [], ['**Aerial Limitations:** small.']);
  geminiReplyText = null;
  const kept = await reviseCardTraits(stocky, pool, '');
  assert.deepEqual(kept.weaknesses, stocky.weaknesses);
});

await test('the backfill groups a pointer and its archive row as one card and skips personal revisions', () => {
  const messi = card('Subject', ['**A:** a.'], ['**Aerial Limitations:** small.']);
  const groups = groupCards([
    { player_slug: 'prime-subject', player_data: messi },
    { player_slug: 'subject--prime--2012-05-25', player_data: structuredClone(messi) },
    { player_slug: 'subject--prime--2012-05-25--rev-abc', player_data: messi },
    { player_slug: 'subject', player_data: card('Subject', ['**B:** b.'], ['**C:** c.']) },
    { player_slug: 'empty', player_data: {} as PlayerProfile },
  ]);
  assert.deepEqual(
    groups.map((g) => g.slugs),
    [['prime-subject', 'subject--prime--2012-05-25'], ['subject']],
  );
});

await test("the backfill reads an old card's own prose as its evidence", () => {
  const old = {
    ...card('Subject', [], []),
    version: { type: 'prime', peakContext: 'Best years.' },
    scoutingDebate: { caseForHigher: 'Higher case.', caseForLower: 'Lower case.' },
    definingMoments: [{ year: 2011, title: 'Final', description: 'Scored.' }],
  } as unknown as PlayerProfile;
  const evidence = cardEvidence(old);
  for (const part of ['Best years.', 'Bio: Bio.', 'Lower case.', 'Defining moment (2011): Final. Scored.']) {
    assert.ok(evidence.includes(part), part);
  }
});

await test('the backfill proposes only cards whose rewrite changed something', async () => {
  const stocky = { slugs: ['subject'], card: card('Subject', ['**Own:** kept.'], ['**Aerial Limitations:** small.', '**Own Weakness:** kept.']) };
  geminiReplyText = JSON.stringify({
    revisions: [{ id: 'W1', drop: false, title: 'Loses The Second Ball', detail: 'Steps off after the first contact', consequence: 'Opponents keep the ball' }],
  });
  const written: PlayerProfile[] = [];
  const entry = await proposeEntry(stocky, pool, written);
  assert.ok(entry);
  // The rewritten card is passed on to the cards after it.
  assert.equal(written.length, 1);
  assert.equal(written[0].weaknesses[0], entry!.after.weaknesses[0]);
  assert.deepEqual(entry!.slugs, ['subject']);
  assert.equal(entry!.after.weaknesses[0], '**Loses The Second Ball:** Steps off after the first contact. Opponents keep the ball.');
  assert.match(reportMarkdown([entry!]), /~~\*\*Aerial Limitations:\*\* small\.~~/);

  geminiPrompts = [];
  assert.equal(await proposeEntry({ slugs: ['x'], card: card('Subject', ['**Own:** a.'], []) }, pool), null);
  assert.equal(geminiPrompts.length, 0);
  geminiReplyText = JSON.stringify({ revisions: [] });
  assert.equal(await proposeEntry({ slugs: ['x'], card: card('Subject', ['**Own:** a.'], ['**Own Weakness:** b.']) }, pool), null);
  assert.equal(geminiPrompts.length, 1);
  geminiReplyText = null;
  assert.equal(await proposeEntry(stocky, pool), null);
});

await test('applying writes only rows that still hold the proposed-from lines, and reports a refused write', async () => {
  const before = card('Subject', ['**S:** s.'], ['**W:** w.']);
  const rows = new Map<string, PlayerProfile>([
    ['a', structuredClone(before)],
    ['b', { ...structuredClone(before), weaknesses: ['**Changed Since:** x.'] }],
    ['frozen', structuredClone(before)],
  ]);
  const writes: string[] = [];
  const store: CardStore = {
    read: async (slug) => rows.get(slug) ?? null,
    write: async (slug, next) => {
      writes.push(slug);
      if (slug === 'frozen') return rows.get(slug)!; // the trigger skipped it
      rows.set(slug, next);
      return next;
    },
  };
  const entry: BackfillEntry = {
    player: 'Subject',
    edition: 'Prime',
    slugs: ['a', 'b', 'frozen', 'gone'],
    before: { strengths: before.strengths, weaknesses: before.weaknesses },
    after: { strengths: before.strengths, weaknesses: ['**New:** n.'] },
  };
  assert.deepEqual(await applyEntry(store, entry), { a: 'updated', b: 'changed_since', frozen: 'blocked', gone: 'missing' });
  assert.deepEqual(writes, ['a', 'frozen']);
  assert.deepEqual(rows.get('a')!.weaknesses, ['**New:** n.']);
  assert.equal(rows.get('a')!.ratings.overall, 88);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
