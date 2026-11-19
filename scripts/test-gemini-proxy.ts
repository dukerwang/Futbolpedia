/**
 * The Gemini key stays on the server: the build puts no key in the browser bundle, the browser's SDK
 * calls this site's /gemini-api-proxy with a placeholder, and the proxy forwards only the app's own
 * models and methods, from this site, within its limits. No network: fetch is faked.
 */
import assert from 'node:assert/strict';
import {
  PROXY_GLOBAL_PER_DAY,
  PROXY_MAX_BODY_BYTES,
  PROXY_PER_DAY,
  PROXY_PER_MINUTE,
  checkProxyPath,
  createProxyLimiter,
  decideProxy,
  originAllowed,
} from '../services/geminiProxy';

let passed = 0;
let failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (e: any) {
    failed += 1;
    console.log(`✗ ${name}\n  ${e?.stack ?? e}`);
  }
};

const KEY = 'server-key-never-sent-to-browsers';
const base: { method: string; path: string; query: Record<string, unknown>; body: unknown; origin?: string; host: string; source: string } = {
  method: 'POST',
  path: 'v1beta/models/gemini-4-hydrogen:generateContent',
  query: {},
  body: { contents: [{ parts: [{ text: 'hi' }] }] },
  origin: 'https://futbolpedia.org',
  host: 'futbolpedia.org',
  source: 'visitor-a',
};
const deps = () => ({ key: KEY, limiter: createProxyLimiter(), extraOrigins: ['futbolpedia.ai.studio'] });

await test('only the app models and content methods pass the path check', () => {
  assert.equal(checkProxyPath('v1beta/models/gemini-4-hydrogen:generateContent').ok, true);
  assert.equal(checkProxyPath('/v1beta/models/gemini-4-hydrogen:streamGenerateContent').ok, true);
  assert.equal(checkProxyPath('v1beta/models/gemini-3.8-flash:countTokens').ok, true);
  for (const p of [
    'v1beta/models/gemini-4-argon:generateContent',
    'v1beta/models/gemini-4-carbon:generateContent',
    'v1beta/models/veo-3-generate:predictLongRunning',
    'v1beta/models/gemini-4-hydrogen:predict',
    'v1beta/models',
    'v1beta/files',
    'upload/v1beta/files',
    'v1beta/cachedContents',
    'v1beta/models/gemini-4-hydrogen:generateContent/../../files',
  ]) {
    assert.equal(checkProxyPath(p).ok, false, p);
  }
});

await test('a request from this site to an app model is forwarded, with only the alt parameter', () => {
  const d = decideProxy({ ...base, query: { alt: 'sse', key: 'someone-elses', __applet_proxy: '1' } }, deps());
  assert.equal(d.forward, true);
  if (d.forward) {
    assert.equal(d.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent');
    assert.deepEqual(d.params, { alt: 'sse' });
    assert.equal(d.model, 'gemini-4-hydrogen');
  }
});

await test('other models, methods, verbs and sites are refused before reaching Google', () => {
  const refused = (over: Partial<typeof base>, status: number) => {
    const d = decideProxy({ ...base, ...over }, deps());
    assert.equal(d.forward, false, JSON.stringify(over));
    if (!d.forward) assert.equal(d.status, status, JSON.stringify(over));
  };
  refused({ path: 'v1beta/models/gemini-4-argon:generateContent' }, 403);
  refused({ path: 'v1beta/models/gemini-4-carbon:streamGenerateContent' }, 403);
  refused({ method: 'GET', path: 'v1beta/models' }, 405);
  refused({ origin: undefined }, 403);
  refused({ origin: 'https://evil.example' }, 403);
  refused({ origin: 'not a url' }, 403);
  refused({ body: { blob: 'x'.repeat(PROXY_MAX_BODY_BYTES + 1) } }, 413);
});

await test('the request host and the site hosts are allowed origins', () => {
  assert.equal(originAllowed('https://futbolpedia.org', 'futbolpedia.org'), true);
  assert.equal(originAllowed('https://abc.run.app', 'abc.run.app'), true);
  assert.equal(originAllowed('https://futbolpedia.ai.studio', 'other.host', ['futbolpedia.ai.studio']), true);
  assert.equal(originAllowed('https://futbolpedia.org.evil.example', 'futbolpedia.org'), false);
});

await test('with no server key, nothing is forwarded', () => {
  const d = decideProxy(base, { ...deps(), key: undefined });
  assert.equal(d.forward, false);
  if (!d.forward) assert.equal(d.status, 503);
});

await test('one visitor is limited per minute and per day, and everyone together per day', () => {
  let t = 0;
  const now = () => t;
  const perMinute = createProxyLimiter({ now });
  for (let i = 0; i < PROXY_PER_MINUTE; i++) assert.equal(perMinute.take('a'), null);
  assert.match(perMinute.take('a')!, /slow down/);
  assert.equal(perMinute.take('b'), null, 'another visitor is unaffected');
  t += 61_000;
  assert.equal(perMinute.take('a'), null, 'a minute later the visitor may go on');

  t = 0;
  const perDay = createProxyLimiter({ now, perMinute: 1_000_000 });
  for (let i = 0; i < PROXY_PER_DAY; i++) assert.equal(perDay.take('a'), null);
  assert.match(perDay.take('a')!, /daily limit for this visitor/);

  t = 0;
  const global = createProxyLimiter({ now, perMinute: 1_000_000, perDay: 1_000_000 });
  for (let i = 0; i < PROXY_GLOBAL_PER_DAY; i++) assert.equal(global.take(`v${i}`), null);
  assert.match(global.take('new')!, /daily limit reached/);
  t += 24 * 60 * 60 * 1000;
  assert.equal(global.take('new'), null, 'the next day starts fresh');
});

await test('a refused request still answers the visitor without forwarding', () => {
  const limiter = createProxyLimiter({ perMinute: 1 });
  assert.equal(decideProxy(base, { key: KEY, limiter }).forward, true);
  const d = decideProxy(base, { key: KEY, limiter });
  assert.equal(d.forward, false);
  if (!d.forward) assert.equal(d.status, 429);
});

await test('the build defines no key for the browser, whatever the environment holds', async () => {
  const fake = 'AIza' + 'X'.repeat(35);
  process.env.GEMINI_API_KEY = fake;
  process.env.API_KEY = fake;
  // Vite bundles its config as CommonJS, where __dirname exists; loaded here as a module it doesn't.
  (globalThis as any).__dirname ??= process.cwd();
  const config = (await import('../vite.config')).default as any;
  const resolved = typeof config === 'function' ? config({ mode: 'production', command: 'build' }) : config;
  const values = Object.values(resolved.define ?? {}).map(String);
  assert.ok(values.length > 0);
  for (const v of values) assert.ok(!v.includes(fake) && !/AIza/.test(v), v);
});

await test('in the browser, the SDK calls this site\'s proxy with a placeholder, never a key', async () => {
  const realKey = 'AIza' + 'Y'.repeat(35);
  process.env.API_KEY = realKey;
  const sent: { url: string; key: string | null }[] = [];
  (globalThis as any).window = { location: { origin: 'https://futbolpedia.org' } };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined));
    sent.push({ url, key: headers.get('x-goog-api-key') });
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const { getAi } = await import('../services/aiClient');
  await getAi().models.generateContent({ model: 'gemini-4-hydrogen', contents: 'hi' });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].url.startsWith('https://futbolpedia.org/gemini-api-proxy/'), sent[0].url);
  assert.match(sent[0].url, /models\/gemini-4-hydrogen:generateContent/);
  assert.ok(!sent[0].url.includes(realKey));
  assert.notEqual(sent[0].key, realKey);
  assert.ok(!/AIza/.test(sent[0].key ?? ''));
  delete (globalThis as any).window;
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
