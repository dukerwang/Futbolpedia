#!/usr/bin/env npx tsx
/**
 * Offline checks for the eval cost controls (`scripts/eval-guard.ts`, `eval-search-cache.ts`,
 * `eval-estimate.ts` and the runners that use them), with the model, fetch and clock faked. No call
 * reaches any network:
 *
 *  - the key: an eval refuses to start without EVAL_GEMINI_API_KEY (and never falls back to the live
 *    app's key), `--use-app-key` is the warned escape hatch, and the key reaches every model call
 *    the pipeline makes (checked on the real SDK's request headers with fetch faked);
 *  - the cap check stops before any other call, and a 429 mid-run stops the run and every later call;
 *  - no grader or figure-check call without `--grade` and `--figure-check`, and one run per
 *    historical question by default;
 *  - the search cache: a hit, a miss, a new day, a bypass, and the app ignoring it;
 *  - real usage counted from the model's usage metadata, per answer and in total;
 *  - the dry run for each set.
 *
 * Usage:
 *   npx tsx scripts/test-eval-costs.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@google/genai';
import { generateProseTurn, generateStructured, getAi, runGroundedSearch, setSearchCache } from '../services/aiClient';
import {
  EVAL_KEY_VAR,
  EvalCapError,
  EvalKeyError,
  addUsage,
  createUsageTally,
  emptyUsage,
  instrumentModels,
  isSpendLimit,
  parseEvalFlags,
  repeatFor,
  resolveEvalKey,
  startEvalSession,
  stoppedError,
  usageLine,
  usageSection,
  usageTotalsText,
  type ModelsLike,
  type StopState,
} from './eval-guard';
import { createFileSearchCache } from './eval-search-cache';
import { runPlainSet } from './eval-plain';
import { runRepeats, type EvalQuestion, type RunResult } from './eval-consistency';
import { checkFigures, FIGURE_LIST_INSTRUCTIONS, FIGURE_VERIFY_INSTRUCTIONS, HISTORY_GRADE_INSTRUCTIONS, runHistoricalSet } from './eval-history';
import { conversationTurnCounts, readConversations, runConversation, type ConversationCase } from './eval-conversations';
import { answersIn, estimateSet, readReportBaseline, type SetEstimateInput } from './eval-estimate';

// The eval's key and the live app's key, set before anything calls `getAi()`.
process.env.EVAL_GEMINI_API_KEY = 'eval-key-123';
process.env.GEMINI_API_KEY = 'app-key-999';
process.env.API_KEY = 'app-key-999';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'eval-costs-'));
/** Preloaded into every child process: any request to the model ends it with a marker, so a bug can't spend anything. */
const blocker = join(scratch, 'block-network.mjs');
writeFileSync(blocker, "globalThis.fetch = async (u) => { console.error('NETWORK ATTEMPT ' + u); process.exit(99); };\n");
const childEnv = (extra: Record<string, string>) => ({ ...process.env, NODE_OPTIONS: `--import ${blocker}`, ...extra });

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

const DAY1 = Date.parse('2026-11-18T10:00:00Z');
const DAY2 = Date.parse('2026-11-19T10:00:00Z');
const quiet = () => {};

/** A response the SDK reads as one generateContent answer. */
const answer = (text: string, extra: Record<string, unknown> = {}, usage: Record<string, number> = { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, cachedContentTokenCount: 10 }) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', ...extra }],
  usageMetadata: usage,
});
const limitError = (message: string, status = 429): Error => Object.assign(new Error(message), { status });
const CAP_MESSAGE = 'Your project has exceeded its monthly spending cap. Please go to AI Studio to manage your project spend cap.';

/** A fake model whose calls are scripted; every request it receives is recorded. */
function fakeModels(script: (req: any, n: number) => any | Promise<any>): ModelsLike & { requests: any[] } {
  const requests: any[] = [];
  return {
    requests,
    async generateContent(req: any) {
      requests.push(req);
      return script(req, requests.length);
    },
  };
}
const flagsOf = (...args: string[]) => parseEvalFlags(args);
/** Runs `fn` with the runners' progress lines (written straight to stdout) silenced. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = write;
  }
}

// --- The key ------------------------------------------------------------------------------------

await test('an eval refuses to start without EVAL_GEMINI_API_KEY, naming it, and never falls back to the live app key', () => {
  for (const env of [{}, { GEMINI_API_KEY: 'secret-app' }, { GEMINI_API_KEY: 'secret-app', API_KEY: 'secret-app' }, { EVAL_GEMINI_API_KEY: '  ', GEMINI_API_KEY: 'secret-app' }]) {
    assert.throws(
      () => resolveEvalKey(env, { useAppKey: false }),
      (e: any) => e instanceof EvalKeyError && e.message.includes(EVAL_KEY_VAR) && e.message.includes('--use-app-key') && !e.message.includes('secret-app'),
    );
  }
  assert.deepEqual(resolveEvalKey({ EVAL_GEMINI_API_KEY: 'eval', GEMINI_API_KEY: 'app' }, { useAppKey: false }), { key: 'eval', usingAppKey: false });
});

await test('--use-app-key is the explicit escape hatch: it uses the app key and warns that it spends the live budget', () => {
  const k = resolveEvalKey({ EVAL_GEMINI_API_KEY: 'eval', GEMINI_API_KEY: 'app' }, { useAppKey: true });
  assert.equal(k.key, 'app');
  assert.equal(k.usingAppKey, true);
  assert.match(k.warning!, /WARNING/);
  assert.match(k.warning!, /live app's Gemini budget/);
  assert.throws(() => resolveEvalKey({}, { useAppKey: true }), EvalKeyError);
});

await test('a session without a key throws before any model call; with --use-app-key it logs the warning and sets the key for this process only', async () => {
  const models = fakeModels(() => answer('ok'));
  const env: Record<string, string | undefined> = { GEMINI_API_KEY: 'app', API_KEY: 'app' };
  await assert.rejects(() => startEvalSession(flagsOf(), root, { env, models, log: quiet }), EvalKeyError);
  assert.equal(models.requests.length, 0, 'nothing was sent');
  assert.equal(env.API_KEY, 'app', 'the environment is untouched when the session refuses');

  const logged: string[] = [];
  const hatch: Record<string, string | undefined> = { GEMINI_API_KEY: 'app' };
  const session = await startEvalSession(flagsOf('--use-app-key', '--fresh-search'), root, { env: hatch, models, log: (l) => logged.push(l) });
  assert.equal(session.key.usingAppKey, true);
  assert.ok(logged.some((l) => /WARNING.*live app's Gemini budget/.test(l)));
  assert.equal(hatch.API_KEY, 'app');
  setSearchCache(null);

  const own: Record<string, string | undefined> = { EVAL_GEMINI_API_KEY: 'eval', GEMINI_API_KEY: 'app', API_KEY: 'app' };
  await startEvalSession(flagsOf('--fresh-search'), root, { env: own, models: fakeModels(() => answer('ok')), log: quiet });
  assert.equal(own.API_KEY, 'eval', 'the eval key replaces the app key in this process');
  assert.equal(own.GEMINI_API_KEY, 'eval', 'so a read of either name reaches the eval key, never the app key');
});

await test('every script refuses without the key: the runner and the smoke test exit 1, name the variable, and start nothing', () => {
  // Empty values count as set for the env-file reader, so a real .env.local on this machine can't supply a key.
  const env = childEnv({ EVAL_GEMINI_API_KEY: '', GEMINI_API_KEY: 'app-key-999', API_KEY: 'app-key-999' });
  for (const args of [['scripts/eval-live-questions.ts', '--only', '1'], ['scripts/eval-live-questions.ts', '--set', 'historical'], ['scripts/eval-live-questions.ts', '--conversations'], ['scripts/smoke-model.ts', 'gemini-test']]) {
    const out = spawnSync('npx', ['tsx', ...args], { cwd: root, env, encoding: 'utf8', timeout: 90_000 });
    assert.equal(out.status, 1, `${args.join(' ')}: ${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /EVAL_GEMINI_API_KEY is not set/);
    assert.doesNotMatch(out.stderr, /NETWORK ATTEMPT/);
    assert.doesNotMatch(out.stdout, /^Q\d|Warming|Usage \(/m, 'no question ran');
  }
});

// --- Flags --------------------------------------------------------------------------------------

await test('grading is opt-in, --figure-check implies --grade, and the historical set runs once unless --repeat says otherwise', () => {
  assert.deepEqual(flagsOf(), { useAppKey: false, grade: false, figureCheck: false, builds: false, freshSearch: false, dryRun: false });
  assert.equal(flagsOf('--grade').grade, true);
  assert.equal(flagsOf('--grade').figureCheck, false);
  const fc = flagsOf('--figure-check');
  assert.equal(fc.figureCheck, true);
  assert.equal(fc.grade, true);
  assert.equal(flagsOf('--regrade', 'r.json').figureCheck, true);
  assert.equal(flagsOf('--builds').builds, true);
  assert.equal(flagsOf('--fresh-search', '--dry-run', '--use-app-key').freshSearch, true);
  assert.equal(repeatFor([]), 1);
  assert.equal(repeatFor(['--set', 'historical']), 1);
  assert.equal(repeatFor(['--repeat', '2']), 2);
  assert.equal(repeatFor(['--repeat', 'x']), 1);
});

// --- The real SDK, with fetch faked: the key, usage and the cache ----------------------------------

const seen: { url: string; key: string | null; body: any }[] = [];
let fetchMode: 'ok' | 'limit' = 'ok';
const realFetch = globalThis.fetch;
const headerOf = (init: any, name: string): string | null => {
  const h = init?.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  const hit = Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return hit ? String(hit[1]) : null;
};
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
  seen.push({ url, key: headerOf(init, 'x-goog-api-key'), body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') });
  if (fetchMode === 'limit') {
    return new Response(JSON.stringify({ error: { code: 429, message: CAP_MESSAGE, status: 'RESOURCE_EXHAUSTED' } }), { status: 429, headers: { 'Content-Type': 'application/json' } });
  }
  const searched = JSON.stringify(init?.body ?? '').includes('googleSearch');
  return new Response(JSON.stringify(answer('{"ok":true}', searched ? { groundingMetadata: { webSearchQueries: ['one query'], groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'A' } }] } } : {})), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

const cacheDir = join(scratch, 'search');
const realSession = await startEvalSession(flagsOf(), root, { searchCacheDir: cacheDir, now: () => DAY1, log: quiet });

await test('the eval key reaches every model call the pipeline makes, and the app key reaches none', async () => {
  const before = seen.length;
  await generateStructured({ task: 'routing', prompt: 'x', schema: { type: Type.OBJECT } });
  await runGroundedSearch('arsenal team news', { digest: 'evidence' });
  await generateProseTurn({ message: 'hi', historyContents: [], systemInstruction: 'be brief', toolMode: 'none' });
  assert.equal(seen.length, before + 3);
  assert.ok(seen.length >= 4, 'the cap check came first');
  assert.ok(seen.every((r) => r.key === 'eval-key-123'), JSON.stringify(seen.map((r) => r.key)));
  assert.ok(!JSON.stringify(seen).includes('app-key-999'));
});

await test('the cap check is the first request, one token long, before anything else', () => {
  assert.equal(seen[0].body.generationConfig?.maxOutputTokens ?? seen[0].body.config?.maxOutputTokens, 1);
  assert.equal(realSession.tally.byPhase().check.calls, 1);
});

await test('usage is counted from usageMetadata: tokens, thinking, and a search from its query', () => {
  const p = realSession.tally.byPhase();
  // The cap check and three answers' calls, each 100 in, 20 out, 30 thinking.
  assert.equal(p.check.inputTokens, 100);
  assert.equal(p.answer.calls, 3);
  assert.equal(p.answer.inputTokens, 300);
  assert.equal(p.answer.outputTokens, 60);
  assert.equal(p.answer.thinkingTokens, 90);
  assert.equal(p.answer.cachedTokens, 30);
  assert.equal(p.answer.searches, 1, 'the one grounded search, from its query');
  assert.equal(realSession.tally.total().calls, 4);
});

await test('search cache: a miss calls and stores, a hit makes no call, and the digest kind is part of the key', async () => {
  const before = seen.length;
  const first = await runGroundedSearch('chelsea injuries', { digest: 'evidence' });
  assert.equal(seen.length, before + 1, 'a miss calls the model');
  const hits = realSession.tally.total().cacheHits;
  const again = await runGroundedSearch('chelsea injuries', { digest: 'evidence' });
  assert.equal(seen.length, before + 1, 'a hit makes no call');
  assert.equal(again.text, first.text);
  assert.deepEqual(again.sources, first.sources);
  assert.equal(realSession.tally.total().cacheHits, hits + 1);
  await runGroundedSearch('chelsea injuries', { digest: 'brief' });
  assert.equal(seen.length, before + 2, 'another kind is another entry');
  await runGroundedSearch('chelsea injuries', { digest: 'evidence', context: 'live facts' });
  assert.equal(seen.length, before + 3, 'an analysis search (read against live facts) is its own kind');
  assert.ok(existsSync(join(cacheDir, '2026-11-18')), 'entries sit under the day');
  assert.equal(readdirSync(join(cacheDir, '2026-11-18')).length, 4, 'the first query, then the three kinds of chelsea');
});

await test('search cache: a failed or empty search is never stored, and another day is a miss', async () => {
  const cache = createFileSearchCache({ dir: join(scratch, 'days'), now: () => DAY1 });
  await cache.set('q', 'evidence', { query: 'q', text: '', sources: [], formattedBlock: '', error: 'refused' });
  await cache.set('q2', 'evidence', { query: 'q2', text: 'something', sources: [], formattedBlock: 'b', error: 'x' });
  assert.equal(existsSync(join(scratch, 'days')), false, 'nothing stored for an error or an empty result');
  await cache.set('q', 'evidence', { query: 'q', text: 'found', sources: [], formattedBlock: 'b' });
  assert.equal((await cache.get('Q ', 'evidence'))?.text, 'found', 'the query is trimmed and lower-cased');
  assert.equal(await cache.get('q', 'brief'), null);
  const tomorrow = createFileSearchCache({ dir: join(scratch, 'days'), now: () => DAY2 });
  assert.equal(await tomorrow.get('q', 'evidence'), null, 'a rerun the next day searches again');
  assert.equal(cache.hits, 1);
  assert.equal(cache.misses, 1);
});

await test('--fresh-search bypasses the cache: the search is made again and nothing is read or written', async () => {
  const files = () => readdirSync(join(cacheDir, '2026-11-18')).sort();
  const listing = files();
  const bodies = listing.map((f) => readFileSync(join(cacheDir, '2026-11-18', f), 'utf8'));
  await startEvalSession(flagsOf('--fresh-search'), root, { searchCacheDir: cacheDir, now: () => DAY1, models: fakeModels(() => answer('ok')), log: quiet });
  const before = seen.length;
  await runGroundedSearch('chelsea injuries', { digest: 'evidence' });
  assert.equal(seen.length, before + 1, 'it searched although today holds the entry');
  await runGroundedSearch('a new query', { digest: 'evidence' });
  assert.deepEqual(files(), listing, 'nothing was written');
  assert.deepEqual(listing.map((f) => readFileSync(join(cacheDir, '2026-11-18', f), 'utf8')), bodies, 'nothing was changed');
});

await test('the app never reads or writes the eval cache: without the hook, a seeded entry is ignored and nothing is stored', async () => {
  setSearchCache(null);
  const dir = join(scratch, 'seeded');
  const seeded = createFileSearchCache({ dir, now: () => Date.now() });
  await seeded.set('seeded query', 'evidence', { query: 'seeded query', text: 'FROM THE CACHE', sources: [], formattedBlock: 'cached' });
  const tree = (d: string): string[] => readdirSync(d, { recursive: true } as any).map(String).sort();
  const before = tree(dir);
  const content = before.filter((f) => f.endsWith('.json')).map((f) => readFileSync(join(dir, f), 'utf8'));
  const calls = seen.length;
  const result = await runGroundedSearch('seeded query', { digest: 'evidence' });
  assert.equal(seen.length, calls + 1, 'the model was asked');
  assert.notEqual(result.text, 'FROM THE CACHE');
  assert.deepEqual(tree(dir), before, 'nothing was written beside the seeded entry');
  assert.deepEqual(before.filter((f) => f.endsWith('.json')).map((f) => readFileSync(join(dir, f), 'utf8')), content);
});

await test('no app source names the eval cache, installs it, or imports the eval scripts', () => {
  const skip = new Set(['node_modules', '.git', 'dist', 'dist-ssr', '.cache', 'docs', 'scripts', '.claude', 'supabase', '.design-sync', 'ds-bundle', '.ds-sync']);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(join(dir, entry.name));
      } else if (/\.(ts|tsx|js|mjs|html)$/.test(entry.name)) {
        const text = readFileSync(join(dir, entry.name), 'utf8');
        const file = relative(root, join(dir, entry.name));
        if (/(?:from\s+|import\()\s*['"][^'"]*\/eval-[a-z-]+['"]/.test(text) || /EVAL_GEMINI_API_KEY|\.cache\/eval-search/.test(text)) found.push(`${file}: imports an eval script, or names the eval key or cache`);
        if (/\bsetSearchCache\s*\(/.test(text)) found.push(`${file}: installs a search cache`);
      }
    }
  };
  walk(root);
  assert.deepEqual(found, []);
  // The module the app bundles for the browser can't touch the disk.
  assert.doesNotMatch(readFileSync(join(root, 'services/aiClient.ts'), 'utf8'), /from 'node:|require\(/);
});

await test('a 429 mid-run stops the run: the call that got it is not retried and no later call is sent', async () => {
  const warn = console.warn;
  console.warn = () => {}; // the pipeline logs each refused search; the test expects them
  const before = seen.length;
  fetchMode = 'limit';
  const started = Date.now();
  const refused = await runGroundedSearch('a query the cap refuses', { digest: 'evidence' });
  assert.ok(Date.now() - started < 1500, 'the pipeline\'s own 2.5 s and 5 s retries were skipped');
  assert.equal(seen.length, before + 1, 'one request reached the network');
  assert.match(refused.error ?? '', /refused|429|cap/i);
  assert.ok(realSession.stopReason(), 'the session knows why it stopped');
  fetchMode = 'ok';
  // Everything after it throws at once, whatever the call: nothing is sent.
  await assert.rejects(() => runGroundedSearch('later', { digest: 'brief' }).then((r) => { if (r.error) throw new Error(r.error); }), /429|stopped|refused/i);
  await assert.rejects(() => generateStructured({ task: 'routing', prompt: 'x', schema: { type: Type.OBJECT } }), /Eval stopped/);
  await assert.rejects(() => generateProseTurn({ message: 'hi', historyContents: [], systemInstruction: 's', toolMode: 'none' }), /Eval stopped/);
  assert.equal(seen.length, before + 1, 'still one request: the later calls never reached the network');
  assert.match(realSession.stopReason()!, /429/);
  setSearchCache(null);
  console.warn = warn;
});
globalThis.fetch = realFetch;

// --- The guard around a faked model ----------------------------------------------------------------

const guarded = (models: ModelsLike) => {
  const tally = createUsageTally();
  const state: StopState = { reason: null };
  instrumentModels(models, tally, state);
  return { tally, state, models };
};

await test('the cap check names the spending cap, exits before any other call, and sends one token at most', async () => {
  const models = fakeModels(() => {
    throw limitError(CAP_MESSAGE);
  });
  await assert.rejects(
    () => startEvalSession(flagsOf('--fresh-search'), root, { env: { EVAL_GEMINI_API_KEY: 'e' }, models, log: quiet }),
    (e: any) => e instanceof EvalCapError && e.kind === 'cap' && /spending cap/.test(e.message) && /Nothing else was sent/.test(e.message),
  );
  assert.equal(models.requests.length, 1, 'only the check was sent');
  assert.equal(models.requests[0].config.maxOutputTokens, 1);
  // Even if the caller went on, the guard refuses every later call without reaching the model.
  await assert.rejects(() => models.generateContent({ contents: 'real work' }), /Eval stopped/);
  assert.equal(models.requests.length, 1);
});

await test('the cap check tells a plain rate limit and any other failure apart, and a healthy key passes', async () => {
  const rate = fakeModels(() => {
    throw limitError('429 Too Many Requests: slow down');
  });
  await assert.rejects(() => startEvalSession(flagsOf('--fresh-search'), root, { env: { EVAL_GEMINI_API_KEY: 'e' }, models: rate, log: quiet }), (e: any) => e instanceof EvalCapError && e.kind === 'rate' && /429/.test(e.message));
  const other = fakeModels(() => {
    throw limitError('API key not valid', 400);
  });
  await assert.rejects(() => startEvalSession(flagsOf('--fresh-search'), root, { env: { EVAL_GEMINI_API_KEY: 'e' }, models: other, log: quiet }), (e: any) => e instanceof EvalCapError && e.kind === 'other' && /EVAL_GEMINI_API_KEY/.test(e.message));
  const ok = fakeModels(() => answer('x'));
  const session = await startEvalSession(flagsOf('--fresh-search'), root, { env: { EVAL_GEMINI_API_KEY: 'e' }, models: ok, log: quiet });
  assert.equal(ok.requests.length, 1);
  assert.equal(session.stopReason(), null);
  assert.equal(session.tally.byPhase().check.calls, 1);
  assert.equal(session.tally.byPhase().answer.calls, 0, 'the check is counted apart from the answers');
});

await test('a 429 on any call stops every later call at once, with the original error marked for the callers', async () => {
  const { models, state } = guarded(
    fakeModels((_req, n) => {
      if (n === 3) throw limitError(CAP_MESSAGE);
      return answer('fine');
    }),
  );
  await models.generateContent({});
  await models.generateContent({});
  const e: any = await models.generateContent({}).catch((x) => x);
  assert.equal(e.evalStopped, true, 'marked, so the pipeline\'s retry skips it');
  assert.match(state.reason ?? '', /429/);
  const inner = (models as any).requests.length;
  const later: any = await models.generateContent({}).catch((x) => x);
  assert.equal(later.evalStopped, true);
  assert.equal(later.status, 429);
  assert.ok(isSpendLimit(later.message), 'the callers\' own limit checks read it');
  assert.equal((models as any).requests.length, inner, 'nothing reached the model');
  assert.equal(stoppedError('x').message, 'Eval stopped, nothing sent: x');
});

await test('a 429 inside a stream stops the run too, and a stream\'s usage is counted from its last chunk', async () => {
  const models: ModelsLike = {
    generateContent: async () => answer('x'),
    generateContentStream: async (req: any) =>
      (async function* () {
        yield { candidates: [{ content: { parts: [{ text: 'a' }] } }] };
        if (req.fail) throw limitError('429 RESOURCE_EXHAUSTED');
        yield { candidates: [{ content: { parts: [{ text: 'b' }] }, groundingMetadata: { webSearchQueries: ['q1', 'q2'] } }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 9, thoughtsTokenCount: 5, toolUsePromptTokenCount: 10 } };
      })(),
  };
  const { tally, state } = guarded(models);
  for await (const _ of await models.generateContentStream!({ config: { tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'f' }] }] } }));
  const u = tally.total();
  assert.deepEqual([u.calls, u.inputTokens, u.outputTokens, u.thinkingTokens, u.searches], [1, 50, 9, 5, 2], 'tool-use tokens count as input and each search query as a search');
  await assert.rejects(async () => {
    for await (const _ of await models.generateContentStream!({ fail: true }));
  }, /429/);
  assert.match(state.reason ?? '', /429/);
  await assert.rejects(() => models.generateContentStream!({}), /Eval stopped/);
});

await test('searches are counted from the model\'s queries; a chat turn that did not search counts none, and a search-only call counts one', async () => {
  const { tally, models } = guarded(
    fakeModels((req) => {
      const queries = req.queries as string[] | undefined;
      return answer('x', queries ? { groundingMetadata: { webSearchQueries: queries } } : {});
    }),
  );
  const search = { tools: [{ googleSearch: {} }] };
  const chat = { tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'f' }] }] };
  await models.generateContent({ config: search });
  assert.equal(tally.total().searches, 1, 'a call made only to search, with no query reported');
  await models.generateContent({ config: chat });
  assert.equal(tally.total().searches, 1, 'a chat turn that did not search');
  await models.generateContent({ config: chat, queries: ['a', 'b', 'c'] });
  assert.equal(tally.total().searches, 4);
  await models.generateContent({ config: {} });
  assert.equal(tally.total().searches, 4, 'no search tool');
});

await test('usage is kept per answer (a mark and a difference), per phase and in total, and printed', async () => {
  const { tally, models } = guarded(fakeModels(() => answer('x', {}, { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 300 })));
  const mark = tally.mark();
  await tally.within('answer', () => models.generateContent({}));
  await tally.within('answer', () => models.generateContent({}));
  const mine = tally.since(mark);
  await tally.within('grade', () => models.generateContent({ config: { tools: [{ googleSearch: {} }] } }));
  assert.deepEqual([mine.calls, mine.inputTokens, mine.outputTokens, mine.thinkingTokens], [2, 2000, 400, 600]);
  assert.equal(tally.phase, 'answer', 'the phase comes back');
  const p = tally.byPhase();
  assert.equal(p.answer.calls, 2);
  assert.equal(p.grade.calls, 1);
  assert.equal(p.grade.searches, 1);
  const t = tally.total();
  assert.deepEqual([t.calls, t.inputTokens, t.outputTokens, t.thinkingTokens, t.searches], [3, 3000, 600, 900, 1]);
  assert.equal(usageLine(t), '3 calls, 3.0k in, 600 out, 900 thinking, 1 searches');
  const text = usageTotalsText(tally);
  assert.match(text, /^Usage \(from the model's usageMetadata\): 3 calls, 3\.0k in/);
  assert.match(text, /answers: 2 calls/);
  assert.match(text, /grading and checks: 1 calls/);
  const section = usageSection(tally, [{ label: 'Q1', usage: mine }, { label: 'Q2' }]);
  assert.match(section, /^## Usage/);
  assert.match(section, /\| Total \| 3 \| 3000 \| 600 \| 900 \| 1 \| 0 \|/);
  assert.match(section, /\| Q1 \| 2 \| 2000 \| 400 \| 600 \| 0 \| 0 \|/);
  assert.doesNotMatch(section, /\| Q2 \|/, 'an answer with no usage has no row');
  assert.deepEqual(addUsage(emptyUsage(), mine), mine);
});

// --- The runners: nothing graded unless asked, and a limit ends each of them ----------------------------

const Q = (n: number): EvalQuestion => ({ n, text: `Question ${n}`, tests: `tests ${n}` });
const okRun = (text: string, extra: Partial<RunResult> = {}): RunResult => ({ answer: text, firstTokenMs: 100, totalMs: 1000, perf: [], ...extra });

await test('the plain live run grades only when a grader is passed, and saves every answer', async () => {
  let asked = 0;
  const ungraded = await runPlainSet<string>({ questions: [Q(1), Q(2), Q(3)], ask: async (t) => (asked++, okRun(`answer to ${t}`)), onResult: () => {}, log: quiet, write: quiet });
  assert.equal(asked, 3);
  assert.deepEqual(ungraded.results.map((r) => [r.q.n, r.grade, r.run.answer]), [[1, null, 'answer to Question 1'], [2, null, 'answer to Question 2'], [3, null, 'answer to Question 3']]);
  const prompts: string[] = [];
  const graded = await runPlainSet<string>({
    questions: [Q(1), Q(2)],
    ask: async (t) => okRun(`answer to ${t}`),
    gradeAnswer: async (q) => (prompts.push(q), { grade: 'graded', raw: '' }),
    onResult: () => {},
    log: quiet,
    write: quiet,
  });
  assert.deepEqual(prompts, ['Question 1', 'Question 2']);
  assert.deepEqual(graded.results.map((r) => r.grade), ['graded', 'graded']);
});

await test('the plain run stops at a 429: later questions are never asked, and what finished is kept and reported as it went', async () => {
  const { models, state } = guarded(fakeModels((_req, n) => (n === 2 ? (() => { throw limitError(CAP_MESSAGE); })() : answer('fine'))));
  const asked: number[] = [];
  const seenResults: number[] = [];
  const ask = async (text: string): Promise<RunResult> => {
    asked.push(Number(text.slice(-1)));
    try {
      await models.generateContent({});
      return okRun(`answer ${text}`);
    } catch (e: any) {
      return okRun('', { error: String(e.message) });
    }
  };
  const out = await runPlainSet<string>({ questions: [Q(1), Q(2), Q(3), Q(4)], ask, stopReason: () => state.reason, onResult: (r) => seenResults.push(r.length), log: quiet, write: quiet });
  assert.deepEqual(asked, [1, 2], 'question 3 was never asked');
  assert.deepEqual(out.results.map((r) => r.q.n), [1]);
  assert.match(out.stoppedEarly ?? '', /^Q2: .*429|cap/);
  assert.deepEqual(seenResults, [1], 'the report was written after the question that finished');
  // A limit the pipeline swallowed (the turn still answered) ends the run at the next check too.
  let n = 0;
  const swallowed = await runPlainSet<string>({ questions: [Q(1), Q(2), Q(3)], ask: async () => (n++, okRun('an answer')), stopReason: () => (n >= 1 ? 'a 429 came back' : null), onResult: () => {}, log: quiet, write: quiet });
  assert.equal(n, 1);
  assert.equal(swallowed.stoppedEarly, 'Q1: a 429 came back');
  assert.equal(swallowed.results.length, 1);
});

await test('the repeat run grades and compares only with graders, runs each question as often as asked, and stops at a 429', async () => {
  const asked: string[] = [];
  const bare = await runRepeats({ questions: [Q(1), Q(2)], repeat: 2, ask: async (t) => (asked.push(t), okRun(`a ${asked.length}`)), log: quiet });
  assert.equal(asked.length, 4);
  assert.ok(bare.runs.every((r) => r.grade === null && r.mentions === null));
  assert.ok(bare.consistency.every((c) => c.check === null && /not graded/.test(c.note ?? '')), 'no comparison call without a grader');
  const prompts: string[] = [];
  const graded = await runRepeats({
    questions: [Q(1)],
    repeat: 2,
    ask: async () => okRun('Arsenal start Raya.'),
    gradeRubric: async () => (prompts.push('rubric'), null),
    grade: async (p) => (prompts.push(p.includes('Several answers') ? 'compare' : 'mentions'), '{"agreement":"same","compared":1,"contradictions":[],"summary":"s"}'),
    log: quiet,
  });
  assert.deepEqual(prompts.sort(), ['compare', 'rubric', 'rubric']);
  assert.equal(graded.consistency[0].check?.agreement, 'same');
  let calls = 0;
  const stopped = await runRepeats({ questions: [Q(1), Q(2)], repeat: 2, ask: async () => (calls++, okRun('x')), stopReason: () => (calls >= 1 ? 'a 429 came back' : null), log: quiet });
  assert.equal(calls, 1);
  assert.match(stopped.stoppedEarly ?? '', /a 429 came back/);
  assert.equal(stopped.runs.length, 1, 'the finished run is kept');
});

const HQ = (n: number, text = `Historical ${n}`) => ({ n, text, tests: `tests ${n}` });
const historicalDeps = (calls: string[], extra: Record<string, unknown> = {}) => ({
  questions: [HQ(1), HQ(2)],
  pairs: [[1, 2]] as [number, number][],
  repeat: 1,
  ask: async (q: string) => ({ answer: `Answer to ${q}`, firstTokenMs: 1, totalMs: 2, perf: [] }),
  today: '2026-11-18',
  label: 't',
  model: 'm',
  ...extra,
});
const kindOf = (prompt: string): string => (prompt.startsWith(HISTORY_GRADE_INSTRUCTIONS.slice(0, 40)) ? 'grade' : prompt.startsWith(FIGURE_LIST_INSTRUCTIONS.slice(0, 40)) ? 'figure-list' : prompt.startsWith(FIGURE_VERIFY_INSTRUCTIONS.slice(0, 40)) ? 'figure-verify' : 'compare');

await test('the historical set runs each question once by default, with no grader, figure check or comparison call', async () => {
  const asked: string[] = [];
  const out = await quietly(() => runHistoricalSet(historicalDeps([], { ask: async (q: string) => (asked.push(q), { answer: `A ${q}`, firstTokenMs: 1, totalMs: 2, perf: [] }) }) as any));
  assert.deepEqual(asked, ['Historical 1', 'Historical 2'], 'one run each');
  const json: any = out.json;
  assert.equal(json.runs.length, 2);
  assert.ok(json.runs.every((r: any) => r.grade === null && r.figures === null));
  assert.equal(json.repeats.length, 0, 'a single run per question has nothing to compare');
  assert.match(out.markdown, /Nothing was graded \(no `--grade`\)/);
  assert.match(out.markdown, /A Historical 1/, 'the answers are saved for a person to read');
});

await test('--grade grades each answer with one call; --figure-check adds the figure calls; --repeat 2 adds one comparison per question', async () => {
  const kinds: string[] = [];
  const grade = async (prompt: string) => {
    const k = kindOf(prompt);
    kinds.push(k);
    if (k === 'figure-list') return '{"claims":["X scored 5 in 2003-04"]}';
    if (k === 'figure-verify') return '{"results":[{"n":1,"verdict":"correct","note":"ok"}]}';
    return k === 'compare' ? '{"agreement":"same","why":"w"}' : '{"verdict":"v","criteria":3}';
  };
  await quietly(() => runHistoricalSet(historicalDeps([], { grade }) as any));
  assert.deepEqual(kinds.filter((k) => k !== 'compare'), ['grade', 'grade'], 'graded once each, no figure check');
  assert.equal(kinds.filter((k) => k === 'compare').length, 1, 'the paraphrase pair is compared');
  kinds.length = 0;
  await quietly(() => runHistoricalSet(historicalDeps([], { grade, figureCheck: true }) as any));
  assert.deepEqual(kinds.filter((k) => k !== 'compare'), ['grade', 'figure-list', 'figure-verify', 'grade', 'figure-list', 'figure-verify']);
  kinds.length = 0;
  const twice = await quietly(() => runHistoricalSet(historicalDeps([], { grade, repeat: 2, pairs: [] }) as any));
  assert.equal((twice.json as any).runs.length, 4);
  assert.equal(kinds.filter((k) => k === 'compare').length, 2, 'one comparison per question, only because there are two runs');
  assert.equal(kinds.filter((k) => k === 'figure-list').length, 0);
  const direct = await checkFigures('an answer', async (p) => (kinds.push(kindOf(p)), '{"claims":[]}'));
  assert.equal(direct?.stated, 0);
});

await test('the historical run keeps what finished when a 429 comes back in the grader or the pipeline', async () => {
  let stop: string | null = null;
  const updates: number[] = [];
  const out = await quietly(() => runHistoricalSet(
    historicalDeps([], {
      questions: [HQ(1), HQ(2), HQ(3)],
      grade: async () => {
        stop = 'a 429 came back (spending cap)';
        throw limitError(CAP_MESSAGE);
      },
      stopReason: () => stop,
      onUpdate: (r: { json: any }) => updates.push(r.json.runs.length),
    }) as any),
  );
  assert.match(out.stoppedEarly ?? '', /^Q1, run 1: a 429/);
  assert.equal((out.json as any).runs.length, 1, 'question 2 and 3 were never asked');
  assert.deepEqual(updates, [1], 'the report was written as the run went');
  assert.match(out.markdown, /Run stopped early/);
  let asked = 0;
  const pipe = await quietly(() => runHistoricalSet(historicalDeps([], { ask: async () => (asked++, { answer: '', error: '429 spending cap', firstTokenMs: null, totalMs: 1, perf: [] }) }) as any));
  assert.equal(asked, 1);
  assert.match(pipe.stoppedEarly ?? '', /429/);
});

const CASE: ConversationCase = {
  id: 'T1',
  title: 'A case',
  turns: [{ user: 'first', recorded: 'recorded reply' }, { user: 'second', mustDo: ['do the thing'] }, { user: 'third', mustDo: ['do another'] }],
};

await test('conversations run their tested turns and grade only with a grader; a 429 ends the case with what finished', async () => {
  const asked: string[] = [];
  const grader: string[] = [];
  const bare = await runConversation(CASE, { ask: async (m) => (asked.push(m), { answer: `reply to ${m}`, totalMs: 1, perf: [] }) });
  assert.deepEqual(asked, ['second', 'third']);
  assert.ok(bare.turns.every((t) => t.checks === null && t.checkList && t.checkList.length > 1), 'saved with the checks to read them against');
  const graded = await runConversation(CASE, { ask: async (m) => ({ answer: `reply to ${m}`, totalMs: 1, perf: [] }), grade: async (p) => (grader.push(p), '{"checks":[]}') });
  assert.equal(grader.length, 2);
  assert.equal(graded.turns.length, 2);
  let n = 0;
  const stopped = await runConversation(CASE, { ask: async (m) => (n++, { answer: n === 1 ? `reply to ${m}` : '', error: n === 1 ? undefined : '429 spending cap', totalMs: 1, perf: [] }) });
  assert.equal(n, 2);
  assert.match(stopped.stoppedEarly ?? '', /429/);
  assert.equal(stopped.turns.length, 1);
  let g = 0;
  const viaState = await runConversation(CASE, { ask: async (m) => (g++, { answer: 'a', totalMs: 1, perf: [] }), stopReason: () => (g >= 1 ? 'a 429 came back' : null) });
  assert.equal(g, 1);
  assert.equal(viaState.stoppedEarly, 'a 429 came back');
});

await test('the conversation set\'s live turns are counted from its cases', () => {
  const cases = readConversations(readFileSync(join(root, 'docs/superpowers/evals/live-questions.md'), 'utf8'));
  const counts = conversationTurnCounts(cases);
  assert.ok(cases.length >= 4);
  assert.ok(counts.tested >= 4 && counts.live >= counts.tested);
  assert.ok(counts.needGaffa >= 1);
  assert.deepEqual(conversationTurnCounts([CASE]), { live: 2, tested: 2, needGaffa: 0 });
  assert.deepEqual(conversationTurnCounts([{ id: 'x', title: 'x', turns: [{ user: 'a' }, { user: 'b', mustDo: ['c'] }] }]), { live: 2, tested: 1, needGaffa: 0 }, 'an earlier turn with no recorded reply runs live');
});

// --- The dry run -----------------------------------------------------------------------------------------

const baseline = readReportBaseline(join(root, 'docs/superpowers/evals/reports'));
const sizes = { chatFixedTokens: 12_000 };
const input = (over: Partial<SetEstimateInput> = {}): SetEstimateInput => ({
  set: 'live',
  questions: [11, 4, 1],
  repeat: 1,
  grade: false,
  figureCheck: false,
  builds: false,
  stage: false,
  pastMode: false,
  cardMentions: false,
  pairs: 0,
  sizes,
  baseline,
  ...over,
});
const names = (e: ReturnType<typeof estimateSet>) => e.expected.components.map((c) => c.name);

await test('the dry run reads the shapes of answers from the saved reports, and takes measured usage over its model', () => {
  assert.ok(baseline.basis.reports > 10 && baseline.basis.chat > 0 && baseline.basis.past > 0, JSON.stringify(baseline.basis));
  assert.ok(baseline.chat.lookups > 1 && baseline.chat.lookups < 5);
  assert.equal(baseline.basis.measuredAnswers, 0, 'the existing reports carry no tokens yet');
  const dir = join(scratch, 'reports');
  mkdirSync(dir);
  const usage = { calls: 7, inputTokens: 90_000, outputTokens: 2_000, thinkingTokens: 3_000, cachedTokens: 0, searches: 2, cacheHits: 0 };
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ results: [{ q: { n: 1 }, run: { research: { path: 'chat', lookups: 4, searches: 2, rounds: 3 }, usage } }, { q: { n: 2 }, run: { research: { path: 'chat', lookups: 2, searches: 0, rounds: 1 }, usage: { ...usage, calls: 5 } } }] }));
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  const measured = readReportBaseline(dir);
  assert.equal(measured.basis.measuredAnswers, 2);
  assert.deepEqual([measured.chat.lookups, measured.chat.searches, measured.chat.rounds], [3, 1, 2]);
  assert.deepEqual([measured.measured.chat!.calls, measured.measured.chat!.inputTokens, measured.measured.chat!.outputTokens], [6, 90_000, 5_000]);
  const e = estimateSet(input({ questions: [1, 2], baseline: measured }));
  const turn = e.expected.components.find((c) => /measured/.test(c.name))!;
  assert.equal(turn.calls, 12, 'two turns of six calls');
  assert.equal(turn.inputTokens, 180_000);
  assert.ok(e.ceiling.total.inputTokens > e.expected.total.inputTokens);
  assert.ok(e.notes.some((n) => /2 answers whose reports recorded their usage/.test(n)));
});

await test('saved reports of every kind give their answers', () => {
  const research = { path: 'chat', lookups: 2, searches: 1, rounds: 2 };
  assert.equal(answersIn([{ q: {}, run: { research } }, { q: {}, run: {} }]).length, 2);
  assert.equal(answersIn({ results: [{ run: { research } }] })[0].kind, 'live');
  assert.equal(answersIn({ runs: [{ run: { research: { ...research, past: {} } } }], repeats: [] })[0].kind, 'historical');
  assert.equal(answersIn([{ id: 'C1', turns: [{ run: { research } }, { run: null }] }]).length, 1);
  assert.deepEqual(answersIn({ nothing: true }), []);
  assert.equal(answersIn([{ run: { research: { path: 'deep', lookups: 1, searches: 0, rounds: 1 } } }])[0].path, 'deep');
});

await test('the live dry run reflects --grade, --repeat and --stage', () => {
  const plain = estimateSet(input());
  assert.equal(plain.turns, 3);
  assert.deepEqual(names(plain).length, 1, 'no grader components without --grade');
  assert.ok(plain.notes.some((n) => /No `--grade`/.test(n)));
  const graded = estimateSet(input({ grade: true }));
  assert.ok(names(graded).some((n) => /Rubric grade/.test(n)));
  assert.ok(graded.expected.total.calls > plain.expected.total.calls);
  assert.ok(!names(graded).some((n) => /Consistency/.test(n)), 'a single run has no comparison');
  const twice = estimateSet(input({ grade: true, repeat: 2, cardMentions: true }));
  assert.equal(twice.turns, 6);
  assert.ok(names(twice).some((n) => /Consistency comparison, 3/.test(n)));
  assert.ok(names(twice).some((n) => /Card-mention/.test(n)));
  assert.equal(estimateSet(input({ repeat: 2 })).expected.components.length, 1, 'repeat alone adds no grader');
  assert.equal(estimateSet(input({ repeat: 2 })).expected.total.calls, plain.expected.total.calls * 2);
  assert.deepEqual(names(estimateSet(input({ stage: true }))), ['Stage-path controls, 3'], 'every question is priced as a stage pipeline turn');
});

await test('the historical dry run reflects --grade, --figure-check, --repeat and --past-mode', () => {
  const h = (over: Partial<SetEstimateInput> = {}) => estimateSet(input({ set: 'historical', questions: [1, 2, 3, 13], pairs: 1, ...over }));
  const plain = h();
  assert.equal(plain.turns, 4, 'one run per question');
  assert.equal(names(plain).length, 1);
  assert.ok(/Stage pipeline answers, 4/.test(names(plain)[0]));
  const graded = h({ grade: true });
  assert.deepEqual(names(graded).map((n) => n.split(',')[0]), ['Stage pipeline answers', 'Historical grade', 'Verdict comparisons']);
  assert.match(names(graded)[2], /Verdict comparisons, 1/, 'only the paraphrase pair: one run each compares nothing else');
  const figures = h({ grade: true, figureCheck: true });
  assert.ok(names(figures).some((n) => /Figure check, 4/.test(n)));
  assert.ok(figures.ceiling.total.grounded > figures.expected.total.grounded, 'the ceiling allows more searches per figure check');
  assert.ok(figures.expected.total.usd > graded.expected.total.usd);
  const twice = h({ grade: true, repeat: 2 });
  assert.equal(twice.turns, 8);
  assert.match(names(twice).find((n) => /Verdict/.test(n))!, /Verdict comparisons, 5/, 'four questions twice, and the pair');
  const past = h({ pastMode: true });
  assert.ok(names(past).some((n) => /Past mode answers, 4/.test(n)) && names(past).some((n) => /Settled-verdict/.test(n)));
  assert.ok(h({ builds: true }).notes.some((n) => /--builds.*never completes/.test(n)));
});

await test('the conversations dry run counts the live turns and prices the conduct grade only with --grade', () => {
  const counts = { live: 10, tested: 8, cases: 5, needGaffa: 2 };
  const c = (over: Partial<SetEstimateInput> = {}) => estimateSet(input({ set: 'conversations', questions: [], conversationTurns: counts, ...over }));
  const plain = c();
  assert.equal(plain.turns, 10);
  assert.equal(names(plain).length, 1);
  assert.ok(plain.notes.some((n) => /2 of 5 cases need a Gaffa club/.test(n)));
  const graded = c({ grade: true });
  assert.match(names(graded)[1], /Conduct grade, 8 tested turns/);
  assert.equal(graded.expected.total.calls - plain.expected.total.calls, 8);
});

await test('--dry-run prices every set with no key, no network and no call', () => {
  const env = childEnv({ EVAL_GEMINI_API_KEY: '', GEMINI_API_KEY: '', API_KEY: '' });
  const run = (...args: string[]) => spawnSync('npx', ['tsx', 'scripts/eval-live-questions.ts', ...args, '--dry-run'], { cwd: root, env, encoding: 'utf8', timeout: 90_000 });
  const live = run('--only', '11,4,1', '--grade', '--repeat', '2');
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.stdout, /Dry run: 3 questions \(11, 4, 1\) × 2 runs = 6 turns through the chat loop\. No call is made\./);
  assert.match(live.stdout, /Flags reflected: --grade, --repeat 2\./);
  assert.match(live.stdout, /Rubric grade, 6/);
  const hist = run('--set', 'historical', '--only', '1,2', '--grade', '--figure-check');
  assert.equal(hist.status, 0, hist.stderr);
  assert.match(hist.stdout, /Dry run, historical set: 2 questions \(1, 2\) × 1 run = 2 turns through the stage pipeline\. No call is made\./);
  assert.match(hist.stdout, /Flags reflected: --grade, --figure-check, --repeat 1\./);
  assert.match(hist.stdout, /Figure check, 2/);
  const conv = run('--conversations', '--only', 'C2,C4');
  assert.equal(conv.status, 0, conv.stderr);
  assert.match(conv.stdout, /Dry run, conversations: 2 cases \(C2, C4\)/);
  assert.match(conv.stdout, /No `--grade`: no grader and no figure check is called/);
  assert.doesNotMatch(conv.stdout + conv.stderr, /EVAL_GEMINI_API_KEY is not set/);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
