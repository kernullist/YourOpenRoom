import { describe, expect, it } from 'vitest';

import {
  composeAoiGroundedStance,
  selectAoiStancePrimaryReason,
  type ComposeAoiGroundedStanceInput,
} from '../aoiGroundedStance';

function input(
  partial: Partial<ComposeAoiGroundedStanceInput> = {},
): ComposeAoiGroundedStanceInput {
  return {
    freshness: partial.freshness ?? 'fresh',
    sourceCount: partial.sourceCount ?? 2,
    sourceStrong: partial.sourceStrong ?? true,
    confidence: partial.confidence ?? 0.6,
    score: partial.score ?? 0.6,
    ...(partial.interestAligned !== undefined ? { interestAligned: partial.interestAligned } : {}),
    ...(partial.matchesOwnInquiry !== undefined
      ? { matchesOwnInquiry: partial.matchesOwnInquiry }
      : {}),
  };
}

describe('composeAoiGroundedStance take precedence', () => {
  it('lets staleness outrank source strength and confidence', () => {
    const stance = composeAoiGroundedStance(
      input({ freshness: 'stale', sourceStrong: true, confidence: 0.95, score: 0.95 }),
    );
    expect(stance.takeKind).toBe('stale_refresh');
    expect(stance.reasons).toContain('stale_evidence');
  });

  it('lets weak sources outrank high confidence', () => {
    const stance = composeAoiGroundedStance(
      input({ sourceStrong: false, confidence: 0.95, score: 0.95 }),
    );
    expect(stance.takeKind).toBe('weak_source');
  });

  it('recommends a review only when confidence and novelty both clear the bar', () => {
    expect(composeAoiGroundedStance(input({ confidence: 0.85, score: 0.8 })).takeKind).toBe(
      'review_candidate',
    );
    // One below the floor is not enough.
    expect(composeAoiGroundedStance(input({ confidence: 0.85, score: 0.7 })).takeKind).toBe(
      'default_watch',
    );
    expect(composeAoiGroundedStance(input({ confidence: 0.7, score: 0.8 })).takeKind).toBe(
      'default_watch',
    );
  });

  it('treats unknown freshness as not stale', () => {
    expect(composeAoiGroundedStance(input({ freshness: 'unknown' })).takeKind).toBe(
      'default_watch',
    );
  });
});

describe('composeAoiGroundedStance reasons', () => {
  it('reports a single source and corroboration as mutually exclusive', () => {
    const single = composeAoiGroundedStance(input({ sourceCount: 1 }));
    expect(single.reasons).toContain('single_source');
    expect(single.reasons).not.toContain('multi_source_corroboration');

    const many = composeAoiGroundedStance(input({ sourceCount: 3, sourceStrong: true }));
    expect(many.reasons).toContain('multi_source_corroboration');
    expect(many.reasons).not.toContain('single_source');
  });

  it('does not claim corroboration when the sources are not strong', () => {
    const stance = composeAoiGroundedStance(input({ sourceCount: 4, sourceStrong: false }));
    expect(stance.reasons).not.toContain('multi_source_corroboration');
    expect(stance.reasons).not.toContain('single_source');
  });

  it('adds the high-confidence reason only for a review candidate', () => {
    expect(composeAoiGroundedStance(input({ confidence: 0.9, score: 0.9 })).reasons).toContain(
      'high_confidence_signal',
    );
    // Stale wins the take, so the confidence reason must not tag along.
    expect(
      composeAoiGroundedStance(input({ freshness: 'stale', confidence: 0.9, score: 0.9 })).reasons,
    ).not.toContain('high_confidence_signal');
  });

  it('notes when Aoi has her own footing on the topic', () => {
    expect(composeAoiGroundedStance(input({ matchesOwnInquiry: true })).reasons).toContain(
      'matches_own_inquiry',
    );
    expect(composeAoiGroundedStance(input({ matchesOwnInquiry: false })).reasons).not.toContain(
      'matches_own_inquiry',
    );
  });

  it('handles a non-finite source count as none', () => {
    const stance = composeAoiGroundedStance(input({ sourceCount: Number.NaN }));
    expect(stance.reasons).toContain('single_source');
  });
});

describe('composeAoiGroundedStance disagreement', () => {
  it('disagrees when a saved interest rests on thin evidence', () => {
    const weak = composeAoiGroundedStance(input({ interestAligned: true, sourceStrong: false }));
    expect(weak.disagreesWithInterest).toBe(true);
    expect(weak.reasons).toContain('saved_interest_but_thin');

    const stale = composeAoiGroundedStance(input({ interestAligned: true, freshness: 'stale' }));
    expect(stale.disagreesWithInterest).toBe(true);
  });

  it('does not manufacture disagreement when the evidence carries the topic', () => {
    const strong = composeAoiGroundedStance(
      input({ interestAligned: true, confidence: 0.9, score: 0.9 }),
    );
    expect(strong.disagreesWithInterest).toBe(false);
    expect(strong.reasons).not.toContain('saved_interest_but_thin');
  });

  it('needs a saved interest to disagree with', () => {
    const notAligned = composeAoiGroundedStance(input({ sourceStrong: false }));
    expect(notAligned.disagreesWithInterest).toBe(false);
    expect(notAligned.reasons).not.toContain('saved_interest_but_thin');
  });
});

describe('selectAoiStancePrimaryReason', () => {
  it('voices the reason that actually decided the stance', () => {
    // Stale outranks everything else present.
    const stale = composeAoiGroundedStance(
      input({ freshness: 'stale', interestAligned: true, sourceCount: 1, matchesOwnInquiry: true }),
    );
    expect(selectAoiStancePrimaryReason(stale)).toBe('stale_evidence');

    // The disagreement outranks the mechanics behind it.
    const thin = composeAoiGroundedStance(
      input({ interestAligned: true, sourceStrong: false, sourceCount: 1 }),
    );
    expect(selectAoiStancePrimaryReason(thin)).toBe('saved_interest_but_thin');

    const corroborated = composeAoiGroundedStance(input({ sourceCount: 3 }));
    expect(selectAoiStancePrimaryReason(corroborated)).toBe('multi_source_corroboration');
  });

  it('returns null when there is no reason to give', () => {
    expect(selectAoiStancePrimaryReason(null)).toBeNull();
    expect(
      selectAoiStancePrimaryReason({
        takeKind: 'default_watch',
        reasons: [],
        disagreesWithInterest: false,
      }),
    ).toBeNull();
  });
});
