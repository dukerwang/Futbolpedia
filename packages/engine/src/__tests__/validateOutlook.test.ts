import { describe, expect, it } from 'vitest';
import { assertValidOutlook, validateOutlook } from '../gates/validateOutlook';
import {
  correctStaleCoachRecord,
  findUnverifiedManagerMentions,
  daysUntilKnownClubManagersTableExpires,
  isKnownClubManagersTableFresh,
  pickCurrentCoach,
  scrubKnownStaleManagers,
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

describe('correctStaleCoachRecord', () => {
  const FRESH = new Date('2026-10-25T12:00:00Z');
  const EXPIRED = new Date('2027-06-01T00:00:00Z');

  it('replaces a missing or stale coach for a listed club', () => {
    expect(correctStaleCoachRecord('Chelsea', null, null, FRESH)).toBe('Xabi Alonso');
    expect(correctStaleCoachRecord('Chelsea', 'Liam Rosenior', null, FRESH)).toBe('Xabi Alonso');
    expect(correctStaleCoachRecord('Barcelona', 'Xavi Hernandez', null, FRESH)).toBe('Hansi Flick');
  });

  it('keeps a non-stale coach and leaves unlisted clubs untouched', () => {
    expect(correctStaleCoachRecord('Chelsea', 'Xabi Alonso', null, FRESH)).toBe('Xabi Alonso');
    expect(correctStaleCoachRecord('Manchester City', 'Enzo Maresca', null, FRESH)).toBe('Enzo Maresca');
    expect(correctStaleCoachRecord('Coventry City', 'Frank Lampard', null, FRESH)).toBe('Frank Lampard');
    expect(correctStaleCoachRecord(null, null, null, FRESH)).toBeNull();
  });

  it('lets a coach appointed after the table was verified win', () => {
    expect(correctStaleCoachRecord('Chelsea', 'Someone New', '2026-11-02', FRESH)).toBe('Someone New');
    expect(correctStaleCoachRecord('Chelsea', 'Someone New', '2026-10-25', FRESH)).toBe('Someone New');
  });

  it('prefers the table over a live coach whose stint predates the verified date', () => {
    expect(correctStaleCoachRecord('Liverpool', 'Unlisted Interim', '2024-06-01', FRESH)).toBe(
      'Andoni Iraola',
    );
    // Same coach under a different spelling: the table entry agrees, so keep the live name.
    expect(correctStaleCoachRecord('Chelsea', 'Xabi Alonso Olano', '2026-07-01', FRESH)).toBe(
      'Xabi Alonso Olano',
    );
  });

  it('still overrides a listed former coach even with a recent start date', () => {
    expect(correctStaleCoachRecord('Liverpool', 'Arne Slot', '2026-11-01', FRESH)).toBe('Andoni Iraola');
  });

  it('keeps an undated, non-stale live coach', () => {
    expect(correctStaleCoachRecord('Napoli', 'Someone New', null, FRESH)).toBe('Someone New');
    expect(correctStaleCoachRecord('Napoli', 'Someone New', 'not a date', FRESH)).toBe('Someone New');
  });

  it('fails open to the live record once the table has expired', () => {
    expect(isKnownClubManagersTableFresh(EXPIRED)).toBe(false);
    expect(correctStaleCoachRecord('Chelsea', 'Someone New', '2024-01-01', EXPIRED)).toBe('Someone New');
    expect(correctStaleCoachRecord('Chelsea', null, null, EXPIRED)).toBeNull();
  });

  it('counts down to expiry', () => {
    expect(daysUntilKnownClubManagersTableExpires(FRESH)).toBe(119);
    expect(daysUntilKnownClubManagersTableExpires(EXPIRED)).toBeLessThanOrEqual(0);
  });
});

describe('scrubKnownStaleManagers', () => {
  const FRESH = new Date('2026-10-25T12:00:00Z');

  it('rewrites a former coach only when the text is about that club', () => {
    expect(scrubKnownStaleManagers("Chelsea under Liam Rosenior pressed high.", FRESH)).toBe(
      'Chelsea under Xabi Alonso pressed high.',
    );
    expect(scrubKnownStaleManagers("Rosenior's Strasbourg side pressed high.", FRESH)).toBe(
      "Rosenior's Strasbourg side pressed high.",
    );
  });

  it('never rewrites a coach who now manages a listed club', () => {
    const text = "Chelsea fans remember Enzo Maresca's system; Manchester City now play it.";
    expect(scrubKnownStaleManagers(text, FRESH)).toBe(text);
  });

  it("uses the turn's verified coach for the verified club", () => {
    expect(
      scrubKnownStaleManagers('Chelsea under Liam Rosenior pressed high.', FRESH, {
        club: 'Chelsea FC',
        coach: 'Someone New',
      }),
    ).toBe('Chelsea under Someone New pressed high.');
    // Other clubs in the same text keep the table's coach.
    expect(
      scrubKnownStaleManagers('Liverpool under Arne Slot pressed high.', FRESH, {
        club: 'Chelsea',
        coach: 'Someone New',
      }),
    ).toBe('Liverpool under Andoni Iraola pressed high.');
  });

  it('ignores a verified coach the table lists as that club\'s former coach', () => {
    expect(
      scrubKnownStaleManagers('Liverpool under Arne Slot pressed high.', FRESH, {
        club: 'Liverpool',
        coach: 'Arne Slot',
      }),
    ).toBe('Liverpool under Andoni Iraola pressed high.');
  });

  it('never rewrites a former coach the turn verified at another club', () => {
    const text = "Chelsea alumni praise Mauricio Pochettino's system with the USA.";
    expect(
      scrubKnownStaleManagers(text, FRESH, { club: 'USA', coach: 'Mauricio Pochettino' }),
    ).toBe(text);
  });

  it('leaves player names that share a former coach surname alone', () => {
    const text = "Barcelona's Xavi's passing range defined an era.";
    expect(scrubKnownStaleManagers(text, FRESH)).toBe(text);
  });
});
