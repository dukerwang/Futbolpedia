#!/usr/bin/env npx tsx
/**
 * Offline checks for the scout's day, with the model, the builders, the stores and the clock
 * faked: the tallies (names only, a seven-day window), the signals summary built from seeded
 * tallies and rows, the planning call (it gets the budget and the signals) and the code that
 * validates what it returns, execution that stops at the budget and carries on past a failed
 * action, one pass a day across ticks and restarts, the notes landing in the evidence ledger and
 * past the figure gate, a Latest Update refresh and its write check, and the journal route.
 *
 * Usage:
 *   npx tsx scripts/test-scout-day.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { PlayerProfile } from '../types';
import { createClubSnapshotStore, type SnapshotRow } from '../services/clubSnapshots';
import { emptyLedger, formatLedger } from '../services/evidenceLedger';
import { gateUnsupportedFigures } from '../services/figureGate';
import { runResearch, type ResearchModel } from '../services/researchAgent';
import type { ResearchToolset, ToolOutcome } from '../services/researchTools';
import {
  ACTION_COST,
  buildPlanPrompt,
  createScoutDay,
  createScoutTally,
  executePlan,
  gatherSignals,
  liveScoutActors,
  memoryScoutStores,
  pastSeason,
  refreshLatestUpdateWith,
  sanitizePlan,
  scoutJournalHandler,
  type ActionResult,
  type PlanInput,
  type ScoutActors,
  type ScoutPlan,
  type ScoutSignals,
  type ScoutSources,
} from '../services/scoutDay';
import { fileScoutNotes, scoutNoteEntry, type ScoutNote, type ScoutNoteSource } from '../services/scoutNotes';

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).stack ?? err}`);
  }
}
// The code under test logs a [scout-day] line per step; keep the output to the checks.
const realLog = console.log;
const realWarn = console.warn;
console.log = (...args: unknown[]) => (typeof args[0] === 'string' && args[0].startsWith('[scout-day]') ? undefined : realLog(...args));
console.warn = (...args: unknown[]) => (typeof args[0] === 'string' && args[0].startsWith('[scout-day]') ? undefined : realWarn(...args));

// --- A clock and seeded data ------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-25T09:00:00Z');
const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysAgo = (n: number) => dayStr(T0 - n * DAY);

/** A card outline as the card query returns it. */
const card = (name: string, club: string, opts: { evaluated: string; updated?: string; prime?: boolean; revision?: boolean }): PlayerProfile =>
  ({
    basicInfo: { name, club, position: 'Midfielder' },
    ratings: { overall: 80, potential: 82 },
    version: opts.prime ? { type: 'prime' } : undefined,
    createdAt: Date.parse(`${opts.evaluated}T12:00:00Z`),
    evaluationDate: opts.evaluated,
    latestUpdateAsOf: opts.updated,
    latestUpdate: 'News.',
    ...(opts.revision ? { revision: { revisedAt: 1 } } : {}),
  }) as unknown as PlayerProfile;

function seededTally() {
  const tally = createScoutTally(() => T0);
  for (let i = 0; i < 5; i++) tally.club('Northgate FC');
  for (let i = 0; i < 2; i++) tally.club('Southvale United');
  tally.club('Eastport City');
  for (let i = 0; i < 4; i++) tally.player('Ada Winger');
  tally.player('Bo Keeper');
  tally.season('Northgate FC', '2003-04');
  tally.season('Northgate FC', '2003-04');
  tally.gap('Injury list for Northgate FC (lookup failed)', 'failed');
  tally.gap('Injury list for Northgate FC (lookup failed)', 'failed');
  tally.gap('Injury list for Southvale United (no free source)', 'not_covered');
  tally.gap('Starting XIs for Eastport City (ESPN had none)', 'empty');
  return tally;
}

const sources = (over: Partial<ScoutSources> = {}): ScoutSources => ({
  tally: seededTally(),
  snapshots: async () => [
    { club: 'Northgate FC', builtAt: new Date(T0 - 2 * DAY).toISOString() },
    { club: 'Southvale United', builtAt: new Date(T0 - 3_600_000).toISOString() },
    { club: 'Eastport City', builtAt: new Date(T0 - 5 * DAY).toISOString() },
  ],
  latestScored: async (club) =>
    club === 'Northgate FC'
      ? { kickoff: `${daysAgo(3)}T15:00:00Z`, opponent: 'Rivals', namesRight: 7 }
      : club === 'Eastport City'
        ? { kickoff: `${daysAgo(4)}T15:00:00Z`, opponent: 'Others', namesRight: 10 }
        : null,
  nextFixture: async (club) =>
    club === 'Northgate FC'
      ? { kickoff: new Date(T0 + 30 * 3_600_000).toISOString(), opponent: 'Rivals', competition: 'League' }
      : club === 'Southvale United'
        ? { kickoff: new Date(T0 + 3 * DAY).toISOString(), opponent: 'Far Away', competition: 'League' }
        : null,
  cards: async () => [
    card('Ada Winger', 'Northgate FC', { evaluated: daysAgo(28), updated: daysAgo(9) }), // nearing, old line
    card('Bo Keeper', 'Southvale United', { evaluated: daysAgo(10), updated: daysAgo(2) }), // fine
    card('Cy Striker', 'Eastport City', { evaluated: daysAgo(12), updated: daysAgo(8) }), // old line
    card('Di Prime', 'Northgate FC', { evaluated: daysAgo(40), prime: true }), // prime: never
    card('Ed Revised', 'Northgate FC', { evaluated: daysAgo(28), revision: true }), // personal revision: never
    card('Flo Expired', 'Northgate FC', { evaluated: daysAgo(45), updated: daysAgo(40) }), // window closed
  ],
  ...over,
});

// --- Tallies ----------------------------------------------------------------------------------

await test('tallies count the names routes resolved over seven days, most first, and keep gaps by text', () => {
  let clock = T0;
  const tally = createScoutTally(() => clock);
  tally.club('Northgate FC');
  tally.club('northgate fc');
  tally.player('Ada Winger');
  clock = T0 + 5 * DAY;
  tally.club('Northgate FC');
  tally.club('Southvale United');
  tally.gap('Injury list (lookup failed)', 'failed');
  tally.gap('Injury list (lookup failed)', 'failed');
  tally.gap('Anything', 'not_covered');
  tally.gap('Anything', 'found');
  assert.deepEqual(tally.demandClubs(), [{ name: 'Northgate FC', hits: 3 }, { name: 'Southvale United', hits: 1 }]);
  assert.deepEqual(tally.gaps(), [{ item: 'Injury list (lookup failed)', status: 'failed', count: 2 }]);
  // Day eight: the first day's hits have aged out; the later ones stay.
  clock = T0 + 7 * DAY;
  assert.deepEqual(tally.demandClubs(), [{ name: 'Northgate FC', hits: 1 }, { name: 'Southvale United', hits: 1 }]);
  assert.deepEqual(tally.demandPlayers(), []);
  clock = T0 + 13 * DAY;
  assert.deepEqual(tally.demandClubs(), []);
});

await test('a season is recorded as club and normalized period; a period that does not read is ignored', () => {
  const tally = createScoutTally(() => T0);
  tally.season('Northgate FC', '2003-2004');
  tally.season('Northgate FC', 'last year');
  assert.deepEqual(tally.demandSeasons(), [{ club: 'Northgate FC', season: '2003-04', hits: 1 }]);
});

// --- Signals ----------------------------------------------------------------------------------

await test('the summary is built from the tallies and rows: demand, stale stories, fixtures, cards, gaps', async () => {
  const s = await gatherSignals(sources(), T0);
  assert.equal(s.day, '2026-11-25');
  assert.deepEqual(s.demand.clubs.map((c) => `${c.name}:${c.hits}`), ['Northgate FC:5', 'Southvale United:2', 'Eastport City:1']);
  assert.deepEqual(s.demand.players.map((p) => p.name), ['Ada Winger', 'Bo Keeper']);
  assert.deepEqual(s.demand.seasons, [{ club: 'Northgate FC', season: '2003-04', hits: 2 }]);
  // Seven of eleven names is a miss of four; ten of eleven is a miss of one.
  assert.deepEqual(s.staleStories.map((c) => [c.club, c.missed, c.asked]), [['Northgate FC', 4, 5]]);
  // Only the fixture inside 48 hours counts, and the snapshot's age is flagged.
  assert.deepEqual(s.fixtures.map((f) => [f.club, f.snapshotOlderThanDay]), [['Northgate FC', true]]);
  assert.deepEqual(s.cards.nearingRefresh.map((c) => [c.player, c.days]), [['Ada Winger', 28]]);
  assert.deepEqual(s.cards.staleLatestUpdate.map((c) => [c.player, c.days]), [['Ada Winger', 9], ['Cy Striker', 8]]);
  // Only empty and failed gaps are kept; not_covered is not something to fill.
  assert.deepEqual(s.gaps.map((g) => [g.item, g.count]), [['Injury list for Northgate FC (lookup failed)', 2], ['Starting XIs for Eastport City (ESPN had none)', 1]]);
  assert.deepEqual(s.unread, []);
});

await test('lists are capped at twenty and ordered by how much a name was asked about', async () => {
  const tally = createScoutTally(() => T0);
  const outlines: PlayerProfile[] = [];
  for (let i = 0; i < 30; i++) {
    for (let k = 0; k < i; k++) tally.player(`Player ${i}`);
    outlines.push(card(`Player ${i}`, 'Northgate FC', { evaluated: daysAgo(10), updated: daysAgo(9) }));
  }
  const s = await gatherSignals(sources({ tally, cards: async () => outlines }), T0);
  assert.equal(s.cards.staleLatestUpdate.length, 20);
  assert.equal(s.cards.staleLatestUpdate[0].player, 'Player 29');
  assert.equal(s.demand.players.length, 20);
});

await test('a source that fails is listed as unread and the rest of the summary stands', async () => {
  const s = await gatherSignals(
    sources({
      cards: async () => {
        throw new Error('db down');
      },
      latestScored: async () => {
        throw new Error('record down');
      },
    }),
    T0,
  );
  assert.ok(s.unread.includes('cards'));
  assert.ok(s.unread.some((u) => u.startsWith('prediction record for')));
  assert.equal(s.fixtures.length, 1);
  assert.equal(s.demand.clubs.length, 3);
});

// --- The plan ---------------------------------------------------------------------------------

const signals = await gatherSignals(sources(), T0);

await test('the planning prompt carries the date, the budget, the costs and the signals, and no example names', () => {
  const prompt = buildPlanPrompt({ today: '2026-11-25', season: '2026-27', budget: 29, signals });
  assert.match(prompt, /Today is 2026-11-25, in the 2026-27 season/);
  assert.match(prompt, /You have 29 model calls/);
  assert.match(prompt, new RegExp(`About ${ACTION_COST.rebuild_snapshot} calls`));
  assert.match(prompt, /Leave budget unspent when nothing is worth it/);
  assert.match(prompt, /Northgate FC \(5\)/);
  assert.match(prompt, /Ada Winger \(Northgate FC\): line dated/);
  // The instructions (before the signals block) name no club or player.
  assert.doesNotMatch(prompt.split('<signals>')[0], /Northgate|Southvale|Ada Winger/);
});

await test('the plan is validated: unknown types, unknown names, bad seasons, repeats and extras are dropped', () => {
  const good = { reason: 'Because people ask.' };
  const raw = {
    summary: 'Northgate first.',
    actions: [
      { type: 'rebuild_snapshot', club: 'Northgate FC', ...good },
      { type: 'rebuild_snapshot', club: 'northgate fc', ...good }, // repeat
      { type: 'rebuild_snapshot', club: 'Invented Town', ...good }, // not in the signals
      { type: 'launch_missiles', club: 'Northgate FC', ...good }, // unknown type
      { type: 'build_era', club: 'Northgate FC', season: '2003-04', ...good },
      { type: 'build_era', club: 'Northgate FC', season: '2026-27', ...good }, // not a past season
      { type: 'build_era', club: 'Northgate FC', season: '1999-00', ...good }, // before the sources start
      { type: 'refresh_latest_update', player: 'Ada Winger', ...good },
      { type: 'refresh_latest_update', player: 'Bo Keeper', ...good }, // his line is fresh
      { type: 'research_note', subject: 'Eastport City', question: 'Who is injured?', ...good },
      { type: 'research_note', subject: 'Eastport City', question: '', ...good }, // no question
      { type: 'rebuild_snapshot', club: 'Southvale United' }, // no reason
    ],
  };
  const { plan, dropped } = sanitizePlan(raw, signals, { seasonStartYear: 2026 });
  assert.deepEqual(plan.actions.map((a) => a.type), ['rebuild_snapshot', 'build_era', 'refresh_latest_update', 'research_note']);
  assert.equal(dropped, 8);
  assert.equal(plan.summary, 'Northgate first.');
  // Without the right to write a card's pointer row, the refresh is not offered.
  const without = sanitizePlan(raw, signals, { seasonStartYear: 2026, canRefreshLatestUpdate: false });
  assert.ok(!without.plan.actions.some((a) => a.type === 'refresh_latest_update'));
});

await test('a plan is cut to twenty actions and a malformed answer is an empty plan', () => {
  const many = {
    summary: 's',
    actions: Array.from({ length: 30 }, (_, i) => ({ type: 'research_note', subject: `Subject ${i}`, question: `Question ${i}`, reason: 'r' })),
  };
  const { plan, dropped } = sanitizePlan(many, signals);
  assert.equal(plan.actions.length, 20);
  assert.equal(dropped, 10);
  const none = sanitizePlan({ nonsense: true }, signals);
  assert.deepEqual(none.plan.actions, []);
  assert.match(none.plan.summary, /Nothing is worth/);
  assert.equal(pastSeason('2024-25', 2026), '2024-25');
  assert.equal(pastSeason('2024-2026', 2026), null);
});

// --- Execution --------------------------------------------------------------------------------

const plan = (actions: ScoutPlan['actions']): ScoutPlan => ({ summary: 'test', actions });
const ok = (calls: number, detail = 'done'): ActionResult => ({ ok: true, calls, detail });
const fakeActors = (log: string[] = [], over: Partial<ScoutActors> = {}): ScoutActors => ({
  rebuildSnapshot: async (c) => (log.push(`rebuild:${c}`), ok(4)),
  buildEra: async (c, s) => (log.push(`era:${c}:${s}`), ok(3)),
  refreshLatestUpdate: async (p) => (log.push(`refresh:${p}`), ok(2)),
  researchNote: async (s, q) => (log.push(`note:${s}:${q}`), ok(1)),
  ...over,
});
const actions = {
  rebuild: (club: string) => ({ type: 'rebuild_snapshot' as const, club, reason: 'r' }),
  note: (subject: string) => ({ type: 'research_note' as const, subject, question: 'q', reason: 'r' }),
  refresh: (player: string) => ({ type: 'refresh_latest_update' as const, player, reason: 'r' }),
};

await test('execution stops at the budget mid-list and records the rest as skipped', async () => {
  const log: string[] = [];
  const out = await executePlan(plan([actions.rebuild('A'), actions.rebuild('B'), actions.rebuild('C'), actions.rebuild('D')]), fakeActors(log), 8);
  assert.deepEqual(log, ['rebuild:A', 'rebuild:B']);
  assert.equal(out.spent, 8);
  assert.deepEqual(out.skipped.map((s) => [s.index, s.action.type]), [[2, 'rebuild_snapshot'], [3, 'rebuild_snapshot']]);
  assert.match(out.skipped[0].reason, /budget spent \(8 of 8/);
});

await test('an action that no longer fits is skipped and a cheaper one further down still runs', async () => {
  const log: string[] = [];
  const out = await executePlan(plan([actions.rebuild('A'), actions.rebuild('B'), actions.note('C')]), fakeActors(log), 6);
  assert.deepEqual(log, ['rebuild:A', 'note:C:q']);
  assert.equal(out.spent, 5);
  assert.deepEqual(out.skipped.map((s) => s.index), [1]);
  assert.match(out.skipped[0].reason, /about 4 calls with 2 left/);
});

await test("an action's real call count is what is charged, not the estimate", async () => {
  const log: string[] = [];
  const cheap = fakeActors(log, { rebuildSnapshot: async (c) => (log.push(`rebuild:${c}`), ok(0, 'already fresh')) });
  const out = await executePlan(plan([actions.rebuild('A'), actions.rebuild('B'), actions.rebuild('C')]), cheap, 4);
  assert.deepEqual(log, ['rebuild:A', 'rebuild:B', 'rebuild:C']);
  assert.equal(out.spent, 0);
});

await test('a failed action does not stop the pass and is charged its estimate', async () => {
  const log: string[] = [];
  const failing = fakeActors(log, {
    rebuildSnapshot: async () => {
      throw new Error('search refused');
    },
  });
  const out = await executePlan(plan([actions.rebuild('A'), actions.note('B'), actions.refresh('C')]), failing, 30);
  assert.deepEqual(log, ['note:B:q', 'refresh:C']);
  assert.deepEqual(out.ran.map((r) => [r.index, r.ok, r.calls]), [[0, false, 4], [1, true, 1], [2, true, 2]]);
  assert.match(out.ran[0].detail, /search refused/);
  assert.equal(out.spent, 7);
});

await test('actions an interrupted pass already ran are neither repeated nor charged twice', async () => {
  const log: string[] = [];
  const done = [{ index: 0, action: actions.rebuild('A'), ok: true, calls: 4, detail: 'done', ms: 1 }];
  const out = await executePlan(plan([actions.rebuild('A'), actions.note('B')]), fakeActors(log), 30, { done });
  assert.deepEqual(log, ['note:B:q']);
  assert.equal(out.spent, 5);
  assert.deepEqual(out.ran.map((r) => r.index), [0, 1]);
});

// --- The pass, its schedule and its journal ---------------------------------------------------

function harness(over: { now?: () => number; planRaw?: unknown; log?: string[]; budget?: number; stores?: ReturnType<typeof memoryScoutStores>; afterSweep?: Promise<unknown>; enabled?: boolean; canWrite?: boolean } = {}) {
  const stores = over.stores ?? memoryScoutStores();
  const inputs: PlanInput[] = [];
  const log = over.log ?? [];
  const day = createScoutDay({
    sources: sources(),
    model: {
      plan: async (input) => {
        inputs.push(input);
        return (
          over.planRaw ?? {
            summary: 'Northgate first.',
            actions: [
              { type: 'rebuild_snapshot', club: 'Northgate FC', reason: 'Asked about most; its record missed by four.' },
              { type: 'research_note', subject: 'Eastport City', question: 'Who is injured?', reason: 'The injury lookup keeps failing.' },
            ],
          }
        );
      },
    },
    actors: fakeActors(log),
    journal: stores.journal,
    budget: over.budget ?? 30,
    now: over.now ?? (() => T0),
    enabled: over.enabled,
    canWrite: over.canWrite,
    afterSweep: over.afterSweep,
  });
  return { day, stores, inputs, log };
}

await test('a pass plans with the budget, runs the plan and writes one journal row for the day', async () => {
  const h = harness();
  const row = await h.day.tick();
  assert.ok(row);
  assert.equal(h.inputs.length, 1);
  assert.equal(h.inputs[0].budget, 29, 'the planning call is part of the day budget');
  assert.equal(h.inputs[0].today, '2026-11-25');
  assert.deepEqual(h.log, ['rebuild:Northgate FC', 'note:Eastport City:Who is injured?']);
  const saved = await h.stores.journal.get('2026-11-25');
  assert.equal(saved?.status, 'done');
  assert.equal(saved?.calls_spent, 1 + 4 + 1);
  assert.equal(saved?.budget, 30);
  assert.equal(saved?.plan.actions.length, 2);
  assert.equal(saved?.plan.actions[0].reason, 'Asked about most; its record missed by four.');
  assert.deepEqual(saved?.ran.map((r) => [r.calls, r.ok]), [[4, true], [1, true]]);
  assert.equal(saved?.signals.demand.clubs[0].name, 'Northgate FC');
});

await test('the pass runs once a day across ticks and restarts: a done row means done', async () => {
  const stores = memoryScoutStores();
  const first = harness({ stores });
  await first.day.tick();
  await first.day.tick();
  assert.equal(first.inputs.length, 1);
  // A restart is a new scheduler over the same journal.
  const restarted = harness({ stores });
  assert.equal(await restarted.day.tick(), null);
  assert.equal(restarted.inputs.length, 0);
  assert.deepEqual(restarted.log, []);
  // The next UTC day runs again.
  const tomorrow = harness({ stores, now: () => T0 + DAY });
  assert.ok(await tomorrow.day.tick());
  assert.equal(tomorrow.inputs[0].today, '2026-11-26');
  assert.equal((await stores.journal.recent(7)).length, 2);
});

await test('a pass that died resumes from its stored plan with the calls already spent; one still running is left alone', async () => {
  const stores = memoryScoutStores();
  const first = harness({ stores });
  await first.day.tick();
  const done = (await stores.journal.get('2026-11-25'))!;
  // Make it look as though the pass died after its first action.
  const interrupted = { ...done, status: 'running' as const, ran: done.ran.slice(0, 1), calls_spent: 5, updated_at: new Date(T0 - 3_600_000).toISOString() };
  await stores.journal.put(interrupted);
  const resumed = harness({ stores, now: () => T0 + 60_000 });
  const row = await resumed.day.tick();
  assert.equal(resumed.inputs.length, 0, 'the stored plan is reused, not re-planned');
  assert.deepEqual(resumed.log, ['note:Eastport City:Who is injured?']);
  assert.equal(row?.status, 'done');
  assert.equal(row?.calls_spent, 6);
  // A running row touched a moment ago belongs to a pass that is still going.
  await stores.journal.put({ ...interrupted, updated_at: new Date(T0 + 60_000).toISOString() });
  const other = harness({ stores, now: () => T0 + 120_000 });
  assert.equal(await other.day.tick(), null);
  assert.deepEqual(other.log, []);
});

await test('the pass waits for the prediction sweep, and is skipped when off or without a secret key', async () => {
  let release!: () => void;
  const sweep = new Promise<void>((r) => (release = r));
  const h = harness({ afterSweep: sweep });
  const pending = h.day.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.inputs.length, 0, 'planning has not started while the sweep runs');
  release();
  assert.ok(await pending);
  assert.equal(h.inputs.length, 1);

  const off = harness({ enabled: false });
  assert.equal(await off.day.tick(), null);
  assert.equal(off.inputs.length, 0);
  const noKey = harness({ canWrite: false });
  assert.equal(await noKey.day.tick(), null);
  assert.equal(noKey.inputs.length, 0);
  assert.equal(await noKey.stores.journal.get('2026-11-25'), null);
});

await test('overlapping ticks run one pass; an empty plan is still journaled; a failed planning call is retried then given up', async () => {
  const h = harness({ planRaw: { summary: 'Quiet day.', actions: [] } });
  const [a, b] = await Promise.all([h.day.tick(), h.day.tick()]);
  assert.equal([a, b].filter(Boolean).length, 1);
  const saved = await h.stores.journal.get('2026-11-25');
  assert.equal(saved?.calls_spent, 1);
  assert.deepEqual(saved?.plan.actions, []);

  const stores = memoryScoutStores();
  let calls = 0;
  const failing = createScoutDay({
    sources: sources(),
    model: {
      plan: async () => {
        calls++;
        throw new Error('model down');
      },
    },
    actors: fakeActors(),
    journal: stores.journal,
    now: () => T0,
  });
  assert.equal(await failing.tick(), null);
  assert.equal(await stores.journal.get('2026-11-25'), null, 'a failed plan is not journaled at first, so the next tick retries');
  assert.equal(await failing.tick(), null);
  const last = await failing.tick();
  assert.equal(last?.status, 'done');
  assert.match(last?.plan.error ?? '', /model down/);
  assert.equal(calls, 3);
  assert.equal(await failing.tick(), null);
  assert.equal(calls, 3);
});

// --- The live actors --------------------------------------------------------------------------

await test('a note is one dated search kept for its subject; a search with no answer is charged and kept for nothing', async () => {
  const stores = memoryScoutStores();
  const searches: string[] = [];
  const tools = {
    webSearch: async (q: string): Promise<ToolOutcome> => {
      searches.push(q);
      return q.includes('empty')
        ? { status: 'empty', result: null, missing: [] }
        : { status: 'found', result: { kind: 'web', label: q, content: '[2026-11-15] A key defender is back in training.', sources: ['Source (https://example.test/a)'] }, missing: [] };
    },
  };
  const actors = liveScoutActors({ snapshots: {} as any, tools, notes: stores.notes, client: null, now: () => T0 });
  const res = await actors.researchNote('Northgate FC', 'Who is back from injury?');
  assert.deepEqual([res.ok, res.calls], [true, 1]);
  assert.deepEqual(searches, ['Northgate FC: Who is back from injury?']);
  assert.equal(stores.notes.rows.length, 1);
  assert.deepEqual(
    { ...stores.notes.rows[0], note: '…' },
    { day: '2026-11-25', subject: 'Northgate FC', subject_key: 'northgate-fc', question: 'Who is back from injury?', note: '…', sources: ['Source (https://example.test/a)'] },
  );
  const none = await actors.researchNote('Northgate FC', 'empty question');
  assert.deepEqual([none.ok, none.calls], [false, 1]);
  assert.equal(stores.notes.rows.length, 1);
});

await test("a snapshot rebuild and an era build report the calls they really made", async () => {
  const snap = { club: 'Northgate FC', builtAt: '2026-11-25T09:00:00Z' } as any;
  const actors = liveScoutActors({
    snapshots: {
      rebuild: async (club: string) => (club === 'Northgate FC' ? { snapshot: snap, calls: 4 } : { snapshot: null, calls: 0 }),
      eraBuild: async (_k: string, subject: string) =>
        subject === 'Stored FC' ? { snapshot: { key: 'k' } as any, built: false, calls: 0 } : { snapshot: { key: 'club_season:northgate-fc:2003-04' } as any, built: true, calls: 3 },
    },
    tools: {} as any,
    notes: memoryScoutStores().notes,
    client: null,
  });
  assert.deepEqual(await actors.rebuildSnapshot('Northgate FC'), { ok: true, calls: 4, detail: 'Northgate FC rebuilt, built 2026-11-25T09:00' });
  assert.deepEqual(await actors.rebuildSnapshot('Nowhere'), { ok: false, calls: 0, detail: 'the live data has no such club' });
  assert.deepEqual(await actors.buildEra('Stored FC', '2003-04'), { ok: true, calls: 0, detail: 'already stored' });
  assert.deepEqual(await actors.buildEra('Northgate FC', '2003-04'), { ok: true, calls: 3, detail: 'club_season:northgate-fc:2003-04 stored' });
});

await test('a club store rebuild replaces a fresh snapshot and counts its searches and the story call', async () => {
  const writes: SnapshotRow[] = [];
  let researched = 0;
  const live: Promise<ToolOutcome> = Promise.resolve({ status: 'found', result: { kind: 'club_context', label: 'x', content: 'x', club: { team: 'Northgate FC' } as any }, missing: [] });
  const store = createClubSnapshotStore({
    read: async () => null,
    write: async (row) => void writes.push(row),
    research: async () => {
      researched++;
      return { calls: [{ tool: 'web_search', subject: 'a' }, { tool: 'web_search', subject: 'b' }, { tool: 'web_search', subject: 'c' }], outcomes: [] };
    },
    summarize: async () => ({ club: 'Northgate FC', league: 'League', core: {} as any, story: {} as any, sources: [], builtAt: new Date().toISOString(), version: 1 }),
  });
  const first = await store.rebuild('Northgate FC', live);
  assert.deepEqual([first.calls, !!first.snapshot], [4, true]);
  const second = await store.rebuild('Northgate FC', live);
  assert.deepEqual([second.calls, !!second.snapshot], [4, true], 'a fresh snapshot is rebuilt anyway');
  assert.equal(researched, 2);
  assert.equal(writes.length, 2);
  assert.deepEqual(await store.rebuild('Nowhere', Promise.resolve({ status: 'empty', result: null, missing: [] })), { snapshot: null, calls: 0 });
});

// --- A Latest Update refresh ------------------------------------------------------------------

/** A player_profiles table in memory with the trigger's behaviour switched on or off. */
function fakeCards(row: { player_data: PlayerProfile; updated_at: string }, trigger: 'allows' | 'skips') {
  const state = { row, updates: 0 };
  const query = () => {
    const q: any = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: state.row, error: null }),
      update: (patch: { player_data: PlayerProfile; updated_at: string }) => {
        state.updates++;
        if (trigger === 'allows') state.row = { player_data: patch.player_data, updated_at: patch.updated_at };
        return { eq: async () => ({ error: null }) };
      },
    };
    return q;
  };
  return { state, client: { from: () => query() } };
}

await test('a refresh writes the new line when the row accepts it and says so when the trigger skips the write', async () => {
  const rewrite = async (c: PlayerProfile): Promise<PlayerProfile> => ({ ...c, latestUpdate: 'Fresh news.', latestUpdateAsOf: '2026-11-25' });
  const base = { player_data: card('Ada Winger', 'Northgate FC', { evaluated: daysAgo(10), updated: daysAgo(9) }), updated_at: new Date(T0 - 9 * DAY).toISOString() };
  const accepted = fakeCards(base, 'allows');
  const done = await refreshLatestUpdateWith(accepted.client, 'Ada Winger', rewrite, T0);
  assert.deepEqual([done.ok, done.calls], [true, 2]);
  assert.equal(accepted.state.row.player_data.latestUpdate, 'Fresh news.');
  assert.equal(accepted.state.row.player_data.evaluationDate, daysAgo(10), 'the evaluation date, which the trigger keys on, is unchanged');

  const skipped = fakeCards(base, 'skips');
  const blocked = await refreshLatestUpdateWith(skipped.client, 'Ada Winger', rewrite, T0);
  assert.deepEqual([blocked.ok, blocked.calls], [false, 2]);
  assert.match(blocked.detail, /trigger/);

  // A card whose line is fresh is left alone and costs nothing.
  const fresh = fakeCards({ ...base, player_data: card('Ada Winger', 'Northgate FC', { evaluated: daysAgo(10), updated: daysAgo(1) }) }, 'allows');
  const left = await refreshLatestUpdateWith(fresh.client, 'Ada Winger', rewrite, T0);
  assert.deepEqual([left.ok, left.calls, fresh.state.updates], [false, 0, 0]);
});

// --- The scout's notes in the writer's evidence ----------------------------------------------

const today = new Date().toISOString().slice(0, 10);
const noteOn = (day: string, subject: string, note: string): ScoutNote => ({ day, subject, question: 'Who is injured?', note, sources: ['Source (https://example.test/a)'] });
const daysBefore = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const noteSource = (rows: ScoutNote[]): ScoutNoteSource => ({ forSubjects: async () => rows });

await test("the scout's notes for a subject are filed as dated scout_note evidence, within fourteen days", async () => {
  const rows = [
    noteOn(daysBefore(2), 'Northgate FC', '[2026-11-14] The captain has 7 league goals and is back in training.'),
    noteOn(daysBefore(20), 'Northgate FC', '[2026-10-01] An old note.'),
    noteOn(daysBefore(1), 'Somewhere Else', 'Another club entirely.'),
  ];
  const ledger = await fileScoutNotes(emptyLedger(), ['northgate fc'], noteSource(rows), today);
  assert.equal(ledger.entries.length, 1);
  const [entry] = ledger.entries;
  assert.equal(entry.kind, 'scout_note');
  assert.match(entry.label, new RegExp(`Northgate FC: Who is injured\\? \\(the scout's note of ${daysBefore(2)}\\)`));
  assert.match(entry.content, new RegExp(`Researched ${daysBefore(2)}`));
  assert.deepEqual(entry.sources, ['Source (https://example.test/a)']);
  assert.match(formatLedger(ledger), /\[E1\] The scout's note .* Northgate FC/);
  // Nothing for a subject with no note, and a failing table leaves the ledger as it was.
  assert.equal((await fileScoutNotes(emptyLedger(), ['Unknown FC'], noteSource([]), today)).entries.length, 0);
  const down: ScoutNoteSource = { forSubjects: async () => Promise.reject(new Error('down')) };
  assert.equal((await fileScoutNotes(emptyLedger(), ['Northgate FC'], down, today)).entries.length, 0);
});

await test('a figure only a scout note holds passes the figure gate, and one nothing holds does not', async () => {
  const ledger = await fileScoutNotes(emptyLedger(), ['Northgate FC'], noteSource([noteOn(daysBefore(1), 'Northgate FC', '[2026-11-15] The captain has 7 league goals this season.')]), today);
  const evidence = formatLedger(ledger);
  const kept = gateUnsupportedFigures('The captain has 7 league goals this season.', evidence);
  assert.equal(kept.removed.length, 0);
  const cut = gateUnsupportedFigures('The captain has 12 league goals this season.', evidence);
  assert.ok(cut.removed.length > 0);
});

await test('research files the notes of the clubs and players a turn opened beside their evidence', async () => {
  const report = { team: 'Northgate FC', league: 'League', fixtures: [], lineups: [], results: [] } as any;
  const tools = {
    clubRecentTeam: async (): Promise<ToolOutcome> => ({ status: 'found', result: { kind: 'club_context', label: 'Northgate FC: recent team', content: 'Recent XIs', club: report }, missing: [] }),
    playerSeason: async (): Promise<ToolOutcome> => ({ status: 'empty', result: null, missing: [] }),
    leagueTable: async (): Promise<ToolOutcome> => ({ status: 'empty', result: null, missing: [] }),
    webSearch: async (): Promise<ToolOutcome> => ({ status: 'empty', result: null, missing: [] }),
    card: async (): Promise<ToolOutcome> => ({ status: 'empty', result: null, missing: [] }),
    clubSeason: async (): Promise<ToolOutcome> => ({ status: 'empty', result: null, missing: [] }),
    playerCareer: async (): Promise<ToolOutcome> => ({ status: 'empty', result: null, missing: [] }),
  } as ResearchToolset;
  const asked: string[][] = [];
  const model: ResearchModel = {
    writeBrief: async () => ({ understanding: 'u', focus: '', timeframe: 'live', outline: [], calls: [{ tool: 'club_recent_team', subject: 'Northgate FC' }], unresolved: [] }),
    reflect: async () => ({ enough: true, calls: [], unresolved: [], discard: [] }),
  };
  const { ledger } = await runResearch(
    { message: 'How is Northgate FC doing?', thread: '', cardsInPlay: [], hints: { clubs: ['Northgate FC'], players: [] }, present: true },
    tools,
    {
      model,
      situationModel: { enrich: async () => ({ clubs: [], players: [], unknowns: [] }) },
      scoutNotes: {
        forSubjects: async (subjects) => {
          asked.push(subjects);
          return [noteOn(daysBefore(1), 'Northgate FC', '[2026-11-15] The captain is fit.')];
        },
      },
    },
  );
  assert.ok(asked.flat().includes('Northgate FC'));
  const entry = ledger.entries.find((e) => e.kind === 'scout_note');
  assert.ok(entry, 'the note reached the writer\'s ledger');
  assert.match(entry!.content, /The captain is fit/);
  assert.ok(scoutNoteEntry(noteOn('2026-11-15', 'X', 'n')).content.includes('2026-11-15'));
});

// --- The journal route ------------------------------------------------------------------------

await test('the journal route returns the last days, newest first, public and read-only', async () => {
  const stores = memoryScoutStores();
  for (let i = 0; i < 10; i++) {
    const h = harness({ stores, now: () => T0 + i * DAY, planRaw: { summary: `Day ${i}`, actions: [] } });
    await h.day.tick();
  }
  const day = createScoutDay({ sources: sources(), actors: fakeActors(), journal: stores.journal });
  const app = express();
  app.get('/api/scout/journal', scoutJournalHandler(day));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/api/scout/journal?days=3`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /public/);
    const body = (await res.json()) as { days: { day: string; plan: { summary: string }; status: string }[] };
    assert.deepEqual(body.days.map((d) => d.day), ['2026-12-04', '2026-12-03', '2026-12-02']);
    assert.equal(body.days[0].plan.summary, 'Day 9');
    const dflt = (await (await fetch(`${base}/api/scout/journal`)).json()) as { days: unknown[] };
    assert.equal(dflt.days.length, 7);
    const bad = (await (await fetch(`${base}/api/scout/journal?days=abc`)).json()) as { days: unknown[] };
    assert.equal(bad.days.length, 7);
    assert.equal((await fetch(`${base}/api/scout/journal`, { method: 'POST' })).status, 404);
  } finally {
    server.close();
  }
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
