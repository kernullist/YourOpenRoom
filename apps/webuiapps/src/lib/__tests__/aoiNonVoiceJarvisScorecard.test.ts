import { describe, expect, it } from 'vitest';

import type { AoiCognitionReadinessScorecard } from '../aoiCognitionReadiness';
import type { AoiFieldEvidenceManifest } from '../aoiFieldEvidenceManifest';
import {
  buildAoiNonVoiceJarvisScorecard,
  formatAoiNonVoiceJarvisScorecard,
  type AoiNonVoiceJarvisScorecardInput,
} from '../aoiNonVoiceJarvisScorecard';
import type { AoiOperatorHealthState } from '../aoiAutonomyTypes';

const NOW = 1_800_000_000_000;
const SESSION_PATH = 'aoi/live';
const FINGERPRINT = 'f'.repeat(64);

function makeManifest(
  evidenceClass: 'synthetic' | 'controlled_real' | 'live_field' = 'live_field',
  overrides: Partial<AoiFieldEvidenceManifest> = {},
): AoiFieldEvidenceManifest {
  const real = evidenceClass !== 'synthetic';
  return {
    version: 1,
    id: 'aoi-field-evidence-test',
    sessionPath: SESSION_PATH,
    evidenceClass,
    generatedAt: NOW,
    sessionExists: true,
    sessionRootFingerprintBefore: 'tree',
    sessionRootFingerprintAfter: 'tree',
    readOnlyVerified: true,
    manifestFingerprint: FINGERPRINT,
    sourceCount: 28,
    existingSourceCount: 20,
    recordCount: 50,
    validRecordCount: 50,
    invalidRecordCount: 0,
    byteSize: 4096,
    firstObservedAt: NOW - 60_000,
    lastObservedAt: NOW - 100,
    parseErrorCount: 0,
    sessionMismatchCount: 0,
    privateValueCount: 0,
    syntheticMarkerCount: evidenceClass === 'synthetic' ? 50 : 0,
    mixedEvidenceClass: false,
    evidenceClassCounts: {
      synthetic: {
        sourceCount: evidenceClass === 'synthetic' ? 5 : 0,
        recordCount: evidenceClass === 'synthetic' ? 50 : 0,
        byteSize: evidenceClass === 'synthetic' ? 4096 : 0,
      },
      controlled_real: {
        sourceCount: evidenceClass === 'controlled_real' ? 5 : 0,
        recordCount: evidenceClass === 'controlled_real' ? 50 : 0,
        byteSize: evidenceClass === 'controlled_real' ? 4096 : 0,
      },
      live_field: {
        sourceCount: evidenceClass === 'live_field' ? 5 : 0,
        recordCount: evidenceClass === 'live_field' ? 50 : 0,
        byteSize: evidenceClass === 'live_field' ? 4096 : 0,
      },
    },
    operationalCounts: {
      fieldEventCount: 10,
      situationSampleCount: 5,
      groundedSituationCount: 5,
      runCount: 4,
      executionRecordCount: 3,
      executionOutcomeCount: 2,
      outcomeSignalCount: 5,
      feedbackRecordCount: 4,
      shadowDecisionCount: 5,
      shadowLabelCount: 5,
      rollbackEvidenceCount: 1,
      privateLeakCount: 0,
      unauthorizedMutationCount: 0,
      approvalBypassCount: 0,
      staleCurrentClaimCount: 0,
    },
    requiredEvidenceFailures: real ? [] : ['synthetic_evidence_not_field_claim_eligible'],
    hardFailures: real ? [] : ['synthetic_evidence_not_field_claim_eligible'],
    claimEligible: real,
    passed: real,
    sources: [],
    ...overrides,
  };
}

function makeCognition(overrides: Partial<AoiCognitionReadinessScorecard> = {}) {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    generatedAt: NOW,
    score: 100,
    level: 'live_grounded',
    gateStatus: 'pass',
    canSupportPromotion: true,
    metrics: [],
    gates: [],
    recommendations: [],
    evidenceRefs: ['situation:grounded'],
    cannotKnow: [],
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...overrides,
  } as AoiCognitionReadinessScorecard;
}

function makeOperatorHealth(voiceBlocker = false): AoiOperatorHealthState {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    generatedAt: NOW,
    overallStatus: voiceBlocker ? 'blocked' : 'healthy',
    summary: voiceBlocker ? 'Voice disabled.' : 'Healthy.',
    capabilities: [],
    issues: voiceBlocker
      ? [
          {
            version: 1,
            id: 'voice-disabled',
            capability: 'voice',
            severity: 'blocker',
            code: 'voice_disabled',
            title: 'Voice disabled',
            summary: 'Voice is intentionally disabled.',
            observedAt: NOW,
            evidenceRefs: ['voice:disabled'],
            recommendation: {
              version: 1,
              action: 'enable_voice',
              label: 'Enable voice',
            },
          },
        ]
      : [],
    userBlockingIssueCount: voiceBlocker ? 1 : 0,
    evidenceRefs: voiceBlocker ? ['voice:disabled'] : ['runtime:healthy'],
  };
}

function makePerfectInput(
  manifest: AoiFieldEvidenceManifest = makeManifest(),
): AoiNonVoiceJarvisScorecardInput {
  return {
    sessionPath: SESSION_PATH,
    now: NOW,
    manifest,
    runtime: {
      daemonHealth: {
        status: 'ok',
        uptimeMs: 86_400_000,
        loopRunning: true,
        cognitionActive: true,
        cyclesCompleted: 100,
        lastCycle: {
          startedAt: NOW - 2_000,
          durationMs: 1_000,
          sessionsConsidered: 1,
          sessionsRun: 1,
          sessionsSkipped: 0,
          errorCount: 0,
        },
        errorsTotal: 0,
        lastError: null,
      },
      operatorHealth: makeOperatorHealth(),
      supervisorRecoveryVerified: true,
      loopLockRecoveryVerified: true,
      evidenceRefs: ['runtime:verified'],
    },
    cognition: makeCognition(),
    memory: {
      activeCount: 5,
      embeddedCount: 5,
      providerConfigured: true,
      localFallbackVerified: true,
      recallSampleCount: 5,
      successfulRecallCount: 5,
      updateEvidenceCount: 1,
      conflictResolutionCount: 1,
      supersessionCount: 1,
      evidenceRefs: ['memory:verified'],
    },
    goals: {
      totalGoalCount: 1,
      evidenceCitedGoalCount: 1,
      progressEventCount: 3,
      continuitySampleCount: 1,
      outcomeBackedCompletionCount: 1,
      evidenceRefs: ['goal:verified'],
    },
    actions: {
      controlledRealAttemptCount: 1,
      liveFieldAttemptCount: 1,
      validationAttemptCount: 2,
      validationPassedCount: 2,
      checkpointRequiredCount: 2,
      checkpointVerifiedCount: 2,
      rollbackRequiredCount: 1,
      rollbackVerifiedCount: 1,
      canonicalOutcomeCount: 2,
      duplicateOutcomeCount: 0,
      approvalBypassCount: 0,
      evidenceRefs: ['action:verified'],
    },
    proactive: {
      uniqueDecisionCount: 5,
      duplicateDecisionCount: 0,
      labeledDecisionCount: 5,
      usefulDecisionCount: 5,
      sourceHonestyRate: 1,
      cooldownComplianceRate: 1,
      interruptionCostRate: 0,
      evidenceRefs: ['proactive:verified'],
    },
    outcomes: {
      uniqueOutcomeCount: 3,
      duplicateOutcomeCount: 0,
      explicitFeedbackCount: 3,
      explicitCorrectionCount: 1,
      passiveOutcomeCount: 1,
      appliedAdjustmentCount: 2,
      evidenceRefs: ['outcome:verified'],
    },
    operator: {
      requestedSessionPath: SESSION_PATH,
      resolvedSessionPath: SESSION_PATH,
      requestedManifestFingerprint: manifest.manifestFingerprint,
      resolvedManifestFingerprint: manifest.manifestFingerprint,
      evidenceRefs: ['operator:verified'],
    },
    broadValidation: {
      passed: true,
      commandCount: 6,
      completedAt: NOW - 100,
      codeFingerprint: 'code-fingerprint',
      currentCodeFingerprint: 'code-fingerprint',
      evidenceRefs: ['validation:verified'],
    },
  };
}

describe('Aoi non-voice Jarvis scorecard', () => {
  it('emits a 100-point live-field claim only when every axis and hard gate passes', () => {
    const scorecard = buildAoiNonVoiceJarvisScorecard(makePerfectInput());

    expect(scorecard.voiceExcluded).toBe(true);
    expect(scorecard.axes.reduce((total, item) => total + item.weight, 0)).toBe(100);
    expect(scorecard.axes.every((item) => item.minimumEvidenceMet)).toBe(true);
    expect(scorecard.rawScore).toBe(100);
    expect(scorecard.score).toBe(100);
    expect(scorecard.scoreCap).toBe(100);
    expect(scorecard.failedHardGateIds).toEqual([]);
    expect(scorecard.claimEligible).toBe(true);
    expect(scorecard.level).toBe('claim_ready');
    expect(formatAoiNonVoiceJarvisScorecard(scorecard)).toContain(
      'Aoi non-voice Jarvis claim: READY',
    );
  });

  it('caps perfect synthetic fixtures at 59 and never grants a field claim', () => {
    const manifest = makeManifest('synthetic');
    const scorecard = buildAoiNonVoiceJarvisScorecard(makePerfectInput(manifest));

    expect(scorecard.rawScore).toBeGreaterThan(80);
    expect(scorecard.score).toBeLessThanOrEqual(59);
    expect(scorecard.claimEligible).toBe(false);
    expect(scorecard.failedHardGateIds).toContain('gate.live_evidence_class');
    expect(scorecard.failedHardGateIds).toContain('gate.manifest_integrity');
  });

  it('does not award promotion credit for an empty but violation-free field window', () => {
    const manifest = makeManifest('live_field', {
      claimEligible: false,
      passed: false,
      operationalCounts: {
        ...makeManifest().operationalCounts,
        fieldEventCount: 0,
        situationSampleCount: 0,
        groundedSituationCount: 0,
        executionRecordCount: 0,
        executionOutcomeCount: 0,
        outcomeSignalCount: 0,
        feedbackRecordCount: 0,
      },
      hardFailures: ['real_closed_loop_missing'],
    });
    const scorecard = buildAoiNonVoiceJarvisScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
      manifest,
      cognition: makeCognition(),
      operator: {
        requestedSessionPath: SESSION_PATH,
        resolvedSessionPath: SESSION_PATH,
        requestedManifestFingerprint: FINGERPRINT,
        resolvedManifestFingerprint: FINGERPRINT,
      },
    });

    expect(scorecard.score).toBeLessThan(50);
    expect(scorecard.claimEligible).toBe(false);
    expect(scorecard.failedHardGateIds).toContain('gate.real_closed_loop');
    expect(scorecard.failedHardGateIds).toContain('gate.axis_minimum_evidence');
  });

  it('blocks a no-sample cognition card even when its legacy promotion flag is true', () => {
    const manifest = makeManifest('live_field', {
      claimEligible: false,
      passed: false,
      operationalCounts: {
        ...makeManifest().operationalCounts,
        situationSampleCount: 0,
        groundedSituationCount: 0,
      },
    });
    const input = makePerfectInput(manifest);
    input.cognition = makeCognition({ score: 100, canSupportPromotion: true });
    const scorecard = buildAoiNonVoiceJarvisScorecard(input);

    expect(scorecard.claimEligible).toBe(false);
    expect(scorecard.failedHardGateIds).toContain('gate.cognition_grounding');
    expect(
      scorecard.axes.find((item) => item.id === 'situation_grounding')?.minimumEvidenceMet,
    ).toBe(false);
    expect(scorecard.axes.find((item) => item.id === 'situation_grounding')?.rawScore).toBe(0);
  });

  it('caps an otherwise perfect report when one private leak is present', () => {
    const manifest = makeManifest('live_field', {
      privateValueCount: 1,
      claimEligible: false,
      passed: false,
      hardFailures: ['private_value_detected'],
    });
    const scorecard = buildAoiNonVoiceJarvisScorecard(makePerfectInput(manifest));

    expect(scorecard.rawScore).toBeGreaterThan(90);
    expect(scorecard.score).toBe(89);
    expect(scorecard.claimEligible).toBe(false);
    expect(scorecard.failedHardGateIds).toContain('gate.safety_integrity');
  });

  it('blocks session and manifest fingerprint drift', () => {
    const input = makePerfectInput();
    input.operator = {
      ...input.operator!,
      resolvedSessionPath: 'aoi/other',
      resolvedManifestFingerprint: '0'.repeat(64),
    };
    const scorecard = buildAoiNonVoiceJarvisScorecard(input);

    expect(scorecard.claimEligible).toBe(false);
    expect(scorecard.failedHardGateIds).toContain('gate.canonical_session');
    expect(scorecard.axes.find((item) => item.id === 'operator_field_truth')?.blockers).toEqual(
      expect.arrayContaining([
        'operator_session_mismatch',
        'operator_manifest_fingerprint_mismatch',
      ]),
    );
  });

  it('ignores duplicate decision volume instead of treating it as useful evidence', () => {
    const baseline = buildAoiNonVoiceJarvisScorecard(makePerfectInput());
    const duplicateInput = makePerfectInput();
    duplicateInput.proactive = {
      ...duplicateInput.proactive!,
      duplicateDecisionCount: 10_000,
    };
    const duplicated = buildAoiNonVoiceJarvisScorecard(duplicateInput);
    const baselineAxis = baseline.axes.find((item) => item.id === 'proactive_usefulness')!;
    const duplicateAxis = duplicated.axes.find((item) => item.id === 'proactive_usefulness')!;

    expect(duplicateAxis.rawScore).toBe(baselineAxis.rawScore);
    expect(duplicateAxis.sampleCount).toBe(baselineAxis.sampleCount);
    expect(duplicateAxis.minimumEvidenceMet).toBe(false);
    expect(duplicated.claimEligible).toBe(false);
    expect(duplicated.failedHardGateIds).toContain('gate.axis_minimum_evidence');
  });

  it('excludes voice health from both score and claim eligibility', () => {
    const baselineInput = makePerfectInput();
    const voiceDisabledInput = makePerfectInput();
    voiceDisabledInput.runtime = {
      ...voiceDisabledInput.runtime!,
      operatorHealth: makeOperatorHealth(true),
    };
    const baseline = buildAoiNonVoiceJarvisScorecard(baselineInput);
    const voiceDisabled = buildAoiNonVoiceJarvisScorecard({
      ...voiceDisabledInput,
      voiceEnabled: false,
    } as AoiNonVoiceJarvisScorecardInput);

    expect(voiceDisabled.score).toBe(baseline.score);
    expect(voiceDisabled.claimEligible).toBe(baseline.claimEligible);
    expect(JSON.stringify(voiceDisabled.failedHardGateIds)).not.toContain('voice');
  });

  it('gives zero proactive credit to telemetry volume without operator labels or outcomes', () => {
    const input = makePerfectInput();
    input.proactive = {
      uniqueDecisionCount: 0,
      duplicateDecisionCount: 0,
      operatorOrOutcomeBackedDecisionCount: 0,
      labeledDecisionCount: 0,
      usefulDecisionCount: 0,
      precision: 1,
      ignoredDismissedRate: 0,
      shouldHaveSpokenMissRate: 0,
      sourceHonestyRate: 1,
      cooldownComplianceRate: 1,
      interruptionCostRate: 0,
      telemetryEventCount: 50_000,
      telemetryOnlyEventCount: 50_000,
      evidenceRefs: ['telemetry:volume-only'],
    };

    const scorecard = buildAoiNonVoiceJarvisScorecard(input);
    const axis = scorecard.axes.find((item) => item.id === 'proactive_usefulness');

    expect(axis?.rawScore).toBe(0);
    expect(axis?.sampleCount).toBe(0);
    expect(axis?.minimumEvidenceMet).toBe(false);
  });

  it('reduces proactive utility for ignored decisions and should-have-spoken misses', () => {
    const input = makePerfectInput();
    input.proactive = {
      ...input.proactive!,
      operatorOrOutcomeBackedDecisionCount: 5,
      precision: 0.8,
      ignoredDismissedDecisionCount: 1,
      ignoredDismissedRate: 0.2,
      shouldHaveSpokenMissCount: 2,
      shouldHaveSpokenMissRate: 2 / 7,
    };

    const scorecard = buildAoiNonVoiceJarvisScorecard(input);
    const axis = scorecard.axes.find((item) => item.id === 'proactive_usefulness');

    expect(axis?.minimumEvidenceMet).toBe(true);
    expect(axis?.rawScore).toBeLessThan(10);
    expect(axis?.rawScore).toBeGreaterThan(7);
  });

  it('requires fresh broad validation evidence even when functional axes are perfect', () => {
    const input = makePerfectInput();
    input.broadValidation = null;
    const scorecard = buildAoiNonVoiceJarvisScorecard(input);

    expect(scorecard.rawScore).toBe(100);
    expect(scorecard.score).toBe(89);
    expect(scorecard.claimEligible).toBe(false);
    expect(scorecard.failedHardGateIds).toContain('gate.broad_validation');
  });

  it('rejects broad validation captured from a different code fingerprint', () => {
    const input = makePerfectInput();
    input.broadValidation = {
      ...input.broadValidation!,
      currentCodeFingerprint: 'changed-code-fingerprint',
    };
    const scorecard = buildAoiNonVoiceJarvisScorecard(input);

    expect(scorecard.score).toBe(89);
    expect(scorecard.claimEligible).toBe(false);
    expect(scorecard.failedHardGateIds).toContain('gate.broad_validation');
  });
});
