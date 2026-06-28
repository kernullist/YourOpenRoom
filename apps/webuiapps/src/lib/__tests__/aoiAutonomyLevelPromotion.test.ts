import { describe, expect, it } from 'vitest';

import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import {
  evaluateAoiAutonomyLevelPromotion,
  resolveAoiAutonomyLevelPromotionConfig,
  type AoiAutonomyLevelPromotionConfig,
  type AoiAutonomyLevelPromotionGateState,
} from '../aoiAutonomyLevelPromotion';
import type { AoiAutonomyLevel, AoiAutonomyPolicy } from '../aoiAutonomyTypes';
import type { AoiJarvisReadinessScorecard } from '../aoiJarvisReadinessScorecard';

function scorecard(
  overrides: Partial<AoiJarvisReadinessScorecard> = {},
): AoiJarvisReadinessScorecard {
  return {
    version: 1,
    id: 'sc-1',
    sessionPath: 'aoi/default',
    generatedAt: 1000,
    score: 95,
    level: 'trusted_operator',
    gateStatus: 'pass',
    canIncreaseTrust: true,
    modeRecommendation: 'candidate_for_higher_trust',
    visibility: {
      version: 1,
      dashboard: 'allowed',
      inline: 'allowed',
      directChat: 'allowed',
      workOrderPrepare: 'allowed',
      directChatBlockedReasons: [],
      workOrderPrepareBlockedReasons: [],
      summary: '',
      evidenceRefs: [],
    },
    metricGroups: [],
    metrics: [],
    gates: [],
    recommendations: [],
    evidenceRefs: [],
    blockerRefs: [],
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...overrides,
  };
}

const negativeScorecard = (): AoiJarvisReadinessScorecard =>
  scorecard({ canIncreaseTrust: false, level: 'field_preview', gateStatus: 'warning' });

function policy(level: AoiAutonomyLevel): AoiAutonomyPolicy {
  return { ...DEFAULT_AOI_AUTONOMY_POLICY, level };
}

function config(
  overrides: Partial<AoiAutonomyLevelPromotionConfig> = {},
): AoiAutonomyLevelPromotionConfig {
  return { enabled: true, ceiling: 'L4', minConsecutive: 1, sustainMs: 0, ...overrides };
}

function gateState(
  overrides: Partial<AoiAutonomyLevelPromotionGateState> = {},
): AoiAutonomyLevelPromotionGateState {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    baselineLevel: 'L2',
    lastManagedLevel: 'L2',
    positiveSince: null,
    consecutivePositive: 0,
    lastEvaluatedAt: 0,
    history: [],
    updatedAt: 0,
    ...overrides,
  };
}

describe('resolveAoiAutonomyLevelPromotionConfig', () => {
  it('is disabled by default with an L4 ceiling', () => {
    expect(resolveAoiAutonomyLevelPromotionConfig({})).toEqual({
      enabled: false,
      ceiling: 'L4',
      minConsecutive: 3,
      sustainMs: 60 * 60 * 1000,
    });
  });

  it('enables on flag and hard-clamps the ceiling to L4 even when L5 is requested', () => {
    const resolved = resolveAoiAutonomyLevelPromotionConfig({
      AOI_AUTONOMY_AUTO_PROMOTE: '1',
      AOI_AUTONOMY_AUTO_PROMOTE_CEILING: 'L5',
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.ceiling).toBe('L4');
  });

  it('allows the ceiling to be lowered and the window to be tuned', () => {
    const resolved = resolveAoiAutonomyLevelPromotionConfig({
      AOI_AUTONOMY_AUTO_PROMOTE_CEILING: 'L3',
      AOI_AUTONOMY_AUTO_PROMOTE_MIN_CONSECUTIVE: '5',
      AOI_AUTONOMY_AUTO_PROMOTE_SUSTAIN_MS: '0',
    });
    expect(resolved.ceiling).toBe('L3');
    expect(resolved.minConsecutive).toBe(5);
    expect(resolved.sustainMs).toBe(0);
  });
});

describe('evaluateAoiAutonomyLevelPromotion', () => {
  it('holds without change when auto-promotion is disabled', () => {
    const decision = evaluateAoiAutonomyLevelPromotion({
      policy: policy('L2'),
      scorecard: scorecard(),
      gateState: null,
      config: config({ enabled: false }),
      now: 1000,
    });
    expect(decision.action).toBe('hold');
    expect(decision.changed).toBe(false);
    expect(decision.reason).toBe('auto_promote_disabled');
  });

  it('advances the streak but holds until the sustained window is met', () => {
    const decision = evaluateAoiAutonomyLevelPromotion({
      policy: policy('L2'),
      scorecard: scorecard(),
      gateState: gateState(),
      config: config({ minConsecutive: 3, sustainMs: 10_000 }),
      now: 1000,
    });
    expect(decision.action).toBe('hold');
    expect(decision.changed).toBe(false);
    expect(decision.reason).toContain('sustaining');
    expect(decision.nextGateState.consecutivePositive).toBe(1);
    expect(decision.nextGateState.positiveSince).toBe(1000);
  });

  it('promotes by exactly one level once the window is met, then resets the streak', () => {
    const decision = evaluateAoiAutonomyLevelPromotion({
      policy: policy('L2'),
      scorecard: scorecard(),
      gateState: gateState({ positiveSince: 1000, consecutivePositive: 1 }),
      config: config({ minConsecutive: 2, sustainMs: 5_000 }),
      now: 6_000,
    });
    expect(decision.action).toBe('promote');
    expect(decision.changed).toBe(true);
    expect(decision.previousLevel).toBe('L2');
    expect(decision.nextLevel).toBe('L3');
    expect(decision.nextGateState.lastManagedLevel).toBe('L3');
    expect(decision.nextGateState.consecutivePositive).toBe(0);
    expect(decision.nextGateState.positiveSince).toBeNull();
    expect(decision.nextGateState.history).toHaveLength(1);
    expect(decision.nextGateState.history[0]).toMatchObject({
      kind: 'promote',
      from: 'L2',
      to: 'L3',
    });
  });

  it('never promotes past the L4 hard ceiling even if config asks for L5', () => {
    const decision = evaluateAoiAutonomyLevelPromotion({
      policy: policy('L4'),
      scorecard: scorecard(),
      gateState: gateState({ baselineLevel: 'L4', lastManagedLevel: 'L4' }),
      config: config({ ceiling: 'L5' }),
      now: 1000,
    });
    expect(decision.action).toBe('hold');
    expect(decision.changed).toBe(false);
    expect(decision.reason).toContain('at_ceiling');
  });

  it('instantly rolls back to baseline on readiness regression', () => {
    const decision = evaluateAoiAutonomyLevelPromotion({
      policy: policy('L4'),
      scorecard: negativeScorecard(),
      gateState: gateState({ baselineLevel: 'L2', lastManagedLevel: 'L4' }),
      config: config(),
      now: 2000,
    });
    expect(decision.action).toBe('rollback');
    expect(decision.changed).toBe(true);
    expect(decision.previousLevel).toBe('L4');
    expect(decision.nextLevel).toBe('L2');
    expect(decision.nextGateState.lastManagedLevel).toBe('L2');
    expect(decision.nextGateState.history.at(-1)).toMatchObject({
      kind: 'rollback',
      from: 'L4',
      to: 'L2',
    });
  });

  it('holds (no rollback) on regression when already at baseline', () => {
    const decision = evaluateAoiAutonomyLevelPromotion({
      policy: policy('L2'),
      scorecard: negativeScorecard(),
      gateState: gateState({
        baselineLevel: 'L2',
        lastManagedLevel: 'L2',
        consecutivePositive: 2,
        positiveSince: 1,
      }),
      config: config(),
      now: 2000,
    });
    expect(decision.action).toBe('hold');
    expect(decision.changed).toBe(false);
    expect(decision.nextGateState.consecutivePositive).toBe(0);
    expect(decision.nextGateState.positiveSince).toBeNull();
  });

  it('re-baselines and yields when the level was changed manually out-of-band', () => {
    // Promoter thought it was managing L3, but the operator manually set L5.
    const decision = evaluateAoiAutonomyLevelPromotion({
      policy: policy('L5'),
      scorecard: scorecard(),
      gateState: gateState({ baselineLevel: 'L2', lastManagedLevel: 'L3' }),
      config: config(),
      now: 3000,
    });
    expect(decision.changed).toBe(false);
    expect(decision.action).toBe('hold');
    // Re-baselined to the manual level; rollback can never drop below it.
    expect(decision.nextGateState.baselineLevel).toBe('L5');
    expect(decision.nextGateState.lastManagedLevel).toBe('L5');
  });
});
