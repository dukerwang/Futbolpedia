#!/usr/bin/env npx tsx
/**
 * A handful of live Gemini calls through the app's own code paths, to compare models before a
 * switch: one prime-card synthesis (responseSchema), one evidence search (Google Search, 800-token
 * cap), the player identity lookup (512-token cap), the club coach lookup (120-token cap) and one
 * streaming chat turn with the full tool set. Every request is sent to the model named on the
 * command line; sampling is sent only if that model honors it, as in production.
 *
 * About 6 to 8 calls and 4 to 6 grounded searches per run (well under $0.20 on either model). It
 * spends the project's Gemini budget, which the live app shares, so it isn't part of `npm test`.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx tsx scripts/smoke-model.ts gemini-4-hydrogen [--out report.json]
 */
import { writeFileSync } from 'node:fs';

const model = process.argv[2];
if (!model) throw new Error('Usage: npx tsx scripts/smoke-model.ts <model-id> [--out file.json]');
const outIndex = process.argv.indexOf('--out');
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : null;
process.env.API_KEY ??= process.env.GEMINI_API_KEY;
if (!process.env.API_KEY) throw new Error('Set GEMINI_API_KEY');

// The app's live and history routes, answered in-process so the chat tools' relative fetches work.
const realFetch = globalThis.fetch;
const getJson = async (url: string) => {
  const res = await realFetch(url, {
    headers: { 'User-Agent': 'Futbolpedia-smoke/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const { createLiveFootball } = await import('../services/liveFootball');
const { createHistoryFootball } = await import('../services/historyFootball');
const { getRealWorldFootballSeason } = await import('../prompts/scoutCore');
const live = createLiveFootball(getJson);
const historyStore = new Map<string, any>();
const history = createHistoryFootball({
  getJson,
  store: { get: async (k) => historyStore.get(k), set: async (k, v) => void historyStore.set(k, v) },
  currentSeasonStart: () => getRealWorldFootballSeason().seasonStartYear,
});
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.startsWith('/api/')) {
    const u = new URL(url, 'http://local');
    const q = (k: string) => u.searchParams.get(k) ?? '';
    if (u.pathname === '/api/live/club') return json(await live.club(q('name')));
    if (u.pathname === '/api/live/player') return json(await live.player(q('name')));
    if (u.pathname === '/api/live/table') return json(await live.table(q('league'), q('country') || undefined));
    return new Response(JSON.stringify({ error: 'not available in the smoke runner' }), { status: 404 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { getAi, runGroundedSearch, generateProseTurn, getCurrentSeasonInfo } = await import('../services/aiClient');
const { getModelProfile, outputCap, samplingFor } = await import('../constants/modelProfiles');
const { synthesizePlayerDossier } = await import('../services/dossierSynthesizer');
const { getPlayerIdentity } = await import('../services/groundingService');
const { buildConversationalScoutInstruction } = await import('../prompts/chatPrompt');
const { ThinkingLevel } = await import('@google/genai');

interface CallLog {
  step: string;
  ms: number;
  firstChunkMs?: number;
  prompt?: number;
  cached?: number;
  thoughts?: number;
  output?: number;
  finish?: string;
  error?: string;
}
const calls: CallLog[] = [];
let step = '';
/** The production temperature of the current step, sent only when the model honors sampling. */
let stepTemperature = 0;

const usageOf = (res: any) => {
  const u = res?.usageMetadata ?? {};
  return {
    prompt: u.promptTokenCount,
    cached: u.cachedContentTokenCount ?? 0,
    thoughts: u.thoughtsTokenCount ?? 0,
    output: u.candidatesTokenCount,
    finish: res?.candidates?.[0]?.finishReason,
  };
};
const withModel = (req: any) => {
  const config = { ...(req.config ?? {}) };
  delete config.temperature;
  return { ...req, model, config: { ...config, ...samplingFor(model, stepTemperature) } };
};

// Every request, including the chat session's, goes through these two methods.
const models: any = getAi().models;
const generate = models.generateContent.bind(models);
const generateStream = models.generateContentStream.bind(models);
models.generateContent = async (req: any) => {
  const t0 = Date.now();
  try {
    const res = await generate(withModel(req));
    calls.push({ step, ms: Date.now() - t0, ...usageOf(res) });
    return res;
  } catch (e: any) {
    calls.push({ step, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 300) });
    throw e;
  }
};
models.generateContentStream = async (req: any) => {
  const t0 = Date.now();
  const stream = await generateStream(withModel(req));
  return (async function* () {
    let last: any;
    let firstChunkMs: number | undefined;
    for await (const chunk of stream) {
      firstChunkMs ??= Date.now() - t0;
      if (chunk.usageMetadata) last = chunk;
      yield chunk;
    }
    calls.push({ step, ms: Date.now() - t0, firstChunkMs, ...usageOf(last) });
  })();
};

const outputs: Record<string, unknown> = {};
async function run(name: string, temperature: number, fn: () => Promise<unknown>) {
  step = name;
  stepTemperature = temperature;
  const t0 = Date.now();
  try {
    outputs[name] = await fn();
  } catch (e: any) {
    outputs[name] = { error: String(e?.message ?? e).slice(0, 300) };
  }
  console.log(`${name}: ${Date.now() - t0} ms`);
}

console.log(`Model: ${model} (profile ${getModelProfile(model).family})`);

await run('synthesis', 0.35, async () => {
  const career = await history.playerCareer('Andrea Pirlo');
  const card = await synthesizePlayerDossier({
    rawMessage: 'rate Andrea Pirlo prime',
    isHistorical: true,
    foundationText: `<career_record>\n${JSON.stringify(career).slice(0, 8000)}\n</career_record>`,
    verifiedFacts: null,
    verifiedFactsBlock: '',
    lockedDossiersBlock: '',
    savedDossiersBlock: '',
    cardName: 'Andrea Pirlo',
  });
  return {
    version: card.version,
    position: card.basicInfo.position,
    ratings: card.ratings,
    tier: (card as any).calibration?.tierBand,
    strengths: card.strengths,
    weaknesses: card.weaknesses,
    shortBio: card.shortBio,
  };
});

await run('evidence_search', 0.1, () =>
  runGroundedSearch(`Arsenal team news and injuries ${getCurrentSeasonInfo().month} ${getCurrentSeasonInfo().year}`, {
    digest: 'evidence',
  }),
);

await run('player_identity', 0, () => getPlayerIdentity('zico'));

await run('coach_lookup', 0, async () => {
  const { month, year } = getCurrentSeasonInfo();
  // The same request as clubManagers.ts searchCurrentCoach.
  const res = await getAi().models.generateContent({
    model,
    contents: `As of ${month} ${year}, who is the current first-team head coach (manager) of Chelsea? Use the most recent reliable reports. If a caretaker or interim coach is in charge, name them. Reply with exactly one line and nothing else:
COACH: <full name or UNKNOWN> | SINCE: <appointment date YYYY-MM-DD or UNKNOWN> | PREVIOUS: <the head coach immediately before them, full name, or UNKNOWN> | SOURCE_DATE: <publication date of your most recent source YYYY-MM-DD or UNKNOWN>`,
    config: { maxOutputTokens: outputCap(model, 120), tools: [{ googleSearch: {} }], thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
  });
  return res.text ?? null;
});

await run('chat_stream', 0.55, async () => {
  const tools: string[] = [];
  let chunks = 0;
  const text = await generateProseTurn({
    message: 'Who has Arsenal started in goal in their last four matches, and how is their league form right now?',
    historyContents: [],
    systemInstruction: buildConversationalScoutInstruction(false),
    modelOverride: model,
    thinkingLevelOverride: 'low',
    toolMode: 'full',
    onToolCalls: (names) => tools.push(...names),
    onStreamChunk: () => void chunks++,
  });
  return { tools, chunks, text };
});

const report = { model, at: new Date().toISOString(), calls, outputs };
console.table(calls);
if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 2));
