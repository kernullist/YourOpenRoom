import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import {
  fetchAoiAutonomyDashboard,
  fetchAoiFieldFeedback,
  fetchAoiOutcomeLearning,
  fetchAoiOperatorHealth,
  fetchAoiPlaybooks,
  fetchAoiProactiveBriefs,
  prepareAoiPlaybookPreview,
  recordAoiFieldFeedback,
  recordAoiOutcomeSignal,
  recordAoiProactiveBriefFeedback,
  resetAoiProactiveBriefCooldown,
  runAoiAutonomyManualTick,
  runAoiAutonomyManualWakeup,
  runAoiProactiveBriefScoutNow,
  updateAoiPlaybookProgress,
  updateAoiEnvironmentSource,
} from '../aoiAutonomyClient';
import { buildAoiTrustCalibrationProfile } from '../aoiTrustCalibration';
import type { AoiAutonomyEvaluationResult } from '../aoiAutonomyEvaluation';
import type { AoiAutonomyStatus, AoiOperatorHealthState, AoiPlaybook } from '../aoiAutonomyTypes';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function makeStatus(): AoiAutonomyStatus {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    policy: {
      ...DEFAULT_AOI_AUTONOMY_POLICY,
      enabled: true,
      level: 'L3',
      updatedAt: 1000,
    },
    activeProposalCount: 1,
    archivedProposalCount: 0,
    acceptedProposalCount: 0,
    snoozedProposalCount: 0,
    blockedProposalCount: 0,
    observationCount: 3,
    reflectionCount: 1,
    decisionCount: 2,
    lastTickAt: 1000,
    nextAllowedTickAt: 2000,
    lastTickReason: 'manual',
    activeTick: false,
    recentObservationCount: 1,
    proposalsCreatedInLastTick: 1,
    activeGoalCount: 1,
    currentGoalTitle: 'Finish Aoi dashboard',
    nextGoalStepTitle: 'Review blocked gates',
    updatedAt: 1000,
  };
}

function makeEvaluation(): AoiAutonomyEvaluationResult {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    generatedAt: 1000,
    metrics: {
      totalProposals: 1,
      totalDecisions: 2,
      proposalAcceptanceRate: 0.5,
      proposalDismissRate: 0.25,
      dismissRateByCategory: [],
      duplicateCooldownViolationCount: 0,
      evidenceCoverage: 1,
      staleMemoryReuseCount: 0,
      blockedHighRiskProposalCount: 0,
      acceptedExecutionSuccessRate: 1,
      goalContinuationUsefulness: null,
      preferenceDemotionCandidateCount: 0,
      oneOffPreferenceFeedbackCount: 0,
    },
    calibration: {
      noisyProposalTypes: [],
      wrongMemoryRefs: [],
      blockedActionKinds: [],
      staleMemoryRefs: [],
      preferenceDemotionRefs: [],
      highRiskProposalCount: 0,
      highRiskProposalRate: 0,
      highRiskBlockedCount: 0,
    },
    trustCalibration: buildAoiTrustCalibrationProfile({
      sessionPath: 'aoi/default',
      now: 1000,
    }),
  };
}

function makeFlightRecorderPayload() {
  return {
    ok: true,
    sessionPath: 'aoi/default',
    records: [],
    replayDrafts: [],
    summary: {
      version: 1,
      sessionPath: 'aoi/default',
      generatedAt: 1000,
      totalRecordCount: 0,
      laneCounts: {
        hidden: 0,
        dashboard: 0,
        digest: 0,
        direct_chat: 0,
        approval_request: 0,
        blocked: 0,
      },
      hardFailCounters: {
        privateLeakCount: 0,
        unauthorizedMutationCount: 0,
        staleCurrentClaimCount: 0,
        approvalBypassCount: 0,
      },
      latestBlindSpotLabels: [],
      latestSourceFreshnessGapLabels: [],
      recentRecords: [],
      evidenceRefs: [],
      replayDraftCount: 0,
      mutationCount: 0,
      actionAuthority: 'display_only',
    },
  };
}

function makeHealth(): AoiOperatorHealthState {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    generatedAt: 1000,
    overallStatus: 'limited',
    summary: 'Aoi health is limited: Tavily missing for research.',
    capabilities: [],
    issues: [
      {
        version: 1,
        id: 'aoi-health-tavily-missing-client-test',
        capability: 'research',
        severity: 'warning',
        code: 'tavily_missing',
        title: 'Tavily missing for research',
        summary: 'Research is not configured.',
        cannotKnow: 'Aoi cannot know fresh web evidence because Tavily is not configured.',
        observedAt: 1000,
        evidenceRefs: ['config:tavily'],
        recommendation: {
          version: 1,
          action: 'configure_tavily',
          label: 'Configure Tavily',
          targetPanel: 'research',
        },
      },
    ],
    userBlockingIssueCount: 0,
    evidenceRefs: ['config:tavily'],
  };
}

function makePlaybook(): AoiPlaybook {
  return {
    version: 1,
    id: 'aoi-playbook-client-test',
    sessionPath: 'aoi/default',
    title: 'Coordinate validation',
    objective: 'Preview validation and ask for the next decision.',
    status: 'preview',
    createdAt: 1000,
    updatedAt: 1000,
    sourceRefs: ['proposal:aoi-proposal-client-test'],
    evidenceRefs: ['proposal:aoi-proposal-client-test'],
    proposalId: 'aoi-proposal-client-test',
    healthIssueRefs: [],
    blockedReasons: [],
    nextStepId: 'aoi-playbook-client-test-step-01',
    nextRequiredDecision: 'Review the context step.',
    steps: [
      {
        version: 1,
        id: 'aoi-playbook-client-test-step-01',
        kind: 'inspect_context',
        title: 'Inspect context',
        summary: 'Review current evidence.',
        status: 'ready',
        dependsOn: [],
        evidenceRefs: ['proposal:aoi-proposal-client-test'],
        sourceRefs: ['proposal:aoi-proposal-client-test'],
        blockedReasons: [],
        executionBoundary: {
          version: 1,
          mutationCapable: false,
          commandCapable: false,
          requiresApproval: false,
          requiredAutonomyLevel: 'L2',
          freshAcceptanceRequired: false,
          approver: 'none',
          existingGate: 'none',
          canAutoRun: false,
          summary: 'Read-only context inspection.',
        },
        checkpointNotes: [],
        rollbackNotes: [],
        validationNotes: [],
        refs: { proposalRef: 'proposal:aoi-proposal-client-test' },
        updatedAt: 1000,
      },
    ],
    edges: [],
  };
}

function makeProactiveBriefPayload() {
  const profile = {
    version: 1,
    sessionPath: 'aoi/default',
    topics: [],
    generatedAt: 1000,
    sourceMemoryCount: 0,
    warnings: [],
  };
  const cooldownState = {
    version: 1,
    sessionPath: 'aoi/default',
    updatedAt: 1000,
    cooldowns: {},
  };
  const candidate = {
    version: 1,
    id: 'aoi-brief-client-test',
    sessionPath: 'aoi/default',
    topicId: 'aoi-interest-re',
    topicLabel: 'Reverse Engineering',
    status: 'candidate',
    title: 'Fresh reversing writeup',
    hook: 'A fresh reversing writeup matches your saved interests.',
    summary: 'Short source-backed summary.',
    whyForOperator: 'Matches reverse engineering interests.',
    noveltyReason: 'New source for a saved topic.',
    sources: [
      {
        title: 'Fresh reversing writeup',
        url: 'https://research.example.com/re/writeup',
        host: 'research.example.com',
        retrievedAt: 1000,
        snippet: 'Public source snippet.',
      },
    ],
    evidenceRefs: ['source:research.example.com'],
    memoryIds: ['memory-re-001'],
    score: 0.8,
    confidence: 0.82,
    risk: 'low',
    freshness: {
      searchedAt: 1000,
      cannotKnow: ['Aoi cannot know whether the source changed after retrieval.'],
    },
    delivery: {
      allowedModes: ['dashboard', 'digest', 'inline_card'],
    },
    cooldownKey: 'interest:reverse-engineering',
    createdAt: 1000,
    updatedAt: 1000,
    expiresAt: 2000,
  };
  return {
    ok: true,
    sessionPath: 'aoi/default',
    candidates: [candidate],
    feedback: [],
    profile,
    cooldownState,
    panel: {
      visible: true,
      statusLabel: '1 proactive interest brief',
      hiddenLabel: '',
      cards: [],
      evidenceRefs: ['source:research.example.com'],
    },
  };
}

function makeFieldFeedbackPayload() {
  const fieldShadowReport = {
    version: 1,
    id: 'aoi-field-shadow-report-client-test',
    sessionPath: 'aoi/default',
    generatedAt: 1000,
    session: {
      version: 1,
      id: 'aoi-field-shadow-session-client-test',
      sessionPath: 'aoi/default',
      startedAt: 1000,
      updatedAt: 1000,
      decisionCount: 0,
      activeDecisionCount: 0,
      expiredDecisionCount: 0,
      evidenceRefs: [],
      mutationCount: 0,
      expiresAt: 2000,
    },
    records: [],
    activeRecords: [],
    expiredRecords: [],
    totalRecordCount: 0,
    activeRecordCount: 0,
    expiredRecordCount: 0,
    dedupedRecordCount: 0,
    mutationCount: 0,
    zeroMutation: true,
    privacyCounts: {
      redacted: 0,
      metadata_only: 0,
      synthetic: 0,
      unknown: 0,
    },
    decisionKindCounts: {
      would_speak: 0,
      would_stay_quiet: 0,
      would_show_dashboard: 0,
      would_prepare_research: 0,
      would_prepare_work_order: 0,
      would_propose: 0,
      would_prepare_approval: 0,
      would_mark_blind_spot: 0,
    },
    subsystemOriginCounts: {
      digest: 0,
      health: 0,
      source_consent: 0,
      personal_source_reality: 0,
      playbook: 0,
      approved_command_policy: 0,
      interruption_governor: 0,
      action_ladder: 0,
      mission_memory: 0,
      voice_policy: 0,
      unknown: 0,
    },
    sourceKindCounts: {},
    evidenceRefs: [],
  };
  return {
    ok: true,
    sessionPath: 'aoi/default',
    fieldShadowReport,
    labelActions: [],
    feedbackInbox: {
      version: 1,
      id: 'aoi-feedback-inbox-client-test',
      sessionPath: 'aoi/default',
      generatedAt: 1000,
      inboxCount: 0,
      unlabeledCount: 0,
      labeledCount: 0,
      unsafeLabelCount: 0,
      calibrationInputCount: 0,
      promotionCandidateCount: 0,
      labelDistribution: {
        useful: 0,
        too_much: 0,
        too_frequent: 0,
        wrong_source: 0,
        wrong_timing: 0,
        unsafe: 0,
        missed_context: 0,
        should_have_spoken: 0,
        show_more: 0,
        show_less: 0,
        mute_topic: 0,
        pin_topic: 0,
      },
      topSourceKindsNeedingReview: [],
      items: [],
      evidenceRefs: [],
      actionAuthority: 'label_only',
      mutationCount: 0,
    },
  };
}

function makeOutcomeLearningPayload() {
  const outcome = {
    version: 1,
    id: 'aoi-outcome-client-test',
    sessionPath: 'aoi/default',
    eventId: 'proposal:aoi-proposal-client-test',
    sourceProposalId: 'aoi-proposal-client-test',
    outcomeKind: 'proposal_opened',
    signalKind: 'passive_outcome',
    confidence: 0.24,
    inferredAdjustment: {
      version: 1,
      target: 'topic',
      direction: 'boost',
      magnitude: 0.12,
      reason: 'Proposal was opened by the operator.',
    },
    topicKey: 'topic:reverse-engineering',
    sourceKey: 'browser_context',
    deliveryMode: 'dashboard',
    result: 'positive',
    evidenceRefs: ['proposal:aoi-proposal-client-test'],
    privacyState: 'metadata_only',
    createdAt: 2000,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
  return {
    ok: true,
    sessionPath: 'aoi/default',
    outcomes: [outcome],
    summary: {
      version: 1,
      sessionPath: 'aoi/default',
      generatedAt: 2000,
      outcomeCount: 1,
      explicitLabelLinkedCount: 0,
      explicitCorrectionCount: 0,
      passiveOutcomeCount: 1,
      outcomeOnly: true,
      trustIncreaseAllowed: false,
      trustIncreaseBlockedReasons: [
        'outcome-only signals cannot increase trust without explicit labels or field readiness',
      ],
      kindConfidenceLabels: ['proposal_opened: confidence 0.24 (passive_outcome)'],
      learningEffectLabels: ['proposal_opened: topic boost x0.12'],
      previousSuggestionOutcomeLabels: [
        'proposal aoi-proposal-client-test -> proposal_opened (positive, confidence 0.24)',
      ],
      evidenceRefs: ['outcome-learning:v1', 'outcome:aoi-outcome-client-test'],
      actionAuthority: 'display_only',
      mutationCount: 0,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Aoi autonomy client dashboard', () => {
  it('fetches status, proposals, goals, and evaluation for the compact dashboard', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith('/api/aoi-autonomy/status?')) {
        return jsonResponse({ status: makeStatus() });
      }
      if (url.startsWith('/api/aoi-autonomy/proposals?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          active: [{ id: 'aoi-proposal-client-test' }],
          archived: [],
        });
      }
      if (url.startsWith('/api/aoi-autonomy/goals?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          active: [{ id: 'aoi-goal-client-test' }],
          archived: [],
          progress: [],
        });
      }
      if (url.startsWith('/api/aoi-autonomy/mission?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          mission: null,
        });
      }
      if (url.startsWith('/api/aoi-autonomy/sources?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          registry: {
            version: 1,
            sessionPath: 'aoi/default',
            updatedAt: 1000,
            sources: [],
          },
        });
      }
      if (url.startsWith('/api/aoi-autonomy/workspace?')) {
        return jsonResponse({
          ok: true,
          sessionPath: 'aoi/default',
          snapshot: null,
        });
      }
      if (url.startsWith('/api/aoi-autonomy/context?')) {
        return jsonResponse({
          ok: true,
          sessionPath: 'aoi/default',
          context: null,
        });
      }
      if (url.startsWith('/api/aoi-autonomy/evaluation?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          evaluation: makeEvaluation(),
        });
      }
      if (url.startsWith('/api/aoi-autonomy/timeline?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          events: [],
          summary: {
            version: 1,
            sessionPath: 'aoi/default',
            newestMeaningfulEvents: [],
            lastExportRedactionCount: 0,
            totalEventCount: 0,
            exportedTraceCount: 0,
          },
        });
      }
      if (url.startsWith('/api/aoi-autonomy/flight-recorder?')) {
        return jsonResponse(makeFlightRecorderPayload());
      }
      if (url.startsWith('/api/aoi-autonomy/scheduler?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          state: {
            version: 1,
            sessionPath: 'aoi/default',
            updatedAt: 1000,
            wakeupCount: 0,
            sourceSchedules: [],
            recentWakeups: [],
          },
        });
      }
      if (url.startsWith('/api/aoi-autonomy/health?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          health: makeHealth(),
        });
      }
      if (url.startsWith('/api/aoi-autonomy/playbooks?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          active: [makePlaybook()],
          archived: [],
        });
      }
      if (url.startsWith('/api/aoi-autonomy/opportunities?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          active: [],
          archived: [],
        });
      }
      if (url.startsWith('/api/aoi-autonomy/deliberations?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          latest: null,
          runs: [],
        });
      }
      if (url.startsWith('/api/aoi-autonomy/proactive-briefs?')) {
        return jsonResponse(makeProactiveBriefPayload());
      }
      if (url.startsWith('/api/aoi-autonomy/field-feedback?')) {
        return jsonResponse(makeFieldFeedbackPayload());
      }
      if (url.startsWith('/api/aoi-autonomy/outcomes?')) {
        return jsonResponse(makeOutcomeLearningPayload());
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await fetchAoiAutonomyDashboard('aoi/default');
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));

    expect(snapshot.status.policy.level).toBe('L3');
    expect(snapshot.proposals.active).toHaveLength(1);
    expect(snapshot.goals.active).toHaveLength(1);
    expect(snapshot.evaluation.metrics.evidenceCoverage).toBe(1);
    expect(snapshot.timeline.totalEventCount).toBe(0);
    expect(snapshot.flightRecorder.summary.totalRecordCount).toBe(0);
    expect(snapshot.scheduler.wakeupCount).toBe(0);
    expect(snapshot.health.overallStatus).toBe('limited');
    expect(snapshot.playbooks.active).toHaveLength(1);
    expect(snapshot.proactiveBriefs.candidates).toHaveLength(1);
    expect(snapshot.fieldFeedback.feedbackInbox.inboxCount).toBe(0);
    expect(snapshot.outcomeLearning.summary.trustIncreaseAllowed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(18);
    expect(calledUrls).toEqual(
      expect.arrayContaining([
        '/api/aoi-autonomy/status?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/proposals?sessionPath=aoi%2Fdefault&includeArchived=true',
        '/api/aoi-autonomy/goals?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/mission?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/sources?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/workspace?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/context?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/evaluation?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/timeline?sessionPath=aoi%2Fdefault&limit=20',
        '/api/aoi-autonomy/flight-recorder?sessionPath=aoi%2Fdefault&limit=20',
        '/api/aoi-autonomy/scheduler?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/health?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/playbooks?sessionPath=aoi%2Fdefault&includeArchived=true',
        '/api/aoi-autonomy/opportunities?sessionPath=aoi%2Fdefault&includeArchived=true',
        '/api/aoi-autonomy/deliberations?sessionPath=aoi%2Fdefault&limit=20',
        '/api/aoi-autonomy/proactive-briefs?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/field-feedback?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/outcomes?sessionPath=aoi%2Fdefault',
      ]),
    );
  });

  it('fetches and records proactive brief feedback', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/aoi-autonomy/proactive-briefs?')) {
        return jsonResponse(makeProactiveBriefPayload());
      }
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (url === '/api/aoi-autonomy/proactive-briefs/feedback') {
        const payload = makeProactiveBriefPayload();
        return jsonResponse({
          ...payload,
          feedbackRecord: {
            version: 1,
            id: 'aoi-brief-feedback-client-test',
            briefId: 'aoi-brief-client-test',
            topicId: 'aoi-interest-re',
            sessionPath: 'aoi/default',
            category: 'show_less',
            createdAt: 2000,
          },
          candidate: payload.candidates[0],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const list = await fetchAoiProactiveBriefs('aoi/default');
    const feedback = await recordAoiProactiveBriefFeedback('aoi/default', {
      briefId: 'aoi-brief-client-test',
      category: 'show_less',
    });

    expect(list.candidates[0].id).toBe('aoi-brief-client-test');
    expect(feedback.feedbackRecord.category).toBe('show_less');
    expect(requestBodies).toEqual([
      {
        sessionPath: 'aoi/default',
        briefId: 'aoi-brief-client-test',
        category: 'show_less',
      },
    ]);
  });

  it('fetches and records field feedback with label metadata', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/aoi-autonomy/field-feedback?')) {
        return jsonResponse(makeFieldFeedbackPayload());
      }
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (url === '/api/aoi-autonomy/field-feedback') {
        return jsonResponse({
          ...makeFieldFeedbackPayload(),
          labelAction: {
            version: 1,
            id: 'aoi-feedback-label-client-test',
            sessionPath: 'aoi/default',
            decisionRecordId: 'field-shadow-record-client-test',
            decisionId: 'field-shadow-decision-client-test',
            fieldEventId: 'field-event-client-test',
            opportunityId: 'opportunity-client-test',
            topicKey: 'topic:reverse-engineering',
            sourceKey: 'browser_context',
            deliveryMode: 'direct_chat',
            label: 'too_frequent',
            actor: 'user',
            createdAt: 2000,
            sourceKinds: ['browser_context'],
            evidenceRefs: ['field-shadow-record:field-shadow-record-client-test'],
            calibrationEligible: true,
            promotionEligible: false,
            safetyTightening: false,
            actionAuthority: 'display_only',
            mutationCount: 0,
          },
          followThroughEvents: [
            {
              version: 1,
              id: 'aoi-follow-through-field-feedback-client-test',
              sessionPath: 'aoi/default',
              opportunityId: 'opportunity-client-test',
              sourceKind: 'research',
              topicKey: 'topic:reverse-engineering',
              sourceKey: 'browser_context',
              deliveryMode: 'direct_chat',
              action: 'snoozed',
              feedbackCategory: 'too_frequent',
              result: 'negative',
              timingLabel: 'operator field feedback too_frequent',
              evidenceRefs: ['operator-feedback:aoi-feedback-label-client-test'],
              createdAt: 2000,
              actionAuthority: 'display_only',
              mutationCount: 0,
            },
          ],
          fieldEvents: [
            {
              version: 1,
              id: 'aoi-field-event-feedback-client-test',
              sessionPath: 'aoi/default',
              category: 'feedback_recorded',
              summary: 'Operator labeled field decision as too_frequent.',
              sourceRefs: ['operator-feedback:aoi-feedback-label-client-test'],
              evidenceRefs: ['field-shadow-record:field-shadow-record-client-test'],
              privacyState: 'metadata_only',
              mutationCount: 0,
              cannotKnow: [],
              createdAt: 2000,
              expiresAt: 3000,
              signalIds: ['aoi-feedback-label-client-test'],
              dedupeKey: 'operator-feedback:aoi-feedback-label-client-test',
              actionAuthority: 'display_only',
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const list = await fetchAoiFieldFeedback('aoi/default');
    const feedback = await recordAoiFieldFeedback('aoi/default', {
      decisionRecordId: 'field-shadow-record-client-test',
      decisionId: 'field-shadow-decision-client-test',
      fieldEventId: 'field-event-client-test',
      opportunityId: 'opportunity-client-test',
      topicKey: 'topic:reverse-engineering',
      sourceKey: 'browser_context',
      deliveryMode: 'direct_chat',
      label: 'too_frequent',
      sourceKinds: ['browser_context'],
      evidenceRefs: ['field-shadow-record:field-shadow-record-client-test'],
    });

    expect(list.feedbackInbox.inboxCount).toBe(0);
    expect(feedback.labelAction.actionAuthority).toBe('display_only');
    expect(feedback.followThroughEvents[0]?.feedbackCategory).toBe('too_frequent');
    expect(feedback.fieldEvents[0]?.mutationCount).toBe(0);
    expect(requestBodies).toEqual([
      {
        sessionPath: 'aoi/default',
        decisionRecordId: 'field-shadow-record-client-test',
        decisionId: 'field-shadow-decision-client-test',
        fieldEventId: 'field-event-client-test',
        opportunityId: 'opportunity-client-test',
        topicKey: 'topic:reverse-engineering',
        sourceKey: 'browser_context',
        deliveryMode: 'direct_chat',
        label: 'too_frequent',
        sourceKinds: ['browser_context'],
        evidenceRefs: ['field-shadow-record:field-shadow-record-client-test'],
      },
    ]);
  });

  it('fetches and records passive outcome learning signals', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/aoi-autonomy/outcomes?')) {
        return jsonResponse(makeOutcomeLearningPayload());
      }
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (url === '/api/aoi-autonomy/outcomes') {
        return jsonResponse({
          ...makeOutcomeLearningPayload(),
          outcome: makeOutcomeLearningPayload().outcomes[0],
          followThroughLearning: {
            version: 1,
            sessionPath: 'aoi/default',
            generatedAt: 2000,
            eventCount: 1,
            acceptedCount: 1,
            dismissedCount: 0,
            executedCount: 0,
            failedCount: 0,
            pendingCount: 0,
            topicScores: [],
            sourceScores: [],
            timingScores: [],
            directChatSuppressionKeys: [],
            cooldownHints: [],
            rankingBoostHints: [],
            trustAdjustmentHints: ['passive outcome signals are low-confidence calibration only'],
            evidenceRefs: ['outcome:aoi-outcome-client-test'],
          },
          timeline: {
            version: 1,
            sessionPath: 'aoi/default',
            newestMeaningfulEvents: [],
            lastExportRedactionCount: 0,
            totalEventCount: 1,
            exportedTraceCount: 0,
          },
          evaluation: makeEvaluation(),
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const list = await fetchAoiOutcomeLearning('aoi/default');
    const result = await recordAoiOutcomeSignal('aoi/default', {
      sourceProposalId: 'aoi-proposal-client-test',
      outcomeKind: 'validation_run',
      validationPassed: false,
      topicKey: 'topic:reverse-engineering',
      sourceKey: 'browser_context',
      deliveryMode: 'dashboard',
      evidenceRefs: ['validation:pnpm-test'],
      createdAt: 2000,
    });

    expect(list.summary.outcomeOnly).toBe(true);
    expect(result.outcome.signalKind).toBe('passive_outcome');
    expect(result.timeline?.totalEventCount).toBe(1);
    expect(result.followThroughLearning?.eventCount).toBe(1);
    expect(requestBodies).toEqual([
      {
        sessionPath: 'aoi/default',
        sourceProposalId: 'aoi-proposal-client-test',
        outcomeKind: 'validation_run',
        validationPassed: false,
        topicKey: 'topic:reverse-engineering',
        sourceKey: 'browser_context',
        deliveryMode: 'dashboard',
        evidenceRefs: ['validation:pnpm-test'],
        createdAt: 2000,
      },
    ]);
  });

  it('runs proactive brief scout and cooldown reset through explicit endpoints', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (url === '/api/aoi-autonomy/proactive-briefs/scout') {
        return jsonResponse({
          ok: true,
          sessionPath: 'aoi/default',
          record: {
            id: 'aoi-wakeup-proactive-scout-client-test',
            status: 'completed',
            completedAt: 2000,
            proactiveScout: {
              version: 1,
              requested: true,
              runNow: true,
              background: false,
              status: 'blocked',
              provider: 'none',
              providerConfigured: false,
              startedAt: 2000,
              completedAt: 2000,
              createdCandidateCount: 0,
              skippedTopicCount: 0,
              sourceFreshnessCount: 0,
              topicIds: [],
              blockedReasons: ['current_provider_missing'],
              warnings: [],
              budget: {
                dayKey: '2027-01-15',
                runsToday: 0,
                maxRunsPerDay: 3,
                runsThisSession: 0,
                maxRunsPerSession: 5,
              },
              evidenceRefs: ['scheduler:proactive-scout'],
            },
          },
          state: {
            version: 1,
            sessionPath: 'aoi/default',
            updatedAt: 2000,
            wakeupCount: 1,
            sourceSchedules: [],
            recentWakeups: [],
          },
          status: makeStatus(),
          proactiveBriefs: makeProactiveBriefPayload(),
        });
      }
      if (url === '/api/aoi-autonomy/proactive-briefs/cooldown/reset') {
        return jsonResponse(makeProactiveBriefPayload());
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const scout = await runAoiProactiveBriefScoutNow({
      sessionPath: 'aoi/default',
      topicId: 'aoi-interest-re',
      quietMode: true,
    });
    const reset = await resetAoiProactiveBriefCooldown({
      sessionPath: 'aoi/default',
      topicId: 'aoi-interest-re',
    });

    expect(scout.record.proactiveScout?.blockedReasons).toContain('current_provider_missing');
    expect(scout.proactiveBriefs.candidates[0].id).toBe('aoi-brief-client-test');
    expect(reset.candidates[0].id).toBe('aoi-brief-client-test');
    expect(requestBodies).toEqual([
      {
        sessionPath: 'aoi/default',
        topicId: 'aoi-interest-re',
        mode: 'quick',
        quietMode: true,
      },
      {
        sessionPath: 'aoi/default',
        topicId: 'aoi-interest-re',
      },
    ]);
  });

  it('fetches the compact operator health snapshot', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      expect(String(input)).toBe('/api/aoi-autonomy/health?sessionPath=aoi%2Fdefault');
      return jsonResponse({
        sessionPath: 'aoi/default',
        health: makeHealth(),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAoiOperatorHealth('aoi/default');

    expect(result.health.issues[0].recommendation.action).toBe('configure_tavily');
    expect(result.health.summary).not.toContain('secret');
  });

  it('fetches and mutates compact playbook previews', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/aoi-autonomy/playbooks?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          active: [makePlaybook()],
          archived: [],
        });
      }
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (url === '/api/aoi-autonomy/playbooks/prepare') {
        return jsonResponse({
          ok: true,
          sessionPath: 'aoi/default',
          playbook: makePlaybook(),
          active: [makePlaybook()],
          archived: [],
        });
      }
      if (url === '/api/aoi-autonomy/playbooks/update') {
        return jsonResponse({
          ok: true,
          sessionPath: 'aoi/default',
          playbook: {
            ...makePlaybook(),
            steps: makePlaybook().steps.map((step) => ({ ...step, status: 'completed' })),
          },
          active: [makePlaybook()],
          archived: [],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const list = await fetchAoiPlaybooks('aoi/default');
    const prepared = await prepareAoiPlaybookPreview('aoi/default', {
      proposalId: 'aoi-proposal-client-test',
    });
    const updated = await updateAoiPlaybookProgress('aoi/default', {
      playbookId: 'aoi-playbook-client-test',
      kind: 'inspect_context_completed',
      evidenceRefs: ['timeline:context-reviewed'],
    });

    expect(list.active[0].id).toBe('aoi-playbook-client-test');
    expect(prepared.playbook.steps[0].executionBoundary.canAutoRun).toBe(false);
    expect(updated.playbook.steps[0].status).toBe('completed');
    expect(requestBodies).toEqual([
      {
        sessionPath: 'aoi/default',
        proposalId: 'aoi-proposal-client-test',
      },
      {
        sessionPath: 'aoi/default',
        playbookId: 'aoi-playbook-client-test',
        kind: 'inspect_context_completed',
        evidenceRefs: ['timeline:context-reviewed'],
      },
    ]);
  });

  it('preserves explicit clear markers when updating environment sources', async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(String(input)).toBe('/api/aoi-autonomy/sources');
      expect(init?.method).toBe('POST');
      return jsonResponse({
        ok: true,
        sessionPath: 'aoi/default',
        registry: {
          version: 1,
          sessionPath: 'aoi/default',
          updatedAt: 2000,
          sources: [],
        },
        status: makeStatus(),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await updateAoiEnvironmentSource('aoi/default', {
      sourceId: 'notes-metadata',
      patch: {
        enabled: false,
        consentReason: undefined,
        lastObservedAt: undefined,
        lastReviewedAt: undefined,
      },
    });

    expect(requestBody).toMatchObject({
      sessionPath: 'aoi/default',
      sourceId: 'notes-metadata',
      patch: {
        enabled: false,
        consentReason: null,
        lastObservedAt: null,
        lastReviewedAt: null,
      },
    });
  });

  it('posts a bounded manual tick when the user runs check now', async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(String(input)).toBe('/api/aoi-autonomy/tick');
      expect(init?.method).toBe('POST');
      return jsonResponse({
        ok: true,
        sessionPath: 'aoi/default',
        status: makeStatus(),
        proposals: [],
        blockedProposals: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAoiAutonomyManualTick({
      sessionPath: 'aoi/default',
      latestUserMessage: 'check this session',
      reason: 'manual',
      maxRuntimeMs: 5000,
    });

    expect(result.status.sessionPath).toBe('aoi/default');
    expect(requestBody).toMatchObject({
      sessionPath: 'aoi/default',
      latestUserMessage: 'check this session',
      reason: 'manual',
      maxRuntimeMs: 5000,
    });
  });

  it('posts a bounded manual wakeup through the scheduler endpoint', async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(String(input)).toBe('/api/aoi-autonomy/wakeup');
      expect(init?.method).toBe('POST');
      return jsonResponse({
        ok: true,
        sessionPath: 'aoi/default',
        record: {
          id: 'aoi-wakeup-client-test',
          completedAt: 2000,
        },
        state: {
          version: 1,
          sessionPath: 'aoi/default',
          updatedAt: 2000,
          wakeupCount: 1,
          sourceSchedules: [],
          recentWakeups: [],
        },
        status: makeStatus(),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAoiAutonomyManualWakeup({
      sessionPath: 'aoi/default',
      latestUserMessage: 'check this session',
      sourceIds: ['app-state'],
      quietMode: true,
    });

    expect(result.sessionPath).toBe('aoi/default');
    expect(requestBody).toMatchObject({
      sessionPath: 'aoi/default',
      latestUserMessage: 'check this session',
      sourceIds: ['app-state'],
      reason: 'manual_refresh',
      quietMode: true,
    });
    expect(requestBody.budget).toMatchObject({
      maxSchedulerRuntimeMs: 15000,
      maxBackgroundTickRuntimeMs: 12000,
      maxSourceCount: 3,
      maxGeneratedProposalCount: 2,
      wakeupCooldownMs: 0,
    });
  });

  it('returns failed wakeup records instead of treating them as HTTP failures', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: false,
        sessionPath: 'aoi/default',
        record: {
          id: 'aoi-wakeup-failed-client-test',
          status: 'failed',
          completedAt: 2000,
        },
        state: {
          version: 1,
          sessionPath: 'aoi/default',
          updatedAt: 2000,
          wakeupCount: 1,
          sourceSchedules: [],
          recentWakeups: [],
        },
        status: makeStatus(),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAoiAutonomyManualWakeup({
      sessionPath: 'aoi/default',
    });

    expect(result.ok).toBe(false);
    expect(result.record.status).toBe('failed');
  });
});
