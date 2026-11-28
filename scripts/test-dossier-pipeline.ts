#!/usr/bin/env npx tsx
/**
 * Offline end-to-end checks for the single-dossier pipeline: sendMessageToAI runs for real, with
 * Gemini answered by a fake at the fetch layer (no network, Supabase or API keys). They check
 * which version of a player gets rated: current form, prime, or a named season.
 *
 * Usage:
 *   npx tsx scripts/test-dossier-pipeline.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';
import { ATTRIBUTE_KEYS } from '../constants/ratingTiers';

process.env.API_KEY = 'offline-test-key';
import type { ClubManagerServer } from '../services/clubManagerServer';

interface Scenario {
  /** Reply text for the "still playing professionally?" check. */
  status: string;
  /** Digest text returned by grounded searches. */
  search: (query: string) => string;
  /** The prime window the model returns, given the synthesis prompt. */
  window?: (prompt: string) => { startSeason: string; endSeason: string };
  /** The model's peer placement on the synthesized card. */
  placement?: { betterThan: string[]; levelWith: string[]; notAsGoodAs: string[] };
  /** The name and club the model puts on the card. */
  name?: string;
  club?: string;
  /** API-Football's record for the player, if it has one. */
  apiPlayer?: { name: string; currentClub: string; age?: number };
  /** The turn classifier's answer, for messages no fast path routes. */
  route?: { intent: string; targetPlayers: string[] };
  /** What /api/live/player and /api/history/player answer; unset, they 404. */
  livePlayer?: { found: true; name: string; team: string; text: string };
  career?: { found: true; title: string; text: string; sources: string[]; missing: [] };
}

interface GeminiCall {
  prompt: string;
  maxOutputTokens?: number;
  structured: boolean;
}

let scenario: Scenario = { status: 'ACTIVE', search: () => '' };
let calls: GeminiCall[] = [];

const textOf = (body: any): string =>
  JSON.stringify([body.contents ?? '', body.systemInstruction ?? '']);

function fakeProfile(prompt: string) {
  const attributes = Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, 80]));
  const today = new Date().toISOString().slice(0, 10);
  const version = prompt.includes('ERA DATED CARD')
    ? {
        type: 'era',
        label: 'Era',
        evaluationDate: '2020-08-23',
        seasonOrEra: '2017-20',
        peakContext: 'Era note.',
        primeWindow: scenario.window?.(prompt) ?? { startSeason: '2017-18', endSeason: '2019-20' },
      }
    : prompt.includes('SEASON DATED CARD')
    ? { type: 'season_snapshot', label: 'Season (2005-06)', evaluationDate: '2006-05-17', seasonOrEra: '2005-06', peakContext: 'Season note.' }
    : prompt.includes('HISTORICAL / PRIME')
      ? {
          type: 'prime',
          label: 'Prime Zenith (2010-12)',
          evaluationDate: '2012-05-25',
          seasonOrEra: '2010-12',
          peakContext: 'Peak note.',
          primeWindow: scenario.window?.(prompt) ?? { startSeason: '2010-11', endSeason: '2011-12' },
        }
      // The model's own window is never used: code sets a current card's, and no other card has one.
      : { type: 'current', label: 'Current Form', evaluationDate: today, seasonOrEra: '2026-27', peakContext: null, formWindow: { from: '2001-01-01', to: '2002-01-01' } };
  return {
    calibration: {
      tierBand: '90_92_WORLD_CLASS',
      peerBenchmark: 'Peers.',
      signatureSpikes: ['vision', 'retention', 'firstTouch'],
      genuineFlaws: ['aerialProwess', 'strength'],
      verifiedCurrentHeadCoach: null,
      conflictingManagerReports: [],
      peerPlacement: scenario.placement ?? { betterThan: [], levelWith: [], notAsGoodAs: [] },
    },
    basicInfo: {
      name: scenario.name ?? 'Test Player',
      age: 28,
      nationality: 'Spain',
      club: scenario.club ?? 'FC Barcelona',
      primaryPosition: 'Central Midfielder',
      secondaryPosition: 'None',
      height: "5'7\"",
      weight: '150 lbs',
    },
    ratings: { overall: 91, potential: 91 },
    attributes,
    strengths: ['**A:** b.'],
    weaknesses: ['**C:** d.'],
    playstyleAndRole: { playstyle: { archetype: 'Test Archetype Mould', description: 'Prose.' }, bestRoles: ['Role'] },
    shortBio: 'Bio.',
    latestUpdate: 'Update.',
    version,
  };
}

function geminiReply(body: any): string {
  const prompt = textOf(body);
  const structured = JSON.stringify(body).includes('responseSchema') || JSON.stringify(body).includes('responseJsonSchema');
  calls.push({ prompt, maxOutputTokens: body.generationConfig?.maxOutputTokens, structured });
  if (prompt.includes('still playing professionally')) return scenario.status;
  if (prompt.includes('first-team head coach')) {
    return 'COACH: Test Coach | SINCE: UNKNOWN | PREVIOUS: UNKNOWN | SOURCE_DATE: UNKNOWN';
  }
  if (structured && prompt.includes("Classify the user's football scouting message")) {
    const route = scenario.route ?? { intent: 'tactical_chat', targetPlayers: [] };
    return JSON.stringify({
      analyticalMode: route.intent === 'single_dossier' ? 'dossier' : 'debate_or_verdict',
      targetClubs: [],
      searchQueries: [],
      reasoningComplexity: 'low',
      isHistorical: false,
      needsSearch: false,
      ...route,
    });
  }
  if (structured && prompt.includes('synthesis_instructions')) return JSON.stringify(fakeProfile(prompt));
  if (structured && prompt.includes('Rewrite the Latest Update')) {
    return JSON.stringify({ latestUpdate: 'Fresh news line.' });
  }
  if (structured) return '{}';
  return scenario.search(prompt);
}

let managers: ClubManagerServer | undefined;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.includes('generativelanguage.googleapis.com')) {
    const text = geminiReply(JSON.parse(init?.body ?? '{}'));
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: text ? [{ text }] : [] },
            finishReason: text ? 'STOP' : 'MAX_TOKENS',
            groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/source', title: 'Source' } }] },
          },
        ],
        usageMetadata: {},
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (url.startsWith('/api/football/player') && scenario.apiPlayer) {
    return new Response(JSON.stringify({ player: scenario.apiPlayer }), { status: 200 });
  }
  // The coach lookup runs on the server; the real one answers here, with Gemini faked above.
  if (url.startsWith('/api/clubs/manager')) {
    const { createClubManagerServer } = await import('../services/clubManagerServer');
    managers ??= createClubManagerServer({ db: null });
    const answer = await managers.get(new URL(url, 'http://local').searchParams.get('club'));
    return new Response(JSON.stringify({ manager: answer }), { status: 200 });
  }
  if (url.startsWith('/api/live/player') && scenario.livePlayer) {
    return new Response(JSON.stringify(scenario.livePlayer), { status: 200 });
  }
  if (url.startsWith('/api/history/player') && scenario.career) {
    return new Response(JSON.stringify(scenario.career), { status: 200 });
  }
  if (url.startsWith('/api/')) return new Response('{}', { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  calls = [];
  try {
    await fn();
    passes++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${(err as Error).stack ?? err}`);
  }
}

const synthesisPrompt = () => calls.find((c) => c.structured && c.prompt.includes('synthesis_instructions'))?.prompt ?? '';
const statusCalls = () => calls.filter((c) => c.prompt.includes('still playing professionally'));
const managerCalls = () => calls.filter((c) => c.prompt.includes('first-team head coach'));

async function main() {
  // Quiet the pipeline's perf and info logs.
  const log = console.log;
  const info = console.info;
  const quiet = () => {
    console.log = () => {};
    console.info = () => {};
  };
  const loud = () => {
    console.log = log;
    console.info = info;
  };
  const { sendMessageToAI } = await import('../services/geminiService');
  const rate = async (message: string, saved: PlayerProfile[] = []) => {
    quiet();
    try {
      return (await sendMessageToAI(message, [], undefined, [], saved)) as PlayerProfile;
    } finally {
      loud();
    }
  };

  await test('a retired player with no timeframe is rated at his prime', async () => {
    scenario = { status: 'RETIRED', search: () => '- Summary of the player.' };
    const card = await rate('Rate Andrés Iniesta');
    assert.equal(statusCalls().length, 1);
    assert.ok((statusCalls()[0].maxOutputTokens ?? 0) >= 100, 'status check leaves room for thinking tokens');
    assert.match(synthesisPrompt(), /HISTORICAL \/ PRIME/);
    assert.doesNotMatch(synthesisPrompt(), /CURRENT FORM DATED CARD/);
    assert.equal(card.version?.type, 'prime');
    assert.equal(card.clubManager, undefined);
    assert.equal(managerCalls().length, 0);
  });

  await test('an empty status reply still finds the retirement in the grounding', async () => {
    scenario = {
      status: '',
      search: (q) =>
        q.includes('current club as of')
          ? '- Retired from professional football in 2024 after a final spell abroad.'
          : '- Summary of the player.',
    };
    const card = await rate('Rate Xavi Hernández');
    assert.match(synthesisPrompt(), /HISTORICAL \/ PRIME/);
    assert.equal(card.version?.type, 'prime');
    assert.equal(card.clubManager, undefined);
  });

  await test('an active player gets a current-form card with a verified manager', async () => {
    scenario = { status: 'ACTIVE', search: () => '- Regular starter this season. Retired from international football last year.' };
    const card = await rate('Rate Cole Palmer');
    assert.match(synthesisPrompt(), /CURRENT FORM DATED CARD/);
    assert.equal(card.version?.type, 'current');
    assert.equal(card.clubManager?.name, 'Test Coach');
    const { formWindowFor, todayIso } = await import('../services/dossierCards');
    const window = formWindowFor(todayIso());
    assert.deepEqual(card.version?.formWindow, window);
    // Keys and the season label are unchanged by the window.
    assert.match(card.version?.id ?? '', new RegExp(`-current-${todayIso()}$`));
    assert.match(card.version?.label ?? '', /^Current Form \(/);
    const prompt = synthesisPrompt();
    // The rule, in the system instruction and this card's own instructions.
    assert.match(prompt, /Current form rates the level he has played at over the last 12 months/);
    assert.ok(prompt.includes(`THE FORM WINDOW (${window.from} to ${window.to})`));
    assert.match(prompt, /Matches within the window count equally/);
    assert.match(prompt, /Neither reputation lag nor reputation carry sets the band/);
    assert.doesNotMatch(prompt, /out of reputation lag/);
    assert.doesNotMatch(prompt, /do not undersell him/);
    // Both searches ask for the window, and neither adds a third.
    const queries = calls.filter((c) => !c.structured).map((c) => c.prompt);
    assert.equal(queries.filter((q) => q.includes('last 12 months')).length, 2);
    assert.ok(queries.some((q) => q.includes('award shortlists and placings')));
  });

  await test('a new card goes under the name he is known by, whatever he was called', async () => {
    scenario = {
      status: 'STATUS: RETIRED | KNOWN AS: Pelé | FULL NAME: Edson Arantes do Nascimento',
      search: () => '- Summary of the player.',
      // The model keeps the name it was asked about.
      name: 'Edson Arantes do Nascimento',
    };
    const card = await rate('Rate Edson Arantes do Nascimento');
    assert.match(synthesisPrompt(), /`basicInfo\.name` = \\"Pelé\\"/);
    assert.equal(card.basicInfo.name, 'Pelé');
    assert.equal(card.version?.type, 'prime');
    assert.match(card.version?.id ?? '', /^pele-prime-/);
  });

  await test('a surname that is also a ranking word still gets his dossier', async () => {
    scenario = {
      status: 'STATUS: RETIRED | KNOWN AS: George Best | FULL NAME: George Best',
      search: () => '- Summary of the player.',
      name: 'George Best',
      route: { intent: 'single_dossier', targetPlayers: ['George Best'] },
    };
    const card = await rate('rate george best');
    assert.equal(card.basicInfo?.name, 'George Best');
    assert.equal(card.version?.type, 'prime');
  });

  await test('a message that names no player is never rated as one', async () => {
    const { classifyTurn } = await import('../services/turnRouter');
    scenario = { status: 'ACTIVE', search: () => '', route: { intent: 'single_dossier', targetPlayers: [] } };
    const route = await classifyTurn({ message: 'yo what the fuck is happening', history: [], conversationDossiers: [], hasImage: false });
    assert.notEqual(route.intent, 'single_dossier');
    // A ranking question is still not a dossier, whoever the classifier names.
    scenario.route = { intent: 'single_dossier', targetPlayers: ['Lamine Yamal'] };
    const ranking = await classifyTurn({ message: 'Is Yamal the best RW in the world?', history: [], conversationDossiers: [], hasImage: false });
    assert.notEqual(ranking.intent, 'single_dossier');
  });

  await test('a name no footballer goes by gets a question back, not somebody else', async () => {
    scenario = { status: 'STATUS: NONE', search: () => '- Kylian Mbappé news.', name: 'Kylian Mbappé' };
    const reply = await rate('rate blorpington fizzwick');
    assert.equal(typeof reply, 'string');
    assert.match(reply as unknown as string, /couldn't find a footballer called "blorpington fizzwick"/);
    assert.equal(synthesisPrompt(), '');
  });

  await test('a manager who once played is rated as the player he was, even when current form is asked', async () => {
    scenario = {
      status: 'STATUS: RETIRED | KNOWN AS: Pep Guardiola | FULL NAME: Josep Guardiola Sala',
      search: () => '- Manager on a sabbatical after leaving his club.',
      name: 'Pep Guardiola',
    };
    const card = await rate('Rate Pep Guardiola right now');
    assert.match(synthesisPrompt(), /HISTORICAL \/ PRIME/);
    assert.doesNotMatch(synthesisPrompt(), /CURRENT FORM DATED CARD/);
    assert.equal(card.version?.type, 'prime');
  });

  await test('an inconclusive status still finds a playing career that ended in the grounding', async () => {
    scenario = {
      status: 'STATUS: UNKNOWN',
      search: (q) =>
        q.includes('current club as of') ? '- Has coached since he ended his playing career in 2006.' : '- Summary of the player.',
    };
    const card = await rate('Rate Xabi Alonso right now');
    assert.equal(card.version?.type, 'prime');
  });

  await test('a coach who never played professionally is never rated as a footballer', async () => {
    scenario = { status: 'STATUS: NOT A PLAYER | KNOWN AS: André Villas-Boas | FULL NAME: Luís André de Pina Cabral e Villas-Boas', search: () => '- Coach news.' };
    const reply = await rate('Rate André Villas-Boas');
    assert.equal(typeof reply, 'string');
    assert.match(reply as unknown as string, /never played professionally/);
    assert.equal(synthesisPrompt(), '');
  });

  await test('a named season gets a season card whatever his status', async () => {
    scenario = { status: 'RETIRED', search: () => '- That season in summary.' };
    const card = await rate('Rate Thierry Henry 2006');
    assert.match(synthesisPrompt(), /SEASON DATED CARD EVALUATION \(2006\)/);
    assert.equal(card.version?.type, 'season_snapshot');
    assert.equal(card.version?.formWindow, undefined);
    assert.doesNotMatch(synthesisPrompt(), /THE FORM WINDOW/);
    assert.equal(card.version?.seasonOrEra, '2005-06');
    assert.equal(card.clubManager, undefined);
  });

  await test('a named era gets an era card, with no manager', async () => {
    scenario = { status: 'ACTIVE', search: () => '- Those seasons in summary.', name: 'Neymar Jr', club: 'Paris Saint-Germain' };
    const card = await rate('rate the psg version of neymar');
    assert.match(synthesisPrompt(), /ERA DATED CARD EVALUATION \(\W*psg\W*\)/);
    assert.doesNotMatch(synthesisPrompt(), /CURRENT FORM DATED CARD/);
    assert.equal(card.version?.type, 'era');
    assert.equal(card.version?.qualifier, 'psg');
    assert.equal(card.version?.seasonOrEra, '2017-20');
    assert.equal(card.version?.label, 'Paris Saint-Germain era (2017-20)');
    assert.equal(card.basicInfo.club, 'Paris Saint-Germain');
    assert.equal(card.clubManager, undefined);
    assert.equal(managerCalls().length, 0);
  });

  await test('the same era asked another way is the stored card', async () => {
    scenario = { status: 'ACTIVE', search: () => '- Those seasons in summary.', name: 'Neymar Jr' };
    const card = await rate('rate neymar at paris saint-germain');
    assert.equal(synthesisPrompt(), '', 'no re-rating');
    assert.equal(card.version?.label, 'Paris Saint-Germain era (2017-20)');
  });

  await test('an era covering the same years as a stored card is that card', async () => {
    scenario = { status: 'ACTIVE', search: () => '- Those seasons in summary.', name: 'Neymar Jr' };
    const card = await rate("rate neymar's post-barcelona years");
    assert.match(synthesisPrompt(), /ERA DATED CARD EVALUATION \(\W*post-barcelona\W*\)/);
    assert.equal(card.version?.qualifier, 'psg', 'the published card for 2017-20');
  });

  await test('an era named after his current club is his current form', async () => {
    scenario = {
      status: 'ACTIVE',
      search: () => '- Regular starter this season.',
      name: 'Neymar Jr',
      club: 'Santos',
      apiPlayer: { name: 'Neymar Jr', currentClub: 'Santos', age: 34 },
    };
    const card = await rate('rate the santos version of neymar');
    assert.match(synthesisPrompt(), /CURRENT FORM DATED CARD/);
    assert.equal(card.version?.type, 'current');
    assert.equal(card.clubManager?.name, 'Test Coach');
  });

  await test("a current card names no manager when its club isn't the one API-Football registers", async () => {
    scenario = {
      status: 'ACTIVE',
      search: () => '- Regular starter this season.',
      name: 'Jordan Okafor',
      club: 'Paris Saint-Germain',
      apiPlayer: { name: 'Jordan Okafor', currentClub: 'Santos' },
    };
    const card = await rate('Rate Jordan Okafor');
    assert.equal(card.version?.type, 'current');
    assert.equal(card.clubManager, undefined);
  });

  await test('a saved current card has its week-old Latest Update rewritten, ratings untouched', async () => {
    scenario = { status: 'ACTIVE', search: () => '- Latest news.' };
    const { sanitizeProfileData } = await import('../services/dossierSynthesizer');
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const rated = daysAgo(8);
    const { CALIBRATION_EPOCH_MS } = await import('../services/dossierStore');
    const saved: PlayerProfile = {
      ...sanitizeProfileData({
        basicInfo: { name: 'Pedri', age: 23, nationality: 'Spain', club: 'FC Barcelona', position: 'Central Midfielder' },
        ratings: { overall: 89, potential: 92 },
      }),
      latestUpdate: 'Old news line.',
      evaluationDate: rated,
      // Rated on the current scale (cards from before the recalibration are never reused).
      createdAt: Math.max(Date.now() - 8 * 86_400_000, CALIBRATION_EPOCH_MS + 1),
      version: { id: `pedri-current-${rated}`, type: 'current', label: 'Current Form', evaluationDate: rated, seasonOrEra: '2026-27' },
    };
    const card = await rate('Rate Pedri', [saved]);
    assert.equal(card.latestUpdate, 'Fresh news line.');
    assert.equal(card.latestUpdateAsOf, new Date().toISOString().slice(0, 10));
    assert.equal(card.ratings.overall, 89);
    assert.equal(card.version?.evaluationDate, rated);
    assert.equal(synthesisPrompt(), '', 'no re-rating');

    // A fresh one is served as is.
    calls = [];
    const fresh = await rate('Rate Pedri', [{ ...saved, latestUpdateAsOf: daysAgo(2) }]);
    assert.equal(fresh.latestUpdate, 'Old news line.');
    assert.equal(calls.length, 0);
  });

  await test('a prime is a window of seasons, and a career-length window is narrowed', async () => {
    scenario = {
      status: 'RETIRED',
      search: () => '- Summary of the player.',
      window: (prompt) =>
        prompt.includes('validation_retry')
          ? { startSeason: '2009-10', endSeason: '2011-12' }
          : { startSeason: '2006-07', endSeason: '2011-12' },
    };
    const card = await rate('Rate prime Andrés Iniesta');
    const syntheses = calls.filter((c) => c.structured && c.prompt.includes('synthesis_instructions'));
    assert.match(synthesisPrompt(), /THE PRIME IS A WINDOW/);
    assert.equal(syntheses.length, 2);
    assert.match(syntheses[1].prompt, /covers 6 seasons/);
    assert.equal(card.version?.type, 'prime');
    assert.equal(card.version?.seasonOrEra, '2009-12');
    assert.equal(card.version?.label, 'Prime Zenith (2009-12)');
    assert.deepEqual(card.version?.primeWindow, { startSeason: '2009-10', endSeason: '2011-12' });
  });

  await test('a one-season prime window is widened to a sustained stretch', async () => {
    scenario = {
      status: 'RETIRED',
      search: () => '- Summary of the player.',
      window: (prompt) =>
        prompt.includes('validation_retry')
          ? { startSeason: '2009-10', endSeason: '2010-11' }
          : { startSeason: '2010-11', endSeason: '2010-11' },
    };
    const card = await rate('Rate prime Andrés Iniesta');
    const syntheses = calls.filter((c) => c.structured && c.prompt.includes('synthesis_instructions'));
    assert.equal(syntheses.length, 2);
    assert.match(syntheses[1].prompt, /covers 1 season\./);
    assert.equal(card.version?.seasonOrEra, '2009-11');
  });

  await test('"rerate prime" regenerates from scratch; "rate prime" keeps the old card in view', async () => {
    const { sanitizeProfileData } = await import('../services/dossierSynthesizer');
    const { CALIBRATION_EPOCH_MS } = await import('../services/dossierStore');
    const oldPrime: PlayerProfile = {
      ...sanitizeProfileData({
        basicInfo: { name: 'Andrés Iniesta', age: 28, nationality: 'Spain', club: 'FC Barcelona', position: 'Central Midfielder' },
        ratings: { overall: 95, potential: 95 },
      }),
      evaluationDate: '2013-06-01',
      createdAt: CALIBRATION_EPOCH_MS + 1,
      version: { id: 'andres-iniesta-prime-2013-06-01', type: 'prime', label: 'Prime Zenith (2012-13)', evaluationDate: '2013-06-01', seasonOrEra: '2012-13' },
    };
    scenario = { status: 'RETIRED', search: () => '- Summary of the player.' };

    await rate('rate prime Andrés Iniesta', [oldPrime]);
    assert.match(synthesisPrompt(), /prior_authored_dossiers/);

    calls = [];
    const card = await rate('rerate prime Andrés Iniesta', [oldPrime]);
    assert.match(synthesisPrompt(), /HISTORICAL \/ PRIME/);
    assert.doesNotMatch(synthesisPrompt(), /prior_authored_dossiers/);
    assert.doesNotMatch(synthesisPrompt(), /Andrés Iniesta \[Prime/);
    assert.equal(card.version?.type, 'prime');
    assert.ok(typeof card.rerateAt === 'number' && card.rerateAt > CALIBRATION_EPOCH_MS);
  });

  await test('a rerate reads the closest peers at his position in full, never his own cards', async () => {
    const { sanitizeProfileData } = await import('../services/dossierSynthesizer');
    const { CALIBRATION_EPOCH_MS } = await import('../services/dossierStore');
    const prime = (name: string, position: string, overall: number, window: string): PlayerProfile => ({
      ...sanitizeProfileData({
        basicInfo: { name, age: 27, nationality: 'Spain', club: 'FC Barcelona', position },
        ratings: { overall, potential: overall },
        weaknesses: [`**Weakness of ${name}:** what he couldn't do.`],
      }),
      evaluationDate: '2010-05-27',
      createdAt: CALIBRATION_EPOCH_MS + 1,
      version: { id: `${name}-prime`, type: 'prime', label: `Prime Zenith (${window})`, evaluationDate: '2010-05-27', seasonOrEra: window },
    });
    const own = prime('Andrés Iniesta', 'Central Midfielder', 95, '2010-12');
    scenario = { status: 'RETIRED', search: () => '- Summary of the player.' };
    calls = [];
    await rate('rerate prime Andrés Iniesta', [own, prime('Peer Conductor', 'Central Midfielder', 94, '2008-10'), prime('Peer Keeper', 'Goalkeeper', 95, '2008-10')]);
    const prompt = synthesisPrompt();
    assert.match(prompt, /<closest_peers>[\s\S]*Peer Conductor[\s\S]*Weakness of Peer Conductor[\s\S]*<\/closest_peers>/);
    assert.doesNotMatch(prompt.slice(prompt.indexOf('<closest_peers>')), /Peer Keeper[\s\S]*<\/closest_peers>/);
    assert.doesNotMatch(prompt, /Weakness of Andrés Iniesta/);
    assert.match(prompt, /their ratings stay as they are/);
  });

  await test("a prime card's Overall agrees with its peer placement", async () => {
    const { sanitizeProfileData } = await import('../services/dossierSynthesizer');
    const { CALIBRATION_EPOCH_MS } = await import('../services/dossierStore');
    const peer: PlayerProfile = {
      ...sanitizeProfileData({
        basicInfo: { name: 'Peer Maestro', age: 27, nationality: 'Spain', club: 'FC Barcelona', position: 'Central Midfielder' },
        ratings: { overall: 91, potential: 91 },
      }),
      evaluationDate: '2009-05-27',
      createdAt: CALIBRATION_EPOCH_MS + 1,
      version: { id: 'peer-maestro-prime-2009-05-27', type: 'prime', label: 'Prime Zenith (2008-09)', evaluationDate: '2009-05-27', seasonOrEra: '2008-09' },
    };
    // The fake rates every card 91; the model says this one was the better footballer.
    scenario = {
      status: 'RETIRED',
      search: () => '- Summary of the player.',
      placement: { betterThan: ['Peer Maestro [Prime 2008-09]'], levelWith: [], notAsGoodAs: [] },
    };
    const card = await rate('Rate Andrés Iniesta', [peer]);
    assert.match(synthesisPrompt(), /calibrated_peer_ledger[\s\S]*Peer Maestro \[Prime 2008-09\][^\n]*91 OVR/);
    assert.match(synthesisPrompt(), /peerPlacement/);
    assert.equal(card.ratings.overall, 92);
    assert.equal(card.ratings.potential, 92);
    assert.deepEqual(card.peerPlacement?.betterThan, ['Peer Maestro (2008-09)']);
  });

  await test("a current card is rated from his live season record, with the gaps the lookups left", async () => {
    scenario = {
      status: 'ACTIVE',
      search: () => '- [2026-10-20] Recent form digest.',
      name: 'Marcus Okonkwo',
      apiPlayer: { name: 'Marcus Okonkwo', currentClub: 'FC Barcelona', age: 28 },
      livePlayer: { found: true, name: 'Marcus Okonkwo', team: 'Northside', text: 'Northside, Midfielder: 9 starts, 760 minutes, 2 goals.' },
    };
    const card = await rate('Rate Marcus Okonkwo');
    assert.equal(typeof card, 'object', String(card));
    const prompt = synthesisPrompt();
    assert.match(prompt, /Live player season \(FPL\)[^\n]*Marcus Okonkwo \(Northside\)/);
    assert.match(prompt, /9 starts, 760 minutes/);
    // The club route 404s in this test, so the lookup is a gap the card must not fill from memory.
    assert.match(prompt, /Lookup failed[^\n]*\\n- Live match data for Northside/);
    assert.match(prompt, /never fill them from memory/);
    // More data never turns the rating into a reading of figures.
    assert.match(prompt, /settle facts, not how good he is/);
    assert.match(prompt, /never a formula for it/);
  });

  await test("the bridge check's season draft is rated afresh with none of his own cards in view", async () => {
    const { draftBlindSeason } = await import('../services/geminiService');
    const { sanitizeProfileData } = await import('../services/dossierSynthesizer');
    const { CALIBRATION_EPOCH_MS } = await import('../services/dossierStore');
    const saved = (name: string, overall: number, version: PlayerProfile['version']): PlayerProfile => ({
      ...sanitizeProfileData({
        basicInfo: { name, age: 25, nationality: 'Spain', club: 'FC Barcelona', position: 'Central Midfielder' },
        ratings: { overall, potential: overall },
        weaknesses: [`**Weakness of ${name} ${overall}:** what he couldn't do.`],
      }),
      evaluationDate: version!.evaluationDate,
      createdAt: CALIBRATION_EPOCH_MS + 1,
      version,
    });
    const own = [
      saved('Ilan Moreau', 88, { id: 'a', type: 'current', label: 'Current Form', evaluationDate: '2026-10-25', seasonOrEra: '2026-27' }),
      saved('Ilan Moreau', 87, { id: 'b', type: 'season_snapshot', label: 'Season (2025-26)', evaluationDate: '2026-05-20', seasonOrEra: '2025-26' }),
    ];
    const peer = saved('Peer Pivot', 89, { id: 'c', type: 'prime', label: 'Prime Zenith (2018-20)', evaluationDate: '2020-05-20', seasonOrEra: '2018-20' });
    scenario = { status: 'ACTIVE', search: () => '- That season in summary.', name: 'Ilan Moreau' };
    quiet();
    let card: PlayerProfile;
    try {
      card = (await draftBlindSeason('Ilan Moreau', '2025-26', [...own, peer])) as PlayerProfile;
    } finally {
      loud();
    }
    const prompt = synthesisPrompt();
    assert.match(prompt, /SEASON DATED CARD EVALUATION \(2025-26\)/);
    assert.match(prompt, /Peer Pivot/);
    assert.doesNotMatch(prompt, /prior_authored_dossiers/);
    assert.doesNotMatch(prompt, /Ilan Moreau \[(?:Current|Season|Prime)|Weakness of Ilan Moreau/);
    // The season's saved card isn't served in place of a fresh draft.
    assert.equal(card.ratings.overall, 91);
    assert.equal(card.version?.type, 'season_snapshot');
  });

  await test("a current card reads his career record too, and its history never reads as a retirement", async () => {
    scenario = {
      status: 'STATUS: UNKNOWN',
      search: () => '- [2026-10-20] Recent form digest.',
      name: 'Tobias Brandt',
      career: { found: true, title: 'Tobias Brandt', text: 'Joined after the club legend retired. 2025-26 Northside 34 apps 3 goals.', sources: ['https://example.com/career'], missing: [] },
    };
    const card = await rate('Rate Tobias Brandt right now');
    assert.match(synthesisPrompt(), /Career record \(Wikipedia\)[^\n]*Tobias Brandt/);
    assert.match(synthesisPrompt(), /2025-26 Northside 34 apps/);
    assert.match(synthesisPrompt(), /CURRENT FORM DATED CARD/);
    assert.equal(card.version?.type, 'current');
  });

  await test("a prime is rated from his career record", async () => {
    scenario = {
      status: 'RETIRED',
      search: () => '- Summary of the player.',
      career: { found: true, title: 'Andrés Iniesta', text: 'Season by season: 2008-09 Barcelona 26 apps 4 goals.', sources: ['https://en.wikipedia.org/wiki/Andr%C3%A9s_Iniesta'], missing: [] },
    };
    await rate('Rate Andrés Iniesta');
    assert.match(synthesisPrompt(), /Career record \(Wikipedia\)[^\n]*Andrés Iniesta/);
    assert.match(synthesisPrompt(), /2008-09 Barcelona 26 apps/);
    assert.match(synthesisPrompt(), /settle facts, not how good he is/);
    assert.match(synthesisPrompt(), /choose the seasons when he played his best football/);
  });

  console.log(`${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
