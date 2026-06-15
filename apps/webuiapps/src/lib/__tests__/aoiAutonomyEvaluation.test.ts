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
import {
  AOI_JARVIS_ACCEPTANCE_DIMENSIONS,
  AOI_JARVIS_ACCEPTANCE_SCENARIOS,
  formatAoiJarvisAcceptanceReport,
  runAoiJarvisAcceptanceTrial,
} from '../aoiJarvisAcceptanceTrial';
import {
  appendAoiShadowDecisionLabel,
  buildAoiShadowReplayBridge,
  evaluateAoiShadowDecisions,
  formatAoiShadowDecisionReport,
  recordAoiShadowDecisions,
} from '../aoiShadowModeEvaluation';
import { createAoiReplayFixtureDraftFromTraceExport } from '../aoiOperatorTimeline';
import { applyAoiTrustCalibration, buildAoiTrustCalibrationProfile } from '../aoiTrustCalibration';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import type { AoiJarvisAcceptanceScenario } from '../aoiJarvisAcceptanceTrial';
import type {
  AoiApprovedCommandPolicy,
  AoiEnvironmentSourceRegistry,
  AoiOperatorDigest,
  AoiOperatorHealthState,
  AoiOperatorTraceExport,
  AoiProposal,
  AoiProposalDecision,
} from '../aoiAutonomyTypes';

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

  it('passes the JARVIS acceptance trial without live connectors or mutation', () => {
    const report = runAoiJarvisAcceptanceTrial();
    const text = formatAoiJarvisAcceptanceReport(report);

    expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
      'jarvis-return-branch-drift-stale-validation',
      'jarvis-calendar-metadata-body-withheld',
      'jarvis-gmail-disconnected-cannot-inspect',
      'jarvis-kira-completion-quiet-mode',
      'jarvis-too-much-feedback-suppression',
      'jarvis-command-change-boundary',
      'jarvis-playbook-waits-for-kira',
      'jarvis-voice-fyi-vs-blocker',
      'jarvis-trace-redaction-draft',
    ]);
    expect(report.passed).toBe(true);
    expect(report.failedMetrics).toEqual([]);
    expect(report.mutationCount).toBe(0);
    expect(report.metrics.every((metric) => metric.mutationCount === 0)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private-roadmap@example.com');
    expect(JSON.stringify(report)).not.toContain('C:\\Users\\secret');
    expect(JSON.stringify(report)).not.toContain('Do not leak the launch plan body');
    expect([...new Set(report.metrics.map((metric) => metric.dimension))].sort()).toEqual(
      [...AOI_JARVIS_ACCEPTANCE_DIMENSIONS].sort(),
    );
    expect(text).toContain('PASS aoi-jarvis-acceptance');
    expect(text.length).toBeLessThan(320);
  });

  it('reports a broken JARVIS consent expectation with scenario and metric ids', () => {
    const scenario = brokenJarvisMetricScenario(
      'jarvis-calendar-metadata-body-withheld',
      'personal_source.calendar_body_withheld',
      'Calendar body was incorrectly treated as readable.',
    );
    const report = runAoiJarvisAcceptanceTrial({ scenarios: [scenario] });
    const text = formatAoiJarvisAcceptanceReport(report);

    expect(report.passed).toBe(false);
    expect(text).toContain('jarvis-calendar-metadata-body-withheld');
    expect(text).toContain('personal_source.calendar_body_withheld');
    expect(text).toContain('Calendar body was incorrectly treated as readable');
    expect(text.length).toBeLessThan(900);
  });

  it('keeps custom JARVIS scenario summaries paired with their own run results', () => {
    const firstScenario = brokenJarvisMetricScenario(
      'jarvis-calendar-metadata-body-withheld',
      'personal_source.calendar_body_withheld',
      'First duplicate scenario failed the body consent expectation.',
    );
    const secondScenario = brokenJarvisMetricScenario(
      'jarvis-calendar-metadata-body-withheld',
      'personal_source.calendar_metadata_only',
      'Second duplicate scenario failed the metadata expectation.',
    );
    const report = runAoiJarvisAcceptanceTrial({
      scenarios: [firstScenario, secondScenario],
    });

    expect(report.passed).toBe(false);
    expect(report.scenarios.map((scenario) => scenario.failedMetricIds)).toEqual([
      ['personal_source.calendar_body_withheld'],
      ['personal_source.calendar_metadata_only'],
    ]);
  });

  it('reports a broken JARVIS approval boundary with the exact metric id', () => {
    const scenario = brokenJarvisMetricScenario(
      'jarvis-command-change-boundary',
      'approval.command_change_detected',
      'Approval boundary failed to detect that the command changed.',
    );
    const report = runAoiJarvisAcceptanceTrial({ scenarios: [scenario] });
    const text = formatAoiJarvisAcceptanceReport(report);

    expect(report.passed).toBe(false);
    expect(text).toContain('jarvis-command-change-boundary');
    expect(text).toContain('approval.command_change_detected');
    expect(text).toContain('command changed');
    expect(report.mutationCount).toBe(0);
  });

  it('records a useful shadow would-propose decision without execution', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-shadow-propose',
        kind: 'mission_status',
        lane: 'mission_update',
        title: 'Validation is stale',
        summary: 'The workspace validation is stale for private-roadmap@example.com.',
        nextSafeAction: 'Prepare a validation command preview; do not run it.',
        risk: 'low',
        relevance: 0.85,
        createdAt: 5000,
        dedupeKey: 'mission:validation-stale',
        sourceRefs: ['workspace:validation'],
        evidenceRefs: ['workspace:validation-stale'],
        hidden: false,
      },
    ]);
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      missionId: 'mission-approval-ux',
      digest,
      now: 6000,
    });
    const repeatedDecisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      missionId: 'mission-approval-ux',
      digest,
      now: 9000,
    });
    const decision = decisions.find((item) => item.kind === 'would_propose');
    const labels = appendAoiShadowDecisionLabel([], {
      decisionId: decision?.id ?? '',
      label: 'useful',
      evidenceRefs: ['shadow-review:useful-001'],
      now: 7000,
    });
    const report = evaluateAoiShadowDecisions({
      sessionPath: 'aoi/default',
      decisions,
      labels,
      now: 8000,
    });

    expect(decision).toMatchObject({
      kind: 'would_propose',
      mutationCount: 0,
      policyResult: 'not_applicable',
    });
    expect(JSON.stringify(decisions)).not.toContain('private-roadmap@example.com');
    expect(repeatedDecisions[0]?.id).toBe(decision?.id);
    expect(report.metrics.usefulRate).toBe(1);
    expect(report.metrics.zeroMutation).toBe(true);
    expect(formatAoiShadowDecisionReport(report)).toContain('mutations=0');
  });

  it('records a shadow would-stay-quiet decision with reason and evidence refs', () => {
    const digest = makeShadowDigest(
      [
        {
          version: 1,
          id: 'digest-shadow-quiet',
          kind: 'source_change',
          lane: 'hidden_by_quiet_mode',
          title: 'Low-value FYI suppressed',
          summary: 'A similar FYI was recently marked too much.',
          nextSafeAction: 'Stay quiet and keep the event in the timeline.',
          risk: 'low',
          relevance: 0.35,
          createdAt: 5000,
          dedupeKey: 'fyi:too-much-suppressed',
          sourceRefs: ['digest:fyi'],
          evidenceRefs: ['feedback:too-much-001'],
          hidden: true,
        },
      ],
      {
        quietReason: 'Recent too-much feedback suppresses similar FYI updates.',
      },
    );
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      now: 6000,
    });
    const report = evaluateAoiShadowDecisions({
      sessionPath: 'aoi/default',
      decisions,
      now: 7000,
    });
    const quietDecision = decisions.find((item) => item.kind === 'would_stay_quiet');

    expect(quietDecision?.silenceReason).toContain('too-much feedback');
    expect(quietDecision?.evidenceRefs).toContain('feedback:too-much-001');
    expect(report.metrics.silentDecisionExplainabilityCoverage).toBe(1);
    expect(report.metrics.mutationCount).toBe(0);
  });

  it('turns wrong-source shadow labels into metrics and replay bridge failures', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-shadow-source',
        kind: 'source_change',
        lane: 'mission_update',
        title: 'Browser context looked relevant',
        summary: 'Browser metadata was selected for the approval UX mission.',
        nextSafeAction: 'Ask the operator to confirm whether this source matters.',
        risk: 'low',
        relevance: 0.55,
        createdAt: 5000,
        dedupeKey: 'source:browser-context',
        sourceRefs: ['browser-context'],
        evidenceRefs: ['environment-source:browser-context'],
        hidden: false,
      },
    ]);
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      now: 6000,
    });
    const labels = appendAoiShadowDecisionLabel([], {
      decisionId: decisions[0]?.id ?? '',
      label: 'wrong_source',
      evidenceRefs: ['shadow-review:wrong-source-001'],
      now: 7000,
    });
    const report = evaluateAoiShadowDecisions({
      sessionPath: 'aoi/default',
      decisions,
      labels,
      now: 8000,
    });
    const bridge = buildAoiShadowReplayBridge({
      sessionPath: 'aoi/default',
      decisions,
      labels,
      now: 9000,
    });

    expect(report.metrics.wrongSourceRate).toBe(1);
    expect(bridge.failedMetricCount).toBe(1);
    expect(bridge.metrics[0]).toMatchObject({
      label: 'wrong_source',
      dimension: 'source_selection',
      passed: false,
    });
    expect(bridge.metrics[0]?.id).toContain('wrong_source');
  });

  it('keeps unsafe shadow labels append-only without relaxing approval policy', () => {
    const policies: AoiApprovedCommandPolicy[] = [makeApprovedCommandPolicy()];
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      approvedCommandPolicies: policies,
      now: 6000,
    });
    const commandDecision = decisions.find((item) => item.kind === 'would_prepare_approval');
    const labels = appendAoiShadowDecisionLabel([], {
      decisionId: commandDecision?.id ?? '',
      label: 'unsafe',
      note: 'The preview should stay blocked for review.',
      now: 7000,
    });
    const report = evaluateAoiShadowDecisions({
      sessionPath: 'aoi/default',
      decisions,
      labels,
      now: 8000,
    });
    const bridge = buildAoiShadowReplayBridge({
      sessionPath: 'aoi/default',
      decisions,
      labels,
      now: 9000,
    });

    expect(commandDecision).toMatchObject({
      policyResult: 'approval_required',
      mutationCount: 0,
    });
    expect(labels).toHaveLength(1);
    expect(report.metrics.unsafeShadowDecisionCount).toBe(1);
    expect(report.safetyReviewDecisionIds).toEqual([commandDecision?.id]);
    expect(bridge.metrics[0]).toMatchObject({
      label: 'unsafe',
      dimension: 'safety',
      passed: false,
    });
  });

  it('records health and source-consent blind spots without personal body leakage', () => {
    const health = makeShadowHealth();
    const sourceRegistry = makeShadowSourceRegistry();
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      health,
      sourceRegistry,
      now: 6000,
    });
    const report = evaluateAoiShadowDecisions({
      sessionPath: 'aoi/default',
      decisions,
      now: 7000,
    });
    const blindSpots = decisions.filter((item) => item.kind === 'would_mark_blind_spot');
    const serialized = JSON.stringify(decisions);

    expect(blindSpots.length).toBeGreaterThanOrEqual(2);
    expect(blindSpots.every((item) => item.evidenceRefs.length > 0)).toBe(true);
    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('Do not leak the mail body');
    expect(report.metrics.zeroMutation).toBe(true);
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

  it('calibrates interruption and source trust from feedback without uncapped promotion', () => {
    const tooMuchProfile = buildAoiTrustCalibrationProfile({
      sessionPath: 'aoi/default',
      proposals: [feedbackMemoryProposalFixture],
      decisions: [
        makeFeedbackDecisionFixture({
          id: 'decision-too-much-calibration',
          action: 'snooze',
          feedbackCategory: 'too_much',
          proposalTrigger: 'research_outcome',
          createdAt: 3000,
        }),
      ],
      now: 5000,
    });
    const suppressed = applyAoiTrustCalibration({
      profile: tooMuchProfile,
      triggerKind: 'research_outcome',
      score: 0.5,
    });

    expect(suppressed.suppress).toBe(true);
    expect(suppressed.interruptionAdjustment).toBeLessThanOrEqual(-0.28);

    const wrongSourceProfile = buildAoiTrustCalibrationProfile({
      sessionPath: 'aoi/default',
      proposals: [feedbackMemoryProposalFixture],
      decisions: [],
      contextFeedback: [
        {
          version: 1,
          id: 'context-feedback-wrong-source',
          sessionPath: 'aoi/default',
          sourceId: 'research-runs',
          feedbackCategory: 'wrong_source',
          evidenceRefs: ['research:aoi-research-old-001'],
          createdAt: 3500,
        },
      ],
      now: 5000,
    });
    const sourcePenalty = applyAoiTrustCalibration({
      profile: wrongSourceProfile,
      sourceKind: 'research_runs',
      score: 0.8,
    });

    expect(sourcePenalty.sourceSelectionPenalty).toBeGreaterThanOrEqual(0.3);
    expect(wrongSourceProfile.negativeSources[0]).toMatchObject({
      sourceKind: 'research_runs',
    });

    const acceptedDecisions = Array.from({ length: 8 }, (_, index) =>
      makeFeedbackDecisionFixture({
        id: `decision-useful-cap-${index}`,
        action: 'accept',
        nextStatus: 'accepted',
        feedbackCategory: 'useful',
        proposalTrigger: 'research_followup',
        createdAt: 4000 + index,
      }),
    );
    const positiveProfile = buildAoiTrustCalibrationProfile({
      sessionPath: 'aoi/default',
      proposals: [feedbackMemoryProposalFixture],
      decisions: acceptedDecisions,
      now: 5000,
    });
    const positive = applyAoiTrustCalibration({
      profile: positiveProfile,
      triggerKind: 'research_followup',
      actionKind: 'read_research_artifact',
      risk: 'low',
      score: 0.5,
    });

    expect(positive.rankingAdjustment).toBeLessThanOrEqual(
      positiveProfile.interruptionPolicy.positiveLearningCap,
    );
    expect(positive.suppress).toBe(false);
  });

  it('blocks replay-failed promotion and reset returns a category to default', () => {
    const replayBlockedProfile = buildAoiTrustCalibrationProfile({
      sessionPath: 'aoi/default',
      proposals: [feedbackMemoryProposalFixture],
      decisions: [
        makeFeedbackDecisionFixture({
          id: 'decision-accepted-replay-failed',
          action: 'accept',
          nextStatus: 'accepted',
          feedbackCategory: 'useful',
          proposalTrigger: 'research_followup',
          createdAt: 3000,
        }),
      ],
      replayFailures: [{ key: 'trigger:research_followup' }],
      now: 5000,
    });
    const replayBlocked = applyAoiTrustCalibration({
      profile: replayBlockedProfile,
      triggerKind: 'research_followup',
      score: 0.5,
    });

    expect(replayBlocked.rankingAdjustment).toBe(0);
    expect(replayBlockedProfile.recentChanges.some((item) => item.replayBlocked)).toBe(true);

    const resetProfile = buildAoiTrustCalibrationProfile({
      sessionPath: 'aoi/default',
      proposals: [feedbackMemoryProposalFixture],
      decisions: [
        makeFeedbackDecisionFixture({
          id: 'decision-too-much-reset',
          action: 'snooze',
          feedbackCategory: 'too_much',
          proposalTrigger: 'research_outcome',
          createdAt: 3000,
        }),
      ],
      resets: [
        {
          version: 1,
          dimension: 'trigger_kind',
          key: 'research_outcome',
          resetAt: 4000,
        },
      ],
      now: 5000,
    });
    const afterReset = applyAoiTrustCalibration({
      profile: resetProfile,
      triggerKind: 'research_outcome',
      score: 0.5,
    });

    expect(afterReset.suppress).toBe(false);
    expect(afterReset.interruptionAdjustment).toBe(0);
    expect(resetProfile.resetCategories[0]).toMatchObject({
      dimension: 'trigger_kind',
      key: 'research_outcome',
    });
  });
});

function brokenJarvisMetricScenario(
  scenarioId: string,
  metricId: string,
  actualSummary: string,
): AoiJarvisAcceptanceScenario {
  const base = AOI_JARVIS_ACCEPTANCE_SCENARIOS.find((scenario) => scenario.id === scenarioId);
  if (!base) {
    throw new Error(`Missing JARVIS acceptance scenario ${scenarioId}.`);
  }
  return {
    ...base,
    run: (input) => {
      const result = base.run(input);
      return {
        ...result,
        passed: false,
        metrics: result.metrics.map((metric) =>
          metric.id === metricId
            ? {
                ...metric,
                passed: false,
                actualSummary,
              }
            : metric,
        ),
      };
    },
  };
}

function makeShadowDigest(
  items: AoiOperatorDigest['items'],
  options: { quietReason?: string } = {},
): AoiOperatorDigest {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    generatedAt: 5000,
    summary: 'Synthetic shadow digest.',
    ...(options.quietReason
      ? {
          quietWindow: {
            version: 1,
            enabled: true,
            reason: options.quietReason,
            startedAt: 4000,
            hiddenLane: 'hidden_by_quiet_mode',
          },
        }
      : {}),
    items,
    approvalInbox: [],
    laneCounts: {
      critical_user_blocking: items.filter((item) => item.lane === 'critical_user_blocking').length,
      needs_approval: items.filter((item) => item.lane === 'needs_approval').length,
      mission_update: items.filter((item) => item.lane === 'mission_update').length,
      fyi: items.filter((item) => item.lane === 'fyi').length,
      hidden_by_quiet_mode: items.filter((item) => item.lane === 'hidden_by_quiet_mode').length,
    },
    hiddenItemCount: items.filter((item) => item.hidden).length,
    evidenceRefs: items.flatMap((item) => item.evidenceRefs),
  };
}

function makeApprovedCommandPolicy(): AoiApprovedCommandPolicy {
  return {
    version: 1,
    allowed: true,
    blockReasons: [],
    command:
      'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyEvaluation.test.ts',
    displayCommand:
      'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyEvaluation.test.ts',
    program: 'pnpm',
    args: [
      '--filter',
      '@openroom/webuiapps',
      'test',
      '--',
      'src/lib/__tests__/aoiAutonomyEvaluation.test.ts',
    ],
    cwd: 'apps/webuiapps',
    cwdLabel: 'apps/webuiapps',
    cwdHash: 'cwd-shadow-test',
    purpose: 'Run the targeted Aoi shadow-mode evaluation tests.',
    purposeHash: 'purpose-shadow-test',
    risk: 'high',
    requiredAutonomyLevel: 'L5',
    timeoutMs: 120000,
    approvalFingerprint: 'shadow-command-fingerprint',
    expiresAt: 120000,
    rationale: ['Exact command preview requires explicit user approval.'],
  };
}

function makeShadowHealth(): AoiOperatorHealthState {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    generatedAt: 5000,
    overallStatus: 'limited',
    summary: 'Synthetic health state.',
    capabilities: [],
    issues: [
      {
        version: 1,
        id: 'health-gmail-disconnected',
        capability: 'personal_signals',
        severity: 'error',
        code: 'gmail_disconnected',
        title: 'Gmail is disconnected',
        summary: 'Gmail metadata is unavailable for private-roadmap@example.com.',
        cannotKnow: 'Do not leak the mail body because Gmail is disconnected.',
        sourceId: 'gmail-metadata',
        observedAt: 5000,
        evidenceRefs: ['environment-source:gmail-metadata'],
        recommendation: {
          version: 1,
          action: 'connect_gmail',
          label: 'Reconnect Gmail metadata.',
          targetPanel: 'personal-sources',
          targetRef: 'gmail-metadata',
        },
      },
    ],
    userBlockingIssueCount: 0,
    evidenceRefs: ['environment-source:gmail-metadata'],
  };
}

function makeShadowSourceRegistry(): AoiEnvironmentSourceRegistry {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    updatedAt: 5000,
    sources: [
      {
        version: 1,
        id: 'gmail-metadata',
        kind: 'gmail_metadata',
        label: 'Gmail metadata',
        enabled: false,
        scope: 'session',
        risk: 'medium',
        allowedOperations: ['read_metadata'],
        privateByDefault: true,
        quietModeBehavior: 'record_only',
        updatedAt: 5000,
        consentReason: 'Explicit user consent is required before Gmail metadata can be used.',
      },
    ],
  };
}
