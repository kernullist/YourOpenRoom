import { describe, expect, it } from 'vitest';

import type {
  AoiOutcomeSignalRecord,
  AoiProactiveBriefFieldEvent,
  AoiProposalDecision,
} from '../aoiAutonomyTypes';
import type { AoiOperatorFeedbackLabelAction } from '../aoiOperatorFeedbackInbox';
import { buildAoiProactiveUsefulnessMetrics } from '../aoiProactiveUsefulnessMetrics';

const SESSION_PATH = 'aoi/live';
const NOW = 1_800_000_000_000;

function decision(
  id: string,
  action: 'accept' | 'dismiss' | 'snooze',
  feedbackCategory?: AoiProposalDecision['feedbackCategory'],
): AoiProposalDecision {
  return {
    version: 1,
    id,
    proposalId: `proposal-${id}`,
    sessionPath: SESSION_PATH,
    cooldownKey: `topic-${id}`,
    action,
    actor: 'user',
    createdAt: NOW - 1000,
    previousStatus: 'active',
    nextStatus: action === 'accept' ? 'accepted' : action === 'dismiss' ? 'dismissed' : 'snoozed',
    ...(feedbackCategory ? { feedbackCategory } : {}),
  };
}

function fieldEvent(id: string, createdAt = NOW - 1000): AoiProactiveBriefFieldEvent {
  return {
    version: 1,
    id,
    sessionPath: SESSION_PATH,
    kind: 'shown_dashboard',
    briefId: `brief-${id}`,
    suppressionReasons: [],
    sourceRefs: [],
    sourceHosts: [],
    evidenceRefs: [],
    freshness: { cannotKnow: [], stale: false },
    privacy: {
      redacted: false,
      privateLeakDetected: false,
      unauthorizedMutationDetected: false,
      redactionReasons: [],
    },
    dedupeKey: `dashboard:${id}`,
    createdAt,
  };
}

function operatorLabel(
  id: string,
  label: AoiOperatorFeedbackLabelAction['label'],
): AoiOperatorFeedbackLabelAction {
  return {
    version: 1,
    id,
    sessionPath: SESSION_PATH,
    decisionRecordId: `record-${id}`,
    decisionId: `shadow-${id}`,
    label,
    actor: 'user',
    createdAt: NOW - 500,
    sourceKinds: ['workspace'],
    evidenceRefs: [`label:${id}`],
    calibrationEligible: true,
    promotionEligible: true,
    safetyTightening: false,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function outcome(id: string, proposalId: string): AoiOutcomeSignalRecord {
  return {
    version: 1,
    id,
    eventId: id,
    sessionPath: SESSION_PATH,
    sourceProposalId: proposalId,
    outcomeKind: 'validation_run',
    validationPassed: true,
    signalKind: 'passive_outcome',
    confidence: 0.4,
    inferredAdjustment: {
      version: 1,
      target: 'readiness',
      direction: 'boost',
      magnitude: 0.2,
      reason: 'Validated.',
    },
    deliveryMode: 'unknown',
    result: 'positive',
    evidenceRefs: [`outcome:${id}`],
    privacyState: 'metadata_only',
    createdAt: NOW - 100,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

describe('Aoi proactive usefulness metrics', () => {
  it('never turns raw telemetry volume into credited usefulness decisions', () => {
    const metrics = buildAoiProactiveUsefulnessMetrics({
      sessionPath: SESSION_PATH,
      decisions: [],
      outcomes: [],
      feedback: [],
      operatorLabels: [],
      fieldEvents: Array.from({ length: 100 }, (_, index) => fieldEvent(`event-${index}`)),
      now: NOW,
    });

    expect(metrics.telemetryEventCount).toBe(100);
    expect(metrics.telemetryOnlyEventCount).toBe(100);
    expect(metrics.uniqueDecisionCount).toBe(0);
    expect(metrics.labeledDecisionCount).toBe(0);
    expect(metrics.precision).toBe(0);
    expect(metrics.interruptionCostRate).toBe(1);
  });

  it('computes precision, dismissal, cooldown, and interruption from operator decisions', () => {
    const metrics = buildAoiProactiveUsefulnessMetrics({
      sessionPath: SESSION_PATH,
      decisions: [
        decision('1', 'accept', 'useful'),
        decision('2', 'accept', 'useful'),
        decision('3', 'accept', 'useful'),
        decision('4', 'dismiss', 'wrong_timing'),
        decision('5', 'dismiss', 'too_frequent'),
      ],
      outcomes: [],
      feedback: [],
      operatorLabels: [],
      now: NOW,
    });

    expect(metrics.uniqueDecisionCount).toBe(5);
    expect(metrics.operatorOrOutcomeBackedDecisionCount).toBe(5);
    expect(metrics.usefulDecisionCount).toBe(3);
    expect(metrics.ignoredDismissedDecisionCount).toBe(2);
    expect(metrics.precision).toBe(0.6);
    expect(metrics.ignoredDismissedRate).toBe(0.4);
    expect(metrics.cooldownComplianceRate).toBe(0.8);
    expect(metrics.interruptionCostRate).toBe(0.4);
  });

  it('counts should-have-spoken misses separately from delivered decisions', () => {
    const metrics = buildAoiProactiveUsefulnessMetrics({
      sessionPath: SESSION_PATH,
      decisions: [decision('1', 'accept', 'useful'), decision('2', 'accept', 'useful')],
      outcomes: [],
      feedback: [],
      operatorLabels: [
        operatorLabel('miss-1', 'should_have_spoken'),
        operatorLabel('miss-2', 'should_have_spoken'),
      ],
      now: NOW,
    });

    expect(metrics.uniqueDecisionCount).toBe(2);
    expect(metrics.shouldHaveSpokenMissCount).toBe(2);
    expect(metrics.shouldHaveSpokenMissRate).toBe(0.5);
    expect(metrics.evidenceRefs).toContain('operator-feedback:miss-1');
  });

  it('merges validation with its proposal and detects duplicate signal identities', () => {
    const accepted = decision('1', 'accept', 'useful');
    const validation = outcome('validation-1', accepted.proposalId);
    const metrics = buildAoiProactiveUsefulnessMetrics({
      sessionPath: SESSION_PATH,
      decisions: [accepted],
      outcomes: [validation, validation],
      feedback: [],
      operatorLabels: [],
      now: NOW,
    });

    expect(metrics.uniqueDecisionCount).toBe(1);
    expect(metrics.usefulDecisionCount).toBe(1);
    expect(metrics.duplicateDecisionCount).toBe(1);
  });
});
