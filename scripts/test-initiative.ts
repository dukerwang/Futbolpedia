#!/usr/bin/env npx tsx
/**
 * Offline checks for the writer's initiative: a chat turn runs for real through sendMessageToAI
 * with Gemini faked at the fetch layer (no network, Supabase or API keys, no model calls). The
 * faked writer is scripted to call ask_user, prepare_club and offer_rating, and the checks are
 * what the turn does with them: a question ends the turn and carries its chips, a club is prepared
 * once per conversation, an offer never repeats a shown card, the retired request_deeper is never
 * offered, and Gaffa's panel and challenge turns never see the tools. The control (a clear question with its card in play, a writer that doesn't
 * ask) answers normally.
 *
 * Usage:
 *   npx tsx scripts/test-initiative.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerProfile } from '../types';
import { INITIATIVE_RULES } from '../prompts/chatPrompt';

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

// ---------------------------------------------------------------------------------------------
// The fake model

interface WriterRequest {
  /** The tool names the writer was shown. */
  tools: string[];
  /** The message the writer was sent, or null on a round that returns tool results. */
  prompt: string | null;
  followUp: boolean;
}
interface Part {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
}

const writerRequests: WriterRequest[] = [];
const routeCalls: string[] = [];
const snapshotRoute: string[] = [];
/** What the writer says on its first round; the second round (after tool results) says `finalText`. */
let firstRound: Part[] = [];
let finalText = 'A direct answer.';
/** The turn router's answer for the next turn (the classifier is a structured call). */
let nextRoute: Record<string, unknown> = {};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const modelReply = (parts: Part[]) => json({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: {} });
/** The same reply as a server-sent event stream, which is how the streaming writer reads it. */
const sseReply = (parts: Part[]) =>
  new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: {} })}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.startsWith('/api/snapshots/club')) {
    snapshotRoute.push(new URL(url, 'http://local').searchParams.get('club') ?? '');
    return json({ snapshot: null });
  }
  if (url.startsWith('/api/live/table')) {
    const row = (rank: number, team: string, points: number) => ({ rank, team, group: null, played: 12, won: 8, drawn: 2, lost: 2, goalDiff: 10 - rank, points, form: null });
    return json({ found: true, league: 'Premier League', season: '2026-27', text: '1. Arsenal — 29 pts, P12 W8 D2 L2, GD +9\n2. Chelsea — 26 pts, P12 W7 D3 L2, GD +8', rows: [row(1, 'Arsenal', 29), row(2, 'Chelsea', 26)] });
  }
  if (url.startsWith('/api/')) return new Response('{}', { status: 404 });
  if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);

  const body = JSON.parse(init?.body ?? '{}');
  const raw = JSON.stringify(body);
  const streaming = url.includes('streamGenerateContent');
  const reply = streaming ? sseReply : modelReply;
  const structured = raw.includes('responseSchema') || raw.includes('responseJsonSchema');
  const prompt = JSON.stringify([body.contents ?? '', body.systemInstruction ?? '']);

  if (prompt.includes('first-team head coach')) return modelReply([{ text: 'COACH: UNKNOWN | SINCE: UNKNOWN | PREVIOUS: UNKNOWN | SOURCE_DATE: UNKNOWN' }]);
  if (structured && prompt.includes('Classify')) {
    routeCalls.push('classify');
    return modelReply([{ text: JSON.stringify(nextRoute) }]);
  }
  if (structured) return modelReply([{ text: '{}' }]);

  // The writer: the one request that carries the dossier tools.
  const declared: string[] = (body.tools ?? []).flatMap((t: any) => (t.functionDeclarations ?? []).map((d: any) => d.name));
  if (declared.includes('look_up_dossier')) {
    const followUp = raw.includes('"functionResponse"');
    writerRequests.push({ tools: declared, prompt: followUp ? null : raw, followUp });
    return reply(followUp ? [{ text: finalText }] : firstRound);
  }
  return modelReply([{ text: 'A search result.' }]);
}) as typeof fetch;

const { sendMessageToAI } = await import('../services/geminiService');
const { createDossierTools, createInitiativeTools, offerScout, showCard } = await import('../services/conversationalScout');
const { ReplyComposer, readyOf } = await import('../services/replyBlocks');
const { pitchBlock } = await import('../services/replyBlocks/pitch');
type ReplyBlock = import('../types').ReplyBlock;
/** What a reply attached, read back from its blocks. */
const attachedIn = (blocks: ReplyBlock[] | null) => ({
  ask: readyOf(blocks, 'ask')[0]?.data,
  goDeeper: readyOf(blocks, 'goDeeper')[0]?.data,
  scoutOffers: readyOf(blocks, 'scoutOffer').map((b) => b.data.name),
  cards: readyOf(blocks, 'card').map((b) => b.data),
  lineups: readyOf(blocks, 'pitch').map((b) => b.data),
});
const { validateAsk, createPreparer, resetPrepared, askedDirectly, clubKey } = await import('../services/initiative');
const { formatIsoDate } = await import('../services/dossierStore');

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { log, info, warn } = console;
  console.log = console.info = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, info, warn });
  }
};

const now = Date.now();
const today = formatIsoDate(now);
const card = (name: string, type: 'current' | 'prime' = 'current'): PlayerProfile => {
  const evaluationDate = type === 'current' ? today : '2005-05-15';
  return {
    basicInfo: { name, club: 'Bayer Leverkusen', position: 'Attacking Midfielder', age: 23, nationality: 'Germany' },
    ratings: { overall: 85, potential: 90 },
    createdAt: now,
    evaluationDate,
    version: { id: `${name}-${type}`, type, label: type, evaluationDate, seasonOrEra: type === 'current' ? undefined : '2003-06' },
    attributes: { finishing: 80 },
    shortBio: 'A card.',
  } as unknown as PlayerProfile;
};

/** A question about one player whose card is in play: one clear reading, no live cue, so nothing is researched. */
const playerQuestion = 'How good is Florian Wirtz?';
const playerRoute = {
  intent: 'tactical_chat',
  analyticalMode: 'player_qa',
  targetPlayers: ['Florian Wirtz'],
  targetClubs: [],
  searchQueries: [],
  reasoningComplexity: 'low',
  isHistorical: false,
  wantsRegeneration: false,
  needsSearch: false,
};
const pastRoute = { ...playerRoute, isHistorical: true };

interface Turn {
  reply: string;
  attached: ReplyBlock[] | null;
  writer: WriterRequest[];
}
async function runTurn(
  message: string,
  opts: { route?: Record<string, unknown>; first?: Part[]; final?: string; options?: Record<string, unknown>; stream?: boolean; cards?: PlayerProfile[] } = {},
): Promise<Turn> {
  nextRoute = opts.route ?? playerRoute;
  firstRound = opts.first ?? [{ text: 'A direct answer.' }];
  finalText = opts.final ?? 'A direct answer.';
  const before = writerRequests.length;
  let attached: ReplyBlock[] | null = null;
  const reply = await quietly(() =>
    sendMessageToAI(message, [], undefined, opts.cards ?? [card('Florian Wirtz')], [], {
      conversationId: 'conv-default',
      // These tests exercise the stage pipeline's writer tools.
      stage: true,
      ...opts.options,
      onBlocks: (blocks) => (attached = blocks),
      ...(opts.stream ? { onStreamChunk: () => {} } : {}),
    }),
  );
  return { reply: reply as string, attached, writer: writerRequests.slice(before) };
}
const call = (name: string, args: Record<string, unknown>): Part => ({ functionCall: { name, args } });
const INITIATIVE = ['ask_user', 'prepare_club', 'offer_rating'];

// ---------------------------------------------------------------------------------------------
// Ask instead of answer

await test('ask_user ends the turn: the question is the reply and the options are attached', async () => {
  const t = await runTurn(playerQuestion, {
    first: [call('ask_user', { question: 'Which version of him do you mean?', options: ['His current form', 'His prime', 'His prime'] })],
    final: 'SHOULD NOT BE SENT',
  });
  assert.equal(t.reply, 'Which version of him do you mean?');
  assert.equal(t.writer.length, 1, 'the writer got no second round');
  assert.deepEqual(attachedIn(t.attached).ask, {
    question: 'Which version of him do you mean?',
    options: ['His current form', 'His prime'],
  });
  assert.ok(INITIATIVE.every((n) => t.writer[0].tools.includes(n)), `shown ${t.writer[0].tools}`);
});

await test('ask_user ends a streamed turn too, and the stream carries the question', async () => {
  const chunks: string[] = [];
  nextRoute = playerRoute;
  firstRound = [call('ask_user', { question: 'Which club do you mean?', options: ['The first club', 'The second club'] })];
  let attached: ReplyBlock[] | null = null;
  const reply = await quietly(() =>
    sendMessageToAI(playerQuestion, [], undefined, [card('Florian Wirtz')], [], {
      conversationId: 'conv-stream',
      stage: true,
      onBlocks: (blocks) => (attached = blocks),
      onStreamChunk: (text) => chunks.push(text),
    }),
  );
  assert.equal(reply, 'Which club do you mean?');
  assert.equal(chunks.at(-1), 'Which club do you mean?');
  assert.deepEqual(attachedIn(attached).ask?.options, ['The first club', 'The second club']);
});

await test('a question with fewer than two options is refused and the writer answers instead', async () => {
  const t = await runTurn(playerQuestion, {
    first: [call('ask_user', { question: 'Which one?', options: ['Only one'] })],
    final: 'The answer the writer gave after the refusal.',
  });
  assert.equal(t.reply, 'The answer the writer gave after the refusal.');
  assert.equal(t.writer.length, 2);
  assert.equal(attachedIn(t.attached).ask, undefined);
});

await test('an asking reply drops what was drawn for an answer, and keeps scout offers', () => {
  const composer = new ReplyComposer();
  composer.showCard(card('Florian Wirtz'));
  composer.offerScout('Pedri');
  composer.addView(pitchBlock(composer.newId(), { club: 'Southside' } as any));
  const { tools, endTurn } = createInitiativeTools({
    composer, cardsInPlay: [], localCards: [], historical: false, conversationId: 'conv-unit', clubsInPlay: [], startBuild: () => {},
  });
  assert.equal(endTurn(), null);
  tools.ask!({ question: 'Which season?', options: ['This one', 'Last one'] });
  assert.equal(endTurn(), 'Which season?');
  assert.deepEqual(composer.cards, []);
  assert.equal(composer.viewsOf('pitch').length, 0);
  assert.deepEqual(composer.scoutOffers, ['Pedri']);
});

await test('options are cleaned: clipped, deduplicated, at most four', () => {
  const long = 'a very long option that keeps going and going well past the length a chip can show on a phone';
  const checked = validateAsk('  Which   one? ', [long, 'Two', 'two', 'Three', 'Four', 'Five', 7]);
  assert.ok('ask' in checked);
  if ('ask' in checked) {
    assert.equal(checked.ask.question, 'Which one?');
    assert.equal(checked.ask.options.length, 4);
    assert.ok(checked.ask.options[0].length <= 60);
    assert.deepEqual(checked.ask.options.slice(1), ['Two', 'Three', 'Four']);
  }
  assert.ok('error' in validateAsk('', ['a', 'b']));
  assert.ok('error' in validateAsk('Which?', 'a, b'));
});

await test('control: a clear question with its card in play, and a writer that does not ask, is answered normally', async () => {
  const t = await runTurn(playerQuestion, { first: [{ text: 'He is a high-end starter who plays between the lines.' }] });
  assert.equal(t.reply, 'He is a high-end starter who plays between the lines.');
  assert.equal(t.writer.length, 1);
  const a = attachedIn(t.attached);
  assert.equal(a.ask, undefined);
  assert.equal(a.goDeeper, undefined);
  assert.equal(a.cards.length, 0, 'code no longer shows his card; the writer does, with show_dossier');
  // The writer was told when to ask and when to take the likelier reading and say so.
  const prompt = t.writer[0].prompt ?? '';
  assert.ok(prompt.includes('call `ask_user` only when the message reads two ways'));
  assert.ok(prompt.includes('say in one sentence which reading you took'));
});

// ---------------------------------------------------------------------------------------------
// Prepare

await test('prepare_club starts the server build once per club per conversation', async () => {
  resetPrepared();
  snapshotRoute.length = 0;
  const opts = { options: { conversationId: 'conv-prep-a' } };
  await runTurn(playerQuestion, { ...opts, first: [call('prepare_club', { club: 'Southside' }), call('prepare_club', { club: 'Southside FC' })] });
  assert.deepEqual(snapshotRoute, ['Southside'], 'two spellings of one club start one build');
  // The same conversation, another turn: that club is done, a new one starts.
  await runTurn(playerQuestion, { ...opts, first: [call('prepare_club', { club: 'Southside' }), call('prepare_club', { club: 'Northside' })] });
  assert.deepEqual(snapshotRoute, ['Southside', 'Northside']);
  // Another conversation prepares its own.
  await runTurn(playerQuestion, { options: { conversationId: 'conv-prep-b' }, first: [call('prepare_club', { club: 'Southside' })] });
  assert.deepEqual(snapshotRoute, ['Southside', 'Northside', 'Southside']);
});

await test('prepare_club returns at once, is capped per turn and per conversation, and leaves a club the turn reads', () => {
  resetPrepared();
  const started: string[] = [];
  const prepare = createPreparer('conv-caps', ['Southside'], (c) => started.push(c));
  assert.equal(prepare({ club: 'southside fc' }).started, false, 'the turn already reads it');
  assert.equal(prepare({ club: 'Eastside' }).started, true);
  assert.equal(prepare({ club: 'Westside' }).started, true);
  assert.equal(prepare({ club: 'Northside' }).started, false, 'two per turn');
  const later = createPreparer('conv-caps', [], (c) => started.push(c));
  assert.equal(later({ club: 'Northside' }).started, true);
  assert.equal(later({ club: 'Midside' }).started, false, 'three per conversation');
  assert.equal(prepare({ club: '' }).started, false);
  assert.deepEqual(started, ['Eastside', 'Westside', 'Northside']);
  assert.equal(clubKey('Arsenal FC'), clubKey('arsenal'));
});

await test('the writer is told prepare is for the next step, not this answer', async () => {
  const t = await runTurn(playerQuestion);
  assert.ok((t.writer[0].prompt ?? '').includes('`prepare_club` is for the next step of the conversation, not for this answer'));
});

// ---------------------------------------------------------------------------------------------
// Offer

await test('offer_rating adds an offer for a player with no card, once', async () => {
  const t = await runTurn(playerQuestion, {
    first: [call('offer_rating', { name: 'Pedri', edition: 'current' }), call('offer_rating', { name: 'Pedri', edition: 'current' })],
  });
  assert.deepEqual(attachedIn(t.attached).scoutOffers, ['Pedri']);
});

await test('offer_rating for his prime offers the prime beside his current card', async () => {
  const t = await runTurn(playerQuestion, { first: [call('offer_rating', { name: 'Florian Wirtz', edition: 'prime' })] });
  assert.deepEqual(attachedIn(t.attached).scoutOffers, ['prime Florian Wirtz']);
});

await test('offer_rating never duplicates a card that is shown, or one that exists for that version', async () => {
  const t = await runTurn(playerQuestion, { first: [call('offer_rating', { name: 'Florian Wirtz', edition: 'current' })] });
  const a = attachedIn(t.attached);
  assert.equal(a.cards.length, 0);
  assert.deepEqual(a.scoutOffers, []);
  // A prime card he has is not offered again either.
  const both = await runTurn(playerQuestion, {
    cards: [card('Florian Wirtz'), card('Florian Wirtz', 'prime')],
    first: [call('offer_rating', { name: 'Florian Wirtz', edition: 'prime' })],
  });
  assert.deepEqual(attachedIn(both.attached).scoutOffers, []);
});

await test('offer_rating only offers: nothing is rated and the model is never asked to rate', async () => {
  const t = await runTurn(playerQuestion, { first: [call('offer_rating', { name: 'Pedri', edition: 'prime' })] });
  assert.deepEqual(attachedIn(t.attached).scoutOffers, ['prime Pedri']);
  assert.ok((t.writer[0].prompt ?? '').includes('You offer and never rate'));
});

await test('a player the model looked up and found missing is offered by rule only if the user named him', async () => {
  const composer = new ReplyComposer();
  const named = ['Pedri'];
  const tools = createDossierTools({
    cardsInPlay: [], localCards: [], historical: false, composer,
    offerMissing: (name) => askedDirectly(name, named, 'How does Pedri fit next to him?'),
  });
  const brought = (await tools.lookUp({ name: 'Gavi' })) as any;
  assert.equal(brought.found, false);
  assert.match(brought.note, /offer_rating/);
  assert.deepEqual(composer.scoutOffers, [], 'a player the model brought in is left to offer_rating');
  const asked = (await tools.lookUp({ name: 'Pedri' })) as any;
  assert.equal(asked.found, false);
  assert.deepEqual(composer.scoutOffers, ['Pedri'], 'a player asked about directly keeps the rule');
  // The chat loop passes no filter, so its behaviour is unchanged: every missing player is offered.
  const unfiltered = new ReplyComposer();
  await createDossierTools({ cardsInPlay: [], localCards: [], historical: false, composer: unfiltered }).lookUp({ name: 'Gavi' });
  assert.deepEqual(unfiltered.scoutOffers, ['Gavi']);
  assert.equal(askedDirectly('Florian Wirtz', [], 'Is Wirtz better than him?'), false, 'the full name is needed');
  assert.equal(askedDirectly('Wirtz', [], 'Is Wirtz better than him?'), true);
});

await test('the routing rule still offers a target player who has no card', async () => {
  const t = await runTurn('How good is Pedri?', {
    route: { ...playerRoute, targetPlayers: ['Pedri'] },
    cards: [],
    first: [{ text: 'He is very good.' }],
  });
  assert.deepEqual(attachedIn(t.attached).scoutOffers, ['Pedri']);
});

// ---------------------------------------------------------------------------------------------
// Go deeper, retired

await test('request_deeper is never offered and its rule never sent, on any stage turn', async () => {
  const present = await runTurn(playerQuestion, { first: [call('request_deeper', { reason: 'More to read.' })], final: 'The stage answer.' });
  const forced = await runTurn(playerQuestion, { options: { stage: true }, final: 'The stage answer.' });
  const past = await runTurn('How good was prime Florian Wirtz?', { route: pastRoute, final: 'An answer about the past.' });
  for (const t of [present, forced, past]) {
    assert.ok(!t.writer[0].tools.includes('request_deeper'));
    assert.ok(!(t.writer[0].prompt ?? '').includes('request_deeper'), 'no rule for it');
    assert.equal(attachedIn(t.attached).goDeeper, undefined);
    assert.ok(INITIATIVE.every((n) => t.writer[0].tools.includes(n)), 'ask, prepare and offer stay');
  }
  // A call to it anyway is an unknown tool: the turn still answers.
  assert.equal(present.reply, 'The stage answer.');
  assert.equal(INITIATIVE_RULES.hasOwnProperty('deeper'), false);
});


// ---------------------------------------------------------------------------------------------
// View tools

const VIEW_TOOLS = ['show_pitch', 'show_table', 'show_comparison', 'show_ranking', 'show_dossier'];
const kindsOf = (blocks: ReplyBlock[] | null) => (blocks ?? []).map((b) => b.kind);

await test('every prose turn is offered the four view tools and show_dossier, a thread about the past and a card-only turn included', async () => {
  const present = await runTurn('Who is top of the league?', { route: { ...playerRoute, analyticalMode: 'debate_or_verdict', needsSearch: false, targetPlayers: [] } });
  const past = await runTurn('How good was prime Florian Wirtz?', { route: pastRoute });
  const cardsOnly = await runTurn(playerQuestion);
  for (const [label, t] of [['present', present], ['past', past], ['cards only', cardsOnly]] as const) {
    assert.ok(VIEW_TOOLS.every((n) => t.writer[0].tools.includes(n)), `${label}: shown ${t.writer[0].tools}`);
    const prompt = t.writer[0].prompt ?? '';
    for (const tool of VIEW_TOOLS) assert.ok(prompt.includes(`\`${tool}\``), `${label}: the prompt has a line for ${tool}`);
    assert.ok(prompt.includes('A view lands where you call it'), label);
  }
});

await test('the view guidance is descriptive and joins the turn instructions, not the system prompt', async () => {
  const { viewRules } = await import('../prompts/chatPrompt');
  const { buildConversationalScoutInstruction } = await import('../prompts/chatPrompt');
  const rules = viewRules();
  assert.doesNotMatch(rules, /\b(Arsenal|Chelsea|Madrid|Messi|Saka|Wirtz|\d{2} Overall)\b/);
  for (const eaFc of [false, true]) assert.ok(!/show_table|show_ranking|show_comparison/.test(buildConversationalScoutInstruction(eaFc)), 'the system prompt stays byte-stable');
});

await test('Gaffa’s panel and a challenge turn are offered no view tool, and a call to one is unknown', async () => {
  const panel = await runTurn(playerQuestion, { options: { noRating: true }, first: [call('show_table', { league: 'Premier League' })], final: 'A plain answer for the panel.' });
  assert.ok(VIEW_TOOLS.filter((n) => n !== 'show_dossier').every((n) => !panel.writer[0].tools.includes(n)), `shown ${panel.writer[0].tools}`);
  assert.ok(!(panel.writer[0].prompt ?? '').includes('A view lands where you call it'));
  assert.deepEqual(kindsOf(panel.attached).filter((k) => k !== 'prose'), []);
  const wirtz = card('Florian Wirtz');
  const challenge = await runTurn('He should be a point higher.', {
    route: { ...playerRoute, intent: 'challenge_or_revise', targetPlayers: ['Florian Wirtz'] },
    options: { challengeCardKey: (await import('../services/dossierStore')).getCardKey(wirtz) },
    cards: [wirtz],
    final: 'The prose the writer gave.',
  });
  assert.ok(challenge.writer.every((w) => VIEW_TOOLS.filter((n) => n !== 'show_dossier').every((n) => !w.tools.includes(n))));
});

await test('a streamed reply puts a view where the model called it: text, the table, then the rest', async () => {
  const t = await runTurn('Who is top of the league?', {
    stream: true,
    first: [{ text: 'Arsenal lead the table. ' }, call('show_table', { league: 'Premier League', highlight: ['Arsenal'] })],
    final: 'The gap to Chelsea is small.',
  });
  assert.deepEqual(kindsOf(t.attached), ['prose', 'table', 'prose']);
  const blocks = t.attached!;
  assert.equal((blocks[0] as { text: string }).text, 'Arsenal lead the table.');
  assert.equal((blocks[2] as { text: string }).text, 'The gap to Chelsea is small.');
  assert.equal(t.reply, 'Arsenal lead the table.\n\nThe gap to Chelsea is small.');
  const table = blocks[1] as import('../types').ReadyBlock<'table'>;
  assert.equal(table.data.rows.length, 2);
  assert.deepEqual(table.data.highlight, ['Arsenal']);
});

await test('a reply that is not streamed has no text to anchor to, so its view follows the prose', async () => {
  const t = await runTurn('Who is top of the league?', {
    first: [call('show_table', { league: 'Premier League' })],
    final: 'Arsenal lead the table.',
  });
  assert.deepEqual(kindsOf(t.attached), ['prose', 'table']);
});

await test('show_dossier lands where it was called on a streamed reply, and a one-player question shows no card by rule', async () => {
  const shown = await runTurn(playerQuestion, {
    stream: true,
    first: [{ text: 'He is a high-end starter. ' }, call('show_dossier', { name: 'Florian Wirtz' })],
    final: 'His card has the detail.',
  });
  assert.deepEqual(kindsOf(shown.attached), ['prose', 'card', 'prose']);
  const plain = await runTurn(playerQuestion, { stream: true, first: [{ text: 'He is a high-end starter.' }] });
  assert.deepEqual(kindsOf(plain.attached), ['prose'], 'code attaches nothing: the model chose no card');
});

await test('a comparison of two carded players draws both cards, and one without a card is a reason the model reads', async () => {
  const cards = [card('Florian Wirtz'), card('Jamal Musiala')];
  const ok = await runTurn('Wirtz or Musiala?', {
    stream: true,
    cards,
    first: [{ text: 'Close call. ' }, call('show_comparison', { playerA: 'Florian Wirtz', playerB: 'Jamal Musiala' })],
    final: 'Musiala has the edge.',
  });
  assert.deepEqual(kindsOf(ok.attached), ['prose', 'comparison', 'prose']);
  const bad = await runTurn('Wirtz or Pedri?', {
    cards,
    first: [call('show_comparison', { playerA: 'Florian Wirtz', playerB: 'Pedri' })],
    final: 'I only have Wirtz rated.',
  });
  assert.deepEqual(kindsOf(bad.attached), ['prose'], 'a failed view draws nothing');
});

await test('a question the writer asks drops the views drawn before it', async () => {
  const t = await runTurn('Who is top of the league?', {
    stream: true,
    first: [{ text: 'Let me look. ' }, call('show_table', { league: 'Premier League' }), call('ask_user', { question: 'Which league?', options: ['Premier League', 'La Liga'] })],
  });
  assert.deepEqual(kindsOf(t.attached), ['prose', 'ask']);
  assert.equal(t.reply, 'Which league?');
});

// ---------------------------------------------------------------------------------------------
// Where the tools never reach

await test('Gaffa’s panel (noRating) is shown none of the four tools, and a call to one does nothing', async () => {
  const t = await runTurn(playerQuestion, {
    options: { noRating: true },
    first: [
      call('ask_user', { question: 'Which?', options: ['A', 'B'] }),
      call('prepare_club', { club: 'Southside' }),
      call('offer_rating', { name: 'Pedri', edition: 'current' }),
    ],
    final: 'A plain answer for the panel.',
  });
  assert.ok(INITIATIVE.every((n) => !t.writer[0].tools.includes(n)), `shown ${t.writer[0].tools}`);
  assert.ok(!(t.writer[0].prompt ?? '').includes('ask_user'));
  assert.equal(t.reply, 'A plain answer for the panel.');
  const a = attachedIn(t.attached);
  assert.equal(a.ask, undefined);
  assert.deepEqual(a.scoutOffers, []);
});

await test('the Gaffa panel module reads only the cards of a reply', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../services/gaffaChatApi.ts', import.meta.url), 'utf8');
  assert.ok(!/\.ask\b|goDeeper|scoutOffers/.test(source));
  assert.match(source, /noRating: true/);
});

await test('a challenge turn that falls back to prose is shown none of the four tools', async () => {
  const wirtz = card('Florian Wirtz');
  const t = await runTurn('He should be a point higher, his chance creation is elite.', {
    route: { ...playerRoute, intent: 'challenge_or_revise', targetPlayers: ['Florian Wirtz'] },
    options: { challengeCardKey: (await import('../services/dossierStore')).getCardKey(wirtz) },
    cards: [wirtz],
    first: [call('ask_user', { question: 'Which?', options: ['A', 'B'] })],
    final: 'The prose the writer gave.',
  });
  // The structured challenge call returns nothing usable offline, so the turn falls back to prose.
  assert.equal(t.writer.length > 0, true, 'the fallback reached the writer');
  assert.ok(INITIATIVE.every((n) => !t.writer[0].tools.includes(n)));
  assert.equal(attachedIn(t.attached).ask, undefined);
});

await test('the chat loop keeps its own tool set', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../services/chatTurn.ts', import.meta.url), 'utf8');
  assert.ok(!/ask_user|prepare_club|offer_rating|request_deeper|initiativeTools/.test(source));
});

// ---------------------------------------------------------------------------------------------
// The chat loop as the default

type ChatModel = import('../services/chatTurn').ChatModel;
type LoopScript = ({ text: string; calls: { name: string; args: Record<string, unknown> }[]; finishReason?: string } | (() => never))[];

/** A chat loop that plays back `script`, one entry per send; a function entry throws when reached. */
function fakeLoop(script: LoopScript) {
  const opened: string[][] = [];
  let sends = 0;
  const model: ChatModel = {
    open(args) {
      opened.push(args.declarations.map((d) => String(d.name)));
      return {
        async send(_message, { onText }) {
          const next = script[Math.min(sends++, script.length - 1)];
          const reply = typeof next === 'function' ? next() : next;
          if (reply.text) onText?.(reply.text);
          return reply;
        },
      };
    },
  };
  const deps = (extra: Record<string, unknown> = {}) => ({ model, tools: {} as any, snapshots: null, managers: async () => [], ...extra });
  return { opened, sends: () => sends, deps };
}
const says = (text: string) => ({ text, calls: [] as { name: string; args: Record<string, unknown> }[] });
const OTHER_THREE = ['ask_user', 'prepare_club', 'offer_rating'];
const FALLBACK_LABEL = 'Taking the standard route...';

/** A turn with the stage writer scripted (it answers plainly) and the chat loop as given; returns what each side saw. */
async function loopTurn(loop: ReturnType<typeof fakeLoop>, options: Record<string, unknown>, opts: { message?: string; route?: Record<string, unknown>; chatDeps?: Record<string, unknown> } = {}) {
  const labels: string[] = [];
  const t = await runTurn(opts.message ?? playerQuestion, {
    route: opts.route,
    first: [{ text: 'The stage answer.' }],
    final: 'The stage answer.',
    options: { ...options, chatDeps: loop.deps(opts.chatDeps), onStageChange: (l: string) => labels.push(l) },
  });
  return { ...t, labels };
}

await test('a present-day turn runs the loop and never reaches the writer', async () => {
  const loop = fakeLoop([says('The loop answer.')]);
  const t = await loopTurn(loop, { stage: false });
  assert.equal(t.reply, 'The loop answer.');
  assert.equal(t.writer.length, 0, 'the stage writer was not asked');
  assert.equal(loop.opened.length, 1);
  assert.ok(!loop.opened[0].includes('request_deeper'));
  assert.equal(attachedIn(t.attached).goDeeper, undefined);
});

await test('with past mode off, a past thread takes the stage pipeline, with the three initiative tools', async () => {
  const loop = fakeLoop([says('The loop answer.')]);
  const t = await loopTurn(loop, { stage: false, pastMode: false }, { message: 'How good was prime Florian Wirtz?', route: pastRoute });
  assert.equal(loop.opened.length, 0);
  assert.equal(t.writer.length > 0, true);
  assert.ok(OTHER_THREE.every((n) => t.writer[0].tools.includes(n)));
});

await test('the stage flag sends a present-day turn to the writer, and without it the loop answers', async () => {
  const plain = fakeLoop([says('The loop answer.')]);
  const stage = await runTurn(playerQuestion, { final: 'The stage answer.', options: { chatDeps: plain.deps() } });
  assert.equal(plain.opened.length, 0);
  assert.equal(stage.reply, 'A direct answer.');

  const loop = fakeLoop([says('The loop answer.')]);
  const answered = await loopTurn(loop, { stage: false });
  assert.equal(answered.reply, 'The loop answer.');
  assert.equal(answered.writer.length, 0);
});

await test('a loop that fails runs the writer once, after an error, an empty reply and a spent budget', async () => {
  const cases: [string, LoopScript, Record<string, unknown>][] = [
    [
      'error',
      [
        () => {
          throw new Error('model unavailable');
        },
      ],
      {},
    ],
    ['empty reply', [{ text: '', calls: [], finishReason: 'STOP' }], {}],
    [
      'spent budget',
      [{ text: '', calls: [{ name: 'get_league_table', args: { league: 'A' } }] }, { text: '', calls: [{ name: 'get_league_table', args: { league: 'B' } }] }, { text: '', calls: [] }],
      { budget: { rounds: 1 }, tools: { leagueTable: async () => ({ status: 'empty', result: null, missing: [] }) } },
    ],
  ];
  for (const [name, script, extra] of cases) {
    const loop = fakeLoop(script);
    const t = await loopTurn(loop, { stage: false }, { chatDeps: extra });
    assert.equal(t.reply, 'The stage answer.', name);
    assert.equal(loop.opened.length, 1, `${name}: the loop made one attempt`);
    assert.equal(t.writer.length, 1, `${name}: the writer ran once`);
    assert.ok(OTHER_THREE.every((n) => t.writer[0].tools.includes(n)), name);
    assert.equal(t.labels.filter((l) => l === FALLBACK_LABEL).length, 1, name);
  }
});

await test('a slow loop that answers is never followed by the writer', async () => {
  let clock = 0;
  const loop = fakeLoop([{ text: '', calls: [{ name: 'get_league_table', args: { league: 'A' } }] }, says('The late loop answer.')]);
  const t = await loopTurn(loop, { stage: false }, {
    chatDeps: { now: () => (clock += 60_000), tools: { leagueTable: async () => ({ status: 'empty', result: null, missing: [] }) } },
  });
  assert.equal(t.reply, 'The late loop answer.');
  assert.equal(t.writer.length, 0);
  assert.ok(!t.labels.includes(FALLBACK_LABEL));
});

// ---------------------------------------------------------------------------------------------
// The prompt

await test('the rules are descriptive: no quoted sample phrases, no names', () => {
  for (const [name, rule] of Object.entries(INITIATIVE_RULES)) {
    assert.ok(!/["“”]/.test(rule), `${name} quotes a phrase`);
    assert.ok(!/\b(Arsenal|Wirtz|Messi|Madrid|Barcelona|Liverpool)\b/.test(rule), `${name} names a player or club`);
  }
});

// ---------------------------------------------------------------------------------------------
// The chips

const ReplyChips = await import('../components/ReplyChips');
const { AskChips } = ReplyChips;

await test('the ask chips draw one button per option', () => {
  const html = renderToStaticMarkup(React.createElement(AskChips, { options: ['His current form', 'His prime'], onAsk: () => {} }));
  assert.match(html, /aria-label="Reply options"/);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
  assert.match(html, />His current form</);
  assert.match(html, />His prime</);
  assert.doesNotMatch(html, /disabled=""/);
});

await test('the Go deeper chip is gone, and a stored Go deeper flag still reads but draws nothing', async () => {
  assert.equal('GoDeeperChip' in ReplyChips, false);
  const { blocksOf, drawnBlocksOf } = await import('../services/replyBlocks');
  const old = {
    id: 'old-reply',
    sender: 'ai',
    content: 'An answer from when the chat loop was opt-in.',
    timestamp: 0,
    goDeeper: { reason: 'The recent lineups were not read.' },
  } as any;
  assert.deepEqual(blocksOf(old).map((b) => b.kind), ['prose', 'goDeeper'], 'the stored field still parses');
  assert.deepEqual(drawnBlocksOf(old).map((b) => b.kind), ['prose']);
  const stored = { ...old, goDeeper: undefined, blocks: blocksOf(old) };
  assert.deepEqual(drawnBlocksOf(stored).map((b) => b.kind), ['prose'], 'a reply stored as blocks too');
  const source = await (await import('node:fs/promises')).readFile(new URL('../components/ReplyBody.tsx', import.meta.url), 'utf8');
  assert.match(source, /drawnBlocksOf\(message\)/);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
