import { describe, expect, it } from 'vitest';

import { runAoiControlledRealCognitionHarness } from '../aoiControlledRealCognitionHarness';

const NOW = 1_800_000_000_000;

describe('Aoi controlled-real cognition harness', () => {
  it('passes grounded, dark-source, measured-memory, and validated-goal real-store scenarios', async () => {
    const report = await runAoiControlledRealCognitionHarness(NOW);

    expect(report).toMatchObject({
      evidenceClass: 'controlled_real',
      passed: true,
      scenarioCount: 4,
      passedScenarioCount: 4,
      cleanupVerified: true,
      actionAuthority: 'disposable_workspace_only',
    });
    expect(report.behaviorFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      report.scenarios.find((scenario) => scenario.id === 'consented_grounded_situation'),
    ).toMatchObject({
      cognitionScore: 85,
      cognitionLevel: 'live_grounded',
      canSupportPromotion: true,
      activitySourceStatus: 'fresh',
      activityMetadataOnly: true,
    });
    expect(
      report.scenarios.find((scenario) => scenario.id === 'dark_source_fail_closed'),
    ).toMatchObject({
      activityEventBlocked: true,
      cognitionLevel: 'ungrounded',
      canSupportPromotion: false,
      activitySourceStatus: 'consent_missing',
      privateBaitAbsent: true,
    });
    expect(
      report.scenarios.find((scenario) => scenario.id === 'measured_memory_recall'),
    ).toMatchObject({
      recallSampleCount: 3,
      successfulRecallCount: 3,
      recallMissCount: 0,
      localFallbackVerified: true,
      conflictResolutionCount: 1,
      supersessionCount: 1,
      decayCandidateCount: 1,
    });
    expect(
      report.scenarios.find((scenario) => scenario.id === 'validated_goal_continuity'),
    ).toMatchObject({
      wakeupCount: 2,
      goalPersistedAcrossWakeups: true,
      completedFromOutcome: true,
      outcomeBackedCompletion: true,
      completionEventCount: 1,
    });
  });

  it('produces a stable behavior fingerprint for the same evidence behavior', async () => {
    const first = await runAoiControlledRealCognitionHarness(NOW);
    const second = await runAoiControlledRealCognitionHarness(NOW);
    expect(second.behaviorFingerprint).toBe(first.behaviorFingerprint);
  });
});
