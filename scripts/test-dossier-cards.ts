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
  isPrimeCard,
  mergeAllCalibratedDossiers,
  mergeConversationDossiers,
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
  mostRecentlyShownCard,
  pickCardPerPlayer,
} from '../services/dossierStore';
import { applyVersionRules, sanitizeProfileData } from '../services/dossierSynthesizer';
import { getCurrentSeasonInfo } from '../services/aiClient';
import { getAttributeLabel } from '../constants/ratingTiers';

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

  await test('current cards stay shared for a week; prime cards are frozen', () => {
    const now = Date.parse('2026-10-25T10:00:00Z');
    assert.equal(isCardInRefreshWindow(currentCard('Pedri', '2026-10-25'), now), true);
    assert.equal(isCardInRefreshWindow(currentCard('Pedri', '2026-10-19'), now), true);
    assert.equal(isCardInRefreshWindow(currentCard('Pedri', '2026-10-18'), now), false);
    assert.equal(isCardInRefreshWindow(card('Pedri'), now), false);
    assert.equal(isCardInRefreshWindow(primeCard('Pedri', '2021-05-01'), now), true);
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
    const bernardo = currentCard('Bernardo Silva', '2026-09-01');
    const thiago = currentCard('Thiago Silva', '2026-09-02');
    const xhakaOld = currentCard('Granit Xhaka', '2026-09-01');
    const xhakaPrime = primeCard('Granit Xhaka', '2020-08-23');
    const pool = [bernardo, thiago, xhakaOld, xhakaPrime];

    const bySurname = await fetchPriorDossiersForPlayer('Xhaka', pool);
    assert.deepEqual(bySurname.map(getCardKey), [getCardKey(xhakaPrime), getCardKey(xhakaOld)]);
    assert.deepEqual(await fetchPriorDossiersForPlayer('Silva', pool), []);
    const exact = await fetchPriorDossiersForPlayer('Bernardo Silva', pool);
    assert.deepEqual(exact.map((p) => p.basicInfo.name), ['Bernardo Silva']);
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

  console.log(`${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
