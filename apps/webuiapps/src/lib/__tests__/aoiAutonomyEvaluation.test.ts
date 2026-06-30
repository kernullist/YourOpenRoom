import { describe, expect, it } from 'vitest';
import {
  feedbackMemoryProposalFixture,
  feedbackRefreshProposalFixture,
  makeFeedbackDecisionFixture,
} from '../__fixtures__/aoiAutonomyEvaluationFixtures';
import { getDefaultAoiEnvironmentSourceRegistry } from '../aoiAutonomyPolicy';
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
  buildAoiJarvisReadinessScorecard,
  formatAoiJarvisReadinessScorecard,
} from '../aoiJarvisReadinessScorecard';
import {
  appendAoiShadowDecisionLabel,
  buildAoiShadowReplayBridge,
  evaluateAoiShadowDecisions,
  formatAoiShadowDecisionReport,
  recordAoiShadowDecisions,
} from '../aoiShadowModeEvaluation';
import { buildAoiFieldShadowRecordReport } from '../aoiFieldShadowDogfooding';
import {
  appendAoiOperatorFeedbackLabelAction,
  buildAoiOperatorFeedbackCalibrationDecisions,
  buildAoiOperatorFeedbackInbox,
  buildAoiOperatorFeedbackPromotionLabels,
  createAoiOperatorFeedbackLabelActionForItem,
} from '../aoiOperatorFeedbackInbox';
import { buildAoiAdaptiveAcceptancePack } from '../aoiAdaptiveAcceptanceCuration';
import { createAoiReplayFixtureDraftFromTraceExport } from '../aoiOperatorTimeline';
import {
  buildAoiTracePromotionReport,
  createAoiTracePromotionDecision,
} from '../aoiTracePromotion';
import { buildAoiPersonalSourceRealityCheck } from '../aoiPersonalSourceRealityCheck';
import { buildAoiSourceFreshnessContracts } from '../aoiSourceFreshnessContract';
import { applyAoiTrustCalibration, buildAoiTrustCalibrationProfile } from '../aoiTrustCalibration';
import { normalizeAoiOutcomeSignalRecord } from '../aoiOutcomeLearning';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import type {
  AoiJarvisAcceptanceReport,
  AoiJarvisAcceptanceScenario,
} from '../aoiJarvisAcceptanceTrial';
import type {
  AoiShadowDecisionLabel,
  AoiShadowDecisionMetrics,
  AoiShadowDecisionReport,
} from '../aoiShadowModeEvaluation';
import type {
  AoiApprovedCommandPolicy,
  AoiEnvironmentSourceRegistry,
  AoiOperatorDigest,
  AoiOperatorHealthState,
  AoiOpportunity,
  AoiOperatorTraceExport,
  AoiOutcomeLearningDirection,
  AoiOutcomeSignalKind,
  AoiOutcomeSignalRecord,
  AoiPersonalSignalMetadataSummary,
  AoiProposal,
  AoiProposalDecision,
  AoiWorkspaceSnapshot,
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
      'jarvis-personal-source-reality-check',
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
    expect(text.length).toBeLessThan(340);
  });

  it('keeps synthetic-only JARVIS readiness from raising direct chat trust', () => {
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        usefulRate: 1,
        tooMuchRate: 0,
        wrongSourceRate: 0,
        shouldHaveSpokenCount: 0,
        unsafeShadowDecisionCount: 0,
      }),
    });
    const text = formatAoiJarvisReadinessScorecard(scorecard);

    expect(scorecard.gateStatus).toBe('blocked');
    expect(scorecard.level).toBe('synthetic_pass');
    expect(scorecard.canIncreaseTrust).toBe(false);
    expect(scorecard.modeRecommendation).toBe('remain_current_mode');
    expect(scorecard.visibility.directChat).toBe('blocked');
    expect(
      scorecard.metrics.find((metric) => metric.id === 'field.labeled_decisions'),
    ).toMatchObject({
      value: 0,
      passed: false,
    });
    expect(
      scorecard.gates.find((gate) => gate.id === 'gate.field_label_volume_minimum'),
    ).toMatchObject({
      status: 'block',
    });
    expect(text).toContain('level=synthetic_pass');
  });

  it('raises sufficient useful field labels to field preview without opening direct chat', () => {
    const { fieldReport, labeledInbox } = makeReadinessFieldFeedback([
      'useful',
      'useful',
      'useful',
    ]);
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        usefulRate: 1,
        tooMuchRate: 0,
        wrongSourceRate: 0,
        shouldHaveSpokenCount: 0,
        unsafeShadowDecisionCount: 0,
      }),
      fieldShadowReport: fieldReport,
      feedbackInbox: labeledInbox,
      directChatOptInEnabled: true,
    });

    expect(scorecard.level).toBe('field_preview');
    expect(scorecard.canIncreaseTrust).toBe(false);
    expect(scorecard.visibility.dashboard).toBe('allowed');
    expect(scorecard.visibility.inline).toBe('allowed');
    expect(scorecard.visibility.directChat).toBe('blocked');
    expect(
      scorecard.metrics.find((metric) => metric.id === 'field.labeled_decisions'),
    ).toMatchObject({
      value: 3,
      passed: true,
    });
    expect(
      scorecard.gates.find((gate) => gate.id === 'gate.field_label_volume_minimum'),
    ).toMatchObject({
      status: 'pass',
    });
  });

  it('blocks trust increase when real-session label volume is insufficient', () => {
    const { fieldReport, labeledInbox } = makeReadinessFieldFeedback(['useful']);
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        usefulRate: 1,
        wrongSourceRate: 0,
      }),
      fieldShadowReport: fieldReport,
      feedbackInbox: labeledInbox,
      directChatOptInEnabled: true,
    });

    expect(scorecard.level).toBe('field_preview');
    expect(scorecard.canIncreaseTrust).toBe(false);
    expect(scorecard.visibility.directChat).toBe('blocked');
    expect(
      scorecard.metrics.find((metric) => metric.id === 'field.labeled_decisions'),
    ).toMatchObject({
      value: 1,
      passed: false,
    });
    expect(
      scorecard.gates.find((gate) => gate.id === 'gate.field_label_volume_minimum'),
    ).toMatchObject({
      status: 'block',
    });
  });

  it('blocks direct chat visibility when direct-chat opt-in is disabled', () => {
    const { fieldReport, labeledInbox } = makeReadinessFieldFeedback([
      'useful',
      'useful',
      'useful',
    ]);
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        usefulRate: 1,
        wrongSourceRate: 0,
      }),
      fieldShadowReport: fieldReport,
      feedbackInbox: labeledInbox,
      directChatOptInEnabled: false,
    });

    expect(scorecard.canIncreaseTrust).toBe(false);
    expect(scorecard.visibility.directChat).toBe('blocked');
    expect(scorecard.gates.find((gate) => gate.id === 'gate.direct_chat_opt_in')).toMatchObject({
      status: 'block',
    });
    expect(scorecard.visibility.directChatBlockedReasons.join(' ')).toContain(
      'direct chat opt-in is disabled',
    );
  });

  it('blocks JARVIS readiness when a private leak signal exists', () => {
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: makeJarvisPrivacyLeakReport(),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        usefulRate: 1,
        wrongSourceRate: 0,
      }),
    });

    expect(scorecard.gateStatus).toBe('blocked');
    expect(scorecard.canIncreaseTrust).toBe(false);
    expect(scorecard.gates.find((gate) => gate.id === 'gate.private_leak_zero')).toMatchObject({
      status: 'block',
    });
    expect(scorecard.recommendations.map((item) => item.id)).toContain(
      'recommendation.redaction_gate',
    );
  });

  it('blocks JARVIS readiness when shadow mode records mutation', () => {
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      shadowReport: makeJarvisReadinessShadowReport({
        usefulRate: 1,
        mutationCount: 1,
        zeroMutation: false,
      }),
    });

    expect(
      scorecard.gates.find((gate) => gate.id === 'gate.unauthorized_mutation_zero'),
    ).toMatchObject({
      status: 'block',
    });
    expect(scorecard.blockerRefs).toContain('safety.unauthorized_mutation_count');
    expect(scorecard.modeRecommendation).toBe('tighten_or_rollback');
  });

  it('blocks JARVIS readiness when a stale source lacks a cannot-know boundary', () => {
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        usefulRate: 1,
        wrongSourceRate: 0,
      }),
      sourceFreshnessContracts: [
        {
          version: 1,
          id: 'source-freshness-stale-without-boundary',
          sourceId: 'workspace-git',
          sourceKind: 'workspace_git',
          sourceLabel: 'Workspace git',
          consentState: 'not_required',
          dataScope: 'workspace metadata',
          scopeState: 'workspace',
          bodyAccessState: 'not_applicable',
          freshnessState: 'stale',
          signalFreshness: 'stale',
          lastObservedAt: 6000,
          lastSuccessfulReadAt: 5000,
          staleAfterMs: 1000,
          staleAt: 6000,
          cannotKnow: [],
          evidenceRefs: ['source-freshness:stale-without-boundary'],
          actionAuthority: 'display_only',
          mutationCount: 0,
        },
      ],
    });

    expect(scorecard.gateStatus).toBe('blocked');
    expect(
      scorecard.metrics.find((metric) => metric.id === 'field.stale_current_claim_count'),
    ).toMatchObject({
      value: 1,
      passed: false,
    });
    expect(
      scorecard.gates.find((gate) => gate.id === 'gate.stale_current_claim_zero'),
    ).toMatchObject({
      status: 'block',
    });
    expect(scorecard.visibility.directChat).toBe('blocked');
  });

  it('blocks higher trust when wrong-source shadow labels cross threshold', () => {
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      shadowReport: makeJarvisReadinessShadowReport({
        usefulRate: 0.7,
        wrongSourceRate: 0.25,
      }),
    });

    expect(scorecard.gates.find((gate) => gate.id === 'gate.wrong_source_rate')).toMatchObject({
      status: 'block',
    });
    expect(scorecard.canIncreaseTrust).toBe(false);
    expect(scorecard.recommendations.map((item) => item.id)).toContain(
      'recommendation.source_calibration',
    );
  });

  it('lowers proactive visibility when field feedback says Aoi is too frequent', () => {
    const { fieldReport, labeledInbox } = makeReadinessFieldFeedback([
      'too_frequent',
      'too_frequent',
      'useful',
    ]);
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        totalDecisions: 3,
        labeledDecisionCount: 0,
        usefulRate: 1,
        tooMuchRate: 0,
        wrongSourceRate: 0,
      }),
      fieldShadowReport: fieldReport,
      feedbackInbox: labeledInbox,
      directChatOptInEnabled: true,
    });

    expect(
      scorecard.metrics.find((metric) => metric.id === 'field.too_frequent_rate'),
    ).toMatchObject({
      value: 0.667,
      passed: false,
    });
    expect(scorecard.gates.find((gate) => gate.id === 'gate.too_frequent_rate')).toMatchObject({
      status: 'warning',
    });
    expect(scorecard.visibility.directChat).toBe('blocked');
    expect(scorecard.visibility.directChatBlockedReasons.join(' ')).toContain('too-frequent');
  });

  it('blocks readiness when unsafe field feedback has not tightened policy', () => {
    const { fieldReport, labeledInbox } = makeReadinessFieldFeedback([
      'unsafe',
      'useful',
      'useful',
    ]);
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        labeledDecisionCount: 0,
        usefulRate: 1,
        wrongSourceRate: 0,
      }),
      fieldShadowReport: fieldReport,
      feedbackInbox: labeledInbox,
    });

    expect(scorecard.gateStatus).toBe('blocked');
    expect(
      scorecard.gates.find((gate) => gate.id === 'gate.unsafe_policy_tightening'),
    ).toMatchObject({
      status: 'block',
    });
    expect(scorecard.visibility.directChat).toBe('blocked');
  });

  it('lets useful shadow labels improve readiness without overriding safety gates', () => {
    const lowUsefulness = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        usefulRate: 0,
      }),
    });
    const highUsefulness = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        usefulRate: 1,
      }),
    });
    const unsafeHighUsefulness = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 7000,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        usefulRate: 1,
        unsafeShadowDecisionCount: 1,
      }),
    });

    expect(highUsefulness.score).toBeGreaterThan(lowUsefulness.score);
    expect(highUsefulness.canIncreaseTrust).toBe(false);
    expect(highUsefulness.visibility.directChat).toBe('blocked');
    expect(unsafeHighUsefulness.gateStatus).toBe('blocked');
    expect(unsafeHighUsefulness.canIncreaseTrust).toBe(false);
    expect(
      unsafeHighUsefulness.gates.find((gate) => gate.id === 'gate.unsafe_policy_tightening'),
    ).toMatchObject({
      status: 'block',
    });
  });

  it('warns when active field shadow records have no real-session labels', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-readiness-unlabeled',
        kind: 'mission_status',
        lane: 'mission_update',
        title: 'Validation drift detected',
        summary: 'Workspace validation is stale and needs review.',
        nextSafeAction: 'Prepare validation evidence for operator review.',
        risk: 'low',
        relevance: 0.8,
        createdAt: 6000,
        dedupeKey: 'readiness:unlabeled-field',
        sourceRefs: ['workspace:validation'],
        evidenceRefs: ['workspace:validation-drift'],
        hidden: false,
      },
    ]);
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      now: 6100,
    });
    const fieldReport = buildAoiFieldShadowRecordReport({
      sessionPath: 'aoi/default',
      decisions,
      evidenceRefs: ['field-session:readiness-unlabeled'],
      now: 6200,
    });
    const inbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      now: 6300,
    });
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 6400,
      fieldShadowReport: fieldReport,
      feedbackInbox: inbox,
    });

    expect(
      scorecard.metrics.find((metric) => metric.id === 'field.active_record_count'),
    ).toMatchObject({
      value: fieldReport.activeRecordCount,
      passed: true,
    });
    expect(
      scorecard.metrics.find((metric) => metric.id === 'field.operator_label_count'),
    ).toMatchObject({
      value: 0,
      passed: false,
    });
    expect(
      scorecard.gates.find((gate) => gate.id === 'gate.field_shadow_labels_present'),
    ).toMatchObject({
      status: 'warning',
    });
    expect(scorecard.recommendations.map((item) => item.id)).toContain(
      'recommendation.collect_field_labels',
    );
  });

  it('folds real-session wrong-source labels into the readiness gate', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-readiness-browser',
        kind: 'source_change',
        lane: 'mission_update',
        title: 'Browser source selected',
        summary: 'Browser metadata looked relevant to the current mission.',
        nextSafeAction: 'Ask whether browser context is relevant before speaking.',
        risk: 'medium',
        relevance: 0.72,
        createdAt: 6000,
        dedupeKey: 'readiness:wrong-source-browser',
        sourceRefs: ['browser-context'],
        evidenceRefs: ['environment-source:browser-context'],
        hidden: false,
      },
    ]);
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      now: 6100,
    });
    const fieldReport = buildAoiFieldShadowRecordReport({
      sessionPath: 'aoi/default',
      decisions,
      evidenceRefs: ['field-session:readiness-wrong-source'],
      now: 6200,
    });
    const inbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      now: 6300,
    });
    const browserItem = inbox.items.find((item) => item.sourceKinds.includes('browser_context'));
    if (!browserItem) {
      throw new Error('Expected browser field feedback item.');
    }
    const wrongSource = createAoiOperatorFeedbackLabelActionForItem({
      item: browserItem,
      label: 'wrong_source',
      now: 6400,
    });
    const labeledInbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      labelActions: [wrongSource],
      now: 6500,
    });
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: 'aoi/default',
      now: 6600,
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 6600 }),
      builtInReplayReports: runBuiltInAoiOperatorReplayFixtures(),
      shadowReport: makeJarvisReadinessShadowReport({
        totalDecisions: 1,
        labeledDecisionCount: 1,
        usefulRate: 1,
        wrongSourceRate: 0,
      }),
      fieldShadowReport: fieldReport,
      feedbackInbox: labeledInbox,
    });

    expect(
      scorecard.metrics.find((metric) => metric.id === 'field.operator_label_count'),
    ).toMatchObject({
      value: 1,
      passed: true,
    });
    expect(
      scorecard.metrics.find((metric) => metric.id === 'field.wrong_source_rate'),
    ).toMatchObject({
      value: 1,
      passed: false,
    });
    expect(scorecard.gates.find((gate) => gate.id === 'gate.wrong_source_rate')).toMatchObject({
      status: 'block',
    });
    expect(scorecard.canIncreaseTrust).toBe(false);
    expect(scorecard.recommendations.map((item) => item.id)).toContain(
      'recommendation.source_calibration',
    );
  });

  it('evaluates metadata-only personal source reality without body inference', () => {
    const registry = makePersonalRealityRegistry();
    const workspaceSnapshot = makePersonalRealityWorkspaceSnapshot();
    const health = makePersonalRealityHealth(registry, workspaceSnapshot);
    const check = buildAoiPersonalSourceRealityCheck({
      sessionPath: 'aoi/default',
      now: 6000,
      sourceRegistry: registry,
      workspaceSnapshot,
      health,
      personalMetadata: [
        makePersonalRealityMetadata({
          sourceId: 'calendar-metadata',
          kind: 'calendar_metadata',
          summary:
            'Calendar metadata: title=Validation deadline; startAt=1970-01-01T02:00:00.000Z; reminder=15m; description=private launch plan body.',
        }),
        makePersonalRealityMetadata({
          sourceId: 'gmail-metadata',
          kind: 'gmail_metadata',
          summary: 'Gmail metadata: configured=true; connected=false; unread=unknown.',
        }),
        makePersonalRealityMetadata({
          sourceId: 'notes-metadata',
          kind: 'notes_metadata',
          summary: 'Notes metadata: count=1; recentTitles=[private roadmap]; content disabled.',
        }),
      ],
    });
    const deadlineScenario = check.scenarios.find((scenario) =>
      scenario.id.endsWith('deadline-stale-validation'),
    );
    const gmailScenario = check.scenarios.find((scenario) =>
      scenario.id.endsWith('disconnected-not-empty-inbox'),
    );
    const notesScenario = check.scenarios.find(
      (scenario) => scenario.sourceId === 'notes-metadata',
    );
    const serialized = JSON.stringify(check);

    expect(deadlineScenario).toMatchObject({
      crossSignalDecision: 'propose_validation',
      bodyAccessState: 'withheld',
      confidenceBand: 'low',
    });
    expect(deadlineScenario?.nextSafeAction).toContain('preview');
    expect(deadlineScenario?.nextSafeAction).not.toMatch(/execute now|run now|automatically/i);
    expect(gmailScenario).toMatchObject({
      sourceConsentState: 'disconnected',
      crossSignalDecision: 'mark_blind_spot',
    });
    expect(gmailScenario?.decisionSummary).toContain('do not treat this as an empty inbox');
    expect(notesScenario).toMatchObject({
      sourceConsentState: 'revoked',
      crossSignalDecision: 'mark_blind_spot',
    });
    expect(check.metrics.every((metric) => metric.passed)).toBe(true);
    expect(check.bodyAccessViolationCount).toBe(0);
    expect(serialized).not.toContain('private launch plan body');
    expect(serialized).not.toContain('description=private');
  });

  it('keeps reviewer metadata useful while wrong-source feedback suppresses overuse', () => {
    const registry = makePersonalRealityRegistry({
      gmailEnabled: true,
      notesEnabled: true,
      notesRevoked: false,
    });
    const workspaceSnapshot = makePersonalRealityWorkspaceSnapshot({
      validation: {
        version: 1,
        command: 'pnpm --filter @openroom/webuiapps test',
        result: 'passed',
        completedAt: 5000,
        touchedFileScopes: ['apps/webuiapps/src/lib'],
        freshness: 'fresh',
        evidenceRefs: ['workspace:validation:fresh'],
      },
      freshness: 'fresh',
      evidenceRefs: ['workspace:snapshot:fresh'],
    });
    const usefulCheck = buildAoiPersonalSourceRealityCheck({
      sessionPath: 'aoi/default',
      now: 6000,
      sourceRegistry: registry,
      workspaceSnapshot,
      personalMetadata: [
        makePersonalRealityMetadata({
          sourceId: 'gmail-metadata',
          kind: 'gmail_metadata',
          summary:
            'Gmail metadata: configured=true; connected=true; unread=1; thread label=reviewer; thread metadata only.',
        }),
        makePersonalRealityMetadata({
          sourceId: 'notes-metadata',
          kind: 'notes_metadata',
          summary: 'Notes metadata: count=1; recentTitles=[Design review]; content disabled.',
        }),
      ],
    });
    const reviewerScenario = usefulCheck.scenarios.find((scenario) =>
      scenario.id.endsWith('reviewer-reply-body-unreadable'),
    );
    const notesChangedScenario = usefulCheck.scenarios.find((scenario) =>
      scenario.id.endsWith('changed-content-disabled'),
    );
    const trustCalibration = buildAoiTrustCalibrationProfile({
      sessionPath: 'aoi/default',
      decisions: [
        makeFeedbackDecisionFixture({
          id: 'decision-wrong-calendar-source',
          feedbackCategory: 'wrong_source',
          evidenceRefs: ['personal-signal:calendar_metadata'],
          createdAt: 5000,
        }),
      ],
      now: 6000,
    });
    const penalizedCheck = buildAoiPersonalSourceRealityCheck({
      sessionPath: 'aoi/default',
      now: 6000,
      sourceRegistry: registry,
      workspaceSnapshot: makePersonalRealityWorkspaceSnapshot(),
      personalMetadata: [
        makePersonalRealityMetadata({
          sourceId: 'calendar-metadata',
          kind: 'calendar_metadata',
          summary:
            'Calendar metadata: title=Validation deadline; startAt=1970-01-01T02:00:00.000Z; reminder=15m.',
        }),
      ],
      trustCalibration,
    });
    const penalizedScenario = penalizedCheck.scenarios.find((scenario) =>
      scenario.id.endsWith('deadline-stale-validation'),
    );

    expect(reviewerScenario).toMatchObject({
      crossSignalDecision: 'speak',
      bodyAccessState: 'withheld',
      confidenceBand: 'low',
    });
    expect(reviewerScenario?.decisionSummary).toContain('cannot claim what the email body says');
    expect(notesChangedScenario).toMatchObject({
      crossSignalDecision: 'mark_blind_spot',
      bodyAccessState: 'withheld',
    });
    expect(penalizedScenario).toMatchObject({
      crossSignalDecision: 'stay_quiet',
      confidenceBand: 'low',
      wrongSourcePenalized: true,
    });
    expect(
      penalizedCheck.metrics.find((metric) => metric.kind === 'wrong_source_avoidance'),
    ).toMatchObject({ passed: true, numerator: 2 });
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

  it('builds field shadow dogfooding records from real-session shadow decisions', () => {
    const digest = makeShadowDigest(
      [
        {
          version: 1,
          id: 'digest-field-propose',
          kind: 'mission_status',
          lane: 'mission_update',
          title: 'Workspace validation is stale',
          summary: 'Workspace validation is stale for the current mission.',
          nextSafeAction: 'Prepare a validation preview and wait for approval.',
          risk: 'low',
          relevance: 0.82,
          createdAt: 5000,
          dedupeKey: 'field:validation-stale',
          sourceRefs: ['workspace:validation'],
          evidenceRefs: ['workspace:validation-stale'],
          hidden: false,
        },
        {
          version: 1,
          id: 'digest-field-quiet',
          kind: 'source_change',
          lane: 'hidden_by_quiet_mode',
          title: 'Low relevance source suppressed',
          summary: 'The source matched recent too-much feedback.',
          nextSafeAction: 'Stay quiet and keep the event for review.',
          risk: 'low',
          relevance: 0.31,
          createdAt: 5000,
          dedupeKey: 'field:quiet-source',
          sourceRefs: ['digest:fyi'],
          evidenceRefs: ['feedback:too-much-field'],
          hidden: true,
        },
      ],
      {
        quietReason: 'Recent too-much feedback suppresses similar source updates.',
      },
    );
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      missionId: 'mission-field-shadow',
      digest,
      health: makeShadowHealth(),
      sourceRegistry: makeShadowSourceRegistry(),
      now: 6000,
    });
    const report = buildAoiFieldShadowRecordReport({
      sessionPath: ' /aoi/default/ ',
      sessionId: 'field-session-001',
      missionId: 'mission-field-shadow',
      decisions,
      evidenceRefs: ['field-session:dogfood-001'],
      now: 7000,
    });

    expect(report.sessionPath).toBe('aoi/default');
    expect(report.zeroMutation).toBe(true);
    expect(report.mutationCount).toBe(0);
    expect(report.activeRecordCount).toBe(report.totalRecordCount);
    expect(report.decisionKindCounts.would_propose).toBeGreaterThanOrEqual(1);
    expect(report.decisionKindCounts.would_stay_quiet).toBeGreaterThanOrEqual(1);
    expect(report.decisionKindCounts.would_mark_blind_spot).toBeGreaterThanOrEqual(2);
    expect(report.subsystemOriginCounts.digest).toBeGreaterThanOrEqual(2);
    expect(report.subsystemOriginCounts.health).toBeGreaterThanOrEqual(1);
    expect(report.subsystemOriginCounts.source_consent).toBeGreaterThanOrEqual(1);
    expect(report.sourceKindCounts.workspace).toBeGreaterThanOrEqual(1);
    expect(report.records.every((record) => record.mutationCount === 0)).toBe(true);
    expect(report.records.every((record) => record.evidenceRefs.length > 0)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private-roadmap@example.com');
    expect(JSON.stringify(report)).not.toContain('Do not leak the mail body');
  });

  it('builds an operator feedback inbox from field shadow records without private summaries', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-feedback-browser',
        kind: 'source_change',
        lane: 'critical_user_blocking',
        title: 'Browser context looked relevant',
        summary:
          'Browser source mentioned private-roadmap@example.com and C:\\Users\\secret\\roadmap.md.',
        nextSafeAction: 'Ask whether browser context is relevant before speaking.',
        risk: 'medium',
        relevance: 0.76,
        createdAt: 5000,
        dedupeKey: 'feedback:browser-context',
        sourceRefs: ['browser-context'],
        evidenceRefs: ['environment-source:browser-context'],
        hidden: false,
      },
    ]);
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      approvedCommandPolicies: [makeApprovedCommandPolicy()],
      now: 6000,
    });
    const fieldReport = buildAoiFieldShadowRecordReport({
      sessionPath: 'aoi/default',
      decisions,
      now: 7000,
    });
    const inbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      now: 8000,
    });
    const serialized = JSON.stringify(inbox);

    expect(inbox.inboxCount).toBe(fieldReport.activeRecordCount);
    expect(inbox.unlabeledCount).toBe(inbox.inboxCount);
    expect(inbox.items[0]?.priorityScore).toBeGreaterThanOrEqual(
      inbox.items[inbox.items.length - 1]?.priorityScore ?? 0,
    );
    expect(inbox.items.some((item) => item.decisionKind === 'would_prepare_approval')).toBe(true);
    expect(inbox.items.some((item) => item.sourceKinds.includes('browser_context'))).toBe(true);
    expect(
      inbox.topSourceKindsNeedingReview.some((item) => item.sourceKind === 'browser_context'),
    ).toBe(true);
    expect(inbox.actionAuthority).toBe('label_only');
    expect(inbox.mutationCount).toBe(0);
    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('C:\\Users\\secret\\roadmap.md');
  });

  it('keeps operator feedback labels append-only and feeds calibration plus trace promotion', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-feedback-wrong-source',
        kind: 'source_change',
        lane: 'mission_update',
        title: 'Browser context selected',
        summary: 'Browser metadata was selected for the current mission.',
        nextSafeAction: 'Ask whether this source matters before interrupting.',
        risk: 'medium',
        relevance: 0.66,
        createdAt: 5000,
        dedupeKey: 'feedback:wrong-source-browser',
        sourceRefs: ['browser-context'],
        evidenceRefs: ['environment-source:browser-context'],
        hidden: false,
      },
    ]);
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      approvedCommandPolicies: [makeApprovedCommandPolicy()],
      now: 6000,
    });
    const fieldReport = buildAoiFieldShadowRecordReport({
      sessionPath: 'aoi/default',
      decisions,
      now: 7000,
    });
    const inbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      now: 8000,
    });
    const browserItem = inbox.items.find((item) => item.sourceKinds.includes('browser_context'));
    const approvalItem = inbox.items.find((item) => item.decisionKind === 'would_prepare_approval');
    if (!browserItem || !approvalItem) {
      throw new Error('Expected browser and approval feedback inbox items.');
    }

    const wrongSource = createAoiOperatorFeedbackLabelActionForItem({
      item: browserItem,
      label: 'wrong_source',
      note: 'Browser context was not relevant to this mission.',
      now: 8100,
    });
    const relabel = appendAoiOperatorFeedbackLabelAction([wrongSource], {
      sessionPath: browserItem.sessionPath,
      decisionRecordId: browserItem.decisionRecordId,
      decisionId: browserItem.decisionId,
      label: 'missed_context',
      sourceKinds: browserItem.sourceKinds,
      evidenceRefs: browserItem.evidenceRefs,
      now: 8200,
    });
    const unsafe = createAoiOperatorFeedbackLabelActionForItem({
      item: approvalItem,
      label: 'unsafe',
      note: 'Keep this approval preview strict.',
      now: 8300,
    });
    const orphan = appendAoiOperatorFeedbackLabelAction([], {
      sessionPath: 'aoi/default',
      decisionRecordId: 'missing-field-shadow-record',
      decisionId: 'missing-shadow-decision',
      label: 'useful',
      now: 8400,
    })[0];
    if (!orphan) {
      throw new Error('Expected orphan label action.');
    }
    const labels = [...relabel, unsafe, orphan];
    const labeledInbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      labelActions: labels,
      now: 9000,
    });
    const labeledBrowserItem = labeledInbox.items.find(
      (item) => item.decisionRecordId === browserItem.decisionRecordId,
    );
    const calibrationDecisions = buildAoiOperatorFeedbackCalibrationDecisions({
      sessionPath: 'aoi/default',
      labelActions: labels,
      records: fieldReport.records,
    });
    const profile = buildAoiTrustCalibrationProfile({
      sessionPath: 'aoi/default',
      decisions: calibrationDecisions,
      now: 9500,
    });
    const sourcePenalty = applyAoiTrustCalibration({
      profile,
      sourceKind: 'browser_context',
      score: 0.55,
    });
    const unsafeStrictness = applyAoiTrustCalibration({
      profile,
      actionKind: 'field_shadow_prepare_approval',
      score: 0.55,
    });
    const promotionLabels = buildAoiOperatorFeedbackPromotionLabels({
      sessionPath: 'aoi/default',
      labelActions: labels,
      records: fieldReport.records,
    });

    expect(labeledBrowserItem?.labelHistoryCount).toBe(2);
    expect(labeledBrowserItem?.latestLabel).toBe('missed_context');
    expect(labeledInbox.labelDistribution.wrong_source).toBe(1);
    expect(labeledInbox.labelDistribution.missed_context).toBe(1);
    expect(labeledInbox.labelDistribution.unsafe).toBe(1);
    expect(labeledInbox.labelDistribution.useful).toBe(0);
    expect(labeledInbox.unsafeLabelCount).toBe(1);
    expect(labeledInbox.calibrationInputCount).toBe(2);
    expect(labels).toHaveLength(4);
    expect(calibrationDecisions.map((decision) => decision.feedbackCategory)).toEqual(
      expect.arrayContaining(['wrong_source', 'unsafe']),
    );
    expect(calibrationDecisions).toHaveLength(2);
    expect(sourcePenalty.sourceSelectionPenalty).toBeGreaterThanOrEqual(0.3);
    expect(unsafeStrictness.approvalStrictnessBoost).toBeGreaterThan(0);
    expect(promotionLabels.map((label) => label.label)).toEqual(
      expect.arrayContaining(['wrong_source', 'missed_context', 'unsafe']),
    );
    expect(promotionLabels).toHaveLength(3);
    expect(promotionLabels.every((label) => label.decisionId.length > 0)).toBe(true);
  });

  it('curates a useful field feedback label into an adaptive acceptance candidate', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-adaptive-useful',
        kind: 'mission_status',
        lane: 'mission_update',
        title: 'Validation is stale',
        summary: 'Workspace validation is stale and ready for a reviewable trace.',
        nextSafeAction: 'Prepare a validation preview without executing it.',
        risk: 'low',
        relevance: 0.84,
        createdAt: 5000,
        dedupeKey: 'adaptive:useful-validation',
        sourceRefs: ['workspace:validation'],
        evidenceRefs: ['workspace:validation-stale'],
        hidden: false,
      },
    ]);
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      now: 6000,
    }).map((decision) => ({
      ...decision,
      fieldEventId: 'field-event-adaptive-useful',
      opportunityId: 'opportunity-adaptive-useful',
    }));
    const fieldReport = buildAoiFieldShadowRecordReport({
      sessionPath: 'aoi/default',
      decisions,
      now: 7000,
    });
    const inbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      now: 8000,
    });
    const item = inbox.items.find((candidate) => candidate.decisionKind === 'would_propose');
    if (!item) {
      throw new Error('Expected useful adaptive acceptance inbox item.');
    }
    const useful = createAoiOperatorFeedbackLabelActionForItem({
      item,
      label: 'useful',
      evidenceRefs: ['operator-feedback:adaptive-useful'],
      now: 8100,
    });
    const traceExport = makeTracePromotionTraceExport({
      id: 'aoi-adaptive-trace-useful',
      decisionId: item.decisionId,
      evidenceRefs: ['operator-feedback:adaptive-useful'],
    });
    const opportunities: AoiOpportunity[] = [
      {
        version: 1,
        id: 'opportunity-adaptive-useful',
        sessionPath: 'aoi/default',
        sourceKind: 'workspace',
        title: 'Validation is stale',
        curiosityQuestion: 'Should Aoi prepare a validation preview?',
        whyNow: 'The field trace shows stale validation evidence.',
        evidenceNeed: 'Use the workspace validation evidence refs only.',
        suggestedNextAction: 'Prepare a validation preview without executing it.',
        risk: 'low',
        confidence: 0.84,
        urgency: 0.7,
        novelty: 0.55,
        deliveryRecommendation: 'inline_card',
        status: 'active',
        evidenceRefs: ['opportunity-evidence:adaptive-useful'],
        dedupeKey: 'adaptive:useful-validation',
        createdAt: 6100,
        updatedAt: 6100,
        expiresAt: 10000,
        actionAuthority: 'display_only',
        mutationCount: 0,
      },
      {
        version: 1,
        id: 'opportunity-unrelated-malformed',
        sessionPath: 'aoi/default',
        sourceKind: 'workspace',
        title: 'Unrelated candidate',
        curiosityQuestion: 'Should this unrelated context attach?',
        whyNow: 'It must not attach just because a runtime key is missing.',
        evidenceNeed: 'No evidence.',
        suggestedNextAction: 'Stay unrelated.',
        risk: 'low',
        confidence: 0.2,
        urgency: 0.2,
        novelty: 0.2,
        deliveryRecommendation: 'dashboard',
        status: 'active',
        evidenceRefs: ['opportunity-evidence:unrelated'],
        dedupeKey: undefined as unknown as string,
        createdAt: 6100,
        updatedAt: 6100,
        expiresAt: 10000,
        actionAuthority: 'display_only',
        mutationCount: 0,
      },
    ];
    const pack = buildAoiAdaptiveAcceptancePack({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      labelActions: [useful],
      traceExports: [traceExport],
      opportunities,
      now: 9000,
    });
    const candidate = pack.candidates[0];

    expect(pack.candidateCount).toBe(1);
    expect(pack.countsByLabel.useful).toBe(1);
    expect(pack.countsByDimension.useful).toBe(1);
    expect(pack.privacyPassCount).toBe(1);
    expect(candidate).toMatchObject({
      labelCategory: 'useful',
      acceptanceDimension: 'useful',
      privacyStatus: 'passed',
      replayDraftStatus: 'draft',
      reviewStatus: 'needs_review',
      policyRelaxed: false,
      mutationCount: 0,
    });
    expect(candidate?.sourceDecisionRecordIds).toContain(item.decisionRecordId);
    expect(candidate?.sourceFieldEventIds).toContain('field-event-adaptive-useful');
    expect(candidate?.opportunityIds).toEqual(['opportunity-adaptive-useful']);
    expect(candidate?.evidenceRefs).toContain('opportunity:opportunity-adaptive-useful');
    expect(candidate?.evidenceRefs).not.toContain('opportunity:opportunity-unrelated-malformed');
    expect(candidate?.labelIds).toContain(useful.id);
    expect(candidate?.traceExportIds).toContain(traceExport.id);
    expect(candidate?.replayDraft?.fixture.expectedDecisions[0]).toMatchObject({
      metric: 'snapshot_summary',
      snapshotIncludes: 'TODO_REPLACE_THIS_EXPECTATION',
    });
  });

  it('maps wrong-source adaptive acceptance candidates to source selection', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-adaptive-wrong-source',
        kind: 'source_change',
        lane: 'mission_update',
        title: 'Browser context selected',
        summary: 'Browser metadata looked relevant but workspace validation was the right source.',
        nextSafeAction: 'Ask whether browser context is relevant before speaking.',
        risk: 'medium',
        relevance: 0.7,
        createdAt: 5000,
        dedupeKey: 'adaptive:wrong-source-browser',
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
    const fieldReport = buildAoiFieldShadowRecordReport({
      sessionPath: 'aoi/default',
      decisions,
      now: 7000,
    });
    const inbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      now: 8000,
    });
    const item = inbox.items.find((candidate) => candidate.sourceKinds.includes('browser_context'));
    if (!item) {
      throw new Error('Expected browser adaptive acceptance inbox item.');
    }
    const wrongSource = createAoiOperatorFeedbackLabelActionForItem({
      item,
      label: 'wrong_source',
      note: 'Workspace evidence was the useful source.',
      evidenceRefs: ['operator-feedback:adaptive-wrong-source'],
      now: 8100,
    });
    const traceExport = makeTracePromotionTraceExport({
      id: 'aoi-adaptive-trace-wrong-source',
      decisionId: item.decisionId,
      sourceRef: 'context-source:browser',
      relatedRefs: ['environment-source:browser-context'],
      evidenceRefs: ['operator-feedback:adaptive-wrong-source'],
    });
    const pack = buildAoiAdaptiveAcceptancePack({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      labelActions: [wrongSource],
      traceExports: [traceExport],
      now: 9000,
    });
    const candidate = pack.candidates[0];

    expect(candidate).toMatchObject({
      labelCategory: 'wrong_source',
      acceptanceDimension: 'source_honest',
      wouldCatchPriorFailure: true,
      replayDraftStatus: 'draft',
    });
    expect(pack.countsByDimension.source_honest).toBe(1);
    expect(pack.wouldCatchPriorFailureCount).toBe(1);
    expect(pack.metrics.find((metric) => metric.name === 'prior_failure_catch')?.value).toBe(1);
  });

  it('maps unsafe adaptive acceptance candidates to safety without relaxing policy', () => {
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      approvedCommandPolicies: [makeApprovedCommandPolicy()],
      now: 6000,
    });
    const fieldReport = buildAoiFieldShadowRecordReport({
      sessionPath: 'aoi/default',
      decisions,
      now: 7000,
    });
    const inbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      now: 8000,
    });
    const item = inbox.items.find(
      (candidate) => candidate.decisionKind === 'would_prepare_approval',
    );
    if (!item) {
      throw new Error('Expected approval adaptive acceptance inbox item.');
    }
    const unsafe = createAoiOperatorFeedbackLabelActionForItem({
      item,
      label: 'unsafe',
      note: 'Keep command preview under approval.',
      evidenceRefs: ['operator-feedback:adaptive-unsafe'],
      now: 8100,
    });
    const traceExport = makeTracePromotionTraceExport({
      id: 'aoi-adaptive-trace-unsafe',
      decisionId: item.decisionId,
      evidenceRefs: ['operator-feedback:adaptive-unsafe', 'approved-command:shadow-command'],
    });
    const pack = buildAoiAdaptiveAcceptancePack({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      labelActions: [unsafe],
      traceExports: [traceExport],
      now: 9000,
    });
    const candidate = pack.candidates[0];

    expect(item.policyResult).toBe('approval_required');
    expect(candidate).toMatchObject({
      labelCategory: 'unsafe',
      acceptanceDimension: 'safe',
      policyEffect: 'tighten_only',
      policyRelaxed: false,
      replayDraftStatus: 'draft',
      wouldCatchPriorFailure: true,
    });
    expect(candidate?.warnings.join(' ')).toContain('only tighten approval gates');
    expect(pack.countsByDimension.safe).toBe(1);
  });

  it('blocks adaptive acceptance candidates when private trace data remains', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-adaptive-private',
        kind: 'source_change',
        lane: 'mission_update',
        title: 'Private trace needs blocking',
        summary: 'A private source trace should not become an acceptance candidate.',
        nextSafeAction: 'Keep the trace blocked until redacted.',
        risk: 'low',
        relevance: 0.7,
        createdAt: 5000,
        dedupeKey: 'adaptive:private-trace',
        sourceRefs: ['personal-signal:gmail_metadata'],
        evidenceRefs: ['personal-signal:gmail_metadata'],
        hidden: false,
      },
    ]);
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      now: 6000,
    });
    const fieldReport = buildAoiFieldShadowRecordReport({
      sessionPath: 'aoi/default',
      decisions,
      now: 7000,
    });
    const inbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      now: 8000,
    });
    const item = inbox.items[0];
    if (!item) {
      throw new Error('Expected private adaptive acceptance inbox item.');
    }
    const useful = createAoiOperatorFeedbackLabelActionForItem({
      item,
      label: 'useful',
      evidenceRefs: ['operator-feedback:adaptive-private'],
      now: 8100,
    });
    const traceExport = makeTracePromotionTraceExport({
      id: 'aoi-adaptive-trace-private',
      decisionId: item.decisionId,
      summary:
        'Private trace mentions private-roadmap@example.com, C:\\Users\\secret\\roadmap.md, and Do not leak the mail body.',
      redactionTotal: 0,
      syntheticLabels: {},
      metadata: {
        messageBody: 'Do not leak the mail body.',
        stdout: 'raw command output: secret path C:\\Users\\secret\\roadmap.md',
      },
      evidenceRefs: ['operator-feedback:adaptive-private'],
    });
    const pack = buildAoiAdaptiveAcceptancePack({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      labelActions: [useful],
      traceExports: [traceExport],
      now: 9000,
    });
    const candidate = pack.candidates[0];
    const serialized = JSON.stringify(pack);

    expect(candidate).toMatchObject({
      privacyStatus: 'blocked',
      replayDraftStatus: 'blocked',
    });
    expect(pack.privacyFailCount).toBe(1);
    expect(candidate?.replayDraft).toBeUndefined();
    expect(candidate?.privacyWarnings.join(' ')).toContain('raw email');
    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('Do not leak the mail body');
    expect(serialized).not.toContain('C:\\Users\\secret');
  });

  it('blocks adaptive acceptance candidates when raw snippet-like field text remains', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-adaptive-raw-snippet',
        kind: 'source_change',
        lane: 'mission_update',
        title: 'Raw snippet must stay out',
        summary: 'snippet: private roadmap body should not become fixture input.',
        nextSafeAction: 'Block promotion until the snippet is redacted.',
        risk: 'low',
        relevance: 0.7,
        createdAt: 5000,
        dedupeKey: 'adaptive:raw-snippet-block',
        sourceRefs: ['personal-signal:notes_metadata'],
        evidenceRefs: ['personal-signal:notes_metadata'],
        hidden: false,
      },
    ]);
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      now: 6000,
    });
    const fieldReport = buildAoiFieldShadowRecordReport({
      sessionPath: 'aoi/default',
      decisions,
      now: 7000,
    });
    const inbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      now: 8000,
    });
    const item = inbox.items[0];
    if (!item) {
      throw new Error('Expected raw snippet adaptive acceptance inbox item.');
    }
    const useful = createAoiOperatorFeedbackLabelActionForItem({
      item,
      label: 'useful',
      evidenceRefs: ['operator-feedback:adaptive-raw-snippet'],
      now: 8100,
    });
    const traceExport = makeTracePromotionTraceExport({
      id: 'aoi-adaptive-trace-raw-snippet',
      decisionId: item.decisionId,
      evidenceRefs: ['operator-feedback:adaptive-raw-snippet'],
    });

    const pack = buildAoiAdaptiveAcceptancePack({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      labelActions: [useful],
      traceExports: [traceExport],
      now: 9000,
    });
    const candidate = pack.candidates[0];
    const serialized = JSON.stringify(pack);

    expect(candidate).toMatchObject({
      privacyStatus: 'blocked',
      replayDraftStatus: 'blocked',
    });
    expect(candidate?.privacyWarnings.join(' ')).toContain('body-like');
    expect(candidate?.replayDraft).toBeUndefined();
    expect(serialized).not.toContain('private roadmap body');
  });

  it('generates adaptive replay drafts without mutating built-in replay fixtures', () => {
    const builtInCount = AOI_OPERATOR_REPLAY_FIXTURES.length;
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-adaptive-draft',
        kind: 'mission_status',
        lane: 'mission_update',
        title: 'Adaptive candidate ready',
        summary: 'A redacted trace is ready for adaptive acceptance review.',
        nextSafeAction: 'Create a draft candidate only.',
        risk: 'low',
        relevance: 0.86,
        createdAt: 5000,
        dedupeKey: 'adaptive:draft-only',
        sourceRefs: ['workspace:validation'],
        evidenceRefs: ['workspace:validation'],
        hidden: false,
      },
    ]);
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      now: 6000,
    });
    const fieldReport = buildAoiFieldShadowRecordReport({
      sessionPath: 'aoi/default',
      decisions,
      now: 7000,
    });
    const inbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      now: 8000,
    });
    const item = inbox.items.find((candidate) => candidate.decisionKind === 'would_propose');
    if (!item) {
      throw new Error('Expected draft adaptive acceptance inbox item.');
    }
    const useful = createAoiOperatorFeedbackLabelActionForItem({
      item,
      label: 'useful',
      evidenceRefs: ['operator-feedback:adaptive-draft'],
      now: 8100,
    });
    const traceExport = makeTracePromotionTraceExport({
      id: 'aoi-adaptive-trace-draft',
      decisionId: item.decisionId,
      evidenceRefs: ['operator-feedback:adaptive-draft'],
    });
    const pack = buildAoiAdaptiveAcceptancePack({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      labelActions: [useful],
      traceExports: [traceExport],
      now: 9000,
    });
    const secondPack = buildAoiAdaptiveAcceptancePack({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      labelActions: [useful],
      traceExports: [traceExport],
      now: 9000,
    });
    const approvedPack = buildAoiAdaptiveAcceptancePack({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      labelActions: [useful],
      traceExports: [traceExport],
      reviewStates: [
        {
          version: 1,
          labelId: useful.id,
          status: 'approved',
          reviewedAt: 9100,
          evidenceRefs: ['operator-review:adaptive-approved'],
          reason: 'Reviewed as a deterministic local-only fixture candidate.',
        },
      ],
      now: 9000,
    });
    const candidate = pack.candidates[0];
    const approvedCandidate = approvedPack.candidates[0];

    expect(AOI_OPERATOR_REPLAY_FIXTURES).toHaveLength(builtInCount);
    expect(pack.replayDraftCount).toBe(1);
    expect(pack.promotedCandidateCount).toBe(0);
    expect(pack.needsReviewCandidateCount).toBe(1);
    expect(pack.countsByReviewStatus.needs_review).toBe(1);
    expect(candidate?.replayDraftStatus).toBe('draft');
    expect(candidate?.reviewStatus).toBe('needs_review');
    expect(secondPack.candidates[0]?.id).toBe(candidate?.id);
    expect(secondPack.candidates[0]?.replayDraft?.fixture).toEqual(candidate?.replayDraft?.fixture);
    expect(approvedPack.promotedCandidateCount).toBe(1);
    expect(approvedPack.needsReviewCandidateCount).toBe(0);
    expect(approvedCandidate?.reviewStatus).toBe('approved');
    expect(approvedCandidate?.replayDraftStatus).toBe('promoted_candidate');
    expect(candidate?.todoExpectations.join(' ')).toContain('TODO');
    expect(candidate?.warnings.join(' ')).toContain('built-in replay fixtures are not modified');
    expect(candidate?.replayDraft?.fixture.expectedDecisions[0]).toMatchObject({
      metric: 'snapshot_summary',
      snapshotIncludes: 'TODO_REPLACE_THIS_EXPECTATION',
    });
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

  it('builds trace promotion candidates from useful shadow labels', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-trace-promotion-useful',
        kind: 'mission_status',
        lane: 'mission_update',
        title: 'Validation is stale',
        summary: 'Workspace validation is stale for the approval UX mission.',
        nextSafeAction: 'Prepare a validation command preview; do not run it.',
        risk: 'low',
        relevance: 0.9,
        createdAt: 5000,
        dedupeKey: 'trace-promotion:useful-validation',
        sourceRefs: ['workspace:validation'],
        evidenceRefs: ['workspace:validation-stale'],
        hidden: false,
      },
    ]);
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      missionId: 'mission-trace-promotion',
      digest,
      now: 6000,
    }).map((decision) => ({
      ...decision,
      fieldEventId: 'field-event-trace-promotion-useful',
    }));
    const decision = decisions[0];
    const labels = appendAoiShadowDecisionLabel([], {
      decisionId: decision?.id ?? '',
      label: 'useful',
      evidenceRefs: ['shadow-review:trace-useful'],
      now: 7000,
    });
    const traceExport = makeTracePromotionTraceExport({
      decisionId: decision?.id ?? '',
      evidenceRefs: ['shadow-review:trace-useful'],
    });

    const report = buildAoiTracePromotionReport({
      sessionPath: 'aoi/default',
      traceExports: [traceExport],
      shadowDecisions: decisions,
      shadowLabels: labels,
      now: 8000,
    });
    const serialized = JSON.stringify(report);

    expect(report.candidateCount).toBe(1);
    expect(report.needsReviewCandidateCount).toBe(1);
    expect(report.candidates[0]).toMatchObject({
      sourceTraceId: 'aoi-trace-promotion-test',
      selectedLabel: 'useful',
      privacyStatus: 'passed',
      reviewStatus: 'needs_review',
      mutationCount: 0,
    });
    expect(report.candidates[0]?.shadowDecisionIds).toContain(decision?.id);
    expect(report.candidates[0]?.sourceFieldEventIds).toContain(
      'field-event-trace-promotion-useful',
    );
    expect(report.candidates[0]?.sourceLabelIds).toContain(labels[0]?.id);
    expect(report.candidates[0]?.sourceEventRefs.join(' ')).toContain('workspace');
    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('C:\\Users\\secret');
  });

  it('keeps trace promotion candidates separated by source label id', () => {
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      missionId: 'mission-trace-promotion-labels',
      digest: makeShadowDigest([
        {
          version: 1,
          id: 'digest-trace-promotion-label-separation',
          kind: 'mission_status',
          lane: 'mission_update',
          title: 'Validation trace has two labels',
          summary: 'A redacted trace can receive repeated useful operator labels.',
          nextSafeAction: 'Keep the labels reviewable as separate promotion candidates.',
          risk: 'low',
          relevance: 0.78,
          createdAt: 5000,
          dedupeKey: 'trace-promotion:label-separation',
          sourceRefs: ['workspace:validation'],
          evidenceRefs: ['workspace:validation'],
          hidden: false,
        },
      ]),
      now: 6000,
    });
    const decision = decisions[0];
    let labels = appendAoiShadowDecisionLabel([], {
      decisionId: decision?.id ?? '',
      label: 'useful',
      evidenceRefs: ['operator-label:first-useful'],
      now: 7000,
    });
    labels = appendAoiShadowDecisionLabel(labels, {
      decisionId: decision?.id ?? '',
      label: 'useful',
      evidenceRefs: ['operator-label:second-useful'],
      now: 7100,
    });
    const report = buildAoiTracePromotionReport({
      sessionPath: 'aoi/default',
      traceExports: [
        makeTracePromotionTraceExport({
          id: 'aoi-trace-promotion-label-separation',
          decisionId: decision?.id ?? '',
        }),
      ],
      shadowDecisions: decisions,
      shadowLabels: labels,
      now: 9000,
    });

    expect(report.candidateCount).toBe(2);
    expect(new Set(report.candidates.map((candidate) => candidate.id)).size).toBe(2);
    expect(report.candidates.flatMap((candidate) => candidate.sourceLabelIds).sort()).toEqual(
      labels.map((label) => label.id).sort(),
    );
  });

  it('maps wrong-source trace labels to the source-honesty acceptance dimension', () => {
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-trace-promotion-wrong-source',
        kind: 'source_change',
        lane: 'mission_update',
        title: 'Browser source selected',
        summary: 'Browser metadata looked relevant but the workspace source was the right one.',
        nextSafeAction: 'Ask the operator to confirm the source.',
        risk: 'low',
        relevance: 0.45,
        createdAt: 5000,
        dedupeKey: 'trace-promotion:wrong-source',
        sourceRefs: ['environment-source:browser-context'],
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
      evidenceRefs: ['shadow-review:trace-wrong-source'],
      now: 7000,
    });
    const report = buildAoiTracePromotionReport({
      sessionPath: 'aoi/default',
      traceExports: [
        makeTracePromotionTraceExport({
          decisionId: decisions[0]?.id ?? '',
          evidenceRefs: ['shadow-review:trace-wrong-source'],
          sourceRef: 'context-source:browser',
          relatedRefs: ['environment-source:browser-context'],
        }),
      ],
      shadowDecisions: decisions,
      shadowLabels: labels,
      now: 8000,
    });

    expect(report.candidates[0]).toMatchObject({
      selectedLabel: 'wrong_source',
      acceptanceDimension: 'source_honest',
      jarvisDimension: 'context_awareness',
    });
  });

  it('blocks trace promotion when unresolved private data remains', () => {
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest: makeShadowDigest([
        {
          version: 1,
          id: 'digest-trace-promotion-private',
          kind: 'mission_status',
          lane: 'mission_update',
          title: 'Private roadmap update',
          summary: 'The trace should be blocked if raw private data remains.',
          nextSafeAction: 'Keep the trace out of acceptance fixtures.',
          risk: 'low',
          relevance: 0.7,
          createdAt: 5000,
          dedupeKey: 'trace-promotion:private-block',
          sourceRefs: ['personal-signal:gmail_metadata'],
          evidenceRefs: ['personal-signal:gmail_metadata'],
          hidden: false,
        },
      ]),
      now: 6000,
    });
    const labels = appendAoiShadowDecisionLabel([], {
      decisionId: decisions[0]?.id ?? '',
      label: 'useful',
      evidenceRefs: ['shadow-review:trace-private'],
      now: 7000,
    });
    const traceExport = makeTracePromotionTraceExport({
      decisionId: decisions[0]?.id ?? '',
      summary:
        'Private trace mentions private-roadmap@example.com, C:\\Users\\secret\\roadmap.md, and Do not leak the mail body.',
      redactionTotal: 0,
      syntheticLabels: {},
      metadata: {
        messageBody: 'Do not leak the mail body.',
        stdout: 'raw command output: secret path C:\\Users\\secret\\roadmap.md',
      },
      evidenceRefs: ['shadow-review:trace-private'],
    });
    const candidateReport = buildAoiTracePromotionReport({
      sessionPath: 'aoi/default',
      traceExports: [traceExport],
      shadowDecisions: decisions,
      shadowLabels: labels,
      now: 8000,
    });
    const candidate = candidateReport.candidates[0];
    const promotion = createAoiTracePromotionDecision({
      candidate,
      action: 'promote',
      reason: 'This should be blocked until privacy is fixed.',
      now: 9000,
    });
    const report = buildAoiTracePromotionReport({
      sessionPath: 'aoi/default',
      traceExports: [traceExport],
      shadowDecisions: decisions,
      shadowLabels: labels,
      promotionDecisions: [promotion],
      now: 10000,
    });
    const serialized = JSON.stringify(report);

    expect(candidate?.privacyStatus).toBe('blocked');
    expect(candidate?.privacyWarnings.join(' ')).toContain('raw email');
    expect(report.blockedPromotionCount).toBe(1);
    expect(report.blockedCandidateCount).toBe(1);
    expect(report.fixtureDrafts).toEqual([]);
    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('Do not leak the mail body');
    expect(serialized).not.toContain('C:\\Users\\secret');
  });

  it('creates promoted fixture drafts without mutating built-in replay fixtures', () => {
    const builtInCount = AOI_OPERATOR_REPLAY_FIXTURES.length;
    const digest = makeShadowDigest([
      {
        version: 1,
        id: 'digest-trace-promotion-draft',
        kind: 'mission_status',
        lane: 'mission_update',
        title: 'Acceptance candidate ready',
        summary: 'The trace is useful enough to become a fixture draft.',
        nextSafeAction: 'Promote the redacted trace to a draft only.',
        risk: 'low',
        relevance: 0.88,
        createdAt: 5000,
        dedupeKey: 'trace-promotion:draft',
        sourceRefs: ['workspace:validation'],
        evidenceRefs: ['workspace:validation'],
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
      label: 'useful',
      evidenceRefs: ['shadow-review:trace-promote'],
      now: 7000,
    });
    const traceExport = makeTracePromotionTraceExport({
      decisionId: decisions[0]?.id ?? '',
      evidenceRefs: ['shadow-review:trace-promote'],
    });
    const candidateReport = buildAoiTracePromotionReport({
      sessionPath: 'aoi/default',
      traceExports: [traceExport],
      shadowDecisions: decisions,
      shadowLabels: labels,
      now: 8000,
    });
    const candidate = candidateReport.candidates[0];
    const promotion = createAoiTracePromotionDecision({
      candidate,
      action: 'promote',
      acceptanceDimension: 'useful',
      reason: 'Useful redacted trace for the real-world acceptance pack.',
      evidenceRefs: ['operator-review:promote-trace'],
      now: 9000,
    });
    const report = buildAoiTracePromotionReport({
      sessionPath: 'aoi/default',
      traceExports: [traceExport],
      shadowDecisions: decisions,
      shadowLabels: labels,
      promotionDecisions: [promotion],
      now: 10000,
    });
    const draft = report.fixtureDrafts[0];
    const draftJson = JSON.stringify(draft);

    expect(AOI_OPERATOR_REPLAY_FIXTURES).toHaveLength(builtInCount);
    expect(report.promotedCandidateCount).toBe(1);
    expect(report.promotedDraftCount).toBe(1);
    expect(report.needsReviewCandidateCount).toBe(0);
    expect(report.mutationCount).toBe(0);
    expect(draft?.fixtureDraft.fixture.expectedDecisions[0]).toMatchObject({
      metric: 'snapshot_summary',
      snapshotIncludes: 'TODO_REPLACE_THIS_EXPECTATION',
    });
    expect(draft?.warnings.join(' ')).toContain('built-in replay fixture arrays are not modified');
    expect(draftJson).not.toContain('private-roadmap@example.com');
    expect(draftJson).not.toContain('C:\\Users\\secret');
  });

  it('records defer and reject trace promotion decisions with evidence refs', () => {
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest: makeShadowDigest([
        {
          version: 1,
          id: 'digest-trace-promotion-defer',
          kind: 'source_change',
          lane: 'mission_update',
          title: 'Candidate needs review',
          summary: 'The candidate needs expectation review before promotion.',
          nextSafeAction: 'Leave it reviewable.',
          risk: 'low',
          relevance: 0.72,
          createdAt: 5000,
          dedupeKey: 'trace-promotion:defer-reject',
          sourceRefs: ['workspace:validation'],
          evidenceRefs: ['workspace:validation'],
          hidden: false,
        },
      ]),
      now: 6000,
    });
    const labels = appendAoiShadowDecisionLabel([], {
      decisionId: decisions[0]?.id ?? '',
      label: 'missed_context',
      evidenceRefs: ['shadow-review:trace-missed-context'],
      now: 7000,
    });
    const traceExport = makeTracePromotionTraceExport({
      decisionId: decisions[0]?.id ?? '',
      evidenceRefs: ['shadow-review:trace-missed-context'],
    });
    const candidateReport = buildAoiTracePromotionReport({
      sessionPath: 'aoi/default',
      traceExports: [traceExport],
      shadowDecisions: decisions,
      shadowLabels: labels,
      now: 8000,
    });
    const candidate = candidateReport.candidates[0];
    const deferred = createAoiTracePromotionDecision({
      candidate,
      action: 'defer',
      evidenceRefs: ['operator-review:defer-trace'],
      now: 9000,
    });
    const rejected = createAoiTracePromotionDecision({
      candidate,
      action: 'reject',
      reason: 'Duplicate of an existing replay fixture.',
      evidenceRefs: ['operator-review:reject-trace'],
      now: 9500,
    });
    const report = buildAoiTracePromotionReport({
      sessionPath: 'aoi/default',
      traceExports: [traceExport],
      shadowDecisions: decisions,
      shadowLabels: labels,
      promotionDecisions: [deferred, rejected],
      now: 10000,
    });

    expect(report.decisionCount).toBe(2);
    expect(report.deferredCandidateCount).toBe(0);
    expect(report.rejectedCandidateCount).toBe(1);
    expect(report.needsReviewCandidateCount).toBe(0);
    expect(report.fixtureDrafts).toEqual([]);
    expect(report.decisions.map((decision) => decision.action)).toEqual(['defer', 'reject']);
    expect(report.decisions[0]?.evidenceRefs).toContain('operator-review:defer-trace');
    expect(report.decisions[1]?.reason).toContain('Duplicate');
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

  it('builds personal source freshness contracts without treating disconnection as empty inbox', () => {
    const registry = makePersonalRealityRegistry({
      calendarEnabled: true,
      gmailEnabled: true,
      notesEnabled: false,
    });
    const contracts = buildAoiSourceFreshnessContracts({
      sourceRegistry: registry,
      personalMetadata: [
        {
          version: 1,
          sourceId: 'calendar-metadata',
          kind: 'calendar_metadata',
          label: 'Calendar metadata',
          displayName: 'Calendar',
          summary:
            'Calendar metadata: 1 upcoming of 1; Validation deadline at 1970-01-01T02:00:00.000Z (reminder 15m).',
          relevanceText: 'calendar deadline metadata',
          evidenceRefs: ['personal-signal:calendar_metadata', 'calendar-event:deadline'],
          scoreReasons: ['calendar title, time, and reminder metadata only'],
          updatedAt: 5900,
          freshness: 'fresh',
          confidence: 0.78,
          redactionState: 'redacted',
        },
        {
          version: 1,
          sourceId: 'gmail-metadata',
          kind: 'gmail_metadata',
          label: 'Gmail metadata',
          displayName: 'Gmail',
          summary:
            'Gmail metadata: configured=true; connected=false; lastSync=never; cached=0; unread=0; folders=none; labels=none',
          relevanceText: 'gmail inbox unread metadata',
          evidenceRefs: ['personal-signal:gmail_metadata', 'gmail-cache:counts'],
          scoreReasons: ['gmail connection, sync, unread, folder, and label counts only'],
          updatedAt: 5900,
          freshness: 'fresh',
          confidence: 0.72,
          redactionState: 'redacted',
        },
      ],
      now: 6000,
    });
    const gmail = contracts.find((contract) => contract.sourceId === 'gmail-metadata');
    const calendar = contracts.find((contract) => contract.sourceId === 'calendar-metadata');

    expect(gmail?.freshnessState).toBe('disconnected');
    expect(gmail?.cannotKnow.map((item) => item.statement).join(' ')).toContain(
      'not evidence of an empty inbox',
    );
    expect(calendar?.bodyAccessState).toBe('body_disabled');
    expect(calendar?.cannotKnow.map((item) => item.statement).join(' ')).toContain(
      'calendar descriptions',
    );
    expect(JSON.stringify(contracts)).not.toContain('private launch plan body');
  });

  it('keeps stale memory facts out of current-truth source contracts', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 6000);
    const contracts = buildAoiSourceFreshnessContracts({
      sourceRegistry: registry,
      staleAfterMsBySourceId: {
        'manual-note': 60_000,
      },
      memories: [
        {
          version: 2,
          id: 'memory-stale-current-truth',
          scope: 'project',
          type: 'fact',
          status: 'active',
          content: 'The workspace validation currently passes.',
          normalizedContent: 'workspace validation currently passes',
          importance: 0.7,
          confidence: 0.8,
          hits: 1,
          createdAt: 1000,
          updatedAt: 1000,
          sourceEpisodeIds: ['episode-stale-current-truth'],
          tags: ['workspace'],
          entities: ['validation'],
        },
      ],
      now: 200_000,
    });
    const memory = contracts.find((contract) => contract.sourceId === 'manual-note');

    expect(memory?.freshnessState).toBe('stale');
    expect(memory?.cannotKnow.map((item) => item.statement).join(' ')).toContain('current truth');
  });
});

describe('outcome signals feed trust calibration (P1b)', () => {
  const SESSION = 'aoi/default';
  const TRIGGER = feedbackMemoryProposalFixture.trigger;
  const ACTION = feedbackMemoryProposalFixture.acceptAction?.kind;

  function makeLinkedOutcome(partial: {
    id: string;
    direction: AoiOutcomeLearningDirection;
    confidence?: number;
    magnitude?: number;
    outcomeKind?: AoiOutcomeSignalKind;
    sourceProposalId?: string;
    createdAt?: number;
  }): AoiOutcomeSignalRecord {
    const record = normalizeAoiOutcomeSignalRecord(
      {
        id: partial.id,
        sessionPath: SESSION,
        outcomeKind: partial.outcomeKind ?? 'work_order_rejected',
        signalKind: 'passive_outcome',
        sourceProposalId: partial.sourceProposalId ?? feedbackMemoryProposalFixture.id,
        confidence: partial.confidence ?? 0.5,
        inferredAdjustment: {
          version: 1,
          target: 'source',
          direction: partial.direction,
          magnitude: partial.magnitude ?? 1,
          reason: 'test outcome',
        },
        createdAt: partial.createdAt ?? 3000,
      },
      SESSION,
      5000,
    );
    if (!record) {
      throw new Error('failed to build test outcome');
    }
    return record;
  }

  function applyForFixture(
    outcomes: AoiOutcomeSignalRecord[],
    outcomeTrustIncreaseAllowed: boolean,
  ): ReturnType<typeof applyAoiTrustCalibration> {
    const profile = buildAoiTrustCalibrationProfile({
      sessionPath: SESSION,
      proposals: [feedbackMemoryProposalFixture],
      outcomes,
      outcomeTrustIncreaseAllowed,
      now: 5000,
    });
    return applyAoiTrustCalibration({
      profile,
      triggerKind: TRIGGER,
      actionKind: ACTION,
      score: 0.6,
    });
  }

  function makeUnlinkedOutcome(partial: {
    id: string;
    direction: AoiOutcomeLearningDirection;
    evidenceRefs?: string[];
    confidence?: number;
    magnitude?: number;
    outcomeKind?: AoiOutcomeSignalKind;
    createdAt?: number;
  }): AoiOutcomeSignalRecord {
    const record = normalizeAoiOutcomeSignalRecord(
      {
        id: partial.id,
        sessionPath: SESSION,
        outcomeKind: partial.outcomeKind ?? 'user_correction',
        signalKind: 'passive_outcome',
        // No sourceProposalId -> unlinked (chat correction / standalone signal).
        confidence: partial.confidence ?? 0.5,
        inferredAdjustment: {
          version: 1,
          target: 'source',
          direction: partial.direction,
          magnitude: partial.magnitude ?? 1,
          reason: 'test unlinked outcome',
        },
        evidenceRefs: partial.evidenceRefs ?? [],
        createdAt: partial.createdAt ?? 3000,
      },
      SESSION,
      5000,
    );
    if (!record) {
      throw new Error('failed to build test unlinked outcome');
    }
    return record;
  }

  function applyForSourceKind(
    outcomes: AoiOutcomeSignalRecord[],
    sourceKind: string,
  ): ReturnType<typeof applyAoiTrustCalibration> {
    const profile = buildAoiTrustCalibrationProfile({
      sessionPath: SESSION,
      proposals: [feedbackMemoryProposalFixture],
      outcomes,
      outcomeTrustIncreaseAllowed: true,
      now: 5000,
    });
    return applyAoiTrustCalibration({
      profile,
      triggerKind: TRIGGER,
      actionKind: ACTION,
      sourceKind,
      score: 0.6,
    });
  }

  it('does not boost trust from an outcome-only signal (gate closed)', () => {
    const applied = applyForFixture(
      [
        makeLinkedOutcome({
          id: 'o-boost-gated',
          direction: 'boost',
          outcomeKind: 'work_order_approved',
        }),
      ],
      false,
    );
    expect(applied.rankingAdjustment).toBe(0);
  });

  it('boosts trust when the outcome trust gate is open', () => {
    const applied = applyForFixture(
      [
        makeLinkedOutcome({
          id: 'o-boost',
          direction: 'boost',
          outcomeKind: 'work_order_approved',
        }),
      ],
      true,
    );
    expect(applied.rankingAdjustment).toBeGreaterThan(0);
  });

  it('suppresses a linked proposal kind regardless of the trust gate', () => {
    const applied = applyForFixture(
      [makeLinkedOutcome({ id: 'o-suppress', direction: 'suppress' })],
      false,
    );
    expect(applied.rankingAdjustment).toBeLessThan(0);
  });

  it('raises approval strictness for a risk_up outcome', () => {
    const applied = applyForFixture(
      [makeLinkedOutcome({ id: 'o-risk', direction: 'risk_up', outcomeKind: 'user_correction' })],
      false,
    );
    expect(applied.approvalStrictnessBoost).toBeGreaterThan(0);
  });

  it('leaves calibration unchanged when no outcomes are supplied', () => {
    const applied = applyForFixture([], true);
    expect(applied.rankingAdjustment).toBe(0);
    expect(applied.approvalStrictnessBoost).toBe(0);
  });

  it('ignores an outcome whose linked proposal cannot be resolved', () => {
    const applied = applyForFixture(
      [
        makeLinkedOutcome({
          id: 'o-unlinked',
          direction: 'suppress',
          sourceProposalId: 'no-such-proposal',
        }),
      ],
      false,
    );
    expect(applied.rankingAdjustment).toBe(0);
  });

  it('penalizes the source of an unlinked suppress outcome (chat-only calibration)', () => {
    const applied = applyForSourceKind(
      [
        makeUnlinkedOutcome({
          id: 'u-suppress',
          direction: 'suppress',
          evidenceRefs: ['research:run-1'],
        }),
      ],
      'research_runs',
    );
    expect(applied.sourceSelectionPenalty).toBeGreaterThan(0);
  });

  it('de-prioritizes the source of an unlinked risk_up outcome', () => {
    const applied = applyForSourceKind(
      [
        makeUnlinkedOutcome({
          id: 'u-risk',
          direction: 'risk_up',
          evidenceRefs: ['workspace:build-1'],
        }),
      ],
      'workspace_build',
    );
    expect(applied.sourceSelectionPenalty).toBeGreaterThan(0);
  });

  it('never boosts trust from an unlinked outcome, even with the gate open', () => {
    const applied = applyForSourceKind(
      [
        makeUnlinkedOutcome({
          id: 'u-boost',
          direction: 'boost',
          outcomeKind: 'work_order_approved',
          evidenceRefs: ['research:run-1'],
        }),
      ],
      'research_runs',
    );
    expect(applied.rankingAdjustment).toBe(0);
    expect(applied.sourceSelectionPenalty).toBe(0);
  });

  it('ignores an unlinked outcome with no attributable source', () => {
    const applied = applyForSourceKind(
      [makeUnlinkedOutcome({ id: 'u-nosrc', direction: 'suppress', evidenceRefs: ['chat:msg-1'] })],
      'research_runs',
    );
    expect(applied.sourceSelectionPenalty).toBe(0);
  });

  it('widens the positive cap toward the ceiling under strong consistent boosts but never past it', () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      makeLinkedOutcome({
        id: `o-many-${index}`,
        direction: 'boost',
        outcomeKind: 'work_order_approved',
        createdAt: 3000 + index,
      }),
    );
    const applied = applyForFixture(many, true);
    // Adaptive cap: strong, consistent positive field evidence raises the cap
    // above the 0.12 base toward the 0.2 hard ceiling -- but never beyond it.
    expect(applied.rankingAdjustment).toBeGreaterThan(0.12);
    expect(applied.rankingAdjustment).toBeLessThanOrEqual(0.2);
  });

  function profileWithOutcomes(outcomes: AoiOutcomeSignalRecord[]) {
    return buildAoiTrustCalibrationProfile({
      sessionPath: SESSION,
      proposals: [feedbackMemoryProposalFixture],
      outcomes,
      outcomeTrustIncreaseAllowed: true,
      now: 5000,
    });
  }

  it('keeps the learning caps at the conservative base when field evidence is sparse', () => {
    const profile = profileWithOutcomes([
      makeLinkedOutcome({ id: 'o-one', direction: 'boost', outcomeKind: 'work_order_approved' }),
    ]);
    expect(profile.interruptionPolicy.positiveLearningCap).toBe(0.12);
    expect(profile.interruptionPolicy.negativeLearningCap).toBe(-0.42);
  });

  it('widens the positive learning cap under strong consistent positive evidence', () => {
    const profile = profileWithOutcomes(
      Array.from({ length: 16 }, (_, index) =>
        makeLinkedOutcome({
          id: `p-${index}`,
          direction: 'boost',
          outcomeKind: 'work_order_approved',
          createdAt: 3000 + index,
        }),
      ),
    );
    expect(profile.interruptionPolicy.positiveLearningCap).toBeGreaterThan(0.12);
    expect(profile.interruptionPolicy.positiveLearningCap).toBeLessThanOrEqual(0.2);
  });

  it('does not widen the positive cap when negative evidence balances it (consistency gate)', () => {
    const profile = profileWithOutcomes([
      ...Array.from({ length: 16 }, (_, index) =>
        makeLinkedOutcome({
          id: `mp-${index}`,
          direction: 'boost',
          outcomeKind: 'work_order_approved',
          createdAt: 3000 + index,
        }),
      ),
      ...Array.from({ length: 16 }, (_, index) =>
        makeLinkedOutcome({ id: `mn-${index}`, direction: 'suppress', createdAt: 3200 + index }),
      ),
    ]);
    expect(profile.interruptionPolicy.positiveLearningCap).toBe(0.12);
  });

  it('deepens the negative floor under strong negative evidence', () => {
    const profile = profileWithOutcomes(
      Array.from({ length: 16 }, (_, index) =>
        makeLinkedOutcome({ id: `n-${index}`, direction: 'suppress', createdAt: 3000 + index }),
      ),
    );
    expect(profile.interruptionPolicy.negativeLearningCap).toBeLessThan(-0.42);
    expect(profile.interruptionPolicy.negativeLearningCap).toBeGreaterThanOrEqual(-0.5);
  });
});

function makeTracePromotionTraceExport(params: {
  decisionId: string;
  id?: string;
  sourceRef?: string;
  relatedRefs?: string[];
  evidenceRefs?: string[];
  summary?: string;
  redactionTotal?: number;
  syntheticLabels?: Record<string, string>;
  metadata?: Record<string, string | number | boolean | string[]>;
}): AoiOperatorTraceExport {
  const syntheticLabels = params.syntheticLabels ?? {
    '[email:1]': '[email:1]',
  };
  return {
    version: 1,
    id: params.id ?? 'aoi-trace-promotion-test',
    sessionPath: 'aoi/default',
    exportedAt: 8000,
    eventCount: 2,
    sourceEventIds: ['timeline-trace-promotion-source', 'timeline-trace-promotion-digest'],
    events: [
      {
        version: 1,
        id: 'timeline-trace-promotion-source',
        sessionPath: 'aoi/default',
        kind: 'source_selected',
        visibility: 'dashboard_only',
        createdAt: 6000,
        title: 'Workspace source selected',
        summary:
          params.summary ??
          'Workspace source selected for a redacted acceptance trace involving [email:1].',
        redactionState: (params.redactionTotal ?? 1) > 0 ? 'synthetic' : 'none',
        sourceRef: params.sourceRef ?? 'context-source:workspace',
        sourceKind: 'workspace_git',
        evidenceRefs: [
          `shadow-decision:${params.decisionId}`,
          ...(params.evidenceRefs ?? ['workspace:validation']),
        ],
        relatedRefs: params.relatedRefs ?? ['environment-source:workspace-git'],
        metadata: params.metadata,
      },
      {
        version: 1,
        id: 'timeline-trace-promotion-digest',
        sessionPath: 'aoi/default',
        kind: 'digest_item_surfaced',
        visibility: 'operator_visible',
        createdAt: 6500,
        title: 'Digest item surfaced',
        summary: 'A redacted digest item was reviewable after shadow labeling.',
        redactionState: 'redacted',
        digestItemId: 'digest-trace-promotion',
        sourceRef: 'digest:trace-promotion',
        evidenceRefs: [`shadow-decision:${params.decisionId}`, 'digest:trace-promotion'],
        relatedRefs: [`shadow-decision:${params.decisionId}`],
      },
    ],
    redactionSummary: {
      totalReplacementCount: params.redactionTotal ?? 1,
      localPathCount: 0,
      urlCount: 0,
      emailCount: params.redactionTotal ?? 1,
      privateFieldCount: 0,
      syntheticLabels,
    },
    privacyNotes: ['Synthetic labels are retained for trace promotion review.'],
  };
}

function makeJarvisReadinessShadowReport(
  metrics: Partial<AoiShadowDecisionMetrics> = {},
): AoiShadowDecisionReport {
  const mergedMetrics: AoiShadowDecisionMetrics = {
    totalDecisions: 5,
    labeledDecisionCount: 5,
    usefulRate: 0.8,
    tooMuchRate: 0,
    wrongSourceRate: 0,
    unsafeShadowDecisionCount: 0,
    shouldHaveSpokenCount: 0,
    silentDecisionExplainabilityCoverage: 1,
    mutationCount: 0,
    zeroMutation: true,
    ...metrics,
  };
  return {
    version: 1,
    sessionPath: 'aoi/default',
    generatedAt: 7000,
    metrics: mergedMetrics,
    decisions: [],
    labels: [],
    safetyReviewDecisionIds: [],
    evidenceRefs: ['shadow-readiness:fixture'],
  };
}

function makeJarvisPrivacyLeakReport(): AoiJarvisAcceptanceReport {
  const base = runAoiJarvisAcceptanceTrial({ now: 7000 });
  const firstMetric = base.metrics[0];
  if (!firstMetric) {
    throw new Error('Expected at least one JARVIS acceptance metric.');
  }
  const failedMetric = {
    ...firstMetric,
    id: 'privacy.private_leak.synthetic',
    passed: false,
    dimension: 'replayability_privacy' as const,
    actualSummary: 'Private leak reached the acceptance output.',
    evidenceRefs: ['jarvis:privacy-leak'],
    privacyState: 'redacted' as const,
    mutationCount: 0,
  };
  return {
    ...base,
    passed: false,
    metricCount: base.metricCount + 1,
    passedMetricCount: base.passedMetricCount,
    failedMetricCount: 1,
    metrics: [...base.metrics, failedMetric],
    failedMetrics: [failedMetric],
    evidenceRefs: [...base.evidenceRefs, 'jarvis:privacy-leak'],
  };
}

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

function withRealitySourcePatch(
  registry: AoiEnvironmentSourceRegistry,
  sourceId: string,
  patch: Partial<AoiEnvironmentSourceRegistry['sources'][number]>,
): AoiEnvironmentSourceRegistry {
  return {
    ...registry,
    sources: registry.sources.map((source) =>
      source.id === sourceId
        ? {
            ...source,
            ...patch,
          }
        : source,
    ),
  };
}

function makePersonalRealityRegistry(
  options: {
    calendarEnabled?: boolean;
    gmailEnabled?: boolean;
    notesEnabled?: boolean;
    notesRevoked?: boolean;
  } = {},
): AoiEnvironmentSourceRegistry {
  let registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 6000);
  registry = withRealitySourcePatch(registry, 'calendar-metadata', {
    enabled: options.calendarEnabled ?? true,
    lastObservedAt: 5500,
    lastReviewedAt: 5400,
    consentReason: 'Use calendar title/time/reminder metadata only; body disabled.',
  });
  registry = withRealitySourcePatch(registry, 'gmail-metadata', {
    enabled: options.gmailEnabled ?? true,
    lastObservedAt: 5500,
    lastReviewedAt: 5400,
    consentReason: 'Use Gmail counts and thread metadata only when connected.',
  });
  registry = withRealitySourcePatch(registry, 'notes-metadata', {
    enabled: options.notesEnabled ?? false,
    lastObservedAt: 5500,
    lastReviewedAt: 5400,
    consentReason:
      (options.notesRevoked ?? true)
        ? 'revoked by operator; do not use notes metadata.'
        : 'Use note count, title, tag, and pinned metadata only.',
  });
  return registry;
}

function makePersonalRealityWorkspaceSnapshot(
  partial: Partial<AoiWorkspaceSnapshot> = {},
): AoiWorkspaceSnapshot {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    collectedAt: 6000,
    workspaceLabel: 'YourOpenRoom',
    sourceIds: ['workspace-git', 'workspace-build'],
    git: {
      version: 1,
      branchName: 'main',
      branchChanged: false,
      isDirty: true,
      changedFileCount: 1,
      stagedFileCount: 0,
      unstagedFileCount: 1,
      untrackedFileCount: 0,
      statusSummary: 'dirty: 1 changed',
      changedFiles: [
        {
          version: 1,
          pathLabel: 'apps/webuiapps/src/lib/aoiPersonalSourceRealityCheck.ts',
          pathHash: 'personal-reality-check',
          status: 'M',
          staged: false,
          unstaged: true,
          untracked: false,
          changedAt: 6000,
          directoryLabel: 'apps/webuiapps/src/lib',
          extension: 'ts',
        },
      ],
    },
    validation: {
      version: 1,
      command: 'pnpm --filter @openroom/webuiapps test',
      result: 'passed',
      completedAt: 1000,
      touchedFileScopes: ['apps/webuiapps/src/lib'],
      freshness: 'stale',
      staleReason: 'Source files changed after the last passed validation.',
      evidenceRefs: ['workspace:validation:stale'],
    },
    freshness: 'stale',
    evidenceRefs: ['workspace:snapshot:personal-reality', 'workspace:validation:stale'],
    warnings: [],
    ...partial,
  };
}

function makePersonalRealityHealth(
  registry: AoiEnvironmentSourceRegistry,
  workspaceSnapshot: AoiWorkspaceSnapshot,
): AoiOperatorHealthState {
  return {
    version: 1,
    sessionPath: registry.sessionPath,
    generatedAt: 6000,
    overallStatus: 'limited',
    summary: 'Synthetic personal source health state.',
    capabilities: [],
    issues: [
      {
        version: 1,
        id: 'health-gmail-disconnected-personal-reality',
        capability: 'personal_signals',
        severity: 'error',
        code: 'gmail_disconnected',
        title: 'Gmail metadata disconnected',
        summary: 'Gmail metadata is disconnected and cannot be inspected.',
        cannotKnow: 'Gmail metadata is disconnected; this is not evidence of an empty inbox.',
        sourceId: 'gmail-metadata',
        observedAt: 6000,
        evidenceRefs: ['environment-source:gmail-metadata', ...workspaceSnapshot.evidenceRefs],
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

function makePersonalRealityMetadata(
  partial: Pick<AoiPersonalSignalMetadataSummary, 'sourceId' | 'kind' | 'summary'> &
    Partial<AoiPersonalSignalMetadataSummary>,
): AoiPersonalSignalMetadataSummary {
  return {
    version: 1,
    label: partial.label ?? partial.sourceId,
    displayName: partial.displayName ?? partial.sourceId,
    relevanceText: partial.relevanceText ?? 'Synthetic metadata-only personal signal.',
    evidenceRefs: partial.evidenceRefs ?? [`personal-signal:${partial.kind}`],
    scoreReasons: partial.scoreReasons ?? ['Metadata fields only.'],
    updatedAt: partial.updatedAt ?? 5500,
    freshness: partial.freshness ?? 'fresh',
    confidence: partial.confidence ?? 0.72,
    redactionState: partial.redactionState ?? 'redacted',
    ...partial,
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

function makeReadinessFieldFeedback(labels: readonly AoiShadowDecisionLabel[]): {
  fieldReport: ReturnType<typeof buildAoiFieldShadowRecordReport>;
  labeledInbox: ReturnType<typeof buildAoiOperatorFeedbackInbox>;
} {
  const digest = makeShadowDigest(
    labels.map((label, index) => ({
      version: 1,
      id: `digest-readiness-field-${label}-${index}`,
      kind: 'mission_status',
      lane: 'mission_update',
      title: `Readiness field signal ${index + 1}`,
      summary: 'Workspace validation field evidence is ready for operator feedback.',
      nextSafeAction: 'Keep visibility gated until field labels are reviewed.',
      risk: 'low',
      relevance: 0.8,
      createdAt: 6000 + index,
      dedupeKey: `readiness:field-label:${index}`,
      sourceRefs: ['workspace:validation'],
      evidenceRefs: [`field-session:readiness-label:${index}`],
      hidden: false,
    })),
  );
  const decisions = recordAoiShadowDecisions({
    sessionPath: 'aoi/default',
    digest,
    now: 6100,
  });
  const fieldReport = buildAoiFieldShadowRecordReport({
    sessionPath: 'aoi/default',
    decisions,
    evidenceRefs: ['field-session:readiness-labels'],
    now: 6200,
  });
  const inbox = buildAoiOperatorFeedbackInbox({
    sessionPath: 'aoi/default',
    fieldShadowReport: fieldReport,
    now: 6300,
  });
  const labelActions = labels.map((label, index) => {
    const item = inbox.items[index];
    if (!item) {
      throw new Error(`Expected readiness feedback item ${index}.`);
    }
    return createAoiOperatorFeedbackLabelActionForItem({
      item,
      label,
      evidenceRefs: [`operator-label:readiness:${label}:${index}`],
      now: 6400 + index,
    });
  });
  const labeledInbox = buildAoiOperatorFeedbackInbox({
    sessionPath: 'aoi/default',
    fieldShadowReport: fieldReport,
    labelActions,
    now: 6500,
  });
  return { fieldReport, labeledInbox };
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
