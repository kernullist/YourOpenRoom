import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AOI_AUTONOMY_POLICY,
  getDefaultAoiEnvironmentSourceRegistry,
} from '../aoiAutonomyPolicy';
import { decideAoiMission } from '../aoiAutonomyClient';
import { buildAoiContextPromptBlock, sanitizeAoiContextUrl } from '../aoiContextRouter';
import {
  AOI_AUTONOMY_PANEL_SETTINGS_KEY,
  appendAoiAgendaNudgeDecisionFeedbackHistory,
  buildAoiAgendaChatFollowUpContext,
  buildAoiAgendaChatFollowUpResponse,
  buildAoiAgendaNudgeDeliveryDecisionAudit,
  buildAoiAgendaNudgeDecisionFeedbackAudit,
  buildAoiAgendaNudgeFeedbackResetPatch,
  buildAoiAgendaNudgeReadinessActionAudit,
  buildAoiAgendaNudgeCalibrationPanelSummary,
  buildAoiAgendaNudgeReadinessPanelSummary,
  buildAoiAutonomyAgendaPanelSummary,
  buildAoiOperatorHealthPanelSummary,
  buildAoiPlaybookPanelSummary,
  buildAoiBlockedStateSummary,
  buildAoiBlockedProactiveExplanation,
  buildAoiAutonomySchedulerPanelSummary,
  buildAoiAutonomyNotificationBadge,
  buildAoiContextSourcePanelSummaries,
  buildAoiEnvironmentSourcePanelSummaries,
  buildAoiMissionPanelSummary,
  buildAoiMissionResumePrompt,
  buildAoiOperatorDigestPanelSummary,
  buildAoiOperatorAcceptanceDashboard,
  buildAoiOperatorTimelinePanelSummary,
  buildAoiApprovedCommandPanelSummary,
  buildAoiPreferenceInfluencePanelSummary,
  buildAoiPreparedActionPlanPanelSummary,
  buildAoiWorkspaceSignalPanelSummary,
  buildAoiProposalActionPresentation,
  buildAoiProposalInspectorSummary,
  buildAoiProactiveExplanation,
  buildAoiRecoveryPreviewSummary,
  canShowAoiProposalPrimaryAction,
  getAoiSafeAlternativeForReasons,
  getAoiAgendaNudgeCalibrationGate,
  loadAoiAutonomyPanelSettings,
  recordAoiAgendaNudgeFeedback,
  saveAoiAutonomyPanelSettings,
  sanitizeAoiProposalDisplayText,
  selectAoiAgendaChatNudge,
  selectAoiInlineProposal,
} from '../aoiAutonomyUi';
import { evaluateAoiOperatorHealth } from '../aoiOperatorHealth';
import { buildAoiOperatorDigest } from '../aoiOperatorDigest';
import {
  appendAoiShadowDecisionLabel,
  evaluateAoiShadowDecisions,
  recordAoiShadowDecisions,
} from '../aoiShadowModeEvaluation';
import { buildAoiFieldShadowRecordReport } from '../aoiFieldShadowDogfooding';
import {
  buildAoiOperatorFeedbackInbox,
  createAoiOperatorFeedbackLabelAction,
  createAoiOperatorFeedbackLabelActionForItem,
} from '../aoiOperatorFeedbackInbox';
import {
  buildAoiOperatorVoiceEventFromDigest,
  buildAoiOperatorVoiceSummary,
  decideAoiOperatorVoiceRender,
  getDefaultAoiOperatorVoicePolicy,
} from '../aoiOperatorVoice';
import { buildAoiTrustCalibrationProfile } from '../aoiTrustCalibration';
import { buildAoiMissionMemorySnapshot } from '../aoiMissionMemory';
import { buildAoiMissionControlState } from '../aoiMissionControlRuntime';
import { buildAoiDigestTimelineEvents } from '../aoiOperatorTimeline';
import { buildAoiPersonalSourceRealityCheck } from '../aoiPersonalSourceRealityCheck';
import { buildAoiSourceFreshnessContracts } from '../aoiSourceFreshnessContract';
import { buildAoiRealFieldCapture } from '../aoiRealFieldCapture';
import { buildAoiFeedbackCompression } from '../aoiFeedbackCompression';
import {
  buildAoiKiraHandoffPreparedActionPlan,
  buildAoiPreviewOnlyFileWorkPreparedActionPlan,
} from '../aoiSafeActionPlan';
import {
  buildAoiBoundedWorkOrderFromProposal,
  createAoiBoundedWorkOrder,
} from '../aoiBoundedWorkOrder';
import { runAoiFieldGroundedJarvisAcceptancePack } from '../aoiFieldGroundedJarvisAcceptancePack';
import { runAoiJarvisAcceptanceTrial } from '../aoiJarvisAcceptanceTrial';
import { runAoiRealFieldOperationsAcceptancePack } from '../aoiRealFieldOperationsAcceptancePack';
import {
  createAoiApprovedCommandRequest,
  evaluateAoiApprovedCommandPolicy,
} from '../aoiApprovedCommandPolicy';
import { decideAoiCapabilityBrokerAuthority } from '../aoiCapabilityRegistry';
import type { AppDef } from '../appRegistry';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import type {
  AoiAutonomyPolicy,
  AoiAutonomySchedulerState,
  AoiAutonomyStatus,
  AoiAttentionEvent,
  AoiApprovedCommandPolicy,
  AoiContextRouterResult,
  AoiContextSourceSummary,
  AoiEnvironmentSourceRegistry,
  AoiMissionState,
  AoiOperatorTimelineSummary,
  AoiOperatorHealthState,
  AoiPersonalSignalMetadataSummary,
  AoiPlaybook,
  AoiProposal,
  AoiProposalDecision,
  AoiWorkspaceSnapshot,
} from '../aoiAutonomyTypes';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-autonomy-ui-real-field-test-'));
  tempRoots.push(root);
  return root;
}

function makePolicy(partial: Partial<AoiAutonomyPolicy> = {}): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    proactiveSuggestionsEnabled: true,
    level: 'L3',
    updatedAt: 1000,
    ...partial,
  };
}

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'aoi-proposal-ui-test-001',
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'Open matching research',
    body: 'A completed Aoi research report may answer the current question.',
    reason: 'The current topic overlaps with a completed research run.',
    trigger: 'research_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'research:memory',
    confidence: 0.72,
    risk: 'low',
    requiredAutonomyLevel: 'L2',
    requiresUserApproval: true,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['memory:aoi-memory-ui-test'],
    memoryIds: ['aoi-memory-ui-test'],
    artifactRefs: ['research:aoi-research-ui-test/report'],
    riskSignals: [],
    ...partial,
  };
}

function makePreferenceMemory(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  return {
    version: 2,
    id: 'aoi-memory-ui-test',
    scope: 'user',
    type: 'preference',
    status: 'active',
    content: 'The user prefers Korean by default. pref:response.language',
    normalizedContent: 'the user prefers korean by default',
    importance: 0.8,
    confidence: 0.82,
    hits: 2,
    createdAt: 1000,
    updatedAt: 2000,
    sourceEpisodeIds: ['episode-ui-preference'],
    tags: ['preference', 'durable-preference', 'pref:response.language'],
    entities: ['response.language'],
    ...partial,
  };
}

function makeMission(partial: Partial<AoiMissionState> = {}): AoiMissionState {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    status: 'waiting_on_research',
    activeGoalId: 'aoi-goal-ui-test',
    focusSummary: 'Refresh Windows kernel security research',
    waitingOn: 'research',
    lastMeaningfulEventRef: 'goal-progress:ui-test',
    nextRecommendedAction: {
      kind: 'inspect_research',
      label: 'Inspect research run status.',
      reason: 'A research run is linked to the mission.',
      ref: 'research:aoi-research-ui-test',
    },
    evidenceRefs: [
      'goal:aoi-goal-ui-test',
      'research:aoi-research-ui-test',
      'proposal:aoi-proposal-ui-test-001',
    ],
    sourceRefs: {
      goalRef: 'goal:aoi-goal-ui-test',
      proposalRef: 'proposal:aoi-proposal-ui-test-001',
      researchRunRef: 'research:aoi-research-ui-test',
    },
    transitions: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...partial,
  };
}

function makeEnvironmentSourceRegistry(
  partial: Partial<AoiEnvironmentSourceRegistry> = {},
): AoiEnvironmentSourceRegistry {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    updatedAt: 1000,
    sources: [
      {
        version: 1,
        id: 'app-state',
        kind: 'app_state',
        label: 'OpenRoom app state',
        enabled: true,
        scope: 'session',
        risk: 'low',
        allowedOperations: ['summarize', 'status', 'read_metadata'],
        privateByDefault: false,
        quietModeBehavior: 'record_only',
        updatedAt: 1000,
      },
      {
        version: 1,
        id: 'browser-context',
        kind: 'browser_context',
        label: 'Explicit page at F:\\kernullist\\YourOpenRoom\\secret.md',
        enabled: false,
        scope: 'explicit_target',
        risk: 'high',
        allowedOperations: ['summarize', 'read_metadata'],
        privateByDefault: true,
        quietModeBehavior: 'suppress',
        consentReason: 'Use api_key=secret-value only for this page.',
        updatedAt: 1000,
      },
      {
        version: 1,
        id: 'notes-metadata',
        kind: 'notes_metadata',
        label: 'Notes metadata',
        enabled: false,
        scope: 'explicit_target',
        risk: 'high',
        allowedOperations: ['status', 'read_metadata', 'summarize_counts'],
        privateByDefault: true,
        quietModeBehavior: 'suppress',
        updatedAt: 1000,
      },
    ],
    ...partial,
  };
}

function makeWorkspaceSnapshot(partial: Partial<AoiWorkspaceSnapshot> = {}): AoiWorkspaceSnapshot {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    collectedAt: 1000,
    workspaceLabel: 'YourOpenRoom',
    sourceIds: ['workspace-git', 'workspace-build'],
    git: {
      version: 1,
      branchName: 'codex/aoi-workspace',
      branchChanged: false,
      isDirty: true,
      changedFileCount: 1,
      stagedFileCount: 0,
      unstagedFileCount: 1,
      untrackedFileCount: 0,
      statusSummary: 'dirty: 1 changed, 0 staged',
      changedFiles: [
        {
          version: 1,
          pathLabel: 'apps/webuiapps/src/lib/aoiWorkspaceSignals.ts',
          pathHash: 'changed',
          status: 'M',
          staged: false,
          unstaged: true,
          untracked: false,
          changedAt: 1000,
          directoryLabel: 'apps/webuiapps/src/lib',
          extension: 'ts',
        },
      ],
    },
    validation: {
      version: 1,
      command: 'pnpm --filter @openroom/webuiapps test',
      result: 'passed',
      completedAt: 500,
      touchedFileScopes: ['apps/webuiapps/src'],
      freshness: 'stale',
      staleReason: 'Relevant files changed after the last passed validation.',
      evidenceRefs: [],
    },
    freshness: 'stale',
    evidenceRefs: ['workspace:snapshot:ui-test', 'workspace:validation:stale'],
    warnings: [],
    ...partial,
  };
}

function withSourcePatch(
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

function makeBlockingHealth(): AoiOperatorHealthState {
  return evaluateAoiOperatorHealth({
    sessionPath: 'aoi/default',
    registry: getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000),
    config: {
      tavilyConfigured: true,
      kiraConfigured: true,
      kiraWorkerRouteConfigured: true,
      kiraReviewerRouteConfigured: true,
      memoryAvailable: false,
    },
    now: 2000,
  });
}

function makeContextSource(
  partial: Partial<AoiContextSourceSummary> = {},
): AoiContextSourceSummary {
  return {
    version: 1,
    id: 'ctx-ui-test-001',
    sourceId: 'browser-context',
    kind: 'browser_context',
    label: 'Example page',
    displayName: 'Browser',
    relevanceScore: 0.91,
    confidence: 0.84,
    freshness: 'fresh',
    redactionState: 'redacted',
    summary: 'Example page at https://example.com/report is available as explicit metadata only.',
    evidenceRefs: ['browser:ctx-ui-test-001'],
    scoreReasons: ['explicit browser context intent detected'],
    updatedAt: 2000,
    ...partial,
  };
}

function makeContextRouterResult(sources: AoiContextSourceSummary[]): AoiContextRouterResult {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    generatedAt: 3000,
    selectedSources: sources,
    candidateSources: sources,
    promptBlock: buildAoiContextPromptBlock(sources),
  };
}

function makeAttentionEvent(partial: Partial<AoiAttentionEvent> = {}): AoiAttentionEvent {
  return {
    version: 1,
    id: 'attention-ui-test-001',
    sessionPath: 'aoi/default',
    kind: 'research_completed',
    sourceRef: 'research:aoi-research-ui-test',
    sourceSignature: 'research:aoi-research-ui-test',
    summary: 'Aoi research completed for the active mission.',
    risk: 'low',
    evidenceRefs: ['research:aoi-research-ui-test'],
    suggestedAttentionLevel: 'inline',
    createdAt: 3000,
    dedupeKey: 'attention:research_completed:research:aoi-research-ui-test',
    ...partial,
  };
}

function makeSchedulerState(
  partial: Partial<AoiAutonomySchedulerState> = {},
): AoiAutonomySchedulerState {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    updatedAt: 5000,
    wakeupCount: 1,
    lastWakeupAt: 5000,
    lastWakeupReason: 'session_open',
    lastWakeupStatus: 'completed',
    nextAllowedWakeupAt: 6000,
    sourceSchedules: [],
    recentWakeups: [
      {
        version: 1,
        id: 'aoi-wakeup-ui-test',
        sessionPath: 'aoi/default',
        reason: 'session_open',
        startedAt: 4500,
        completedAt: 5000,
        durationMs: 500,
        ok: true,
        status: 'completed',
        budget: {
          version: 1,
          maxSchedulerRuntimeMs: 15000,
          maxBackgroundTickRuntimeMs: 12000,
          maxSourceCount: 3,
          maxGeneratedProposalCount: 2,
          perSourceCooldownMs: 60000,
          wakeupCooldownMs: 60000,
          quietMode: false,
          allowNetwork: false,
        },
        selectedSourceIds: ['app-state'],
        refreshedSourceIds: ['app-state'],
        skippedSources: [
          { sourceId: 'workspace-git', reasons: ['source_disabled'] },
          { sourceId: 'workspace-build', reasons: ['max_source_count_reached'] },
          { sourceId: 'browser-context', reasons: ['quiet_mode_suppressed'] },
          { sourceId: 'manual-note', reasons: ['source_cooldown_active'] },
        ],
        tickRan: true,
        tickSkipped: false,
        tickOk: true,
        tickReason: 'app',
        proposalsCreated: 1,
        observationsSeen: 2,
        warnings: ['background tick warning with F:\\kernullist\\YourOpenRoom\\secret.txt'],
      },
    ],
    ...partial,
  };
}

function makeAutonomyStatus(partial: Partial<AoiAutonomyStatus> = {}): AoiAutonomyStatus {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    policy: makePolicy(),
    activeProposalCount: 2,
    archivedProposalCount: 0,
    acceptedProposalCount: 1,
    snoozedProposalCount: 0,
    blockedProposalCount: 0,
    observationCount: 5,
    reflectionCount: 2,
    decisionCount: 1,
    lastDecisionAt: 3500,
    lastObservationAt: 4500,
    lastReflectionAt: 4600,
    lastTickAt: 4700,
    nextAllowedTickAt: 6000,
    lastTickReason: 'manual',
    activeTick: false,
    recentObservationCount: 3,
    proposalsCreatedInLastTick: 1,
    activeGoalCount: 1,
    currentGoalTitle: 'Refresh Windows kernel security research',
    nextGoalStepTitle: 'Inspect research',
    environmentSourceCount: 3,
    enabledEnvironmentSourceCount: 2,
    highRiskEnvironmentSourceCount: 1,
    privateEnvironmentSourceCount: 1,
    lastEnvironmentSourceObservedAt: 4500,
    updatedAt: 5000,
    ...partial,
  };
}

function makeProposalDecision(partial: Partial<AoiProposalDecision> = {}): AoiProposalDecision {
  return {
    version: 1,
    id: 'decision-ui-test-001',
    proposalId: 'aoi-proposal-ui-test-001',
    sessionPath: 'aoi/default',
    cooldownKey: 'attention:research_completed:research:too-noisy',
    action: 'snooze',
    actor: 'user',
    createdAt: 3500,
    previousStatus: 'active',
    nextStatus: 'snoozed',
    feedbackCategory: 'too_frequent',
    evidenceRefs: ['research:too-noisy'],
    ...partial,
  };
}

describe('Aoi autonomy UI helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('selects the highest-value active inline proposal', () => {
    const lowValue = makeProposal({
      id: 'aoi-proposal-low',
      confidence: 0.56,
      risk: 'medium',
      updatedAt: 2000,
    });
    const highValue = makeProposal({
      id: 'aoi-proposal-high',
      confidence: 0.91,
      risk: 'low',
      evidenceRefs: ['memory:1', 'research:2', 'tool:3'],
      updatedAt: 1500,
    });

    expect(
      selectAoiInlineProposal([lowValue, highValue], makePolicy(), {
        now: 3000,
      })?.id,
    ).toBe('aoi-proposal-high');
  });

  it('hides dismissed and snoozed proposals from inline suggestions', () => {
    const dismissed = makeProposal({ id: 'aoi-proposal-dismissed' });
    const snoozed = makeProposal({ id: 'aoi-proposal-snoozed' });
    const visible = makeProposal({ id: 'aoi-proposal-visible', confidence: 0.65 });

    expect(
      selectAoiInlineProposal([dismissed, snoozed, visible], makePolicy(), {
        now: 3000,
        dismissedProposalIds: new Set([dismissed.id]),
        snoozedProposalIds: new Set([snoozed.id]),
      })?.id,
    ).toBe('aoi-proposal-visible');
  });

  it('does not expose a primary action for blocked proposals', () => {
    expect(
      canShowAoiProposalPrimaryAction(
        makeProposal({
          status: 'blocked',
          blockedReason: 'Policy level is too low.',
        }),
        3000,
      ),
    ).toBe(false);
  });

  it('keeps inline suggestions conservative with default policy', () => {
    expect(DEFAULT_AOI_AUTONOMY_POLICY.enabled).toBe(false);
    expect(DEFAULT_AOI_AUTONOMY_POLICY.proactiveSuggestionsEnabled).toBe(false);
    expect(selectAoiInlineProposal([makeProposal()], DEFAULT_AOI_AUTONOMY_POLICY)).toBeNull();
  });

  it('suppresses proactive inline suggestions in quiet mode', () => {
    expect(
      selectAoiInlineProposal([makeProposal()], makePolicy(), {
        now: 3000,
        quietMode: true,
      }),
    ).toBeNull();
  });

  it('keeps dashboard badges quiet and ignores high-risk goal proposal nudges', () => {
    const highRiskGoalProposal = makeProposal({
      risk: 'high',
      trigger: 'goal_continuation',
      artifactRefs: ['goal:aoi-goal-ui-test'],
    });
    const lowRiskGoalProposal = makeProposal({
      id: 'aoi-proposal-low-risk-goal',
      trigger: 'goal_continuation',
      artifactRefs: ['goal:aoi-goal-ui-test'],
    });

    expect(
      buildAoiAutonomyNotificationBadge({
        proposals: [highRiskGoalProposal],
        settings: {
          panelExpanded: true,
          notificationsEnabled: false,
          quietMode: false,
          maxSuggestionsPerSession: 3,
        },
      }),
    ).toBeNull();
    expect(
      buildAoiAutonomyNotificationBadge({
        proposals: [lowRiskGoalProposal],
        settings: {
          panelExpanded: true,
          notificationsEnabled: false,
          quietMode: true,
          maxSuggestionsPerSession: 3,
        },
      }),
    ).toBeNull();
    expect(
      buildAoiAutonomyNotificationBadge({
        proposals: [lowRiskGoalProposal],
      })?.reason,
    ).toBe('goal_proposal');
    expect(
      buildAoiAutonomyNotificationBadge({
        status: {
          version: 1,
          sessionPath: 'aoi/default',
          policy: makePolicy(),
          activeProposalCount: 1,
          archivedProposalCount: 0,
          acceptedProposalCount: 0,
          snoozedProposalCount: 0,
          blockedProposalCount: 0,
          observationCount: 2,
          reflectionCount: 0,
          decisionCount: 0,
          activeTick: false,
          recentObservationCount: 2,
          proposalsCreatedInLastTick: 1,
          activeGoalCount: 0,
          updatedAt: 4000,
        },
        proposals: [
          makeProposal({
            id: 'aoi-proposal-attention',
            trigger: 'attention_broker',
            title: 'Review completed Aoi research',
            reason: 'Background research finished while you were away.',
          }),
        ],
      }),
    ).toMatchObject({
      label: '1 attention update',
      why: 'Background research finished while you were away.',
      reason: 'background_event',
    });
  });

  it('summarizes the observe-think-propose-act-reflect agenda from autonomy state', () => {
    const acceptedProposal = makeProposal({
      status: 'accepted',
      title: 'Open matching research',
      reason: 'A completed research report matches the current mission.',
      acceptAction: {
        kind: 'read_research_artifact',
        params: {
          runId: 'aoi-research-ui-test',
          artifact: 'report',
        },
      },
      evidenceRefs: ['research:aoi-research-ui-test/report'],
      suggestedTools: ['read_research_artifact'],
      updatedAt: 4900,
    });
    const approvalProposal = makeProposal({
      id: 'aoi-proposal-approval-ui-test',
      title: 'Refresh stale research',
      reason: 'The saved research is stale for a current-info question.',
      trigger: 'stale_research_memory',
      risk: 'medium',
      requiresUserApproval: true,
      acceptAction: {
        kind: 'start_research',
        params: {
          request: 'latest Windows kernel security trend',
        },
      },
      evidenceRefs: ['memory:stale-research-ui-test'],
      suggestedTools: ['start_research'],
      updatedAt: 4800,
    });
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 5000,
      activeProposals: [approvalProposal],
      workspaceSnapshot: makeWorkspaceSnapshot(),
    });

    const summary = buildAoiAutonomyAgendaPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [acceptedProposal, approvalProposal],
      blockedProposals: [
        {
          proposalId: 'aoi-proposal-blocked-ui-test',
          title: 'Run risky command',
          reasons: ['autonomy_level_too_low'],
          evidenceRefs: ['workspace:validation:stale'],
          actionKind: 'run_command',
          requiredAutonomyLevel: 'L5',
          requiresUserApproval: true,
          risk: 'high',
          safeAlternative: 'Keep this as a manual proposal.',
        },
      ],
      mission: makeMission(),
      workspaceSnapshot: makeWorkspaceSnapshot(),
      digest,
      scheduler: makeSchedulerState(),
      health: makeBlockingHealth(),
      recentDecisions: [
        makeProposalDecision({
          action: 'accept',
          nextStatus: 'accepted',
          feedbackCategory: 'useful',
          evidenceRefs: ['research:aoi-research-ui-test/report'],
        }),
      ],
      now: 5000,
      includeDetails: true,
    });

    expect(summary.headlineLabel).toBe('Aoi has an accepted action ready');
    expect(summary.loopLabel).toBe('Observe -> Think -> Propose -> Act -> Reflect');
    expect(summary.nextBestActionLabel).toContain('read research artifact');
    expect(summary.approvalInboxLabel).toContain('1 approval-gated action');
    expect(summary.safetyBoundaryLabel).toContain('L2');
    expect(summary.phaseSummaries.map((phase) => phase.key)).toEqual([
      'observe',
      'think',
      'propose',
      'act',
      'reflect',
    ]);
    expect(summary.phaseSummaries.find((phase) => phase.key === 'observe')).toMatchObject({
      statusLabel: 'watching',
      tone: 'active',
    });
    expect(summary.phaseSummaries.find((phase) => phase.key === 'think')?.primaryLabel).toContain(
      'last reflection',
    );
    expect(summary.phaseSummaries.find((phase) => phase.key === 'act')).toMatchObject({
      statusLabel: 'ready',
      tone: 'ready',
    });
    expect(summary.phaseSummaries.find((phase) => phase.key === 'reflect')?.detailLabels).toEqual(
      expect.arrayContaining(['latest feedback: useful']),
    );
    expect(summary.evidenceRefs).toEqual(
      expect.arrayContaining(['research:aoi-research-ui-test/report']),
    );
  });

  it('surfaces agenda chat nudges only when notification gates allow them', () => {
    const acceptedProposal = makeProposal({
      status: 'accepted',
      confidence: 0.9,
      evidenceRefs: ['research:aoi-research-ui-test/report'],
      acceptAction: {
        kind: 'read_research_artifact',
        params: {
          runId: 'aoi-research-ui-test',
          artifact: 'report',
        },
      },
      suggestedTools: ['read_research_artifact'],
    });
    const settings = {
      panelExpanded: true,
      notificationsEnabled: true,
      quietMode: false,
      maxSuggestionsPerSession: 3,
    };

    const nudge = selectAoiAgendaChatNudge({
      status: makeAutonomyStatus(),
      activeProposals: [acceptedProposal],
      settings,
      options: {
        now: 5000,
      },
    });

    expect(nudge).toMatchObject({
      reason: 'accepted_action_ready',
      proposalId: acceptedProposal.id,
      evidenceRefs: ['research:aoi-research-ui-test/report'],
    });
    expect(nudge?.chatText).toContain('accepted action is ready');
    expect(nudge?.chatText).toContain('Boundary:');
    expect(nudge?.chatText).not.toMatch(/\bexecuted\b|\bexecuting\b/i);
    expect(
      selectAoiAgendaChatNudge({
        status: makeAutonomyStatus(),
        activeProposals: [acceptedProposal],
        settings: {
          ...settings,
          quietMode: true,
        },
        options: {
          now: 5000,
        },
      }),
    ).toBeNull();
    expect(
      selectAoiAgendaChatNudge({
        status: makeAutonomyStatus(),
        activeProposals: [acceptedProposal],
        settings: {
          ...settings,
          notificationsEnabled: false,
        },
        options: {
          now: 5000,
        },
      }),
    ).toBeNull();
    expect(
      selectAoiAgendaChatNudge({
        status: makeAutonomyStatus(),
        activeProposals: [acceptedProposal],
        settings,
        options: {
          now: 5000,
          lastShownAt: 4500,
          cooldownMs: 1000,
        },
      }),
    ).toBeNull();
    expect(
      selectAoiAgendaChatNudge({
        status: makeAutonomyStatus(),
        activeProposals: [acceptedProposal],
        settings,
        options: {
          now: 5000,
          shownCount: 3,
        },
      }),
    ).toBeNull();
    expect(
      selectAoiAgendaChatNudge({
        status: makeAutonomyStatus(),
        activeProposals: [acceptedProposal],
        settings,
        options: {
          now: 5000,
          shownDedupeKeys: new Set([`accepted:${acceptedProposal.id}`]),
        },
      }),
    ).toBeNull();
  });

  it('prioritizes approval-gated agenda chat nudges over high-signal proposals', () => {
    const highSignalProposal = makeProposal({
      id: 'aoi-proposal-high-signal-ui-test',
      title: 'Summarize the current RE trend',
      confidence: 0.94,
      evidenceRefs: ['research:re-trend-ui-test/report', 'memory:re-interest', 'source:kernel'],
      updatedAt: 4900,
    });
    const approvalProposal = makeProposal({
      id: 'aoi-proposal-approval-ui-test',
      title: 'Refresh stale RE research',
      reason: 'The saved RE trend research is stale for a current-info question.',
      requiresUserApproval: true,
      acceptAction: {
        kind: 'start_research',
        params: {
          request: 'latest reverse engineering trend',
        },
      },
      evidenceRefs: ['memory:stale-research-ui-test'],
      suggestedTools: ['start_research'],
      updatedAt: 4700,
    });
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 5000,
      activeProposals: [approvalProposal],
      workspaceSnapshot: makeWorkspaceSnapshot(),
    });

    const nudge = selectAoiAgendaChatNudge({
      status: makeAutonomyStatus(),
      activeProposals: [highSignalProposal, approvalProposal],
      digest,
      settings: {
        panelExpanded: true,
        notificationsEnabled: true,
        quietMode: false,
        maxSuggestionsPerSession: 3,
      },
      options: {
        now: 5000,
      },
    });

    expect(nudge).toMatchObject({
      reason: 'approval_waiting',
      proposalId: approvalProposal.id,
    });
    expect(nudge?.chatText).toContain('approval-gated action is waiting');
    expect(nudge?.chatText).toContain('Safe next step:');
  });

  it('answers agenda nudge follow-ups with bounded approval details', () => {
    const approvalProposal = makeProposal({
      id: 'aoi-proposal-approval-ui-test',
      title: 'Refresh stale RE research',
      reason: 'The saved RE trend research is stale for a current-info question.',
      risk: 'medium',
      requiredAutonomyLevel: 'L3',
      requiresUserApproval: true,
      acceptAction: {
        kind: 'start_research',
        params: {
          request: 'latest reverse engineering trend',
        },
      },
      evidenceRefs: ['memory:stale-research-ui-test'],
      suggestedTools: ['start_research'],
    });
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 5000,
      activeProposals: [approvalProposal],
      workspaceSnapshot: makeWorkspaceSnapshot(),
    });
    const nudge = selectAoiAgendaChatNudge({
      status: makeAutonomyStatus(),
      activeProposals: [approvalProposal],
      digest,
      settings: {
        panelExpanded: true,
        notificationsEnabled: true,
        quietMode: false,
        maxSuggestionsPerSession: 3,
      },
      options: {
        now: 5000,
      },
    });

    expect(nudge).not.toBeNull();
    const response = buildAoiAgendaChatFollowUpResponse({
      context: buildAoiAgendaChatFollowUpContext(nudge!, 'Review the approval gate', 5001),
      activeProposals: [approvalProposal],
      digest,
    });

    expect(response.intent).toBe('review_approval_gate');
    expect(response.shouldEnableQuietMode).toBe(false);
    expect(response.feedbackKind).toBe('useful');
    expect(response.chatText).toContain('Approval gate: Refresh stale RE research');
    expect(response.chatText).toContain('required level: L3');
    expect(response.chatText).toContain('waiting for explicit approval');
    expect(response.chatText).not.toMatch(/\bhas run command\b|\bhas executed\b/i);
    expect(response.evidenceRefs).toContain('memory:stale-research-ui-test');
  });

  it('turns agenda nudge quiet follow-ups into a local quiet-mode preference', () => {
    const proposal = makeProposal({
      status: 'accepted',
      evidenceRefs: ['research:aoi-research-ui-test/report'],
      acceptAction: {
        kind: 'read_research_artifact',
        params: {
          runId: 'aoi-research-ui-test',
        },
      },
    });
    const nudge = selectAoiAgendaChatNudge({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: {
        panelExpanded: true,
        notificationsEnabled: true,
        quietMode: false,
        maxSuggestionsPerSession: 3,
      },
      options: {
        now: 5000,
      },
    });

    expect(nudge).not.toBeNull();
    const response = buildAoiAgendaChatFollowUpResponse({
      context: buildAoiAgendaChatFollowUpContext(nudge!, 'Keep observing quietly', 5001),
      activeProposals: [proposal],
    });

    expect(response.intent).toBe('enable_quiet_mode');
    expect(response.shouldEnableQuietMode).toBe(true);
    expect(response.feedbackKind).toBe('quieted');
    expect(response.suggestedReplies).toEqual([]);
    expect(response.chatText).toContain('quiet mode is on');
    expect(response.chatText).toContain('no tools or external actions run');
  });

  it('calibrates agenda chat nudges from follow-up feedback', () => {
    const proposal = makeProposal({
      confidence: 0.96,
      evidenceRefs: ['research:aoi-research-ui-test/report', 'memory:re-interest', 'source:kernel'],
    });
    const quieted = recordAoiAgendaNudgeFeedback(null, {
      kind: 'quieted',
      now: 5000,
      reason: 'enable_quiet_mode',
      dedupeKey: 'proposal:aoi-proposal-ui-test-001',
    });
    const gate = getAoiAgendaNudgeCalibrationGate(quieted, 6000);

    expect(gate).toMatchObject({
      suppressed: true,
      evidenceRefs: ['agenda-feedback:quieted'],
    });
    expect(gate.reasonLabels.join(' ')).toContain('quieted feedback');

    const duplicateQuieted = recordAoiAgendaNudgeFeedback(quieted, {
      kind: 'quieted',
      now: 5500,
      reason: 'enable_quiet_mode_again',
      dedupeKey: 'proposal:aoi-proposal-ui-test-001',
    });
    expect(duplicateQuieted).toMatchObject({
      updatedAt: 5000,
      quietedCount: 1,
      lastFeedbackKind: 'quieted',
      lastFeedbackReason: 'enable_quiet_mode',
      lastDedupeKey: 'proposal:aoi-proposal-ui-test-001',
    });

    expect(
      selectAoiAgendaChatNudge({
        status: makeAutonomyStatus(),
        activeProposals: [proposal],
        settings: {
          panelExpanded: true,
          notificationsEnabled: true,
          quietMode: false,
          maxSuggestionsPerSession: 3,
          agendaNudgeCalibration: quieted,
        },
        options: {
          now: 6000,
        },
      }),
    ).toBeNull();

    const useful = recordAoiAgendaNudgeFeedback(quieted, {
      kind: 'useful',
      now: 7000,
      reason: 'review_approval_gate',
      dedupeKey: 'proposal:aoi-proposal-ui-test-001',
    });

    expect(useful.mutedUntil).toBeNull();
    expect(getAoiAgendaNudgeCalibrationGate(useful, 8000).suppressed).toBe(false);
    expect(
      selectAoiAgendaChatNudge({
        status: makeAutonomyStatus(),
        activeProposals: [proposal],
        settings: {
          panelExpanded: true,
          notificationsEnabled: true,
          quietMode: false,
          maxSuggestionsPerSession: 3,
          agendaNudgeCalibration: useful,
        },
        options: {
          now: 8000,
        },
      })?.reason,
    ).toBe('high_signal_proposal');
  });

  it('summarizes agenda nudge calibration for panel visibility and reset', () => {
    const emptySummary = buildAoiAgendaNudgeCalibrationPanelSummary(null, 5000);
    expect(emptySummary).toMatchObject({
      visible: true,
      statusLabel: 'untrained',
      tone: 'neutral',
      resetLabel: 'Nothing to reset',
      resetDisabled: true,
      resetTitle: 'No local agenda nudge feedback to reset',
      auditLabels: [],
    });
    const staleFeedbackAudit = {
      version: 1 as const,
      actionId: 'quiet_decision_nudges' as const,
      kind: 'quieted' as const,
      actionLabel: 'Quiet for now',
      reason: 'delivery decision silent/no candidate',
      dedupeKey: 'agenda-decision:silent:5000:no candidate',
      recordedAt: 5100,
      safetyBoundary:
        'Local delivery feedback only; no tools, app actions, policy bypass, or execution gates were run.',
    };
    const staleAuditSummary = buildAoiAgendaNudgeCalibrationPanelSummary(
      {
        panelExpanded: true,
        notificationsEnabled: true,
        quietMode: false,
        maxSuggestionsPerSession: 3,
        agendaNudgeCalibration: null,
        agendaNudgeReadinessLastDecisionFeedback: staleFeedbackAudit,
      },
      6000,
    );
    expect(staleAuditSummary).toMatchObject({
      statusLabel: 'untrained',
      resetLabel: 'Reset agenda nudge feedback',
      resetDisabled: false,
      resetTitle: 'Reset local agenda nudge feedback calibration and audit trail',
      evidenceRefs: ['agenda-feedback:audit-trail'],
    });
    expect(staleAuditSummary.reasonLabels.join(' ')).toContain('audit trail');
    expect(staleAuditSummary.auditLabels.join(' ')).toContain('Last feedback: Quiet for now');

    const quieted = recordAoiAgendaNudgeFeedback(null, {
      kind: 'quieted',
      now: 5000,
      reason: 'enable_quiet_mode',
      dedupeKey: 'proposal:aoi-proposal-ui-test-001',
    });
    const trainedFeedbackHistory = appendAoiAgendaNudgeDecisionFeedbackHistory(
      null,
      staleFeedbackAudit,
    );
    const mutedSummary = buildAoiAgendaNudgeCalibrationPanelSummary(
      {
        panelExpanded: true,
        notificationsEnabled: true,
        quietMode: false,
        maxSuggestionsPerSession: 3,
        agendaNudgeCalibration: quieted,
        agendaNudgeReadinessLastDecisionFeedback: staleFeedbackAudit,
        agendaNudgeReadinessDecisionFeedbackHistory: trainedFeedbackHistory,
      },
      6000,
    );

    expect(mutedSummary).toMatchObject({
      statusLabel: 'muted',
      tone: 'suppressed',
      resetLabel: 'Reset agenda nudge feedback',
      resetDisabled: false,
    });
    expect(mutedSummary.reasonLabels.join(' ')).toContain('quieted feedback');
    expect(mutedSummary.countLabels).toContain('1 quiet/noisy');
    expect(mutedSummary.auditLabels.join(' ')).toContain('Feedback trail');

    const useful = recordAoiAgendaNudgeFeedback(quieted, {
      kind: 'useful',
      now: 7000,
      reason: 'review_approval_gate',
      dedupeKey: 'proposal:aoi-proposal-ui-test-001',
    });
    const learningSummary = buildAoiAgendaNudgeCalibrationPanelSummary(
      {
        panelExpanded: true,
        notificationsEnabled: true,
        quietMode: false,
        maxSuggestionsPerSession: 3,
        agendaNudgeCalibration: useful,
      },
      8000,
    );

    expect(learningSummary).toMatchObject({
      statusLabel: 'learning',
      tone: 'learning',
      resetDisabled: false,
    });
    expect(learningSummary.summaryLabel).toContain('positive local feedback');
    expect(learningSummary.reasonLabels.join(' ')).toContain('No local suppression');
  });

  it('summarizes agenda nudge readiness gates before direct chat delivery', () => {
    const proposal = makeProposal({
      confidence: 0.96,
      evidenceRefs: ['research:aoi-research-ui-test/report', 'memory:re-interest'],
    });
    const baseSettings = {
      panelExpanded: true,
      notificationsEnabled: true,
      quietMode: false,
      maxSuggestionsPerSession: 3,
    };
    const readySummary = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: baseSettings,
      options: {
        now: 5000,
      },
    });

    expect(readySummary).toMatchObject({
      statusLabel: 'ready',
      tone: 'ready',
    });
    expect(readySummary.candidateLabel).toContain('high-signal proposal');
    expect(readySummary.deliveryDecisionLabels.join(' ')).toContain('Delivery: ready to speak');
    expect(readySummary.deliveryDecisionLabels.join(' ')).toContain('Next eligible: now');
    expect(readySummary.deliveryDecisionLabels.join(' ')).toContain('no tools');
    expect(readySummary.reasonLabels.join(' ')).toContain('gates all allow');
    expect(readySummary.evidenceRefs).toContain('memory:re-interest');
    expect(readySummary.actions).toEqual([]);
    expect(readySummary.decisionFeedbackActions).toEqual([]);
    const readyDeliveryAudit = buildAoiAgendaNudgeDeliveryDecisionAudit({
      summary: readySummary,
      now: 9000,
    });
    expect(readyDeliveryAudit).toMatchObject({
      state: 'ready',
      statusLabel: 'ready',
      recordedAt: 9000,
    });
    expect(readyDeliveryAudit.safetyBoundary).toContain('no tools');
    const auditedReadySummary = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: {
        ...baseSettings,
        agendaNudgeReadinessLastDecision: readyDeliveryAudit,
      },
      options: {
        now: 9500,
      },
    });
    expect(auditedReadySummary.lastDecisionLabels.join(' ')).toContain('Last decision: ready');
    expect(auditedReadySummary.lastDecisionLabels.join(' ')).toContain('Decision boundary');
    expect(auditedReadySummary.decisionFeedbackActions.map((action) => action.id)).toEqual([
      'mark_decision_useful',
      'mark_decision_too_much',
      'quiet_decision_nudges',
    ]);
    const tooMuchFeedback = auditedReadySummary.decisionFeedbackActions.find(
      (action) => action.id === 'mark_decision_too_much',
    )!;
    const noisyCalibration = recordAoiAgendaNudgeFeedback(null, {
      kind: tooMuchFeedback.kind,
      reason: tooMuchFeedback.reason,
      dedupeKey: tooMuchFeedback.dedupeKey,
      now: 9700,
    });
    expect(noisyCalibration.noisyCount).toBe(1);
    expect(noisyCalibration.lastFeedbackReason).toContain('delivery decision ready');
    expect(noisyCalibration.lastDedupeKey).toContain('agenda-decision:ready');
    expect(noisyCalibration.mutedUntil).toBeGreaterThan(9700);
    const tooMuchFeedbackAudit = buildAoiAgendaNudgeDecisionFeedbackAudit({
      action: tooMuchFeedback,
      now: 9800,
    });
    const duplicateFeedbackHistory = appendAoiAgendaNudgeDecisionFeedbackHistory(
      appendAoiAgendaNudgeDecisionFeedbackHistory(null, tooMuchFeedbackAudit),
      tooMuchFeedbackAudit,
    );
    expect(duplicateFeedbackHistory).toHaveLength(1);
    const usefulFeedback = auditedReadySummary.decisionFeedbackActions.find(
      (action) => action.id === 'mark_decision_useful',
    )!;
    const usefulFeedbackAudit = buildAoiAgendaNudgeDecisionFeedbackAudit({
      action: usefulFeedback,
      now: 9900,
    });
    const feedbackHistory = appendAoiAgendaNudgeDecisionFeedbackHistory(
      duplicateFeedbackHistory,
      usefulFeedbackAudit,
    );
    const feedbackAuditedReadySummary = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: {
        ...baseSettings,
        agendaNudgeReadinessLastDecision: readyDeliveryAudit,
        agendaNudgeReadinessLastDecisionFeedback: tooMuchFeedbackAudit,
        agendaNudgeReadinessDecisionFeedbackHistory: feedbackHistory,
      },
      options: {
        now: 9900,
      },
    });
    expect(feedbackAuditedReadySummary.lastDecisionFeedbackLabels.join(' ')).toContain('Too much');
    expect(feedbackAuditedReadySummary.decisionFeedbackHistoryLabels.join(' ')).toContain(
      '2 recent calibration',
    );
    expect(feedbackAuditedReadySummary.decisionFeedbackHistoryLabels.join(' ')).toContain('Useful');
    expect(
      feedbackAuditedReadySummary.decisionFeedbackActions.find(
        (action) => action.id === 'mark_decision_too_much',
      )?.disabled,
    ).toBe(true);
    expect(
      feedbackAuditedReadySummary.decisionFeedbackActions.find(
        (action) => action.id === 'mark_decision_useful',
      )?.disabled,
    ).toBe(false);
    const resetFeedbackSummary = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: {
        ...baseSettings,
        agendaNudgeReadinessLastDecision: readyDeliveryAudit,
        agendaNudgeCalibration: noisyCalibration,
        agendaNudgeReadinessLastDecisionFeedback: tooMuchFeedbackAudit,
        agendaNudgeReadinessDecisionFeedbackHistory: feedbackHistory,
        ...buildAoiAgendaNudgeFeedbackResetPatch(),
      },
      options: {
        now: 10000,
      },
    });
    expect(resetFeedbackSummary.lastDecisionLabels.join(' ')).toContain('Last decision: ready');
    expect(resetFeedbackSummary.lastDecisionFeedbackLabels).toEqual([]);
    expect(resetFeedbackSummary.decisionFeedbackHistoryLabels).toEqual([]);
    expect(
      resetFeedbackSummary.decisionFeedbackActions.find(
        (action) => action.id === 'mark_decision_too_much',
      )?.disabled,
    ).toBe(false);

    const notificationSummary = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: {
        ...baseSettings,
        notificationsEnabled: false,
      },
      options: {
        now: 5000,
      },
    });
    expect(notificationSummary).toMatchObject({
      statusLabel: 'notifications off',
      tone: 'blocked',
    });
    expect(notificationSummary.deliveryDecisionLabels.join(' ')).toContain('Delivery: blocked');
    expect(notificationSummary.nextActionLabels.join(' ')).toContain('Turn on');
    expect(notificationSummary.actions.map((action) => action.id)).toEqual([
      'enable_notifications',
    ]);
    const notificationAudit = buildAoiAgendaNudgeReadinessActionAudit({
      action: notificationSummary.actions[0],
      summary: notificationSummary,
      now: 7000,
    });
    expect(notificationAudit).toMatchObject({
      actionId: 'enable_notifications',
      actionLabel: 'Enable notifications',
      statusBefore: 'notifications off',
    });
    expect(notificationAudit.safetyBoundary).toContain('no tools');
    expect(notificationAudit.safetyBoundary).toContain('policy bypass');

    const auditedNotificationSummary = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: {
        ...baseSettings,
        notificationsEnabled: false,
        agendaNudgeReadinessLastAction: notificationAudit,
      },
      options: {
        now: 8000,
      },
    });
    expect(auditedNotificationSummary.lastActionLabels.join(' ')).toContain('Enable notifications');
    expect(auditedNotificationSummary.lastActionLabels.join(' ')).toContain(
      'Local readiness recovery only',
    );

    const quietSummary = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: {
        ...baseSettings,
        quietMode: true,
      },
      options: {
        now: 5000,
      },
    });
    expect(quietSummary).toMatchObject({
      statusLabel: 'quiet mode',
      tone: 'blocked',
    });
    expect(quietSummary.actions.map((action) => action.id)).toEqual(['disable_quiet_mode']);

    const capSummary = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: {
        ...baseSettings,
        maxSuggestionsPerSession: 0,
      },
      options: {
        now: 5000,
      },
    });
    expect(capSummary).toMatchObject({
      statusLabel: 'session cap',
      tone: 'blocked',
    });
    expect(capSummary.actions.map((action) => action.id)).toEqual(['raise_session_cap']);

    const quieted = recordAoiAgendaNudgeFeedback(null, {
      kind: 'quieted',
      now: 5000,
      reason: 'enable_quiet_mode',
      dedupeKey: 'proposal:aoi-proposal-ui-test-001',
    });
    const mutedSummary = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: {
        ...baseSettings,
        agendaNudgeCalibration: quieted,
      },
      options: {
        now: 6000,
      },
    });
    expect(mutedSummary).toMatchObject({
      statusLabel: 'muted',
      tone: 'blocked',
    });
    expect(mutedSummary.actions.map((action) => action.id)).toEqual(['reset_feedback_mute']);

    const cooldownSummary = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: baseSettings,
      options: {
        now: 6000,
        lastShownAt: 5000,
      },
    });
    expect(cooldownSummary).toMatchObject({
      statusLabel: 'cooling down',
      tone: 'waiting',
    });
    expect(cooldownSummary.candidateLabel).toContain('high-signal proposal');
    expect(cooldownSummary.deliveryDecisionLabels.join(' ')).toContain('Delivery: silent');
    expect(cooldownSummary.deliveryDecisionLabels.join(' ')).toContain('Next eligible:');
    expect(cooldownSummary.reasonLabels.join(' ')).toContain('Cooldown remaining');
    expect(cooldownSummary.actions.map((action) => action.id)).toEqual(['refresh_autonomy']);

    const noCandidateDuringCooldown = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [],
      settings: baseSettings,
      options: {
        now: 6000,
        lastShownAt: 5000,
      },
    });
    expect(noCandidateDuringCooldown).toMatchObject({
      statusLabel: 'no candidate',
      tone: 'waiting',
    });
    expect(noCandidateDuringCooldown.deliveryDecisionLabels.join(' ')).toContain(
      'Delivery: silent',
    );
    expect(noCandidateDuringCooldown.actions.map((action) => action.id)).toEqual([
      'run_check',
      'refresh_autonomy',
    ]);

    const dedupeSummary = buildAoiAgendaNudgeReadinessPanelSummary({
      status: makeAutonomyStatus(),
      activeProposals: [proposal],
      settings: baseSettings,
      options: {
        now: 5000,
        shownDedupeKeys: new Set(['proposal:aoi-proposal-ui-test-001']),
      },
    });
    expect(dedupeSummary).toMatchObject({
      statusLabel: 'already shown',
      tone: 'waiting',
    });
    expect(dedupeSummary.deliveryDecisionLabels.join(' ')).toContain('different proposal');
    expect(dedupeSummary.reasonLabels.join(' ')).toContain('Duplicate protection');
    expect(dedupeSummary.actions.map((action) => action.id)).toEqual(['run_check']);
  });

  it('keeps proposal inspector evidence refs opt-in', () => {
    const proposal = makeProposal({
      acceptAction: {
        kind: 'read_research_artifact',
        params: { artifact: 'report' },
      },
      evidenceRefs: ['memory:aoi-memory-ui-test', 'research:aoi-research-ui-test/report'],
      suggestedTools: ['read_research_artifact'],
    });
    const collapsed = buildAoiProposalInspectorSummary({
      proposal,
      policy: makePolicy(),
      activeProposals: [makeProposal({ id: 'aoi-proposal-duplicate' })],
      includeEvidence: false,
      now: 4000,
    });
    const expanded = buildAoiProposalInspectorSummary({
      proposal,
      policy: makePolicy(),
      activeProposals: [makeProposal({ id: 'aoi-proposal-duplicate' })],
      includeEvidence: true,
      now: 4000,
    });

    expect(collapsed.evidenceRefs).toEqual([]);
    expect(expanded.evidenceRefs).toEqual(proposal.evidenceRefs);
    expect(collapsed.suggestedAction).toBe('read_research_artifact');
    expect(collapsed.policyAllowed).toBe(false);
    expect(collapsed.policyReasons).toContain('duplicate_active_proposal');
  });

  it('builds recovery preview summaries with retry and non-goal details', () => {
    const proposal = makeProposal({
      trigger: 'failure_recovery',
      recoveryPreview: {
        version: 1,
        failureKind: 'kira_validation_failed',
        rootCauseSummary: 'Observed validation failed signal from Kira.',
        evidenceRefs: ['memory:kira-failed-001'],
        proposedAction: {
          kind: 'prepare_kira_followup',
          label: 'Prepare Kira follow-up',
          reason: 'Target validation evidence only.',
        },
        whyNarrowerOrSafer: 'Bounded to one failed Kira work item.',
        retryCount: 1,
        maxRetryCount: 2,
        cooldownActive: true,
        cooldownUntil: 2000,
        sourceRef: 'memory:kira-failed-001',
        failureSignature: 'failure:kira_validation_failed:test',
        nonGoals: ['Do not create broad Kira work that fixes everything at once.'],
      },
    });

    const summary = buildAoiRecoveryPreviewSummary(proposal, true);

    expect(summary).toMatchObject({
      visible: true,
      failureKind: 'kira validation failed',
      proposedActionLabel: 'Prepare Kira follow-up',
      retryLabel: '1/2 retries used',
    });
    expect(summary.cooldownLabel).toContain('cooldown active');
    expect(summary.evidenceRefs).toEqual(['memory:kira-failed-001']);
    expect(summary.nonGoals[0]).toContain('Do not create broad Kira work');
  });

  it('persists conservative panel notification settings', () => {
    const storage = new Map<string, string>();
    const storageAdapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };
    const feedbackHistory = Array.from({ length: 7 }, (_, index) => ({
      version: 1 as const,
      actionId: 'quiet_decision_nudges' as const,
      kind: 'quieted' as const,
      actionLabel: 'Quiet for now',
      reason: `delivery decision silent/no candidate ${index}`,
      dedupeKey: `agenda-decision:silent:${7200 + index}:no candidate`,
      recordedAt: 7200 + index,
      safetyBoundary:
        'Local delivery feedback only; no tools, app actions, policy bypass, or execution gates were run.',
    }));
    const governorAuditTrail = {
      version: 1 as const,
      updatedAt: 7300,
      events: [
        {
          version: 1 as const,
          id: 'aoi-jarvis-governor-audit-aoi-default-7300',
          dedupeKey: 'aoi/default|direct_chat|allow-direct-chat',
          kind: 'mode_change' as const,
          sessionPath: 'aoi/default',
          decisionId: 'aoi-jarvis-governor-aoi-default-7300',
          previousDecisionId: 'aoi-jarvis-governor-aoi-default-7200',
          recordedAt: 7300,
          mode: 'direct_chat' as const,
          modeLabel: 'Direct chat',
          previousMode: 'proactive_brief' as const,
          previousModeLabel: 'Proactive brief',
          allowedCapabilityLabels: ['Observe sources', 'Direct chat'],
          blockedCapabilityLabels: ['Approved command'],
          blockerLabels: ['Command execution waits for approval.'],
          whyNotJarvisYetLabels: ['Execution remains approval-gated.'],
          nextUpgradeAction: 'Collect review evidence before approval execution.',
          evidenceRefs: ['governor-mode:direct_chat'],
          safetyBoundary:
            'Governor audit is display-only; it records decisions but does not run tools, app actions, policy bypasses, or command execution.',
          actionAuthority: 'display_only' as const,
          mutationCount: 0 as const,
        },
      ],
      actionAuthority: 'display_only' as const,
      mutationCount: 0 as const,
    };
    const governorAuditLastReset = {
      version: 1 as const,
      id: 'aoi-jarvis-governor-audit-reset-aoi-default-7400',
      recordedAt: 7400,
      sessionPath: 'aoi/default',
      droppedEventCount: 1,
      snapshotDecisionId: 'aoi-jarvis-governor-aoi-default-7300',
      snapshotMode: 'direct_chat' as const,
      snapshotModeLabel: 'Direct chat',
      reason: 'Operator restarted the governor audit trail from the current snapshot.',
      safetyBoundary:
        'Governor audit reset is display-only; it clears local review history and records the current snapshot but does not run tools, app actions, policy bypasses, or command execution.',
      actionAuthority: 'display_only' as const,
      mutationCount: 0 as const,
    };

    const saved = saveAoiAutonomyPanelSettings(
      {
        panelExpanded: false,
        notificationsEnabled: true,
        quietMode: true,
        maxSuggestionsPerSession: 99,
        agendaNudgeReadinessLastAction: {
          version: 1,
          actionId: 'disable_quiet_mode',
          actionLabel: 'Leave quiet mode',
          recordedAt: 7000,
          statusBefore: 'quiet mode',
          candidateBefore: '1 active, 0 blocked, 0 approval',
          safetyBoundary:
            'Local readiness recovery only; no tools, app actions, policy bypass, or execution gates were run.',
        },
        agendaNudgeReadinessLastDecision: {
          version: 1,
          recordedAt: 7100,
          state: 'silent',
          statusLabel: 'no candidate',
          candidateLabel: '0 active, 0 blocked, 0 approval',
          summaryLabel: 'Aoi is allowed to speak, but no agenda item currently qualifies.',
          decisionLabels: [
            'Delivery: silent. Aoi is allowed to speak, but no agenda item currently qualifies.',
            'Boundary: direct agenda delivery only; no tools, app actions, policy bypass, or execution gates run from this decision.',
          ],
          evidenceRefs: ['memory:agenda-decision'],
          safetyBoundary:
            'Local delivery decision audit only; no tools, app actions, policy bypass, or execution gates were run.',
        },
        agendaNudgeReadinessLastDecisionFeedback: {
          version: 1,
          actionId: 'quiet_decision_nudges',
          kind: 'quieted',
          actionLabel: 'Quiet for now',
          reason: 'delivery decision silent/no candidate',
          dedupeKey: 'agenda-decision:silent:7100:no candidate',
          recordedAt: 7200,
          safetyBoundary:
            'Local delivery feedback only; no tools, app actions, policy bypass, or execution gates were run.',
        },
        agendaNudgeReadinessDecisionFeedbackHistory: feedbackHistory,
        jarvisAutonomyGovernorAuditTrail: governorAuditTrail,
        jarvisAutonomyGovernorAuditLastReset: governorAuditLastReset,
      },
      storageAdapter,
    );

    expect(saved).toMatchObject({
      panelExpanded: false,
      notificationsEnabled: true,
      quietMode: true,
      maxSuggestionsPerSession: 12,
      agendaNudgeReadinessLastAction: {
        actionId: 'disable_quiet_mode',
        actionLabel: 'Leave quiet mode',
        recordedAt: 7000,
      },
      agendaNudgeReadinessLastDecision: {
        state: 'silent',
        statusLabel: 'no candidate',
        recordedAt: 7100,
        evidenceRefs: ['memory:agenda-decision'],
      },
      agendaNudgeReadinessLastDecisionFeedback: {
        actionId: 'quiet_decision_nudges',
        kind: 'quieted',
        recordedAt: 7200,
        dedupeKey: 'agenda-decision:silent:7100:no candidate',
      },
      jarvisAutonomyGovernorAuditTrail: {
        updatedAt: 7300,
        actionAuthority: 'display_only',
        mutationCount: 0,
      },
      jarvisAutonomyGovernorAuditLastReset: {
        recordedAt: 7400,
        droppedEventCount: 1,
        snapshotMode: 'direct_chat',
        actionAuthority: 'display_only',
        mutationCount: 0,
      },
    });
    expect(saved.jarvisAutonomyGovernorAuditTrail?.events[0]).toMatchObject({
      kind: 'mode_change',
      mode: 'direct_chat',
      previousMode: 'proactive_brief',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(saved.jarvisAutonomyGovernorAuditLastReset).toMatchObject({
      snapshotDecisionId: 'aoi-jarvis-governor-aoi-default-7300',
      safetyBoundary: expect.stringContaining('display-only'),
    });
    expect(saved.agendaNudgeReadinessDecisionFeedbackHistory).toHaveLength(5);
    expect(saved.agendaNudgeReadinessDecisionFeedbackHistory?.[0]).toMatchObject({
      recordedAt: 7206,
      dedupeKey: 'agenda-decision:silent:7206:no candidate',
    });
    expect(saved.agendaNudgeReadinessDecisionFeedbackHistory?.[4]).toMatchObject({
      recordedAt: 7202,
      dedupeKey: 'agenda-decision:silent:7202:no candidate',
    });
    expect(storage.has(AOI_AUTONOMY_PANEL_SETTINGS_KEY)).toBe(true);
    expect(loadAoiAutonomyPanelSettings(storageAdapter)).toEqual(saved);
  });

  it('redacts local private paths from proposal display text', () => {
    expect(
      sanitizeAoiProposalDisplayText('Read F:\\kernullist\\YourOpenRoom\\private\\report.md now'),
    ).toBe('Read [local path] now');
  });

  it('redacts local paths and secrets from proactive explanations', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal({
        reason:
          'Read F:\\kernullist\\YourOpenRoom\\private\\report.md with api_key=secret-value before suggesting the next step.',
        body: 'Token ghp_1234567890abcdefghijkl should never be shown.',
      }),
      policy: makePolicy(),
      includeEvidence: true,
    });

    expect(explanation.messageSummary).toContain('[local path]');
    expect(explanation.messageSummary).toContain('api_key=[private secret]');
    expect(explanation.messageSummary).not.toContain('secret-value');
    expect(explanation.details.join(' ')).toContain('[private secret]');
    expect(explanation.details.join(' ')).not.toContain('ghp_1234567890abcdefghijkl');
  });

  it('redacts private environment source summaries and shows gated sources', () => {
    const summaries = buildAoiEnvironmentSourcePanelSummaries(makeEnvironmentSourceRegistry());
    const browser = summaries.find((summary) => summary.id === 'browser-context');
    const app = summaries.find((summary) => summary.id === 'app-state');
    const notes = summaries.find((summary) => summary.id === 'notes-metadata');

    expect(app).toMatchObject({
      enabled: true,
      canToggle: true,
      gateReason: 'Allowed for registry metadata only.',
    });
    expect(browser).toMatchObject({
      enabled: false,
      canToggle: false,
      riskLabel: 'high',
      privateLabel: 'private by default',
    });
    expect(browser?.label).toContain('[local path]');
    expect(browser?.consentSummary).toContain('api_key=[private secret]');
    expect(browser?.consentSummary).not.toContain('secret-value');
    expect(browser?.gateReason).toContain('source disabled');
    expect(browser?.toggleTitle).toContain('explicit target');
    expect(notes).toMatchObject({
      enabled: false,
      canToggle: true,
      canClear: false,
      privateLabel: 'private by default',
    });
    expect(notes?.metadataScopeLabel).toContain('note count');
    expect(notes?.willNotReadOrDoLabel).toContain('full note bodies');
    expect(notes?.gateReason).toContain('source consent review required');
    expect(notes?.toggleTitle).toContain('metadata scope');
  });

  it('redacts explicit browser context URLs before UI or prompt display', () => {
    const sanitized = sanitizeAoiContextUrl(
      'https://example.com/report?api_key=secret-value&token=abc#private-fragment',
    );

    expect(sanitized.urlHost).toBe('example.com');
    expect(sanitized.redactedUrl).toBe('https://example.com/report');
    expect(sanitized.redactedUrl).not.toContain('api_key');
    expect(sanitized.redactedUrl).not.toContain('secret-value');
    expect(sanitized.redactionState).toBe('redacted');
  });

  it('keeps routed context prompt blocks compact and evidence-backed', () => {
    const sources = Array.from({ length: 8 }, (_item, index) =>
      makeContextSource({
        id: `ctx-ui-test-${index}`,
        label: `Example page ${index}`,
        summary:
          'Metadata only. The router should not inject scraped content or private URL query strings.',
        evidenceRefs: [`browser:ctx-ui-test-${index}`],
      }),
    );
    const block = buildAoiContextPromptBlock(sources, {
      maxSources: 3,
      maxChars: 900,
    });

    expect(block.length).toBeLessThanOrEqual(900);
    expect(block.match(/Example page/g)?.length).toBe(3);
    expect(block).toContain('read-only context');
    expect(block).toContain('browser:ctx-ui-test-0');
  });

  it('summarizes selected context sources with feedback affordances', () => {
    const summaries = buildAoiContextSourcePanelSummaries(
      makeContextRouterResult([makeContextSource()]),
    );

    expect(summaries[0]).toMatchObject({
      sourceId: 'browser-context',
      displayNameLabel: 'Browser',
      scoreLabel: '91%',
      redactionLabel: 'redacted',
    });
    expect(summaries[0].wrongEvidenceTitle).toContain('wrong evidence');
    expect(summaries[0].wrongTimingTitle).toContain('wrong timing');
  });

  it('summarizes stale workspace validation as a recommendation without leaking local paths', () => {
    const summary = buildAoiWorkspaceSignalPanelSummary(
      makeWorkspaceSnapshot({
        workspaceLabel: 'F:\\kernullist\\YourOpenRoom',
        git: {
          version: 1,
          branchName: 'codex/aoi-workspace',
          previousBranchName: 'main',
          branchChanged: true,
          isDirty: true,
          changedFileCount: 1,
          stagedFileCount: 0,
          unstagedFileCount: 1,
          untrackedFileCount: 0,
          statusSummary: 'dirty: 1 changed, 0 staged',
          changedFiles: [
            {
              version: 1,
              pathLabel: 'F:\\kernullist\\YourOpenRoom\\private\\secret.ts',
              pathHash: 'changed',
              status: 'M',
              staged: false,
              unstaged: true,
              untracked: false,
              changedAt: 1000,
            },
          ],
        },
      }),
    );

    expect(summary).toMatchObject({
      visible: true,
      freshness: 'stale',
      recommendationTone: 'recommendation',
      recommendationLabel: 'Prepare the next safe validation check.',
    });
    expect(summary.evidenceRefs).toContain('workspace:validation:stale');
    expect(JSON.stringify(summary)).toContain('[local path]');
    expect(JSON.stringify(summary)).not.toContain('F:\\');
    expect(JSON.stringify(summary)).not.toContain('secret.ts');
  });

  it('keeps fresh workspace summaries neutral', () => {
    const summary = buildAoiWorkspaceSignalPanelSummary(
      makeWorkspaceSnapshot({
        git: {
          version: 1,
          branchName: 'main',
          branchChanged: false,
          isDirty: false,
          changedFileCount: 0,
          stagedFileCount: 0,
          unstagedFileCount: 0,
          untrackedFileCount: 0,
          statusSummary: 'clean',
          changedFiles: [],
        },
        validation: {
          version: 1,
          result: 'passed',
          completedAt: 1000,
          touchedFileScopes: ['apps/webuiapps/src'],
          freshness: 'fresh',
          evidenceRefs: [],
        },
        freshness: 'fresh',
      }),
    );

    expect(summary).toMatchObject({
      visible: true,
      freshness: 'fresh',
      recommendationTone: 'neutral',
      dirtyLabel: 'Working tree clean',
    });
  });

  it('builds short proactive message summaries with the full explanation contract', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal(),
      policy: makePolicy(),
    });

    expect(explanation).toMatchObject({
      whyNow: 'The current topic overlaps with a completed research run.',
      whatChanged: 'A research followup proposal is ready for review.',
      evidenceSummary: '1 evidence ref attached; details stay in the panel.',
      safeNextAction: 'Approve exact action',
      approvalBoundary: 'I will not run tools or change state without explicit approval.',
      evidenceRefs: [],
      evidenceCount: 1,
      risk: 'low',
    });
    expect(explanation.messageSummary).toMatchInlineSnapshot(
      `"Why now: The current topic overlaps with a completed research run. Changed: A research followup proposal is ready for review. Evidence: 1 evidence ref attached; details stay in the panel. Next: Approve exact action Boundary: I will not run tools or change state without explicit approval."`,
    );
    expect(explanation.messageSummary.length).toBeLessThan(360);
  });

  it('includes approval boundaries for high-risk proactive explanations', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal({
        risk: 'high',
        requiredAutonomyLevel: 'L5',
        requiresUserApproval: true,
        acceptAction: {
          kind: 'start_research',
          params: {
            query: 'high risk follow-up',
          },
        },
      }),
      policy: makePolicy({ level: 'L5' }),
    });

    expect(explanation.risk).toBe('high');
    expect(explanation.willNotDoWithoutApproval).toContain('explicit approval');
    expect(explanation.messageSummary).toContain('Boundary:');
  });

  it('explains Kira handoff boundaries without claiming direct file edits', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal({
        status: 'accepted',
        title: 'Create one reviewed Kira work item',
        trigger: 'goal_continuation',
        risk: 'medium',
        requiredAutonomyLevel: 'L4',
        requiresUserApproval: true,
        suggestedTools: ['create_kira_work'],
        evidenceRefs: ['goal:aoi-goal-ui-test', 'proposal:aoi-proposal-ui-test-001'],
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            title: 'Implement one reviewed follow-up',
          },
        },
      }),
      policy: makePolicy({ level: 'L4' }),
      hasKiraPreview: true,
    });

    expect(explanation.safeNextAction).toBe('Approve and create Kira work item');
    expect(explanation.willNotDoWithoutApproval).toContain('reviewed Kira work item');
    expect(explanation.willNotDoWithoutApproval).toContain('will not edit files');
    expect(explanation.messageSummary).toContain('Boundary:');
  });

  it('explains failed validation recovery as a narrow follow-up', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal({
        trigger: 'failure_recovery',
        title: 'Prepare Kira validation follow-up',
        reason: 'Kira validation failed and the recovery should target evidence only.',
        risk: 'medium',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['create_kira_work'],
        evidenceRefs: ['event:kira-validation-failed-001'],
        recoveryPreview: {
          version: 1,
          failureKind: 'kira_validation_failed',
          rootCauseSummary: 'Kira validation failed after review.',
          evidenceRefs: ['event:kira-validation-failed-001'],
          proposedAction: {
            kind: 'prepare_kira_followup',
            label: 'Prepare Kira follow-up',
            reason: 'Target validation evidence only.',
          },
          whyNarrowerOrSafer: 'Bounded to one failed validation item.',
          retryCount: 0,
          maxRetryCount: 2,
          cooldownActive: false,
          sourceRef: 'event:kira-validation-failed-001',
          failureSignature: 'failure:kira_validation_failed:test',
          nonGoals: ['Do not broaden scope.'],
        },
      }),
      policy: makePolicy({ level: 'L4' }),
    });

    expect(explanation.whatChanged).toContain('narrower recovery proposal');
    expect(explanation.messageSummary).toContain('Kira validation failed');
    expect(explanation.messageSummary).toContain('Boundary:');
  });

  it('avoids confident wording when evidence is weak', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal({
        confidence: 0.42,
        evidenceRefs: [],
        memoryIds: [],
        reason: 'The current topic might overlap with an older note.',
      }),
      policy: makePolicy(),
    });

    expect(explanation.lowEvidence).toBe(true);
    expect(explanation.confidenceLabel).toBe('low evidence');
    expect(explanation.messageSummary).toContain('Limited evidence');
    expect(explanation.messageSummary).not.toMatch(/\bready\b/i);
  });

  it('shows a narrowing alternative for broad Kira handoff policy blocks', () => {
    expect(
      getAoiSafeAlternativeForReasons(makeProposal({ requiredAutonomyLevel: 'L4' }), [
        'kira_handoff_scope_too_broad',
      ]),
    ).toContain('Narrow');
  });

  it('builds compact mission panel and prompt context', () => {
    const mission = makeMission();
    const collapsed = buildAoiMissionPanelSummary(mission);
    const expanded = buildAoiMissionPanelSummary(mission, true);
    const prompt = buildAoiMissionResumePrompt(mission);

    expect(collapsed).toMatchObject({
      visible: true,
      waitingOnLabel: 'research',
      evidenceRefs: [],
      canPause: true,
      canResume: false,
    });
    expect(expanded.evidenceRefs).toEqual(mission.evidenceRefs);
    expect(prompt).toContain('Aoi Mission Context');
    expect(prompt).toContain('research:aoi-research-ui-test');
    expect(prompt.length).toBeLessThan(900);
    expect(buildAoiMissionResumePrompt(makeMission({ status: 'completed' }))).toBe('');
  });

  it('maps proposal states to precise approval labels and mutation boundaries', () => {
    const acceptedKira = makeProposal({
      status: 'accepted',
      acceptAction: {
        kind: 'create_kira_work',
        params: {
          title: 'Implement one reviewed follow-up',
        },
      },
      suggestedTools: ['create_kira_work'],
      evidenceRefs: ['goal:aoi-goal-ui-test', 'proposal:aoi-proposal-ui-test-001'],
    });
    const previewOnly = buildAoiProposalActionPresentation(acceptedKira, {
      hasKiraPreview: false,
    });
    const finalKira = buildAoiProposalActionPresentation(acceptedKira, {
      hasKiraPreview: true,
    });
    const research = buildAoiProposalActionPresentation(
      makeProposal({
        status: 'accepted',
        acceptAction: {
          kind: 'start_research',
          params: {
            query: 'Windows kernel protection research',
          },
        },
      }),
    );
    const memory = buildAoiProposalActionPresentation(
      makeProposal({
        status: 'accepted',
        acceptAction: {
          kind: 'save_memory',
          params: {
            candidateId: 'memory-candidate-ui-test',
          },
        },
      }),
    );

    expect(previewOnly).toMatchObject({
      visibleState: 'preview_ready',
      primaryLabel: 'Preview plan',
      primaryRole: 'preview',
      requiresPreviewBeforeFinal: true,
      finalActionAvailable: false,
    });
    expect(finalKira.primaryLabel).toBe('Approve and create Kira work item');
    expect(finalKira.visibleState).toBe('waiting_for_approval');
    expect(finalKira.finalActionAvailable).toBe(true);
    expect(finalKira.mutationBoundary).toContain('Kira work item');
    expect(finalKira.mutationBoundary).toContain('does not edit files');
    expect(research.primaryLabel).toBe('Approve and start research run');
    expect(research.mutationBoundary).toContain('research run');
    expect(memory.primaryLabel).toBe('Approve and promote memory');
    expect(memory.mutationBoundary).toContain('untrusted skill draft');
  });

  it('summarizes prepared action plans without hiding risk, checkpoint, validation, or rollback', () => {
    const plan = buildAoiKiraHandoffPreparedActionPlan(
      makeProposal({
        status: 'accepted',
        risk: 'medium',
        requiredAutonomyLevel: 'L4',
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            projectName: 'YourOpenRoom',
            title: 'Implement reviewed action plan UI',
            objective: 'Implement one reviewed action plan UI change.',
            scope: ['Aoi autonomy UI'],
            modules: ['ChatPanel', 'aoiAutonomyUi'],
            validationCommands: [
              'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyUi.test.ts',
            ],
          },
        },
        suggestedTools: ['create_kira_work'],
        evidenceRefs: ['goal:aoi-goal-ui-test', 'proposal:aoi-proposal-ui-test-001'],
      }),
      { now: 2000 },
    );
    const collapsed = buildAoiPreparedActionPlanPanelSummary(plan);
    const expanded = buildAoiPreparedActionPlanPanelSummary(plan, true);

    expect(collapsed).toMatchObject({
      visible: true,
      statusLabel: 'ready',
      actionKindLabel: 'create kira work',
    });
    expect(collapsed.riskLabel).toContain('mutation capable');
    expect(collapsed.checkpointLabel).toContain('kira isolated worktree');
    expect(collapsed.validationLabel).toContain('approval before run');
    expect(collapsed.rollbackLabel).toContain('best_effort');
    expect(expanded.validationCommands.length).toBeGreaterThan(0);
    expect(expanded.rollbackInstructions.join(' ')).not.toMatch(/\bguaranteed\b/i);
  });

  it('shows blocked checkpoint state for high-risk preview-only file work', () => {
    const summary = buildAoiPreparedActionPlanPanelSummary(
      buildAoiPreviewOnlyFileWorkPreparedActionPlan({
        objective: 'Preview risky source edit',
        risk: 'high',
        affectedSurfaces: ['apps/webuiapps/src/lib/aoiAutonomyExecution.ts'],
        evidenceRefs: ['proposal:file-preview-ui-test'],
      }),
    );

    expect(summary.statusLabel).toBe('blocked');
    expect(summary.checkpointLabel).toContain('missing');
    expect(summary.blockers).toContain('missing_checkpoint_for_risky_mutation');
    expect(summary.rollbackLabel).toContain('none');
  });

  it('summarizes approved command preview and result details with cwd, risk, and output boundaries', () => {
    const blockedPolicy = evaluateAoiApprovedCommandPolicy(
      createAoiApprovedCommandRequest({
        sessionPath: 'aoi/default',
        command: 'Remove-Item src/lib/a.ts',
        cwd: '.',
        purpose: 'Validate Aoi changes.',
        risk: 'high',
        requestedAt: 2000,
      }),
    );
    const blocked = buildAoiApprovedCommandPanelSummary({ policy: blockedPolicy });

    expect(blocked).toMatchObject({
      visible: true,
      statusLabel: 'blocked',
      cwdLabel: 'workspace root',
    });
    expect(blocked.commandLabel).toContain('Remove-Item');
    expect(blocked.riskLabel).toContain('L5 approval');
    expect(blocked.reasonLabels.join(' ')).toContain('destructive file operation');

    const allowedPolicy = evaluateAoiApprovedCommandPolicy(
      createAoiApprovedCommandRequest({
        sessionPath: 'aoi/default',
        command:
          'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyUi.test.ts',
        cwd: '.',
        purpose: 'Validate UI helpers.',
        risk: 'high',
        requestedAt: 2000,
      }),
    );
    const passed = buildAoiApprovedCommandPanelSummary({
      policy: allowedPolicy,
      result: {
        version: 1,
        ok: true,
        command: allowedPolicy.command,
        cwdLabel: allowedPolicy.cwdLabel,
        exitCode: 0,
        timedOut: false,
        durationMs: 140,
        stdoutExcerpt: 'all tests passed',
        stderrExcerpt: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        auditRecord: {
          version: 1,
          id: 'aoi-command-ui-test',
          sessionPath: 'aoi/default',
          command: allowedPolicy.command,
          cwdLabel: allowedPolicy.cwdLabel,
          cwdHash: allowedPolicy.cwdHash,
          purpose: allowedPolicy.purpose,
          risk: allowedPolicy.risk,
          allowed: true,
          blockReasons: [],
          startedAt: 2000,
          completedAt: 2140,
          durationMs: 140,
          exitCode: 0,
          timedOut: false,
          stdoutExcerpt: 'all tests passed',
          stderrExcerpt: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidenceRefs: ['aoi-command-audit:aoi-command-ui-test'],
          approvalFingerprint: allowedPolicy.approvalFingerprint,
        },
        evidenceRefs: ['aoi-command-audit:aoi-command-ui-test'],
      },
      includeDetails: true,
    });

    expect(passed.statusLabel).toBe('passed');
    expect(passed.resultLabel).toContain('exit 0');
    expect(passed.stdoutExcerpt).toContain('all tests passed');
    expect(passed.evidenceRefs).toContain('aoi-command-audit:aoi-command-ui-test');
  });

  it('summarizes preference influence and conflict explanations without exposing private content', () => {
    const summary = buildAoiPreferenceInfluencePanelSummary({
      proposal: makeProposal({
        memoryIds: ['aoi-memory-ui-test'],
        evidenceRefs: ['memory:aoi-memory-ui-test'],
      }),
      memories: [
        makePreferenceMemory({
          content:
            'The user prefers Korean by default and keeps api_key=secret-value in F:\\kernullist\\YourOpenRoom\\private.txt. pref:response.language',
        }),
        makePreferenceMemory({
          id: 'aoi-memory-project-language',
          scope: 'project',
          projectKey: 'youropenroom',
          content:
            'For this project, public docs should be English first with api_key=secret-value from F:\\kernullist\\YourOpenRoom\\private.txt. pref:response.language',
          tags: ['preference', 'project-convention', 'pref:response.language'],
        }),
      ],
      projectKey: 'youropenroom',
      includeDetails: true,
      now: 3000,
    });

    expect(summary).toMatchObject({
      visible: true,
      statusLabel: 'conflict resolved',
    });
    expect(summary.preferenceLabels.join(' ')).toContain('project convention');
    expect(summary.conflictLabels.join(' ')).toContain('Project convention wins');
    expect(JSON.stringify(summary)).toContain('api_key=[private secret]');
    expect(JSON.stringify(summary)).toContain('[local path]');
    expect(JSON.stringify(summary)).not.toContain('secret-value');
    expect(JSON.stringify(summary)).not.toContain('F:\\');
    expect(summary.conflictLabels.join(' ').length).toBeLessThan(260);
  });

  it('does not expose generic Continue labels for risky final actions', () => {
    const riskyKinds = ['create_kira_work', 'start_research', 'save_memory'] as const;

    for (const kind of riskyKinds) {
      const presentation = buildAoiProposalActionPresentation(
        makeProposal({
          status: 'accepted',
          acceptAction: {
            kind,
            params: {},
          },
        }),
        {
          hasKiraPreview: kind === 'create_kira_work',
        },
      );

      expect(presentation.primaryLabel).not.toMatch(/\bcontinue\b/i);
      expect(presentation.primaryTitle).not.toMatch(/\bcontinue\b/i);
      expect(presentation.mutationBoundary).not.toMatch(/\bcontinue\b/i);
    }
  });

  it('exposes blocked policy reason, missing evidence, and safe alternative', () => {
    const summary = buildAoiBlockedStateSummary({
      proposal: makeProposal({
        status: 'blocked',
        blockedReason: 'missing_evidence_refs',
        evidenceRefs: [],
        acceptAction: {
          kind: 'create_kira_work',
          params: {},
        },
      }),
      reasons: ['missing_evidence_refs', 'kira_handoff_requires_accepted_proposal'],
    });

    expect(summary.policyReasons).toContain('missing_evidence_refs');
    expect(summary.missingEvidence).toContain('Evidence refs are missing.');
    expect(summary.missingEvidence).toContain(
      'An accepted proposal is required before Kira handoff.',
    );
    expect(summary.safeAlternative).toContain('Accept');
  });

  it('explains blocked proposals without exposing tool execution', () => {
    const explanation = buildAoiBlockedProactiveExplanation({
      blockedProposal: {
        proposalId: 'aoi-proposal-blocked-ui-test',
        title: 'Create broad Kira work',
        reasons: ['kira_handoff_scope_too_broad'],
        evidenceRefs: ['proposal:aoi-proposal-blocked-ui-test'],
        actionKind: 'create_kira_work',
        requiredAutonomyLevel: 'L4',
        requiresUserApproval: true,
        risk: 'high',
      },
      includeEvidence: true,
    });

    expect(explanation.messageSummary).toContain('Why now:');
    expect(explanation.messageSummary).toContain('Boundary:');
    expect(explanation.safeNextAction).toContain('Narrow');
    expect(explanation.willNotDoWithoutApproval).toContain('No tools run');
    expect(explanation.evidenceRefs).toEqual(['proposal:aoi-proposal-blocked-ui-test']);
  });

  it('uses explicit mission interrupt labels and visible states', () => {
    const delegated = buildAoiMissionPanelSummary(
      makeMission({
        status: 'waiting_on_kira',
        waitingOn: 'kira',
        sourceRefs: {
          goalRef: 'goal:aoi-goal-ui-test',
          kiraWorkRef: 'kira:aoi-kira-work-ui-test',
        },
      }),
    );
    const paused = buildAoiMissionPanelSummary(makeMission({ status: 'paused' }));

    expect(delegated.visibleState).toBe('delegated_to_kira');
    expect(delegated.pauseLabel).toBe('Pause this goal');
    expect(delegated.resumeLabel).toBe('Resume');
    expect(delegated.showEvidenceLabel).toBe('Show evidence');
    expect(paused.visibleState).toBe('paused');
    expect(paused.canResume).toBe(true);
  });

  it('dedupes related mission, Kira, and research digest items', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      mission: makeMission({
        sourceRefs: {
          goalRef: 'goal:aoi-goal-ui-test',
          proposalRef: 'proposal:aoi-proposal-ui-test-001',
          researchRunRef: 'research:aoi-research-ui-test',
          kiraWorkRef: 'memory:kira-related',
        },
        evidenceRefs: [
          'goal:aoi-goal-ui-test',
          'research:aoi-research-ui-test',
          'memory:kira-related',
        ],
      }),
      attentionEvents: [
        makeAttentionEvent({
          id: 'attention-research-ui-test',
          kind: 'research_completed',
          sourceRef: 'research:aoi-research-ui-test',
          evidenceRefs: ['research:aoi-research-ui-test'],
          summary: 'Research finished for the active mission.',
        }),
        makeAttentionEvent({
          id: 'attention-kira-ui-test',
          kind: 'kira_completed_reviewed_work',
          sourceRef: 'memory:kira-related',
          sourceSignature: 'memory:kira-related',
          evidenceRefs: ['memory:kira-related'],
          summary: 'Kira completed reviewed work for the active mission.',
        }),
      ],
    });

    const relatedItems = digest.items.filter(
      (item) =>
        item.evidenceRefs.includes('research:aoi-research-ui-test') ||
        item.evidenceRefs.includes('memory:kira-related'),
    );

    expect(relatedItems).toHaveLength(1);
    expect(relatedItems[0].evidenceRefs).toEqual(
      expect.arrayContaining(['research:aoi-research-ui-test', 'memory:kira-related']),
    );
  });

  it('suppresses low-value digest items in quiet mode while keeping blockers visible', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      workspaceSnapshot: makeWorkspaceSnapshot(),
      quietMode: true,
      blockedProposals: [
        {
          proposalId: 'aoi-proposal-blocked-ui-test',
          title: 'Create broad Kira work',
          reasons: ['kira_handoff_scope_too_broad'],
          evidenceRefs: ['proposal:aoi-proposal-blocked-ui-test'],
          actionKind: 'create_kira_work',
          requiredAutonomyLevel: 'L4',
          requiresUserApproval: true,
          risk: 'high',
          safeAlternative: 'Narrow the handoff scope before approval.',
        },
      ],
    });

    expect(digest.hiddenItemCount).toBeGreaterThan(0);
    expect(digest.items.some((item) => item.lane === 'hidden_by_quiet_mode')).toBe(true);
    expect(digest.items.some((item) => item.lane === 'critical_user_blocking')).toBe(true);
  });

  it('keeps approval inbox actions on the existing decision path', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      activeProposals: [
        makeProposal({
          risk: 'medium',
          suggestedTools: ['run_command'],
          evidenceRefs: ['proposal:aoi-proposal-ui-test-001', 'workspace:validation:stale'],
          acceptAction: {
            kind: 'run_command',
            params: {
              command: 'pnpm --filter @openroom/webuiapps test',
              cwd: 'F:\\kernullist\\YourOpenRoom',
              purpose: 'Validate Aoi autonomy UI changes.',
            },
          },
        }),
      ],
    });

    expect(digest.approvalInbox).toHaveLength(1);
    expect(digest.approvalInbox[0].availableActions).toEqual([
      'approve',
      'dismiss',
      'snooze',
      'details',
    ]);
    expect(digest.approvalInbox[0].boundary).toContain('execution path');
    expect(JSON.stringify(digest.approvalInbox[0].availableActions)).not.toContain('execute');
  });

  it('builds a resume brief with an explicit safety boundary', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      mission: makeMission(),
      userIdleMs: 20 * 60 * 1000,
    });
    const panelSummary = buildAoiOperatorDigestPanelSummary(digest, true);

    expect(digest.resumeBrief?.visible).toBe(true);
    expect(digest.resumeBrief?.safetyBoundary).toContain('without explicit approval');
    expect(panelSummary.resumeBriefLabel).toContain('Boundary:');
  });

  it('does not build a resume brief for low-value FYI-only changes', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      workspaceSnapshot: makeWorkspaceSnapshot(),
      userIdleMs: 20 * 60 * 1000,
    });

    expect(digest.items.some((item) => item.lane === 'fyi')).toBe(true);
    expect(digest.resumeBrief).toBeUndefined();
  });

  it('speaks a critical blocker when TTS and category policy are enabled', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      blockedProposals: [
        {
          proposalId: 'aoi-proposal-blocked-ui-test',
          title: 'Kira handoff is blocked',
          reasons: ['needs narrower scope'],
          evidenceRefs: ['proposal:aoi-proposal-blocked-ui-test'],
          actionKind: 'create_kira_work',
          requiredAutonomyLevel: 'L4',
          requiresUserApproval: true,
          risk: 'high',
          safeAlternative: 'Narrow the handoff before approval.',
        },
      ],
    });
    const event = buildAoiOperatorVoiceEventFromDigest({ digest });
    const decision = decideAoiOperatorVoiceRender({
      sessionPath: 'aoi/default',
      event,
      policy: getDefaultAoiOperatorVoicePolicy(),
      ttsEnabled: true,
      now: 4000,
    });

    expect(event?.category).toBe('critical_blocker');
    expect(decision.status).toBe('spoken');
    expect(decision.shouldSpeak).toBe(true);
    expect(decision.spokenSummary).toContain('Nothing runs without explicit approval');
  });

  it('keeps low-value FYI voice events silent by default', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      attentionEvents: [
        makeAttentionEvent({
          kind: 'proposal_feedback_trust_changed',
          sourceRef: 'workspace:low-value',
          sourceSignature: 'workspace:low-value',
          evidenceRefs: ['workspace:low-value'],
          suggestedAttentionLevel: 'silent',
          summary: 'A low-value workspace metadata source changed.',
        }),
      ],
    });
    const event = buildAoiOperatorVoiceEventFromDigest({ digest });
    const decision = decideAoiOperatorVoiceRender({
      sessionPath: 'aoi/default',
      event,
      policy: getDefaultAoiOperatorVoicePolicy(),
      ttsEnabled: true,
      now: 4000,
    });

    expect(event?.category).toBe('fyi');
    expect(decision.status).toBe('disabled_category');
    expect(decision.shouldSpeak).toBe(false);
  });

  it('suppresses operator voice during an active quiet window', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      mission: makeMission({ status: 'blocked', waitingOn: 'user' }),
    });
    const event = buildAoiOperatorVoiceEventFromDigest({ digest, mission: makeMission() });
    const policy = getDefaultAoiOperatorVoicePolicy();
    const decision = decideAoiOperatorVoiceRender({
      sessionPath: 'aoi/default',
      event,
      policy: {
        ...policy,
        quietWindows: [
          {
            version: 1,
            enabled: true,
            reason: 'User is in quiet focus.',
            startedAt: 3000,
            endsAt: 5000,
          },
        ],
      },
      mission: makeMission({ status: 'blocked', waitingOn: 'user' }),
      ttsEnabled: true,
      now: 4000,
    });

    expect(decision.status).toBe('quiet_window');
    expect(decision.silentReason).toContain('quiet focus');
  });

  it('suppresses similar future voice events after too-much feedback', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      mission: makeMission({
        sourceRefs: {
          goalRef: 'goal:aoi-goal-ui-test',
          researchRunRef: 'research:too-noisy',
        },
        evidenceRefs: ['research:too-noisy'],
      }),
      attentionEvents: [
        makeAttentionEvent({
          id: 'attention-too-noisy-ui-test',
          sourceRef: 'research:too-noisy',
          sourceSignature: 'research:too-noisy',
          evidenceRefs: ['research:too-noisy'],
          summary: 'A research completion update is too noisy.',
        }),
      ],
    });
    const event = buildAoiOperatorVoiceEventFromDigest({ digest });
    const decision = decideAoiOperatorVoiceRender({
      sessionPath: 'aoi/default',
      event,
      policy: getDefaultAoiOperatorVoicePolicy(),
      mission: makeMission({
        sourceRefs: {
          goalRef: 'goal:aoi-goal-ui-test',
          researchRunRef: 'research:too-noisy',
        },
        evidenceRefs: ['research:too-noisy'],
      }),
      recentDecisions: [
        makeProposalDecision({
          cooldownKey: event?.dedupeKey ?? 'digest:research:too-noisy',
          feedbackCategory: 'too_much',
          evidenceRefs: ['research:too-noisy'],
        }),
      ],
      ttsEnabled: true,
      now: 4000,
    });

    expect(decision.status).toBe('duplicate');
    expect(decision.shouldSpeak).toBe(false);
  });

  it('suppresses similar digest and voice events through trust calibration', () => {
    const trustCalibrationProfile = buildAoiTrustCalibrationProfile({
      sessionPath: 'aoi/default',
      decisions: [
        makeProposalDecision({
          id: 'decision-digest-too-much-trust',
          proposalTrigger: 'research_outcome',
          feedbackCategory: 'too_much',
          action: 'snooze',
        }),
        makeProposalDecision({
          id: 'decision-voice-too-much-trust',
          proposalTrigger: 'completion_update',
          feedbackCategory: 'too_much',
          action: 'snooze',
        }),
      ],
      now: 5000,
    });
    const event = makeAttentionEvent({
      id: 'attention-trust-suppressed-ui-test',
      sourceRef: 'research:too-noisy-trust',
      sourceSignature: 'research:too-noisy-trust',
      evidenceRefs: ['research:too-noisy-trust'],
      summary: 'A research completion update should be quiet after calibration.',
    });
    const calibratedDigest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 5000,
      attentionEvents: [event],
      trustCalibrationProfile,
    });
    const baseDigest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 5000,
      attentionEvents: [event],
    });
    const voiceEvent = buildAoiOperatorVoiceEventFromDigest({ digest: baseDigest });
    const voiceDecision = decideAoiOperatorVoiceRender({
      sessionPath: 'aoi/default',
      event: voiceEvent,
      policy: getDefaultAoiOperatorVoicePolicy(),
      ttsEnabled: true,
      trustCalibrationProfile,
      now: 5000,
    });

    expect(calibratedDigest.items[0].lane).toBe('hidden_by_quiet_mode');
    expect(calibratedDigest.items[0].hidden).toBe(true);
    expect(voiceEvent?.category).toBe('completion_update');
    expect(voiceDecision.status).toBe('suppressed');
    expect(voiceDecision.reasons).toContain('trust_calibration_suppressed');
  });

  it('summarizes operator health limits without treating disabled personal sources as errors', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);
    const health = evaluateAoiOperatorHealth({
      sessionPath: 'aoi/default',
      registry,
      config: {
        tavilyConfigured: false,
        gmailConfigured: false,
        gmailConnected: false,
        kiraConfigured: true,
        kiraWorkerRouteConfigured: true,
        kiraReviewerRouteConfigured: true,
        voiceEnabled: false,
      },
      now: 2000,
    });
    const researchIssue = health.issues.find((issue) => issue.code === 'tavily_missing');
    const personalDisabled = health.issues.find((issue) => issue.code === 'gmail_source_disabled');
    const summary = buildAoiOperatorHealthPanelSummary(health, true);

    expect(health.overallStatus).toBe('limited');
    expect(researchIssue).toMatchObject({
      capability: 'research',
      severity: 'warning',
    });
    expect(researchIssue?.cannotKnow).toContain('Aoi cannot know fresh web evidence');
    expect(personalDisabled).toMatchObject({
      capability: 'personal_signals',
      severity: 'info',
    });
    expect(summary.recommendationLabels).toContain('Configure Tavily');
    expect(JSON.stringify(health)).not.toContain('apiKey');
  });

  it('reports stale validation as a workspace warning with an actionable recommendation', () => {
    const registry = withSourcePatch(
      getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000),
      'workspace-build',
      {
        enabled: true,
        lastObservedAt: 1900,
      },
    );
    const health = evaluateAoiOperatorHealth({
      sessionPath: 'aoi/default',
      registry,
      workspaceSnapshot: makeWorkspaceSnapshot({
        collectedAt: 2000,
        validation: {
          version: 1,
          command: 'pnpm test',
          result: 'passed',
          completedAt: 1500,
          touchedFileScopes: ['apps/webuiapps/src/lib'],
          freshness: 'stale',
          staleReason: 'workspace changed after validation',
          evidenceRefs: ['workspace:validation:stale'],
        },
        freshness: 'stale',
      }),
      config: {
        tavilyConfigured: true,
        kiraConfigured: true,
        kiraWorkerRouteConfigured: true,
        kiraReviewerRouteConfigured: true,
      },
      now: 2000,
    });
    const issue = health.issues.find((item) => item.code === 'validation_stale');

    expect(issue).toMatchObject({
      capability: 'workspace',
      severity: 'warning',
    });
    expect(issue?.recommendation.action).toBe('run_validation');
    expect(issue?.cannotKnow).toContain(
      'Aoi cannot know whether the current workspace still passes',
    );
  });

  it('builds compact playbook cards with boundaries and blocked prerequisites', () => {
    const playbook: AoiPlaybook = {
      version: 1,
      id: 'aoi-playbook-ui-test',
      sessionPath: 'aoi/default',
      title: 'Coordinate Kira validation',
      objective: 'Create Kira work, wait for review, then run approved validation.',
      status: 'blocked',
      createdAt: 1000,
      updatedAt: 2000,
      sourceRefs: ['proposal:aoi-proposal-ui-test-001'],
      evidenceRefs: ['proposal:aoi-proposal-ui-test-001', 'health:approved_commands:runner'],
      proposalId: 'aoi-proposal-ui-test-001',
      healthIssueRefs: ['health:approved_commands:runner'],
      blockedReasons: ['approved_commands:approved_command_runner_unavailable'],
      nextStepId: 'aoi-playbook-ui-test-step-02',
      nextRequiredDecision:
        'Resolve prerequisite: approved_commands:approved_command_runner_unavailable',
      steps: [
        {
          version: 1,
          id: 'aoi-playbook-ui-test-step-01',
          kind: 'inspect_context',
          title: 'Inspect context',
          summary: 'Review current context.',
          status: 'completed',
          dependsOn: [],
          evidenceRefs: ['timeline:context'],
          sourceRefs: ['proposal:aoi-proposal-ui-test-001'],
          resultSummary: 'Context reviewed.',
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
          refs: { proposalRef: 'proposal:aoi-proposal-ui-test-001' },
          updatedAt: 1500,
        },
        {
          version: 1,
          id: 'aoi-playbook-ui-test-step-02',
          kind: 'run_approved_command',
          title: 'Run approved validation command',
          summary: 'Run one exact command only after approval.',
          status: 'blocked',
          dependsOn: ['aoi-playbook-ui-test-step-01'],
          evidenceRefs: ['health:approved_commands:runner'],
          sourceRefs: ['proposal:aoi-proposal-ui-test-001'],
          blockedReasons: ['approved_commands:approved_command_runner_unavailable'],
          executionBoundary: {
            version: 1,
            mutationCapable: false,
            commandCapable: true,
            requiresApproval: true,
            requiredAutonomyLevel: 'L5',
            freshAcceptanceRequired: true,
            approver: 'user',
            existingGate: 'approved_command',
            canAutoRun: false,
            summary: 'Validation command execution requires fresh approval for the exact command.',
          },
          checkpointNotes: [],
          rollbackNotes: ['Validation-only command does not promise rollback.'],
          validationNotes: ['pnpm test'],
          refs: { proposalRef: 'proposal:aoi-proposal-ui-test-001' },
          updatedAt: 2000,
        },
      ],
      edges: [
        {
          version: 1,
          id: 'edge-aoi-playbook-ui-test',
          fromStepId: 'aoi-playbook-ui-test-step-01',
          toStepId: 'aoi-playbook-ui-test-step-02',
          kind: 'depends_on',
          evidenceRefs: ['proposal:aoi-proposal-ui-test-001'],
        },
      ],
    };

    const summary = buildAoiPlaybookPanelSummary(playbook, true);

    expect(summary.visible).toBe(true);
    expect(summary.tone).toBe('blocked');
    expect(summary.boundaryLabels[0]).toContain('fresh approval');
    expect(summary.boundaryLabels[0]).toContain('auto-run no');
    expect(summary.blockedPrerequisiteLabels).toContain(
      'approved_commands:approved_command_runner_unavailable',
    );
    expect(summary.nextDecisionLabel).toContain('Resolve prerequisite');
  });

  it('keeps health digest quiet unless the health state is user-blocking', () => {
    const warningHealth = evaluateAoiOperatorHealth({
      sessionPath: 'aoi/default',
      registry: getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000),
      config: {
        tavilyConfigured: false,
        kiraConfigured: true,
        kiraWorkerRouteConfigured: true,
        kiraReviewerRouteConfigured: true,
      },
      now: 2000,
    });
    const quietDigest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      operatorHealth: warningHealth,
      now: 2000,
    });
    const blockingDigest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      operatorHealth: makeBlockingHealth(),
      now: 2000,
    });

    expect(warningHealth.userBlockingIssueCount).toBe(0);
    expect(quietDigest.items.find((item) => item.kind === 'operator_health')).toBeUndefined();
    expect(blockingDigest.items.find((item) => item.kind === 'operator_health')).toMatchObject({
      lane: 'critical_user_blocking',
      kind: 'operator_health',
    });
  });

  it('represents replay evaluation failures without running replay at runtime', () => {
    const health = evaluateAoiOperatorHealth({
      sessionPath: 'aoi/default',
      registry: getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000),
      config: {
        tavilyConfigured: true,
        kiraConfigured: true,
        kiraWorkerRouteConfigured: true,
        kiraReviewerRouteConfigured: true,
      },
      replayScenarios: [
        {
          fixtureId: 'health-replay-failure',
          failed: true,
          summary: 'Fixture expected health silence but received a blocker.',
          evidenceRefs: ['replay:health-replay-failure'],
        },
      ],
      now: 2000,
    });
    const issue = health.issues.find((item) => item.code === 'replay_scenario_failed');

    expect(issue).toMatchObject({
      capability: 'replay_evaluation',
      severity: 'error',
    });
    expect(issue?.recommendation.action).toBe('review_replay');
  });

  it('keeps approval voice summaries free of execution implication', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      activeProposals: [
        makeProposal({
          risk: 'high',
          suggestedTools: ['run_command'],
          acceptAction: {
            kind: 'run_command',
            params: {
              command: 'pnpm --filter @openroom/webuiapps test',
              cwd: 'F:\\kernullist\\YourOpenRoom',
              purpose: 'Validate Aoi autonomy UI changes.',
            },
          },
        }),
      ],
    });
    const event = buildAoiOperatorVoiceEventFromDigest({ digest });
    const summary = event
      ? buildAoiOperatorVoiceSummary(event, getDefaultAoiOperatorVoicePolicy())
      : '';

    expect(event?.category).toBe('approval_required');
    expect(summary).toContain('Nothing runs without explicit approval');
    expect(summary.toLowerCase()).not.toContain('executed');
    expect(summary.toLowerCase()).not.toContain('running command');
    expect(summary).not.toContain('proposal:');
  });

  it('redacts personal metadata from spoken operator summaries unless voice scope allows it', () => {
    const policy = getDefaultAoiOperatorVoicePolicy();
    const summary = buildAoiOperatorVoiceSummary(
      {
        version: 1,
        id: 'aoi-voice-event-personal-ui-test',
        sessionPath: 'aoi/default',
        category: 'completion_update',
        interruptionLevel: 'mission',
        title: 'Calendar says private interview with Alice',
        whatChanged: 'Calendar metadata says private interview with Alice is imminent.',
        nextSafeAction: 'Review personal signal metadata in the dashboard.',
        risk: 'low',
        dedupeKey: 'digest:personal-signal:calendar_metadata',
        sourceRefs: ['personal-signal:calendar_metadata'],
        evidenceRefs: ['personal-signal:calendar_metadata'],
        createdAt: 4000,
        privateContent: true,
      },
      policy,
    );

    expect(summary).toContain('consented personal metadata signal');
    expect(summary).not.toContain('Alice');
    expect(summary).not.toContain('interview');
  });

  it('reduces and hides similar digest items after negative feedback', () => {
    const event = makeAttentionEvent({
      id: 'attention-noisy-ui-test',
      sourceRef: 'research:too-noisy',
      sourceSignature: 'research:too-noisy',
      evidenceRefs: ['research:too-noisy'],
      dedupeKey: 'attention:research_completed:research:too-noisy',
    });
    const baseDigest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      attentionEvents: [event],
      quietMode: true,
    });
    const reducedDigest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      attentionEvents: [event],
      quietMode: true,
      recentDecisions: [makeProposalDecision()],
    });
    const baseItem = baseDigest.items.find((item) =>
      item.sourceRefs.includes('research:too-noisy'),
    );
    const reducedItem = reducedDigest.items.find((item) =>
      item.sourceRefs.includes('research:too-noisy'),
    );

    expect(baseItem?.hidden).toBe(false);
    expect(reducedItem?.relevance).toBeLessThan(baseItem?.relevance ?? 0);
    expect(reducedItem?.lane).toBe('hidden_by_quiet_mode');
  });

  it('builds digest timeline events and a compact timeline panel summary', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 4000,
      attentionEvents: [
        makeAttentionEvent({
          id: 'attention-visible-ui-test',
          sourceRef: 'research:visible',
          sourceSignature: 'research:visible',
          evidenceRefs: ['research:visible'],
          summary: 'A useful research update is ready.',
        }),
      ],
      workspaceSnapshot: makeWorkspaceSnapshot(),
      quietMode: true,
    });
    const timelineInputs = buildAoiDigestTimelineEvents(digest);
    const hidden = timelineInputs.find((event) => event.kind === 'digest_item_hidden');
    const surfaced = timelineInputs.find((event) => event.kind === 'digest_item_surfaced');

    expect(hidden?.relatedRefs?.length).toBeGreaterThan(0);
    expect(surfaced?.evidenceRefs?.length).toBeGreaterThan(0);

    const timelineSummary: AoiOperatorTimelineSummary = {
      version: 1,
      sessionPath: 'aoi/default',
      newestMeaningfulEvents: [
        {
          version: 1,
          id: 'timeline-ui-test-001',
          sessionPath: 'aoi/default',
          kind: 'digest_item_surfaced',
          visibility: 'operator_visible',
          createdAt: 4000,
          title: surfaced?.title ?? 'Digest surfaced',
          summary: surfaced?.summary ?? 'Digest item surfaced.',
          redactionState: 'none',
          evidenceRefs: surfaced?.evidenceRefs ?? [],
          relatedRefs: surfaced?.relatedRefs ?? [],
        },
      ],
      newestEventAt: 4000,
      lastExportAt: 4500,
      lastExportRedactionCount: 3,
      totalEventCount: 4,
      exportedTraceCount: 1,
    };
    const panelSummary = buildAoiOperatorTimelinePanelSummary(timelineSummary);

    expect(panelSummary.visible).toBe(true);
    expect(panelSummary.summaryLabel).toBe('4 timeline events');
    expect(panelSummary.eventLabels[0]).toContain('digest item surfaced');
    expect(panelSummary.exportLabel).toContain('1970-01-01T00:00:04.500Z');
    expect(panelSummary.redactionLabel).toBe('3 privacy replacements');
  });

  it('builds an acceptance dashboard with all six panels and stable empty states', () => {
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      now: 5000,
    });

    expect(dashboard).toMatchObject({
      version: 1,
      sessionPath: 'aoi/default',
      answerLabel: 'Why did Aoi judge the situation this way?',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(dashboard.currentBrief).toMatchObject({
      visible: false,
      missionLabel: 'No mission focus yet',
      validationLabel: 'Validation unknown',
    });
    expect(dashboard.blindSpots.statusLabel).toBe('No known blind spots');
    expect(dashboard.nextSafeAction.boundaryLabel).toContain('no execution authority');
    expect(dashboard.whyQuiet.reasonLabels).toEqual(['No quiet suppression recorded']);
    expect(dashboard.pendingApproval.visible).toBe(false);
    expect(dashboard.replayHealth.builtInReplayLabel).toBe('No built-in replay report');
    expect(dashboard.jarvisReadiness.visible).toBe(false);
    expect(dashboard.jarvisAutonomyGovernor.visible).toBe(true);
    expect(dashboard.jarvisAutonomyGovernor.modeLabel).toBe('Observe only');
    expect(dashboard.capabilityAuthority.visible).toBe(true);
    expect(dashboard.capabilityAuthority.unauthorizedMutationCount).toBe(0);
  });

  it('shows capability broker app authority and blocked mutation evidence', () => {
    const kiraApp: AppDef = {
      appId: 18,
      appName: 'kira',
      displayName: 'Kira',
      route: '/kira',
      actions: [
        { name: 'OPEN_APP_WINDOW', description: 'Open Kira', params: [] },
        {
          name: 'APPLY_MODEL_SETTINGS',
          description: 'Persist Kira model settings',
          params: [],
        },
      ],
    };
    const brokerDecision = decideAoiCapabilityBrokerAuthority({
      appReference: 'kira',
      actionType: 'APPLY_MODEL_SETTINGS',
      requestedBand: 'execute',
      apps: [kiraApp],
      evidenceRefs: ['test:kira-settings-mutation'],
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      now: 5000,
      capabilityBrokerDecisions: [brokerDecision],
    });

    expect(dashboard.capabilityAuthority.visible).toBe(true);
    expect(dashboard.capabilityAuthority.statusLabel).toContain('broker decision');
    expect(dashboard.capabilityAuthority.decisionLabels.join(' ')).toContain(
      'kira:apply_model_settings',
    );
    expect(dashboard.capabilityAuthority.blockedReasonLabels.join(' ')).toContain(
      'approval_required',
    );
    expect(dashboard.capabilityAuthority.approvalRequirementLabels.join(' ')).toContain(
      'approval required',
    );
    expect(dashboard.capabilityAuthority.rollbackRequirementLabels.join(' ')).toContain(
      'rollback missing',
    );
    expect(dashboard.capabilityAuthority.mutationCount).toBe(0);
    expect(dashboard.capabilityAuthority.unauthorizedMutationCount).toBe(0);
  });

  it('uses mission memory to explain stale validation, pending external work, and approvals', () => {
    const approvalPolicy: AoiApprovedCommandPolicy = {
      version: 1,
      allowed: true,
      blockReasons: [],
      command: 'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyUi.test.ts',
      displayCommand:
        'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyUi.test.ts',
      program: 'pnpm',
      args: ['--filter', '@openroom/webuiapps', 'test'],
      cwd: 'apps/webuiapps',
      cwdLabel: 'apps/webuiapps',
      cwdHash: 'cwd-hash',
      purpose: 'Validate acceptance dashboard mission memory.',
      purposeHash: 'purpose-hash',
      risk: 'high',
      requiredAutonomyLevel: 'L5',
      timeoutMs: 120000,
      approvalFingerprint: 'approval-ui-mission-memory',
      expiresAt: 9000,
      rationale: ['Command execution requires renewed user approval.'],
    };
    const missionMemory = buildAoiMissionMemorySnapshot({
      sessionPath: 'aoi/default',
      mission: makeMission({
        sourceRefs: {
          goalRef: 'goal:aoi-goal-ui-test',
          researchRunRef: 'research:aoi-research-ui-test',
          validationRef: 'workspace:validation:stale',
        },
      }),
      workspaceSnapshot: makeWorkspaceSnapshot(),
      approvedCommandPolicies: [approvalPolicy],
      now: 6000,
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      missionMemory,
      now: 7000,
    });

    expect(dashboard.currentBrief.visible).toBe(true);
    expect(dashboard.currentBrief.statusLabel).toContain('mission memory stale');
    expect(dashboard.currentBrief.validationLabel).toContain('Validation stale');
    expect(dashboard.blindSpots.visible).toBe(true);
    expect(dashboard.blindSpots.blindSpotLabels.join(' ')).toContain('Validation is stale');
    expect(dashboard.nextSafeAction.actionLabel).toContain('Wait for external evidence');
    expect(dashboard.nextSafeAction.blockedReasonLabels).toContain('pending external evidence');
    expect(dashboard.pendingApproval.visible).toBe(true);
    expect(dashboard.pendingApproval.approvalLabels.join(' ')).toContain(
      'approval-ui-mission-memory',
    );
    expect(dashboard.evidenceRefs).toContain(`mission-memory:${missionMemory.id}`);
  });

  it('surfaces mission control runtime counts and top mission next action', () => {
    const missionControl = buildAoiMissionControlState({
      sessionPath: 'aoi/default',
      mission: makeMission({
        status: 'waiting_on_user',
        waitingOn: 'user',
        activeGoalId: 'aoi-goal-ui-approval',
        focusSummary: 'Polish the operator dashboard mission control panel.',
        nextRecommendedAction: {
          kind: 'wait_for_user',
          label: 'Wait for approval.',
          reason: 'Approval is required before validation can run.',
          ref: 'proposal:aoi-proposal-ui-approval',
        },
        sourceRefs: {
          goalRef: 'goal:aoi-goal-ui-approval',
          proposalRef: 'proposal:aoi-proposal-ui-approval',
        },
        evidenceRefs: ['goal:aoi-goal-ui-approval', 'proposal:aoi-proposal-ui-approval'],
      }),
      playbooks: [
        {
          version: 1,
          id: 'playbook-ui-mission-control',
          sessionPath: 'aoi/default',
          title: 'Mission control dashboard playbook',
          objective: 'Keep approval boundaries visible.',
          status: 'waiting',
          createdAt: 6000,
          updatedAt: 6000,
          sourceRefs: ['goal:aoi-goal-ui-approval'],
          evidenceRefs: ['playbook:ui-mission-control'],
          goalId: 'aoi-goal-ui-approval',
          missionRef: 'mission:aoi-goal-ui-approval',
          healthIssueRefs: [],
          blockedReasons: [],
          nextStepId: 'step-ui-approval',
          nextRequiredDecision: 'Ask for approval before validation.',
          steps: [
            {
              version: 1,
              id: 'step-ui-approval',
              kind: 'preview_command',
              title: 'Preview validation',
              summary: 'Preview the validation command only.',
              status: 'waiting_for_approval',
              dependsOn: [],
              evidenceRefs: ['playbook-step:ui-approval'],
              sourceRefs: ['goal:aoi-goal-ui-approval'],
              blockedReasons: [],
              executionBoundary: {
                version: 1,
                mutationCapable: false,
                commandCapable: true,
                requiresApproval: true,
                requiredAutonomyLevel: 'L5',
                freshAcceptanceRequired: true,
                approver: 'user',
                existingGate: 'approved_command',
                canAutoRun: false,
                summary: 'Validation command execution requires fresh approval.',
                approvalRef: 'command-approval:ui-mission-control',
              },
              checkpointNotes: [],
              rollbackNotes: [],
              validationNotes: ['pnpm --filter @openroom/webuiapps test'],
              refs: {
                goalRef: 'goal:aoi-goal-ui-approval',
                missionRef: 'mission:aoi-goal-ui-approval',
                commandAuditRef: 'command-approval:ui-mission-control',
              },
              updatedAt: 6000,
            },
          ],
          edges: [],
        },
      ],
      now: 7000,
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      missionControl,
      now: 8000,
    });

    expect(dashboard.missionControl.visible).toBe(true);
    expect(dashboard.missionControl.waitingApprovalCountLabel).toContain('1 waiting approval');
    expect(dashboard.currentBrief.statusLabel).toContain('mission control waiting on approval');
    expect(dashboard.nextSafeAction.actionLabel).toContain('approval');
    expect(dashboard.nextSafeAction.boundaryLabel).toContain('approval gates');
    expect(dashboard.pendingApproval.visible).toBe(true);
    expect(dashboard.pendingApproval.approvalLabels.join(' ')).toContain(
      'command-approval:ui-mission-control',
    );
    expect(dashboard.evidenceRefs).toContain(`mission-control:${missionControl.id}`);
  });

  it('shows disabled personal sources as blind spots without inferred private content', () => {
    const registry = makeEnvironmentSourceRegistry({
      sources: [
        {
          version: 1,
          id: 'gmail-metadata',
          kind: 'gmail_metadata',
          label: 'Gmail metadata for private-roadmap@example.com',
          enabled: false,
          scope: 'session',
          risk: 'medium',
          allowedOperations: ['read_metadata'],
          privateByDefault: true,
          quietModeBehavior: 'record_only',
          consentReason: 'Do not leak the mail body.',
          updatedAt: 5000,
        },
      ],
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      sourceRegistry: registry,
      now: 6000,
    });
    const serialized = JSON.stringify(dashboard);

    expect(dashboard.blindSpots.visible).toBe(true);
    expect(dashboard.blindSpots.blindSpotLabels.join(' ')).toContain('Gmail metadata');
    expect(dashboard.blindSpots.blindSpotLabels.join(' ')).toContain('disabled source');
    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('Do not leak the mail body');
    expect(serialized).not.toContain('mail body.');
  });

  it('shows source freshness contracts with disconnected and metadata-only boundaries', () => {
    let registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 6000);
    registry = withSourcePatch(registry, 'gmail-metadata', {
      enabled: true,
      lastReviewedAt: 5500,
      consentReason: 'Use Gmail metadata counts only when connected.',
    });
    registry = withSourcePatch(registry, 'calendar-metadata', {
      enabled: true,
      lastReviewedAt: 5500,
      consentReason: 'Use calendar title/time/reminder metadata only; body disabled.',
    });
    const contracts = buildAoiSourceFreshnessContracts({
      sourceRegistry: registry,
      personalMetadata: [
        {
          version: 1,
          sourceId: 'gmail-metadata',
          kind: 'gmail_metadata',
          label: 'Gmail metadata',
          displayName: 'Gmail',
          summary:
            'Gmail metadata: configured=true; connected=false; lastSync=never; cached=0; unread=0; folders=none; labels=none',
          relevanceText: 'gmail unread inbox metadata',
          evidenceRefs: ['personal-signal:gmail_metadata'],
          scoreReasons: ['gmail connection, sync, unread, folder, and label counts only'],
          updatedAt: 5900,
          freshness: 'fresh',
          confidence: 0.72,
          redactionState: 'redacted',
        },
        {
          version: 1,
          sourceId: 'calendar-metadata',
          kind: 'calendar_metadata',
          label: 'Calendar metadata',
          displayName: 'Calendar',
          summary:
            'Calendar metadata: 1 upcoming of 1; Validation deadline at 1970-01-01T02:00:00.000Z (reminder 15m).',
          relevanceText: 'calendar deadline metadata',
          evidenceRefs: ['personal-signal:calendar_metadata'],
          scoreReasons: ['calendar title, time, and reminder metadata only'],
          updatedAt: 5900,
          freshness: 'fresh',
          confidence: 0.76,
          redactionState: 'redacted',
        },
      ],
      now: 6000,
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      sourceRegistry: registry,
      sourceFreshnessContracts: contracts,
      now: 6000,
    });

    expect(dashboard.sourceFreshness.visible).toBe(true);
    expect(dashboard.sourceFreshness.disconnectedSourceLabels.join(' ')).toContain('Gmail');
    expect(dashboard.sourceFreshness.metadataOnlyBoundaryLabels.join(' ')).toContain(
      'Calendar metadata',
    );
    expect(dashboard.sourceFreshness.lastObservedLabels.join(' ')).toContain('Gmail metadata');
    expect(dashboard.blindSpots.blindSpotLabels.join(' ')).toContain(
      'not evidence of an empty inbox',
    );
  });

  it('surfaces real field capture evidence as a display-only acceptance dashboard panel', () => {
    const realFieldCapture = buildAoiRealFieldCapture({
      sessionPath: 'aoi/default',
      now: 6500,
      workspaceSnapshots: [
        makeWorkspaceSnapshot({
          collectedAt: 6400,
          freshness: 'fresh',
          validation: {
            version: 1,
            command: 'pnpm exec vitest run src/lib/__tests__/aoiRealFieldCapture.test.ts',
            result: 'passed',
            completedAt: 6400,
            touchedFileScopes: ['apps/webuiapps/src/lib'],
            freshness: 'fresh',
            evidenceRefs: ['workspace:real-field-validation'],
          },
          evidenceRefs: ['workspace:real-field-capture'],
        }),
      ],
      researchSignals: [
        {
          sessionPath: 'aoi/default',
          runId: 'research-stale-ui-panel',
          title: 'Stale RE trend research',
          summary: 'Stale research cannot support a current trend claim.',
          freshness: 'stale',
          completedAt: 1000,
          evidenceRefs: ['research:stale-ui-panel'],
          cannotKnow: ['Current state cannot be claimed from stale research.'],
          risk: 'medium',
        },
      ],
      personalMetadataSources: [
        {
          sessionPath: 'aoi/default',
          sourceId: 'gmail-metadata',
          label: 'Gmail metadata for private-roadmap@example.com',
          kind: 'gmail_metadata',
          consentState: 'disconnected',
          freshness: 'unknown',
          metadataSummary: 'Gmail connected=false; unread=unknown.',
          bodyPreview: 'body: private mail body should stay hidden.',
          observedAt: 6300,
          evidenceRefs: ['personal:gmail-metadata'],
          risk: 'medium',
        },
      ],
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      realFieldCapture,
      now: 7000,
    });
    const serialized = JSON.stringify(dashboard.realFieldCapture);

    expect(dashboard.realFieldCapture.visible).toBe(true);
    expect(dashboard.realFieldCapture.statusLabel).toContain('signal');
    expect(dashboard.realFieldCapture.signalLabels.join(' ')).toContain('workspace');
    expect(dashboard.realFieldCapture.blindSpotLabels.join(' ')).toContain('cannot claim current');
    expect(dashboard.realFieldCapture.hardFailLabels).toEqual([
      'private leaks 0',
      'unauthorized mutations 0',
      'stale current claims 0',
    ]);
    expect(dashboard.realFieldCapture.liveOperationLabels).toEqual([
      'shell 0',
      'network 0',
      'gmail 0',
      'calendar 0',
      'kira mutation 0',
    ]);
    expect(dashboard.realFieldCapture.evidenceRefs).toContain(
      `real-field-capture:${realFieldCapture.id}`,
    );
    expect(dashboard.evidenceRefs).toContain(`real-field-capture:${realFieldCapture.id}`);
    expect(dashboard.jarvisReadiness.visible).toBe(true);
    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('private mail body');
  });

  it('surfaces feedback compression adjustments without leaking private feedback notes', () => {
    const tooFrequent = createAoiOperatorFeedbackLabelAction({
      sessionPath: 'aoi/default',
      decisionRecordId: 'record-feedback-compression-ui',
      decisionId: 'decision-feedback-compression-ui',
      opportunityId: 'opportunity-feedback-compression-ui',
      topicKey: 'topic:reverse-engineering',
      sourceKey: 'browser_context',
      deliveryMode: 'direct_chat',
      label: 'too_frequent',
      sourceKinds: ['browser_context'],
      evidenceRefs: ['operator-feedback:too-frequent-ui'],
      note: 'body: private feedback note from private-roadmap@example.com',
      now: 7200,
    });
    const feedbackCompression = buildAoiFeedbackCompression({
      sessionPath: 'aoi/default',
      labelActions: [tooFrequent],
      now: 7300,
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      feedbackCompression,
      now: 7400,
    });
    const serialized = JSON.stringify(dashboard.feedbackCompression);

    expect(dashboard.feedbackCompression.visible).toBe(true);
    expect(dashboard.feedbackCompression.statusLabel).toContain('1 explicit label');
    expect(dashboard.feedbackCompression.timingAdjustmentLabels.join(' ')).toContain(
      'Timing tolerance decrease',
    );
    expect(dashboard.feedbackCompression.directChatLabel).toContain('Direct chat x');
    expect(dashboard.feedbackCompression.verbosityLabel).toContain('shorter');
    expect(dashboard.feedbackCompression.trustLabels.join(' ')).toContain(
      'explicit positive operator label required',
    );
    expect(dashboard.feedbackCompression.evidenceRefs).toContain(
      `feedback-compression:${feedbackCompression.id}`,
    );
    expect(dashboard.evidenceRefs).toContain(`feedback-compression:${feedbackCompression.id}`);
    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('private feedback note');
  });

  it('feeds personal source reality checks into dashboard and shadow hooks', () => {
    let registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 6000);
    registry = withSourcePatch(registry, 'calendar-metadata', {
      enabled: true,
      lastObservedAt: 5900,
      lastReviewedAt: 5800,
      consentReason: 'Use calendar title/time/reminder metadata only; body disabled.',
    });
    registry = withSourcePatch(registry, 'gmail-metadata', {
      enabled: true,
      lastReviewedAt: 5800,
      consentReason: 'Use Gmail metadata counts only when connected.',
    });
    const workspaceSnapshot = makeWorkspaceSnapshot({
      validation: {
        version: 1,
        command: 'pnpm --filter @openroom/webuiapps test',
        result: 'passed',
        completedAt: 1000,
        touchedFileScopes: ['apps/webuiapps/src/lib'],
        freshness: 'stale',
        staleReason: 'Relevant files changed after validation.',
        evidenceRefs: ['workspace:validation:stale'],
      },
      freshness: 'stale',
    });
    const health = evaluateAoiOperatorHealth({
      sessionPath: 'aoi/default',
      registry,
      workspaceSnapshot,
      config: {
        tavilyConfigured: true,
        gmailConfigured: true,
        gmailConnected: false,
        kiraConfigured: true,
        kiraWorkerRouteConfigured: true,
        kiraReviewerRouteConfigured: true,
      },
      now: 6000,
    });
    const metadata: AoiPersonalSignalMetadataSummary[] = [
      {
        version: 1,
        sourceId: 'calendar-metadata',
        kind: 'calendar_metadata',
        label: 'Calendar metadata',
        displayName: 'Calendar',
        summary:
          'Calendar metadata: title=Validation deadline; startAt=1970-01-01T02:00:00.000Z; reminder=15m; description=private launch plan body.',
        relevanceText: 'Deadline metadata overlaps stale workspace validation.',
        evidenceRefs: ['personal-signal:calendar_metadata'],
        scoreReasons: ['Title, time, and reminder metadata only.'],
        updatedAt: 5900,
        freshness: 'fresh',
        confidence: 0.78,
        redactionState: 'redacted',
      },
    ];
    const realityCheck = buildAoiPersonalSourceRealityCheck({
      sessionPath: 'aoi/default',
      now: 6000,
      sourceRegistry: registry,
      workspaceSnapshot,
      health,
      personalMetadata: metadata,
    });
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      personalSourceRealityCheck: realityCheck,
      now: 6100,
    });
    const shadowReport = evaluateAoiShadowDecisions({
      sessionPath: 'aoi/default',
      decisions,
      now: 6200,
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      workspaceSnapshot,
      health,
      sourceRegistry: registry,
      personalSourceRealityCheck: realityCheck,
      shadowReport,
      now: 6300,
    });
    const serialized = JSON.stringify(dashboard);

    expect(decisions.some((decision) => decision.kind === 'would_propose')).toBe(true);
    expect(decisions.some((decision) => decision.kind === 'would_mark_blind_spot')).toBe(true);
    expect(dashboard.currentBrief.visible).toBe(true);
    expect(dashboard.currentBrief.missionLabel).toContain('workspace validation is stale');
    expect(dashboard.blindSpots.visible).toBe(true);
    expect(dashboard.blindSpots.blindSpotLabels.join(' ')).toContain('Gmail');
    expect(dashboard.nextSafeAction.visible).toBe(true);
    expect(dashboard.nextSafeAction.actionLabel).toContain('preview');
    expect(dashboard.nextSafeAction.boundaryLabel).toContain('does not execute commands');
    expect(dashboard.replayHealth.visible).toBe(true);
    expect(dashboard.replayHealth.evidenceRefs).toContain(
      `personal-source-reality:${realityCheck.id}`,
    );
    expect(shadowReport.metrics.zeroMutation).toBe(true);
    expect(serialized).not.toContain('private launch plan body');
    expect(serialized).not.toContain('description=private');

    const failedRealityCheck = {
      ...realityCheck,
      metrics: [
        ...realityCheck.metrics,
        {
          version: 1 as const,
          id: 'personal-reality.body_access_violation.synthetic',
          kind: 'body_access_violation_count' as const,
          passed: false,
          value: 1,
          numerator: 1,
          denominator: 1,
          summary: 'Synthetic personal source reality failure.',
          evidenceRefs: ['personal-source-reality:synthetic-failure'],
        },
      ],
    };
    const failedRealityDashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      personalSourceRealityCheck: failedRealityCheck,
      now: 6400,
    });

    expect(failedRealityDashboard.replayHealth.visible).toBe(true);
    expect(failedRealityDashboard.replayHealth.failedMetricIds).toContain(
      'personal-reality.body_access_violation.synthetic',
    );
  });

  it('explains quiet suppression from shadow decisions and digest evidence', () => {
    const digest = {
      version: 1 as const,
      sessionPath: 'aoi/default',
      generatedAt: 6000,
      summary: 'A low-value FYI was suppressed.',
      quietWindow: {
        version: 1 as const,
        enabled: true,
        reason: 'Recent too-much feedback suppresses similar FYI updates.',
        startedAt: 5500,
        hiddenLane: 'hidden_by_quiet_mode' as const,
      },
      items: [
        {
          version: 1 as const,
          id: 'digest-quiet-dashboard',
          kind: 'source_change' as const,
          lane: 'hidden_by_quiet_mode' as const,
          title: 'FYI suppressed',
          summary: 'A low-value FYI matched recent too-much feedback.',
          nextSafeAction: 'Stay quiet and keep the evidence in the dashboard.',
          risk: 'low' as const,
          relevance: 0.3,
          createdAt: 6000,
          dedupeKey: 'quiet-dashboard-too-much',
          sourceRefs: ['digest:fyi'],
          evidenceRefs: ['feedback:too-much-dashboard'],
          hidden: true,
        },
      ],
      approvalInbox: [],
      laneCounts: {
        critical_user_blocking: 0,
        needs_approval: 0,
        mission_update: 0,
        fyi: 0,
        hidden_by_quiet_mode: 1,
      },
      hiddenItemCount: 1,
      evidenceRefs: ['feedback:too-much-dashboard'],
    };
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      now: 6000,
    });
    const shadowReport = evaluateAoiShadowDecisions({
      sessionPath: 'aoi/default',
      decisions,
      now: 7000,
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      digest,
      shadowReport,
      now: 8000,
    });

    expect(dashboard.whyQuiet.visible).toBe(true);
    const quietReasons = dashboard.whyQuiet.reasonLabels.join(' ').toLowerCase();
    expect(quietReasons).toContain('quiet');
    expect(quietReasons).toContain('too-much');
    expect(dashboard.whyQuiet.quietDecisionRefs[0]).toContain('shadow-decision:');
    expect(dashboard.whyQuiet.evidenceRefs).toContain('feedback:too-much-dashboard');
  });

  it('summarizes operator feedback inbox counts and source review pressure', () => {
    const digest = {
      version: 1 as const,
      sessionPath: 'aoi/default',
      generatedAt: 6000,
      summary: 'Browser source needs field review.',
      items: [
        {
          version: 1 as const,
          id: 'digest-feedback-dashboard',
          kind: 'source_change' as const,
          lane: 'mission_update' as const,
          title: 'Browser context selected',
          summary:
            'Browser metadata mentioned private-roadmap@example.com and C:\\Users\\secret\\note.txt.',
          nextSafeAction: 'Ask whether browser context is relevant before speaking.',
          risk: 'medium' as const,
          relevance: 0.67,
          createdAt: 6000,
          dedupeKey: 'feedback-dashboard-browser',
          sourceRefs: ['browser-context'],
          evidenceRefs: ['environment-source:browser-context'],
          hidden: false,
        },
      ],
      approvalInbox: [],
      laneCounts: {
        critical_user_blocking: 0,
        needs_approval: 0,
        mission_update: 1,
        fyi: 0,
        hidden_by_quiet_mode: 0,
      },
      hiddenItemCount: 0,
      evidenceRefs: ['environment-source:browser-context'],
    };
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      now: 6100,
    });
    const fieldReport = buildAoiFieldShadowRecordReport({
      sessionPath: 'aoi/default',
      decisions,
      now: 6200,
    });
    const inbox = buildAoiOperatorFeedbackInbox({
      sessionPath: 'aoi/default',
      fieldShadowReport: fieldReport,
      now: 6300,
    });
    const browserItem = inbox.items.find((item) => item.sourceKinds.includes('browser_context'));
    if (!browserItem) {
      throw new Error('Expected browser feedback inbox item.');
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
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      feedbackInbox: labeledInbox,
      now: 6600,
    });
    const serialized = JSON.stringify(dashboard.feedbackInbox);

    expect(dashboard.feedbackInbox.visible).toBe(true);
    expect(dashboard.feedbackInbox.inboxCountLabel).toContain('field feedback');
    expect(dashboard.feedbackInbox.unlabeledCountLabel).toContain('0 unlabeled');
    expect(dashboard.feedbackInbox.labelDistributionLabels.join(' ')).toContain('wrong source 1');
    expect(dashboard.feedbackInbox.topSourceKindLabels.join(' ')).toContain('browser context');
    expect(dashboard.feedbackInbox.calibrationInputLabel).toContain('1 calibration');
    expect(dashboard.feedbackInbox.promotionCandidateLabel).toContain('1 promotion');
    expect(dashboard.feedbackInbox.itemLabels[0]?.whatAoiNoticedLabel).toContain(
      'Browser metadata mentioned',
    );
    expect(
      dashboard.feedbackInbox.itemLabels[0]?.labelActions.some(
        (action) => action.feedbackLabel === 'too_frequent',
      ),
    ).toBe(true);
    expect(dashboard.feedbackInbox.itemLabels[0]?.actionAuthority).toBe('display_only');
    expect(dashboard.evidenceRefs).toContain('environment-source:browser-context');
    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('C:\\Users\\secret\\note.txt');
  });

  it('preserves pending approval boundaries with cwd, risk, and command fingerprint', () => {
    const request = createAoiApprovedCommandRequest({
      sessionPath: 'aoi/default',
      proposalId: 'proposal-dashboard-command',
      decisionId: 'decision-dashboard-command',
      command: 'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyUi.test.ts',
      cwd: 'apps/webuiapps',
      purpose: 'Validate the acceptance dashboard summary.',
      risk: 'high',
      timeoutMs: 120000,
      requestedAt: 6000,
      evidenceRefs: ['proposal:proposal-dashboard-command'],
    });
    const policy = evaluateAoiApprovedCommandPolicy(request);
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      approvedCommandPolicies: [policy],
      now: 7000,
    });

    expect(dashboard.pendingApproval.visible).toBe(true);
    expect(dashboard.pendingApproval.approvalLabels.join(' ')).toContain(
      policy.approvalFingerprint,
    );
    expect(dashboard.pendingApproval.boundaryLabels.join(' ')).toContain(policy.cwdLabel);
    expect(dashboard.pendingApproval.boundaryLabels.join(' ')).toContain(
      policy.approvalFingerprint,
    );
    expect(dashboard.pendingApproval.riskLabels).toContain('high risk L5');
    expect(dashboard.actionAuthority).toBe('display_only');
    expect(dashboard.mutationCount).toBe(0);
  });

  it('summarizes bounded work orders without implying execution happened', () => {
    const eligibleOrder = createAoiBoundedWorkOrder({
      sessionPath: 'aoi/default',
      objective: 'Adjust one Aoi dashboard helper.',
      affectedSurfaces: ['apps/webuiapps/src/lib/aoiAutonomyUi.ts'],
      files: ['apps/webuiapps/src/lib/aoiAutonomyUi.ts'],
      allowedOperations: ['edit_file', 'run_validation_command'],
      commands: [
        {
          command:
            'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyUi.test.ts',
          cwd: '.',
          purpose: 'Validate Aoi dashboard work-order summary.',
        },
      ],
      risk: {
        level: 'low',
        mutationCapable: true,
      },
      checkpoint: {
        kind: 'existing_git_state',
        required: true,
        available: true,
        summary: 'Existing git state is available.',
        instructions: [],
        evidenceRefs: ['git:status'],
      },
      rollback: {
        kind: 'manual_revert_required',
        available: true,
        guarantee: 'none',
        summary: 'Manual revert through reviewed diff.',
        instructions: ['Use the exact git diff if review rejects it.'],
        evidenceRefs: ['git:status'],
      },
      evidenceRefs: ['proposal:bounded-ui'],
      now: 7000,
    });
    const blockedOrder = createAoiBoundedWorkOrder({
      sessionPath: 'aoi/default',
      objective: 'Fix everything in the repository.',
      affectedSurfaces: ['entire repo'],
      allowedOperations: ['edit_file'],
      risk: {
        level: 'medium',
        mutationCapable: true,
      },
      now: 7000,
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      boundedWorkOrders: [eligibleOrder, blockedOrder],
      now: 8000,
    });
    const serialized = JSON.stringify(dashboard.boundedWorkOrders).toLowerCase();

    expect(dashboard.boundedWorkOrders.visible).toBe(true);
    expect(dashboard.boundedWorkOrders.statusLabel).toContain('1/2 work order');
    expect(dashboard.boundedWorkOrders.eligibleWorkOrderLabels.join(' ')).toContain(
      'Adjust one Aoi dashboard helper',
    );
    expect(dashboard.boundedWorkOrders.blockedReasonLabels.join(' ')).toContain('scope_too_broad');
    expect(dashboard.boundedWorkOrders.exactNextApprovalLabels.join(' ')).toContain(
      eligibleOrder.approval.approvalFingerprint,
    );
    expect(dashboard.boundedWorkOrders.expectedDiffShapeLabels.join(' ')).toContain(
      eligibleOrder.expectedDiffShape.summary,
    );
    expect(dashboard.boundedWorkOrders.reviewRequirementLabels.join(' ')).toContain('command=true');
    expect(dashboard.boundedWorkOrders.stopConditionLabels.join(' ')).toContain('approval');
    expect(dashboard.boundedWorkOrders.checkpointLabels.join(' ')).toContain('available');
    expect(dashboard.boundedWorkOrders.rollbackLabels.join(' ')).toContain('manual_revert');
    expect(dashboard.pendingApproval.approvalLabels.join(' ')).toContain(
      eligibleOrder.approval.approvalFingerprint,
    );
    expect(serialized).not.toContain('executed');
    expect(dashboard.actionAuthority).toBe('display_only');
    expect(dashboard.mutationCount).toBe(0);
  });

  it('can display generated Kira-review work orders from accepted proposals', () => {
    const order = buildAoiBoundedWorkOrderFromProposal(
      makeProposal({
        status: 'accepted',
        title: 'Create reviewed Kira work order',
        risk: 'medium',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['create_kira_work'],
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            projectName: 'YourOpenRoom',
            title: 'Patch Aoi dashboard summary',
            objective: 'Patch one Aoi dashboard summary helper.',
            scope: ['apps/webuiapps/src/lib/aoiAutonomyUi.ts'],
            modules: ['aoiAutonomyUi'],
            validationProfile: 'aoi-autonomy',
          },
        },
      }),
      {
        now: 7000,
        generated: true,
      },
    );
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      boundedWorkOrders: [order],
      now: 8000,
    });

    expect(order.policyResult.status).toBe('kira_review_required');
    expect(dashboard.boundedWorkOrders.exactNextApprovalLabels.join(' ')).toContain('Kira review');
    expect(dashboard.pendingApproval.riskLabels.join(' ')).toContain('medium risk L4');
  });

  it('summarizes prepared work orders emitted by action ladder decisions', () => {
    const order = buildAoiBoundedWorkOrderFromProposal(
      makeProposal({
        id: 'proposal-dashboard-ladder-work-order',
        status: 'active',
        title: 'Create Kira-reviewed work order from ladder',
        risk: 'medium',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['create_kira_work'],
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            title: 'Patch Aoi bounded work order panel',
            objective: 'Patch one Aoi bounded work order dashboard helper.',
            scope: ['apps/webuiapps/src/lib/aoiAutonomyUi.ts'],
            modules: ['aoiAutonomyUi'],
            validationProfile: 'aoi-autonomy',
          },
        },
      }),
      {
        now: 7000,
        generated: true,
      },
    );
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      actionLadderDecisions: [
        {
          version: 1,
          id: 'aoi-action-ladder-dashboard-work-order',
          sessionPath: 'aoi/default',
          opportunityId: 'opp-dashboard-work-order',
          opportunityDedupeKey: 'dashboard:work-order',
          currentLevel: 'L4',
          levelLabel: 'L4 prepare only',
          summaryLabel: 'Prepare-only bounded work order is ready for review.',
          allowedActions: [],
          blockedActions: [],
          approvalNeeds: [],
          preparedWorkOrder: order,
          evidenceNeeds: [],
          safeFallback: 'Prepare-only; no execution authority.',
          connectionLabels: ['aoiBoundedWorkOrder.ts'],
          evidenceRefs: order.evidenceRefs,
          actionAuthority: 'display_only',
          mutationCount: 0,
        },
      ],
      now: 8000,
    });

    expect(dashboard.boundedWorkOrders.visible).toBe(true);
    expect(dashboard.boundedWorkOrders.eligibleWorkOrderLabels.join(' ')).toContain(
      'Patch one Aoi bounded work order dashboard helper',
    );
    expect(dashboard.boundedWorkOrders.reviewRequirementLabels.join(' ')).toContain('kira=true');
    expect(dashboard.pendingApproval.approvalLabels.join(' ')).toContain(
      order.approval.approvalFingerprint,
    );
    expect(JSON.stringify(dashboard).toLowerCase()).not.toContain('executed');
  });

  it('summarizes replay health failures by metric id without long snapshots', () => {
    const digest = buildAoiOperatorDigest({
      sessionPath: 'aoi/default',
      now: 6000,
      attentionEvents: [
        makeAttentionEvent({
          id: 'attention-replay-dashboard-test',
          sourceRef: 'browser-context',
          sourceSignature: 'browser-context',
          evidenceRefs: ['environment-source:browser-context'],
          dedupeKey: 'attention:replay-dashboard',
        }),
      ],
    });
    const decisions = recordAoiShadowDecisions({
      sessionPath: 'aoi/default',
      digest,
      now: 6000,
    });
    const labels = appendAoiShadowDecisionLabel([], {
      decisionId: decisions[0]?.id ?? '',
      label: 'wrong_source',
      evidenceRefs: ['shadow-review:wrong-source-dashboard'],
      now: 6500,
    });
    const shadowReport = evaluateAoiShadowDecisions({
      sessionPath: 'aoi/default',
      decisions,
      labels,
      now: 7000,
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      builtInReplayReports: [
        {
          version: 1,
          fixtureId: 'dashboard-replay-failure',
          title: 'Dashboard replay failure',
          sessionPath: 'aoi/replay',
          generatedAt: 6000,
          passed: false,
          summary: 'A replay expectation failed.',
          metrics: [
            {
              version: 1,
              id: 'replay.source_selected.dashboard',
              name: 'source_selected',
              label: 'Expected selected source.',
              passed: false,
              expected: 'workspace',
              actual: 'browser',
              evidenceRefs: ['replay:dashboard-replay-failure'],
            },
          ],
          selectedSourceLabels: [],
          attentionDecisionLabels: [],
          generatedProposalLabels: [],
          blockedReasonLabels: [],
          preferenceConflictLabels: [],
          digestSummary: '',
          commandExecutionCount: 0,
          mutationAttemptCount: 0,
        },
      ],
      jarvisAcceptanceReport: {
        version: 1,
        id: 'jarvis-dashboard-report',
        sessionPath: 'aoi/default',
        generatedAt: 6000,
        passed: false,
        scenarioCount: 1,
        metricCount: 1,
        passedMetricCount: 0,
        failedMetricCount: 1,
        mutationCount: 0,
        scenarios: [
          {
            version: 1,
            id: 'jarvis-dashboard-scenario',
            title: 'Dashboard scenario',
            passed: false,
            actualSummary: 'Failed source expectation.',
            evidenceRefs: ['jarvis:dashboard'],
            privacyState: 'synthetic',
            mutationCount: 0,
            failedMetricIds: ['jarvis.dashboard.metric'],
          },
        ],
        metrics: [
          {
            version: 1,
            id: 'jarvis.dashboard.metric',
            scenarioId: 'jarvis-dashboard-scenario',
            dimension: 'context_awareness',
            passed: false,
            actualSummary: 'Very long actual summary should not appear in the dashboard.',
            evidenceRefs: ['jarvis:dashboard'],
            privacyState: 'synthetic',
            mutationCount: 0,
          },
        ],
        failedMetrics: [
          {
            version: 1,
            id: 'jarvis.dashboard.metric',
            scenarioId: 'jarvis-dashboard-scenario',
            dimension: 'context_awareness',
            passed: false,
            actualSummary: 'Very long actual summary should not appear in the dashboard.',
            evidenceRefs: ['jarvis:dashboard'],
            privacyState: 'synthetic',
            mutationCount: 0,
          },
        ],
        evidenceRefs: ['jarvis:dashboard'],
      },
      shadowReport,
      promotedFixtureCandidates: [
        {
          id: 'trace-dashboard-candidate',
          label: 'Wrong source dashboard trace',
          status: 'candidate',
          evidenceRefs: ['trace:dashboard-candidate'],
        },
      ],
      now: 8000,
    });
    const replayHealthJson = JSON.stringify(dashboard.replayHealth);

    expect(dashboard.replayHealth.visible).toBe(true);
    expect(dashboard.replayHealth.failedMetricIds).toEqual([
      'replay.source_selected.dashboard',
      'jarvis.dashboard.metric',
      'shadow.wrong_source',
    ]);
    expect(dashboard.replayHealth.promotedFixtureLabels[0]).toContain(
      'Wrong source dashboard trace',
    );
    expect(replayHealthJson).not.toContain('Very long actual summary');
    expect(replayHealthJson.length).toBeLessThan(1400);
  });

  it('summarizes JARVIS readiness gates without raising autonomy by wording', () => {
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      jarvisAcceptanceReport: runAoiJarvisAcceptanceTrial({ now: 7000 }),
      shadowReport: {
        version: 1,
        sessionPath: 'aoi/default',
        generatedAt: 7000,
        metrics: {
          totalDecisions: 4,
          labeledDecisionCount: 4,
          usefulRate: 0.75,
          tooMuchRate: 0,
          wrongSourceRate: 0.25,
          unsafeShadowDecisionCount: 0,
          shouldHaveSpokenCount: 0,
          silentDecisionExplainabilityCoverage: 1,
          mutationCount: 0,
          zeroMutation: true,
        },
        decisions: [],
        labels: [],
        safetyReviewDecisionIds: [],
        evidenceRefs: ['shadow-readiness:wrong-source-dashboard'],
      },
      now: 8000,
    });
    const serialized = JSON.stringify(dashboard.jarvisReadiness).toLowerCase();

    expect(dashboard.jarvisReadiness.visible).toBe(true);
    expect(dashboard.jarvisReadiness.statusLabel).toContain('blocked');
    expect(dashboard.jarvisReadiness.levelLabel).toContain('synthetic pass');
    expect(dashboard.jarvisReadiness.modeRecommendationLabel).toBe(
      'Tighten or roll back current mode',
    );
    expect(dashboard.jarvisReadiness.visibilityLabels.join(' ')).toContain('direct chat blocked');
    expect(dashboard.jarvisReadiness.gateLabels.join(' ')).toContain('Wrong-source rate');
    expect(dashboard.jarvisReadiness.recommendationLabels.join(' ')).toContain(
      'Run source calibration',
    );
    expect(serialized).not.toContain('increase autonomy now');
    expect(dashboard.jarvisReadiness.evidenceRefs).toContain(
      'shadow-readiness:wrong-source-dashboard',
    );
    expect(dashboard.jarvisAutonomyGovernor.visible).toBe(true);
    expect(dashboard.jarvisAutonomyGovernor.blockerLabels.join(' ')).toContain(
      'Jarvis readiness blocks direct chat',
    );
  });

  it('surfaces field-grounded JARVIS acceptance readiness and hard-fail counters', () => {
    const fieldGroundedAcceptanceReport = runAoiFieldGroundedJarvisAcceptancePack({
      sessionPath: 'aoi/default',
      now: 7000,
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      fieldGroundedAcceptanceReport,
      now: 8000,
    });

    expect(dashboard.replayHealth.visible).toBe(true);
    expect(dashboard.replayHealth.fieldGroundedAcceptanceLabel).toContain('14/14');
    expect(dashboard.replayHealth.fieldGroundedAcceptanceLabel).toContain('field-grounded');
    expect(dashboard.replayHealth.fieldGroundedHardFailLabels).toEqual([
      'private leaks 0',
      'unauthorized mutations 0',
      'stale current claims 0',
      'live shell 0',
      'live network 0',
      'live Gmail 0',
      'live Calendar 0',
      'live Kira mutation 0',
    ]);
    expect(dashboard.replayHealth.fieldGroundedNextGoalLabels.length).toBeGreaterThan(0);
    expect(dashboard.replayHealth.failedMetricIds).toEqual([]);
    expect(dashboard.replayHealth.evidenceRefs).toEqual(
      expect.arrayContaining(fieldGroundedAcceptanceReport.evidenceRefs.slice(0, 1)),
    );
    expect(dashboard.jarvisReadiness.visible).toBe(true);
    expect(JSON.stringify(dashboard).toLowerCase()).not.toContain('fully autonomous');
  });

  it('surfaces real-field operations readiness and acceptance tier differences', async () => {
    const realFieldOperationsAcceptanceReport = await runAoiRealFieldOperationsAcceptancePack({
      sessionsDir: makeTempRoot(),
      sessionPath: 'aoi/default',
      now: 7000,
    });
    const dashboard = buildAoiOperatorAcceptanceDashboard({
      sessionPath: 'aoi/default',
      realFieldOperationsAcceptanceReport,
      now: 8000,
    });

    expect(dashboard.replayHealth.visible).toBe(true);
    expect(dashboard.replayHealth.realFieldOperationsAcceptanceLabel).toContain('16/16');
    expect(dashboard.replayHealth.realFieldOperationsAcceptanceLabel).toContain(
      'real-field operations',
    );
    expect(dashboard.replayHealth.realFieldOperationsTierLabels).toHaveLength(3);
    expect(dashboard.replayHealth.realFieldOperationsTierLabels.join(' ')).toContain(
      'Synthetic acceptance checks isolated replay fixtures',
    );
    expect(dashboard.replayHealth.realFieldOperationsTierLabels.join(' ')).toContain(
      'Real-field operations acceptance stitches capture',
    );
    expect(dashboard.replayHealth.realFieldOperationsHardFailLabels).toEqual([
      'private leaks 0',
      'unauthorized mutations 0',
      'stale current claims 0',
      'live shell 0',
      'live network 0',
      'live Gmail 0',
      'live Calendar 0',
      'live Kira mutation 0',
    ]);
    expect(dashboard.replayHealth.failedMetricIds).toEqual([]);
    expect(dashboard.replayHealth.evidenceRefs).toEqual(
      expect.arrayContaining(realFieldOperationsAcceptanceReport.evidenceRefs.slice(0, 1)),
    );
    expect(JSON.stringify(dashboard)).not.toContain('honey@example.com');
    expect(JSON.stringify(dashboard)).not.toContain('C:\\Users\\secret');
  });

  it('summarizes scheduler wakeups and limits skipped source noise', () => {
    const collapsed = buildAoiAutonomySchedulerPanelSummary(makeSchedulerState(), false);
    const expanded = buildAoiAutonomySchedulerPanelSummary(makeSchedulerState(), true);

    expect(collapsed).toMatchObject({
      visible: true,
      summaryLabel: 'session open completed: 1 refreshed, 4 skipped',
      budgetLabel: '3 source(s), 2 proposal(s), 12s tick budget',
    });
    expect(collapsed.skippedSourceLabels).toHaveLength(4);
    expect(collapsed.skippedSourceLabels[0]).toContain('workspace-git');
    expect(collapsed.skippedSourceLabels[3]).toBe('1 more skipped source(s)');
    expect(collapsed.warningLabels.join(' ')).toContain('[local path]');
    expect(expanded.skippedSourceLabels).toHaveLength(4);
    expect(expanded.evidenceRefs).toEqual(['wakeup:aoi-wakeup-ui-test']);
  });

  it('sends pause and resume mission client calls without dropping evidence refs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        sessionPath: 'aoi/default',
        mission: null,
      }),
    } as Response);

    await decideAoiMission('aoi/default', {
      action: 'pause',
      reason: 'User interrupted the goal.',
      evidenceRefs: ['goal:aoi-goal-ui-test'],
    });
    await decideAoiMission('aoi/default', {
      action: 'resume',
      reason: 'User resumed the goal.',
      evidenceRefs: ['goal:aoi-goal-ui-test', 'proposal:aoi-proposal-ui-test-001'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const pauseBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const resumeBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));

    expect(pauseBody).toMatchObject({
      sessionPath: 'aoi/default',
      action: 'pause',
      evidenceRefs: ['goal:aoi-goal-ui-test'],
    });
    expect(resumeBody).toMatchObject({
      sessionPath: 'aoi/default',
      action: 'resume',
      evidenceRefs: ['goal:aoi-goal-ui-test', 'proposal:aoi-proposal-ui-test-001'],
    });
  });
});
