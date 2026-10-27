#!/usr/bin/env npx tsx
/**
 * Offline checks for dossier card identity, dating, sanitization and version enforcement.
 * No network, Supabase or Gemini access needed.
 *
 * Usage:
 *   npx tsx scripts/test-dossier-cards.ts
 */
import assert from 'node:assert/strict';
import type { PlayerProfile } from '../types';
import {
  ensureDossierDated,
  fetchPriorDossiersForPlayer,
  findReferencedDossiers,
  getCardKey,
  getDossierEvaluationDate,
  isCardInRefreshWindow,
  needsLatestUpdateRefresh,
  isPrimeCard,
  mergeAllCalibratedDossiers,
  mergeConversationDossiers,
  latestCardPerPlayer,
  dropSupersededPrimes,
  resolveSavedDossiersForRequest,
  toBasePlayerSlug,
  toDossierCardSlug,
  toVersionedSlug,
  upsertCachedDossier,
  applyDossierPatch,
  buildRevisionProposalsBlock,
  buildRevisionRow,
  hasRevisionConsensus,
  type DossierRevisionRow,
  CALIBRATION_EPOCH_MS,
  isRatedOnCurrentScale,
  mostRecentlyShownCard,
  pickCardPerPlayer,
  renameDossierCard,
  parseRequestedSeason,
  seasonMatches,
  seasonSpan,
  formatPrimeWindow,
} from '../services/dossierStore';
import { classifyTurn, extractCandidatePlayerName } from '../services/turnRouter';
import { SCOUT_CORE_INSTRUCTION } from '../prompts/scoutCore';
import { CONVERSATIONAL_SCOUT_MANDATE } from '../prompts/chatPrompt';
import { DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION } from '../prompts/dossierPrompt';
import { groundingShowsRetirement, parseCareerStatus } from '../services/groundingService';
import { applyVersionRules, sanitizeProfileData } from '../services/dossierSynthesizer';
import { getCurrentSeasonInfo } from '../services/aiClient';
import { getAttributeLabel, normalizePosition, resolveLiberoPosition } from '../constants/ratingTiers';
import { applyPeerPlacement, placementRange, resolvePlacement } from '../services/ratingPlacement';

const TODAY = new Date().toISOString().split('T')[0];
const MAY_2020_MS = Date.parse('2020-05-23T15:00:00Z');

let failures = 0;
let passes = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        passes++;
      },
      (err) => {
        failures++;
        console.error(`✗ ${name}\n  ${err instanceof Error ? err.message : err}`);
      },
    );
}

/** A minimal outfield card. `overrides` replaces top-level fields. */
function card(name: string, overrides: Partial<PlayerProfile> = {}): PlayerProfile {
  return {
    ...sanitizeProfileData({
      basicInfo: { name, age: 30, nationality: 'Germany', club: 'Bayern Munich', position: 'Defensive Midfielder' },
      ratings: { overall: 88, potential: 88 },
    }),
    version: undefined,
    evaluationDate: undefined,
    ...overrides,
  };
}

const currentCard = (name: string, date: string, extra: Partial<PlayerProfile> = {}) =>
  card(name, {
    evaluationDate: date,
    version: {
      id: `${toBasePlayerSlug(name)}-current-${date}`,
      type: 'current',
      label: 'Current Form',
      evaluationDate: date,
      seasonOrEra: '2026-27',
    },
    ...extra,
  });

const primeCard = (name: string, date: string, extra: Partial<PlayerProfile> = {}) =>
  card(name, {
    evaluationDate: date,
    version: {
      id: `${toBasePlayerSlug(name)}-prime-${date}`,
      type: 'prime',
      label: 'Prime Zenith (2019-20)',
      evaluationDate: date,
      seasonOrEra: '2019-20',
      peakContext: 'Treble season.',
    },
    ...extra,
  });

async function main() {
  // ── Card keys and slugs ──────────────────────────────────────────────────

  await test('base slug strips edition markers', () => {
    assert.equal(toBasePlayerSlug('Joshua Kimmich'), 'joshua-kimmich');
    assert.equal(toBasePlayerSlug('Joshua Kimmich (Prime)'), 'joshua-kimmich');
    assert.equal(toBasePlayerSlug('Prime Joshua Kimmich'), 'joshua-kimmich');
    assert.equal(toBasePlayerSlug('Peak Steven Gerrard'), 'steven-gerrard');
  });

  await test('current and prime cards of one player get distinct keys', () => {
    const cur = currentCard('Joshua Kimmich', '2026-10-25');
    const prime = primeCard('Joshua Kimmich', '2020-08-23');
    assert.equal(getCardKey(cur), 'joshua-kimmich:current:2026-10-25');
    assert.equal(getCardKey(prime), 'joshua-kimmich:prime:2020-08-23');
  });

  await test('two dated current cards of one player get distinct keys', () => {
    assert.notEqual(
      getCardKey(currentCard('Joshua Kimmich', '2026-10-20')),
      getCardKey(currentCard('Joshua Kimmich', '2026-10-25')),
    );
  });

  await test('renaming one card leaves the other card of the player alone', () => {
    const cur = currentCard('Joshua Kimmich', '2026-10-25');
    const prime = primeCard('Joshua Kimmich', '2020-08-23');
    const library = [cur, prime];
    const target = getCardKey(cur);
    const renamed = library.map((d) =>
      getCardKey(d) === target ? { ...d, basicInfo: { ...d.basicInfo, name: 'J. Kimmich' } } : d,
    );
    assert.equal(renamed[0].basicInfo.name, 'J. Kimmich');
    assert.equal(renamed[1].basicInfo.name, 'Joshua Kimmich');
    assert.equal(getCardKey(renamed[1]), getCardKey(prime));
  });

  await test('legacy current card without version is keyed by its creation day', () => {
    const legacy = card('Joshua Kimmich', { createdAt: MAY_2020_MS });
    assert.equal(getCardKey(legacy), 'joshua-kimmich:current:2020-05-23');
  });

  await test('legacy undated prime card falls back to createdAt, then "undated"', () => {
    const withCreated = card('Joshua Kimmich (Prime)', { createdAt: MAY_2020_MS });
    assert.equal(getCardKey(withCreated), `joshua-kimmich:prime:${MAY_2020_MS}`);
    const bare = card('Joshua Kimmich (Prime)');
    assert.equal(getCardKey(bare), 'joshua-kimmich:prime:undated');
  });

  await test('versioned and pointer slugs', () => {
    assert.equal(
      toVersionedSlug(currentCard('Joshua Kimmich', '2026-10-25')),
      'joshua-kimmich--current--2026-10-25',
    );
    assert.equal(
      toVersionedSlug(primeCard('Joshua Kimmich (Prime)', '2020-08-23')),
      'joshua-kimmich--prime--2020-08-23',
    );
    assert.equal(toVersionedSlug(card('Joshua Kimmich (Prime)')), null);
    assert.equal(toDossierCardSlug('Joshua Kimmich'), 'joshua-kimmich');
    assert.equal(toDossierCardSlug('Joshua Kimmich', true), 'prime-joshua-kimmich');
    assert.equal(toDossierCardSlug('Prime Joshua Kimmich', true), 'prime-joshua-kimmich');
  });

  await test('isPrimeCard: version type wins, name marker is the legacy fallback', () => {
    assert.equal(isPrimeCard(currentCard('Joshua Kimmich (Prime)', TODAY)), false);
    assert.equal(isPrimeCard(primeCard('Joshua Kimmich', '2020-08-23')), true);
    const retro = primeCard('Joshua Kimmich', '2020-08-23');
    retro.version!.type = 'retro';
    assert.equal(isPrimeCard(retro), true);
    assert.equal(isPrimeCard(card('Joshua Kimmich (Prime)')), true);
    assert.equal(isPrimeCard(card('Peak Gerrard')), true);
    assert.equal(isPrimeCard(card('Joshua Kimmich')), false);
  });

  // ── Dating ───────────────────────────────────────────────────────────────

  await test('future and malformed evaluation dates are rejected', () => {
    const future = currentCard('Joshua Kimmich', '2999-01-01', { createdAt: MAY_2020_MS });
    assert.equal(getDossierEvaluationDate(future), '2020-05-23');
    const malformed = primeCard('Joshua Kimmich', '2020-08');
    assert.equal(getDossierEvaluationDate(malformed), null);
  });

  await test('a prime card never falls back to its creation date', () => {
    const p = card('Joshua Kimmich (Prime)', { createdAt: MAY_2020_MS });
    assert.equal(getDossierEvaluationDate(p), null);
    assert.equal(ensureDossierDated(p, Date.now()), null);
  });

  await test('ensureDossierDated fills version and evaluationDate on a legacy current card', () => {
    const dated = ensureDossierDated(card('Joshua Kimmich', { createdAt: MAY_2020_MS }));
    assert.ok(dated);
    assert.equal(dated.evaluationDate, '2020-05-23');
    assert.equal(dated.version?.type, 'current');
    assert.equal(dated.version?.evaluationDate, '2020-05-23');
    assert.equal(dated.version?.seasonOrEra, '2019-20');
    assert.equal(dated.version?.label, 'Current Form (May 2020)');
  });

  await test('ensureDossierDated uses the fallback only for current cards', () => {
    const dated = ensureDossierDated(card('Joshua Kimmich'), MAY_2020_MS);
    assert.equal(dated?.evaluationDate, '2020-05-23');
    assert.equal(ensureDossierDated(card('Joshua Kimmich (Prime)'), MAY_2020_MS), null);
  });

  await test('ensureDossierDated keeps an existing version and its key', () => {
    const prime = primeCard('Joshua Kimmich', '2020-08-23');
    const dated = ensureDossierDated(prime, Date.now());
    assert.equal(dated?.version?.label, 'Prime Zenith (2019-20)');
    assert.equal(dated?.version?.peakContext, 'Treble season.');
    assert.equal(getCardKey(dated!), getCardKey(prime));
  });

  await test('a freshly dated prime card is stamped with its generation time, not its peak', () => {
    const now = Date.now();
    const dated = ensureDossierDated(primeCard('Steven Gerrard', '2009-05-24'), now);
    assert.equal(dated?.createdAt, now);
    assert.equal(mergeAllCalibratedDossiers([dated!], []).length, 1);
  });

  await test('ensureDossierDated rejects nameless input', () => {
    assert.equal(ensureDossierDated({} as PlayerProfile), null);
  });

  await test('current cards stay shared for a month; prime cards are frozen', () => {
    const now = Date.parse('2026-10-25T10:00:00Z');
    assert.equal(isCardInRefreshWindow(currentCard('Pedri', '2026-10-25'), now), true);
    assert.equal(isCardInRefreshWindow(currentCard('Pedri', '2026-09-26'), now), true);
    assert.equal(isCardInRefreshWindow(currentCard('Pedri', '2026-09-25'), now), false);
    assert.equal(isCardInRefreshWindow(card('Pedri'), now), false);
    assert.equal(isCardInRefreshWindow(primeCard('Pedri', '2021-05-01'), now), true);
  });

  await test('the Latest Update refreshes weekly inside the rating window', () => {
    const now = Date.parse('2026-10-25T10:00:00Z');
    assert.equal(needsLatestUpdateRefresh(currentCard('Pedri', '2026-10-19'), now), false);
    assert.equal(needsLatestUpdateRefresh(currentCard('Pedri', '2026-10-18'), now), true);
    // A refreshed card counts from its refresh stamp, not its rating date.
    assert.equal(
      needsLatestUpdateRefresh(currentCard('Pedri', '2026-10-01', { latestUpdateAsOf: '2026-10-20' }), now),
      false,
    );
    assert.equal(
      needsLatestUpdateRefresh(currentCard('Pedri', '2026-10-01', { latestUpdateAsOf: '2026-10-17' }), now),
      true,
    );
    // Out of the rating window the whole card is re-rated instead.
    assert.equal(needsLatestUpdateRefresh(currentCard('Pedri', '2026-09-20'), now), false);
    assert.equal(needsLatestUpdateRefresh(primeCard('Pedri', '2021-05-01'), now), false);
    const revision = { baseCardKey: 'pedri:current:2026-10-10', revisedAt: now };
    assert.equal(needsLatestUpdateRefresh(currentCard('Pedri', '2026-10-10', { revision }), now), false);
  });

  await test('positions: strikers file as Centre Forward; Libero only on sweeper-era cards', () => {
    assert.equal(normalizePosition('ST'), 'Centre Forward');
    assert.equal(normalizePosition('Striker/Second Striker'), 'Centre Forward/Second Striker');
    assert.equal(normalizePosition('Sweeper'), 'Libero');
    assert.equal(resolveLiberoPosition('Libero', true), 'Libero/Centre-Back');
    assert.equal(resolveLiberoPosition('Libero/Defensive Midfielder', true), 'Libero/Defensive Midfielder');
    assert.equal(resolveLiberoPosition('Defensive Midfielder/Libero', true), 'Libero/Defensive Midfielder');
    assert.equal(resolveLiberoPosition('Libero', false), 'Centre-Back');
    assert.equal(resolveLiberoPosition('Libero/Centre-Back', false), 'Centre-Back');
    assert.equal(resolveLiberoPosition('Centre-Back', true), 'Centre-Back');
  });

  // ── Merging dated cards ──────────────────────────────────────────────────

  await test('calibrated pool keeps only the newest current card per player', async () => {
    const now = Date.now();
    const older = currentCard('Joshua Kimmich', '2026-10-21', { createdAt: now, ratings: { overall: 86, potential: 86 } });
    const newer = currentCard('Joshua Kimmich', TODAY, { createdAt: now, ratings: { overall: 88, potential: 88 } });
    const prime = primeCard('Joshua Kimmich', '2020-08-23', { createdAt: now, ratings: { overall: 91, potential: 91 } });
    // Without Supabase this only seeds the in-memory shared pool, which lists before local cards.
    await upsertCachedDossier('', newer);
    const merged = mergeAllCalibratedDossiers([older, prime], []);
    const current = merged.filter((p) => !isPrimeCard(p));
    assert.equal(current.length, 1);
    assert.equal(current[0].ratings.overall, 88);
    assert.equal(merged.filter(isPrimeCard).length, 1);
    assert.equal(findReferencedDossiers('Kimmich', current, ['Kimmich']).length, 1);
  });

  await test('conversation and saved-archive lookups keep the newest current card', () => {
    const older = currentCard('Pedri', '2026-10-01', { ratings: { overall: 87, potential: 90 } });
    const newer = currentCard('Pedri', TODAY, { ratings: { overall: 89, potential: 91 } });
    const conv = mergeConversationDossiers([], [newer, older]);
    assert.deepEqual(conv.map((p) => p.ratings.overall), [89]);
    const saved = resolveSavedDossiersForRequest('pull up my saved dossier on Pedri', [older, newer], []);
    assert.deepEqual(saved.dossiers.map((p) => p.ratings.overall), [89]);
  });

  await test('prior-rating memory matches one player, never a namesake', async () => {
    const rated = { createdAt: CALIBRATION_EPOCH_MS + 1 };
    const bernardo = currentCard('Bernardo Silva', '2026-09-01', rated);
    const thiago = currentCard('Thiago Silva', '2026-09-02', rated);
    const xhakaOld = currentCard('Granit Xhaka', '2026-09-01', rated);
    const xhakaPrime = primeCard('Granit Xhaka', '2020-08-23', rated);
    const pool = [bernardo, thiago, xhakaOld, xhakaPrime];

    const bySurname = await fetchPriorDossiersForPlayer('Xhaka', pool);
    assert.deepEqual(bySurname.map(getCardKey), [getCardKey(xhakaPrime), getCardKey(xhakaOld)]);
    assert.deepEqual(await fetchPriorDossiersForPlayer('Silva', pool), []);
    const exact = await fetchPriorDossiersForPlayer('Bernardo Silva', pool);
    assert.deepEqual(exact.map((p) => p.basicInfo.name), ['Bernardo Silva']);
  });

  await test('cards rated before the recalibration never anchor a re-rating or get shared', async () => {
    const oldScale = currentCard('Pedri', '2026-09-01', { createdAt: CALIBRATION_EPOCH_MS - 1 });
    const unstamped = currentCard('Pedri', '2026-08-01');
    const newScale = currentCard('Pedri', '2026-10-24', { createdAt: CALIBRATION_EPOCH_MS + 1 });
    assert.equal(isRatedOnCurrentScale(oldScale), false);
    assert.equal(isRatedOnCurrentScale(unstamped), false);
    assert.equal(isRatedOnCurrentScale(unstamped, CALIBRATION_EPOCH_MS + 1), true);
    assert.equal(isRatedOnCurrentScale(newScale), true);

    const prior = await fetchPriorDossiersForPlayer('Pedri', [oldScale, unstamped, newScale]);
    assert.deepEqual(prior.map(getCardKey), [getCardKey(newScale)]);
    assert.deepEqual(await fetchPriorDossiersForPlayer('Pedri', [oldScale, unstamped]), []);
  });

  // ── Challenges and revisions ─────────────────────────────────────────────

  await test('an accepted challenge becomes a personal revision of the shared card', async () => {
    const shared = currentCard('Florian Wirtz', '2026-10-24', { createdAt: Date.now() });
    const revised = applyDossierPatch(shared, { targetPlayerName: 'Wirtz', overall: 91, attributes: { vision: 95 } });
    assert.equal(revised.revision?.baseCardKey, getCardKey(shared));
    assert.equal(getCardKey(revised), getCardKey(shared));
    const again = applyDossierPatch(revised, { targetPlayerName: 'Wirtz', attributes: { flair: 90 } });
    assert.equal(again.revision?.baseCardKey, getCardKey(shared));

    // Never written to the shared store: the in-memory shared pool stays without Wirtz.
    await upsertCachedDossier('', revised);
    assert.equal(mergeAllCalibratedDossiers([], []).some((p) => p.basicInfo.name === 'Florian Wirtz'), false);
  });

  await test('a revision row records what moved against the shared card', () => {
    const shared = currentCard('Florian Wirtz', '2026-10-24');
    const revised = applyDossierPatch(shared, { targetPlayerName: 'Wirtz', overall: 91, attributes: { vision: 95, finishing: 0 } });
    const row = buildRevisionRow(shared, revised, 'He runs the game', 'xA 0.4', 'client-a');
    assert.equal(row?.card_slug, 'florian-wirtz--current--2026-10-24');
    assert.deepEqual(row?.deltas, { overall: 91 - shared.ratings.overall, vision: 95 - shared.attributes.vision });
    assert.equal(buildRevisionRow(shared, shared, 'no change', '', 'client-a'), null);
    assert.equal(buildRevisionRow(card('Florian Wirtz (Prime)'), revised, 'undated', '', 'client-a'), null);
  });

  await test('consensus needs distinct people pushing the same way', () => {
    const row = (client: string, deltas: Record<string, number>): DossierRevisionRow => ({
      card_slug: 'x--current--2026-10-24', player_base: 'x', edition: 'current', card_date: '2026-10-24',
      deltas, rationale: null, evidence: null, client_id: client,
    });
    assert.equal(hasRevisionConsensus([row('a', { vision: 2 }), row('b', { vision: 1 }), row('c', { vision: 3 })]), true);
    assert.equal(hasRevisionConsensus([row('a', { vision: 2 }), row('a', { vision: 1 }), row('a', { vision: 3 })]), false);
    assert.equal(hasRevisionConsensus([row('a', { vision: 2 }), row('b', { vision: -1 }), row('c', { vision: 3 })]), false);
    const block = buildRevisionProposalsBlock([row('a', { vision: 2, overall: -1 })]);
    assert.match(block, /Vision \+2, Overall -1/);
    assert.equal(buildRevisionProposalsBlock([]), '');
  });

  // ── Sanitization ─────────────────────────────────────────────────────────

  await test('sanitize(null) returns the empty default card', () => {
    const p = sanitizeProfileData(null);
    assert.equal(p.basicInfo.name, 'N/A');
    assert.equal(p.ratings.overall, 0);
    assert.equal(p.version, undefined);
  });

  await test('sanitize leaves the new optional sections unset when the model omits them', () => {
    const p = sanitizeProfileData({ basicInfo: { name: 'Joshua Kimmich' } });
    for (const field of [
      'confidence',
      'scoutingDebate',
      'archetypeAnalysis',
      'ageCurve',
      'definingMoments',
      'signatureSpikes',
      'genuineFlaws',
      'peerBenchmark',
    ] as const) {
      assert.equal(p[field], undefined, field);
    }
  });

  await test('sanitize normalizes confidence, tags, age curve and moments', () => {
    const p = sanitizeProfileData({
      basicInfo: { name: 'Lamine Yamal', age: 19 },
      confidence: { grade: 'Z' as any, dataGaps: ['Small sample [1, 2]'] },
      archetypeAnalysis: { playstyleTags: ['a', 'b', '', 'c', 'd', 'e', 'f', 'g'] },
      ageCurve: { phase: 'Golden Era' as any },
      definingMoments: [{ year: '2024', title: 'Euro final' }, {}, { description: 'no title or year' }],
      calibration: {
        tierBand: '90_92_WORLD_CLASS' as any,
        peerBenchmark: 'Saka [3]',
        signatureSpikes: ['dribbling'],
        genuineFlaws: [],
      },
    });
    assert.equal(p.confidence?.grade, 'B');
    assert.deepEqual(p.confidence?.dataGaps, ['Small sample']);
    assert.ok(p.confidence?.verdict);
    assert.deepEqual(p.archetypeAnalysis?.playstyleTags, ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.equal(p.ageCurve?.phase, 'Emergent Runway');
    assert.deepEqual(p.definingMoments, [{ year: '2024', title: 'Euro final', description: '' }]);
    assert.deepEqual(p.signatureSpikes, ['dribbling']);
    assert.equal(p.genuineFlaws, undefined);
    assert.equal(p.peerBenchmark, 'Saka');
  });

  await test('sanitize dates a current card today and keeps a valid peak date', () => {
    const cur = sanitizeProfileData({ basicInfo: { name: 'Joshua Kimmich' } });
    assert.equal(cur.version?.type, 'current');
    assert.equal(cur.evaluationDate, TODAY);
    assert.equal(cur.version?.seasonOrEra, getCurrentSeasonInfo().currentSeason);

    const prime = sanitizeProfileData({
      basicInfo: { name: 'Steven Gerrard' },
      version: { type: 'prime', evaluationDate: '2009-05-24', seasonOrEra: '2008-09' },
    });
    assert.equal(prime.evaluationDate, '2009-05-24');
    assert.equal(prime.version?.label, 'Prime Zenith (2008-09)');
    assert.equal(prime.version?.id, 'steven-gerrard-prime-2009-05-24');
  });

  await test('sanitize never invents a peak date', () => {
    for (const evaluationDate of [undefined, '2999-01-01', '2009', 'May 2009']) {
      const p = sanitizeProfileData({
        basicInfo: { name: 'Steven Gerrard' },
        version: { type: 'prime', evaluationDate },
      });
      assert.equal(p.version?.evaluationDate, '', String(evaluationDate));
      assert.equal(p.evaluationDate, undefined, String(evaluationDate));
      assert.equal(p.version?.label, 'Prime Zenith');
    }
  });

  await test('spike and flaw keys have display labels', () => {
    assert.equal(getAttributeLabel('progressivePassing'), 'Progressive Passing');
    assert.equal(getAttributeLabel('GKpositioning'), 'GK Positioning');
    assert.equal(getAttributeLabel('Elite vision'), 'Elite vision');
  });

  // ── Version enforcement ──────────────────────────────────────────────────

  await test('current route pins today and strips peak context even if the model said prime', () => {
    const raw = sanitizeProfileData({
      basicInfo: { name: 'Joshua Kimmich' },
      version: { type: 'prime', evaluationDate: '2020-08-23', peakContext: 'Treble' },
    });
    const p = applyVersionRules(raw, false);
    const { month, year, currentSeason } = getCurrentSeasonInfo();
    assert.equal(p.version?.type, 'current');
    assert.equal(p.version?.evaluationDate, TODAY);
    assert.equal(p.evaluationDate, TODAY);
    assert.equal(p.version?.seasonOrEra, currentSeason);
    assert.equal(p.version?.label, `Current Form (${month} ${year})`);
    assert.equal(p.version?.peakContext, null);
    assert.equal(getCardKey(p), `joshua-kimmich:current:${TODAY}`);
  });

  await test('historical route keeps the verified peak date and edition', () => {
    const raw = sanitizeProfileData({
      basicInfo: { name: 'Steven Gerrard' },
      version: { type: 'season_snapshot', evaluationDate: '2009-05-24', seasonOrEra: '2008-09' },
    });
    const p = applyVersionRules(raw, true);
    assert.equal(p.version?.type, 'season_snapshot');
    assert.equal(p.version?.evaluationDate, '2009-05-24');
    assert.equal(p.version?.id, 'steven-gerrard-season_snapshot-2009-05-24');
    assert.equal(isPrimeCard(p), true);
  });

  await test('historical route without a peak date stays undated and out of the shared store', () => {
    const raw = sanitizeProfileData({
      basicInfo: { name: 'Steven Gerrard' },
      version: { type: 'prime' },
    });
    const p = applyVersionRules(raw, true);
    assert.equal(p.version?.evaluationDate, '');
    assert.equal(ensureDossierDated(p, Date.now()), null);
  });

  await test('historical route never keeps today as the peak date of a card the model called current', () => {
    const raw = sanitizeProfileData({
      basicInfo: { name: 'Steven Gerrard' },
      version: { type: 'current', evaluationDate: TODAY },
    });
    const p = applyVersionRules(raw, true);
    assert.equal(p.version?.type, 'prime');
    assert.equal(p.version?.evaluationDate, '');
    assert.equal(p.version?.seasonOrEra, '');
    assert.equal(p.version?.label, 'Prime Zenith');
    assert.equal(p.evaluationDate, undefined);
    assert.equal(ensureDossierDated(p, Date.now()), null);
  });

  await test('a named season becomes a season card, never the prime', () => {
    const asPrime = sanitizeProfileData({
      basicInfo: { name: 'Thierry Henry' },
      version: { type: 'prime', evaluationDate: '2006-05-17', seasonOrEra: '2005-06', peakContext: 'UCL final.' },
    });
    const p = applyVersionRules(asPrime, true, '2006');
    assert.equal(p.version?.type, 'season_snapshot');
    assert.equal(p.version?.label, 'Season (2005-06)');
    assert.equal(p.version?.id, 'thierry-henry-season_snapshot-2006-05-17');
    assert.equal(getCardKey(p), 'thierry-henry:season_snapshot:2006-05-17');

    // A season request the model labelled current carries no trustworthy date.
    const asCurrent = sanitizeProfileData({
      basicInfo: { name: 'Thierry Henry' },
      version: { type: 'current', evaluationDate: TODAY, seasonOrEra: '2026-27' },
    });
    const q = applyVersionRules(asCurrent, true, '2006');
    assert.equal(q.version?.type, 'season_snapshot');
    assert.equal(q.version?.evaluationDate, '');
    assert.equal(ensureDossierDated(q, Date.now()), null);
  });

  await test('a prime is one season, not a span', () => {
    assert.equal(isSingleSeason('2013-14'), true);
    assert.equal(isSingleSeason('1999-00'), true);
    assert.equal(isSingleSeason('1962'), true);
    assert.equal(isSingleSeason('2012-15'), false);
    assert.equal(isSingleSeason('1961-1963'), false);
    assert.equal(isSingleSeason('2010-13'), false);
    assert.equal(isSingleSeason('2013-2014'), true);
  });

  await test('the Hub lists one prime per player, the newest', async () => {
    const at = (n: number) => ({ createdAt: CALIBRATION_EPOCH_MS + n });
    const older = primeCard('Cristiano Ronaldo', '2014-05-24', { ...at(1), ratings: { overall: 98, potential: 98 } });
    const newer = primeCard('Cristiano Ronaldo', '2015-05-23', { ...at(2), ratings: { overall: 98, potential: 98 } });
    const season = primeCard('Cristiano Ronaldo', '2008-05-21', { ...at(3), ratings: { overall: 93, potential: 95 } });
    season.version = { ...season.version!, type: 'season_snapshot', seasonOrEra: '2007-08' };
    const items = await fetchGlobalHubDossiers([older, newer, season]);
    const keys = items.map((i) => getCardKey(i.profile)).sort();
    assert.deepEqual(keys, [
      'cristiano-ronaldo:prime:2015-05-23',
      'cristiano-ronaldo:season_snapshot:2008-05-21',
    ]);
  });

  await test('seasons parse from messages and match card seasons', () => {
    assert.equal(parseRequestedSeason('Rate Henry 2006'), '2006');
    assert.equal(parseRequestedSeason('Kaká 2006/07'), '2006-07');
    assert.equal(parseRequestedSeason('Kaká 2006-2007'), '2006-07');
    assert.equal(parseRequestedSeason('Rooney in the 2000s'), null);
    assert.equal(parseRequestedSeason('Rate Cole Palmer'), null);
    assert.equal(seasonMatches('2005-06', '2006'), true);
    assert.equal(seasonMatches('2006-07', '2006'), true);
    assert.equal(seasonMatches('2004-05', '2006'), false);
    assert.equal(seasonMatches('2006-07', '2005-06'), false);
    assert.equal(seasonMatches('2005-06', '2005-06'), true);
    assert.equal(extractCandidatePlayerName('Rate Thierry Henry 2006'), 'Thierry Henry');
    assert.equal(extractCandidatePlayerName('Ronaldo 2007/08'), 'Ronaldo');
  });

  await test('career status: retired players are recognized, active ones are not', () => {
    assert.equal(parseCareerStatus('RETIRED'), 'retired');
    assert.equal(parseCareerStatus('He is RETIRED.'), 'retired');
    assert.equal(parseCareerStatus('active'), 'active');
    assert.equal(parseCareerStatus(''), 'unknown');
    assert.equal(parseCareerStatus('UNKNOWN'), 'unknown');

    const retiredText = '- Retired from professional football in 2024 after a spell in the UAE.';
    assert.equal(groundingShowsRetirement(retiredText, null), true);
    // International retirement is not retirement.
    assert.equal(groundingShowsRetirement('- Retired from international football in 2024. Starts every league game.', null), false);
    // Current-season appearances overrule any mention of retirement.
    const playing = { name: 'X', seasonStats: { season: 2026, appearances: 9 } } as any;
    assert.equal(groundingShowsRetirement(retiredText, playing), false);
    assert.equal(groundingShowsRetirement('- Came out of retirement and retired again? No: came out of retirement in 2025.', null), false);
  });

  await test('accented and unaccented names resolve to the same shared card slug', () => {
    assert.equal(toDossierCardSlug('João Pedro'), 'joao-pedro');
    assert.equal(toDossierCardSlug('joao pedro'), 'joao-pedro');
    assert.equal(toDossierCardSlug('Kylian Mbappé'), toDossierCardSlug('kylian mbappe'));
    assert.equal(toDossierCardSlug('Martin Ødegaard'), 'martin-odegaard');
    assert.equal(toDossierCardSlug('Pelé', true), 'prime-pele');
  });

  await test('name references match across accents', () => {
    const joao = card('João Pedro');
    const neto = card('Pedro Neto');
    assert.deepEqual(findReferencedDossiers('rate joao pedro', [joao]).map((p) => p.basicInfo.name), ['João Pedro']);
    assert.deepEqual(findReferencedDossiers('how good is Joao?', [joao, neto]).map((p) => p.basicInfo.name), ['João Pedro']);
    assert.deepEqual(findReferencedDossiers('rate odegaard', [card('Martin Ødegaard')]).length, 1);
  });

  await test('a turn locks one card per player, in the edition it asks about', () => {
    const terryNow = card('John Terry');
    const terryPrime = primeCard('John Terry', '2005-05-07');
    const pele = primeCard('Pelé', '1970-06-21');
    const vvd = card('Virgil van Dijk');
    const editions = (cards: PlayerProfile[]) =>
      cards.map((p) => `${p.basicInfo.name}:${isPrimeCard(p) ? 'prime' : 'current'}`).sort();

    // Current-form turn: the current card wins whichever order they arrive in.
    assert.deepEqual(editions(pickCardPerPlayer([terryNow, terryPrime], false)), ['John Terry:current']);
    assert.deepEqual(editions(pickCardPerPlayer([terryPrime, terryNow], false)), ['John Terry:current']);
    // Peak turn: the prime card wins, and active players keep their current card.
    assert.deepEqual(editions(pickCardPerPlayer([terryPrime, terryNow, vvd], true)), [
      'John Terry:prime',
      'Virgil van Dijk:current',
    ]);
    // A legend with only a prime card keeps it on a current-form turn.
    assert.deepEqual(editions(pickCardPerPlayer([pele, vvd], false)), ['Pelé:prime', 'Virgil van Dijk:current']);
  });

  await test('a challenge revises the card the user was most recently shown', () => {
    const terryNow = card('John Terry');
    const terryPrime = primeCard('John Terry', '2005-05-07');
    const history = [
      { id: '1', sender: 'ai' as const, content: terryNow },
      { id: '2', sender: 'ai' as const, content: terryPrime },
      { id: '3', sender: 'user' as const, content: 'his passing should be higher' },
    ];
    assert.equal(mostRecentlyShownCard(history as any, [terryNow, terryPrime]), terryPrime);
    assert.equal(mostRecentlyShownCard(history.slice(0, 1) as any, [terryNow, terryPrime]), terryNow);
    assert.equal(mostRecentlyShownCard([], [terryNow]), undefined);
  });

  await test('renaming a card never changes its edition', () => {
    // Legacy prime card: no version, prime only because its name says so.
    const legacyPrime = card('Prime Kaká', { version: undefined, evaluationDate: undefined });
    assert.equal(isPrimeCard(legacyPrime), true);
    const renamed = renameDossierCard(legacyPrime, 'Kaká');
    assert.equal(renamed.basicInfo.name, 'Kaká');
    assert.equal(isPrimeCard(renamed), true);
    assert.equal(getDossierEvaluationDate(renamed), null);

    // Legacy current card renamed to something that reads as prime stays current, same date.
    const legacyCurrent = card('Bukayo Saka', { version: undefined, evaluationDate: undefined, createdAt: MAY_2020_MS });
    const peakName = renameDossierCard(legacyCurrent, 'Saka (Peak form)');
    assert.equal(isPrimeCard(peakName), false);
    assert.equal(getDossierEvaluationDate(peakName), getDossierEvaluationDate(legacyCurrent));

    // A versioned card keeps its version untouched.
    const prime = primeCard('John Terry', '2005-05-07');
    assert.deepEqual(renameDossierCard(prime, 'JT').version, prime.version);
  });

  // ── Peer placement ──────────────────────────────────────────────────────

  const rated = (base: PlayerProfile, overall: number): PlayerProfile => ({
    ...base,
    ratings: { overall, potential: overall },
  });
  const henry = rated(primeCard('Thierry Henry', '2004-05-15'), 95);
  const neymar = rated(primeCard('Neymar Jr', '2015-06-06'), 95);
  const neymarNow = rated(currentCard('Neymar Jr', TODAY), 84);
  const gullit = rated(primeCard('Ruud Gullit', '1988-05-24'), 96);
  const cruyff = rated(primeCard('Johan Cruyff', '1972-05-31'), 97);
  const salah = rated(primeCard('Mohamed Salah', '2018-05-26'), 95);
  const ledger = [cruyff, gullit, henry, neymar, neymarNow, salah];

  await test('better than peers rated 95 lifts a prime card above them', () => {
    const subject = rated(primeCard('Ronaldinho', '2006-05-17'), 95);
    const placed = applyPeerPlacement(
      subject,
      { betterThan: ['Thierry Henry [Prime 2003-04]', 'Neymar Jr', 'Mohamed Salah'], levelWith: [], notAsGoodAs: ['Johan Cruyff'] },
      ledger,
      true,
    );
    assert.equal(placed.ratings.overall, 96);
    assert.equal(placed.ratings.potential, 96);
    assert.deepEqual(placed.peerPlacement?.betterThan, ['Thierry Henry (2019-20)', 'Neymar Jr (2019-20)', 'Mohamed Salah (2019-20)']);
    assert.deepEqual(placed.peerPlacement?.notAsGoodAs, ['Johan Cruyff (2019-20)']);
  });

  await test('a placement that agrees with the Overall changes nothing but is recorded', () => {
    const subject = rated(primeCard('Kaká', '2007-05-23'), 94);
    const placed = applyPeerPlacement(subject, { betterThan: [], levelWith: [], notAsGoodAs: ['Thierry Henry'] }, ledger, true);
    assert.equal(placed.ratings.overall, 94);
    assert.deepEqual(placed.peerPlacement?.notAsGoodAs, ['Thierry Henry (2019-20)']);
  });

  await test('level with a peer means the same Overall', () => {
    const subject = rated(primeCard('Rivaldo', '1999-05-16'), 94);
    assert.equal(applyPeerPlacement(subject, { betterThan: [], levelWith: ['Henry'], notAsGoodAs: [] }, ledger, true).ratings.overall, 95);
  });

  await test('no room between two integer ratings allows a tie', () => {
    const range = placementRange({ betterThan: [henry], levelWith: [], notAsGoodAs: [gullit] });
    assert.deepEqual(range, { min: 95, max: 96 });
  });

  await test('a self-contradictory placement leaves the card as rated', () => {
    const subject = rated(primeCard('Kaká', '2007-05-23'), 94);
    const placed = applyPeerPlacement(subject, { betterThan: ['Johan Cruyff'], levelWith: [], notAsGoodAs: ['Thierry Henry'] }, ledger, true);
    assert.equal(placed, subject);
  });

  await test('placement names resolve to the edition being rated, never to the player himself', () => {
    const currentSubject = rated(currentCard('Kylian Mbappé', TODAY), 90);
    assert.deepEqual(resolvePlacement({ betterThan: ['Neymar Jr'], levelWith: [], notAsGoodAs: [] }, ledger, currentSubject).betterThan, [neymarNow]);
    const primeSubject = rated(primeCard('Kaká', '2007-05-23'), 94);
    assert.deepEqual(resolvePlacement({ betterThan: ['Neymar Jr'], levelWith: [], notAsGoodAs: [] }, ledger, primeSubject).betterThan, [neymar]);
    const self = resolvePlacement({ betterThan: ['Mohamed Salah'], levelWith: [], notAsGoodAs: [] }, ledger, rated(currentCard('Mohamed Salah', TODAY), 88));
    assert.deepEqual(self.betterThan, []);
  });

  await test('unknown and ambiguous placement names are ignored', () => {
    const ronaldos = [rated(primeCard('Cristiano Ronaldo', '2014-05-24'), 98), rated(primeCard('Ronaldo Nazário', '1997-05-14'), 97)];
    const subject = rated(primeCard('Kaká', '2007-05-23'), 94);
    const resolved = resolvePlacement({ betterThan: ['Ronaldo', 'Somebody Unrated'], levelWith: [], notAsGoodAs: [] }, ronaldos, subject);
    assert.deepEqual(resolved.betterThan, []);
    assert.equal(applyPeerPlacement(subject, { betterThan: ['Ronaldo'], levelWith: [], notAsGoodAs: [] }, ronaldos, true), subject);
  });

  // ── Prime windows ───────────────────────────────────────────────────────

  await test('season spans read single seasons, windows and calendar years', () => {
    assert.deepEqual(seasonSpan('2005-06'), [2005, 2005]);
    assert.deepEqual(seasonSpan('2003-06'), [2003, 2005]);
    assert.deepEqual(seasonSpan('1999-02'), [1999, 2001]);
    assert.deepEqual(seasonSpan('1962'), [1962, 1962]);
    assert.equal(seasonSpan('2011–12 Season'), null);
  });

  await test('a prime window is written from its first and last season', () => {
    assert.deepEqual(formatPrimeWindow('2003-04', '2005-06'), { seasonOrEra: '2003-06', seasons: 3 });
    assert.deepEqual(formatPrimeWindow('2005-06', '2005-06'), { seasonOrEra: '2005-06', seasons: 1 });
    assert.deepEqual(formatPrimeWindow('2004/05', '2005–06'), { seasonOrEra: '2004-06', seasons: 2 });
    assert.deepEqual(formatPrimeWindow('1958', '1962'), { seasonOrEra: '1958-1962', seasons: 5 });
    assert.equal(formatPrimeWindow('2005-06', '2003-04'), null);
    assert.equal(formatPrimeWindow('2003-05', '2005-06'), null);
    assert.equal(formatPrimeWindow(undefined, '2005-06'), null);
  });

  await test('a multi-season prime window never stands in for one of its seasons', () => {
    assert.equal(seasonMatches('2003-06', '2005-06'), false);
    assert.equal(seasonMatches('2003-06', '2004'), false);
    // A one-season prime still is that season's card.
    assert.equal(seasonMatches('2005-06', '2005-06'), true);
    assert.equal(seasonMatches('2005-06', '2006'), true);
  });

  await test('a prime card takes its season and label from its window', () => {
    const p = sanitizeProfileData({
      basicInfo: { name: 'Ronaldinho', age: 25, nationality: 'Brazil', club: 'FC Barcelona', position: 'Left Winger' },
      ratings: { overall: 96, potential: 96 },
      version: {
        type: 'prime',
        label: 'Prime Zenith (2004–06 Era)',
        evaluationDate: '2006-05-17',
        seasonOrEra: '2004-06',
        primeWindow: { startSeason: '2003-04', endSeason: '2005-06' },
      },
    } as any);
    assert.equal(p.version?.seasonOrEra, '2003-06');
    assert.equal(p.version?.label, 'Prime Zenith (2003-06)');
    assert.deepEqual(p.version?.primeWindow, { startSeason: '2003-04', endSeason: '2005-06' });
  });

  await test('a prime card with only a season gets a one-season window', () => {
    const p = sanitizeProfileData({
      basicInfo: { name: 'Thierry Henry', age: 26, nationality: 'France', club: 'Arsenal', position: 'Centre Forward' },
      ratings: { overall: 95, potential: 95 },
      version: { type: 'prime', label: 'Prime Zenith (2003–04 Season)', evaluationDate: '2004-05-15', seasonOrEra: '2003-04' },
    } as any);
    assert.equal(p.version?.label, 'Prime Zenith (2003-04)');
    assert.deepEqual(p.version?.primeWindow, { startSeason: '2003-04', endSeason: '2003-04' });
  });

  await test('a season card and a current card carry no prime window', () => {
    const prime = sanitizeProfileData({
      basicInfo: { name: 'Ronaldinho', age: 25, nationality: 'Brazil', club: 'FC Barcelona', position: 'Left Winger' },
      ratings: { overall: 96, potential: 96 },
      version: {
        type: 'prime',
        label: 'x',
        evaluationDate: '2006-05-17',
        seasonOrEra: '2003-06',
        primeWindow: { startSeason: '2003-04', endSeason: '2005-06' },
      },
    } as any);
    assert.equal(applyVersionRules(prime, true, '2005-06').version?.primeWindow, undefined);
    assert.equal(applyVersionRules(prime, false).version?.primeWindow, undefined);
    assert.deepEqual(applyVersionRules(prime, true).version?.primeWindow, prime.version?.primeWindow);
  });

  // ── Prime rerate ────────────────────────────────────────────────────────

  const route = (message: string, conversationDossiers: PlayerProfile[] = []) =>
    classifyTurn({ message, history: [], conversationDossiers, hasImage: false });

  await test('"rerate prime <player>" regenerates the prime card', async () => {
    const r = await route('rerate prime Ronaldinho');
    assert.equal(r.intent, 'single_dossier');
    assert.equal(r.rerate, true);
    assert.equal(r.isHistorical, true);
    assert.equal(r.wantsRegeneration, true);
    assert.match(r.targetPlayers[0], /Ronaldinho/);
    assert.equal((await route('Re-rate prime Thierry Henry')).rerate, true);
  });

  await test('"rate prime <player>" is an ordinary request', async () => {
    const r = await route('rate prime Ronaldinho');
    assert.equal(r.intent, 'single_dossier');
    assert.ok(!r.rerate);
    assert.equal(r.wantsRegeneration, false);
  });

  await test('"rerate him" re-rates the card just shown, in its edition', async () => {
    const shown = primeCard('Ronaldinho', '2006-05-17');
    const r = await route('rerate him', [shown]);
    assert.equal(r.rerate, true);
    assert.deepEqual(r.targetPlayers, ['Ronaldinho']);
    assert.equal(r.isHistorical, true);
  });

  await test('a re-rated prime card replaces the old one in pools', () => {
    const old = primeCard('Ronaldinho', '2006-05-17', { createdAt: 2_000 });
    const rerated = primeCard('Ronaldinho', '2005-05-29', { createdAt: 1_000, rerateAt: 5_000 });
    const season = card('Ronaldinho', {
      evaluationDate: '2002-06-30',
      version: { id: 'r-s', type: 'season_snapshot', label: 'Season (2001-02)', evaluationDate: '2002-06-30', seasonOrEra: '2001-02' },
    });
    const kept = latestCardPerPlayer([rerated, old, season]);
    assert.equal(kept.length, 2);
    assert.ok(kept.includes(rerated));
    assert.ok(kept.includes(season));
    // Without re-ratings, the later generated prime card wins.
    assert.deepEqual(latestCardPerPlayer([old, primeCard('Ronaldinho', '2005-05-29', { createdAt: 1_000 })]), [old]);
  });

  await test('a re-rated prime with a new window supersedes the old prime card everywhere', () => {
    // The re-rating moved the window, so the old card keeps its own archive row and card key.
    const old = primeCard('Pelé', '1962-10-11', { createdAt: 2_000 });
    const rerated = primeCard('Pelé', '1963-11-16', { createdAt: 5_000, rerateAt: 5_000 });
    const season = card('Pelé', {
      evaluationDate: '1958-06-29',
      version: { id: 'p-s', type: 'season_snapshot', label: 'Season (1958)', evaluationDate: '1958-06-29', seasonOrEra: '1958' },
    });
    const other = primeCard('Garrincha', '1962-06-17', { createdAt: 1_000 });
    assert.notEqual(getCardKey(old), getCardKey(rerated));
    const kept = dropSupersededPrimes([old, rerated, season, other]);
    assert.deepEqual(kept, [rerated, season, other]);
    // Without a re-rating, nothing is dropped.
    assert.deepEqual(dropSupersededPrimes([old, other]), [old, other]);
  });

  await test('no scouting prompt mentions re-rating', () => {
    for (const prompt of [SCOUT_CORE_INSTRUCTION, CONVERSATIONAL_SCOUT_MANDATE, DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION]) {
      assert.doesNotMatch(prompt, /\bre-?rate\b/i);
    }
  });

  console.log(`${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
