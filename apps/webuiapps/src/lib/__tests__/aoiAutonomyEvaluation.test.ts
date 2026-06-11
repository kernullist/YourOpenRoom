import { describe, expect, it } from 'vitest';
import {
  feedbackMemoryProposalFixture,
  feedbackRefreshProposalFixture,
  makeFeedbackDecisionFixture,
} from '../__fixtures__/aoiAutonomyEvaluationFixtures';
import { evaluateAoiAutonomyRecords } from '../aoiAutonomyEvaluation';
import type { AoiProposal, AoiProposalDecision } from '../aoiAutonomyTypes';

describe('Aoi autonomy evaluation', () => {
  it('computes compact feedback and execution metrics from local records', () => {
    const acceptedProposal: AoiProposal = {
      ...feedbackRefreshProposalFixture,
      id: 'proposal-executed-001',
      status: 'executed',
      cooldownKey: 'research-refresh:executed',
    };
    const duplicateProposal: AoiProposal = {
      ...feedbackMemoryProposalFixture,
      id: 'proposal-duplicate-001',
      status: 'active',
    };
    const highRiskProposal: AoiProposal = {
      ...feedbackMemoryProposalFixture,
      id: 'proposal-high-risk-blocked',
      status: 'blocked',
      risk: 'high',
      requiredAutonomyLevel: 'L5',
      requiresUserApproval: true,
      cooldownKey: 'research-followup:high-risk',
    };
    const decisions: AoiProposalDecision[] = [
      makeFeedbackDecisionFixture({
        id: 'decision-accept-001',
        proposalId: acceptedProposal.id,
        cooldownKey: acceptedProposal.cooldownKey,
        action: 'accept',
        nextStatus: 'accepted',
        feedbackCategory: 'useful',
        proposalTrigger: acceptedProposal.trigger,
        proposalRisk: acceptedProposal.risk,
        actionKind: acceptedProposal.acceptAction?.kind,
        suggestedTools: acceptedProposal.suggestedTools,
        memoryIds: acceptedProposal.memoryIds,
        evidenceRefs: acceptedProposal.evidenceRefs,
      }),
      makeFeedbackDecisionFixture({
        id: 'decision-execute-001',
        proposalId: acceptedProposal.id,
        cooldownKey: acceptedProposal.cooldownKey,
        action: 'execute',
        previousStatus: 'accepted',
        nextStatus: 'executed',
        createdAt: 3600,
        proposalTrigger: acceptedProposal.trigger,
        actionKind: acceptedProposal.acceptAction?.kind,
      }),
      makeFeedbackDecisionFixture({
        id: 'decision-wrong-memory-001',
        feedbackCategory: 'wrong_memory',
      }),
      makeFeedbackDecisionFixture({
        id: 'decision-stale-001',
        feedbackCategory: 'stale',
      }),
      makeFeedbackDecisionFixture({
        id: 'decision-too-frequent-001',
        feedbackCategory: 'too_frequent',
        action: 'snooze',
        nextStatus: 'snoozed',
      }),
      makeFeedbackDecisionFixture({
        id: 'decision-block-high-risk-001',
        proposalId: highRiskProposal.id,
        cooldownKey: highRiskProposal.cooldownKey,
        action: 'block',
        previousStatus: 'accepted',
        nextStatus: 'blocked',
        proposalRisk: 'high',
        actionKind: 'start_research',
        suggestedTools: ['start_research'],
      }),
      makeFeedbackDecisionFixture({
        id: 'decision-goal-useful-001',
        proposalId: 'proposal-goal-continuation-001',
        cooldownKey: 'goal-continuation:goal-1:step-1:pending',
        action: 'accept',
        nextStatus: 'accepted',
        feedbackCategory: 'useful',
        proposalTrigger: 'goal_continuation',
      }),
    ];

    const result = evaluateAoiAutonomyRecords({
      sessionPath: 'aoi/default',
      proposals: [
        feedbackMemoryProposalFixture,
        feedbackRefreshProposalFixture,
        acceptedProposal,
        duplicateProposal,
        highRiskProposal,
      ],
      decisions,
      now: 5000,
    });

    expect(result.metrics.proposalAcceptanceRate).toBeGreaterThan(0);
    expect(
      result.metrics.dismissRateByCategory.find((item) => item.category === 'too_frequent')?.count,
    ).toBe(1);
    expect(result.metrics.duplicateCooldownViolationCount).toBe(1);
    expect(result.metrics.evidenceCoverage).toBe(1);
    expect(result.metrics.staleMemoryReuseCount).toBeGreaterThanOrEqual(1);
    expect(result.metrics.blockedHighRiskProposalCount).toBe(1);
    expect(result.metrics.acceptedExecutionSuccessRate).toBe(1);
    expect(result.metrics.goalContinuationUsefulness).toBe(1);
    expect(result.calibration.wrongMemoryRefs[0]).toMatchObject({
      key: 'memory-stale-research',
      count: 1,
    });
    expect(result.calibration.blockedActionKinds[0]).toMatchObject({
      key: 'start_research',
      count: 1,
    });
    expect(JSON.stringify(result)).not.toContain(feedbackMemoryProposalFixture.body);
  });
});
