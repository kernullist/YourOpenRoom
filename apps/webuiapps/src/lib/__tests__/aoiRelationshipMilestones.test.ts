import { describe, expect, it } from 'vitest';

import {
  AOI_SESSION_COUNT_MILESTONES,
  deriveAoiRelationshipMilestones,
} from '../aoiRelationshipMilestones';

describe('deriveAoiRelationshipMilestones', () => {
  it('emits nothing before any threshold is crossed', () => {
    expect(deriveAoiRelationshipMilestones({ sessionCount: 3 })).toEqual([]);
  });

  it('emits only the highest crossed session threshold', () => {
    const derived = deriveAoiRelationshipMilestones({ sessionCount: 60 });
    expect(derived.map((item) => item.id)).toEqual(['session_count:50']);
    expect(derived[0].label).toBe('We reached 50 sessions together.');
    expect(derived[0].evidenceRefs).toEqual(['relationship:session_count:50']);
  });

  it('emits a threshold exactly on the crossing', () => {
    for (const threshold of AOI_SESSION_COUNT_MILESTONES) {
      const derived = deriveAoiRelationshipMilestones({ sessionCount: threshold });
      expect(derived.map((item) => item.id)).toContain(`session_count:${threshold}`);
    }
  });

  it('ignores a non-finite or fractional session count safely', () => {
    expect(deriveAoiRelationshipMilestones({ sessionCount: Number.NaN })).toEqual([]);
    expect(deriveAoiRelationshipMilestones({ sessionCount: 10.9 }).map((item) => item.id)).toEqual([
      'session_count:10',
    ]);
  });

  it('records a trust level once per level and never L1', () => {
    expect(
      deriveAoiRelationshipMilestones({ sessionCount: 1, autonomyLevel: 'L4' }).map(
        (item) => item.id,
      ),
    ).toEqual(['trust_promoted:L4']);
    // L1 is the default starting point, not an achievement.
    expect(deriveAoiRelationshipMilestones({ sessionCount: 1, autonomyLevel: 'L1' })).toEqual([]);
    expect(deriveAoiRelationshipMilestones({ sessionCount: 1, autonomyLevel: 'l3' })[0].id).toBe(
      'trust_promoted:L3',
    );
  });

  it('emits no trust milestone for a missing or unrecognized level', () => {
    expect(deriveAoiRelationshipMilestones({ sessionCount: 1 })).toEqual([]);
    expect(deriveAoiRelationshipMilestones({ sessionCount: 1, autonomyLevel: null })).toEqual([]);
    expect(deriveAoiRelationshipMilestones({ sessionCount: 1, autonomyLevel: 'L9' })).toEqual([]);
    expect(deriveAoiRelationshipMilestones({ sessionCount: 1, autonomyLevel: '  ' })).toEqual([]);
  });

  it('separates "none accepted yet" from "unknown"', () => {
    // 0 is a real answer: nothing accepted, so no milestone.
    expect(deriveAoiRelationshipMilestones({ sessionCount: 1, acceptedProposalCount: 0 })).toEqual(
      [],
    );
    // Absent is also no milestone -- an unreadable store must not invent one.
    expect(
      deriveAoiRelationshipMilestones({ sessionCount: 1, acceptedProposalCount: null }),
    ).toEqual([]);
    const derived = deriveAoiRelationshipMilestones({
      sessionCount: 1,
      acceptedProposalCount: 1,
    });
    expect(derived.map((item) => item.id)).toEqual(['first_accepted_proposal']);
  });

  it('combines every crossing available at once', () => {
    const derived = deriveAoiRelationshipMilestones({
      sessionCount: 100,
      autonomyLevel: 'L4',
      acceptedProposalCount: 7,
    });
    expect(derived.map((item) => item.id)).toEqual([
      'session_count:100',
      'trust_promoted:L4',
      'first_accepted_proposal',
    ]);
    // Labels stay in the neutral audit register; companion phrasing is separate.
    for (const item of derived) {
      expect(item.label).toMatch(/^[\x20-\x7E]+$/);
      expect(item.evidenceRefs.length).toBeGreaterThan(0);
    }
  });
});
