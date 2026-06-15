import { describe, expect, it } from 'vitest';
import {
  feedbackMemoryProposalFixture,
  feedbackRefreshProposalFixture,
  makeFeedbackDecisionFixture,
} from '../__fixtures__/aoiAutonomyEvaluationFixtures';
import { evaluateAoiAutonomyRecords } from '../aoiAutonomyEvaluation';
import {
  AOI_OPERATOR_REPLAY_FIXTURES,
  cloneAoiOperatorReplayFixture,
  formatAoiReplayReport,
  runAoiOperatorReplayFixture,
  runBuiltInAoiOperatorReplayFixtures,
} from '../aoiOperatorReplay';
import { createAoiReplayFixtureDraftFromTraceExport } from '../aoiOperatorTimeline';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import type { AoiOperatorTraceExport, AoiProposal, AoiProposalDecision } from '../aoiAutonomyTypes';

describe('Aoi autonomy evaluation', () => {
  it('computes compact feedback and execution metrics from local records', () => {
    const preferenceMemory: AoiMemoryEntry = {
      version: 2,
      id: 'memory-preference-wrong',
      scope: 'user',
      type: 'preference',
      status: 'active',
      content: 'The user prefers concise answers. pref:response.tone',
      normalizedContent: 'the user prefers concise answers',
      importance: 0.72,
      confidence: 0.7,
      hits: 1,
      createdAt: 1000,
      updatedAt: 2000,
      sourceEpisodeIds: ['episode-preference-wrong'],
      tags: ['preference', 'pref:response.tone'],
      entities: ['response.tone'],
    };
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
        memoryIds: ['memory-preference-wrong'],
        evidenceRefs: ['memory:memory-preference-wrong'],
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
        memoryIds: [],
        evidenceRefs: [],
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
      memories: [preferenceMemory],
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
    expect(result.metrics.preferenceDemotionCandidateCount).toBe(1);
    expect(result.metrics.oneOffPreferenceFeedbackCount).toBe(1);
    expect(result.calibration.wrongMemoryRefs[0]).toMatchObject({
      key: 'memory-preference-wrong',
      count: 1,
    });
    expect(result.calibration.blockedActionKinds[0]).toMatchObject({
      key: 'start_research',
      count: 1,
    });
    expect(result.calibration.preferenceDemotionRefs[0]).toMatchObject({
      key: 'memory-preference-wrong',
      count: 1,
    });
    expect(JSON.stringify(result)).not.toContain(feedbackMemoryProposalFixture.body);
  });

  it('passes all built-in Aoi operator replay scenarios without command execution', () => {
    const reports = runBuiltInAoiOperatorReplayFixtures();

    expect(reports.map((report) => report.fixtureId)).toEqual([
      'user-return-branch-drift',
      'kira-completed-reviewed',
      'research-insufficient-sources',
      'too-much-feedback-suppression',
      'high-risk-command-blocked',
      'preference-project-conflict',
      'disabled-source-excluded',
      'quiet-mode-low-value-digest',
    ]);
    expect(
      reports.filter((report) => !report.passed).map((report) => formatAoiReplayReport(report)),
    ).toEqual([]);
    expect(reports.every((report) => report.commandExecutionCount === 0)).toBe(true);
    expect(reports.every((report) => report.mutationAttemptCount === 0)).toBe(true);

    const commandReport = reports.find(
      (report) => report.fixtureId === 'high-risk-command-blocked',
    );
    expect(commandReport?.blockedReasonLabels.join(' ')).toContain(
      'approved_command_blocked:destructive_file_operation',
    );

    const quietReport = reports.find(
      (report) => report.fixtureId === 'quiet-mode-low-value-digest',
    );
    expect(quietReport?.digestSummary).toContain('No meaningful ambient updates');
  });

  it('prints understandable failed replay expectations', () => {
    const fixture = AOI_OPERATOR_REPLAY_FIXTURES[0];
    const broken = cloneAoiOperatorReplayFixture(fixture, {
      id: 'broken-source-expectation',
      expectedDecisions: [
        {
          id: 'missing-source',
          metric: 'source_selected',
          label: 'This intentionally expects a missing source.',
          sourceId: 'missing-source',
        },
      ],
    });

    const report = runAoiOperatorReplayFixture(broken);
    const text = formatAoiReplayReport(report);

    expect(report.passed).toBe(false);
    expect(report.summary).toContain('missing-source');
    expect(text).toContain('FAIL missing-source');
    expect(text).toContain('sources:');
  });

  it('keeps replay snapshots concise and reviewable', () => {
    const report = runAoiOperatorReplayFixture(AOI_OPERATOR_REPLAY_FIXTURES[1]);
    const text = formatAoiReplayReport(report);

    expect(report.passed).toBe(true);
    expect(text).toContain('kira-completed-reviewed');
    expect(text).toContain('sources:');
    expect(text).toContain('attention:');
    expect(text.length).toBeLessThan(1400);
  });

  it('promotes privacy-safe trace exports into replay fixture drafts without mutating built-ins', () => {
    const builtInCount = AOI_OPERATOR_REPLAY_FIXTURES.length;
    const traceExport: AoiOperatorTraceExport = {
      version: 1,
      id: 'aoi-trace-export-test',
      sessionPath: 'aoi/default',
      exportedAt: 5000,
      eventCount: 2,
      sourceEventIds: ['timeline-event-001', 'timeline-event-002'],
      events: [
        {
          version: 1,
          id: 'timeline-event-001',
          sessionPath: 'aoi/default',
          kind: 'source_selected',
          visibility: 'dashboard_only',
          createdAt: 1000,
          title: 'Source selected',
          summary: 'Synthetic source [url:1] selected for context.',
          redactionState: 'synthetic',
          sourceRef: 'context-source:browser',
          evidenceRefs: ['browser:[url:1]'],
          relatedRefs: ['environment-source:browser-context'],
        },
        {
          version: 1,
          id: 'timeline-event-002',
          sessionPath: 'aoi/default',
          kind: 'proposal_accepted',
          visibility: 'operator_visible',
          createdAt: 1500,
          title: 'Proposal accepted',
          summary: 'The safe proposal was accepted.',
          redactionState: 'none',
          proposalId: 'proposal-test-001',
          decisionId: 'decision-test-001',
          evidenceRefs: ['proposal:proposal-test-001'],
          relatedRefs: ['proposal:proposal-test-001', 'decision:decision-test-001'],
        },
      ],
      redactionSummary: {
        totalReplacementCount: 1,
        localPathCount: 0,
        urlCount: 1,
        emailCount: 0,
        privateFieldCount: 0,
        syntheticLabels: {
          '[url:1]': '[url:1]',
        },
      },
      privacyNotes: ['Synthetic labels are retained.'],
    };

    const draft = createAoiReplayFixtureDraftFromTraceExport(traceExport, {
      fixtureId: 'trace-draft-test',
    });
    const draftJson = JSON.stringify(draft);

    expect(AOI_OPERATOR_REPLAY_FIXTURES).toHaveLength(builtInCount);
    expect(draft.fixture.id).toBe('trace-draft-test');
    expect(draft.fixture.inputEvents.map((event) => event.kind)).toEqual([
      'environment_source',
      'proposal_decision',
    ]);
    expect(draft.fixture.expectedDecisions[0]).toMatchObject({
      metric: 'snapshot_summary',
      snapshotIncludes: 'TODO_REPLACE_THIS_EXPECTATION',
    });
    expect(draft.todoExpectations.join(' ')).toContain('Replace the placeholder');
    expect(draft.warnings.join(' ')).toContain('does not execute shell commands');
    expect(draftJson).not.toContain('C:\\');
    expect(draftJson).not.toContain('https://');
  });

  it('keeps operator voice decisions as replay context without proposal execution', () => {
    const traceExport: AoiOperatorTraceExport = {
      version: 1,
      id: 'aoi-voice-trace-export-test',
      sessionPath: 'aoi/default',
      exportedAt: 6000,
      eventCount: 1,
      sourceEventIds: ['timeline-voice-event-001'],
      events: [
        {
          version: 1,
          id: 'timeline-voice-event-001',
          sessionPath: 'aoi/default',
          kind: 'operator_voice_decision',
          visibility: 'operator_visible',
          createdAt: 5000,
          title: 'Operator voice spoken',
          summary: 'Operator voice spoken for approval_required: summary id only.',
          redactionState: 'redacted',
          sourceRef: 'digest:approval-inbox:aggregate',
          sourceKind: 'approval_required',
          status: 'spoken',
          evidenceRefs: ['proposal:aoi-proposal-voice-test'],
          relatedRefs: ['voice-event:aoi-voice-event-test', 'voice-summary:aoi-summary-test'],
          metadata: {
            category: 'approval_required',
            status: 'spoken',
            shouldSpeak: true,
            summaryId: 'aoi-summary-test',
            transcriptHash: 'abc123',
            replayable: true,
          },
        },
      ],
      redactionSummary: {
        totalReplacementCount: 0,
        localPathCount: 0,
        urlCount: 0,
        emailCount: 0,
        privateFieldCount: 0,
        syntheticLabels: {},
      },
      privacyNotes: ['Voice transcript body is not exported.'],
    };

    const draft = createAoiReplayFixtureDraftFromTraceExport(traceExport, {
      fixtureId: 'voice-trace-draft-test',
    });
    const draftJson = JSON.stringify(draft.fixture.inputEvents);

    expect(draft.fixture.inputEvents).toHaveLength(1);
    expect(draft.fixture.inputEvents[0]).toMatchObject({
      kind: 'environment_source',
      sourceRef: 'digest:approval-inbox:aggregate',
    });
    expect(draft.fixture.inputEvents[0].kind).not.toBe('proposal_decision');
    expect(draftJson).not.toContain('proposal_decision');
    expect(draft.warnings.join(' ')).toContain('does not execute shell commands');
  });
});
