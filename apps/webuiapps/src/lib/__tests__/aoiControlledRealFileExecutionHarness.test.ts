import { describe, expect, it } from 'vitest';

import { runAoiControlledRealFileExecutionHarness } from '../aoiControlledRealFileExecutionHarness';

describe('runAoiControlledRealFileExecutionHarness', () => {
  it('proves success, drift block, recovery, rollback-failure detection, and cleanup', () => {
    const report = runAoiControlledRealFileExecutionHarness(1_800_000_000_000);
    expect(report).toMatchObject({
      evidenceClass: 'controlled_real',
      passed: true,
      scenarioCount: 4,
      passedScenarioCount: 4,
      cleanupVerified: true,
      actionAuthority: 'disposable_workspace_only',
    });
    expect(report.behaviorFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
      'validated_success',
      'target_fingerprint_drift',
      'validation_failure_rollback',
      'rollback_failure_detection',
    ]);
    expect(
      report.scenarios.find((scenario) => scenario.id === 'validation_failure_rollback'),
    ).toMatchObject({
      passed: true,
      validationStatus: 'failed',
      rollbackAttempted: true,
      rollbackSucceeded: true,
      finalStateVerified: true,
    });
    expect(
      report.scenarios.find((scenario) => scenario.id === 'rollback_failure_detection'),
    ).toMatchObject({
      passed: true,
      rollbackAttempted: true,
      rollbackSucceeded: false,
      blockReasons: expect.arrayContaining(['rollback_failed']),
    });
  });

  it('has a stable behavior fingerprint for the same controlled scenarios', () => {
    const first = runAoiControlledRealFileExecutionHarness(1_800_000_000_000);
    const second = runAoiControlledRealFileExecutionHarness(1_800_000_000_000);
    expect(second.behaviorFingerprint).toBe(first.behaviorFingerprint);
  });
});
