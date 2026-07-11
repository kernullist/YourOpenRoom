import { describe, expect, it } from 'vitest';

import {
  AOI_AUTONOMOUS_EXECUTE_REVERSIBLE_CLASS,
  classifyAoiAutonomousExecuteEligibility,
  type AoiAutonomousExecuteEligibilityInput,
} from '../aoiAutonomousExecuteEligibility';

const NOW = 1_800_000_000_000;

// A fully-eligible input; each test perturbs ONE gate to prove it is required.
function eligibleInput(
  partial: Partial<AoiAutonomousExecuteEligibilityInput> = {},
): AoiAutonomousExecuteEligibilityInput {
  return {
    actionKind: 'file_write',
    hasCheckpoint: true,
    approvalFingerprint: 'fp-abc',
    currentFingerprint: 'fp-abc',
    approvalExpiresAt: NOW + 60_000,
    readinessLevel: 'trusted_operator',
    sessionBudgetRemaining: 2,
    acceptDecisionActor: 'user',
    now: NOW,
    ...partial,
  };
}

describe('classifyAoiAutonomousExecuteEligibility (P2.3)', () => {
  it('is eligible only when every invariant holds', () => {
    const result = classifyAoiAutonomousExecuteEligibility(eligibleInput());
    expect(result).toEqual({ eligible: true, blockReasons: [] });
  });

  it('excludes irreversible / irreversible-adjacent action kinds', () => {
    for (const actionKind of [
      'run_command',
      'connector_call',
      'file_delete',
      'create_kira_work',
      'save_memory',
    ] as const) {
      const result = classifyAoiAutonomousExecuteEligibility(eligibleInput({ actionKind }));
      expect(result.eligible).toBe(false);
      expect(result.blockReasons).toContain('not_reversible_class');
    }
    // The reversible class is exactly these three.
    expect([...AOI_AUTONOMOUS_EXECUTE_REVERSIBLE_CLASS].sort()).toEqual([
      'app_action',
      'file_patch',
      'file_write',
    ]);
  });

  it('blocks when no rollback checkpoint exists', () => {
    expect(
      classifyAoiAutonomousExecuteEligibility(eligibleInput({ hasCheckpoint: false })).blockReasons,
    ).toContain('checkpoint_missing');
  });

  it('blocks a missing approval and a fingerprint drift between approve and execute', () => {
    expect(
      classifyAoiAutonomousExecuteEligibility(eligibleInput({ approvalFingerprint: null }))
        .blockReasons,
    ).toContain('approval_missing');
    expect(
      classifyAoiAutonomousExecuteEligibility(eligibleInput({ approvalFingerprint: 'fp-OTHER' }))
        .blockReasons,
    ).toContain('approval_fingerprint_mismatch');
  });

  it('blocks an expired or missing approval-TTL window', () => {
    expect(
      classifyAoiAutonomousExecuteEligibility(eligibleInput({ approvalExpiresAt: NOW - 1 }))
        .blockReasons,
    ).toContain('approval_expired');
    expect(
      classifyAoiAutonomousExecuteEligibility(eligibleInput({ approvalExpiresAt: null }))
        .blockReasons,
    ).toContain('approval_expired');
  });

  it('blocks readiness below trusted_operator', () => {
    expect(
      classifyAoiAutonomousExecuteEligibility(eligibleInput({ readinessLevel: 'field_preview' }))
        .blockReasons,
    ).toContain('readiness_below_trusted_operator');
  });

  it('blocks an exhausted per-session budget', () => {
    expect(
      classifyAoiAutonomousExecuteEligibility(eligibleInput({ sessionBudgetRemaining: 0 }))
        .blockReasons,
    ).toContain('session_budget_exhausted');
  });

  it('blocks a non-user-authored accept decision (consume, never author)', () => {
    expect(
      classifyAoiAutonomousExecuteEligibility(eligibleInput({ acceptDecisionActor: 'aoi' }))
        .blockReasons,
    ).toContain('accept_decision_not_user_authored');
    expect(
      classifyAoiAutonomousExecuteEligibility(eligibleInput({ acceptDecisionActor: null }))
        .blockReasons,
    ).toContain('accept_decision_not_user_authored');
  });

  it('collects ALL failing gates at once (fail-closed, observable)', () => {
    const result = classifyAoiAutonomousExecuteEligibility({
      actionKind: 'run_command',
      hasCheckpoint: false,
      approvalFingerprint: null,
      currentFingerprint: 'fp',
      approvalExpiresAt: NOW - 1,
      readinessLevel: 'field_preview',
      sessionBudgetRemaining: 0,
      acceptDecisionActor: 'aoi',
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toEqual([
      'not_reversible_class',
      'checkpoint_missing',
      'approval_missing',
      'approval_expired',
      'readiness_below_trusted_operator',
      'session_budget_exhausted',
      'accept_decision_not_user_authored',
    ]);
  });
});
