import { describe, expect, it } from 'vitest';
import { assertValidOutlook, validateOutlook } from '../gates/validateOutlook';
import {
  findUnverifiedManagerMentions,
  pickCurrentCoach,
  sameCoach,
  scrubFormerCoaches,
  scrubUnverifiedManagerText,
} from '../gates/managerMentions';
import { buildOutlookSearchQueries } from '../pipeline/queryGen';
import type { OutlookContextBag, OutlookExtraction, PlayerOutlook } from '../types/outlook';

const SAMPLE_BAG: OutlookContextBag = {
  player_id: '11111111-1111-1111-1111-111111111111',
  name: 'James Tarkowski',
  display_name: 'James Tarkowski',
  age: 32,
  nationality: 'England',
  club: 'Everton',
  primary_position: 'CB',
  secondary_positions: [],
  availability: 'available',
  injury_news: null,
  market_value_eur_m: 12,
  is_new_to_prem: false,
  academy_eligible: false,
  simulation_date: '2026-08-26',
  current_season: '2026-27',
  is_dynasty_league: true,
  pl_tenure: 'established',
};

const SAMPLE_EXTRACTION: OutlookExtraction = {
  verified_facts: ['First-choice centre-back at Everton'],
  status_summary: 'Fit and available',
  role_summary: 'Nailed starter at centre-back',
  career_phase: 'plateau',
  data_gaps: [],
  conflicting_reports: [],
  current_head_coach: null,
  pl_mobility: 'stable',
  mobility_summary: 'Established at Everton with no exit links reported',
};

function makeOutlook(text: string, confidence: 'high' | 'medium' | 'low' = 'high'): PlayerOutlook {
  return {
    outlook: text,
    sidecar: {
      evaluation_tags: ['reliable_starter'],
      confidence,
      horizons_touched: ['near', 'long'],
      evidence_gaps: [],
      generated_at: '2026-08-26T00:00:00.000Z',
      model_id: 'gemini-3.8-flash',
      pipeline_version: '0.2.0',
    },
  };
}

describe('buildOutlookSearchQueries', () => {
  it('returns four deterministic queries including coach and PL mobility', () => {
    const queries = buildOutlookSearchQueries(SAMPLE_BAG);
    expect(queries).toHaveLength(4);
    expect(queries.every((q) => q.includes('James Tarkowski') || q.includes('Everton'))).toBe(true);
    expect(queries.some((q) => q.includes('head coach'))).toBe(true);
    expect(queries.some((q) => q.includes('transfer exit'))).toBe(true);
  });
});

describe('validateOutlook', () => {
  it('accepts a valid outlook paragraph', () => {
    const outlook = makeOutlook(
      'James Tarkowski is fit and entrenched as Everton\'s first-choice centre-back, logging heavy defensive volume most weeks with limited progressive carrying. At 32 he profiles as a plateau-phase starter whose value is durability and aerial defending rather than upside growth. Expect steady minutes and a reliable floor with occasional set-piece threat, and a longer arc defined by reliability over breakout potential rather than a changing role.',
    );
    const result = validateOutlook(outlook, SAMPLE_EXTRACTION, SAMPLE_BAG);
    expect(result.ok).toBe(true);
  });

  it('rejects trade advice phrasing', () => {
    const outlook = makeOutlook(
      'Tarkowski is a nailed Everton centre-back with steady minutes and defensive volume across the season. At 32 he remains a durable starter rather than an upside play, with aerial defending and clearances defining his weekly output. Managers should buy him before the price moves and hold through the fixture run because his floor is secure. Over the longer arc he profiles as a plateau-phase defender whose value is reliability rather than growth.',
    );
    const result = validateOutlook(outlook, SAMPLE_EXTRACTION, SAMPLE_BAG);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('banned phrase'))).toBe(true);
  });

  it('rejects high confidence with many evidence gaps', () => {
    const outlook = makeOutlook(
      'James Tarkowski is fit and entrenched as Everton\'s first-choice centre-back, logging heavy defensive volume most weeks with limited progressive carrying. At 32 he profiles as a plateau-phase starter whose value is durability and aerial defending rather than upside growth. Expect steady minutes and a reliable floor with occasional set-piece threat, and a longer arc defined by reliability over breakout potential rather than a changing role.',
      'high',
    );
    const extraction: OutlookExtraction = {
      ...SAMPLE_EXTRACTION,
      data_gaps: ['a', 'b', 'c'],
    };
    const outlookWithGaps = {
      ...outlook,
      sidecar: { ...outlook.sidecar, evidence_gaps: ['x', 'y', 'z'] },
    };
    const result = validateOutlook(outlookWithGaps, extraction, SAMPLE_BAG);
    expect(result.ok).toBe(false);
  });

  it('assertValidOutlook throws on failure', () => {
    const outlook = makeOutlook('Too short.');
    expect(() => assertValidOutlook(outlook, SAMPLE_EXTRACTION, SAMPLE_BAG)).toThrow();
  });

  it('rejects stale manager names not verified in extraction', () => {
    const extraction: OutlookExtraction = {
      ...SAMPLE_EXTRACTION,
      current_head_coach: 'Xabi Alonso',
      verified_facts: ['Xabi Alonso is Chelsea head coach as of August 2026'],
    };
    const outlook = makeOutlook(
      'Estêvão is available and integrated into Enzo Maresca\'s attacking rotation at Chelsea, where the teenager profiles as an inverted winger with heavy 1v1 usage when selected. Near term minutes may fluctuate while Chelsea manage his load across competitions, though his direct dribbling offers genuine upside in open games. Longer term he remains a high-ceiling wide forward whose value tracks starting frequency and physical durability more than a reinvented role under a new coach.',
    );
    const result = validateOutlook(outlook, extraction, SAMPLE_BAG);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('unverified manager'))).toBe(true);
  });

  it('does not misflag lowercase or club possessives as unverified managers', () => {
    const text =
      "James Tarkowski operates inside his club's system and Everton's setup while thriving under Champions League pressure.";
    expect(
      findUnverifiedManagerMentions(text, {
        currentHeadCoach: null,
        verifiedFacts: [],
        supplementalCorpus: ['Everton'],
      }),
    ).toEqual([]);
  });

  it('scrubs unverified manager attributions cleanly in place', () => {
    const raw =
      "Estêvão thrives in Enzo Maresca's system and operates under Mauricio Pochettino at the club.";
    const ctx = {
      currentHeadCoach: 'Xabi Alonso',
      verifiedFacts: ['Xabi Alonso is Chelsea head coach'],
      supplementalCorpus: ['Chelsea'],
    };
    const scrubbed = scrubUnverifiedManagerText(raw, ctx);
    expect(findUnverifiedManagerMentions(scrubbed, ctx)).toEqual([]);
    expect(scrubbed).toContain("Xabi Alonso's system");
    expect(scrubbed).toContain('under Xabi Alonso at the club.');
  });

  it('scrubs capitalized "Under Enzo Maresca" and possessive "In Maresca\'s setup" into Xabi Alonso', () => {
    const raw =
      "• Moisés Caicedo (Chelsea): Under Enzo Maresca, Caicedo functions as the central defensive fulcrum. In Maresca's tactical setup, he covers ground.";
    const scrubbed = scrubUnverifiedManagerText(raw, {
      currentHeadCoach: 'Xabi Alonso',
      verifiedFacts: ['Xabi Alonso is Chelsea head coach'],
      supplementalCorpus: ['Chelsea'],
    });
    expect(scrubbed).not.toContain('Maresca');
    expect(scrubbed).toContain('Under Xabi Alonso');
    expect(scrubbed).toContain("Xabi Alonso's tactical setup");
  });
});

describe('pickCurrentCoach', () => {
  const CHELSEA = 49;
  // Shaped like API-Football's /coachs?team=49 response: every coach who ever managed the team.
  const coachsResponse = [
    {
      id: 1,
      name: 'M. Pochettino',
      firstname: 'Mauricio',
      lastname: 'Pochettino',
      career: [
        { team: { id: 2384, name: 'USA' }, start: '2024-09-01', end: null },
        { team: { id: CHELSEA, name: 'Chelsea' }, start: '2023-07-01', end: '2024-05-31' },
      ],
    },
    {
      id: 2,
      name: 'L. Rosenior',
      firstname: 'Liam',
      lastname: 'Rosenior',
      // Stale open stint API-Football never closed.
      career: [{ team: { id: CHELSEA, name: 'Chelsea' }, start: '2026-01-06', end: null }],
    },
    {
      id: 3,
      name: 'X. Alonso',
      firstname: 'Xabi',
      lastname: 'Alonso',
      career: [
        { team: { id: CHELSEA, name: 'Chelsea' }, start: '2026-07-01', end: null },
        { team: { id: 168, name: 'Bayer Leverkusen' }, start: '2022-10-05', end: '2025-06-30' },
      ],
    },
  ];

  it('picks the open stint at this team with the latest start', () => {
    expect(pickCurrentCoach(coachsResponse, CHELSEA)).toEqual({
      coach: 'Xabi Alonso',
      coachSince: '2026-07-01',
    });
  });

  it('ignores open stints at other teams', () => {
    expect(pickCurrentCoach(coachsResponse.slice(0, 2), CHELSEA)).toEqual({
      coach: 'Liam Rosenior',
      coachSince: '2026-01-06',
    });
  });

  it('falls back to the first coach, undated, when no stint is open', () => {
    expect(pickCurrentCoach([coachsResponse[0]], CHELSEA)).toEqual({
      coach: 'Mauricio Pochettino',
      coachSince: null,
    });
    expect(pickCurrentCoach([{ name: 'Someone' }], CHELSEA)).toEqual({
      coach: 'Someone',
      coachSince: null,
    });
  });

  it('handles empty or malformed responses', () => {
    expect(pickCurrentCoach([], CHELSEA)).toEqual({ coach: null, coachSince: null });
    expect(pickCurrentCoach(undefined, CHELSEA)).toEqual({ coach: null, coachSince: null });
  });
});

describe('sameCoach', () => {
  it('matches across accents and full-name vs surname', () => {
    expect(sameCoach('Rúben Amorim', 'Ruben Amorim')).toBe(true);
    expect(sameCoach('Xabi Alonso', 'Alonso')).toBe(true);
    expect(sameCoach('Xabi Alonso', 'Enzo Maresca')).toBe(false);
    expect(sameCoach('Xabi Alonso', 'Xabi')).toBe(true);
    expect(sameCoach(null, 'Xabi Alonso')).toBe(false);
  });

  it('does not match a short fragment inside another name', () => {
    expect(sameCoach('Arne Slot', 'Slo')).toBe(false);
  });
});

describe('scrubFormerCoaches', () => {
  const chelsea = { club: 'Chelsea', coach: 'Xabi Alonso', previousCoach: 'Liam Rosenior' };
  const city = { club: 'Manchester City', coach: 'Enzo Maresca', previousCoach: 'Pep Guardiola' };

  it("rewrites a club's previous coach only when the text names that club", () => {
    expect(scrubFormerCoaches('Chelsea under Liam Rosenior pressed high.', [chelsea])).toBe(
      'Chelsea under Xabi Alonso pressed high.',
    );
    expect(scrubFormerCoaches("Liam Rosenior's Strasbourg side pressed high.", [chelsea])).toBe(
      "Liam Rosenior's Strasbourg side pressed high.",
    );
  });

  it('never rewrites a coach who currently manages one of the given clubs', () => {
    const moved = { club: 'Chelsea', coach: 'Xabi Alonso', previousCoach: 'Enzo Maresca' };
    const text = "Chelsea fans remember Enzo Maresca's system; Manchester City now play it.";
    expect(scrubFormerCoaches(text, [moved, city])).toBe(text);
  });

  it('does nothing without verified managers or a previous coach', () => {
    const text = 'Chelsea under Liam Rosenior pressed high.';
    expect(scrubFormerCoaches(text, [])).toBe(text);
    expect(scrubFormerCoaches(text, [{ club: 'Chelsea', coach: 'Xabi Alonso' }])).toBe(text);
  });
});

describe('strict current-coach mode', () => {
  const ctx = {
    currentHeadCoach: 'Xabi Alonso',
    currentClub: 'Chelsea',
    // Search text that mentions the sacked coach would normally count as verifying him.
    verifiedFacts: ['Chelsea sacked Enzo Maresca and appointed Xabi Alonso.'],
  };

  it('lets a name through when it only appears in grounding text, in normal mode', () => {
    expect(findUnverifiedManagerMentions("He thrives in Maresca's system.", ctx)).toEqual([]);
  });

  it('allows only the verified coach in strict mode', () => {
    const strict = { ...ctx, strictCurrentCoach: true };
    expect(findUnverifiedManagerMentions("He thrives in Maresca's system.", strict)).toHaveLength(1);
    expect(scrubUnverifiedManagerText("He thrives in Maresca's system.", strict)).toBe(
      "He thrives in Xabi Alonso's system.",
    );
    expect(findUnverifiedManagerMentions("He thrives in Alonso's system.", strict)).toEqual([]);
  });

  it('catches a possessive after a lowercase verb, and names nobody when no coach is verified', () => {
    const none = { currentHeadCoach: null, verifiedFacts: [], strictCurrentCoach: true };
    expect(scrubUnverifiedManagerText("He anchors Maresca's system.", none)).toBe(
      "He anchors the team's system.",
    );
  });

  it('accepts any verified club manager in a multi-club chat turn', () => {
    const chat = {
      currentHeadCoach: null,
      verifiedFacts: [],
      clubManagers: [
        { club: 'Chelsea', coach: 'Xabi Alonso' },
        { club: 'Arsenal', coach: 'Mikel Arteta' },
      ],
    };
    expect(findUnverifiedManagerMentions("Arteta's system against Alonso's setup.", chat)).toEqual([]);
  });
});
