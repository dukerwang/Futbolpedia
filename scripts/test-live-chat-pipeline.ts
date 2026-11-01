#!/usr/bin/env npx tsx
/**
 * Offline end-to-end check for a chat question about the present: sendMessageToAI runs for real,
 * with Gemini and the live football routes faked at the fetch layer (no network, Supabase or API
 * keys). It checks that the brief plans facts and analysis, the analysis search reads its sources
 * against the live facts, reflect sets aside a stale tactical piece, and the writer gets a dated
 * situation snapshot with the first-choice XI and what changed.
 *
 * Usage:
 *   npx tsx scripts/test-live-chat-pipeline.ts
 */
import assert from 'node:assert/strict';
import { formatClubReport, type ClubMatch, type LiveClubReport } from '../services/liveFootball';

process.env.API_KEY = 'offline-test-key';

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

const match = (id: string, date: string): ClubMatch => ({
  id,
  date,
  competition: 'LaLiga',
  leagueSlug: 'esp.1',
  home: true,
  opponent: `Opponent ${id}`,
  completed: true,
  goalsFor: 2,
  goalsAgainst: 1,
  penaltiesFor: null,
  penaltiesAgainst: null,
});
const roles = ['G', 'LB', 'CD-L', 'CD-R', 'RB', 'DM', 'CM-L', 'CM-R', 'LF', 'F', 'RF'];
const names = ['Keeper', 'New Fullback', 'Centre Left', 'Centre Right', 'Right Back', 'Anchor', 'Eight One', 'Eight Two', 'Left Wing', 'Main Nine', 'Right Wing'];
const report: LiveClubReport = {
  team: 'Southside',
  league: 'LaLiga',
  lineups: ['m3', 'm2', 'm1'].map((id, i) => ({
    match: match(id, `2026-10-${25 - i * 7}`),
    formation: '4-3-3',
    starters: roles.map((role, j) => ({ name: names[j], role })),
    subsUsed: [],
  })),
  results: ['m3', 'm2', 'm1'].map((id, i) => match(id, `2026-10-${25 - i * 7}`)),
  fixtures: [],
  fplPlayers: null,
  asOf: '2026-11-01',
};

const STALE_ANALYSIS = '[March 2025] Southside build up from a back three, with Departed Star as the left wing-back.';
interface Call {
  prompt: string;
  structured: boolean;
  search: boolean;
}
const calls: Call[] = [];
const liveAsked: string[] = [];

const respond = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.startsWith('/api/live/club')) {
    liveAsked.push(url);
    return new Response(JSON.stringify({ found: true, team: report.team, league: report.league, text: formatClubReport(report), report, missing: [{ item: 'Injury list for Southside (no free source outside the Premier League)', status: 'not_covered' }] }));
  }
  if (url.startsWith('/api/live/player')) {
    liveAsked.push(url);
    return new Response(JSON.stringify({ found: false, status: 'not_covered', reason: 'not a Premier League player' }));
  }
  if (url.startsWith('/api/')) return new Response('{}', { status: 404 });
  if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);

  const body = JSON.parse(init?.body ?? '{}');
  const raw = JSON.stringify(body);
  const prompt = JSON.stringify([body.contents ?? '', body.systemInstruction ?? '']);
  const structured = raw.includes('responseSchema') || raw.includes('responseJsonSchema');
  const search = raw.includes('googleSearch') && !raw.includes('functionDeclarations');
  calls.push({ prompt, structured, search });

  if (prompt.includes('first-team head coach')) return respond('COACH: UNKNOWN | SINCE: UNKNOWN | PREVIOUS: UNKNOWN | SOURCE_DATE: UNKNOWN');
  if (search) {
    if (prompt.includes('tactical analysis')) return respond(STALE_ANALYSIS);
    if (prompt.includes('transfers')) return respond('[2026-08-20] Southside signed New Fullback from abroad.');
    return respond('[2026-10-28] Eight Two is out with an ankle injury.');
  }
  if (structured && prompt.includes('You are planning the research')) {
    return respond(
      JSON.stringify({
        understanding: 'How Southside build up now, from who plays',
        focus: 'What is new in the build-up this season, and why',
        timeframe: 'live',
        outline: ['What changed', 'First phase', 'Trade-offs'],
        calls: [
          { tool: 'web_search', subject: 'Southside transfers 2026-27', purpose: 'arrivals', stage: 'facts' },
          { tool: 'web_search', subject: 'Southside tactical analysis 2026-27', purpose: 'build-up', stage: 'analysis' },
        ],
      }),
    );
  }
  if (structured && prompt.includes('You are checking whether research')) {
    const stale = [...prompt.matchAll(/\[(E\d+)\] Web search — Southside tactical analysis/g)].map((m) => ({ id: m[1], reason: 'describes last season' }));
    return respond(JSON.stringify({ enough: true, discard: stale, calls: [], unresolved: [] }));
  }
  if (structured && prompt.includes('situation snapshot a football analyst')) {
    return respond(
      JSON.stringify({
        clubs: [{ club: 'Southside', changes: ['New Fullback signed in August'], distinctive: 'A back four this season after last season’s back three.', newsAbsences: [{ name: 'Eight Two', note: 'ankle (2026-10-28)' }], unknowns: [] }],
        players: [],
        unknowns: [],
      }),
    );
  }
  if (structured && prompt.includes('Classify')) {
    return respond(
      JSON.stringify({
        intent: 'tactical_chat',
        analyticalMode: 'tactical_or_system',
        targetPlayers: [],
        targetClubs: ['Southside'],
        searchQueries: [],
        reasoningComplexity: 'high',
        isHistorical: false,
        wantsRegeneration: false,
        needsSearch: true,
      }),
    );
  }
  if (structured) return respond('{}');
  return respond('New Fullback starts at left-back in a back four. They allow a PPDA of 8.4 when they press. Main Nine leads the line.');
}) as typeof fetch;

const { sendMessageToAI } = await import('../services/geminiService');
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { log, info, warn } = console;
  console.log = console.info = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, info, warn });
  }
};

await test('a question about the present researches facts, then analysis, and the writer argues from a dated snapshot', async () => {
  const stages: string[] = [];
  const reply = await quietly(() =>
    sendMessageToAI("Break down Southside's build-up shape this season", [], undefined, [], [], { onStageChange: (s) => stages.push(s) }),
  );
  // The pressing figure was never looked up, so its sentence goes; the rest stands.
  assert.equal(reply, 'New Fullback starts at left-back in a back four. Main Nine leads the line.');
  assert.ok(liveAsked.some((u) => u.includes('name=Southside')), 'the club was looked up live');
  assert.ok(stages.includes('Working out what the question needs...'));

  // The analysis search came with the live facts; the transfer search didn't.
  const analysisSearch = calls.find((c) => c.search && c.prompt.includes('Southside tactical analysis 2026-27'));
  assert.ok(analysisSearch, 'the analysis search ran');
  assert.match(analysisSearch.prompt, /Current facts from live match data[\s\S]*regular starters Keeper, New Fullback/);
  assert.match(analysisSearch.prompt, /describes an earlier team/);
  const transferSearch = calls.find((c) => c.search && c.prompt.includes('Southside transfers 2026-27'));
  assert.ok(transferSearch && !transferSearch.prompt.includes('Current facts from live match data'));

  const writer = calls.filter((c) => !c.structured && !c.search && !c.prompt.includes('first-team head coach')).at(-1)?.prompt ?? '';
  assert.match(writer, /<situation_snapshot>/);
  assert.match(writer, /A precise figure .* goes in only when one of those sources gives it; for standings call `get_league_table`/);
  const writerCall = calls.filter((c) => !c.structured && !c.search && !c.prompt.includes('first-team head coach')).at(-1);
  assert.ok(writerCall);
  assert.match(writer, /First-choice XI \(4-3-3, from the last 3 starting XIs\): G Keeper \(3\/3\) \| LB New Fullback/);
  assert.match(writer, /CM-R Eight Two \(3\/3, news reports him out: ankle/);
  assert.match(writer, /Changed since last season: New Fullback signed in August/);
  assert.match(writer, /Distinctive this season: A back four this season/);
  assert.match(writer, /What's distinctive this season, for the answer to lead with/);
  // The stale piece was set aside, and the injury gap reads as not covered.
  assert.doesNotMatch(writer, /Departed Star/);
  assert.match(writer, /\[Not covered\][^\]]*Injury list for Southside/);
  // The club's research pass and the search on the question went in with the turn's own lookups.
  assert.match(writer, /Web search — Southside transfers in and out and coaching changes since last season/);
  assert.match(writer, /Web search — Break down Southside's build-up shape this season/);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
