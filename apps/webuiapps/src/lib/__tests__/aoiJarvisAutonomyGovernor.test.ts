import { describe, expect, it } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import type { AoiJarvisReadinessScorecard } from '../aoiJarvisReadinessScorecard';
import {
  AOI_JARVIS_AUTONOMY_GOVERNOR_AUDIT_TRAIL_MAX,
  appendAoiJarvisAutonomyGovernorAuditTrail,
  buildAoiJarvisAutonomyGovernor,
  buildAoiJarvisAutonomyGovernorAuditEvent,
  buildAoiJarvisAutonomyGovernorAuditFreshnessReview,
  buildAoiJarvisAutonomyGovernorAuditPanelSummary,
  buildAoiJarvisAutonomyGovernorAuditResetAudit,
  buildAoiJarvisAutonomyGovernorCapabilityGaps,
  buildAoiJarvisAutonomyGovernorUpgradePlan,
  buildAoiJarvisAutonomyGovernorPromptBlock,
  buildAoiJarvisAutonomyGovernorPanelSummary,
  canAoiJarvisAutonomyUseCapability,
  normalizeAoiJarvisAutonomyGovernorAuditResetAudit,
} from '../aoiJarvisAutonomyGovernor';
import type { AoiMissionControlState } from '../aoiMissionControlRuntime';
import type { AoiSourceFreshnessContract } from '../aoiSourceFreshnessContract';
import type {
  AoiAutonomyPolicy,
  AoiOperatorHealthState,
  AoiProactiveTrendAdvisorState,
} from '../aoiAutonomyTypes';

function makePolicy(partial: Partial<AoiAutonomyPolicy> = {}): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    previewMode: true,
    level: 'L5',
    proactiveSuggestionsEnabled: true,
    proactiveBriefing: {
      ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
      enabled: true,
      directChatHookOptIn: true,
    },
    updatedAt: 1000,
    ...partial,
  };
}

function makeHealth(partial: Partial<AoiOperatorHealthState> = {}): AoiOperatorHealthState {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    generatedAt: 1000,
    overallStatus: 'healthy',
    summary: 'All operator surfaces are healthy.',
    capabilities: [],
    issues: [],
    userBlockingIssueCount: 0,
    evidenceRefs: ['operator-health:healthy'],
    ...partial,
  };
}

function makeSource(partial: Partial<AoiSourceFreshnessContract> = {}): AoiSourceFreshnessContract {
  return {
    version: 1,
    id: 'source-freshness-workspace-git',
    sourceId: 'workspace-git',
    sourceKind: 'workspace_git',
    sourceLabel: 'Workspace git',
    consentState: 'not_required',
    dataScope: 'workspace metadata',
    scopeState: 'workspace',
    bodyAccessState: 'not_applicable',
    freshnessState: 'fresh',
    signalFreshness: 'fresh',
    lastObservedAt: 1000,
    lastSuccessfulReadAt: 1000,
    staleAfterMs: 60_000,
    cannotKnow: [],
    evidenceRefs: ['source-freshness:workspace-git:fresh'],
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

function makeTrend(
  partial: Partial<AoiProactiveTrendAdvisorState> = {},
): AoiProactiveTrendAdvisorState {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    generatedAt: 1000,
    watchProfile: {
      version: 1,
      sessionPath: 'aoi/default',
      generatedAt: 1000,
      sourceTopicCount: 0,
      topicWatches: [],
      evidenceRefs: ['trend-watch-profile:test'],
    },
    snapshots: [],
    opinionCards: [],
    quietNotificationCount: 0,
    directChatHookCount: 0,
    sourceQualityCounts: {},
    interestDriftCounts: {},
    deliveryControlBlockedReasons: [],
    recentDeliveryEvents: [],
    deliveryAuditSummary: {
      version: 1,
      inlineShownCount: 0,
      directChatOfferedCount: 0,
      suppressedCount: 0,
      evidenceRefs: ['trend-delivery:audit'],
    },
    readiness: {
      version: 1,
      status: 'ready',
      sampleCount: 4,
      directChatReady: true,
      directChatBlockedReasons: [],
      summary: 'Trend advisor is ready for direct chat.',
      evidenceRefs: ['trend-readiness:ready'],
    },
    evidenceRefs: ['trend-advisor:ready'],
    ...partial,
  };
}

function makeBlockedReadinessScorecard(): AoiJarvisReadinessScorecard {
  return {
    version: 1,
    id: 'readiness-blocked-test',
    sessionPath: 'aoi/default',
    generatedAt: 1000,
    score: 58,
    level: 'not_ready',
    gateStatus: 'blocked',
    canIncreaseTrust: false,
    modeRecommendation: 'tighten_or_rollback',
    metricGroups: [],
    metrics: [],
    gates: [
      {
        version: 1,
        id: 'gate.stale_source_honesty_minimum',
        label: 'Stale-source honesty minimum',
        status: 'block',
        reason: 'Higher trust is blocked until source honesty is proven.',
        evidenceRefs: ['readiness:stale-source-honesty'],
        blockerRefs: ['source.stale_honesty_rate'],
      },
    ],
    recommendations: [
      {
        version: 1,
        id: 'recommendation.run_source_calibration',
        severity: 'blocker',
        label: 'Run source calibration',
        reason: 'Source honesty needs more evidence.',
        action: 'Collect source calibration evidence before higher-trust execution.',
        evidenceRefs: ['readiness:stale-source-honesty'],
      },
    ],
    evidenceRefs: ['readiness:stale-source-honesty'],
    blockerRefs: ['gate.stale_source_honesty_minimum', 'source.stale_honesty_rate'],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

describe('Aoi Jarvis autonomy governor', () => {
  it('allows approval execution only when policy and evidence gates are healthy', () => {
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy(),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      agendaNudgeReadiness: {
        visible: true,
        tone: 'ready',
        statusLabel: 'ready',
        summaryLabel: 'Agenda direct chat is ready.',
        evidenceRefs: ['agenda-readiness:ready'],
      },
      ttsEnabled: true,
    });

    expect(governor.overallMode).toBe('approval_execution');
    expect(canAoiJarvisAutonomyUseCapability(governor, 'command')).toBe(true);
    expect(governor.actionAuthority).toBe('display_only');
    expect(governor.mutationCount).toBe(0);
  });

  it('blocks direct chat when sources are stale without disabling quiet suggestions', () => {
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy(),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [
        makeSource({
          freshnessState: 'stale',
          signalFreshness: 'stale',
          evidenceRefs: ['source-freshness:workspace-git:stale'],
        }),
      ],
      proactiveTrendAdvisor: makeTrend(),
      ttsEnabled: true,
    });

    expect(governor.overallMode).toBe('proactive_brief');
    expect(canAoiJarvisAutonomyUseCapability(governor, 'research')).toBe(true);
    expect(canAoiJarvisAutonomyUseCapability(governor, 'direct_chat')).toBe(false);
    expect(governor.blockers.map((blocker) => blocker.id)).toContain(
      'aoi-jarvis-governor:source-freshness-stale',
    );
  });

  it('keeps proactive briefs but blocks direct chat when agenda nudge readiness is muted', () => {
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy({ level: 'L4' }),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      agendaNudgeReadiness: {
        visible: true,
        tone: 'muted',
        statusLabel: 'muted',
        summaryLabel: 'Feedback mute is active.',
        evidenceRefs: ['agenda-feedback:too-much'],
      },
      ttsEnabled: true,
    });

    expect(governor.overallMode).toBe('proactive_brief');
    expect(canAoiJarvisAutonomyUseCapability(governor, 'proactive_brief')).toBe(true);
    expect(canAoiJarvisAutonomyUseCapability(governor, 'direct_chat')).toBe(false);
    expect(governor.nextUpgradeAction.toLowerCase()).toContain('agenda direct chat is blocked');
  });

  it('falls back to observe only when operator health is blocked', () => {
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy(),
      operatorHealth: makeHealth({
        overallStatus: 'blocked',
        summary: 'Approved command runner is unavailable.',
        userBlockingIssueCount: 1,
        evidenceRefs: ['operator-health:approved-command-runner-blocked'],
      }),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      ttsEnabled: true,
    });

    expect(governor.overallMode).toBe('observe_only');
    expect(canAoiJarvisAutonomyUseCapability(governor, 'mission_control')).toBe(false);
    expect(canAoiJarvisAutonomyUseCapability(governor, 'command')).toBe(false);
  });

  it('uses readiness blockers to prevent execution without muting source-backed direct chat', () => {
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy(),
      operatorHealth: makeHealth(),
      jarvisReadinessScorecard: makeBlockedReadinessScorecard(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      agendaNudgeReadiness: {
        visible: true,
        tone: 'ready',
        statusLabel: 'ready',
        summaryLabel: 'Agenda direct chat is ready.',
        evidenceRefs: ['agenda-readiness:ready'],
      },
      ttsEnabled: true,
    });

    expect(governor.overallMode).toBe('direct_chat');
    expect(canAoiJarvisAutonomyUseCapability(governor, 'direct_chat')).toBe(true);
    expect(canAoiJarvisAutonomyUseCapability(governor, 'command')).toBe(false);
  });

  it('allows prepared actions but blocks command execution while mission control waits for approval', () => {
    const missionControl: AoiMissionControlState = {
      version: 1,
      id: 'mission-control-waiting-approval',
      sessionPath: 'aoi/default',
      generatedAt: 2000,
      items: [],
      health: {
        version: 1,
        activeMissionCount: 1,
        staleMissionCount: 0,
        waitingExternalCount: 0,
        waitingApprovalCount: 1,
        blockedMissionCount: 0,
        pausedMissionCount: 0,
        completedMissionCount: 0,
        archivedMissionCount: 0,
        whyQuiet: 'Waiting for explicit approval.',
        warnings: [],
        evidenceRefs: ['mission-control:waiting-approval'],
      },
      dashboardSummary: {
        version: 1,
        visible: true,
        statusLabel: 'waiting approval',
        activeMissionCountLabel: '1 active',
        staleMissionCountLabel: '0 stale',
        waitingExternalCountLabel: '0 waiting external',
        waitingApprovalCountLabel: '1 waiting approval',
        blockedMissionCountLabel: '0 blocked',
        topMissionLabel: 'No top mission',
        nextSafeActionLabel: 'Wait for approval',
        whyQuietLabel: 'Waiting for explicit approval.',
        itemLabels: [],
        evidenceRefs: ['mission-control:waiting-approval'],
      },
      evidenceRefs: ['mission-control:waiting-approval'],
      actionAuthority: 'display_only',
      mutationCount: 0,
    };
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy(),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [makeSource()],
      missionControl,
      proactiveTrendAdvisor: makeTrend(),
      ttsEnabled: true,
    });

    expect(governor.overallMode).toBe('prepare_actions');
    expect(canAoiJarvisAutonomyUseCapability(governor, 'prepare_action')).toBe(true);
    expect(canAoiJarvisAutonomyUseCapability(governor, 'command')).toBe(false);
  });

  it('builds a compact panel summary with blockers and evidence', () => {
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy({
        proactiveBriefing: {
          ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
          enabled: true,
          directChatHookOptIn: false,
        },
      }),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      ttsEnabled: true,
    });
    const panel = buildAoiJarvisAutonomyGovernorPanelSummary(governor);

    expect(panel.visible).toBe(true);
    expect(panel.modeLabel).toBe('Proactive brief');
    expect(panel.blockedCapabilityLabels).toContain('Direct chat');
    expect(panel.capabilityGapLabels.join(' ')).toContain('Direct chat opt-in is off');
    expect(panel.upgradePlanLabels.join(' ')).toContain('Direct chat');
    expect(panel.blockerLabels.join(' ')).toContain('Direct chat opt-in is off');
    expect(panel.evidenceRefs).toContain('policy:directChatHookOptIn:false');
  });

  it('builds display-only capability gaps for blocked authority bands', () => {
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy({ level: 'L5' }),
      operatorHealth: makeHealth(),
      jarvisReadinessScorecard: makeBlockedReadinessScorecard(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      agendaNudgeReadiness: {
        visible: true,
        tone: 'ready',
        statusLabel: 'ready',
        summaryLabel: 'Agenda direct chat is ready.',
        evidenceRefs: ['agenda-readiness:ready'],
      },
      ttsEnabled: true,
    });
    const gaps = buildAoiJarvisAutonomyGovernorCapabilityGaps(governor);
    const commandGap = gaps.find((gap) => gap.capability === 'command');

    expect(commandGap).toMatchObject({
      capabilityLabel: 'Approved command',
      requiredMode: 'approval_execution',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(commandGap?.reason).toContain('Jarvis readiness gate is blocked');
    expect(commandGap?.nextAction).toContain('Source honesty needs more evidence');
    expect(commandGap?.evidenceRefs).toContain('readiness:stale-source-honesty');
  });

  it('builds display-only upgrade evidence plans from blocked governor gaps', () => {
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy({ level: 'L5' }),
      operatorHealth: makeHealth(),
      jarvisReadinessScorecard: makeBlockedReadinessScorecard(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      agendaNudgeReadiness: {
        visible: true,
        tone: 'ready',
        statusLabel: 'ready',
        summaryLabel: 'Agenda direct chat is ready.',
        evidenceRefs: ['agenda-readiness:ready'],
      },
      ttsEnabled: true,
    });
    const plan = buildAoiJarvisAutonomyGovernorUpgradePlan(governor);

    expect(plan).toMatchObject({
      visible: true,
      status: 'collect_evidence',
      currentMode: 'direct_chat',
      targetMode: 'prepare_actions',
      targetCapabilityLabel: 'Prepare action',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(plan.summaryLabel).toContain('Prepare action targets Prepare actions');
    expect(plan.steps[0]).toMatchObject({
      label: 'Resolve Jarvis readiness gate is blocked',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(plan.steps[0].safeActionLabel).toContain('research, memory, and observation');
    expect(plan.evidenceRefs).toContain('readiness:stale-source-honesty');
  });

  it('records display-only audit events and dedupes repeated governor decisions', () => {
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy(),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      ttsEnabled: true,
    });
    const event = buildAoiJarvisAutonomyGovernorAuditEvent({ decision: governor });

    expect(event).toMatchObject({
      kind: 'snapshot',
      mode: 'approval_execution',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(event?.allowedCapabilityLabels).toContain('Approved command');
    expect(event?.upgradePlanStatus).toBe('steady');
    expect(event?.upgradePlanSummaryLabel).toContain(
      'Approval execution has no blocked configured capability',
    );
    expect(event?.upgradePlanStepLabels.join(' ')).toContain('Maintain autonomy evidence trail');

    const trail = appendAoiJarvisAutonomyGovernorAuditTrail(null, event);
    const repeatedTrail = appendAoiJarvisAutonomyGovernorAuditTrail(trail, event);

    expect(trail?.events).toHaveLength(1);
    expect(repeatedTrail?.events).toHaveLength(1);
    expect(repeatedTrail?.actionAuthority).toBe('display_only');
    expect(repeatedTrail?.mutationCount).toBe(0);
  });

  it('classifies mode changes when the governor ceiling changes', () => {
    const blockedGovernor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy({ enabled: false, previewMode: false }),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      ttsEnabled: true,
    });
    const blockedEvent = buildAoiJarvisAutonomyGovernorAuditEvent({
      decision: blockedGovernor,
    });
    const readyGovernor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 3000,
      policy: makePolicy(),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      ttsEnabled: true,
    });
    const readyEvent = buildAoiJarvisAutonomyGovernorAuditEvent({
      decision: readyGovernor,
      previousEvent: blockedEvent,
    });
    const trail = appendAoiJarvisAutonomyGovernorAuditTrail(
      appendAoiJarvisAutonomyGovernorAuditTrail(null, blockedEvent),
      readyEvent,
    );

    expect(blockedEvent?.mode).toBe('observe_only');
    expect(readyEvent).toMatchObject({
      kind: 'mode_change',
      previousMode: 'observe_only',
      mode: 'approval_execution',
    });
    expect(trail?.events[0]).toMatchObject({ mode: 'approval_execution' });
    expect(trail?.events[1]).toMatchObject({ mode: 'observe_only' });
  });

  it('reviews whether the latest governor audit snapshot is current or stale', () => {
    const staleGovernor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 2000,
      policy: makePolicy({ enabled: false, previewMode: false }),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      ttsEnabled: true,
    });
    const currentGovernor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 3000,
      policy: makePolicy(),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      ttsEnabled: true,
    });
    const staleEvent = buildAoiJarvisAutonomyGovernorAuditEvent({ decision: staleGovernor });
    const trail = appendAoiJarvisAutonomyGovernorAuditTrail(null, staleEvent);
    const review = buildAoiJarvisAutonomyGovernorAuditFreshnessReview(currentGovernor, trail);
    const summary = buildAoiJarvisAutonomyGovernorAuditPanelSummary(trail, null, currentGovernor);

    expect(review).toMatchObject({
      visible: true,
      status: 'stale',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(review.label).toContain('Stale');
    expect(review.reviewLabels.join(' ')).toContain('Mode changed from Observe only');
    expect(review.reviewLabels.join(' ')).toContain('Allowed capability set changed');
    expect(summary.freshnessLabel).toContain('Stale');
    expect(summary.freshnessReviewLabels.join(' ')).toContain('Mode changed');
  });

  it('keeps the governor audit trail bounded and summarizes recent decisions', () => {
    const events = Array.from(
      { length: AOI_JARVIS_AUTONOMY_GOVERNOR_AUDIT_TRAIL_MAX + 3 },
      (_, index) =>
        buildAoiJarvisAutonomyGovernorAuditEvent({
          decision: buildAoiJarvisAutonomyGovernor({
            sessionPath: `aoi/session-${index}`,
            now: 2000 + index,
            policy: makePolicy({ level: index % 2 === 0 ? 'L3' : 'L5' }),
            operatorHealth: makeHealth(),
            sourceFreshnessContracts: [makeSource()],
            proactiveTrendAdvisor: makeTrend(),
            ttsEnabled: true,
          }),
        }),
    );
    const trail = events.reduce(
      (currentTrail, event) => appendAoiJarvisAutonomyGovernorAuditTrail(currentTrail, event),
      null as ReturnType<typeof appendAoiJarvisAutonomyGovernorAuditTrail>,
    );
    const summary = buildAoiJarvisAutonomyGovernorAuditPanelSummary(trail);

    expect(trail?.events).toHaveLength(AOI_JARVIS_AUTONOMY_GOVERNOR_AUDIT_TRAIL_MAX);
    expect(trail?.events[0].sessionPath).toBe('aoi/session-10');
    expect(summary.visible).toBe(true);
    expect(summary.recentEventLabels.length).toBeGreaterThan(0);
    expect(summary.upgradePlanLabel).toContain('Direct chat targets Direct chat');
    expect(summary.upgradePlanStepLabels.join(' ')).toContain('Review Direct chat upgrade gate');
    expect(summary.freshnessLabel).toContain('Audit freshness is unknown');
    expect(summary.safetyBoundaryLabel).toContain('display-only');
  });

  it('builds a display-only reset audit and exposes restart controls in the summary', () => {
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 3000,
      policy: makePolicy(),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [makeSource()],
      proactiveTrendAdvisor: makeTrend(),
      ttsEnabled: true,
    });
    const event = buildAoiJarvisAutonomyGovernorAuditEvent({ decision: governor });
    const trail = appendAoiJarvisAutonomyGovernorAuditTrail(null, event);
    const resetAudit = buildAoiJarvisAutonomyGovernorAuditResetAudit({
      trail,
      decision: governor,
      now: 5000,
    });
    const normalizedReset = normalizeAoiJarvisAutonomyGovernorAuditResetAudit({
      ...resetAudit,
      droppedEventCount: 999,
      actionAuthority: 'command',
      mutationCount: 10,
    });
    const summary = buildAoiJarvisAutonomyGovernorAuditPanelSummary(trail, normalizedReset);

    expect(resetAudit).toMatchObject({
      recordedAt: 5000,
      droppedEventCount: 1,
      snapshotMode: 'approval_execution',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(normalizedReset).toMatchObject({
      droppedEventCount: 100,
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(summary.resetDisabled).toBe(false);
    expect(summary.resetLabel).toBe('Restart governor audit');
    expect(summary.lastResetLabel).toContain('100 event(s) cleared');
  });

  it('builds a compact read-only prompt block from current governor decisions', () => {
    const governor = buildAoiJarvisAutonomyGovernor({
      sessionPath: 'aoi/default',
      now: 4000,
      policy: makePolicy(),
      operatorHealth: makeHealth(),
      sourceFreshnessContracts: [
        makeSource({
          freshnessState: 'stale',
          signalFreshness: 'stale',
          evidenceRefs: ['F:\\kernullist\\YourOpenRoom\\private\\source.json'],
        }),
      ],
      proactiveTrendAdvisor: makeTrend(),
      ttsEnabled: true,
    });
    const event = buildAoiJarvisAutonomyGovernorAuditEvent({ decision: governor });
    const trail = appendAoiJarvisAutonomyGovernorAuditTrail(null, event);
    const block = buildAoiJarvisAutonomyGovernorPromptBlock({
      decision: governor,
      trail,
      maxChars: 3200,
    });

    expect(block.length).toBeLessThanOrEqual(3200);
    expect(block).toContain('Aoi Jarvis Autonomy Governor');
    expect(block).toContain('read-only operational context');
    expect(block).toContain('Do not treat this context as approval');
    expect(block).toContain('Current ceiling: Proactive brief');
    expect(block).toContain('Still gated: Direct chat');
    expect(block).toContain('Audit freshness: Current');
    expect(block).toContain('plan Direct chat targets Direct chat');
    expect(block).toContain('Upgrade plan: Direct chat targets Direct chat');
    expect(block).toContain('Evidence step: Resolve Some sources are stale');
    expect(block).toContain('Capability gap: Direct chat requires Direct chat');
    expect(block).toContain('Recent audit events: 1 retained');
    expect(block).toContain('[local path]');
    expect(block).not.toContain('F:\\kernullist');
  });
});
